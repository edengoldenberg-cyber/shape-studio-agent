'use strict';
/**
 * callback_demo.mjs — One populated end-to-end local demonstration.
 *
 * Shows:
 *   1. Lead accepts callback + gives time
 *   2. AI asks for first name
 *   3. Lead gives name → record updated
 *   4. Mocked team alert sent with idMessage
 *   5. callback_pending entry in aptStore (reminderSent=false)
 *   6. Panel-ready lead state
 *
 * Run: node tests/callback_demo.mjs
 * No real messages sent (TEST_MODE=true, all WhatsApp calls intercepted by mock).
 */

import http                 from 'http';
import { createServer }     from 'http';
import { spawn }            from 'child_process';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir }           from 'os';
import path                 from 'path';

// createRequire lets us load CommonJS modules from this ESM file.
const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEMO_PHONE = '972509970055';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Dynamic port allocation (avoids stale-server collisions on reruns) ────────
async function freePort(base) {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(base, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', () => freePort(base + 1).then(resolve));
  });
}

const MOCK_PORT = await freePort(20499);
const APP_PORT  = await freePort(20498);

// ── Isolated temp DATA_DIR ─────────────────────────────────────────────────
// Use a fresh temp directory so the demo never reads from or writes to the
// project's real data/ directory. This keeps the demo idempotent and prevents
// stale leads_persist.json from causing the persist.loadLeads race.
const DEMO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'shape-demo-'));
// Copy the studio's staff_config.json (read-only during demo) so modules that
// read it (notification.service, appointment_worker, whatsapp.service) work.
const srcStaff = path.join(__dirname, '../data/staff_config.json');
if (existsSync(srcStaff)) {
  copyFileSync(srcStaff, path.join(DEMO_DATA_DIR, 'staff_config.json'));
} else {
  writeFileSync(path.join(DEMO_DATA_DIR, 'staff_config.json'),
    JSON.stringify({ staff: [], default_assignee_id: null }));
}
// Copy subscription packages so pricing context loads correctly.
const srcPkg = path.join(__dirname, '../data/subscription_packages.json');
if (existsSync(srcPkg)) copyFileSync(srcPkg, path.join(DEMO_DATA_DIR, 'subscription_packages.json'));

// ── Mock Green API server — captures ALL outbound messages ───────────────────
let _capturedSends = [];
const mockSrv = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const idMessage = `DEMO-${Date.now()}`;
    _capturedSends.push({ chatId: parsed.chatId, preview: (parsed.message ?? '').slice(0, 100), idMessage });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ idMessage }));
  });
});
await new Promise((resolve, reject) => {
  mockSrv.on('error', reject);
  mockSrv.listen(MOCK_PORT, resolve);
});

// ── App server ────────────────────────────────────────────────────────────────
const serverProc = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    PORT:                     String(APP_PORT),
    TEST_MODE:                'true',
    GREEN_API_URL:            `localhost:${MOCK_PORT}`,
    GREEN_API_ID_INSTANCE:    '9999055',
    GREEN_API_TOKEN_INSTANCE: 'mock-tok-demo',
    // 972000000099 matches DEMO_PHONE_RE and is intercepted by demoCapture.
    // Use a synthetic non-demo phone as the notification recipient so handoff
    // alerts route through the HTTP mock and show as 'sent' in the demo output.
    STUDIO_OWNER_PHONE:       '972509000001',
    NOTIFY_PHONES:            '972509000001',
    TEST_ALLOWLIST_PHONES:    '972509000001',
    OPENAI_API_KEY:           'sk-test',  // Force fake key — demo uses mocked pipeline only
    DATA_DIR:                 DEMO_DATA_DIR,
    NODE_ENV:                 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Ensure cleanup even on crash or Ctrl-C
