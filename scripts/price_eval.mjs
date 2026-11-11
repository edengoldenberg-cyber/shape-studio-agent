/**
 * price_eval.mjs — get the full price-first Hebrew reply with real production pricing data.
 * Uses local data/ directory (not temp) so subscription_packages.json is loaded.
 */
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use the REAL local data directory so subscription_packages.json is loaded
process.env.DATA_DIR = path.join(__dirname, '../data');

const MOCK_PORT = 20021;
const APP_PORT  = 20020;
const _sends    = [];

const mockServer = http.createServer((_req, res) => {
  let body = '';
  _req.on('data', c => { body += c; });
  _req.on('end', () => {
    let parsed = {}; try { parsed = JSON.parse(body); } catch {}
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
process.env.TEST_ALLOWLIST_PHONES    = '972509922001,972509922002,972509922003';

await import('../server.js');
await new Promise(r => setTimeout(r, 600));

const BASE = `http://localhost:${APP_PORT}`;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMsg(phone, text) {
  const id = `m-${Date.now()}`;
  const payload = {
    typeWebhook: 'incomingMessageReceived',
    senderData:  { sender: `${phone}@c.us`, chatId: `${phone}@c.us` },
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
    req.on('error', reject); req.write(body); req.end();
  });
}

async function del(phone) {
  const norm = `972${phone.replace(/^0/,'')}`;
  await fetch(`${BASE}/api/leads/${encodeURIComponent(norm)}`, { method: 'DELETE' }).catch(() => {});
}

function lastSend(phone) {
  const tail = phone.replace(/^0/,'');
  const all = _sends.filter(s => s.to.includes(tail));
  return all[all.length - 1]?.text ?? null;
}

// ── Scenario 1: Price-first ───────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════');
console.log(' Price-first (production pricing data loaded)');
console.log('══════════════════════════════════════════════════');
const p1 = '0509922001';
await del(p1); _sends.length = 0;

await sendMsg(p1, 'כמה עולה מנוי?');
await wait(5500);
const r1 = lastSend(p1);
console.log('\nMessage: "כמה עולה מנוי?"');
console.log('\n--- Full reply ---');
console.log(r1);
console.log('--- End reply ---');

// Source attribution
const sources = [];
if (r1 && /60/i.test(r1))             sources.push('trial price (60₪) ← subscription_packages.json trial.price_ils');
if (r1 && /ניסיון|היכרות/i.test(r1)) sources.push('trial name ← subscription_packages.json trial.name');
if (r1 && /תדירות|הצוות/i.test(r1))  sources.push('monthly price fallback ← buildPricingContext() unconfigured message');
if (r1 && /פילאטיס.*Reformer|Reformer.*פילאטיס|פילאטיס מכשירים/i.test(r1)) sources.push('class types ← subscription_packages.json _universal_access');
if (r1 && /8.*כניסות|12.*כניסות|ללא הגבלה/i.test(r1)) sources.push('package tiers ← subscription_packages.json packages[].name');
console.log('\nSource attribution:');
sources.forEach(s => console.log(' ✓', s));
if (sources.length === 0) console.log(' (no recognized pricing terms — reply may be off-script)');

// Quality checks
console.log('\nQuality:');
console.log(' leads with trial (60₪):', r1 && /60/i.test(r1) ? 'YES ✓' : 'NO ✗');
console.log(' no call redirect first:', r1 && !/^[^.?!\n]{0,30}(?:שיחה קצרה|מתי נוח)/i.test(r1) ? 'YES ✓' : 'NO ✗');
console.log(' length:', r1 ? r1.split(/[.!?\n]/).filter(s=>s.trim()).length + ' sentences' : 'n/a');
await del(p1);

// ── Scenario 2 & 3 (burst and call-decline) with real data ──────────────────
console.log('\n══════════════════════════════════════════════════');
console.log(' Burst: 3 consecutive messages (production data)');
console.log('══════════════════════════════════════════════════');
const p2 = '0509922002';
await del(p2); _sends.length = 0;

await sendMsg(p2, 'שלום');
await wait(80);
await sendMsg(p2, 'אני מחפשת שיעורי פילאטיס');
await wait(80);
await sendMsg(p2, 'אני מחדרה');
await wait(6500);

const sends2 = _sends.filter(s => s.to.includes('9922002'));
const r2 = sends2[sends2.length-1]?.text ?? null;
console.log('\nBurst: "שלום" → "אני מחפשת שיעורי פילאטיס" → "אני מחדרה"');
console.log('Send count:', sends2.length);
console.log('\n--- Full reply ---');
console.log(r2);
console.log('--- End reply ---');
await del(p2);

console.log('\n══════════════════════════════════════════════════');
console.log(' Call declined (production data)');
console.log('══════════════════════════════════════════════════');
const p3 = '0509922003';
await del(p3); _sends.length = 0;

await sendMsg(p3, 'שלום, אני רון, מחדרה, מחפש פילאטיס לחיזוק גב');
await wait(5500);
const r3a = lastSend(p3);
console.log('\nTurn 1: "שלום, אני רון, מחדרה, מחפש פילאטיס לחיזוק גב"');
console.log('\n--- Full reply ---');
console.log(r3a);
console.log('--- End reply ---');

_sends.length = 0;
await sendMsg(p3, 'לא רוצה שיתקשרו אלי, רק מידע בוואטסאפ');
await wait(5500);
const r3b = lastSend(p3);
console.log('\nTurn 2: "לא רוצה שיתקשרו אלי, רק מידע בוואטסאפ"');
console.log('\n--- Full reply ---');
console.log(r3b);
console.log('--- End reply ---');

const r3b_accepts = r3b && !/(?:באיזו שעה|מתי נוח.*שיחזרו|שיחה קצרה.*מתי)/i.test(r3b);
console.log('\nQuality: accepts refusal without callback question:', r3b_accepts ? 'YES ✓' : 'NO ✗');
await del(p3);

console.log('\n══════════════════════════════════════════════════');
mockServer.close();
process.exit(0);
