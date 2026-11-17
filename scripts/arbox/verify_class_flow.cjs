#!/usr/bin/env node
/**
 * verify_class_flow.cjs — CONTROLLED verification of booking / cancelling / MOVING a class against the REAL Arbox,
 * through the same code production uses (services/class_actions.js: plan → execute → read-back → balance).
 *
 * ⚠ With --execute this changes REAL bookings of the member you name. Run it ONLY for the test member and the classes
 *   the studio owner approved, in the order the owner approved. It never retries a request and never touches any
 *   member other than --user-id.
 *
 * Default is a DRY RUN: it reads the member, her memberships, her bookings and the classes, prints the plan (or the
 * exact refusal) and the requests that WOULD be sent, and sends nothing.
 *
 *   node scripts/arbox/verify_class_flow.cjs --kind book   --user-id 123 --date 2026-11-20 --to 17:00
 *   node scripts/arbox/verify_class_flow.cjs --kind cancel --user-id 123 --date 2026-11-20 --from 17:00
 *   node scripts/arbox/verify_class_flow.cjs --kind move   --user-id 123 --date 2026-11-20 --from 18:00 --to 17:00 [--to-date 2026-11-21]
 *   add --allow-late to plan a MOVE whose original class is inside its cancellation window (the owner-approved exception)
 *   add --execute --owner-approved "<who approved, when>" --confirm-user-id 123   to really send
 *
 * What it prints when executing: the bookings and sessions BEFORE, every request with Arbox's status and answer, the
 * read-back after each step, the bookings and sessions AFTER and the comparison, and the final state
 * (done / nothing_changed / holds_both / unknown). It does NOT edit code and does NOT enable anything in production:
 * turning an operation on is a separate, reviewed change (WRITE_CONTRACTS[op].verified + ARBOX_WRITE_OPS).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
process.env.LOG_TO_FILE = 'false';
const axios = require('axios');
const gw = require('../../services/arbox_gateway');
const { createClassActions } = require('../../services/class_actions');

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const has = k => process.argv.includes('--' + k);
const kind = arg('kind'), userId = arg('user-id'), date = arg('date'), from = arg('from'), to = arg('to'), toDate = arg('to-date') ?? date;
const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ''), okTime = t => /^\d{2}:\d{2}$/.test(t ?? '');
if (!['book', 'cancel', 'move'].includes(kind) || !/^\d+$/.test(userId ?? '') || !okDate(date) || !okDate(toDate)
    || (kind !== 'book' && !okTime(from)) || (kind !== 'cancel' && !okTime(to))) {
  console.error('usage: --kind book|cancel|move --user-id N --date YYYY-MM-DD [--from HH:MM] [--to HH:MM] [--to-date YYYY-MM-DD] [--allow-late] [--execute --owner-approved "…" --confirm-user-id N]');
  process.exit(2);
}
const execute = has('execute') && !!arg('owner-approved') && arg('confirm-user-id') === userId;
const hhmm = t => String(t ?? '').slice(0, 5);
const sent = [];

// The production gateway with ONE difference, local to this process: the switches are answered by this script's own
// explicit flags, and a write is posted here (the gateway refuses unverified contracts - that is what is being verified).
const client = axios.create({ baseURL: process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public', timeout: 20000, validateStatus: () => true,
  headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json', 'Content-Type': 'application/json' } });
const gateway = { ...gw,
  writesEnabled: op => (op === 'class_move_late' ? has('allow-late') : ['class_book', 'class_cancel'].includes(op)),
  executeWrite: async (op, args) => {
    const c = gw.WRITE_CONTRACTS[op];
    if (!c || c.virtual) throw new gw.ArboxError('bad_args', `unknown write ${op}`);
    if (!execute) throw new gw.ArboxError('write_disabled', 'dry run');
    if (String(args.userId) !== String(userId)) throw new gw.ArboxError('bad_args', 'a request for another member is never sent');
    const body = c.body(args), t0 = Date.now();
    let res;
    try { res = await client.post(c.path, body); }
    catch (err) { sent.push({ op, body, error: err.code ?? err.message }); console.log(`→ POST ${c.path} ${JSON.stringify(body)}\n  did not complete (${err.code ?? err.message}) — outcome UNKNOWN, not sent again`);
      throw new gw.ArboxError('unavailable', `request did not complete: ${err.code ?? err.message}`, { submitted: true, uncertain: true }); }
    sent.push({ op, body, status: res.status });
    console.log(`→ POST ${c.path} ${JSON.stringify(body)}\n  HTTP ${res.status} in ${Date.now() - t0} ms\n  ${JSON.stringify(res.data).slice(0, 900)}`);
    gw.clearCache(`bookings:${userId}`); gw.clearCache('classes:');
    if (res.status >= 500 || res.status === 429) throw new gw.ArboxError('unavailable', `Arbox ${op} → ${res.status}`, { submitted: true, uncertain: true, status: res.status });
    if (res.status >= 400) throw new gw.ArboxError('rejected', `Arbox ${op} → ${res.status}`, { submitted: true, status: res.status, detail: JSON.stringify(res.data?.error?.message ?? res.data ?? '').slice(0, 300) });
    return { accepted: true, status: res.status, data: res.data?.data ?? null };
  } };
const actions = createClassActions({ gateway, logger: { info() {}, warn() {}, error() {} }, audience: () => true, verifyTries: 4, verifyWaitMs: 2500 });
const showBal = b => (b?.ok ? `${b.count} bookings in the next 30 days [${b.slots.join(' | ') || '—'}], sessions left reported: ${b.sessionsLeft ?? 'none reported'}` : `could not be read (${b?.error})`);

(async () => {
  console.log(execute ? `EXECUTING REAL REQUESTS — approved by: ${arg('owner-approved')}` : 'DRY RUN — nothing will be sent');
  const member = await gw.getMemberById(userId);
  console.log(`member: ${member ? `${member.name} (role ${member.role}, active ${member.active})` : 'NOT FOUND'}`);
  if (!member) return;
  const ms = (await gw.getMemberships(userId)).memberships;
  console.log(`memberships: ${ms.map(m => `${m.name} [${m.type}] active=${m.active} cancelled=${m.cancelled} ${m.startDate ?? '?'}→${m.endDate ?? 'no end'} (membership_user_id ${m.membershipUserId})`).join(' | ') || 'none'}`);
  const days = [...new Set([date, toDate])];
  const bookings = [], classes = [];
  for (const d of days) { bookings.push(...(await gw.getBookings(userId, { from: d, to: d, fresh: true })).bookings); classes.push(...(await gw.getClasses({ from: d, to: d, fresh: true })).classes); }
  console.log(`bookings on ${days.join(', ')}: ${bookings.map(b => `${b.date} ${hhmm(b.time)} ${b.className} (sessions left ${b.sessionsLeft})`).join(' | ') || 'none'}`);
  const cur = kind === 'book' ? null : { booking: bookings.find(b => b.date === date && hhmm(b.time) === from) ?? null };
  const tcls = kind === 'cancel' ? null : classes.filter(c => c.date === toDate && hhmm(c.start) === to);
  if (tcls && tcls.length > 1) { console.log(`REFUSED: ${tcls.length} classes start at ${to} on ${toDate} — name one schedule id by narrowing the request.`); return; }
  for (const c of classes.filter(c => (c.date === date && hhmm(c.start) === from) || (c.date === toDate && hhmm(c.start) === to)))
    console.log(`class ${c.date} ${hhmm(c.start)} ${c.name} (schedule_id ${c.scheduleId}): ${c.occupancy ? `${c.occupancy.registered}/${c.occupancy.capacity}, ${c.occupancy.spotsLeft} free` : 'occupancy unknown'}; cancellation closes ${c.cancelLockHours ?? '?'} h before`);
  const pl = await actions.plan({ kind, phone: null, member: { userId: Number(userId) }, date, bookings, classes, current: cur, target: tcls ? { cls: tcls[0] ?? null } : null });
  if (!pl.ok) { console.log(`\nPLAN REFUSED: ${pl.reason} — ${pl.text}${pl.hoursLeft !== undefined ? ` (hours left ${pl.hoursLeft}, window ${pl.lockHours} h)` : ''}`); return; }
  console.log(`\nPLAN (${kind}${pl.late ? ', LATE: inside the cancellation window of the original class' : ''}):`);
  for (const st of pl.steps) console.log(`  ${st.op}: POST ${gw.WRITE_CONTRACTS[st.op].path} ${JSON.stringify(gw.WRITE_CONTRACTS[st.op].body(st.args))}   — ${st.slot.date} ${st.slot.time} ${st.slot.name}`);
  console.log(`balance now: ${showBal(await actions.balance(Number(userId)))}`);
  if (!execute) { console.log('\nNot sent. (add --execute --owner-approved "…" --confirm-user-id <id>)'); return; }

  console.log('');
  const res = await actions.execute(pl);
  console.log(`\nRESULT: ok=${res.ok} state=${res.state} done=[${res.done.join(', ')}]${res.failed ? ` failed=${res.failed.op}@${res.failed.stage}: ${res.failed.reason}${res.failed.detail ? ` ${res.failed.detail}` : ''}` : ''}`);
  for (const l of res.log) console.log(`  ${l.op}: accepted=${l.accepted}${l.status ? ` (HTTP ${l.status})` : ''}${l.error ? ` error=${l.error.kind}: ${l.error.message} ${l.error.detail ?? ''}` : ''}${l.verify ? ` · read-back: ${l.verify.verified ? 'VISIBLE as expected' : `NOT as expected (seen=${l.verify.seen}, ${l.verify.error ?? ''})`} after ${l.verify.tries} read(s)` : ''}`);
  console.log(`BEFORE: ${showBal(res.balance.before)}`);
  console.log(`AFTER:  ${showBal(res.balance.after)}`);
  console.log(`BALANCE CHECK: ${res.balance.check} — ${res.balance.note}`);
  console.log(`requests sent: ${sent.length} (${sent.map(x => `${x.op}→${x.status ?? x.error}`).join(', ')})`);
  if (res.state === 'holds_both') console.log('⚠ The member is booked into BOTH classes. Cancel one by hand in Arbox. Nothing further was sent.');
  if (res.state === 'unknown') console.log('⚠ The outcome is UNKNOWN. Check the member in Arbox before anything else. Nothing further was sent.');
})().catch(e => { console.error('verification failed:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 300));
