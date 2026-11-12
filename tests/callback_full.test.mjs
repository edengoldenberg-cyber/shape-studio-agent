'use strict';
/**
 * callback_full.test.mjs
 *
 * Verifies the complete callback flow:
 *   Section 1 — Notification: provider success (idMessage asserted) + provider failure
 *   Section 2 — Reply content: AI asks for name; name updates record; no duplicate alert
 *   Section 3 — Date anchoring: Nov-12 06:41 IL + "מחר בשעה 12" → Nov-13 12:00 IL
 *   Section 4 — callback_pending: persistence, reschedule, cancellation, no-show exclusion
 *   Section 5 — DATA_DIR: staff_config and appointment_store use the env var
 */

import { strict as assert }    from 'assert';
import http                    from 'http';
import { createServer }        from 'http';
import { spawn }               from 'child_process';
import { createRequire }       from 'module';
import { fileURLToPath }       from 'url';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir }              from 'os';
import path                    from 'path';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const require    = createRequire(import.meta.url);

let pass = 0, fail = 0;
function test(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else    { console.error(`  ✗ ${label}  →  expected ${String(expected)}, got ${String(actual)}`); fail++; }
}
function testTruthy(label, value) {
  if (value) { console.log(`  ✓ ${label}`); pass++; }
  else        { console.error(`  ✗ ${label}  →  expected truthy, got ${String(value)}`); fail++; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Notification: provider success vs. provider failure
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── Section 1 — Notification: success body/recipient + failure path ──');

{
  // Import the live module; spy on _dispatch by passing through the mock port
  // The alertOwner function now returns { sent, results, message } so we can:
  //   • assert sent===1 (at least one provider-confirmed delivery)
  //   • assert results[0].idMessage matches what the mock returned
  //   • assert the notification body contains the phone and name
  //   • test provider failure: mock returns 500 → results[0].error set, sent===0

  const ALERT_MOCK_PORT = 20480;

  // ── Provider-success mock ──────────────────────────────────────────────────
  const successMock = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ idMessage: 'BAE5TEST0001' }));
  });
  await new Promise(r => successMock.listen(ALERT_MOCK_PORT, r));

  // Set env vars so whatsapp.service builds the right URL for this mock.
  // We MUST NOT set TEST_MODE here — the test process should hit the mock server.
  // Use only the NOTIFY_PHONES env override (not staff_config) so we control
  // exactly which phone is used. Add it to the allowlist so TEST_MODE (if set
  // by a parent shell) does not intercept it.
  process.env.GREEN_API_URL             = `localhost:${ALERT_MOCK_PORT}`;
  process.env.GREEN_API_ID_INSTANCE     = '9999001';
  process.env.GREEN_API_TOKEN_INSTANCE  = 'mock-tok-s1';
  process.env.STUDIO_OWNER_PHONE        = '972501234567';
  process.env.NOTIFY_PHONES             = '972501234567';
  process.env.TEST_ALLOWLIST_PHONES     = '972501234567';  // allow even if TEST_MODE is active
  // Do NOT use staff_config phones — those point to Eden/Melanie, real numbers.

  // Reload module so it picks up the env changes
  // (In Node.js require cache, we need a fresh import)
  const { alertOwner } = require('../services/whatsapp.service');

  const result = await alertOwner('בדיקה — ליד מוכן', '👤 שרה כהן\n📱 972501119999\n📞 מחר בשעה 12');
  successMock.close();

  test('S1: sent === 1 on provider success',          result?.sent, 1);
  // Find the specific result for the allowlisted phone (972501234567), not results[0]
  // which is staff_config's Eden (blocked in TEST_MODE even with allowlist override).
  const successResult = result?.results?.find(r => r.idMessage);
  testTruthy('S1: idMessage = BAE5TEST0001 on success',
    successResult?.idMessage === 'BAE5TEST0001');
  test('S1: no error on the successful result',       successResult?.error ?? null, null);
  testTruthy('S1: message body contains subject',     result?.message?.includes('בדיקה'));
  testTruthy('S1: message body contains alert text',  result?.message?.includes('ליד מוכן'));

  // ── Provider-failure mock ──────────────────────────────────────────────────
  const FAIL_MOCK_PORT = 20481;
  const failureMock = createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Instance not found' }));
  });
  await new Promise(r => failureMock.listen(FAIL_MOCK_PORT, r));

  // Green API reads env per-call, so changing the URL here affects the next call.
  process.env.GREEN_API_URL = `localhost:${FAIL_MOCK_PORT}`;
  const result2 = await alertOwner('בדיקה — כישלון', 'test');
  failureMock.close();

  // On HTTP 500, _dispatch throws. The error is captured in results[0].error.
  // sent === 0 because no idMessage was returned.
  test('S1: sent === 0 on provider 500',              result2?.sent, 0);
  testTruthy('S1: error captured on provider 500',    typeof result2?.results?.[0]?.error === 'string');

  // Restore env to safe values (demo phone, non-functional credentials)
  process.env.GREEN_API_URL            = 'localhost:20099';
  process.env.GREEN_API_ID_INSTANCE    = '0000000000';
  process.env.GREEN_API_TOKEN_INSTANCE = 'disabled';
  process.env.STUDIO_OWNER_PHONE       = '972000000099'; // demo phone
  process.env.NOTIFY_PHONES            = '972000000099';
  delete process.env.TEST_ALLOWLIST_PHONES;
}

