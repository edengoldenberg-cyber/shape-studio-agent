/**
 * dana_rating_page_check.mjs — "הדירוג הסופי של דנה" as the owner sees it, in a real (headless) browser, desktop and phone size.
 *
 *   node tests/dana_rating_page_check.mjs <base url of a running preview> [screenshots dir] [base url of a WRITABLE preview]
 *
 * Against <base> the check only reads: for every project it compares what is DRAWN beside the player with what the server
 * says (the mark, the five areas, the three improvements, the version and the skills), and looks at the full rating on the
 * review step. Against the writable preview (a disposable copy of some data, no worker) it asks for a rating of the existing
 * file and checks that the page keeps a typed draft and an opened section while it refreshes itself, and that no version
 * is created. Nothing is rendered by this check.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:3191').replace(/\/$/, ''), shots = process.argv[3] || null, writable = (process.argv[4] || '').replace(/\/$/, '') || null;
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}${detail ? '  →  ' + String(detail).slice(0, 400) : ''}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, { timeoutMs = 15000, intervalMs = 150 } = {}) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > timeoutMs) return null; await sleep(intervalMs); } };
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const browserBin = process.env.CHROME_BIN ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p));
if (!browserBin) { console.error('[FATAL] no Chrome/Edge binary (set CHROME_BIN)'); process.exit(2); }
const api = async (p, b = base) => (await fetch(b + '/api/dana/studio' + p)).json();
const { projects } = await api('/projects');
if (!projects.length) { console.error('[FATAL] the preview has no project'); process.exit(2); }

const dbgPort = await freePort(), profileDir = mkdtempSync(path.join(tmpdir(), 'dana-rating-chrome-'));
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
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown');
    if (m.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  const ev = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed'); return r.result.value; };
  const shot = async (name, sel) => { if (!shots) return; mkdirSync(shots, { recursive: true });
    const m = await cdp('Page.getLayoutMetrics'); let clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(Math.ceil(m.cssContentSize.height), 9000), scale: 1 };
    if (sel) { const b = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.max(0, r.left + scrollX - 8), y: Math.max(0, r.top + scrollY - 8), width: r.width + 16, height: Math.min(r.height + 16, 5000) }; })()`); clip = { ...b, scale: 1 }; }
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64')); };
  const goto = async url => { await cdp('Page.navigate', { url: 'about:blank' }); await sleep(150); await cdp('Page.navigate', { url }); };
  const has = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);
  const box = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { x: r.left, y: r.top + scrollY, w: r.width, h: r.height, right: r.right, shown: s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 }; })()`);
  const overflow = () => ev(`[...document.querySelectorAll('.card')].filter(c => { const r = c.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 2 || r.left < -2); }).map(c => c.id || c.querySelector('h2')?.innerText || 'card')`);
  const openProject = async (b, id) => { await goto(`${b}/dana-studio.html#${id}`); await waitFor(() => has('#sidereview')); };
  const step = async key => { await waitFor(() => ev(`!!document.querySelector('#steps [data-step="${key}"]')`)); await ev(`document.querySelector('#steps [data-step="${key}"]').click()`); await sleep(400); };

  for (const [name, w, h, mobile] of [['desktop', 1400, 900, false], ['phone', 390, 844, true]]) {
    console.log(`\n== ${name} ==`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
    for (const pr of projects) {
      const p = (await api('/projects/' + pr.id)).project, f = p.version.package.finalReview, s = f.score, tag = `${name} · ${pr.targetLabel} v${p.version.n}`;
      if (!s) { check(`${tag}: the review carries a summary mark`, false, 'no score in the server answer — rate the existing file first'); continue; }
      await openProject(base, pr.id);
      const side = await text('#sidereview'), sb = await box('#sidereview'), pb = await box('#playerbox');
      check(`${tag}: the card "הדירוג הסופי של דנה" is drawn and visible`, /^הדירוג הסופי של דנה/.test(side.trim()) && sb && sb.shown && sb.h > 200, side.slice(0, 60));
      check(`${tag}: it is beside the player — ${mobile ? 'directly under it in the page' : 'in the same column, under it'}`,
        pb && sb && sb.y > pb.y && (mobile ? sb.y - (pb.y + pb.h) < 260 : Math.abs(sb.x - pb.x) < 12 && sb.y - (pb.y + pb.h) < 260), JSON.stringify({ pb, sb }));
      const drawn = await ev(`(() => { const q = document.querySelector('#sidereview .score b'); return { overall: q && q.innerText.trim(), groups: [...document.querySelectorAll('#sidereview .sg')].map(g => [g.querySelector('.grow').innerText.trim(), g.querySelector('b').innerText.trim()]),
        imps: [...document.querySelectorAll('#sidereview li.imp')].map(li => li.innerText), bars: [...document.querySelectorAll('#sidereview .sg .bar i')].map(i => i.getBoundingClientRect().width) }; })()`);
      check(`${tag}: the mark on screen is the server's (${s.overall} of 100)`, drawn.overall === String(s.overall) && /מתוך 100/.test(side), drawn.overall);
      check(`${tag}: the five areas on screen are the server's, each with its mark or "לא נבדק"`,
        JSON.stringify(drawn.groups) === JSON.stringify(s.groups.map(g => [g.label, g.score === null ? 'לא נבדק' : String(g.score)])) && drawn.groups.length === 5, JSON.stringify(drawn.groups));
      check(`${tag}: the coverage is said next to the mark`, new RegExp(`מבוסס על ${s.coverage.decided} מתוך ${s.coverage.applicable} קריטריונים`).test(side) && /לא נבדקו ואינם בציון/.test(side));
      check(`${tag}: mandatory failures are said beside the mark, never hidden by it`, s.blocking.count ? side.includes(s.blocking.text) : !/כשלים מחייבים/.test(side), s.blocking.text);
      check(`${tag}: what works and what is still weak`, /מה עובד/.test(side) && /מה עדיין חלש|לא נמצא דבר חלש/.test(side));
      const top = f.top_improvements || [];
      check(`${tag}: up to three improvements in order, each with what to do${top.some(x => x.why) ? ' and why' : ''}`,
        drawn.imps.length === Math.min(3, top.length) && drawn.imps.every((t, i) => t.startsWith(`${i + 1}. `) && /מה לעשות:/.test(t) && (!top[i].why || /למה:/.test(t))), drawn.imps.join(' | ').slice(0, 300));
      check(`${tag}: the version of the video and the skills the rating rests on`, new RegExp(`גרסה ${p.version.n} של הסרטון`).test(side) && f.skills.every(k => side.includes(k.name)) && side.includes(f.file_sha256.slice(0, 12)));
      check(`${tag}: dana can / needs you / blocked — the three counts`, new RegExp(`דנה יכולה לבצע ${f.next_steps.dana.length}`).test(side) && new RegExp(`דורש אותך ${f.next_steps.owner.length}`).test(side) && new RegExp(`חסום ${f.next_steps.blockers.length}`).test(side));
      check(`${tag}: nothing runs off the screen`, (await overflow()).length === 0, JSON.stringify(await overflow()));
      await ev(`document.querySelector('#sidereview').scrollIntoView()`);
      await shot(`rating_${name}_${pr.target}_${pr.id.slice(-4)}_side`, '#sidereview');
      if (mobile) await shot(`rating_${name}_${pr.target}_${pr.id.slice(-4)}_page`);

      await step('review'); await waitFor(() => has('#finalreview'));
      const fr = await text('#finalreview');
      check(`${tag}: the full rating is on the review step, named for this version`, new RegExp(`הדירוג הסופי של דנה — גרסה ${p.version.n} · ${pr.targetLabel}`).test(fr), fr.slice(0, 80));
      check(`${tag}: how the mark is computed, its version, and what was measured / assessed by the model / left to the owner`, /איך מחושב:/.test(fr) && fr.includes(s.version) && /נמדד בקוד \d+\/\d+ · הערכת מודל \d+\/\d+/.test(fr) && fr.includes(s.coverage.text));
      const ns = await ev(`[...document.querySelectorAll('#nextsteps .ns')].map(n => n.querySelectorAll('li:not(.mute)').length)`);
      check(`${tag}: next steps in three separate lists`, JSON.stringify(ns) === JSON.stringify([f.next_steps.dana.length, f.next_steps.owner.length, f.next_steps.blockers.length]), JSON.stringify(ns));
      check(`${tag}: "apply the improvements" lists exactly what Dana can do and renders nothing by itself`,
        (await ev(`document.querySelectorAll('#applylist li').length`)) === f.next_steps.dana.length && (await text('#applybox')).includes('שום דבר לא מופק עד שלוחצים'));
      check(`${tag}: the history of this version's reviews, with the file and the criteria version of each`,
        (await ev(`document.querySelectorAll('#reviewlist > li').length`)) === p.reviews.length && (await ev(`document.querySelector('#reviewhistory').textContent`)).includes(f.rubric_version));
      check(`${tag}: review step — nothing runs off the screen`, (await overflow()).length === 0, JSON.stringify(await overflow()));
      await shot(`rating_${name}_${pr.target}_${pr.id.slice(-4)}_full`, '#finalreview');
    }
    // the state of the screen survives a real reload: the same project, the same step
    await ev('location.reload()'); await sleep(900); await waitFor(() => has('#finalreview'));
    check(`${name}: after a reload the same project and the same step are on screen`, await has('#finalreview') && await has('#sidereview'));
  }

  if (writable) {
    console.log('\n== refresh while a rating is in progress (writable copy, no worker) ==');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const wp = (await api('/projects', writable)).projects[0], before = (await api('/projects/' + wp.id, writable)).project;
    await goto(`${writable}/dana-studio.html`); await sleep(400);
    await ev(`localStorage.setItem('dana_reviewer', 'שחקן בדיקה (דפדפן) — לא הבעלים')`);
    await openProject(writable, wp.id); await step('review'); await waitFor(() => has('#arnote'));
    await ev(`(() => { const t = document.querySelector('#arnote'); t.focus(); t.value = 'טיוטה שלא נשלחה'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#reviewhistory').open = true; })()`);
    await ev(`document.querySelector('#finalreview [data-do="rate"]').click()`);
    const waiting = await waitFor(() => ev(`/הדירוג מתעדכן/.test(document.querySelector('#finalreview').innerText)`), { timeoutMs: 8000 });
    check('asking for a rating of the existing file shows that the rating is being updated and that the video does not change', !!waiting && /הסרטון לא משתנה/.test(await text('#finalreview')));
    await sleep(7500);                                   // at least two of the page's own refreshes
    const mid = (await api('/projects/' + wp.id, writable)).project;
    check('the request is a rating job: no new version, the status of the project is unchanged', mid.rating?.status === 'queued' && mid.versions.length === before.versions.length && mid.status === before.status && mid.currentVersion === before.currentVersion, JSON.stringify(mid.rating));
    check('the typed draft is still in the box after the page refreshed itself', (await ev(`document.querySelector('#arnote').value`)) === 'טיוטה שלא נשלחה');
    check('the opened history section is still open', await ev(`document.querySelector('#reviewhistory').open`));
    check('while the rating waits, "apply and produce a new version" is disabled — nothing is rendered behind it', await ev(`document.querySelector('[data-do="applyreview"]').disabled && document.querySelector('#finalreview [data-do="rate"]').disabled`));
    await shot('rating_phone_while_updating', '#finalreview');
  }
  check('no JavaScript errors on the page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) { check('the check ran to the end', false, e.stack || e); }
finally { kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
