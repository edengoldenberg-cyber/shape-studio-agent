#!/usr/bin/env node
/**
 * dana_tab_browser_check.mjs — browser verification of the Dana tab in the main panel.
 *
 * Starts an isolated server (temp DATA_DIR, mocked Green API + Arbox, nothing can be sent), optionally
 * seeded with a finished LOCAL test package, and drives a real headless Chrome at a desktop and a
 * phone viewport: the Dana tab must open the editing studio (upload, worker status, projects,
 * review + approval package) and keep the previous tools reachable as a separate view.
 *
 * Usage:  node tests/dana_tab_browser_check.mjs [--seed <dir containing dana/>] [--shots <dir>]
 */
import { spawn, spawnSync } from 'child_process';
import { createServer }     from 'http';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { existsSync, writeFileSync, mkdtempSync, rmSync, cpSync, mkdirSync } from 'fs';
import { tmpdir }           from 'os';
import path                 from 'path';

const require = createRequire(import.meta.url);
const { createIsolatedDataDir, removeDir, isolatedChildEnv, freePort, waitFor } = require('./helpers/isolated_env.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const seed = arg('--seed'), shots = arg('--shots');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}${detail ? '  →  ' + detail : ''}`); } };

const browserBin = process.env.CHROME_BIN ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p));
if (!browserBin) { console.error('[FATAL] No Chrome/Edge binary found (set CHROME_BIN).'); process.exit(2); }

const children = [];
const killTree = pid => { if (!pid) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };
const dataDir = createIsolatedDataDir('shape-danatab-');
const profileDir = mkdtempSync(path.join(tmpdir(), 'shape-danatab-chrome-'));
let mock, ws;

