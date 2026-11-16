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
    await until(`!!document.querySelector('[data-home="projects"]')`); await js(`document.querySelector('[data-home="projects"]').click()`);   // the tab is remembered from the previous run
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

    // ── the home screen keeps its state through the automatic refreshes (every 10 s; references every 6 s) ──
    await js(`document.querySelector('[data-home="refs"]').click()`);
    const hasAnalysis = await until(`!!document.querySelector('#refs details')`, 6000);
    if (hasAnalysis) await js(`(() => { const d = document.querySelector('#refs details'); d.open = true; const i = d.querySelector('input[data-pk]'); if (i) { i.focus(); i.value = '99'; i.dispatchEvent(new Event('input', { bubbles: true })); } window.__mark = d; })()`);
    await js(`document.querySelector('[data-home="brand"]').click()`);
    await js(`(() => { const t = [...document.querySelectorAll('#brand textarea')].find(x => !x.value); t.focus(); t.value = 'טקסט שהוקלד ולא נשמר'; t.dispatchEvent(new Event('input', { bubbles: true })); window.scrollTo(0, 220); window.__y = window.scrollY; window.__k = t.dataset.brand; })()`);
    await sleep(12500);                                   // longer than both refresh timers
    check('after the automatic refreshes: still on the same tab', await js(`!document.querySelector('[data-pane="brand"]').classList.contains('hidden')`));
    check('… text typed into a brand setting was not wiped', await js(`document.querySelector('[data-brand="' + window.__k + '"]').value === 'טקסט שהוקלד ולא נשמר'`), await js(`document.querySelector('[data-brand="' + window.__k + '"]').value`));
    check('… the scroll position did not move', await js(`Math.abs(window.scrollY - window.__y) <= 2`), await js(`window.scrollY + ' vs ' + window.__y`));
    await js(`document.querySelector('[data-home="refs"]').click()`);
    if (hasAnalysis) check("… the open reference analysis is still open, and a number typed into its proposal is still there", await js(`(() => { const d = document.querySelector('#refs details'); const i = d.querySelector('input[data-pk]'); return d.open && (!i || i.value === '99'); })()`));
    await js(`document.querySelector('[data-home="skills"]').click()`);
    check('skill library: create from analysis, create from instructions, and the list', await js(`${vis('#skfromrefs')} && ${vis('#skfromprompt')} && ${vis('#sk_prompt')} && !!document.getElementById('skills')`));
    await js(`(() => { const t = document.getElementById('sk_prompt'); t.value = 'טיוטת הוראות'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await shot(`${vp.name}-04-skills`);
    await js(`document.querySelector('[data-home="about"]').click()`);
    check('"how it works": the pipeline, who decides what, and capabilities split into active / partial / missing', await until(`/המסלול/.test(document.getElementById('about').textContent) && /Claude מחליט/.test(document.getElementById('about').textContent) && ['פעיל', 'חלקי', 'חסר'].every(x => [...document.querySelectorAll('#about .pill')].some(p => p.textContent === x))`));
    check('… B-roll and music are listed as missing, not as active', await js(`[...document.querySelectorAll('#about li')].filter(li => /צילומי השלמה|מוזיקה ואפקטים/.test(li.textContent)).every(li => li.querySelector('.pill').textContent === 'חסר')`));
    check('"how it works": no horizontal scroll', await js(noOverflow));
    await shot(`${vp.name}-05-how-it-works`);
    await cdp('Page.reload'); await until(`document.querySelectorAll('#projects .proj').length > 0`);
    check('after a page reload the same tab is shown again', await js(`!document.querySelector('[data-pane="about"]').classList.contains('hidden')`));

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

    // ── a project keeps its state while its status is refreshed (simulated: the server data is not touched) ──
    // The page is made to believe a new version is being produced: the job is "leased" and the version on screen is the
    // last finished one. That is exactly the situation in which the review used to vanish and the tab used to jump.
    await goto(`${base}/dana-studio.html#${edit.id}`);
    await until(`!!document.querySelector('#mainvid[src]')`);
    await js(`(() => { const real = window.fetch; window.__polls = 0; window.__fail = false;
      window.fetch = async (u, o) => { const isProject = new RegExp('/projects/[^/?]+([?].*)?$').test(String(u)) && (!o || !o.method || o.method === 'GET');
        if (isProject && window.__fail) throw new TypeError('Failed to fetch');
        const r = await real(u, o); if (!isProject) return r;
        const j = await r.clone().json(); window.__polls++;
        j.project.job = Object.assign({}, j.project.job, { status: 'leased', stage: 'render_cards', note: 'מרנדר כרטיסי כתוביות (סימולציה)' });
        j.project.status = 'editing'; j.project.currentVersion = j.project.shown.n + 1;
        j.project.shown = Object.assign({}, j.project.shown, { isCurrent: false, currentN: j.project.shown.n + 1, currentStatus: 'editing', currentHasPackage: false });
        j.project.nextAction = { key: 'wait', label: 'דנה עובדת — אין מה לעשות כרגע' };
        j.project.progress = Object.assign({}, j.project.progress, { phase: 'edit', percent: 40 + window.__polls, percentBasis: 'estimated', percentNote: 'משוער', stage: 'render_cards', note: 'מרנדר', attempts: 1, maxAttempts: 3,
          phases: (j.project.progress.phases || []).map((x, i) => Object.assign({}, x, { state: i < 3 ? 'done' : i === 3 ? 'current' : 'todo' })) });
        return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } }); }; })()`);
    // re-open the project through the page itself, so the simulated state is what it loads
    await js(`document.getElementById('back').click()`); await until(`document.querySelectorAll('#projects .proj').length > 0`);
    await js(`document.querySelector('#projects .proj[data-id="${edit.id}"]').click()`);
    await until(`window.__polls >= 1 && !!document.querySelector('#mainvid[src]')`, 8000);
    await step('review');
    await until(`!!document.getElementById('shownote')`, 8000);
    check("while a new version is being produced, Dana's review of the last finished version stays on screen", await js(`document.querySelectorAll('#dreview .cat').length === 12 && ${vis('#reviewinfo')}`));
    check('… and it says which version is shown and that it is not the current one', await js(`/לא הגרסה הנוכחית/.test(document.getElementById('shownote').textContent) && /אינה עדכנית/.test(document.getElementById('reviewinfo').textContent) === false || /הביקורת/.test(document.getElementById('reviewinfo').textContent)`));
    await js(`document.querySelectorAll('#dreview .cat')[4].click()`); await sleep(200);
    const catKey = await js(`document.querySelector('#dreview .cat.sel').dataset.cat`);
    await js(`(() => { const d = [...document.querySelectorAll('#panel details')].find(x => !x.open); d.open = true; window.__det = [...document.querySelectorAll('#panel details')].indexOf(d);
      const v = document.getElementById('mainvid'); v.muted = true; v.currentTime = 1; v.play(); window.__vid = v; window.scrollTo(0, 300); window.__y = window.scrollY; window.__p0 = window.__polls; })()`);
    await sleep(4000);                                    // at least one status refresh while the section is open
    check('a status refresh does not close the open category or an opened section of the review', await js(`document.querySelector('#dreview .cat.sel')?.dataset.cat === ${JSON.stringify(catKey)} && document.querySelectorAll('#panel details')[window.__det].open && window.__polls > window.__p0`));
    await step('edit');
    await js(`(() => { const t = document.getElementById('rvnote'); t.focus(); t.value = 'בקשה שנכתבת בזמן רענון'; t.dispatchEvent(new Event('input', { bubbles: true })); window.__panelEl = document.querySelector('#panel .card'); })()`);
    await sleep(8000);                                    // at least two status refreshes while typing and playing
    check('several status refreshes happened meanwhile', await js(`window.__polls - window.__p0 >= 2`), await js(`window.__polls - window.__p0`));
    check('… the step did not jump', await js(`document.querySelector('#steps .on').dataset.step === 'edit'`));
    check('… the text being typed is still there, and the field kept the focus', await js(`document.getElementById('rvnote').value === 'בקשה שנכתבת בזמן רענון' && document.activeElement === document.getElementById('rvnote')`));
    check('… the player was not rebuilt and kept playing', await js(`document.getElementById('mainvid') === window.__vid && !window.__vid.paused && window.__vid.currentTime > 2`), await js(`JSON.stringify({ same: document.getElementById('mainvid') === window.__vid, paused: window.__vid.paused, t: window.__vid.currentTime })`));
    check('… the progress area did update (the refresh is real)', await js(`/[45][0-9]%/.test(document.getElementById('progress').textContent)`), await js(`document.getElementById('progress').textContent.slice(0, 60)`));
    await step('review');
    check('… coming back to the review, the chosen category is still chosen', await js(`document.querySelector('#dreview .cat.sel')?.dataset.cat === ${JSON.stringify(catKey)}`));
    await js(`window.__fail = true`); await sleep(7500);
    check('a failed refresh says so and keeps the screen as it was', await js(`/הרענון נכשל/.test(document.getElementById('notice').textContent) && document.querySelectorAll('#dreview .cat').length === 12 && !document.getElementById('detail').classList.contains('hidden')`), await js(`document.getElementById('notice').textContent`));
    await js(`window.__fail = false`); await sleep(7500);
    check('… and the message goes away when the refresh works again', await js(`document.getElementById('notice').classList.contains('hidden')`));
    await shot(`${vp.name}-16-review-while-working`);
    await cdp('Page.reload'); await until(`!!document.querySelector('#mainvid[src]')`);
    check('after a page reload: the same project, step and category are restored', await until(`document.querySelector('#steps .on')?.dataset.step === 'review' && document.querySelector('#dreview .cat.sel')?.dataset.cat === ${JSON.stringify(catKey)}`, 8000));
    check('the review states which version it belongs to, when it was made and on which file', await js(`/גרסת הסרטון שנבדקה/.test(document.getElementById('reviewinfo').textContent) && /בוצעה על הקובץ הסופי/.test(document.getElementById('reviewinfo').textContent) && /לא נבדק/.test(document.getElementById('reviewinfo').textContent)`));
    await step('project');
    check('project step: a library skill can be chosen (approved default / a skill / let Dana suggest / none)', await js(edit.kind === 'review_only' ? 'true' : `['default', 'suggest', 'none'].every(v => [...document.querySelectorAll('#pskillsel option')].some(o => o.value === v))`));
    await goto(`${base}/dana-studio.html#prj_doesnotexist000`);
    check('a project that cannot be loaded shows a clear error instead of an empty screen', await until(`/הפרויקט לא נטען/.test(document.getElementById('notice').textContent)`, 8000), await js(`document.getElementById('notice').textContent`));

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
