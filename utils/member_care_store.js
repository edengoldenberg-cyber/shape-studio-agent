'use strict';

/**
 * member_care_store.js — durable state of Tomer's proactive member care.
 *
 * DATA_DIR/member_care.json, atomic (tmp + rename) after every mutation; a failed write
 * THROWS and the in-memory change is rolled back (same contract as service_case_store).
 *
 * {
 *   settings: { programs: { <id>: { enabled, hour, activatedAt } }, groupLink, paymentResolution,
 *               billingDataConfirmed, policy: {...}, updatedAt, updatedBy },
 *   episodes: { <key>: episode },      // one per member + program + eligibility episode
 *   pauses:   { <phone>: { reason, note, until, endKnown, setBy, setAt, userId, name } },
 *   careOptOut: { <phone>: { at, via } },                 // "stop writing to me" — proactive only
 *   entitlements: { <userId>: { userId, phone, name, kind, total, issuedAt, episodeKey, items: [...] } },
 *   runs: [ { at, trigger, programs, considered, sent, deferred, blocked, failed, uncertain } ],   (last 200)
 *   lastRun: { <program>: 'YYYY-MM-DD' },                 // Israel date of the last scheduled run
 *   lock: null | { owner, until },                        // one run at a time, also across processes
 * }
 *
 * episode = {
 *   key, program, userId, phone, name, episodeKey, variant, synthetic,
 *   sourceDates: {...},                 // the Arbox dates the eligibility rests on
 *   status,   // pending | deferred | blocked | sending | sent | failed | uncertain | closed | expired | cancelled
 *   reasons: [...],                     // why it is deferred / blocked / cancelled / expired
 *   validUntil,                         // Israel date after which it is no longer sent
 *   send: { state, startedAt, at, idMessage, text, error, attempts },
 *   conversation: { awaiting, outcome, lastReplyAt, replies: [{ at, text, kind }] },
 *   caseId, createdAt, updatedAt, history: [{ at, type, detail }]   (last 40)
 * }
 */

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const dataDir = () => (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, '');
const file    = () => path.join(dataDir(), 'member_care.json');

const PROGRAM_IDS = ['welcome', 'payment_failed', 'birthday', 'expiry5', 'absence14', 'absence7', 'tuesday', 'onboarding14', 'month1'];   // priority order

/** Proposed defaults — every value is shown in the panel and can be changed there. */
const DEFAULT_POLICY = {
  windowStart: 9,              // proactive messages are sent 09:00–20:00 Israel time
  windowEnd: 20,
  fridayEnd: 13,               // Friday until 13:00
  saturday: false,             // nothing on Saturday
  birthdaySaturday: 'friday',  // a Saturday birthday is greeted on Friday ('friday' | 'sunday')
  cooldownHours: 72,           // at most one routine proactive message per member in 72h
  attendanceCooldownDays: 6,   // Tuesday / 7-day / 14-day never closer than 6 days to each other
  recentConversationHours: 24, // no routine message while a conversation was active in the last 24h
  replyWindowDays: 5,          // a reply within 5 days continues the proactive conversation
  defaultPauseDays: 14,        // pause length when the member gave no return date
  paymentGraceHours: 24,       // wait a day after a failed charge before writing
  managerDigest: false,        // scheduled manager digest — off until approved
};
const DEFAULT_HOURS = { welcome: 10, payment_failed: 11, birthday: 9, expiry5: 10, absence14: 10, absence7: 10, tuesday: 10, onboarding14: 11, month1: 11 };

function defaults() {
  return {
    settings: {
      programs: Object.fromEntries(PROGRAM_IDS.map(id => [id, { enabled: false, hour: DEFAULT_HOURS[id], activatedAt: null }])),
      groupLink: null, paymentResolution: null, billingDataConfirmed: false,
      policy: { ...DEFAULT_POLICY }, updatedAt: null, updatedBy: null,
    },
    episodes: {}, pauses: {}, careOptOut: {}, entitlements: {}, runs: [], lastRun: {}, lock: null,
  };
}

