'use strict';
/**
 * callback_time.test.mjs
 *
 * Section 1 — Pattern unit tests: TIME_PATTERN + TIME_REJECTION_RE.
 * Section 2 — Full callback flow via simulate endpoint.
 *
 * Section 2 scenario:
 *   register lead (first message) → set callProposed=true → send acceptance →
 *   verify: callTimeGiven, callTimeGivenAt, status=callback_requested, event log,
 *   handoffAlert attempted, confirmedName absent, leads_persist.json updated.
 *   Then: rejection guard, duplicate delivery guard, name collection.
 */

import { strict as assert } from 'assert';
import http                 from 'http';
import { createServer }     from 'http';
import { spawn }            from 'child_process';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { readFileSync }     from 'fs';
import path                 from 'path';

// Never the repo's data/ folder: run through `node tests/run_mjs_tests.mjs`, which gives
// every harness its own temporary DATA_DIR and dummy external credentials.
const ISOLATED_DATA_DIR = process.env.MJS_ISOLATED_DATA_DIR;
if (!ISOLATED_DATA_DIR) {
  console.error('[FATAL] Run via: node tests/run_mjs_tests.mjs --filter callback_time (isolated DATA_DIR required)');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Pattern unit tests (no server)
// ══════════════════════════════════════════════════════════════════════════════

const { TIME_PATTERN, TIME_REJECTION_RE } = require('../agents/lead_agent.js');

let pass = 0, fail = 0;

function test(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.error(`  ✗ ${label}  →  expected ${String(expected)}, got ${String(actual)}`);
    fail++;
  }
}

function accepts(text) {
  return TIME_PATTERN.test(text) && !TIME_REJECTION_RE.test(text);
}

console.log('\n── ACCEPTANCE: messages that SHOULD capture a callback time ──');

// The exact message from the live failure.
// Sent 2026-11-12 06:41 IL — "מחר" = November 13 at 12:00 Asia/Jerusalem.
// "למחר" contains "מחר" with Hebrew prepositional prefix ל — must still match.
test('כן אשמח למחר בשעה 12  [exact live message, Nov-12 06:41 → Nov 13 12:00 IL]',
  accepts('כן אשמח למחר בשעה 12'), true);

test('מחר בשעה 12',                   accepts('מחר בשעה 12'),              true);
test('למחר בשעה 15',                  accepts('למחר בשעה 15'),             true);
test('שעה 12',                        accepts('שעה 12'),                   true);
test('שעה 9',                         accepts('שעה 9'),                    true);
test('15:30',                         accepts('15:30'),                    true);
test('בשעה 15:30',                    accepts('בשעה 15:30'),               true);
test('10am',                          accepts('10am'),                     true);
test('9pm',                           accepts('9pm'),                      true);
test('ביום שני בעשר',                 accepts('ביום שני בעשר'),            true);
test('שני בבוקר',                     accepts('שני בבוקר'),                true);
test('יום שלישי',                     accepts('יום שלישי'),                true);
test('שישי',                          accepts('שישי'),                     true);
test('בבוקר',                         accepts('בבוקר'),                    true);
test('בערב',                          accepts('בערב'),                     true);
test('בצהריים',                       accepts('בצהריים'),                  true);
test('שישי אחה"צ',                    accepts('שישי אחה"צ'),               true);
test('אחרי עבודה',                    accepts('אחרי עבודה'),               true);
test('להיום בשעה 10',                 accepts('להיום בשעה 10'),            true);
test('monday',                        accepts('monday'),                   true);
test('friday morning',                accepts('friday morning'),           true);
test('לא, מחר ב12 מתאים  [comma breaks \\s+ in rejection]',
  accepts('לא, מחר ב12 מתאים'), true);

console.log('\n── REJECTION: messages that MUST NOT capture (negation) ──');

test('מחר לא מתאים',                  accepts('מחר לא מתאים'),             false);
test('מחר לא נוח לי',                 accepts('מחר לא נוח לי'),            false);
test('לא מחר',                        accepts('לא מחר'),                   false);
test('לא מחר בשום אופן',              accepts('לא מחר בשום אופן'),         false);
test('היום לא נוח',                   accepts('היום לא נוח'),              false);
test('לא היום',                       accepts('לא היום'),                  false);
test('לא מתאים מחר',                  accepts('לא מתאים מחר'),             false);
test('לא נוח מחר',                    accepts('לא נוח מחר'),               false);

