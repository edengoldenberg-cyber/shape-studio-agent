#!/usr/bin/env node
/**
 * arbox_care_probe.cjs — READ-ONLY (GET only) shape probe for the member-care programs.
 *
 * Prints field NAMES, value FORMATS (letters → a, digits → d) and distinct values of a
 * short whitelist of enum-like fields. Never prints a name, phone, e-mail, id or free text.
 * Purpose: decide, per program, whether the data it needs really exists in the API.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const LOC = process.env.ARBOX_LOCATION_ID ?? '19392';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('BASE points at a mock'); process.exit(2); }
const http = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json' }, timeout: 30000, validateStatus: () => true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ENUMS = new Set(['status', 'type', 'active', 'cancelled', 'check_in', 'is_recurring_payment', 'period_time_unit', 'user_role', 'is_first_session', 'recurring', 'is_recurring',
  'payment_status', 'paid', 'auto_renew', 'is_auto_renew', 'membership_status', 'deactivated', 'period_amount', 'sessions', 'has_regular_client', 'allow_sms', 'allow_mailing_list', 'gender', 'service_type', 'on_hold', 'hold']);
const fmt = v => v === null ? 'null' : typeof v === 'number' ? 'num' : typeof v === 'boolean' ? String(v) : Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : String(v).slice(0, 26).replace(/[A-Za-zא-ת]/g, 'a').replace(/\d/g, 'd');
async function raw(p, params = {}) { await sleep(350); return http.get(p, { params: { location_id: LOC, ...params } }); }
async function shape(label, p, params = {}) {
  const r = await raw(p, params);
  const rows = Array.isArray(r.data?.data) ? r.data.data : (r.data?.data && typeof r.data.data === 'object' ? [r.data.data] : []);
  const pg = r.data?.extra?.pagination;
  console.log(`\n== ${label}  GET ${p} ${JSON.stringify(params)} → HTTP ${r.status}, rows ${rows.length}${pg ? `, pagination ${JSON.stringify({ total: pg.total, per_page: pg.per_page, next: !!pg.next_page_url })}` : ''}${r.status >= 400 ? ' · ' + JSON.stringify(r.data?.error ?? r.data ?? '').slice(0, 160).replace(/\d{6,}/g, 'N') : ''}`);
  if (!rows.length) return rows;
  const keys = [...new Set(rows.flatMap(x => Object.keys(x ?? {})))];
  for (const k of keys) {
    const vals = rows.map(x => x?.[k]);
    const nonNull = vals.filter(v => v !== null && v !== undefined && v !== '');
    const formats = [...new Set(nonNull.map(fmt))].slice(0, 4);
    const en = ENUMS.has(k) ? ' values=' + JSON.stringify([...new Set(vals.map(v => (typeof v === 'object' ? fmt(v) : v)))].slice(0, 12)) : '';
    console.log(`   ${k}: filled ${nonNull.length}/${rows.length} fmt ${JSON.stringify(formats)}${en}`);
  }
  return rows;
}
const iso = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const users = await shape('users p1', '/v3/users', { limit: 200, page: 1 });
  const mem = await shape('memberships (no user filter)', '/v3/users/memberships', { limit: 200 });
  const mem2 = await raw('/v3/users/memberships', { limit: 200, page: 2 });
  console.log('   memberships page 2 rows:', (mem2.data?.data ?? []).length, '| distinct users on page 1:', new Set(mem.map(x => x.user_id)).size);
  const am = await shape('activeMembershipsReport', '/v3/reports/activeMembershipsReport');
  const mt = await shape('membershipTypes', '/v3/membershipTypes', { limit: 200 });
  const typeIds = new Set(mt.map(x => x.id));
  console.log('   join memberships.membership_type_id ↔ membershipTypes.id:', mem.filter(x => typeIds.has(x.membership_type_id ?? x.membership_types_id ?? x.membership_type?.id)).length, '/', mem.length,
    '| by name:', mem.filter(x => mt.some(t => t.name === x.membership_type_name)).length, '/', mem.length);
  const past = await shape('bookingsReport last 14d (all members)', '/v3/reports/bookingsReport', { fromDate: iso(-14), toDate: iso(0), limit: 200 });
  const p2 = await raw('/v3/reports/bookingsReport', { fromDate: iso(-14), toDate: iso(0), limit: 200, page: 2 });
  const big = await raw('/v3/reports/bookingsReport', { fromDate: iso(-14), toDate: iso(0) });
  console.log('   bookingsReport: page 2 rows', (p2.data?.data ?? []).length, '| no-limit rows', (big.data?.data ?? []).length, '| check_in=Yes', (big.data?.data ?? []).filter(x => x.check_in === 'Yes').length,
    '| distinct users', new Set((big.data?.data ?? []).map(x => x.user_id)).size, '| same as page1?', JSON.stringify((big.data?.data ?? []).slice(0, 3).map(x => x.date + x.time)) === JSON.stringify(past.slice(0, 3).map(x => x.date + x.time)));
  const long = await raw('/v3/reports/bookingsReport', { fromDate: iso(-45), toDate: iso(0) });
  console.log('   bookingsReport 45-day range → HTTP', long.status, 'rows', (long.data?.data ?? []).length, JSON.stringify(long.data?.error ?? '').slice(0, 120));
  await shape('membersOnHoldReport', '/v3/reports/membersOnHoldReport', { fromDate: iso(-30), toDate: iso(30) });
  await shape('attendance report', '/v3/reports/attendance', { fromDate: iso(-7), toDate: iso(0) });
  await shape('absences', '/v3/absences', { fromDate: iso(-7), toDate: iso(0) });
  await shape('users/debts', '/v3/users/debts', {});
  await shape('webhooks', '/v3/webhooks', {});
  console.log('\n== candidate billing / payment report routes (status only)');
  for (const name of ['paymentsReport', 'failedPaymentsReport', 'declinedPaymentsReport', 'debtsReport', 'debtReport', 'transactionsReport', 'salesReport', 'recurringPaymentsReport', 'openChargesReport', 'chargesReport', 'expiredMembershipsReport', 'expiringMembershipsReport', 'birthdaysReport', 'newMembersReport', 'renewalsReport', 'inactiveMembersReport', 'lastSeenReport', 'entrancesReport']) {
    const r = await raw('/v3/reports/' + name, { fromDate: iso(-30), toDate: iso(0) });
    const rows = Array.isArray(r.data?.data) ? r.data.data : null;
    console.log(`   /v3/reports/${name} → HTTP ${r.status}${rows ? `, rows ${rows.length}, keys ${JSON.stringify(Object.keys(rows[0] ?? {}))}` : ''}`);
  }
  for (const p of ['/v3/payments', '/v3/transactions', '/v3/users/payments', '/v3/users/charges', '/v3/charges', '/v3/invoices']) {
    const r = await raw(p, {});
    console.log(`   ${p} → HTTP ${r.status}`);
  }
  // one member's own membership rows (shape only) — to see what a single-user call adds
  const uid = users.find(u => u.user_role === 'client' && u.active === 1)?.user_id;
  if (uid) await shape('memberships of one member', '/v3/users/memberships', { user_id: uid, limit: 50 });
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
