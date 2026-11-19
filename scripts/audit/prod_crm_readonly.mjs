/**
 * prod_crm_readonly.mjs — look at the Barak → CRM sales workspace of a RUNNING deployment at
 * desktop + phone widths, READ-ONLY. Only GET requests leave the browser (meta / search / lead
 * card are all GET); no action button is tapped, nothing is typed, no record is changed.
 *   PROD_SESSION=<cookie> node scripts/audit/prod_crm_readonly.mjs --base https://… [--widths 1366,360,390,430]
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import net from 'net';
import path from 'path';

const argOf = k => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : null; };
const BASE = (argOf('base') ?? '').replace(/\/$/, '');
const TOKEN = process.env.PROD_SESSION ?? '';
const shotDir = argOf('shots') ?? path.join(process.cwd(), '.claude', 'prod-shots');
const WIDTHS = (argOf('widths') ?? '1366,360,390,430').split(',').map(Number).filter(Boolean);
if (!/^https:\/\//.test(BASE) || TOKEN.length < 20) { console.error('usage: PROD_SESSION=… node prod_crm_readonly.mjs --base https://…'); process.exit(2); }
mkdirSync(shotDir, { recursive: true });
const bin = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? '  →  ' + detail : ''}`); } };
const profile = mkdtempSync(path.join(tmpdir(), 'shape-crm-ro-'));
const port = await freePort();
const chrome = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=430,900', 'about:blank'], { stdio: 'ignore' });
const blocked = [];
try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {} if (!target) await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(), pageErrors = [];
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? 'unknown');
    if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    if (m.method === 'Fetch.requestPaused') {
      const rq = m.params.request, u = new URL(rq.url);
      const ok = rq.method === 'GET' && u.origin === BASE;
      const okStatic = rq.method === 'GET' && u.origin !== BASE;
      if (ok || okStatic) cdp('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      else { blocked.push(`${rq.method} ${u.pathname}`); cdp('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
    }
  };
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result.value; };
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(expr)) return true; } catch {} await sleep(250); } return false; };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp('Network.setCookie', { name: 'ss_session', value: TOKEN, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax' });
  const q = s => JSON.stringify(s);
  async function tap(sel) {
    const box = await evalJs(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    if (!box || !box.w) return false;
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700); return true;
  }
  const shot = async name => { await sleep(400); const s = await Promise.race([cdp('Page.captureScreenshot', { format: 'png' }), sleep(20000).then(() => null)]); if (s) writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(s.data, 'base64')); };
  const audit = async (label, W) => {
    const a = await evalJs(`(() => { const vw = ${W}; const vis = e => { if (!e.getClientRects().length) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inScroller = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
      const kind = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/)[0] : '');
      const out = { docW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), layoutW: innerWidth, off: [], small: [] };
      for (const e of document.querySelectorAll('#tab-barak *')) { if (!vis(e)) continue; const r = e.getBoundingClientRect();
        if ((r.left < -1 || r.right > vw + 1) && !inScroller(e)) out.off.push(kind(e));
        if (e.matches('button, a[href], select, input:not([type=hidden]):not([type=checkbox]), textarea, .crm-chip, .crm-btn') && (r.width < 40 || r.height < 40) && !inScroller(e)) out.small.push(kind(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
      return out; })()`);
    check(`${label}: no sideways scroll (document ${a.docW}px on ${W}px)`, a.docW <= W + 1 && a.layoutW <= W + 1, `layout ${a.layoutW}`);
    check(`${label}: nothing reaches outside the screen`, a.off.length === 0, [...new Set(a.off)].slice(0, 8).join(' | '));
    if (W < 900) check(`${label}: tap targets ≥ ~40px`, a.small.length === 0, [...new Set(a.small)].slice(0, 8).join(' | '));
  };

  for (const W of WIDTHS) {
    console.log(`\n── ${W}px ──`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: W < 900 ? 800 : 900, deviceScaleFactor: W < 900 ? 2 : 1, mobile: W < 900 });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Page.navigate', { url: BASE + '/' });
    check(`${W}: dashboard opens with the session`, await until(`!!document.querySelector('.tab-btn[data-tab="barak"]') && !/login/.test(location.pathname)`));
    check(`${W}: Barak tab opens`, await tap('.tab-btn[data-tab="barak"]') && await until(`document.querySelector('.tab-btn[data-tab="barak"]').classList.contains('active')`));
    await sleep(1200);
    check(`${W}: CRM sub-view opens`, await tap('.barak-sv-btn[data-bview="crm"]') && await until(`!!document.querySelector('#crm-root .crm-search')`));
    const got = await until(`!!document.querySelector('#crm-root .crm-card') || !!document.querySelector('#crm-root .crm-empty')`, 12000);
    const info = await evalJs(`({ cards: document.querySelectorAll('#crm-root .crm-card').length, count: (document.querySelector('#crm-count')?.textContent||''), views: document.querySelectorAll('#crm-views .crm-chip').length, filters: document.querySelectorAll('#crm-filters select').length, search: !!document.querySelector('#crm-q'), err: !!document.querySelector('#crm-root .crm-empty.err') })`);
    console.log(`  (cards: ${info.cards}, ${info.count}, views: ${info.views}, filters: ${info.filters})`);
    check(`${W}: search box + saved views + filters render`, info.search && info.views >= 8 && info.filters >= 5);
    check(`${W}: the list loaded without an error state`, got && !info.err);
    await audit(`${W} CRM list`, W);
    await shot(`prod-crm-${W}-1-list`);
    // open one lead card (GET only) and check it fits
    if (info.cards) {
      const opened = await tap('#crm-root .crm-card') && await until(`!!document.querySelector('.crm-modal')`, 8000);
      check(`${W}: a lead card opens`, opened);
      if (opened) {
        const fit = await evalJs(`(() => { const r = document.querySelector('.crm-modal').getBoundingClientRect(); return { fits: r.left >= -1 && r.right <= ${W} + 1, hasStage: !!document.querySelector('#cm-stage'), hasTl: !!document.querySelector('.crm-tl'), hasActions: !!document.querySelector('.crm-actions') }; })()`);
        check(`${W}: the card fits the screen`, fit.fits);
        check(`${W}: the card has stage, actions and a timeline`, fit.hasStage && fit.hasActions && fit.hasTl);
        await shot(`prod-crm-${W}-2-card`);
        await tap('#cm-x');
      }
    }
  }
  console.log('');
  console.log(`  blocked by the read-only guard: ${blocked.length ? [...new Set(blocked)].join(', ') : 'nothing (only GET left the browser)'}`);
  check('no non-GET request left the browser', blocked.filter(b => !b.startsWith('GET')).length === 0);
  check('no uncaught JavaScript errors on the page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  console.log(`\nprod_crm_readonly: PASS=${pass} FAIL=${fail}  (against ${new URL(BASE).host})`);
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(fail ? 1 : 0);
