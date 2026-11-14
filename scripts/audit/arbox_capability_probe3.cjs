#!/usr/bin/env node
/**
 * arbox_capability_probe3.cjs — third READ-ONLY pass. Uses GET and OPTIONS only.
 * (OPTIONS asks the server which methods a route accepts; it performs no action.)
 * Prints field names / types and counts only — no member data.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const LOC  = process.env.ARBOX_LOCATION_ID ?? '19392';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('BASE points at a mock'); process.exit(2); }
const http = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json' }, timeout: 25000, validateStatus: () => true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function shape(v, d = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${shape(v[0], d + 1)}]×${v.length}` : '[]';
  if (typeof v === 'object') return d >= 2 ? '{…}' : '{' + Object.entries(v).map(([k, x]) => `${k}:${shape(x, d + 1)}`).join(', ') + '}';
  return typeof v;
}
const get = async (p, params = {}) => { await sleep(300); return http.get(p, { params: { location_id: LOC, ...params } }); };
const options = async p => { await sleep(300); return http.request({ method: 'OPTIONS', url: p, params: { location_id: LOC } }); };
const iso = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  // ── allowed methods ──────────────────────────────────────────────────────────
  console.log('── OPTIONS (allowed methods) ──');
  for (const p of ['/v3/schedule', '/v3/schedule/cancel', '/v3/users', '/v3/users/memberships', '/v3/users/memberships/hold', '/v3/users/memberships/cancel', '/v3/users/memberships/update', '/v3/users/notes', '/v3/tasks', '/v3/leads', '/v3/entrances', '/v3/webhooks', '/v3/customFields', '/v3/membershipTypes', '/v3/reports/bookingsReport']) {
    const r = await options(p);
    console.log(`  ${p.padEnd(34)} ${r.status} allow=${r.headers.allow ?? r.headers['access-control-allow-methods'] ?? '-'}`);
  }

  // ── report shapes with dates ────────────────────────────────────────────────
  console.log('\n── reports (fromDate/toDate) ──');
  const past = { fromDate: iso(-14), toDate: iso(0) }, fut = { fromDate: iso(0), toDate: iso(7) }, wide = { fromDate: iso(-14), toDate: iso(7) };
  const R = async (name, params, label = '') => {
    const r = await get(`/v3/reports/${name}`, params);
    const list = Array.isArray(r.data?.data) ? r.data.data : null;
    console.log(`  ${(name + label).padEnd(34)} ${r.status} count=${list ? list.length : '-'} pag=${r.data?.extra?.pagination ? JSON.stringify(r.data.extra.pagination).replace(/https?:[^"]+/g, 'URL').slice(0, 120) : '-'}\n      ${r.status === 200 ? shape(list ? list[0] : r.data?.data).slice(0, 900) : JSON.stringify(r.data?.error?.message ?? r.data).slice(0, 300)}`);
    return list;
  };
  const bookingsFut = await R('bookingsReport', fut, ' (next 7d)');
  await R('bookingsReport', past, ' (past 14d)');
  await R('bookingCancellationReport', wide);
  await R('lateCancellationReport', past);
  await R('entranceReport', past);
  await R('membersOnHoldReport', wide);
  await R('classesSummaryReport', fut, ' (next 7d)');
  await R('classesSummaryReport', past, ' (past)');
  for (const t of ['schedule', 'class', 'coach', 'day', 'hour', 'session', 'category']) await R('bookingStatisticsReport', { ...past, type: t }, ` type=${t}`);
  for (const g of ['user', 'member', 'class', 'schedule', 'day', 'week', 'month']) await R('absenceReport', { ...past, group_by: g }, ` group_by=${g}`);
  await R('expiringMembershipsReport', { fromDate: iso(0), toDate: iso(30) });
  await R('expiringSessionsReport', { fromDate: iso(0), toDate: iso(60) });
  await R('activeSessionMembers', wide);
  await R('activePlanMembers', wide);
  await R('transactionsReport', past);
  await R('canceledMembershipsReport', past);
  await R('trialClassesReport', wide);
  await R('renewalsReport', wide);
  await R('getMissingMembers', { fromDate: iso(-14) });

  // ── do report filters narrow to one member / one class? ─────────────────────
  console.log('\n── report filters ──');
  const b0 = bookingsFut?.[0];
  if (b0) {
    const all = (await get('/v3/reports/bookingsReport', fut)).data?.data ?? [];
    const uid = b0.user_id ?? b0.userId, sid = b0.schedule_id ?? b0.scheduleId;
    for (const [k, v] of [['user_id', uid], ['userId', uid], ['schedule_id', sid], ['scheduleId', sid], ['limit', 2], ['page', 2]]) {
      if (v == null) { console.log(`  bookingsReport ?${k}: no such field on rows`); continue; }
      const r = await get('/v3/reports/bookingsReport', { ...fut, [k]: v });
      const list = r.data?.data ?? [];
      const uids = new Set(list.map(x => x.user_id ?? x.userId)).size;
      console.log(`  bookingsReport ?${k}=… → ${r.status} rows=${list.length} (unfiltered ${all.length}) distinct users=${uids}`);
    }
  } else console.log('  no future bookings rows to test with');

  // ── wider scan for a booking (register) route ───────────────────────────────
  console.log('\n── scan for register / waitlist routes (GET → 405 means exists) ──');
  const hits = [];
  const prefixes = ['/v3/schedule', '/v3/schedule/user', '/v3/schedule/users', '/v3/schedule/booking', '/v3/schedule/bookings', '/v3/users/schedule', '/v3/users/booking', '/v3/users/bookings', '/v3/booking', '/v3/bookings', '/v3/leads', '/v3/schedule/standby', '/v3/schedule/waitingList', '/v3/trial', '/v3/reports/bookingsReport'];
  const words = ['create', 'add', 'register', 'insert', 'new', 'store', 'book', 'enroll', 'join', 'trial', 'trialClass', 'standby', 'waitlist', 'waitingList', 'checkIn', 'attend', 'approve', 'restore', 'uncancel', 'move', 'reschedule', 'update', 'convert', 'status', 'updateStatus', 'lost'];
  for (const pre of prefixes) for (const w of words) {
    const r = await get(`${pre}/${w}`, { limit: 1 });
    if (r.status !== 404) hits.push(`${pre}/${w} → ${r.status}${r.status === 405 ? ' (' + (r.headers.allow ?? '?') + ')' : ' ' + JSON.stringify(r.data?.error?.message ?? '').slice(0, 160)}`);
  }
  console.log(`  ${prefixes.length * words.length} candidates → ${hits.length} non-404`); hits.forEach(h => console.log('  ' + h));

  // ── webhooks: what is registered (names only) ───────────────────────────────
  const wh = await get('/v3/webhooks');
  console.log('\nGET /v3/webhooks', wh.status, shape(wh.data?.data).slice(0, 500));
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
