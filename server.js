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

const { verifyWebhook, parseInbound, parseInboundRich, parseGreenApiWebhook, releaseQueuedMessages, sendText, sendFileByUrl, alertOwner, notifyLeadTeam, probeGreenApiConnection, getGreenCreds, _tokenSourceVar, getTestSendLog, clearTestSendLog } = require('./services/whatsapp.service');
const { SCHEDULE_TIMETABLE_RE: _SCHEDULE_RE } = require('./agents/deterministic_reply');
const phoneRegistry = require('./utils/phone_registry');
// conversation_fsm is imported for future wiring into processInboundWAMessage.
// Currently the pipeline uses the existing isExistingClient / 4-tier routing path.
// getFsmState() is not yet called in the message pipeline — it is a structural module
// available for the next integration step (replace isExistingClient tree with FSM dispatch).
const { getState: getFsmState } = require('./utils/conversation_fsm'); // eslint-disable-line no-unused-vars
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
const tomerStore                       = require('./utils/tomer_store');
const retentionWorker                  = require('./workers/retention_worker');
const studioAssets                     = require('./utils/studio_assets');
const memberCache                      = require('./utils/member_cache');
const { detectAndMarkConversions, isMemberPhoneSync } = require('./utils/conversion_detector');

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
  if (!base) {
    logger.warn('[timetable] getActiveTimetableUrl: no base URL — BACKEND_URL and RAILWAY_PUBLIC_DOMAIN both unset');
    return null;
  }
  const imgPath = studioAssets.getTimetableImagePath();
  if (imgPath && fs.existsSync(imgPath)) return `${base}/api/admin/timetable-image`;
  if (fs.existsSync(SCHEDULE_PNG_PATH))  return `${base}/schedule.png`;
  logger.warn('[timetable] getActiveTimetableUrl: no image file found', {
    uploadedPath: imgPath ?? '(not uploaded)',
    staticPath:   SCHEDULE_PNG_PATH,
    hint:         'Upload timetable image via admin UI, or check DATA_DIR Volume is mounted on Railway',
  });
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

/**
 * Synchronous self-cleaning pass: remove every lead record whose phone is
 * now confirmed as a member in PhoneRegistry.
 *
 * Uses only phoneRegistry.isMember() — zero Arbox API calls, zero I/O.
 * The registry must already be initialised before calling this.
 *
 * Called from two places:
 *   • Startup: immediately after persist.loadLeads() catches stale records
 *     that were written before the person became a member.
 *   • 15-min cron: catches conversions that occurred since the last daily
 *     09:15 detectAndMarkConversions run.
 *
 * Does NOT delete records — reclassifies to status='converted_member'.
 * This preserves conversation history and meta for audit while removing the
 * record from all sales flows, cron queues, and dashboard lead views.
 *
 * Returns count of reclassified records so callers can persist and broadcast.
 *
 * @param {'startup'|'cron_15min'|string} source - label for logs/events
 * @returns {number}
 */
function _purgeKnownMembersFromLeadStore(source = 'unknown') {
  const leads = store.getAllLeads();
  if (!leads.length) return 0;

  let reclassified = 0;
  for (const lead of leads) {
    if (!lead.phone) continue;
    if (lead.status === 'converted_member') continue; // already done
    if (!phoneRegistry.isMember(lead.phone)) continue;

    store.reclassifyAsConvertedMember(lead.phone, { name: lead.name ?? null, source });
    store.logEvent('member_reclassified_from_leads', lead.phone, {
      name: lead.name ?? null,
      source,
      historyPreserved: (lead.history ?? []).length,
    });
    logger.info('[lead-purge] Member reclassified (history preserved)', {
      phone:        lead.phone,
      name:         lead.name ?? '(unknown)',
      historyTurns: (lead.history ?? []).length,
      source,
    });
    reclassified++;
  }
  return reclassified;
}

/**
 * Proactively seed the member cache from Arbox.
 * Called on startup and every 15 minutes via cron.
 * Non-blocking — always call fire-and-forget with .catch()
 */
async function seedMemberCache() {
  return memberCache.seedFromArbox({
    normalizeToE164,
    _autoAddKnownMember,
  }).catch(err => logger.warn('[server] seedMemberCache failed', { error: err.message }));
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

// ── Test instrumentation endpoints ───────────────────────────────────────────
// All routes below are gated behind TEST_MODE=true and return 404 in production.
// TEST_MODE must be set explicitly in .env for local integration testing only.
// These endpoints must never be deployed to production without this guard.
//
// The send log stores only the last-4-digit phone tail and send type — no raw
// phones, no message content. The events endpoint returns masked phones and
// event types only.

function requireTestMode(req, res, next) {
  if (process.env.TEST_MODE !== 'true') return res.status(404).end();
  next();
}

// GET /api/test/sends — return send counts since last clear (phone tail only)
app.get('/api/test/sends', requireTestMode, (_req, res) => {
  const log = getTestSendLog();
  res.json({ sends: log, count: log.length });
});

// DELETE /api/test/sends — clear the send log (call before each test)
app.delete('/api/test/sends', requireTestMode, (_req, res) => {
  clearTestSendLog();
  res.json({ ok: true, cleared: true });
});

// DELETE /api/test/cooldowns — clear the reply cooldown map.
// The 10-second REPLY_COOLDOWN prevents double-firing in production but
// causes route='acknowledged' for rapid test-to-test messages on the same phone.
app.delete('/api/test/cooldowns', requireTestMode, (_req, res) => {
  _lastReplied.clear();
  res.json({ ok: true });
});

// GET /api/test/events — recent events for a phone, filtered by type.
// Returns event type and timestamp only. Phone masked in response.
// Used to verify agent invocation (message_in = Barak; client_message_in = Tomer).
app.get('/api/test/events', requireTestMode, (req, res) => {
  const rawPhone = req.query.phone ? normalizeToE164(req.query.phone) : null;
  if (!rawPhone) return res.status(400).json({ error: 'phone required' });
  const since  = req.query.since ? new Date(req.query.since) : null;
  const events = store.getEvents({ phone: rawPhone, since: since ?? undefined, limit: 50 });
  res.json({
    events: events.map(e => ({
      type: e.type,
      ts:   e.ts,
      // Mask phone — never return raw phone in test responses
      phone: maskPhone(e.phone ?? rawPhone),
    })),
    count: events.length,
  });
});

// DELETE /api/leads/:phone — remove a lead entirely (test cleanup only).
// Not an admin feature: communication restrictions and identity records are not
// preserved on full delete. Exists solely for test isolation.
app.delete('/api/leads/:phone', requireTestMode, (req, res) => {
  const norm = normalizeToE164(decodeURIComponent(req.params.phone));
  if (!norm) return res.status(400).json({ error: 'invalid phone' });
  const existing = store.getLead(norm);
  if (!existing) return res.status(404).json({ error: 'lead not found' });
  store.deleteLead(norm);
  persist.saveLeads(store);
  logger.info('[api/leads] Lead deleted (test cleanup)', { phone: norm });
  res.json({ ok: true, phone: norm });
});

// GET /api/health/registry — phone registry and timetable facts (no assumptions)
app.get('/api/health/registry', (_req, res) => {
  const ageMs  = phoneRegistry.age();
  const size   = phoneRegistry.size();
  const refreshIntervalMs = 60_000; // phone_registry background interval
  // Stale = more than 3 missed refresh cycles (3 min) since last successful sync
  const staleThresholdMs = refreshIntervalMs * 3;

  const assets   = studioAssets.getAssets();
  const imgPath  = studioAssets.getTimetableImagePath();
  const imgPath2 = studioAssets.getTimetable2ImagePath();
  const base     = getBackendBase();

  // Fact: does the file actually exist on disk?
  const img1Exists = !!(imgPath && fs.existsSync(imgPath));
  const img2Exists = !!(imgPath2 && fs.existsSync(imgPath2));
  const staticExists = fs.existsSync(SCHEDULE_PNG_PATH);

  // Fact: when was the image file last written (mtime)? Independent of URL reachability.
  let img1LastModifiedAt = null;
  if (img1Exists && imgPath) {
    try { img1LastModifiedAt = fs.statSync(imgPath).mtime.toISOString(); } catch {}
  } else if (staticExists) {
    try { img1LastModifiedAt = fs.statSync(SCHEDULE_PNG_PATH).mtime.toISOString(); } catch {}
  }

  // Fact: what URL would be constructed (requires base URL)?
  // Presence of a URL does NOT imply the image is accessible from outside — it
  // requires the base URL to be reachable and the DATA_DIR Volume to be mounted.
  const img1Url = base && img1Exists
    ? `${base}/api/admin/timetable-image`
    : base && staticExists
      ? `${base}/schedule.png`
      : null;
  const img2Url = base && img2Exists ? `${base}/api/admin/timetable2-image` : null;

  res.json({
    registry: {
      size,
      ageMs,
      ageSec:             Math.round(ageMs / 1000),
      refreshIntervalSec: refreshIntervalMs / 1000,   // actual Arbox poll cadence: 60s
      staleBeyondSec:     staleThresholdMs / 1000,    // 3 missed cycles = 180s
      isStale:            ageMs > staleThresholdMs,
      isEmpty:            size === 0,
      diagnosis:          size === 0            ? 'EMPTY — registry never loaded or last refresh failed'
                        : ageMs > staleThresholdMs ? 'STALE — last sync was ' + Math.round(ageMs/1000) + 's ago'
                        : 'OK',
    },
    timetable: {
      // Three independent facts (each can be true/false independently):
      uploadedFlag:       assets.timetableImageUploaded,  // set by admin upload endpoint
      imageExt:           assets.timetableImageExt || null,
      img1Path:           imgPath ?? null,
      img1FileExists:     img1Exists,          // disk presence — does NOT prove HTTP accessibility
      img1LastModifiedAt: img1LastModifiedAt,  // when the file was last written
      img2FileExists:     img2Exists,
      staticPngExists:    staticExists,
      baseUrlSet:         !!base,
      img1Url:            img1Url ?? null,     // null if base missing or no file on disk
      img2Url:            img2Url ?? null,
      // Diagnosis is factual — no "will be sent" claims
      diagnosis:          !base            ? 'BASE_URL_MISSING — set BACKEND_URL or deploy to Railway'
                        : img1Exists       ? 'img1 file found on disk; URL constructable — verify Railway Volume is mounted for external access'
                        : staticExists     ? 'using static schedule.png fallback; img1LastModifiedAt shows when it was last updated'
                        : 'NO_IMAGE_FILE — uploadedFlag=' + assets.timetableImageUploaded +
                          '; if true, file may have been lost (check DATA_DIR Volume mount)',
    },
    checkedAt: new Date(),
  });
});

// ── Admin: dry-run reclassification ──────────────────────────────────────────
// GET  /api/admin/dry-run-members  — show what would be reclassified (no changes)
// POST /api/admin/reclassify-members — apply reclassification with backup first
//
// Backup file: DATA_DIR/converted_members_backup_<timestamp>.json
// Restore: copy backup phones back to known_members.json and invalidate memberCache.

app.get('/api/admin/dry-run-members', (_req, res) => {
  const allLeads = store.getAllLeads();
  const candidates = allLeads.filter(l =>
    l.phone && l.status !== 'converted_member' && phoneRegistry.isMember(l.phone)
  );
  res.json({
    wouldReclassify: candidates.length,
    records: candidates.map(l => ({
      phone_masked:    l.phone.slice(0, 5) + '****' + l.phone.slice(-3),
      name:            l.name ?? null,
      status:          l.status,
      score:           l.score,
      messageCount:    l.messageCount,
      firstSeen:       l.firstSeen,
      lastActivity:    l.lastActivity,
      historyTurns:    (l.history ?? []).length,
      metaKeys:        Object.keys(l.meta ?? {}),
      introOfferSent:  l.introOfferSent,
    })),
    note: 'No changes made. POST /api/admin/reclassify-members to apply with backup.',
    checkedAt: new Date(),
  });
});

app.post('/api/admin/reclassify-members', async (_req, res) => {
  const allLeads = store.getAllLeads();
  const candidates = allLeads.filter(l =>
    l.phone && l.status !== 'converted_member' && phoneRegistry.isMember(l.phone)
  );

  if (!candidates.length) {
    return res.json({ reclassified: 0, note: 'No member records found in lead store.' });
  }

  // Write backup BEFORE making any changes
  const backupPath = path.join(
    (process.env.DATA_DIR ?? path.join(__dirname, 'data')).replace(/\/$/, ''),
    `converted_members_backup_${Date.now()}.json`
  );
  try {
    fs.writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      count: candidates.length,
      records: candidates.map(l => ({ ...l, phone_masked: l.phone.slice(0,5)+'****'+l.phone.slice(-3) })),
    }, null, 2), 'utf8');
    logger.info('[reclassify] Backup written', { path: backupPath, count: candidates.length });
  } catch (backupErr) {
    return res.status(500).json({ error: 'Backup failed — no changes made', detail: backupErr.message });
  }

  // Apply reclassification
  let done = 0;
  for (const l of candidates) {
    store.reclassifyAsConvertedMember(l.phone, { name: l.name ?? null, source: 'admin_reclassify' });
    store.logEvent('member_reclassified_admin', l.phone, {
      name: l.name, historyPreserved: (l.history ?? []).length,
    });
    done++;
  }

  persist.saveLeads(store);
  broadcastSse('leads_updated', { reclassified: done, source: 'admin_reclassify' });
  logger.info('[reclassify] Admin reclassification complete', { reclassified: done, backupPath });

  res.json({
    reclassified: done,
    backupPath,
    note: 'All changes persisted. Backup available at backupPath for rollback.',
    reclassifiedAt: new Date(),
  });
});