console.log('\n── BOUNDARY: patterns must NOT create false positives ──');

test('מחרתיים not matched via מחר',   TIME_PATTERN.test('מחרתיים'),        false);
test('שניים not matched via שני',     TIME_PATTERN.test('שניים'),          false);
test('שחרית not matched',             TIME_PATTERN.test('שחרית'),          false);
test('מחרתיים לא מתאים not captured', accepts('מחרתיים לא מתאים'),        false);

const section1Fail = fail;
console.log(`\n── Section 1 results: PASS=${pass}  FAIL=${fail} ──`);

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Full callback flow
// ══════════════════════════════════════════════════════════════════════════════

let APP_PORT  = 20090;
let MOCK_PORT = 20091;
const TEST_LEAD = '972509970099';
const REJ_LEAD  = '972509970088';

// Find a free TCP port starting from `base`
async function freePort(base) {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(base, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', () => freePort(base + 1).then(resolve));
  });
}

let serverProc, mockServer;
let flowPass = 0, flowFail = 0;

function flowTest(label, actual, expected) {
  const eq = actual === expected;
  if (eq) { console.log(`  ✓ ${label}`); flowPass++; }
  else {
    console.error(`  ✗ ${label}  →  expected ${String(expected)}, got ${String(actual)}`);
    flowFail++;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function get(url) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${APP_PORT}${url}`, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    }).on('error', reject);
  });
}

async function req(method, url, data) {
  const body = data ? JSON.stringify(data) : '';
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: 'localhost', port: APP_PORT, path: url, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const post  = (url, data) => req('POST', url, data);
const del   = (url)       => req('DELETE', url, {});

async function simulate(text, phone = TEST_LEAD) {
  return post('/api/whatsapp/simulate', { from: phone, name: 'Test', text });
}

async function setQual(phone, qualData) {
  return post(`/api/leads/${encodeURIComponent(phone)}/set-qual`, qualData);
}

// /api/test/lead/:phone returns unmasked lead data (TEST_MODE only)
async function getLead(phone = TEST_LEAD) {
  const res = await get(`/api/test/lead/${encodeURIComponent(phone)}`);
  return res?.ok ? res.lead : null;
}

// /api/test/events?phone=... returns events for a phone (TEST_MODE only)
async function getEvents(phone = TEST_LEAD) {
  const res = await get(`/api/test/events?phone=${encodeURIComponent(phone)}`);
  return Array.isArray(res?.events) ? res.events : [];
}

function startMockServer() {
  return new Promise(resolve => {
    mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url.includes('/arbox') ? { data: [] } : { idMessage: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }));
      });
    });
    mockServer.listen(MOCK_PORT, resolve);
  });
}

function startAppServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT:                     String(APP_PORT),
        TEST_MODE:                'true',
        GREEN_API_URL:            `localhost:${MOCK_PORT}`,
        GREEN_API_ID_INSTANCE:    '9999999999',
        GREEN_API_TOKEN_INSTANCE: 'mock-token-flow',
        ARBOX_BASE_URL:           `http://localhost:${MOCK_PORT}/arbox`,
        ARBOX_API_KEY:            'mock-arbox',
        // 972000000099 is a demo phone — alertOwner calls are intercepted, not sent
        STUDIO_OWNER_PHONE:       '972000000099',
        NOTIFY_PHONES:            '972000000099',
        OPENAI_API_KEY:           process.env.OPENAI_API_KEY ?? 'sk-test',
        // Isolated: the runner (tests/run_mjs_tests.mjs) supplies a fresh temporary DATA_DIR.
        DATA_DIR:                 ISOLATED_DATA_DIR,
        NODE_ENV:                 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.on('error', reject);

    let resolved = false;
    // Wait for startupComplete=true (persist.loadLeads + initWorkers done).
    // Without this, store/reset could run before persist.loadLeads, then
    // _storeReadyPromise holds the first webhook until loadLeads fires — which
    // reloads old state into the already-reset store.
    const poll = setInterval(async () => {
      try {
        const h = await get('/health');
        if (!resolved && h?.startupComplete === true) {
          resolved = true; clearInterval(poll); resolve();
        }
      } catch {}
    }, 300);
    setTimeout(() => {
      if (!resolved) { resolved = true; clearInterval(poll); resolve(); }
    }, 20_000);
  });
}