let _state = null;
function _load() {
  if (_state) return _state;
  const s = defaults();
  try {
    if (fs.existsSync(file())) {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      const d = defaults();
      Object.assign(s, raw);
      s.settings = { ...d.settings, ...(raw.settings ?? {}) };
      s.settings.policy = { ...DEFAULT_POLICY, ...(raw.settings?.policy ?? {}) };
      s.settings.programs = Object.fromEntries(PROGRAM_IDS.map(id => [id, { ...d.settings.programs[id], ...(raw.settings?.programs?.[id] ?? {}) }]));
      for (const k of ['episodes', 'pauses', 'careOptOut', 'entitlements', 'lastRun']) s[k] = raw[k] ?? {};
      s.runs = raw.runs ?? []; s.lock = raw.lock ?? null;
    }
  } catch (err) {
    const bad = file() + '.corrupt-' + Date.now();
    try { fs.copyFileSync(file(), bad); } catch { /* ignore */ }
    console.error('[member-care] could not read member_care.json — copied to', bad, err.message);
  }
  _state = s;
  return s;
}
function _persist() {
  if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ..._load(), savedAt: new Date().toISOString() }, null, 1), 'utf8');
  fs.renameSync(tmp, file());
}
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
/** Run a mutation; on a failed write restore the previous state and rethrow. */
function mutate(fn) {
  const s = _load();
  const snap = JSON.stringify(s);
  try { const out = fn(s); _persist(); return clone(out); }
  catch (err) { _state = JSON.parse(snap); throw err; }
}
const nowIso = () => new Date().toISOString();

// ── settings ──────────────────────────────────────────────────────────────────
const getSettings = () => clone(_load().settings);
function updateSettings(patch, by = 'staff') {
  return mutate(s => {
    const { policy, programs, ...rest } = patch ?? {};
    Object.assign(s.settings, rest);
    if (policy) s.settings.policy = { ...s.settings.policy, ...policy };
    if (programs) for (const [id, p] of Object.entries(programs)) if (s.settings.programs[id]) s.settings.programs[id] = { ...s.settings.programs[id], ...p };
    s.settings.updatedAt = nowIso(); s.settings.updatedBy = by;
    return s.settings;
  });
}

// ── episodes ──────────────────────────────────────────────────────────────────
const episodeKey = (program, userId, key) => `${program}|${userId}|${key}`;
const getEpisode = key => clone(_load().episodes[key] ?? null);
function listEpisodes({ program, status, phone, userId, limit = 500 } = {}) {
  let rows = Object.values(_load().episodes);
  if (program) rows = rows.filter(e => e.program === program);
  if (status)  rows = rows.filter(e => (Array.isArray(status) ? status.includes(e.status) : e.status === status));
  if (phone)   rows = rows.filter(e => e.phone === phone);
  if (userId !== undefined) rows = rows.filter(e => String(e.userId) === String(userId));
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return clone(rows.slice(0, limit));
}
/** Create or patch an episode and append a history event. `patch.send` / `patch.conversation` are merged. */
function upsertEpisode(key, patch = {}, event = null) {
  return mutate(s => {
    const at = nowIso();
    const cur = s.episodes[key] ?? { key, status: 'pending', reasons: [], send: { state: null, attempts: 0 }, conversation: { awaiting: null, outcome: null, lastReplyAt: null, replies: [] }, caseId: null, createdAt: at, history: [] };
    const { send, conversation, ...rest } = patch;
    Object.assign(cur, rest);
    if (send) cur.send = { ...cur.send, ...send };
    if (conversation) cur.conversation = { ...cur.conversation, ...conversation };
    if (event) cur.history = [...cur.history, { at, ...event }].slice(-40);
    cur.updatedAt = at;
    s.episodes[key] = cur;
    return cur;
  });
}

// ── pauses / proactive opt-out ────────────────────────────────────────────────
function getPause(phone, now = new Date()) {
  const p = _load().pauses[phone];
  if (!p) return null;
  if (p.until && new Date(p.until + 'T23:59:59+02:00').getTime() < now.getTime()) return null;   // ended
  return clone(p);
}
const listPauses = () => clone(Object.entries(_load().pauses).map(([phone, p]) => ({ phone, ...p })));
function setPause(phone, { reason, note = null, until = null, endKnown = !!until, setBy = 'staff', userId = null, name = null }) {
  return mutate(s => { s.pauses[phone] = { reason, note, until, endKnown, setBy, setAt: nowIso(), userId, name }; return s.pauses[phone]; });
}
function clearPause(phone) { if (_load().pauses[phone]) mutate(s => { delete s.pauses[phone]; }); }
const isCareOptedOut = phone => !!_load().careOptOut[phone];
function setCareOptOut(phone, via = 'member') { return mutate(s => { s.careOptOut[phone] = { at: nowIso(), via }; return s.careOptOut[phone]; }); }
function clearCareOptOut(phone) { if (_load().careOptOut[phone]) mutate(s => { delete s.careOptOut[phone]; }); }

