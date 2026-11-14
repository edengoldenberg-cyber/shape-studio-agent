#!/usr/bin/env node
/**
 * tomer_panel_browser_check.mjs — browser verification of the Tomer service-cases panel
 * and of dashboard authentication.
 *
 * Starts an isolated server (fresh temp DATA_DIR, loopback Green API mock, loopback
 * Arbox stand-in, authentication ENABLED with a throw-away password), creates cases by
 * sending real inbound member messages, then drives a real headless Chrome over the
 * DevTools protocol: logs in through the login page, opens the "פניות" tab, CLICKS the
 * case buttons and asserts on the RENDERED DOM and on server state read back afterwards.
 *
 * Usage:  node tests/tomer_panel_browser_check.mjs [--screenshot <file.png>]
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
const { createArboxMock } = require('./helpers/arbox_mock.cjs');
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
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
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
const PASSWORD = 'panel-check-' + Math.random().toString(36).slice(2);
const TOKEN    = 'token-' + Math.random().toString(36).slice(2);
const M1 = '972507100001', M2 = '972507100002';
const dataDir    = createIsolatedDataDir('shape-tomer-panel-');
writeFileSync(path.join(dataDir, 'known_members.json'), JSON.stringify({ phones: [M1, M2], names: {} }));
const profileDir = mkdtempSync(path.join(tmpdir(), 'shape-tomer-chrome-'));
const sent = [];
const arbox = createArboxMock();
let green, ws;

try {
  const [appPort, greenPort, dbgPort] = [await freePort(), await freePort(), await freePort()];
  green = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => { try { sent.push(JSON.parse(b)); } catch { /* not json */ } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ idMessage: `MOCK-${sent.length}` })); });
  });
  await new Promise(r => green.listen(greenPort, '127.0.0.1', r));
  const arboxUrl = await arbox.listen();
  arbox.state.users.push(
    { user_id: 1, first_name: 'דנה', last_name: 'בדיקה', phone: '050-7100001', user_role: 'client', active: 1, gender: 'female' },
    { user_id: 2, first_name: 'נועה', last_name: 'בדיקה', phone: '+972507100002', user_role: 'client', active: 1, gender: 'female' });
  arbox.state.memberships.push(
    { membership_user_id: 11, user_id: 1, membership_type_name: 'מנוי חודשי', type: 'plan', debt: 0, start_time: '2026-10-01', end_time: '2026-12-31', active: 1, cancelled: 0 },
    { membership_user_id: 12, user_id: 2, membership_type_name: 'מנוי חודשי', type: 'plan', debt: 0, start_time: '2026-10-01', end_time: '2026-12-31', active: 1, cancelled: 0 });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: isolatedChildEnv(dataDir, {
      PORT: String(appPort), TEST_MODE: 'true', WHATSAPP_AUTO_REPLY: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
      GREEN_API_URL: `127.0.0.1:${greenPort}`, GREEN_API_ID_INSTANCE: '9990001', GREEN_API_TOKEN_INSTANCE: 'mock-panel',
      ARBOX_BASE_URL: arboxUrl, ARBOX_CLIENT_ID: 'mock', ARBOX_LOCATION_ID: '1', ARBOX_MIN_GAP_MS: '0', ARBOX_VERIFY_DELAY_MS: '0',
      TEST_ALLOWLIST_PHONES: [TEST_MANAGER_PHONE, M1, M2].join(','),
      AUTH_DISABLED: 'false', DASHBOARD_PASSWORD: PASSWORD, DASHBOARD_API_TOKEN: TOKEN,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(server);
  let serverErr = ''; server.stderr.on('data', d => { serverErr += d.toString(); });
  const raw = (method, url, body, headers = {}) => fetch(`http://127.0.0.1:${appPort}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const authed = async (method, url, body) => (await raw(method, url, body, { Authorization: `Bearer ${TOKEN}` })).json().catch(() => ({}));
  const up = await waitFor(async () => (await (await raw('GET', '/health')).json()).startupComplete === true, { timeoutMs: 30000, intervalMs: 200 });
  if (!up) throw new Error('server did not start: ' + serverErr.slice(-400));

  // ── Authentication (HTTP level) ─────────────────────────────────────────────
  check('auth: /health is public', (await raw('GET', '/health')).status === 200);
  check('auth: API without a session → 401', (await raw('GET', '/api/tomer/cases')).status === 401);
  check('auth: send endpoint without a session → 401', (await raw('POST', '/api/tomer/send-whatsapp', { phone: M1, message: 'x' })).status === 401);
  check('auth: simulate endpoint without a session → 401', (await raw('POST', '/api/whatsapp/simulate', { from: M1, text: 'x' })).status === 401);
  check('auth: store reset without a session → 401', (await raw('POST', '/api/store/reset', {})).status === 401);
  check('auth: dashboard HTML redirects to the login page', await (async () => { const r = await raw('GET', '/', null, { Accept: 'text/html' }); return r.status === 302 && r.headers.get('location') === '/login.html'; })());
  check('auth: dashboard script is not served without a session', (await raw('GET', '/app.js')).status === 401);
  check('auth: provider webhook path is not blocked by auth', (await raw('POST', '/api/green-api/webhook', { typeWebhook: 'stateInstanceChanged' })).status !== 401);
  check('auth: wrong password → 401', (await raw('POST', '/auth/login', { password: 'nope' })).status === 401);
  check('auth: nothing was sent to anyone during the unauthenticated attempts', sent.length === 0);

  // ── Cases from real member messages ─────────────────────────────────────────
  const say = (phone, text) => authed('POST', '/api/whatsapp/simulate', { from: phone, name: 'WA', text });
  const r1 = await say(M1, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
  const r2 = await say(M2, 'צריכה לדבר איתך בהקדם');
  check('setup: both member messages opened cases', r1.route === 'tomer_case_opened' && r2.route === 'tomer_case_opened', JSON.stringify([r1.route, r2.route]));
  const casesApi = async (open = 1) => (await authed('GET', `/api/tomer/cases?open=${open}`)).cases ?? [];
  const c1 = (await casesApi()).find(c => c.phone === M1), c2 = (await casesApi()).find(c => c.phone === M2);

  // ── Real browser ────────────────────────────────────────────────────────────
  const chrome = spawn(browserBin, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1500,1100', 'about:blank'], { stdio: 'ignore' });
  children.push(chrome);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()).find(t => t.type === 'page'), { timeoutMs: 20000, intervalMs: 200 });
  if (!target) throw new Error('browser did not expose a page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(); const pageErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? 'unknown');
  };
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  async function evalJs(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }
  await cdp('Page.enable'); await cdp('Runtime.enable');
  async function click(selector) {
    const box = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!box || !box.w || !box.h) throw new Error('element not clickable: ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  async function type(selector, text) { await click(selector); await cdp('Input.insertText', { text }); }
  const card = id => `.tw-case-card[data-case="${id}"]`;
  const cardText = id => evalJs(`document.querySelector('${card(id)}')?.innerText ?? null`);
  const hasBtn = (id, op) => evalJs(`!!document.querySelector('${card(id)} .tw-case-btn[data-op="${op}"]')`);
  const actionState = id => evalJs(`document.querySelector('${card(id)} .tw-case-action')?.dataset.state ?? null`);

  // ── Login through the page ──────────────────────────────────────────────────
  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  check('browser: unauthenticated visit lands on the login page', (await waitFor(() => evalJs(`location.pathname === '/login.html' && !!document.getElementById('pw')`), { timeoutMs: 10000 })) === true);
  await type('#pw', 'wrong-password');
  await click('#go');
  check('browser: wrong password shows an error and stays on the login page', (await waitFor(() => evalJs(`document.getElementById('err').textContent.includes('סיסמה שגויה')`), { timeoutMs: 8000 })) === true);
  await evalJs(`(document.getElementById('pw').value = '', true)`);
  await type('#pw', PASSWORD);
  await click('#go');
  check('browser: correct password opens the dashboard', (await waitFor(() => evalJs(`location.pathname === '/' && !!document.querySelector('.tab-btn[data-tab="tomer"]')`), { timeoutMs: 15000 })) === true);
  check('browser: session cookie is HttpOnly (not readable by page scripts)', (await evalJs(`document.cookie.includes('ss_session')`)) === false);

  // ── Cases tab ───────────────────────────────────────────────────────────────
  // The manager alert links to /#tomer — open the workspace the same way.
  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/#tomer` });
  await waitFor(() => evalJs(`document.readyState === 'complete' && document.querySelector('.tab-btn.active')?.dataset.tab === 'tomer'`), { timeoutMs: 15000 });
  const tabShown = await waitFor(() => evalJs(`(() => { const e = document.querySelector('.tw-tab[data-pane="cases"]'); const r = e?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })()`), { timeoutMs: 10000 });
  check('browser: Tomer workspace shows the "פניות" tab', tabShown === true, JSON.stringify({ active: await evalJs(`document.querySelector('.tab-btn.active')?.dataset.tab`), pageErrors }));
  await click('.tw-tab[data-pane="cases"]');
  check('browser: "פניות" tab renders both cases', (await waitFor(() => evalJs(`document.querySelectorAll('.tw-case-card').length === 2`), { timeoutMs: 15000 })) === true, JSON.stringify(pageErrors));
  check('browser: badge shows 2 open cases', (await evalJs(`document.getElementById('tw-badge-cases').textContent`)) === '2');
  check('browser: writes-disabled notice explains manual execution', /כתיבה ל-Arbox כבויה/.test(await evalJs(`document.getElementById('tw-cases-writes').textContent`)));
  const t1 = await cardText(c1.id);
  check('case 1: category, member name, request text, verified Arbox facts', /בקשת הקפאת מנוי/.test(t1) && /דנה בדיקה/.test(t1) && /רוצה להקפיא את המנוי/.test(t1) && /Arbox: מנוי חודשי \(עד 2026-12-31\)/.test(t1), t1);
  check('case 1: proposed action with dates, awaiting approval', (await actionState(c1.id)) === 'awaiting_approval' && /2026-12-01 – 2026-12-15/.test(t1) && /ממתין לאישור/.test(t1));
  check('case 1: approve + reject buttons; no "mark executed" before approval', await hasBtn(c1.id, 'approve') && await hasBtn(c1.id, 'reject') && !(await hasBtn(c1.id, 'mark-executed')));
  check('case 2: staff-request case has no Arbox action, has reply/resolve', (await actionState(c2.id)) === null && await hasBtn(c2.id, 'reply') && await hasBtn(c2.id, 'resolve'));

  // ── Approve (click + confirm modal) ─────────────────────────────────────────
  await click(`${card(c1.id)} .tw-case-btn[data-op="approve"]`);
  await waitFor(() => evalJs(`!!document.getElementById('mc-yes')`), { timeoutMs: 5000 });
  await click('#mc-yes');
  check('click "אשר": action becomes "לביצוע ידני ב-Arbox"', (await waitFor(async () => (await actionState(c1.id)) === 'awaiting_manual', { timeoutMs: 8000 })) === true, await cardText(c1.id));
  check('click "אשר": nothing was written to Arbox', arbox.writes().length === 0);
  check('click "אשר": approve button gone, "בוצע ב-Arbox — אמת" offered', !(await hasBtn(c1.id, 'approve')) && await hasBtn(c1.id, 'mark-executed'));
  const memberMsgs = () => sent.filter(s => String(s.chatId ?? '').startsWith(M1)).length;
  const beforeManual = memberMsgs();

  // ── Mark executed before Arbox shows it → not verified ──────────────────────
  await click(`${card(c1.id)} .tw-case-btn[data-op="mark-executed"]`);
  check('click "בוצע ב-Arbox" before the change exists: card shows "Arbox לא מציג"', (await waitFor(async () => (await actionState(c1.id)) === 'not_verified', { timeoutMs: 8000 })) === true, await cardText(c1.id));
  check('not verified: the member was told nothing', memberMsgs() === beforeManual);

  // ── Staff perform it in Arbox → verified → member told once ─────────────────
  arbox.state.holds.push({ user_id: 1, membership_user_id: 11, start_date: '2026-12-01', end_date: '2026-12-15' });
  await click(`${card(c1.id)} .tw-case-btn[data-op="mark-executed"]`);
  check('click "בוצע ב-Arbox" after the hold exists: card shows "בוצע ואומת ב-Arbox"', (await waitFor(async () => (await actionState(c1.id)) === 'verified', { timeoutMs: 8000 })) === true, await cardText(c1.id));
  check('verified: member received exactly one completion update', memberMsgs() === beforeManual + 1 && /נרשמה ב-Arbox/.test(sent.filter(s => String(s.chatId ?? '').startsWith(M1)).at(-1)?.message ?? ''));
  check('server after clicks: action verified by staff_manual executor', (await casesApi()).find(c => c.id === c1.id)?.action?.executor === 'staff_manual');

  // ── Resolve with a note ─────────────────────────────────────────────────────
  await click(`${card(c1.id)} .tw-case-btn[data-op="resolve"]`);
  await waitFor(() => evalJs(`!!document.getElementById('mp-input')`), { timeoutMs: 5000 });
  await type('#mp-input', 'הוקפא לפי בקשה');
  await click('#mp-ok');
  check('click "סגור פנייה": case leaves the open list', (await waitFor(() => evalJs(`!document.querySelector('${card(c1.id)}') && document.querySelectorAll('.tw-case-card').length === 1`), { timeoutMs: 8000 })) === true);
  check('server: case resolved with the typed note', (await casesApi(0)).find(c => c.id === c1.id)?.resolution?.note === 'הוקפא לפי בקשה');
  await click('#twp-cases .filter-btn[data-cf="0"]');
  check('"סגורות" filter shows the resolved case with its note and no action buttons', (await waitFor(async () => /נסגר: הוקפא לפי בקשה/.test((await cardText(c1.id)) ?? ''), { timeoutMs: 8000 })) === true && !(await hasBtn(c1.id, 'resolve')));
  await click('#twp-cases .filter-btn[data-cf="1"]');
  await waitFor(() => evalJs(`!!document.querySelector('${card(c2.id)}')`), { timeoutMs: 8000 });

  // ── Staff reply → takeover ──────────────────────────────────────────────────
  await click(`${card(c2.id)} .tw-case-btn[data-op="reply"]`);
  await waitFor(() => evalJs(`!!document.getElementById('mp-input')`), { timeoutMs: 5000 });
  await type('#mp-input', 'היי, מתקשרת אלייך עוד כמה דקות');
  await click('#mp-ok');
  check('click "השב לחבר/ה": the staff text was sent to the member', (await waitFor(() => sent.some(s => String(s.chatId ?? '').startsWith(M2) && s.message === 'היי, מתקשרת אלייך עוד כמה דקות'), { timeoutMs: 8000 })) === true);
  const n2 = sent.filter(s => String(s.chatId ?? '').startsWith(M2)).length;
  const held = await say(M2, 'רוצה לבטל את המנוי');
  check('after the staff reply Tomer is silent for this member (human owns the conversation)', held.route === 'human_owns_hold' && sent.filter(s => String(s.chatId ?? '').startsWith(M2)).length === n2, held.route);

  check('browser: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  if (shotFile) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
    console.log(`  screenshot: ${shotFile}`);
  }
} catch (err) {
  fail++; console.error('[ERROR]', err.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  for (const c of children) killTree(c.pid);
  try { green?.close(); } catch { /* ignore */ }
  try { await arbox.close(); } catch { /* ignore */ }
  removeDir(dataDir);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\nTomer panel browser check: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
