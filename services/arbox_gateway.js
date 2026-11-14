'use strict';

/**
 * arbox_gateway.js — the ONLY module Tomer uses to talk to Arbox.
 *
 * Every function returns verified data together with where it came from and when
 * (`source`, `fetchedAt`, `stale`), or throws a typed error. Nothing here guesses.
 *
 * What the configured API key can do was established with GET/OPTIONS-only probes
 * (scripts/audit/arbox_capability_probe*.cjs) — see docs/ARBOX_CAPABILITY_MATRIX.md.
 *
 * READS (verified against the live API):
 *   /v3/users (paginated)                     member identity
 *   /v3/users/memberships?user_id             memberships: type, start/end, active, cancelled, debt
 *   /v3/reports/bookingsReport?user_id        a member's bookings: date, time, class, check_in, sessions_left
 *   /v3/schedule                              timetable: class, instructor, capacity, registration link
 *   /v3/reports/classesSummaryReport          real occupancy: registration_count, standby_members, status
 *   /v3/reports/bookingCancellationReport     recorded cancellations
 *   /v3/reports/membersOnHoldReport           freezes (row shape NOT yet seen live — no member was on hold)
 *
 * WRITES: routes exist (POST /v3/users/memberships/hold | cancel) but their request
 * contract is UNVERIFIED — it can only be learned by sending a POST. They are therefore
 * disabled in code (`WRITE_CONTRACTS[op].verified === false`) AND by configuration
 * (`ARBOX_WRITES_ENABLED` must be 'true'). There is NO route to book or cancel a
 * member's class, or to join a waitlist; `POST /v3/schedule/cancel` is suspected to
 * cancel the whole class for everyone and is never called.
 */

const axios  = require('axios');
const logger = require('../utils/logger');
const { ilDateString, addDays, ilParts } = require('../utils/callback_time');

const LOC = () => process.env.ARBOX_LOCATION_ID ?? '19392';

// ── Errors ────────────────────────────────────────────────────────────────────
class ArboxError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'ArboxError'; this.kind = kind; Object.assign(this, extra); }
}
// kind: 'unavailable' (network / timeout / 5xx / 429) | 'rejected' (4xx) | 'write_disabled' | 'bad_args'

// ── HTTP ──────────────────────────────────────────────────────────────────────
let _client = null;
function client() {
  if (_client) return _client;
  _client = axios.create({
    baseURL: process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public',
    headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json', 'Content-Type': 'application/json' },
    timeout: Number(process.env.ARBOX_TIMEOUT_MS) || 12000,
    validateStatus: () => true,
  });
  return _client;
}

// Simple politeness limiter: at most 3 requests in flight, 120 ms apart. Arbox sends no
// rate-limit headers; a 429 is honoured once using Retry-After.
let _inFlight = 0; const _waiters = []; let _lastStart = 0;
async function _slot() {
  if (_inFlight >= 3) await new Promise(r => _waiters.push(r));
  _inFlight++;
  const gap = (Number(process.env.ARBOX_MIN_GAP_MS ?? 120)) - (Date.now() - _lastStart);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _lastStart = Date.now();
}
function _release() { _inFlight--; const w = _waiters.shift(); if (w) w(); }

async function _get(path, params = {}, { retry429 = true } = {}) {
  await _slot();
  let res;
  try {
    res = await client().get(path, { params: { location_id: LOC(), ...params } });
  } catch (err) {
    throw new ArboxError('unavailable', `Arbox GET ${path} failed: ${err.code ?? err.message}`, { path, timeout: err.code === 'ECONNABORTED' });
  } finally { _release(); }
  if (res.status === 429 && retry429) {
    const wait = Math.min((Number(res.headers?.['retry-after']) || 2) * 1000, 8000);
    await new Promise(r => setTimeout(r, wait));
    return _get(path, params, { retry429: false });
  }
  if (res.status === 429 || res.status >= 500) throw new ArboxError('unavailable', `Arbox GET ${path} → ${res.status}`, { path, status: res.status });
  if (res.status >= 400) throw new ArboxError('rejected', `Arbox GET ${path} → ${res.status}`, { path, status: res.status, detail: res.data?.error?.message ?? null });
  return res.data;
}

