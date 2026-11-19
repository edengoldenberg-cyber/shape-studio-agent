// READ-ONLY render check of the Maya control dashboard + reminders screen. GET only.
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import net from 'net'; import path from 'path';
const BASE = process.argv[process.argv.indexOf('--base') + 1].replace(/\/$/, '');
const TOKEN = process.env.PROD_SESSION ?? '';
const WIDTHS = (process.argv.includes('--widths') ? process.argv[process.argv.indexOf('--widths') + 1] : '1366,390,360').split(',').map(Number);
const shotDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : '.';
const bin = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const check = (l, ok, d = '') => { ok ? (pass++, console.log('  ✓ ' + l)) : (fail++, console.log('  ✗ ' + l + (d ? ' → ' + d : ''))); };
const profile = mkdtempSync(path.join(tmpdir(), 'maya-ro-')); const port = await freePort();
const chrome = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const blocked = [];
try {
  let target = null; for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {} if (!target) await sleep(200); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp')); });
  let seq = 0; const pending = new Map(), pageErrors = [];
  const cdp = (m, p = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? 'err');
    if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    if (m.method === 'Fetch.requestPaused') { const ok = m.params.request.method === 'GET'; ok ? cdp('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {}) : (blocked.push(m.params.request.method + ' ' + new URL(m.params.request.url).pathname), cdp('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {})); } };
  const evalJs = async e => { const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const until = async (e, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(e)) return true; } catch {} await sleep(250); } return false; };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await cdp('Network.setCookie', { name: 'ss_session', value: TOKEN, url: BASE, httpOnly: true, secure: true, sameSite: 'Lax' });
  const q = s => JSON.stringify(s);
  const tap = async sel => { const b = await evalJs(`(()=>{const e=document.querySelector(${q(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,w:r.width}})()`); if (!b || !b.w) return false; await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] }); await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(600); return true; };
  const shot = async n => { await sleep(400); const s = await cdp('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (s) writeFileSync(path.join(shotDir, n + '.png'), Buffer.from(s.data, 'base64')); };
  const noHScroll = async W => evalJs(`Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= ${W} + 1`);
  for (const W of WIDTHS) {
    console.log(`\n── ${W}px ──`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: W < 900 ? 800 : 900, deviceScaleFactor: W < 900 ? 2 : 1, mobile: W < 900 });
    await cdp('Page.navigate', { url: BASE + '/' });
    check(`${W}: dashboard opens`, await until(`!!document.querySelector('#maya-subnav')`));
    // Control & Tasks
    check(`${W}: control sub-view opens`, await tap('#maya-subnav [data-mview="control"]') && await until(`!!document.querySelector('#maya-control-root .mc-tiles')`, 12000));
    const ctl = await evalJs(`({tiles:document.querySelectorAll('#maya-control-root .mc-tile').length, day:document.querySelectorAll('#maya-control-root .mc-day .mc-chip').length, filters:document.querySelectorAll('#maya-control-root .mc-filters select').length, list:document.querySelectorAll('#maya-control-root .mc-sec').length, crmLink:!!document.querySelector('#mc-crm'), boardLink:!!document.querySelector('#mc-board')})`);
    console.log(`  (bucket tiles:${ctl.tiles} day-chips:${ctl.day} filters:${ctl.filters} list-sections:${ctl.list})`);
    check(`${W}: control shows the 8 buckets, day summary, filters, list and source links`, ctl.tiles >= 8 && ctl.day >= 3 && ctl.filters >= 2 && ctl.list >= 1 && ctl.crmLink && ctl.boardLink);
    // the daily control-check (anomalies) section with its "check now" button
    const anom = await evalJs(`({ sec: /בקרה יומית/.test(document.querySelector('#maya-control-root')?.textContent||''), run: !!document.querySelector('#mc-runcheck') })`);
    check(`${W}: the daily control-check (anomalies) section renders with a "check now" button`, anom.sec && anom.run);
    // clicking a bucket filters the list
    check(`${W}: a bucket tile filters the list`, await tap('#maya-control-root [data-bucket="needs_action"]') && await until(`/דורש פעולה/.test([...document.querySelectorAll('#maya-control-root .mc-sec h3')].map(h=>h.textContent).join(' '))`, 6000));
    check(`${W} control: no sideways scroll`, await noHScroll(W));
    await shot(`prod-maya-${W}-1-control`);
    // Reminders
    check(`${W}: reminders sub-view opens`, await tap('#maya-subnav [data-mview="reminders"]') && await until(`!!document.querySelector('#mr-times')`, 10000));
    const rem = await evalJs(`(() => { const txt = document.querySelector('#maya-reminders-root')?.textContent||''; return {times:document.querySelector('#mr-times')?.value, hasSave:!!document.querySelector('#mr-save'), hasToggle:!!document.querySelector('#mr-toggle'), single:/תזכורת מרוכזת אחת/.test(txt), recipient:/נמען מאומת/.test(txt), snoozed:/משימות שנדחו/.test(txt), history:/היסטוריית ריצות/.test(txt)}; })()`);
    console.log(`  (reminder times: ${rem.times})`);
    check(`${W}: reminders screen shows times, save/toggle and the single-digest note`, rem.hasSave && rem.hasToggle && rem.single && /09:00/.test(rem.times || ''));
    check(`${W}: reminders screen shows the verified recipient, snoozed tasks and run history`, rem.recipient && rem.snoozed && rem.history);
    check(`${W} reminders: no sideways scroll`, await noHScroll(W));
    await shot(`prod-maya-${W}-2-reminders`);
  }
  console.log('');
  check('only GET left the browser', blocked.filter(b => !b.startsWith('GET')).length === 0, blocked.slice(0, 4).join(', '));
  check('no uncaught JS errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  console.log(`\nprod_maya_readonly: PASS=${pass} FAIL=${fail}`);
} catch (e) { console.log('ERR ' + e.message); }
finally { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
process.exit(fail ? 1 : 0);
