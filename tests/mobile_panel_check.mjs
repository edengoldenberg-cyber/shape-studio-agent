#!/usr/bin/env node
/**
 * mobile_panel_check.mjs — the dashboard on a PHONE-SIZED screen (Barak, Tomer, WhatsApp inbox, shared screens).
 *
 * This is browser EMULATION (headless Chrome with a mobile viewport and touch input), NOT a real device: it proves
 * layout, touch reachability and refresh behaviour, not what a specific phone's browser or keyboard does.
 *
 * Isolated server (fresh temp DATA_DIR, loopback WhatsApp-provider mock, loopback Arbox stand-in, invented data).
 * For each of 360 / 390 / 430 px it walks the full path on both panels with TOUCH events:
 *   Barak: callback list → the row of a hand-arranged callback → "approve and send summary" form (name + reminder)
 *          → a refresh arrives while the draft is typed → send → result shown; reschedule draft + save
 *   Tomer: cases list → a case → details → a staff reply typed → a live update arrives → send → result shown;
 *          staff tasks (cards + details dialog); the other panes
 *   WhatsApp inbox: thread list → a thread → a draft → an inbound message from someone else
 * and asserts, on every screen: no horizontal page scroll, nothing wider than the screen, every visible control at
 * least 44×44 px, no clipped text, drafts / open panels / scroll position / the selected client survive a refresh,
 * and the focused field stays visible when the viewport shrinks as it does under an on-screen keyboard.
 * One desktop pass (1366×768) confirms the wide layout is still the wide layout.
 *
 * Usage:  node tests/mobile_panel_check.mjs [--shots <dir>] [--widths 360,390,430]
 * Requires Google Chrome or Microsoft Edge installed locally. No npm dependencies.
 */
import { spawn, spawnSync } from 'child_process';
import { createServer }     from 'http';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir }           from 'os';
import path                 from 'path';

