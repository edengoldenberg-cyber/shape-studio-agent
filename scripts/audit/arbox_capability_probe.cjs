#!/usr/bin/env node
/**
 * arbox_capability_probe.cjs — READ-ONLY discovery of what the configured Arbox API key
 * can actually do. Sends GET requests only (never POST/PUT/PATCH/DELETE), so it cannot
 * change any member, booking, membership or payment.
 *
 * How write endpoints are detected without writing: the Arbox server (Laravel) answers a
 * GET on a route that only accepts POST/PUT/DELETE with 405 Method Not Allowed and an
 * `Allow:` header, while a route that does not exist answers 404. A 405 therefore proves
 * the route exists and names its methods — without calling it.
 *
 * Output contains field NAMES and value TYPES only — no member data is printed.
 *
 * Usage: node scripts/audit/arbox_capability_probe.cjs            (uses the repo .env)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');

const LOC  = process.env.ARBOX_LOCATION_ID ?? '19392';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
const KEY  = process.env.ARBOX_CLIENT_ID;
if (!KEY) { console.error('ARBOX_CLIENT_ID missing'); process.exit(2); }
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('BASE points at a mock: ' + BASE); process.exit(2); }

const http = axios.create({ baseURL: BASE, headers: { apiKey: KEY, Accept: 'application/json' }, timeout: 15000, validateStatus: () => true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${shape(v[0], depth + 1)}]×${v.length}` : '[]';
  if (typeof v === 'object') {
    if (depth >= 2) return '{…}';
    return '{' + Object.entries(v).map(([k, x]) => `${k}:${shape(x, depth + 1)}`).join(', ') + '}';
  }
  return typeof v;
}

async function get(path, params = {}) {
  await sleep(350);                                   // stay far below any rate limit
  const r = await http.get(path, { params: { location_id: LOC, ...params } });
  const body = r.data;
  const list = Array.isArray(body?.data) ? body.data : null;
  return {
    status: r.status,
    allow: r.headers?.allow ?? null,
    rate: Object.fromEntries(Object.entries(r.headers ?? {}).filter(([k]) => /ratelimit|retry-after/i.test(k))),
    count: list ? list.length : null,
    first: list ? list[0] : (body?.data ?? null),
    pagination: body?.extra?.pagination ? Object.keys(body.extra.pagination) : null,
    err: r.status >= 400 ? JSON.stringify(body?.error ?? body?.message ?? body).slice(0, 160) : null,
    raw: body,
  };
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const plus7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const minus30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const range = { from_date: today, to_date: plus7 };
  const past  = { from_date: minus30, to_date: today };

  console.log(`Arbox base: ${BASE}   location: ${LOC}   date: ${today}\n`);

  // ── 1. Known read endpoints: field inventory ────────────────────────────────
  const users = await get('/v3/users', { limit: 5 });
  console.log('GET /v3/users', users.status, 'pagination:', users.pagination, 'rate headers:', JSON.stringify(users.rate));
  console.log('  fields:', shape(users.first));
  const uid = users.raw?.data?.find(u => u.user_role === 'client' && u.active === 1)?.user_id ?? users.first?.user_id;

  const sched = await get('/v3/schedule', { ...range, limit: 5 });
  console.log('\nGET /v3/schedule', sched.status);
  console.log('  fields:', shape(sched.first));
  const sid = sched.first?.schedule_id ?? sched.first?.id;

  const mem = await get('/v3/users/memberships', { limit: 5 });
  console.log('\nGET /v3/users/memberships', mem.status);
  console.log('  fields:', shape(mem.first));

  // ── 2. Filters that would make reads member-specific ────────────────────────
  console.log('\n── filter behaviour ──');
  for (const [label, path, params] of [
    ['users?user_id',            '/v3/users',             { user_id: uid, limit: 5 }],
    ['users?phone',              '/v3/users',             { phone: '0500000000', limit: 5 }],
    ['users?search',             '/v3/users',             { search: 'zzzz-no-such-name', limit: 5 }],
    ['users/memberships?user_id', '/v3/users/memberships', { user_id: uid, limit: 50 }],
    ['schedule?user_id',         '/v3/schedule',          { ...range, user_id: uid, limit: 50 }],
    ['schedule?schedule_id',     '/v3/schedule',          { ...range, schedule_id: sid, limit: 5 }],
    ['schedule (past 30d)',      '/v3/schedule',          { ...past, limit: 5 }],
  ]) {
    const r = await get(path, params);
    const ids = Array.isArray(r.raw?.data) ? new Set(r.raw.data.map(x => x.user_id ?? x.schedule_id)).size : null;
    console.log(`  ${label.padEnd(28)} → ${r.status} count=${r.count} distinctIds=${ids}${r.err ? ' err=' + r.err : ''}`);
  }

  // ── 3. Candidate endpoints (GET only). 200 = readable, 405 = exists but write-only, 404 = absent ──
  console.log('\n── endpoint existence (GET only) ──');
  const U = uid, S = sid;
  const candidates = [
    // bookings / registrations / occupancy
    '/v3/schedule/users', `/v3/schedule/${S}`, `/v3/schedule/${S}/users`, '/v3/scheduleUsers', '/v3/schedule_users', '/v3/schedule/registrations',
    '/v3/bookings', '/v3/booking', `/v3/users/${U}/bookings`, `/v3/users/${U}/schedule`, '/v3/users/schedule', '/v3/users/bookings', '/v3/registrations',
    '/v3/schedule/register', '/v3/schedule/cancel', '/v3/schedule/book', '/v3/scheduleUser', '/v3/schedule/user',
    // waitlist
    '/v3/standby', '/v3/schedule/standby', '/v3/waitlist', '/v3/waitingList', '/v3/schedule/waitlist',
    // attendance
    '/v3/attendance', '/v3/users/attendance', `/v3/users/${U}/attendance`, '/v3/checkins', '/v3/checkIn', '/v3/entrances', '/v3/reports/attendance', '/v3/absences',
    // memberships / holds / cancellation
    '/v3/memberships', '/v3/membershipTypes', '/v3/membership_types', `/v3/users/${U}`, `/v3/users/${U}/memberships`, '/v3/users/holds', '/v3/holds', '/v3/users/suspensions', '/v3/suspensions', '/v3/freezes', '/v3/users/memberships/hold', '/v3/users/memberships/cancel',
    // money
    '/v3/payments', '/v3/sales', '/v3/transactions', '/v3/invoices', '/v3/debts', '/v3/users/debts',
    // misc documented / third-party-listed
    '/v3/leads', '/v3/convertedLeads', '/v3/lostLeads', '/v3/searchUser', '/v3/updateLeadStatus', '/v3/tasks', '/v3/locations', '/v3/staff', '/v3/messages', '/v3/sms', '/v3/reports', '/v3/services', '/v3/categories', '/v3/coaches',
    // older versions
    '/v2/schedule', '/v2/users', '/v1/schedule', '/schedule', '/users',
  ];
  const found = [];
  for (const p of candidates) {
    const params = /tasks|schedule|attendance|checkins|entrances|absences|reports|sales|payments|transactions/.test(p) ? { ...range, limit: 2 } : { limit: 2 };
    const r = await get(p, params);
    const tag = r.status === 200 ? 'READABLE' : r.status === 405 ? 'EXISTS (not GET) allow=' + r.allow : r.status === 404 ? 'absent' : String(r.status);
    if (r.status !== 404) found.push(p);
    const mask = s => String(s).replace(String(U), ':userId').replace(String(S), ':scheduleId');
    console.log(`  ${mask(p).padEnd(38)} ${String(r.status).padEnd(4)} ${tag}${r.status === 200 ? '  fields: ' + shape(r.first).slice(0, 400) : (r.err && r.status !== 404 ? '  ' + r.err : '')}`);
  }
  console.log('\nnon-404 endpoints:', found.length);
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