console.log('\n── Section 2 — Full callback flow ──');

try {
  // Find free ports before starting anything
  MOCK_PORT = await freePort(20091);
  APP_PORT  = await freePort(20094);
  console.log(`  [info] Using ports: app=${APP_PORT}, mock=${MOCK_PORT}`);

  await startMockServer();
  await startAppServer();
  await sleep(400);

  // ── Clean slate ──────────────────────────────────────────────────────────
  await post('/api/store/reset', {});
  await sleep(100);

  // ── 2a. Register lead and set callProposed=true ───────────────────────────
  // "מחפשת פילאטיס" contains "פילאטיס" which matches SALES_INTENT_RE in
  // the router → goes directly to Barak, bypassing the unclassified hold.
  const sim1 = await simulate('מחפשת פילאטיס מחדרה');
  await sleep(300);

  // Clear the reply-cooldown so sim2 is not suppressed as a "brief ack".
  // The simulate pipeline has a 10s cooldown between bot replies to the same phone;
  // sim1 and sim2 would otherwise be within that window.
  await del('/api/test/cooldowns');

  // Set callProposed=true via test endpoint (avoids depending on AI output)
  const qualPatch = await setQual(TEST_LEAD, { callProposed: true });
  flowTest('set-qual endpoint returns ok=true', qualPatch?.ok, true);
  flowTest('callProposed written to qualData',  qualPatch?.qualData?.callProposed, true);

  const lead0 = await getLead();
  flowTest('Lead exists after first message + set-qual',
    lead0 !== null, true);

  // ── 2b. Send the exact live failure message ───────────────────────────────
  const sim2 = await simulate('כן אשמח למחר בשעה 12');
  await sleep(500);


  const lead = await getLead();
  const qd   = lead?.meta?.qualData ?? {};

  flowTest('callTimeGiven saved after acceptance message',
    typeof qd.callTimeGiven, 'string');

  flowTest('callTimeGiven contains "מחר" (verbatim text captured)',
    String(qd.callTimeGiven).includes('מחר'), true);

  flowTest('callTimeGivenAt timestamp stored',
    typeof qd.callTimeGivenAt, 'string');

  flowTest('callTimeGivenAt is a valid ISO date',
    !isNaN(new Date(qd.callTimeGivenAt ?? '').getTime()), true);

  // callTimeGivenAt should be recent — anchors parseHebrewTime to message time
  const capturedMs = new Date(qd.callTimeGivenAt ?? 0).getTime();
  flowTest('callTimeGivenAt is within 15s of test run',
    Math.abs(Date.now() - capturedMs) < 15_000, true);

  flowTest('status = callback_requested',
    lead?.status, 'callback_requested');

  flowTest('meta.callbackTime matches callTimeGiven',
    lead?.meta?.callbackTime, qd.callTimeGiven);

  flowTest('meta.callbackRequestedAt stored',
    typeof lead?.meta?.callbackRequestedAt, 'string');

  flowTest('confirmedName not set (name not given in acceptance message)',
    qd.confirmedName ?? null, null);

  // ── 2c. Event log ─────────────────────────────────────────────────────────
  const events     = await getEvents(TEST_LEAD);
  const captureEvt = events.find(e => e.type === 'call_time_captured');
  flowTest('call_time_captured event in log',
    captureEvt != null, true);

  // ── 2d. Handoff alert ─────────────────────────────────────────────────────
  // With the notification-consolidation fix (3a35b0c), the manager summary is
  // deferred until the name is known. So at time-only stage the status is
  // 'deferred_pending_name'. After name capture it becomes 'sent' or 'failed'.
  const alertStatus = lead?.meta?.handoffAlertStatus;
  flowTest('handoffAlert status set after time given (deferred or sent/failed)',
    alertStatus === 'deferred_pending_name' || alertStatus === 'sent' || alertStatus === 'failed', true);

  // ── 2e. Persistence: leads_persist.json updated ───────────────────────────
  // Flush immediately via test endpoint (periodic save runs every 60s — too slow for tests)
  await post('/api/test/flush', {});
  const persistPath = path.join(__dirname, '../data/leads_persist.json');
  let persisted = false;
  try {
    const raw       = readFileSync(persistPath, 'utf8');
    const data      = JSON.parse(raw);
    const leads     = data?.leads ?? [];
    const persEntry = Array.isArray(leads)
      ? leads.find(([phone]) => phone === TEST_LEAD)?.[1]
      : null;
    persisted = persEntry?.meta?.qualData?.callTimeGiven?.includes('מחר') === true;
  } catch {}
  flowTest('callTimeGiven persisted to leads_persist.json after flush',
    persisted, true);

  // ── 2f. REJECTION GUARD ───────────────────────────────────────────────────
  // "מחר לא מתאים" must NOT set callTimeGiven even though TIME_PATTERN matches.
  await del('/api/test/cooldowns');  // clear cooldown for rejection lead
  await simulate('מחפשת פילאטיס', REJ_LEAD);
  await sleep(200);
  await setQual(REJ_LEAD, { callProposed: true });
  await simulate('מחר לא מתאים', REJ_LEAD);
  await sleep(300);

  const rejLead = await getLead(REJ_LEAD);
  const rqd     = rejLead?.meta?.qualData ?? {};
  flowTest('"מחר לא מתאים" does NOT set callTimeGiven',
    rqd.callTimeGiven ?? null, null);
  flowTest('"מחר לא מתאים" does NOT set status=callback_requested',
    rejLead?.status !== 'callback_requested', true);

  const rejEvents = await getEvents(REJ_LEAD);
  flowTest('"מחר לא מתאים" does NOT create call_time_captured event',
    rejEvents.some(e => e.type === 'call_time_captured'), false);

  // ── 2g. DUPLICATE DELIVERY ────────────────────────────────────────────────
  // Send the same acceptance message a second time. reliableHandoffAlert has
  // an idempotency gate: if handoffCallTime === callTimeGiven, skip.
  const sentAtBefore = lead?.meta?.handoffAlertSentAt;
  await simulate('כן אשמח למחר בשעה 12');  // duplicate of 2b
  await sleep(400);
  const afterDup    = await getLead();
  const sentAtAfter = afterDup?.meta?.handoffAlertSentAt;
  flowTest('Duplicate acceptance message: handoffAlertSentAt unchanged (idempotent)',
    sentAtBefore, sentAtAfter);

  // ── 2h. NAME COLLECTION after callTimeGiven ───────────────────────────────
  // After callTimeGiven is set without a name, the AI asks for the name (new behavior).
  // We ensure nameAsked=true via set-qual, then send the name.
  // Clear cooldown — a reply was just sent in the duplicate-ack test.
  await del('/api/test/cooldowns');
  await setQual(TEST_LEAD, { nameAsked: true });
  await simulate('שרה');
  await sleep(500);
  const withName = await getLead();
  const wqd      = withName?.meta?.qualData ?? {};
  flowTest('Name "שרה" confirmed after giving name post-callTimeGiven',
    wqd.confirmedName === 'שרה' || (typeof wqd.confirmedName === 'string' && wqd.confirmedName.length >= 2), true);

} catch (err) {
  console.error(`\n  [FATAL] ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(0,5).join('\n'));
  flowFail++;
} finally {
  try { serverProc?.kill(); } catch {}
  try { mockServer?.close(); } catch {}
}

const section2Fail = flowFail;
console.log(`\n── Section 2 results: PASS=${flowPass}  FAIL=${flowFail} ──`);

// ══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════════════════════════════════

const totalFail = section1Fail + section2Fail;
const totalPass = pass + flowPass;
console.log(`\n─────────────────────────────────────────────────────────`);
console.log(`callback_time.test.mjs: PASS=${totalPass}  FAIL=${totalFail}`);
if (totalFail > 0) process.exit(1);
