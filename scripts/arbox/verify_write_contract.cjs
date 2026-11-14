#!/usr/bin/env node
/**
 * verify_write_contract.cjs — CONTROLLED verification of ONE Arbox write contract.
 *
 * ⚠ This script can change a REAL membership. It exists because the request format of
 *   POST /v3/users/memberships/hold|cancel is undocumented and can only be confirmed by
 *   sending one request. Run it ONLY against a test member the studio owner approved.
 *
 * Default is a DRY RUN: it prints the exact request it would send and the current
 * read-back state, and sends nothing. A real request needs ALL of:
 *     --execute
 *     --owner-approved "<name of the person who approved, and the date>"
 *     --confirm-user-id <the same user id again>
 *
 * Usage:
 *   node scripts/arbox/verify_write_contract.cjs --op membership_hold \
 *        --user-id 123 --membership-user-id 456 --from 2026-12-01 --to 2026-12-03
 *   … add --execute --owner-approved "Eden, 2026-11-20" --confirm-user-id 123 to send.
 *
 * What it does when executing:
 *   1. reads the state BEFORE (memberships / hold report)
 *   2. sends exactly ONE request with the assumed body (never retries)
 *   3. prints status + response body
 *   4. reads the state AFTER, up to 3 times, and prints whether the change is visible
 *   5. prints what to change in services/arbox_gateway.js (WRITE_CONTRACTS[op].verified)
 *      — it does NOT edit code and does NOT enable writes.
 * Undoing a successful test hold/cancel is done by staff in the Arbox dashboard.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
process.env.LOG_TO_FILE = 'false';
const axios = require('axios');

const arg = n => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : null; };
const has = n => process.argv.includes('--' + n);
const op = arg('op'), userId = arg('user-id'), mid = arg('membership-user-id'), from = arg('from'), to = arg('to');
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
const LOC = process.env.ARBOX_LOCATION_ID ?? '19392';
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function die(msg) { console.error('REFUSED: ' + msg); process.exit(2); }
if (!['membership_hold', 'membership_cancel'].includes(op)) die('--op must be membership_hold or membership_cancel');
if (!/^\d+$/.test(userId ?? '') || !/^\d+$/.test(mid ?? '')) die('--user-id and --membership-user-id are required (numeric)');
if (op === 'membership_hold' && (!ISO.test(from ?? '') || !ISO.test(to ?? '') || to < from)) die('--from and --to (YYYY-MM-DD) are required for a hold');
if (!process.env.ARBOX_CLIENT_ID) die('ARBOX_CLIENT_ID is not set');

const { WRITE_CONTRACTS } = require('../../services/arbox_gateway');
const contract = WRITE_CONTRACTS[op];
const body = contract.body({ userId: Number(userId), membershipUserId: Number(mid), from, to });
const http = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true });

async function readState() {
  const m = await http.get('/v3/users/memberships', { params: { location_id: LOC, user_id: userId, limit: 200 } });
  const row = (m.data?.data ?? []).find(x => String(x.membership_user_id) === String(mid) && String(x.user_id) === String(userId));
  const out = { membershipFound: !!row, active: row?.active ?? null, cancelled: row?.cancelled ?? null, end_time: row?.end_time ?? null, type: row?.type ?? null };
  if (op === 'membership_hold') {
    const h = await http.get('/v3/reports/membersOnHoldReport', { params: { location_id: LOC, fromDate: from, toDate: to } });
    const rows = h.data?.data ?? [];
    out.holdRowForMember = rows.some(r => String(r.user_id) === String(userId) || String(r.membership_user_id) === String(mid));
    out.holdReportFields = rows[0] ? Object.keys(rows[0]) : [];
  }
  return out;
}

(async () => {
  console.log(`Arbox base: ${BASE}`);
  console.log(`Operation : ${op}  (${contract.method} ${contract.path})  — contract currently marked verified=${contract.verified}`);
  console.log('Request body (ASSUMED format):', JSON.stringify(body));
  const before = await readState();
  console.log('State BEFORE:', JSON.stringify(before));
  if (!before.membershipFound) die('this membership_user_id does not belong to this user_id — nothing sent');

  if (!has('execute')) { console.log('\nDRY RUN — nothing was sent. See the header of this file for the flags that send one real request.'); return; }
  if (!arg('owner-approved')) die('--owner-approved "<who, when>" is required to send');
  if (arg('confirm-user-id') !== userId) die('--confirm-user-id must repeat the user id');
  if (/localhost|127\.0\.0\.1/.test(BASE)) die('base URL is a local mock — this script is for the real API');

  console.log(`\nSENDING ONE REQUEST (approved by: ${arg('owner-approved')}) …`);
  let res;
  try { res = await http.request({ method: contract.method, url: contract.path, data: body }); }
  catch (err) { console.log('Request did not complete:', err.code ?? err.message, '\nOUTCOME UNKNOWN — check the member in Arbox. Do NOT run again before checking.'); }
  if (res) console.log('Response:', res.status, JSON.stringify(res.data).slice(0, 800));

  let after = null, visible = false;
  for (let i = 0; i < 3 && !visible; i++) {
    await new Promise(r => setTimeout(r, 2500));
    after = await readState();
    visible = op === 'membership_hold' ? after.holdRowForMember === true : (after.cancelled === 1 || after.active === 0);
  }
  console.log('State AFTER:', JSON.stringify(after));
  console.log(visible
    ? `\nRESULT: the change is visible in a read-back. The assumed contract works.\nNext (separate, reviewed change): set WRITE_CONTRACTS.${op}.verified = true, and only then consider ARBOX_WRITES_ENABLED=true.\nRemember to undo the test change in the Arbox dashboard.`
    : `\nRESULT: the change is NOT visible in a read-back. The contract stays unverified; writes stay disabled.\nIf the response above was 2xx, check the member in Arbox manually — the request may have had another effect.`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
