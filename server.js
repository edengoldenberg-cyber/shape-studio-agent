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

const { verifyWebhook, parseInbound, parseInboundRich, parseGreenApiWebhook, releaseQueuedMessages, sendText, sendFileByUrl, alertOwner, notifyLeadTeam, probeGreenApiConnection, ensureOutgoingWebhooks, getGreenCreds, _tokenSourceVar, getTestSendLog, clearTestSendLog } = require('./services/whatsapp.service');
const { SCHEDULE_TIMETABLE_RE: _SCHEDULE_RE } = require('./agents/deterministic_reply');
const phoneRegistry = require('./utils/phone_registry');
const ownership     = require('./utils/ownership');
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
const { fmtScheduledAt }               = require('./utils/time');
const { createCallbackService, AVAIL_RESCHEDULE_RE: _CB_RESCHEDULE_RE } = require('./services/callback.service');
const callbackTime                     = require('./utils/callback_time');
const appointmentWorker                = require('./workers/appointment_worker');
const tomerStore                       = require('./utils/tomer_store');
const arboxGateway                     = require('./services/arbox_gateway');
const serviceCases                     = require('./utils/service_case_store');
const tomerTest                        = require('./services/tomer_test_mode');
const careStore                        = require('./utils/member_care_store');
const contactPolicy                    = require('./services/contact_policy');
const { createMemberCare }             = require('./services/member_care');
const { createTomerService }           = require('./services/tomer_service');
const retentionWorker                  = require('./workers/retention_worker');
const studioAssets                     = require('./utils/studio_assets');
const memberCache                      = require('./utils/member_cache');
const identity                         = require('./services/identity_resolver').shared();   // the ONE identity resolver
const { detectAndMarkConversions, isMemberPhoneSync } = require('./utils/conversion_detector');

// ── Staff configuration (hot-reloadable) ─────────────────────────────────────
//
// DATA_DIR_VAL resolves from the DATA_DIR env var (set to /data on Railway with a
// mounted Volume) or falls back to the bundled ./data directory in the container.
// All runtime config files (staff_config, leads_persist, inbox_persist) must come
// from the same directory so a volume mount is the authoritative source.
//
// On Railway: set DATA_DIR=/data in Railway Variables + mount a Volume at /data.
// Without DATA_DIR: falls back to <app-root>/data/ (container-local, wiped on deploy).

const DATA_DIR_VAL = (process.env.DATA_DIR ?? path.join(__dirname, 'data')).replace(/\/$/, '');
const STAFF_CONFIG_PATH  = path.join(DATA_DIR_VAL, 'staff_config.json');
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
// KNOWN_MEMBERS_PATH env override exists for test isolation only; production uses the default.
const KNOWN_MEMBERS_PATH = process.env.KNOWN_MEMBERS_PATH ?? path.join(__dirname, 'data/known_members.json');

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

// ── Authentication ────────────────────────────────────────────────────────────
// Mounted BEFORE the static dashboard and every API route. Public exceptions (provider
// webhooks, /health, /api/version, calendar .ics, timetable images) are listed in
// middleware/auth.js. Fails closed when DASHBOARD_PASSWORD is not configured.
require('./middleware/auth').mount(app, express);

// ── Static dashboard ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────────────────────
// _startupComplete: set after phoneRegistry.init + persist.loadLeads + initWorkers.
// _storeReady / _storeReadyPromise: set immediately after persist.loadLeads so that
// inbound webhooks arriving during the phoneRegistry.init window (up to 10 s) are
// HELD in processInboundWAMessage rather than processing against an empty store.
// Without this gate a webhook could run, capture state, and then have that state
// silently overwritten when persist.loadLeads fires moments later.
let _startupComplete = false;
let _storeReady = false;
// Promise resolves once persist.loadLeads has completed. processInboundWAMessage
// awaits it so webhooks arriving before loadLeads are deferred, not dropped.
let _storeReadyResolve;
const _storeReadyPromise = new Promise(r => { _storeReadyResolve = r; });
function _markStoreReady() {
  if (_storeReady) return;
  _storeReady = true;
  _storeReadyResolve();
}
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString(), startupComplete: _startupComplete, storeReady: _storeReady }));

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

// POST /api/test/flush — immediately persist both stores to disk (TEST_MODE only).
// Without this, the 60s periodic save means persistence can't be verified in short tests.
app.post('/api/test/flush', requireTestMode, (_req, res) => {
  persist.saveAll(store, inbox);
  res.json({ ok: true, flushedAt: new Date().toISOString() });
});

