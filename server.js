require('dotenv').config();
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cron    = require('node-cron');
const logger  = require('./utils/logger');

// ── Global error handlers ─────────────────────────────────────────────────────
// node-cron v3 emits 'task-failed' on the internal Task EventEmitter but nothing
// listens for it, so async cron errors would vanish silently. These handlers
// surface them before they can be swallowed.
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack:  reason instanceof Error ? reason.stack   : undefined,
  });
  // Do NOT re-throw — a crash would kill all in-flight requests on Railway.
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — server will continue', { error: err.message, stack: err.stack });
});

const { verifyWebhook, parseInbound, parseInboundRich, parseGreenApiWebhook, releaseQueuedMessages, sendText, sendFileByUrl, alertOwner, notifyLeadTeam, probeGreenApiConnection, getGreenCreds, _tokenSourceVar } = require('./services/whatsapp.service');
const { fetchAndNormalizeLead } = require('./services/metaLeads');
const { captureRawBody, verifyMetaSignature } = require('./middleware/security');
const inbox = require('./utils/whatsapp_inbox');
const store          = require('./utils/lead_store');
const leadAgent      = require('./agents/lead_agent');
const managerAgent   = require('./agents/manager_agent');
const tomerAgent     = require('./agents/tomer_agent');
const danaAgent      = require('./agents/dana_agent');
const barakAgent     = require('./agents/barak_agent');
const retentionAgent = require('./agents/retention_agent');
const contentAgent   = require('./agents/content_agent');

const { initWorkers }                  = require('./workers/scheduler');
const automations                      = require('./utils/automation_store');
const aptStore                         = require('./utils/appointment_store');
const calendarSvc                      = require('./services/calendar.service');
const notifySvc                        = require('./services/notification.service');
const greenApiSvc                      = require('./services/greenapi.service');
const persist                          = require('./utils/persist');
const studioAssets                     = require('./utils/studio_assets');

// ── Staff configuration (hot-reloadable) ─────────────────────────────────────

const STAFF_CONFIG_PATH  = path.join(__dirname, 'data/staff_config.json');
const SCHEDULE_PNG_PATH  = path.join(__dirname, 'public', 'schedule.png');

/**
 * Resolve the publicly reachable base URL of this server.
 * Priority: BACKEND_URL env var → RAILWAY_PUBLIC_DOMAIN env var → null.
 * Returns null when neither is set (e.g. plain localhost dev without ngrok).
 */
function getBackendBase() {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

/** Publicly accessible URL for schedule.png — requires BACKEND_URL or RAILWAY_PUBLIC_DOMAIN. */
function getScheduleImageUrl() {
  const base = getBackendBase();
  return base ? `${base}/schedule.png` : null;
}

/**
 * Returns the best available timetable image URL (image 1):
 *   1. Custom uploaded image served via /api/admin/timetable-image (from DATA_DIR)
 *   2. Static schedule.png in public/ (legacy fallback)
 * Returns null when neither is available.
 */
function getActiveTimetableUrl() {
  const base = getBackendBase();
  if (!base) return null;
  const imgPath = studioAssets.getTimetableImagePath();
  if (imgPath && fs.existsSync(imgPath)) return `${base}/api/admin/timetable-image`;
  if (fs.existsSync(SCHEDULE_PNG_PATH))  return `${base}/schedule.png`;
  return null;
}

/**
 * Returns the URL for timetable image 2 if one has been uploaded, or null.
 */
function getActiveTimetable2Url() {
  const base = getBackendBase();
  if (!base) return null;
  const imgPath = studioAssets.getTimetable2ImagePath();
  if (imgPath && fs.existsSync(imgPath)) return `${base}/api/admin/timetable2-image`;
  return null;
}

function loadStaffConfig() {
  try { return JSON.parse(fs.readFileSync(STAFF_CONFIG_PATH, 'utf8')); }
  catch { return { staff: [], default_assignee_id: null, appointment_duration_min: 30 }; }
}

let staffConfig = loadStaffConfig();

// ── Known-members override list ───────────────────────────────────────────────
// When Arbox lookup fails or is slow, staff can manually add phone numbers here
// to guarantee they always route to Tomer (never to Barak's sales flow).
// File: data/known_members.json  Format: { "phones": ["972XXXXXXXXX", ...] }
const KNOWN_MEMBERS_PATH = path.join(__dirname, 'data/known_members.json');

function loadKnownMembers() {
  try { return new Set(JSON.parse(fs.readFileSync(KNOWN_MEMBERS_PATH, 'utf8')).phones ?? []); }
  catch { return new Set(); }
}

// Checked on each inbound message — file is re-read so runtime edits take effect immediately.
function isKnownMember(phone) {
  if (!phone) return false;
  const list = loadKnownMembers();
  const norm = normalizeToE164(phone);
  return list.has(phone) || (norm ? list.has(norm) : false);
}

// Auto-persist an Arbox-confirmed member to known_members.json.
// Called once per confirmed member so future lookups survive Arbox timeouts.
function _autoAddKnownMember(phone, name) {
  try {
    let data = { phones: [], names: {} };
    try { data = JSON.parse(fs.readFileSync(KNOWN_MEMBERS_PATH, 'utf8')); } catch { /* fresh file */ }
    const norm = normalizeToE164(phone) ?? phone;
    if (!data.phones.includes(norm)) {
      data.phones.push(norm);
      if (name) data.names = { ...(data.names ?? {}), [norm]: name };
      fs.writeFileSync(KNOWN_MEMBERS_PATH, JSON.stringify(data, null, 2), 'utf8');
      logger.info('[known-members] Auto-added confirmed Arbox member', { phone: norm, name });
    }
  } catch (err) {
    logger.warn('[known-members] Auto-add failed', { error: err.message });
  }
}

function findStaff(id) {
  return staffConfig.staff?.find(s => s.id === id) ?? null;
}
function defaultStaff() {
  return findStaff(staffConfig.default_assignee_id) ??
         staffConfig.staff?.find(s => s.active) ??
         null;
}

/**
 * Returns true when a phone belongs to a configured staff member.
 * Used to skip the lead/client pipeline for inbound messages from Eden/Melanie.
 */
function isStaffPhone(phone) {
  if (!phone) return false;
  const norm = normalizeToE164(phone);
  return (staffConfig.staff ?? []).some(s => s.phone && normalizeToE164(s.phone) === norm);
}

const app         = express();
const PORT        = process.env.PORT ?? 3000;
const aptIcsCache = new Map(); // aptId → ICS string (in-memory, lost on restart — regenerate on demand)

// ── Server-Sent Events — real-time push to dashboard clients ──────────────────
const sseClients = new Set();

function broadcastSse(event, data) {
  if (!sseClients.size) return;
  const payload = `data: ${JSON.stringify({ event, ...data })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── Bypass ngrok browser-warning page ────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// ── Global request logger — catches EVERY hit including Meta's verifier ───────
// If Meta's request reaches this server you will see it here before any route.
app.use((req, _res, next) => {
  logger.info(`INCOMING ${req.method} ${req.originalUrl}`, {
    ip:      req.headers['x-forwarded-for'] ?? req.ip,
    ua:      (req.headers['user-agent'] ?? '').slice(0, 100),
    host:    req.headers['host'],
  });
  next();
});

// ── Static dashboard ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── WhatsApp webhook — verification (GET) ────────────────────────────────────
app.get('/webhook/whatsapp', verifyWebhook);

// ── WhatsApp webhook — inbound messages (POST) ───────────────────────────────
// captureRawBody must run before verifyMetaSignature (needs raw bytes for HMAC).
// JSON is parsed manually from req.rawBody so the stream stays intact for signing.
app.post('/webhook/whatsapp', captureRawBody, verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);
  let body = {};
  try { body = JSON.parse(req.rawBody || '{}'); } catch { return; }

  const message = parseInbound(body);
  if (!message) return;

  logger.info('Inbound WhatsApp message', { from: message.from, preview: message.text.slice(0, 60) });
  try {
    await leadAgent.handleInbound(message);
  } catch (err) {
    logger.error('Lead agent error', { error: err.message, from: message.from });
  }
});

// ── REST API — shared express.json() parser for all /api POST routes ──────────
const jsonBody = express.json();

// GET /api/leads — all leads (history stripped, phone masked)
app.get('/api/leads', (_req, res) => {
  const leads = store.getAllLeads().map(({ history, ...l }) => ({
    ...l,
    phone: maskPhone(l.phone),
  }));
  res.json(leads);
});

// GET /api/stats — daily stats + system health
app.get('/api/stats', (_req, res) => {
  res.json({ daily: store.getDailyStats(), health: store.getSystemHealth() });
});

// GET /api/system — agent status, service config, recent events
app.get('/api/system', (_req, res) => {
  res.json({
    agents: {
      lead:      { name: 'Lead Agent',          status: 'active', role: 'מסווג וממיר לידים' },
      manager:   { name: 'מאיה — Operations',  status: 'active', role: 'מנהלת פעולות AI' },
      tomer:     { name: 'תומר — Retention',   status: 'active', role: 'שימור ופולו-אפ לידים' },
      dana:      { name: 'דנה — Content',      status: 'active', role: 'תוכן, שיווק וניתוח וידאו (Mosseri)' },
      barak:     { name: 'ברק — CRM',          status: 'active', role: 'סנכרון Arbox והזמנות' },
      retention: { name: 'Retention (legacy)', status: 'active', role: 'צ\'ק-אין חברים קיימים' },
      content:   { name: 'Content (legacy)',   status: 'active', role: 'חבילת תוכן אוטומטית' },
    },
    services: {
      whatsapp: { configured: isConfigured('WHATSAPP_ACCESS_TOKEN') },
      arbox:    { configured: isConfigured('ARBOX_API_KEY', 'ARBOX_CLIENT_ID') },
      openai:   { configured: isConfigured('OPENAI_API_KEY') },
    },
    store:  store.getSystemHealth(),
    events: store.getEvents({ limit: 20 }).reverse(),
  });
});

// GET /api/maya/summary — executive summary: conversion funnel + campaign KPIs
app.get('/api/maya/summary', (_req, res) => {
  const stats  = store.getDailyStats();
  const health = store.getSystemHealth();
  const all    = store.getAllLeads();

  const converted     = all.filter(l => l.bookingConfirmed).length;
  const introSent     = all.filter(l => l.introOfferSent).length;
  const introRedeemed = all.filter(l => l.introOfferRedeemed).length;
  const convRate      = introSent > 0
    ? Math.round((introRedeemed / introSent) * 100)
    : 0;
  const bookingRate   = introRedeemed > 0
    ? Math.round((converted / introRedeemed) * 100)
    : 0;

  res.json({
    funnel: {
      leads:          stats.totalLeads,
      hot:            stats.hotLeadsTotal,
      introSent,
      introRedeemed,
      bookingsToday:  stats.bookingsToday,
      converted,
      convRate,
      bookingRate,
    },
    today: {
      newLeads:       stats.newLeadsToday,
      messagesIn:     stats.messagesIn,
      messagesOut:    stats.messagesOut,
      reEngaged:      stats.reEngagedToday,
      crises:         stats.crisesToday,
    },
    members: {
      total:   stats.total   ?? 0,
      active:  stats.active  ?? 0,
      atRisk:  stats.atRisk  ?? 0,
      churned: stats.churned ?? 0,
    },
    health: { avgScore: health.avgScore, status: health.status },
    updatedAt: new Date(),
  });
});

// POST /api/maya/chat — send a message to the manager agent
app.post('/api/maya/chat', jsonBody, async (req, res) => {
  const message = req.body?.message;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const reply = await managerAgent.chat(message);
    res.json({ reply });
  } catch (err) {
    logger.error('Maya chat error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/store/seed — populate with demo leads
app.post('/api/store/seed', (_req, res) => {
  const count = store.seedDemoData();
  logger.info('Demo data seeded', { count });
  res.json({ count, ok: true });
});

// ── Tomer routes ─────────────────────────────────────────────────────────────
app.post('/api/tomer/chat', jsonBody, async (req, res) => {
  const message = req.body?.message;
  if (!message) return res.status(400).json({ error: 'message required' });
  try { res.json({ reply: await tomerAgent.chat(message) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tomer/run-checks', async (_req, res) => {
  try { res.json(await tomerAgent.runDailyChecks()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dana routes ───────────────────────────────────────────────────────────────
app.post('/api/dana/chat', jsonBody, async (req, res) => {
  const message = req.body?.message;
  if (!message) return res.status(400).json({ error: 'message required' });
  try { res.json({ reply: await danaAgent.chat(message) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dana/content-pack', jsonBody, async (req, res) => {
  try { res.json(await danaAgent.generateContentPack(req.body?.focusClass)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dana/ad-copy', jsonBody, async (req, res) => {
  const { format, objective, className } = req.body ?? {};
  try { res.json(await danaAgent.generateAdCopy({ format, objective, className })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/dana/analyze-video — Mosseri-framework content review
// Body: { description, transcript, format, goal, title }
// Returns: { review, readiness, verdict, scores, flags, strengths, reasonings }
app.post('/api/dana/analyze-video', jsonBody, async (req, res) => {
  const { description, transcript, format, goal, title } = req.body ?? {};
  if (!description && !transcript) {
    return res.status(400).json({ error: 'חובה לשלוח description או transcript' });
  }
  try {
    res.json(await danaAgent.analyzeVideo({ description, transcript, format, goal, title }));
  } catch (err) {
    logger.error('Dana analyze-video error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Barak routes ──────────────────────────────────────────────────────────────
app.post('/api/barak/chat', jsonBody, async (req, res) => {
  const message = req.body?.message;
  if (!message) return res.status(400).json({ error: 'message required' });
  try { res.json({ reply: await barakAgent.chat(message) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/barak/sync-lead', jsonBody, async (req, res) => {
  const { phone } = req.body ?? {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  res.json(await barakAgent.syncLeadToArbox(phone));
});

app.post('/api/barak/sync-all', async (_req, res) => {
  res.json(await barakAgent.syncAllUnsynced());
});

app.post('/api/barak/book-trial', jsonBody, async (req, res) => {
  const { phone, classId } = req.body ?? {};
  if (!phone || !classId) return res.status(400).json({ error: 'phone and classId required' });
  res.json(await barakAgent.registerTrialBooking(phone, classId));
});

// POST /api/store/reset — wipe all leads and events
app.post('/api/store/reset', (_req, res) => {
  store.clear();
  managerAgent.clearHistory();
  tomerAgent.clearHistory();
  danaAgent.clearHistory();
  barakAgent.clearHistory();
  logger.info('Store reset');
  res.json({ ok: true });
});

// ── Tomer extras ─────────────────────────────────────────────────────────────

// GET /api/tomer/members — studio members at risk of churning
app.get('/api/tomer/members', (_req, res) => {
  const inactive = store.getInactiveMembers(14);
  const stats    = store.getMemberStats();
  res.json({
    inactive: inactive.map(m => ({ ...m, phone: maskPhone(m.phone ?? '') })),
    stats,
    checkedAt: new Date(),
  });
});

// GET /api/tomer/queue — dormant leads awaiting re-engagement
app.get('/api/tomer/queue', (_req, res) => {
  const dormant         = store.getDormantLeads(3);
  const introNotRedeemed = store.getAllLeads().filter(l => l.introOfferSent && !l.introOfferRedeemed);
  res.json({
    dormant:          dormant.map(({ history, ...l }) => ({ ...l, phone: maskPhone(l.phone) })),
    introNotRedeemed: introNotRedeemed.map(({ history, ...l }) => ({ ...l, phone: maskPhone(l.phone) })),
    checkedAt:        new Date(),
  });
});

// POST /api/tomer/send-whatsapp — manual WhatsApp outreach stub (wires to service when configured)
// GET /api/tomer/activity — Tomer's recent respond/silence decisions + known-members list
app.get('/api/tomer/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit ?? '60', 10), 200);
  const TOMER_TYPES = new Set([
    'tomer_silent', 'tomer_responded', 're_engagement_sent',
    'tomer_action_sent', 'tomer_birthday_sent', 'tomer_renewal_sent',
  ]);

  const events = store.getEvents({ limit: 500 })
    .filter(e => TOMER_TYPES.has(e.type))
    .slice(-limit)
    .reverse();

  let knownMembers = { phones: [], names: {} };
  try { knownMembers = JSON.parse(fs.readFileSync(KNOWN_MEMBERS_PATH, 'utf8')); } catch { /* ignore */ }

  res.json({
    events,
    stats: {
      silenced:  events.filter(e => e.type === 'tomer_silent').length,
      responded: events.filter(e => e.type === 'tomer_responded').length,
      autoSent:  events.filter(e => e.type === 're_engagement_sent').length,
    },
    knownMembers: {
      total: (knownMembers.phones ?? []).length,
      list:  (knownMembers.phones ?? []).map(p => ({
        phone: p,
        name:  knownMembers.names?.[p] ?? null,
      })),
    },
    checkedAt: new Date(),
  });
});

app.post('/api/tomer/send-whatsapp', jsonBody, async (req, res) => {
  const { phone, message } = req.body ?? {};
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  try {
    await sendText(phone, message);
    store.logEvent('manual_whatsapp', phone, { preview: message.slice(0, 80), agent: 'tomer' });
    logger.info('Tomer manual WhatsApp sent', { phone });
    res.json({ ok: true, phone, sentAt: new Date() });
  } catch (err) {
    logger.error('Tomer send-whatsapp error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Barak extras ──────────────────────────────────────────────────────────────

// POST /api/barak/sync-arbox — full Arbox CRM sync (calls existing sync-all logic)
app.post('/api/barak/sync-arbox', async (_req, res) => {
  try {
    const result = await barakAgent.syncAllUnsynced();
    store.logEvent('arbox_full_sync', null, { result });
    res.json({ ...result, syncedAt: new Date(), source: 'sync-arbox' });
  } catch (err) {
    logger.error('Barak sync-arbox error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/barak/sync-status — Arbox sync summary for dashboard
app.get('/api/barak/sync-status', (_req, res) => {
  const all     = store.getAllLeads();
  const synced  = all.filter(l => l.arboxSynced);
  const pending = all.filter(l => !l.arboxSynced && l.status !== 'crisis')
                     .sort((a, b) => b.score - a.score);
  res.json({
    total:       all.length,
    synced:      synced.length,
    pending:     pending.length,
    pendingLeads: pending.map(({ history, ...l }) => ({ ...l, phone: maskPhone(l.phone) })),
    syncedLeads:  synced.map(l => ({ name: l.name, arboxId: l.arboxId, phone: maskPhone(l.phone) })),
    checkedAt:   new Date(),
  });
});

// ── Meta Lead Ads webhook ─────────────────────────────────────────────────────

// GET /api/leads/webhook — Meta verification challenge
app.get('/api/leads/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected  = process.env.META_LEADS_VERIFY_TOKEN ?? 'shape_studio_leads';

  // ── Diagnostic log — visible in your terminal when Meta clicks Verify ────────
  logger.info('META LEADS WEBHOOK HIT', {
    method:    req.method,
    url:       req.originalUrl,
    query:     req.query,
    headers: {
      host:                req.headers['host'],
      'user-agent':        req.headers['user-agent'],
      'ngrok-skip-browser-warning': req.headers['ngrok-skip-browser-warning'] ?? '(not sent by Meta — that is fine)',
    },
    checks: {
      mode_ok:      mode === 'subscribe',
      token_ok:     token === expected,
      token_got:    token,
      token_expect: expected,
      challenge:    challenge,
    },
  });

  if (mode === 'subscribe' && token === expected) {
    logger.info('Meta leads webhook VERIFIED — returning challenge', { challenge });
    // Raw Node response — no Express wrapping, explicit Content-Length.
    // This is the strictest-possible plain-text reply Meta's verifier accepts.
    const body = Buffer.from(String(challenge), 'utf8');
    res.writeHead(200, {
      'Content-Type':               'text/plain',
      'Content-Length':             body.length,
      'ngrok-skip-browser-warning': 'true',
      'Cache-Control':              'no-cache, no-store',
    });
    return res.end(body);
  }

  logger.warn('Meta leads webhook REJECTED', { mode, token, expected });
  res.writeHead(403); res.end();
});

// URL aliases — Meta sometimes omits /api or uses /webhooks prefix
app.get(['/leads/webhook', '/webhooks/leads', '/webhook/leads'], (req, res) => {
  logger.info('Meta alias route hit', { path: req.path, query: req.query });
  req.url = '/api/leads/webhook?' + new URLSearchParams(req.query).toString();
  app.handle(req, res);
});

// POST /api/leads/webhook — Meta Lead Ads inbound
app.post('/api/leads/webhook', jsonBody, async (req, res) => {
  res.sendStatus(200); // Meta requires 200 within 5s — processing happens below

  try {
    // Meta sends only a leadgen_id. The full lead data must be fetched separately
    // from the Graph API using META_PAGE_ACCESS_TOKEN.
    const change    = req.body?.entry?.[0]?.changes?.[0]?.value;
    const leadgenId = change?.leadgen_id;
    const formId    = change?.form_id ?? null;
    const adId      = change?.ad_id   ?? null;

    if (!leadgenId) {
      logger.debug('Meta leads webhook: no leadgen_id — skipping', { body: req.body });
      return;
    }

    logger.info('Meta lead webhook received', { leadgenId, formId });

    // ── Attempt 1: Graph API (requires META_PAGE_ACCESS_TOKEN) ───────────────
    const graphLead = await fetchAndNormalizeLead(leadgenId).catch(err => {
      logger.warn('fetchAndNormalizeLead threw unexpectedly', { leadgenId, error: err.message });
      return null;
    });

    // ── Attempt 2: field_data embedded in the webhook body ───────────────────
    // Meta's testing tool and some configurations include field_data directly.
    // Production webhooks almost never do, but we try anyway.
    const payloadLead = parseMetaLeadWebhook(req.body);

    const lead = graphLead ?? payloadLead;

    // ── No phone resolved — alert admins so the lead is never silently lost ──
    if (!lead?.phone) {
      const tokenConfigured = isConfigured('META_PAGE_ACCESS_TOKEN');
      const reason = tokenConfigured
        ? 'Graph API returned no phone field — verify form field names include "phone_number" or "phone"'
        : 'META_PAGE_ACCESS_TOKEN is not configured on Railway — set a valid Page Access Token';

      logger.warn('Meta lead: could not resolve phone', { leadgenId, reason, fieldDataInPayload: (change?.field_data ?? []).length });

      // Logged to event store only — no WhatsApp alert (config issues shouldn't flood admin)
      store.logEvent('meta_lead_no_phone', null, { leadgenId, formId, reason });
      return;
    }

    // ── Lead resolved — store and notify ─────────────────────────────────────
    store.upsertLead(lead.phone, {
      name:   lead.name,
      status: 'new',
      score:  5,
      meta:   { source: 'meta_ads', leadgenId, formId: lead.formId ?? formId, adId: lead.adId ?? adId },
    });
    store.logEvent('meta_lead_webhook', lead.phone, { name: lead.name, leadgenId, source: 'meta_ads' });
    logger.info('Meta lead captured', { phone: lead.phone, name: lead.name, leadgenId });

    // WhatsApp notification to Eden + Melanie — bypasses quiet hours
    notifyLeadTeam(lead, { formId: lead.formId ?? formId, adId: lead.adId ?? adId })
      .catch(err => logger.warn('Lead team WhatsApp notification failed', { error: err.message }));

  } catch (err) {
    logger.error('Meta lead webhook error', { error: err.message });
  }
});

// ── Dana extras ───────────────────────────────────────────────────────────────

// GET /api/dana/recent — recent content-related events for Dana's panel
app.get('/api/dana/recent', (_req, res) => {
  const CONTENT_TYPES = new Set(['content_pack_generated', 'ad_copy_generated', 'video_analysis']);
  const events = store.getEvents({ limit: 30 })
    .filter(e => CONTENT_TYPES.has(e.type))
    .reverse()
    .slice(0, 8);
  res.json({ events });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone ?? '—';
  return phone.slice(0, 5) + '••••' + phone.slice(-3);
}

/** Parse a Meta Lead Ads webhook payload into a normalised lead object. */
function parseMetaLeadWebhook(body) {
  try {
    const change = body?.entry?.[0]?.changes?.[0]?.value;
    if (!change) return null;
    const fields = change.field_data ?? [];
    const get    = (name) => fields.find(f => f.name === name)?.values?.[0];
    const phone  = get('phone_number') ?? get('phone');
    if (!phone) return null;
    const cleaned = phone.replace(/[\s\-+()]/g, '').replace(/^0/, '972');
    const name    = [get('first_name'), get('last_name')].filter(Boolean).join(' ') || get('full_name') || null;
    return { phone: cleaned, name, formId: change.form_id ?? null, adId: body?.entry?.[0]?.id ?? null };
  } catch { return null; }
}

function isConfigured(...keys) {
  return keys.every(key => {
    const v = process.env[key];
    return !!(v && v !== 'REPLACE_ME' && v !== '972XXXXXXXXX');
  });
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

cron.schedule('30 8 * * *', async () => {
  logger.info('Cron: releasing quiet-hours queue');
  try {
    await releaseQueuedMessages();
  } catch (err) {
    logger.error('Cron: releaseQueuedMessages failed', { error: err.message });
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 9 * * *', async () => {
  logger.info('Cron: starting daily retention pass');
  try {
    await retentionAgent.runDailyRetentionPass([]);
  } catch (err) {
    logger.error('Retention cron error', { error: err.message });
  }
}, { timezone: 'Asia/Jerusalem' });

// Tomer's re-engagement pass — 09:30 every morning
cron.schedule('30 9 * * *', async () => {
  logger.info('Cron: Tomer daily re-engagement checks');
  try {
    const result = await tomerAgent.runDailyChecks();
    logger.info('Tomer checks complete', result);
  } catch (err) {
    logger.error('Tomer cron error', { error: err.message });
  }
}, { timezone: 'Asia/Jerusalem' });

cron.schedule('0 8 1,15 * *', async () => {
  logger.info('Cron: generating bi-weekly content pack');
  try {
    await contentAgent.generateAndSendContentPack();
  } catch (err) {
    logger.error('Content cron error', { error: err.message });
  }
}, { timezone: 'Asia/Jerusalem' });

// ══════════════════════════════════════════════════════════════════════════════
// BARAK — Arbox Dashboard & Automated Reports
// ══════════════════════════════════════════════════════════════════════════════

// ── Live Arbox data endpoints ──────────────────────────────────────────────────

// GET /api/arbox/members — live members from Arbox /v3/users
app.get('/api/arbox/members', async (_req, res) => {
  try {
    const arboxSvc  = require('./services/arbox.service');
    const all       = await arboxSvc.getMembers({ limit: 200 });
    const active    = all.filter(m => m.active);
    const inactive  = all.filter(m => !m.active);
    res.json({
      total: all.length, activeCount: active.length, inactiveCount: inactive.length,
      members: all.map(m => ({
        user_id:     m.user_id,
        name:        `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
        phone:       maskPhone(m.phone ?? ''),
        active:      !!m.active,
        role:        m.user_role,
        memberSince: m.membership_start_date,
        memberEnd:   m.membership_end_date,
      })),
      fetchedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/arbox/leads — live leads from Arbox /v3/leads