async function _getAllPages(path, params = {}, { maxPages = 25 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const body  = await _get(path, { ...params, limit: 200, page });
    const batch = Array.isArray(body?.data) ? body.data : [];
    all.push(...batch);
    if (!body?.extra?.pagination?.next_page_url || batch.length === 0) break;
  }
  return all;
}

// ── Phone normalization (single canonical form: 972XXXXXXXXX) ─────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[^\d+]/g, '');
  if (!s) return null;
  let n;
  if (s.startsWith('+972'))       n = s.slice(1);
  else if (s.startsWith('00972')) n = s.slice(2);
  else if (s.startsWith('972'))   n = s;
  else if (s.startsWith('0'))     n = '972' + s.slice(1);
  else if (s.length === 9)        n = '972' + s;
  else                            n = s.replace(/^\+/, '');
  return /^\d{10,15}$/.test(n) ? n : null;
}

// ── Cache (stale-while-error) ─────────────────────────────────────────────────
const _cache = new Map();   // key → { at, value }
async function cached(key, ttlMs, loader, { maxStaleMs = 30 * 60 * 1000 } = {}) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return { value: hit.value, fetchedAt: hit.at, stale: false };
  try {
    const value = await loader();
    _cache.set(key, { at: Date.now(), value });
    return { value, fetchedAt: Date.now(), stale: false };
  } catch (err) {
    // Serve the previous copy, clearly marked stale, only for a bounded time.
    if (hit && now - hit.at < maxStaleMs) {
      logger.warn('[arbox-gateway] serving stale data', { key, ageSec: Math.round((now - hit.at) / 1000), error: err.message });
      return { value: hit.value, fetchedAt: hit.at, stale: true };
    }
    throw err;
  }
}
function clearCache(prefix = '') { for (const k of [..._cache.keys()]) if (k.startsWith(prefix)) _cache.delete(k); }

// ── Members ───────────────────────────────────────────────────────────────────
const USERS_TTL = 5 * 60 * 1000;

function _mapUser(u) {
  return {
    userId:    u.user_id,
    firstName: (u.first_name ?? '').trim() || null,
    lastName:  (u.last_name ?? '').trim() || null,
    name:      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || null,
    phoneRaw:  u.phone ?? null,
    phone:     normalizePhone(u.phone),
    role:      u.user_role ?? null,
    active:    u.active === 1,
    gender:    u.gender === 'female' || u.gender === 'male' ? u.gender : null,
    birthday:  /^\d{4}-\d{2}-\d{2}$/.test(u.birthday ?? '') ? u.birthday : null,          // YYYY-MM-DD as entered in Arbox
    memberSince: /^\d{4}-\d{2}-\d{2}/.test(u.membership_start_date ?? '') ? String(u.membership_start_date).slice(0, 10) : null,
    createdAt: u.created_time ?? null,                                                     // when the USER ROW was created (import time ≠ joining time)
  };
}

async function _userIndex() {
  return cached('users', USERS_TTL, async () => {
    const users = (await _getAllPages('/v3/users')).map(_mapUser);
    const byPhone = new Map(), byId = new Map();
    for (const u of users) {
      byId.set(String(u.userId), u);
      if (u.phone) byPhone.set(u.phone, [...(byPhone.get(u.phone) ?? []), u]);
    }
    return { byPhone, byId, count: users.length, all: users };
  });
}

/**
 * Resolve the Arbox member behind a WhatsApp phone.
 *   { status:'found', member, fetchedAt, stale }
 *   { status:'not_found' }           no member-type user has this phone
 *   { status:'ambiguous', count }    several member-type users share the phone — never guess
 *   { status:'unavailable', error }  Arbox could not be read (and no usable cached copy)
 * Only member-type users (client / aggregatorMember) are considered; an active one wins
 * over inactive ones; two active ones are ambiguous.
 */
async function resolveMember(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return { status: 'not_found' };
  let idx;
  try { idx = await _userIndex(); }
  catch (err) { return { status: 'unavailable', error: err.message }; }
  const all = (idx.value.byPhone.get(norm) ?? []).filter(u => u.role === 'client' || u.role === 'aggregatorMember');
  if (!all.length) return { status: 'not_found', fetchedAt: idx.fetchedAt, stale: idx.stale };
  const active = all.filter(u => u.active);
  const pick = active.length === 1 ? active[0] : (active.length === 0 && all.length === 1 ? all[0] : null);
  if (!pick) return { status: 'ambiguous', count: (active.length || all.length), fetchedAt: idx.fetchedAt, stale: idx.stale };
  return { status: 'found', member: pick, fetchedAt: idx.fetchedAt, stale: idx.stale, source: '/v3/users' };
}

