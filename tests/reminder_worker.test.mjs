/**
 * reminder_worker.test.mjs — E2E tests for runCallbackPendingReminderPass.
 *
 * Tests:
 *   A. Disabled by default (CALLBACK_PENDING_REMINDER_ENABLED not set)
 *   B. No due entries → 0 sends
 *   C. Entry due → 1 pass, reminderSent=true, messages sent to all active staff
 *   D. Due time formatted in Asia/Jerusalem
 *   E. Recipients: active staff with phones only (inactive excluded)
 *   F. Restart persistence: entry survives module reload, still sent on next run
 *   G. Duplicate prevention: reminderSent=true excludes from next run
 *   H. Cancellation: cancelled entry → 0 sends
 *   I. Rescheduling: rescheduled entry → reminderSent reset → 1 send on next run
 *   J. Retry behavior: when ALL sends throw, entry is STILL marked sent (limitation)
 *
 * Architecture note:
 *   appointment_store.js exports a module-level singleton that captures DATA_DIR at
 *   load time. To use a fresh instance with a temp DATA_DIR, we set DATA_DIR in env
 *   and clear both appointment_store and appointment_worker from require.cache before
 *   each scenario that needs isolated state.
 *
 *   notification.service.js destructures sendText at load time. Patching
 *   whatsapp.service.exports.sendText BEFORE clearing and reloading notification.service
 *   ensures the new module load picks up the patched function (CJS exports object is
 *   shared by reference — the destructure copies the patched reference).
 */

import { createRequire }  from 'module';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir }         from 'os';
import path               from 'path';
import { fileURLToPath }  from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const req       = createRequire(import.meta.url);

// ── Helpers ───────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function test(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else     { console.error(`  ✗ ${label}  →  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}
function truthy(label, value) {
  if (value) { console.log(`  ✓ ${label}`); pass++; }
  else        { console.error(`  ✗ ${label}  →  expected truthy, got ${String(value)}`); fail++; }
}
function note(msg) { console.log(`  [note] ${msg}`); }

// ── Temp DATA_DIR ─────────────────────────────────────────────────────────────

const tmpBase = mkdtempSync(path.join(tmpdir(), 'rw_test_'));
const dataDir = path.join(tmpBase, 'data');
mkdirSync(dataDir, { recursive: true });

const STAFF_CONFIG = {
  staff: [
    { id: 'eden',     name: 'Eden',     phone: '972509000001', email: 'eden@test.com', active: true  },
    { id: 'melanie',  name: 'Melanie',  phone: '972509000002', email: null,            active: true  },
    { id: 'inactive', name: 'Inactive', phone: '972509000099', email: null,            active: false },
  ],
};
writeFileSync(path.join(dataDir, 'staff_config.json'), JSON.stringify(STAFF_CONFIG));
process.env.DATA_DIR = dataDir;

// ── sendText mock ─────────────────────────────────────────────────────────────
// Patching at the exports object level so that notification.service.js — when
// reloaded with a cleared cache — will destructure this mock from the same exports
// object and use it for all broadcastToStaff calls.

const wa = req('../services/whatsapp.service');
const originalSendText = wa.sendText;

let sendCalls = [];
let sendShouldThrow = false;    // throw for every phone
let sendFailPhones  = new Set(); // throw only for specific phones
wa.sendText = async (phone, message, _opts) => {
  if (sendShouldThrow || sendFailPhones.has(phone)) throw new Error('mock send failure');
  sendCalls.push({ phone, message });
  return { idMessage: `MOCK-${Date.now()}` };
};

// ── Module reload helper ──────────────────────────────────────────────────────
// Returns fresh aptStore + runCallbackPendingReminderPass that share one new
// DATA_DIR (same temp directory). Call between scenarios that need isolated state.

const APTS_FILE = path.join(dataDir, 'appointments.json');