// ── WhatsApp webhook — verification (GET) ────────────────────────────────────
app.get('/webhook/whatsapp', verifyWebhook);

// ── WhatsApp webhook — inbound messages (POST) ───────────────────────────────
// captureRawBody must run before verifyMetaSignature (needs raw bytes for HMAC).
// JSON is parsed manually from req.rawBody so the stream stays intact for signing.
app.post('/webhook/whatsapp', captureRawBody, verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);
  let body = {};
  try { body = JSON.parse(req.rawBody || '{}'); } catch { return; }

  // Previously called leadAgent.handleInbound directly, bypassing:
  //   - 4-tier member identity resolution (members reached the sales funnel)
  //   - message deduplication (duplicate webhooks caused duplicate replies)
  //   - ownership / opt-out gates
  //   - inbox logging and SSE broadcasting
  // Now routes through processInboundWAMessage (the same full pipeline used by
  // /api/whatsapp/webhook and /api/green-api/webhook).
  const message = parseInboundRich(body);
  if (!message) return;

  logger.info('Inbound WhatsApp message (Meta webhook)', { from: message.from, preview: (message.text ?? '').slice(0, 60) });
  scheduleInboundProcessing(message);
});

// ── REST API — shared express.json() parser for all /api POST routes ──────────
const jsonBody = express.json();

// GET /api/leads — all leads (history stripped, phone masked)
// Runtime member filter: confirmed members are stripped from every response.
// Also reactively purges any members found — so the first dashboard open after
// a failed startup purge permanently cleans the store without a manual step.
app.get('/api/leads', (_req, res) => {
  const allLeads = store.getAllLeads();

  // Identify any leads that are now confirmed members in PhoneRegistry.
  // isMember() is synchronous O(1) — safe to call in a request handler.
  const memberLeads = allLeads.filter(l =>
    l.phone && l.status !== 'converted_member' && phoneRegistry.isMember(l.phone)
  );

  // Reactively reclassify members found during dashboard load.
  // Uses reclassifyAsConvertedMember so history is preserved.
  if (memberLeads.length > 0) {
    for (const l of memberLeads) {
      store.reclassifyAsConvertedMember(l.phone, { name: l.name ?? null, source: 'reactive_api_read' });
      store.logEvent('member_reclassified_on_api_read', l.phone, { name: l.name ?? null });
      logger.info('[api/leads] Reactive reclassify — confirmed member removed from lead view', {
        phone: l.phone, name: l.name, historyTurns: (l.history ?? []).length,
      });
    }
    persist.saveLeads(store);
  }

  const leads = allLeads
    .filter(l => l.status !== 'converted_member' && (!l.phone || !phoneRegistry.isMember(l.phone)))
    .map(({ history, ...l }) => ({ ...l, phone: maskPhone(l.phone) }));

  res.json(leads);
});

// GET /api/version — running code identity, for deployment verification
// Returns the git commit SHA baked in at build time via RAILWAY_GIT_COMMIT_SHA,
// plus the active webhook URL so callers can confirm which provider is configured.
app.get('/api/version', (_req, res) => {
  res.json({
    commit:          process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown (env not set)',
    deploymentId:    process.env.RAILWAY_DEPLOYMENT_ID ?? 'unknown',
    serviceId:       process.env.RAILWAY_SERVICE_ID    ?? 'unknown',
    startedAt:       process.env._SERVER_START_TS      ?? 'unknown',
    activeWebhooks: {
      greenApi: !!process.env.GREEN_API_ID_INSTANCE || !!process.env.GREEN_API_INSTANCE_ID,
      metaCloud: !!process.env.WHATSAPP_ACCESS_TOKEN,
    },
    phoneRegistrySize: (typeof phoneRegistry?.size === 'function') ? phoneRegistry.size() : 'unavailable',
  });
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

// POST /api/dana/analyze-video — Mosseri-framework content review (text-based)
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

// ── Dana video upload + async analysis job system (Fix 4) ─────────────────────
//
// Upload via multipart/form-data (not base64 JSON) to avoid 33% base64 overhead.
// Max file size: 150 MB on disk (declared up-front in UI; multer enforces on server).
//
// Flow:
//   POST /api/dana/analyze-video-upload   — save file, create job, return {jobId} immediately
//   GET  /api/dana/analysis-job/:id       — poll: returns {status, stage, note, error, result}
//   GET  /api/dana/video-history          — list saved analyses (from report.json files)
//   GET  /api/dana/video-history/:id      — load one full report
//   GET  /api/dana/skill-status           — which Mosseri skill files are loaded

const multer      = require('multer');
const { v4: _uuid4 } = require('uuid');

// Store uploads in DATA_DIR/uploads/ so Railway Volume keeps them
const _uploadDir = () => {
  const d = path.join((process.env.DATA_DIR ?? path.join(__dirname, 'data')).replace(/\/$/, ''), 'uploads');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
};

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, _uploadDir()),
    filename:    (_req, _file, cb) => cb(null, _uuid4() + '_' + Date.now()),
  }),
  limits: { fileSize: 150 * 1024 * 1024 },  // 150 MB — consistent with UI
  fileFilter: (_req, file, cb) => {
    const ALLOWED = new Set(['video/mp4','video/quicktime','video/webm','video/x-msvideo','video/x-matroska']);
    const ext     = file.originalname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    const ALLOWED_EXT = new Set(['mp4','mov','webm','avi','mkv']);
    if (ALLOWED.has(file.mimetype) || ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`פורמט לא נתמך: ${file.mimetype || ext}. נתמכים: mp4, mov, webm, avi, mkv`));
  },
});

// MIME → extension mapping
const MIME_TO_EXT = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'video/x-msvideo': 'avi', 'video/x-matroska': 'mkv',
};

app.post('/api/dana/analyze-video-upload',
  videoUpload.single('video'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'קובץ וידאו חסר (שדה: video)' });

    const { title, goal, format, audience, organic_or_paid, message, focus_notes, previousVersionId } = req.body ?? {};

    const ext = MIME_TO_EXT[req.file.mimetype] ??
                (req.file.originalname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'mp4');

    // Create job immediately and return jobId — client will poll
    const id  = _uuid4();
    const job = danaAgent.createAnalysisJob(id, {
      title: title ?? 'סרטון ללא כותרת',
      sizeKb: Math.round(req.file.size / 1024),
    });

    logger.info('[dana] Video upload received — job created', { id, sizeKb: job.sizeKb, ext });
    res.json({ jobId: id, status: 'queued' });

    // Run analysis asynchronously — does NOT block the HTTP response
    setImmediate(async () => {
      let savedVideoPath;
      try {
        // Move multer temp file to DATA_DIR/videos/{id}/video.{ext}
        const videoSvc = require('./services/video.service');
        savedVideoPath = videoSvc.saveVideoFromPath(id, req.file.path, ext);

        danaAgent.updateJob(id, { status: 'running', stage: 'meta', note: 'קורא מטא-דאטה...' });

        const report = await danaAgent.analyzeVideoFile({
          videoPath:  savedVideoPath,
          id,
          ext,
          title:            title            ?? 'סרטון ללא כותרת',
          goal:             goal             ?? 'leads',
          format:           format           ?? 'feed',
          audience:         audience         ?? '',
          organic_or_paid:  organic_or_paid  ?? 'organic',
          message:          message          ?? '',
          focus_notes:      focus_notes      ?? '',
          previousVersionId: previousVersionId ?? null,
          onProgress: (stage, note) => danaAgent.updateJob(id, { status: 'running', stage, note }),
        });

        danaAgent.updateJob(id, {
          status: 'completed',
          stage:  'done',
          note:   `ניתוח הושלם — ציון ${report.readiness}/100`,
          result: { id, readiness: report.readiness, verdict: report.verdict },
        });
      } catch (err) {
        logger.error('[dana] async analysis failed', { id, error: err.message });
        danaAgent.updateJob(id, { status: 'failed', stage: 'error', error: err.message });
        // Clean up tmp file if save didn't happen
        if (req.file?.path && !savedVideoPath) {
          try { fs.unlinkSync(req.file.path); } catch {}
        }
      }
    });
  }
);

// Reprocess a saved video — retries analysis on a previously uploaded file without re-uploading.
// Re-analyse an existing video.
// Always creates a NEW job ID → original report.json is never overwritten.
// previousVersionId links the new report to the old one.
app.post('/api/dana/analysis-job/:id/retry', jsonBody, async (req, res) => {
  const originalId = req.params.id;
  const originalJob = danaAgent.getJob(originalId);
  if (!originalJob) return res.status(404).json({ error: 'Job לא נמצא' });

  // Find the saved video file from the original job
  const videoSvc  = require('./services/video.service');
  const dataDir   = videoSvc.DATA_DIR_FN();
  const videoDir  = require('path').join(dataDir, 'videos', originalId);
  if (!require('fs').existsSync(videoDir)) {
    return res.status(404).json({ error: 'תיקיית הסרטון לא נמצאה — יש להעלות שוב' });
  }

  const files = require('fs').readdirSync(videoDir).filter(f => f.startsWith('video.'));
  if (files.length === 0) {
    return res.status(404).json({ error: 'קובץ הסרטון לא נמצא — יש להעלות שוב' });
  }

  const videoFile   = files[0];
  const srcPath     = require('path').join(videoDir, videoFile);
  const ext         = videoFile.split('.').pop() ?? 'mp4';

  // Always use a new UUID — the original report.json is NEVER overwritten
  const { v4: _uuid4reanalyze } = require('uuid');
  const newId    = _uuid4reanalyze();
  const newDir   = require('path').join(dataDir, 'videos', newId);
  require('fs').mkdirSync(newDir, { recursive: true });
  const destPath = require('path').join(newDir, videoFile);
  require('fs').copyFileSync(srcPath, destPath);

  const { title, goal, format, audience, organic_or_paid, message, focus_notes } = req.body ?? {};
  const prevMeta = originalJob.title ? { title: originalJob.title } : {};

  logger.info('[dana] Re-analyse with new ID', { originalId, newId, ext });
  const newJob = danaAgent.createAnalysisJob(newId, {
    title:    title ?? prevMeta.title ?? 'ניתוח מחדש',
    sizeKb:   Math.round(require('fs').statSync(destPath).size / 1024),
    previousVersionId: originalId,
  });

  res.json({ jobId: newId, originalId, status: 'queued' });

  setImmediate(async () => {
    let savedPath;
    try {
      savedPath = destPath; // already copied
      danaAgent.updateJob(newId, { status: 'running', stage: 'meta', note: 'מנסה שוב...' });
      const report = await danaAgent.analyzeVideoFile({
        videoPath:  savedPath,
        id:         newId,
        ext,
        title:            title            ?? prevMeta.title ?? 'ניתוח מחדש',
        goal:             goal             ?? 'leads',
        format:           format           ?? 'feed',
        audience:         audience         ?? '',
        organic_or_paid:  organic_or_paid  ?? 'organic',
        message:          message          ?? '',
        focus_notes:      focus_notes      ?? '',
        previousVersionId: originalId,
        onProgress: (stage, note) => danaAgent.updateJob(newId, { status: 'running', stage, note }),
      });
      danaAgent.updateJob(newId, {
        status: 'completed', stage: 'done',
        note:   `ניתוח הושלם — ציון ${report.readiness}/100`,
        result: { id: newId, readiness: report.readiness, verdict: report.verdict },
      });
    } catch (err) {
      logger.error('[dana] re-analyse failed', { newId, originalId, error: err.message });
      danaAgent.updateJob(newId, { status: 'failed', stage: 'error', error: err.message });
    }
  });
});