try {
  const seeded = !!(seed && existsSync(path.join(seed, 'dana')));
  if (seeded) cpSync(path.join(seed, 'dana'), path.join(dataDir, 'dana'), { recursive: true });
  const [appPort, mockPort, dbgPort] = [await freePort(), await freePort(), await freePort()];
  mock = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url.includes('/arbox') ? { data: [] } : { idMessage: 'MOCK' })); }); });
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
    env: isolatedChildEnv(dataDir, { PORT: String(appPort), TEST_MODE: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
      GREEN_API_URL: `127.0.0.1:${mockPort}`, GREEN_API_ID_INSTANCE: '9990001', GREEN_API_TOKEN_INSTANCE: 'mock',
      ARBOX_BASE_URL: `http://127.0.0.1:${mockPort}/arbox`, ARBOX_API_KEY: 'mock-arbox', DANA_WORKER_TOKEN: 'test-token-not-a-secret' }),
  });
  children.push(server);
  let serverErr = ''; server.stderr.on('data', d => { serverErr += d.toString(); });
  const up = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${appPort}/health`)).json()).startupComplete === true, { timeoutMs: 30000, intervalMs: 200 });
  if (!up) throw new Error('server did not start: ' + serverErr.slice(-400));

  const chrome = spawn(browserBin, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profileDir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  children.push(chrome);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()).find(t => t.type === 'page'), { timeoutMs: 20000, intervalMs: 200 });
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(); const pageErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown');
    if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
  };
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result.value; };
  const until = (expr, ms = 15000) => waitFor(() => evalJs(expr).catch(() => false), { timeoutMs: ms, intervalMs: 150 });
  const shot = async name => { if (!shots) return; mkdirSync(shots, { recursive: true }); const g = await evalJs(`JSON.stringify({ sw: document.documentElement.scrollWidth, vw: Math.round(window.visualViewport.width), vh: Math.round(window.visualViewport.height) })`).then(JSON.parse);
    // RTL: the visible part of a page wider than the screen is its right edge
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(g.sw > g.vw + 1 ? { clip: { x: g.sw - g.vw, y: 0, width: g.vw, height: g.vh, scale: 1 } } : {}) }); writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64')); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  const F = `document.getElementById('dana-studio-frame')`, D = `${F}.contentDocument`;
  const visible = sel => `(() => { const e = document.querySelector('${sel}'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`;

  for (const vp of [{ name: 'desktop', width: 1400, height: 900, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
    console.log(`\n── ${vp.name} ${vp.width}x${vp.height}`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.mobile ? 2 : 1, mobile: vp.mobile });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    await until(`document.readyState === 'complete' && !!document.querySelector('.tab-btn[data-tab="dana"]')`);
    check('studio is not loaded before the Dana tab is opened', await evalJs(`!${F}.getAttribute('src')`));
    await evalJs(`document.querySelector('.tab-btn[data-tab="dana"]').click()`);
    check('Dana tab opens the editing studio view', await until(`document.getElementById('tab-dana').classList.contains('active') && !document.getElementById('dana-view-studio').hidden && ${F}.getAttribute('src') === '/dana-studio.html?embed=1'`));
    check('previous tools are hidden while the studio is shown', await evalJs(`document.getElementById('dana-view-tools').hidden && !${visible('.dana-layout')}`));
    check('studio page loaded inside the tab', await until(`${D} && ${D}.readyState === 'complete' && !!${D}.getElementById('pick')`));
    check('upload control is present and usable', await evalJs(`(() => { const b = ${D}.getElementById('pick'), r = b.getBoundingClientRect(); return !b.disabled && r.width > 100 && r.height >= 44 && !!${D}.getElementById('file'); })()`));
    check('worker status is shown', await until(`!!${D}.getElementById('worker') && !/בודק/.test(${D}.getElementById('worker').textContent)`), await evalJs(`${D}.getElementById('worker')?.textContent`));
    check('embedded mode hides the redundant "panel" link', await evalJs(`${D}.documentElement.classList.contains('embed') && getComputedStyle(${D}.querySelector('header a')).display === 'none'`));
    check('the Dana tab adds no horizontal overflow of its own', await evalJs(`[...document.querySelectorAll('#tab-dana, #tab-dana *')].every(e => e.offsetParent === null || e.getBoundingClientRect().width <= window.visualViewport.width + 1)`));
    check('studio frame sits inside the visible screen width', await evalJs(`(() => { const r = ${F}.getBoundingClientRect(), sw = document.documentElement.scrollWidth, vw = window.visualViewport.width; return r.width <= vw + 1 && r.right <= window.innerWidth + 1 && r.left >= window.innerWidth - vw - 1; })()`), await evalJs(`JSON.stringify(${F}.getBoundingClientRect())`));
    check('no horizontal overflow inside the studio', await evalJs(`${D}.documentElement.scrollWidth <= ${F}.clientWidth + 1`));
    check('studio frame is large enough to work in', await evalJs(`(() => { const r = ${F}.getBoundingClientRect(); return r.width >= Math.min(window.visualViewport.width, 640) * 0.9 && r.height >= 420; })()`), await evalJs(`JSON.stringify(${F}.getBoundingClientRect())`));
    await shot(`${vp.name}-1-studio`);
    if (process.env.DANA_TAB_DEBUG) console.log('   layout:', await evalJs(`JSON.stringify({ inner: window.innerWidth, vv: Math.round(window.visualViewport.width), scroll: document.documentElement.scrollWidth, wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().width > ${vp.width} + 2 && e.offsetParent !== null).slice(0, 8).map(e => e.tagName + '.' + String(e.className).slice(0, 30) + ':' + Math.round(e.getBoundingClientRect().width)) })`));

    if (seeded) {
      check('projects are listed', await until(`${D}.querySelectorAll('#projects .proj').length > 0`));
      await evalJs(`${D}.querySelector('#projects .proj').click()`);
      check('project opens: processing history and review package', await until(`!${D}.getElementById('detail').classList.contains('hidden') && !!${D}.querySelector('#detail video')`));
      check('review video has a source and the cover is shown', await evalJs(`!!${D}.querySelector('#detail video').getAttribute('src') && !!${D}.querySelector('#detail img.cover')`));
      check('video is playable (metadata loads through the panel)', await until(`${D}.querySelector('#detail video').readyState >= 1 && ${D}.querySelector('#detail video').duration > 1`, 20000));
      check('approval actions are visible inside the frame', await evalJs(`(() => { const a = ${D}.getElementById('actions'); if (a.classList.contains('hidden')) return false; const r = a.getBoundingClientRect(); return r.bottom <= ${F}.clientHeight + 1 && r.height > 40 && !!a.querySelector('[data-act="approve"]'); })()`));
      check('approval bar is on screen without scrolling the panel', await evalJs(`(() => { const f = ${F}.getBoundingClientRect(), a = ${D}.getElementById('actions').getBoundingClientRect(); return f.top + a.bottom <= window.visualViewport.height + 1; })()`), await evalJs(`JSON.stringify([${F}.getBoundingClientRect().top, ${D}.getElementById('actions').getBoundingClientRect().bottom, window.visualViewport.height])`));
      await shot(`${vp.name}-2-package`);
      await evalJs(`${D}.getElementById('back').click()`);
      check('back returns to upload + project list', await until(`!${D}.getElementById('list').classList.contains('hidden')`));
    }

    await evalJs(`document.querySelector('.dana-switch-btn[data-dana-view="tools"]').click()`);
    check('previous tools open as a separate view', await evalJs(`!document.getElementById('dana-view-tools').hidden && document.getElementById('dana-view-studio').hidden && ${visible('.dana-layout')}`));
    check('previous tools are intact (analysis upload, chat)', await evalJs(`!!document.getElementById('vup-submit') && !!document.getElementById('dana-chat-input') && !!document.getElementById('dana-send')`));
    check('previous tools fit the visible screen width', await evalJs(`[...document.querySelectorAll('#dana-view-tools, #dana-view-tools *')].every(e => e.offsetParent === null || e.getBoundingClientRect().width <= window.visualViewport.width + 1)`));
    await shot(`${vp.name}-3-tools`);
    await evalJs(`document.querySelector('.dana-switch-btn[data-dana-view="studio"]').click()`);
    check('switching back shows the studio again without reloading it', await evalJs(`!document.getElementById('dana-view-studio').hidden && !!${D}.getElementById('pick')`));
    await evalJs(`document.querySelector('.tab-btn[data-tab="barak"]').click()`);
    check('other tabs still switch (Barak)', await evalJs(`document.getElementById('tab-barak').classList.contains('active') && !document.getElementById('tab-dana').classList.contains('active')`));
  }
  check('no JavaScript errors in the page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail++; console.error('[ERROR]', e.message);
} finally {
  try { ws?.close(); } catch { /* closed */ }
  for (const c of children) killTree(c.pid);
  mock?.close();
  await new Promise(r => setTimeout(r, 500));
  removeDir(dataDir); try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* locked */ }
}
console.log(`\ndana_tab_browser_check.mjs: PASS=${pass}  FAIL=${fail}`);
process.exit(fail ? 1 : 0);