/** Clear the appointments.json so each section starts with an empty store. */
function clearAptsFile() {
  writeFileSync(APTS_FILE, '[]');
}

function reloadModules() {
  // Order matters: clear notification.service first so the fresh appointment_worker
  // load triggers a fresh notification.service load — which picks up the patched sendText.
  // req.cache is the CJS module cache exposed by createRequire (same as Module._cache).
  for (const id of ['../services/notification.service',
                     '../utils/appointment_store',
                     '../workers/appointment_worker']) {
    const resolved = req.resolve(id);
    if (req.cache) delete req.cache[resolved];
  }
  const aptStore = req('../utils/appointment_store');
  const { runCallbackPendingReminderPass } = req('../workers/appointment_worker');
  return { aptStore, runCallbackPendingReminderPass };
}

// ── Section A — Disabled by default ──────────────────────────────────────────

console.log('\n── Section A — Disabled by default ──');
{
  clearAptsFile();
  delete process.env.CALLBACK_PENDING_REMINDER_ENABLED;
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();
  sendCalls = [];

  const apt = aptStore.createCallbackPending({
    leadPhone: '972501000001', leadName: 'Test A',
    rawTime: 'מחר בשעה 10', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });

  const result = await runCallbackPendingReminderPass(null);
  test('A: disabled → returns { pendingReminders: 0 }', result.pendingReminders, 0);
  test('A: disabled → 0 sends', sendCalls.length, 0);
  test('A: reminderSent stays false when disabled', aptStore.get(apt.id)?.reminderSent, false);
  note('CALLBACK_PENDING_REMINDER_ENABLED not set (or ≠ "true") → worker is completely silent.');
}

// ── Section B — Enabled, no due entries ──────────────────────────────────────

console.log('\n── Section B — Enabled, no due entries ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();
  sendCalls = [];

  // Entry is 2 hours away — outside the default 30-min window
  aptStore.createCallbackPending({
    leadPhone: '972501000002', leadName: 'Test B',
    rawTime: 'בעוד שעתיים', scheduledAt: new Date(Date.now() + 2 * 60 * 60_000),
    assignedStaffId: 'eden',
  });

  const result = await runCallbackPendingReminderPass(null);
  test('B: no due → returns { pendingReminders: 0 }', result.pendingReminders, 0);
  test('B: no due → 0 sends', sendCalls.length, 0);
}

// ── Section C — Entry due: sends + marks ─────────────────────────────────────

console.log('\n── Section C — Entry due: sends to all active staff ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  process.env.CALLBACK_PENDING_REMINDER_MIN = '30';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();
  sendCalls = [];

  const apt = aptStore.createCallbackPending({
    leadPhone: '972501000003', leadName: 'Test C',
    rawTime: 'מחר בשעה 10', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });

  const result = await runCallbackPendingReminderPass(null);
  test('C: returns { pendingReminders: 1 }', result.pendingReminders, 1);
  // 2 active staff with phones (eden + melanie). inactive excluded.
  test('C: 2 sends (one per active staff with phone)', sendCalls.length, 2);
  truthy('C: eden received reminder', sendCalls.some(s => s.phone === '972509000001'));
  truthy('C: melanie received reminder', sendCalls.some(s => s.phone === '972509000002'));
  test('C: inactive staff not sent to', sendCalls.some(s => s.phone === '972509000099'), false);
  test('C: reminderSent=true after pass', aptStore.get(apt.id)?.reminderSent, true);
}

// ── Section D — Due time formatted in Asia/Jerusalem ─────────────────────────

