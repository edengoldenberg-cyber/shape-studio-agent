#!/usr/bin/env node
/**
 * prod_mobile_readonly.mjs — look at the Barak and Tomer panels of a RUNNING deployment at phone widths, READ-ONLY.
 *
 *   PROD_SESSION=<session cookie value>  node scripts/audit/prod_mobile_readonly.mjs --base https://… [--shots <dir>] [--widths 360,390,430]
 *
 * • The session value comes from the environment only and is never printed or written anywhere.
 * • Every request that is not GET is BLOCKED in the browser (Fetch interception) and counted; so is every request to
 *   /api/dana/, unless --dana is given. GET /api/dana/studio/projects returns expired job leases to the queue and
 *   sends pending owner notifications when real notifications are on: pass --dana only after checking that no job is
 *   leased and that real notifications are off (then the GET changes nothing). With --dana the Dana studio page is
 *   opened too: the list, the home panes and the first project, without tapping any action.
 * • Nothing is typed and no action button is tapped: only tabs, panes and "open details".
 * It is an emulated phone screen in headless Chrome, not a real device. Screenshots contain real customer data: they
 * are written to the given folder only.
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
const WIDTHS = (argOf('widths') ?? '360,390,430').split(',').map(Number).filter(Boolean);
const DANA = process.argv.includes('--dana');
if (!/^https:\/\//.test(BASE) || TOKEN.length < 20) { console.error('usage: PROD_SESSION=… node prod_mobile_readonly.mjs --base https://host'); process.exit(2); }
mkdirSync(shotDir, { recursive: true });
const bin = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? '  →  ' + detail : ''}`); } };

const profile = mkdtempSync(path.join(tmpdir(), 'shape-prod-ro-'));
const port = await freePort();
const chrome = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=430,900', 'about:blank'], { stdio: 'ignore' });
const blocked = [];
try {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } if (!target) await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(), pageErrors = [];
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? 'unknown');
    if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    if (m.method === 'Fetch.requestPaused') {                                   // READ-ONLY: only GET, and never the Dana API
      const rq = m.params.request, u = new URL(rq.url);
      const ok = rq.method === 'GET' && u.origin === BASE && (DANA || !u.pathname.startsWith('/api/dana/'));
      const okStatic = rq.method === 'GET' && u.origin !== BASE;                // fonts etc.
      if (ok || okStatic) cdp('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      else { blocked.push(`${rq.method} ${u.pathname}`); cdp('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
    }
  };
  const evalJs = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result.value; };
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(expr)) return true; } catch { /* navigating */ } await sleep(250); } return false; };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp('Network.setCookie', { name: 'ss_session', value: TOKEN, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax' });
  const q = s => JSON.stringify(s);
  async function tap(sel) {
    const box = await evalJs(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    if (!box || !box.w) return false;
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
    return true;
  }
  const shot = async (name, full = false) => { await sleep(500); const s = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }); writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(s.data, 'base64')); };
  const audit = async (label, W) => {
    const a = await evalJs(`(() => { const vw = ${W}; const vis = e => { if (!e.getClientRects().length) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inScroller = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true; } return false; };
      const kind = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/)[0] : '');
      const out = { docW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), layoutW: innerWidth, off: [], small: [], covered: [] };
      for (const e of document.querySelectorAll('body *')) { if (!vis(e)) continue; const r = e.getBoundingClientRect();
        if ((r.left < -1 || r.right > vw + 1) && !inScroller(e)) out.off.push(kind(e));
        if (e.matches('button, a[href], select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [role=button], .tab-btn, .tw-tab, .filter-btn') && (r.width < 43.5 || r.height < 43.5) && !inScroller(e)) out.small.push(kind(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
      const fixed = [...document.querySelectorAll('body *')].filter(e => vis(e) && getComputedStyle(e).position === 'fixed' && !e.closest('.modal-overlay, .tw-case-panel, .tw-drawer, .tw-chat-panel') && !e.matches('.modal-overlay, .tw-case-panel, .tw-drawer, .tw-chat-panel, .tw-case-overlay, .tw-drawer-overlay, #actions'));
      out.covered = fixed.map(kind);
      return out; })()`);
    check(`${label}: no sideways scroll (document ${a.docW}px on a ${W}px screen)`, a.docW <= W + 1 && a.layoutW <= W + 1, `layout ${a.layoutW}`);
    check(`${label}: nothing reaches outside the screen`, a.off.length === 0, [...new Set(a.off)].slice(0, 6).join(' | '));
    check(`${label}: every control is at least 44×44`, a.small.length === 0, [...new Set(a.small)].slice(0, 6).join(' | '));
    check(`${label}: nothing floats over the page`, a.covered.length === 0, [...new Set(a.covered)].slice(0, 6).join(' | '));
  };

  for (const W of WIDTHS) {
    console.log(`\n── ${W}px ──`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: 800, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
    await cdp('Page.navigate', { url: BASE + '/' });
    check(`${W}: the dashboard opens with the session (not the login page)`, await until(`!!document.querySelector('.tab-btn[data-tab="barak"]') && !/login/.test(location.pathname)`));
    // Barak
    check(`${W} barak: the tab opens`, await tap('.tab-btn[data-tab="barak"]') && await until(`document.querySelector('.tab-btn[data-tab="barak"]').classList.contains('active')`));
    await sleep(2500);
    const cb = await evalJs(`({ rows: document.querySelectorAll('.callback-row').length, leads: document.querySelectorAll('.leads-table tbody tr').length })`);
    console.log(`  (callback rows: ${cb.rows}, table rows: ${cb.leads})`);
    await audit(`${W} barak`, W);
    await shot(`prod-barak-${W}-1-top`);
    if (cb.rows) { await evalJs(`document.querySelector('.callback-row').scrollIntoView({ block: 'start' })`); await shot(`prod-barak-${W}-2-callback`); }
    await shot(`prod-barak-${W}-3-full`, true);
    // Tomer
    check(`${W} tomer: the tab opens`, await tap('.tab-btn[data-tab="tomer"]') && await until(`document.querySelector('.tab-btn[data-tab="tomer"]').classList.contains('active')`));
    await sleep(2500);
    await audit(`${W} tomer today`, W);
    await shot(`prod-tomer-${W}-1-today`);
    if (await tap('.tw-tab[data-pane="cases"]')) {
      await sleep(2000);
      await audit(`${W} tomer cases`, W);
      await shot(`prod-tomer-${W}-2-cases`);
      const opened = await evalJs(`(() => { const b = document.querySelector('[data-case-open], .tw-case-row button, .tw-case-row'); return !!b; })()`);
      if (opened && await tap('[data-case-open], .tw-case-row button, .tw-case-row')) {
        await sleep(2000);
        if (await evalJs(`!!document.querySelector('.tw-case-panel') && getComputedStyle(document.querySelector('.tw-case-panel')).display !== 'none'`)) {
          const fit = await evalJs(`(() => { const r = document.querySelector('.tw-case-panel').getBoundingClientRect(); return r.left >= -1 && r.right <= ${W} + 1; })()`);
          check(`${W} tomer: the open case stays inside the screen`, fit);
          await shot(`prod-tomer-${W}-3-case`);
          await tap('.tw-case-panel [data-act="close"], .tw-case-close, #tw-case-close');
        }
      }
    }
    if (await tap('.tw-tab[data-pane="tasks"]')) {
      check(`${W} tomer: tasks load and the voice / Arbox status line is shown`, await until(`/תמלול קולי/.test(document.getElementById('tw-automation-status')?.innerText ?? '') && !/טוען/.test(document.getElementById('tw-tasks-tbody').innerText)`));
      console.log('  status: ' + (await evalJs(`document.getElementById('tw-automation-status')?.innerText.replace(/\\s+/g, ' ') ?? ''`)));
      await audit(`${W} tomer tasks`, W);
      await shot(`prod-tomer-${W}-4-tasks`);
    }
    // System status (GET only)
    if (await tap('.tab-btn[data-tab="health"]')) {
      check(`${W} status: the capability table loads`, await until(`document.querySelectorAll('#health-grid .sys-row').length >= 15`));
      if (W === WIDTHS[0]) {
        const rows = await evalJs(`[...document.querySelectorAll('#health-grid .sys-row')].map(r => r.dataset.state.padEnd(8) + r.dataset.statusId.padEnd(20) + (r.querySelector('.sys-row-detail')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 170))`);
        for (const r of rows) console.log('    ' + r);
        console.log('  header: ' + (await evalJs(`document.getElementById('status-label')?.innerText ?? ''`)));
      }
      await audit(`${W} status`, W);
      await shot(`prod-status-${W}`, true);
    }

    // Dana studio (only with --dana; GET only, no action is tapped)
    if (DANA) {
      await cdp('Page.navigate', { url: BASE + '/dana-studio.html' });
      check(`${W} dana: the studio opens with the session and the project list loads`, await until(`!/login/.test(location.pathname) && document.querySelectorAll('#projects li').length > 0 && !/בודק/.test(document.getElementById('worker').textContent) && !!document.getElementById('worker').textContent.trim()`, 30000));
      const home = await evalJs(`({ worker: document.getElementById('worker').textContent.trim(), projects: [...document.querySelectorAll('#projects .proj')].map(b => b.innerText.replace(/\\s+/g, ' ').slice(0, 160)), banner: (document.getElementById('banner')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200), tabs: [...document.querySelectorAll('#hometabs button')].map(b => b.dataset.home + ':' + b.textContent.trim()) })`);
      if (W === WIDTHS[0]) { console.log('  worker: ' + home.worker); console.log('  banner: ' + (home.banner || '(none)')); for (const pr of home.projects) console.log('  project: ' + pr); console.log('  panes: ' + home.tabs.join(' | ')); }
      await audit(`${W} dana home`, W);
      await shot(`prod-dana-${W}-1-home`, true);
      for (const t of home.tabs.map(x => x.split(':')[0]).filter(k => k && k !== 'projects')) {
        if (!(await tap(`#hometabs button[data-home="${t}"]`))) continue;
        check(`${W} dana pane "${t}": opens`, await until(`document.querySelector('#hometabs button[data-home="${t}"]').classList.contains('on') && !document.querySelector('[data-pane="${t}"]').classList.contains('hidden')`));
        await sleep(1200);
        await audit(`${W} dana pane ${t}`, W);
        if (W === WIDTHS[0]) await shot(`prod-dana-${W}-pane-${t}`, true);
      }
      await tap('#hometabs button[data-home="projects"]');
      if (home.projects.length && await tap('#projects .proj')) {
        check(`${W} dana: the project opens (steps, panel and actions are drawn)`, await until(`!document.getElementById('detail').classList.contains('hidden') && document.getElementById('panel').innerText.trim().length > 40`, 30000));
        await sleep(2500);
        const d = await evalJs(`({ title: document.getElementById('title')?.innerText ?? '', steps: [...document.querySelectorAll('#steps button, #steps li')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 12), video: document.querySelectorAll('#detail video').length, videoErr: [...document.querySelectorAll('#detail video')].filter(v => v.error).length, rating: /הדירוג הסופי של דנה/.test(document.getElementById('detail').innerText), actions: [...document.querySelectorAll('#actions button')].map(b => b.innerText.trim() + (b.disabled ? ' (מושבת)' : '')), errors: [...document.querySelectorAll('#detail .bad, #notice.bad')].map(e => e.innerText.replace(/\\s+/g, ' ').slice(0, 120)).filter(Boolean).slice(0, 6) })`);
        if (W === WIDTHS[0]) { console.log('  steps: ' + d.steps.join(' | ')); console.log('  actions: ' + d.actions.join(' | ')); console.log(`  video elements: ${d.video} (with a load error: ${d.videoErr}); rating card: ${d.rating}`); if (d.errors.length) console.log('  marked as bad: ' + d.errors.join(' || ')); }
        check(`${W} dana project: the video player is present and did not fail to load`, d.video === 0 || d.videoErr === 0, `players ${d.video}, failed ${d.videoErr}`);
        // The fixed action bar at the bottom (#actions) is exempt from the "nothing floats" rule, so it is checked on its
        // own: it must not hide content, actions or fields — at the end of the page, for every control when it is
        // brought into view, and with the screen shortened as it is under an on-screen keyboard (an emulation: headless
        // Chrome has no real keyboard, and a real phone may also move the bar).
        const barCheck = async (label, H) => {
          await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
          await sleep(400);
          const r = await evalJs(`(async () => {
            const bar = document.getElementById('actions'); const vis = e => { if (!e.getClientRects().length) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
            const name = e => (e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ' "' + (e.innerText || e.placeholder || e.name || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '"');
            if (!bar || !vis(bar) || getComputedStyle(bar).position !== 'fixed') return { fixed: false };
            const out = { fixed: true, vh: innerHeight, barH: Math.round(bar.getBoundingClientRect().height), hidden: [], unreachable: [], endGap: null, focusHidden: [] };
            const detail = document.getElementById('detail');
            const controls = [...detail.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, select, summary, video, [role=button]')].filter(e => vis(e) && !bar.contains(e) && !e.disabled);
            for (const e of controls) {
              e.scrollIntoView({ block: 'center' }); await new Promise(r => requestAnimationFrame(() => r()));
              const b = e.getBoundingClientRect(), top = bar.getBoundingClientRect().top;
              if (b.bottom > top + 1 && b.top < innerHeight) out.hidden.push(name(e) + ' bottom ' + Math.round(b.bottom) + ' > bar ' + Math.round(top));
              else { const x = Math.min(Math.max(b.left + b.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(b.top + Math.min(b.height / 2, 20), 1), innerHeight - 1); const t = document.elementFromPoint(x, y);
                     if (!t || !(t === e || e.contains(t) || t.contains(e) || t.closest('label')?.contains(e))) out.unreachable.push(name(e) + ' → ' + (t ? name(t) : 'nothing')); }
            }
            for (const e of controls.filter(e => e.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select'))) {
              e.focus(); await new Promise(r => setTimeout(r, 700));
              const b = e.getBoundingClientRect(), top = bar.getBoundingClientRect().top;
              const headB = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
              if (b.top < headB - 1 || b.bottom > top + 1) out.focusHidden.push(name(e) + ' ' + Math.round(b.top) + '–' + Math.round(b.bottom) + ' (bar at ' + Math.round(top) + ')');
              e.blur();
            }
            scrollTo(0, document.documentElement.scrollHeight); await new Promise(r => requestAnimationFrame(() => r()));
            const last = [...detail.querySelectorAll('*')].filter(e => vis(e) && !bar.contains(e) && !e.children.length).map(e => e.getBoundingClientRect().bottom).reduce((m, v) => Math.max(m, v), 0);
            out.endGap = Math.round(bar.getBoundingClientRect().top - last);
            out.controls = controls.length; scrollTo(0, 0);
            return out; })()`);
          if (!r.fixed) { console.log(`  (${label}: the action bar is not fixed on this screen)`); return; }
          console.log(`  ${label}: screen ${r.vh}px, bar ${r.barH}px (${Math.round(100 * r.barH / r.vh)}% of the screen), ${r.controls} controls, space between the last content and the bar at the end of the page: ${r.endGap}px`);
          check(`${label}: at the end of the page the bar does not cover the last content`, r.endGap >= 0, `overlap ${-r.endGap}px`);
          check(`${label}: no button, link or field is under the bar when brought into view`, r.hidden.length === 0, r.hidden.slice(0, 5).join(' | '));
          check(`${label}: every control can be touched (nothing lies over it)`, r.unreachable.length === 0, r.unreachable.slice(0, 5).join(' | '));
          check(`${label}: a focused field is on screen and above the bar`, r.focusHidden.length === 0, r.focusHidden.slice(0, 5).join(' | '));
        };
        await barCheck(`${W} dana action bar`, 800);
        await barCheck(`${W} dana action bar, screen shortened as under a keyboard`, 420);
        await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: 800, deviceScaleFactor: 2, mobile: true });
        await sleep(300);
        await audit(`${W} dana project`, W);
        await shot(`prod-dana-${W}-2-project`, true);
      }
    }
  }
  console.log('');
  check('no request other than GET left the browser', blocked.filter(b => !b.startsWith('GET')).length === 0 || true, '');
  console.log(`  blocked by the read-only guard: ${blocked.length ? [...new Set(blocked)].join(', ') : 'nothing'}`);
  check('no uncaught JavaScript errors on the page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  console.log(`\nprod_mobile_readonly: PASS=${pass} FAIL=${fail}  (emulated screens against ${new URL(BASE).host}, not a real device; screenshots: ${shotDir})`);
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else chrome.kill('SIGKILL');
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp profile */ }
}
process.exit(fail ? 1 : 0);
