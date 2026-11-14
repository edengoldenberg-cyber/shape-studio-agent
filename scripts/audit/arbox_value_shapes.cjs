#!/usr/bin/env node
/** READ-ONLY (GET). Prints only distinct NON-personal enum-like values and formats needed to code against the API. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const LOC = process.env.ARBOX_LOCATION_ID ?? '19392';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('BASE points at a mock'); process.exit(2); }
const http = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json' }, timeout: 30000, validateStatus: () => true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async (p, params = {}) => { await sleep(300); const r = await http.get(p, { params: { location_id: LOC, ...params } }); return r.data?.data ?? []; };
const iso = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const distinct = (rows, k) => [...new Set(rows.map(r => typeof r[k] === 'string' ? r[k].replace(/\d/g, 'd') : JSON.stringify(r[k])))].slice(0, 12);
const values = (rows, k) => [...new Set(rows.map(r => JSON.stringify(r[k])))].slice(0, 15);
const norm = raw => { const s = String(raw ?? '').replace(/[^\d+]/g, ''); if (s.startsWith('00972')) return s.slice(2); if (s.startsWith('+972')) return s.slice(1); if (s.startsWith('972')) return s; if (s.startsWith('0')) return '972' + s.slice(1); if (s.length === 9) return '972' + s; return s; };

(async () => {
  const fut = { fromDate: iso(0), toDate: iso(7) }, past = { fromDate: iso(-14), toDate: iso(0) };
  const b = await get('/v3/reports/bookingsReport', fut);
  console.log('bookingsReport: date fmt', distinct(b, 'date'), '| time fmt', distinct(b, 'time'), '| check_in', values(b, 'check_in'), '| user_role', values(b, 'user_role'), '| sessions_left', values(b, 'sessions_left').slice(0, 8), '| is_first_session', values(b, 'is_first_session'), '| end_membership_time fmt', distinct(b, 'end_membership_time'));
  const bp = await get('/v3/reports/bookingsReport', past);
  console.log('bookingsReport(past): check_in', values(bp, 'check_in'));
  const c = await get('/v3/reports/classesSummaryReport', fut);
  console.log('classesSummary: status', values(c, 'status'), '| date fmt', distinct(c, 'date'), '| start_time fmt', distinct(c, 'start_time'), '| registration_count range', Math.min(...c.map(x => x.registration_count)), '-', Math.max(...c.map(x => x.registration_count)), '| standby max', Math.max(...c.map(x => x.standby_members)), '| service_type', values(c, 'service_type'));
  const s = await get('/v3/schedule', { from_date: iso(0), to_date: iso(7), limit: 200 });
  console.log('schedule: n', s.length, '| disable_cancellation_time', values(s, 'disable_cancellation_time'), '| enable_late_cancellation', values(s, 'enable_late_cancellation'), '| max_participants', values(s, 'max_participants'), '| date fmt', distinct(s, 'date'), '| start fmt', distinct(s, 'start_time'), '| is_transparent', values(s, 'is_transparent'), '| registration_link host', [...new Set(s.map(x => { try { return new URL(x.registration_link).host; } catch { return String(x.registration_link).slice(0, 12); } }))]);
  const cs = new Map(c.map(x => [x.schedule_id, x]));
  console.log('schedule <-> classesSummary join by schedule_id:', s.filter(x => cs.has(x.schedule_id)).length, '/', s.length, '| classes where registration_count >= max:', s.filter(x => cs.get(x.schedule_id)?.registration_count >= x.max_participants).length);
  const am = await get('/v3/reports/activeMembershipsReport');
  console.log('activeMembershipsReport: status', values(am, 'status'), '| open_charges', values(am, 'open_charges').slice(0, 6), '| leg', values(am, 'leg').slice(0, 6), '| end_date fmt', distinct(am, 'end_date'));
  const m = await get('/v3/users/memberships', { limit: 200 });
  console.log('memberships: type', values(m, 'type'), '| active', values(m, 'active'), '| cancelled', values(m, 'cancelled'), '| end_time fmt', distinct(m, 'end_time'), '| start_time fmt', distinct(m, 'start_time'), '| debt>0 count', m.filter(x => x.debt > 0).length, '/', m.length);
  const mt = await get('/v3/membershipTypes', { limit: 200 });
  console.log('membershipTypes: n', mt.length, '| type', values(mt, 'type'), '| sessions', values(mt, 'sessions').slice(0, 10), '| period_time_unit', values(mt, 'period_time_unit'), '| is_recurring_payment', values(mt, 'is_recurring_payment'));
  let page = 1; const users = [];
  for (;;) {
    await sleep(300);
    const r = await http.get('/v3/users', { params: { location_id: LOC, limit: 200, page } });
    const batch = r.data?.data ?? []; users.push(...batch);
    if (!r.data?.extra?.pagination?.next_page_url || !batch.length || page++ > 20) break;
  }
  const roles = {}; for (const u of users) { const k = u.user_role + '/active=' + u.active; roles[k] = (roles[k] || 0) + 1; }
  const byPhone = new Map(); for (const u of users) { const n = norm(u.phone); if (!n) continue; byPhone.set(n, [...(byPhone.get(n) ?? []), u]); }
  const dup = [...byPhone.values()].filter(v => v.length > 1);
  console.log('users: total', users.length, 'pages', page, '| roles', JSON.stringify(roles), '| distinct phones', byPhone.size, '| phones shared by >1 user:', dup.length, '| of which >1 active client:', dup.filter(v => v.filter(u => u.user_role === 'client' && u.active === 1).length > 1).length, '| gender', values(users, 'gender'), '| allow_sms', values(users, 'allow_sms'));
  const canc = await get('/v3/reports/bookingCancellationReport', { fromDate: iso(-14), toDate: iso(7) });
  console.log('bookingCancellationReport: cancelled_by', values(canc, 'cancelled_by').length, 'distinct | hours_before fmt', distinct(canc, 'hours_before').slice(0, 5), '| date fmt', distinct(canc, 'date'), '| cancelled_time fmt', distinct(canc, 'cancelled_time'));
  const one = b[0]?.user_id;
  if (one) {
    const f1 = await get('/v3/reports/bookingCancellationReport', { fromDate: iso(-14), toDate: iso(7), user_id: one });
    console.log('bookingCancellationReport ?user_id filter -> rows', f1.length, 'distinct users', new Set(f1.map(x => x.user_id)).size, '(unfiltered', canc.length + ')');
    const f2 = await get('/v3/reports/classesSummaryReport', { ...fut, schedule_id: c[0]?.schedule_id });
    console.log('classesSummaryReport ?schedule_id filter -> rows', f2.length, '(unfiltered', c.length + ')');
    const f3 = await get('/v3/reports/bookingsReport', { fromDate: iso(-31), toDate: iso(0), user_id: one });
    console.log('bookingsReport 31d past for one user -> rows', f3.length);
  }
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
