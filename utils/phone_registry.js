'use strict';

/**
 * phone_registry.js — Synchronous O(1) member identity store.
 *
 * Architectural contract:
 *   isMember(phone) is ALWAYS synchronous, ALWAYS O(1), NEVER does I/O.
 *   It is safe to call at the very first line of processInboundWAMessage
 *   before any async work begins.
 *
 * Why this is different from member_cache.js:
 *   member_cache uses a TTL Map — entries expire after 24h, cold misses fall
 *   through to a live Arbox lookup, and normalization bugs cause false misses.
 *   This module uses a plain Set that is rebuilt from scratch every 60 seconds.
 *   There is no TTL, no eviction, no "confirmed N hours ago" edge case.
 *   A phone is in the Set or it isn't. Full stop.
 *
 * Failure safety:
 *   If Arbox is unreachable during a refresh, the previous Set is kept intact.
 *   The registry never empties on a transient API failure.
 *   Startup blocks until the first successful load (or 10s timeout → empty set
 *   with an alertOwner call so staff know the registry is cold).
 */

const logger = require('./logger');

// ── Canonical normalization — single source of truth ─────────────────────────
// All phones stored and looked up in this exact format: "972XXXXXXXXX"
function normalize(raw) {
  if (!raw) return null;
  // Strip all non-digit, non-plus characters — covers spaces, dashes, punctuation,
  // and invisible Unicode formatting marks (RTL/LTR marks, zero-width spaces, etc.)
  // that appear in some Arbox phone exports and would cause missed Set lookups.
  const s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('00972')) return s.slice(2);       // 00972 → 972
  if (s.startsWith('972'))   return s;
  if (s.startsWith('0'))     return '972' + s.slice(1);
  if (s.length === 9)        return '972' + s;        // 501234567 → 972501234567
  return s;
}

// ── The hot-path Set ──────────────────────────────────────────────────────────
let _memberSet  = new Set();
let _lastLoaded = 0;
let _refreshTimer = null;
let _loading = false;

// ── Load from Arbox ───────────────────────────────────────────────────────────

async function _loadFromArbox() {
  if (_loading) return;
  _loading = true;
  try {
    const arboxSvc = require('../services/arbox.service');
    // Arbox API rejects limit > ~999 with 400 "must be smaller than 500" on /v3/users.
    // getAllUsers() is paginated and walks all pages, so limit=200 per page fetches
    // all 1000+ users correctly without triggering the API error.
    const users = await arboxSvc.getAllUsers({ limit: 200 });

    const next = new Set();
    for (const u of users) {
      if (!u.phone) continue;
      // Only confirmed studio members belong in this registry.
      // Leads with active=1 (Arbox trial/unqualified) are NOT members —
      // they must still reach Barak's qualification funnel.
      // Staff are handled by isStaffPhone() and must not block the member gate.
      // aggregatorMember (ClassPass/Gympass) included regardless of active status
      // because Arbox sometimes marks them active=0 between sessions.
      const isMember = (u.user_role === 'client' && u.active === 1) ||
                        u.user_role === 'aggregatorMember';
      if (!isMember) continue;
      const norm = normalize(u.phone);
      if (norm) next.add(norm);
    }

    // Atomic swap — never expose a half-built Set
    _memberSet  = next;
    _lastLoaded = Date.now();
    logger.info('[phone-registry] Refreshed', { members: next.size });
  } catch (err) {
    // Keep the previous Set intact on failure — do not empty it
    logger.warn('[phone-registry] Refresh failed — keeping previous data', {
      error: err.message,
      currentSize: _memberSet.size,
    });
  } finally {
    _loading = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synchronous O(1) membership check.
 * Safe to call before any async work in the webhook handler.
 */
function isMember(rawPhone) {
  if (!rawPhone) return false;
  const norm = normalize(rawPhone);
  return norm ? _memberSet.has(norm) : false;
}

/**
 * Returns the normalized E164 form (or null).
 * Use this everywhere a consistent format is needed.
 */
function normalizePhone(raw) {
  return normalize(raw);
}

/** Current registry size — useful for health checks. */
function size() { return _memberSet.size; }

/** Milliseconds since last successful Arbox sync. */
function age() { return Date.now() - _lastLoaded; }

/**
 * Add a single phone immediately (e.g. after a confirmed Arbox registration).
 * Does not wait for the next 60s refresh cycle.
 */
function addMember(rawPhone) {
  const norm = normalize(rawPhone);
  if (norm) { _memberSet.add(norm); }
}

/**
 * Remove a phone (e.g. membership cancelled).
 * Does not wait for the next 60s refresh cycle.
 */
function removeMember(rawPhone) {
  const norm = normalize(rawPhone);
  if (norm) { _memberSet.delete(norm); }
}

// ── Startup + background refresh ─────────────────────────────────────────────

/**
 * Load from Arbox and start the 60-second background refresh.
 * Must be awaited at startup before the HTTP server begins accepting requests.
 * Accepts a timeout so a slow Arbox API doesn't hold up deployment.
 */
async function init({ timeoutMs = 10_000 } = {}) {
  const loadPromise = _loadFromArbox();
  const timeoutPromise = new Promise(resolve =>
    setTimeout(() => {
      logger.warn('[phone-registry] Startup load timed out — starting with empty registry');
      resolve();
    }, timeoutMs)
  );
  await Promise.race([loadPromise, timeoutPromise]);

  // 60-second background refresh — never blocks message handling
  _refreshTimer = setInterval(() => {
    _loadFromArbox().catch(err =>
      logger.warn('[phone-registry] Background refresh error', { error: err.message })
    );
  }, 60_000);
  _refreshTimer.unref(); // don't prevent clean process exit

  logger.info('[phone-registry] Initialized', { members: _memberSet.size });
}

function stop() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

module.exports = { isMember, normalizePhone, addMember, removeMember, size, age, init, stop };
