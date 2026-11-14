#!/usr/bin/env node
/**
 * panel_browser_check.mjs — browser verification of the Barak callback panel.
 *
 * NOT an API test. It starts an isolated server (fresh temp DATA_DIR, HTTP-mocked Green
 * API + Arbox), creates callbacks by sending real inbound messages, then drives a real
 * headless Chrome over the DevTools protocol: it loads the dashboard, CLICKS the panel's
 * buttons, TYPES into its inputs and asserts on the RENDERED DOM. After each click the
 * server state is read back to confirm the click did what the panel says it did.
 *
 * Usage:  node tests/panel_browser_check.mjs [--screenshot <file.png>]
 * Requires Google Chrome or Microsoft Edge installed locally. No npm dependencies.
 */

import { spawn, spawnSync } from 'child_process';
import { createServer }     from 'http';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir }           from 'os';
import path                 from 'path';

const require = createRequire(import.meta.url);
const { createIsolatedDataDir, removeDir, isolatedChildEnv, freePort, waitFor, TEST_MANAGER_PHONE } = require('./helpers/isolated_env.cjs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const shotIdx = process.argv.indexOf('--screenshot');
const shotFile = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.error(`  ✗ ${label}${detail ? '  →  ' + detail : ''}`); }
}

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browserBin = process.env.CHROME_BIN ?? BROWSERS.find(p => existsSync(p));
if (!browserBin) { console.error('[FATAL] No Chrome/Edge binary found (set CHROME_BIN).'); process.exit(2); }

const children = [];
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

const dataDir    = createIsolatedDataDir('shape-panel-');
const profileDir = mkdtempSync(path.join(tmpdir(), 'shape-panel-chrome-'));
const sent = [];
let mock, ws;

async function httpJson(port, method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({}));
}

