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
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync, cpSync, mkdirSync } from 'fs';
import { tmpdir }           from 'os';
import path                 from 'path';

const require = createRequire(import.meta.url);
const { createIsolatedDataDir, removeDir, isolatedChildEnv, freePort, waitFor } = require('./helpers/isolated_env.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const seed = arg('--seed'), shots = arg('--shots');

const WORKER_TOKEN = 'test-worker-token-not-a-secret-0123';
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
  // Round 2 rebuilt the studio page around six workflow steps. The page itself (steps, transcript verification, review, references)
  // is now checked by tests/dana_studio_page_check.mjs; this script keeps checking the Dana TAB of the panel that embeds it.
  // The sections below that walked the old single-page layout are switched off rather than silently rewritten.
  const LEGACY_LAYOUT = false;
  const seeded = LEGACY_LAYOUT && !!(seed && existsSync(path.join(seed, 'dana')));
  let oldId = null; const NEW_ID = 'prj_newstylepackage01';
  if (seeded) {
    cpSync(path.join(seed, 'dana'), path.join(dataDir, 'dana'), { recursive: true });
    // Second project: the same local test package, re-labelled with the fields the NEW worker sends
    // (plan, zooms, transcript doubts, per-card source times, rules used). The original stays as the "old package".
    const sf = path.join(dataDir, 'dana', 'studio.json'), st = JSON.parse(readFileSync(sf, 'utf8'));
    const old = Object.values(st.projects)[0]; oldId = old.id;
    const np = JSON.parse(JSON.stringify(old));
    np.id = NEW_ID; np.title = 'חבילה בפורמט החדש'; np.createdAt = new Date(Date.parse(old.createdAt) + 1000).toISOString();
    np.publication = null; np.status = 'ready_for_review'; np.captionEdits = []; np.zoomEdits = [];
    const v = np.versions.find(x => x.n === np.currentVersion); v.approval = null; v.status = 'ready_for_review';
    const k = v.package, seg = k.segment;
    k.judgement_mode = 'model';
    k.cards = k.cards.map(c => ({ ...c, source_start_s: +(seg.in_s + c.start).toFixed(3), source_end_s: +(seg.in_s + c.start + c.dur).toFixed(3) }));
    k.plan = { message: 'מסר לבדיקה', hook: 'פתיחה לבדיקה', rationale: 'נימוק לבדיקה', content_judgement: 'model', brief: ['שורת תדריך'],
      segments: [{ n: 1, source_in_s: seg.in_s, source_out_s: seg.out_s, tl_in_s: 0, tl_out_s: k.duration, role: 'hook', why: 'קטע בדיקה' }] };
    k.zooms = [{ id: 'z@152.0', source_t_s: 152.0, tl_t_s: 2.0, scale: 1.15, ease_s: 0.4, hold_until_s: k.duration, reason: 'משפט מפתח (בדיקה)', evidence: 'rms +3dB' }];
    k.transcript = { status: 'auto_unverified', corrections_applied: [],
      doubts: [{ card: 2, tl_start_s: k.cards[1].start, tl_end_s: k.cards[1].start + k.cards[1].dur, source_start_s: k.cards[1].source_start_s, source_end_s: k.cards[1].source_end_s, word: 'בדיקה', kind: 'low_confidence', note: 'prob 0.5' }] };
    k.rules_used = { skill: { name: 'dana-editing', version: '1.0.0', sha256: 'a'.repeat(64) }, profile: { id: 'center-bold-v1', version: '1', sha256: 'b'.repeat(64) }, standing_rules: [{ id: 'rule_abc', version: 2 }], references: [] };
    k.revision_mode = 'locked_to_previous_plan';
    k.quality = { technical: { passed: 14, failed: 1, warned: 2, failed_ids: ['caption_text'] }, content_review: { met: 12, total: 14, not_met: [{ id: 'A9', note: 'אין טקסט קאבר' }], basis: 'תמלול ופריימים בודדים בלבד' },
                  owner_needed: { listening_doubts: 5, review_items: 1, human_checks: ['listening', 'framing', 'meaning'] }, not_verified: ['תחושת התנועה של הזום'] };
    st.projects[NEW_ID] = np;
    writeFileSync(sf, JSON.stringify(st));
    cpSync(path.join(dataDir, 'dana', 'projects', old.id), path.join(dataDir, 'dana', 'projects', NEW_ID), { recursive: true });
  }
  const [appPort, mockPort, dbgPort] = [await freePort(), await freePort(), await freePort()];
  mock = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url.includes('/arbox') ? { data: [] } : { idMessage: 'MOCK' })); }); });
  await new Promise(r => mock.listen(mockPort, '127.0.0.1', r));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
    env: isolatedChildEnv(dataDir, { PORT: String(appPort), TEST_MODE: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
      GREEN_API_URL: `127.0.0.1:${mockPort}`, GREEN_API_ID_INSTANCE: '9990001', GREEN_API_TOKEN_INSTANCE: 'mock',
      ARBOX_BASE_URL: `http://127.0.0.1:${mockPort}/arbox`, ARBOX_API_KEY: 'mock-arbox', DANA_WORKER_TOKEN: WORKER_TOKEN }),
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
    check('studio page loaded inside the tab', await until(`${D} && ${D}.readyState === 'complete' && !!${D}.getElementById('pickraw')`));
    check('upload control is present and usable', await evalJs(`(() => { const b = ${D}.getElementById('pickraw'), r = b.getBoundingClientRect(); return !b.disabled && r.width > 100 && r.height >= 44 && !!${D}.getElementById('file'); })()`));
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
      await evalJs(`${D}.querySelector('#projects .proj[data-id="${oldId}"]').click()`);
      check('project opens: processing history and review package', await until(`!${D}.getElementById('detail').classList.contains('hidden') && !!${D}.querySelector('#detail video')`));
      check('review video has a source and the cover is shown', await evalJs(`!!${D}.querySelector('#detail video').getAttribute('src') && !!${D}.querySelector('#detail img.cover')`));
      check('video is playable (metadata loads through the panel)', await until(`${D}.querySelector('#detail video').readyState >= 1 && ${D}.querySelector('#detail video').duration > 1`, 20000));
      check('approval actions are visible inside the frame', await evalJs(`(() => { const a = ${D}.getElementById('actions'); if (a.classList.contains('hidden')) return false; const r = a.getBoundingClientRect(); return r.bottom <= ${F}.clientHeight + 1 && r.height > 40 && !!a.querySelector('[data-act="approve"]'); })()`));
      check('approval bar is on screen without scrolling the panel', await evalJs(`(() => { const f = ${F}.getBoundingClientRect(), a = ${D}.getElementById('actions').getBoundingClientRect(); return f.top + a.bottom <= window.visualViewport.height + 1; })()`), await evalJs(`JSON.stringify([${F}.getBoundingClientRect().top, ${D}.getElementById('actions').getBoundingClientRect().bottom, window.visualViewport.height])`));
      await shot(`${vp.name}-2-package`);
      check('old package (no new fields) still renders: captions editor, style, revise — and no plan / zoom sections', await evalJs(`!!${D}.getElementById('captions') && !!${D}.getElementById('style') && !!${D}.getElementById('revise') && !${D}.getElementById('plan') && !${D}.getElementById('zooms')`));
      check('automatic transcript is not called an exact quote', await evalJs(`!/ציטוט מדויק\\)/.test(${D}.getElementById('detail').innerText) && /תמלול אוטומטי — לא אומת/.test(${D}.getElementById('captions').innerText)`));
      await evalJs(`${D}.getElementById('back').click()`);
      check('back returns to upload + project list', await until(`!${D}.getElementById('list').classList.contains('hidden')`));
      check('list page: standing rules, references (a file is analysed by the worker; links are not fetched), destination account', await until(`!!${D}.getElementById('rules') && /דנה לא מורידה קישורים/.test(${D}.getElementById('list').innerText) && !/עדיין לא פעיל/.test(${D}.getElementById('list').innerText) && !!${D}.getElementById('acctset') && !!${D}.getElementById('refadd')`));

      // ── the NEW-format package ──
      await evalJs(`${D}.querySelector('#projects .proj[data-id="${NEW_ID}"]').click()`);
      check('new package: plan with message, segment map and rules used', await until(`!!${D}.getElementById('plan') && /מסר לבדיקה/.test(${D}.getElementById('plan').innerText) && /center-bold-v1/.test(${D}.getElementById('plan').innerText) && ${D}.querySelectorAll('#plan [data-play]').length === 1`));
      check('quality is three separate blocks plus what was not verified — and no "N/14" headline anywhere', await evalJs(`(() => { const d = ${D}, q = d.getElementById('quality'); if (!q) return false; const t = n => d.getElementById(n)?.innerText || '';
        return /בדיקות טכניות \\(אוטומטיות\\)/.test(t('q-technical')) && /14 עברו/.test(t('q-technical')) && /caption_text/.test(t('q-technical'))
          && /הערכת תוכן \\(מודל, על תמלול ופריימים בודדים\\)/.test(t('q-content')) && /A9/.test(t('q-content'))
          && /דורש צפייה או האזנה שלך/.test(t('q-owner')) && /5/.test(t('q-owner')) && /לא נבדק/.test(t('q-notverified')) && /תחושת התנועה/.test(t('q-notverified'))
          && !/\\d+\\/14/.test(d.getElementById('detail').innerText) && !/קריטריוני קבלה \\(/.test(d.getElementById('detail').innerText); })()`));
      check('the revision mode and the standing rules used (id + version) are shown in plain words', await evalJs(`/נעול לתוכנית של הגרסה הקודמת — רק מה שביקשת השתנה/.test(${D}.getElementById('revmode')?.innerText || '') && /rule_abc/.test(${D}.getElementById('plan').innerText) && /גרסה 2/.test(${D}.getElementById('plan').innerText)`));
      check('captions editor: one field per card, the doubt is marked on its card', await evalJs(`(() => { const d = ${D}; const n = d.querySelectorAll('#captions input[data-card]').length; const li = d.querySelector('#captions input[data-card="2"]').closest('li'); return n > 5 && [...d.querySelectorAll('#captions input[data-card]')].every(i => !i.disabled) && /ודאות נמוכה/.test(li.innerText) && d.querySelectorAll('#captions .pill.warn').length === 2; })()`));
      check('tapping a card seeks the review video to it', await evalJs(`(async () => { const d = ${D}, v = d.getElementById('mainvid'); d.querySelector('#captions input[data-card="3"]').closest('li').querySelector('[data-play]').click(); await new Promise(r => setTimeout(r, 400)); const t0 = Number(d.querySelector('#captions input[data-card="3"]').closest('li').querySelector('[data-play]').dataset.play.split(',')[0]); const ok = Math.abs(v.currentTime - t0) < 1.5; v.pause(); return ok; })()`));
      check('style preview is drawn over a real frame', await until(`(() => { const c = ${D}.getElementById('pv'); const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < px.length; i += 400) if (px[i] + px[i + 1] + px[i + 2] > 60) lit++; return lit > 50; })()`));
      check('zooms are listed with time, strength and reason', await evalJs(`/משפט מפתח/.test(${D}.getElementById('zooms').innerText) && !!${D}.querySelector('#zooms select[data-zoom="z@152.0"]')`));
      check('versions section and the single revise action exist', await evalJs(`!!${D}.getElementById('versions') && !!${D}.querySelector('#revise [data-do="revise"]')`));
      check('no horizontal overflow inside the studio with every section open', await evalJs(`${D}.documentElement.scrollWidth <= ${F}.clientWidth + 1`), await evalJs(`${D}.documentElement.scrollWidth + ' > ' + ${F}.clientWidth`));
      await shot(`${vp.name}-4-new-package`);
      await evalJs(`${D}.getElementById('back').click()`);
      await until(`!${D}.getElementById('list').classList.contains('hidden')`);
    }

    await evalJs(`document.querySelector('.dana-switch-btn[data-dana-view="tools"]').click()`);
    check('previous tools open as a separate view', await evalJs(`!document.getElementById('dana-view-tools').hidden && document.getElementById('dana-view-studio').hidden && ${visible('.dana-layout')}`));
    check('previous tools are intact (analysis upload, chat)', await evalJs(`!!document.getElementById('vup-submit') && !!document.getElementById('dana-chat-input') && !!document.getElementById('dana-send')`));
    check('previous tools fit the visible screen width', await evalJs(`[...document.querySelectorAll('#dana-view-tools, #dana-view-tools *')].every(e => e.offsetParent === null || e.getBoundingClientRect().width <= window.visualViewport.width + 1)`));
    await shot(`${vp.name}-3-tools`);
    await evalJs(`document.querySelector('.dana-switch-btn[data-dana-view="studio"]').click()`);
    check('switching back shows the studio again without reloading it', await evalJs(`!document.getElementById('dana-view-studio').hidden && !!${D}.getElementById('pickraw')`));
    await evalJs(`document.querySelector('.tab-btn[data-tab="barak"]').click()`);
    check('other tabs still switch (Barak)', await evalJs(`document.getElementById('tab-barak').classList.contains('active') && !document.getElementById('tab-dana').classList.contains('active')`));
  }
  if (seeded) {
    // ── "הפק גרסה מתוקנת" end to end: the page → the server → the job the worker would receive ──
    console.log('\n── revise flow');
    await evalJs(`document.querySelector('.tab-btn[data-tab="dana"]').click()`);
    await until(`${D} && !!${D}.querySelector('#projects .proj[data-id="${NEW_ID}"]')`);
    await evalJs(`${D}.querySelector('#projects .proj[data-id="${NEW_ID}"]').click()`);
    await until(`${D}.getElementById('list').classList.contains('hidden') && !${D}.getElementById('detail').classList.contains('hidden') && !!${D}.querySelector('#captions input[data-card="2"]')`);   // the project is loaded, not the previous DOM
    const original = await evalJs(`${D}.querySelector('#captions input[data-card="2"]').value`);
    await evalJs(`(() => { const d = ${D}, w = ${F}.contentWindow; w.prompt = () => 'בודק אוטומטי'; w.confirm = () => true;
      const set = (el, val) => { el.value = val; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
      set(d.querySelector('#captions input[data-card="2"]'), 'כתובית מתוקנת');
      set(d.getElementById('st_size'), '110');
      const z = d.querySelector('#zooms select[data-zoom="z@152.0"]'); z.value = 'remove'; z.dispatchEvent(new w.Event('input', { bubbles: true }));
      set(d.getElementById('rvnote'), 'הערת בדיקה לפרויקט');
      const r = d.querySelector('input[name="rvscope"][value="project"]'); r.checked = true; r.dispatchEvent(new w.Event('input', { bubbles: true })); })()`);
    check('the summary lists what will go into the next version', await evalJs(`/1 תיקוני כתוביות/.test(${D}.getElementById('rvsum').textContent) && /שינוי סגנון/.test(${D}.getElementById('rvsum').textContent) && /1 שינויי זום/.test(${D}.getElementById('rvsum').textContent)`), await evalJs(`${D}.getElementById('rvsum').textContent`));
    await evalJs(`${D}.querySelector('#revise [data-do="revise"]').click()`);
    const api = async (u, o) => (await fetch(`http://127.0.0.1:${appPort}${u}`, o)).json().catch(() => ({}));
    const queued = await waitFor(async () => { const p = (await api(`/api/dana/studio/projects/${NEW_ID}`)).project; return p && p.currentVersion === 2 && p.status === 'editing' ? p : null; }, { timeoutMs: 10000, intervalMs: 200 });
    check('pressing it queues version 2 and keeps version 1', !!queued && queued.versions.length === 2 && queued.versions[0].hasVideo === true, JSON.stringify(queued?.versions));
    check('the page shows the new version in the queue', await until(`/ממתין בתור|בעריכה/.test(${D}.getElementById('detail').innerText)`));
    const W = { method: 'POST', headers: { Authorization: `Bearer ${WORKER_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: 'check', pipelineVersion: 't' }) };
    const leased = await api('/api/dana/worker/lease', W), o = leased.job?.options ?? {};
    check('the job carries the caption correction with its source time and original text', o.caption_edits?.length === 1 && o.caption_edits[0].text === 'כתובית מתוקנת' && o.caption_edits[0].original === original && o.caption_edits[0].source_end_s > o.caption_edits[0].source_start_s, JSON.stringify(o.caption_edits));
    check('the job carries the style change, the zoom removal and the project note; no adapter is forced', o.style_overrides?.caption_size === 110 && o.zoom_edits?.[0]?.id === 'z@152.0' && o.zoom_edits[0].action === 'remove' && o.change_request === 'הערת בדיקה לפרויקט' && (o.adapter === undefined || o.adapter === 'claude'), JSON.stringify({ s: o.style_overrides, z: o.zoom_edits, c: o.change_request, a: o.adapter }));
  }
  if (LEGACY_LAYOUT) {
    // ── Reference: owner uploads a file + note → the worker analyses → the page shows it → the owner approves ──
    console.log('\n── reference analysis flow');
    const base = `http://127.0.0.1:${appPort}`, WH = { Authorization: `Bearer ${WORKER_TOKEN}`, 'Content-Type': 'application/json' };
    const fd = new FormData();
    fd.append('title', 'רפרנס לבדיקה'); fd.append('by', 'בודק אוטומטי'); fd.append('owner_note', 'אהבתי את הפתיחה'); fd.append('usage_permission', 'inspiration_only');
    fd.append('file', new Blob([Buffer.alloc(4000, 7)], { type: 'video/mp4' }), 'ref.mp4');
    const added = await (await fetch(`${base}/api/dana/studio/references`, { method: 'POST', body: fd })).json();
    const rid = added.reference?.id;
    check('a reference with a file waits for the worker', added.reference?.status === 'awaiting_analysis', JSON.stringify(added).slice(0, 200));
    const lr = await (await fetch(`${base}/api/dana/worker/references/lease`, { method: 'POST', headers: WH, body: JSON.stringify({ workerId: 'check' }) })).json();
    const file = await fetch(`${base}/api/dana/worker/references/${rid}/file`, { headers: { ...WH, 'X-Lease-Token': lr.leaseToken } });
    check('the worker leases it and downloads the file with the lease', lr.reference?.id === rid && file.status === 200 && (await file.arrayBuffer()).byteLength === 4000);
    const analysis = { summary: 'פתיחה ישירה וכתוביות גדולות', basis_note: 'מדידות קוד ופריימים בודדים; בלי האזנה', measured: { duration_s: 12.5, cuts_s: [3.2], avg_shot_s: 6.2, words_per_s: 2.4, face_scale_changes: [{ t_s: 3.2, ratio: 1.2 }], notes: [] },
      aspects: [{ aspect: 'opening', observation: 'נפתח על המשפט המרכזי', example_times_s: [0.0, 1.5], rule: 'לפתוח על המשפט החזק', basis: 'measured' },
                { aspect: 'sound', observation: 'ייתכן שיש מוזיקה', example_times_s: [], rule: '', basis: 'hypothesis' }],
      do_not_imitate: ['הלוגו של החשבון'], hypotheses: ['הקצב לפי מוזיקה'], proposed_profile: { params: { caption_size: 104, caption_max_lines: 1, backing: false }, rules: ['לפתוח על המשפט החזק'] } };
    const posted = await (await fetch(`${base}/api/dana/worker/references/${rid}/analysis`, { method: 'POST', headers: { ...WH, 'X-Lease-Token': lr.leaseToken }, body: JSON.stringify({ status: 'analysed', analysis }) })).json();
    check('the analysis is accepted', posted.status === 'analysed', JSON.stringify(posted));
    await evalJs(`document.querySelector('.tab-btn[data-tab="dana"]').click()`);
    await evalJs(`(() => { const d = ${D}; if (d.getElementById('list').classList.contains('hidden')) d.getElementById('back').click(); })()`);
    const card = `${D}.querySelector('#refs li[data-refid="${rid}"]')`;
    await evalJs(`${F}.contentWindow.location.reload()`);
    check('the page shows the analysis: note, summary, basis labels, example times, what not to imitate, hypotheses', await until(`(() => { const c = ${card}; if (!c) return false; const t = c.innerText;
      return /נותח — מחכה להחלטה שלך/.test(t) && /אהבתי את הפתיחה/.test(t) && /פתיחה ישירה וכתוביות גדולות/.test(t) && /נמדד/.test(t) && /השערה/.test(t) && /לא לחקות/.test(t) && /הלוגו של החשבון/.test(t)
        && /מדידות קוד ופריימים בודדים/.test(t) && c.querySelectorAll('[data-refplay][data-t="1.5"]').length === 1 && !!c.querySelector('input[data-pk="caption_size"]') && !!c.querySelector('[data-refapprove]') && !!c.querySelector('[data-refreject]'); })()`, 15000));
    await evalJs(`${card}.querySelector('[data-refplay][data-t="1.5"]').click()`);
    check('tapping an example time opens the reference player on that reference', await evalJs(`(() => { const v = ${D}.getElementById('refvid'); return !v.classList.contains('hidden') && v.dataset.ref === '${rid}' && v.getAttribute('src').endsWith('/references/${rid}/file'); })()`));
    check('nothing is approved or default before the owner decides', (await (await fetch(`${base}/api/dana/studio/profiles`)).json()).profiles.every(p => p.source_reference !== rid));
    await evalJs(`(() => { const w = ${F}.contentWindow, c = ${card}; w.prompt = () => 'בודק אוטומטי'; w.confirm = () => true;
      const i = c.querySelector('input[data-pk="caption_size"]'); i.value = '110'; c.querySelector('[data-refdefault]').checked = true; c.querySelector('[data-refapprove]').click(); })()`);
    const prof = await waitFor(async () => { const j = await (await fetch(`${base}/api/dana/studio/profiles`)).json(); return j.default?.source_reference === rid ? j : null; }, { timeoutMs: 8000, intervalMs: 200 });
    check('approving with an adjusted number creates version 1 of the reference profile and makes it the default', !!prof && prof.default.id === `ref-${rid}` && prof.default.version === 1 && prof.default.params.caption_size === 110 && prof.default.params.caption_max_lines === 1 && prof.default.rules.length === 1, JSON.stringify(prof?.default));
    check('the page shows the approved profile on the reference and as the default', await until(`/פרופיל אושר/.test(${card}?.innerText || '') && /ref-${rid}/.test(${D}.getElementById('profnow').textContent)`, 8000));
    await shot('reference-analysed');
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
