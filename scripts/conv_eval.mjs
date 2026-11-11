/**
 * Generates 3 isolated Hebrew conversation evaluations against real AI.
 */
import http from 'http';
import os   from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const TEST_DATA_DIR = path.join(os.tmpdir(), `conv-eval-${process.pid}`);
process.env.DATA_DIR = TEST_DATA_DIR;

const MOCK_PORT = 20001;
const APP_PORT  = 20000;
const _sends = [];

const mockServer = http.createServer((_req, res) => {
  let body = '';
  _req.on('data', c => { body += c; });
  _req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const to = parsed.chatId?.replace('@c.us','') ?? '';
    if (_req.url.includes('sendMessage')) {
      _sends.push({ to, text: parsed.message ?? '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ idMessage: `MOCK-${Date.now()}` }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateInstance: 'authorized' }));
    }
  });
});
await new Promise(r => mockServer.listen(MOCK_PORT, r));

process.env.GREEN_API_URL            = `localhost:${MOCK_PORT}`;
process.env.GREEN_API_ID_INSTANCE    = '9999999999';
process.env.GREEN_API_TOKEN_INSTANCE = 'mock-token';
process.env.WHATSAPP_AUTO_REPLY      = 'true';
process.env.TEST_MODE                = 'true';
process.env.PORT                     = String(APP_PORT);
process.env.ARBOX_BASE_URL           = `http://localhost:${MOCK_PORT}/arbox`;
process.env.TEST_ALLOWLIST_PHONES    =
  '972509921001,972509921002,972509921003,972509921004,972509921005,972509921006';

await import('../server.js');
await new Promise(r => setTimeout(r, 600));

const BASE = `http://localhost:${APP_PORT}`;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMsg(phone, text, msgId) {
  const id = msgId ?? `m-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve()); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function deleteLead(phone) {
  const norm = `972${phone.replace(/^0/,'')}`;
  await fetch(`${BASE}/api/leads/${encodeURIComponent(norm)}`, { method: 'DELETE' }).catch(() => {});
}

function getAllSends(phone) {
  const tail = phone.replace(/^0/,'');
  return _sends.filter(s => s.to.includes(tail)).map(s => s.text);
}
function getLastSend(phone) {
  const all = getAllSends(phone);
  return all[all.length - 1] ?? null;
}

// ─────────────────────────────────────────────────────────────
// Scenario 1: Price-first
// ─────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════');
console.log(' Scenario 1: Price-first lead');
console.log('══════════════════════════════════════');
const p1 = '0509921001';
await deleteLead(p1);
_sends.length = 0;

await sendMsg(p1, 'כמה עולה מנוי?');
await wait(5500);

const r1 = getLastSend(p1);
console.log('\nMessage: "כמה עולה מנוי?"');
console.log('Reply  :', r1);
console.log('\nEvaluation:');
const r1_hasPriceInfo   = r1 != null && /(שקל|מחיר|עולה|60|חבילה|אימונ|₪|תדירות|מנוי)/i.test(r1);
const r1_noFirstRedirect = r1 != null && !/^[^.!?\n]{0,30}(?:שיחה קצרה|מתי נוח|לצוות)/i.test(r1);
const r1_notTooLong     = r1 != null && r1.split(/[.!?\n]/).filter(s=>s.trim()).length <= 5;
console.log(' answers with price info:', r1_hasPriceInfo ? 'YES' : 'NO — NO PRICE GIVEN ✗');
console.log(' does not open with call redirect:', r1_noFirstRedirect ? 'YES' : 'OPENS WITH REDIRECT ✗');
console.log(' length ok (<=5 sentences):', r1_notTooLong ? 'YES' : 'TOO LONG ✗');
await deleteLead(p1);

// ─────────────────────────────────────────────────────────────
// Scenario 2: 3-message burst
// ─────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════');
console.log(' Scenario 2: Consecutive messages (burst)');
console.log('══════════════════════════════════════');
const p2 = '0509921002';
await deleteLead(p2); _sends.length = 0;

await sendMsg(p2, 'שלום');
await wait(90);
await sendMsg(p2, 'אני מחפשת שיעורי פילאטיס');
await wait(90);
await sendMsg(p2, 'אני מחדרה');
await wait(6500);

const sends2 = getAllSends(p2);
const r2     = getLastSend(p2);
console.log('\nBurst: "שלום" → "אני מחפשת שיעורי פילאטיס" → "אני מחדרה"');
console.log('Send count:', sends2.length);
console.log('Reply:', r2);
console.log('\nEvaluation:');
console.log(' combined to 1 send:', sends2.length === 1 ? 'YES' : `NO (${sends2.length}) ✗`);
console.log(' no re-ask location:', r2 && !/מאיזה אזור|מאיפה/i.test(r2) ? 'YES' : 'NO ✗');
console.log(' no re-ask interest:', r2 && !/מה מחפש/i.test(r2) ? 'YES' : 'NO ✗');
console.log(' engages with content:', r2 && /(פילאטיס|חדרה|רפורמר|אימון|שיעור|מכשירים)/i.test(r2) ? 'YES' : 'NO ✗');
await deleteLead(p2);

// ─────────────────────────────────────────────────────────────
// Scenario 3: Lead declines call after context is built
// ─────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════');
console.log(' Scenario 3: Call declined mid-flow');
console.log('══════════════════════════════════════');
const p3 = '0509921003';
await deleteLead(p3); _sends.length = 0;

await sendMsg(p3, 'שלום, אני רון, מחדרה, מחפש פילאטיס לחיזוק גב');
await wait(5500);
const r3a = getLastSend(p3);
console.log('\nTurn 1 — "שלום, אני רון, מחדרה, מחפש פילאטיס לחיזוק גב"');
console.log('Reply:', r3a);

_sends.length = 0;
await sendMsg(p3, 'לא רוצה שיתקשרו אלי, רק מידע בוואטסאפ');
await wait(5500);
const r3b = getLastSend(p3);
console.log('\nTurn 2 — "לא רוצה שיתקשרו אלי, רק מידע בוואטסאפ"');
console.log('Reply:', r3b);

console.log('\nEvaluation:');
const r3b_noPushback  = r3b != null && !/(?:בכל זאת|אפשר.*שיחה|מה.*שיחה|מה אם.*שיחה)/i.test(r3b);
const r3b_noCallRepeat = r3b != null && !/מתי נוח.*(?:נחזור|שיחה)|(?:שיחה קצרה).*מתי/i.test(r3b);
const r3b_continues   = r3b != null && r3b.length > 25;
const r3b_trial       = r3b != null && /(60|ניסיון|2 אימונ|התחייבות)/i.test(r3b);
console.log(' accepts refusal without pushback:', r3b_noPushback ? 'YES' : 'NO — PUSHBACK ✗');
console.log(' no call time question re-asked:', r3b_noCallRepeat ? 'YES' : 'NO — RE-ASKED ✗');
console.log(' continues engaging:', r3b_continues ? 'YES' : 'NO ✗');
console.log(' offers trial alternative:', r3b_trial ? 'YES' : '(not offered — optional)');
await deleteLead(p3);

console.log('\n══════════════════════════════════════');
mockServer.close();
const { default: fs } = await import('fs');
try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exit(0);
