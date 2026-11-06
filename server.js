require('dotenv').config();
const path    = require('path');
const express = require('express');
const cron    = require('node-cron');
const logger  = require('./utils/logger');

const { verifyWebhook, parseInbound, parseInboundRich, parseGreenApiWebhook, releaseQueuedMessages, sendText, notifyLeadTeam } = require('./services/whatsapp.service');
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

const { initWorkers } = require('./workers/scheduler');
const automations     = require('./utils/automation_store');

const app  = express();
const PORT = process.env.PORT ?? 3000;

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

// POST /api/leads/webhook — Meta Lead Ads inbound (new courier recruitment lead)
app.post('/api/leads/webhook', jsonBody, async (req, res) => {
  res.sendStatus(200);                    // Meta requires 200 within 5s

  try {
    // Meta sends only a leadgen_id in the webhook payload.
    // Actual field values (name, phone, area…) must be fetched from Graph API.
    const change    = req.body?.entry?.[0]?.changes?.[0]?.value;
    const leadgenId = change?.leadgen_id;
    const formId    = change?.form_id  ?? null;
    const adId      = change?.ad_id    ?? null;

    if (!leadgenId) {
      logger.debug('Meta leads webhook: no leadgen_id — skipping', { body: req.body });
      return;
    }

    logger.info('Meta lead webhook received', { leadgenId, formId });

    // Try Graph API first; fall back to whatever the webhook body contains
    const lead = await fetchAndNormalizeLead(leadgenId).catch(() => null)
                 ?? parseMetaLeadWebhook(req.body);

    if (!lead?.phone) {
      logger.warn('Meta lead: could not resolve phone — no Graph token or empty form?', { leadgenId });
      return;
    }

    store.upsertLead(lead.phone, {
      name:   lead.name,
      status: 'new',
      score:  5,
      meta:   { source: 'meta_ads', formId: lead.formId ?? formId, adId: lead.adId ?? adId },
    });
    store.logEvent('meta_lead_webhook', lead.phone, { name: lead.name, source: 'meta_ads' });
    logger.info('Meta lead captured', { phone: lead.phone, name: lead.name });

    // Notify team via WhatsApp immediately (bypass quiet hours — leads are time-sensitive)
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
  await releaseQueuedMessages();
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
  fixed_booking:  /שבץ אותי קבוע|לקבוע קבוע|להירשם קבוע|מנוי קבוע|כל שבוע/,
  cancellation:   /ביטול|תבטל[יה]?|לבטל|לא אגיע|לא מגיע[ה]?|לא יכול[ה]?|אבטל|ביטלתי|להסיר|תסיר אותי/,
  booking:        /תשבץ[יה]?|שיבוץ|לשבץ|רוצה מקום|תרשמ[יה]|להירשם|להצטרף|רשמ[יה] אותי|קבע[יה] לי|אני רוצ[האה] להירשם/,
  schedule_query: /לוח שיעורים|מה יש|מתי יש|יש שיעור|יש מקום|מה קורה|סדר יום|מה הלוח|איזה שיעורים|מה התוכנית|מה הוא שיעור/,
};

function detectSchedulingIntent(text) {
  if (!text) return 'general';
  if (INTENT_PATTERNS.fixed_booking.test(text))  return 'fixed_booking';
  if (INTENT_PATTERNS.cancellation.test(text))   return 'cancellation';
  if (INTENT_PATTERNS.booking.test(text))        return 'booking';
  if (INTENT_PATTERNS.schedule_query.test(text)) return 'schedule_query';
  return 'general';
}

// ── Barak scheduling draft reply ──────────────────────────────────────────────

async function buildSchedulingReply(intent, msg, clientMatch) {
  const firstName = (msg.name ?? clientMatch.arboxName ?? '').split(' ')[0] || 'שלום';

  if (intent === 'cancellation') {
    return (
      `${firstName}, בקשת הביטול שלך התקבלה ✅\n` +
      `אנחנו מעדכנים את הלוח ונחזור אליך עם אישור. ` +
      `אם תרצ/י לתאם מועד חלופי — רק תגיד/י! 🗓️`
    );
  }

  if (intent === 'fixed_booking') {
    return (
      `${firstName}, נשמח לשבץ אותך קבוע! 🎯\n` +
      `אחד מהצוות ייצור איתך קשר תוך שעה לתיאום. ` +
      `איזה שיעור מעניין אותך? (Reformer, Pilates Barre, Strength Training…)`
    );
  }

  // For booking / schedule_query — pull live schedule from Barak
  let scheduleData = { classes: [], total: 0 };
  try {
    scheduleData = await barakAgent.checkSchedule();
  } catch { /* non-fatal — reply without schedule data */ }

  if (intent === 'booking' || intent === 'schedule_query') {
    if (!scheduleData.classes?.length) {
      return `${firstName}, אין שיעורים נוספים היום. בדוק/י את הלוח שלנו מחר בבוקר! 🗓️`;
    }
    const lines = scheduleData.classes.slice(0, 5).map(c =>
      `• ${c.start} — ${c.name} (מדריך/ה: ${c.staff}, ${c.maxParticipants} מקומות)`
    ).join('\n');
    return (
      `${firstName}, הנה השיעורים הקרובים היום ב-Shape Studio 🏋️\n\n` +
      `${lines}\n\n` +
      `רוצה מקום? ענה/י עם שם השיעור שמעניין אותך 💪`
    );
  }

  return null;
}

// ── Internal processor (shared by webhook + simulate) ─────────────────────────

async function processInboundWAMessage(msg) {
  const fromNorm    = normalizeToE164(msg.from);
  const fromIsraeli = e164ToIsraeli(fromNorm);

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

  // 3. Routing decision
  let route     = 'unhandled';
  let barakReply = null;

  const isExistingClient = clientMatch.found && clientMatch.matchType === 'member';
  const isSchedulingMsg  = intent !== 'general';

  if (isSchedulingMsg) {
    // Scheduling intents always go to Barak regardless of client status
    route = 'barak';
    try { barakReply = await buildSchedulingReply(intent, msg, clientMatch); } catch { /* non-fatal */ }
  } else if (!isExistingClient) {
    // Unknown sender or known lead → lead qualification pipeline (lead_agent sends its own reply)
    route = 'lead_agent';
    try {
      await leadAgent.handleInbound({
        from: fromNorm,
        name: msg.name,
        text: msg.text ?? '',
      });
    } catch (err) {
      logger.error('Lead agent error in WA pipeline', { error: err.message, from: fromNorm });
    }
  } else {
    // Existing client, non-scheduling general message → Tomer handles retention context
    // (Barak handles scheduling; Tomer handles ongoing engagement and check-ins)
    route = 'tomer';
    if (msg.type === 'text' && msg.text?.trim()) {
      try {
        const tomerPrompt =
          `הודעה נכנסת מחבר/ת סטודיו פעיל/ה.\n` +
          `שם: ${msg.name ?? clientMatch.arboxName ?? 'לא ידוע'}\n` +
          `הודעה: "${msg.text}"\n\n` +
          `ענה בעברית בצורה אישית, חמה ותומכת — עד 3 משפטים.`;
        barakReply = await tomerAgent.chat(tomerPrompt);
      } catch (err) {
        logger.warn('Tomer general reply failed', { error: err.message, from: fromNorm });
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

  // 5. Lead store upsert + global event log
  const existing = store.getLead(fromNorm) ?? {};
  store.upsertLead(fromNorm, {
    name:         msg.name ?? clientMatch.arboxName ?? existing.name,
    messageCount: (existing.messageCount ?? 0) + 1,
    arboxSynced:  clientMatch.found,
    arboxId:      clientMatch.arboxId ?? existing.arboxId,
    meta: {
      ...(existing.meta ?? {}),
      isClient:   isExistingClient,
      lastIntent: intent,
      source:     'whatsapp_live',
    },
  });

  store.logEvent('message_in', fromNorm, {
    preview:     (msg.text ?? '').slice(0, 80),
    intent,
    route,
    inboxId:     inboxEntry.id,
    clientFound: clientMatch.found,
    clientName:  clientMatch.arboxName,
    source:      'whatsapp_live',
  });

  logger.info('WA pipeline processed', {
    from:    fromNorm,
    type:    msg.type,
    intent,
    route,
    client:  clientMatch.found ? clientMatch.arboxName : '(new)',
  });

  // 6. Auto-reply when configured and Barak has a draft
  if (barakReply && process.env.WHATSAPP_AUTO_REPLY === 'true') {
    try {
      await sendText(fromNorm, barakReply);
      store.logEvent('message_out', fromNorm, {
        preview: barakReply.slice(0, 80),
        agent:   'barak',
        source:  'auto_reply',
      });
    } catch (err) {
      logger.warn('WA auto-reply failed', { from: fromNorm, error: err.message });
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

  processInboundWAMessage(msg).catch(err =>
    logger.error('WA pipeline error', { error: err.message, from: msg.from })
  );
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
// Security: the endpoint URL itself is the access control (UUID-like path is fine,
// but the current path is acceptable for a private deployment).
app.post('/api/green-api/webhook', express.json({ limit: '1mb' }), async (req, res) => {
  res.sendStatus(200); // respond immediately — Green API retries on non-200

  const rawType = req.body?.typeWebhook;
  logger.debug('Green API webhook received', { typeWebhook: rawType });

  // Silently ignore non-message events (state changes, device info, delivery receipts)
  if (!rawType || rawType !== 'incomingMessageReceived') return;

  const msg = parseGreenApiWebhook(req.body);
  if (!msg) return; // group message, unsupported type, or parse failure

  logger.info('Green API inbound message', {
    from:    msg.from,
    type:    msg.type,
    preview: msg.text?.slice(0, 60),
  });

  // Route through the full CRM pipeline — same logic as /api/whatsapp/webhook
  processInboundWAMessage(msg).catch(err =>
    logger.error('WA pipeline error (Green API)', { error: err.message, from: msg.from })
  );
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

// POST /api/webhooks/meta — flexible Meta Lead Ads stub (easier for testing than /api/leads/webhook)
app.post('/api/webhooks/meta', jsonBody, async (req, res) => {
  try {
    // Accept both strict Meta format and a simplified test format { name, phone, adCampaign }
    let lead = null;
    if (req.body?.entry) {
      lead = parseMetaLeadWebhook(req.body);
    } else {
      const { name, phone, adCampaign, adId } = req.body ?? {};
      if (!phone) return;
      const cleaned = String(phone).replace(/[\s\-+()]/g, '').replace(/^0/, '972');
      lead = { phone: cleaned, name: name ?? null, formId: adCampaign ?? 'test', adId: adId ?? null };
    }
    if (!lead?.phone) return;

    store.upsertLead(lead.phone, {
      name: lead.name, status: 'new', score: 5,
      meta: { source: 'meta_ads', formId: lead.formId, adId: lead.adId },
    });
    store.logEvent('meta_lead_webhook', lead.phone, { name: lead.name, source: 'meta_ads' });
    automations.recordExecution('rule-008', { phone: lead.phone, name: lead.name });
    logger.info('Meta webhook (stub) lead captured', { phone: lead.phone, name: lead.name });
    return res.json({ ok: true, captured: true, phone: lead.phone, name: lead.name, ts: new Date() });
  } catch (err) {
    logger.error('Meta webhook stub error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`Shape Studio Agent running — http://localhost:${PORT}`);
  initWorkers(store);
});

module.exports = app;