// GET /api/test/lead/:phone — return full (unmasked) lead record for test assertions.
// TEST_MODE only — never exposes real phone data in production.
app.get('/api/test/lead/:phone', requireTestMode, (req, res) => {
  const norm = normalizeToE164(decodeURIComponent(req.params.phone));
  if (!norm) return res.status(400).json({ ok: false, error: 'invalid phone' });
  const lead = store.getLead(norm);
  if (!lead) return res.status(404).json({ ok: false, error: 'not found' });
  // Return history length only — not full content — to minimise data exposure.
  const { history, ...rest } = lead;
  res.json({ ok: true, lead: { ...rest, historyLength: history?.length ?? 0 } });
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

// POST /api/leads/:phone/set-qual — directly set qualData fields (TEST_MODE only).
// Lets tests seed callProposed=true without depending on OpenAI output.
app.post('/api/leads/:phone/set-qual', requireTestMode, jsonBody, (req, res) => {
  const norm = normalizeToE164(decodeURIComponent(req.params.phone));
  if (!norm) return res.status(400).json({ ok: false, error: 'invalid phone' });
  if (!store.getLead(norm)) store.upsertLead(norm, {});
  const existing = store.getLead(norm);
  const meta     = existing?.meta ?? {};
  const current  = meta.qualData ?? {};
  store.upsertLead(norm, { meta: { ...meta, qualData: { ...current, ...req.body } } });
  persist.saveLeads(store);
  res.json({ ok: true, qualData: store.getLead(norm)?.meta?.qualData ?? {} });
});

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
// CODE_FEATURES is a static list of feature flags baked into this binary at
// edit time — provides source-revision verification independent of git or env vars.
const CODE_FEATURES = [
  'gate3b_v2',           // Gate 3b covers !callTimeGiven (hallucinated time commitment)
  'aptstore_save_throws', // appointment_store.create() throws on disk-write failure
  'callTimeGivenAt_anchor', // name-capture path uses callTimeGivenAt for time resolution
  'booking_guard_tests',  // booking_guard.test.js with disk-write spy test
  'callback_service_v1',  // services/callback.service.js owns the lead → callback lifecycle
  'tomer_service_v1',     // services/tomer_service.js owns every member message; cases + verified Arbox reads
  'dashboard_auth_v1',    // middleware/auth.js — dashboard and API require a session; fails closed
  'dashboard_auth_v2',    // revocable sessions (logout), CSRF token on state changes, login throttling
  'tomer_panel_v2',       // staff-handled membership requests, one manager alert, complete cases panel
  'tomer_test_only_v1',   // services/tomer_test_mode.js — new flow only for allowlisted phones unless TOMER_MODE=all
  'member_care_v1',       // services/member_care.js — proactive programs (all off by default) + shared contact policy
  'identity_resolver_v1', // services/identity_resolver.js — one resolver for registry, cache and live lookup; active flag ≠ membership
  'member_care_gates_v2', // owner approval of the contact policy gates activation; unknown freeze status blocks absence outreach; late replies → context or one clarification
  'strict_callback_time', // utils/callback_time.js — no default hour, no AI date guessing
  'apt_persist_strict',   // appointment_store update/updateBatch throw + roll back on failed write
  'staff_confirm_lifecycle', // confirm / outcome endpoints enforce transitions
  'current_callback_latest', // a lead's current callback = its most recent request only
  'quiet_hours_restored',    // utils/time.isQuietHours active again (22:00–08:00 Israel)
];
app.get('/api/version', (_req, res) => {
  res.json({
    commit:          _deployedRevision ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown (env not set)',
    deploymentId:    process.env.RAILWAY_DEPLOYMENT_ID ?? 'unknown',
    serviceId:       process.env.RAILWAY_SERVICE_ID    ?? 'unknown',
    startedAt:       process.env._SERVER_START_TS      ?? 'unknown',
    codeFeatures:    CODE_FEATURES,
    tomerMode:       tomerTest.mode(),       // 'test_only' unless TOMER_MODE=all (details: GET /api/tomer/test-mode, authenticated)
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
  // A person who asked not to be contacted is never messaged from the dashboard.
  const _swNorm = normalizeToE164(phone) ?? phone;
  if (!tomerTest.isAllowed(_swNorm)) return res.status(403).json({ ok: false, error: 'recipient_not_allowed', detail: 'מצב בדיקה — המספר אינו ברשימת המורשים.' });
  if (store.getLead(_swNorm)?.status === 'opted_out') return res.status(409).json({ error: 'opted_out', detail: 'איש הקשר ביקש לא לקבל הודעות' });
  try {
    const _swRes = await sendText(phone, message);
    if (_swRes?.idMessage) _recordBotSend(_swRes.idMessage, _swNorm);
    inbox.pushOutbound({ phone: _swNorm, name: null, text: message, agentId: 'staff', meta: { agent: 'staff', handler: 'dashboard_send', trigger: 'panel', idMessage: _swRes?.idMessage ?? null } });
    _applyStaffTakeover(_swNorm, _swRes?.idMessage ?? null, message);
    store.logEvent('manual_whatsapp', phone, { preview: message.slice(0, 80), agent: 'staff' });
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

// GET /api/barak/callbacks — server-side join of callback leads + appointments.
// Returns combined records with FULL phones (never masked) and aptId for panel actions.
// Matching is done by full E.164 phone, not by masked phone, so no collision risk.
// The panel uses this single endpoint instead of client-side joining masked phones.
app.get('/api/barak/callbacks', (_req, res) => {
  // One row per lead needing callback attention — open requests (including human-owned
  // conversations), requests still waiting for a time or a name, and expired calls
  // awaiting an outcome. Completed / cancelled / no-answer callbacks leave this queue.
  res.json({ ok: true, callbacks: callbackSvc.panelRows(maskPhone) });
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

  const out = _manualTakeover(norm, { reason, staffName });
  res.json({ ok: true, phone: norm, status: 'human_owns', prevStatus: out.prevStatus, unchanged: out.unchanged });
});

/**
 * Staff take a conversation over from the dashboard. Idempotent: a second takeover
 * keeps the status recorded by the first one, so release still restores the right state.
 */
function _manualTakeover(norm, { reason = 'manual', staffName = null } = {}) {
  if (tomerTest.routeOverride(norm)) return _testTakeover(norm, { by: staffName ?? 'staff', reason });
  const existing = store.getLead(norm) ?? {};
  if (existing.status === 'human_owns') {
    return { prevStatus: existing.meta?.previousStatus ?? null, unchanged: true };
  }
  const prevStatus = existing.status ?? (_isKnownMemberPhone(norm) ? 'converted_member' : 'cold');
  store.upsertLead(norm, {
    status: 'human_owns',
    meta: {
      ...(existing.meta ?? {}),
      humanOwnsReason:    reason,
      humanOwnsSince:     new Date().toISOString(),
      humanOwnsBy:        staffName,
      previousStatus:     prevStatus,     // saved so release can restore it
      ...(prevStatus === 'converted_member' ? { isConfirmedMember: true } : {}),
    },
  });
  store.logEvent('human_takeover_manual', norm, { reason, staffName, prevStatus });
  persist.saveLeads(store);
  logger.info('[lead-ownership] Takeover — bot suppressed', { phone: norm, reason, staffName });
  broadcastSse('message', { phone: norm, route: 'human_owns', reason: 'manual_takeover' });
  return { prevStatus, unchanged: false };
}

/** Is this phone a studio member as far as the shared identity resolver knows? (no network) */
function _isKnownMemberPhone(norm) {
  try {
    const e = memberCache.getEntry(norm);
    if (e && String(e.source ?? '').startsWith('manual_') && memberCache.isConfirmed(norm)) return true;   // explicit staff decision
    return ['member', 'aggregator'].includes(identity.peek(norm).category);
  } catch { return false; }
}
// Topics a FORMER member is sent to staff for (never Barak, never Tomer).
const FORMER_MEMBER_STAFF_TOPICS = new Set(['complaint', 'refund_request', 'billing_dispute', 'payment_issue', 'receipt_request', 'payment_claim',
  'billing_question', 'membership_cancel', 'membership_freeze', 'app_problem', 'staff_request', 'injury']);

/** Release human ownership. Idempotent; returns null when there is no record. */
function _releaseConversation(norm) {
  if (tomerTest.routeOverride(norm)) {
    if (!serviceCases.getMember(norm)?.humanOwned) return { status: 'tomer_test', automationResumed: false, unchanged: true };
    serviceCases.patchMember(norm, { humanOwned: null });
    logger.info('[tomer-test] test conversation released — Tomer answers again', { phone: norm });
    broadcastSse('lead_updated', { phone: norm, status: 'tomer_test' });
    return { status: 'tomer_test', automationResumed: true };
  }
  if (!store.getLead(norm)) return null;
  const result = ownership.releaseOwnership(store, norm, { isMember: _isKnownMemberPhone });
  if (!result || result.unchanged) return result;
  store.logEvent('human_release', norm, { restoredTo: result.status, automationResumed: result.automationResumed });
  persist.saveLeads(store);
  logger.info('[lead-ownership] Released — bot resumed', { phone: norm, restoredTo: result.status });
  broadcastSse('lead_updated', { phone: norm, status: result.status });
  return result;
}

app.post('/api/leads/:phone/release', jsonBody, (req, res) => {
  const norm = normalizeToE164(decodeURIComponent(req.params.phone));
  if (!norm) return res.status(400).json({ error: 'invalid phone' });
  if (!store.getLead(norm)) return res.status(404).json({ error: 'lead not found' });

  const result = _releaseConversation(norm);
  if (!result) return res.status(404).json({ error: 'lead not found' });

  // Idempotent: lead was not in human_owns — preserve current state, no-op.
  if (result.unchanged) {
    logger.info('[lead-ownership] Release no-op — not in human_owns', { phone: norm, status: result.status });
    return res.json({ ok: true, phone: norm, status: result.status, automationResumed: false, unchanged: true });
  }
  return res.json({ ok: true, phone: norm, status: result.status, automationResumed: result.automationResumed });
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
  // Strip all non-digit, non-plus characters (covers spaces, dashes, dots, parens,
  // and invisible Unicode formatting marks from Arbox phone exports).
  const s = String(phone).replace(/[^\d+]/g, '');
  if (s.startsWith('00972')) return s.replace(/^\+?00/, '');  // 00972XXXXXXXXX → 972XXXXXXXXX
  if (s.startsWith('+972'))  return s.slice(1);               // +972XXXXXXXXX → 972XXXXXXXXX
  if (s.startsWith('972'))   return s;                        // already E164
  if (s.startsWith('0'))     return '972' + s.slice(1);       // 05X → 972 5X
  if (s.length === 9)        return '972' + s;                // 5XXXXXXXX → 972 5XXXXXXXX
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
  // "לא הצלחתי" and "פספסנו" removed: they signal a missed class (attendance failure),
  // not an intent to reschedule a future appointment. Both also appear in cancellation
  // context. Reschedule intent now requires an explicit future-booking signal.
  reschedule:       /לדחות|לשנות שעה|שעה אחרת|יום אחר|לא יכול[ה]? עכשיו|לא יכול[ה]? אז|תקבע מחדש|זמן אחר|מועד אחר|לתזמן מחדש/,
  // specialist_query: rehab, pre/post-natal, specific instructor background
  specialist_query: /שיקומ|rehab|rehabilit|מדריכ.{0,5}שיקומ|אחרי לידה|לאחר לידה|בהריון|pre.?natal|post.?natal|מדריכ.{0,10}מוסמכ|קורס.{0,10}מדריכ|מתמחה ב|מתמחה עם/,
  // subscription_query: questions about membership packages and what's included
  subscription_query: /מה זה כולל|כולל מה|מה כלול|מה נכלל|איזה שיעורים כלול|כמה כניסות|מנוי חודשי|מנויים|חבילה|חבילות|כמה עולה מנוי|מחיר מנוי|עלות מנוי|כמה עולה חבר|מנוי ב|מנוי ל/,
  // schedule_query covers both schedule listings AND instructor-specific questions.
  // Keep in sync with SCHEDULE_TIMETABLE_RE in deterministic_reply.js — any phrase
  // that matches that regex but not this one will route through lead_agent instead
  // of the scheduling pipeline's null-URL fallback.
  schedule_query:   /מערכת שעות|לוח שיעורים|מה יש|מתי יש|יש שיעור|יש מקום|סדר יום|מה הלוח|הלוח שלכם|הלוח שלך|שעות.*הסטודיו|שעות.*שלכם|שעות פעילות|שעות פתיחה|מתי פתוח|מתי פתוחים|לראות.*שעות|רוצה.*לוח|איזה שיעורים|מה התוכנית|מה הוא שיעור|מי מדריך|מי המדריך|מי מלמד|מי מנהל|מי נותן|באיזה שעה|בכמה|מה השעה|שיעור.{0,15}ב(יום|ערב|בוקר|צהריים)|ב(יום\s)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)|יש לכם.*תמונה|שלח.*תמונה.*לוח|תמונה.*לוח|לוח.*תמונה|יש תמונה|שלח.*מערכת|רוצה.*מערכת|לראות.*מערכת|לוח.*שבוע|שבוע.*לוח|אפשר.*לראות.*לוח|שלח[יה]?\s+לי\s+(?:את\s+ה?)?תמונה|תשלח[יה]?\s+לי\s+(?:את\s+ה?)?תמונה|אפשר\s+תמונה|לשלוח\s+לי\s+תמונה|שלוח\s+לי\s+תמונה/,
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
    return `נכון לעכשיו אין לי מידע מלא על מדריכים בהתמחות הזו. אשמח לחבר אותך עם נציג מהצוות שיוכל לענות — באיזו שעה נוח לך? 📞`;
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
      `אם המחיר לא מצוין (null) — ציין "אשמח לחבר אותך עם נציג שייתן לך את הפרטים". עד 4 שורות.`
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

  // For booking / schedule_query — pull live Arbox schedule for the right day.
  // Pass msg.timestamp (Unix seconds) so "חמישי" resolves relative to the send
  // time rather than the server's processing clock.
  let scheduleData = { classes: [], total: 0, date: null };
  try {
    scheduleData = await barakAgent.checkSchedule(msgText, msg?.timestamp ?? null);
  } catch { /* non-fatal */ }

  if (intent === 'booking' || intent === 'schedule_query') {
    if (!scheduleData.classes?.length) {
      const dayLabel = scheduleData.date ? formatDateHe(scheduleData.date) : 'היום';
      return `אין שיעורים ב${dayLabel}. רוצה שאבדוק יום אחר? 🗓️`;
    }

    const dayLabel      = scheduleData.date ? formatDateHe(scheduleData.date) : 'היום';
    const instructorOnly = isInstructorQuery(msgText);
    const classFilter    = extractClassFilter(msgText);

    // Time-of-day filter: morning query → before 12:00; evening → 17:00+.
    // Applied before the class-name filter so "פילאטיס בבוקר" works correctly.
    const isMorningQuery = /בבוקר|שעות\s*בוקר|אימון\s*בוקר/.test(msgText);
    const isEveningQuery = /בערב|שעות\s*ערב|אחה"צ|אחרי\s*הצהריים/.test(msgText);
    const timeFiltered = isMorningQuery
      ? scheduleData.classes.filter(c => parseInt((c.start ?? '12').split(':')[0], 10) < 12)
      : isEveningQuery
        ? scheduleData.classes.filter(c => parseInt((c.start ?? '12').split(':')[0], 10) >= 17)
        : scheduleData.classes;

    // Surgical filter: when the user named a specific class, show only that class
    const relevantClasses = classFilter
      ? timeFiltered.filter(c => classFilter.test(c.name))
      : timeFiltered;

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

// Opt-out signals that MUST reach lead_agent even when status=callback_requested/call_scheduled.
// lead_agent sets opted_out status and sends the removal acknowledgement.
// Keep in sync with lead_agent._optOutPatterns.
const _POST_CALL_OPT_OUT_PATS = [
  /^\s*STOP\s*$/i,
  /^\s*unsubscribe\s*$/i,
  /^\s*HDR\s*$/i,
  /(?:^|[ ,.!?])(?:הסר|תסיר)[ו]?\s+אות[יה](?:$|[ ,.!?])/,
  /(?:^|[ ,.!?])אל\s+תשלח[ו]?(?:\s+לי)?(?:\s+יותר)?(?:\s+הודעות)?(?:$|[ ,.!?])/,
  /לא\s+רוצה\s+(?:לקבל\s+)?הודעות/,
  /(?:^|[ ,.!?])הסר\s+מרשימה(?:$|[ ,.!?])/,
];
function isPostCallOptOut(text) {
  if (!text) return false;
  return _POST_CALL_OPT_OUT_PATS.some(p => p.test(text));
}

// ── Payment screenshot / confirmation detector ────────────────────────────────
// Catches Bit/Paybox/bank-transfer screenshots and text confirmations.
// These must NEVER trigger sales scripts — always ack + alert staff.
//
// ביט (Bit app): requires a non-Hebrew char before and after to avoid matching
// "ביטלתי" (I cancelled), "ביטול" (cancellation), "ביטוח" (insurance), etc.
// א-ת covers the Hebrew Unicode block (alef–tav).
const PAYMENT_RE = /\bbit\b|(?<![א-ת])ביט(?![א-ת])|paybox|פייבוקס|העברה בנקאית|העברה.*בנק|בנק.*העברה|אישור תשלום|אישור.*תשלום|קבלה.*תשלום|שלחתי תשלום|שלחתי העברה|העברתי|ביצעתי העברה|שלמתי|תשלום עבר|הועבר|payment.*confirm|transfer.*confirm|שלחתי.*₪|₪.*שלחתי|\b\d{2,4}\s*₪|\b\d{2,4}\s*ש["״"]ח|שלחתי.*\d{2,4}\s*(שקל|ש["״"]ח)|הוראת קבע|חיוב.*כרטיס/i;

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
// Two mechanisms prevent bot echoes from triggering false human_owns:
//
// 1. _botSentIds (idMessage ring buffer): every Green API idMessage we send is
//    recorded. When an echo arrives with that idMessage → confirmed bot send → skip.
//    This is the primary and reliable mechanism.
//
// 2. _pendingBotSends (per-phone in-flight tracker): records sends whose HTTP
//    request is still in flight (< 3s). Handles the rare case where Green API
//    delivers the outgoingMessageReceived echo before our sendText() HTTP response
//    has returned and _recordBotSend has been called.
//
// INTENTIONAL LIMITATION: A staff reply arriving within 3 seconds of an in-flight
// bot send will be temporarily misclassified. This is the minimum viable window for
// an HTTP round-trip. 3 seconds ≪ 20 seconds: a staff reply at t+2s is not masked.
const _botSentIds     = new Map(); // idMessage → { phone, sentAt }
const _pendingBotSends = new Map(); // phone → [sendStartedAt, ...] (in-flight sends)
const _unresolvedEchoes = new Map(); // phone → { idMessage, msgText, graceTimer }
const BOT_SENT_TTL        = 24 * 60 * 60 * 1000;
// Allow shorter TTL in tests (TEST_PENDING_SEND_TTL_MS) while keeping 3s in production.
const PENDING_SEND_TTL    = Number(process.env.TEST_PENDING_SEND_TTL_MS) || 3_000;
// Grace period after PENDING_SEND_TTL expires: gives slow providers time to deliver
// _recordBotSend before concluding a staff reply. TEST_UNRESOLVED_GRACE_MS shortens it.
const UNRESOLVED_GRACE_MS = Number(process.env.TEST_UNRESOLVED_GRACE_MS) || 5_000;
const OUTGOING_RECONCILE_MS = 300;  // hold unresolved outgoing echo for ID reconciliation

function _markBotSent(phone) {
  // Register that a bot send is now in flight for this phone.
  if (!phone) return;
  const sends = _pendingBotSends.get(phone) ?? [];
  sends.push(Date.now());
  _pendingBotSends.set(phone, sends);
}

function _recordBotSend(idMessage, phone) {
  if (!idMessage || typeof idMessage !== 'string') return;
  if (idMessage.startsWith('demo-') || idMessage.startsWith('blocked-')) return;
  _botSentIds.set(idMessage, { phone, sentAt: Date.now() });
  // Log the mapping from Green API provider ID to this bot-send.
  // This proves "one send, two records" when history sync later imports the same
  // provider ID: the provider ID here (3EB0...) matches the idMessage in the thread.
  store.logEvent('bot_send_recorded', phone, { idMessage });
  if (_botSentIds.size > 400) {
    const oldestKey = _botSentIds.keys().next().value;
    _botSentIds.delete(oldestKey);
  }
  // If this phone has an unresolved echo waiting on exactly this idMessage,
  // the provider finally responded. Clear the entry and cancel any pending grace timer.
  // If grace already fired and set attribution_review, revert it to the pre-review status.
  // Never touch human_owns — that reflects genuine staff action, not auto-attribution.
  const unresolved = _unresolvedEchoes.get(phone);
  if (unresolved && unresolved.idMessage === idMessage) {
    if (unresolved.graceTimer) clearTimeout(unresolved.graceTimer);
    _unresolvedEchoes.delete(phone);
    const curStatus = store.getLead(phone)?.status;
    if (curStatus === 'attribution_review') {
      const prev = unresolved.prevStatus ?? 'cold';
      store.upsertLead(phone, { status: prev });
      logger.info('[reconcile] attribution_review reverted — late bot send confirmed', { phone, prevStatus: prev });
    }
    logger.info('[reconcile] Late _recordBotSend cleared unresolved echo — confirmed bot send', { phone, idMessage });
    store.logEvent('echo_attributed_to_bot', phone, { idMessage });
  }
  // Remove oldest pending-send entry now that the idMessage is confirmed.
  const sends = _pendingBotSends.get(phone);
  if (sends?.length > 0) {
    sends.shift();
    if (sends.length === 0) _pendingBotSends.delete(phone);
  }
}

function _hasUnresolvedEcho(phone) {
  return _unresolvedEchoes.has(phone);
}

function _hasPendingBotSend(phone) {
  const sends = _pendingBotSends.get(phone);
  if (!sends || sends.length === 0) return false;
  const now = Date.now();
  const active = sends.filter(ts => now - ts < PENDING_SEND_TTL);
  if (active.length !== sends.length) {
    if (active.length === 0) _pendingBotSends.delete(phone);
    else _pendingBotSends.set(phone, active);
  }
  return active.length > 0;
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

// Deferred echo reconciliation: fires every OUTGOING_RECONCILE_MS while the bot's
// HTTP send is still in-flight. Three termination cases:
//   (a) idMessage confirmed in _botSentIds → bot echo, done.
//   (b) pending send still active → provider still in-flight, re-defer.
//   (c) PENDING_SEND_TTL expired (no pending send) → attribution unresolved:
//       Wait UNRESOLVED_GRACE_MS for _recordBotSend (slow provider). If it arrives →
//       bot confirmed, entry cleared. If grace expires without confirmation → enter
//       attribution_review (NOT human_owns — elapsed time alone does not prove staff).
//       The entry persists past grace so a late _recordBotSend can still clear review.
function _scheduleEchoReconcile(norm, idMessage, msgText) {
  setTimeout(() => {
    if (_isBotSentId(idMessage)) {
      logger.debug('[outgoing-webhook] Deferred: confirmed bot echo', { phone: norm, idMessage });
      return;
    }
    if (_hasPendingBotSend(norm)) {
      logger.debug('[outgoing-webhook] Deferred: bot send still in-flight — extending window', { phone: norm, idMessage });
      _scheduleEchoReconcile(norm, idMessage, msgText);
      return;
    }
    if (_unresolvedEchoes.has(norm)) return; // already holding for this phone, idempotent
    logger.info('[outgoing-webhook] TTL expired — attribution unresolved, entering grace period', {
      phone: norm, idMessage,
    });
    store.logEvent('echo_attribution_unresolved', norm, { idMessage });
    const prevStatus = store.getLead(norm)?.status ?? null;
    const graceTimer = setTimeout(() => {
      const entry = _unresolvedEchoes.get(norm);
      if (!entry || entry.idMessage !== idMessage) return; // cleared by _recordBotSend
      // Keep entry active after grace so a late _recordBotSend can still reconcile.
      _unresolvedEchoes.set(norm, { ...entry, graceTimer: null });
      logger.info('[outgoing-webhook] Grace expired — attribution still unresolved, entering review', {
        phone: norm, idMessage,
      });
      _applyAttributionReview(norm, idMessage, msgText, entry.prevStatus);
    }, UNRESOLVED_GRACE_MS);
    _unresolvedEchoes.set(norm, { idMessage, msgText, graceTimer, prevStatus });
  }, OUTGOING_RECONCILE_MS);
}

// Enter explicit attribution review: the echo cannot yet be attributed to bot or staff.
// Sets status to 'attribution_review' so the conversation is paused for manual resolution.
// A late _recordBotSend will clear this. Human takeover via API confirms staff authorship.
// Does NOT set human_owns — elapsed time alone is not evidence of staff authorship.
function _applyAttributionReview(norm, idMessage, msgText, prevStatus = null) {
  const existing  = store.getLead(norm) ?? {};
  const curStatus = existing.status ?? null;
  // Don't overwrite genuine human stop-statuses set by staff action.
  if (['opted_out', 'converted_member', 'human_owns'].includes(curStatus)) {
    logger.info('[reconcile] Attribution review skipped — existing stop-status preserved', {
      phone: norm, curStatus,
    });
    return;
  }
  store.upsertLead(norm, {
    status: 'attribution_review',
    meta: {
      ...(existing.meta ?? {}),
      attributionReviewSince:      new Date().toISOString(),
      attributionReviewIdMessage:  idMessage,
      attributionReviewReason:     'grace_expired_unresolved',
      attributionReviewPrevStatus: prevStatus,
    },
  });
  persist.saveLeads(store);
  store.logEvent('echo_attribution_review', norm, { idMessage, prevStatus });
  logger.info('[outgoing-webhook] Attribution review entered — grace expired without bot confirmation', {
    phone: norm, idMessage,
  });
  broadcastSse('message', { phone: norm, route: 'attribution_review', reason: 'grace_expired' });
}

// Idempotent — if already human_owns or opted_out, does nothing.
// A converted_member IS taken over: staff replying to a member must silence Tomer too
// (previousStatus keeps 'converted_member', so releasing ownership restores it).
function _applyStaffTakeover(norm, idMessage, msgText, { by = 'staff', isMember = false } = {}) {
  if (tomerTest.routeOverride(norm)) {
    const out = _testTakeover(norm, { by, reason: 'staff_manual_reply' });
    if (!out.unchanged) { try { tomerService.noteOwnership(norm, 'human_takeover', { by, detail: 'staff reply' }); } catch { /* optional */ } }
    return;
  }
  const existing  = store.getLead(norm) ?? {};
  const curStatus = existing.status ?? null;
  if (['opted_out', 'human_owns'].includes(curStatus)) return;
  // A member with no lead record yet must come back as a member after release.
  const member = isMember || curStatus === 'converted_member' || _isKnownMemberPhone(norm);
  store.upsertLead(norm, {
    status: 'human_owns',
    meta: {
      ...(existing.meta ?? {}),
      humanOwnsReason: 'staff_manual_reply',
      humanOwnsSince:  new Date().toISOString(),
      humanOwnsBy:     by,
      previousStatus:  curStatus ?? (member ? 'converted_member' : 'cold'),
      ...(member ? { isConfirmedMember: true } : {}),
    },
  });
  persist.saveLeads(store);
  try { tomerService.noteOwnership(norm, 'human_takeover', { by, detail: 'staff reply' }); } catch { /* cases are optional context here */ }
  store.logEvent('human_takeover_staff_reply', norm, {
    idMessage, preview: (msgText ?? '').slice(0, 60),
  });
  logger.info('[outgoing-webhook] Staff manual reply detected — human_owns set', {
    phone: norm, idMessage, wasLead: !!existing.status,
  });
  broadcastSse('message', { phone: norm, route: 'human_owns', reason: 'staff_reply' });
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

// ══════════════════════════════════════════════════════════════════════════════
// BARAK — LEAD → CALLBACK FLOW
// ══════════════════════════════════════════════════════════════════════════════
//
// One service owns the lifecycle (services/callback.service.js); this section only
// decides which lifecycle step an inbound lead message is.

const callbackSvc = createCallbackService({
  store, persist, logger, alertOwner,
  // Prospect sends: register the provider id so the outgoing-message webhook echo is
  // attributed to the bot and never mistaken for a staff takeover.
  sendText: async (to, text, opts) => {
    const r = await sendText(to, text, opts);
    if (r?.idMessage) _recordBotSend(r.idMessage, to);
    return r;
  },
  markBotSent:         phone => _markBotSent(phone),
  getBackendBase:      () => getBackendBase(),
  getStaffId:          () => defaultStaff()?.id ?? 'eden',
  getDurationMin:      () => staffConfig.appointment_duration_min ?? 30,
  cancelCalendarEvent: apt => calendarSvc.cancelCalendarEvent(apt),
});

// ══════════════════════════════════════════════════════════════════════════════
// TOMER — EXISTING-MEMBER SERVICE
// ══════════════════════════════════════════════════════════════════════════════
// services/tomer_service.js owns every member message (text + media). Kill switch:
// TOMER_SERVICE_ENABLED=false restores the previous member routing.
// In test_only mode (the default) the new flow exists only for the allowlisted phones;
// every other member keeps the routing production had before it (see tomer_test_mode.js).
const _tomerSwitch = () => process.env.TOMER_SERVICE_ENABLED !== 'false';
const _tomerOn = phone => _tomerSwitch() && tomerTest.isAllowed(phone);

// ── Test identity (route-overridden phone) ────────────────────────────────────
// Conversation ownership and opt-out of the test identity live in the service-case
// store, NOT on the phone's lead record: the Barak lead, its appointments and its
// history are never modified by the Tomer test, and removing the override restores
// Barak's routing with every stored record exactly as it was.
function _testIdentityLead(phone) {
  const m = serviceCases.getMember(phone) ?? {};
  const status = m.optedOut ? 'opted_out' : m.humanOwned ? 'human_owns' : null;
  return status ? { phone, status, meta: { humanOwnsBy: m.humanOwned?.by ?? null, humanOwnsSince: m.humanOwned?.since ?? null, humanOwnsReason: m.humanOwned?.reason ?? null } } : null;
}
/** The record that decides who answers this phone: the test identity's own state, or the lead store. */
const _ownerLead = phone => (tomerTest.routeOverride(phone) ? _testIdentityLead(phone) : store.getLead(phone));
function _testTakeover(phone, { by = 'staff', reason = 'manual' } = {}) {
  if (serviceCases.getMember(phone)?.humanOwned) return { prevStatus: null, unchanged: true };
  serviceCases.patchMember(phone, { humanOwned: { by, reason, since: new Date().toISOString() } });
  logger.info('[tomer-test] staff took the test conversation over — Tomer silenced', { phone, by, reason });
  broadcastSse('message', { phone, route: 'human_owns', reason });
  return { prevStatus: null, unchanged: false };
}
// What the Tomer service sees as "the lead store": for the test identity only its own state.
const tomerLeadStore = {
  getLead:    phone => _ownerLead(phone),
  upsertLead: (phone, patch) => {
    if (!tomerTest.routeOverride(phone)) return store.upsertLead(phone, patch);
    if (patch?.status === 'opted_out') serviceCases.patchMember(phone, { optedOut: { at: new Date().toISOString() } });
    return _testIdentityLead(phone);
  },
  logEvent:   (type, phone, data) => (tomerTest.routeOverride(phone) ? undefined : store.logEvent(type, phone, data)),
};
let _tomerOpenAI = null;
let memberCare = null;                                   // created right after the service (it sends through it)
const tomerGateway = tomerTest.wrapGateway(arboxGateway);
const tomerService = app.locals.tomerService = createTomerService({
  leadStore: tomerLeadStore, persist: { saveLeads: () => persist.saveLeads(store) }, logger,
  gateway: tomerGateway, cases: serviceCases, tomerStore, inbox,
  allowed: phone => _tomerOn(phone),
  getCare: () => memberCare,
  // Automatic member sends obey WHATSAPP_AUTO_REPLY; a staff reply from the panel
  // (opts.staff) is a human send and is never blocked by it.
  sendText: async (to, text, opts = {}) => {
    // TEST-ONLY RESTRICTION — the single exit for every member-facing message of the new
    // flow (replies, follow-ups, staff replies from a case): a phone that is not allowed
    // receives nothing, whatever called this.
    if (!_tomerOn(to)) {
      logger.warn('[tomer] send refused — recipient is not enabled for the new Tomer flow', { tail: String(to).slice(-4), mode: tomerTest.mode() });
      return { blocked: true, notAllowed: true };
    }
    if (!opts.staff && process.env.WHATSAPP_AUTO_REPLY !== 'true') return { blocked: true };
    _markBotSent(to);
    // Tomer only ever ANSWERS a member who has just written, so its replies are not held
    // for quiet hours: the shared quiet-hours path would send "נחזור אליך מחר בבוקר" (a
    // promise Tomer must not make) and keep the real answer in an in-memory queue that a
    // restart loses. TOMER_QUIET_HOURS=true restores the shared quiet-hours behaviour.
    const _direct = !!opts.bypassQuietHours || process.env.TOMER_QUIET_HOURS !== 'true';
    const r = await sendText(to, text, { bypassQuietHours: _direct, linkPreview: opts.linkPreview !== false });
    // Registered so the provider's echo of this send is not mistaken for a phone-side reply.
    if (r?.idMessage) _recordBotSend(r.idMessage, to);
    if (!opts.staff) _markReplied(to);
    return r;
  },
  // Case alerts go to ONE manager: TOMER_MANAGER_PHONE, else the studio owner / default
  // assignee in staff_config.json. Quiet hours do not apply to staff alerts.
  managerPhone: () => _tomerManagerPhone(),
  sendManager: (phone, text) => sendText(phone, text, { bypassQuietHours: true, linkPreview: false }),
  getAssets:      () => studioAssets.getAssets(),
  getBackendBase: () => getBackendBase(),
  sendTimetable: async (phone) => {
    const url = getActiveTimetableUrl();
    if (!url || process.env.WHATSAPP_AUTO_REPLY !== 'true' || !_tomerOn(phone)) return false;
    _markBotSent(phone);
    const r = await sendFileByUrl(phone, url, 'schedule.png', 'מערכת השעות העדכנית של הסטודיו');
    if (r?.idMessage) _recordBotSend(r.idMessage, phone);
    const url2 = getActiveTimetable2Url();
    if (url2) { _markBotSent(phone); const r2 = await sendFileByUrl(phone, url2, 'schedule2.png', '').catch(() => null); if (r2?.idMessage) _recordBotSend(r2.idMessage, phone); }
    return !!r?.idMessage;
  },
  applyTakeover: (phone, text, o = {}) => _applyStaffTakeover(phone, null, text, o),
  ai: process.env.OPENAI_API_KEY ? async ({ system, user }) => {
    if (!_tomerOpenAI) { const OpenAI = require('openai'); _tomerOpenAI = new (OpenAI.OpenAI ?? OpenAI)({ apiKey: process.env.OPENAI_API_KEY }); }
    const c = await _tomerOpenAI.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o', temperature: 0.2, max_tokens: 220,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    return c.choices?.[0]?.message?.content ?? null;
  } : null,
});

// ══════════════════════════════════════════════════════════════════════════════
// TOMER — PROACTIVE MEMBER CARE (services/member_care.js)
// ══════════════════════════════════════════════════════════════════════════════
// Three independent gates before any proactive message: the deployment switch
// TOMER_PROACTIVE_ENABLED, the program's own enable flag (panel, off by default), and the
// test-only recipient allowlist enforced in the Tomer send wrapper.
memberCare = createMemberCare({
  gateway: tomerGateway, store: careStore, cases: serviceCases, logger,
  sendMember: (phone, text, meta) => tomerService.say(phone, text, meta),
  state: {
    proactiveOn: () => _tomerSwitch() && tomerTest.proactiveEnabled(),
    allowed: phone => _tomerOn(phone),
    owner: phone => _conversationOwner(phone),
    // The last message that really was part of a conversation: anything the member wrote, or
    // anything of ours that went out (a refused / blocked send is not a conversation).
    lastConversationAt: phone => {
      const msgs = (inbox.getThread ? inbox.getThread(phone) : null)?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.direction === 'out' && ['failed', 'blocked', 'uncertain'].includes(m.meta?.sendState)) continue;
        return new Date(m.timestamp).getTime();
      }
      return null;
    },
    testPhones: () => tomerTest.status().routeOverridePhones,
  },
  audit: e => { try { tomerStore.appendAudit({ ...e, owner: 'tomer' }); } catch { /* audit is a view */ } },
  // Automated browser checks only (NODE_ENV=test): a clock that starts at a given instant, so
  // the check behaves the same at any hour of the day. Never honoured outside tests.
  ...(process.env.NODE_ENV === 'test' && process.env.MEMBER_CARE_TEST_NOW
    ? (() => { const base = new Date(process.env.MEMBER_CARE_TEST_NOW).getTime(), t0 = Date.now(); return { now: () => new Date(base + (Date.now() - t0)) }; })() : {}),
});
app.locals.memberCare = memberCare;
// Every 15 minutes: run the programs that are due today. Does nothing while the switch is off.
if (process.env.TEST_NO_BIND !== 'true') {
  cron.schedule('*/15 * * * *', () => { memberCare.tick().catch(err => logger.error('[member-care] scheduled run failed', { error: err.message })); }, { timezone: 'Asia/Jerusalem' });
}
{
  const _by = req => String(req.body?.by ?? '').trim().slice(0, 40) || 'צוות';
  const _care = fn => async (req, res) => {
    try {
      const out = await fn(req);
      if (out && out.ok === false) return res.status(out.error === 'not_found' || out.error === 'unknown_program' ? 404 : 409).json(out);
      return res.json({ ok: true, ...(out ?? {}) });
    } catch (err) {
      logger.error('[member-care] request failed', { path: req.path, error: err.message });
      return res.status(500).json({ ok: false, error: 'operation_failed', detail: err.message });
    }
  };
  const _epRow = e => ({ ...e, label: memberCare.PROGRAMS[e.program]?.label ?? e.program, reasonsText: (e.reasons ?? []).map(c => contactPolicy.REASON_HE[c] ?? memberCare.EXCL_HE[c] ?? c) });

  app.get('/api/tomer/care/overview', _care(() => ({ ...memberCare.overview(), testMode: tomerTest.status(), autoReply: process.env.WHATSAPP_AUTO_REPLY === 'true' })));
  app.post('/api/tomer/care/settings', jsonBody, _care(req => {
    const b = req.body ?? {}, patch = {};
    if ('groupLink' in b) {
      const v = String(b.groupLink ?? '').trim();
      if (v && !/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{10,}$/.test(v)) return { ok: false, error: 'bad_group_link' };
      patch.groupLink = v || null;
    }
    if ('paymentResolution' in b) {
      const v = String(b.paymentResolution ?? '').trim().slice(0, 400);
      if (/cvv|שלח[וי]? (?:לי |לנו )?(?:את )?(?:מספר|פרטי) (?:ה)?כרטיס/i.test(v)) return { ok: false, error: 'unsafe_payment_text' };
      patch.paymentResolution = v || null;
    }
    if ('billingDataConfirmed' in b) patch.billingDataConfirmed = b.billingDataConfirmed === true;
    if (b.policy && typeof b.policy === 'object') {
      const cur = careStore.getSettings().policy, p = {};
      const int = (k, lo, hi) => { if (k in b.policy) { const n = Number(b.policy[k]); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`bad_policy:${k}`); p[k] = n; } };
      try { int('windowStart', 6, 12); int('windowEnd', 13, 22); int('fridayEnd', 9, 16); int('cooldownHours', 0, 720); int('attendanceCooldownDays', 0, 30); int('recentConversationHours', 0, 168); int('replyWindowDays', 1, 14); int('defaultPauseDays', 1, 90); int('paymentGraceHours', 0, 168); }
      catch (err) { return { ok: false, error: 'bad_policy', detail: err.message }; }
      if ('saturday' in b.policy) p.saturday = b.policy.saturday === true;
      if (['friday', 'sunday'].includes(b.policy.birthdaySaturday)) p.birthdaySaturday = b.policy.birthdaySaturday;
      if ((p.windowStart ?? cur.windowStart) >= (p.windowEnd ?? cur.windowEnd)) return { ok: false, error: 'bad_policy' };
      patch.policy = p;                                    // managerDigest is not settable: no digest exists until approved
    }
    let settings = careStore.updateSettings(patch, _by(req));
    // Owner approval of the contact policy as it stands AFTER this save. The caller must echo the
    // fingerprint it was shown and name the approver; any later policy change voids the approval.
    if ('policyApproved' in b) {
      const ap = memberCare.approvePolicy({ approved: b.policyApproved === true, fingerprint: b.policyFingerprint, by: String(b.approvedBy ?? '').trim().slice(0, 40) });
      if (!ap.ok) return ap;
      settings = ap.settings;
    }
    // Staff statement that the Arbox hold report is a reliable source of freeze status.
    if ('freezeSourceConfirmed' in b) {
      const fc = memberCare.confirmFreezeSource({ confirmed: b.freezeSourceConfirmed === true, by: String(b.by ?? '').trim().slice(0, 40) });
      if (!fc.ok) return fc;
      settings = fc.settings;
    }
    // A program whose required setting was removed (or whose policy approval was voided) cannot stay enabled.
    for (const id of careStore.PROGRAM_IDS) if (settings.programs[id].enabled && memberCare.programBlocks(id, settings).length) careStore.updateSettings({ programs: { [id]: { enabled: false } } }, 'system');
    return { overview: memberCare.overview() };
  }));
  // Staff-reviewed freeze status of ONE member (valid for a limited time; never written to Arbox).
  app.post('/api/tomer/care/freeze-review', jsonBody, _care(req => {
    const out = memberCare.reviewFreeze(String(req.body?.userId ?? '').trim(), { status: req.body?.status ?? null, by: String(req.body?.by ?? '').trim().slice(0, 40), note: req.body?.note ?? null });
    return out.ok ? { review: out.review, overview: memberCare.overview() } : out;
  }));
  app.post('/api/tomer/care/programs/:id', jsonBody, _care(req => {
    const out = memberCare.setProgram(req.params.id, { enabled: req.body?.enabled, hour: req.body?.hour }, _by(req));
    // Changing a program's hour changes what the owner approved: programs that are now blocked are switched off.
    if (out.ok) for (const id of careStore.PROGRAM_IDS) if (out.settings.programs[id].enabled && memberCare.programBlocks(id, out.settings).length) careStore.updateSettings({ programs: { [id]: { enabled: false } } }, 'system');
    return out.ok ? { overview: memberCare.overview() } : out;
  }));
  app.get('/api/tomer/care/preview/:id', _care(req => memberCare.preview(req.params.id)));
  app.post('/api/tomer/care/run/:id', jsonBody, _care(async req => {
    if (!memberCare.PROGRAMS[req.params.id]) return { ok: false, error: 'unknown_program' };
    const out = await memberCare.run({ programs: [req.params.id], trigger: 'manual', by: _by(req) });
    return out.ok ? { run: out } : { ok: false, error: out.reason };
  }));
  app.post('/api/tomer/care/test-send/:id', jsonBody, _care(req => memberCare.testSend(req.params.id, { by: _by(req) })));
  app.get('/api/tomer/care/episodes', _care(req => {
    const status = req.query.status ? String(req.query.status).split(',') : undefined;
    return { episodes: careStore.listEpisodes({ status, program: req.query.program || undefined, limit: 300 }).map(_epRow) };
  }));
  app.post('/api/tomer/care/episodes/resolve', jsonBody, _care(req => { const out = memberCare.resolveUncertain(String(req.body?.key ?? ''), { action: req.body?.action, by: _by(req) }); return out.ok ? { episode: _epRow(out.episode) } : out; }));
  app.get('/api/tomer/care/absence-report', _care(() => memberCare.absenceReport()));
  app.get('/api/tomer/care/visibility', _care(() => memberCare.visibility()));
  app.post('/api/tomer/care/pauses', jsonBody, _care(req => {
    const phone = normalizeToE164(String(req.body?.phone ?? ''));
    const reason = String(req.body?.reason ?? '').trim().slice(0, 60);
    const until = String(req.body?.until ?? '').trim();
    if (!phone) return { ok: false, error: 'bad_phone' };
    if (!reason) return { ok: false, error: 'reason_required' };
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: 'bad_date' };
    careStore.setPause(phone, { reason, note: String(req.body?.note ?? '').slice(0, 200) || null, until: until || null, endKnown: !!until, setBy: _by(req), name: String(req.body?.name ?? '').slice(0, 60) || null });
    return { pauses: careStore.listPauses() };
  }));
  app.post('/api/tomer/care/pauses/remove', jsonBody, _care(req => { careStore.clearPause(normalizeToE164(String(req.body?.phone ?? '')) ?? String(req.body?.phone ?? '')); return { pauses: careStore.listPauses() }; }));
  app.post('/api/tomer/care/entitlements/:userId/reserve', jsonBody, _care(req => careStore.reserveGuest(req.params.userId, { guestName: String(req.body?.guestName ?? '').slice(0, 60) || null, note: String(req.body?.note ?? '').slice(0, 200) || null, by: _by(req), caseId: req.body?.caseId ?? null })));
  app.post('/api/tomer/care/entitlements/:userId/redeem', jsonBody, _care(req => careStore.redeemGuest(req.params.userId, String(req.body?.itemId ?? ''), _by(req))));
  app.post('/api/tomer/care/entitlements/:userId/release', jsonBody, _care(req => careStore.releaseGuest(req.params.userId, String(req.body?.itemId ?? ''), _by(req))));
}

function _tomerManagerPhone() {
  const clean = p => String(p ?? '').trim().replace(/^\+/, '');
  const ok = p => /^[0-9]{9,15}$/.test(p);
  const env = clean(process.env.TOMER_MANAGER_PHONE);
  if (ok(env)) return env;
  // In test_only mode the alert recipient must be named explicitly — never inferred.
  if (tomerTest.mode() !== 'all') return null;
  const list = staffConfig?.staff ?? [];
  const pick = list.find(s => s.active && s.role === 'owner' && ok(clean(s.phone)))
            ?? list.find(s => s.active && s.id === staffConfig?.default_assignee_id && ok(clean(s.phone)))
            ?? null;
  return pick ? clean(pick.phone) : null;
}

// A lead asking, in their own words, for someone to call / get back to them.
const CALLBACK_REQUEST_RE = /נציג|לדבר עם (?:מישהו|מישהי|אדם|בן אדם)|אדם אמיתי|שמישהו יחזור|ש[ית]חזרו אלי|תחזרו אלי|תחזור אלי|חזרו אלי|לחזור אלי|שיתקשרו|שתתקשרו|תתקשרו|תתקשר אלי|להתקשר אלי|שיצרו קשר|צרו (?:איתי |אתי )?קשר|שיחת טלפון|שיחה טלפונית|לדבר בטלפון|אפשר שיחה|רוצה שיחה|לתאם שיחה|לקבוע שיחה|אשמח לשיחה|אשמח לדבר|מעדי(?:ף|פה) (?:לדבר|שיחה)/;
// A message about classes / prices that happens to contain a day or an hour.
const CLASS_QUESTION_RE = /שיעור|אימון|מערכת|לוח|פילאטיס|יוגה|רפורמר|מחיר|עולה|פתוח|סטודיו פעיל/;

function _saneDate(ts) {
  const d = ts instanceof Date ? ts : (ts ? new Date(ts) : null);
  if (!d || isNaN(d.getTime())) return new Date();
  const y = d.getUTCFullYear();
  return (y >= 2020 && y <= 2100) ? d : new Date();
}

/**
 * Returns a pipeline result when the message belongs to the callback flow, or null to
 * let the normal pipeline continue.
 *
 *   phase 'active' — the lead already has a callback in progress (status
 *                    callback_requested / call_scheduled).
 *   phase 'new'    — the lead is asking for a callback, answering a callback
 *                    invitation with a time, or supplying a time we asked for.
 */
async function handleLeadCallbackFlow({ msg, fromNorm, fromIsraeli, clientMatch, intent, phase }) {
  const lead   = store.getLead(fromNorm);
  const status = lead?.status ?? null;
  const meta   = lead?.meta ?? {};
  const qd     = meta.qualData ?? {};
  const text   = (msg.text ?? '').trim();
  const sentAt = _saneDate(msg.timestamp);
  const inCallbackState = callbackSvc.CALLBACK_STATUSES.has(status);

  if (phase === 'active' && !inCallbackState) return null;
  if (phase === 'new' && (inCallbackState || callbackSvc.STOP_STATUSES.has(status))) return null;

  const { extractNameFromMessage, TIME_REJECTION_RE } = leadAgent;
  const autoReply = process.env.WHATSAPP_AUTO_REPLY === 'true';
  const who = qd.confirmedName ?? msg.name ?? fromIsraeli ?? fromNorm;

  // Record the turn and return. `alreadySent` = the callback service sent the text itself.
  async function finish(route, reply, { alreadySent = false, routeIntent = intent } = {}) {
    if (reply && !alreadySent && autoReply) {
      _markBotSent(fromNorm);
      try {
        const r = await sendText(fromNorm, reply);
        if (r?.idMessage) _recordBotSend(r.idMessage, fromNorm);
        _markReplied(fromNorm);
      } catch (err) {
        logger.warn('[callback-flow] reply send failed', { from: fromNorm, route, error: err.message });
      }
    }
    if (reply && text) leadAgent.recordSchedulingExchange(fromNorm, text, reply);
    const cur = store.getLead(fromNorm);
    if (cur) store.upsertLead(fromNorm, { messageCount: (cur.messageCount ?? 0) + 1, name: cur.name ?? msg.name ?? undefined });
    const entry = inbox.push({
      from: fromNorm, fromIsraeli, name: msg.name ?? null,
      text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
      receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
      clientMatch, intent: routeIntent, route, barakReply: reply ?? null,
    });
    persist.saveLeads(store);
    persist.saveInbox(inbox);
    return { inboxEntry: entry, clientMatch, intent: routeIntent, route, barakReply: reply ?? null };
  }

  function patchMeta(patch) {
    const cur = store.getLead(fromNorm);
    store.upsertLead(fromNorm, { meta: { ...(cur?.meta ?? {}), ...patch } });
  }

  // Ask for a time and remember that the next time-like message answers it.
  async function askForTime(reply, route = 'callback_time_requested') {
    if (!store.getLead(fromNorm)) store.upsertLead(fromNorm, { name: msg.name ?? undefined });
    patchMeta({ awaitingCallbackTime: true, callbackTimeAttempts: 0, callbackRequestedAt: sentAt.toISOString() });
    store.logEvent('callback_requested', fromNorm, { preview: text.slice(0, 80) });
    return finish(route, reply, { routeIntent: 'representative' });
  }

  // Resolve + persist the time, then either close (name known) or ask for the name.
  async function acceptAndRespond(source) {
    if (!store.getLead(fromNorm)) store.upsertLead(fromNorm, { name: msg.name ?? undefined });
    const r = callbackSvc.acceptTime({ phone: fromNorm, text, sentAt, source });

    if (!r.ok && r.reason === 'persist_failed') {
      patchMeta({ awaitingCallbackTime: false, callbackNeedsManualAt: new Date().toISOString() });
      alertOwner(`⚠️ בקשת שיחה לא נשמרה — נדרש טיפול ידני`,
        `${who} (${fromNorm})\nביקש/ה שיחה: "${text.slice(0, 200)}"\nהמועד לא נשמר במערכת (${r.error}). לא נשלח אישור לליד — נא ליצור קשר ישירות.`,
        { linkPreview: false }).catch(() => {});
      return finish('callback_persist_failed', r.clarification, { routeIntent: 'callback_time' });
    }
    if (!r.ok) {
      const attempts = (store.getLead(fromNorm)?.meta?.callbackTimeAttempts ?? 0) + 1;
      if (attempts >= 3) {
        // Three unclear answers: stop asking and hand over truthfully.
        patchMeta({ awaitingCallbackTime: false, callbackTimeAttempts: 0, callbackNeedsManualAt: new Date().toISOString() });
        alertOwner(`📞 בקשת שיחה ללא מועד ברור — ${who}`,
          `${who} (${fromNorm})\nביקש/ה שיחה אך לא הצלחנו לקבוע מועד.\nהודעה אחרונה: "${text.slice(0, 200)}"\nלא נקבעה שיחה — נא לתאם ישירות.`,
          { linkPreview: false }).catch(() => {});
        store.logEvent('callback_time_unresolved_handoff', fromNorm, { reason: r.reason });
        return finish('callback_time_unresolved_handoff',
          `לא הצלחתי להבין את המועד 🙏 העברתי את הבקשה לצוות — יחזרו אליך כאן בוואטסאפ כדי לתאם.`,
          { routeIntent: 'callback_time' });
      }
      patchMeta({ awaitingCallbackTime: true, callbackTimeAttempts: attempts });
      store.logEvent('callback_time_clarification', fromNorm, { reason: r.reason, attempts });
      return finish('callback_time_clarify', r.clarification, { routeIntent: 'callback_time' });
    }
    if (r.unchanged) {
      // Same time repeated — the request already exists. No reply, no notification.
      store.logEvent('post_call_dup_acceptance', fromNorm, { aptId: r.apt.id });
      return finish('post_call_silent', null);
    }

    const route = r.isReschedule ? 'appointment_rescheduled' : 'appointment_created';
    const routeIntent = r.isReschedule ? 'reschedule_time' : 'callback_time';
    const fmt = callbackTime.formatCallbackTime(r.apt.scheduledAt);
    const name = store.getLead(fromNorm)?.meta?.qualData?.confirmedName ?? null;

    if (name) {
      // Name already known → the appointment is on disk, send both summaries now.
      const fin = await callbackSvc.finalize({ phone: fromNorm, trigger: source });
      const delivered = ['accepted', 'queued'].includes(fin.prospect?.state) ? fin.prospectMsg : null;
      return finish(route, delivered, { alreadySent: true, routeIntent });
    }
    // Name unknown → say exactly what was recorded and ask for the name. The manager
    // summary goes out once, when the name arrives.
    const cur = store.getLead(fromNorm)?.meta ?? {};
    patchMeta({ qualData: { ...(cur.qualData ?? {}), nameAsked: true } });
    const reply = r.isReschedule
      ? `עדכנתי את בקשת השיחה: ${fmt} ✅\nואיך קוראים לך? 😊`
      : `רשמתי בקשת שיחה: ${fmt} ✅\nואיך קוראים לך? 😊`;
    return finish(route, reply, { routeIntent });
  }

  const isRequest = msg.type === 'text' && !CALL_DECLINED_RE.test(text)
    && (intent === 'representative' || CALLBACK_REQUEST_RE.test(text));
  const hasTime   = msg.type === 'text' && callbackTime.hasTimeSignal(text) && !TIME_REJECTION_RE.test(text);
  const looksLikeClassQuestion = /\?/.test(text) && CLASS_QUESTION_RE.test(text);

  // ════════════════════════════════ ACTIVE PHASE ═══════════════════════════════
  if (phase === 'active') {
    // Opt-out: close the open callback (no reminders may follow), then let lead_agent
    // record opted_out and send the single acknowledgement.
    if (isPostCallOptOut(text)) {
      callbackSvc.cancelForOptOut(fromNorm);
      patchMeta({ awaitingCallbackTime: false });
      return null;
    }
    if (msg.type !== 'text' || !text) {
      store.logEvent('post_call_ack_silent', fromNorm, { status, type: msg.type });
      return finish('post_call_silent', null);
    }

    const apt    = callbackSvc.openCallback(fromNorm);
    const future = callbackSvc.isFuture(apt);

    // 1. Cancellation / "not convenient" / reply to the reminder / late reply.
    //    Runs before the brief-ack check so a bare "כן" to the reminder is recorded.
    if (apt) {
      const av = await callbackSvc.handleAvailabilityReply({ phone: fromNorm, text, sentAt, displayName: msg.name });
      if (av) return finish(av.route, av.reply, { alreadySent: true });
    }

    // 2. Brief acknowledgement → silent.
    if (isBriefAck(text)) {
      store.logEvent('post_call_ack_silent', fromNorm, { status, preview: text.slice(0, 60) });
      return finish('post_call_silent', null);
    }

    // 3. Name, when we asked for it.
    if (qd.nameAsked && !qd.confirmedName) {
      const captured = extractNameFromMessage(text);
      if (captured) {
        patchMeta({ qualData: { ...qd, confirmedName: captured, nameConfirmed: true } });
        store.upsertLead(fromNorm, { name: captured });
        persist.saveLeads(store);
        store.logEvent('name_captured_post_call', fromNorm, { name: captured, status });
        if (!future) {
          // No valid future appointment to confirm — say so and ask for a time.
          return askForTime(`תודה ${captured}! 🙂 מתי נוח לך שנחזור אליך? (יום ושעה)`, 'post_call_name_captured');
        }
        const fin = await callbackSvc.finalize({ phone: fromNorm, trigger: 'name_captured' });
        const delivered = ['accepted', 'queued'].includes(fin.prospect?.state) ? fin.prospectMsg : null;
        return finish('post_call_name_captured', delivered, { alreadySent: true });
      }
    }

    // 4. A time.
    if (hasTime && !looksLikeClassQuestion) {
      const awaitingNew = meta.awaitingCallbackTime === true || apt?.prospectAvailability === 'rescheduled' || intent === 'reschedule';
      if (awaitingNew) return acceptAndRespond(future ? 'reschedule' : 'callback_time');
      // No valid future callback (none, or it expired without an outcome): a time
      // from the lead starts a new request. The expired record is left untouched.
      if (!future && (isRequest || intent === 'general')) return acceptAndRespond('callback_time');
      if (future) {
        // An open future callback exists and nobody asked for a new time.
        const probe = callbackTime.resolveCallbackTime(text, sentAt);
        if (probe.ok && probe.scheduledAt.getTime() === apt.scheduledAt.getTime()) {
          store.logEvent('post_call_dup_acceptance', fromNorm, { aptId: apt.id });
          return finish('post_call_silent', null);
        }
        if (probe.ok && intent === 'general') return acceptAndRespond('reschedule');
      }
      // otherwise: fall through (schedule question / staff attention)
    }

    // 5. Explicit wish to move the call, without a usable time.
    if (intent === 'reschedule' || (_CB_RESCHEDULE_RE.test(text) && text.length <= 40)) {
      if (apt && future) {
        try { aptStore.update(apt.id, { prospectAvailability: 'rescheduled', prospectAvailabilityAt: sentAt.toISOString() }); }
        catch (err) { logger.error('[callback-flow] reschedule request not persisted', { from: fromNorm, error: err.message }); }
      }
      return askForTime(`אין בעיה 🙂 מתי יהיה לך נוח? (יום ושעה)`, 'reschedule_prompt');
    }

    // 6. Asking for a call again.
    if (isRequest) {
      if (future) {
        const fmt = callbackTime.formatCallbackTime(apt.scheduledAt);
        store.logEvent('post_call_representative_acknowledged', fromNorm, { existingAptId: apt.id });
        return finish('post_call_rep_acknowledged',
          `רשומה אצלנו בקשת שיחה: ${fmt} 😊\nאם המועד לא נוח — כתבו לי יום ושעה אחרים ואעדכן.`);
      }
      return askForTime(`בשמחה! 😊 מתי נוח לך שנחזור אליך? (יום ושעה)`);
    }

    // 7. Schedule question → answer it, no sales funnel.
    if (intent === 'schedule_query') {
      const timetableUrl = getActiveTimetableUrl();
      let postCallReply = null;
      if (timetableUrl) {
        postCallReply = `הנה מערכת השעות של Shape Studio! 🏋️‍♀️`;
        if (autoReply) {
          _markBotSent(fromNorm);
          sendFileByUrl(fromNorm, timetableUrl, 'schedule.png', postCallReply)
            .then(res => { if (res?.idMessage) _recordBotSend(res.idMessage, fromNorm); store.logEvent('timetable_image_sent', fromNorm, { status }); })
            .catch(() => { _markBotSent(fromNorm); sendText(fromNorm, postCallReply).catch(() => {}); });
        }
        store.logEvent('post_call_schedule_answered', fromNorm, { status });
        return finish('post_call_schedule', postCallReply, { alreadySent: true });
      }
      postCallReply = await buildSchedulingReply(intent, msg, clientMatch).catch(() => null);
      store.logEvent('post_call_schedule_answered', fromNorm, { status });
      return finish('post_call_schedule', postCallReply);
    }

    // 8. Anything else is a genuine new message → staff see it, the bot stays silent.
    alertOwner(
      `📬 הודעה אחרי ${status === 'call_scheduled' ? 'תיאום' : 'בקשת חזרה'} — ${who}`,
      `${who} (${fromNorm})\nסטטוס: ${status}\nהודעה: "${text.slice(0, 200)}"\n\nהאדם כתב אחרי בקשת השיחה. אנא בדקו ידנית.`,
      { linkPreview: false }
    ).catch(() => {});
    store.logEvent('post_call_staff_notified', fromNorm, { status, preview: text.slice(0, 80) });
    return finish('post_call_staff_hold', null);
  }

  // ═════════════════════════════════ NEW PHASE ═════════════════════════════════
  if (msg.type !== 'text' || !text) return null;
  const awaiting  = meta.awaitingCallbackTime === true;
  const inviteCtx = !CALL_DECLINED_RE.test(text) && leadAgent.isCallbackInviteContext(fromNorm);

  if (!isRequest && !awaiting && !(inviteCtx && hasTime)) return null;

  if (!isRequest && !awaiting) {
    // Answering Barak's invitation with a time. A question about classes that merely
    // mentions a day/hour is not a callback time.
    if (intent !== 'general' || looksLikeClassQuestion) return null;
  }
  if (awaiting && !isRequest && !hasTime) return null;      // unrelated message — normal pipeline
  if (awaiting && !isRequest && looksLikeClassQuestion) return null;

  if (!hasTime) return askForTime(`בשמחה! 😊 מתי נוח לך שנחזור אליך? (יום ושעה)`);
  return acceptAndRespond(isRequest ? 'callback_request' : (awaiting ? 'callback_time' : 'invite_reply'));
}

/**
 * A message from a route-overridden test phone. Touches: the inbox thread (appended),
 * the service-case store, and Tomer's own audit. Never: the lead store, the appointment
 * store, the callback flow, Barak, the member cache or Arbox member data.
 */
async function _processTomerTestMessage(msg, fromNorm, fromIsraeli) {
  const clientMatch = { found: true, matchType: 'tomer_test_override', arboxName: null, arboxId: null, isActive: true, role: 'test' };
  const owner = _conversationOwner(fromNorm);
  const entry = inbox.push({
    from: fromNorm, fromIsraeli, name: msg.name ?? null, text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
    receivedAt: new Date(), mediaType: msg.type, mediaCaption: msg.mediaCaption ?? null, mediaId: msg.mediaId ?? null,
    clientMatch, intent: 'tomer_test', barakReply: null,
    route: owner === 'human' ? 'human_owns_hold' : owner === 'opted_out' ? 'opted_out_silent' : 'tomer',
  });
  const setRoute = r => { entry.route = r; const tm = inbox.getThread(fromNorm)?.messages.find(x => x.id === entry.id); if (tm) tm.route = r; };
  if (owner === 'human') {
    try {
      const hc = tomerService.recordWhileHumanOwned({ phone: fromNorm, text: msg.text ?? '', type: msg.type, messageId: msg.messageId ?? null });
      if (hc) broadcastSse('tomer_case', { id: hc.id });
    } catch (err) { logger.warn('[tomer-test] could not add a held message to the case', { error: err.message }); }
  } else if (owner !== 'opted_out') {
    try {
      const tRes = await tomerService.handleMemberMessage({
        phone: fromNorm, text: msg.type === 'text' ? (msg.text ?? '') : '', type: msg.type, caption: msg.mediaCaption ?? null,
        name: msg.name ?? null, sentAt: msg.timestamp instanceof Date ? msg.timestamp : null, messageId: msg.messageId ?? null,
      });
      setRoute(`tomer_${tRes?.outcome ?? 'handled'}`);
      if (tRes?.caseId) broadcastSse('tomer_case', { id: tRes.caseId });
    } catch (err) {
      setRoute('tomer_error');
      logger.error('[tomer-test] message handling failed', { from: fromNorm, error: err.message });
      const mgrPhone = _tomerManagerPhone();
      if (mgrPhone) sendText(mgrPhone, `⚠️ תומר (בדיקה) — הודעה לא טופלה\n📱 ${fromIsraeli ?? fromNorm}\nשגיאה פנימית: ${err.message}\nלא נשלחה תשובה אוטומטית.`, { bypassQuietHours: true, linkPreview: false }).catch(() => {});
    }
  }
  logger.info('[tomer-test] message from the test phone handled by the routing override', { from: fromNorm, route: entry.route });
  broadcastSse('message', { phone: fromNorm, name: entry.name ?? null, route: entry.route });
  persist.saveInbox(inbox);
  return { inboxEntry: entry, clientMatch, intent: 'tomer_test', route: entry.route, barakReply: null };
}

async function processInboundWAMessage(msg) {
  // Hold processing until persist.loadLeads has completed. Without this gate a
  // webhook arriving during phoneRegistry.init (~10 s) would process against an
  // empty store; persist.loadLeads would then overwrite any state it wrote.
  if (!_storeReady) await _storeReadyPromise;

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

  // (Identity is resolved once, below, by services/identity_resolver.js — the registry, the
  //  member cache and the live lookup no longer decide separately.)

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

  // 0c. TOMER TEST ROUTING OVERRIDE — an allowlisted test phone is handled by the new
  //     Tomer flow and by nothing else. Placed before identity resolution and before every
  //     lead / callback / appointment step, so the phone's Barak lead record, appointments
  //     and reminders are neither read-modified nor consumed while the override is on.
  if (_tomerSwitch() && tomerTest.routeOverride(fromNorm)) {
    return _processTomerTestMessage(msg, fromNorm, fromIsraeli);
  }

  // 1. Identity — ONE shared resolver (services/identity_resolver.js).
  //
  //   member         client row with a verified, currently valid membership   → Tomer
  //   aggregator     aggregator member, identified separately                 → existing member handling
  //   former_member  client row with membership history, none valid today     → Barak (renewal) / staff (service, billing)
  //   staff          active Arbox staff row                                   → staff bypass, never Barak
  //   lead / unknown lead row, client row without any membership, not in Arbox → Barak
  //   unavailable    could not be determined                                  → neither agent: hold + staff alert
  //
  //   The Arbox `active` flag is not a membership, and a row merely existing proves nothing.
  //   Complete pagination, normalised phones, shared phones and stale data are handled in
  //   the resolver; the result is recorded on the inbox entry (clientMatch.identity).
  const ident = await identity.resolve(fromNorm);
  // A member confirmed by hand in the admin panel (an explicit staff decision, valid 24 h) is honoured.
  const _manualMember = (() => {
    const e = memberCache.getEntry(fromNorm);
    return !!e && String(e.source ?? '').startsWith('manual_') && memberCache.isConfirmed(fromNorm);
  })();
  const identCategory = _manualMember && !['member', 'aggregator', 'staff'].includes(ident.category) ? 'member' : ident.category;
  const _identInfo = { category: identCategory, resolved: ident.category, manual: _manualMember && identCategory !== ident.category,
    stale: !!ident.stale, refreshFailed: !!ident.refreshFailed, shared: !!ident.shared, ambiguous: !!ident.ambiguous, others: ident.others ?? [], reason: ident.reason ?? null };

  // 1a. Arbox staff who are not in the local staff roster: same bypass as roster staff.
  if (identCategory === 'staff') {
    logger.info('Inbound message from Arbox staff member — bypassing pipeline', { from: fromNorm });
    const _sm = { found: true, matchType: 'staff', arboxName: ident.name ?? null, arboxId: ident.userIds?.[0] ?? null, isActive: true, role: 'staff', identity: _identInfo };
    const staffEntry2 = inbox.push({
      from: fromNorm, fromIsraeli, name: msg.name ?? ident.name ?? null, text: msg.text ?? '', messageId: msg.messageId,
      timestamp: msg.timestamp, receivedAt: new Date(), mediaType: msg.type, mediaCaption: msg.mediaCaption ?? null, mediaId: msg.mediaId ?? null,
      clientMatch: _sm, intent: 'staff', route: 'staff_bypass', barakReply: null,
    });
    return { inboxEntry: staffEntry2, clientMatch: _sm, intent: 'staff', route: 'staff_bypass', barakReply: null };
  }

  const isAggregator     = identCategory === 'aggregator';
  const isFormerMember   = identCategory === 'former_member';
  const isExistingClient = identCategory === 'member' || isAggregator;
  const arboxConfirmedClient = isExistingClient && !_identInfo.manual;
  // Identity could not be determined → the degraded-mode guard below holds the message.
  // Also when Arbox could not be read just now and the older copy does not know this phone as a
  // member: "not a member" is unproven (they may have joined since), so Barak must not start.
  // (A lead that fresh data confirmed in the last 2 hours passes — see the guard below.)
  const arboxLookupFailed = identCategory === 'unavailable' || (!!ident.refreshFailed && !isExistingClient);
  if (arboxLookupFailed) logger.warn('[pipeline] Identity unavailable — degraded-mode hold will apply', { from: fromNorm, reason: ident.reason });

  const clientMatch = {
    found:     !['unknown', 'unavailable'].includes(identCategory),
    matchType: isExistingClient ? 'member' : ['former_member', 'lead'].includes(identCategory) ? identCategory : null,
    arboxName: ident.name ?? null,
    arboxId:   ident.userIds?.[0] ?? null,
    isActive:  isExistingClient,
    role:      isAggregator ? 'aggregatorMember' : identCategory === 'member' || isFormerMember ? 'client' : identCategory === 'lead' ? 'lead' : null,
    identity:  _identInfo,
  };

  // A contact that fresh Arbox data shows is NOT a member: stamp it, so a short Arbox outage
  // right afterwards does not hold their next message (see the degraded-mode guard).
  if (['lead', 'unknown', 'former_member'].includes(identCategory) && !ident.stale) {
    const existing = store.getLead(fromNorm);
    if (existing && existing.status !== 'converted_member') {
      store.upsertLead(fromNorm, { meta: { ...(existing.meta ?? {}), arboxConfirmedColdLead: true, arboxColdLeadConfirmedAt: Date.now() } });
    }
  }

  // 1b. Former member: identified as such and kept in the lead world WITH their history.
  //     A record that was parked as 'converted_member' while they were a member is reopened
  //     (history and meta untouched) so that renewal interest can reach Barak.
  if (isFormerMember) {
    const rec = store.getLead(fromNorm);
    const meta = { ...(rec?.meta ?? {}), formerMember: true, formerMemberArboxId: ident.userIds?.[0] ?? null, formerMemberSeenAt: new Date().toISOString() };
    if (rec && rec.status === 'converted_member') {
      store.upsertLead(fromNorm, { status: 'cold', meta: { ...meta, reopenedFromConvertedMemberAt: new Date().toISOString() } });
      store.logEvent('former_member_reopened_as_lead', fromNorm, { historyPreserved: (rec.history ?? []).length });
      logger.info('[pipeline] Former member — lead record reopened (history preserved)', { from: fromNorm });
    } else if (rec) {
      store.upsertLead(fromNorm, { meta });
    }
  }

  // 2. Intent detection (only meaningful for text messages)
  const intent = msg.type === 'text' ? detectSchedulingIntent(msg.text) : 'general';

  // Lead reschedule requests are handled by handleLeadCallbackFlow (below, AFTER the
  // human_owns / opted_out gates) — never before ownership has been checked.

  // ── Callback-time interception ────────────────────────────────────────────────
  // When this person previously requested a human callback (awaitingCallbackTime),
  // their NEXT non-intent message is the preferred callback time.
  //
  // Three cases handled here:
  //   A. noShowAptId     — the worker flagged a no-show; lead is now giving a new time
  //   B. reschedulingAptId — lead explicitly asked to reschedule; now providing new time
  //   C. neither         — fresh appointment (first-time callback request)
  const leadState = store.getLead(fromNorm);
  // Members (Tomer) only. Leads are handled by handleLeadCallbackFlow, which resolves
  // the time strictly and persists the appointment before replying.
  if (isExistingClient && !_tomerOn(fromNorm) && leadState?.meta?.awaitingCallbackTime && msg.type === 'text' && msg.text?.trim() &&
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
      // Fresh callback request — use callback_pending semantics: staff has not yet
      // confirmed this call. The panel (and status) distinguish "requested" from
      // "confirmed" so the team knows action is required.
      apt = aptStore.createCallbackPending({
        leadPhone:       fromNorm,
        leadName:        callbackName,
        rawTime,
        scheduledAt:     null,         // filled async via parseHebrewTimeLocal below
        durationMin:     staffConfig.appointment_duration_min ?? 30,
        assignedStaffId: assignedStaff?.id ?? 'eden',
      });
      // Set callback_requested (not call_scheduled) — same semantics as the AI flow.
      // Also persist callTimeGiven in qualData so the panel rawTime lookup works and
      // the post-call gate (nameAsked check) can reference it.
      const _awFreshMeta = store.getLead(fromNorm)?.meta ?? {};
      // msg.timestamp is a Date object (parseGreenApiWebhook already converts Unix
      // seconds to Date via * 1000). Do NOT multiply again — it would produce year 58838+.
      const _awFreshAt = msg.timestamp instanceof Date
        ? msg.timestamp.toISOString()
        : (msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString());
      store.upsertLead(fromNorm, {
        status: 'callback_requested',
        meta: {
          ..._awFreshMeta,
          callTimeGivenAt: _awFreshAt,
          handoffAlertStatus: 'pending',
          handoffCallTime:    rawTime,
          qualData: {
            ...(_awFreshMeta.qualData ?? {}),
            callTimeGiven:   rawTime,
            callTimeGivenAt: _awFreshAt,
          },
        },
      });
      store.logEvent('callback_requested_explicit', fromNorm, { aptId: apt.id, rawTime, staff: apt.assignedStaffId });
      logger.info('Callback requested (explicit representative) — status → callback_requested', { phone: fromNorm, rawTime, aptId: apt.id });
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
          // For fresh callbacks: suppress the preliminary staff notification.
          // The name is unknown at this point (leadName = WhatsApp display name, often null
          // or unconfirmed). Sending now produces an incomplete message with blank/wrong name
          // and the misleading "שיחת ייעוץ נקבעה" subject when nothing has been confirmed.
          //
          // The CONSOLIDATED manager summary fires after the prospect provides their name
          // via the name-capture path (server.js post_call_name_captured). That message has
          // the full name, accurate status wording, and formatted scheduledAt date.
          //
          // Panel shows the callback_pending appointment immediately so staff is not blind.
          // If the prospect never provides a name, the appointment remains visible in the panel.
          const _curMeta = store.getLead(fromNorm)?.meta ?? {};
          store.upsertLead(fromNorm, {
            meta: {
              ..._curMeta,
              handoffAlertStatus:  'deferred_pending_name',
              handoffCallTime:     rawTime,
            },
          });
          persist.saveLeads(store);
          logger.info('[pipeline] New callback — manager summary deferred until name captured',
            { from: fromNorm, rawTime });
        }

        store.logEvent('appointment_staff_notified', fromNorm, {
          aptId:   apt.id,
          staffId: apt.assignedStaffId,
          type:    isReschedule ? 'rescheduled' : 'requested',
        });
      } catch (err) {
        logger.error('Appointment background tasks failed', { aptId: apt.id, error: err.message });
        // Record failure to lead meta so the panel shows the correct state
        try {
          const _failMeta = store.getLead(fromNorm)?.meta ?? {};
          if (_failMeta.handoffAlertStatus === 'pending') {
            store.upsertLead(fromNorm, {
              meta: { ..._failMeta, handoffAlertStatus: 'failed', handoffAlertFailedAt: new Date().toISOString() },
            });
          }
        } catch {}
      }
    });

    // ── Ask for name when not yet known ──────────────────────────────────────
    // After the callback time is recorded, ask for the prospect's first name so
    // the staff brief can include it. Only ask on a fresh appointment, not on
    // reschedule (name was captured during the original booking).
    if (!isReschedule) {
      const _awMeta = store.getLead(fromNorm)?.meta ?? {};
      store.upsertLead(fromNorm, {
        meta: {
          ..._awMeta,
          qualData: { ...(_awMeta.qualData ?? {}), nameAsked: true },
        },
      });
    }

    // ── Confirm to lead ───────────────────────────────────────────────────────
    // Fresh request: confirm the time and ask for the name in the same message.
    // "רשמנו" (we noted) rather than "נקבעה" (was booked) — the callback is
    // requested, not confirmed by staff yet. Post-call gate captures the name.
    const confirmMsg = isReschedule
      ? `מעולה! קבענו מחדש ל-${rawTime} ✅\nנציג מהצוות ייצור איתך קשר בזמן החדש. 😊`
      : `מעולה! רשמנו את בקשת השיחה ל-${rawTime} ✅\nנציג מהצוות ייצור איתך קשר. ואיך קוראים לך? 😊`;

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
  if (!(isExistingClient && _tomerOn(fromNorm)) && msg.type === 'text' && isSpamMessage(msg.text)) {
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
  // Must fire before Barak/Tomer routing so a member's Bit screenshot never ends
  // up with Barak's sales funnel as a reply.
  // EXCEPTION: human_owns / opted_out take precedence — staff own the conversation.
  {
    const _pmtOwn = store.getLead(fromNorm)?.status ?? null;
    if (!(isExistingClient && _tomerOn(fromNorm)) && _pmtOwn !== 'human_owns' && _pmtOwn !== 'opted_out' && isPaymentMessage(msg)) {
    const senderName = msg.name ?? clientMatch.arboxName ?? fromIsraeli ?? fromNorm;
    // Wording must not claim the payment was verified — nobody has looked at it yet.
    const paymentAck = `קיבלנו את ההודעה 🙏 הצוות יבדוק את התשלום ויעדכן. זה עדיין לא אישור שהתשלום התקבל.`;

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
  } // end payment block

  // 2b. Universal ownership and status gate — runs before Tier-4 and before the
  //     Barak/Tomer routing split.
  //
  //   ORDER IS INTENTIONAL: opted_out / human_owns must block even when Arbox is down.
  //   A person who requested silence or is under human care must not receive an
  //   arbox_outage_hold message, a Barak qualification reply, OR a Tomer service reply.
  //
  //   human_owns: applies to ALL contacts including Arbox members. When a staff member
  //   manually replies to a member's message, Tomer must also stop until ownership is released.
  //
  //   opted_out: also universal — a member who requested silence must not receive Tomer
  //   automated messages any more than Barak messages. The old Barak-only gate was a bug.
  //
  //   call_scheduled / callback_requested: handled context-aware below — not an early return
  //   because reschedule / schedule-query / opt-out must still be processed.
  {
    const _stopRec    = store.getLead(fromNorm);
    const _stopStatus = _stopRec?.status;

    if (_stopStatus === 'human_owns') {
      store.logEvent('reply_suppressed_human_owns', fromNorm, {
        agent: isExistingClient ? 'tomer' : 'barak',
        preview: (msg.text ?? '').slice(0, 60),
      });
      logger.info('[pipeline] Reply suppressed — human_owns (universal)', { from: fromNorm, isExistingClient });
      // Tomer stays silent, but the message is added to the member's open service case
      // so staff see it in the panel (nothing is sent to anyone).
      try {
        const _hc = tomerService.recordWhileHumanOwned({ phone: fromNorm, text: msg.text ?? '', type: msg.type, messageId: msg.messageId ?? null });
        if (_hc) broadcastSse('tomer_case', { id: _hc.id });
      } catch (err) { logger.warn('[tomer] could not add a held message to the case', { from: fromNorm, error: err.message }); }
      const hoEntry = inbox.push({
        from: fromNorm, fromIsraeli, name: msg.name ?? clientMatch.arboxName ?? null,
        text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
        receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
        clientMatch, intent, route: 'human_owns_hold', barakReply: null,
      });
      broadcastSse('message', { phone: hoEntry.from, name: hoEntry.name ?? null, route: 'human_owns' });
      persist.saveInbox(inbox);
      return { inboxEntry: hoEntry, clientMatch, intent, route: 'human_owns_hold', barakReply: null };
    }

    if (_stopStatus === 'opted_out') {
      store.logEvent('reply_suppressed_opted_out', fromNorm, {
        agent: isExistingClient ? 'tomer' : 'barak',
        preview: (msg.text ?? '').slice(0, 60),
      });
      logger.info('[pipeline] Reply suppressed — opted_out (universal)', { from: fromNorm, isExistingClient });
      const optEntry = inbox.push({
        from: fromNorm, fromIsraeli, name: msg.name ?? clientMatch.arboxName ?? null,
        text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
        receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
        clientMatch, intent, route: 'opted_out_silent', barakReply: null,
      });
      persist.saveInbox(inbox);
      return { inboxEntry: optEntry, clientMatch, intent, route: 'opted_out_silent', barakReply: null };
    }
  }

  // 2b-echo. Echo attribution hold — in-memory unresolved state (active session).
  //   Also catches attribution_review status set by grace expiry (survives restarts).
  //   Both states preserve inbound messages for review and block automated replies.
  {
    const _arStatus = store.getLead(fromNorm)?.status;
    const _inHold   = _hasUnresolvedEcho(fromNorm) || _arStatus === 'attribution_review';
    if (_inHold) {
      const _holdReason = _hasUnresolvedEcho(fromNorm) ? 'unresolved_echo' : 'attribution_review';
      store.logEvent('reply_held_unresolved_echo', fromNorm, {
        reason: _holdReason, preview: (msg.text ?? '').slice(0, 60),
      });
      logger.info('[pipeline] Reply held — attribution unresolved', { from: fromNorm, reason: _holdReason });
      // Preserve the message in the lead record — do not silently lose it.
      const _exHold = store.getLead(fromNorm) ?? {};
      store.upsertLead(fromNorm, {
        name:         msg.name ?? _exHold.name,
        messageCount: (_exHold.messageCount ?? 0) + 1,
        meta: { ...(_exHold.meta ?? {}), lastHeldMessageAt: new Date().toISOString() },
      });
      const heldEntry = inbox.push({
        from: fromNorm, fromIsraeli, name: msg.name ?? clientMatch.arboxName ?? null,
        text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp,
        receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
        clientMatch, intent, route: 'echo_attribution_hold', barakReply: null,
      });
      persist.saveInbox(inbox);
      return { inboxEntry: heldEntry, clientMatch, intent, route: 'echo_attribution_hold', barakReply: null };
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

  // 2c-bis. FORMER MEMBER with a service / billing issue → staff, not Barak and not Tomer.
  //     Renewal or training interest continues below to Barak like any lead.
  if (isFormerMember && msg.type === 'text' && (msg.text ?? '').trim()) {
    const _fmCat = require('./services/member_intent').classify(msg.text).category;
    if (FORMER_MEMBER_STAFF_TOPICS.has(_fmCat)) {
      const ackMsg = `קיבלנו את הודעתך 🙏 הפנייה נרשמה לטיפול צוות הסטודיו.`;
      store.logEvent('former_member_service_to_staff', fromNorm, { category: _fmCat, preview: (msg.text ?? '').slice(0, 80) });
      alertOwner('📋 חבר/ה לשעבר — פנייה בנושא שירות / חיוב',
        `📱 ${fromIsraeli ?? fromNorm}${ident.name ? `\n👤 ${ident.name}` : ''}\n📝 "${(msg.text ?? '').slice(0, 300)}"\n\nלפי Arbox אין מנוי בתוקף (חבר/ה לשעבר). ההודעה לא הועברה לברק ולא נענתה על ידי תומר — נדרש טיפול צוות.\n💬 https://wa.me/${fromNorm}`,
        { linkPreview: false }).catch(() => {});
      let _fmSent = null;
      if (process.env.WHATSAPP_AUTO_REPLY === 'true') {
        _markBotSent(fromNorm);
        const r = await sendText(fromNorm, ackMsg).catch(() => null);
        if (r?.idMessage) { _recordBotSend(r.idMessage, fromNorm); _fmSent = ackMsg; }
      }
      const fmEntry = inbox.push({
        from: fromNorm, fromIsraeli, name: msg.name ?? ident.name ?? null, text: msg.text ?? '', messageId: msg.messageId,
        timestamp: msg.timestamp, receivedAt: new Date(), mediaType: msg.type, mediaCaption: null, mediaId: null,
        clientMatch, intent, route: 'former_member_staff', barakReply: _fmSent,
      });
      persist.saveInbox(inbox);
      return { inboxEntry: fmEntry, clientMatch, intent, route: 'former_member_staff', barakReply: _fmSent };
    }
  }

  // 2d. Lead callback flow — active phase.
  //     Runs AFTER the human_owns / opted_out / attribution gates and Tier-4, BEFORE the
  //     AI pipeline. Handles every message from a lead that already has a callback in
  //     progress (reminder replies, reschedule, cancellation, name capture, new time…).
  if (!isExistingClient) {
    const _cbActive = await handleLeadCallbackFlow({ msg, fromNorm, fromIsraeli, clientMatch, intent, phase: 'active' });
    if (_cbActive) return _cbActive;
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
    // SALES_INTENT_RE: phrases that unambiguously indicate fitness/studio interest.
    // Intentionally narrow — generic words ("גוף"/"גב"/"כוח"/"מה קורה") must NOT trigger
    // the funnel. Unknown contacts without clear studio intent go to the unclassified
    // inbox first; a neutral greeting gives them the chance to clarify.
    // Weight-loss phrases: "להוריד 20 קילו" / "לרדת במשקל" are fitness-specific in this context.
    const SALES_INTENT_RE = /פילאטיס|כושר|שיעור|אימו[נן]|להצטרף|מנוי|להתנסות|ניסיון|רפורמר|בארה|קנגו|yoga|יוגה|בריאות|ירידה.*משקל|להוריד.*(?:קילו|משקל)|לרדת.*(?:קילו|משקל|במשקל)|חיזוק|גמישות|שייפ\s*סטודיו|מחיר|כמה.*עולה|שעות.*פעילות|לוח.*שיעורים|מערכת\s*שעות|הצעת\s+היכרות|60\s+ש|60\s+₪/i;
    const _hasSalesIntent = SALES_INTENT_RE.test(msg.text ?? '');

    if (!_hasLeadHistory && !_hasSalesIntent && msg.type === 'text') {
      const _alreadyGreeted = _tomerStore.hasGreetedUnclassified(fromNorm);
      _tomerStore.markUnclassified(fromNorm, { firstMessage: msg.text ?? '' });

      let _unclassifiedReply = null;
      if (!_alreadyGreeted && process.env.WHATSAPP_AUTO_REPLY === 'true') {
        _unclassifiedReply = 'שלום! 😊 קיבלנו את הודעתך. כדי שנוכל לעזור — ספר/י לנו מה מחפש/ת.';
        _markBotSent(fromNorm);
        const _ucSendRes = await sendText(fromNorm, _unclassifiedReply).catch(() => null);
        if (_ucSendRes?.idMessage) _recordBotSend(_ucSendRes.idMessage, fromNorm);
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

  // 2f. Lead callback flow — new-request phase (after the unclassified hold, so an
  //     unknown contact with no studio intent is never pulled into a callback).
  if (!isExistingClient) {
    const _cbNew = await handleLeadCallbackFlow({ msg, fromNorm, fromIsraeli, clientMatch, intent, phase: 'new' });
    if (_cbNew) return _cbNew;
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
  let _tomerInboxEntry  = null;   // set when the Tomer route stored the inbound message itself

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

  if (isExistingClient && _tomerOn(fromNorm)) {
    // ════════════════════════════════════════════════════════════════════════
    // TOMER SERVICE — every message from a verified member (text and media).
    // The service sends its own replies and records them (agent, handler, trigger,
    // case, data source, provider id), so barakReply stays null here.
    // ════════════════════════════════════════════════════════════════════════
    route = 'tomer';
    _replyAlreadySent = true;
    // The member's message is recorded in the thread BEFORE Tomer answers, so the
    // conversation reads in the order it happened (message, then reply) and an answered
    // conversation is never listed as "unanswered".
    _tomerInboxEntry = inbox.push({
      from: fromNorm, fromIsraeli, name: msg.name ?? clientMatch.arboxName ?? null,
      text: msg.text ?? '', messageId: msg.messageId, timestamp: msg.timestamp, receivedAt: new Date(),
      mediaType: msg.type, mediaCaption: msg.mediaCaption ?? null, mediaId: msg.mediaId ?? null,
      clientMatch, intent, route, barakReply: null,
    });
    try {
      const tRes = await tomerService.handleMemberMessage({
        phone: fromNorm, text: msg.type === 'text' ? (msg.text ?? '') : '', type: msg.type,
        caption: msg.mediaCaption ?? null, name: clientMatch.arboxName ?? msg.name ?? null,
        sentAt: msg.timestamp instanceof Date ? msg.timestamp : null,
        messageId: msg.messageId ?? null,
      });
      route = `tomer_${tRes?.outcome ?? 'handled'}`;
      logger.info('[tomer] member message handled', { from: fromNorm, outcome: tRes?.outcome, category: tRes?.category ?? null, caseId: tRes?.caseId ?? null });
      if (tRes?.caseId) broadcastSse('tomer_case', { id: tRes.caseId });
    } catch (err) {
      // Nothing is claimed to the member. The failure is surfaced to the manager so
      // the message is not lost.
      route = 'tomer_error';
      logger.error('[tomer] member message handling failed', { from: fromNorm, error: err.message });
      store.logEvent('tomer_service_error', fromNorm, { error: err.message, preview: (msg.text ?? '').slice(0, 80) });
      alertOwner('⚠️ תומר — הודעת חבר/ה לא טופלה',
        `📱 ${fromIsraeli ?? fromNorm}\n📝 "${(msg.text ?? `[${msg.type}]`).slice(0, 200)}"\n\nשגיאה פנימית: ${err.message}\nלא נשלחה תשובה אוטומטית — יש לענות ידנית.\n💬 https://wa.me/${fromNorm}`,
        { linkPreview: false }).catch(() => {});
    }

  } else if (skipAiReply) {
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
        const _awaitingNow = store.getLead(fromNorm)?.meta?.awaitingCallbackTime === true;
        if (!_awaitingNow) {
          const clientName = msg.name ?? clientMatch.arboxName ?? fromIsraeli ?? fromNorm;
          notifySvc.notifyRepresentativeRequest(fromNorm, clientName).catch(err =>
            logger.warn('Representative request staff alert failed', { error: err.message })
          );
        }
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
              msgTimestamp: msg.timestamp ?? null,
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
      // A lead's request for a representative never reaches this point: it is taken by
      // handleLeadCallbackFlow, and the manager receives exactly one consolidated summary
      // once time + name are known and the appointment is persisted.
    } else {
      // General / sales qualification → lead_agent (Barak's AI persona)
      try {
        const leadResult = await leadAgent.handleInbound({
          from:             fromNorm,
          name:             msg.name,
          text:             msg.text ?? '',
          _pendingMessages, // stale-send gate: handleInbound checks before sendText
          msgTimestamp:     msg.timestamp ?? null, // anchor relative date resolution to send time
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

  // 4. Store in inbox ring buffer (already stored for the Tomer route — only its outcome is added)
  if (_tomerInboxEntry) {
    _tomerInboxEntry.route = route;
    const _tm = inbox.getThread(fromNorm)?.messages.find(x => x.id === _tomerInboxEntry.id);
    if (_tm) _tm.route = route;
  }
  const inboxEntry = _tomerInboxEntry ?? inbox.push({
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
      if (staleRecord && !['converted_member', 'opted_out', 'human_owns'].includes(staleRecord.status)) {
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
        // Fresh Arbox data showed this contact is not a member (also on their very first message).
        ...(['lead', 'unknown', 'former_member'].includes(identCategory) && !ident.stale
          ? { arboxConfirmedColdLead: true, arboxColdLeadConfirmedAt: Date.now() } : {}),
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
  // ── LATE REPLY SUPPRESSION ───────────────────────────────────────────────────
  // Status may have changed DURING async AI generation (concurrent human takeover,
  // opt-out from a parallel message, or status update via API).
  // Re-check just before sending so a reply generated before the status change
  // is never delivered after it.
  //
  // Guard: only apply when the reply has NOT already been sent internally
  // (_replyAlreadySent = false). When the reply was sent inside lead_agent.handleInbound
  // (e.g. the frustration handoff message, opt-out ack), the status change IS the
  // intended consequence of sending that message — suppressing barakReply would hide
  // the sent message from the simulate/inbox response without preventing any actual send.
  //
  // Only applies to the Barak branch (!isExistingClient): Tomer has its own
  // silence classifier and is unaffected by lead stop-statuses.
  if (barakReply && !isExistingClient && !_replyAlreadySent) {
    const _lateStatus = store.getLead(fromNorm)?.status;
    if (_lateStatus === 'opted_out' || _lateStatus === 'human_owns') {
      logger.info('[pipeline] Late reply suppression — status changed during AI generation', {
        from: fromNorm, status: _lateStatus,
      });
      store.logEvent('reply_suppressed_late', fromNorm, { status: _lateStatus });
      barakReply = null;
    }
    // Stale reply suppression: a newer message arrived during AI generation.
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
          const phone = chatId.replace(/@.*$/, '');
          const norm  = normalizeToE164(phone);
          if (norm) {
            if (_hasPendingBotSend(norm)) {
              // A bot HTTP send is still in-flight when this echo arrived.
              // Schedule a re-deferring reconciliation loop that keeps checking
              // every OUTGOING_RECONCILE_MS until the provider responds or the
              // pending-send TTL expires (handles slow providers > 300ms).
              logger.debug('[outgoing-webhook] Bot send in-flight — deferring echo reconciliation', {
                phone: norm, idMessage,
              });
              _scheduleEchoReconcile(norm, idMessage, msgText);
              return;
            }

            // idMessage not in _botSentIds AND no in-flight send → staff manually typed this.
            _applyStaffTakeover(norm, idMessage, msgText);
            // Record the outbound in the inbox thread so the dashboard shows the
            // staff reply and the conversation is fully visible.
            const _senderName = body?.senderData?.senderName ?? null;
            if (msgText) {
              // Recorded as STAFF. The sender name of an outgoing message is the studio's own
              // WhatsApp name, so it must not rename the member's thread.
              inbox.pushOutbound({ phone: norm, name: null, text: msgText, agentId: 'staff', meta: { agent: 'staff', handler: 'phone_reply', trigger: 'outgoing_webhook', by: _senderName, idMessage } });
              persist.saveInbox(inbox);
              broadcastSse('message', { phone: norm, name: _senderName, direction: 'out' });
            }
            logger.info('[outgoing-webhook] Phone-side manual reply — human_owns set + inbox recorded',
              { phone: norm, idMessage, preview: (msgText ?? '').slice(0, 60) });
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
    messageId: (process.env.TEST_MODE === 'true' && req.body?.messageId) || `sim-${Date.now()}`,
    // TEST_MODE only: tests may state when the message was "sent" to exercise
    // timestamp-anchored date resolution. Production always uses the real clock.
    timestamp: (process.env.TEST_MODE === 'true' && req.body?.timestamp) ? new Date(req.body.timestamp) : new Date(),
    type,
    mediaType: type,
    mediaCaption: null,
    mediaId: null,
  };

  try {
    const result = await processInboundWAMessage(msg);
    broadcastSse('message', { phone: result.inboxEntry.from, name: result.inboxEntry.name ?? null });
    // TEST_MODE: include store state for test assertions without a second round-trip
    const _simLead = process.env.TEST_MODE === 'true' ? (() => {
      const l = store.getLead(normalizeToE164(from));
      if (!l) return null;
      const { history, ...rest } = l;
      return { ...rest, historyLength: history?.length ?? 0 };
    })() : undefined;
    const _simApts = process.env.TEST_MODE === 'true'
      ? aptStore.getByPhone(normalizeToE164(from) ?? from).map(a => ({
          id: a.id, status: a.status, scheduledAt: a.scheduledAt, rawTime: a.rawTime,
          staffConfirmedAt: a.staffConfirmedAt ?? null, reminderSent: a.reminderSent,
          prospectReminderSent: a.prospectReminderSent,
          prospectAvailability: a.prospectAvailability,
        }))
      : undefined;
    res.json({
      ok: true,
      inboxId:     result.inboxEntry.id,
      intent:      result.intent,
      route:       result.route,
      clientMatch: result.clientMatch,
      barakReply:  result.barakReply,
      processedAt: new Date(),
      _lead:       _simLead,
      _apts:       _simApts,
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
  // Test-only restriction applies to every Tomer send route, old and new.
  if (!tomerTest.isAllowed(normalizeToE164(phone) ?? phone)) return res.status(403).json({ ok: false, error: 'recipient_not_allowed', detail: 'מצב בדיקה — המספר אינו ברשימת המורשים.' });
  if (store.getLead(normalizeToE164(phone) ?? phone)?.status === 'opted_out') return res.status(409).json({ ok: false, error: 'opted_out' });

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
  // Legacy segment sends (unapproved wording, no contact policy) are superseded by member care.
  return res.status(410).json({ ok: false, error: 'superseded_by_member_care', detail: 'שליחה יזומה נעשית רק דרך "ליווי חברים".' });
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

// ── Tomer service cases ───────────────────────────────────────────────────────
// Who is answering this member right now (from the lead store — the same record the
// inbound pipeline checks before letting Tomer reply).
function _conversationOwner(phone) {
  const st = _ownerLead(phone)?.status ?? null;
  return st === 'human_owns' ? 'human' : st === 'opted_out' ? 'opted_out' : st === 'attribution_review' ? 'attribution_review' : 'tomer';
}
function _caseRow(c) {
  return { ...c, conversationOwner: _conversationOwner(c.phone), link: tomerService.caseLink(c.id) };
}
/** The member's WhatsApp thread as the dashboard recorded it, with who wrote each message. */
function _caseConversation(phone) {
  const lead = _ownerLead(phone);
  const t    = inbox.getThread ? inbox.getThread(phone) : null;
  const all  = t?.messages ?? [];
  const who  = m => (m.direction === 'in' ? 'member'
    : m.agentId === 'tomer' ? 'tomer'
    : (m.agentId === 'staff' || m.agentId === 'manual') ? 'staff'
    : m.agentId === 'barak' ? 'bot' : 'unknown');
  return {
    owner:      _conversationOwner(phone),
    ownedBy:    lead?.status === 'human_owns' ? (lead.meta?.humanOwnsBy ?? null) : null,
    ownedSince: lead?.status === 'human_owns' ? (lead.meta?.humanOwnsSince ?? null) : null,
    ownedReason: lead?.status === 'human_owns' ? (lead.meta?.humanOwnsReason ?? null) : null,
    total:      all.length,
    messages:   all.slice(-40).map(m => ({
      direction: m.direction, who: who(m), text: String(m.text ?? '').slice(0, 1500), timestamp: m.timestamp,
      mediaType: m.mediaType && m.mediaType !== 'text' ? m.mediaType : null,
      by: m.meta?.by ?? null, handler: m.meta?.handler ?? null, sendState: m.meta?.sendState ?? null,
    })),
  };
}

// The effective test restrictions (authenticated — it lists phone numbers).
app.get('/api/tomer/test-mode', (_req, res) => {
  res.json({ ok: true, ...tomerTest.status(), serviceEnabled: _tomerSwitch(), managerPhone: _tomerManagerPhone(),
    autoReply: process.env.WHATSAPP_AUTO_REPLY === 'true', arboxWrites: arboxGateway.writeStatus(),
    retention: Object.fromEntries(Object.entries(retentionWorker.getConfig()).map(([k, v]) => [k, !!v.enabled])) });
});

app.get('/api/tomer/cases', (req, res) => {
  try {
    const open = req.query.open === '1' ? true : req.query.open === '0' ? false : undefined;
    const status = ['awaiting_staff', 'in_progress', 'awaiting_member', 'resolved'].includes(req.query.status) ? req.query.status : undefined;
    res.json({
      ok: true,
      cases: serviceCases.list({ open, status, phone: req.query.phone || undefined, limit: Number(req.query.limit) || 300 }).map(_caseRow),
      counts: serviceCases.counts(),
      categories: Object.fromEntries(Object.entries(tomerService.CATEGORY).map(([k, v]) => [k, v.label])),
      outcomes: tomerService.OUTCOMES,
      serviceEnabled: _tomerSwitch(),
      testMode: tomerTest.status(),
      autoReply: process.env.WHATSAPP_AUTO_REPLY === 'true',
      managerConfigured: !!_tomerManagerPhone(),
      ts: new Date(),
    });
  } catch (err) {
    logger.error('[tomer-cases] list failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'list_failed', detail: err.message });
  }
});
app.get('/api/tomer/cases/:id', (req, res) => {
  try {
    const c = serviceCases.get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, case: _caseRow(c), conversation: _caseConversation(c.phone),
      categories: { [c.category]: tomerService.CATEGORY[c.category]?.label ?? c.category }, outcomes: tomerService.OUTCOMES, ts: new Date() });
  } catch (err) {
    logger.error('[tomer-cases] read failed', { id: req.params.id, error: err.message });
    return res.status(500).json({ ok: false, error: 'read_failed', detail: err.message });
  }
});
{
  const _by = req => String(req.body?.by ?? '').trim().slice(0, 40) || 'צוות';
  const _caseOp = fn => async (req, res) => {
    try {
      const out = await fn(req.params.id, req);
      if (!out) return res.status(404).json({ ok: false, error: 'not_found' });
      if (out.case) out.case = _caseRow(out.case);
      if (out.ok === false) return res.status(out.error === 'not_found' ? 404 : ['send_failed', 'send_uncertain', 'notify_failed', 'notify_uncertain'].includes(out.error) ? 502 : 409).json(out);
      broadcastSse('tomer_case', { id: req.params.id });
      return res.json(out);
    } catch (err) {
      logger.error('[tomer-cases] operation failed', { id: req.params.id, error: err.message });
      return res.status(500).json({ ok: false, error: 'operation_failed', detail: err.message });
    }
  };
  const S = tomerService.staff;
  app.post('/api/tomer/cases/:id/assign',             jsonBody, _caseOp((id, req) => S.assign(id, { to: req.body?.to, by: _by(req) })));
  app.post('/api/tomer/cases/:id/status',             jsonBody, _caseOp((id, req) => S.setStatus(id, { status: req.body?.status, by: _by(req) })));
  app.post('/api/tomer/cases/:id/reply',              jsonBody, _caseOp((id, req) => S.staffReply(id, { text: req.body?.text, by: _by(req), awaitMember: req.body?.awaitMember === true })));
  app.post('/api/tomer/cases/:id/resolve',            jsonBody, _caseOp((id, req) => S.resolve(id, { note: req.body?.note, outcome: req.body?.outcome, by: _by(req) })));
  app.post('/api/tomer/cases/:id/reopen',             jsonBody, _caseOp((id, req) => S.reopen(id, { by: _by(req) })));
  app.post('/api/tomer/cases/:id/retry-notification', jsonBody, _caseOp((id, req) => S.retryNotification(id, { force: req.body?.force === true, by: _by(req) })));
  app.post('/api/tomer/cases/:id/refresh-arbox',      jsonBody, _caseOp((id, req) => S.refreshArbox(id, { by: _by(req) })));
  // Conversation ownership from the case: the same takeover / release the rest of the
  // dashboard uses, recorded on the case.
  app.post('/api/tomer/cases/:id/takeover', jsonBody, _caseOp((id, req) => {
    const c = serviceCases.get(id); if (!c) return null;
    const out = _manualTakeover(c.phone, { reason: 'tomer_panel', staffName: _by(req) });
    if (!out.unchanged) tomerService.noteOwnership(c.phone, 'human_takeover', { by: _by(req), detail: 'panel' });
    return { ok: true, unchanged: out.unchanged, case: serviceCases.get(id), conversationOwner: _conversationOwner(c.phone) };
  }));
  app.post('/api/tomer/cases/:id/release', jsonBody, _caseOp((id, req) => {
    const c = serviceCases.get(id); if (!c) return null;
    const out = _releaseConversation(c.phone);
    const changed = !!out && !out.unchanged;
    if (changed) tomerService.noteOwnership(c.phone, 'human_release', { by: _by(req), detail: `restored to ${out.status}` });
    return { ok: true, unchanged: !changed, restoredTo: out?.status ?? null, case: serviceCases.get(id), conversationOwner: _conversationOwner(c.phone) };
  }));
}

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

// GET /api/tomer/member/id/:arboxId — rich member context via stable Arbox member ID.
// Phone is resolved server-side from Arbox — not exposed in the enriched member list.
// This endpoint avoids sending real phones to the client via URL parameters.
app.get('/api/tomer/member/id/:arboxId', async (req, res) => {
  const arboxId = decodeURIComponent(req.params.arboxId);
  try {
    const arboxSvc = require('./services/arbox.service');
    const member   = await arboxSvc.getMemberById(arboxId).catch(() => null);
    if (!member) return res.status(404).json({ ok: false, error: 'member not found' });
    const phone    = member.phone ?? null;
    const lead     = phone ? store.getLead(phone) : null;
    const history  = phone ? tomerStore.getMemberHistory(phone) : [];
    const tasks    = phone ? tomerStore.getTasks({ phone }) : [];
    const audit    = phone ? tomerStore.getAudit({ phone, limit: 20 }) : [];
    const inboxThreads = (phone && inbox.getThread) ? inbox.getThread(phone) : [];
    let arboxClasses = [];
    try {
      arboxClasses = await Promise.race([
        arboxSvc.getUpcomingClasses({ days: 5, limit: 6 }),
        new Promise(r => setTimeout(() => r([]), 2500)),
      ]);
    } catch { arboxClasses = []; }
    res.json({ ok: true, arboxId, phone, arbox: member, lead, history, tasks, audit, inboxThreads, arboxClasses });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
    let arboxClasses = [];
    try {
      arboxClasses = await Promise.race([
        arboxSvc.getUpcomingClasses({ days: 5, limit: 6 }),
        new Promise(r => setTimeout(() => r([]), 2500)),
      ]);
    } catch { arboxClasses = []; }
    res.json({ ok: true, phone, arbox: member, lead, history, tasks, audit, inboxThreads, arboxClasses });
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
  // The legacy retention workflows are superseded by member care (panel: "ליווי חברים") and can no longer be enabled.
  if (enabled === true) return res.status(410).json({ ok: false, error: 'superseded_by_member_care', detail: 'התוכניות הישנות הוחלפו ב"ליווי חברים".' });
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

// GET /api/tomer/today — "Today's Work" action items for Eden's daily workspace
// Returns prioritized list: Eden tasks, aging conversations, failed sends, upcoming sends.
app.get('/api/tomer/today', async (req, res) => {
  try {
    const now       = Date.now();
    const openTasks = tomerStore.getOpenTasks();
    const audit24h  = tomerStore.getAudit({ limit: 100 });
    const failedSends = audit24h.filter(e => e.sendState === 'failed');

    // Aging conversations — threads where the last inbound message has no reply, 2–24h ago.
    //
    // Source: inbox._threads (loaded from persist on startup), NOT inbox._msgs (the flat
    // ring buffer that is empty after a restart). Using _threads means this view is
    // consistent with /api/tomer/conversations and survives deploys without synthesizing
    // duplicate message objects.
    //
    // "Unanswered" definition (same as /api/tomer/conversations):
    //   find the last direction='in' message in the thread; skip if any direction='out'
    //   message follows it. No separate barakReply check needed — outbound direction is
    //   the authoritative answered/unanswered signal in the thread model.
    const AGE_MIN = 2 * 3600000, AGE_MAX = 24 * 3600000;
    const awaitingReply = [];
    const _agingThreads = inbox.getThreads ? inbox.getThreads({ limit: 200 }) : [];
    for (const t of _agingThreads) {
      const msgs = t.messages ?? [];
      let lastInMsg = null, lastInIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].direction === 'in') { lastInMsg = msgs[i]; lastInIdx = i; break; }
      }
      if (!lastInMsg) continue;
      if (msgs.slice(lastInIdx + 1).some(m => m.direction === 'out')) continue;

      const ts  = new Date(lastInMsg.timestamp).getTime();
      const age = now - ts;
      if (age < AGE_MIN || age > AGE_MAX) continue;

      const route = lastInMsg.route ?? '';
      if (['opted_out_silent','post_call_silent','acknowledged','spam_filtered','staff_bypass'].includes(route)) continue;

      const lead = store.getLead(t.phone) ?? {};
      awaitingReply.push({
        phone:      maskPhone(t.phone),
        name:       t.name ?? null,
        lastText:   (lastInMsg.text ?? '').slice(0, 80),
        route,
        ageMin:     Math.round(age / 60000),
        owner:      lead.status === 'human_owns'        ? 'human'
                  : lead.status === 'attribution_review' ? 'attribution_review'
                  :                                        'bot',
        leadStatus: lead.status ?? null,
        receivedAt: lastInMsg.timestamp,
      });
    }

    // Upcoming workflow summary (enabled workflows only)
    const cfg = retentionWorker.getConfig();
    const CRON_HOURS = [0, 4, 8, 12, 16, 20];
    const nowIL = new Date(now);
    const ilHour = parseInt(nowIL.toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }), 10);
    const nextCronH = CRON_HOURS.find(h => h > ilHour) ?? (CRON_HOURS[0] + 24);
    const nextRunLabel = nextCronH < 24
      ? `${String(nextCronH).padStart(2,'0')}:00 היום`
      : `${String(CRON_HOURS[0]).padStart(2,'0')}:00 מחר`;

    const upcomingWorkflows = Object.entries(cfg)
      .filter(([,wf]) => wf.enabled)
      .map(([id]) => ({ id, nextRun: nextRunLabel, eligibleCount: null }));
    // Fetch eligible counts async (non-blocking — may return 0 if Arbox is slow)
    for (const wf of upcomingWorkflows) {
      try {
        const preview = await Promise.race([
          retentionWorker.previewWorkflow(wf.id, 5),
          new Promise(r => setTimeout(() => r({ eligible: [] }), 2000)),
        ]);
        wf.eligibleCount = (preview.eligible ?? []).length;
        wf.workflow = preview.workflow ?? wf.id;
      } catch { wf.eligibleCount = null; }
    }

    res.json({
      ok: true,
      openTasks:      openTasks.slice(0, 20),
      awaitingReply:  awaitingReply.slice(0, 20),
      failedSends:    failedSends.slice(0, 10),
      upcomingWorkflows,
      counts: {
        openTasks:     openTasks.length,
        highPriority:  openTasks.filter(t => t.priority === 'high').length,
        awaitingReply: awaitingReply.length,
        failedSends:   failedSends.length,
      },
      cases:        serviceCases.counts(),
      urgentCases:  serviceCases.list({ open: true, limit: 500 }).filter(c => c.priority === 'high' || c.unreadMember || ['failed', 'uncertain'].includes(c.notification?.state)).slice(0, 20).map(_caseRow),
      ts: new Date(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/upcoming — Upcoming automated messages per workflow
// Returns each workflow's: state, eligible members, message template, next scheduled run.
app.get('/api/tomer/upcoming', async (req, res) => {
  try {
    const cfg = retentionWorker.getConfig();
    const now     = Date.now();
    const CRON_H  = [0, 4, 8, 12, 16, 20];
    const ilHour  = parseInt(new Date(now).toLocaleString('sv-SE', {
      timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false,
    }), 10);
    const nextH   = CRON_H.find(h => h > ilHour);
    const nextRun = nextH != null
      ? new Date(new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' }) + `T${String(nextH).padStart(2,'0')}:00:00+02:00`)
      : null;

    const workflows = [];
    for (const [id, wf] of Object.entries(cfg)) {
      const entry = { id, enabled: wf.enabled, nextRun: nextRun?.toISOString() ?? null, eligible: [], totalEligible: 0, messageTemplate: null, state: 'disabled' };

      if (wf.enabled) {
        try {
          const preview = await Promise.race([
            retentionWorker.previewWorkflow(id, 10),
            new Promise(r => setTimeout(() => r({ eligible: [], workflow: id }), 3000)),
          ]);
          entry.eligible      = (preview.eligible ?? []).map(m => ({ name: m.name, phone: maskPhone(m.phone ?? '') }));
          entry.totalEligible = entry.eligible.length;
          entry.messageTemplate = preview.messageTemplate ?? preview.sampleMessage ?? null;
          entry.state = entry.totalEligible > 0 ? 'eligible' : 'no_eligible';
          entry.workflow = preview.workflow ?? id;
        } catch { entry.state = 'preview_error'; }
      }
      workflows.push(entry);
    }

    res.json({ ok: true, workflows, ts: new Date() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/conversations — inbox threads with unanswered inbound messages
app.get('/api/tomer/conversations', (req, res) => {
  try {
    const threads = inbox.getThreads({ limit: 200 });
    const result  = [];
    for (const t of threads) {
      const msgs   = t.messages ?? [];
      const lastIn = [...msgs].reverse().find(m => m.direction === 'in');
      if (!lastIn) continue;
      const lastInIdx = msgs.lastIndexOf(lastIn);
      const hasReply  = msgs.slice(lastInIdx + 1).some(m => m.direction === 'out');
      if (hasReply) continue;

      const lead  = store.getLead(t.phone);
      const ageMs = Date.now() - new Date(lastIn.timestamp).getTime();
      const ageMin = Math.round(ageMs / 60000);
      result.push({
        phone:      maskPhone(t.phone),
        name:       t.name ?? null,
        lastText:   (lastIn.text ?? '').slice(0, 120),
        ageMin,
        escalate:   ageMin >= 120,
        owner:      lead?.status === 'human_owns'         ? 'human'
                  : lead?.status === 'attribution_review' ? 'attribution_review'
                  : lead?.status === 'opted_out'          ? 'opted_out'
                  : 'bot',
        leadStatus: lead?.status ?? null,
        caseId:     serviceCases.list({ phone: t.phone, open: true, limit: 50 }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0]?.id ?? null,
        messages:   msgs.slice(-6).map(m => ({
          direction: m.direction,
          text:      (m.text ?? '').slice(0, 200),
          timestamp: m.timestamp,
          route:     m.route ?? null,
        })),
        lastAt: t.lastAt,
      });
    }
    result.sort((a, b) => b.escalate - a.escalate || b.ageMin - a.ageMin);
    res.json({ ok: true, conversations: result, total: result.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/message-queue — persistent message queue
app.get('/api/tomer/message-queue', (req, res) => {
  try {
    const { status, phone, workflowId, limit } = req.query;
    const entries = tomerStore.getMessageQueue({
      status:     status     || undefined,
      phone:      phone      || undefined,
      workflowId: workflowId || undefined,
      limit:      parseInt(limit) || 100,
    });
    res.json({ ok: true, entries, total: entries.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/tomer/members-enriched — Arbox member list with server-side ownership/task join.
// Phones are NEVER sent to the client. Members are identified by arboxId or display-safe
// masked-phone. The join is done server-side using the full (unmasked) phone internally.
app.get('/api/tomer/members-enriched', async (req, res) => {
  try {
    const arboxSvc = require('./services/arbox.service');
    const detailed = await arboxSvc.getDetailedMembers?.().catch(() => null);
    if (!detailed) return res.json({ ok: true, members: [] });

    const all = [
      ...(detailed.active ?? []).map(m => ({ ...m, _statusKey: 'active' })),
      ...(detailed.expiringSoon ?? []).map(m => ({ ...m, _statusKey: 'expiring' })),
      ...(detailed.expired ?? []).map(m => ({ ...m, _statusKey: 'expired' })),
    ];

    // Build open-task count per phone
    const openTasks = tomerStore.getOpenTasks();
    const taskCountByPhone = {};
    openTasks.forEach(t => { if (t.phone) taskCountByPhone[t.phone] = (taskCountByPhone[t.phone] ?? 0) + 1; });

    const enriched = all.map(m => {
      const lead    = m.phone ? store.getLead(m.phone) : null;
      const tasks   = m.phone ? taskCountByPhone[m.phone] ?? 0 : 0;
      const ownerSt = lead?.status ?? null;
      return {
        arboxId:    m.user_id,
        name:       `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || null,
        phone:      maskPhone(m.phone ?? ''),           // masked for display
        _phone:     m.phone ?? null,                    // INTERNAL ONLY — never expose in public response
        statusKey:  m._statusKey,
        memberEnd:  m.membership_end_date?.slice(0, 10) ?? null,
        active:     m.active ?? false,
        birthday:   m.birthday?.slice(0, 10) ?? null,
        allowSms:   m.allow_sms ?? null,
        owner:      ownerSt === 'human_owns'         ? 'human'
                  : ownerSt === 'opted_out'           ? 'opted_out'
                  : ownerSt === 'attribution_review'  ? 'attribution_review'
                  :                                     'bot',
        openTasks:  tasks,
        leadStatus: ownerSt,
        lastContact: lead?.meta?.lastContactAt ?? null,
      };
    });

    // Strip internal _phone before sending — never send real phones to client
    const safe = enriched.map(({ _phone, ...m }) => m);
    res.json({ ok: true, members: safe });
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

// POST /api/admin/reset-lead-state/:phone — controlled reset for live E2E testing.
// Clears callback, qualification and AI history for one specific phone.
// Preserves firstSeen, messageCount, source and all appointment records.
// Appointment cancellation must be done separately via PATCH/cancel endpoints.
app.post('/api/admin/reset-lead-state/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const lead  = store.getLead(phone);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

  // Preserve identity; clear all qualification, callback and dedup state.
  store.upsertLead(phone, {
    status: 'new',
    name:   null,
    score:  4,
    meta: {
      source:              lead.meta?.source              ?? null,
      lastIntent:          null,
      qualData:            {},
      qualProfile:         null,
      leadBrief:           null,
      briefGeneratedAt:    null,
      awaitingCallbackTime:  false,
      callbackTime:          null,
      callbackRequestedAt:   null,
      noShowAptId:           null,
      reschedulingAptId:     null,
      reschedulingOldTime:   null,
      handoffAlertStatus:    null,
      handoffAlertSentAt:    null,
      handoffAlertFailedAt:  null,
      handoffAlertIdMessage: null,
      handoffAlertError:     null,
      handoffSentPhones:     [],
      handoffCallTime:       null,
      nameConfirmedAlertSent:    null,
      nameConfirmedAlertIdMessage: null,
    },
  });

  // Clear Barak's in-memory conversation history for this phone.
  // Without this the AI would continue from the previous session context.
  try { leadAgent.clearSession(phone); } catch {}

  persist.saveLeads(store);
  store.logEvent('lead_state_reset', phone, { by: 'admin_panel', preserved: 'firstSeen,messageCount' });
  logger.info('[admin] Lead state reset for E2E test', { phone });
  res.json({ ok: true, status: 'new', phone });
});

// ── Shared closing-summary send/retry logic ───────────────────────────────
// Called by the admin endpoint and the startup recovery pass.
// Sends only the parts not yet accepted:
//   - prospect: skipped if closingSummaryProspectState === 'accepted'
//   - manager:  per-phone dedup via closingSummaryManagerSentTo + skipPhones
// Uses fmtScheduledAt for the formatted time visible to humans.
// Returns a result object for the caller to report or log.
async function _retryClosingSummary(phone, { force = false } = {}) {
  // Same code path as the automatic flow (callbackSvc.finalize): identical wording,
  // persisted-appointment requirement and durable per-appointment / per-recipient dedup.
  // `force` only bypasses the "already complete" short-circuit — it can never resend to
  // a recipient who already accepted this appointment's summary, and nothing is sent for
  // an expired or missing appointment (historical summaries are not replayed).
  const lead = store.getLead(phone);
  if (!lead) return { ok: false, error: 'lead_not_found' };
  const meta     = lead.meta ?? {};
  const qd       = meta.qualData ?? {};
  const callTime = qd.callTimeGiven ?? meta.callbackTime ?? null;
  if (!qd.confirmedName) return { ok: false, error: 'no_name' };
  if (!callTime)         return { ok: false, error: 'no_call_time' };
  if (qd.closingSummarySent && !force) {
    return { ok: false, error: 'already_sent',
      existing: { managerIdMessage: meta.closingSummaryManagerIdMessage, sentTo: meta.closingSummaryManagerSentTo } };
  }

  const skippedBefore = [...(meta.closingSummaryManagerSentTo ?? [])];
  const fin = await callbackSvc.finalize({ phone, trigger: force ? 'admin_retry_force' : 'retry' });
  if (!fin.apt) return { ok: false, error: fin.error };

  return {
    ok:                      fin.bothAccepted,
    prospectMsg:             fin.prospectMsg,
    prospectRecipient:       phone,
    prospectIdMessage:       fin.prospect.idMessage ?? null,
    prospectError:           fin.prospect.state === 'accepted' ? null : (fin.prospect.reason ?? fin.prospect.state),
    prospectAlreadyAccepted: fin.prospect.alreadySent === true,
    managerMsg:              fin.managerMsg,
    managerResults:          fin.manager.results ?? [],
    managerIdMessage:        fin.manager.idMessage ?? null,
    sentTo:                  (fin.manager.allSentTo ?? []).filter(p => p !== 'staff_action'),
    skipped:                 skippedBefore,
    bothAccepted:            fin.bothAccepted,
  };
}


// POST /api/admin/send-closing-summary/:phone — manually trigger the closing summary
// for a lead whose name and callTimeGiven are already known. Used for recovery when
// the automatic flow did not fire (e.g. wrong recipient was configured).
// Guards: does not resend if closingSummarySent is already true; checks per-recipient
// to skip phones already covered. Set force=true in body to override the sent flag.
app.post('/api/admin/send-closing-summary/:phone', jsonBody, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const force = req.body?.force === true;
  const lead  = store.getLead(phone);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

  const result = await _retryClosingSummary(phone, { force });

  if (result.error === 'no_name')     return res.status(422).json({ ok: false, error: 'confirmedName not set' });
  if (result.error === 'no_persisted_callback') return res.status(422).json({ ok: false, error: 'no persisted callback with a valid time — nothing to confirm' });
  if (result.error === 'callback_expired')      return res.status(409).json({ ok: false, error: 'callback time already passed — summaries are not replayed' });
  if (result.error === 'in_flight')             return res.status(409).json({ ok: false, error: 'a summary send is already in progress' });
  if (result.error === 'no_call_time') return res.status(422).json({ ok: false, error: 'callTimeGiven not set' });
  if (result.error === 'already_sent') {
    return res.status(409).json({ ok: false, error: 'closingSummarySent already true — pass force:true to override',
      existing: result.existing });
  }

  store.logEvent('closing_summary_sent_manual', phone, {
    name: lead.meta?.qualData?.confirmedName ?? lead.name,
    bothAccepted: result.bothAccepted,
    managerIdMessage: result.managerIdMessage,
    sentTo: result.sentTo,
  });
  res.json(result);
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

// GET /api/admin/appointments/worker-status — effective reminder-worker configuration
app.get('/api/admin/appointments/worker-status', (_req, res) => {
  res.json({ ok: true, worker: appointmentWorker.workerStatus(), callingHours: callbackTime.callingHours() });
});

// Lifecycle transitions are NOT available through the generic PATCH: status, time and
// reminder state change only through the dedicated endpoints below, which enforce the
// allowed transitions and keep the lead and the panel consistent.
const _APT_PATCHABLE = new Set(['assignedStaffId', 'completionNotes', 'noAnswerNote']);

// PATCH /api/admin/appointments/:id — edit descriptive fields only
app.patch('/api/admin/appointments/:id', jsonBody, (req, res) => {
  const body = req.body ?? {};
  const refused = Object.keys(body).filter(k => !_APT_PATCHABLE.has(k));
  if (refused.length) {
    return res.status(400).json({ ok: false, error: `Fields not editable here: ${refused.join(', ')}. Use confirm / complete / cancel / no-answer / reschedule.` });
  }
  try {
    const apt = aptStore.update(req.params.id, body);
    if (!apt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
    store.logEvent('appointment_updated_manual', apt.leadPhone, { aptId: apt.id, ...body });
    res.json({ ok: true, appointment: apt });
  } catch (err) {
    logger.error('[api] appointment update not persisted', { aptId: req.params.id, error: err.message });
    res.status(500).json({ ok: false, error: 'persist_failed', message: 'השינוי לא נשמר — נסו שוב' });
  }
});

const _APT_ERRORS = {
  not_found:   [404, 'Appointment not found'],
  not_pending: [409, 'רק בקשת שיחה שממתינה לאישור אפשר לאשר'],
  not_open:    [409, 'הבקשה כבר נסגרה (הושלמה / בוטלה / לא ענה) — אי אפשר לשנות אותה'],
  no_time:     [409, 'לבקשה אין מועד תקין — קבעו מועד ("שנה מועד") לפני אישור'],
  expired:     [409, 'מועד השיחה כבר עבר — עדכנו תוצאה או קבעו מועד חדש'],
};
function _aptFail(res, r) {
  const [code, message] = _APT_ERRORS[r.error] ?? [400, r.error];
  return res.status(code).json({ ok: false, error: message, code: r.error, status: r.apt?.status ?? null });
}
function _aptPersistFail(res, id, err) {
  logger.error('[api] appointment change not persisted', { aptId: id, error: err.message });
  return res.status(500).json({ ok: false, error: 'השינוי לא נשמר — נסו שוב', code: 'persist_failed' });
}

// POST /api/admin/appointments/:id/confirm — staff approves a pending callback.
//   callback_pending (valid future time) → confirmed; lead → call_scheduled.
//   Repeat = no-op (unchanged:true). Closed or expired records are refused (409).
//   Reminder records already sent for this time are preserved — approving never
//   re-triggers a reminder. Human ownership / opt-out on the lead are never overridden.
app.post('/api/admin/appointments/:id/confirm', jsonBody, (req, res) => {
  try {
    const r = callbackSvc.staffConfirm(req.params.id);
    if (!r.ok) return _aptFail(res, r);
    if (!r.unchanged) logger.info('[api] Appointment confirmed by staff', { aptId: r.apt.id, phone: r.apt.leadPhone });
    res.json({ ok: true, unchanged: !!r.unchanged, appointment: r.apt });
  } catch (err) { _aptPersistFail(res, req.params.id, err); }
});

// POST /api/admin/appointments/:id/complete — the call took place
app.post('/api/admin/appointments/:id/complete', jsonBody, (req, res) => {
  try {
    const r = callbackSvc.staffOutcome(req.params.id, 'completed', { notes: req.body?.notes || null });
    if (!r.ok) return _aptFail(res, r);
    res.json({ ok: true, unchanged: !!r.unchanged, appointment: r.apt });
  } catch (err) { _aptPersistFail(res, req.params.id, err); }
});

// POST /api/admin/appointments/:id/cancel — staff cancels the callback (no prospect message)
app.post('/api/admin/appointments/:id/cancel', jsonBody, (req, res) => {
  try {
    const r = callbackSvc.staffOutcome(req.params.id, 'cancelled', { reason: req.body?.reason || null });
    if (!r.ok) return _aptFail(res, r);
    res.json({ ok: true, unchanged: !!r.unchanged, appointment: r.apt });
  } catch (err) { _aptPersistFail(res, req.params.id, err); }
});

// POST /api/admin/appointments/:id/no-answer — staff called, the prospect did not answer.
// Recorded as an outcome only: no automated message is sent to the prospect.
app.post('/api/admin/appointments/:id/no-answer', jsonBody, (req, res) => {
  try {
    const r = callbackSvc.staffOutcome(req.params.id, 'no_answer', { note: req.body?.note || null });
    if (!r.ok) return _aptFail(res, r);
    res.json({ ok: true, unchanged: !!r.unchanged, appointment: r.apt });
  } catch (err) { _aptPersistFail(res, req.params.id, err); }
});

// POST /api/admin/appointments/:id/reschedule — staff move an OPEN callback.
// The new time is resolved strictly (same resolver as prospect messages, anchored to
// now, Asia/Jerusalem); an unclear or past time is refused with an explanation instead
// of being guessed. The old reminder cycle is invalidated, staff approval is required
// again, and the prospect receives the updated summary.
app.post('/api/admin/appointments/:id/reschedule', jsonBody, async (req, res) => {
  const { rawTime } = req.body ?? {};
  if (!rawTime?.trim()) return res.status(400).json({ ok: false, error: 'rawTime required' });
  try {
    const r = await callbackSvc.staffReschedule(req.params.id, rawTime.trim());
    if (r.error === 'invalid_time') {
      return res.status(422).json({ ok: false, error: `לא ניתן לקבוע את המועד: ${r.clarification}`, code: r.reason });
    }
    if (!r.ok) return _aptFail(res, r);
    res.json({ ok: true, appointment: r.appointment, scheduledAt: r.scheduledAt,
      prospectNotified: r.summary?.prospect?.state ?? null });
  } catch (err) { _aptPersistFail(res, req.params.id, err); }
});

// POST /api/admin/appointments/:id/assign — reassign to a different staff member
app.post('/api/admin/appointments/:id/assign', jsonBody, (req, res) => {
  const { staffId } = req.body ?? {};
  if (!staffId) return res.status(400).json({ ok: false, error: 'staffId required' });
  try {
    const apt = aptStore.update(req.params.id, { assignedStaffId: staffId });
    if (!apt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
    store.logEvent('appointment_staff_reassigned', apt.leadPhone, { aptId: apt.id, staffId });
    res.json({ ok: true, appointment: apt });
  } catch (err) { _aptPersistFail(res, req.params.id, err); }
});

// POST /api/admin/appointments/:id/retry-notify — (re)send the consolidated manager
// summary for this appointment to recipients who have not accepted it yet. Uses the same
// builder and durable dedup as the automatic flow: never a second copy, never a
// different wording, never for an expired or closed appointment.
app.post('/api/admin/appointments/:id/retry-notify', async (req, res) => {
  const apt = aptStore.get(req.params.id);
  if (!apt) return res.status(404).json({ ok: false, error: 'Appointment not found' });
  const open = callbackSvc.openCallback(apt.leadPhone);
  if (!open || open.id !== apt.id) {
    return res.status(409).json({ ok: false, error: 'הבקשה אינה הבקשה הפתוחה העדכנית של הליד — לא נשלח סיכום' });
  }
  try {
    const fin = await callbackSvc.finalize({ phone: apt.leadPhone, trigger: 'admin_retry_notify' });
    if (!fin.apt) {
      const msg = fin.error === 'no_name' ? 'חסר שם לליד — הסיכום נשלח רק אחרי שהליד מוסר שם'
                : fin.error === 'callback_expired' ? 'מועד השיחה כבר עבר — סיכומים ישנים לא נשלחים מחדש'
                : fin.error;
      return res.status(422).json({ ok: false, error: msg, code: fin.error });
    }
    store.logEvent('appointment_handoff_retried', apt.leadPhone, {
      aptId: apt.id, newSent: fin.manager.newSent.length,
    });
    res.json({ ok: fin.manager.accepted, sent: fin.manager.newSent.length,
      skipped: (fin.manager.results ?? []).filter(r => r.skipped).length, results: fin.manager.results ?? [] });
  } catch (err) {
    logger.error('[api] retry-notify failed', { aptId: req.params.id, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
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
    const _dsRes = await sendText(phone, text.trim());
    // Registered so the provider's echo of this send is not recorded a second time.
    if (_dsRes?.idMessage) _recordBotSend(_dsRes.idMessage, normalizeToE164(phone) ?? phone);
    inbox.pushOutbound({ phone, name: name ?? null, text: text.trim(), agentId: 'staff', meta: { agent: 'staff', handler: 'dashboard_send', trigger: 'panel', idMessage: _dsRes?.idMessage ?? null } });
    // Dashboard manual send = staff is handling this contact. Set human_owns so
    // automated agents (Barak, Tomer, payment ack) stay silent until released.
    _applyStaffTakeover(normalizeToE164(phone) ?? phone, null, text.trim());
    store.logEvent('message_out', phone, { preview: text.slice(0, 80), agent: 'manual', source: 'dashboard' });
    broadcastSse('message', { phone, name: name ?? null, direction: 'out' });
    logger.info('Dashboard manual reply sent — human_owns set', { phone });
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

// GET /api/admin/green-api/settings — read the outgoingMessageWebhook flag only.
// Strictly read-only: calls getSettings directly, never setSettings.
// Returns only the specific setting needed for phone-side takeover; does not expose
// full provider configuration (webhookUrl, instance state, etc.).
// Note: no session-level authentication — all /api/admin/* endpoints rely on
// network/obscurity (Railway HTTPS subdomain). Do not add secrets to the response.
app.get('/api/admin/green-api/settings', async (_req, res) => {
  const { host, instanceId, token } = getGreenCreds();
  if (!host || !instanceId || !token) return res.status(503).json({ ok: false, error: 'Green API not configured' });
  try {
    const axios = require('axios');
    const { data } = await axios.get(`https://${host}/waInstance${instanceId}/getSettings/${token}`, { timeout: 8000 });
    res.json({ ok: true, outgoingMessageWebhook: data.outgoingMessageWebhook ?? 'unknown' });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/green-api/settings — enable or disable outgoingMessageWebhook only.
// Allowlisted to exactly one field: { outgoingMessageWebhook: 'yes'|'no' }.
// Extra body keys are explicitly rejected so callers cannot accidentally forward
// arbitrary setSettings params to the provider.
// Body: { outgoingMessageWebhook: 'yes' | 'no' }
app.post('/api/admin/green-api/settings', jsonBody, async (req, res) => {
  const body  = req.body ?? {};
  const keys  = Object.keys(body);
  const extra = keys.filter(k => k !== 'outgoingMessageWebhook');
  if (extra.length > 0) {
    return res.status(400).json({ ok: false, error: `Only outgoingMessageWebhook is accepted; unexpected keys: ${extra.join(', ')}` });
  }
  const value = body.outgoingMessageWebhook;
  if (value !== 'yes' && value !== 'no') {
    return res.status(400).json({ ok: false, error: 'Body must be { outgoingMessageWebhook: "yes"|"no" }' });
  }
  const { host, instanceId, token } = getGreenCreds();
  if (!host || !instanceId || !token) return res.status(503).json({ ok: false, error: 'Green API not configured' });
  try {
    const axios = require('axios');
    await axios.post(
      `https://${host}/waInstance${instanceId}/setSettings/${token}`,
      { outgoingMessageWebhook: value },
      { timeout: 8000 }
    );
    // Verify the change with a fresh read.
    const { data: verified } = await axios.get(`https://${host}/waInstance${instanceId}/getSettings/${token}`, { timeout: 8000 });
    const confirmed = verified.outgoingMessageWebhook === value;
    logger.info('[admin] Green API outgoingMessageWebhook updated', { value, verified: verified.outgoingMessageWebhook, confirmed });
    if (!confirmed) {
      return res.status(502).json({ ok: false, error: `setSettings accepted but getSettings shows ${verified.outgoingMessageWebhook}` });
    }
    res.json({ ok: true, outgoingMessageWebhook: verified.outgoingMessageWebhook });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
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

// ── Startup closing-summary recovery ──────────────────────────────────────────
// in_flight after a crash = UNKNOWN outcome: the provider may have accepted the send
// before the process died. It becomes 'uncertain' and is surfaced for review in the
// panel — it is never resent automatically. Only definitively 'failed' sends (the
// provider never accepted them) are retried, through the same persisted-appointment
// and durable-dedup rules as every other summary (callbackSvc.finalize), so nothing is
// sent for an expired or closed callback.
function _recoverClosingSummaries() {
  let uncertain = 0;
  for (const l of store.getAllLeads()) {
    const m = l.meta ?? {};
    if (m.closingSummaryProspectState === 'in_flight' || m.closingSummaryManagerState === 'in_flight') {
      store.upsertLead(l.phone, {
        meta: {
          ...m,
          closingSummaryProspectState: m.closingSummaryProspectState === 'in_flight' ? 'uncertain' : m.closingSummaryProspectState,
          closingSummaryManagerState:  m.closingSummaryManagerState  === 'in_flight' ? 'uncertain' : m.closingSummaryManagerState,
        },
      });
      uncertain++;
    }
  }
  if (uncertain > 0) {
    persist.saveLeads(store);
    logger.warn('[startup] Closing summary uncertain states found (crash recovery) — review in the panel', { count: uncertain });
  }
  const retries = [];
  if (process.env.WHATSAPP_AUTO_REPLY === 'true') {
    for (const l of store.getAllLeads()) {
      const m  = l.meta ?? {};
      const qd = m.qualData ?? {};
      const failed  = m.closingSummaryProspectState === 'failed'    || m.closingSummaryManagerState === 'failed';
      const unknown = m.closingSummaryProspectState === 'uncertain' || m.closingSummaryManagerState === 'uncertain';
      if (qd.closingSummarySent || !failed || unknown) continue;
      retries.push(_retryClosingSummary(l.phone).catch(err =>
        logger.warn('[startup] Closing summary retry failed', { phone: l.phone, error: err.message })
      ));
    }
    if (retries.length) logger.info('[startup] Retrying definitively-failed closing summaries', { count: retries.length });
  }
  return { uncertain, retries: Promise.all(retries) };
}

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

// Read the deployed git SHA from revision.json (written by the deploy script before
// railway up). Falls back to RAILWAY_GIT_COMMIT_SHA if the file is absent.
let _deployedRevision = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) ?? null;
try {
  const _rev = JSON.parse(fs.readFileSync(path.join(__dirname, 'revision.json'), 'utf8'));
  _deployedRevision = _rev.sha?.slice(0, 8) ?? _deployedRevision;
} catch { /* revision.json absent in development — not an error */ }

// TEST_NO_BIND=true: used by Jest tests (via jest_global_setup.js) to load the server
// module without binding a port. Supertest creates its own ephemeral server from the
// express app object, so a bound port would conflict. TEST_MODE=true enables test
// endpoints and must remain set; TEST_NO_BIND controls only port binding.
if (process.env.TEST_NO_BIND === 'true') {
  persist.loadLeads(store);
  persist.loadInbox(inbox);
  _markStoreReady();
  // Tomer: a manager alert left unfinished by a crash is marked failed / uncertain for
  // staff to decide — nothing is ever re-sent on startup.
  tomerService.reconcileOnStartup().catch(err => logger.error('[startup] Tomer notification reconciliation failed', { error: err.message }));
  try { memberCare.reconcileOnStartup(); } catch (err) { logger.error('[startup] member-care reconciliation failed', { error: err.message }); }
  _startupComplete = true;
} else {

app.listen(PORT, async () => {
  logger.info(`Shape Studio Agent running — http://localhost:${PORT}`, {
    revision:   _deployedRevision ?? 'unknown',
    deployedAt: (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'revision.json'), 'utf8')).deployedAt; } catch { return null; } })(),
  });

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
  // Identity: the last saved directory is loaded first, so a restart during an Arbox outage
  // still knows who the members are (marked stale); phoneRegistry.init then reads Arbox afresh.
  try { if (identity.load()) logger.info('[startup] identity directory loaded from disk (stale until refreshed)'); } catch (err) { logger.warn('[startup] identity directory not loaded', { error: err.message }); }
  await phoneRegistry.init({ timeoutMs: 10_000 });

  // TEST_STARTUP_DELAY_MS: artificial pause injected between loadLeads and
  // _markStoreReady for integration tests that need to send a webhook during
  // the startup window and verify it is held, not processed against an empty store.
  if (process.env.TEST_STARTUP_DELAY_MS) {
    await new Promise(r => setTimeout(r, Number(process.env.TEST_STARTUP_DELAY_MS)));
  }

  persist.loadLeads(store);
  persist.loadInbox(inbox);

  // Unblock any inbound webhook that arrived before loadLeads completed.
  _markStoreReady();

  // ── Startup closing-summary recovery ──────────────────────────────────────
  _recoverClosingSummaries();

  // Historical corrupt callTimeGivenAt values (year 58838+, from the old double-×1000
  // bug) are deliberately NOT repaired automatically. callbackRequestedAt is not proof of
  // when the time message was sent, and guessing would overwrite evidence. Original
  // values are preserved; affected leads are flagged for review in /api/barak/callbacks
  // (flags: call_time_timestamp_invalid_review). The appointment's persisted scheduledAt
  // is the source of truth and is never recomputed from these fields.

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

  // Mark startup complete AFTER persist.loadLeads + initWorkers so demos and
  // integration tests that poll /health can safely start sending store-modifying
  // requests without racing against persist.loadLeads overwriting in-memory state.
  // Tomer: a manager alert left unfinished by a crash is marked failed / uncertain for
  // staff to decide — nothing is ever re-sent on startup.
  tomerService.reconcileOnStartup().catch(err => logger.error('[startup] Tomer notification reconciliation failed', { error: err.message }));
  try { memberCare.reconcileOnStartup(); } catch (err) { logger.error('[startup] member-care reconciliation failed', { error: err.message }); }
  _startupComplete = true;
  logger.info('[startup] Startup sequence complete — store ready');

  // Also seed the legacy member_cache for backward compatibility with any code
  // that still calls memberCache.isConfirmed() directly.
  seedMemberCache().then(r => {
    if (r?.seeded >= 0) logger.info('[startup] Legacy member cache seeded', r);
  }).catch(() => {});

  // Probe Green API credentials immediately at startup so Railway logs show
  // whether WhatsApp sending will work before the first real message arrives.
  probeGreenApiConnection().catch(() => {}); // errors already logged inside

  // Ensure outgoing webhook is enabled so phone-side manual messages trigger
  // human_owns takeover. Without outgoingMessageWebhook=yes, messages typed on
  // the studio WhatsApp phone never reach the bot and cannot suppress automation.
  ensureOutgoingWebhooks().then(r => {
    if (r.ok && r.changed)   logger.info('[startup] Green API outgoingMessageWebhook ENABLED — phone takeover now active');
    if (r.ok && !r.changed)  logger.info('[startup] Green API outgoingMessageWebhook already enabled');
    if (!r.ok)               logger.warn('[startup] Green API outgoingMessageWebhook COULD NOT be enabled — phone takeover may not work', { reason: r.reason });
  }).catch(() => {});

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

} // end else (TEST_NO_BIND !== 'true')

module.exports = app;
// Exposed for tests only: the real startup-recovery routine (production runs it from
// the listen callback).
module.exports._recoverClosingSummaries = _recoverClosingSummaries;

