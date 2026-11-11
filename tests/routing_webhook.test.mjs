/**
 * routing_webhook.test.mjs — Isolated behavioral tests for:
 *   1. "מה קורה" scheduling misclassification fix
 *   2. Burst batching via actual Green API webhook path
 *   3. Human takeover via outgoing webhook (bot echo vs staff reply)
 *   4. Deferred reconciliation: hold during in-flight bot send
 *   5. Human_owns blocks pending automated sends
 *   6. Tomer member-by-id endpoint
 *
 * Uses:
 *   - Isolated DATA_DIR (tmpdir, never touches production data)
 *   - Mock Green API + Arbox server (HTTP, records sends, returns MOCK-* ids)
 *   - Real server.js on a test port
 *   - No real OpenAI calls (no key set — bot fails fast on AI, still exercises routing)
 *   - lead_store singleton accessed directly for status checks (no masked-phone issue)
 *
 * Source-level checks are labelled (SRC) to distinguish from behavioral tests.
 *
 * Run: node tests/routing_webhook.test.mjs
 */

import http   from 'http';
import os     from 'os';
import path   from 'path';
import fs     from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ── Isolated DATA_DIR ─────────────────────────────────────────────────────────
const TEST_DATA_DIR = path.join(os.tmpdir(), `rw-test-${process.pid}`);
process.env.DATA_DIR = TEST_DATA_DIR;
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

// ── Ports ─────────────────────────────────────────────────────────────────────
const MOCK_PORT = 20061;
const APP_PORT  = 20060;

// ── Mock server state ─────────────────────────────────────────────────────────
const _sends     = [];    // { to, text, idMessage }
let _gaDelay     = 0;     // artificial sendMessage delay (ms)
let _gaNextId    = null;  // override next idMessage if set
let _gaErrorMode = false; // when true, sendMessage returns 500 (simulates failed/timed-out send)

// ── Canned Arbox member (used by Suite 6) ─────────────────────────────────────
const MOCK_MEMBER = {
  user_id: 42, first_name: 'Test', last_name: 'Member',
  phone: '972509960001', active: true,
  membership_start_date: '2026-01-01', membership_end_date: '2027-01-01',
  allow_sms: true, allow_email: true,
};

// ── Mock Green API + Arbox ────────────────────────────────────────────────────
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let parsed = {}; try { parsed = JSON.parse(body); } catch {}

    if (req.url.includes('sendMessage')) {
      if (_gaErrorMode) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock provider error — _gaErrorMode=true' }));
        return;
      }
      const to    = parsed.chatId?.replace('@c.us', '') ?? '';
      const idMsg = _gaNextId ?? `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      _gaNextId   = null;
      const delay = _gaDelay;
      const respond = () => {
        _sends.push({ to, text: parsed.message ?? '', idMessage: idMsg });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ idMessage: idMsg }));
      };
      if (delay > 0) setTimeout(respond, delay);
      else           respond();
      return;
    }
    if (req.url.includes('getStateInstance')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateInstance: 'authorized' }));
      return;
    }
    if (req.url.includes('/v3/users')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [MOCK_MEMBER] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
});
await new Promise(r => mockServer.listen(MOCK_PORT, r));

// ── Env setup (before server.js import) ──────────────────────────────────────
process.env.GREEN_API_URL            = `localhost:${MOCK_PORT}`;
process.env.GREEN_API_ID_INSTANCE    = '9999999998';
process.env.GREEN_API_TOKEN_INSTANCE = 'mock-token-rw';
process.env.WHATSAPP_AUTO_REPLY      = 'true';
process.env.TEST_MODE                = 'true';
process.env.PORT                     = String(APP_PORT);
process.env.ARBOX_BASE_URL           = `http://localhost:${MOCK_PORT}/arbox`;
process.env.BURST_WINDOW_MS          = '300';   // fast burst for tests
delete process.env.OPENAI_API_KEY;              // no real AI calls
process.env.TEST_AI_DELAY_MS         = '400';   // simulate generation latency for race tests
process.env.TEST_PENDING_SEND_TTL_MS = '100';   // shorten 3s TTL so unresolved tests run fast
process.env.TEST_UNRESOLVED_GRACE_MS = '1500';  // shorten 5s grace to 1.5s

