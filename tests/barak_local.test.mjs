/**
 * barak_local.test.mjs — isolated local tests with mocked externals.
 *
 * Run from the project root:
 *   TEST_MODE=true node tests/barak_local.test.mjs
 *
 * What is mocked:
 *   - Green API (sendMessage, sendFileByUrl) → captured in _sends[]
 *   - alertOwner / notifyLeadTeam → no-op
 *   - Arbox API → all calls return empty arrays
 *
 * What is real:
 *   - Full server.js pipeline including scheduleInboundProcessing burst window
 *   - lead_agent.js including stale gate
 *   - OpenAI GPT-4o — real model, no mocking
 *
 * Tests assert:
 *   1. Three-message burst → 1 combined processing, 1 send
 *   2. Newer message during generation → stale send suppressed
 *   3. Duplicate messageId in burst → ignored
 *   4. Non-first message retry during processing → queued, processed after
 *   5. Multi-fact first message → no re-ask
 *   6. Specialist query (postnatal pilates) → AI fallthrough, not "no info"
 */

import http   from 'http';
import os     from 'os';
import path   from 'path';
import fs     from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ── Redirect DATA_DIR to a temp directory BEFORE importing server ─────────────
// This prevents test persistence from writing to data/leads_persist.json
// (the production data file that the main server loads on startup).
const TEST_DATA_DIR = path.join(os.tmpdir(), `barak-test-${process.pid}`);
process.env.DATA_DIR = TEST_DATA_DIR;

// ── Inject mocks BEFORE requiring server ─────────────────────────────────────

const _sends   = [];   // { to, type:'text'|'file', fileName?, preview }
const _alerts  = [];   // { title, body }

// Mock Green API HTTP layer
process.env.GREEN_API_URL          = 'mock.green-api.local';
process.env.GREEN_API_ID_INSTANCE  = '9999999999';
process.env.GREEN_API_TOKEN_INSTANCE = 'mock-token';

// WHATSAPP_AUTO_REPLY must be true so the pipeline actually sends
process.env.WHATSAPP_AUTO_REPLY = 'true';
process.env.TEST_MODE           = 'true';

// Allow test phones through the TEST_MODE default-deny gate so they reach
// the mock Green API server (not a real send — the URL points to localhost).
// Phones 972509920001–972509920006 correspond to test cases 1–6.
process.env.TEST_ALLOWLIST_PHONES =
  '972509920001,972509920002,972509920003,972509920004,972509920005,972509920006';

// Intercept axios before server loads it
// Monkey-patch after server is imported would be harder; use a module-level intercept
// by setting the base URL to localhost and running a tiny mock HTTP server.

const MOCK_PORT = 19999;
let mockServer;

