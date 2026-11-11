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
const _sends   = [];      // { to, text, idMessage }
let _gaDelay   = 0;       // artificial sendMessage delay (ms)
let _gaNextId  = null;    // override next idMessage if set

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

process.env.TEST_ALLOWLIST_PHONES = [
  '972509960001','972509960002','972509960003','972509960004',
  '972509960005','972509960006','972509960007','972509960008',
  '972509960009','972509960010',
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

  // Fix 2: Deferred reconciliation in outgoing handler
  assert(src.includes('OUTGOING_RECONCILE_MS'), '(SRC) OUTGOING_RECONCILE_MS constant defined');
  assert(src.includes('_applyStaffTakeover'), '(SRC) _applyStaffTakeover helper defined');
  // Look for setTimeout+OUTGOING_RECONCILE_MS in the outgoingMessageReceived handler specifically
  const outgoingPos   = src.indexOf("rawType === 'outgoingMessageReceived'");
  const outgoingBlock = outgoingPos >= 0 ? src.slice(outgoingPos, outgoingPos + 2000) : '';
  assert(
    outgoingBlock.includes('setTimeout') && outgoingBlock.includes('OUTGOING_RECONCILE_MS'),
    '(SRC) deferred reconciliation setTimeout+OUTGOING_RECONCILE_MS in outgoing handler',
    outgoingBlock.slice(0, 60)
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
//  Suite 2: Consecutive messages — only one automated send
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 2: Burst — single send for burst window ──');
{
  const ph = '972509960002'; // same phone as Suite 1
  // Poll until at least 1 send has arrived for this phone (or no send if AI fails)
  await wait(2000); // give AI time to fail and pipeline to complete
  const sentCount = sendsFor(ph).length;
  // With no OpenAI key the bot may still send a fallback or nothing.
  // What matters: not 3 separate sends (one per message).
  assert(sentCount <= 1, '2a: at most 1 send for 3-message burst (not 3 separate sends)', sentCount);
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
//  Suite 4: Deferred reconciliation — in-flight bot send
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 4: Deferred reconciliation ──');

// 4a: Staff reply echo during in-flight bot send → human_owns after reconciliation window.
//
// Setup: use a text that triggers the UNCLASSIFIED path (new phone, no sales intent).
// The unclassified path calls _markBotSent BEFORE await sendText, so the HTTP call
// is in-flight when our echo arrives. The pipeline then returns WITHOUT any further
// store.upsertLead({ status }) call, so human_owns is not overwritten.
{
  const ph = '972509960007';
  clearSends();

  _gaDelay = 500; // slow mock GA → bot HTTP in-flight during echo

  // Trigger unclassified greeting via inbound webhook (goes through burst accumulator)
  // "שלום רב" has no sales intent → unclassified path → _markBotSent called
  await inboundWebhook(ph, 'שלום רב', `deferred-4a-${Date.now()}`);

  // Wait for burst (300ms) + pipeline start + _markBotSent call (~100ms)
  await wait(500);

  // Staff reply echo: different id from whatever the bot will send
  const staffId = `STAFF-DEFERRED-${Date.now()}`;
  await outgoingWebhook(ph, staffId, 'אני אטפל בזה');

  // Wait > OUTGOING_RECONCILE_MS (300ms) + GA delay (500ms) + buffer
  await wait(1000);

  const status = store.getLead(ph)?.status ?? null;
  assert(status === 'human_owns', '4a: staff reply during in-flight → human_owns after deferred window', status ?? '(no lead)');
  _gaDelay = 0;
}

// 4b: Bot echo during in-flight (preknown MOCK- id) → NOT human_owns
{
  const ph         = '972509960008';
  const preknownId = `MOCK-PRE-${Date.now()}`;
  _gaNextId        = preknownId;
  _gaDelay         = 400;

  post('/api/whatsapp/simulate', { from: ph, text: 'מה השעות?' }).catch(() => {});
  await wait(80);

  // Echo for the same preknown id arrives while HTTP is pending
  await outgoingWebhook(ph, preknownId, 'bot message');

  // Wait for GA to respond + reconciliation window
  await wait(800);

  const status = store.getLead(ph)?.status ?? null;
  // MOCK-* prefix makes _isBotSentId return true unconditionally
  assert(status !== 'human_owns', '4b: MOCK-* bot echo during in-flight → NOT human_owns', status ?? '(no lead)');

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