try {
  // ── Isolated backend ────────────────────────────────────────────────────────
  const [appPort, mockPort, dbgPort] = [await freePort(), await freePort(), await freePort()];
  mock = createServer((req, res) => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/arbox')) return res.end(JSON.stringify({ data: [] }));
      try { sent.push(JSON.parse(b)); } catch { /* not json */ }
      res.end(JSON.stringify({ idMessage: `MOCK-${sent.length}-${Date.now()}` }));
    });
  });
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));

  const LEAD_A = '972587700001', LEAD_B = '972587700002', LEAD_C = '972587700003';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: isolatedChildEnv(dataDir, {
      PORT: String(appPort), TEST_MODE: 'true', WHATSAPP_AUTO_REPLY: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
      GREEN_API_URL: `127.0.0.1:${mockPort}`, GREEN_API_ID_INSTANCE: '9990001', GREEN_API_TOKEN_INSTANCE: 'mock-panel',
      ARBOX_BASE_URL: `http://127.0.0.1:${mockPort}/arbox`, ARBOX_API_KEY: 'mock-arbox',
      TEST_ALLOWLIST_PHONES: [TEST_MANAGER_PHONE, LEAD_A, LEAD_B, LEAD_C].join(','),
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(server);
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += d.toString(); });
  const up = await waitFor(async () => (await httpJson(appPort, 'GET', '/health')).startupComplete === true, { timeoutMs: 30000, intervalMs: 200 });
  if (!up) throw new Error('server did not start: ' + serverErr.slice(-400));

  const say = (phone, text) => httpJson(appPort, 'POST', '/api/whatsapp/simulate', { from: phone, name: 'WA', text });
  const rowsApi = async () => (await httpJson(appPort, 'GET', '/api/barak/callbacks')).callbacks ?? [];
  const apts = async () => (await httpJson(appPort, 'GET', '/api/admin/appointments?limit=50')).appointments ?? [];

  // Real flows: A = complete request (pending staff), B = waiting for a name, C = waiting for a time.
  for (const [phone, steps] of [
    [LEAD_A, ['היי, מתעניינת בפילאטיס מכשירים', 'אשמח שיחזרו אליי', 'מחרתיים ב-10:30', 'דנה']],
    [LEAD_B, ['שלום, רוצה לשמוע על אימוני כוח', 'תתקשרו אליי מחרתיים ב-12:00']],
    [LEAD_C, ['היי, מתעניין בפילאטיס', 'אפשר שיחת טלפון?']],
  ]) for (const t of steps) {
    const r = await say(phone, t);
    if (!r.route) throw new Error(`setup message failed (${phone} "${t}"): ${JSON.stringify(r).slice(0, 300)}`);
  }
  const setupRows = await rowsApi();
  check('setup: three callback rows exist server-side', setupRows.length === 3, JSON.stringify(setupRows.map(r => [r.fullPhone, r.stage])));

  // ── Real browser ────────────────────────────────────────────────────────────
  const chrome = spawn(browserBin, [
    '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1500,1100', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json();
    return list.find(t => t.type === 'page');
  }, { timeoutMs: 20000, intervalMs: 200 });
  if (!target) throw new Error('browser did not expose a page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(); const dialogs = []; const pageErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown');
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); }
  };
  function cdp(method, params = {}) {
    return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function evalJs(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }
  await cdp('Page.enable'); await cdp('Runtime.enable');

  // Row helpers evaluated in the page — everything is read from the rendered DOM.
  const rowSel = phone => `.callback-row[data-phone="${phone}"]`;
  const rowText = phone => evalJs(`(() => { const r = document.querySelector('${rowSel(phone)}'); return r ? r.innerText : null; })()`);
  const rowAttr = (phone, attr) => evalJs(`document.querySelector('${rowSel(phone)}')?.getAttribute('${attr}') ?? null`);
  const hasButton = (phone, action) => evalJs(`!!document.querySelector('${rowSel(phone)} button[data-cb-action="${action}"]')`);
  const msgBar = () => evalJs(`(() => { const m = document.getElementById('barak-callbacks-msg'); return m && m.style.display !== 'none' ? m.textContent : ''; })()`);
  // A real mouse click at the element's on-screen position.
  async function click(selector) {
    const box = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!box || !box.w || !box.h) throw new Error('element not clickable: ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }
  async function type(selector, text) {
    await click(selector);
    await cdp('Input.insertText', { text });
  }

  // Deep link from the manager's WhatsApp summary opens the Barak tab directly.
  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/#barak` });
  const rendered = await waitFor(() => evalJs(`document.querySelectorAll('.callback-row').length === 3`), { timeoutMs: 20000, intervalMs: 150 });
  check('browser: /#barak opens the Barak tab and renders 3 callback rows', rendered === true,
    JSON.stringify({ rows: await evalJs(`document.querySelectorAll('.callback-row').length`), active: await evalJs(`document.querySelector('.tab-btn.active')?.dataset.tab`), hash: await evalJs('location.hash'), pageErrors }));
  check('browser: Barak tab is the active tab', await evalJs(`document.querySelector('.tab-btn.active')?.dataset.tab`) === 'barak');
  check('browser: badge shows 3', (await evalJs(`document.getElementById('barak-callbacks-badge').textContent`)) === '3');

  // ── Row A: complete request ─────────────────────────────────────────────────
  const aptA = (await apts()).find(a => a.leadPhone === LEAD_A);
  const fmtA = (await rowsApi()).find(r => r.fullPhone === LEAD_A).apt.scheduledLabel;
  let tA = await rowText(LEAD_A);
  check('row A: shows the confirmed name', /✓ דנה/.test(tA), tA);
  check('row A: shows the explicit date and Israel time from scheduledAt', tA.includes(fmtA) && /בשעה 10:30/.test(fmtA), fmtA);
  check('row A: stage "ממתין לאישור הצוות"', /ממתין לאישור הצוות/.test(tA));
  check('row A: staff approval and prospect availability shown as separate facts', /צוות: טרם אישר/.test(tA) && /ליד: טרם נשלחה תזכורת/.test(tA));
  check('row A: confirm button is rendered', await hasButton(LEAD_A, 'confirm'));

  // ── Row B / C: incomplete requests are visible and actionable ───────────────
  const tB = await rowText(LEAD_B), tC = await rowText(LEAD_C);
  check('row B: stage "ממתין לשם" + explanation that the summary is pending', /ממתין לשם/.test(tB) && /סיכום למנהל יישלח כשהליד ימסור שם/.test(tB), tB);
  check('row B: time shown, action buttons present', /בשעה 12:00/.test(tB) && await hasButton(LEAD_B, 'cancel'));
  check('row C: stage "ממתין למועד מהליד", WhatsApp link, no appointment buttons', /ממתין למועד מהליד/.test(tC) && /WhatsApp/.test(tC) && !(await hasButton(LEAD_C, 'confirm')), tC);

  // ── Click: ✅ אשר שיחה ───────────────────────────────────────────────────────
  await click(`${rowSel(LEAD_A)} button[data-cb-action="confirm"]`);
  const confirmedDom = await waitFor(() => evalJs(`document.querySelector('${rowSel(LEAD_A)}')?.dataset.stage === 'staff_confirmed'`), { timeoutMs: 8000 });
  check('click "אשר שיחה": row re-renders as "אושר על ידי הצוות"', confirmedDom === true && /אושר על ידי הצוות/.test(await rowText(LEAD_A)));
  check('click "אשר שיחה": success message shown in the panel', /השיחה אושרה/.test(await msgBar()), await msgBar());
  check('click "אשר שיחה": confirm button is gone (cannot be confirmed twice)', !(await hasButton(LEAD_A, 'confirm')));
  check('click "אשר שיחה": facts now read "צוות: אישר"', /צוות: אישר/.test(await rowText(LEAD_A)));
  check('server after click: appointment confirmed, lead call_scheduled',
    (await apts()).find(a => a.id === aptA.id).status === 'confirmed' && (await rowsApi()).find(r => r.fullPhone === LEAD_A).status === 'call_scheduled');
  const sendsAfterConfirm = sent.length;

  // ── Click: 🔄 שנה מועד (invalid, then valid) ────────────────────────────────
  await click(`${rowSel(LEAD_A)} button[data-cb-action="reschedule"]`);
  check('click "שנה מועד": inline input appears', await evalJs(`document.getElementById('cb-resched-${aptA.id}').style.display === 'flex'`));
  await type(`#cb-resched-input-${aptA.id}`, '30.02 ב-10');
  await click(`${rowSel(LEAD_A)} button[data-cb-action="reschedule-save"]`);
  const errShown = await waitFor(async () => /שגיאה/.test(await msgBar()), { timeoutMs: 8000 });
  check('invalid date typed in the panel: error shown, nothing changed', errShown === true && /לא קיים בלוח השנה/.test(await msgBar()), await msgBar());
  check('server after invalid reschedule: time unchanged, still confirmed',
    (await apts()).find(a => a.id === aptA.id).scheduledAt === aptA.scheduledAt && (await apts()).find(a => a.id === aptA.id).status === 'confirmed');

  await evalJs(`document.getElementById('cb-resched-input-${aptA.id}').value = ''`);
  await type(`#cb-resched-input-${aptA.id}`, 'מחרתיים ב-15:00');
  await click(`${rowSel(LEAD_A)} button[data-cb-action="reschedule-save"]`);
  const moved = await waitFor(async () => /בשעה 15:00/.test((await rowText(LEAD_A)) ?? ''), { timeoutMs: 8000 });
  check('valid new time: row shows the new explicit time', moved === true);
  check('valid new time: back to "ממתין לאישור הצוות" and confirm button returns', /ממתין לאישור הצוות/.test(await rowText(LEAD_A)) && await hasButton(LEAD_A, 'confirm'));
  check('valid new time: success message', /המועד עודכן/.test(await msgBar()), await msgBar());
  const afterMove = sent.slice(sendsAfterConfirm);
  check('provider after reschedule: prospect got ONE updated summary, manager got none',
    afterMove.filter(p => p.chatId === `${LEAD_A}@c.us` && /עדכנו את בקשת השיחה/.test(p.message)).length === 1
    && afterMove.filter(p => p.chatId === `${TEST_MANAGER_PHONE}@c.us`).length === 0, JSON.stringify(afterMove.map(p => p.chatId)));

  // ── Click: ✔ הושלם ──────────────────────────────────────────────────────────
  await click(`${rowSel(LEAD_A)} button[data-cb-action="complete"]`);
  const goneA = await waitFor(() => evalJs(`!document.querySelector('${rowSel(LEAD_A)}')`), { timeoutMs: 8000 });
  check('click "הושלם": row leaves the active queue', goneA === true);
  check('click "הושלם": badge drops to 2', (await evalJs(`document.getElementById('barak-callbacks-badge').textContent`)) === '2');
  check('server after click: appointment completed, lead call_completed',
    (await apts()).find(a => a.id === aptA.id).status === 'completed'
    && (await httpJson(appPort, 'GET', `/api/test/lead/${LEAD_A}`)).lead?.status === 'call_completed');

  // ── Click: 🚫 בטל (two-step) ────────────────────────────────────────────────
  const aptB = (await apts()).find(a => a.leadPhone === LEAD_B);
  await click(`${rowSel(LEAD_B)} button[data-cb-action="cancel"]`);
  check('first click on "בטל" only arms the button', /לחצו שוב לביטול/.test(await evalJs(`document.querySelector('${rowSel(LEAD_B)} button[data-cb-action="cancel"]').textContent`))
    && (await apts()).find(a => a.id === aptB.id).status === 'callback_pending');
  await click(`${rowSel(LEAD_B)} button[data-cb-action="cancel"]`);
  const goneB = await waitFor(() => evalJs(`!document.querySelector('${rowSel(LEAD_B)}')`), { timeoutMs: 8000 });
  check('second click cancels: row leaves the queue', goneB === true);
  check('server after click: appointment cancelled, lead call_cancelled',
    (await apts()).find(a => a.id === aptB.id).status === 'cancelled'
    && (await httpJson(appPort, 'GET', `/api/test/lead/${LEAD_B}`)).lead?.status === 'call_cancelled');
  check('cancellation from the panel sent nothing to the prospect', !sent.some(p => p.chatId === `${LEAD_B}@c.us` && /ביטל/.test(p.message)));

  check('no native alert()/prompt() dialogs were used by any of these actions', dialogs.length === 0, dialogs.join(' | '));
  check('no uncaught JavaScript errors on the page', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));

  if (shotFile) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
    console.log(`  screenshot: ${shotFile}`);
  }
} catch (err) {
  fail++;
  console.error(`  [FATAL] ${err.stack ?? err.message}`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  for (const c of children) killTree(c.pid);
  try { mock?.close(); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 300));
  removeDir(dataDir);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* browser may still hold a lock */ }
}

console.log(`\npanel_browser_check.mjs: PASS=${pass}  FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