const require = createRequire(import.meta.url);
const { createIsolatedDataDir, removeDir, isolatedChildEnv, freePort, waitFor, TEST_MANAGER_PHONE } = require('./helpers/isolated_env.cjs');
const { createArboxMock } = require('./helpers/arbox_mock.cjs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const argOf = k => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : null; };
const shotDir = argOf('shots') ?? path.join(root, '.claude', 'mobile-shots');
const WIDTHS = (argOf('widths') ?? '360,390,430').split(',').map(Number).filter(Boolean);
mkdirSync(shotDir, { recursive: true });

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

// invented people: members (Arbox stand-in) and leads
const MEMBERS = ['972507200001', '972507200002', '972507200003', '972507200004', '972507200005'];
const LEAD_PLAIN = '972587800001';
const LEAD_HAND  = { 360: '972587800011', 390: '972587800012', 430: '972587800013', 1366: '972587800014' };
const LEAD_EXTRA = { 360: '972587800021', 390: '972587800022', 430: '972587800023', 1366: '972587800024' };
const dataDir    = createIsolatedDataDir('shape-mobile-');
writeFileSync(path.join(dataDir, 'known_members.json'), JSON.stringify({ phones: MEMBERS, names: {} }));
const profileDir = mkdtempSync(path.join(tmpdir(), 'shape-mobile-chrome-'));
const sent = [];
const arbox = createArboxMock();
let green, ws;

try {
  const [appPort, greenPort, dbgPort] = [await freePort(), await freePort(), await freePort()];
  const BASE = `http://127.0.0.1:${appPort}`;
  green = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      try { sent.push(JSON.parse(b)); } catch { /* not json */ }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ idMessage: `3EB0MOCK${sent.length}` }));
    });
  });
  await new Promise(r => green.listen(greenPort, '127.0.0.1', r));
  const arboxUrl = await arbox.listen();
  [['דנה', '050-7200001'], ['נועה', '0507200002'], ['מיכל', '0507200003'], ['רותם', '0507200004'], ['שירה', '0507200005']].forEach(([first, phone], i) => {
    arbox.state.users.push({ user_id: i + 1, first_name: first, last_name: 'בדיקה', phone, user_role: 'client', active: 1, gender: 'female' });
    arbox.state.memberships.push({ membership_user_id: 11 + i, user_id: i + 1, membership_type_name: 'מנוי חודשי פילאטיס מכשירים', type: 'plan', debt: 0, start_time: '2026-10-01', end_time: '2026-12-31', active: 1, cancelled: 0 });
  });

  let serverErr = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: isolatedChildEnv(dataDir, {
      PORT: String(appPort), TEST_MODE: 'true', WHATSAPP_AUTO_REPLY: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
      GREEN_API_URL: `127.0.0.1:${greenPort}`, GREEN_API_ID_INSTANCE: '9990001', GREEN_API_TOKEN_INSTANCE: 'mock-panel',
      ARBOX_BASE_URL: arboxUrl, ARBOX_CLIENT_ID: 'mock', ARBOX_LOCATION_ID: '1', ARBOX_MIN_GAP_MS: '0', ARBOX_TIMEOUT_MS: '1500',
      TEST_ALLOWLIST_PHONES: [TEST_MANAGER_PHONE, ...MEMBERS, LEAD_PLAIN, ...Object.values(LEAD_HAND), ...Object.values(LEAD_EXTRA)].join(','),
      BACKEND_URL: BASE,
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(server);
  server.stderr.on('data', d => { serverErr += d.toString(); });
  const http = async (method, url, body) => (await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
  if (!(await waitFor(async () => (await http('GET', '/health')).startupComplete === true, { timeoutMs: 30000, intervalMs: 200 }))) throw new Error('server did not start: ' + serverErr.slice(-400));

  let msgSeq = 0;
  const say = (phone, text, name = 'WA') => http('POST', '/api/whatsapp/simulate', { from: phone, name, text, messageId: `m-${++msgSeq}` });
  /** A message typed by hand on the studio phone (the provider's outgoing webhook): the chat becomes human-owned. */
  const staffTypes = async (phone, text) => {
    const chatId = `${phone}@c.us`;
    await http('POST', '/api/green-api/webhook', { typeWebhook: 'outgoingMessageReceived', instanceData: { idInstance: 9990001, wid: '972500000000@c.us' }, timestamp: Math.floor(Date.now() / 1000),
      idMessage: `2A${(++msgSeq).toString(16).toUpperCase().padStart(8, '0')}FF`, senderData: { chatId, sender: chatId, senderName: 'Staff' }, messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } } });
    await new Promise(r => setTimeout(r, 120));
  };
  const rowsApi = async () => (await http('GET', '/api/barak/callbacks')).callbacks ?? [];
  const cases = async () => (await http('GET', '/api/tomer/cases')).cases ?? [];

  // ── invented data ───────────────────────────────────────────────────────────
  for (const t of ['היי, מתעניינת בפילאטיס מכשירים', 'אשמח שיחזרו אליי', 'מחרתיים ב-10:30', 'דנה']) await say(LEAD_PLAIN, t, 'דנה כהן-לוי');
  for (const w of [...WIDTHS, 1366]) {
    await say(LEAD_HAND[w], 'היי, כמה עולה מנוי לפילאטיס מכשירים פעמיים בשבוע?', 'יעל אברהמי');
    await staffTypes(LEAD_HAND[w], 'מתי יהיה לך נוח שניצור קשר?');
    await say(LEAD_HAND[w], 'מחר אני פנויה בין 14:00-16:00', 'יעל אברהמי');
  }
  await say(MEMBERS[0], 'רוצה להקפיא את המנוי מ-1.12 עד 15.12 כי אני נוסעת לחופשה ארוכה עם המשפחה');
  for (let i = 1; i <= 4; i++) await say(MEMBERS[i], 'צריכה לדבר איתך בהקדם לגבי השיעורים של השבוע הבא ושינוי במערכת');
  await http('POST', '/api/tomer/tasks', { phone: MEMBERS[0], action: 'class_change', memberName: 'דנה בדיקה', detail: 'בקשה: מעבר מ-18:00 ל-17:00 היום\nרישום קיים (Arbox): פילאטיס מכשירים 18:00\nשיעור מבוקש (Arbox): פילאטיס מכשירים 17:00 — 5/8 רשומים, 3 פנויים\nלמה זה אצל הצוות: ביטול מאוחר' });
  await http('POST', '/api/tomer/tasks', { phone: MEMBERS[1], action: 'voice_message', memberName: 'נועה בדיקה', detail: 'ההודעה הקולית לא תומללה: תוכן הבקשה אינו ידוע.\nנדרש: להאזין בוואטסאפ ולענות.' });
  const setup = { rows: await rowsApi(), cases: await cases() };
  check('setup: callback rows (1 regular + one hand-arranged per width) and 5 member cases exist', setup.rows.length === WIDTHS.length + 2 && setup.cases.length === 5,
    JSON.stringify({ rows: setup.rows.map(r => [r.fullPhone, r.stage, r.humanOwned]), cases: setup.cases.length }));

  // ── browser ─────────────────────────────────────────────────────────────────
  const chrome = spawn(browserBin, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' });
  children.push(chrome);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()).find(t => t.type === 'page'), { timeoutMs: 20000, intervalMs: 200 });
  if (!target) throw new Error('browser did not expose a page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(); const pageErrors = []; const dialogs = []; let onPaused = null;
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown');
    if (m.method === 'Fetch.requestPaused' && onPaused) onPaused(m.params);
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); }
  };
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  async function evalJs(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  }
  await cdp('Page.enable'); await cdp('Runtime.enable');
  const q = s => JSON.stringify(s);
  const until = (expr, timeoutMs = 10000) => waitFor(() => evalJs(expr), { timeoutMs });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let touch = true, curW = 0;
  async function setViewport(width, height, mobile = true) {
    touch = mobile; curW = width;
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
    if (mobile) await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
  }
  /** A real tap (touch events) — or a mouse click on the desktop pass — at the element's on-screen centre. The element must be inside the viewport after scrolling to it. */
  async function tap(selector) {
    const box = await evalJs(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })()`);
    if (!box || !box.w || !box.h) throw new Error('element not tappable: ' + selector);
    if (box.x < 0 || box.x > box.vw || box.y < 0 || box.y > box.vh) throw new Error(`element centre is outside the screen: ${selector} ${JSON.stringify(box)}`);
    const top = await evalJs(`(() => { const e = document.querySelector(${q(selector)}); const t = document.elementFromPoint(${box.x}, ${box.y}); return !!t && (e === t || e.contains(t) || t.contains(e)); })()`);
    if (!top) throw new Error('element is covered by something else at its centre: ' + selector);
    if (touch) {
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(60);
  }
  async function type(selector, text) { await tap(selector); await cdp('Input.insertText', { text }); }
  async function shot(name, full = false) {
    await sleep(450);                                   // let the tap highlight and transitions finish
    const s = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
    writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(s.data, 'base64'));
  }

  /**
   * What a thumb and an eye would trip over on the screen as rendered now (visible elements only):
   *   hscroll   the page scrolls sideways
   *   off       an element reaches outside the screen's width
   *   small     a control smaller than 44×44 (a checkbox / radio is measured by its label)
   *   clipped   text cut by overflow:hidden without an ellipsis
   *   cut       text or a control that a clipping ancestor (overflow hidden) cuts off at the side
   * The width is the DEVICE width that was set, not innerWidth: a phone browser widens its layout viewport (and shrinks
   * the page) when content overflows, which would hide exactly the defect this looks for.
   */
  const auditExpr = () => `(() => {
    const vw = ${curW}, out = { vw, layoutW: innerWidth, docW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), off: [], small: [], clipped: [], tiny: [], cut: [] };
    const clipper = e => { for (let p = e.parentElement; p && p !== document.documentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'hidden' || o === 'clip') { const a = p.getBoundingClientRect(), r = e.getBoundingClientRect(); if (r.left < a.left - 1.5 || r.right > a.right + 1.5) return p; } else if (o === 'auto' || o === 'scroll') return null; } return null; };
    const vis = e => { if (!e.getClientRects().length) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
      for (let p = e; p; p = p.parentElement) { if (p.hidden) return false; } const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const id = e => (e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + ' "' + (e.innerText || e.value || e.placeholder || e.title || '').trim().slice(0, 24) + '"');
    // clipped inside a scroll container (a sideways-scrolling strip) is not off-screen: only what the PAGE cannot show counts
    const inScroller = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
    for (const e of document.querySelectorAll('body *')) {
      if (!vis(e) || e.closest('iframe')) continue;
      const r = e.getBoundingClientRect();
      if ((r.left < -1 || r.right > vw + 1) && !inScroller(e)) out.off.push(id(e) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
      const cs = getComputedStyle(e);
      const ownText = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (ownText && /hidden|clip/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.clipped.push(id(e));
      if (ownText && parseFloat(cs.fontSize) < 11) out.tiny.push(id(e) + ' ' + cs.fontSize);
      if ((ownText || e.matches('button, input, select, textarea, a[href]')) && clipper(e)) out.cut.push(id(e));
    }
    for (const e of document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"], [onclick], label[for]')) {
      if (!vis(e) || e.type === 'hidden') continue;
      let t = e; if (e.matches('input[type="checkbox"], input[type="radio"]')) t = e.closest('label') || (e.id && document.querySelector('label[for="' + e.id + '"]')) || e;
      if (e.matches('label[for]')) continue;
      const r = t.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) out.small.push(id(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return out;
  })()`;
  async function audit(label, { allow = [] } = {}) {
    const a = await evalJs(auditExpr());
    const keep = list => list.filter(x => !allow.some(re => re.test(x)));
    check(`${label}: no horizontal page scroll`, a.docW <= a.vw + 1 && a.layoutW <= a.vw + 1, `document ${a.docW}px, layout viewport ${a.layoutW}px on a ${a.vw}px screen`);
    check(`${label}: nothing is cut off at the side by its container`, keep(a.cut).length === 0, `${keep(a.cut).length}: ` + keep(a.cut).slice(0, 6).join(' | '));
    check(`${label}: nothing reaches outside the screen`, keep(a.off).length === 0, keep(a.off).slice(0, 6).join(' | '));
    check(`${label}: every control is at least 44×44`, keep(a.small).length === 0, `${keep(a.small).length}: ` + keep(a.small).slice(0, 8).join(' | '));
    check(`${label}: no clipped text`, keep(a.clipped).length === 0, keep(a.clipped).slice(0, 6).join(' | '));
    check(`${label}: no text under 11px`, keep(a.tiny).length === 0, `${keep(a.tiny).length}: ` + keep(a.tiny).slice(0, 6).join(' | '));
    return a;
  }
  /** The on-screen keyboard takes roughly the lower half of the screen: with the viewport that short, the focused field must still be visible. */
  async function keyboardCheck(label, W, H, fieldSel, saveSel) {
    await setViewport(W, Math.round(H * 0.45));
    await sleep(350);
    const r = await evalJs(`(() => { const f = document.querySelector(${q(fieldSel)}), s = document.querySelector(${q(saveSel)}); const fr = f.getBoundingClientRect();
      const top = document.elementFromPoint(fr.left + fr.width / 2, fr.top + Math.min(fr.height, 30) / 2);
      s.scrollIntoView({ block: 'center' }); const sr = s.getBoundingClientRect(); const st = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
      return { focused: document.activeElement === f, fieldVisible: fr.top >= 0 && fr.top + Math.min(fr.height, 30) <= innerHeight && !!top && (top === f || f.contains(top)), saveReachable: sr.top >= 0 && sr.bottom <= innerHeight && !!st && (st === s || s.contains(st)), fr: [Math.round(fr.top), Math.round(fr.bottom)], vh: innerHeight }; })()`);
    check(`${label}: with the keyboard open the focused field is still visible and the save button can be reached`, r.focused && r.fieldVisible && r.saveReachable, JSON.stringify(r));
    await setViewport(W, H);
    await sleep(200);
  }
  const rowSel = phone => `.callback-row[data-phone="${phone}"]`;
  const msgBar = () => evalJs(`(() => { const m = document.getElementById('barak-callbacks-msg'); return m && m.style.display !== 'none' ? m.textContent : ''; })()`);
  const tabIs = t => evalJs(`document.querySelector('.tab-btn.active')?.dataset.tab === ${q(t)}`);
  const goTab = async t => { await tap(`.tab-btn[data-tab="${t}"]`); await until(`document.querySelector('.tab-btn.active')?.dataset.tab === ${q(t)}`); await sleep(350); };

  for (const W of WIDTHS) {
    const H = W === 360 ? 740 : W === 390 ? 844 : 932;
    console.log(`\n── ${W}px (emulated phone, touch) ──`);
    await setViewport(W, H);

    // ── login page ────────────────────────────────────────────────────────────
    await cdp('Page.navigate', { url: `${BASE}/login.html` });
    await until(`!!document.getElementById('pw')`);
    await audit(`${W} login`);
    await shot(`login-${W}`);

    // ── Barak ─────────────────────────────────────────────────────────────────
    await cdp('Page.navigate', { url: `${BASE}/#barak` });
    check(`${W} barak: the tab opens from its link and the callback rows are rendered`, (await until(`document.querySelectorAll('.callback-row').length >= ${WIDTHS.length + 1} && document.querySelector('.tab-btn.active')?.dataset.tab === 'barak'`, 20000)) === true);
    await sleep(400);
    await evalJs(`(document.getElementById('barak-callbacks-panel').scrollIntoView({ block: 'start' }), true)`);
    await audit(`${W} barak list`);
    await shot(`barak-${W}-1-callbacks`);
    await shot(`barak-${W}-1-full`, true);
    const hand = LEAD_HAND[W], apt = (await rowsApi()).find(r => r.fullPhone === hand).apt;
    const tRow = await evalJs(`document.querySelector(${q(rowSel(hand))})?.innerText ?? ''`);
    check(`${W} barak: the hand-arranged row shows name, phone, the RANGE of hours, stage and who owns the chat — nothing is hidden`, /יעל|שם/.test(tRow) && tRow.includes('0' + hand.slice(3)) && /14:00/.test(tRow) && /16:00/.test(tRow) && /בטיפול אנושי/.test(tRow) && /טווח שעות/.test(tRow), tRow.replace(/\s+/g, ' ').slice(0, 300));
    check(`${W} barak: what is a tooltip on a desktop (manager summary / staff reminder state) is written out`, /סיכום למנהל/.test(tRow) && /תזכורת לצוות/.test(tRow), tRow.replace(/\s+/g, ' ').slice(0, 300));

    await tap(`${rowSel(hand)} button[data-cb-action="owner-summary"]`);
    check(`${W} barak: "אשר ושלח סיכום" opens its form inside the row`, (await until(`getComputedStyle(document.getElementById('cb-owner-${apt.id}')).display !== 'none'`, 4000)) === true);
    await evalJs(`(document.getElementById('cb-owner-name-${apt.id}').value = '', true)`);
    await type(`#cb-owner-name-${apt.id}`, 'יעלי');
    await tap(`label[for="cb-owner-rem-${apt.id}"], #cb-owner-${apt.id} label`);      // reminder off …
    await tap(`label[for="cb-owner-rem-${apt.id}"], #cb-owner-${apt.id} label`);      // … and on again, by touch
    check(`${W} barak: the reminder checkbox answers to touch`, (await evalJs(`document.getElementById('cb-owner-rem-${apt.id}').checked`)) === true);
    await audit(`${W} barak summary form`);
    await shot(`barak-${W}-2-summary-form`);
    await tap(`#cb-owner-name-${apt.id}`);
    await keyboardCheck(`${W} barak summary form`, W, H, `#cb-owner-name-${apt.id}`, `${rowSel(hand)} button[data-cb-action="owner-summary-send"]`);

    // a refresh with CHANGED data arrives while the draft is on the screen (another lead asks for a call)
    await evalJs(`(document.getElementById('cb-owner-name-${apt.id}').blur(), document.querySelector(${q(rowSel(hand))}).scrollIntoView({ block: 'center' }), true)`);
    const y0 = await evalJs('Math.round(scrollY)');
    for (const t of ['היי, מתעניין באימוני כוח', 'אפשר שיחת טלפון?']) await say(LEAD_EXTRA[W], t, 'אבי');
    await evalJs('loadBarakPanel().then(() => true)');
    await sleep(5600);                                                                // and the 5-second timer fires too
    const kept = await evalJs(`({ rows: document.querySelectorAll('.callback-row').length, name: document.getElementById('cb-owner-name-${apt.id}')?.value, open: getComputedStyle(document.getElementById('cb-owner-${apt.id}')).display !== 'none', rem: document.getElementById('cb-owner-rem-${apt.id}')?.checked, y: Math.round(scrollY) })`);
    check(`${W} barak: the refresh brought the new row AND kept the typed name, the open form and the checkbox`, kept.name === 'יעלי' && kept.open && kept.rem === true && (await evalJs(`!!document.querySelector(${q(rowSel(LEAD_EXTRA[W]))})`)), JSON.stringify(kept));
    check(`${W} barak: the refresh did not move the page`, Math.abs(kept.y - y0) <= 2, `${y0} → ${kept.y}`);

    const before = sent.length;
    await tap(`${rowSel(hand)} button[data-cb-action="owner-summary-send"]`);
    check(`${W} barak: the result of the send is shown in the panel`, (await waitFor(async () => /הסיכום נשלח ללקוח/.test(await msgBar()), { timeoutMs: 8000 })) === true, await msgBar());
    const after = (await rowsApi()).find(r => r.fullPhone === hand);
    check(`${W} barak: server — ONE summary went to that lead with the range, the chat is still human-owned, the reminder is approved`,
      sent.slice(before).filter(p => p.chatId === `${hand}@c.us`).length === 1 && /14:00/.test(sent.slice(before).find(p => p.chatId === `${hand}@c.us`)?.message ?? '') && after.humanOwned === true && after.apt.prospectSummarySent && !!after.apt.ownerApproved?.reminder,
      JSON.stringify({ n: sent.slice(before).length, humanOwned: after.humanOwned, apt: { s: after.apt.prospectSummarySent, o: after.apt.ownerApproved } }));
    const msgVisible = await evalJs(`(() => { const m = document.getElementById('barak-callbacks-msg'); const r = m.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
    check(`${W} barak: the result message is on the screen where the action was taken (not scrolled away)`, msgVisible === true);
    await shot(`barak-${W}-3-summary-sent`);
    const tRow2 = await evalJs(`document.querySelector(${q(rowSel(hand))})?.innerText ?? ''`);
    check(`${W} barak: the row now says the summary was sent and the reminder is scheduled`, /סיכום נשלח ללקוח/.test(tRow2) && /תזכורת ללקוח\/ה מאושרת/.test(tRow2), tRow2.replace(/\s+/g, ' ').slice(0, 300));

    // reschedule on the regular row: draft, save, result
    const aptP = (await rowsApi()).find(r => r.fullPhone === LEAD_PLAIN).apt;
    await tap(`${rowSel(LEAD_PLAIN)} button[data-cb-action="reschedule"]`);
    await type(`#cb-resched-input-${aptP.id}`, `מחרתיים ב-1${WIDTHS.indexOf(W) + 1}:00`);
    await evalJs('loadBarakPanel().then(() => true)');
    check(`${W} barak: a reschedule draft survives a refresh`, (await evalJs(`document.getElementById('cb-resched-input-${aptP.id}')?.value`)) === `מחרתיים ב-1${WIDTHS.indexOf(W) + 1}:00`);
    await audit(`${W} barak reschedule form`);
    await shot(`barak-${W}-4-reschedule`);
    await tap(`${rowSel(LEAD_PLAIN)} button[data-cb-action="reschedule-save"]`);
    check(`${W} barak: rescheduled — result shown and the row carries the new time`, (await waitFor(async () => /המועד עודכן/.test(await msgBar()) && new RegExp(`בשעה 1${WIDTHS.indexOf(W) + 1}:00`).test(await evalJs(`document.querySelector(${q(rowSel(LEAD_PLAIN))}).innerText`)), { timeoutMs: 8000 })) === true, await msgBar());
    // the assign action must not need a native prompt
    await tap(`${rowSel(LEAD_PLAIN)} button[data-cb-action="assign"]`);
    check(`${W} barak: "נציג" opens an inline choice, not a browser prompt`, dialogs.length === 0 && (await until(`!!document.querySelector(${q(rowSel(LEAD_PLAIN) + ' [data-cb-action="assign-save"]')})`, 3000)) === true, dialogs.join('|'));
    await tap(`${rowSel(LEAD_PLAIN)} button[data-cb-action="assign"]`);

    // leads table as cards
    await evalJs(`(document.getElementById('barak-view-pipeline').scrollIntoView({ block: 'start' }), true)`);
    const cardInfo = await evalJs(`(() => { const tr = document.querySelector('#barak-leads-tbody tr'); if (!tr) return null; const tds = [...tr.children]; return { display: getComputedStyle(tr).display, labelled: tds.every(td => 'label' in td.dataset) && tds.filter(td => td.dataset.label).length >= 8, thead: getComputedStyle(document.querySelector('#barak-view-pipeline thead')).display, text: tr.innerText.replace(/\\s+/g, ' ').slice(0, 200) }; })()`);
    check(`${W} barak: the leads table is shown as cards with every column labelled`, cardInfo && cardInfo.display !== 'table-row' && cardInfo.labelled && cardInfo.thead === 'none', JSON.stringify(cardInfo));
    await audit(`${W} barak leads cards`);
    await shot(`barak-${W}-5-leads`);
    for (const v of ['memberships', 'attendance', 'staff', 'retention', 'arbox-leads', 'schedule', 'sync']) {
      await tap(`.barak-sv-btn[data-bview="${v}"]`); await sleep(500);
      const a = await evalJs(auditExpr());
      check(`${W} barak/${v}: fits the screen`, a.docW <= a.vw + 1 && a.layoutW <= a.vw + 1 && a.off.length === 0 && a.cut.length === 0, `doc ${a.docW}/${a.layoutW}; ` + [...a.off, ...a.cut].slice(0, 4).join(' | '));
      check(`${W} barak/${v}: controls are at least 44×44`, a.small.length === 0, `${a.small.length}: ` + a.small.slice(0, 6).join(' | '));
    }
    await tap(`.barak-sv-btn[data-bview="pipeline"]`);

    // ── Tomer ─────────────────────────────────────────────────────────────────
    await goTab('tomer');
    await audit(`${W} tomer today`);
    await shot(`tomer-${W}-0-today`);
    await tap('.tw-tab[data-pane="cases"]');
    check(`${W} tomer: the cases list is rendered`, (await until(`document.querySelectorAll('.tw-case-card').length === 5`)) === true);
    await sleep(300);
    await audit(`${W} tomer cases`);
    await shot(`tomer-${W}-1-cases`);
    const member = MEMBERS[1 + WIDTHS.indexOf(W)], other = MEMBERS[4];
    const cs = (await cases()).find(c => c.phone === member), csFreeze = (await cases()).find(c => c.phone === MEMBERS[0]);
    await tap(`.tw-case-card[data-case="${csFreeze.id}"]`);
    check(`${W} tomer: a case opens over the list`, (await until(`!document.getElementById('tw-case-drawer').hidden && !!document.querySelector('#tw-cd-status-chip')`)) === true);
    const panel = await evalJs(`(() => { const r = document.querySelector('.tw-case-panel').getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight }; })()`);
    check(`${W} tomer: the case panel is inside the screen`, panel.l >= 0 && panel.r <= panel.vw && panel.t >= 0 && panel.b <= panel.vh, JSON.stringify(panel));
    const d1 = await evalJs(`document.getElementById('tw-case-body').innerText`);
    check(`${W} tomer: member details — name, Arbox id, phone, request dates, notification, Arbox data, conversation`, /דנה בדיקה/.test(d1) && /מזהה Arbox 1/.test(d1) && d1.includes(MEMBERS[0]) && /01\.12\.2026 – 15\.12\.2026/.test(d1) && /התראה למנהל/.test(d1) && /מנוי חודשי/.test(d1) && /השיחה עם החבר\/ה/.test(d1), d1.replace(/\s+/g, ' ').slice(0, 300));
    await audit(`${W} tomer case details`);
    await shot(`tomer-${W}-2-case-details`);
    await tap('#tw-case-close');
    await until(`document.getElementById('tw-case-drawer').hidden`);

    await tap(`.tw-case-card[data-case="${cs.id}"]`);
    await until(`!document.getElementById('tw-case-drawer').hidden && !!document.getElementById('tw-cd-reply')`);
    await type('#tw-cd-reply', 'היי, מתקשרת אלייך עוד כמה דקות');
    await keyboardCheck(`${W} tomer case reply`, W, H, '#tw-cd-reply', '#tw-case-body [data-act="reply"]');
    await evalJs(`(document.getElementById('tw-cd-reply').blur(), document.querySelector('#tw-case-body details').open = true, true)`);
    const sc0 = await evalJs(`(() => { const b = document.querySelector('.tw-case-panel'); const s = [b, document.getElementById('tw-case-body')].find(x => x.scrollHeight > x.clientHeight + 4) || b; s.scrollTop = 260; return Math.round(s.scrollTop); })()`);
    await say(other, `ועוד שאלה לגבי החניה ליד הסטודיו ${W}`);                       // a live update for ANOTHER case
    await say(member, 'תודה, מחכה');                                                 // and one for the open case
    await sleep(1800);
    const keptT = await evalJs(`(() => { const b = document.querySelector('.tw-case-panel'); const s = [b, document.getElementById('tw-case-body')].find(x => x.scrollHeight > x.clientHeight + 4) || b;
      return { open: !document.getElementById('tw-case-drawer').hidden, hash: location.hash, draft: document.getElementById('tw-cd-reply')?.value, scroll: Math.round(s.scrollTop), details: document.querySelector('#tw-case-body details')?.open, newMsg: document.getElementById('tw-case-body').innerText.includes('תודה, מחכה') }; })()`);
    check(`${W} tomer: a live update redrew the open case (the new message is there) and kept the draft, the open history and the scroll position`,
      keptT.open && keptT.hash === `#tomer/case/${cs.id}` && keptT.draft === 'היי, מתקשרת אלייך עוד כמה דקות' && keptT.newMsg && keptT.details === true && Math.abs(keptT.scroll - sc0) <= 4, JSON.stringify({ ...keptT, sc0 }));
    await audit(`${W} tomer case with draft`);
    await tap('#tw-case-body [data-act="reply"]');
    const fl = await waitFor(async () => { const f = await evalJs(`(() => { const e = document.getElementById('tw-cd-msg'); return e ? { text: e.textContent, kind: e.dataset.kind ?? null } : null; })()`); return f && f.kind === 'ok' && /התקבלה אצל ספק הוואטסאפ/.test(f.text) ? f : null; }, { timeoutMs: 10000 });
    check(`${W} tomer: the staff reply was sent and the result is shown in the case`, !!fl && sent.at(-1)?.message === 'היי, מתקשרת אלייך עוד כמה דקות' && String(sent.at(-1)?.chatId).startsWith(member));
    const flashSeen = await evalJs(`(() => { const r = document.getElementById('tw-cd-msg').getBoundingClientRect(); const t = document.querySelector('.tomer-toast, .toast, #toast'); return { inView: r.top >= 0 && r.bottom <= innerHeight, top: Math.round(r.top) }; })()`);
    check(`${W} tomer: the result is visible without scrolling back`, flashSeen.inView, JSON.stringify(flashSeen));
    await shot(`tomer-${W}-3-reply-sent`);
    await tap('#tw-case-close');
    await until(`document.getElementById('tw-case-drawer').hidden`);

    // staff tasks
    await tap('.tw-tab[data-pane="tasks"]');
    check(`${W} tomer: staff tasks are rendered`, (await until(`document.querySelectorAll('#tw-tasks-tbody tr').length >= 2 && !/טוען/.test(document.getElementById('tw-tasks-tbody').innerText)`)) === true);
    await sleep(250);
    const taskCard = await evalJs(`(() => { const tr = document.querySelector('#tw-tasks-tbody tr'); return { display: getComputedStyle(tr).display, labelled: [...tr.children].every(td => 'label' in td.dataset) && [...tr.children].filter(td => td.dataset.label).length >= 5, text: tr.innerText.replace(/\\s+/g, ' ').slice(0, 160) }; })()`);
    check(`${W} tomer: tasks are cards with labelled fields and their buttons`, taskCard.display !== 'table-row' && taskCard.labelled && /פרטים/.test(taskCard.text), JSON.stringify(taskCard));
    check(`${W} tomer: each task says what waits for Eden`, (await evalJs(`[...document.querySelectorAll('#tw-tasks-tbody tr')].every(tr => /מחכה לטיפול של עדן/.test(tr.innerText))`)) === true);
    check(`${W} tomer: voice transcription and Arbox action status are shown above the tasks`, (await until(`/תמלול קולי/.test(document.getElementById('tw-automation-status')?.innerText ?? '') && /פעולות Arbox של תומר: כבויות/.test(document.getElementById('tw-automation-status').innerText)`)) === true);
    await audit(`${W} tomer tasks`);
    await shot(`tomer-${W}-4-tasks`);
    await tap('#tw-tasks-tbody tr button[onclick^="viewTaskDetail"]');
    const modalOk = await until(`(() => { const m = document.querySelector('.modal-overlay .modal-box, .modal-overlay > div'); if (!m) return false; const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`, 5000);
    check(`${W} tomer: the task details dialog is inside the screen`, modalOk === true, await evalJs(`(() => { const m = document.querySelector('.modal-overlay .modal-box, .modal-overlay > div'); if (!m) return 'no dialog'; const r = m.getBoundingClientRect(); return JSON.stringify([r.left, r.right, r.top, r.bottom, innerWidth, innerHeight].map(Math.round)); })()`));
    await audit(`${W} tomer task dialog`);
    await shot(`tomer-${W}-5-task-details`);
    await tap('.modal-overlay button');
    await until(`!document.querySelector('.modal-overlay')`, 3000);
    for (const p of ['conversations', 'care', 'members', 'audit']) {
      await tap(`.tw-tab[data-pane="${p}"]`); await sleep(700);
      await audit(`${W} tomer/${p}`);
    }
    await shot(`tomer-${W}-6-care`, true);

    // ── WhatsApp inbox ────────────────────────────────────────────────────────
    await goTab('whatsapp');
    await until(`document.querySelectorAll('.wa-thread-item').length >= 5`);
    await audit(`${W} whatsapp list`);
    await shot(`whatsapp-${W}-1-list`);
    await evalJs(`(window.__waPick = [...document.querySelectorAll('.wa-thread-item')].find(e => e.getAttribute('onclick').includes('${member}')), window.__waPick.id = 'wa-pick', true)`);
    await tap('#wa-pick');
    check(`${W} whatsapp: a thread opens with its messages and the reply field`, (await until(`getComputedStyle(document.getElementById('wa-thread-view')).display !== 'none' && document.querySelectorAll('#wa-thread-messages .wa-bubble, #wa-thread-messages [class*="bubble"], #wa-thread-messages .wa-msg-row').length > 0`)) === true);
    await sleep(300);
    await audit(`${W} whatsapp thread`);
    await type('#wa-reply-input', 'טיוטה שלא נשלחה');
    await keyboardCheck(`${W} whatsapp reply`, W, H, '#wa-reply-input', '#wa-reply-send');
    await say(other, `הודעה ממישהי אחרת ${W}`);
    await sleep(1500);
    const keptW = await evalJs(`({ draft: document.getElementById('wa-reply-input').value, phone: document.querySelector('#wa-thread-header .wa-thdr-phone')?.textContent ?? '', view: getComputedStyle(document.getElementById('wa-thread-view')).display })`);
    check(`${W} whatsapp: an inbound message from someone else did not switch the open client or wipe the draft`, keptW.draft === 'טיוטה שלא נשלחה' && keptW.phone.replace(/\D/g, '').endsWith(member.slice(3)) && keptW.view !== 'none', JSON.stringify(keptW));
    await shot(`whatsapp-${W}-2-thread`);
    await evalJs(`(document.getElementById('wa-reply-input').value = '', true)`);
    if (await evalJs(`!!document.getElementById('wa-back') && getComputedStyle(document.getElementById('wa-back')).display !== 'none'`)) {
      await tap('#wa-back');
      check(`${W} whatsapp: "back" returns to the list of chats`, (await until(`getComputedStyle(document.querySelector('.wa-threads-sidebar')).display !== 'none' && document.querySelector('.wa-thread-item').getBoundingClientRect().height > 0`, 3000)) === true);
    }

    // ── the other shared screens fit ──────────────────────────────────────────
    for (const t of ['maya', 'automations', 'knowledge', 'health', 'sandbox']) {
      await goTab(t); await sleep(500);
      const a = await evalJs(auditExpr());
      check(`${W} ${t}: fits the screen (no sideways scroll, nothing outside or cut)`, a.docW <= a.vw + 1 && a.layoutW <= a.vw + 1 && a.off.length === 0 && a.cut.length === 0, `doc ${a.docW}/${a.layoutW}; ` + [...a.off, ...a.cut].slice(0, 4).join(' | '));
      check(`${W} ${t}: controls are at least 44×44`, a.small.length === 0, `${a.small.length}: ` + a.small.slice(0, 6).join(' | '));
      if (t === 'maya') await shot(`maya-${W}`, true);
      if (t === 'health') {
        // the status table is computed, not a constant "active": every row has a state, and a capability that is
        // off in this isolated server (Arbox class writes, Dana publishing) is not shown as live
        await until(`document.querySelectorAll('#health-grid .sys-row').length >= 15`, 8000);
        const st = await evalJs(`(() => { const r = [...document.querySelectorAll('#health-grid .sys-row')]; const by = id => r.find(x => x.dataset.statusId === id);
          return { n: r.length, unlabelled: r.filter(x => !x.querySelector('.sys-state')?.textContent.trim() || !x.querySelector('.sys-row-detail')?.textContent.trim()).length,
            writes: by('tomer_class_writes')?.dataset.state, publish: by('dana_publish')?.dataset.state, groups: document.querySelectorAll('#health-grid .sys-group').length,
            blockedNoAction: r.filter(x => x.dataset.state === 'blocked' && !x.querySelector('.sys-row-action')).length, old: document.querySelectorAll('#health-grid .hstatus.active').length }; })()`);
        check(`${W} health: the status table shows every component with a state and an explanation`, st.n >= 15 && st.unlabelled === 0 && st.groups === 4, JSON.stringify(st));
        check(`${W} health: switched-off capabilities are not shown as active`, st.writes === 'blocked' && st.publish === 'off' && st.old === 0, JSON.stringify(st));
        check(`${W} health: every "waiting for you" row says what is needed`, st.blockedNoAction === 0, JSON.stringify(st));
        await shot(`health-${W}`, true);
      }
    }
    check(`${W}: the tab row shows every tab without sideways scrolling`, await evalJs(`(() => { const n = document.querySelector('.tab-nav'); return n.scrollWidth <= n.clientWidth + 1 && [...n.querySelectorAll('.tab-btn')].every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }); })()`));
  }

  // ── desktop still the wide layout ───────────────────────────────────────────
  console.log('\n── 1366×768 (desktop) ──');
  await setViewport(1366, 768, false);
  await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
  await cdp('Page.navigate', { url: 'about:blank' });            // a hash-only change would not reload the page
  await cdp('Page.navigate', { url: `${BASE}/#barak` });
  await until(`document.querySelectorAll('.callback-row').length >= 3 && document.querySelector('.tab-btn.active')?.dataset.tab === 'barak'`, 20000);
  await sleep(400);
  const desk = await evalJs(`(() => { const row = document.querySelector('.callback-row .cb-grid') || document.querySelector('.callback-row > div'); const tr = document.querySelector('#barak-leads-tbody tr');
    const nav = [...document.querySelectorAll('.tab-nav .tab-btn')].map(b => Math.round(b.getBoundingClientRect().top));
    return { docW: document.documentElement.scrollWidth, vw: innerWidth, cols: getComputedStyle(row).gridTemplateColumns.split(' ').length, tr: getComputedStyle(tr).display, thead: getComputedStyle(document.querySelector('#barak-view-pipeline thead')).display, navOneRow: new Set(nav).size === 1, head: !!document.querySelector('.cb-head') && getComputedStyle(document.querySelector('.cb-head')).display !== 'none' }; })()`);
  check('desktop barak: no sideways scroll; callbacks are a 7-column grid with its header; leads are a real table; the tabs are one row',
    desk.docW <= desk.vw + 1 && desk.cols === 7 && desk.tr === 'table-row' && desk.thead === 'table-header-group' && desk.navOneRow && desk.head, JSON.stringify(desk));
  await shot('barak-1366-desktop');
  const handD = LEAD_HAND[1366], aptD = (await rowsApi()).find(r => r.fullPhone === handD).apt;
  await tap(`${rowSel(handD)} button[data-cb-action="owner-summary"]`);
  await type(`#cb-owner-name-${aptD.id}`, '');
  await tap(`${rowSel(handD)} button[data-cb-action="owner-summary-send"]`);
  check('desktop barak: approve + send summary works with a mouse', (await waitFor(async () => /הסיכום נשלח ללקוח/.test(await msgBar()), { timeoutMs: 8000 })) === true, await msgBar());
  await tap('.tab-btn[data-tab="tomer"]'); await sleep(300);
  await tap('.tw-tab[data-pane="cases"]');
  await until(`document.querySelectorAll('.tw-case-card').length >= 5`);
  await tap('.tw-case-card');
  await until(`!document.getElementById('tw-case-drawer').hidden && !!document.querySelector('#tw-cd-status-chip')`);
  const dPanel = await evalJs(`Math.round(document.querySelector('.tw-case-panel').getBoundingClientRect().width)`);
  check('desktop tomer: the case opens as a 560px side panel, not full screen', dPanel === 560, String(dPanel));
  await shot('tomer-1366-desktop');
  await tap('#tw-case-close');
  await tap('.tw-tab[data-pane="tasks"]');
  await until(`document.querySelectorAll('#tw-tasks-tbody tr').length >= 2`);
  check('desktop tomer: tasks are a real table', (await evalJs(`getComputedStyle(document.querySelector('#tw-tasks-tbody tr')).display`)) === 'table-row');
  await tap('.tab-btn[data-tab="whatsapp"]'); await sleep(500);
  check('desktop whatsapp: list and chat side by side', await evalJs(`(() => { const a = document.querySelector('.wa-threads-sidebar').getBoundingClientRect(), b = document.querySelector('.wa-chat-pane').getBoundingClientRect(); return a.width > 200 && b.width > 400 && Math.abs(a.top - b.top) < 4; })()`));

  check('no native alert()/prompt() dialogs were used', dialogs.length === 0, dialogs.join(' | '));
  // ── a tap that arrives before the page scripts have loaded is not lost ──────
  // Production, 2026-11-18: on the first load after a deployment (nothing cached) the Barak tab was tapped as soon as
  // it was drawn and never opened. The tab row is in the HTML; its handlers come with app.js at the end of the page.
  console.log('\n── slow connection ──');
  await setViewport(390, 800, true);
  // app.js is held back by the test (as a slow connection would) until the tab has been tapped
  let heldAppJs = null;
  onPaused = prm => { if (/\/app\.js(\?|$)/.test(prm.request.url) && !heldAppJs) heldAppJs = prm.requestId; else cdp('Fetch.continueRequest', { requestId: prm.requestId }).catch(() => {}); };
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/app.js*' }] });
  await cdp('Page.navigate', { url: 'about:blank' });
  await cdp('Page.navigate', { url: `${BASE}/` });
  await until(`!!document.querySelector('.tab-btn[data-tab="barak"]') && getComputedStyle(document.querySelector('.tab-nav')).display !== 'block'`, 30000);   // drawn with its stylesheet
  await waitFor(async () => !!heldAppJs, { timeoutMs: 15000 });
  const early = await evalJs(`typeof loadBarakPanel === 'undefined'`);
  await tap('.tab-btn[data-tab="barak"]');
  check('slow connection: the tap came before the page scripts had loaded (the check tests what it claims)', early === true && !!heldAppJs);
  check('slow connection: the tapped tab is marked at once, before the scripts arrive', (await evalJs(`document.querySelector('.tab-btn.active')?.dataset.tab`)) === 'barak');
  await sleep(1500);
  if (heldAppJs) await cdp('Fetch.continueRequest', { requestId: heldAppJs });
  check('slow connection: a tab tapped before the scripts have loaded opens once they have', (await until(`typeof loadBarakPanel === 'function' && document.readyState === 'complete' && document.querySelector('.tab-btn[data-tab="barak"]').classList.contains('active') && document.getElementById('tab-barak').classList.contains('active')`, 30000)) === true,
    await evalJs(`'active tab: ' + (document.querySelector('.tab-btn.active')?.dataset.tab ?? 'none') + ', active panel: ' + (document.querySelector('.tab-panel.active')?.id ?? 'none')`));
  await cdp('Fetch.disable'); onPaused = null;

  check('no uncaught JavaScript errors on the page', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 500));
} catch (err) {
  fail++;
  console.error(`  [FATAL] ${err.stack ?? err.message}`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  for (const c of children) killTree(c.pid);
  try { green?.close(); } catch { /* ignore */ }
  try { await arbox.close?.(); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 300));
  removeDir(dataDir);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* browser may still hold a lock */ }
}

console.log(`\nmobile_panel_check.mjs: PASS=${pass}  FAIL=${fail}   (emulated screens, not a real device; screenshots: ${shotDir})`);
process.exit(fail > 0 ? 1 : 0);
