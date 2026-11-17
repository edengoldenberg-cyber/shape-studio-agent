#!/usr/bin/env node
/**
 * verify_class_contract.cjs — CONTROLLED verification of ONE Arbox class-booking request.
 *
 * ⚠ With --execute this script changes a REAL booking. It exists because two things about
 *   POST /v3/schedule/bookSession and POST /v3/schedule/cancelUserBooking are not documented and can only be learned
 *   by sending one request: whether the studio's API key is permitted to use them, and what they do to the member's
 *   sessions. Run it ONLY against a test member and a class the studio owner approved.
 *
 * Default is a DRY RUN: it prints the exact request it would send and the state read from Arbox, and sends nothing.
 * A real request needs ALL of:
 *     --execute
 *     --owner-approved "<who approved, and the date>"
 *     --confirm-user-id <the same user id again>
 *
 *   node scripts/arbox/verify_class_contract.cjs --op class_book   --user-id 123 --schedule-id 456 --date 2026-11-20 --time 17:00 [--membership-user-id 789]
 *   node scripts/arbox/verify_class_contract.cjs --op class_cancel --user-id 123 --schedule-id 456 --date 2026-11-20 --time 17:00
 *
 * When executing it: 1. reads the member's bookings of that day BEFORE; 2. sends exactly ONE request with the
 * documented body (never retries); 3. prints the status and the response body; 4. reads the bookings AFTER, up to
 * three times, and says whether the change is visible and how long it took; 5. prints the member's memberships
 * before and after (sessions / debt), so the effect on the membership is seen; 6. prints what to change in
 * services/arbox_gateway.js (WRITE_CONTRACTS[op].verified). It does NOT edit code and does NOT enable anything.
 * Undoing a test booking: run the other operation for the same class, or cancel it in the Arbox dashboard.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
process.env.LOG_TO_FILE = 'false';
const axios = require('axios');
const gw = require('../../services/arbox_gateway');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const has = k => process.argv.includes('--' + k);
const op = arg('op'), userId = arg('user-id'), scheduleId = arg('schedule-id'), date = arg('date'), time = arg('time'), mu = arg('membership-user-id');
const ROUTE = { class_book: '/v3/schedule/bookSession', class_cancel: '/v3/schedule/cancelUserBooking' }[op];
if (!ROUTE || !/^\d+$/.test(userId ?? '') || !/^\d+$/.test(scheduleId ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(time ?? '')) {
  console.error('usage: --op class_book|class_cancel --user-id N --schedule-id N --date YYYY-MM-DD --time HH:MM [--membership-user-id N] [--execute --owner-approved "…" --confirm-user-id N]');
  process.exit(2);
}
const body = op === 'class_book' ? { user_id: Number(userId), schedule_id: Number(scheduleId), ...(mu ? { membership_user_id: Number(mu) } : {}) } : { schedule_id: Number(scheduleId), user_id: Number(userId) };
const execute = has('execute') && arg('owner-approved') && arg('confirm-user-id') === userId;
const seen = bs => bs.some(b => b.date === date && String(b.time).slice(0, 5) === time);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(execute ? `EXECUTING ONE REAL REQUEST — approved by: ${arg('owner-approved')}` : 'DRY RUN — nothing will be sent (add --execute --owner-approved "…" --confirm-user-id <id> to send)');
  const member = await gw.getMemberById(userId);
  console.log(`member: ${member ? `${member.name} (active ${member.active}, role ${member.role})` : 'NOT FOUND'}`);
  if (!member) return;
  const before = (await gw.getBookings(userId, { from: date, to: date, fresh: true })).bookings;
  const msBefore = (await gw.getMemberships(userId)).memberships;
  console.log(`bookings on ${date} BEFORE: ${before.map(b => `${String(b.time).slice(0, 5)} ${b.className} (sessions left ${b.sessionsLeft})`).join(' | ') || 'none'}`);
  console.log(`memberships BEFORE: ${msBefore.map(m => `${m.name} active=${m.active} debt=${m.debt} (membership_user_id ${m.membershipUserId})`).join(' | ') || 'none'}`);
  console.log(`\nrequest: POST ${ROUTE}\nbody:    ${JSON.stringify(body)}`);
  if (seen(before) === (op === 'class_book')) { console.log(`\nNothing to verify: the ${time} booking is already ${op === 'class_book' ? 'present' : 'absent'}.`); return; }
  if (!execute) { console.log('\nNot sent.'); return; }

  const client = axios.create({ baseURL: process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public', timeout: 20000, validateStatus: () => true,
    headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json', 'Content-Type': 'application/json' } });
  const t0 = Date.now();
  let res;
  try { res = await client.post(ROUTE, body); } catch (err) { console.log(`\nThe request did not complete (${err.code ?? err.message}). The outcome is UNKNOWN — read the state below; do NOT send it again.`); }
  if (res) console.log(`\nresponse: HTTP ${res.status}\n${JSON.stringify(res.data).slice(0, 1200)}`);
  for (let k = 1; k <= 3; k++) {
    await sleep(k === 1 ? 500 : 2500);
    const after = (await gw.getBookings(userId, { from: date, to: date, fresh: true })).bookings;
    const ok = seen(after) === (op === 'class_book');
    console.log(`read-back ${k} (${Math.round((Date.now() - t0) / 100) / 10}s): bookings ${after.map(b => `${String(b.time).slice(0, 5)} ${b.className} (sessions left ${b.sessionsLeft})`).join(' | ') || 'none'} → change ${ok ? 'VISIBLE' : 'not visible'}`);
    if (ok) break;
  }
  gw.clearCache(`memberships:${userId}`);
  const msAfter = (await gw.getMemberships(userId)).memberships;
  console.log(`memberships AFTER:  ${msAfter.map(m => `${m.name} active=${m.active} debt=${m.debt}`).join(' | ') || 'none'}`);
  console.log(`\nIf the status was 2xx and the change is visible: the contract of "${op}" is confirmed. To allow it, a developer sets\n  WRITE_CONTRACTS.${op}.verified = true in services/arbox_gateway.js (a code change, reviewed and deployed),\nand the owner sets ARBOX_WRITES_ENABLED=true and ARBOX_WRITE_OPS to include "${op}". This script changed neither.`);
})().catch(e => { console.error('verification failed:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 200));