console.log('\n── Section D — Due time formatted in Asia/Jerusalem ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();
  sendCalls = [];

  // Create entry due in 10 minutes (within the 30-min window).
  // Compute the expected IL hour:minute so we can verify the message is formatted
  // in Asia/Jerusalem time (not UTC or server local time).
  const scheduledAt = new Date(Date.now() + 10 * 60_000);
  const expectedILTime = scheduledAt.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  note(`D: scheduledAt (UTC) = ${scheduledAt.toISOString()}`);
  note(`D: expectedILTime = ${expectedILTime} (via Asia/Jerusalem locale)`);

  aptStore.createCallbackPending({
    leadPhone: '972501000004', leadName: 'Test D',
    rawTime: 'בעוד 10 דקות', scheduledAt,
    assignedStaffId: 'eden',
  });

  await runCallbackPendingReminderPass(null);

  truthy('D: at least 1 send (due entry)', sendCalls.length >= 1);
  if (sendCalls.length) {
    const msg = sendCalls[0].message;
    truthy('D: reminder message contains "⏰"', msg.includes('⏰'));
    truthy('D: reminder message contains lead name', msg.includes('Test D'));
    // The formatted time must appear in the message.  formatTime uses toLocaleString
    // with timeZone:'Asia/Jerusalem', so the hour:minute in the message matches
    // expectedILTime (not UTC, not server local).
    truthy('D: reminder message contains IL-formatted time', msg.includes(expectedILTime));
    note(`D: full reminder message:\n       ${msg.replace(/\n/g, '\n       ')}`);
  }
}

// ── Section E — Recipients ────────────────────────────────────────────────────
// (Covered by Section C — 2 active staff, inactive excluded.)

// ── Section F — Restart persistence ──────────────────────────────────────────

console.log('\n── Section F — Restart persistence ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore: s1, runCallbackPendingReminderPass: pass1 } = reloadModules();
  sendCalls = [];

  // Create entry and do NOT run the pass yet
  const apt = s1.createCallbackPending({
    leadPhone: '972501000006', leadName: 'Test F',
    rawTime: 'בעוד 10 דקות', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });

  truthy('F: entry persisted to disk after create', (() => {
    const { readFileSync } = req('fs');
    const content = readFileSync(path.join(dataDir, 'appointments.json'), 'utf8');
    return content.includes(apt.id);
  })());

  // Simulate restart: reload modules (fresh AppointmentStore reads from disk)
  const { aptStore: s2, runCallbackPendingReminderPass: pass2 } = reloadModules();

  // Verify entry survived reload
  const reloaded = s2.get(apt.id);
  truthy('F: entry survives module reload', reloaded !== null);
  test('F: reloaded status = callback_pending', reloaded?.status, 'callback_pending');
  test('F: reloaded reminderSent = false', reloaded?.reminderSent, false);

  // Run the pass on the reloaded store
  const result = await pass2(null);
  test('F: reminder sent after restart', result.pendingReminders, 1);
  test('F: reminderSent=true persisted after restart run', s2.get(apt.id)?.reminderSent, true);
}

// ── Section G — Duplicate prevention ─────────────────────────────────────────

console.log('\n── Section G — Duplicate prevention ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();
  sendCalls = [];

  const apt = aptStore.createCallbackPending({
    leadPhone: '972501000007', leadName: 'Test G',
    rawTime: 'בעוד 10 דקות', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });

  // First run
  const r1 = await runCallbackPendingReminderPass(null);
  const countAfterFirst = sendCalls.length;
  test('G: first run → 1 reminder', r1.pendingReminders, 1);

  // Second run — reminderSent is now true
  sendCalls = [];
  const r2 = await runCallbackPendingReminderPass(null);
  test('G: second run → 0 reminders (deduped)', r2.pendingReminders, 0);
  test('G: second run → 0 sends', sendCalls.length, 0);
  note(`G: Sent ${countAfterFirst} message(s) on first run, 0 on second run.`);
}

// ── Section H — Cancellation ──────────────────────────────────────────────────