// ── guest-session entitlements ────────────────────────────────────────────────
const ACTIVE_ITEM = new Set(['reserved', 'redeemed']);
function _view(e) { const used = e.items.filter(i => ACTIVE_ITEM.has(i.status)); return { ...e, reserved: used.filter(i => i.status === 'reserved').length, redeemed: used.filter(i => i.status === 'redeemed').length, remaining: e.total - used.length }; }
const getEntitlement = userId => { const e = _load().entitlements[String(userId)]; return e ? clone(_view(e)) : null; };
const listEntitlements = () => clone(Object.values(_load().entitlements).map(_view));
/** Issue once per member — a second call returns the existing entitlement unchanged. */
function issueEntitlement({ userId, phone, name, total = 2, episodeKey: ek = null, kind = 'guest_sessions' }) {
  return mutate(s => {
    const id = String(userId);
    if (s.entitlements[id]) return { ..._view(s.entitlements[id]), alreadyIssued: true };
    s.entitlements[id] = { userId: id, phone, name, kind, total, issuedAt: nowIso(), episodeKey: ek, items: [] };
    return _view(s.entitlements[id]);
  });
}
function reserveGuest(userId, { guestName = null, note = null, by = 'staff', caseId = null } = {}) {
  return mutate(s => {
    const e = s.entitlements[String(userId)];
    if (!e) return { ok: false, error: 'no_entitlement' };
    if (_view(e).remaining <= 0) return { ok: false, error: 'none_remaining' };
    const item = { id: 'g-' + randomUUID().slice(0, 8), status: 'reserved', guestName, note, by, caseId, at: nowIso(), redeemedAt: null };
    e.items.push(item);
    return { ok: true, item, entitlement: _view(e) };
  });
}
function _itemOp(userId, itemId, fn) {
  return mutate(s => {
    const e = s.entitlements[String(userId)];
    const item = e?.items.find(i => i.id === itemId);
    if (!item) return { ok: false, error: 'not_found' };
    const err = fn(item);
    return err ? { ok: false, error: err } : { ok: true, item, entitlement: _view(e) };
  });
}
const redeemGuest  = (userId, itemId, by = 'staff') => _itemOp(userId, itemId, i => { if (i.status === 'redeemed') return 'already_redeemed'; if (i.status !== 'reserved') return 'not_reserved'; i.status = 'redeemed'; i.redeemedAt = nowIso(); i.redeemedBy = by; return null; });
const releaseGuest = (userId, itemId, by = 'staff') => _itemOp(userId, itemId, i => { if (i.status !== 'reserved') return i.status === 'redeemed' ? 'already_redeemed' : 'not_reserved'; i.status = 'released'; i.releasedAt = nowIso(); i.releasedBy = by; return null; });

// ── runs, schedule, lock ──────────────────────────────────────────────────────
function recordRun(run) { return mutate(s => { s.runs = [...s.runs, { at: nowIso(), ...run }].slice(-200); return run; }); }
const listRuns = (limit = 30) => clone(_load().runs.slice(-limit).reverse());
const lastRunDate = program => _load().lastRun[program] ?? null;
function markRan(program, ilDate) { mutate(s => { s.lastRun[program] = ilDate; }); }
/** Durable lock so two workers (or two processes after a deploy overlap) never run together. */
function acquireLock(owner, ttlMs = 10 * 60 * 1000, now = Date.now()) {
  const cur = _load().lock;
  if (cur && cur.owner !== owner && cur.until > now) return false;
  mutate(s => { s.lock = { owner, until: now + ttlMs }; });
  return true;
}
function releaseLock(owner) { if (_load().lock?.owner === owner) mutate(s => { s.lock = null; }); }

function reload() { _state = null; return _load(); }

module.exports = {
  PROGRAM_IDS, DEFAULT_POLICY, getSettings, updateSettings,
  episodeKey, getEpisode, listEpisodes, upsertEpisode,
  getPause, listPauses, setPause, clearPause, isCareOptedOut, setCareOptOut, clearCareOptOut,
  getEntitlement, listEntitlements, issueEntitlement, reserveGuest, redeemGuest, releaseGuest,
  recordRun, listRuns, lastRunDate, markRan, acquireLock, releaseLock, reload,
};