function cleanup() {
  try { serverProc.kill(); } catch {}
  try { mockSrv.close(); } catch {}
  try { rmSync(DEMO_DATA_DIR, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[demo] uncaught:', err.message); cleanup(); process.exit(1); });

function g(url) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${APP_PORT}${url}`, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    }).on('error', reject);
  });
}
function p(url, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: APP_PORT, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}
function del(url) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: APP_PORT, path: url, method: 'DELETE' }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject); r.end();
  });
}

// Wait for server ready AND full startup (persist.loadLeads + initWorkers must complete
// before we start modifying the store, otherwise a delayed persist.loadLeads call
// would overwrite in-memory state set by the demo flow).
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  await sleep(300);
  try {
    const h = await g('/health');
    if (h?.startupComplete === true) ready = true;
  } catch {}
}
if (!ready) { console.error('Server did not reach startupComplete'); cleanup(); process.exit(1); }

// ── DEMO ─────────────────────────────────────────────────────────────────────

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║  Shape Studio — Callback Flow Demo (mocked, no sends)   ║');
console.log(`╚═══════ app:${APP_PORT}  mock:${MOCK_PORT} ══════════════╝\n`);

await p('/api/store/reset', {});
await sleep(100);

// Step 1 — Initial inquiry (triggers Barak's sales flow)
console.log('Step 1: Lead sends first message');
const s1 = await p('/api/whatsapp/simulate', { from: DEMO_PHONE, name: 'Demo Lead', text: 'שלום, מחפשת פילאטיס מחדרה' });
await sleep(300);
console.log(`  → Barak reply: "${(s1.barakReply ?? '').slice(0, 80)}"`);

// Step 2 — Force callProposed=true (skips multi-turn AI for demo speed)
await del('/api/test/cooldowns');
const sq2 = await p(`/api/leads/${encodeURIComponent(DEMO_PHONE)}/set-qual`, { callProposed: true });
console.log('\nStep 2: callProposed=true set (AI has proposed callback in conversation)');

// Step 3 — Lead accepts callback + gives time
console.log('\nStep 3: Lead sends acceptance with time');
console.log(`  Inbound: "כן אשמח למחר בשעה 12"  (Nov-12 06:41 IL → Nov-13 12:00 IL)`);
const s3 = await p('/api/whatsapp/simulate', {
  from: DEMO_PHONE, name: 'Demo Lead', text: 'כן אשמח למחר בשעה 12',
});
await sleep(600);

const lead3 = await g(`/api/test/lead/${encodeURIComponent(DEMO_PHONE)}`);
const qd3 = lead3?.lead?.meta?.qualData ?? {};
console.log(`  → callTimeGiven:    "${qd3.callTimeGiven ?? '—'}"`);
console.log(`  → callTimeGivenAt:  ${qd3.callTimeGivenAt ?? '—'} (anchored to inbound timestamp)`);
console.log(`  → status:           ${lead3?.lead?.status ?? '—'}`);
console.log(`  → AI reply:         "${(s3.barakReply ?? '').slice(0, 80)}"`);

// Step 4 — AI asked for name; check the alert was sent
const alertStatus = lead3?.lead?.meta?.handoffAlertStatus;
const alertId     = lead3?.lead?.meta?.handoffAlertIdMessage;
console.log(`\nStep 4: Team notification`);
console.log(`  → handoffAlertStatus:    ${alertStatus ?? '—'}`);
console.log(`  → handoffAlertIdMessage: ${alertId ?? '(demo phone — intercepted, not real WhatsApp)'}`);

// Step 5 — Lead gives name
console.log('\nStep 5: Lead gives name');
await del('/api/test/cooldowns');
await p(`/api/leads/${encodeURIComponent(DEMO_PHONE)}/set-qual`, { nameAsked: true });
const s5 = await p('/api/whatsapp/simulate', { from: DEMO_PHONE, name: 'Demo Lead', text: 'שרה' });
await sleep(400);

const lead5 = await g(`/api/test/lead/${encodeURIComponent(DEMO_PHONE)}`);
const qd5 = lead5?.lead?.meta?.qualData ?? {};
console.log(`  Inbound: "שרה"`);
console.log(`  → confirmedName: "${qd5.confirmedName ?? '—'}"`);

// Step 6 — Create callback_pending aptStore entry (shows what the reminder worker will use)
// Point the demo process's appointment_store at the same temp dir so Step 6's
// createCallbackPending writes to DEMO_DATA_DIR, not the project's real data/.
process.env.DATA_DIR = DEMO_DATA_DIR;
const aptStore = require('../utils/appointment_store');
const { parseHebrewTimeLocal } = require('../services/calendar.service');
const msgTs = qd5.callTimeGivenAt ? new Date(qd5.callTimeGivenAt) : new Date();
const scheduledAt = parseHebrewTimeLocal(qd5.callTimeGiven ?? 'מחר בשעה 12', msgTs);
const apt = aptStore.createCallbackPending({
  leadPhone:       DEMO_PHONE,
  leadName:        qd5.confirmedName ?? 'Demo Lead',
  rawTime:         qd5.callTimeGiven ?? 'מחר בשעה 12',
  scheduledAt,
  assignedStaffId: 'eden',
});
console.log('\nStep 6: callback_pending aptStore entry');
console.log(`  → id:           ${apt.id}`);
console.log(`  → status:       ${apt.status}`);
console.log(`  → leadName:     ${apt.leadName}`);
console.log(`  → rawTime:      ${apt.rawTime}`);
if (scheduledAt) {
  const ilTime = scheduledAt.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem',
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  console.log(`  → scheduledAt:  ${ilTime} (Asia/Jerusalem)`);
} else {
  console.log(`  → scheduledAt:  null (parseHebrewTimeLocal could not resolve)`);
}
console.log(`  → reminderSent:  ${apt.reminderSent}  (reminder disabled until CALLBACK_PENDING_REMINDER_ENABLED=true)`);
console.log(`  → noShowAlerted: ${apt.noShowAlerted}  (excluded from no-show pass by design)`);

// Step 7 — Final panel state summary
console.log('\nStep 7: Panel state');
const panelLeads = await g('/api/leads');
const pl = Array.isArray(panelLeads) ? panelLeads.find(l => l.phone?.includes('055')) : null;
console.log(`  Lead in /api/leads: ${pl ? 'yes' : 'no'}`);
console.log(`  status:             ${pl?.status ?? '—'}`);
console.log(`  score:              ${pl?.score ?? '—'}/10`);

// Captured outbound sends
console.log('\nAll mocked WhatsApp sends this demo:');
_capturedSends.forEach((s, i) => {
  const isAlert = s.chatId?.includes('972509000001');
  console.log(`  ${i+1}. to=${s.chatId} [${isAlert ? 'team alert' : 'lead'}] "${s.preview}"`);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup();

console.log('\n╔═════════════════════════════════════╗');
console.log('║  Demo complete. No real messages sent ║');
console.log('╚═════════════════════════════════════╝\n');
