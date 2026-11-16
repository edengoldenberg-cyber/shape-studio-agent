/**
 * dana_round4_page_check.mjs — the round-4 parts of the owner's page in a real (headless) browser, desktop and phone size.
 *
 *   node tests/dana_round4_page_check.mjs <base url of a running preview> [screenshots dir]
 *
 * Read-only. Needs a preview whose data holds a reel and a story made from one source (scripts/dana_e2e_round4.cjs).
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
const reel = projects.find(p => p.groupId && p.target === 'reel'), story = projects.find(p => p.groupId && p.target === 'story');
if (!reel || !story) { console.error('[FATAL] the preview has no reel + story pair'); process.exit(2); }
const { skills } = await api('/skills');
const upgraded = skills.find(k => k.versions.length > 1);

const dbgPort = await freePort(), profileDir = mkdtempSync(path.join(tmpdir(), 'dana-r4-chrome-'));
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
    await waitFor(() => has('#uptarget'));
    check(`${name}: the upload form asks for the target: reel / story / both`, (await ev(`[...document.querySelectorAll('#uptarget option')].map(o => o.value).join()`)) === 'reel,story,both');
    await ev(`(document.querySelector('[data-home="projects"]')||{click(){}}).click()`); await sleep(300);
    check(`${name}: the project list shows each output with its target`, /ריל/.test(await text('#projects')) && /סטורי/.test(await text('#projects')));

    await openStep(reel.id, 'edit');
    await waitFor(() => has('#timeline'));
    check(`${name}: reel — the target card says what the target changed`, /סרטון רציף אחד/.test(await text('#target')), (await text('#target')).slice(0, 120));
    check(`${name}: reel — the timeline lists every stretch with its skill, text, sound, assets and transition`, /סקיל אחראי/.test(await text('#timeline')) && /מעבר:/.test(await text('#timeline')) && /נכסים:/.test(await text('#timeline')));
    check(`${name}: reel — graphics are split: over the footage / replaces the footage, each removable on its own`, /מעל הצילום/.test(await text('#graphics')) && /מחליף את הצילום/.test(await text('#graphics')) && ((await ev(`document.querySelectorAll('#graphics [data-play]').length`)) === 0 || await has('#graphics [data-grm]')));
    check(`${name}: reel — a switch for animation scenes next to the one for overlay graphics`, await has('#adjust [data-adj="animation"]') && await has('#adjust [data-adj="graphics"]'));
    check(`${name}: reel — the other output of the same source is one tap away`, await has('#siblings [data-open]') || (await openStep(reel.id, 'project'), await has('#siblings [data-open]')));
    await openStep(reel.id, 'edit'); await waitFor(() => has('#timeline'));
    check(`${name}: reel edit step — nothing runs off the screen`, (await overflow()).length === 0, JSON.stringify(await overflow()));
    await shot(`r4_${name}_reel_edit`);

    await openStep(reel.id, 'review');
    await waitFor(() => has('#finalreview'));
    const fr = await text('#finalreview');
    check(`${name}: "הביקורת הסופית של דנה" is on the review step, for this version and target`, /הדירוג הסופי של דנה — גרסה \d+ · ריל/.test(fr), fr.slice(0, 80));
    check(`${name}: final review — skills and versions, coverage, compliance`, /dana-review/.test(fr) && /היקף הכיסוי/.test(fr) && /עמידה בכללי הסקילים/.test(fr));
    check(`${name}: final review — what worked / needs improvement / not checked / limits`, /מה הצליח/.test(fr) && /מה דורש שיפור/.test(fr) && /מה לא נבדק/.test(fr) && /מגבלות הביקורת/.test(fr));
    check(`${name}: final review — says it is not an approval and not by score alone`, /זו אינה אישור/.test(fr) && /לא לפי הדירוג לבדו/.test(fr));
    check(`${name}: final review — explains the change against the previous version (or says there is none)`, /מה השתנה בדירוג מול הגרסה הקודמת|אין גרסה קודמת/.test(fr));
    check(`${name}: review step — nothing runs off the screen`, (await overflow()).length === 0, JSON.stringify(await overflow()));
    await shot(`r4_${name}_reel_final_review`);
    // refresh stability: an opened <details> inside the final review stays open across a poll
    await ev(`(() => { const d = [...document.querySelectorAll('#finalreview details')].find(x => !x.open); if (d) { d.open = true; d.dataset.t = '1'; } })()`);
    await sleep(6500);
    check(`${name}: an opened section of the final review stays open after the page refreshes itself`, await ev(`(() => { const d = document.querySelector('#finalreview details[data-t="1"]'); return !d || d.open; })()`) && await has('#finalreview'));

    await openStep(story.id, 'edit');
    await waitFor(() => has('#target'));
    const tc = await text('#target');
    check(`${name}: story — cards, own safe zone, no cover text, no post caption, publishing stated as not supported`, /כרטיסי סטורי/.test(tc) && /לסטורי אין קאבר/.test(tc) && /לסטורי אין קפשן/.test(tc) && /לא נבדק/.test(tc), tc.slice(0, 200));
    check(`${name}: story — each card can be played as its own file`, (await ev(`document.querySelectorAll('#target video').length`)) >= 1);
    await shot(`r4_${name}_story_edit`);
    await openStep(story.id, 'review'); await waitFor(() => has('#finalreview'));
    check(`${name}: story has its OWN final review`, /· סטורי/.test(await text('#finalreview')));

    await goto(`${base}/dana-studio.html`); await waitFor(() => has('[data-home="skills"]'));
    await ev(`document.querySelector('[data-home="skills"]').click()`); await waitFor(() => has('#sk_goal'));
    check(`${name}: skill form — goal, mandatory, open to suggestion, what not to take, example videos (saved or new)`, await has('#sk_must') && await has('#sk_open') && await has('#sk_avoid') && await has('#skex') && await has('#skaddfiles'));
    check(`${name}: a default COMBINATION of skills can be set, in priority order`, !!(await waitFor(() => has('#skset [data-skset]'))) && await has('#sksetsave'));
    if (upgraded) { await ev(`(document.querySelector('[data-skopen="${upgraded.id}"]')||{click(){}}).click()`); await sleep(700);
      const sc = await text('#skillcard');
      check(`${name}: an approved skill offers "שדרג סקיל באמצעות רפרנס"`, /שדרג סקיל באמצעות רפרנס/.test(sc), sc.slice(0, 100));
      check(`${name}: the upgraded version shows its comparison (kept / added / changed, and why)`, /שדרוג מגרסה/.test(sc) && /נשאר/.test(sc), sc.slice(0, 160)); }
    check(`${name}: skills tab — nothing runs off the screen`, (await overflow()).length === 0, JSON.stringify(await overflow()));
    await shot(`r4_${name}_skills`);
  }
  check('no JavaScript errors on the page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) { check('the check ran to the end', false, e.stack || e); }
finally { kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