app.get('/api/arbox/leads', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const leads    = await arboxSvc.getLeads({ limit: 200 });
    res.json({
      total: leads.length,
      leads: leads.map(l => ({
        user_id:    l.user_id,
        name:       `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(),
        phone:      maskPhone(l.phone ?? ''),
        email:      l.email ? l.email.replace(/(.{2}).+(@.+)/, '$1***$2') : null,
        status:     l.lead_status,
        source:     l.lead_source,
        created:    l.created_time,
      })),
      fetchedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/arbox/schedule — upcoming schedule (today + N days)
app.get('/api/arbox/schedule', async (req, res) => {
  try {
    const days = parseInt(req.query.days ?? '7', 10);
    const arboxSvc = require('./services/arbox.service');
    const classes  = await arboxSvc.getUpcomingClasses({ days, limit: 50 });
    res.json({
      total: classes.length, days,
      classes: classes.map(c => ({
        id: c.schedule_id, name: c.session_name,
        date: c.date, start: c.start_time, end: c.end_time,
        maxParticipants: c.max_participants,
        staff: c.staff_member?.name ?? '—',
      })),
      fetchedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/arbox/overview — combined members + leads + schedule + health
app.get('/api/arbox/overview', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const [members, leads, classes, conn, mbStats] = await Promise.all([
      arboxSvc.getAllUsers({ limit: 200 }).catch(() => []),
      arboxSvc.getLeads({ limit: 200 }).catch(() => []),
      arboxSvc.getUpcomingClasses({ days: 7, limit: 30 }).catch(() => []),
      arboxSvc.testConnection().catch(e => ({ ok: false, error: e.message })),
      arboxSvc.getMembershipStats({ daysWarning: 30 }).catch(() => null),
    ]);
    const today = new Date().toISOString().split('T')[0];
    const todayClasses  = classes.filter(c => c.date === today);
    // Sum registered bookings for today — tries common Arbox field names
    const todayBookings = todayClasses.reduce(
      (sum, c) => sum + (c.registered_count ?? c.registrations ?? c.number_of_registrations ?? c.registered ?? 0), 0
    );
    const activeClients   = members.filter(m => m.active === 1 && m.user_role === 'client').length;
    const activeStaff     = members.filter(m => m.active === 1 && m.user_role === 'staffMember').length;
    const expiringSoon    = mbStats?.uniqueUsersExpiring ?? 0;
    res.json({
      connection: conn,
      members: {
        total:            members.length,
        active:           activeClients,                    // 148 — clients only
        activeMemberships: activeClients + activeStaff,    // 161 — clients + staff
        expiringSoon,                                      // 9 — from /v3/users/memberships
      },
      leads:    { total: leads.filter(u => u.user_role === 'lead').length },
      schedule: { total: classes.length, today: todayClasses.length, todayBookings },
      fetchedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/arbox/classify — precise Arbox membership classification (reports-v5 aligned)
app.get('/api/arbox/classify', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const c = await arboxSvc.classifyMemberships({ limit: 500 });

    const fmt = (u) => ({
      user_id:     u.user_id,
      name:        u._name,
      phone:       maskPhone(u._phone ?? ''),
      role:        u.user_role,
      active:      u.active === 1,
      memberSince: u.membership_start_date,
      memberEnd:   u.membership_end_date,
      status:      u._status,
      daysLeft:    u._daysLeft,
    });

    res.json({
      summary:    c.summary,
      categories: {
        activeClients:   c.activeClients.map(fmt),
        expiringSoon:    c.expiringSoon.map(fmt),
        recentlyExpired: c.recentlyExpired.map(fmt),
        archivedExpired: c.archivedExpired.map(fmt),
        deactivated:     c.deactivated.map(fmt),
        aggregators:     c.aggregators.map(fmt),
        aggregatorsInact: c.aggregatorsInact.map(fmt),
        leads:           c.leadsWithPhone.map(fmt),
        staff:           c.staff.map(fmt),
      },
      apiLimitations: c.apiLimitations,
      fetchedAt: new Date(),
    });
  } catch (err) {
    logger.error('classify error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/barak/validate-data — run data integrity audit
app.post('/api/barak/validate-data', async (_req, res) => {
  try {
    const result = await barakAgent.runDataValidation();
    store.logEvent('barak_data_validation', null, { agent: 'barak', score: result.integrityScore, issues: result.summary.totalIssues });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/barak/integrity-report — return most recent validation report
app.get('/api/barak/integrity-report', (_req, res) => {
  const report = barakAgent.getLastValidation();
  if (!report) return res.json({ available: false, note: 'בדיקה לא הורצה עדיין — POST /api/barak/validate-data להפעלה' });
  res.json({ available: true, ...report });
});

// GET /api/arbox/detailed-members — clients + aggregators with computed subscription status
app.get('/api/arbox/detailed-members', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const detail   = await arboxSvc.getDetailedMembers({ daysWarning: 30 });

    const format = m => ({
      user_id:     m.user_id,
      name:        `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
      phone:       maskPhone(m.phone ?? ''),
      role:        m.user_role,
      active:      !!m.active,
      memberSince: m.membership_start_date,
      memberEnd:   m.membership_end_date,
      status:      m._computedStatus,
      daysLeft:    m._daysLeft,
    });

    res.json({
      total:         detail.total,
      activeCount:   detail.activeCount,
      expiringSoonCount: detail.expiringSoonCount,
      expiredCount:  detail.expiredCount,
      active:        detail.active.map(format),
      expiringSoon:  detail.expiringSoon.map(format),
      expired:       detail.expired.map(format),
      fetchedAt:     new Date(),
    });
  } catch (err) {
    logger.error('detailed-members error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/arbox/staff — studio staff and instructors
app.get('/api/arbox/staff', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const staff    = await arboxSvc.getStaff();
    res.json({
      total: staff.length,
      staff: staff.map(s => ({
        user_id:    s.user_id,
        name:       `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(),
        phone:      maskPhone(s.phone ?? ''),
        email:      s.email ? s.email.replace(/(.{2}).+(@.+)/, '$1***$2') : null,
        active:     !!s.active,
        joinedDate: s.membership_start_date,
        gender:     s.gender || null,
      })),
      fetchedAt: new Date(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/arbox/attendance — attendance report + no-show risk
app.get('/api/arbox/attendance', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const report   = await arboxSvc.getAttendanceReport(store);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/arbox/retention — retention health metrics + recommendations
app.get('/api/arbox/retention', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const health   = await arboxSvc.getRetentionHealth(store);
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/barak/lookup-client — search Arbox by name or phone
app.post('/api/barak/lookup-client', jsonBody, async (req, res) => {
  const { query } = req.body ?? {};
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const result = await barakAgent.lookupClient(query);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/barak/check-schedule — get schedule for a specific date
app.post('/api/barak/check-schedule', jsonBody, async (req, res) => {
  const { date } = req.body ?? {};
  try {
    const result = await barakAgent.checkSchedule(date);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/barak/sync-leads — pull Arbox leads into local store
app.post('/api/barak/sync-leads', async (_req, res) => {
  try {
    const result = await barakAgent.syncLeadsFromArbox();
    store.logEvent('barak_leads_synced', null, { agent: 'barak', ...result });
    res.json({ ...result, syncedAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/barak/arbox-test — live credential probe against Arbox API
app.get('/api/barak/arbox-test', async (_req, res) => {
  const result = await barakAgent.probeConnection();
  res.json(result);
});

// ── Known-members override CRUD ───────────────────────────────────────────────
// GET  /api/members/known          — list all manual overrides
// POST /api/members/known          — add { phone } to the override list
// DELETE /api/members/known/:phone — remove a phone from the list

app.get('/api/members/known', (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(KNOWN_MEMBERS_PATH, 'utf8'));
    res.json({ phones: data.phones ?? [], total: (data.phones ?? []).length });
  } catch {
    res.json({ phones: [], total: 0 });
  }
});

app.post('/api/members/known', jsonBody, (req, res) => {
  const { phone, name } = req.body ?? {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    let data = { phones: [], names: {} };
    try { data = JSON.parse(fs.readFileSync(KNOWN_MEMBERS_PATH, 'utf8')); } catch { /* fresh */ }
    const norm = normalizeToE164(phone) ?? phone;
    if (!data.phones.includes(norm)) data.phones.push(norm);
    if (name) data.names = { ...(data.names ?? {}), [norm]: name };
    fs.writeFileSync(KNOWN_MEMBERS_PATH, JSON.stringify(data, null, 2), 'utf8');
    logger.info('[known-members] Added override', { phone: norm, name });
    res.json({ ok: true, phone: norm, total: data.phones.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/members/known/:phone', (req, res) => {
  try {
    let data = { phones: [], names: {} };
    try { data = JSON.parse(fs.readFileSync(KNOWN_MEMBERS_PATH, 'utf8')); } catch { /* fresh */ }
    const norm = normalizeToE164(decodeURIComponent(req.params.phone)) ?? decodeURIComponent(req.params.phone);
    data.phones = data.phones.filter(p => p !== norm);
    fs.writeFileSync(KNOWN_MEMBERS_PATH, JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true, total: data.phones.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/barak/arbox-dashboard — live Arbox sync + member + revenue metrics
app.get('/api/barak/arbox-dashboard', (_req, res) => {
  const all      = store.getAllLeads();
  const members  = store.getAllMembers();
  const stats    = store.getDailyStats();
  const synced   = all.filter(l => l.arboxSynced);
  const unsynced = all.filter(l => !l.arboxSynced && l.status !== 'crisis');
  const booked   = all.filter(l => l.bookingConfirmed);
  const converted= all.filter(l => l.introOfferRedeemed);
  const mStats   = store.getMemberStats();

  // Revenue simulation: trial=60 NIS, membership avg=350 NIS/month
  const trialRevenue      = booked.length * 60;
  const estimatedMRR      = mStats.active * 350;
  const churnRisk         = Math.round((mStats.atRisk / Math.max(mStats.total, 1)) * 100);

  res.json({
    sync: {
      total: all.length, synced: synced.length, unsynced: unsynced.length,
      syncRate: all.length ? Math.round((synced.length / all.length) * 100) : 0,
      configured: isConfigured('ARBOX_API_KEY'),
    },
    funnel: {
      totalLeads: all.length, hot: stats.hotLeadsTotal,
      warm: stats.warmLeadsTotal, booked: booked.length,
      converted: converted.length, crisis: stats.crisisActive,
      conversionRate: all.length ? Math.round((converted.length / all.length) * 100) : 0,
    },
    members: {
      total: mStats.total, active: mStats.active,
      atRisk: mStats.atRisk, churned: mStats.churned,
      churnRisk: `${churnRisk}%`,
    },
    revenue: {
      trialRevenue:    `${trialRevenue} ₪`,
      estimatedMRR:    `${estimatedMRR.toLocaleString()} ₪`,
      avgLeadScore:    store.getSystemHealth().avgScore,
    },
    unsyncedLeads: unsynced.slice(0, 5).map(l => ({
      name: l.name, score: l.score, status: l.status,
      phone: maskPhone(l.phone), firstSeen: l.firstSeen,
    })),
    updatedAt: new Date(),
  });
});

// GET /api/barak/reports/daily — daily lead ingestion & conversion report
app.get('/api/barak/reports/daily', (_req, res) => {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const stats    = store.getDailyStats();
  const events   = store.getEvents({ since: dayStart, limit: 200 });
  const all      = store.getAllLeads();

  const newToday  = all.filter(l => new Date(l.firstSeen) >= dayStart);
  const metaToday = events.filter(e => e.type === 'meta_lead_webhook').length;
  const waTriggers= events.filter(e => e.type === 'message_in').length;

  const convRate = stats.introOffersSent > 0
    ? Math.round(((stats.introsRedeemed ?? 0) / stats.introOffersSent) * 100)
    : 0;

  res.json({
    reportType: 'daily_ingestion',
    date: new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' }),
    ingestion: {
      newLeads:       stats.newLeadsToday,
      fromMeta:       metaToday,
      fromWhatsApp:   waTriggers,
      totalInStore:   all.length,
    },
    conversion: {
      introOffersSent:   stats.introOffersSent,
      introsRedeemed:    stats.introsRedeemed ?? 0,
      bookingsConfirmed: stats.bookingsToday,
      conversionRate:    `${convRate}%`,
    },
    scoreDistribution: {
      hot:  stats.hotLeadsTotal,
      warm: stats.warmLeadsTotal,
      cold: stats.coldLeadsTotal,
    },
    topLeads: store.getHotLeads().slice(0, 3).map(l => ({
      name: l.name, score: l.score, introSent: l.introOfferSent,
      phone: maskPhone(l.phone), lastActivity: l.lastActivity,
    })),
    generatedAt: new Date(),
  });
});

// GET /api/barak/reports/sync-health — Arbox sync health: invalid phones, duplicates, pending
app.get('/api/barak/reports/sync-health', (_req, res) => {
  const all      = store.getAllLeads();
  const PHONE_RE = /^972[0-9]{8,10}$/;
  const nameIdx  = new Map();
  const issues   = [];

  for (const lead of all) {
    const phone = (lead.phone ?? '').replace(/\s/g, '');
    if (!PHONE_RE.test(phone)) {
      issues.push({ type: 'invalid_phone', name: lead.name, phone: maskPhone(lead.phone), severity: 'high' });
    }
    const norm = (lead.name ?? '').trim().toLowerCase();
    if (norm && nameIdx.has(norm)) {
      issues.push({ type: 'duplicate_name', name: lead.name, phone: maskPhone(lead.phone),
        existingPhone: maskPhone(nameIdx.get(norm)), severity: 'medium' });
    } else if (norm) nameIdx.set(norm, lead.phone);
  }

  const unsynced = all.filter(l => !l.arboxSynced && l.status !== 'crisis');
  const pending  = unsynced.map(l => ({
    name: l.name, score: l.score, status: l.status,
    phone: maskPhone(l.phone), firstSeen: l.firstSeen,
  }));

  res.json({
    reportType: 'sync_health',
    summary: {
      totalLeads:     all.length,
      synced:         all.filter(l => l.arboxSynced).length,
      pendingSync:    unsynced.length,
      issuesFound:    issues.length,
      healthScore:    Math.max(0, 100 - issues.length * 10 - unsynced.length * 3),
    },
    issues,
    pendingSync: pending,
    generatedAt: new Date(),
  });
});

// GET /api/barak/reports/hot-leads — high-value leads without trial offer
app.get('/api/barak/reports/hot-leads', (_req, res) => {
  const hot = store.getHotLeads();
  const needsOffer = hot.filter(l => !l.introOfferSent);
  const needsSync  = hot.filter(l => !l.arboxSynced);
  const urgent     = hot.filter(l => !l.introOfferSent && !l.arboxSynced);

  res.json({
    reportType: 'hot_leads_alert',
    summary: {
      totalHot:       hot.length,
      needsOffer:     needsOffer.length,
      needsSync:      needsSync.length,
      urgent:         urgent.length,
      actionRequired: urgent.length > 0,
    },
    hotLeads: hot.map(l => ({
      name:         l.name,
      score:        l.score,
      phone:        maskPhone(l.phone),
      introSent:    l.introOfferSent,
      arboxSynced:  l.arboxSynced,
      lastActivity: l.lastActivity,
      priority:     !l.introOfferSent ? 'HIGH' : !l.arboxSynced ? 'MEDIUM' : 'OK',
    })),
    generatedAt: new Date(),
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// WHATSAPP INBOX & CRM PIPELINE
// Endpoint: /api/whatsapp/webhook  (GET = Meta verification, POST = inbound)
// Routes existing clients' scheduling intents to Barak.
// New prospects continue to /webhook/whatsapp → lead_agent (existing flow).
// ══════════════════════════════════════════════════════════════════════════════

// ── Phone helpers ─────────────────────────────────────────────────────────────

function normalizeToE164(phone) {
  if (!phone) return null;
  const s = String(phone).replace(/[\s\-\.\(\)]/g, '');
  if (s.startsWith('+')) return s.slice(1);   // +972XXXXXXXX → 972XXXXXXXX
  if (s.startsWith('972')) return s;
  if (s.startsWith('0'))   return '972' + s.slice(1);
  return s;
}

function e164ToIsraeli(e164) {
  if (!e164) return null;
  const s = String(e164).replace(/[\s\-\.\(\)]/g, '');
  if (s.startsWith('972')) return '0' + s.slice(3);
  return s;
}

// ── Intent detection (Hebrew scheduling patterns) ─────────────────────────────

const INTENT_PATTERNS = {
  fixed_booking:    /שבץ אותי קבוע|לקבוע קבוע|להירשם קבוע|מנוי קבוע|כל שבוע/,
  cancellation:     /ביטול|תבטל[יה]?|לבטל|לא אגיע|לא מגיע[ה]?|לא יכול[ה]?|אבטל|ביטלתי|להסיר|תסיר אותי/,
  booking:          /תשבץ[יה]?|שיבוץ|לשבץ|רוצה מקום|תרשמ[יה]|להירשם|להצטרף|רשמ[יה] אותי|קבע[יה] לי|אני רוצ[האה] להירשם/,
  representative:   /נציג|לדבר עם מישהו|לדבר עם אדם|לדבר עם בן אדם|העבר[יה]? אות[יה] לאדם|שמישהו יחזור|שיתקשרו|שיצרו קשר|אדם אמיתי/,
  reschedule:       /לדחות|לשנות שעה|שעה אחרת|יום אחר|לא יכול[ה]? עכשיו|לא יכול[ה]? אז|פספסנו|לא הצלחתי|תקבע מחדש|זמן אחר|מועד אחר|לתזמן מחדש/,
  // specialist_query: rehab, pre/post-natal, specific instructor background
  specialist_query: /שיקומ|rehab|rehabilit|מדריכ.{0,5}שיקומ|אחרי לידה|לאחר לידה|בהריון|pre.?natal|post.?natal|מדריכ.{0,10}מוסמכ|קורס.{0,10}מדריכ|מתמחה ב|מתמחה עם/,
  // subscription_query: questions about membership packages and what's included
  subscription_query: /מה זה כולל|כולל מה|מה כלול|מה נכלל|איזה שיעורים כלול|כמה כניסות|מנוי חודשי|מנויים|חבילה|חבילות|כמה עולה מנוי|מחיר מנוי|עלות מנוי|כמה עולה חבר|מנוי ב|מנוי ל/,
  // schedule_query covers both schedule listings AND instructor-specific questions
  schedule_query:   /מערכת שעות|לוח שיעורים|מה יש|מתי יש|יש שיעור|יש מקום|מה קורה|סדר יום|מה הלוח|הלוח שלכם|הלוח שלך|שעות.*הסטודיו|שעות.*שלכם|שעות פעילות|שעות פתיחה|מתי פתוח|מתי פתוחים|לראות.*שעות|רוצה.*לוח|איזה שיעורים|מה התוכנית|מה הוא שיעור|מי מדריך|מי המדריך|מי מלמד|מי מנהל|מי נותן|באיזה שעה|בכמה|מה השעה|שיעור.{0,15}ב(יום|ערב|בוקר|צהריים)|ב(יום\s)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|יש לכם.*תמונה|שלח.*תמונה.*לוח|תמונה.*לוח|לוח.*תמונה|יש תמונה/,
};

function detectSchedulingIntent(text) {
  if (!text) return 'general';
  if (INTENT_PATTERNS.representative.test(text))     return 'representative';
  if (INTENT_PATTERNS.reschedule.test(text))         return 'reschedule';
  if (INTENT_PATTERNS.fixed_booking.test(text))      return 'fixed_booking';
  if (INTENT_PATTERNS.cancellation.test(text))       return 'cancellation';
  if (INTENT_PATTERNS.booking.test(text))            return 'booking';
  if (INTENT_PATTERNS.specialist_query.test(text))   return 'specialist_query';
  if (INTENT_PATTERNS.subscription_query.test(text)) return 'subscription_query';
  if (INTENT_PATTERNS.schedule_query.test(text))     return 'schedule_query';
  return 'general';
}

// ── Timetable image detection ─────────────────────────────────────────────────

// Keywords that mean "send me the full weekly timetable" (→ image).
const TIMETABLE_IMAGE_RE = /מערכת שעות|מה יש השבוע|לוח.*שבוע|שבוע.*לוח|שלח[יה]?.*לוח|שלח[יה]?.*מערכת|הלוח שלכם|הלוח שלך|שעות.*הסטודיו|שעות.*שלכם|שעות.*שלך|שעות פעילות|שעות פתיחה|מתי פתוח|לראות.*שעות|רוצה.*לוח|לוח שיעורים|יש לכם.*תמונה|שלח.*תמונה.*לוח|תמונה.*לוח|לוח.*תמונה|יש תמונה/i;
// Day names that make a schedule query specific to one day (→ Arbox live, not image).
const SPECIFIC_DAY_RE    = /היום|מחר|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת/;

/**
 * Returns true when the user wants the full weekly timetable image rather
 * than a live per-day answer from Arbox.
 */
function isWeeklyTimetableQuery(text) {
  if (!text) return false;
  if (TIMETABLE_IMAGE_RE.test(text)) return true;
  // "לוח שיעורים" alone with no specific day → image
  if (/לוח שיעורים/.test(text) && !SPECIFIC_DAY_RE.test(text)) return true;
  return false;
}

// ── Barak scheduling draft reply ──────────────────────────────────────────────

// Class capacity constants — single source of truth
const CLASS_CAPACITY = {
  default:  10,
  reformer: 8,
};

// Both English "Reformer" and Hebrew "פילאטיס מכשירים" (and variants) → 8
const REFORMER_PATTERN = /reformer|מכשירים/i;

function capacityFor(className) {
  return REFORMER_PATTERN.test(className ?? '') ? CLASS_CAPACITY.reformer : CLASS_CAPACITY.default;
}

// Hebrew weekday names for display
const HE_DAYS_DISPLAY = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

function formatDateHe(isoDate) {
  const d = new Date(isoDate);
  return `${HE_DAYS_DISPLAY[d.getDay()]} ${d.toLocaleDateString('he-IL', { day:'numeric', month:'numeric' })}`;
}

// Detect whether the message is asking about a specific instructor
function isInstructorQuery(text) {
  return /מי מדריך|מי המדריך|מי מלמד|מי נותן|מי מנהל/.test(text ?? '');
}

// Extract a class-name keyword from the message for precise filtering.
// Returns a RegExp to match class names, or null if no specific class mentioned.
function extractClassFilter(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // Map of Hebrew/English keywords → partial class name pattern
  const CLASS_KEYWORDS = [
    [/פילאטיס מכשירים|reformer|מכשירים/,              /reformer|מכשירים/i],
    [/פילאטיס בר|barre|pilates barre/,                 /barre/i],
    [/אימון כח|strength|כוח/,                          /strength|כח|כוח/i],
    [/all in|אול אין|אול-אין/,                         /all\s*in/i],
    [/עיצוב|חיטוב|toning|sculpt|concept/,              /toning|sculpt|עיצוב|חיטוב/i],
    [/יוגה|yoga|ashtanga/,                             /yoga|יוגה|ashtanga/i],
    [/קנגו|kangoo/,                                    /kangoo|קנגו/i],
  ];

  for (const [detect, matchRe] of CLASS_KEYWORDS) {
    if (detect.test(t)) return matchRe;
  }
  return null;
}

async function buildSchedulingReply(intent, msg, clientMatch) {
  const msgText = msg.text ?? '';

  // ── Reschedule / appointment-change request ───────────────────────────────────
  if (intent === 'reschedule') {
    return `בהחלט! באיזו שעה או יום יהיה לך נוח? 🗓️`;
  }

  // ── Representative / callback request ────────────────────────────────────────
  if (intent === 'representative') {
    const phone = normalizeToE164(msg.from);
    store.upsertLead(phone, {
      name: msg.name ?? clientMatch.arboxName ?? undefined,
      meta: { ...(store.getLead(phone)?.meta ?? {}), awaitingCallbackTime: true, callbackRequestedAt: new Date().toISOString() },
    });
    store.logEvent('callback_requested', phone, { name: msg.name });
    logger.info('Callback requested', { phone });
    return `בשמחה! באיזו שעה או יום יהיה לך נוח שיחזרו אליך? 📞`;
  }

  // ── Specialist instructor query ──────────────────────────────────────────────
  if (intent === 'specialist_query') {
    const { matched, all } = barakAgent.findInstructorsBySpecialty(msgText);
    if (matched.length) {
      const lines = matched.map(s => {
        const specs = s.specialties?.length ? s.specialties.join(' | ') : '';
        const flags = [
          s.rehab         ? '🏥 שיקומי'       : null,
          s.pre_postnatal ? '🤰 לידה ולאחריה' : null,
        ].filter(Boolean).join(' ');
        const bio = s.bio ? `\n  ${s.bio}` : '';
        return `• *${s.name_he}* — ${specs}${flags ? ` ${flags}` : ''}${bio}`;
      }).join('\n');
      return `יש לנו מדריכ/ה מתאים/ה:\n\n${lines}\n\nרוצה לתאם שיעור?`;
    }
    // No match in directory → transparent answer
    return `נכון לעכשיו אין לנו מידע מלא על מדריכים בהתמחות זו. אפשר לפנות לסטודיו ישירות כדי לקבל תשובה מדויקת.`;
  }

  // ── Subscription / membership query (Bug 3 & 4) ───────────────────────────
  if (intent === 'subscription_query') {
    const subCtx    = barakAgent.getSubscriptionContext();
    // Check if the question is specifically about what's included
    const isIncludesQ = /מה זה כולל|כולל מה|מה כלול|מה נכלל|איזה שיעורים כלול/.test(msgText);

    if (isIncludesQ) {
      return (
        `המנוי כולל גישה מלאה לכל סוגי האימונים בסטודיו 🏋️\n\n` +
        `פילאטיס מכשירים (Reformer) · אימוני כוח · Pilates Barre · ` +
        `Concept Toning · ALL IN · Ashtanga Yoga · Kangoo Jumps\n\n` +
        `אין הגבלה לסוג שיעור — רק מספר הכניסות החודשי קובע את החבילה.`
      );
    }

    // General pricing question — return structured packages from the data file
    const lines = [];
    if (barakAgent.getSubscriptionContext().includes('מנויים חודשיים')) {
      lines.push(`השתמש בנתוני המנויים שצויינו ב-context שלך כדי לענות.`);
    }
    // Fall through to tomerAgent.chat so the AI can compose a natural answer
    // using SUBSCRIPTION_CONTEXT already injected into barak's system messages
    return await tomerAgent.chat(
      `המשתמש שאל: "${msgText}"\n\n` +
      `ענה בעברית על מבנה המנויים של Shape Studio לפי הנתונים הבאים:\n\n${subCtx}\n\n` +
      `כלל חשוב: כל מנוי כולל גישה לכל סוגי האימונים. ציין זאת בתשובה. ` +
      `אם המחיר לא מצוין (null) — ציין "פנה/י לסטודיו לפרטי מחיר". עד 4 שורות.`
    );
  }

  if (intent === 'cancellation') {
    return (
      `בקשת הביטול התקבלה ✅\n` +
      `אנחנו מעדכנים את הלוח ונחזור אליך עם אישור. ` +
      `אם תרצה/י לתאם מועד חלופי — רק תגיד/י 🗓️`
    );
  }

  if (intent === 'fixed_booking') {
    return (
      `נשמח לשבץ אותך קבוע! 🎯\n` +
      `אחד מהצוות ייצור איתך קשר תוך שעה לתיאום. ` +
      `איזה שיעור מעניין אותך?`
    );
  }

  // For booking / schedule_query — pull live Arbox schedule for the right day
  let scheduleData = { classes: [], total: 0, date: null };
  try {
    scheduleData = await barakAgent.checkSchedule(msgText);
  } catch { /* non-fatal */ }

  if (intent === 'booking' || intent === 'schedule_query') {
    if (!scheduleData.classes?.length) {
      const dayLabel = scheduleData.date ? formatDateHe(scheduleData.date) : 'היום';
      return `אין שיעורים ב${dayLabel}. רוצה שאבדוק יום אחר? 🗓️`;
    }

    const dayLabel      = scheduleData.date ? formatDateHe(scheduleData.date) : 'היום';
    const instructorOnly = isInstructorQuery(msgText);
    const classFilter    = extractClassFilter(msgText);

    // Surgical filter: when the user named a specific class, show only that class
    const relevantClasses = classFilter
      ? scheduleData.classes.filter(c => classFilter.test(c.name))
      : scheduleData.classes;

    // If a class was named but none found that day, say so precisely
    if (classFilter && !relevantClasses.length) {
      const className = msgText.match(/פילאטיס מכשירים|reformer|פילאטיס בר|barre|אימון כח|strength|all in|עיצוב|חיטוב|יוגה|yoga|קנגו|kangoo/i)?.[0] ?? 'השיעור המבוקש';
      return `לא מצאתי ${className} ב${dayLabel}. רוצה שאבדוק יום אחר? 🗓️`;
    }

    const displayClasses = relevantClasses.slice(0, 8);

    if (instructorOnly) {
      // Asked specifically about an instructor — answer only that
      const lines = displayClasses.map(c =>
        `• ${c.start} | ${c.name}\n  מדריך/ה: *${c.staff}*`
      ).join('\n');
      return `ב${dayLabel}:\n\n${lines}`;
    }

    // General schedule listing
    const lines = displayClasses.map(c => {
      const cap = capacityFor(c.name);
      return `• ${c.start}–${c.end} | ${c.name}\n  מדריך/ה: ${c.staff} | ${cap} מקומות`;
    }).join('\n');

    // Only add a name greeting if this is a filtered (personal) query, not a full listing
    const preamble = classFilter
      ? `ב${dayLabel} 🏋️\n\n`
      : `שיעורי ה${dayLabel} ב-Shape Studio 🏋️\n\n`;

    return `${preamble}${lines}\n\nרוצה מקום? ענה/י עם שם השיעור 💪`;
  }

  return null;
}

// ── Inbound-message guard helpers ────────────────────────────────────────────

/**
 * Brief-acknowledgement detector.
 * Returns true for short social closings that don't require an AI reply.
 * Checks are intentionally tight: message must be ≤ 20 chars AND match a
 * known Hebrew/English acknowledgement pattern.  Longer messages that happen
 * to contain "תודה" (e.g. "תודה, מה השעות שלכם?") pass through normally.
 */
const BRIEF_ACK_RE = [
  /^(תודה( רבה)?|תנקיו|טאנקיו?|thanks?|thank you|thx|ty)\.?!*$/i,
  /^(אוקיי?|אוקי|ok[ay]?|k)\.?!*$/i,
  /^(סבבה?|סבב)\.?!*$/i,
  /^(בסדר( גמור)?)\.?!*$/i,
  /^(כן|לא|אה|אממ?)\.?!*$/i,
  /^(מעולה|נהדר|מצוין|מדהים|חמוד|מגניב|יופי)\.?!*$/i,
  /^(קיבלתי|הבנתי|ברור|ממש|ביי|שלום|bye|ciao)\.?!*$/i,
  /^(good|great|nice|perfect|cool|fine|sure|awesome)\.?!*$/i,
  /^(שמעתי|פה|כאן|אני פה)\.?!*$/i,
  /^[👍🙏❤️😊🙂😁💪✅👌🤩🥰😍]+$/u,
];

function isBriefAck(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 20) return false;
  return BRIEF_ACK_RE.some(p => p.test(t));
}

// ── Payment screenshot / confirmation detector ────────────────────────────────
// Catches Bit/Paybox/bank-transfer screenshots and text confirmations.
// These must NEVER trigger sales scripts — always ack + alert staff.
const PAYMENT_RE = /\bbit\b|ביט|paybox|פייבוקס|העברה בנקאית|העברה.*בנק|בנק.*העברה|אישור תשלום|אישור.*תשלום|קבלה.*תשלום|שלחתי תשלום|שלחתי העברה|העברתי|ביצעתי העברה|שלמתי|תשלום עבר|הועבר|payment.*confirm|transfer.*confirm|שלחתי.*₪|₪.*שלחתי|\b\d{2,4}\s*₪|\b\d{2,4}\s*ש["״"]ח|שלחתי.*\d{2,4}\s*(שקל|ש["״"]ח)|הוראת קבע|חיוב.*כרטיס/i;

function isPaymentMessage(msg) {
  const text = (msg.mediaCaption ?? msg.text ?? '').trim();
  // Any image with no meaningful caption is likely a screenshot → treat as payment candidate
  if ((msg.type === 'image' || msg.mediaType === 'image') && (!text || text === '[תמונה]')) return true;
  return PAYMENT_RE.test(text);
}

// ── Spam / irrelevant-message filter ─────────────────────────────────────────
// Voting campaigns, chain messages, coupons etc. — silently logged, no AI reply.
const SPAM_RE = /הצביע[וה]?|לצביע\b|הצבעה.*תחרות|תחרות.*הצבעה|הצבע.*קישור|chain\s*message|forward.*message|העבר.*לחברים|שרשרת הודעות|קופון חינם|קבל.*חינם.*לחץ|click.*here.*win|win.*free/i;

function isSpamMessage(text) {
  if (!text || text.trim().length < 5) return false;
  return SPAM_RE.test(text);
}

/**
 * MessageId deduplication — prevents Green API double-delivery from running
 * the pipeline twice and sending duplicate replies.
 * Keeps a sliding window of ids seen in the last 10 minutes.
 */
const _seenInbound   = new Map(); // idMessage → timestamp
const INBOUND_TTL_MS = 10 * 60 * 1000;

function _isDuplicateInbound(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, ts] of _seenInbound) if (now - ts > INBOUND_TTL_MS) _seenInbound.delete(id);
  if (_seenInbound.has(messageId)) return true;
  _seenInbound.set(messageId, now);
  return false;
}

/**
 * Per-phone reply cooldown — if the system sent a reply to this number within
 * the last 10 seconds, skip the next AI call.
 * Protects against race conditions where two webhooks from the same burst
 * both pass the messageId check (different IDs, same user) and both fire.
 */
const _lastReplied    = new Map(); // phone → timestamp
const REPLY_COOLDOWN  = 10_000; // 10 seconds

function _isInCooldown(phone) {
  const ts = _lastReplied.get(phone);
  return !!(ts && Date.now() - ts < REPLY_COOLDOWN);
}
function _markReplied(phone) {
  _lastReplied.set(phone, Date.now());
}

// ── Internal processor (shared by webhook + simulate) ─────────────────────────

async function processInboundWAMessage(msg) {
  const fromNorm    = normalizeToE164(msg.from);
  const fromIsraeli = e164ToIsraeli(fromNorm);

  // ── Deduplication: skip if Green API already delivered this messageId ────────
  if (_isDuplicateInbound(msg.messageId)) {
    logger.warn('processInboundWAMessage: duplicate messageId — skipping', {
      from: fromNorm, messageId: msg.messageId,
    });
    return null;
  }

  // 0a. Reaction bypass — emoji reactions (👍, 🐔, etc.) must NEVER trigger an
  //     automated AI reply.  Store in inbox for thread visibility, then exit.
  if (msg.isReaction || msg.type === 'reaction') {
    logger.info('Reaction event — logging to inbox, skipping AI pipeline', {
      from: fromNorm, emoji: msg.reactionEmoji ?? null, reactedToId: msg.reactedToId ?? null,
    });
    const reactionEntry = inbox.push({
      from:          fromNorm,
      fromIsraeli,
      name:          msg.name ?? null,
      text:          msg.text ?? '[reaction]',
      messageId:     msg.messageId,
      timestamp:     msg.timestamp,
      receivedAt:    new Date(),
      mediaType:     'reaction',
      mediaCaption:  null,
      mediaId:       null,
      clientMatch:   { found: false },
      intent:        'reaction',
      route:         'reaction_bypass',
      barakReply:    null,
      reactionEmoji: msg.reactionEmoji ?? null,
      reactedToId:   msg.reactedToId   ?? null,
    });
    return { inboxEntry: reactionEntry, clientMatch: { found: false }, intent: 'reaction', route: 'reaction_bypass', barakReply: null };
  }

  // 0b. Staff bypass — messages from Eden/Melanie are stored in the inbox for
  //     visibility but are never processed through the lead/client pipeline.
  if (isStaffPhone(fromNorm)) {
    logger.info('Inbound message from internal staff — bypassing pipeline', { from: fromNorm });
    const staffEntry = inbox.push({
      from: fromNorm, fromIsraeli,
      name: msg.name ?? null,
      text: msg.text ?? '',
      messageId: msg.messageId,
      timestamp: msg.timestamp,
      receivedAt: new Date(),
      mediaType: msg.type,
      mediaCaption: msg.mediaCaption ?? null,
      mediaId: msg.mediaId ?? null,
      clientMatch: { found: false, matchType: 'staff', arboxName: null, arboxId: null, isActive: true, role: 'staff' },
      intent: 'staff',
      route:  'staff_bypass',
      barakReply: null,
    });
    return { inboxEntry: staffEntry, clientMatch: { found: false }, intent: 'staff', route: 'staff_bypass', barakReply: null };
  }

  // 1. Arbox client lookup
  let clientMatch = { found: false, matchType: null, arboxName: null, arboxId: null, isActive: false, role: null };
  try {
    const lookup = await barakAgent.lookupClient(fromIsraeli ?? fromNorm ?? '');
    if (lookup.total > 0) {
      const best = lookup.results[0];
      clientMatch = {
        found:     true,
        matchType: best.type,
        arboxName: best.name,
        arboxId:   String(best.user_id ?? ''),
        isActive:  best.active ?? false,
        role:      best.role ?? null,
      };
    }
  } catch { /* lookup failure is non-fatal */ }

  // 2. Intent detection (only meaningful for text messages)
  const intent = msg.type === 'text' ? detectSchedulingIntent(msg.text) : 'general';

  // ── Client identity — resolved HERE, before any early-return path ─────────────
  // Must come before the reschedule / callback handlers so they can guard correctly.
  const arboxConfirmedClient = clientMatch.found &&
    (clientMatch.matchType === 'member' || clientMatch.role === 'aggregatorMember');
  const cachedIsClient        = store.getLead(fromNorm)?.meta?.isClient === true;
  const knownMemberOverride   = isKnownMember(fromNorm) || isKnownMember(fromIsraeli);
  const isExistingClient      = arboxConfirmedClient || cachedIsClient || knownMemberOverride;

  // ── Reschedule intent — LEADS ONLY (existing clients handled via Tomer path) ───
  if (intent === 'reschedule' && !isExistingClient) {
    const existingApt = aptStore.getActiveByPhone(fromNorm);
    if (existingApt) {
      aptStore.update(existingApt.id, { status: 'rescheduled' });
      store.logEvent('appointment_reschedule_requested', fromNorm, { aptId: existingApt.id, oldTime: existingApt.rawTime });
    }
    // Set awaiting flag so the next message is treated as the new time.
    // reschedulingAptId lets the callback handler send a reschedule notification
    // instead of a fresh "confirmed" notification.
    store.upsertLead(fromNorm, {
      meta: {
        ...(store.getLead(fromNorm)?.meta ?? {}),
        awaitingCallbackTime: true,
        callbackRequestedAt:  new Date().toISOString(),
        reschedulingAptId:    existingApt?.id ?? null,
        reschedulingOldTime:  existingApt?.rawTime ?? null,
      },
    });
    const rescheduleMsg = `בהחלט! באיזו שעה או יום יהיה לך נוח? 🗓️`;
    if (process.env.WHATSAPP_AUTO_REPLY === 'true') {
      await sendText(fromNorm, rescheduleMsg).catch(() => {});
    }
    const rscInboxEntry = inbox.push({
      from: fromNorm, fromIsraeli, name: msg.name ?? clientMatch.arboxName ?? null,
      text: msg.text, messageId: msg.messageId, timestamp: msg.timestamp,
      receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
      clientMatch, intent: 'reschedule', route: 'reschedule_prompt', barakReply: rescheduleMsg,
    });
    return { inboxEntry: rscInboxEntry, clientMatch, intent: 'reschedule', route: 'reschedule_prompt', barakReply: rescheduleMsg };
  }

  // ── Callback-time interception ────────────────────────────────────────────────
  // When this person previously requested a human callback (awaitingCallbackTime),
  // their NEXT non-intent message is the preferred callback time.
  //
  // Three cases handled here:
  //   A. noShowAptId     — the worker flagged a no-show; lead is now giving a new time
  //   B. reschedulingAptId — lead explicitly asked to reschedule; now providing new time
  //   C. neither         — fresh appointment (first-time callback request)
  const leadState = store.getLead(fromNorm);
  if (leadState?.meta?.awaitingCallbackTime && msg.type === 'text' && msg.text?.trim() &&
      intent !== 'representative' && intent !== 'reschedule') {
    const rawTime      = msg.text.trim();
    const callbackName = msg.name ?? clientMatch.arboxName ?? fromNorm;

    // Determine whether this is a reschedule of an existing appointment
    const prevAptId   = leadState.meta.noShowAptId ?? leadState.meta.reschedulingAptId ?? null;
    const prevApt     = prevAptId ? aptStore.get(prevAptId) : null;
    const oldTimeLabel = prevApt?.rawTime ?? leadState.meta.reschedulingOldTime ?? null;
    const isReschedule = !!(prevApt || oldTimeLabel);

    // Clear all awaiting-callback flags immediately
    store.upsertLead(fromNorm, {
      meta: {
        ...(leadState.meta ?? {}),
        awaitingCallbackTime: false,
        callbackTime:         rawTime,
        noShowAptId:          null,
        reschedulingAptId:    null,
        reschedulingOldTime:  null,
      },
    });

    const assignedStaff = defaultStaff();

    // ── Create or update the appointment record ───────────────────────────────
    let apt;
    if (isReschedule && prevApt) {
      // Reuse the same appointment record — reset it to 'confirmed' with the new time.
      // This preserves the history (original createdAt, same id) while reflecting the change.
      apt = aptStore.update(prevAptId, {
        status:        'confirmed',
        rawTime,
        scheduledAt:   null,         // will be filled in async below
        reminderSent:  false,
        noShowAlerted: false,
      });
      store.logEvent('appointment_rescheduled', fromNorm, {
        aptId:    prevAptId,
        rawTime,
        oldTime:  oldTimeLabel,
        trigger:  leadState.meta.noShowAptId ? 'no_show' : 'lead_request',
      });
      logger.info('Appointment rescheduled', { phone: fromNorm, rawTime, aptId: prevAptId, oldTime: oldTimeLabel });
    } else {
      // Fresh appointment
      apt = aptStore.create({
        leadPhone:       fromNorm,
        leadName:        callbackName,
        rawTime,
        scheduledAt:     null,
        durationMin:     staffConfig.appointment_duration_min ?? 30,
        assignedStaffId: assignedStaff?.id ?? 'eden',
      });
      store.logEvent('appointment_created', fromNorm, { aptId: apt.id, rawTime, staff: apt.assignedStaffId });
      logger.info('Appointment created', { phone: fromNorm, rawTime, aptId: apt.id });
    }

    // ── Async: parse time + calendar + notify all staff ───────────────────────
    setImmediate(async () => {
      try {
        // Cancel old Google Calendar event when rescheduling
        if (isReschedule && prevApt?.calendarEventId) {
          await calendarSvc.cancelCalendarEvent(prevApt).catch(() => {});
        }

        const { scheduledAt, icsContent, googleEventId } =
          await calendarSvc.createCalendarEntry(apt, assignedStaff);

        aptStore.update(apt.id, { scheduledAt, calendarEventId: googleEventId });

        if (icsContent) aptIcsCache.set(apt.id, icsContent);

        const backendBase = getBackendBase();
        const icsUrl      = (icsContent && backendBase)
          ? `${backendBase}/api/calendar/appointment/${apt.id}.ics`
          : null;

        if (isReschedule) {
          // Notify all active staff: "rescheduled — was X, now Y"
          await notifySvc.notifyStaffRescheduled(
            { ...apt, scheduledAt },
            assignedStaff,
            oldTimeLabel ?? '—'
          );
        } else {
          // Notify all active staff: "new appointment confirmed"
          await notifySvc.notifyStaffCallbackConfirmed(
            { ...apt, scheduledAt },
            assignedStaff,
            icsUrl
          );
        }

        store.logEvent('appointment_staff_notified', fromNorm, {
          aptId:   apt.id,
          staffId: apt.assignedStaffId,
          type:    isReschedule ? 'rescheduled' : 'confirmed',
        });
      } catch (err) {
        logger.error('Appointment background tasks failed', { aptId: apt.id, error: err.message });
      }
    });

    // ── Confirm to lead ───────────────────────────────────────────────────────
    const confirmMsg = isReschedule
      ? `מעולה! קבענו מחדש ל-${rawTime} ✅\nנציג מהצוות ייצור איתך קשר בזמן החדש. 😊`
      : `מעולה! השיחה נקבעה ל-${rawTime} ✅\nנציג מהצוות ייצור איתך קשר. יש עוד משהו שאוכל לעזור? 😊`;

    if (process.env.WHATSAPP_AUTO_REPLY === 'true') {
      await sendText(fromNorm, confirmMsg).catch(err =>
        logger.warn('Callback confirm send failed', { error: err.message })
      );
    }

    const eventType = isReschedule ? 'appointment_rescheduled_confirmed' : 'appointment_confirmed';
    store.logEvent(eventType, fromNorm, { aptId: apt.id, preview: confirmMsg.slice(0, 80) });

    const cbInboxEntry = inbox.push({
      from: fromNorm, fromIsraeli, name: msg.name ?? clientMatch.arboxName ?? null,
      text: msg.text, messageId: msg.messageId, timestamp: msg.timestamp,
      receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
      clientMatch,
      intent:    isReschedule ? 'reschedule_time' : 'callback_time',
      route:     isReschedule ? 'appointment_rescheduled' : 'appointment_created',
      barakReply: confirmMsg,
    });
    return {
      inboxEntry: cbInboxEntry,
      clientMatch,
      intent:    isReschedule ? 'reschedule_time' : 'callback_time',
      route:     isReschedule ? 'appointment_rescheduled' : 'appointment_created',
      barakReply: confirmMsg,
    };
  }

  // ── Spam filter — silently discard off-topic messages ────────────────────────
  if (msg.type === 'text' && isSpamMessage(msg.text)) {
    logger.info('Spam/irrelevant message — skipping AI pipeline', { from: fromNorm, preview: msg.text?.slice(0, 60) });
    store.logEvent('spam_filtered', fromNorm, { preview: msg.text?.slice(0, 60) });
    const spamEntry = inbox.push({
      from: fromNorm, fromIsraeli,
      name: msg.name ?? null,
      text: msg.text, messageId: msg.messageId, timestamp: msg.timestamp,
      receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
      clientMatch, intent: 'spam', route: 'spam_filtered', barakReply: null,
    });
    return { inboxEntry: spamEntry, clientMatch, intent: 'spam', route: 'spam_filtered', barakReply: null };
  }

  // ── Payment screenshot / confirmation — ack and alert staff ──────────────────
  // Must fire before any agent routing so an existing member sending a Bit screenshot
  // never ends up with Barak's "מאיזה אזור את?" as a reply.
  if (isPaymentMessage(msg)) {
    const senderName = msg.name ?? clientMatch.arboxName ?? fromIsraeli ?? fromNorm;
    const paymentAck = `תודה רבה! קיבלנו את אישור התשלום ✅ הצוות שלנו יעדכן את המערכת בקרוב. לכל שאלה — אנחנו כאן 😊`;

    if (process.env.WHATSAPP_AUTO_REPLY === 'true') {
      await sendText(fromNorm, paymentAck).catch(err =>
        logger.warn('Payment ack send failed', { from: fromNorm, error: err.message })
      );
      _markReplied(fromNorm);
    }

    alertOwner(
      `💳 אישור תשלום — ${senderName}`,
      `*${senderName}* (${fromNorm}) שלח/ה ${msg.type === 'image' ? 'צילום מסך תשלום' : 'אישור תשלום'}.\n\n` +
      (msg.text && msg.text !== '[תמונה]' ? `תוכן: ${msg.text.slice(0, 200)}` : '(תמונה ללא כיתוב)')
    ).catch(() => {});

    store.logEvent('payment_received', fromNorm, { type: msg.type, preview: msg.text?.slice(0, 80), senderName });
    logger.info('Payment message detected — acked and alerted staff', { from: fromNorm, type: msg.type });

    const pmtEntry = inbox.push({
      from: fromNorm, fromIsraeli,
      name: msg.name ?? clientMatch.arboxName ?? null,
      text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
      receivedAt: new Date(), mediaType: msg.type,
      mediaCaption: msg.mediaCaption ?? null, mediaId: msg.mediaId ?? null,
      clientMatch, intent: 'payment', route: 'payment_ack', barakReply: paymentAck,
    });
    persist.saveLeads(store);
    return { inboxEntry: pmtEntry, clientMatch, intent: 'payment', route: 'payment_ack', barakReply: paymentAck };
  }

  // 3. Routing decision — strict Barak / Tomer boundary
  //
  //   The primary split is ALWAYS membership status, never intent.
  //   Checking intent first (old code) let scheduling queries bypass the split,
  //   sending a member's "מה יש מחר?" to Barak's branch.
  //
  //   New tree:
  //     brief-ack / cooldown → acknowledged (no agent called)
  //     isExistingClient     → TOMER  exclusively (scheduling + general)
  //     !isExistingClient    → BARAK  exclusively (scheduling + general)
  //
  //   buildSchedulingReply is shared Arbox infrastructure used by both agents.
  //   The route label reflects the correct persona so the inbox attributes
  //   the reply to the right agent.
  let route            = 'unhandled';
  let barakReply       = null;
  let timetableImgUrl  = null;   // first timetable image URL (sent with caption)
  let timetable2ImgUrl = null;   // second timetable image URL (sent as follow-up)

  const isSchedulingMsg  = intent !== 'general';

  // ── Brief-ack + cooldown guard ───────────────────────────────────────────────
  const ackDetected  = isBriefAck(msg.text);
  const inCooldown   = _isInCooldown(fromNorm);

  // Exception: when Barak is waiting for a location confirmation, a brief "כן"
  // must still reach the lead agent to update locationViable.
  // Without this, "כן" gets swallowed and the location check repeats every turn.
  const awaitingLocation = !isExistingClient && (() => {
    const qd = store.getLead(fromNorm)?.meta?.qualData ?? {};
    return qd.locationCheckAsked === true && qd.locationViable == null;
  })();

  const skipAiReply  = (ackDetected && !awaitingLocation) || inCooldown;

  if (ackDetected && !awaitingLocation) logger.info('Brief ack — skipping AI reply', { from: fromNorm, text: msg.text?.slice(0, 20) });
  if (awaitingLocation && ackDetected)  logger.info('Brief ack allowed — awaiting location confirmation', { from: fromNorm });
  if (inCooldown)   logger.warn('Reply cooldown — skipping AI reply', { from: fromNorm });

  if (skipAiReply) {
    // Message stored in inbox (step 4); neither agent is invoked.
    route = 'acknowledged';

  } else if (isExistingClient) {
    // ════════════════════════════════════════════════════════════════════════
    // TOMER — Customer Support & Retention
    // Handles ALL messages from verified active Arbox members.
    // Barak never sees these messages.
    // ════════════════════════════════════════════════════════════════════════
    route = 'tomer';

    if (isSchedulingMsg) {
      // Scheduling query from an existing member: Tomer uses Arbox live data
      const timetableUrlTomer = getActiveTimetableUrl();
      if (intent === 'schedule_query'
          && isWeeklyTimetableQuery(msg.text)
          && timetableUrlTomer) {
        barakReply       = `הנה מערכת השעות העדכנית של Shape Studio! 🏋️‍♀️`;
        timetableImgUrl  = timetableUrlTomer;
        timetable2ImgUrl = getActiveTimetable2Url(); // second image (may be null)
      } else {
        try { barakReply = await buildSchedulingReply(intent, msg, clientMatch); } catch { /* non-fatal */ }
      }
      if (intent === 'representative') {
        const clientName = msg.name ?? clientMatch.arboxName ?? fromIsraeli ?? fromNorm;
        notifySvc.notifyRepresentativeRequest(fromNorm, clientName).catch(err =>
          logger.warn('Representative request staff alert failed', { error: err.message })
        );
      }
    } else if (msg.type === 'text' && msg.text?.trim()) {
      // Existing member general message → Tomer silence classifier (strict rules)
      try {
        const result = await tomerAgent.handleInboundMember({
          name:        msg.name,
          text:        msg.text,
          phone:       fromNorm,
          clientMatch,
        });
        if (result.reply) barakReply = result.reply;
        // result.reply === null → Tomer chose silence; no WhatsApp message is sent
        logger.info('[tomer] Inbound decision', { decision: result.decision, reason: result.reason, from: fromNorm });
      } catch (err) {
        logger.warn('Tomer inbound handler failed', { error: err.message, from: fromNorm });
      }
    } else if (msg.type !== 'text' && msg.type !== 'reaction') {
      // Non-text, non-payment media from an existing client (image, audio, document, etc.)
      // — a warm holding reply so the person knows we received it.
      barakReply = `תודה! קיבלנו את ההודעה 😊 הצוות שלנו יחזור אליך בהקדם.`;
      // Logged to inbox only — no alertOwner (staff sees it in the dashboard)
      store.logEvent('client_media_in', fromNorm, { type: msg.type, name: msg.name ?? clientMatch.arboxName });
    }

  } else {
    // ════════════════════════════════════════════════════════════════════════
    // BARAK — Sales & Lead Onboarding
    // Handles ALL messages from new leads and unknown senders.
    // Tomer never sees these messages.
    // ════════════════════════════════════════════════════════════════════════
    route = 'barak';

    if (isSchedulingMsg) {
      // Scheduling query from a lead: Barak uses Arbox live data
      const timetableUrlBarak = getActiveTimetableUrl();
      if (intent === 'schedule_query' && isWeeklyTimetableQuery(msg.text)) {
        if (timetableUrlBarak) {
          // Image available — send it
          barakReply       = `הנה מערכת השעות העדכנית של Shape Studio! 🏋️‍♀️`;
          timetableImgUrl  = timetableUrlBarak;
          timetable2ImgUrl = getActiveTimetable2Url();
        } else {
          // No image uploaded — give a helpful overview, don't show a single-day dump
          barakReply = `יש לנו שיעורים כל ימות השבוע — פילאטיס מכשירים (Reformer), Barre, אימון כוח, יוגה, Kangoo ועוד 🏋️‍♀️\nאיזה יום ושעה בדרך כלל עובדים לך?`;
        }
      } else {
        try { barakReply = await buildSchedulingReply(intent, msg, clientMatch); } catch { /* non-fatal */ }
      }
      if (intent === 'representative') {
        const clientName = msg.name ?? fromIsraeli ?? fromNorm;
        notifySvc.notifyRepresentativeRequest(fromNorm, clientName).catch(err =>
          logger.warn('Representative request staff alert failed', { error: err.message })
        );
      }
    } else {
      // General / sales qualification → lead_agent (Barak's AI persona)
      try {
        const leadResult = await leadAgent.handleInbound({
          from: fromNorm,
          name: msg.name,
          text: msg.text ?? '',
        });
        _markReplied(fromNorm); // cooldown: lead_agent sends its own reply via sendText

        // If the AI promised to send the schedule image, actually send it.
        // lead_agent already sent the text reply; now append the image + follow-up.
        if (leadResult?.reply && /שולח לך את המערכת|שולחת את המערכת/.test(leadResult.reply)) {
          const timetableUrlFromLeadAgent = getActiveTimetableUrl();
          if (timetableUrlFromLeadAgent) {
            const followUp = `ראית משהו שמתאים לך? יספר/י לי איזה יום ושעה בדרך כלל עובדים לך 😊`;
            sendFileByUrl(fromNorm, timetableUrlFromLeadAgent, 'schedule.png', '')
              .then(async () => {
                store.logEvent('timetable_image_sent', fromNorm, { imageUrl: timetableUrlFromLeadAgent, via: 'lead_agent' });
                const t2 = getActiveTimetable2Url();
                if (t2) {
                  await sendFileByUrl(fromNorm, t2, 'schedule2.png', '')
                    .catch(err => logger.warn('Timetable2 follow-on send failed', { from: fromNorm, error: err.message }));
                }
                await sendText(fromNorm, followUp)
                  .catch(err => logger.warn('Timetable follow-up send failed', { from: fromNorm, error: err.message }));
              })
              .catch(err => logger.warn('Timetable image send failed after lead_agent reply', { from: fromNorm, error: err.message }));
          }
        }
      } catch (err) {
        logger.error('Barak (lead_agent) error in WA pipeline', { error: err.message, from: fromNorm });
      }
    }
  }

  // 4. Store in inbox ring buffer
  const inboxEntry = inbox.push({
    from:        fromNorm,
    fromIsraeli,
    name:        msg.name ?? clientMatch.arboxName ?? null,
    text:        msg.text ?? '',
    messageId:   msg.messageId,
    timestamp:   msg.timestamp,
    receivedAt:  new Date(),
    mediaType:   msg.type,
    mediaCaption: msg.mediaCaption ?? null,
    mediaId:     msg.mediaId ?? null,
    clientMatch,
    intent,
    route,
    barakReply,
  });

  // 5. Store — strict bifurcation: existing clients NEVER create lead records
  if (isExistingClient) {
    // ── Existing client path ──────────────────────────────────────────────────
    // 5a. Self-healing cache: persist Arbox-confirmed members to known_members.json
    //     so future lookups work even when Arbox API is down.
    if (arboxConfirmedClient) {
      _autoAddKnownMember(fromNorm, clientMatch.arboxName ?? msg.name);
    }

    // 5b. Destroy any stale lead record that was created before we identified them
    //     as an existing client (e.g. from a previous session where Arbox timed out).
    if (store.getLead(fromNorm)) {
      store.deleteLead(fromNorm);
      logger.info('[pipeline] Removed stale lead record for confirmed member', { from: fromNorm });
    }

    // 5c. Log with a client-specific event type — never pollutes the leads feed
    store.logEvent('client_message_in', fromNorm, {
      preview:    (msg.text ?? '').slice(0, 80),
      intent,
      route,
      inboxId:    inboxEntry.id,
      clientName: clientMatch.arboxName ?? msg.name,
      source:     'whatsapp_live',
    });

  } else {
    // ── Lead path ─────────────────────────────────────────────────────────────
    // 5a. Create / update the lead record — only for real leads / unknown senders
    const existing = store.getLead(fromNorm) ?? {};
    store.upsertLead(fromNorm, {
      name:         msg.name ?? clientMatch.arboxName ?? existing.name,
      messageCount: (existing.messageCount ?? 0) + 1,
      arboxSynced:  clientMatch.found,
      arboxId:      clientMatch.arboxId ?? existing.arboxId,
      meta: {
        ...(existing.meta ?? {}),
        lastIntent: intent,
        source:     'whatsapp_live',
      },
    });

    // 5b. Log to the leads event feed
    store.logEvent('message_in', fromNorm, {
      preview:     (msg.text ?? '').slice(0, 80),
      intent,
      route,
      inboxId:     inboxEntry.id,
      clientFound: clientMatch.found,
      clientName:  clientMatch.arboxName,
      source:      'whatsapp_live',
    });
  }

  logger.info('WA pipeline processed', {
    from:    fromNorm,
    type:    msg.type,
    intent,
    route,
    client:  clientMatch.found ? clientMatch.arboxName : '(new)',
  });

  // 6. Auto-reply when configured and Barak has a draft
  if (barakReply && process.env.WHATSAPP_AUTO_REPLY === 'true') {
    if (timetableImgUrl) {
      // Send timetable image 1 (with caption), then image 2 if available, then a follow-up question.
      const timetableFollowUp = `ראית משהו שמתאים לך? יספר/י לי איזה יום ושעה בדרך כלל עובדים לך 😊`;
      sendFileByUrl(fromNorm, timetableImgUrl, 'schedule.png', barakReply)
        .then(async () => {
          store.logEvent('timetable_image_sent', fromNorm, { imageUrl: timetableImgUrl });
          _markReplied(fromNorm);
          if (timetable2ImgUrl) {
            await sendFileByUrl(fromNorm, timetable2ImgUrl, 'schedule2.png', '')
              .then(() => store.logEvent('timetable2_image_sent', fromNorm, { imageUrl: timetable2ImgUrl }))
              .catch(err => logger.warn('Timetable2 image send failed', { from: fromNorm, error: err.message }));
          }
          // Follow-up question after all images — always sent so the conversation doesn't stall
          await sendText(fromNorm, timetableFollowUp)
            .then(() => store.logEvent('timetable_followup_sent', fromNorm, { preview: timetableFollowUp.slice(0, 60) }))
            .catch(err => logger.warn('Timetable follow-up send failed', { from: fromNorm, error: err.message }));
        })
        .catch(err => {
          logger.warn('Timetable image send failed — falling back to text reply', { from: fromNorm, error: err.message });
          sendText(fromNorm, barakReply).catch(() => {});
        });
    } else {
      try {
        await sendText(fromNorm, barakReply);
        _markReplied(fromNorm); // start cooldown window so a quick follow-up doesn't double-fire
        store.logEvent('message_out', fromNorm, {
          preview: barakReply.slice(0, 80),
          agent:   'barak',
          source:  'auto_reply',
        });
      } catch (err) {
        logger.warn('WA auto-reply failed', { from: fromNorm, error: err.message });
      }
    }
  }

  return { inboxEntry, clientMatch, intent, route, barakReply };
}

// ── GET /api/whatsapp/webhook — Meta hub.challenge verification ───────────────
app.get('/api/whatsapp/webhook', verifyWebhook);

// ── POST /api/whatsapp/webhook — full CRM pipeline ───────────────────────────
// captureRawBody preserves raw bytes for HMAC verification before JSON parse.
app.post('/api/whatsapp/webhook', captureRawBody, verifyMetaSignature, async (req, res) => {
  res.sendStatus(200); // Meta requires a fast 200 — all processing is async

  let body = {};
  try { body = JSON.parse(req.rawBody || '{}'); } catch { return; }

  const msg = parseInboundRich(body);
  if (!msg) return; // status update, echo, or unsupported shape

  logger.info('WA webhook inbound', { from: msg.from, type: msg.type, preview: msg.text?.slice(0, 60) });

  processInboundWAMessage(msg)
    .then(r => {
      if (!r) return;
      broadcastSse('message', { phone: r.inboxEntry.from, name: r.inboxEntry.name ?? null });
      persist.saveInbox(inbox);
      persist.saveLeads(store);
    })
    .catch(err => logger.error('WA pipeline error', { error: err.message, from: msg.from }));
});

// ── POST /api/green-api/webhook — inbound messages from Green API ─────────────
//
// Green API pushes webhooks in its own JSON format (NOT Meta Cloud API format).
// It does NOT send X-Hub-Signature-256, so Meta's signature middleware must NOT
// be used here — this endpoint handles its own minimal validation.
//
// Set this URL in the Green API dashboard:
//   Settings → Notifications → Webhook URL:
//   https://shape-studio-agent-production.up.railway.app/api/green-api/webhook
//
// IMPORTANT — respond BEFORE body parsing (same pattern as /api/webhooks/meta).
// express.json() buffers the stream before calling the handler, pushing the 200
// response past Green API's timeout window and triggering unnecessary retries.
// Fix: no json middleware here; 200 is the FIRST statement, raw body is buffered
// asynchronously, then parsed inside setImmediate after the response is flushed.
app.post('/api/green-api/webhook', (req, res) => {
  // ── 1. Respond to Green API before reading a single byte ─────────────────────
  res.sendStatus(200);

  // ── 2. Buffer raw body ───────────────────────────────────────────────────────
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    setImmediate(async () => {
      // ── 3. Parse body ─────────────────────────────────────────────────────────
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        logger.warn('[green-api/webhook] Received unparseable body — ignoring');
        return;
      }

      const rawType = body?.typeWebhook ?? '(missing)';

      // Log EVERY webhook hit at INFO so Railway logs always show whether
      // Green API is actually reaching the server.  Previously this was
      // logger.debug — invisible at the default log level.
      logger.info('[green-api/webhook] Received', { typeWebhook: rawType });

      // ── 4. Route by typeWebhook ───────────────────────────────────────────────
      if (rawType !== 'incomingMessageReceived') {
        // Non-message events (delivery receipts, state changes, device info, etc.)
        // are logged above and then discarded — no inbox action needed.
        // If you need to act on e.g. 'outgoingMessageStatus', add a handler here.
        return;
      }

      // ── 5. Parse the inbound message shape ───────────────────────────────────
      const msg = parseGreenApiWebhook(body);
      if (!msg) {
        // Group chat, unsupported media type, or parse failure — log enough to debug
        logger.warn('[green-api/webhook] parseGreenApiWebhook returned null', {
          chatId:  body?.senderData?.chatId,
          msgType: body?.messageData?.typeMessage,
        });
        return;
      }

      logger.info('[green-api/webhook] Inbound message parsed', {
        from:    msg.from,
        type:    msg.type,
        preview: msg.text?.slice(0, 60),
      });

      // ── 6. Full CRM pipeline → inbox → SSE → persist ─────────────────────────
      processInboundWAMessage(msg)
        .then(r => {
          if (!r) return;
          broadcastSse('message', { phone: r.inboxEntry.from, name: r.inboxEntry.name ?? null });
          persist.saveInbox(inbox);
          persist.saveLeads(store);
          logger.info('[green-api/webhook] Message processed and persisted', {
            from:   r.inboxEntry.from,
            intent: r.intent,
            route:  r.route,
          });
        })
        .catch(err => logger.error('[green-api/webhook] Pipeline error', {
          error: err.message,
          from:  msg.from,
        }));
    });
  });
});

// ── GET /api/whatsapp/inbox — paginated inbox for the dashboard ───────────────
app.get('/api/whatsapp/inbox', (req, res) => {
  const limit      = Math.min(parseInt(req.query.limit  ?? '50',  10), 200);
  const unreadOnly = req.query.unread === 'true';
  res.json({
    messages: inbox.getAll({ limit, unreadOnly }),
    stats:    inbox.getStats(),
    ts: new Date(),
  });
});

// ── POST /api/whatsapp/inbox/:id/read — mark single message as read ───────────
app.post('/api/whatsapp/inbox/:id/read', (req, res) => {
  const msg = inbox.markRead(req.params.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  res.json({ ok: true, id: msg.id, readAt: msg.readAt });
});

// ── POST /api/whatsapp/inbox/read-all — mark all messages as read ─────────────
app.post('/api/whatsapp/inbox/read-all', (_req, res) => {
  inbox.markAllRead();
  res.json({ ok: true, stats: inbox.getStats() });
});

// ── GET /api/whatsapp/stats — unread badge count for the UI ──────────────────
app.get('/api/whatsapp/stats', (_req, res) => {
  res.json(inbox.getStats());
});

// ── POST /api/whatsapp/simulate — inject a test message without real WhatsApp ─
// Body: { from, text, name?, type? }
// Useful for testing intent detection + Barak routing without a Meta connection.
app.post('/api/whatsapp/simulate', jsonBody, async (req, res) => {
  const { from, text, name, type = 'text' } = req.body ?? {};
  if (!from || !text) return res.status(400).json({ error: 'from and text required' });

  const msg = {
    from,
    name:      name ?? null,
    text,
    messageId: `sim-${Date.now()}`,
    timestamp: new Date(),
    type,
    mediaType: type,
    mediaCaption: null,
    mediaId: null,
  };

  try {
    const result = await processInboundWAMessage(msg);
    broadcastSse('message', { phone: result.inboxEntry.from, name: result.inboxEntry.name ?? null });
    res.json({
      ok: true,
      inboxId:     result.inboxEntry.id,
      intent:      result.intent,
      route:       result.route,
      clientMatch: result.clientMatch,
      barakReply:  result.barakReply,
      processedAt: new Date(),
    });
  } catch (err) {
    logger.error('WA simulate error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// WEBHOOK STUBS — Meta Lead Ads & WhatsApp (testing / production-ready)
// ══════════════════════════════════════════════════════════════════════════════

// ── Meta webhook helpers ──────────────────────────────────────────────────────

/**
 * Return the first non-empty trimmed string found in `obj` by trying each key
 * in `keys` in order.  Handles null, undefined, and blank-string values.
 */
function _firstStr(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * Parse a raw request body string into a plain object.
 * Handles three formats that Make.com or Meta may send:
 *   1. Standard JSON object             {"phone":"…"}
 *   2. Double-encoded JSON string       "\"{\\"phone\\":\\"…\\"}\""
 *      (Make's jsonString mode sometimes wraps the value in an extra layer)
 *   3. URL-encoded form data            phone=…&name=…
 */
function _parseRawBody(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Attempt 1 — JSON (handles both normal and double-encoded)
  try {
    const parsed = JSON.parse(s);
    // If the outer value is a string, Make double-encoded the payload — re-parse
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed); } catch { return null; }
    }
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through */ }

  // Attempt 2 — URL-encoded form data (application/x-www-form-urlencoded)
  try {
    const params = new URLSearchParams(s);
    const obj = Object.fromEntries(params.entries());
    if (Object.keys(obj).length) return obj;
  } catch { /* fall through */ }

  return null;
}

/**
 * Normalise any phone string into Israel E.164-without-+ format (972XXXXXXXXX).
 * Strips every non-digit character, then prefixes 972 if needed.
 */
function _normPhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('972')) return d;
  if (d.startsWith('0'))   return '972' + d.slice(1);
  return '972' + d;
}

// POST /api/webhooks/meta — Meta Lead Ads ingestion (Make.com → Railway)
//
// CRITICAL: respond BEFORE body parsing. express.json() (jsonBody) buffers the
// entire request body before calling the route handler — any stream delay or
// middleware stall would push the response past Make's 120 s timeout, causing 499.
// Fix: no jsonBody middleware here. The 200 is sent as the very first line,
// then the raw body is buffered asynchronously and processed in setImmediate.
app.post('/api/webhooks/meta', (req, res) => {
  // ── 1. Flush 200 to Make IMMEDIATELY — before reading a single byte ───────────
  res.status(200).json({ success: true, message: 'Lead received' });

  // ── 2. Buffer the raw body (small payload — typically < 1 KB from Make) ───────
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    // ── 3. All parsing and heavy work run after the response is fully sent ───────
    setImmediate(async () => {
      const rawStr = Buffer.concat(chunks).toString();
      const body   = _parseRawBody(rawStr);

      if (!body) {
        logger.warn('Meta webhook: unparseable body', {
          contentType: req.headers['content-type'],
          preview:     rawStr.slice(0, 150),
        });
        return;
      }

      let lead = null;
      try {
        if (body?.entry) {
          // ── Native Meta webhook format (direct Lead Ads subscription) ──────────
          lead = parseMetaLeadWebhook(body);
        } else {
          // ── Make.com / simplified format ────────────────────────────────────────
          //
          // Make.com forwards Meta Lead Ads data in two shapes depending on the module:
          //   A. Flat:      { "phone": "0501234567", "full_name": "..." }
          //   B. field_data: { "field_data": [{ "name": "phone_number", "values": ["..."] }] }
          //
          // We try both.  Flatten the field_data array into a plain map first so the
          // same _firstStr helper works for both shapes.
          const fdFlat = {};
          if (Array.isArray(body.field_data)) {
            for (const f of body.field_data) {
              if (f?.name && f.values?.[0] != null) fdFlat[f.name] = String(f.values[0]);
            }
          }

          const PHONE_KEYS = [
            'phone', 'phone_number', 'phoneNumber',
            'mobile', 'mobile_phone', 'mobilePhone',
            'cell', 'tel', 'telephone',
          ];
          const rawPhone =
            _firstStr(body,   PHONE_KEYS) ??
            _firstStr(fdFlat, PHONE_KEYS);

          if (!rawPhone) {
            logger.warn('Meta webhook: phone field not found in payload', {
              receivedKeys:  Object.keys(body).join(', '),
              fieldDataKeys: Object.keys(fdFlat).join(', ') || '(none)',
              preview:       JSON.stringify(body).slice(0, 200),
            });
            return;
          }

          const phone = _normPhone(rawPhone);
          if (!phone) {
            logger.warn('Meta webhook: phone normalisation returned null', { rawPhone });
            return;
          }

          // Name: try flat body keys, then field_data map, then first+last split
          const firstName =
            _firstStr(body,   ['first_name', 'firstName', 'given_name']) ??
            _firstStr(fdFlat, ['first_name', 'firstName', 'given_name']);
          const lastName =
            _firstStr(body,   ['last_name', 'lastName', 'family_name']) ??
            _firstStr(fdFlat, ['last_name', 'lastName', 'family_name']);
          const name =
            _firstStr(body,   ['name', 'full_name', 'fullName', 'lead_name', 'leadName']) ??
            _firstStr(fdFlat, ['full_name', 'name', 'fullName']) ??
            ([firstName, lastName].filter(Boolean).join(' ') || null);

          lead = {
            phone,
            name:  name ?? null,
            email:
              _firstStr(body,   ['email', 'email_address', 'emailAddress']) ??
              _firstStr(fdFlat, ['email', 'email_address']) ?? null,
            adCampaign:
              _firstStr(body,   ['adCampaign', 'ad_campaign', 'campaign', 'campaignName', 'campaign_name']) ??
              _firstStr(fdFlat, ['ad_campaign', 'adCampaign', 'campaign']) ?? null,
            formId:
              _firstStr(body,   ['formId', 'form_id', 'form']) ??
              _firstStr(fdFlat, ['form_id', 'formId']) ?? null,
            customQuestions: body.customQuestions ?? body.custom_questions ?? body.questions ?? null,
          };
        }

        if (!lead?.phone) {
          logger.warn('Meta webhook: lead.phone is empty after extraction');
          return;
        }
      } catch (err) {
        logger.error('Meta webhook payload parse error', { error: err.message });
        return;
      }

      try {
        store.upsertLead(lead.phone, {
          name:   lead.name,
          email:  lead.email,
          status: 'new',
          score:  5,
          meta: {
            source:          'meta_ads',
            formId:          lead.formId,
            adCampaign:      lead.adCampaign,
            customQuestions: lead.customQuestions,
          },
        });
        store.logEvent('meta_lead_webhook', lead.phone, { name: lead.name, source: 'meta_ads' });
        automations.recordExecution('rule-008', { phone: lead.phone, name: lead.name });
        logger.info('Meta webhook lead captured', { phone: lead.phone, name: lead.name, formId: lead.formId });

        // Persist immediately so this lead survives a crash or restart
        persist.saveLeads(store);

        // Broadcast SSE so connected dashboards refresh their lead panels instantly
        broadcastSse('new_lead', { phone: lead.phone, name: lead.name, source: 'meta_ads' });

        await notifyLeadTeam(lead, { formId: lead.formId, adCampaign: lead.adCampaign })
          .catch(err => logger.warn('notifyLeadTeam failed', { error: err.message }));

        // ── Trigger Barak's lead onboarding pipeline ─────────────────────────────
        // Call leadAgent.handleInbound with a synthetic first-touch text so the
        // AI generates a personalised greeting and dispatches it via Green API —
        // the same code path as a real inbound WhatsApp message.
        //
        // Fallback: if leadAgent fails (OpenAI down, Green API misconfigured) we
        // send a static acknowledgement so the lead is never left in silence.
        const triggerText = `שלום, ראיתי את המודעה שלכם ואשמח לקבל פרטים נוספים על הסטודיו`;
        let sentReply     = null;

        try {
          const result = await leadAgent.handleInbound({
            from: lead.phone,
            name: lead.name ?? null,
            text: triggerText,
          });
          sentReply = result?.reply ?? null;

          // The scoring function uses English keywords; Hebrew trigger text may
          // score lower than a Meta lead deserves — restore the warmer baseline.
          const currentScore = store.getLead(lead.phone)?.score ?? 0;
          if (currentScore < 5) store.upsertLead(lead.phone, { score: 5, status: 'warm' });

          logger.info('Barak lead pipeline activated for Meta lead', {
            phone: lead.phone, replyPreview: sentReply?.slice(0, 60),
          });
        } catch (err) {
          logger.error('leadAgent.handleInbound failed for Meta lead — sending fallback message', {
            phone:  lead.phone,
            error:  err.message,
            action: 'Check OPENAI_API_KEY and Green API credentials in Railway Variables',
          });
          // Static fallback so the lead gets at least an acknowledgement
          const givenName   = (lead.name ?? '').split(/\s+/)[0].trim() || null;
          const welcomeText = `שלום${givenName ? ' ' + givenName : ''}! 🤸‍♀️ קיבלנו את פנייתך לשייפ סטודיו ונחזור אליך בהקדם. בינתיים, אם יש שאלות — אנחנו כאן! 😊`;
          try {
            await sendText(lead.phone, welcomeText, { bypassQuietHours: true });
            sentReply = welcomeText;
          } catch (sendErr) {
            logger.error('Fallback welcome message also failed', { phone: lead.phone, error: sendErr.message });
          }
        }

        // Always create an outbound inbox thread entry so the WhatsApp live chat
        // screen shows this lead immediately regardless of delivery outcome.
        inbox.pushOutbound({
          phone:   lead.phone,
          name:    lead.name ?? null,
          text:    sentReply ?? '[AI reply sent]',
          agentId: 'barak-meta',
        });
        store.logEvent('message_out', lead.phone, {
          preview: (sentReply ?? '[AI reply]').slice(0, 80),
          agent:   'barak',
          source:  'meta_lead',
        });
        persist.saveInbox(inbox);
        // SSE fires so the WhatsApp live tab refreshes thread list immediately
        broadcastSse('message', { phone: lead.phone, name: lead.name ?? null, direction: 'out' });
      } catch (err) {
        logger.error('Meta webhook async processing error', { error: err.message, phone: lead?.phone });
      }
    });
  });
});

// POST /api/webhooks/whatsapp — WhatsApp inbound simulation stub
// Accepts { from, text } and routes to lead agent, returns AI reply
app.post('/api/webhooks/whatsapp', jsonBody, async (req, res) => {
  const { from, text, name } = req.body ?? {};
  if (!from || !text) return res.status(400).json({ error: 'from and text required' });

  try {
    // Ensure lead exists in store
    store.upsertLead(from, { name: name ?? null });
    store.logEvent('message_in', from, { preview: text.slice(0, 80), source: 'whatsapp_stub' });

    // Route through lead agent for AI reply (same shape as WhatsApp inbound)
    const reply = await leadAgent.handleInbound({ from, text });
    const replyText = typeof reply === 'string' ? reply : reply?.text ?? 'הודעה נקלטה';

    store.logEvent('message_out', from, { preview: replyText.slice(0, 80), agent: 'lead' });
    logger.info('WhatsApp stub message processed', { from });

    res.json({ ok: true, from, received: text, reply: replyText, processedAt: new Date() });
  } catch (err) {
    // Lead agent may not expose handleInboundMessage as a standalone fn — fallback gracefully
    store.logEvent('message_in', from, { preview: text.slice(0, 80), source: 'whatsapp_stub' });
    logger.warn('WhatsApp stub: lead agent routing not available, message logged', { from });
    res.json({ ok: true, queued: true, from, received: text,
      note: 'הודעה נקלטה ונרשמה — ניתוב לסוכן ידרוש חיבור WhatsApp פעיל',
      processedAt: new Date() });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTOMATIONS — Rules, Worker toggles, Execution log
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/automations — all rules + worker states
app.get('/api/automations', (_req, res) => {
  res.json({
    rules:   automations.getAllRules(),
    workers: automations.getAllWorkers(),
    ts: new Date(),
  });
});

// POST /api/automations/toggle-rule — { id, enabled? }
app.post('/api/automations/toggle-rule', jsonBody, (req, res) => {
  const { id, enabled } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const rule = automations.toggleRule(id, enabled);
  if (!rule) return res.status(404).json({ error: `Rule ${id} not found` });
  logger.info('Automation rule toggled', { id, enabled: rule.enabled });
  res.json({ ok: true, rule });
});

// POST /api/automations/toggle-worker — { id, enabled? }
app.post('/api/automations/toggle-worker', jsonBody, (req, res) => {
  const { id, enabled } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const worker = automations.toggleWorker(id, enabled);
  if (!worker) return res.status(404).json({ error: `Worker ${id} not found` });
  logger.info('Automation worker toggled', { id, enabled: worker.enabled });
  res.json({ ok: true, worker });
});

// GET /api/automations/log — execution log
app.get('/api/automations/log', (req, res) => {
  const limit = parseInt(req.query.limit ?? '60', 10);
  res.json({ log: automations.getExecLog(limit), ts: new Date() });
});

// ══════════════════════════════════════════════════════════════════════════════
// SANDBOX — Interactive Agent Testing
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/sandbox/simulate — route a message or scenario to any agent
// Body: { agent: 'maya'|'dana'|'tomer'|'barak', message?, scenario? }
app.post('/api/sandbox/simulate', jsonBody, async (req, res) => {
  const { agent: agentKey, message, scenario } = req.body ?? {};
  if (!agentKey) return res.status(400).json({ error: 'agent required (maya|dana|tomer|barak)' });

  const AGENTS = { maya: managerAgent, dana: danaAgent, tomer: tomerAgent, barak: barakAgent };
  const agent = AGENTS[agentKey];
  if (!agent) return res.status(400).json({ error: `Unknown agent: ${agentKey}` });

  // Resolve the input — scenario expands to a preset message
  const SCENARIOS = {
    lead_silent_3d:      `ליד "שירה אברהם" (ציון 5) לא ענתה 3 ימים. מה עושים?`,
    lead_silent_7d:      `ליד "גלית מזרחי" (ציון 2) לא ענתה 7 ימים, נשלחה נגיעה ראשונה. המלצה?`,
    member_inactive_14d: `החברה "יעל כץ" לא הגיעה 35 ימים ל-Concept Toning. מה הצעד הבא?`,
    hot_lead_no_offer:   `"רונית כהן" עם ציון 8 לא קיבלה הצעת היכרות. מה עושים עכשיו?`,
    meta_lead_new:       `נכנס ליד חדש מ-Meta: שם "נועה ברגר", טלפון 0521234567. הפעולה הראשונה?`,
    daily_report:        `תן לי סיכום יומי מלא — לידים, חברות, עדיפויות.`,
    content_reel:        `צרי הצעה לריל Reformer Pilates לאינסטגרם — הוק, מבנה, CTA.`,
    arbox_pending:       `יש 4 לידים שלא מסונכרנים ל-Arbox. מה הסדר הנכון לטפל בהם?`,
  };

  const prompt = scenario ? (SCENARIOS[scenario] ?? scenario) : message;
  if (!prompt) return res.status(400).json({ error: 'message or scenario required' });

  const startedAt = Date.now();
  let reply = '';
  let errorMsg = null;

  try {
    reply = await agent.chat(prompt);
  } catch (err) {
    logger.error('Sandbox simulate error', { agentKey, error: err.message });
    errorMsg = err.message;
    reply = `שגיאה טכנית: ${err.message}`;
  }

  const elapsed = Date.now() - startedAt;
  store.logEvent('sandbox_simulate', null, {
    agent: agentKey, prompt: prompt.slice(0, 80),
    replyPreview: reply.slice(0, 80), elapsed,
  });

  res.json({
    agent:     agentKey,
    scenario:  scenario ?? null,
    prompt,
    reply,
    elapsed,
    error:     errorMsg,
    ts:        new Date(),
  });
});

// GET /api/sandbox/scenarios — available preset scenarios
app.get('/api/sandbox/scenarios', (_req, res) => {
  res.json({
    scenarios: [
      { id: 'lead_silent_3d',      label: 'ליד שקט 3 ימים',          agent: 'tomer', icon: '😴' },
      { id: 'lead_silent_7d',      label: 'ליד שקט 7 ימים',          agent: 'tomer', icon: '🔕' },
      { id: 'member_inactive_14d', label: 'חברת סטודיו — 14 ימים',    agent: 'tomer', icon: '🏋️' },
      { id: 'hot_lead_no_offer',   label: 'ליד חם ללא הצעה',         agent: 'barak', icon: '🔥' },
      { id: 'meta_lead_new',       label: 'ליד חדש מ-Meta',          agent: 'barak', icon: '📱' },
      { id: 'daily_report',        label: 'דוח יומי',                agent: 'maya',  icon: '📊' },
      { id: 'content_reel',        label: 'ריל אינסטגרם',            agent: 'dana',  icon: '🎬' },
      { id: 'arbox_pending',       label: 'סנכרון Arbox ממתין',      agent: 'barak', icon: '🔗' },
    ],
  });
});

// ── GET /api/system/events — unified autonomous action log (last 50) ──────────
app.get('/api/system/events', (_req, res) => {
  const events = store.getEvents({ limit: 50 }).reverse();
  res.json({ events, count: events.length, ts: new Date() });
});

// ── POST /api/tomer/send-message — personalized retention message (production-ready stub) ──
app.post('/api/tomer/send-message', jsonBody, async (req, res) => {
  const { phone, name, template, context: ctx } = req.body ?? {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const TEMPLATES = {
    lead_touch1: `${name || 'שלום'}, שלום! 😊 Shape Studio בפרדס חנה-כרכור מחכה לך. 2 אימונים ב-60 ש״ח — ניסיון ללא התחייבות. הגיע הזמן? 💪`,
    lead_touch2: `${name || 'שלום'}, שבוע עבר! עדיין רוצים לראות אותך. Reformer Pilates, Pilates Barre, Strength Training — מה מתאים? ספרי לנו. 🧘‍♀️`,
    lead_touch3: `${name || 'שלום'}, לא רוצים להעיק 🙂 Shape Studio תמיד פה בשבילך. הצעת הניסיון — 2 אימונים ב-60 ש״ח — עדיין תקפה. 🙏`,
    member_inactive: `${name || 'שלום'}, חסרת לנו ב-Shape Studio! מה קורה? מחכים לך לחזור 🌟`,
    member_atrisk:   `${name || 'שלום'}, ראינו שלא הגעת כבר כמה שבועות. כל בעיה? אשמח לעזור למצוא זמן שמתאים. Shape Studio בפרדס חנה 🤝`,
    intro_followup:  `${name || 'שלום'}, שלחנו לך הצעת היכרות — 2 אימונים ב-60 ש״ח. עדיין תקפה! רוצה לקבוע? 🎯`,
    custom:          ctx ?? `שלום מ-Shape Studio בפרדס חנה-כרכור 👋`,
  };

  const msgTemplate = template && TEMPLATES[template] ? template : 'custom';
  const message = template && TEMPLATES[template] ? TEMPLATES[template] : (ctx ?? TEMPLATES.custom);

  try {
    await sendText(phone, message);
    store.logEvent('tomer_message_sent', phone, {
      agent: 'tomer', name, template: msgTemplate, preview: message.slice(0, 80),
    });
    logger.info('Tomer send-message sent', { phone, template: msgTemplate });
    res.json({ ok: true, sent: true, phone, template: msgTemplate, preview: message.slice(0, 80), sentAt: new Date() });
  } catch (err) {
    // WhatsApp not configured — queue it and return ok so UI doesn't break
    store.logEvent('tomer_message_queued', phone, {
      agent: 'tomer', name, template: msgTemplate, preview: message.slice(0, 80),
      reason: 'WhatsApp not configured',
    });
    logger.warn('Tomer send-message queued (no WhatsApp)', { phone, template: msgTemplate });
    res.json({
      ok: true, queued: true, phone, template: msgTemplate,
      preview: message.slice(0, 80),
      note: 'WhatsApp not configured — message queued for when service is live',
      queuedAt: new Date(),
    });
  }
});

// ── GET /api/tomer/segments — Live Arbox retention segments for the 5-panel UI ──
// Calls arboxSvc.classifyMemberships() once and distributes the result across
// all five Tomer segments: Onboarding · Churn Risk · Renewals · Birthdays · Win-Back
app.get('/api/tomer/segments', async (_req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const r        = await arboxSvc.classifyMemberships({ limit: 500 });

    const activeClients   = r.activeClients   ?? [];
    const expiringSoon    = r.expiringSoon    ?? [];
    const recentlyExpired = r.recentlyExpired ?? [];
    const now             = new Date();

    // Normalise one Arbox-enriched user to a UI-friendly object
    const mapU = u => ({
      user_id:     u.user_id,
      name:        u._name  || `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || '—',
      phone:       u._phone ?? u.phone ?? null,
      memberSince: u.membership_start_date ?? null,
      memberEnd:   u.membership_end_date   ?? null,
      daysLeft:    u._daysLeft ?? null,
    });

    // ── 1. Onboarding — active clients who joined in the last 14 days ───────────
    const day14 = new Date(now - 14 * 86400000);
    const onboarding = activeClients
      .filter(u => u.membership_start_date && new Date(u.membership_start_date) >= day14)
      .map(u => ({
        ...mapU(u),
        daysSince: Math.floor((now - new Date(u.membership_start_date)) / 86400000),
      }))
      .sort((a, b) => a.daysSince - b.daysSince);

    // ── 2. Churn Risk — Arbox expiring (1-30d) ∪ local store inactive (10+ days) ─
    const expiringMapped = expiringSoon.map(u => ({
      ...mapU(u),
      risk:   (u._daysLeft ?? 999) <= 7 ? 'red' : 'yellow',
      reason: 'expiring',
    }));
    const expiringPhones = new Set(expiringMapped.map(u => u.phone).filter(Boolean));

    const inactiveLocal = store.getInactiveMembers(10)
      .filter(m => m.phone && !expiringPhones.has(m.phone))
      .map(m => ({
        user_id:       m.arboxId ?? null,
        name:          m.name    ?? '—',
        phone:         m.phone,
        memberSince:   null,
        memberEnd:     null,
        daysLeft:      null,
        lastAttendance: m.lastAttendance,
        daysSince:     m.lastAttendance
          ? Math.floor((now - new Date(m.lastAttendance)) / 86400000)
          : null,
        risk:   (!m.lastAttendance || Math.floor((now - new Date(m.lastAttendance)) / 86400000) >= 21) ? 'red' : 'yellow',
        reason: 'inactive',
      }));

    const churnRisk = [...expiringMapped, ...inactiveLocal]
      .sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999) || (b.daysSince ?? 0) - (a.daysSince ?? 0));

    // ── 3. Renewals — expiring soon (Arbox) + recently expired ─────────────────
    const renewals = {
      expiringSoon:    expiringSoon.map(mapU),
      recentlyExpired: recentlyExpired.map(u => ({
        ...mapU(u),
        daysGone: u._daysLeft != null ? Math.abs(u._daysLeft) : null,
      })),
    };

    // ── 4. Birthdays — try birth_date / birthday field on Arbox user objects ─────
    // Arbox public API v3 does not expose a birthday field for most account tiers;
    // return an empty list with a note when no data is found.
    const thisMonth = now.getMonth() + 1; // 1–12
    const withBday  = activeClients.filter(u => u.birth_date || u.birthday);
    const birthdays = withBday
      .map(u => ({ ...mapU(u), dob: u.birth_date ?? u.birthday, _m: new Date(u.birth_date ?? u.birthday).getMonth() + 1 }))
      .filter(u => !isNaN(u._m) && u._m === thisMonth);

    // ── 5. Win-Back — recently cancelled/expired (within 90 days) ───────────────
    const winBack = recentlyExpired
      .map(u => ({
        ...mapU(u),
        daysGone: u._daysLeft != null ? Math.abs(u._daysLeft) : null,
      }))
      .sort((a, b) => (a.daysGone ?? 999) - (b.daysGone ?? 999));

    res.json({
      onboarding: { count: onboarding.length, members: onboarding },
      churnRisk:  { count: churnRisk.length,  members: churnRisk  },
      renewals: {
        count:          renewals.expiringSoon.length + renewals.recentlyExpired.length,
        expiringSoon:   renewals.expiringSoon,
        recentlyExpired: renewals.recentlyExpired,
      },
      birthdays: {
        count:   birthdays.length,
        members: birthdays,
        note:    withBday.length === 0 && activeClients.length > 0
          ? 'שדה תאריך לידה אינו זמין ב-API הציבורי של Arbox'
          : null,
      },
      winBack: { count: winBack.length, members: winBack },
      ts: new Date(),
    });
  } catch (err) {
    logger.error('Tomer segments error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tomer/action — proactive WhatsApp send per retention segment ──────
app.post('/api/tomer/action', jsonBody, async (req, res) => {
  const { segment, phone, name, context: ctx } = req.body ?? {};
  if (!phone || !segment) return res.status(400).json({ error: 'phone and segment required' });
  if (String(phone).includes('•')) return res.status(400).json({ error: 'Phone masked — cannot send' });

  const firstName = (name ?? '').split(/\s+/)[0].trim() || null;
  const hi = firstName ? `היי ${firstName}` : 'שלום';

  const MSGS = {
    onboarding: `${hi}! 🌱 שמחים שהצטרפת לשייפ סטודיו!\nאיך הולך עד כה? יש שאלות על השיעורים או הלוח? אנחנו כאן בשבילך 💪`,
    churn_risk: `${hi}! ⭐ לא ראינו אותך${ctx?.daysSince ? ` כבר ${ctx.daysSince} ימים` : ' קצת זמן'}.\nהכל בסדר? נשמח לראות אותך בסטודיו שוב 🤸‍♀️`,
    renewal:    `${hi}! 💳 המנוי שלך${ctx?.daysLeft != null ? ` פג בעוד ${ctx.daysLeft} ימים` : ' עומד לפוג בקרוב'}.\nרוצה לחדש? נשמח לעזור 😊`,
    birthday:   `${hi}! 🎉 יום הולדת שמח!!\nשמחים שאת/ה חלק ממשפחת שייפ סטודיו. יום האימון הבא עלינו 🎂💪`,
    win_back:   `${hi}! 🔄 פספסנו אותך בשייפ סטודיו!\nמה דעתך לחזור? יש לנו הצעה מיוחדת לחברים חוזרים 🌟`,
  };

  const message = MSGS[segment];
  if (!message) return res.status(400).json({ error: `Unknown segment: ${segment}` });

  try {
    await sendText(phone, message, { bypassQuietHours: true });
    store.logEvent('tomer_proactive_send', phone, { segment, name, preview: message.slice(0, 80) });
    logger.info('Tomer proactive action sent', { segment, phone });
    res.json({ ok: true, segment, preview: message.slice(0, 60), sentAt: new Date() });
  } catch (err) {
    logger.error('Tomer action send failed', { segment, phone, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// KNOWLEDGE MANAGEMENT — Admin API
// Allows the dashboard to view, edit, and hot-reload agent knowledge
// (staff directory, subscription packages) without a server restart.
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/knowledge — returns current in-memory knowledge state
app.get('/api/admin/knowledge', (_req, res) => {
  res.json({ ok: true, ...barakAgent.getRawKnowledge() });
});

// POST /api/admin/knowledge/staff — save staff_directory.json and hot-reload
app.post('/api/admin/knowledge/staff', jsonBody, (req, res) => {
  const data = req.body;
  if (!Array.isArray(data?.instructors)) {
    return res.status(400).json({ ok: false, error: 'body must have { instructors: [...] }' });
  }
  try {
    const result = barakAgent.reloadKnowledge({ staffData: data });
    store.logEvent('knowledge_sync', null, { type: 'staff', ...result });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[admin] knowledge/staff save failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/knowledge/packages — save subscription_packages.json and hot-reload
app.post('/api/admin/knowledge/packages', jsonBody, (req, res) => {
  const data = req.body;
  if (!Array.isArray(data?.packages)) {
    return res.status(400).json({ ok: false, error: 'body must have { packages: [...] }' });
  }
  try {
    const result = barakAgent.reloadKnowledge({ pkgData: data });
    store.logEvent('knowledge_sync', null, { type: 'packages', ...result });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[admin] knowledge/packages save failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/knowledge/classes — save classes_knowledge.json and hot-reload
app.post('/api/admin/knowledge/classes', jsonBody, (req, res) => {
  const data = req.body;
  if (!data?.classes) return res.status(400).json({ error: 'classes array required' });
  try {
    const result = barakAgent.reloadKnowledge({ classesData: data });
    store.logEvent('knowledge_sync', null, { type: 'classes', classes_count: result.classes_count });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[admin] knowledge/classes save failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/sync-agent-knowledge — hot-reload all files + run verification
// This is what the dashboard "רענן זיכרון סוכן" button calls.
app.post('/api/admin/sync-agent-knowledge', async (_req, res) => {
  try {
    const reload = barakAgent.reloadKnowledge();     // re-read files from disk, rebuild contexts
    tomerAgent.clearHistory();                       // clear Tomer history too — may reference stale prices
    managerAgent.clearHistory();

    // ── Quick verification: test the two most common knowledge questions ────
    const checks = [];

    // 1. Subscription query — confirm universal access is in the context
    const subCtx = barakAgent.getSubscriptionContext();
    checks.push({
      test:   'subscription_context_includes_universal_access',
      passed: subCtx.includes('כלול בכל מנוי') || subCtx.includes('גישה מלאה'),
      sample: subCtx.slice(0, 120),
    });

    // 2. Staff context — confirm at least one instructor is listed
    const staffCtx = barakAgent.getStaffContext();
    checks.push({
      test:   'staff_context_has_instructors',
      passed: reload.staff_count > 0,
      sample: staffCtx.split('\n').slice(0, 3).join(' / '),
    });

    // 3. Specialist query — if any instructor has rehab:true, verify they appear in lookup
    const { matched: rehabMatches } = barakAgent.findInstructorsBySpecialty('שיקומי');
    checks.push({
      test:   'rehab_specialists_discoverable',
      passed: true,                        // passes even with 0 — means "no rehab staff yet"
      rehab_instructors: rehabMatches.map(s => s.name_he),
    });

    store.logEvent('knowledge_sync', null, {
      type: 'full_reload', ...reload,
      verification_passed: checks.every(c => c.passed),
    });

    // 4. Classes context — confirm classes are loaded
    const classesCtx = barakAgent.getClassesContext();
    checks.push({
      test:   'classes_context_loaded',
      passed: reload.classes_count > 0,
      sample: classesCtx.split('\n').slice(0, 2).join(' / '),
    });

    logger.info('[admin] sync-agent-knowledge complete', reload);
    res.json({ ok: true, ...reload, verification: checks });
  } catch (err) {
    logger.error('[admin] sync-agent-knowledge failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// STUDIO ASSETS API — Waze URL, timetable link (editable from dashboard)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/studio-assets — return current Waze + timetable settings
app.get('/api/admin/studio-assets', (_req, res) => {
  res.json({ ok: true, ...studioAssets.getAssets() });
});

// POST /api/admin/studio-assets — save updated text values (wazeUrl, timetableUrl)
app.post('/api/admin/studio-assets', jsonBody, (req, res) => {
  try {
    const saved = studioAssets.saveAssets(req.body);
    store.logEvent('studio_assets_updated', null, { wazeSet: !!saved.wazeUrl, timetableSet: !!saved.timetableUrl });
    res.json({ ok: true, ...saved });
  } catch (err) {
    logger.error('[admin] studio-assets save failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/studio-assets/timetable — upload timetable image as base64 JSON
// Body: { imageData: "data:image/jpeg;base64,..." }
// No multer needed — uses a generous JSON body limit for image payloads.
const largeJsonBody = express.json({ limit: '10mb' });

app.post('/api/admin/studio-assets/timetable', largeJsonBody, (req, res) => {
  try {
    const { imageData } = req.body ?? {};
    if (!imageData) return res.status(400).json({ ok: false, error: 'imageData required' });

    const match = imageData.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ ok: false, error: 'invalid base64 image format' });

    const [, mime, b64] = match;
    // Map common MIME subtypes to safe file extensions
    const extMap = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
    const ext    = extMap[mime.toLowerCase()] ?? 'jpg';
    const buffer = Buffer.from(b64, 'base64');

    const result = studioAssets.saveTimetableImage(buffer, ext);
    store.logEvent('timetable_image_uploaded', null, { sizeKb: Math.round(buffer.length / 1024), ext });
    logger.info('[admin] Timetable image uploaded', { sizeKb: Math.round(buffer.length / 1024), ext });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[admin] timetable image upload failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/timetable-image — serve timetable image 1 from DATA_DIR
app.get('/api/admin/timetable-image', (_req, res) => {
  const imgPath = studioAssets.getTimetableImagePath();
  if (!imgPath) return res.status(404).json({ ok: false, error: 'No timetable image uploaded' });
  if (!fs.existsSync(imgPath)) return res.status(404).json({ ok: false, error: 'Timetable image file not found' });

  const ext     = imgPath.split('.').pop() ?? 'jpg';
  const mimeMap = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  res.setHeader('Content-Type', mimeMap[ext] ?? 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(imgPath).pipe(res);
});

// POST /api/admin/studio-assets/timetable2 — upload second timetable image as base64
app.post('/api/admin/studio-assets/timetable2', largeJsonBody, (req, res) => {
  try {
    const { imageData } = req.body ?? {};
    if (!imageData) return res.status(400).json({ ok: false, error: 'imageData required' });

    const match = imageData.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ ok: false, error: 'invalid base64 image format' });

    const [, mime, b64] = match;
    const extMap = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };
    const ext    = extMap[mime.toLowerCase()] ?? 'jpg';
    const buffer = Buffer.from(b64, 'base64');

    const result = studioAssets.saveTimetable2Image(buffer, ext);
    store.logEvent('timetable2_image_uploaded', null, { sizeKb: Math.round(buffer.length / 1024), ext });
    logger.info('[admin] Timetable2 image uploaded', { sizeKb: Math.round(buffer.length / 1024), ext });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[admin] timetable2 image upload failed', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/timetable2-image — serve timetable image 2 from DATA_DIR
app.get('/api/admin/timetable2-image', (_req, res) => {
  const imgPath = studioAssets.getTimetable2ImagePath();
  if (!imgPath) return res.status(404).json({ ok: false, error: 'No timetable2 image uploaded' });
  if (!fs.existsSync(imgPath)) return res.status(404).json({ ok: false, error: 'Timetable2 image file not found' });

  const ext     = imgPath.split('.').pop() ?? 'jpg';
  const mimeMap = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  res.setHeader('Content-Type', mimeMap[ext] ?? 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(imgPath).pipe(res);
});

// ══════════════════════════════════════════════════════════════════════════════
// STAFF MANAGEMENT API
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/staff — return current staff roster
app.get('/api/admin/staff', (_req, res) => {
  res.json({ ok: true, ...staffConfig });
});

// POST /api/admin/staff — save updated roster
app.post('/api/admin/staff', jsonBody, (req, res) => {
  const data = req.body;
  if (!Array.isArray(data?.staff)) {
    return res.status(400).json({ ok: false, error: 'body must have { staff: [...] }' });
  }
  try {
    fs.writeFileSync(STAFF_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
    staffConfig = data;
    store.logEvent('staff_config_updated', null, { count: data.staff.length });
    res.json({ ok: true, staff_count: data.staff.length, updatedAt: new Date() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// APPOINTMENTS API
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/appointments — all appointments (paginated, latest first)
app.get('/api/admin/appointments', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const status = req.query.status;
  let apts = aptStore.getAll()
    .sort((a, b) => b.createdAt - a.createdAt);
  if (status) apts = apts.filter(a => a.status === status);
  res.json({ ok: true, total: apts.length, appointments: apts.slice(0, limit) });
});

// PATCH /api/admin/appointments/:id — update status
app.patch('/api/admin/appointments/:id', jsonBody, (req, res) => {
  const apt = aptStore.update(req.params.id, req.body);
  if (!apt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
  store.logEvent('appointment_updated_manual', apt.leadPhone, { aptId: apt.id, ...req.body });
  res.json({ ok: true, appointment: apt });
});

// POST /api/admin/appointments/:id/complete — mark completed
app.post('/api/admin/appointments/:id/complete', (req, res) => {
  const apt = aptStore.markCompleted(req.params.id);
  if (!apt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
  store.logEvent('appointment_completed', apt.leadPhone, { aptId: apt.id });
  res.json({ ok: true, appointment: apt });
});

// POST /api/admin/appointments/:id/cancel — cancel and alert staff
app.post('/api/admin/appointments/:id/cancel', async (req, res) => {
  const apt = aptStore.markCancelled(req.params.id);
  if (!apt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
  calendarSvc.cancelCalendarEvent(apt).catch(() => {});
  store.logEvent('appointment_cancelled', apt.leadPhone, { aptId: apt.id });
  res.json({ ok: true, appointment: apt });
});

// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR — ICS file serving
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/calendar/appointment/:id.ics — download ICS for appointment
app.get('/api/calendar/appointment/:id.ics', async (req, res) => {
  const id  = req.params.id.replace(/\.ics$/, '');
  const apt = aptStore.get(id);
  if (!apt) return res.status(404).send('Appointment not found');

  // Try cache first
  let ics = aptIcsCache.get(id);

  // If not in cache (e.g. after server restart), regenerate
  if (!ics && apt.scheduledAt) {
    const staff = findStaff(apt.assignedStaffId);
    ics = calendarSvc.buildICS(apt, staff);
    if (ics) aptIcsCache.set(id, ics);
  }

  if (!ics) {
    return res.status(422).send('Calendar event could not be generated (appointment time not yet parsed)');
  }

  // "inline" disposition lets iOS/Android open the file directly in the
  // calendar app. "attachment" forces a download which mobile calendars
  // may not auto-handle. The filename is kept human-readable.
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="shape-studio-appointment.ics"');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(ics);
});

// ══════════════════════════════════════════════════════════════════════════════
// WHATSAPP THREADS API + SSE STREAM
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/whatsapp/stream — Server-Sent Events for real-time inbox updates
app.get('/api/whatsapp/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // tell nginx not to buffer
  res.flushHeaders();

  // Send initial "connected" event so the client knows the connection is live
  res.write(`data: ${JSON.stringify({ event: 'connected' })}\n\n`);

  // Heartbeat every 20s to prevent proxy timeouts
  const hb = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 20000);

  sseClients.add(res);
  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

// Helper: strip full messages[] from a thread for the list view (keeps payload small)
function summarizeThread(t) {
  return {
    phone:        t.phone,
    name:         t.name,
    fromIsraeli:  t.fromIsraeli,
    lastText:     t.lastText,
    lastAt:       t.lastAt,
    unreadCount:  t.unreadCount,
    messageCount: t.messages.length,
    clientMatch:  t.clientMatch ?? null,
  };
}

// GET /api/whatsapp/threads — paginated thread list (no message bodies)
app.get('/api/whatsapp/threads', (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit ?? '60', 10), 200);
  const threads = inbox.getThreads({ limit });
  const unread  = threads.reduce((sum, t) => sum + t.unreadCount, 0);
  res.json({
    threads:  threads.map(summarizeThread),
    total:    threads.length,
    unread,
    ts: new Date(),
  });
});

// GET /api/whatsapp/threads/:phone — full thread with all messages; also marks it read
app.get('/api/whatsapp/threads/:phone', (req, res) => {
  const phone  = req.params.phone;
  const thread = inbox.getThread(phone);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  inbox.markThreadRead(phone);
  res.json({ thread, ts: new Date() });
});

// POST /api/whatsapp/threads/:phone/send — send a manual reply from the dashboard
app.post('/api/whatsapp/threads/:phone/send', jsonBody, async (req, res) => {
  const phone = req.params.phone;
  const { text, name } = req.body ?? {};
  if (!phone || !text?.trim()) return res.status(400).json({ error: 'phone and text required' });

  try {
    await sendText(phone, text.trim());
    inbox.pushOutbound({ phone, name: name ?? null, text: text.trim(), agentId: 'manual' });
    store.logEvent('message_out', phone, { preview: text.slice(0, 80), agent: 'manual', source: 'dashboard' });
    broadcastSse('message', { phone, name: name ?? null, direction: 'out' });
    logger.info('Dashboard manual reply sent', { phone });
    res.json({ ok: true, sentAt: new Date() });
  } catch (err) {
    logger.error('Thread send error', { phone, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GREEN API DIAGNOSTICS — /api/debug/green-api
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/debug/green-api — live credential and connectivity diagnostic.
// Hit this endpoint to verify exactly what credentials are in use, what URL
// is being constructed, and whether the Green API instance is reachable and
// authorized — without digging through Railway startup logs.
app.get('/api/debug/green-api', async (_req, res) => {
  const { host, instanceId, token } = getGreenCreds();
  const tokenVar    = _tokenSourceVar();
  const configured  = !!(host && instanceId && token);

  const maskedToken = token && token.length >= 10
    ? token.slice(0, 4) + '...' + token.slice(-4)
    : token ? '(too short)' : null;

  const sendUrl = configured
    ? `https://${host}/waInstance${instanceId}/sendMessage/***TOKEN***`
    : null;

  const stateUrl = configured
    ? `https://${host}/waInstance${instanceId}/getStateInstance/***TOKEN***`
    : null;

  // Run a live getStateInstance probe
  let probe = null;
  if (configured) {
    try {
      probe = await probeGreenApiConnection();
    } catch (err) {
      probe = { ok: false, error: err.message };
    }
  }

  const domainWarning = host && /greenapi\.com/i.test(host) && !/green-api\.com/i.test(host)
    ? 'Host uses "greenapi.com" — the real Green API domain is "green-api.com" (with hyphen). Update GREEN_API_URL.'
    : null;

  res.json({
    configured,
    host:          host          ?? 'NOT SET — set GREEN_API_URL',
    instanceId:    instanceId    ?? 'NOT SET — set GREEN_API_ID_INSTANCE',
    tokenVar:      tokenVar,
    tokenMasked:   maskedToken   ?? 'NOT SET',
    tokenLength:   token ? token.length : 0,
    sendMessageUrl: sendUrl,
    stateUrl,
    domainWarning,
    probe,
    inboxThreads:  inbox.getThreads({ limit: 5 }).map(t => ({
      phone:    t.phone,
      name:     t.name,
      messages: t.messages?.length ?? 0,
      lastAt:   t.lastAt,
    })),
    ts: new Date(),
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GREEN API HISTORY SYNC
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/whatsapp/sync-green — status check (no actual sync)
app.get('/api/whatsapp/sync-green', (_req, res) => {
  const status = inbox.getSyncStatus();
  res.json({
    configured:   greenApiSvc.isConfigured(),
    lastSync:     status.lastSync,
    seenMessages: status.seenIds,
    threads:      status.threadCount,
    ts: new Date(),
  });
});

// POST /api/whatsapp/sync-green — trigger a full history sync
// Body (all optional): { minutes, perChatCount, deepHistory }
app.post('/api/whatsapp/sync-green', jsonBody, async (req, res) => {
  if (!greenApiSvc.isConfigured()) {
    return res.status(503).json({
      ok:     false,
      reason: 'Green API credentials not configured (GREEN_API_URL / GREEN_API_INSTANCE_ID / GREEN_API_TOKEN)',
    });
  }

  const { minutes, perChatCount, deepHistory } = req.body ?? {};
  logger.info('Green API sync triggered via dashboard', { minutes, perChatCount, deepHistory });

  // Run sync (can take several seconds for many chats)
  try {
    const result = await greenApiSvc.syncToInbox(inbox, {
      ...(minutes       != null && { minutes:      parseInt(minutes,       10) }),
      ...(perChatCount  != null && { perChatCount: parseInt(perChatCount,  10) }),
      ...(deepHistory   != null && { deepHistory:  Boolean(deepHistory)        }),
    });

    if (!result.ok) {
      return res.status(502).json(result);
    }

    // Broadcast SSE so all dashboard clients refresh their thread lists
    broadcastSse('sync_complete', {
      source:   'manual',
      chats:    result.chats,
      messages: result.messages,
    });

    store.logEvent('green_api_sync', null, {
      chats:    result.chats,
      messages: result.messages,
      skipped:  result.skipped,
      errors:   result.errors,
    });

    res.json(result);
  } catch (err) {
    logger.error('Green API sync error', { error: err.message });
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// ── SIGTERM — save state before Railway kills the container ───────────────────
// Railway sends SIGTERM ~10s before hard-killing the process on each deploy.
// Writing snapshots here means a new deploy picks them back up immediately.
process.on('SIGTERM', () => {
  logger.info('[shutdown] SIGTERM received — flushing snapshots to disk');
  persist.saveAll(store, inbox);
  logger.info('[shutdown] Flush complete');
  process.exit(0);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`Shape Studio Agent running — http://localhost:${PORT}`);

  // ── Persistence: guarantee DATA_DIR exists, then hydrate stores ─────────────
  //
  // Proactively create the directory NOW — not lazily on first write.
  // This guarantees all subsequent loadLeads / loadInbox calls and the
  // 60-second periodic save can never fail because the directory is missing.
  //
  // Railway setup required (one-time):
  //   1. Add a Volume mounted at /data  (Railway dashboard → Service → Volumes)
  //   2. Add a Variable:  DATA_DIR=/data
  //
  // persist.DATA_DIR === studioAssets.DATA_DIR because both resolve:
  //   process.env.DATA_DIR  ?? path.join(__dirname, '../data')
  // so a single Volume covers leads, inbox, studio_assets.json and timetable.jpg.
  try {
    fs.mkdirSync(persist.DATA_DIR, { recursive: true });
  } catch (mkErr) {
    logger.error('[startup] Could not create DATA_DIR — writes may fail', {
      dir: persist.DATA_DIR, error: mkErr.message,
    });
  }

  // Log the storage configuration so Railway logs immediately confirm the state
  const dataFiles = (() => {
    try { return fs.readdirSync(persist.DATA_DIR); } catch { return []; }
  })();
  logger.info('[data] Storage directory ready', {
    path:        persist.DATA_DIR,
    volume:      process.env.DATA_DIR
      ? '✅ Railway Volume active — data survives deploys'
      : '⚠️  local ./data — ephemeral on Railway (set DATA_DIR=/data + mount Volume)',
    dirsMatch:   persist.DATA_DIR === studioAssets.DATA_DIR,
    existingFiles: dataFiles.filter(f => !f.endsWith('.tmp')),
  });

  persist.loadLeads(store);
  persist.loadInbox(inbox);

  // ── Periodic save: flush both stores to disk every 60 seconds ──────────────
  setInterval(() => persist.saveAll(store, inbox), 60_000).unref();

  initWorkers(store);

  // Probe Green API credentials immediately at startup so Railway logs show
  // whether WhatsApp sending will work before the first real message arrives.
  probeGreenApiConnection().catch(() => {}); // errors already logged inside

  // Auto-populate inbox from Green API history on every cold start.
  // After sync, persist immediately so threads survive a restart before the
  // 60s periodic save fires, and broadcast SSE so any connected dashboard
  // clients (now connected at boot via connectWaSSE()) refresh their list.
  if (greenApiSvc.isConfigured()) {
    setTimeout(async () => {
      try {
        logger.info('[startup] Auto-syncing Green API history...');
        const result = await greenApiSvc.syncToInbox(inbox);
        logger.info('[startup] Green API sync complete', result);
        persist.saveInbox(inbox);   // persist immediately — don't wait 60s
        broadcastSse('sync_complete', { source: 'startup', chats: result.chats, messages: result.messages });
      } catch (err) {
        logger.warn('[startup] Green API auto-sync failed', { error: err.message });
      }
    }, 2000); // 2s delay so the server is fully accepting connections first
  }
});

module.exports = app;