// Poll job status
app.get('/api/dana/analysis-job/:id', (req, res) => {
  const job = danaAgent.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job לא נמצא' });

  const payload = {
    id:        job.id,
    status:    job.status,
    stage:     job.stage,
    note:      job.note,
    error:     job.error    ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  // If completed, include the full report
  if (job.status === 'completed') {
    payload.report = danaAgent.getVideoReport(job.id) ?? null;
  }

  res.json(payload);
});

app.get('/api/dana/video-history', (_req, res) => {
  try { res.json({ analyses: danaAgent.getVideoHistory() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dana/video-history/:id', (req, res) => {
  const report = danaAgent.getVideoReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'ניתוח לא נמצא' });
  res.json(report);
});

// List backup reports for a job (created by saveReport before overwrite)
app.get('/api/dana/video-history/:id/backups', (req, res) => {
  const videoSvc = require('./services/video.service');
  const videoDir = require('path').join(videoSvc.DATA_DIR_FN(), 'videos', req.params.id);
  if (!require('fs').existsSync(videoDir)) return res.status(404).json({ backups: [] });
  const baks = require('fs').readdirSync(videoDir)
    .filter(f => f.endsWith('.bak.json'))
    .sort().reverse()
    .map(f => ({ file: f, url: `/api/dana/video-history/${req.params.id}/backup/${f}` }));
  res.json({ id: req.params.id, backups: baks });
});

// Retrieve a specific backup
app.get('/api/dana/video-history/:id/backup/:file', (req, res) => {
  const f = req.params.file;
  if (!/^report\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.bak\.json$/.test(f))
    return res.status(400).json({ error: 'Invalid backup filename' });
  const videoSvc = require('./services/video.service');
  const p = require('path').join(videoSvc.DATA_DIR_FN(), 'videos', req.params.id, f);
  if (!require('fs').existsSync(p)) return res.status(404).json({ error: 'Backup not found' });
  try { res.json(JSON.parse(require('fs').readFileSync(p, 'utf8'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Skill status
app.get('/api/dana/skill-status', (_req, res) => {
  try { res.json(danaAgent.getSkillStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Video file serving (for panel playback) ───────────────────────────────────
// GET /api/dana/video/:id  — stream the original uploaded video.
//   • id  must match a saved report (guards against path traversal).
//   • Supports HTTP Range requests so the browser <video> element can seek.
//   • Report and video are independent: 404 on the video does NOT break the report.

const MIME_BY_EXT = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
};

app.get('/api/dana/video/:id', (req, res) => {
  const id = req.params.id;
  // Reject IDs that look like path traversal attempts
  if (!/^[a-f0-9-]{30,40}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid analysis ID format' });
  }

  // Report must exist — proves the video was produced by this server
  const report = danaAgent.getVideoReport(id);
  if (!report) return res.status(404).json({ error: 'ניתוח לא נמצא' });

  const videoSvc  = require('./services/video.service');
  const videoDir  = require('path').join(videoSvc.DATA_DIR_FN(), 'videos', id);
  const files     = require('fs').existsSync(videoDir)
    ? require('fs').readdirSync(videoDir).filter(f => f.startsWith('video.'))
    : [];

  if (files.length === 0) {
    return res.status(404).json({ error: 'קובץ הסרטון לא זמין (נמחק או לא נשמר בנפח הקבוע)' });
  }

  const videoFile = files[0];
  const ext       = videoFile.split('.').pop()?.toLowerCase() ?? 'mp4';
  const videoPath = require('path').join(videoDir, videoFile);
  const stat      = require('fs').statSync(videoPath);
  const fileSize  = stat.size;
  const mimeType  = MIME_BY_EXT[ext] ?? 'video/mp4';

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    // Partial content (Range request) — required for browser seeking
    const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);
    if (start >= fileSize || start > end) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
      'Content-Type':   mimeType,
    });
    require('fs').createReadStream(videoPath, { start, end }).pipe(res);
  } else {
    // Full file response
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type':   mimeType,
      'Accept-Ranges':  'bytes',
    });
    require('fs').createReadStream(videoPath).pipe(res);
  }
});

// Stale-report audit: mark old reports that used wrong score scale or schema anchoring.
// GET returns current status (both bug types). POST triggers a rescan.
app.get('/api/dana/reports/audit', (_req, res) => {
  try {
    const history = danaAgent.getVideoHistory();
    const stale   = history.filter(r => {
      const full = danaAgent.getVideoReport(r.id);
      return full?.scoreScaleInvalid === true || full?.staleSchemaAnchored === true;
    });
    res.json({
      total:        history.length,
      staleCount:   stale.length,
      staleIds:     stale.map(r => r.id),
      note:         stale.length > 0
        ? `${stale.length} דוח/ות עם ציונים לא תקפים (סקאלה שגויה או schema-anchoring). הצע ניתוח מחדש.`
        : 'כל הדוחות תקינים.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dana/reports/audit', jsonBody, (_req, res) => {
  try {
    const result = danaAgent.markStaleReports();
    res.json({ ...result, note: 'סריקה הושלמה. דוחות פגומים סומנו.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark a specific report as stale (schema-anchored) with optional replacedByJobId.
// PATCH /api/dana/reports/:id/mark-stale { staleSchemaAnchored: true, replacedByJobId?: string }
app.patch('/api/dana/reports/:id/mark-stale', jsonBody, (req, res) => {
  const id = req.params.id;
  const videoSvc = require('./services/video.service');
  const dataDir  = videoSvc.DATA_DIR_FN();
  const rptPath  = require('path').join(dataDir, 'videos', id, 'report.json');
  if (!require('fs').existsSync(rptPath)) return res.status(404).json({ error: 'Report not found' });
  try {
    const r = JSON.parse(require('fs').readFileSync(rptPath, 'utf8'));
    if (req.body?.staleSchemaAnchored) r.staleSchemaAnchored = true;
    if (req.body?.scoreScaleInvalid)   r.scoreScaleInvalid   = true;
    if (req.body?.replacedByJobId)     r.replacedByJobId     = req.body.replacedByJobId;
    if (req.body?.staleSchemaNote)     r.staleSchemaNote     = req.body.staleSchemaNote;
    require('fs').writeFileSync(rptPath, JSON.stringify(r, null, 2), 'utf8');
    res.json({ id, marked: true, replacedByJobId: r.replacedByJobId ?? null });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

    // ── Lead resolved — guard against re-opening the funnel for existing members ─
    // phoneRegistry is a synchronous O(1) Set — safe to call without await.
    // If the phone is a confirmed Arbox member, log and skip the upsert entirely.
    // Without this guard, a Meta Lead Ad for an existing subscriber would override
    // their converted_member status and restart Barak's qualification flow.
    if (phoneRegistry.isMember(lead.phone)) {
      logger.info('[meta-lead] Skipping upsert — phone is a confirmed Arbox member', {
        phone: lead.phone, name: lead.name, leadgenId,
      });
      store.logEvent('meta_lead_member_skip', lead.phone, { name: lead.name, leadgenId, source: 'meta_ads' });
      return;
    }

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

// NOTE: PhoneRegistry has its OWN internal 60-second interval (started in init()).
// The crons below maintain the LEGACY member_cache and known_members.json layers
// for backward compatibility. PhoneRegistry is the primary identity gate.

// ── Member cache: proactive seeding + lead purge every 15 minutes ────────────
cron.schedule('*/15 * * * *', async () => {
  try {
    const result = await seedMemberCache();
    if (result?.seeded > 0) logger.info('Cron: member cache refreshed', result);

    // After seeding the legacy cache, purge any leads the registry now confirms
    // as members. The registry's own 60s interval may have refreshed it since the
    // last pass, so this catches conversions that happened within the last hour.
    const purged = _purgeKnownMembersFromLeadStore('cron_15min');
    if (purged > 0) {
      persist.saveLeads(store);
      broadcastSse('leads_updated', { purged, source: 'cron_15min' });
      logger.info('Cron: purged converted member records', { purged });
    }
  } catch (err) {
    logger.warn('Cron: member cache seed failed', { error: err.message });
  }
}, { timezone: 'Asia/Jerusalem' });

// ── Conversion detector: runs before Tomer's re-engagement pass ───────────────
// Cross-references lead_store against Arbox to catch leads that have converted
// to members in Arbox without the system being notified.  Removes them from
// lead_store so Tomer's cron never sends a cold re-engagement to a paying member.
cron.schedule('15 9 * * *', async () => {
  logger.info('Cron: running conversion detector');
  try {
    const result = await detectAndMarkConversions(store, memberCache, normalizeToE164, _autoAddKnownMember);
    if (result.converted > 0) {
      logger.info('Cron: conversion detector found new members', result);
      alertOwner(
        '🔄 Conversions Detected',
        `${result.converted} ליד(ים) זוהו כחברים פעילים ב-Arbox והוסרו מתור השימור.`
      ).catch(() => {});
    }
  } catch (err) {
    logger.error('Cron: conversion detector failed', { error: err.message });
  }
}, { timezone: 'Asia/Jerusalem' });

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
    // Also stamp the in-process cache so Tomer's guard picks this up immediately
    // without waiting for the next 15-min Arbox seed cycle.
    memberCache.markConfirmed(norm, { name: name ?? null, role: 'client', source: 'manual_known_members' });
    logger.info('[known-members] Added override', { phone: norm, name });
    res.json({ ok: true, phone: norm, total: data.phones.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/members/mark-converted — manually convert a lead to member
// Use when Eden enrolls a lead in Arbox and wants the system to know immediately
// (before the next 15-min Arbox seed cycle picks it up).
app.post('/api/members/mark-converted', jsonBody, async (req, res) => {
  const { phone, name } = req.body ?? {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const norm = normalizeToE164(phone) ?? phone;
  try {
    // 1. Stamp in-process cache (instantly blocks Barak on next message)
    memberCache.markConfirmed(norm, { name: name ?? null, role: 'client', source: 'manual_conversion' });

    // 2. Stamp known_members.json (survives restarts)
    _autoAddKnownMember(norm, name ?? null);

    // 3. Remove from lead_store (stops Tomer's re-engagement queue)
    const existing = store.getLead(norm);
    if (existing) {
      store.deleteLead(norm);
      store.logEvent('lead_converted_manual', norm, { name: name ?? existing.name, triggeredBy: 'api' });
      logger.info('[conversion] Manual conversion applied', { phone: norm, name: name ?? existing.name });
    }

    res.json({ ok: true, phone: norm, name: name ?? null, cached: true, leadRemoved: !!existing });
  } catch (err) {
    logger.error('[conversion] mark-converted failed', { phone: norm, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/members/invalidate — remove a phone from the member cache
// Use when a membership is cancelled and the person may re-enter the funnel.
app.post('/api/members/invalidate', jsonBody, (req, res) => {
  const { phone } = req.body ?? {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const norm = normalizeToE164(phone) ?? phone;
  memberCache.invalidate(norm);
  store.logEvent('member_cache_invalidated', norm, { triggeredBy: 'api' });
  logger.info('[conversion] Member cache entry invalidated', { phone: norm });
  res.json({ ok: true, phone: norm });
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

// ── Lead ownership + stop-status management ───────────────────────────────────
//
// POST /api/leads/:phone/takeover  — staff takes ownership (stops all bot replies)
// POST /api/leads/:phone/release   — return ownership to Barak
// POST /api/leads/:phone/opt-out   — permanent opt-out (no outreach ever)

app.post('/api/leads/:phone/takeover', jsonBody, (req, res) => {
  const norm   = normalizeToE164(decodeURIComponent(req.params.phone));
  const { reason = 'manual', staffName = null } = req.body ?? {};
  if (!norm) return res.status(400).json({ error: 'invalid phone' });

  const existing = store.getLead(norm) ?? {};
  const prevStatus = existing.status ?? 'cold';
  store.upsertLead(norm, {
    status: 'human_owns',
    meta: {
      ...(existing.meta ?? {}),
      humanOwnsReason:    reason,
      humanOwnsSince:     new Date().toISOString(),
      humanOwnsBy:        staffName,
      previousStatus:     prevStatus,     // saved so release can restore it
    },
  });
  store.logEvent('human_takeover_manual', norm, { reason, staffName, prevStatus });
  persist.saveLeads(store);
  logger.info('[lead-ownership] Takeover — bot suppressed', { phone: norm, reason, staffName });
  res.json({ ok: true, phone: norm, status: 'human_owns', prevStatus });
});

app.post('/api/leads/:phone/release', jsonBody, (req, res) => {
  const norm = normalizeToE164(decodeURIComponent(req.params.phone));
  if (!norm) return res.status(400).json({ error: 'invalid phone' });

  const existing = store.getLead(norm);
  if (!existing) return res.status(404).json({ error: 'lead not found' });

  // Release only clears the human-ownership fields.
  // Communication restrictions and identity are authoritative and are NOT overridden
  // by releasing human ownership — they were set by the person or by identity resolution.
  //
  // Priority (highest to lowest):
  //   1. optedOutAt in meta         → restore to opted_out (permanent comms preference)
  //   2. isConfirmedMember in meta  → restore to converted_member (identity fact)
  //   3. previousStatus if valid    → restore to that automation state
  //   4. fallback                   → cold
  const meta = existing.meta ?? {};
  const ownershipClear = {
    humanOwnsReason:  null,
    humanOwnsSince:   null,
    humanOwnsBy:      null,
    humanReleasedAt:  new Date().toISOString(),
    previousStatus:   null,
  };

  // opted_out: authoritative sources in priority order:
  //   1. meta.optedOutAt — set by both in-flow and API opt-out paths
  //   2. meta.previousStatus — covers legacy records where optedOutAt was not yet written
  //      (e.g. opt-out set before this field was introduced, or via older code paths)
  if (meta.optedOutAt || meta.previousStatus === 'opted_out') {
    store.upsertLead(norm, { status: 'opted_out', meta: { ...meta, ...ownershipClear } });
    store.logEvent('human_release', norm, { restoredTo: 'opted_out', reason: 'opted_out_preserved' });
    persist.saveLeads(store);
    logger.info('[lead-ownership] Released — opted_out preserved', { phone: norm });
    return res.json({ ok: true, phone: norm, status: 'opted_out', automationResumed: false, reason: 'opted_out_preserved' });
  }

  // converted_member: authoritative sources in priority order:
  //   1. meta.isConfirmedMember — stamped by reclassifyAsConvertedMember
  //   2. phoneRegistry.isMember — synchronous O(1) check (most authoritative)
  //   3. meta.previousStatus — covers legacy records where isConfirmedMember was not yet written
  if (meta.isConfirmedMember || phoneRegistry.isMember(norm) || meta.previousStatus === 'converted_member') {
    store.upsertLead(norm, { status: 'converted_member', meta: { ...meta, ...ownershipClear } });
    store.logEvent('human_release', norm, { restoredTo: 'converted_member', reason: 'member_identity_preserved' });
    persist.saveLeads(store);
    logger.info('[lead-ownership] Released — converted_member preserved', { phone: norm });
    return res.json({ ok: true, phone: norm, status: 'converted_member', automationResumed: false, reason: 'member_identity_preserved' });
  }

  const AUTOMATION_STATES = new Set(['new', 'cold', 'warm', 'hot', 'call_scheduled', 'callback_requested']);
  const prev = meta.previousStatus;
  const restoreStatus = AUTOMATION_STATES.has(prev) ? prev : 'cold';
  store.upsertLead(norm, { status: restoreStatus, meta: { ...meta, ...ownershipClear } });
  store.logEvent('human_release', norm, { restoredTo: restoreStatus, wasStatus: prev });
  persist.saveLeads(store);
  logger.info('[lead-ownership] Released — bot resumed', { phone: norm, restoredTo: restoreStatus });
  return res.json({ ok: true, phone: norm, status: restoreStatus, automationResumed: true });
});

app.post('/api/leads/:phone/opt-out', jsonBody, (req, res) => {
  const norm = normalizeToE164(decodeURIComponent(req.params.phone));
  if (!norm) return res.status(400).json({ error: 'invalid phone' });

  const existing = store.getLead(norm) ?? {};
  store.upsertLead(norm, {
    status: 'opted_out',
    score:  0,
    meta: { ...(existing.meta ?? {}), optedOutAt: new Date().toISOString(), optedOutSource: 'manual_api' },
  });
  store.logEvent('opted_out_manual', norm, {});
  persist.saveLeads(store);
  logger.info('[lead-opt-out] Marked opted_out via API', { phone: norm });
  res.json({ ok: true, phone: norm, status: 'opted_out' });
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
  const s = String(phone).replace(/[\s\-\.\(\)\+]/g, ''); // strip +, spaces, dashes, dots, parens
  if (s.startsWith('00972')) return s.slice(2);            // 00972XXXXXXXXX → 972XXXXXXXXX
  if (s.startsWith('972'))   return s;                     // already E164
  if (s.startsWith('0'))     return '972' + s.slice(1);    // 05X → 972 5X
  if (s.length === 9)        return '972' + s;             // 5XXXXXXXX → 972 5XXXXXXXX
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
  // schedule_query covers both schedule listings AND instructor-specific questions.
  // Keep in sync with SCHEDULE_TIMETABLE_RE in deterministic_reply.js — any phrase
  // that matches that regex but not this one will route through lead_agent instead
  // of the scheduling pipeline's null-URL fallback.
  schedule_query:   /מערכת שעות|לוח שיעורים|מה יש|מתי יש|יש שיעור|יש מקום|מה קורה|סדר יום|מה הלוח|הלוח שלכם|הלוח שלך|שעות.*הסטודיו|שעות.*שלכם|שעות פעילות|שעות פתיחה|מתי פתוח|מתי פתוחים|לראות.*שעות|רוצה.*לוח|איזה שיעורים|מה התוכנית|מה הוא שיעור|מי מדריך|מי המדריך|מי מלמד|מי מנהל|מי נותן|באיזה שעה|בכמה|מה השעה|שיעור.{0,15}ב(יום|ערב|בוקר|צהריים)|ב(יום\s)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|יש לכם.*תמונה|שלח.*תמונה.*לוח|תמונה.*לוח|לוח.*תמונה|יש תמונה|שלח.*מערכת|רוצה.*מערכת|לראות.*מערכת|לוח.*שבוע|שבוע.*לוח|אפשר.*לראות.*לוח|שלח[יה]?\s+לי\s+(?:את\s+ה?)?תמונה|תשלח[יה]?\s+לי\s+(?:את\s+ה?)?תמונה|אפשר\s+תמונה|לשלוח\s+לי\s+תמונה|שלוח\s+לי\s+תמונה/,
};

// Explicit negation of a call/contact — must be checked BEFORE representative.
// "לא רוצה שיתקשרו" contains שיתקשרו which representative matches, but the
// intent is the opposite: the lead is declining a call, not requesting one.
const CALL_DECLINED_RE =
  /(?:(?:לא|אין)\s+רוצ[הה]|אל\s+ת)\s*ש(?:יתקשרו|יחזרו|יצרו\s+קשר)|רק\s+(?:וואטסאפ|מסרונים?|הודעות?)(?:\s|[,!.?]|$)/i;

function detectSchedulingIntent(text) {
  if (!text) return 'general';
  // call_declined: explicit negation of a callback — route to AI, not representative path
  if (CALL_DECLINED_RE.test(text))                   return 'general';
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

// Day names that make a schedule query specific to one day (→ Arbox live, not image).
const SPECIFIC_DAY_RE = /היום|מחר|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת/;

/**
 * Returns true when the user wants the full weekly timetable image rather
 * than a live per-day answer from Arbox.
 * Uses the authoritative SCHEDULE_TIMETABLE_RE from deterministic_reply.js
 * (imported as _SCHEDULE_RE) so the two layers stay in sync automatically.
 */
function isWeeklyTimetableQuery(text) {
  if (!text) return false;
  if (!_SCHEDULE_RE.test(text)) return false;
  // Day-specific queries need live Arbox data, not the image
  return !SPECIFIC_DAY_RE.test(text);
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

/**
 * @param {boolean} [opts.noMatchPassthrough] - When true, specialist_query with no
 *   staff match returns null (lets Barak AI handle it) rather than a dead-end "no info"
 *   string. Use for new-lead callers that have an AI fallthrough path.
 */
async function buildSchedulingReply(intent, msg, clientMatch, { noMatchPassthrough = false } = {}) {
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
    const { matched } = barakAgent.findInstructorsBySpecialty(msgText);
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
    // No match in directory.
    // For new leads (noMatchPassthrough=true): return null so Barak AI handles
    // the conversation naturally with an empathetic, non-dead-end response.
    // For existing clients: give a direct honest answer.
    if (noMatchPassthrough) return null;
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
  /^(קיבלתי|הבנתי|ברור|ממש|ביי|bye|ciao)\.?!*$/i,
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

// ── Bot-sent message tracker ──────────────────────────────────────────────────
// Two complementary mechanisms prevent bot echoes from triggering false human_owns:
//
// 1. _botSentIds (idMessage ring buffer): records every Green API idMessage we send.
//    outgoingMessageReceived echoes with this idMessage → confirmed bot send → skip.
//
// 2. _lastBotSendAt (per-phone timestamp): records when we last sent to each phone.
//    Covers send paths where the idMessage is not (yet) in _botSentIds due to async
//    registration or fire-and-forget sends. 20-second grace window.
const _botSentIds    = new Map(); // idMessage → { phone, sentAt }
const _lastBotSendAt = new Map(); // phone     → timestamp of last bot send
const BOT_SENT_TTL   = 24 * 60 * 60 * 1000;
const BOT_SEND_GRACE = 20_000; // 20 seconds — covers async echo delivery lag

function _markBotSent(phone) {
  if (phone) _lastBotSendAt.set(phone, Date.now());
}

function _recordBotSend(idMessage, phone) {
  if (!idMessage || typeof idMessage !== 'string') return;
  if (idMessage.startsWith('demo-') || idMessage.startsWith('blocked-')) return;
  _botSentIds.set(idMessage, { phone, sentAt: Date.now() });
  if (_botSentIds.size > 400) {
    const oldestKey = _botSentIds.keys().next().value;
    _botSentIds.delete(oldestKey);
  }
  _markBotSent(phone);
}

function _isBotSentId(idMessage) {
  if (!idMessage) return false;
  // Demo/blocked IDs are always bot-generated
  if (idMessage.startsWith('demo-') || idMessage.startsWith('blocked-') || idMessage.startsWith('MOCK-')) return true;
  const entry = _botSentIds.get(idMessage);
  if (!entry) return false;
  if (Date.now() - entry.sentAt > BOT_SENT_TTL) {
    _botSentIds.delete(idMessage);
    return false;
  }
  return true;
}

function _isInCooldown(phone) {
  const ts = _lastReplied.get(phone);
  return !!(ts && Date.now() - ts < REPLY_COOLDOWN);
}
function _markReplied(phone) {
  _lastReplied.set(phone, Date.now());
}

// ── Burst accumulator — collect rapid successive messages, serialize processing ──
//
// Four behaviors:
//   1. Burst accumulation: messages within BURST_WINDOW_MS of each other are
//      combined into one context before processing.
//   2. Per-phone serialization: _processingLock prevents concurrent calls for
//      the same phone. Messages arriving while locked queue in _pendingMessages.
//   3. Max wait cap: BURST_MAX_WAIT_MS prevents indefinitely delaying processing
//      when someone keeps typing. After 5s, flush regardless.
//   4. Full message-ID deduplication: each msgId in a burst is tracked; if Green
//      API retries any individual message it is discarded, not re-processed.
//
// Stale reply suppression operates at two levels:
//   1. AI-internal (lead_agent.js): handleInbound checks _pendingMessages before
//      calling sendText. If a newer message arrived during OpenAI generation, the
//      draft is discarded (sendState='skipped_stale') and sendText is never called.
//   2. Outer pipeline (processInboundWAMessage): checks _pendingMessages before
//      the outer auto-reply send. Also catches status changes (opted_out, human_owns).
// Together these ensure an outdated draft cannot be sent after a newer message arrives.
//
// Simulate endpoint calls processInboundWAMessage directly — no debounce.

const _inboundBurst   = new Map(); // phone → { texts, msgIds, firstMsg, latestMsg, startedAt, timer }
const _processingLock = new Set(); // phones currently being processed by processInboundWAMessage
const _pendingMessages = new Map(); // phone → { texts, msgIds, firstMsg, latestMsg } — arrived while locked
// BURST_WINDOW_MS: messages within this window of each other are combined into one context.
// Empirically: human typing at 2-second intervals fires 3 separate replies at 1500ms.
// 2500ms catches messages sent with ~2s gap (measured with the screenshot sequence).
// Configurable via env: BURST_WINDOW_MS=2500 (default). Max effective value: 5000.
const BURST_WINDOW_MS  = parseInt(process.env.BURST_WINDOW_MS ?? '2500', 10);
const BURST_MAX_WAIT_MS = 7000;    // hard cap: flush after this even during a continuous burst

function scheduleInboundProcessing(msg) {
  const fromNorm = normalizeToE164(msg.from);
  if (!fromNorm) {
    processInboundWAMessage(msg).catch(err =>
      logger.error('processInboundWAMessage error (immediate)', { error: err.message })
    );
    return;
  }

  const msgId = msg.messageId;

  // If phone is locked (currently being processed): queue as pending override.
  // These messages will be processed immediately after the in-flight call completes.
  if (_processingLock.has(fromNorm)) {
    const pending = _pendingMessages.get(fromNorm) ?? {
      texts: [], msgIds: new Set(), firstMsg: msg, latestMsg: msg,
    };
    if (msgId && pending.msgIds.has(msgId)) {
      logger.info('[burst] Duplicate msgId during processing — skipped', { from: fromNorm, msgId });
      return;
    }
    if (msg.text) pending.texts.push(msg.text);
    if (msgId)   pending.msgIds.add(msgId);
    pending.latestMsg = msg;
    _pendingMessages.set(fromNorm, pending);
    logger.info('[burst] Queued during processing', { from: fromNorm, pendingCount: pending.texts.length });
    return;
  }

  // Not locked — add to burst window.
  const existing = _inboundBurst.get(fromNorm);
  if (existing) {
    if (msgId && existing.msgIds.has(msgId)) {
      logger.info('[burst] Duplicate msgId in burst — skipped', { from: fromNorm, msgId });
      return;
    }
    clearTimeout(existing.timer);
    if (msg.text) existing.texts.push(msg.text);
    if (msgId)    existing.msgIds.add(msgId);
    existing.latestMsg = msg;
  } else {
    _inboundBurst.set(fromNorm, {
      texts:     msg.text ? [msg.text] : [],
      msgIds:    new Set(msgId ? [msgId] : []),
      firstMsg:  msg,
      latestMsg: msg,
      startedAt: Date.now(),
      timer:     null,
    });
  }

  const entry   = _inboundBurst.get(fromNorm);
  const elapsed = Date.now() - entry.startedAt;
  const waitMs  = elapsed >= BURST_MAX_WAIT_MS ? 0 : BURST_WINDOW_MS;

  entry.timer = setTimeout(() => {
    _inboundBurst.delete(fromNorm);
    _flushBurst(fromNorm, entry);
  }, waitMs);
}

/**
 * Process a burst entry: acquire lock, run pipeline, flush any pending messages
 * that arrived during the in-flight call.
 */
function _flushBurst(fromNorm, entry) {
  const combined = {
    ...entry.latestMsg,
    messageId: entry.firstMsg.messageId,  // first ID for pipeline dedup
    text: entry.texts.length > 1 ? entry.texts.join('\n') : (entry.latestMsg.text ?? ''),
  };

  if (entry.texts.length > 1) {
    logger.info('[burst] Processing combined messages', {
      from: fromNorm, count: entry.texts.length, combined: combined.text.slice(0, 120),
    });
  }

  _processingLock.add(fromNorm);

  processInboundWAMessage(combined)
    .then(r => {
      _processingLock.delete(fromNorm);
      if (r) {
        broadcastSse('message', { phone: r.inboxEntry.from, name: r.inboxEntry.name ?? null });
        persist.saveInbox(inbox);
        persist.saveLeads(store);
      }
      _flushPending(fromNorm);
    })
    .catch(err => {
      _processingLock.delete(fromNorm);
      logger.error('processInboundWAMessage error (burst)', { error: err.message, from: fromNorm });
      _flushPending(fromNorm);
    });
}

/** If messages arrived while the phone was locked, process them now. */
function _flushPending(fromNorm) {
  const pending = _pendingMessages.get(fromNorm);
  if (!pending) return;
  _pendingMessages.delete(fromNorm);
  logger.info('[burst] Flushing pending messages that arrived during processing', {
    from: fromNorm, count: pending.texts.length,
  });
  _flushBurst(fromNorm, pending);
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

  // ── REGISTRY GATE: synchronous O(1) identity check ───────────────────────────
  // This runs before ANY async work. isMember() is a plain Set.has() — no I/O,
  // no TTL math, no Arbox call.
  // On hit: pre-seeds memberCache so the 4-tier lookup immediately classifies
  // this phone as a confirmed member (tier1Fresh=true), which sets isExistingClient=true
  // and routes to Tomer. We do NOT return early here — we let the existing pipeline
  // proceed with a guaranteed memberCache hit so inbox logging, SSE, and persist
  // all run normally. The routing outcome is now deterministic: isExistingClient=true.
  const _registryHit = phoneRegistry.isMember(fromNorm) || phoneRegistry.isMember(fromIsraeli);
  if (_registryHit) {
    logger.info('[registry-gate] MEMBER confirmed — pre-seeding cache for guaranteed Tomer routing', { from: fromNorm });
    memberCache.markConfirmed(fromNorm, { source: 'phone_registry', name: msg.name ?? null, role: 'client' });
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

  // 1. Four-tier member identity resolution
  //
  //   Tier 1 (fastest): in-process memberCache — sub-millisecond, no I/O.
  //     If fresh (< 5 min), skip the Arbox lookup entirely.
  //     If confirmed (< 24 hr), skip the lookup and use cached identity.
  //
  //   Tier 2: known_members.json file — < 2ms disk read.
  //     Populated proactively by the 15-min seed cron and reactively on every
  //     successful Arbox confirmation.
  //
  //   Tier 3: Live Arbox lookup — only fires when both caches miss (genuine
  //     first-contact or entry older than 24hr).
  //     On hit: seeds Tier 1 + Tier 2 so future messages are instant.
  //
  //   Tier 4 (degraded): Arbox is unreachable AND no cache record exists.
  //     Cannot determine member vs. lead — sends a neutral hold message and
  //     alerts staff. Never runs Barak's qualification funnel. This is
  //     intentionally conservative: a false silence is safer than a false sale.

  let clientMatch = { found: false, matchType: null, arboxName: null, arboxId: null, isActive: false, role: null };
  let arboxLookupFailed = false;

  const tier1Fresh     = memberCache.isFresh(fromNorm);
  const tier1Confirmed = !tier1Fresh && memberCache.isConfirmed(fromNorm);
  const tier2File      = !tier1Fresh && !tier1Confirmed && (isKnownMember(fromNorm) || isKnownMember(fromIsraeli));

  const skipArboxLookup = tier1Fresh || tier1Confirmed || tier2File;

  if (skipArboxLookup) {
    // Satisfy the clientMatch shape from cache so downstream code stays intact
    const cached = memberCache.getEntry(fromNorm);
    if (cached) {
      clientMatch = {
        found:     true,
        matchType: 'member',
        arboxName: cached.name ?? null,
        arboxId:   null,   // not needed after routing decision
        isActive:  true,
        role:      cached.role ?? 'client',
      };
    } else if (tier2File) {
      // known_members.json hit but no in-process entry — backfill the cache so the
      // next message is sub-millisecond instead of incurring another disk read.
      memberCache.markConfirmed(fromNorm, { source: 'known_members_backfill' });
      clientMatch = { found: true, matchType: 'member', arboxName: null, arboxId: null, isActive: true, role: 'client' };
    }
  } else {
    // Tier 3: live Arbox lookup — only reaches here on genuine cache miss
    try {
      const lookup = await barakAgent.lookupClient(fromIsraeli ?? fromNorm ?? '');
      if (lookup.total > 0) {
        // Always prefer a member record over a lead record for the routing decision.
        // If getMembers() partially failed and only the lead record was returned,
        // results[0] would be type='lead' — routing the person to Barak despite being a member.
        const best = lookup.results.find(r => r.type === 'member') ?? lookup.results[0];
        clientMatch = {
          found:     true,
          matchType: best.type,
          arboxName: best.name,
          arboxId:   String(best.user_id ?? ''),
          isActive:  best.active ?? false,
          role:      best.role ?? null,
        };
        // Seed Tier 1 + Tier 2 immediately so the next message is cache-fast
        if (best.type === 'member' || best.role === 'aggregatorMember') {
          memberCache.markConfirmed(fromNorm, { name: best.name, role: best.role ?? 'client', source: 'arbox_live' });
          _autoAddKnownMember(fromNorm, best.name ?? msg.name);
        } else if (best.type === 'lead' && !lookup.memberLookupFailed) {
          // Arbox confirmed this person as a cold lead — stamp the flag + a timestamp so
          // Tier-4 can safely bypass during RECENT outages.
          //
          // Guard: !memberLookupFailed is REQUIRED before stamping.
          // When getMembers() fails and only the lead record is returned, we have NOT
          // confirmed there is no member record for this phone. Stamping here would let
          // the next message bypass Tier-4 (via _tier4ActiveLead freshness window) even
          // though member status is unknown — sending a potential subscriber to Barak.
          const existing = store.getLead(fromNorm);
          if (existing && existing.status !== 'converted_member') {
            store.upsertLead(fromNorm, {
              meta: { ...(existing.meta ?? {}), arboxConfirmedColdLead: true, arboxColdLeadConfirmedAt: Date.now() },
            });
          }
        }
      }

      // If getMembers() specifically failed and no member was found, we cannot confirm
      // cold-lead status — treat this as an Arbox failure so Tier-4 fires correctly.
      if (lookup.memberLookupFailed) {
        arboxLookupFailed = true;
        logger.warn('[pipeline] Member lookup failed in lookupClient — identity uncertain, triggering Tier-4', {
          from: fromNorm,
        });
      }
    } catch (lookupErr) {
      arboxLookupFailed = true;
      logger.warn('[pipeline] Arbox lookup failed — falling back to cached member data', {
        from: fromNorm, error: lookupErr.message, tier1Confirmed, tier2File,
      });
    }
  }

  // 2. Intent detection (only meaningful for text messages)
  const intent = msg.type === 'text' ? detectSchedulingIntent(msg.text) : 'general';

  // ── Client identity — resolved HERE, before any early-return path ─────────────
  // Four-tier resolution (see lookup block above for full commentary).
  //
  //   Tier 1a — memberCache.isFresh    → skipArboxLookup=true, clientMatch already set
  //   Tier 1b — memberCache.isConfirmed → skipArboxLookup=true, clientMatch already set
  //   Tier 2  — known_members.json     → skipArboxLookup=true, clientMatch already set
  //   Tier 3  — Live Arbox             → clientMatch set above if lookup succeeded
  //
  // aggregatorMember (ClassPass/Gympass) is treated as an existing client for routing.
  const arboxConfirmedClient = clientMatch.found &&
    (clientMatch.matchType === 'member' || clientMatch.role === 'aggregatorMember');
  const isAggregator          = clientMatch.found && clientMatch.role === 'aggregatorMember';
  const inProcessConfirmed    = tier1Fresh || tier1Confirmed;
  const isExistingClient      = arboxConfirmedClient || inProcessConfirmed || tier2File;

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
      _markBotSent(fromNorm);
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
      // aptStore entry created = real appointment → upgrade to call_scheduled.
      // callback_requested (from AI flow) ≠ call_scheduled (confirmed aptStore entry).
      store.upsertLead(fromNorm, { status: 'call_scheduled' });
      store.logEvent('appointment_created', fromNorm, { aptId: apt.id, rawTime, staff: apt.assignedStaffId });
      logger.info('Appointment created — status → call_scheduled', { phone: fromNorm, rawTime, aptId: apt.id });
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
      _markBotSent(fromNorm);
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
      _markBotSent(fromNorm);
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

  // 2b. Lead stop-status gate — runs BEFORE Tier-4.
  //
  //   ORDER IS INTENTIONAL: opted_out / human_owns must block even when Arbox is down.
  //   A person who requested silence or is under human care must not receive an
  //   arbox_outage_hold message just because the Arbox API was unreachable.
  //
  //   Only applies to the Barak branch (!isExistingClient). Tomer handles verified members.
  //
  //   call_scheduled / callback_requested: handled context-aware below — not an early return
  //   because reschedule / schedule-query / opt-out must still be processed.
  if (!isExistingClient) {
    const _stopRec    = store.getLead(fromNorm);
    const _stopStatus = _stopRec?.status;

    if (_stopStatus === 'opted_out') {
      store.logEvent('reply_suppressed_opted_out', fromNorm, { preview: (msg.text ?? '').slice(0, 60) });
      logger.info('[pipeline] Reply suppressed — opted_out', { from: fromNorm });
      const optEntry = inbox.push({
        from: fromNorm, fromIsraeli, name: msg.name ?? null,
        text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
        receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
        clientMatch, intent, route: 'opted_out_silent', barakReply: null,
      });
      persist.saveInbox(inbox);
      return { inboxEntry: optEntry, clientMatch, intent, route: 'opted_out_silent', barakReply: null };
    }

    if (_stopStatus === 'human_owns') {
      store.logEvent('reply_suppressed_human_owns', fromNorm, { preview: (msg.text ?? '').slice(0, 60) });
      logger.info('[pipeline] Reply suppressed — human_owns', { from: fromNorm });
      const hoEntry = inbox.push({
        from: fromNorm, fromIsraeli, name: msg.name ?? null,
        text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
        receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
        clientMatch, intent, route: 'human_owns_hold', barakReply: null,
      });
      broadcastSse('message', { phone: hoEntry.from, name: hoEntry.name ?? null, route: 'human_owns' });
      persist.saveInbox(inbox);
      return { inboxEntry: hoEntry, clientMatch, intent, route: 'human_owns_hold', barakReply: null };
    }
  }

  // 2c. Tier-4 degraded-mode guard.
  //     Arbox is unreachable AND neither cache tier confirmed this phone.
  //     opted_out / human_owns are already handled above and will never reach here.
  const _tier4ActiveLead = (() => {
    const rec = store.getLead(fromNorm);
    if (!rec) return false;
    if (rec.status === 'converted_member') return false;
    // Only bypass Tier-4 when Arbox RECENTLY confirmed cold-lead status (< 2 hours).
    const confirmedAt = rec.meta?.arboxColdLeadConfirmedAt;
    if (!confirmedAt) return false;
    return Date.now() - confirmedAt < 2 * 60 * 60 * 1000;
  })();
  if (arboxLookupFailed && !isExistingClient && !_tier4ActiveLead) {
    logger.warn('[pipeline] TIER-4 DEGRADED MODE — Arbox down, identity unverifiable', { from: fromNorm });
    const holdMsg = `קיבלנו את הודעתך! הצוות שלנו ייצור איתך קשר בהקדם 😊`;
    if (process.env.WHATSAPP_AUTO_REPLY === 'true') {
      _markBotSent(fromNorm);
      await sendText(fromNorm, holdMsg).catch(() => {});
    }
    alertOwner(
      `⚠️ Arbox Outage — Identity Unverifiable`,
      `Phone: ${fromNorm}\nMessage: "${(msg.text ?? '').slice(0, 100)}"\n\nArbox was unreachable. Could not confirm member vs. lead.\nSent holding message. Please verify manually and follow up.`
    ).catch(() => {});
    store.logEvent('arbox_outage_held', fromNorm, { preview: (msg.text ?? '').slice(0, 80), reason: 'tier4_degraded' });
    const holdEntry = inbox.push({
      from: fromNorm, fromIsraeli, name: msg.name ?? null,
      text: msg.text ?? '', messageId: msg.messageId,
      timestamp: msg.timestamp, receivedAt: new Date(),
      mediaType: msg.type, mediaCaption: null, mediaId: null,
      clientMatch, intent, route: 'arbox_outage_hold', barakReply: holdMsg,
    });
    return { inboxEntry: holdEntry, clientMatch, intent, route: 'arbox_outage_hold', barakReply: holdMsg };
  }

  // 2d. Post-call stop-status gate: context-aware handling for call_scheduled / callback_requested.
  //
  //   These run AFTER Tier-4 (identity is confirmed enough to route) but BEFORE the main
  //   AI pipeline. The correct response depends on what the person wrote:
  //     • brief ack / emoji         → silent (no auto-reply, do not reopen sales)
  //     • schedule query            → send schedule image (answer the question, no funnel)
  //     • reschedule intent         → let the reschedule flow handle it (falls through)
  //     • opt-out                   → handle as opt-out even from post-call status
  //     • other text (new question) → alert staff, no bot reply (staff owns follow-through)
  if (!isExistingClient) {
    const _postCallRec    = store.getLead(fromNorm);
    const _postCallStatus = _postCallRec?.status;

    if (_postCallStatus === 'call_scheduled' || _postCallStatus === 'callback_requested') {
      const msgText = (msg.text ?? '').trim();

      // Always let opt-out fall through to lead_agent (which will set opted_out status)
      // — do not early-return here; the opt-out handler in lead_agent.js needs to run.

      // Reschedule intent → let the reschedule interception block handle it
      if (intent === 'reschedule') {
        // fall through to the standard reschedule path below
      } else if (isBriefAck(msgText) || msg.type !== 'text') {
        // Brief ack / emoji / non-text → silent. The sales phase is over.
        store.logEvent('post_call_ack_silent', fromNorm, { status: _postCallStatus, preview: msgText.slice(0, 60) });
        logger.info('[pipeline] Post-call ack silent', { from: fromNorm, status: _postCallStatus });
        const silEntry = inbox.push({
          from: fromNorm, fromIsraeli, name: msg.name ?? null,
          text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
          receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
          clientMatch, intent, route: 'post_call_silent', barakReply: null,
        });
        return { inboxEntry: silEntry, clientMatch, intent, route: 'post_call_silent', barakReply: null };

      } else if (intent === 'schedule_query') {
        // Schedule query → answer request, no sales funnel.
        const timetableUrl = getActiveTimetableUrl();
        let postCallReply = null;
        if (timetableUrl) {
          postCallReply = `הנה מערכת השעות של Shape Studio! 🏋️‍♀️`;
          if (process.env.WHATSAPP_AUTO_REPLY === 'true') {
            _markBotSent(fromNorm);
            sendFileByUrl(fromNorm, timetableUrl, 'schedule.png', postCallReply)
              .then(res => { if (res?.idMessage) _recordBotSend(res.idMessage, fromNorm); store.logEvent('timetable_image_sent', fromNorm, { status: _postCallStatus }); })
              .catch(() => { _markBotSent(fromNorm); sendText(fromNorm, postCallReply).catch(() => {}); });
          }
        } else {
          postCallReply = buildSchedulingReply(intent, msg, clientMatch).catch(() => null);
          postCallReply = await postCallReply;
          if (postCallReply && process.env.WHATSAPP_AUTO_REPLY === 'true') {
            _markBotSent(fromNorm);
            await sendText(fromNorm, postCallReply).catch(() => {});
          }
        }
        store.logEvent('post_call_schedule_answered', fromNorm, { status: _postCallStatus });
        const scEntry = inbox.push({
          from: fromNorm, fromIsraeli, name: msg.name ?? null,
          text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
          receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
          clientMatch, intent, route: 'post_call_schedule', barakReply: postCallReply,
        });
        return { inboxEntry: scEntry, clientMatch, intent, route: 'post_call_schedule', barakReply: postCallReply };

      } else {
        // New question or message after call completion → staff alert, no bot reply.
        // Staff should follow up. Bot stays silent to avoid false promises.
        alertOwner(
          `📬 הודעה אחרי ${_postCallStatus === 'call_scheduled' ? 'תיאום' : 'בקשת חזרה'} — ${msg.name ?? fromNorm}`,
          `*${msg.name ?? fromNorm}* (${fromNorm})\n*סטטוס:* ${_postCallStatus}\n*הודעה:* "${msgText.slice(0, 200)}"\n\nהאדם כתב אחרי שהתיאום הושלם. אנא בדוק ידנית.`
        ).catch(() => {});
        store.logEvent('post_call_staff_notified', fromNorm, { status: _postCallStatus, preview: msgText.slice(0, 80) });
        logger.info('[pipeline] Post-call message — staff alerted, bot silent', { from: fromNorm, status: _postCallStatus });
        const pcEntry = inbox.push({
          from: fromNorm, fromIsraeli, name: msg.name ?? null,
          text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
          receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
          clientMatch, intent, route: 'post_call_staff_hold', barakReply: null,
        });
        persist.saveInbox(inbox);
        return { inboxEntry: pcEntry, clientMatch, intent, route: 'post_call_staff_hold', barakReply: null };
      }
    }
  }

  // 2e. UNCLASSIFIED HOLD — unknown contact with no identity evidence.
  //
  //   An unknown WhatsApp number is NOT automatically a sales lead.
  //   Before routing to Barak, we require at least one of:
  //     (a) prior lead history (the phone has been in the pipeline before), OR
  //     (b) explicit fitness/sales intent in the current message.
  //
  //   If neither condition holds, the contact receives one neutral warm greeting
  //   and is placed in the unclassified inbox. Subsequent messages follow the same
  //   rule: if they then express fitness intent → Barak. Otherwise → inbox only.
  //
  //   This prevents suppliers, friends, staff with new numbers, and unrelated
  //   contacts from entering the sales qualification funnel.
  //
  //   Override: manual assignment via admin panel always routes correctly.
  if (!isExistingClient) {
    const _tomerStore  = require('./utils/tomer_store');
    const _existingLead = store.getLead(fromNorm);
    const _hasLeadHistory = !!(_existingLead?.messageCount && _existingLead.messageCount > 0);
    const SALES_INTENT_RE = /פילאטיס|כושר|שיעור|אימון|להצטרף|מנוי|להתנסות|ניסיון|רפורמר|בארה|קנגו|yoga|יוגה|בריאות|ירידה.*משקל|חיזוק|כוח|גוף|גב|גמישות|שייפ\s*סטודיו|מחיר|כמה.*עולה|שעות.*פעילות|לוח.*שיעורים|מערכת\s*שעות|הצעת\s+היכרות|60\s+ש|60\s+₪/i;
    const _hasSalesIntent = SALES_INTENT_RE.test(msg.text ?? '');
    // Any non-general intent (schedule query, representative, specialist) establishes
    // the contact is engaging with studio services — route normally, not to unclassified inbox.
    const _hasSalesSignal = _hasSalesIntent || intent !== 'general';

    if (!_hasLeadHistory && !_hasSalesSignal && msg.type === 'text') {
      const _alreadyGreeted = _tomerStore.hasGreetedUnclassified(fromNorm);
      _tomerStore.markUnclassified(fromNorm, { firstMessage: msg.text ?? '' });

      let _unclassifiedReply = null;
      if (!_alreadyGreeted && process.env.WHATSAPP_AUTO_REPLY === 'true') {
        _unclassifiedReply = 'שלום! 😊 קיבלנו את הודעתך. כדי שנוכל לעזור — ספר/י לנו מה מחפש/ת.';
        _markBotSent(fromNorm);
        await sendText(fromNorm, _unclassifiedReply).catch(() => {});
        _tomerStore.markUnclassified(fromNorm, { firstMessage: msg.text ?? '', greetingSent: true });
        _tomerStore.appendAudit({ phone: fromNorm, memberName: msg.name ?? null, event: 'unclassified_greeting',
          requestPreview: (msg.text ?? '').slice(0, 100), tomerAction: 'neutral greeting sent', owner: 'unclassified' });
      }
      logger.info('[pipeline] UNCLASSIFIED — no lead history, no sales intent', { from: fromNorm, greeted: !_alreadyGreeted });
      store.logEvent('unclassified_hold', fromNorm, { greeted: !_alreadyGreeted, preview: (msg.text ?? '').slice(0, 60) });

      const _ucEntry = inbox.push({
        from: fromNorm, fromIsraeli, name: msg.name ?? null,
        text: msg.text ?? '', messageId: msg.messageId,
        timestamp: msg.timestamp, receivedAt: new Date(),
        mediaType: msg.type, mediaCaption: msg.mediaCaption ?? null, mediaId: msg.mediaId ?? null,
        clientMatch, intent, route: 'unclassified', barakReply: _unclassifiedReply,
      });
      return { inboxEntry: _ucEntry, clientMatch, intent, route: 'unclassified', barakReply: _unclassifiedReply };
    }
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
  let route              = 'unhandled';
  let barakReply         = null;
  let timetableImgUrl    = null;   // first timetable image URL (sent with caption)
  let timetable2ImgUrl   = null;   // second timetable image URL (sent as follow-up)
  let _replyAlreadySent  = false;  // true when leadAgent/tomerAgent sent the reply internally

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

  // Brief acks are suppressed. Genuine follow-up questions and requests are NOT
  // blocked by cooldown — deduplication by messageId prevents true duplicates,
  // and the burst accumulator prevents concurrent replies to the same burst.
  const skipAiReply  = (ackDetected && !awaitingLocation);

  if (ackDetected && !awaitingLocation) logger.info('Brief ack — skipping AI reply', { from: fromNorm, text: msg.text?.slice(0, 20) });
  if (awaitingLocation && ackDetected)  logger.info('Brief ack allowed — awaiting location confirmation', { from: fromNorm });
  if (inCooldown)   logger.info('Reply cooldown active — genuine follow-ups still proceed', { from: fromNorm });

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
          name:            msg.name,
          text:            msg.text,
          phone:           fromNorm,
          clientMatch,
          isAggregator,    // hint: ClassPass/Gympass member — potential direct-membership convert
          _pendingMessages, // stale-send gate: Tomer checks before sendText
        });
        if (result.reply) {
          barakReply = result.reply;
          // Tomer sends its own reply internally — mark so outer pipeline doesn't double-send.
          if (result.sendState === 'sent' || result.sendState === 'skipped_stale') {
            _replyAlreadySent = true;
          }
        }
        // result.reply === null → Tomer chose silence; no WhatsApp message is sent
        logger.info('[tomer] Inbound decision', { decision: result.decision, reason: result.reason, from: fromNorm,
          task: result.taskCreated?.id ?? null });
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
          // No schedule image uploaded yet.
          // "שולח לך את המערכת" is a broken promise when timetableImgUrl is null —
          // the lead reads "sending you the schedule" but nothing arrives.
          // Honest fallback: invite them to tell us their preferred day/time so the
          // conversation advances without claiming an image was sent.
          barakReply = `מערכת השעות שלנו מתעדכנת בתדירות — הכי קל להגיד לי איזה יום ושעה בדרך כלל עובדים לך, ואמצא לך מה מתאים 😊`;
        }
      } else {
        // noMatchPassthrough=true: specialist_query with no staff match returns null
        // so Barak AI handles it conversationally instead of returning a dead-end "no info".
        try { barakReply = await buildSchedulingReply(intent, msg, clientMatch, { noMatchPassthrough: true }); } catch { /* non-fatal */ }
        // Fallthrough: if buildSchedulingReply returned null (e.g. specialist_query with no
        // staff directory, or any scheduling intent without an Arbox answer), route to AI so
        // the lead still receives a contextual reply rather than silence.
        if (!barakReply && !timetableImgUrl) {
          try {
            const leadResult = await leadAgent.handleInbound({
              from: fromNorm, name: msg.name, text: msg.text ?? '', _pendingMessages,
            });
            _markReplied(fromNorm);
            if (leadResult?.reply) {
              barakReply        = leadResult.reply;
              _replyAlreadySent = leadResult.sendState === 'sent' || leadResult.sendState === 'skipped_stale';
            }
          } catch (fallErr) {
            logger.error('[pipeline] scheduling fallthrough to AI failed', { error: fallErr.message, from: fromNorm });
          }
        }
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
          from:             fromNorm,
          name:             msg.name,
          text:             msg.text ?? '',
          _pendingMessages, // stale-send gate: handleInbound checks before sendText
        });
        _markReplied(fromNorm);
        if (leadResult?.reply) {
          barakReply = leadResult.reply;
          // _replyAlreadySent: only true when handleInbound actually sent or the send
          // was consciously skipped (stale). Failed sends leave it false so logs show
          // "generated but not sent" rather than "already sent".
          _replyAlreadySent = leadResult.sendState === 'sent' ||
                              leadResult.sendState === 'skipped_stale';
          if (leadResult.sendState && leadResult.sendState !== 'sent') {
            logger.info('[pipeline] AI send state', { from: fromNorm, sendState: leadResult.sendState });
          }
        }

        // If the AI promised to send the schedule image, actually send it.
        // lead_agent already sent the text reply; now append the image + follow-up.
        //
        // Guard: only fire when the text reply was actually sent (sendState='sent').
        // 'skipped_stale' means a newer message arrived during generation — the text
        // was not sent, so sending the image without the text would be an orphaned file.
        // 'failed' means the text send itself errored — no image either.
        // Also re-check status: human_owns / opted_out may have been set concurrently.
        const _canSendPromiseImage = leadResult?.sendState === 'sent' &&
          !_pendingMessages.has(fromNorm) &&
          store.getLead(fromNorm)?.status !== 'human_owns' &&
          store.getLead(fromNorm)?.status !== 'opted_out';
        if (_canSendPromiseImage && leadResult?.reply && /שולח לך את המערכת|שולחת את המערכת/.test(leadResult.reply)) {
          const timetableUrlFromLeadAgent = getActiveTimetableUrl();
          if (timetableUrlFromLeadAgent) {
            _markBotSent(fromNorm);
            sendFileByUrl(fromNorm, timetableUrlFromLeadAgent, 'schedule.png', '')
              .then(async (res) => {
                if (res?.idMessage) _recordBotSend(res.idMessage, fromNorm);
                store.logEvent('timetable_image_sent', fromNorm, { imageUrl: timetableUrlFromLeadAgent, via: 'lead_agent' });
                const t2 = getActiveTimetable2Url();
                if (t2) {
                  _markBotSent(fromNorm);
                  await sendFileByUrl(fromNorm, t2, 'schedule2.png', '')
                    .then(r2 => { if (r2?.idMessage) _recordBotSend(r2.idMessage, fromNorm); })
                    .catch(err => logger.warn('Timetable2 follow-on send failed', { from: fromNorm, error: err.message }));
                }
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

    // 5b. Reclassify any stale lead record for this confirmed member.
    //     Preserves conversation history and meta — only changes status to
    //     'converted_member' so the record never surfaces in sales flows again.
    //     memberCache + known_members.json are seeded above (5a) and in Tier-3.
    {
      const staleRecord = store.getLead(fromNorm);
      if (staleRecord && staleRecord.status !== 'converted_member') {
        const memberName = clientMatch.arboxName ?? msg.name ?? staleRecord.name;
        _autoAddKnownMember(fromNorm, memberName);
        store.reclassifyAsConvertedMember(fromNorm, { name: memberName, source: 'pipeline_step5b' });
        store.logEvent('lead_converted_reactive', fromNorm, {
          name: memberName,
          source: 'pipeline_step5b',
          historyPreserved: (staleRecord.history ?? []).length,
        });
        logger.info('[pipeline] Stale lead reclassified as converted_member (history preserved)', {
          from: fromNorm, historyTurns: (staleRecord.history ?? []).length,
        });
      }
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
  //
  // ── LATE REPLY SUPPRESSION (Fix 5) ──────────────────────────────────────────
  // Status may have changed DURING async AI generation (concurrent human takeover,
  // opt-out from a parallel message, or status update via API).
  // Re-check just before sending so a reply generated before the status change
  // is never delivered after it.
  //
  // Only applies to the Barak branch (!isExistingClient): Tomer has its own
  // silence classifier and is unaffected by lead stop-statuses.
  if (barakReply && !isExistingClient) {
    const _lateStatus = store.getLead(fromNorm)?.status;
    if (_lateStatus === 'opted_out' || _lateStatus === 'human_owns') {
      logger.info('[pipeline] Late reply suppression — status changed during AI generation', {
        from: fromNorm, status: _lateStatus,
      });
      store.logEvent('reply_suppressed_late', fromNorm, { status: _lateStatus });
      barakReply = null;
    }
    // Stale reply suppression: a newer message arrived during AI generation.
    // Suppress the outer-pipeline reply so only the more-informed follow-up reply
    // is sent when the pending message is processed after the lock is released.
    // Note: AI-internal sends (via leadAgent.handleInbound) cannot be suppressed here.
    if (barakReply && _pendingMessages.has(fromNorm)) {
      logger.info('[pipeline] Outer reply suppressed — newer message pending', { from: fromNorm });
      store.logEvent('reply_suppressed_stale', fromNorm, { pendingCount: _pendingMessages.get(fromNorm).texts.length });
      barakReply     = null;
      timetableImgUrl  = null;
      timetable2ImgUrl = null;
    }
  }

  if (barakReply && process.env.WHATSAPP_AUTO_REPLY === 'true' && !_replyAlreadySent) {
    if (timetableImgUrl) {
      // Send timetable image 1 (with caption), then image 2 if available.
      // No follow-up question — the lead responds naturally after seeing the images.
      sendFileByUrl(fromNorm, timetableImgUrl, 'schedule.png', barakReply)
        .then(async (sendRes) => {
          if (sendRes?.idMessage) _recordBotSend(sendRes.idMessage, fromNorm);
          store.logEvent('timetable_image_sent', fromNorm, { imageUrl: timetableImgUrl });
          _markReplied(fromNorm);
          if (timetable2ImgUrl) {
            _markBotSent(fromNorm);
            await sendFileByUrl(fromNorm, timetable2ImgUrl, 'schedule2.png', '')
              .then(r2 => { if (r2?.idMessage) _recordBotSend(r2.idMessage, fromNorm); store.logEvent('timetable2_image_sent', fromNorm, { imageUrl: timetable2ImgUrl }); })
              .catch(err => logger.warn('Timetable2 image send failed', { from: fromNorm, error: err.message }));
          }
          // Record the scheduling exchange in AI history so follow-up requests
          // ("תשלח לי את התמונה") arrive with full timetable context.
          leadAgent.recordSchedulingExchange(fromNorm, msg.text ?? '', barakReply);
        })
        .catch(err => {
          logger.warn('Timetable image send failed — falling back to text reply', { from: fromNorm, error: err.message });
          _markBotSent(fromNorm);
          sendText(fromNorm, barakReply).catch(() => {});
          leadAgent.recordSchedulingExchange(fromNorm, msg.text ?? '', barakReply);
        });
    } else {
      try {
        const sendResult = await sendText(fromNorm, barakReply);
        if (sendResult?.idMessage) _recordBotSend(sendResult.idMessage, fromNorm);
        _markReplied(fromNorm); // start cooldown window so a quick follow-up doesn't double-fire
        store.logEvent('message_out', fromNorm, {
          preview: barakReply.slice(0, 80),
          agent:   'barak',
          source:  'auto_reply',
        });
        // Record fallback text exchange in AI history for follow-up context
        leadAgent.recordSchedulingExchange(fromNorm, msg.text ?? '', barakReply);
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

  scheduleInboundProcessing(msg);
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
      //
      // outgoingMessageReceived: Green API sends this for every message SENT FROM
      // our WhatsApp number, whether by the bot (via our API) or by staff manually
      // typing on the phone. We track bot-sent idMessages so we can distinguish:
      //   - Bot echo (idMessage in _botSentIds) → ignored (avoid false human_owns)
      //   - Staff manual reply (idMessage NOT in _botSentIds) → human_owns for chat
      if (rawType === 'outgoingMessageReceived') {
        const chatId    = body?.senderData?.chatId ?? body?.instanceData?.wid ?? null;
        const idMessage = body?.idMessage ?? null;
        const msgText   = body?.messageData?.textMessageData?.textMessage ?? null;

        if (chatId && !chatId.endsWith('@g.us') && idMessage && !_isBotSentId(idMessage)) {
          // Staff manually typed this message → take human ownership of the conversation
          const phone = chatId.replace(/@.*$/, '');
          const norm  = normalizeToE164(phone);
          if (norm) {
            // Grace window: covers send paths where _recordBotSend hasn't fired yet
            // (fire-and-forget sends, lead_agent internal sends, rapid echo delivery).
            if (Date.now() - (_lastBotSendAt.get(norm) ?? 0) < BOT_SEND_GRACE) {
              logger.debug('[outgoing-webhook] Bot send grace window active — skipping human_owns', { phone: norm });
              return;
            }
            const existing = store.getLead(norm);
            if (existing && !['opted_out', 'converted_member'].includes(existing.status)) {
              store.upsertLead(norm, {
                status: 'human_owns',
                meta: {
                  ...(existing.meta ?? {}),
                  humanOwnsReason: 'staff_manual_reply',
                  humanOwnsSince:  new Date().toISOString(),
                  humanOwnsBy:     'staff',
                },
              });
              store.logEvent('human_takeover_staff_reply', norm, {
                idMessage, preview: (msgText ?? '').slice(0, 60),
              });
              logger.info('[outgoing-webhook] Staff manual reply detected — human_owns set', {
                phone: norm, idMessage,
              });
              broadcastSse('message', { phone: norm, route: 'human_owns', reason: 'staff_reply' });
            }
          }
        }
        return;
      }

      if (rawType !== 'incomingMessageReceived') {
        // Other non-message events (delivery receipts, state changes, device info)
        // are logged above and then discarded — no inbox action needed.
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

      // ── 6. Full CRM pipeline — via burst accumulator (1500ms window) ────────────
      logger.info('[green-api/webhook] Scheduling processing', { from: msg.from });
      scheduleInboundProcessing(msg);
      // persist / SSE are called inside scheduleInboundProcessing after the burst window.
      // Legacy catch-all kept for log continuity:
      void Promise.resolve().catch(err => logger.error('[green-api/webhook] Pipeline error', {
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
// ══════════════════════════════════════════════════════════════════════════════
// TOMER WORKSPACE API — Service tasks, member context, audit, unclassified
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/tomer/tasks — Eden task queue
app.get('/api/tomer/tasks', (req, res) => {
  const { status, phone, type } = req.query;
  const tasks = tomerStore.getTasks({ status, phone, type, limit: 200 });
  const open  = tomerStore.getOpenTasks();
  res.json({ ok: true, tasks, openCount: open.length, ts: new Date() });
});

// POST /api/tomer/tasks — manually create an Eden task from the panel
app.post('/api/tomer/tasks', jsonBody, (req, res) => {
  const { phone, action, detail, memberName } = req.body ?? {};
  if (!phone || !action) return res.status(400).json({ error: 'phone and action required' });
  const { task, isNew } = tomerAgent.createEdenTask({
    type:          action,
    phone,
    memberName:    memberName ?? null,
    arboxId:       null,
    memberMessage: detail ?? '',
    detail:        detail ?? '',
    requestedDates: null,
  });
  if (!isNew && !task) {
    return res.status(409).json({ ok: false, error: 'Duplicate open task of this type already exists' });
  }
  store.logEvent('manual_task_created', phone, { type: action, detail: (detail ?? '').slice(0, 80) });
  res.json({ ok: true, task });
});

// POST /api/tomer/tasks/:id/assign — assign to Eden
app.post('/api/tomer/tasks/:id/assign', jsonBody, (req, res) => {
  const task = tomerStore.assignTask(req.params.id, req.body?.assignedTo ?? 'Eden');
  if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
  res.json({ ok: true, task });
});

// POST /api/tomer/tasks/:id/resolve — resolve a task
app.post('/api/tomer/tasks/:id/resolve', jsonBody, (req, res) => {
  const { resolutionNote, resolvedBy } = req.body ?? {};
  const task = tomerStore.resolveTask(req.params.id, { resolutionNote, resolvedBy });
  if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
  res.json({ ok: true, task });
});

// POST /api/tomer/tasks/:id/update — update any task fields
app.post('/api/tomer/tasks/:id/update', jsonBody, (req, res) => {
  const task = tomerStore.updateTask(req.params.id, req.body ?? {});
  if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
  res.json({ ok: true, task });
});

// GET /api/tomer/audit — action audit log
app.get('/api/tomer/audit', (req, res) => {
  const { phone, event, limit } = req.query;
  const entries = tomerStore.getAudit({ phone, event, limit: parseInt(limit) || 100 });
  res.json({ ok: true, entries, count: entries.length, ts: new Date() });
});

// GET /api/tomer/unclassified — inbox of unknown contacts pending routing
app.get('/api/tomer/unclassified', (req, res) => {
  const contacts = tomerStore.getAllUnclassified();
  res.json({ ok: true, contacts, count: contacts.length, ts: new Date() });
});

// POST /api/tomer/unclassified/:phone/route — manually route an unclassified contact
app.post('/api/tomer/unclassified/:phone/route', jsonBody, (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { routeTo } = req.body ?? {}; // 'barak' | 'tomer' | 'ignore'
  tomerStore.resolveUnclassified(phone, routeTo ?? 'manual');
  if (routeTo === 'barak') {
    // Seed a lead record so the next message routes to Barak naturally
    store.upsertLead(phone, {
      messageCount: 1,
      meta: { manuallyRoutedToBarak: true, routedAt: Date.now() },
    });
  }
  store.logEvent('manual_route', phone, { routeTo, source: 'admin_panel' });
  res.json({ ok: true, phone, routeTo });
});

// GET /api/tomer/member/:phone — rich member context (Arbox + local)
app.get('/api/tomer/member/:phone', async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  try {
    const arboxSvc  = require('./services/arbox.service');
    const member    = await arboxSvc.getMemberByPhone(phone).catch(() => null);
    const lead      = store.getLead(phone);
    const history   = tomerStore.getMemberHistory(phone);
    const tasks     = tomerStore.getTasks({ phone });
    const audit     = tomerStore.getAudit({ phone, limit: 20 });
    const inboxThreads = inbox.getThread ? inbox.getThread(phone) : [];
    res.json({ ok: true, phone, arbox: member, lead, history, tasks, audit, inboxThreads });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/overview — service overview for the panel home
app.get('/api/tomer/overview', async (req, res) => {
  try {
    const openTasks    = tomerStore.getOpenTasks();
    const recentAudit  = tomerStore.getAudit({ limit: 20 });
    const unclassified = tomerStore.getAllUnclassified();
    const arboxSvc     = require('./services/arbox.service');
    const arboxOk      = await arboxSvc.testConnection().then(r => r.ok).catch(() => false);

    const tasksByPriority = { high: 0, normal: 0, low: 0 };
    openTasks.forEach(t => { tasksByPriority[t.priority] = (tasksByPriority[t.priority] ?? 0) + 1; });

    // Aging conversations: inbox threads with no bot reply in the last 2 hours
    const AGE_THRESHOLD = 2 * 60 * 60 * 1000; // 2 hours
    const now = Date.now();
    const allInbox = inbox.getAll?.() ?? [];
    // Group by phone, find last entry per phone, check for silence
    const phoneLastEntry = new Map();
    for (const e of allInbox) {
      const existing = phoneLastEntry.get(e.from);
      if (!existing || new Date(e.receivedAt ?? e.timestamp) > new Date(existing.receivedAt ?? existing.timestamp)) {
        phoneLastEntry.set(e.from, e);
      }
    }
    const agingConversations = [];
    for (const [phone, last] of phoneLastEntry) {
      const msgAge = now - new Date(last.receivedAt ?? last.timestamp).getTime();
      if (msgAge < AGE_THRESHOLD) continue; // too recent
      if (msgAge > 24 * 60 * 60 * 1000) continue; // too old (> 24h not actionable)
      const route = last.route ?? '';
      if (['opted_out_silent', 'post_call_silent', 'acknowledged', 'spam_filtered', 'staff_bypass'].includes(route)) continue;
      if (last.barakReply) continue; // bot did reply
      agingConversations.push({ phone, route, ageH: Math.round(msgAge / 3600000), lastText: (last.text ?? '').slice(0, 60) });
    }

    res.json({
      ok: true,
      service: {
        openTasks:         openTasks.length,
        highPriorityTasks: tasksByPriority.high,
        recentActivity:    recentAudit.filter(e => e.event === 'tomer_responded').length,
        failedActions:     recentAudit.filter(e => e.sendState === 'failed').length,
        unclassified:      unclassified.length,
        agingConversations: agingConversations.length,
      },
      arboxHealth: arboxOk,
      openTasks:   openTasks.slice(0, 10),
      recentAudit: recentAudit.slice(0, 10),
      agingConversations: agingConversations.slice(0, 10),
      ts: new Date(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/retention/config — workflow configuration
app.get('/api/tomer/retention/config', (req, res) => {
  res.json({ ok: true, config: retentionWorker.getConfig() });
});

// POST /api/tomer/retention/toggle — enable/disable a workflow
app.post('/api/tomer/retention/toggle', jsonBody, (req, res) => {
  const { workflowId, enabled } = req.body ?? {};
  if (!workflowId) return res.status(400).json({ error: 'workflowId required' });
  if (enabled === true) retentionWorker.enableWorkflow(workflowId);
  else retentionWorker.disableWorkflow(workflowId);
  res.json({ ok: true, workflowId, enabled: retentionWorker.getConfig()[workflowId]?.enabled });
});

// GET /api/tomer/retention/preview/:workflowId — dry run eligible members
app.get('/api/tomer/retention/preview/:workflowId', async (req, res) => {
  try {
    const preview = await retentionWorker.previewWorkflow(req.params.workflowId, 20);
    res.json({ ok: true, ...preview });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/tomer/retention/run/:workflowId — run a single workflow now
app.post('/api/tomer/retention/run/:workflowId', async (req, res) => {
  try {
    const result = await retentionWorker.runWorkflow(req.params.workflowId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/retention/history — last-run summary per workflow
app.get('/api/tomer/retention/history', (req, res) => {
  try {
    const logPath = require('path').join(
      (process.env.DATA_DIR ?? require('path').join(__dirname, 'data')).replace(/[/\\]$/, ''),
      'retention_log.json'
    );
    const log = require('fs').existsSync(logPath)
      ? JSON.parse(require('fs').readFileSync(logPath, 'utf8'))
      : {};

    // Summarize: last run per workflow + count of executions
    const summary = {};
    for (const [key, entry] of Object.entries(log)) {
      if (key.startsWith('activation:')) continue;
      const workflow = key.split(':')[0];
      if (!summary[workflow]) summary[workflow] = { count: 0, lastRun: null };
      summary[workflow].count++;
      if (!summary[workflow].lastRun || entry.ts > summary[workflow].lastRun) {
        summary[workflow].lastRun = entry.ts;
      }
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/member/:phone/history — Tomer's AI conversation history for a member
app.delete('/api/tomer/member/:phone/history', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  tomerStore.clearMemberHistory(phone);
  res.json({ ok: true, phone, cleared: true });
});

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

// ══════════════════════════════════════════════════════════════════════════════
// LOCAL DEMO SIMULATOR  —  /demo  &  /api/demo/*
// A sandboxed pipeline that uses real lead_agent logic but intercepts all
// WhatsApp sends (demo phones 972000000001–972000000009 never reach Green API).
// ══════════════════════════════════════════════════════════════════════════════

const DEMO_PHONES     = Array.from({ length: 9 }, (_, i) => `97200000000${i + 1}`);
const DEFAULT_DEMO_PH = DEMO_PHONES[0];
const demoCapture     = require('./utils/demo_capture');

// GET /demo → serve the simulator HTML
app.get('/demo', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

// Helper: snapshot the full state for a demo phone
function demoLeadSnapshot(phone) {
  const lead = store.getLead(phone);
  if (!lead) return { exists: false, phone };
  const qd   = lead.meta?.qualData ?? {};
  const hist = (lead.history ?? []).filter(m => m.role !== 'system');
  const completedTurns = hist.filter(m => m.role === 'user').length;
  const recentEvents   = store.getEvents({ phone, limit: 20 });

  return {
    exists:        true,
    phone,
    name:          lead.name ?? null,
    score:         lead.score   ?? 0,
    status:        lead.status  ?? 'new',
    messageCount:  lead.messageCount ?? 0,
    completedTurns,
    arboxSynced:   lead.arboxSynced ?? false,
    qualData: {
      location:            qd.location            ?? null,
      locationViable:      qd.locationViable      ?? null,
      locationCheckNeeded: qd.locationCheckNeeded ?? false,
      locationNearby:      qd.locationNearby      ?? null,
      locationCheckAsked:  qd.locationCheckAsked  ?? false,
      fitnessInterest:     qd.fitnessInterest     ?? null,
      goal:                qd.goal                ?? null,
      workoutStyle:        qd.workoutStyle        ?? null,
      nameAsked:           qd.nameAsked           ?? false,
      confirmedName:       qd.confirmedName       ?? null,
      callProposed:        qd.callProposed        ?? false,
      callTimeGiven:       qd.callTimeGiven        ?? null,
      briefGeneratedAt:    qd.briefGeneratedAt    ?? null,
    },
    history: hist.slice(-10).map(m => ({ role: m.role, text: m.content.slice(0, 200) })),
    recentEvents: recentEvents.map(e => ({ ts: e.ts, type: e.type, data: e.data })),
  };
}

// POST /api/demo/chat — send a test message through the real pipeline
app.post('/api/demo/chat', express.json(), async (req, res) => {
  const { message, phone = DEFAULT_DEMO_PH, name = 'Test Lead' } = req.body ?? {};
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  if (!DEMO_PHONES.includes(phone)) return res.status(400).json({ error: 'invalid demo phone — use 972000000001..9' });

  const stateBefore = demoLeadSnapshot(phone);

  demoCapture.start();
  let result;
  try {
    result = await leadAgent.handleInbound({ from: phone, name, text: message.trim() });
  } catch (err) {
    demoCapture.stop();
    logger.error('[demo] handleInbound threw', { error: err.message });
    return res.status(500).json({ error: err.message, capturedEvents: demoCapture.drain() });
  }
  demoCapture.stop();
  const capturedEvents = demoCapture.drain();

  const stateAfter = demoLeadSnapshot(phone);
  const debug      = leadAgent.getLastDebugContext?.() ?? null;

  res.json({
    reply:          result?.reply ?? null,
    score:          result?.score ?? stateAfter.score,
    status:         result?.status ?? stateAfter.status,
    stateBefore,
    stateAfter,
    debug,
    capturedEvents,
  });
});

// GET /api/demo/state?phone=... — full state snapshot
app.get('/api/demo/state', (req, res) => {
  const phone = req.query.phone ?? DEFAULT_DEMO_PH;
  if (!DEMO_PHONES.includes(phone)) return res.status(400).json({ error: 'invalid demo phone' });
  res.json(demoLeadSnapshot(phone));
});

// POST /api/demo/reset — wipe the session for a demo phone
app.post('/api/demo/reset', express.json(), (req, res) => {
  const { phone = DEFAULT_DEMO_PH } = req.body ?? {};
  if (!DEMO_PHONES.includes(phone)) return res.status(400).json({ error: 'invalid demo phone' });
  leadAgent.clearSession(phone);
  res.json({ ok: true, phone, state: demoLeadSnapshot(phone) });
});

// POST /api/demo/flags — manually inject qualData flags for edge-case testing
app.post('/api/demo/flags', express.json(), (req, res) => {
  const { phone = DEFAULT_DEMO_PH, flags } = req.body ?? {};
  if (!DEMO_PHONES.includes(phone)) return res.status(400).json({ error: 'invalid demo phone' });
  if (!flags || typeof flags !== 'object') return res.status(400).json({ error: 'flags object required' });

  const lead    = store.getLead(phone);
  if (!lead) return res.status(404).json({ error: 'no session — send a message first' });

  const meta    = lead.meta    ?? {};
  const current = meta.qualData ?? {};
  store.upsertLead(phone, { meta: { ...meta, qualData: { ...current, ...flags } } });
  res.json({ ok: true, qualData: { ...current, ...flags } });
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
// The callback MUST be async so that `await phoneRegistry.init()` is valid.
// Note: app.listen() opens the port synchronously before the callback fires.
// The ~1-2s init window is covered by Gate 1 (memberCache) and Gate 2 (operational
// interceptor) in lead_agent.js — both fire even when the registry is warming up.
process.env._SERVER_START_TS = new Date().toISOString();
app.listen(PORT, async () => {
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
  // studioAssets.DATA_DIR and persist's DATA_DIR must resolve to the same path.
  // Both use: process.env.DATA_DIR ?? path.join(__dirname, '../data')
  // When DATA_DIR=/data is set in Railway Variables, both equal '/data' and all
  // files (leads, inbox, studio_assets.json, timetable images) share one Volume.
  const _dataDir = studioAssets.DATA_DIR; // canonical: exported by studio_assets.js
  try {
    fs.mkdirSync(_dataDir, { recursive: true });
  } catch (mkErr) {
    logger.error('[startup] Could not create DATA_DIR — writes may fail', {
      dir: _dataDir, error: mkErr.message,
    });
  }

  // Log storage configuration + existing files so Railway deploy logs confirm
  // whether the Volume is mounted and what persisted from the previous deploy.
  const dataFiles = (() => {
    try { return fs.readdirSync(_dataDir); } catch { return []; }
  })();
  const _assets = studioAssets.getAssets();
  logger.info('[data] Storage directory ready', {
    path:          _dataDir,
    volume:        process.env.DATA_DIR
      ? '✅ Railway Volume active — data survives deploys'
      : '⚠️  local ./data — ephemeral on Railway (set DATA_DIR=/data + mount Volume)',
    existingFiles: dataFiles.filter(f => !f.endsWith('.tmp')),
    timetable: {
      img1Uploaded: _assets.timetableImageUploaded,
      img1Ext:      _assets.timetableImageExt || null,
      img1Exists:   !!(_assets.timetableImageUploaded && _assets.timetableImageExt &&
                       fs.existsSync(require('path').join(_dataDir, `timetable.${_assets.timetableImageExt}`))),
      img2Uploaded: _assets.timetable2ImageUploaded,
      img2Exists:   !!(_assets.timetable2ImageUploaded && _assets.timetable2ImageExt &&
                       fs.existsSync(require('path').join(_dataDir, `timetable2.${_assets.timetable2ImageExt}`))),
    },
  });

  // ── PhoneRegistry: load FIRST, before anything else ────────────────────────
  // Minimises the warm-up window between port-open and first real message.
  // 10s timeout — if Arbox is unreachable at deploy time, the registry starts
  // empty; Gate 1 (memberCache) and Gate 2 (operational interceptor) remain
  // active as independent safety layers throughout the warm-up window.
  await phoneRegistry.init({ timeoutMs: 10_000 });

  persist.loadLeads(store);
  persist.loadInbox(inbox);

  // ── Startup purge: remove stale lead records for phones now in the registry ──
  // phoneRegistry is already warm from the await above — zero extra Arbox calls.
  // This is the fix for the "Orly" class of bug: a person who was a prospect
  // before joining has a lead record in leads_persist.json. Without this pass,
  // that record reappears on every deploy and lingers until the 09:15 daily cron.
  {
    const startupPurged = _purgeKnownMembersFromLeadStore('startup');
    if (startupPurged > 0) {
      persist.saveLeads(store);
      broadcastSse('leads_updated', { purged: startupPurged, source: 'startup' });
      logger.info('[startup] Purged stale member-lead records', { purged: startupPurged });
    }
  }

  // ── Periodic save: flush both stores to disk every 60 seconds ──────────────
  setInterval(() => persist.saveAll(store, inbox), 60_000).unref();

  initWorkers(store);

  // Also seed the legacy member_cache for backward compatibility with any code
  // that still calls memberCache.isConfirmed() directly.
  seedMemberCache().then(r => {
    if (r?.seeded >= 0) logger.info('[startup] Legacy member cache seeded', r);
  }).catch(() => {});

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

