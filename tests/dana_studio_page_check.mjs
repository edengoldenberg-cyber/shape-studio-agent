/**
 * dana_studio_page_check.mjs — the owner's page in a real (headless) browser, desktop and phone size.
 *
 *   node tests/dana_studio_page_check.mjs <base url of a running preview> [screenshots dir]
 *
 * Read-only against the data of that preview: it opens projects, walks the six workflow steps, and checks that the main
 * actions are present, large enough to tap and inside the screen. The one thing it presses that talks to the server is
 * "אמת ושמור תיקון" WITHOUT listening first, which the page itself must refuse.
 * Start a preview first:  DANA_PREVIEW_DATA=<dir> PORT=3191 node scripts/dana_studio_preview.cjs
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
const browserBin = process.env.CHROME_BIN ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p));
if (!browserBin) { console.error('[FATAL] no Chrome/Edge binary (set CHROME_BIN)'); process.exit(2); }

const api = async p => (await fetch(base + '/api/dana/studio' + p)).json();
const { projects } = await api('/projects');
const edit = projects.find(p => p.kind !== 'review_only' && ['ready_for_review', 'approved'].includes(p.status)) ?? projects.find(p => ['ready_for_review', 'approved'].includes(p.status));
const rev = projects.find(p => p.kind === 'review_only');
if (!edit) { console.error('[FATAL] the preview has no finished edit project to open'); process.exit(2); }
const editP = (await api('/projects/' + edit.id)).project;

const dbgPort = await freePort(), profileDir = mkdtempSync(path.join(tmpdir(), 'dana-page-chrome-'));
const chrome = spawn(browserBin, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
const kill = () => { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); else { try { process.kill(chrome.pid, 'SIGKILL'); } catch { /* gone */ } } };
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()).find(t => t.type === 'page'), { timeoutMs: 20000 });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(), pageErrors = [];
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown');
    if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); };
  const js = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const until = (expr, ms = 15000) => waitFor(() => js(expr).catch(() => false), { timeoutMs: ms });
  const shot = async name => { if (!shots) return; mkdirSync(shots, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64')); };
  const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`;
  // RTL: content that is too wide spills to the LEFT, which scrollWidth alone does not always report - so every card is measured too
  const noOverflow = `document.documentElement.scrollWidth <= window.innerWidth + 1 && [...document.querySelectorAll('.card, .tabs, .actions')].filter(e => e.offsetParent !== null).every(e => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; })`;
  const tappable = sel => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null).every(e => e.getBoundingClientRect().height >= 32)`;
  const step = async k => { await js(`document.querySelector('#steps [data-step="${k}"]').click()`); await sleep(250); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  // a URL that differs only by its #hash is a same-document navigation: leave the page first so the project really loads
  const goto = async url => { await cdp('Page.navigate', { url: 'about:blank' }); await sleep(150); await cdp('Page.navigate', { url }); };

  for (const vp of [{ name: 'desktop', width: 1400, height: 900, mobile: false }, { name: 'phone', width: 390, height: 844, mobile: true }]) {
    console.log(`\n── ${vp.name} ${vp.width}x${vp.height}`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.mobile ? 2 : 1, mobile: vp.mobile });
    await cdp('Page.navigate', { url: `${base}/dana-studio.html` });
    check('home loads: projects are listed', await until(`document.querySelectorAll('#projects .proj').length > 0`));
    check('worker state is shown in the header', await until(`!/בודק/.test(document.getElementById('worker').textContent)`), await js(`document.getElementById('worker').textContent`));
    check('two upload actions: raw footage, and an edited video for review', await js(`${vis('#pickraw')} && ${vis('#pickreview')} && ${tappable('#pickraw, #pickreview')}`));
    check('the connected account can be chosen for a new project', await js(`[...document.querySelectorAll('#upacct option')].some(o => o.value === 'pilates_barre_power' && /מחובר/.test(o.textContent))`));
    check('every project row shows its next action', await js(`[...document.querySelectorAll('#projects .proj')].every(b => /הפעולה הבאה/.test(b.textContent))`));
    check('home: no horizontal scroll', await js(noOverflow));
    await shot(`${vp.name}-01-home`);
    await js(`document.querySelector('[data-home="refs"]').click()`);
    check('"רפרנסים וסגנון עריכה" is one tap from home, with multi-file upload and a compare action', await js(`${vis('#refpick')} && document.getElementById('ref_files').multiple && ${vis('#refcompare')}`));
    await until(`!/טוען/.test(document.getElementById('refs').textContent)`);
    await shot(`${vp.name}-02-references`);
    await js(`document.querySelector('[data-home="brand"]').click()`);
    check('brand: the connected account is shown as connected and verified', await until(`/pilates_barre_power/.test(document.getElementById('accounts').textContent) && /מחובר/.test(document.getElementById('accounts').textContent)`));
    check('brand: every setting is editable, missing ones are marked missing (nothing pre-filled)', await until(`document.querySelectorAll('#brand [data-brand]').length >= 10 && [...document.querySelectorAll('#brand li')].filter(li => /חסר/.test(li.querySelector('.pill').textContent)).every(li => li.querySelector('textarea').value === '')`));
    check('brand: no horizontal scroll', await js(noOverflow));
    await shot(`${vp.name}-03-brand`);

    // ── a finished edit ──
    await goto(`${base}/dana-studio.html#${edit.id}`);
    check('project opens with the player', await until(`!document.getElementById('detail').classList.contains('hidden') && !!document.querySelector('#mainvid[src]')`), await js(`document.getElementById('notice').textContent + ' | ' + document.getElementById('side').innerHTML.slice(0, 200)`) + ' | ' + pageErrors.join(';'));
    check('six workflow steps, in order', await js(`[...document.querySelectorAll('#steps [data-step]')].map(b => b.dataset.step).join() === 'project,transcript,style,edit,review,approve'`), await js(`document.getElementById('steps').textContent`));
    check('the next action is stated', await js(`/הפעולה הבאה/.test(document.querySelector('.next').textContent) && document.querySelector('.next b').textContent.length > 4`));
    check('versions are listed', await js(`document.querySelectorAll('#versions li').length === ${editP.versions.length} && !!document.querySelector('#versions summary')`));
    check(vp.mobile ? 'phone: main actions sit in a bar inside the screen' : 'desktop: player stays beside the step content',
      await js(vp.mobile ? `(() => { const a = document.getElementById('actions'); if (a.classList.contains('hidden')) return true; const r = a.getBoundingClientRect(); return r.bottom <= window.innerHeight + 1 && r.width <= window.innerWidth + 1 && ${tappable('#actions button')}; })()`
        : `getComputedStyle(document.getElementById('side')).position === 'sticky' && document.getElementById('side').getBoundingClientRect().width < 500`));
    await shot(`${vp.name}-10-project`);
    await step('transcript');
    const cards = editP.version.package.cards.length;
    check('transcript step: speech transcript, video captions and post caption are three separate sections', await js(`${vis('#speech')} && ${vis('#captions')} && ${vis('#postcap')}`));
    check('every caption has: listen, edit beside its time, a state, and "אמת ושמור תיקון"', await js(`document.querySelectorAll('#captions [data-listen]').length === ${cards} && document.querySelectorAll('#captions input[data-card]').length === ${cards} && document.querySelectorAll('#captions [data-verify]').length === ${cards} && [...document.querySelectorAll('#captions .capline .pill')].some(p => /לא נבדק|תוקן|אומת/.test(p.textContent))`));
    await js(`document.querySelector('#captions [data-verify]').click()`);
    check('verifying without listening is refused by the page', await until(`/אחרי האזנה/.test(document.getElementById('notice').textContent)`, 4000), await js(`document.getElementById('notice').textContent`));
    check('a free-text correction request with a scope choice (this project / standing rule)', await js(`${vis('#freefix #rvnote')} && document.querySelectorAll('#freefix input[name=rvscope]').length === 2`));
    check('transcript step: no horizontal scroll', await js(noOverflow));
    await shot(`${vp.name}-11-transcript`);
    await step('style');
    check('style step: rules the version was edited by, and caption controls with a preview (size, position, lines, colours, highlight, animation)',
      await js(`${vis('#rulesused')} && ${vis('#pv')} && !!document.querySelector('[data-style=caption_size]') && !!document.querySelector('[data-style=caption_y_px]') && !!document.querySelector('[data-style=caption_max_lines]') && document.querySelectorAll('[data-stylec]').length === 2 && !!document.querySelector('[data-style=highlight_enabled]') && !!document.querySelector('[data-styles=caption_animation]')`));
    await shot(`${vp.name}-12-style`);
    await step('edit');
    check("edit step: Dana's plan, zooms, motion graphics, adjustments with a switch for each kind", await js(`${vis('#plan')} && ${vis('#zooms')} && ${vis('#graphics')} && ${vis('#adjust')} && document.querySelectorAll('#adjust [data-adj]').length === 5`));
    if (editP.version.hasCompare) check('edit step: before / after image and clip are loaded', await until(`(() => { const i = document.querySelector('#compare img'); return i && i.complete && i.naturalWidth > 0 && !!document.querySelector('#compare video[src]'); })()`));
    check('edit step: one "produce a corrected version" action with a free-text request', await js(`${vis('#revise [data-do=revise]')} && ${vis('#revise #rvnote')}`));
    check('edit step: no horizontal scroll', await js(noOverflow));
    await shot(`${vp.name}-13-edit`);
    await step('review');
    check("review step: twelve categories with a level each", await js(`document.querySelectorAll('#dreview .cat').length === 12 && [...document.querySelectorAll('#dreview .cat span')].every(s => /תקין|דורש שיפור|בעייתי|לא נבדק/.test(s.textContent))`));
    await js(`document.querySelector('#dreview .cat').click()`); await sleep(250);
    check('a category opens its fixed criteria with a state and a basis', await js(`document.querySelectorAll('#dreview ul.plain li').length >= 2 && /נמדד|הערכת מודל|פריימים בודדים|דורש אותך/.test(document.querySelector('#dreview ul.plain').textContent)`));
    check('improvements by importance and the "יישם שיפורים והפק גרסה חדשה" button', await js(`${vis('#improve')} && /יישם שיפורים והפק גרסה חדשה/.test(document.querySelector('#improve [data-do=applyreview]').textContent)`));
    check('review step: no horizontal scroll', await js(noOverflow));
    await shot(`${vp.name}-14-review`);
    await step('approve');
    check('approve step: approval of this exact version, cover, destination; publishing shown as off', await js(`${vis('#approve')} && ${vis('img.cover')} && /פרסום כבוי|ספק דמה/.test(document.getElementById('panel').textContent)`));
    await shot(`${vp.name}-15-approve`);

    if (rev) {
      await goto(`${base}/dana-studio.html#${rev.id}`);
      check('a video uploaded for review opens on the review step when its review is the latest version', await until(`!!document.querySelector('#steps .on') && !!document.querySelector('#mainvid[src]')`));
      await step('review');
      check('its review shows the categories and what Dana can apply', await until(`document.querySelectorAll('#dreview .cat').length === 12 && ${vis('#improve')}`));
      await shot(`${vp.name}-20-review-only`);
    }
  }
  check('no JavaScript error on the page', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) { fail++; console.error('[ERROR]', e.message); }
finally { kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
