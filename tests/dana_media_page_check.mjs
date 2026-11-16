/**
 * dana_media_page_check.mjs — the compilation / music / narration screens of the owner's page in a real (headless)
 * browser, desktop and phone size. Read-only.
 *
 *   node tests/dana_media_page_check.mjs <base url of a running preview> [screenshots dir]
 *
 * Needs a preview whose data holds a compilation project (scripts/dana_e2e_montage.cjs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:3191').replace(/\/$/, ''), shots = process.argv[3] || null;
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}${detail ? '  →  ' + String(detail).slice(0, 300) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, { timeoutMs = 15000, intervalMs = 150 } = {}) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > timeoutMs) return null; await sleep(intervalMs); } };
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const browserBin = process.env.CHROME_BIN ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p));
if (!browserBin) { console.error('[FATAL] no Chrome/Edge binary (set CHROME_BIN)'); process.exit(2); }
const api = async p => (await fetch(base + '/api/dana/studio' + p)).json();
const { projects } = await api('/projects');
let mont = null;
for (const p of projects) { const full = (await api('/projects/' + p.id)).project; if (full.media && full.media.sources.length > 1) { mont = full; break; } }
if (!mont) { console.error('[FATAL] the preview has no project with several source files'); process.exit(2); }

const dbgPort = await freePort(), profileDir = mkdtempSync(path.join(tmpdir(), 'dana-media-chrome-'));
const chrome = spawn(browserBin, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const kill = () => spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()).find(t => t.type === 'page'), { timeoutMs: 20000 });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(), pageErrors = [];
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown'); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  const ev = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed'); return r.result.value; };
  const shot = async name => { if (!shots) return; mkdirSync(shots, { recursive: true });
    const m = await cdp('Page.getLayoutMetrics'); const h = Math.min(Math.ceil(m.cssContentSize.height), 14000);
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: m.cssContentSize.width, height: h, scale: 1 } });
    writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64')); };
  const goto = async url => { await cdp('Page.navigate', { url: 'about:blank' }); await sleep(150); await cdp('Page.navigate', { url }); };
  const openStep = async (id, stepKey) => { await goto(`${base}/dana-studio.html#${id}`);
    await waitFor(() => ev(`!!document.querySelector('#steps [data-step="${stepKey}"]')`));
    await ev(`document.querySelector('#steps [data-step="${stepKey}"]').click()`); await sleep(500); };
  const has = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);
  const overflow = () => ev(`[...document.querySelectorAll('.card')].filter(c => { const r = c.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 2 || r.left < -2); }).map(c => c.id || c.querySelector('h2')?.innerText || 'card').slice(0, 5)`);

  for (const [name, w, h, mobile] of [['desktop', 1400, 900, false], ['phone', 390, 844, true]]) {
    console.log(`\n== ${name} ==`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    await goto(`${base}/dana-studio.html`);
    await waitFor(() => has('#uptype'));
    check(`${name}: a new project asks for its kind and accepts several video files at once`, (await ev(`[...document.querySelectorAll('#uptype option')].map(o => o.value).join()`)) === 'interview,montage,narrated,mixed' && await ev(`document.querySelector('#file').multiple`));
    await openStep(mont.id, 'project');
    await waitFor(() => has('#media'));
    const m = await text('#media');
    check(`${name}: project step lists every source file with viewing and marking`, (await ev(`document.querySelectorAll('#media video').length`)) === mont.media.sources.length && /חייב להיכלל/.test(await ev(`document.querySelector('#media select[id^="mk_"]').textContent`)) && await has('#media [data-mark-add]'));
    check(`${name}: more source files can be added from the panel`, await has('#media [data-do="addsrc"]') && await has('#addsrc'));
    check(`${name}: music — upload, listen before the edit, start point, level, fades, ducking, and a licence that is not assumed`, await has('#media [data-do="addmusic"]') && (await ev(`document.querySelectorAll('#media audio').length`)) >= 1
      && await has('#media [data-au="music.start_s"]') && await has('#media [data-au="music.volume_db"]') && await has('#media [data-au="music.fade_out_s"]') && await has('#media [data-au="music.duck"]') && /רישיון: (לא אושר|אושר)/.test(m));
    check(`${name}: narration — upload of a ready file, marked as a script; the text-to-speech connection is stated as not active`, await has('#media [data-do="addnar"]') && /אינה פעילה/.test(m));
    check(`${name}: original sound — keep or mute; and three separate actions: save, new mix without re-planning, plan again from all sources`, await has('#media [data-au="original.mode"]')
      && await has('#media [data-do="saveaudio"]') && await has('#media [data-do="remix"]') && await has('#media [data-do="replan"]'));
    check(`${name}: project step — nothing runs off the screen`, (await overflow()).length === 0, JSON.stringify(await overflow()));
    await shot(`media_${name}_project`);
    // an opened source stays open across the page's own refresh, and what was typed is kept
    await ev(`(() => { const d = document.querySelector('#media details'); d.open = true; const i = document.querySelector('#media input[id^="mn_"]'); i.value = 'הערת בדיקה'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(6500);
    check(`${name}: an opened source and a typed note survive the page's own refresh`, await ev(`(() => { const d = document.querySelector('#media details'), i = document.querySelector('#media input[id^="mn_"]'); return !!d && d.open && i.value === 'הערת בדיקה'; })()`));

    await openStep(mont.id, 'edit');
    await waitFor(() => has('#sourcemap'));
    const sm = await text('#sourcemap');
    check(`${name}: edit step — the source map names the file and the time inside it for every part`, /קטע 1/.test(sm) && /בקובץ:/.test(sm) && (await ev(`document.querySelectorAll('#sourcemap [data-play]').length`)) >= 2);
    check(`${name}: one part can be replaced or removed on its own`, await has('#sourcemap [data-seg-replace]') && await has('#sourcemap [data-seg-remove]'));
    const mx = await text('#mix');
    check(`${name}: the mix card shows the parameters, what was measured and the licence state`, /מיקס האודיו/.test(mx) && /נמדד:/.test(mx) && /רישיון המוזיקה/.test(mx) && /דורש האזנה שלך/.test(mx), mx.slice(0, 120));
    check(`${name}: the timeline lists the parts with their source files`, /קובץ מקור:/.test(await text('#timeline')));
    check(`${name}: edit step — nothing runs off the screen`, (await overflow()).length === 0, JSON.stringify(await overflow()));
    await shot(`media_${name}_edit`);
    await openStep(mont.id, 'review');
    await waitFor(() => has('#finalreview'));
    const fr = await text('#finalreview');
    check(`${name}: the compilation has its final review, with what was not checked and that it is not an approval`, /הדירוג הסופי של דנה/.test(fr) && /מה לא נבדק/.test(fr) && /זו אינה אישור/.test(fr));

    await goto(`${base}/dana-studio.html`); await waitFor(() => has('[data-home="about"]'));
    await ev(`document.querySelector('[data-home="about"]').click()`); await waitFor(() => has('#connectors'));
    const cn = await text('#connectors');
    check(`${name}: external connections are shown as they are: narration "prepared, not active" with what is missing and the next action; music by manual upload; publishing off`,
      /מוכן, לא פעיל/.test(cn) && /הפעולה הבאה שלך/.test(cn) && /העלאה ידנית בלבד/.test(cn) && /CapCut/.test(cn) && /כבוי/.test(cn));
    await ev(`(() => { document.querySelector('#tts_text').value = 'זה תסריט קצר לבדיקה של הערכת העלות'; document.querySelector('#tts_est').click(); })()`);
    check(`${name}: a cost estimate for a script is shown without sending anything`, !!(await waitFor(async () => /תווים/.test(await text('#tts_out')))), await text('#tts_out'));
    await shot(`media_${name}_connectors`);
  }
  check('no JavaScript errors on the page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) { check('the check ran to the end', false, e.stack || e); }
finally { kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
