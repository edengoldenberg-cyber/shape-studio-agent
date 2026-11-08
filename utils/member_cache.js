'use strict';

/**
 * member_cache.js — Durable in-process member identity cache.
 *
 * Purpose: eliminate false-positive routing of Arbox members into Barak's
 * lead qualification funnel when the Arbox API is slow or unreachable.
 *
 * Layer model:
 *   L1 — _map (in-process, sub-millisecond)
 *   L2 — member_cache.json (file-backed, survives Railway redeploys if DATA_DIR volume is mounted)
 *
 * TTLs:
 *   SOFT_TTL (5 min) — treat the entry as fresh; skip Arbox live lookup entirely.
 *   HARD_TTL (24 hr) — treat the entry as confirmed even if Arbox is unreachable.
 *   Entries older than HARD_TTL are stale and require an Arbox re-confirmation.
 *
 * Usage in server.js:
 *   const memberCache = require('./utils/member_cache');
 *
 *   // Seed on startup + every 15 min
 *   await memberCache.seedFromArbox();
 *
 *   // During routing (before Arbox call)
 *   if (memberCache.isConfirmed(phone)) → route to Tomer
 *
 *   // After successful Arbox lookup
 *   memberCache.markConfirmed(phone, { name, role, source: 'arbox_live' });
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const DATA_DIR    = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
const CACHE_PATH  = path.join(DATA_DIR, 'member_cache.json');
const SOFT_TTL_MS = 5  * 60 * 1000;   //  5 minutes — skip live Arbox lookup
const HARD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours  — survive outage window

// ─── In-process map: E164 phone → { confirmedAt, source, name, role } ─────────
const _map   = new Map();
let   _dirty = false;

// ─── File I/O ──────────────────────────────────────────────────────────────────

function _load() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    let loaded = 0;
    for (const [phone, entry] of Object.entries(raw.members ?? {})) {
      // Skip entries that have exceeded the hard TTL — they'll be re-seeded
      const age = Date.now() - new Date(entry.confirmedAt ?? 0).getTime();
      if (age < HARD_TTL_MS) { _map.set(phone, entry); loaded++; }
    }
    logger.info('[member-cache] Loaded from disk', { count: loaded, path: CACHE_PATH });
  } catch (err) {
    logger.warn('[member-cache] Load failed — starting empty', { error: err.message });
  }
}

function _flush() {
  if (!_dirty) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [k, v] of _map) obj[k] = v;
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ members: obj, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, CACHE_PATH);
    _dirty = false;
  } catch (err) {
    logger.warn('[member-cache] Flush failed', { error: err.message });
  }
}

// Flush every 30 seconds — non-blocking background interval
setInterval(_flush, 30_000).unref();

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Mark a phone as a confirmed member. Source is recorded for auditing.
 * @param {string} phone - E164 without + (e.g. "972501234567")
 * @param {{ name?: string, role?: string, source?: string }} opts
 */
function markConfirmed(phone, { name = null, role = 'client', source = 'arbox_live' } = {}) {
  if (!phone) return;
  _map.set(phone, { confirmedAt: new Date().toISOString(), source, name, role });
  _dirty = true;
}

/**
 * Returns true if the phone is a confirmed member within the HARD_TTL window.
 * This is the primary gate: use this before any Arbox API call.
 */
function isConfirmed(phone) {
  if (!phone) return false;
  const entry = _map.get(phone);
  if (!entry) return false;
  return Date.now() - new Date(entry.confirmedAt).getTime() < HARD_TTL_MS;
}

/**
 * Returns true if the phone was confirmed within SOFT_TTL — fresh enough to
 * skip the live Arbox lookup entirely.
 */
function isFresh(phone) {
  if (!phone) return false;
  const entry = _map.get(phone);
  if (!entry) return false;
  return Date.now() - new Date(entry.confirmedAt).getTime() < SOFT_TTL_MS;
}

/** Returns the raw cache entry, or null if not present. */
function getEntry(phone) { return _map.get(phone) ?? null; }

/**
 * Remove a phone from the cache. Use when a member's subscription expires
 * or when they are manually de-listed.
 */
function invalidate(phone) {
  if (!phone) return;
  _map.delete(phone);
  _dirty = true;
}

/** Current number of confirmed members in the in-process cache. */
function size() { return _map.size; }

/**
 * Synchronous file-only check against known_members.json.
 * Use this as the isKnownMember fallback in modules that cannot import
 * server.js helpers (e.g. tomer_agent.js, conversion_detector.js).
 * Does NOT require a live Arbox call and survives restarts.
 */
function isKnownMemberFile(phone) {
  if (!phone) return false;
  try {
    const knownPath = path.join(DATA_DIR, 'known_members.json');
    const data = JSON.parse(fs.readFileSync(knownPath, 'utf8'));
    const phones = new Set(data.phones ?? []);
    // Check both raw form and E164 normalized form
    const s = String(phone).replace(/[\s\-\.\(\)]/g, '').replace(/^\+/, '');
    const norm = s.startsWith('972') ? s
               : s.startsWith('0')   ? '972' + s.slice(1)
               : s;
    return phones.has(phone) || phones.has(norm);
  } catch { return false; }
}

/** Force an immediate flush to disk (useful before graceful shutdown). */
function flush() { _dirty = true; _flush(); }

// ─── Scheduled Arbox seeding ───────────────────────────────────────────────────

/**
 * Seed the member cache from a live Arbox fetch. Call this on startup and
 * every 15 minutes via cron. Non-blocking: errors are caught and logged.
 *
 * Fetches ALL users (active=0 included) so aggregators and recently expired
 * members are covered. Only marks users whose active=1 OR role=aggregatorMember.
 *
 * @param {{ normalizeToE164: function, _autoAddKnownMember: function }} helpers
 *   Pass the normalization and auto-add helpers from server.js to avoid circular deps.
 * @returns {Promise<{ seeded: number, skipped: number, error?: string }>}
 */
async function seedFromArbox({ normalizeToE164, _autoAddKnownMember } = {}) {
  let arboxSvc;
  try { arboxSvc = require('../services/arbox.service'); } catch {
    return { seeded: 0, skipped: 0, error: 'arbox_service_unavailable' };
  }

  let users = [];
  try {
    // getAllUsers fetches active + inactive so we don't miss aggregators with active=0
    users = await arboxSvc.getAllUsers({ limit: 1000 });
  } catch (err) {
    logger.warn('[member-cache] Arbox seed failed — API unreachable', { error: err.message });
    return { seeded: 0, skipped: 0, error: err.message };
  }

  let seeded = 0, skipped = 0;
  for (const u of users) {
    if (!u.phone) { skipped++; continue; }

    // Only cache confirmed members: active clients and aggregators
    const isMember = u.active === 1 || u.user_role === 'aggregatorMember';
    if (!isMember) { skipped++; continue; }

    const phone = normalizeToE164 ? normalizeToE164(u.phone) : u.phone.replace(/[\s\-+()]/g, '');
    if (!phone) { skipped++; continue; }

    const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || null;
    markConfirmed(phone, { name, role: u.user_role ?? 'client', source: 'arbox_scheduled' });

    if (_autoAddKnownMember) {
      _autoAddKnownMember(phone, name);
    }
    seeded++;
  }

  logger.info('[member-cache] Arbox seed complete', { seeded, skipped, total: users.length });
  return { seeded, skipped };
}

// Initialize: load from file on first require
_load();

module.exports = {
  markConfirmed,
  isConfirmed,
  isFresh,
  getEntry,
  invalidate,
  size,
  flush,
  seedFromArbox,
  isKnownMemberFile,
};