process.env.TEST_ALLOWLIST_PHONES = [
  '972509960001','972509960002','972509960003','972509960004',
  '972509960005','972509960006','972509960007','972509960008',
  '972509960009','972509960010',
  '972509960011','972509960012','972509960013',
  '972509960014','972509960015','972509960016',
].join(',');

// ── Helpers ───────────────────────────────────────────────────────────────────
const passed = [], failed = [];
function assert(ok, label, detail = '') {
  if (ok) { passed.push(label); console.log(`  ✓ ${label}`); }
  else     { failed.push(label); console.error(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`); }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

const BASE = `http://localhost:${APP_PORT}`;

async function post(urlPath, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, { method: 'GET' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject); req.end();
  });
}

/** Fire Green API inbound message webhook. Returns 200 immediately (async processing). */
async function inboundWebhook(phone, text, msgId) {
  const id = msgId ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  return post('/api/green-api/webhook', {
    typeWebhook: 'incomingMessageReceived',
    senderData:  { chatId: `${phone}@c.us`, senderName: 'Test' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
    idMessage: id, timestamp: Math.floor(Date.now() / 1000),
  });
}

/** Fire Green API outgoing message echo webhook. */
async function outgoingWebhook(phone, idMessage, text = '') {
  return post('/api/green-api/webhook', {
    typeWebhook: 'outgoingMessageReceived',
    senderData:  { chatId: `${phone}@c.us` },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
    idMessage,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function clearSends() { _sends.length = 0; }
function sendsFor(phone) { return _sends.filter(s => s.to === phone); }

/** Poll with timeout until async predicate returns true. */
async function pollUntil(predicate, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(intervalMs);
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 0: Source-level checks (SRC — no server needed)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 0: Source-level assertions (SRC) ──');
{
  const src     = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const arboxSrc = fs.readFileSync(path.join(__dirname, '../services/arbox.service.js'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(__dirname, '../public/tomer-panel.js'), 'utf8');

  // Fix 1: "מה קורה" removed from schedule_query
  const scheduleQueryLine = src.match(/schedule_query:\s+\/[^\n]+/)?.[0] ?? '';
  assert(!scheduleQueryLine.includes('מה קורה'), '(SRC) "מה קורה" absent from schedule_query regex', scheduleQueryLine.slice(0, 80));

  // Fix 2: Deferred reconciliation — re-defer loop + unresolved grace period
  assert(src.includes('OUTGOING_RECONCILE_MS'), '(SRC) OUTGOING_RECONCILE_MS constant defined');
  assert(src.includes('_applyStaffTakeover'), '(SRC) _applyStaffTakeover helper defined');
  assert(src.includes('_scheduleEchoReconcile'), '(SRC) _scheduleEchoReconcile re-defer function defined');
  assert(src.includes('_unresolvedEchoes'), '(SRC) _unresolvedEchoes map defined');
  assert(src.includes('_hasUnresolvedEcho'), '(SRC) _hasUnresolvedEcho helper defined');
  assert(src.includes('UNRESOLVED_GRACE_MS'), '(SRC) UNRESOLVED_GRACE_MS grace period defined');
  assert(src.includes('echo_attribution_hold'), "(SRC) 'echo_attribution_hold' pipeline gate present");
  assert(src.includes('_applyAttributionReview'), '(SRC) _applyAttributionReview defined — grace expiry does not set human_owns');
  assert(src.includes('attribution_review'), "(SRC) 'attribution_review' status referenced — explicit review state");
  const outgoingPos   = src.indexOf("rawType === 'outgoingMessageReceived'");
  const outgoingBlock = outgoingPos >= 0 ? src.slice(outgoingPos, outgoingPos + 2000) : '';
  assert(
    outgoingBlock.includes('_scheduleEchoReconcile'),
    '(SRC) _scheduleEchoReconcile called in outgoing handler',
    outgoingBlock.slice(0, 80)
  );

  // Fix 2: stale gate present
  const stalePos   = src.indexOf('LATE REPLY SUPPRESSION');
  const staleBlock = stalePos >= 0 ? src.slice(stalePos, stalePos + 3000) : '';
  assert(stalePos > 0, '(SRC) LATE REPLY SUPPRESSION block present');
  assert(staleBlock.includes('_pendingMessages'), '(SRC) stale gate checks _pendingMessages');
  assert(staleBlock.includes('reply_suppressed_stale'), "(SRC) stale event 'reply_suppressed_stale' present");

  // Fix 3: getMemberById in arbox.service.js
  assert(arboxSrc.includes('async function getMemberById'), '(SRC) getMemberById defined in arbox.service.js');
  assert(arboxSrc.includes('getMemberById,'), '(SRC) getMemberById exported from arbox.service.js');

  // Fix 4: /api/tomer/member/id/:arboxId endpoint present
  assert(src.includes('/api/tomer/member/id/:arboxId'), '(SRC) /api/tomer/member/id/:arboxId endpoint defined');

  // Fix 5: openMemberByArboxId uses new endpoint, _arboxIdToPhone removed
  assert(panelSrc.includes('/api/tomer/member/id/'), '(SRC) tomer-panel.js calls /api/tomer/member/id/');
  assert(!panelSrc.includes('_arboxIdToPhone'), '(SRC) _arboxIdToPhone map removed from tomer-panel.js');
}

// ════════════════════════════════════════════════════════════════════════════
//  Boot server
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Starting server on port', APP_PORT, '──');
await import('../server.js');
await wait(700);
// Access lead_store singleton (same instance the server uses — module cache)
const store = require('../utils/lead_store');
console.log('  Server ready');

// ════════════════════════════════════════════════════════════════════════════
//  Suite 1: Burst batching via actual Green API webhook
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 1: Burst batching via /api/green-api/webhook ──');
{
  const ph = '972509960002';
  clearSends();

  // Send 3 messages rapidly (within BURST_WINDOW_MS=300ms)
  await inboundWebhook(ph, 'שלום',              `burst-1-${Date.now()}`);
  await inboundWebhook(ph, 'אני מחפש פילאטיס', `burst-2-${Date.now()}`);
  await inboundWebhook(ph, 'בחדרה',             `burst-3-${Date.now()}`);

  // Poll inbox until the burst entry appears (or 6s timeout)
  const appeared = await pollUntil(async () => {
    const r = await get('/api/whatsapp/inbox?limit=20');
    const entries = (r.body?.messages ?? []).filter(m => m.from === ph);
    return entries.length >= 1;
  }, 6000, 200);

  const inboxR  = await get('/api/whatsapp/inbox?limit=20');
  const entries = (inboxR.body?.messages ?? []).filter(m => m.from === ph);

  assert(appeared, '1a: burst inbox entry appeared within 6s');
  assert(entries.length === 1, '1b: exactly 1 inbox entry for 3 rapid messages', entries.length);
  if (entries.length > 0) {
    const txt = entries[0].text ?? '';
    assert(txt.includes('שלום'),     '1c: combined text has first message',  txt.slice(0, 80));
    assert(txt.includes('פילאטיס'),  '1d: combined text has second message', txt.slice(0, 80));
    assert(txt.includes('בחדרה'),    '1e: combined text has third message',  txt.slice(0, 80));
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 2: Burst — exactly one automated send for the combined burst
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 2: Burst — exactly 1 send for 3-message burst ──');
{
  const ph = '972509960002'; // same phone as Suite 1
  // Wait for burst+AI pipeline to complete (burst 300ms + TEST_AI_DELAY_MS 400ms + buffer)
  await wait(2000);
  const sentCount = sendsFor(ph).length;
  // The 3-message burst produces exactly 1 combined reply — not 3 separate sends.
  assert(sentCount === 1, '2a: exactly 1 send for 3-message burst', sentCount);
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 2b: Stale gate — newer inbound during generation suppresses outdated reply
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 2b: Stale gate — newer inbound during AI generation ──');
{
  const ph = '972509960013';
  clearSends();

  // M1: sales-intent message → general intent → Barak → lead_agent → TEST_AI_DELAY_MS (400ms)
  // Using plain greeting + pilates interest so intent stays 'general' (no scheduling path).
  await inboundWebhook(ph, 'שלום, מחפשת פילאטיס, מחדרה', `stale-m1-${Date.now()}`);

  // Wait past burst window (300ms) and 100ms into the AI delay, then send M2.
  // _processingLock is held during the pipeline → M2 queues in _pendingMessages.
  await wait(400);
  await inboundWebhook(ph, 'שלום שוב', `stale-m2-${Date.now()}`);

  // Wait for the stale gate event (M1 pipeline: burst 300ms + identity + AI delay ~1200ms).
  const staleAppeared = await pollUntil(
    () => store.getEvents({ type: 'reply_suppressed_stale', phone: ph }).length >= 1,
    8000, 300,
  );
  // Stale gate fires inside lead_agent (pendingMap.has(from) → skipped_stale).
  assert(staleAppeared, '2b: stale gate event logged — M1 reply suppressed by M2');

  // Wait for M2 pipeline to complete and send its reply (another identity + AI delay ~1200ms).
  const m2Sent = await pollUntil(() => sendsFor(ph).length >= 1, 8000, 300);
  assert(m2Sent,              '2c: M2 reply sent after stale suppression', sendsFor(ph).length);
  assert(sendsFor(ph).length === 1, '2d: exactly 1 send total (M1 suppressed, M2 only)', sendsFor(ph).length);
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 3: Outgoing webhook — bot echo vs staff reply
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 3: Outgoing webhook — bot echo vs staff reply ──');

// 3a: Known bot idMessage → NOT human_owns
{
  const ph = '972509960003';
  clearSends();

  // Trigger a bot send via simulate to populate _botSentIds with a real MOCK-* id
  await post('/api/whatsapp/simulate', { from: ph, text: 'מה השעות שלכם?' });
  await wait(500); // let pipeline complete and _recordBotSend fire

  const botSends = sendsFor(ph);
  const botId    = botSends.length > 0 ? botSends[0].idMessage : `MOCK-KNOWN-${Date.now()}`;

  // Post the echo with the bot's idMessage (confirmed bot send)
  await outgoingWebhook(ph, botId, 'bot reply');
  await wait(300);

  const status = store.getLead(ph)?.status ?? null;
  assert(status !== 'human_owns', '3a: known bot idMessage echo → NOT human_owns', status ?? '(no lead)');
}

// 3b: Unknown idMessage (no pending send) → human_owns
{
  const ph     = '972509960004';
  const staffId = `STAFF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // No bot send has occurred for this phone → _hasPendingBotSend = false
  await outgoingWebhook(ph, staffId, 'סגור את השיעור');
  await wait(300); // setImmediate in webhook handler fires quickly

  const status = store.getLead(ph)?.status ?? null;
  assert(status === 'human_owns', '3b: unknown idMessage (no pending send) → human_owns', status ?? '(no lead)');
}

// 3c: human_owns is idempotent — second unknown echo doesn't corrupt state
{
  const ph  = '972509960005';
  const id1 = `STAFF-C1-${Date.now()}`;
  const id2 = `STAFF-C2-${Date.now() + 1}`;
  await outgoingWebhook(ph, id1, 'ראשון');
  await wait(200);
  await outgoingWebhook(ph, id2, 'שני');
  await wait(200);
  const status = store.getLead(ph)?.status ?? null;
  assert(status === 'human_owns', '3c: second staff echo after human_owns → still human_owns', status ?? '(no lead)');
}

// 3d: opted_out preserved — outgoing echo on opted_out phone must not change status
{
  const ph = '972509960006';
  store.upsertLead(ph, { name: 'Opted Out', status: 'opted_out' });
  await outgoingWebhook(ph, `STAFF-D-${Date.now()}`, 'ביטול');
  await wait(300);
  const status = store.getLead(ph)?.status ?? null;
  assert(status === 'opted_out', '3d: opted_out preserved — outgoing echo does not override', status);
  store.deleteLead(ph);
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 4: Sales-path race + deferred reconciliation with real IDs
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 4: Sales-path race + deferred reconciliation ──');

// 4a: Staff takeover via API during Barak AI generation → human_owns preserved after
//     pipeline finishes. No bot send is delivered after takeover.
//
// Tests the race fixed in lead_agent: score/status write after generation must not
// overwrite human_owns, and the pre-send status check suppresses the reply.
{
  const ph = '972509960007';
  clearSends();
  store.deleteLead(ph); // remove any human_owns left from previous runs

  // Message with explicit sales intent → routes to Barak (lead_agent), not unclassified.
  await inboundWebhook(ph, 'אני מחפשת פילאטיס, מחדרה', `race-4a-${Date.now()}`);

  // Wait past burst window (300ms) and 100ms into TEST_AI_DELAY_MS (400ms).
  // Pipeline is now inside lead_agent awaiting the simulated generation delay.
  await wait(400);

  // Set human_owns via the API — concurrent with AI generation.
  const tRes = await fetch(`${BASE}/api/leads/${encodeURIComponent(ph)}/takeover`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'staff_during_generation_test', staffName: 'TestStaff' }),
  });
  assert(tRes.ok, '4a-setup: takeover API during generation → 2xx', tRes.status);

  // Wait for pipeline to finish (remaining ~300ms AI delay + processing + burst buffer).
  await wait(1200);

  const status4a = store.getLead(ph)?.status ?? null;
  assert(status4a === 'human_owns', '4a: human_owns preserved after pipeline — not overwritten by score write', status4a ?? '(no lead)');
  assert(sendsFor(ph).length === 0,  '4a: no bot send after human_owns set during generation', sendsFor(ph).length);
}

// 4b: Genuine bot echo with ordinary provider-style ID where the provider response
//     is SLOWER than the reconciliation window (1000ms > OUTGOING_RECONCILE_MS 300ms).
//
// The re-defer loop in _scheduleEchoReconcile keeps extending the window while
// _hasPendingBotSend is true. Once the provider responds and _recordBotSend fires,
// the next deferred iteration sees _isBotSentId → true and exits without takeover.
{
  const ph        = '972509960011'; // fresh phone → unclassified path (_markBotSent called)
  const botId4b   = `realbot-${Date.now()}-4b`;
  _gaNextId       = botId4b;
  _gaDelay        = 1000; // > OUTGOING_RECONCILE_MS (300ms) — tests re-defer path
  clearSends();
  store.deleteLead(ph);

  // Unclassified path: _markBotSent → sendText(delayed 1000ms) → _recordBotSend(botId4b)
  await inboundWebhook(ph, 'שלום רב', `deferred-4b-${Date.now()}`);

  // Wait for burst (300ms) + ~80ms pipeline start → sendText is now in-flight.
  await wait(380);

  // Echo with the SAME id arrives while the 1000ms GA delay is still running.
  // _hasPendingBotSend → true → _scheduleEchoReconcile called.
  // Loop fires at 300ms intervals; GA responds at ~1000ms after burst fires (~1300ms total).
  // After GA responds, the next loop iteration sees _isBotSentId(botId4b) → true → skip.
  await outgoingWebhook(ph, botId4b, 'bot message');

  // Wait long enough for: GA response (~1300ms from t=0) + one more reconcile tick (300ms).
  await wait(2000);

  const status4b = store.getLead(ph)?.status ?? null;
  assert(status4b !== 'human_owns', '4b: bot echo with slow provider — NOT human_owns after re-deferred reconciliation', status4b ?? '(no lead)');
  _gaDelay  = 0;
  _gaNextId = null;
}

// 4c: Genuine staff message echo with ordinary ID during the same 1000ms provider delay.
//     Staff ID is never in _botSentIds; re-defer loop finds no pending send once the
//     provider responds → _applyStaffTakeover → human_owns. Verify it persists after
//     the unclassified pipeline finishes (no subsequent status overwrite).
{
  const ph        = '972509960012'; // fresh phone → unclassified path
  const botId4c   = `realbot-${Date.now()}-4c`;
  const staffId4c = `staffmsg-${Date.now()}-4c`;
  _gaNextId       = botId4c;
  _gaDelay        = 1000;
  clearSends();
  store.deleteLead(ph);

  await inboundWebhook(ph, 'שלום רב', `deferred-4c-${Date.now()}`);
  await wait(380); // burst fires, sendText in-flight

  // Staff echo: DIFFERENT id from what the bot sends.
  // Re-defer loop runs until provider responds at ~1300ms, then
  // _hasPendingBotSend → false (cleared by _recordBotSend) → _applyStaffTakeover.
  await outgoingWebhook(ph, staffId4c, 'אני אטפל בזה — staff');

  // Wait for: GA response (~1300ms) + reconcile tick (300ms) + settle.
  await wait(2000);

  const status4c = store.getLead(ph)?.status ?? null;
  // Grace expiry is not proof of staff authorship — status must be attribution_review,
  // not human_owns. Staff confirms ownership via the takeover API.
  assert(status4c === 'attribution_review', '4c: genuine staff echo → attribution_review after grace (not human_owns — elapsed time alone is not proof)', status4c ?? '(no lead)');
  _gaDelay  = 0;
  _gaNextId = null;
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 4d: Provider delay > PENDING_SEND_TTL — bot echo must NOT set human_owns
//            and new automated sends must be held during the grace period.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 4d: Bot echo with provider delay > PENDING_SEND_TTL ──');
{
  const ph      = '972509960014'; // fresh phone → unclassified path
  const botId4d = `realbot-${Date.now()}-4d`;
  _gaNextId     = botId4d;
  _gaDelay      = 1000; // > PENDING_SEND_TTL (100ms in test) — forces unresolved state
  clearSends();
  store.deleteLead(ph);

  // Unclassified path fires: _markBotSent → sendText(1000ms delay) → eventually _recordBotSend.
  await inboundWebhook(ph, 'שלום רב', `deferred-4d-${Date.now()}`);
  await wait(380); // burst fires, sendText in-flight but TTL (100ms) has already expired

  // Bot echo arrives — cannot be confirmed yet (_hasPendingBotSend false, _botSentIds miss).
  // _scheduleEchoReconcile enters unresolved grace period (1500ms), does NOT call _applyStaffTakeover.
  await outgoingWebhook(ph, botId4d, 'bot message');

  // Wait for first deferred tick (300ms) to fire, entering unresolved state.
  await wait(400);

  // Verify: a new inbound during unresolved state is held (no AI, no reply).
  const holdRes = await post('/api/whatsapp/simulate', { from: ph, text: 'שאלה נוספת' });
  assert(holdRes.body?.route === 'echo_attribution_hold', '4d-hold: new inbound held during unresolved attribution', holdRes.body?.route);

  // Verify: unresolved event was logged.
  const unresolvedEvts = store.getEvents({ type: 'echo_attribution_unresolved', phone: ph });
  assert(unresolvedEvts.length >= 1, '4d-unresolved: echo_attribution_unresolved event logged', unresolvedEvts.length);

  // Now wait for the provider to respond (1000ms after burst ~300ms = ~1300ms total),
  // then one more reconcile tick (300ms) + settle.
  await wait(1200);

  // _recordBotSend fired → cleared unresolved → echo_attributed_to_bot event present.
  const botEvts = store.getEvents({ type: 'echo_attributed_to_bot', phone: ph });
  assert(botEvts.length >= 1, '4d: echo_attributed_to_bot event — late _recordBotSend cleared unresolved', botEvts.length);
  assert(store.getLead(ph)?.status !== 'human_owns', '4d: bot echo with slow provider — NOT human_owns', store.getLead(ph)?.status ?? '(no lead)');
  _gaDelay  = 0;
  _gaNextId = null;
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 4e: Failed/timed-out bot send + genuine staff echo.
//            Unresolved state → grace period expires → human_owns.
//            TTL expiry alone does not prove staff; the grace period does.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 4e: Failed bot send + genuine staff echo → human_owns after grace ──');
{
  const ph        = '972509960015'; // fresh phone → unclassified path
  const staffId4e = `staffmsg-${Date.now()}-4e`;
  _gaErrorMode    = true;  // bot send fails → _recordBotSend never called
  clearSends();
  store.deleteLead(ph);

  // Unclassified path: _markBotSent → sendText → 500 error → null → _recordBotSend NOT called.
  // _pendingBotSends has entry until PENDING_SEND_TTL (100ms) expires.
  // _gaErrorMode stays true through the wait so the burst (300ms) fires while it's set.
  await inboundWebhook(ph, 'שלום רב', `deferred-4e-${Date.now()}`);
  await wait(380); // burst fires at ~300ms with _gaErrorMode=true → send fails → _pendingBotSends not cleared
  _gaErrorMode = false; // restore after pipeline has run

  // Genuine staff echo: DIFFERENT id (not what any bot sent).
  // _hasPendingBotSend false (TTL expired) → first deferred tick → unresolved → grace timer.
  await outgoingWebhook(ph, staffId4e, 'כן, אני אטפל — staff');

  // Wait for: first deferred tick (300ms) → unresolved state → grace expires (1500ms) → human_owns.
  // Total: 300 + 1500 + 200 buffer = 2000ms after the echo.
  await wait(2200);

  const status4e = store.getLead(ph)?.status ?? null;
  const unrEvts  = store.getEvents({ type: 'echo_attribution_unresolved', phone: ph });
  assert(unrEvts.length >= 1, '4e-unresolved: unresolved event logged (TTL expiry ≠ staff proof)', unrEvts.length);
  // Grace expiry does NOT auto-confirm staff authorship → attribution_review, not human_owns.
  // Staff uses the takeover API to confirm genuine ownership if needed.
  assert(status4e === 'attribution_review', '4e: failed send → attribution_review after grace (not human_owns)', status4e ?? '(no lead)');
  assert(status4e !== 'human_owns', '4e: elapsed time alone does not prove staff authorship', status4e);
  // No echo_attributed_to_bot event (send never confirmed).
  const botAttrEvts = store.getEvents({ type: 'echo_attributed_to_bot', phone: ph });
  assert(botAttrEvts.length === 0, '4e: no bot attribution when send failed', botAttrEvts.length);
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 4f: Bot echo delayed beyond BOTH PENDING_SEND_TTL and UNRESOLVED_GRACE_MS.
//            Verify it is NEVER falsely labelled as a staff message.
//            Late _recordBotSend clears attribution_review and confirms bot.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 4f: Bot echo delayed beyond TTL + grace — never human_owns ──');
{
  const ph      = '972509960016'; // fresh phone → unclassified path
  const botId4f = `realbot-${Date.now()}-4f`;
  _gaNextId     = botId4f;
  // _gaDelay exceeds TTL (100ms) + grace (1500ms). The echo enters attribution_review
  // before the provider responds. When _recordBotSend finally fires it must clear review.
  _gaDelay      = 2500;
  clearSends();
  store.deleteLead(ph);

  await inboundWebhook(ph, 'שלום רב', `deferred-4f-${Date.now()}`);
  await wait(380); // burst fires, sendText in-flight but TTL already expired
  await outgoingWebhook(ph, botId4f, 'bot message');

  // Wait for attribution_review to be set (grace fires ~300ms after unresolved, 1500ms after that).
  // Unresolved at ~t=685ms; grace at ~t=2185ms.
  const reviewSet = await pollUntil(
    () => store.getLead(ph)?.status === 'attribution_review',
    6000, 300,
  );
  assert(reviewSet,                                '4f-review: attribution_review entered after grace expiry');
  assert(store.getLead(ph)?.status !== 'human_owns', '4f-not-human: grace expiry did NOT set human_owns');
  const reviewEvts = store.getEvents({ type: 'echo_attribution_review', phone: ph });
  assert(reviewEvts.length >= 1,                   '4f-review-event: echo_attribution_review event logged');

  // Now wait for the late _recordBotSend (burst 300ms + _gaDelay 2500ms = ~2800ms from t=0).
  // _recordBotSend clears _unresolvedEchoes and reverts attribution_review.
  const botCleared = await pollUntil(
    () => store.getEvents({ type: 'echo_attributed_to_bot', phone: ph }).length >= 1,
    6000, 300,
  );
  assert(botCleared,                                     '4f-cleared: late _recordBotSend cleared attribution_review');
  assert(store.getLead(ph)?.status !== 'human_owns',     '4f: NOT human_owns after late reconciliation');
  assert(store.getLead(ph)?.status !== 'attribution_review', '4f: attribution_review cleared by late bot confirmation');
  const botEvts4f = store.getEvents({ type: 'echo_attributed_to_bot', phone: ph });
  assert(botEvts4f.length >= 1,                          '4f: echo_attributed_to_bot event present');

  _gaDelay  = 0;
  _gaNextId = null;
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 5: human_owns blocks automated sends
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 5: human_owns blocks automated sends ──');
{
  const ph = '972509960009';
  store.upsertLead(ph, { name: 'Human Owner', status: 'human_owns' });
  clearSends();

  // Send a message that would normally trigger a bot reply
  await inboundWebhook(ph, 'מה המחירים?');
  await wait(500);

  assert(sendsFor(ph).length === 0, '5a: human_owns: zero bot sends when human_owns is active', sendsFor(ph).length);
  store.deleteLead(ph);
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 6: /api/tomer/member/id/:arboxId
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 6: /api/tomer/member/id/:arboxId ──');

// 6a: Known arboxId → 200 with phone resolved server-side
{
  const r = await get(`/api/tomer/member/id/${MOCK_MEMBER.user_id}`);
  assert(r.status === 200, '6a: status 200 for known arboxId', r.status);
  assert(r.body.ok === true, '6a: ok=true', r.body.ok);
  assert(r.body.phone === MOCK_MEMBER.phone, '6a: resolved phone matches Arbox member', r.body.phone);
  assert(r.body.arbox?.user_id === MOCK_MEMBER.user_id, '6a: arbox member data present', r.body.arbox?.user_id);
  assert(Array.isArray(r.body.tasks),   '6a: tasks array present');
  assert(Array.isArray(r.body.history), '6a: history array present');
  assert(String(r.body.arboxId) === String(MOCK_MEMBER.user_id), '6a: arboxId echoed in response', r.body.arboxId);
}

// 6b: Unknown arboxId → 404
{
  const r = await get('/api/tomer/member/id/999999999');
  assert(r.status === 404, '6b: 404 for unknown arboxId', r.status);
  assert(r.body.ok === false, '6b: ok=false for 404', r.body.ok);
}

// 6c: Does not conflict with /api/tomer/member/:phone
{
  const r = await get(`/api/tomer/member/${encodeURIComponent(MOCK_MEMBER.phone)}`);
  assert(r.status === 200, '6c: phone-based endpoint still works', r.status);
  assert(r.body.ok === true, '6c: ok=true for phone lookup', r.body.ok);
}

// ════════════════════════════════════════════════════════════════════════════
//  Suite 7: "מה קורה" intent fix via simulate
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 7: "מה קורה" scheduling fix ──');
{
  const ph = '972509960010';

  // "מה קורה" should NOT route as schedule_query
  const r1 = await post('/api/whatsapp/simulate', { from: ph, text: 'מה קורה' });
  assert(r1.status === 200, '7a: simulate OK for מה קורה', r1.status);
  if (r1.body?.intent !== undefined) {
    assert(r1.body.intent !== 'schedule_query', '7b: מה קורה not schedule_query', r1.body.intent);
  }

  // "מה קורה?" with question mark — same
  const r2 = await post('/api/whatsapp/simulate', { from: ph, text: 'מה קורה?' });
  if (r2.body?.intent !== undefined) {
    assert(r2.body.intent !== 'schedule_query', '7c: מה קורה? not schedule_query', r2.body.intent);
  }

  // Source check as well
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const scheduleLine = src.match(/schedule_query:\s+\/[^\n]+/)?.[0] ?? '';
  assert(!scheduleLine.includes('מה קורה'), '7d (SRC): מה קורה absent from schedule_query', scheduleLine.slice(0, 80));
}

// ════════════════════════════════════════════════════════════════════════════
//  Summary
// ════════════════════════════════════════════════════════════════════════════
console.log('\n─────────────────────────────────────────────────────────');
console.log(`routing_webhook.test.mjs: PASS=${passed.length}  FAIL=${failed.length}`);
if (failed.length > 0) {
  console.error('Failed:');
  failed.forEach(f => console.error('  ✗', f));
  mockServer.close();
  process.exit(1);
}
mockServer.close();
process.exit(0);
