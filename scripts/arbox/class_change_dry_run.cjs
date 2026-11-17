#!/usr/bin/env node
/**
 * class_change_dry_run.cjs — what Tomer WOULD do in Arbox for one class request. READ-ONLY: it sends GET requests
 * only and prints the plan. It cannot book or cancel anything: the write function is replaced by one that throws.
 *
 *   node scripts/arbox/class_change_dry_run.cjs --phone 05XXXXXXXX --date 2026-11-18 --kind move --from 18:00 --to 17:00
 *   node scripts/arbox/class_change_dry_run.cjs --phone 05XXXXXXXX --date 2026-11-18 --kind book --to 17:00
 *   node scripts/arbox/class_change_dry_run.cjs --phone 05XXXXXXXX --date 2026-11-18 --kind cancel --from 18:00
 *
 * It prints: who the member is in Arbox, her bookings that day, the classes involved with their occupancy and their
 * cancellation rule, the checks that pass or the one that refuses, and - when every check passes - the exact requests
 * (method, path, body) in the order they would be sent, with how each would be verified.
 * Names and phones are printed to YOUR terminal only; nothing is stored.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
process.env.LOG_TO_FILE = 'false';
const gw = require('../../services/arbox_gateway');
const { createClassActions } = require('../../services/class_actions');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const phone = arg('phone'), date = arg('date'), kind = arg('kind'), from = arg('from'), to = arg('to');
if (!phone || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !['move', 'book', 'cancel'].includes(kind)) {
  console.error('usage: --phone <phone> --date YYYY-MM-DD --kind move|book|cancel [--from HH:MM] [--to HH:MM]'); process.exit(2);
}
const hhmm = t => String(t ?? '').slice(0, 5);
const ROUTES = { class_book: 'POST /v3/schedule/bookSession', class_cancel: 'POST /v3/schedule/cancelUserBooking' };
const BODY = { class_book: a => ({ user_id: Number(a.userId), schedule_id: Number(a.scheduleId), membership_user_id: Number(a.membershipUserId) }),
               class_cancel: a => ({ schedule_id: Number(a.scheduleId), user_id: Number(a.userId) }) };

(async () => {
  console.log('DRY RUN — GET requests only. Nothing is booked or cancelled.\n');
  console.log('write switches now:', JSON.stringify(Object.fromEntries(Object.entries(gw.writeStatus()).filter(([k]) => k.startsWith('class_')).map(([k, v]) => [k, { verified: v.contractVerified, switchOn: v.switchOn, named: v.namedInAllowList, executable: v.executable }]))));
  const r = await gw.resolveMember(phone);
  console.log(`\nmember: ${r.status}${r.member ? ` — ${r.member.name} (user_id ${r.member.userId}, active ${r.member.active})` : ''}`);
  if (r.status !== 'found') return;
  const bookings = (await gw.getBookings(r.member.userId, { from: date, to: date, fresh: true })).bookings;
  const cl = await gw.getClasses({ from: date, to: date, fresh: true });
  console.log(`bookings on ${date}: ${bookings.map(b => `${hhmm(b.time)} ${b.className}`).join(' | ') || 'none'}`);
  for (const c of cl.classes.filter(c => [from, to].includes(hhmm(c.start))))
    console.log(`class ${hhmm(c.start)} ${c.name} (schedule_id ${c.scheduleId}): ${c.occupancy ? `${c.occupancy.registered}/${c.occupancy.capacity}, ${c.occupancy.spotsLeft} free, ${c.occupancy.standby} waiting` : 'occupancy unknown'} · cancelling closes ${c.cancelLockHours ?? '?'}h before · late cancellation ${c.lateCancellationAllowed === null ? '?' : c.lateCancellationAllowed ? 'allowed' : 'not allowed'}`);
  const ms = (await gw.getMemberships(r.member.userId)).memberships;
  console.log(`memberships: ${ms.map(m => `${m.name} [${m.type}] ${m.startDate}→${m.endDate ?? '∞'} active=${m.active} cancelled=${m.cancelled} (membership_user_id ${m.membershipUserId})`).join(' | ') || 'none'}`);

  // Plan as if the operations were enabled, with a gateway that CANNOT write.
  const planner = createClassActions({ logger: { info() {}, warn() {}, error() {} },
    gateway: { ...gw, writesEnabled: () => true, executeWrite: async () => { throw new Error('dry run: writes are impossible in this script'); } } });
  const pl = await planner.plan({ kind, member: r.member, date, bookings, classes: cl.classes,
    current: from ? { booking: bookings.find(b => hhmm(b.time) === from) ?? null } : null,
    target: to ? { cls: cl.classes.find(c => hhmm(c.start) === to) ?? null } : null });
  if (!pl.ok) { console.log(`\nREFUSED before any request: ${pl.reason} — ${pl.text}${pl.hoursLeft !== undefined ? ` (${pl.hoursLeft}h left, rule ${pl.lockHours}h)` : ''}\n→ the request would go to the staff as a task.`); return; }
  console.log('\nEVERY CHECK PASSES. If the operations were enabled, these requests would be sent, in this order:');
  pl.steps.forEach((s, i) => console.log(`  ${i + 1}. ${ROUTES[s.op]}  ${JSON.stringify(BODY[s.op](s.args))}\n     then read GET /v3/reports/bookingsReport and require the ${s.slot.time} booking to be ${s.op === 'class_book' ? 'PRESENT' : 'ABSENT'}; stop if it is not`));
  console.log('\nNothing was sent.');
})().catch(e => { console.error('dry run failed:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 200));