console.log('\n── Section H — Cancellation ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();
  sendCalls = [];

  const apt = aptStore.createCallbackPending({
    leadPhone: '972501000008', leadName: 'Test H',
    rawTime: 'בעוד 10 דקות', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });
  aptStore.markCancelled(apt.id);

  const result = await runCallbackPendingReminderPass(null);
  test('H: cancelled entry → 0 reminders', result.pendingReminders, 0);
  test('H: cancelled entry → 0 sends', sendCalls.length, 0);
}

// ── Section I — Rescheduling ──────────────────────────────────────────────────

console.log('\n── Section I — Rescheduling ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();
  sendCalls = [];

  const apt = aptStore.createCallbackPending({
    leadPhone: '972501000009', leadName: 'Test I',
    rawTime: 'בעוד 10 דקות', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });

  // First run → sends reminder, reminderSent=true
  await runCallbackPendingReminderPass(null);
  test('I: reminderSent=true after first run', aptStore.get(apt.id)?.reminderSent, true);

  // Reschedule → resets reminderSent, still callback_pending
  aptStore.reschedule(apt.id, {
    rawTime: 'מחר בשעה 15', scheduledAt: new Date(Date.now() + 10 * 60_000),
  });
  // Changed deliberately (was: reschedule → 'confirmed'): a moved callback goes back to
  // callback_pending — the new time needs staff approval again — and its reminder
  // cycle starts over. The OLD time's reminder record must not block the new one.
  const rescheduled = aptStore.get(apt.id);
  test('I: status after reschedule = callback_pending', rescheduled?.status, 'callback_pending');
  test('I: reminderSent=false after reschedule', rescheduled?.reminderSent, false);
  test('I: reminderSentTo cleared after reschedule', (rescheduled?.reminderSentTo ?? []).length, 0);

  // Run again — the rescheduled entry is due again and gets exactly one new reminder.
  sendCalls = [];
  const r2 = await runCallbackPendingReminderPass(null);
  test('I: pending pass reminds the rescheduled entry once', r2.pendingReminders, 1);
  test('I: reminderSent=true after the new cycle', aptStore.get(apt.id)?.reminderSent, true);
  const r3 = await runCallbackPendingReminderPass(null);
  test('I: no second reminder for the same new time', r3.pendingReminders, 0);
  note('I: After reschedule: status=callback_pending, fresh reminder cycle for the new time.');
}

// ── Section J — Retry behavior ────────────────────────────────────────────────
// J1: All sends fail → entry NOT marked sent → retried on next cycle.
// J2: Retry succeeds → entry marked sent → no further sends.
// J3: Partial failure → only failed recipient retried, succeeded recipient skipped.

console.log('\n── Section J — Retry behavior ──');

// J1 + J2: full failure → not marked → retry → marked → dedup
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();

  const apt = aptStore.createCallbackPending({
    leadPhone: '972501000010', leadName: 'Test J1',
    rawTime: 'בעוד 10 דקות', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });

  // ── J1: all fail ──────────────────────────────────────────────────────────
  sendCalls = [];
  sendShouldThrow = true;
  let r1;
  try { r1 = await runCallbackPendingReminderPass(null); }
  finally { sendShouldThrow = false; }

  const afterFail = aptStore.get(apt.id);
  test('J1: worker returns pendingReminders=1 (attempted)', r1.pendingReminders, 1);
  test('J1: reminderSent=false after full failure (not marked)',
    afterFail?.reminderSent, false);
  test('J1: reminderSentTo is empty after full failure',
    (afterFail?.reminderSentTo ?? []).length, 0);
  test('J1: 0 successful sends recorded', sendCalls.length, 0);

  // ── J2: retry — all succeed ───────────────────────────────────────────────
  sendCalls = [];
  const r2 = await runCallbackPendingReminderPass(null);

  const afterRetry = aptStore.get(apt.id);
  test('J2: retry returns pendingReminders=1', r2.pendingReminders, 1);
  test('J2: reminderSent=true after successful retry', afterRetry?.reminderSent, true);
  test('J2: 2 sends on retry (all active staff)', sendCalls.length, 2);
  truthy('J2: eden sent on retry', sendCalls.some(s => s.phone === '972509000001'));
  truthy('J2: melanie sent on retry', sendCalls.some(s => s.phone === '972509000002'));

  // ── J3: dedup — no further sends after full success ───────────────────────
  sendCalls = [];
  const r3 = await runCallbackPendingReminderPass(null);
  test('J3: dedup — 0 reminders after full success', r3.pendingReminders, 0);
  test('J3: dedup — 0 sends', sendCalls.length, 0);
}

