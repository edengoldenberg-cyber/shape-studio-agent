#!/usr/bin/env node
/**
 * tomer_panel_browser_check.mjs — browser verification of Tomer's service-cases panel and
 * of dashboard authentication.
 *
 * Starts an isolated server (fresh temp DATA_DIR, loopback Green API mock, loopback
 * Arbox stand-in, authentication ENABLED with a throw-away password), creates cases by
 * sending real inbound member messages, then drives a real headless Chrome over the
 * DevTools protocol:
 *   • follows the manager alert's deep link while logged out → login page → the case opens
 *   • counters, case identity, conversation, Arbox data, notification status
 *   • assign · reply as staff · takeover / release · resolve with a note
 *   • staff-reported completion vs what Arbox shows
 *   • notification retry (failed / uncertain) without duplicate alerts
 *   • loading-error, empty, not-found and Arbox-unavailable states
 *   • server restart: persisted state, same counters, no alert replayed
 *   • logout
 * Every assertion is on the RENDERED DOM or on server state read back afterwards.
 *
 * Usage:  node tests/tomer_panel_browser_check.mjs [--screenshot <file.png>]
 * Requires Google Chrome or Microsoft Edge installed locally. No npm dependencies.
 */
import { spawn, spawnSync } from 'child_process';
import { createServer }     from 'http';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { existsSync, writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs';
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
const [M1, M2, M3, M4] = ['972507100001', '972507100002', '972507100003', '972507100004'];
const dataDir    = createIsolatedDataDir('shape-tomer-panel-');
writeFileSync(path.join(dataDir, 'known_members.json'), JSON.stringify({ phones: [M1, M2, M3, M4], names: {} }));
const profileDir = mkdtempSync(path.join(tmpdir(), 'shape-tomer-chrome-'));
const sent = [];                      // every message the WhatsApp provider mock ACCEPTED
const mgr  = { mode: 'ok', refused: 0 };   // manager channel: 'ok' | 'reject' (400) | 'error' (500)
const arbox = createArboxMock();
let green, ws;

try {
  const [appPort, greenPort, dbgPort] = [await freePort(), await freePort(), await freePort()];
  const BASE = `http://127.0.0.1:${appPort}`;
  green = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      let j = null; try { j = JSON.parse(b); } catch { /* not json */ }
      if (j && String(j.chatId ?? '').startsWith(TEST_MANAGER_PHONE) && mgr.mode !== 'ok') {
        mgr.refused++; res.writeHead(mgr.mode === 'reject' ? 400 : 500, { 'Content-Type': 'application/json' }); return res.end('{}');
      }
      if (j) sent.push(j);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ idMessage: `MOCK-${sent.length}` }));
    });
  });
  await new Promise(r => green.listen(greenPort, '127.0.0.1', r));
  const arboxUrl = await arbox.listen();
  [[1, 'דנה', '050-7100001'], [2, 'נועה', '+972507100002'], [3, 'מיכל', '0507100003'], [4, 'רותם', '972507100004']].forEach(([id, first, phone]) => {
    arbox.state.users.push({ user_id: id, first_name: first, last_name: 'בדיקה', phone, user_role: 'client', active: 1, gender: 'female' });
    arbox.state.memberships.push({ membership_user_id: 10 + id, user_id: id, membership_type_name: 'מנוי חודשי', type: 'plan', debt: 0, start_time: '2026-10-01', end_time: '2026-12-31', active: 1, cancelled: 0 });
  });

  let serverErr = '';
  function startServer() {
    const server = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: isolatedChildEnv(dataDir, {
        PORT: String(appPort), TEST_MODE: 'true', WHATSAPP_AUTO_REPLY: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
        GREEN_API_URL: `127.0.0.1:${greenPort}`, GREEN_API_ID_INSTANCE: '9990001', GREEN_API_TOKEN_INSTANCE: 'mock-panel',
        ARBOX_BASE_URL: arboxUrl, ARBOX_CLIENT_ID: 'mock', ARBOX_LOCATION_ID: '1', ARBOX_MIN_GAP_MS: '0', ARBOX_TIMEOUT_MS: '1500',
        TEST_ALLOWLIST_PHONES: [TEST_MANAGER_PHONE, M1, M2, M3, M4].join(','),
        AUTH_DISABLED: 'false', DASHBOARD_PASSWORD: PASSWORD, DASHBOARD_API_TOKEN: TOKEN, BACKEND_URL: BASE,
      }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(server);
    server.stderr.on('data', d => { serverErr += d.toString(); });
    return server;
  }
  let server = startServer();
  const raw = (method, url, body, headers = {}) => fetch(`${BASE}${url}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const authed = async (method, url, body) => (await raw(method, url, body, { Authorization: `Bearer ${TOKEN}` })).json().catch(() => ({}));
  const waitUp = () => waitFor(async () => (await (await raw('GET', '/health')).json()).startupComplete === true, { timeoutMs: 30000, intervalMs: 200 });
  if (!(await waitUp())) throw new Error('server did not start: ' + serverErr.slice(-400));

  // ── Authentication (HTTP level) ─────────────────────────────────────────────
  check('auth: /health is public', (await raw('GET', '/health')).status === 200);
  check('auth: API without a session → 401', (await raw('GET', '/api/tomer/cases')).status === 401);
  check('auth: case operation without a session → 401', (await raw('POST', '/api/tomer/cases/x/resolve', { note: 'x' })).status === 401);
  check('auth: send endpoint without a session → 401', (await raw('POST', '/api/tomer/send-whatsapp', { phone: M1, message: 'x' })).status === 401);
  check('auth: simulate endpoint without a session → 401', (await raw('POST', '/api/whatsapp/simulate', { from: M1, text: 'x' })).status === 401);
  check('auth: store reset without a session → 401', (await raw('POST', '/api/store/reset', {})).status === 401);
  check('auth: dashboard HTML redirects to the login page', await (async () => { const r = await raw('GET', '/', null, { Accept: 'text/html' }); return r.status === 302 && r.headers.get('location') === '/login.html'; })());
  check('auth: dashboard script is not served without a session', (await raw('GET', '/app.js')).status === 401);
  check('auth: provider webhook path is not blocked by auth', (await raw('POST', '/api/green-api/webhook', { typeWebhook: 'stateInstanceChanged' })).status !== 401);
  check('auth: wrong password → 401', (await raw('POST', '/auth/login', { password: 'nope' })).status === 401);
  check('auth: nothing was sent to anyone during the unauthenticated attempts', sent.length === 0);
  {
    const lg = await raw('POST', '/auth/login', { password: PASSWORD });
    const cookies = lg.headers.getSetCookie().map(c => c.split(';')[0]);
    const sess = cookies.find(c => c.startsWith('ss_session=')), csrf = decodeURIComponent(cookies.find(c => c.startsWith('ss_csrf=')).split('=')[1]);
    const noTok = await raw('POST', '/api/tomer/cases/x/resolve', { note: 'x' }, { Cookie: sess });
    const evil  = await raw('POST', '/api/tomer/cases/x/resolve', { note: 'x' }, { Cookie: sess, 'X-CSRF-Token': csrf, Origin: 'https://evil.example' });
    const good  = await raw('POST', '/api/tomer/cases/x/resolve', { note: 'x' }, { Cookie: sess, 'X-CSRF-Token': csrf });
    check('auth: a session cookie without the CSRF token cannot change anything (403)', noTok.status === 403);
    check('auth: a request from another origin is rejected (403)', evil.status === 403);
    check('auth: cookie + CSRF token from this origin reaches the handler (404 for an unknown case)', good.status === 404, String(good.status));
    await raw('POST', '/auth/logout', null, { Cookie: sess });
    check('auth: after logout the same cookie is rejected (session revoked)', (await raw('GET', '/api/tomer/cases', null, { Cookie: sess })).status === 401);
  }

  // ── Cases from real member messages ─────────────────────────────────────────
  const say = (phone, text) => authed('POST', '/api/whatsapp/simulate', { from: phone, name: 'WA', text });
  const r1 = await say(M1, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
  const r2 = await say(M2, 'צריכה לדבר איתך בהקדם');
  mgr.mode = 'reject'; const r3 = await say(M3, 'לא הבנתי על מה חויבתי ועל איזה חודש');
  mgr.mode = 'error';  const r4 = await say(M4, 'אני מאוד מאוכזבת מהיחס בשיעור אתמול');
  check('setup: four member messages opened four cases', [r1, r2, r3, r4].every(r => r.route === 'tomer_case_opened'), JSON.stringify([r1.route, r2.route, r3.route, r4.route]));
  const api = async (q = 'open=1') => authed('GET', `/api/tomer/cases?${q}`);
  const byPhone = async p => (await api('')).cases.find(c => c.phone === p);
  const one = async id => (await authed('GET', `/api/tomer/cases/${id}`));
  const [c1, c2, c3, c4] = [await byPhone(M1), await byPhone(M2), await byPhone(M3), await byPhone(M4)];
  const toMgr = () => sent.filter(s => String(s.chatId ?? '').startsWith(TEST_MANAGER_PHONE));
  const toMember = p => sent.filter(s => String(s.chatId ?? '').startsWith(p));
  check('setup: notification states — accepted, accepted, failed (provider 400), uncertain (provider 500)',
    c1.notification.state === 'accepted' && c2.notification.state === 'accepted' && c3.notification.state === 'failed' && c4.notification.state === 'uncertain',
    JSON.stringify([c1, c2, c3, c4].map(c => c.notification.state)));
  check('manager got exactly ONE message per accepted case, and none for the two that did not go out', toMgr().length === 2);
  const alert1 = toMgr().find(s => s.message.includes(c1.id))?.message ?? '';
  const link1 = `${BASE}/#tomer/case/${c1.id}`;
  check('manager alert: member name, phone + WhatsApp link, request type, dates, "nothing changed in Arbox", link to the case',
    /דנה בדיקה/.test(alert1) && alert1.includes('0507100001') && alert1.includes(`https://wa.me/${M1}`) && /בקשת הקפאת מנוי/.test(alert1)
    && /01\.12\.2026 – 15\.12\.2026/.test(alert1) && /לא בוצע שום שינוי ב-Arbox/.test(alert1) && alert1.includes(link1), alert1);
  check('member reply: recorded for staff, explicitly NOT frozen, introduces Tomer once, no deadline',
    (() => { const t = toMember(M1).map(s => s.message).join('\n'); return /^אני תומר, העוזר הדיגיטלי של Shape Studio\./.test(t) && /רשמתי אותה לטיפול הצוות/.test(t) && /המנוי לא הוקפא/.test(t) && !/תוך|בהקדם|אעדכן/.test(t); })(), toMember(M1).map(s => s.message).join(' | '));

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
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
  async function click(selector) {
    const box = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!box || !box.w || !box.h) throw new Error('element not clickable: ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  async function type(selector, text) { await click(selector); await cdp('Input.insertText', { text }); }
  const until = (expr, timeoutMs = 10000) => waitFor(() => evalJs(expr), { timeoutMs });
  const q = s => JSON.stringify(s);
  const txt = sel => evalJs(`document.querySelector(${q(sel)})?.innerText ?? null`);
  const attr = (sel, a) => evalJs(`document.querySelector(${q(sel)})?.getAttribute(${q(a)}) ?? null`);
  const exists = sel => evalJs(`!!document.querySelector(${q(sel)})`);
  const counter = k => evalJs(`document.querySelector('#tw-case-counters [data-count="${k}"]')?.textContent ?? null`);
  const counters = async () => Object.fromEntries(await Promise.all(['open', 'awaiting_staff', 'in_progress', 'awaiting_member', 'resolved'].map(async k => [k, await counter(k)])));
  const card = id => `.tw-case-card[data-case="${id}"]`;
  const BODY = '#tw-case-body';
  const act = a => `${BODY} [data-act="${a}"]`;
  const flash = () => evalJs(`(() => { const e = document.getElementById('tw-cd-msg'); return e ? { text: e.textContent, kind: e.dataset.kind ?? null } : null; })()`);
  const flashed = (kind, re) => waitFor(async () => { const f = await flash(); return f && f.kind === kind && re.test(f.text) ? f : null; }, { timeoutMs: 10000 });
  const statusChip = () => attr('#tw-cd-status-chip', 'data-status-chip');
  const caseOpenIs = id => until(`!document.getElementById('tw-case-drawer').hidden && location.hash === '#tomer/case/${id}' && !!document.querySelector('#tw-cd-status-chip')`);
  async function openFromList(id) { await click(card(id)); return caseOpenIs(id); }

  // ── Manager deep link while logged out → login → the case ──────────────────
  await cdp('Page.navigate', { url: link1 });
  check('deep link (logged out): lands on the login page and keeps the case address', (await until(`location.pathname === '/login.html' && location.hash === '#tomer/case/${c1.id}' && !!document.getElementById('pw')`)) === true, await evalJs('location.href'));
  await type('#pw', 'wrong-password');
  await click('#go');
  check('login: wrong password shows an error and stays on the login page', (await until(`document.getElementById('err').textContent.includes('סיסמה שגויה')`, 8000)) === true);
  await evalJs(`(document.getElementById('pw').value = '', true)`);
  await type('#pw', PASSWORD);
  await click('#go');
  check('login: correct password opens the dashboard', (await until(`location.pathname === '/' && !!document.querySelector('.tab-btn[data-tab="tomer"]')`, 15000)) === true);
  check('deep link after login: the Tomer tab, the cases pane and THAT case are open', (await caseOpenIs(c1.id)) === true
    && (await evalJs(`document.querySelector('.tab-btn.active')?.dataset.tab === 'tomer' && document.querySelector('.tw-tab.active')?.dataset.pane === 'cases'`)) === true, JSON.stringify(pageErrors));
  check('session cookie is HttpOnly (not readable by page scripts)', (await evalJs(`document.cookie.includes('ss_session')`)) === false);
  check('page text never contains the password', !(await evalJs('document.documentElement.outerHTML')).includes(PASSWORD));

  // ── Case view: identity, request, notification, Arbox, conversation ─────────
  const d1 = await txt(BODY);
  check('case 1: member identity (name, Arbox id, phone, WhatsApp link)', /דנה בדיקה/.test(d1) && /מזהה Arbox 1/.test(d1) && d1.includes(M1) && (await attr(`${BODY} a[href="https://wa.me/${M1}"]`, 'href')) !== null, d1.slice(0, 300));
  check('case 1: category, priority, status, owner, created/updated, next action, id', /בקשת הקפאת מנוי/.test(await txt('#tw-case-title')) && /עדיפות רגילה/.test(d1) && (await statusChip()) === 'awaiting_staff'
    && /לא שויכה/.test(d1) && /נפתחה/.test(d1) && /עודכנה/.test(d1) && /הצעד הבא/.test(d1) && d1.includes(c1.id));
  check('case 1: the request with its dates, and the statement that the system does not change Arbox', /תאריכים מבוקשים\s*01\.12\.2026 – 15\.12\.2026/.test(d1) && /המערכת לא מבטלת ולא מקפיאה מנויים/.test(d1), d1);
  check('case 1: notification shown as "accepted by the provider" with its caveat; no retry button', (await attr(`${BODY} .tw-cd-notif`, 'data-notif')) === 'accepted' && /אינו אישור שההודעה נקראה/.test(d1) && !(await exists(act('retry-notification'))));
  check('case 1: Arbox data with source and read time', (await attr(`${BODY} .tw-cd-arbox`, 'data-arbox')) === 'ok' && /מנוי חודשי \(עד 2026-12-31\)/.test(d1) && /מקור: \/v3\/users\/memberships/.test(d1) && /נקרא ב-/.test(d1), d1);
  check('case 1: conversation shows the member\'s message and Tomer\'s reply, each labelled; Tomer is answering', (await evalJs(`[...document.querySelectorAll('${BODY} .tw-cd-msg')].map(e => e.dataset.who).join(',')`)) === 'member,tomer'
    && (await attr('#tw-cd-conv-owner', 'data-owner')) === 'tomer');
  check('case 1: no button for an action the system cannot perform (approve / execute / freeze / cancel)', (await evalJs(`[...document.querySelectorAll('${BODY} [data-act]')].map(b => b.dataset.act).sort().join(',')`)) === 'assign,refresh-arbox,reply,resolve,status,takeover');

  // ── Counters ────────────────────────────────────────────────────────────────
  check('counters: 4 open — all 4 awaiting staff, none in progress / awaiting member / resolved', JSON.stringify(await counters()) === JSON.stringify({ open: '4', awaiting_staff: '4', in_progress: '0', awaiting_member: '0', resolved: '0' }), JSON.stringify(await counters()));
  check('tab badge shows 4 open cases', (await evalJs(`document.getElementById('tw-badge-cases').textContent`)) === '4');
  check('list flags the two cases whose alert did not go out, and says so in the banner', (await attr(`${card(c3.id)} [data-notif]`, 'data-notif')) === 'failed' && (await attr(`${card(c4.id)} [data-notif]`, 'data-notif')) === 'uncertain'
    && /ב-2 פניות פתוחות ההתראה למנהל לא אושרה/.test(await txt('#tw-cases-alert')));
  check('urgent case (complaint) is listed first and marked', (await evalJs(`document.querySelector('.tw-case-card')?.dataset.case`)) === c4.id && /דחוף/.test(await txt(card(c4.id))));

  // ── Case 2: assign → reply as staff → held message → release → resolve ──────
  await click('#tw-case-close');
  check('closing the case returns to the list and clears the case address', (await until(`document.getElementById('tw-case-drawer').hidden && location.hash === '#tomer'`)) === true);
  check('clicking a case card opens it', (await openFromList(c2.id)) === true);
  await click(act('assign'));
  check('assign with no name: inline error, nothing changed', !!(await flashed('error', /יש לכתוב שם/)) && (await one(c2.id)).case.owner === 'tomer');
  await type('#tw-cd-owner', 'עדן');
  await click(act('assign'));
  check('assign: success message, status "בטיפול", owner shown', !!(await flashed('ok', /שויכה/)) && (await statusChip()) === 'in_progress' && (await txt('#tw-cd-owner-val')) === 'עדן');
  check('assign: persisted on the server with who did it', await (async () => { const c = (await one(c2.id)).case; return c.owner === 'עדן' && c.status === 'in_progress' && c.events.some(e => e.type === 'assigned' && e.by === 'עדן'); })());
  check('counters after assign: 3 awaiting staff, 1 in progress, still 4 open', await (async () => { const c = await counters(); return c.open === '4' && c.awaiting_staff === '3' && c.in_progress === '1'; })(), JSON.stringify(await counters()));

  await click(act('reply'));
  check('reply with no text: inline error, nothing sent', !!(await flashed('error', /יש לכתוב הודעה/)) && toMember(M2).length === 1);
  await type('#tw-cd-reply', 'היי נועה, מתקשרת אלייך עוד כמה דקות');
  await click('#tw-cd-await');
  await click(act('reply'));
  check('reply: success message says the provider accepted it and it was recorded as staff', !!(await flashed('ok', /התקבלה אצל ספק הוואטסאפ ונרשמה כהודעת צוות/)));
  check('reply: exactly that text reached the member — with no Tomer introduction', toMember(M2).at(-1)?.message === 'היי נועה, מתקשרת אלייך עוד כמה דקות' && toMember(M2).length === 2);
  check('reply: status "ממתין לחבר/ה"; conversation shows it as STAFF — עדן; the staff now own the conversation', (await statusChip()) === 'awaiting_member'
    && (await evalJs(`(() => { const m = [...document.querySelectorAll('${BODY} .tw-cd-msg')].at(-1); return m.dataset.who + '|' + m.querySelector('.tw-cd-who').textContent; })()`)).startsWith('staff|צוות — עדן')
    && (await attr('#tw-cd-conv-owner', 'data-owner')) === 'human');
  check('counters after reply: 1 awaiting member', (await counter('awaiting_member')) === '1' && (await counter('in_progress')) === '0');
  const n2 = toMember(M2).length;
  const held = await say(M2, 'תודה, אבל רציתי גם לשאול על הקפאה, אפשר?');
  check('takeover: Tomer is silent for this member (human owns the conversation)', held.route === 'human_owns_hold' && toMember(M2).length === n2, held.route);
  check('held message: appears on the case by itself (live update) — status back to "בטיפול", marked as new', (await until(`document.querySelector('#tw-cd-status-chip')?.dataset.statusChip === 'in_progress' && /רציתי גם לשאול על הקפאה/.test(document.querySelector('${BODY}').innerText) && /הודעה חדשה מהחבר\\/ה/.test(document.querySelector('${BODY} .tw-cd-top').innerText)`, 12000)) === true, await statusChip());

  await click(act('release'));
  check('release: success message; Tomer answers again', !!(await flashed('ok', /תומר חוזר לענות/)) && (await attr('#tw-cd-conv-owner', 'data-owner')) === 'tomer');
  const back = await say(M2, 'מה יש מחר?');
  check('after release Tomer replies to the member again', /^tomer_/.test(back.route) && back.route !== 'tomer_error' && toMember(M2).length === n2 + 1, back.route);
  await until(`!!document.querySelector(${q(act('takeover'))})`);
  await click(act('takeover'));
  check('takeover button: staff own the conversation again', !!(await flashed('ok', /תומר מושתק/)) && (await attr('#tw-cd-conv-owner', 'data-owner')) === 'human' && (await say(M2, 'ועוד שאלה, אפשר?')).route === 'human_owns_hold');
  await click(act('release'));
  await flashed('ok', /תומר חוזר לענות/);
  const rel2 = await authed('POST', `/api/tomer/cases/${c2.id}/release`, { by: 'עדן' });
  check('release is idempotent: a second release changes nothing', rel2.ok === true && rel2.unchanged === true && rel2.conversationOwner === 'tomer');

  await click(act('resolve'));
  check('resolve without a note: inline error, the case stays open', !!(await flashed('error', /יש לכתוב הערת סיכום/)) && (await one(c2.id)).case.status !== 'resolved');
  await type('#tw-cd-note', 'שוחחנו בטלפון, הכול הובהר');
  await click(act('resolve'));
  check('resolve: success message; status "נסגר"; the staff report is shown; no action forms remain', !!(await flashed('ok', /הפנייה נסגרה/)) && (await statusChip()) === 'resolved'
    && /דיווח הצוות: טופל — שוחחנו בטלפון, הכול הובהר \(עדן/.test(await txt(`${BODY} .tw-cd-resolution`)) && !(await exists(act('reply'))) && (await exists(act('reopen'))));
  check('counters after resolve: 3 open, 1 resolved', (await counter('open')) === '3' && (await counter('resolved')) === '1', JSON.stringify(await counters()));
  check('resolved case left the open list', (await until(`!document.querySelector('${card(c2.id)}') && document.querySelectorAll('.tw-case-card').length === 3`)) === true);
  check('server: resolution note, outcome and author persisted', await (async () => { const c = (await one(c2.id)).case; return c.status === 'resolved' && c.resolution.note === 'שוחחנו בטלפון, הכול הובהר' && c.resolution.outcome === 'handled' && c.resolution.by === 'עדן'; })());
  check('closing a case sent the member nothing', toMember(M2).length === n2 + 1);
  check('success / error toasts disappear by themselves', (await until(`document.querySelectorAll('.toast').length === 0`, 8000)) === true, String(await evalJs(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`)));
  await click('#tw-case-close');
  await click('#tw-case-counters [data-cf="resolved"]');
  check('"נסגרו" filter lists the resolved case', (await until(`document.querySelectorAll('.tw-case-card').length === 1 && !!document.querySelector('${card(c2.id)}')`)) === true);
  await click('#tw-case-counters [data-cf="awaiting_member"]');
  check('empty state: a filter with no cases says so (not an error, not a spinner)', (await until(`document.querySelector('#tw-cases-list [data-state="empty"]')?.textContent === 'אין פניות שממתינות לחבר/ה'`)) === true);
  await click('#tw-case-counters [data-cf="open"]');
  await until(`document.querySelectorAll('.tw-case-card').length === 3`);

  // ── Case 1 (membership freeze): staff report vs what Arbox shows ────────────
  await openFromList(c1.id);
  await click(act('refresh-arbox'));
  check('read-only Arbox check before any change: "Arbox לא מציג הקפאה"', !!(await flashed('ok', /הנתונים נקראו מ-Arbox/)) && (await attr(`${BODY} .tw-cd-check`, 'data-verified')) === 'false' && /Arbox לא מציג הקפאה/.test(await txt(`${BODY} .tw-cd-check`)));
  await click(act('resolve'));
  check('membership case: closing requires saying what was done', !!(await flashed('error', /יש לבחור מה נעשה/)));
  await evalJs(`(() => { const s = document.getElementById('tw-cd-outcome'); s.value = 'done_in_arbox'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  await type('#tw-cd-note', 'הוקפא ב-Arbox לפי הבקשה');
  await click(act('resolve'));
  await flashed('ok', /הפנייה נסגרה/);
  check('staff-reported completion and the Arbox check are shown separately: "דיווח הצוות: הצוות ביצע ב-Arbox" + "לא אומת"',
    (await attr(`${BODY} [data-staff-report]`, 'data-staff-report')) === 'done_in_arbox' && /דיווח הצוות: הצוות ביצע ב-Arbox — הוקפא ב-Arbox לפי הבקשה/.test(await txt(`${BODY} .tw-cd-resolution`))
    && (await attr(`${BODY} [data-arbox-verified]`, 'data-arbox-verified')) === 'false' && /אימות מול Arbox: לא אומת/.test(await txt(`${BODY} .tw-cd-resolution`)), await txt(`${BODY} .tw-cd-resolution`));
  arbox.state.holds.push({ user_id: 1, membership_user_id: 11, start_date: '2026-12-01', end_date: '2026-12-15' });   // staff really did it in Arbox
  await click(act('refresh-arbox'));
  check('once Arbox shows the hold, the check turns to "אומת ✓" — the staff report is unchanged', (await until(`document.querySelector('${BODY} [data-arbox-verified]')?.dataset.arboxVerified === 'true'`)) === true
    && /אימות מול Arbox: אומת ✓/.test(await txt(`${BODY} .tw-cd-resolution`)) && (await attr(`${BODY} [data-staff-report]`, 'data-staff-report')) === 'done_in_arbox');
  check('the system never wrote to Arbox, and the member was told nothing about a freeze', arbox.writes().length === 0 && toMember(M1).length === 1);
  arbox.mode.down = true;
  await click(act('refresh-arbox'));
  check('Arbox unavailable: error message and an explicit "no data" state — not stale success', !!(await flashed('error', /Arbox לא זמין כרגע/)) && (await attr(`${BODY} .tw-cd-arbox`, 'data-arbox')) === 'unavailable');
  arbox.mode.down = false;
  await click('#tw-case-close');

  // ── Notification retry: failed, then uncertain ─────────────────────────────
  await openFromList(c3.id);
  check('case 3: notification "failed" with the provider detail and a send button', (await attr(`${BODY} .tw-cd-notif`, 'data-notif')) === 'failed' && /provider rejected the request \(400\)/.test(await txt(BODY)) && (await exists(act('retry-notification'))));
  mgr.mode = 'reject';
  const mgrBefore = toMgr().length;
  await click(act('retry-notification'));
  check('retry while the provider still refuses: error shown, still "failed", attempts counted', !!(await flashed('error', /נכשלה שוב/)) && (await attr(`${BODY} .tw-cd-notif`, 'data-notif')) === 'failed' && (await one(c3.id)).case.notification.attempts === 2 && toMgr().length === mgrBefore);
  mgr.mode = 'ok';
  await click(act('retry-notification'));
  check('retry when the provider works: "accepted", the button is gone', !!(await flashed('ok', /ההתראה למנהל התקבלה/)) && (await attr(`${BODY} .tw-cd-notif`, 'data-notif')) === 'accepted' && !(await exists(act('retry-notification'))));
  check('the manager received exactly ONE alert for case 3, with its own link', toMgr().filter(s => s.message.includes(`#tomer/case/${c3.id}`)).length === 1 && toMgr().length === mgrBefore + 1);
  const again3 = await authed('POST', `/api/tomer/cases/${c3.id}/retry-notification`, {});
  check('a further retry of an accepted alert sends nothing', again3.unchanged === true && toMgr().length === mgrBefore + 1);
  await click('#tw-case-close');

  await openFromList(c4.id);
  check('case 4: notification "uncertain" — explains the duplicate risk; only a "send anyway" button', (await attr(`${BODY} .tw-cd-notif`, 'data-notif')) === 'uncertain' && /שליחה חוזרת עלולה ליצור התראה כפולה/.test(await txt(BODY))
    && (await exists(act('retry-notification-force'))) && !(await exists(act('retry-notification'))));
  const plain4 = await authed('POST', `/api/tomer/cases/${c4.id}/retry-notification`, {});
  check('uncertain: a plain retry is refused (needs explicit confirmation)', plain4.error === 'uncertain_needs_confirm' && toMgr().length === mgrBefore + 1);
  await click(act('retry-notification-force'));
  check('uncertain: the explicit "send anyway" sends one alert', !!(await flashed('ok', /ההתראה למנהל התקבלה/)) && toMgr().filter(s => s.message.includes(`#tomer/case/${c4.id}`)).length === 1);
  check('banner about unconfirmed alerts is gone once all are accepted', (await until(`document.getElementById('tw-cases-alert').hidden === true`)) === true);
  await click('#tw-case-close');

  // ── Error states ────────────────────────────────────────────────────────────
  await cdp('Network.setBlockedURLs', { urls: ['*/api/tomer/cases*'] });
  await click('#tw-refresh');
  check('list cannot be loaded: an error with a retry button — and the counters show "—", never 0', (await until(`!!document.querySelector('#tw-cases-list [data-state="error"] #tw-cases-retry') && document.querySelector('#tw-case-counters [data-count="open"]').textContent === '—'`)) === true, JSON.stringify(await counters()));
  await cdp('Network.setBlockedURLs', { urls: [] });
  await click('#tw-cases-retry');
  check('retry reloads the list and the real counters', (await until(`document.querySelectorAll('.tw-case-card').length === 2 && document.querySelector('#tw-case-counters [data-count="open"]').textContent === '2'`)) === true, JSON.stringify(await counters()));
  await evalJs(`(location.hash = '#tomer/case/case-does-not-exist', true)`);
  check('a link to a case that does not exist says so', (await until(`/הפנייה לא נמצאה/.test(document.querySelector('${BODY} [data-state="error"]')?.textContent ?? '')`)) === true);
  await click('#tw-case-close');

  // ── Today view uses the same numbers ────────────────────────────────────────
  await click('.tw-tab[data-pane="today"]');
  check('"היום": case counters match the cases pane (1 urgent, 1 awaiting staff, 1 in progress… as stored)', (await until(`/^\\d+$/.test(document.getElementById('twk-await').textContent)`)) === true
    && await (async () => { const k = (await api()).counts; return (await txt('#twk-high')) === String(k.high) && (await txt('#twk-await')) === String(k.awaiting_staff) && (await txt('#twk-open')) === String(k.in_progress) && (await txt('#twk-member')) === String(k.awaiting_member) && (await txt('#twk-failed')) === '0'; })());

  // ── Restart: persisted state, same counters, nothing replayed ──────────────
  const sentBefore = sent.length, before = (await api()).counts;
  killTree(server.pid);
  await waitFor(async () => { try { await raw('GET', '/health'); return false; } catch { return true; } }, { timeoutMs: 10000, intervalMs: 200 });
  server = startServer();
  if (!(await waitUp())) throw new Error('server did not restart: ' + serverErr.slice(-400));
  await new Promise(r => setTimeout(r, 1500));
  const after = (await api()).counts;
  check('restart: counters are identical', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
  check('restart: no alert and no member message was replayed', sent.length === sentBefore);
  check('restart: case states persisted (resolution, staff report, Arbox check, notification, owner)', await (async () => {
    const [a, b, c] = [(await one(c1.id)).case, (await one(c2.id)).case, (await one(c3.id)).case];
    return a.status === 'resolved' && a.resolution.outcome === 'done_in_arbox' && a.arboxCheck !== null && b.status === 'resolved' && b.owner === 'עדן' && c.notification.state === 'accepted';
  })());
  await cdp('Page.navigate', { url: `${BASE}/#tomer/case/${c2.id}` });
  check('restart: the browser session is still valid and the deep link opens the persisted case', (await caseOpenIs(c2.id)) === true && (await statusChip()) === 'resolved'
    && /שוחחנו בטלפון, הכול הובהר/.test(await txt(`${BODY} .tw-cd-resolution`)) && (await counter('resolved')) === '2');
  check('restart: the conversation is shown with the staff message still attributed to staff', (await evalJs(`[...document.querySelectorAll('${BODY} .tw-cd-msg')].some(e => e.dataset.who === 'staff' && /מתקשרת אלייך/.test(e.innerText))`)) === true);

  if (shotFile) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
    console.log(`  screenshot: ${shotFile}`);
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
  const cookieBefore = (await cdp('Network.getCookies', { urls: [BASE] })).cookies.find(c => c.name === 'ss_session')?.value;
  await click('#tw-case-close');
  await click('#btn-logout');
  check('logout: back on the login page', (await until(`location.pathname === '/login.html'`)) === true);
  check('logout: the session that was in the browser no longer works', !!cookieBefore && (await raw('GET', '/api/tomer/cases', null, { Cookie: `ss_session=${cookieBefore}` })).status === 401);
  await cdp('Page.navigate', { url: `${BASE}/` });
  check('logout: the dashboard asks for the password again', (await until(`location.pathname === '/login.html' && !!document.getElementById('pw')`)) === true);

  check('disk: the password is not stored anywhere in the data directory', !['service_cases.json', 'auth_sessions.json', 'leads_persist.json'].some(f => { try { return readFileSync(path.join(dataDir, f), 'utf8').includes(PASSWORD); } catch { return false; } }));
  check('browser: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
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