async function getMemberById(userId) {
  const idx = await _userIndex();
  return idx.value.byId.get(String(userId)) ?? null;
}

/** Memberships of one member (verified server-side filter by user_id). */
async function getMemberships(userId) {
  if (!userId) throw new ArboxError('bad_args', 'userId required');
  const r = await cached(`memberships:${userId}`, 60 * 1000, async () => {
    const body = await _get('/v3/users/memberships', { user_id: userId, limit: 200 });
    const rows = (Array.isArray(body?.data) ? body.data : []).filter(m => String(m.user_id) === String(userId)); // defence in depth
    return rows.map(m => ({
      membershipUserId: m.membership_user_id,
      name:      m.membership_type_name ?? null,
      type:      m.type ?? null,              // 'plan' (period) | 'session' (punch card) | 'item' …
      startDate: m.start_time ?? null,        // YYYY-MM-DD
      endDate:   m.end_time ?? null,          // YYYY-MM-DD | null = no end date recorded
      active:    m.active === 1,
      cancelled: m.cancelled === 1,
      debt:      typeof m.debt === 'number' ? m.debt : null,
    }));
  });
  return { memberships: r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/users/memberships' };
}

// ── Bookings (of one member) ──────────────────────────────────────────────────
/**
 * Bookings of one member between two Israel dates (YYYY-MM-DD, inclusive; ≤ 31 days).
 * Rows carry no schedule_id, so a booking is identified by date + time + class name.
 */
async function getBookings(userId, { from, to, fresh = false } = {}) {
  if (!userId) throw new ArboxError('bad_args', 'userId required');
  const key = `bookings:${userId}:${from}:${to}`;
  if (fresh) _cache.delete(key);
  const r = await cached(key, 45 * 1000, async () => {
    const body = await _get('/v3/reports/bookingsReport', { user_id: userId, fromDate: from, toDate: to, limit: 200 });
    const rows = (Array.isArray(body?.data) ? body.data : []).filter(b => String(b.user_id) === String(userId));
    return rows.map(b => ({
      date: b.date, time: b.time, className: b.class_name ?? null, instructor: b.staff_member ?? null,
      checkedIn: b.check_in === 'Yes',
      sessionsLeft: (b.sessions_left === null || b.sessions_left === undefined || b.sessions_left === '') ? null : Number(b.sessions_left),
      membershipName: b.membership_type_name ?? null,
    })).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }, { maxStaleMs: 0 });   // bookings are never served stale: an action decision may depend on them
  return { bookings: r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/reports/bookingsReport' };
}

// ── Timetable + real occupancy ────────────────────────────────────────────────
/**
 * Classes between two Israel dates with REAL occupancy.
 *   occupancy: { registered, capacity, standby, spotsLeft } | null when the occupancy
 *   report could not be read — callers must then say that availability is unknown.
 */
async function getClasses({ from, to, fresh = false } = {}) {
  const key = `classes:${from}:${to}`;
  if (fresh) _cache.delete(key);
  const r = await cached(key, 60 * 1000, async () => {
    const sched = await _getAllPages('/v3/schedule', { from_date: from, to_date: to }, { maxPages: 5 });
    let occ = null, occError = null;
    try {
      const body = await _get('/v3/reports/classesSummaryReport', { fromDate: from, toDate: to, limit: 200 });
      occ = new Map((Array.isArray(body?.data) ? body.data : []).map(c => [String(c.schedule_id), c]));
    } catch (err) { occError = err.message; }
    const classes = sched.map(c => {
      const o = occ?.get(String(c.schedule_id)) ?? null;
      const capacity = Number.isFinite(c.max_participants) ? c.max_participants : null;
      return {
        scheduleId: c.schedule_id, date: c.date, start: c.start_time, end: c.end_time,
        name: c.session_name ?? 'שיעור', instructor: c.staff_member?.name ?? null,
        capacity, registrationLink: c.registration_link || null,
        status: o?.status ?? null,                                  // 'active' | 'cancelled' | null (unknown)
        occupancy: o && capacity !== null ? {
          registered: o.registration_count, capacity, standby: o.standby_members ?? 0,
          spotsLeft: Math.max(0, capacity - o.registration_count),
        } : null,
      };
    }).filter(c => c.status !== 'cancelled')
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    return { classes, occupancyAvailable: !!occ, occError };
  }, { maxStaleMs: 10 * 60 * 1000 });
  return { ...r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/schedule + /v3/reports/classesSummaryReport' };
}

/** Recorded booking cancellations of one member (client-side filtered by user_id). */
async function getCancellations(userId, { from, to } = {}) {
  // No server-side user filter: whether this report honours ?user_id is unconfirmed, so
  // the (short) date range is read whole and filtered here.
  const body = await _get('/v3/reports/bookingCancellationReport', { fromDate: from, toDate: to });
  const rows = (Array.isArray(body?.data) ? body.data : []).filter(c => String(c.user_id) === String(userId));
  return {
    cancellations: rows.map(c => ({ scheduleId: c.schedule_id, date: c.date, time: (c.start_time ?? '').slice(0, 5), className: c.class_name ?? null, cancelledAt: c.cancelled_time ?? null })),
    fetchedAt: Date.now(), stale: false, source: '/v3/reports/bookingCancellationReport',
  };
}

/**
 * Is this member on hold (frozen) at any point between the two dates?
 * NOTE: the row shape of membersOnHoldReport has not been observed live (no member was
 * on hold when the API was probed). Matching is by `user_id` or `membership_user_id`;
 * `matchedBy` and `rowFields` are returned so staff can see what the decision rests on.
 */
async function getHoldStatus(userId, { from, to, membershipUserId = null } = {}) {
  const body = await _get('/v3/reports/membersOnHoldReport', { fromDate: from, toDate: to, limit: 200 });
  const rows = Array.isArray(body?.data) ? body.data : [];
  const row = rows.find(r => String(r.user_id) === String(userId))
           ?? (membershipUserId ? rows.find(r => String(r.membership_user_id) === String(membershipUserId)) : null) ?? null;
  return {
    onHold: !!row, matchedBy: row ? (String(row.user_id) === String(userId) ? 'user_id' : 'membership_user_id') : null,
    rowFields: row ? Object.keys(row) : (rows[0] ? Object.keys(rows[0]) : []), totalRows: rows.length,
    fetchedAt: Date.now(), source: '/v3/reports/membersOnHoldReport',
  };
}

// ── Writes (guarded) ──────────────────────────────────────────────────────────
//
// A write runs only when BOTH are true:
//   1. ARBOX_WRITES_ENABLED === 'true'  (deployment switch — off by default)
//   2. WRITE_CONTRACTS[op].verified     (code switch — flipped only after the request
//      contract was verified against Arbox with an approved test member, see
//      scripts/arbox/verify_write_contract.cjs)
// The body builders below are the BEST-KNOWN ASSUMPTION of the contract (snake_case
// fields, as used everywhere else in v3) and are marked unverified.
const WRITE_CONTRACTS = {
  membership_hold: {
    verified: false, method: 'POST', path: '/v3/users/memberships/hold',
    body: a => ({ location_id: Number(LOC()), membership_user_id: a.membershipUserId, user_id: a.userId, start_date: a.from, end_date: a.to }),
  },
  membership_cancel: {
    verified: false, method: 'POST', path: '/v3/users/memberships/cancel',
    body: a => ({ location_id: Number(LOC()), membership_user_id: a.membershipUserId, user_id: a.userId, end_date: a.endDate ?? null }),
  },
};

// Tests may exercise the executor against a LOCAL mock with the assumed contract. This
// override is impossible outside tests: it needs NODE_ENV=test AND a loopback base URL.
function _testContractOverride() {
  return process.env.NODE_ENV === 'test' && process.env.ARBOX_TEST_ASSUME_CONTRACT === 'true'
    && /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(process.env.ARBOX_BASE_URL ?? '');
}
function writesEnabled(op) {
  return process.env.ARBOX_WRITES_ENABLED === 'true' && !!WRITE_CONTRACTS[op]
    && (WRITE_CONTRACTS[op].verified === true || _testContractOverride());
}
function writeStatus() {
  return Object.fromEntries(Object.entries(WRITE_CONTRACTS).map(([op, c]) => [op, {
    route: `${c.method} ${c.path}`, contractVerified: c.verified, switchOn: process.env.ARBOX_WRITES_ENABLED === 'true', executable: writesEnabled(op),
  }]));
}

/**
 * Execute one allow-listed write. Throws:
 *   ArboxError('write_disabled')            nothing was sent
 *   ArboxError('rejected', {submitted:true}) Arbox answered 4xx — not applied
 *   ArboxError('unavailable', {submitted:true, uncertain:true}) timeout / network / 5xx
 *        AFTER the request left — the outcome is UNKNOWN; the caller must read the
 *        resulting state before doing anything else and must never blindly retry.
 */
async function executeWrite(op, args) {
  const c = WRITE_CONTRACTS[op];
  if (!c) throw new ArboxError('bad_args', `unknown write operation: ${op}`);
  if (!writesEnabled(op)) throw new ArboxError('write_disabled', `Arbox write "${op}" is disabled (switch=${process.env.ARBOX_WRITES_ENABLED === 'true'}, contractVerified=${c.verified})`);
  if (!args?.userId || !args?.membershipUserId) throw new ArboxError('bad_args', 'userId and membershipUserId are required');
  let res;
  await _slot();
  try {
    res = await client().request({ method: c.method, url: c.path, data: c.body(args) });
  } catch (err) {
    throw new ArboxError('unavailable', `Arbox ${op} request did not complete: ${err.code ?? err.message}`, { submitted: true, uncertain: true });
  } finally { _release(); }
  clearCache(`memberships:${args.userId}`);
  if (res.status >= 500 || res.status === 429) throw new ArboxError('unavailable', `Arbox ${op} → ${res.status}`, { submitted: true, uncertain: true, status: res.status });
  if (res.status >= 400) throw new ArboxError('rejected', `Arbox ${op} → ${res.status}`, { submitted: true, status: res.status, detail: JSON.stringify(res.data?.error?.message ?? res.data ?? '').slice(0, 300) });
  return { accepted: true, status: res.status };   // accepted ≠ completed: the caller verifies by reading back
}

// ── Studio-wide reads for member care (all read-only, all paged) ──────────────
//
// Field meanings below were OBSERVED with GET-only probes on 2026-11-14
// (scripts/audit/arbox_care_probe.cjs). Nothing here is assumed from a route name.

/** Every user row (members, staff, aggregator members), with birthday / member-since. */
async function getAllUsers() {
  const idx = await _userIndex();
  return { users: idx.value.all, fetchedAt: idx.fetchedAt, stale: idx.stale, source: '/v3/users' };
}

/**
 * Every membership row of the studio (paged, 200 per page; ~1,350 rows observed).
 *   createdAt  when the membership ROW was created in Arbox (purchase / renewal / import)
 *   startDate / endDate  validity; a recurring plan has NO end date
 *   typeId     joins to getMembershipTypes(); types that were deleted are missing there
 */
async function getAllMemberships() {
  const r = await cached('memberships:all', 10 * 60 * 1000, async () => {
    const rows = await _getAllPages('/v3/users/memberships', {}, { maxPages: 40 });
    return rows.map(m => ({
      membershipUserId: m.membership_user_id, userId: m.user_id, typeId: m.membership_type_id ?? null,
      name: m.membership_type_name ?? null, rowType: m.type ?? null,
      startDate: m.start_time ?? null, endDate: m.end_time ?? null,
      createdAt: m.created_at ?? null, active: m.active === 1, cancelled: m.cancelled === 1,
      debt: typeof m.debt === 'number' ? m.debt : null,
    }));
  }, { maxStaleMs: 0 });
  return { memberships: r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/users/memberships (all pages)' };
}

/** Membership types currently defined: kind ('plan' | 'trial' | 'session' | 'onetime' | 'item' | 'service') and whether they renew by recurring charge. */
async function getMembershipTypes() {
  const r = await cached('membershipTypes', 60 * 60 * 1000, async () => {
    const rows = await _getAllPages('/v3/membershipTypes', {}, { maxPages: 5 });
    return rows.map(t => ({ typeId: t.membership_type_id, name: t.membership_type_name ?? null, kind: t.type ?? null, recurring: t.is_recurring_payment === 1 }));
  });
  return { types: r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/membershipTypes' };
}

/**
 * All bookings of all members between two Israel dates (inclusive, ≤ 31 days — the API
 * rejects longer ranges). checkedIn === true is the only VERIFIED attendance signal.
 * Never served stale: "no attendance" must not be concluded from an old copy.
 */
async function getAllBookings({ from, to }) {
  const r = await cached(`bookings:all:${from}:${to}`, 5 * 60 * 1000, async () => {
    const rows = await _getAllPages('/v3/reports/bookingsReport', { fromDate: from, toDate: to }, { maxPages: 60 });
    return rows.filter(b => b.user_role !== 'staffMember').map(b => ({
      userId: b.user_id, date: b.date, time: b.time, className: b.class_name ?? null,
      checkedIn: b.check_in === 'Yes', firstSession: b.is_first_session === 'Yes',
    }));
  }, { maxStaleMs: 0 });
  return { bookings: r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/reports/bookingsReport (all pages)' };
}

/** All recorded booking cancellations in a date range (≤ 31 days). */
async function getAllCancellations({ from, to }) {
  const r = await cached(`cancellations:all:${from}:${to}`, 5 * 60 * 1000, async () => {
    const rows = await _getAllPages('/v3/reports/bookingCancellationReport', { fromDate: from, toDate: to }, { maxPages: 30 });
    return rows.map(c => ({ userId: c.user_id, date: c.date, time: String(c.start_time ?? '').slice(0, 5), className: c.class_name ?? null }));
  }, { maxStaleMs: 0 });
  return { cancellations: r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/reports/bookingCancellationReport' };
}

/**
 * Members on hold in a date range (≤ 31 days). The row shape has never been observed
 * live (no member was on hold when probed) — matching is by user_id only, and `rowFields`
 * is returned so the first real row can be inspected.
 */
async function getHolds({ from, to }) {
  const r = await cached(`holds:${from}:${to}`, 10 * 60 * 1000, async () => {
    const body = await _get('/v3/reports/membersOnHoldReport', { fromDate: from, toDate: to, limit: 200 });
    const rows = Array.isArray(body?.data) ? body.data : [];
    return { userIds: [...new Set(rows.map(x => x.user_id).filter(v => v !== undefined && v !== null).map(String))], totalRows: rows.length, rowFields: rows[0] ? Object.keys(rows[0]) : [] };
  }, { maxStaleMs: 0 });
  return { ...r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/reports/membersOnHoldReport' };
}

/**
 * Card transactions in a date range (≤ 31 days). Observed fields: status 'SUCCESS' | 'FAIL',
 * type 'RECURRING' | 'REGULAR', recurring_payment_id, membership_user_id, date-time.
 * Card digits, vouchers and receipts are deliberately NOT kept.
 */
async function getTransactions({ from, to }) {
  const r = await cached(`transactions:${from}:${to}`, 10 * 60 * 1000, async () => {
    const rows = await _getAllPages('/v3/reports/transactionsReport', { fromDate: from, toDate: to }, { maxPages: 30 });
    return rows.map(t => ({
      transactionId: t.transaction_id, userId: t.user_id, membershipUserId: t.membership_user_id ?? null,
      recurringPaymentId: t.recurring_payment_id ?? null, at: t.transaction_date_time ?? t.transaction_date ?? null,
      date: t.transaction_date ?? String(t.transaction_date_time ?? '').slice(0, 10), kind: t.type ?? null, status: t.status ?? null, itemName: t.item_name ?? null,
    }));
  }, { maxStaleMs: 0 });
  return { transactions: r.value, fetchedAt: r.fetchedAt, stale: r.stale, source: '/v3/reports/transactionsReport' };
}

// ── Date helpers for callers ──────────────────────────────────────────────────
function todayIL(now = new Date()) { return ilDateString(now); }
function dateIL(offsetDays, now = new Date()) { const p = ilParts(now); return ilDateString(addDays({ year: p.year, month: p.month, day: p.day }, offsetDays)); }

function _resetForTests() { _cache.clear(); _client = null; }

module.exports = {
  ArboxError, normalizePhone,
  resolveMember, getMemberById, getMemberships, getBookings, getClasses, getCancellations, getHoldStatus,
  getAllUsers, getAllMemberships, getMembershipTypes, getAllBookings, getAllCancellations, getHolds, getTransactions,
  executeWrite, writesEnabled, writeStatus, WRITE_CONTRACTS,
  todayIL, dateIL, clearCache, _resetForTests,
};