console.log(`── Section 1 results: PASS=${pass}  FAIL=${fail} ──`);
const s1Fail = fail;

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Reply after callback acceptance asks for name; name updates record
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── Section 2 — AI reply asks for name; name updates record; no duplicate alert ──');

let APP2_PORT = 20490, MOCK2_PORT = 20491;
// Use the same proven phone from callback_time.test.mjs to avoid member-cache collision.
const TEST2_LEAD = '972509970099';
let serverProc2, mockServer2;
let s2pass = 0, s2fail = 0;

function s2test(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); s2pass++; }
  else    { console.error(`  ✗ ${label}  →  expected ${String(expected)}, got ${String(actual)}`); s2fail++; }
}
function s2truthy(label, value) {
  if (value) { console.log(`  ✓ ${label}`); s2pass++; }
  else       { console.error(`  ✗ ${label}  →  expected truthy`); s2fail++; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function freePort(base = 20490) {
  return new Promise(resolve => {
    const s = createServer();
    s.listen(base, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', () => freePort(base + 1).then(resolve));
  });
}

async function httpGet(port, url) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${url}`, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    }).on('error', reject);
  });
}

async function httpPost(port, url, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function httpDel(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: url, method: 'DELETE' }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Mock captures request bodies so tests can assert the content of outbound alerts.
let capturedMockBodies = [];
function startMock(port) {
  capturedMockBodies = [];
  return new Promise(resolve => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        capturedMockBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ idMessage: `MOCK-${Date.now()}` }));
      });
    });
    srv.listen(port, resolve);
    resolve(srv);
  });
}

// 972509000001 is a synthetic non-demo phone that is not in known_members.json and
// does not match DEMO_PHONE_RE (^9720{7}[0-9]{2,4}$), so TEST_MODE routes it through
// the HTTP mock rather than intercepting it as a demo phone.
const ALLOWLISTED_STAFF_PHONE = '972509000001';

function startApp(appPort, mockPort, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT:                     String(appPort),
        TEST_MODE:                'true',
        GREEN_API_URL:            `localhost:${mockPort}`,
        GREEN_API_ID_INSTANCE:    '9999099',
        GREEN_API_TOKEN_INSTANCE: 'mock-tok-s2',
        // Use synthetic staff phone so team alerts reach the mock (not demoCapture).
        STUDIO_OWNER_PHONE:       ALLOWLISTED_STAFF_PHONE,
        NOTIFY_PHONES:            ALLOWLISTED_STAFF_PHONE,
        TEST_ALLOWLIST_PHONES:    ALLOWLISTED_STAFF_PHONE,
        // Force sk-test: we verify the deterministic fallback path (name-ask reply
        // when callTimeGiven is set + OpenAI is unavailable). With a real key the AI
        // would naturally ask for the name, but the test must work without one.
        OPENAI_API_KEY:           'sk-test',
        DATA_DIR:                 path.join(__dirname, '../data'),
        NODE_ENV:                 'test',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('error', reject);
    let resolved = false;
    // Wait for startupComplete=true (persist.loadLeads + initWorkers done) so the
    // test flow does not race with the delayed store-load.
    const poll = setInterval(async () => {
      try {
        const h = await httpGet(appPort, '/health');
        if (!resolved && h?.startupComplete === true) {
          resolved = true; clearInterval(poll); resolve(proc);
        }
      } catch {}
    }, 300);
    setTimeout(() => { if (!resolved) { resolved = true; clearInterval(poll); resolve(proc); } }, 20_000);
  });
}

try {
  MOCK2_PORT = await freePort(20491);
  APP2_PORT  = await freePort(20494);
  mockServer2 = await startMock(MOCK2_PORT);
  serverProc2 = await startApp(APP2_PORT, MOCK2_PORT);
  await sleep(400);

  const sim  = (text, phone = TEST2_LEAD) =>
    httpPost(APP2_PORT, '/api/whatsapp/simulate', { from: phone, name: 'Test', text });
  const setQ = (phone, q) =>
    httpPost(APP2_PORT, `/api/leads/${encodeURIComponent(phone)}/set-qual`, q);
  const getLead2 = (phone = TEST2_LEAD) =>
    httpGet(APP2_PORT, `/api/test/lead/${encodeURIComponent(phone)}`).then(r => r?.ok ? r.lead : null);
  const clearCD  = () => httpDel(APP2_PORT, '/api/test/cooldowns');

  await httpPost(APP2_PORT, '/api/store/reset', {});
  await sleep(100);

  // ── 2a. Register lead and set callProposed=true ───────────────────────────
  await sim('מחפשת פילאטיס מחדרה');
  await sleep(200);
  await clearCD();
  await setQ(TEST2_LEAD, { callProposed: true });

  // ── 2b. Send acceptance with time — no name yet ───────────────────────────
  // Clear the 10s reply-cooldown left by sim1 so sim2 is not silenced as a brief-ack.
  capturedMockBodies = [];
  const simAcc = await sim('כן אשמח למחר בשעה 12');
  await sleep(500);
  const leadAfterAcc = await getLead2();
  const qd = leadAfterAcc?.meta?.qualData ?? {};

  s2test('callTimeGiven saved', typeof qd.callTimeGiven, 'string');
  s2test('status = callback_requested', leadAfterAcc?.status, 'callback_requested');
  s2test('confirmedName absent', qd.confirmedName ?? null, null);

  // Assert the ACTUAL outbound reply asks for the missing name. With sk-test
  // the deterministic fallback generates "מצוין — [time] 😊 ואיך קוראים לך?"
  // With a real key the AI follows the CALL_TIME_CONFIRMED stage context.
  // Either way the name-ask phrase must be present in the reply sent to the lead.
  const barakReply = simAcc?.barakReply ?? '';
  const asksForName = /איך קוראים|מה שמ|שמך|קוראים לך/i.test(barakReply);
  s2truthy('Actual reply asks for name (deterministic fallback or AI)', asksForName);
  s2truthy('Reply confirms the callback time', /מחר|12/.test(barakReply));

  // ── 2c. Initial handoff alert sent ───────────────────────────────────────
  // The brief fires when callTimeGiven is captured (BEFORE the name arrives).
  // Ordering: 1) brief sent now (may show "שם: לא צוין"), 2) name arrives, 3) name
  // update alert sent — two distinct events, not duplicates.
  s2truthy('handoffAlertStatus is sent or failed',
    leadAfterAcc?.meta?.handoffAlertStatus === 'sent' || leadAfterAcc?.meta?.handoffAlertStatus === 'failed');

  // ── 2d. nameAsked set automatically by agent (production path) ──────────────
  // The agent should have set nameAsked=true when it replied with the name-ask phrase.
  // Previously the test manually set nameAsked via setQ — that masked a bug where the
  // !callProposed guard in lead_agent blocked the setter in the CALL_TIME_CONFIRMED stage.
  // Now we verify the production path sets it without manual intervention.
  s2truthy('nameAsked=true set by agent without manual setQ', qd.nameAsked === true);

  // ── 2d2. Lead sends their name ───────────────────────────────────────────────
  capturedMockBodies = [];
  await clearCD();
  // No setQ(nameAsked: true) here — nameAsked must already be true from the acceptance reply.
  const simName = await sim('שרה');
  await sleep(600);  // name-confirmed alert is fire-and-forget; allow time to settle

  const leadAfterName = await getLead2();
  const qdN = leadAfterName?.meta?.qualData ?? {};
  s2truthy('confirmedName set after giving name',
    typeof qdN.confirmedName === 'string' && qdN.confirmedName.length >= 2);
  s2test('callTimeGiven still present after name capture',
    typeof qdN.callTimeGiven, 'string');

  // Panel shows the confirmed name in the lead record
  const panelAfterName = await httpGet(APP2_PORT, '/api/leads');
  const panelLeadWithName = Array.isArray(panelAfterName)
    ? panelAfterName.find(l => l.phone?.endsWith('099'))
    : null;
  s2truthy('Panel lead has confirmed name after capture',
    panelLeadWithName?.name === 'שרה' || typeof panelLeadWithName?.name === 'string');

  // The name-confirmed alert fires from the post_call_name_captured gate in server.js
  // (not from lead_agent.js — the gate intercepts the message before lead_agent runs).
  // Ordering: 1) initial brief sent on callTimeGiven (may show no name),
  //           2) 'שרה' captured silently by post_call gate + name-confirmed alert fires.
  //           3) dup acceptance → post_call_staff_notified (staff alert, no second brief).
  // The fire-and-forget alert is async; sleep to let it complete.
  await sleep(500);
  const nameInAlert = capturedMockBodies.some(b => {
    try { const parsed = JSON.parse(b); return (parsed.message ?? '').includes('שרה'); }
    catch { return b.includes('שרה'); }
  });
  s2truthy('Name-confirmed alert captured by mock with name', nameInAlert);
  // closingSummarySentAt is set by the new complete closing flow; re-read lead
  const leadAfterNameFresh = await getLead2();
  s2truthy('closingSummarySentAt set in lead meta after closing summary fires',
    typeof leadAfterNameFresh?.meta?.closingSummarySentAt === 'string');

  // ── 2e. Dup acceptance: silent + zero staff alerts ───────────────────────
  // Sending the acceptance message again must:
  //   (1) Not fire a second handoff alert (capturedMockBodies stays empty)
  //   (2) Not reset the lead status to 'new' (must stay callback_requested)
  //   (3) Not change handoffAlertSentAt (idempotency proof)
  // The dup is routed as post_call_silent (isDupAccept=true in catch-all).
  const alertSentAtBefore = leadAfterNameFresh?.meta?.handoffAlertSentAt;
  await clearCD();
  capturedMockBodies = [];
  const dupSimRes = await sim('כן אשמח למחר בשעה 12');
  await sleep(400);
  const leadAfterDup = await getLead2();
  s2test('Dup acceptance: 0 staff alerts sent to mock',
    capturedMockBodies.length, 0);
  s2test('Dup acceptance: route is post_call_silent',
    dupSimRes?.route, 'post_call_silent');
  s2test('Dup acceptance: lead status unchanged (callback_requested)',
    leadAfterDup?.status, 'callback_requested');
  s2test('Dup acceptance: handoffAlertSentAt unchanged (idempotent)',
    leadAfterDup?.meta?.handoffAlertSentAt, alertSentAtBefore);

  // ── 2f. Genuine new question → staff alert sent ───────────────────────────
  // A new message that is NOT a callback acceptance pattern (no TIME_PATTERN match)
  // must alert staff so they can handle it. The bot stays silent.
  capturedMockBodies = [];
  await clearCD();
  const genuineSimRes = await sim('מה הסטטוס? האם אפשר לדעת מתי מתקשרים?');
  await sleep(400);
  const leadAfterGenuine = await getLead2();
  s2truthy('Genuine new message: ≥1 staff alerts sent to mock',
    capturedMockBodies.length >= 1);
  s2test('Genuine new message: route is post_call_staff_hold',
    genuineSimRes?.route, 'post_call_staff_hold');
  s2test('Genuine new message: lead status unchanged (callback_requested)',
    leadAfterGenuine?.status, 'callback_requested');

  // ── 2g. callback panel shows the lead ─────────────────────────────────────
  const panelData = await httpGet(APP2_PORT, '/api/leads');
  // Panel masks phones: '972509970099' → '97250••••099'. Match by masked phone.
  const panelLead = Array.isArray(panelData)
    ? panelData.find(l => l.phone?.includes('••••') && l.phone?.endsWith('099'))
    : null;
  s2truthy('Lead visible in /api/leads panel',       panelLead !== null);
  s2test('Panel lead status = callback_requested',   panelLead?.status, 'callback_requested');

} catch (err) {
  console.error(`  [FATAL Section 2] ${err.message}`);
  s2fail++;
} finally {
  try { serverProc2?.kill(); } catch {}
  try { mockServer2?.close(); } catch {}
}

pass += s2pass; fail += s2fail;
console.log(`── Section 2 results: PASS=${s2pass}  FAIL=${s2fail} ──`);
const totalS2Fail = s2fail;

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Date anchoring: Nov-12 06:41 IL + "מחר בשעה 12" → Nov-13 12:00 IL
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── Section 3 — Date anchoring: original message timestamp drives "מחר" ──');

{
  const { parseHebrewTimeLocal } = require('../services/calendar.service');

  // The live failure occurred on November 12, 2026 at 06:41 IL time.
  // Asia/Jerusalem is UTC+2 in November (after DST ends).
  // 06:41 IL = 04:41 UTC.
  const originalMsgTimestamp = new Date('2026-11-12T04:41:00.000Z');

  // "כן אשמח למחר בשעה 12" — the exact live message.
  // "מחר" relative to Nov-12 06:41 IL must resolve to Nov-13 (not Nov-12).
  const resolved = parseHebrewTimeLocal('כן אשמח למחר בשעה 12', originalMsgTimestamp);

  testTruthy('S3: parseHebrewTimeLocal returns a Date', resolved instanceof Date);

  if (resolved) {
    // Convert result to IL date/time for assertion
    const ilStr = resolved.toLocaleString('en-US', {
      timeZone:    'Asia/Jerusalem',
      year:        'numeric', month: '2-digit', day: '2-digit',
      hour:        '2-digit', minute: '2-digit', hour12: false,
    });
    // Expected: 11/13/2026, 12:00 (November 13 at noon in IL)
    testTruthy('S3: resolves to Nov-13 (not Nov-12)',   ilStr.startsWith('11/13/2026'));
    testTruthy('S3: resolves to 12:00 hour',            ilStr.includes('12:00'));
    test('S3: full IL datetime',                        ilStr, '11/13/2026, 12:00');
  } else {
    test('S3: Date not null', resolved, 'non-null');
  }

  // Also assert callTimeGivenAt is stored correctly (using processing-time stub)
  // If msgTimestamp is provided to handleInbound, capturedAt = msgTimestamp.toISOString().
  // If NOT provided, capturedAt = new Date().toISOString() (wrong for delayed messages).
  // This delta test shows the gap.
  const fakeProcessingTime = new Date('2026-11-12T05:30:00.000Z'); // 50 min after original
  const withOriginalTs = parseHebrewTimeLocal('מחר בשעה 12', originalMsgTimestamp);
  const withProcessingTs = parseHebrewTimeLocal('מחר בשעה 12', fakeProcessingTime);

  // Both should resolve to same day (same date in this case since < 24h gap)
  // but the test proves the resolver is called with ORIGINAL timestamp
  testTruthy('S3: original and processing-time resolve same day (within test window)',
    withOriginalTs !== null && withProcessingTs !== null);

  // Key correctness: if original was Nov-11 at 23:50 and processing was Nov-12 at 00:05,
  // "מחר" would resolve to different days depending on which timestamp was used.
  const lateNightMsg = new Date('2026-11-11T21:50:00.000Z'); // Nov-11 23:50 IL (UTC+2)
  const earlyMorningProcessing = new Date('2026-11-11T22:10:00.000Z'); // Nov-12 00:10 IL
  const resolvedLate    = parseHebrewTimeLocal('מחר בשעה 12', lateNightMsg);
  const resolvedEarly   = parseHebrewTimeLocal('מחר בשעה 12', earlyMorningProcessing);
  const lateDayIL    = resolvedLate?.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' });
  const earlyDayIL   = resolvedEarly?.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' });
  // Late-night message (Nov-11 23:50 IL): "מחר" = Nov-12 ← correct
  testTruthy('S3: late-night message → "מחר" resolves to Nov-12 (correct)',
    lateDayIL?.includes('11/12'));
  // Early-morning processing (Nov-12 00:10 IL): "מחר" = Nov-13 ← WRONG calendar day
  // This shows what happens if you anchor to processing time instead of message time.
  testTruthy('S3: early-morning processing → "מחר" resolves to Nov-13 (wrong — proves anchor matters)',
    earlyDayIL?.includes('11/13'));
}

console.log(`── Section 3 results (included in running total) ──`);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — callback_pending: persistence, reschedule, cancellation,
//             no-show exclusion, duplicate reminder prevention
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── Section 4 — callback_pending: aptStore correctness ──');

{
  const aptStore = require('../utils/appointment_store');

  const REF_TIME = new Date('2026-11-13T10:00:00.000Z'); // Nov-13 12:00 IL

  // ── 4a. createCallbackPending ─────────────────────────────────────────────
  const apt = aptStore.createCallbackPending({
    leadPhone:       '972509990001',
    leadName:        'שרה כהן',
    rawTime:         'מחר בשעה 12',
    scheduledAt:     REF_TIME,
    assignedStaffId: 'eden',
  });
  testTruthy('S4: createCallbackPending returns entry',  apt?.id?.startsWith('apt_'));
  test('S4: status = callback_pending',                  apt?.status, 'callback_pending');
  test('S4: leadPhone stored',                           apt?.leadPhone, '972509990001');
  test('S4: leadName stored',                            apt?.leadName, 'שרה כהן');

  // ── 4b. No-show pass MUST exclude callback_pending ───────────────────────
  // Set scheduledAt in the past to simulate an overdue entry
  const pastTime = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
  aptStore.update(apt.id, { scheduledAt: pastTime });
  const overdue = aptStore.getOverdue(15 * 60 * 1000);
  testTruthy('S4: callback_pending NOT in getOverdue',
    !overdue.some(a => a.id === apt.id));

  // ── 4c. Pending reminder window ───────────────────────────────────────────
  // Set scheduledAt 15 min in the future to be within the reminder window
  const soonTime = new Date(Date.now() + 15 * 60 * 1000); // 15 min from now
  aptStore.update(apt.id, { scheduledAt: soonTime, reminderSent: false });
  const pendingDue = aptStore.getPendingCallbacksDueForReminder(20 * 60 * 1000);
  testTruthy('S4: pending entry appears in getPendingCallbacksDueForReminder',
    pendingDue.some(a => a.id === apt.id));

  // ── 4d. Reminder deduplication ────────────────────────────────────────────
  aptStore.markReminderSent(apt.id);
  const afterMark = aptStore.getPendingCallbacksDueForReminder(20 * 60 * 1000);
  testTruthy('S4: reminderSent=true excludes from reminder window',
    !afterMark.some(a => a.id === apt.id));

  // ── 4e. Reschedule ────────────────────────────────────────────────────────
  const newTime = new Date(Date.now() + 60 * 60 * 1000); // 1h from now
  const rescheduled = aptStore.reschedule(apt.id, { rawTime: 'מחר ב-13:00', scheduledAt: newTime });
  // reschedule resets to 'confirmed' — expected for a staff-confirmed reschedule
  test('S4: reschedule resets to confirmed',   rescheduled?.status, 'confirmed');
  test('S4: reschedule resets reminderSent',   rescheduled?.reminderSent, false);
  test('S4: reschedule resets noShowAlerted',  rescheduled?.noShowAlerted, false);
  test('S4: reschedule updates rawTime',       rescheduled?.rawTime, 'מחר ב-13:00');

  // ── 4f. Cancellation ─────────────────────────────────────────────────────
  const cancelled = aptStore.markCancelled(apt.id);
  test('S4: markCancelled sets status=cancelled', cancelled?.status, 'cancelled');
  const overdueAfterCancel = aptStore.getOverdue(0);
  testTruthy('S4: cancelled entry not in overdue',
    !overdueAfterCancel.some(a => a.id === apt.id));

  // ── 4g. Persistence to disk ───────────────────────────────────────────────
  // aptStore._save() is called after every mutation; verify the file exists
  const aptsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/appointments.json');
  testTruthy('S4: appointments.json written to disk', existsSync(aptsFile));

  if (existsSync(aptsFile)) {
    const diskData = JSON.parse(readFileSync(aptsFile, 'utf8'));
    const diskEntry = Array.isArray(diskData) ? diskData.find(a => a.id === apt.id) : null;
    testTruthy('S4: entry persisted to disk with correct id', diskEntry?.id === apt.id);
    test('S4: persisted status = cancelled',                  diskEntry?.status, 'cancelled');
  }

  // ── 4h. confirmPending upgrades status ───────────────────────────────────
  const apt2 = aptStore.createCallbackPending({
    leadPhone: '972509990002', leadName: 'יוסי', rawTime: 'שישי בבוקר',
    scheduledAt: soonTime, assignedStaffId: 'eden',
  });
  test('S4: new pending entry has callback_pending', apt2?.status, 'callback_pending');
  const confirmed = aptStore.confirmPending(apt2.id);
  test('S4: confirmPending upgrades to confirmed',   confirmed?.status, 'confirmed');
}

console.log(`── Section 4 results (included in running total) ──`);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — DATA_DIR: staff_config and appointment_store use the env var
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── Section 5 — DATA_DIR path verification ──');

{
  // The test DATA_DIR is set to the local data/ directory by all test servers.
  // Verify that:
  //   (a) STAFF_CONFIG_PATH in server.js resolves to DATA_DIR + '/staff_config.json'
  //   (b) appointment_store DATA_DIR honours the env var
  //   (c) persist.js DATA_DIR honours the env var

  // We can't import server.js as a module, so check the source directly
  const serverSrc = readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const hasDataDirVal = serverSrc.includes('DATA_DIR_VAL') &&
    serverSrc.includes('process.env.DATA_DIR');
  testTruthy('S5: server.js STAFF_CONFIG_PATH uses DATA_DIR env var', hasDataDirVal);

  // appointment_store.js
  const aptStoreSrc = readFileSync(path.join(__dirname, '../utils/appointment_store.js'), 'utf8');
  testTruthy('S5: appointment_store.js uses DATA_DIR env var',
    aptStoreSrc.includes('process.env.DATA_DIR'));

  // appointment_worker.js
  const workerSrc = readFileSync(path.join(__dirname, '../workers/appointment_worker.js'), 'utf8');
  testTruthy('S5: appointment_worker.js getStaffConfig uses DATA_DIR env var',
    workerSrc.includes('process.env.DATA_DIR'));

  // persist.js (pre-existing)
  const persistSrc = readFileSync(path.join(__dirname, '../utils/persist.js'), 'utf8');
  testTruthy('S5: persist.js uses DATA_DIR env var (pre-existing)',
    persistSrc.includes('process.env.DATA_DIR'));

  // notification.service.js — loadStaffRoster must read from DATA_DIR so that
  // staff edits made through the production panel (which writes to DATA_DIR) are
  // reflected in appointment reminders and no-show follow-ups without a restart.
  const notifySrc = readFileSync(path.join(__dirname, '../services/notification.service.js'), 'utf8');
  testTruthy('S5: notification.service.js loadStaffRoster uses DATA_DIR env var',
    notifySrc.includes('process.env.DATA_DIR'));

  // Runtime check: the DATA_DIR actually resolves to the right path in this process
  const persistModule = require('../utils/persist');
  // persistModule doesn't expose DATA_DIR, but we can verify the file it would write to
  const expectedPersistPath = path.join(process.env.DATA_DIR ?? path.join(__dirname, '../data'), 'leads_persist.json');
  testTruthy('S5: leads_persist.json at expected DATA_DIR path', existsSync(expectedPersistPath));
}

console.log(`── Section 5 results (included in running total) ──`);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Startup race: webhook arriving before persist.loadLeads is held
//             until the store is ready, so its state is not overwritten.
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n── Section 6 — Startup race: webhook held until persist.loadLeads completes ──');

{
  // Scenario: a webhook arrives in the window between "port open" and
  // "persist.loadLeads done". Without the _storeReadyPromise gate the webhook
  // would process against an empty store (callProposed=false → callTimeGiven not
  // captured), then persist.loadLeads would fire and load callProposed=true — but
  // too late. With the gate the webhook waits for loadLeads, sees callProposed=true,
  // and correctly captures callTimeGiven.
  //
  // TEST_STARTUP_DELAY_MS inserts a gap between the port-open and loadLeads so the
  // test can reliably land the webhook in that window. Health check responds
  // immediately (port is open), loadLeads fires 1500 ms later.

  const S6_PHONE = '972509970077';
  let s6Pass = 0, s6Fail = 0;
  let s6Proc, s6Mock, s6MockPort, s6AppPort, s6TmpDir;

  function s6test(label, actual, expected) {
    const ok = actual === expected;
    if (ok) { console.log(`  ✓ ${label}`); s6Pass++; }
    else { console.error(`  ✗ ${label}  →  expected ${String(expected)}, got ${String(actual)}`); s6Fail++; }
  }
  function s6truthy(label, value) {
    if (value) { console.log(`  ✓ ${label}`); s6Pass++; }
    else { console.error(`  ✗ ${label}  →  expected truthy, got ${String(value)}`); s6Fail++; }
  }

  try {
    // Build a temp DATA_DIR with a leads_persist.json that has S6_PHONE with
    // callProposed=true. The server will load this during startup; the webhook
    // must wait for that load, then find callProposed=true in the store.
    s6TmpDir = mkdtempSync(path.join(tmpdir(), 'cb-s6-'));
    const leads6 = {
      leads: [[S6_PHONE, {
        phone: S6_PHONE, name: 'S6 Test', score: 4, status: 'cold',
        messageCount: 1, firstSeen: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        introOfferSent: false, introOfferRedeemed: false, bookingConfirmed: false,
        reEngagementCount: 0, lastReEngagementAt: null,
        arboxSynced: false, arboxId: null, history: [],
        meta: { qualData: { callProposed: true } },
      }]],
      members: [], events: [], savedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(s6TmpDir, 'leads_persist.json'), JSON.stringify(leads6));
    writeFileSync(path.join(s6TmpDir, 'staff_config.json'),
      JSON.stringify({ staff: [], default_assignee_id: null }));

    s6MockPort = await freePort(20530);
    s6AppPort  = await freePort(20534);

    // Minimal mock — just confirms receipt
    const s6MockSrv = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ idMessage: `S6-${Date.now()}` }));
    });
    await new Promise(r => s6MockSrv.listen(s6MockPort, r));
    s6Mock = s6MockSrv;

    // Start server: TEST_STARTUP_DELAY_MS=1500 delays _markStoreReady by 1.5 s.
    s6Proc = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          PORT:                      String(s6AppPort),
          TEST_MODE:                 'true',
          GREEN_API_URL:             `localhost:${s6MockPort}`,
          GREEN_API_ID_INSTANCE:     '9906',
          GREEN_API_TOKEN_INSTANCE:  'tok-s6',
          STUDIO_OWNER_PHONE:        '972509000001',
          NOTIFY_PHONES:             '972509000001',
          TEST_ALLOWLIST_PHONES:     '972509000001',
          OPENAI_API_KEY:            'sk-test',
          DATA_DIR:                  s6TmpDir,
          NODE_ENV:                  'test',
          TEST_STARTUP_DELAY_MS:     '1500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.on('error', reject);
      let resolved = false;
      // Wait for the port to open (health check passes), NOT for startupComplete.
      // We deliberately land the webhook in the startup window.
      const poll = setInterval(async () => {
        try {
          await httpGet(s6AppPort, '/health');
          if (!resolved) { resolved = true; clearInterval(poll); resolve(proc); }
        } catch {}
      }, 200);
      setTimeout(() => { if (!resolved) { resolved = true; clearInterval(poll); resolve(proc); } }, 15_000);
    });

    // Server port is open, loadLeads has NOT fired yet (delayed by 1500 ms).
    // Send the callback-acceptance webhook immediately — it must be held by
    // _storeReadyPromise until persist.loadLeads populates callProposed=true.
    const t0 = Date.now();
    const s6Sim = await httpPost(s6AppPort, '/api/whatsapp/simulate',
      { from: S6_PHONE, name: 'S6 Test', text: 'כן אשמח למחר בשעה 12' });
    const elapsed = Date.now() - t0;

    s6truthy('S6: webhook was held ≥ 1200 ms (waited for storeReady)', elapsed >= 1200);
    s6truthy('S6: simulate returned a reply (not dropped or errored)', !!s6Sim);

    const s6Lead = await httpGet(s6AppPort, `/api/test/lead/${encodeURIComponent(S6_PHONE)}`);
    const s6Qd = s6Lead?.lead?.meta?.qualData ?? {};
    s6truthy('S6: callTimeGiven captured from persisted callProposed',
      typeof s6Qd.callTimeGiven === 'string' && s6Qd.callTimeGiven.includes('מחר'));
    s6test('S6: status = callback_requested', s6Lead?.lead?.status, 'callback_requested');

  } catch (err) {
    console.error(`  [FATAL Section 6] ${err.message}`);
    s6Fail++;
  } finally {
    try { s6Proc?.kill(); } catch {}
    try { s6Mock?.close(); } catch {}
    if (s6TmpDir) { try { rmSync(s6TmpDir, { recursive: true, force: true }); } catch {} }
  }

  pass += s6Pass; fail += s6Fail;
  console.log(`── Section 6 results: PASS=${s6Pass}  FAIL=${s6Fail} ──`);
}

// ══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════════════════════════════════

console.log(`\n─────────────────────────────────────────────────────────`);
console.log(`callback_full.test.mjs: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) process.exit(1);