// J4 + J5: partial failure — one recipient fails, is retried; already-succeeded is skipped
console.log('\n── Section J (partial failure) ──');
{
  clearAptsFile();
  process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
  const { aptStore, runCallbackPendingReminderPass } = reloadModules();

  const apt = aptStore.createCallbackPending({
    leadPhone: '972501000011', leadName: 'Test J4',
    rawTime: 'בעוד 10 דקות', scheduledAt: new Date(Date.now() + 10 * 60_000),
    assignedStaffId: 'eden',
  });

  // ── J4: eden succeeds, melanie fails ──────────────────────────────────────
  sendCalls = [];
  sendFailPhones = new Set(['972509000002']); // melanie fails
  let r4;
  try { r4 = await runCallbackPendingReminderPass(null); }
  finally { sendFailPhones = new Set(); }

  const afterPartial = aptStore.get(apt.id);
  test('J4: pendingReminders=1 (attempted)', r4.pendingReminders, 1);
  test('J4: reminderSent=false after partial failure', afterPartial?.reminderSent, false);
  truthy('J4: eden in reminderSentTo after partial success',
    (afterPartial?.reminderSentTo ?? []).includes('972509000001'));
  test('J4: melanie NOT in reminderSentTo (failed)',
    (afterPartial?.reminderSentTo ?? []).includes('972509000002'), false);
  test('J4: eden received 1 send', sendCalls.filter(s => s.phone === '972509000001').length, 1);
  test('J4: melanie received 0 sends (failed)', sendCalls.filter(s => s.phone === '972509000002').length, 0);

  // ── J5: retry — only melanie is retried, eden is skipped ──────────────────
  sendCalls = [];
  const r5 = await runCallbackPendingReminderPass(null);

  const afterRecovery = aptStore.get(apt.id);
  test('J5: pendingReminders=1 (retried)', r5.pendingReminders, 1);
  test('J5: reminderSent=true after recovery', afterRecovery?.reminderSent, true);
  test('J5: eden NOT resent (already accepted)',
    sendCalls.filter(s => s.phone === '972509000001').length, 0);
  test('J5: melanie sent on retry',
    sendCalls.filter(s => s.phone === '972509000002').length, 1);
}

// ── Timing / status report ────────────────────────────────────────────────────

console.log('\n── Reminder worker: status report ──');
note('ENABLED: requires CALLBACK_PENDING_REMINDER_ENABLED=true in env/Railway Variables.');
note('TIMING: cron runs every 15 min (timezone: Asia/Jerusalem). Default window: 30 min.');
note('WINDOW: controlled by CALLBACK_PENDING_REMINDER_MIN (default "30"). Floor: 20 min.');
note('RECIPIENTS: ALL active staff in staff_config.json with a phone. Not just the owner.');
note('DEDUP: per-recipient (reminderSentTo[]) + global (reminderSent). Persists across restarts.');
note('RETRY: failed recipients are retried each cycle; accepted recipients are never resent.');

// ── Cleanup ───────────────────────────────────────────────────────────────────

wa.sendText = originalSendText;
delete process.env.CALLBACK_PENDING_REMINDER_ENABLED;
delete process.env.CALLBACK_PENDING_REMINDER_MIN;
try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}

console.log('\n─────────────────────────────────────────────────────────');
console.log(`reminder_worker.test.mjs: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) process.exit(1);