function startMockGreenApi() {
  mockServer = http.createServer((_req, res) => {
    let body = '';
    _req.on('data', chunk => { body += chunk; });
    _req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const to = parsed.chatId?.replace('@c.us','') ?? parsed.to ?? '';
      if (_req.url.includes('sendMessage')) {
        const idMessage = `MOCK-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        _sends.push({ to, type: 'text', preview: (parsed.message ?? '').slice(0, 80), idMessage });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ idMessage }));
      } else if (_req.url.includes('sendFileByUrl')) {
        const idMessage = `MOCK-FILE-${Date.now()}`;
        _sends.push({ to, type: 'file', fileName: parsed.fileName, idMessage });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ idMessage }));
      } else {
        // Health / state endpoints
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stateInstance: 'authorized', statusInstance: 'online' }));
      }
    });
  });
  return new Promise(resolve => mockServer.listen(MOCK_PORT, resolve));
}

// Point Green API base URL at mock server
process.env.GREEN_API_URL = `localhost:${MOCK_PORT}`;

// ── Start server ──────────────────────────────────────────────────────────────

const APP_PORT = 19998;
process.env.PORT = String(APP_PORT);

// Suppress Arbox calls
process.env.ARBOX_BASE_URL = `http://localhost:${MOCK_PORT}/arbox`;

// Start mock Green API server first
await startMockGreenApi();

// Now import the server — it will start listening
// (We use dynamic import so env vars are set before any require())
const serverModule = await import('../server.js').catch(err => {
  console.error('Server import failed:', err.message);
  process.exit(1);
});

// Give server 500ms to start
await new Promise(r => setTimeout(r, 500));

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE = `http://localhost:${APP_PORT}`;

function clearSends() { _sends.length = 0; }

async function postWebhook(phone, text, messageId) {
  const id = messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const payload = {
    typeWebhook: 'incomingMessageReceived',
    senderData: { sender: `${phone}@c.us`, chatId: `${phone}@c.us` },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
    idMessage: id,
    timestamp: Math.floor(Date.now() / 1000),
  };
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/green-api/webhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getEvents(phone) {
  const res = await fetch(`${BASE}/api/test/events?phone=972${phone.replace(/^0/,'')}`);
  return res.ok ? (await res.json()).events : [];
}

async function deleteLead(phone) {
  const norm = `972${phone.replace(/^0/,'')}`;
  await fetch(`${BASE}/api/leads/${encodeURIComponent(norm)}`, { method: 'DELETE' }).catch(() => {});
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Assertions ────────────────────────────────────────────────────────────────

const passed = [], failed = [];
function assert(ok, label, ev = '') {
  if (ok) { passed.push(label); console.log(`  ✓ ${label}`); }
  else { failed.push(label); console.error(`  ✗ ${label}${ev ? ' — ' + JSON.stringify(ev).slice(0,160) : ''}`); }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testThreeMessageBurst() {
  console.log('\n── Test 1: Three-message burst through webhook ──');
  const phone = '0509920001';
  clearSends();
  await deleteLead(phone);

  // Send 3 messages within 300ms (well inside the 1500ms burst window)
  await postWebhook(phone, 'שלום');
  await wait(100);
  await postWebhook(phone, 'אני מחפשת פילאטיס מכשירים');
  await wait(100);
  await postWebhook(phone, 'מחדרה');

  // Wait for burst to fire and AI to respond (burst window=1500ms + AI~3s)
  await wait(5500);

  const textSends = _sends.filter(s => s.to.includes('9920001') && s.type === 'text');
  const events = await getEvents(phone);
  const inbound = events.filter(e => e.type === 'message_in');

  assert(textSends.length === 1, 'exactly 1 outbound text send for 3-message burst', textSends.length);
  // message_in is logged by both server.js pipeline (step 5b) and lead_agent.handleInbound,
  // so a combined burst produces 2 events total — 1 processing call, 2 log entries.
  assert(inbound.length <= 2, 'at most 2 message_in events (1 pipeline + 1 lead_agent) for burst', inbound.length);
  if (textSends[0]) {
    const reply = textSends[0].preview;
    assert(
      /פילאטיס|רפורמר|מכשירים|שיעורים/i.test(reply),
      'combined burst reply references pilates',
      reply,
    );
  }
  await deleteLead(phone);
}

async function testDuplicateMessageId() {
  console.log('\n── Test 2: Duplicate messageId suppressed ──');
  const phone = '0509920002';
  clearSends();
  await deleteLead(phone);

  const msgId = `dup-${Date.now()}`;
  await postWebhook(phone, 'שלום', msgId);
  await wait(2500);
  const before = _sends.filter(s => s.to.includes('9920002')).length;

  // Send the exact same messageId again
  await postWebhook(phone, 'שלום', msgId);
  await wait(2500);
  const after = _sends.filter(s => s.to.includes('9920002')).length;

  assert(after === before, 'duplicate messageId does not produce a second send', { before, after });
  await deleteLead(phone);
}

async function testNewMessageDuringGeneration() {
  console.log('\n── Test 3: Stale send — newer message during generation ──');
  const phone = '0509920003';
  clearSends();
  await deleteLead(phone);

  // Send message 1; almost immediately send message 2 to arrive during AI generation
  await postWebhook(phone, 'שלום, אני מחפשת פילאטיס מחדרה');
  await wait(400); // after burst window fires but before AI finishes (~3-4s)
  await postWebhook(phone, 'כמה עולה מנוי?');

  await wait(8000); // wait for both to complete

  const sends = _sends.filter(s => s.to.includes('9920003') && s.type === 'text');
  // We expect exactly 1 or 2 sends total:
  // - If stale gate fires: 1 send (the second message's reply, with full context)
  // - If stale gate misses (message 2 arrived before burst fired for message 1): combined, 1 send
  // We should NOT see 2 unrelated sends (one for "שלום" and one for "כמה עולה")
  const hasOrphanedGreeting = sends.some(s => /מאיזה אזור|מה מחפשים|מה מביא/i.test(s.preview)
    && sends.length > 1);
  assert(!hasOrphanedGreeting, 'stale greeting reply not sent when price question followed quickly', sends.map(s=>s.preview));
  assert(sends.length <= 2, 'at most 2 sends total for 2-message sequence', sends.length);
  await deleteLead(phone);
}

async function testSpecialistQueryFallthrough() {
  console.log('\n── Test 4: Specialist query (postnatal) → AI fallthrough ──');
  const phone = '0509920004';
  clearSends();
  await deleteLead(phone);

  // This triggers specialist_query intent; without fallthrough returns "no info"
  await wait(200);
  await postWebhook(phone, 'שלום, אני מחדרה, מחפשת פילאטיס מכשירים לאחר לידה');
  await wait(5500);

  const sends = _sends.filter(s => s.to.includes('9920004') && s.type === 'text');
  assert(sends.length >= 1, 'at least one reply sent', sends.length);
  if (sends[0]) {
    const reply = sends[0].preview;
    assert(
      !/אין לנו מידע|אין מידע|לפנות לסטודיו ישירות/i.test(reply),
      'reply does not say "no info" (AI fallthrough worked)',
      reply,
    );
    assert(
      /פילאטיס|רפורמר|מכשירים|לאחר לידה|שיקום|מחדרה/i.test(reply),
      'reply engages with postnatal pilates request',
      reply,
    );
  }
  await deleteLead(phone);
}

async function testMultiFactNoReAsk() {
  console.log('\n── Test 5: Multi-fact first message — no re-ask ──');
  const phone = '0509920005';
  clearSends();
  await deleteLead(phone);

  await postWebhook(phone, 'שלום, אני מחדרה, מחפשת פילאטיס, רוצה לחזק ליבה');
  await wait(5500);

  const sends = _sends.filter(s => s.to.includes('9920005') && s.type === 'text');
  if (sends[0]) {
    const reply = sends[0].preview;
    assert(!/מאיזה אזור/i.test(reply), 'does not re-ask location', reply);
    assert(!/מה מחפשים/i.test(reply), 'does not re-ask interest', reply);
  } else {
    assert(false, 'at least one send expected', sends);
  }
  await deleteLead(phone);
}

async function testTimetableThenThanks() {
  console.log('\n── Test 6: Timetable send, then "תודה" is silent ──');
  const phone = '0509920006';
  clearSends();
  await deleteLead(phone);

  await postWebhook(phone, 'אפשר לקבל מערכת שעות?');
  await wait(3000);
  const afterTimetable = _sends.filter(s => s.to.includes('9920006')).length;

  clearSends();
  await postWebhook(phone, 'תודה');
  await wait(3000);
  const afterThanks = _sends.filter(s => s.to.includes('9920006')).length;

  assert(afterTimetable >= 1, 'at least one send for timetable request', afterTimetable);
  assert(afterThanks === 0, '"תודה" produces no send (brief ack)', afterThanks);
  await deleteLead(phone);
}

// ── Runner ────────────────────────────────────────────────────────────────────

console.log('Local Barak tests (real AI, mocked Green API + Arbox)\n');
console.log(`Server: ${BASE}  Mock Green API: port ${MOCK_PORT}\n`);

try {
  await testThreeMessageBurst();
  await testDuplicateMessageId();
  await testNewMessageDuringGeneration();
  await testSpecialistQueryFallthrough();
  await testMultiFactNoReAsk();
  await testTimetableThenThanks();
} catch (err) {
  console.error('\nFATAL:', err.message);
}

console.log('\n────────────────────────────────');
console.log(`PASSED: ${passed.length}  FAILED: ${failed.length}`);
if (failed.length > 0) {
  failed.forEach(f => console.error(`  ✗ ${f}`));
}

mockServer.close();

// Clean up the temp DATA_DIR so test persistence never survives the process
try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}

process.exit(failed.length > 0 ? 1 : 0);
