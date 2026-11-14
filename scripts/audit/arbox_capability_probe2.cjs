#!/usr/bin/env node
/**
 * arbox_capability_probe2.cjs — second READ-ONLY pass (GET requests only).
 * Enumerates report names, report field shapes, and scans a wordlist of candidate
 * routes: 405 = route exists for another method (named in `Allow`), 404 = absent.
 * Prints field names / types only — no member data.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const LOC  = process.env.ARBOX_LOCATION_ID ?? '19392';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('BASE points at a mock'); process.exit(2); }
const http = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json' }, timeout: 20000, validateStatus: () => true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function shape(v, d = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${shape(v[0], d + 1)}]×${v.length}` : '[]';
  if (typeof v === 'object') return d >= 2 ? '{…}' : '{' + Object.entries(v).map(([k, x]) => `${k}:${shape(x, d + 1)}`).join(', ') + '}';
  return typeof v;
}
async function get(path, params = {}) {
  await sleep(300);
  const r = await http.get(path, { params: { location_id: LOC, ...params } });
  return r;
}

(async () => {
  const iso = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const past = { from_date: iso(-14), to_date: iso(0) };
  const next = { from_date: iso(0), to_date: iso(7) };

  // ── reports ──────────────────────────────────────────────────────────────────
  const bad = await get('/v3/reports/attendance', past);
  const msg = JSON.stringify(bad.data?.error?.message ?? bad.data);
  console.log('report-name validation message:\n ', msg.slice(0, 1500), '\n');
  const names = [...msg.matchAll(/([a-zA-Z]+Report[a-zA-Z]*|[a-z]+[A-Z][a-zA-Z]+)/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i && !/reportName|must|following/.test(v));
  console.log('report names parsed:', names.join(', '), '\n');
  for (const n of names) {
    let r = await get(`/v3/reports/${n}`, { ...past, limit: 3 });
    if (r.status === 400) r = await get(`/v3/reports/${n}`, { ...next, limit: 3 });
    const list = Array.isArray(r.data?.data) ? r.data.data : null;
    console.log(`  reports/${n.padEnd(28)} ${r.status} count=${list ? list.length : '-'} ${r.status === 200 ? 'fields: ' + shape(list ? list[0] : r.data?.data).slice(0, 700) : JSON.stringify(r.data?.error?.message ?? r.data).slice(0, 300)}`);
  }

  // ── entrances / schedule shapes over the past ────────────────────────────────
  for (const [p, params] of [['/v3/entrances', { ...past, limit: 3 }], ['/v3/schedule', { ...past, limit: 3 }], ['/v3/membershipTypes', { limit: 3 }], ['/v3/tasks', { ...past, limit: 2 }]]) {
    const r = await get(p, params);
    const list = Array.isArray(r.data?.data) ? r.data.data : null;
    console.log(`\nGET ${p} ${r.status} count=${list?.length} fields: ${shape(list ? list[0] : r.data?.data).slice(0, 900)}`);
  }

  // ── route existence scan (GET only) ──────────────────────────────────────────
  const scan = async (prefix, words) => {
    const hits = [];
    for (const w of words) {
      const p = `${prefix}/${w}`;
      const r = await get(p, { limit: 1, ...next });
      if (r.status !== 404) hits.push(`${p} → ${r.status}${r.status === 405 ? ' (' + (r.headers.allow ?? '?') + ')' : ''}${r.status === 400 ? ' ' + JSON.stringify(r.data?.error?.message ?? r.data).slice(0, 200) : ''}`);
    }
    console.log(`\nscan ${prefix}/* (${words.length} words) → ${hits.length} non-404:`); hits.forEach(h => console.log('  ' + h));
  };
  await scan('/v3/schedule', ['register', 'registration', 'registrations', 'book', 'booking', 'bookings', 'enroll', 'signup', 'signUp', 'add', 'insert', 'enter', 'join', 'attend', 'checkIn', 'checkin', 'standby', 'standBy', 'waitingList', 'waitlist', 'users', 'user', 'members', 'member', 'participants', 'uncancel', 'trial', 'lateCancel', 'remove', 'delete', 'update', 'create', 'store', 'cancel', 'registerUser', 'addUser', 'removeUser', 'cancelUser', 'insertUser', 'userSchedule', 'scheduleUser', 'reserve', 'reservation', 'spot', 'absent', 'arrived', 'entrance']);
  await scan('/v3/users/memberships', ['hold', 'unhold', 'unHold', 'freeze', 'unfreeze', 'cancel', 'uncancel', 'renew', 'create', 'add', 'update', 'extend', 'suspend', 'resume', 'sessions', 'holds', 'purchase', 'assign', 'delete', 'cancelHold', 'removeHold', 'endHold', 'pause']);
  await scan('/v3/users', ['create', 'update', 'search', 'find', 'byPhone', 'entrances', 'checkIn', 'debts', 'tasks', 'notes', 'messages', 'sms', 'schedule', 'bookings', 'registrations', 'standby', 'holds', 'documents', 'forms', 'medical', 'activate', 'deactivate', 'convert', 'memberships', 'sessions', 'punches', 'attendance', 'absences', 'lateCancellations', 'payments', 'invoices', 'receipts']);
  await scan('/v3', ['scheduleUser', 'scheduleUsers', 'schedule_user', 'userSchedule', 'booking', 'bookings', 'standBy', 'standby', 'waitingList', 'entrances', 'entrance', 'checkIn', 'tasks', 'leads', 'users', 'membershipTypes', 'holds', 'hold', 'series', 'appointments', 'availability', 'spaces', 'rooms', 'departments', 'products', 'purchases', 'webhooks', 'webhook', 'notifications', 'customFields', 'forms', 'documents', 'coaches', 'boxes', 'box', 'settings', 'cancellations', 'lateCancellations', 'reports']);
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
