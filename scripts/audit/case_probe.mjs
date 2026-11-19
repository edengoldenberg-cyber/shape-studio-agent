// READ-ONLY probe of the Tomer case drawer on mobile: can the note be written and the resolve
// button reached? Opens a TEST case only (GET), focuses/types client-side (no network write),
// and simulates the keyboard by shrinking the viewport. Blocks every non-GET request.
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import net from 'net';
import path from 'path';
const BASE = process.argv[process.argv.indexOf('--base') + 1].replace(/\/$/, '');
const CASE = process.argv[process.argv.indexOf('--case') + 1];
const TOKEN = process.env.PROD_SESSION ?? '';
const bin = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(path.join(tmpdir(), 'case-probe-'));
const port = await freePort();
const chrome = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {} if (!target) await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp')); });
  let seq = 0; const pending = new Map();
  const cdp = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    if (m.method === 'Fetch.requestPaused') { const ok = m.params.request.method === 'GET'; ok ? cdp('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {}) : cdp('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); } };
  const evalJs = async e => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const until = async (e, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(e)) return true; } catch {} await sleep(250); } return false; };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp('Network.setCookie', { name: 'ss_session', value: TOKEN, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax' });
  const probe = async (W, H, label) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(400);
    const r = await evalJs(`(() => {
      const panel = document.querySelector('.tw-case-panel');
      const note = document.querySelector('#tw-cd-note');
      const outcome = document.querySelector('#tw-cd-outcome');
      const resolve = document.querySelector('[data-act="resolve"]');
      const info = el => { if (!el) return null; const r = el.getBoundingClientRect(); const topEl = document.elementFromPoint(Math.min(${W}-5, Math.max(5, r.left + r.width/2)), Math.min(${H}-5, Math.max(5, r.top + r.height/2))); return { has: true, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= ${H}, coveredBy: topEl && !el.contains(topEl) && topEl !== el ? (topEl.id || topEl.className || topEl.tagName) : null }; };
      // try to scroll the resolve button into view inside the panel
      if (resolve && panel) resolve.scrollIntoView({ block: 'center' });
      return { panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null, panelScrollable: panel ? panel.scrollHeight > panel.clientHeight + 1 : null, note: info(note), outcome: info(outcome), resolve: info(resolve) };
    })()`);
    // focus + type into the note (client-side only)
    let typed = null;
    if (r.note?.has) {
      await evalJs(`document.querySelector('#tw-cd-note').focus()`);
      await cdp('Input.insertText', { text: 'בדיקת הקלדה' }).catch(() => {});
      typed = await evalJs(`({ active: document.activeElement === document.querySelector('#tw-cd-note'), value: document.querySelector('#tw-cd-note').value })`);
    }
    console.log(`P ${label} (${W}x${H}): panelScrollable=${r.panelScrollable} note=${JSON.stringify(r.note)} outcome=${JSON.stringify(r.outcome)} resolve=${JSON.stringify(r.resolve)} typed=${JSON.stringify(typed)}`);
  };
  await cdp('Page.navigate', { url: BASE + '/#tomer/case/' + CASE });
  await until(`!!document.querySelector('.tab-btn[data-tab="tomer"]')`);
  await evalJs(`document.querySelector('.tab-btn[data-tab="tomer"]').click()`); await sleep(800);
  await evalJs(`document.querySelector('.tw-tab[data-pane="cases"]')?.click()`); await sleep(1200);
  await evalJs(`(window.openCase ? window.openCase('${CASE}') : null)`);
  const opened = await until(`!!document.querySelector('#tw-cd-note') || !!document.querySelector('[data-act="resolve"]') || !!document.querySelector('[data-act="reopen"]')`, 12000);
  console.log('P opened=' + opened + ' isResolved=' + (await evalJs(`!!document.querySelector('[data-act="reopen"]')`)));
  await probe(390, 800, 'full height');
  await probe(390, 420, 'keyboard open (short screen)');   // simulate the on-screen keyboard
  console.log('');
} catch (e) { console.log('P ERR ' + e.message); }
finally { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
process.exit(0);
