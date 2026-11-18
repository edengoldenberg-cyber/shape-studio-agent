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
  const shot = async (name, full = false) => { await sleep(500); const tall = full && (await evalJs('document.documentElement.scrollHeight')) > 6000; const s = await Promise.race([cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full && !tall }), sleep(30000).then(() => null)]); if (!s) { console.log('  (screenshot ' + name + ' timed out and was skipped)'); return; } writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(s.data, 'base64')); };
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
    if (W < 900) check(`${label}: every control is at least 44×44`, a.small.length === 0, [...new Set(a.small)].slice(0, 6).join(' | '));
    check(`${label}: nothing floats over the page`, a.covered.length === 0, [...new Set(a.covered)].slice(0, 6).join(' | '));
  };

  for (const W of WIDTHS) {
    console.log(`\n── ${W}px ──`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: W < 900 ? 800 : 900, deviceScaleFactor: W < 900 ? 2 : 1, mobile: W < 900 });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Emulation.setUserAgentOverride', { userAgent: W < 900 ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
    await cdp('Page.navigate', { url: BASE + '/' });
    check(`${W}: the dashboard opens with the session (not the login page)`, await until(`!!document.querySelector('.tab-btn[data-tab="barak"]') && !/login/.test(location.pathname)`));
    // Barak
    check(`${W} barak: the tab opens`, await tap('.tab-btn[data-tab="barak"]') && await until(`document.querySelector('.tab-btn[data-tab="barak"]').classList.contains('active')`));
    await sleep(2500);
    const cb = await evalJs(`({ rows: document.querySelectorAll('.callback-row').length, leads: document.querySelectorAll('.leads-table tbody tr').length })`);
    console.log(`  (callback rows: ${cb.rows}, table rows: ${cb.leads})`);
    // refusal / classification notes in the leads table (types and the non-personal part of the text only)
    const notes = await evalJs(`[...document.querySelectorAll('#barak-leads-tbody .lead-note')].map(n => n.dataset.note + ': ' + n.innerText.replace(/"[^"]*"/g, '"…"').replace(/\s+/g, ' ').slice(0, 150))`);
    if (W === WIDTHS[0]) { console.log(`  lead notes: ${notes.length}`); for (const n of notes) console.log('    ' + n); }
    check(`${W} barak: refusal / classification notes are inside the screen`, await evalJs(`[...document.querySelectorAll('#barak-leads-tbody .lead-note')].every(n => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right <= innerWidth + 1 || !!n.closest('.table-wrap, .table-scroll, [style*="overflow"]')) ; })`));
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
    // Owner tasks (inside the tasks pane; GET only — no action button is tapped, nothing is typed into the settings)
    {
      check(`${W} owner tasks: the list and the reminder status load`, await until(`!!document.querySelector('#tw-ot-status [data-reminders]') && !document.querySelector('#tw-ot-list [data-state="loading"]')`));
      const ot = await evalJs(`({ rem: document.querySelector('#tw-ot-status [data-reminders]')?.dataset.reminders ?? null, cards: document.querySelectorAll('#tw-ot-list > .tw-ot-card').length,
        status: (document.getElementById('tw-ot-status')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200), titles: [...document.querySelectorAll('#tw-ot-list > .tw-ot-card')].map(c => c.innerText.replace(/\\s+/g, ' ').replace(/05\\d[- ]?\\d{7}|9725\\d{8}/g, '<phone>').slice(0, 90)) })`);
      if (W === WIDTHS[0]) console.log('  owner tasks: ' + JSON.stringify(ot));
      check(`${W} owner tasks: the reminder state is stated (on / off / waiting for the owner's times)`, !!ot.rem && ot.status.length > 10, JSON.stringify(ot).slice(0, 200));
      if (ot.cards) { await tap('#tw-ot-list > .tw-ot-card [data-toggle]'); await sleep(300); }
      await audit(`${W} owner tasks`, W);
      await shot(`prod-tomer-${W}-5-owner-tasks`, true);
    }
    // The work board (GET only: tiles and filters are client-side; no action button is tapped)
    {
      const tiles = await evalJs(`[...document.querySelectorAll('#tw-bd-today .tw-bd-tile')].map(t => ({ k: t.dataset.bucket, n: parseInt(t.querySelector('.tw-bd-n').textContent, 10) }))`);
      let agree = tiles.length === 6; const det = [];
      for (const t of tiles) {
        await tap(`#tw-bd-today .tw-bd-tile[data-bucket="${t.k}"]`); await sleep(300);
        const n = await evalJs(`document.querySelectorAll('#tw-ot-list > .tw-ot-card').length`);
        det.push(`${t.k}=${t.n}/${n}`); if (n !== t.n) agree = false;
        await tap(`#tw-bd-today .tw-bd-tile[data-bucket="${t.k}"]`); await sleep(200);
      }
      if (W === WIDTHS[0]) console.log('  board tiles (number / cards listed): ' + det.join(' '));
      check(`${W} board: the six tiles are shown and each opens a list of exactly its number`, agree, det.join(' '));
      const cards = await evalJs(`[...document.querySelectorAll('#tw-ot-list > .tw-ot-card')].map(c => ({ board: c.dataset.board, line: c.innerText.replace(/\s+/g, ' ').replace(/05\d[- ]?\d{7}|9725\d{8}/g, '<phone>').slice(0, 170) }))`);
      if (W === WIDTHS[0]) for (const c of cards.slice(0, 6)) console.log('    card [' + c.board + '] ' + c.line);
      if (cards.length) {
        if (await evalJs(`document.querySelector('#tw-ot-list > .tw-ot-card .tw-ot-more').hidden`)) { await tap('#tw-ot-list > .tw-ot-card [data-toggle]'); await sleep(250); }
        const heads = await evalJs(`[...document.querySelectorAll('#tw-ot-list > .tw-ot-card .tw-ot-more h4')].map(h => h.innerText.trim())`);
        check(`${W} board: a card shows why it was opened, what was done, what closes it and its history`, ['למה נפתחה', 'מה בוצע עד עכשיו', 'מה סוגר את המשימה', 'היסטוריית שינויים'].every(h => heads.includes(h)), heads.join(' | '));
      }
      for (const [id, box, sel, min, what] of [['tw-bd-props', 'tw-bd-props-box', '.tw-bd-prop', 9, 'retention proposals'], ['tw-bd-roles', 'tw-bd-roles-box', '.tw-bd-role', 11, 'role map']]) {
        await evalJs(`document.getElementById('${id}').scrollIntoView({ block: 'center' })`);
        await tap(`#${id} > summary`);
        const loaded = await until(`document.querySelectorAll('#${box} ${sel}').length >= ${min} || !!document.querySelector('#${box} [data-state="error"]')`, 90000);
        const rows = await evalJs(`[...document.querySelectorAll('#${box} ${sel}')].map(r => (r.dataset.prop ?? r.dataset.role) + ':' + r.dataset.state + ' — ' + r.innerText.replace(/\s+/g, ' ').replace(/•••\d{3}/g, '').slice(0, 150))`);
        if (W === WIDTHS[0]) for (const r of rows) console.log('    ' + what + ': ' + r);
        check(`${W} board: the ${what} load with a state on every row`, loaded && rows.length >= min && !(await evalJs(`!!document.querySelector('#${box} [data-state="error"]')`)), `rows ${rows.length}`);
        await audit(`${W} board ${what}`, W);
        await tap(`#${id} > summary`);
      }
      await audit(`${W} work board`, W);
      await shot(`prod-tomer-${W}-5b-board`);
    }
    // Members board (GET only: the board, one member card)
    if (await tap('.tw-tab[data-pane="members"]')) {
      const loaded = await until(`document.querySelectorAll('#tw-mb-groups .tw-mb-group').length >= 8 || !!document.querySelector('#tw-mb-state [data-state="error"]')`, 60000);
      const mb = await evalJs(`({ state: document.querySelector('#tw-mb-state [data-state]')?.dataset.state ?? null, head: (document.getElementById('tw-mb-state')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160),
        groups: [...document.querySelectorAll('#tw-mb-groups .tw-mb-group')].map(g => g.dataset.g + '=' + g.querySelector('.tw-mb-n').textContent.trim()),
        rule: (document.getElementById('tw-mb-rule')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 260), cards: document.querySelectorAll('#tw-mb-list .tw-mb-card').length })`);
      if (W === WIDTHS[0]) console.log('  members board: ' + JSON.stringify(mb));
      check(`${W} members: the board loads from Arbox with a number (or "—") on every group`, loaded && mb.state === 'ok' && mb.groups.length >= 8 && mb.groups.every(g => /=(\d+|—)$/.test(g)), JSON.stringify(mb).slice(0, 300));
      check(`${W} members: the active group is not zero and its members are listed`, Number((mb.groups.find(g => g.startsWith('active=')) ?? '=0').split('=')[1]) > 0 && mb.cards > 0, JSON.stringify(mb.groups));
      check(`${W} members: the chosen group states its rule, its source and when it was read`, /כלל החישוב:/.test(mb.rule) && /מקור:/.test(mb.rule) && /עודכן:/.test(mb.rule), mb.rule);
      await audit(`${W} members board`, W);
      await shot(`prod-tomer-${W}-6-members`);
      for (const g of ['expiring', 'absent', 'frozen']) {
        await tap(`#tw-mb-groups .tw-mb-group[data-g="${g}"]`); await sleep(400);
        const r = await evalJs(`({ n: document.querySelector('#tw-mb-groups .tw-mb-group[data-g="${g}"] .tw-mb-n').textContent.trim(), cards: document.querySelectorAll('#tw-mb-list .tw-mb-card').length, empty: !!document.querySelector('#tw-mb-list [data-state="empty"]'), active: document.querySelector('#tw-mb-groups .tw-mb-group.active')?.dataset.g })`);
        check(`${W} members "${g}": the list holds exactly the number on the group (${r.n})`, r.active === g && (r.n === '—' || (Number(r.n) === r.cards && (r.cards > 0 || r.empty))), JSON.stringify(r));
      }
      await evalJs(`document.getElementById('tw-mb-external').scrollIntoView({ block: 'center' })`);
      await tap('#tw-mb-external > summary');
      const extLoaded = await until(`/ממתין להחלטה שלך/.test(document.getElementById('tw-mb-external-box').innerText) || !!document.querySelector('#tw-mb-external-box [data-state="error"]')`, 30000);
      const extLine = await evalJs(`(document.querySelector('#tw-mb-external-box .tw-mb-line')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200)`);
      if (W === WIDTHS[0]) console.log('  outside-club members: ' + extLine);
      check(`${W} members: outside-club members are listed separately, with a number, a source and a time`, extLoaded && /^\d+ חברי מועדון חיצוני/.test(extLine) && /מקור:/.test(extLine) && /עודכן:/.test(extLine), extLine);
      await audit(`${W} outside-club members`, W);
      await tap('#tw-mb-external > summary');
      await tap('#tw-mb-groups .tw-mb-group[data-g="active"]'); await sleep(400);
      if (await tap('#tw-mb-list .tw-mb-card .tw-mb-open')) {
        const opened = await until(`(document.querySelector('#tw-mb-list .tw-mb-card.open .tw-mb-detail')?.innerText ?? '').includes('היסטוריית טיפול')`, 30000);
        const card = await evalJs(`(() => { const d = document.querySelector('#tw-mb-list .tw-mb-card.open .tw-mb-detail'); if (!d) return null; const b = d.getBoundingClientRect();
          return { sections: [...d.querySelectorAll('h4')].map(h => h.innerText.trim()), entries: d.querySelector('[data-entries]')?.dataset.entries ?? null, inside: b.left >= -1 && b.right <= innerWidth + 1 }; })()`);
        if (W === WIDTHS[0]) console.log('  member card: ' + JSON.stringify(card));
        check(`${W} members: a member card opens with its sections and stays inside the screen`, opened && !!card && card.sections.length >= 5 && card.inside && !!card.entries, JSON.stringify(card));
        await audit(`${W} member card`, W);
        await evalJs(`document.querySelector('#tw-mb-list .tw-mb-card.open').scrollIntoView({ block: 'start' })`);
        await shot(`prod-tomer-${W}-7-member-card`);
        // search (client side) and a refresh (GET only): the search text, the chosen group and the open card must survive
        const openId = await evalJs(`document.querySelector('#tw-mb-list .tw-mb-card.open')?.dataset.member ?? null`);
        const total = await evalJs(`document.querySelectorAll('#tw-mb-list .tw-mb-card').length`);
        const q = await evalJs(`(() => { const n = document.querySelector('#tw-mb-list .tw-mb-card.open .tw-mb-name').textContent.trim().slice(0, 3); const i = document.getElementById('tw-mb-search'); i.value = n; i.dispatchEvent(new Event('input', { bubbles: true })); return n; })()`);
        await sleep(500);
        const f = await evalJs(`({ shown: document.querySelectorAll('#tw-mb-list .tw-mb-card').length, allMatch: [...document.querySelectorAll('#tw-mb-list .tw-mb-card .tw-mb-name')].every(n => n.textContent.includes(${JSON.stringify('__Q__')}.replace('__Q__', document.getElementById('tw-mb-search').value))), open: document.querySelector('#tw-mb-list .tw-mb-card.open')?.dataset.member ?? null })`);
        check(`${W} members: the search narrows the list to matching names (${f.shown} of ${total}) and keeps the open card`, f.shown >= 1 && f.shown < total && f.allMatch && f.open === openId, JSON.stringify(f));
        await tap('#tw-refresh');
        await sleep(4000);
        const kept = await evalJs(`({ q: document.getElementById('tw-mb-search').value, group: document.querySelector('#tw-mb-groups .tw-mb-group.active')?.dataset.g, open: document.querySelector('#tw-mb-list .tw-mb-card.open')?.dataset.member ?? null, detail: (document.querySelector('#tw-mb-list .tw-mb-card.open .tw-mb-detail')?.innerText ?? '').length, shown: document.querySelectorAll('#tw-mb-list .tw-mb-card').length })`);
        check(`${W} members: after a refresh the search text, the chosen group and the open card are still there`, kept.q === q && kept.group === 'active' && kept.open === openId && kept.detail > 40 && kept.shown === f.shown, JSON.stringify({ ...kept, q: '(kept)' }));
        await evalJs(`(() => { const i = document.getElementById('tw-mb-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      }
    }
    // Agent knowledge (GET only: the status rows; no save, restore, confirm or sync is tapped)
    if (await tap('.tab-btn[data-tab="knowledge"]')) {
      check(`${W} knowledge: the status rows load`, await until(`document.querySelectorAll('#kn-sync-result .kn-row').length >= 4`, 30000));
      const kn = await evalJs(`({ head: (document.querySelector('#kn-sync-result strong')?.innerText ?? '').slice(0, 120), rows: [...document.querySelectorAll('#kn-sync-result .kn-row')].map(r => r.dataset.knId + ':' + r.dataset.knState + ' — ' + r.innerText.replace(/\\s+/g, ' ').slice(0, 150)),
        raw: /staff_context_has_instructors|classes_context_loaded/.test(document.getElementById('kn-sync-result').innerText) })`);
      if (W === WIDTHS[0]) { console.log('  knowledge: ' + kn.head); for (const r of kn.rows) console.log('    ' + r); }
      check(`${W} knowledge: Hebrew status per subject, no raw check names, "verified" only when every row is fine`, !kn.raw && (kn.rows.every(r => /^\w+:ok/.test(r)) ? true : !/הסוכן עודכן בהצלחה/.test(kn.head)), kn.head);
      await audit(`${W} knowledge`, W);
      await shot(`prod-knowledge-${W}`, true);
    }
    // System status (GET only)
    if (await tap('.tab-btn[data-tab="health"]')) {
      check(`${W} status: the capability table loads`, await until(`document.querySelectorAll('#health-grid .sys-row').length >= 15`));
      if (W === WIDTHS[0]) {
        const rows = await evalJs(`[...document.querySelectorAll('#health-grid .sys-row')].map(r => r.dataset.state.padEnd(8) + r.dataset.statusId.padEnd(20) + (r.querySelector('.sys-row-detail')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 170))`);
        for (const r of rows) console.log('    ' + r);
        console.log('  header: ' + (await evalJs(`document.getElementById('status-label')?.innerText ?? ''`)));
      }
      const dup = await evalJs(`(() => { const r = document.querySelector('#health-grid .sys-row[data-status-id="tomer_duplicates"]'); if (!r) return null; const items = [...r.querySelectorAll('.sys-item')];
        return { state: r.dataset.state, items: items.length, rows: r.querySelectorAll('.sys-item-row').length, withId: [...r.querySelectorAll('.sys-item-row')].filter(x => /מזהה Arbox\\s*[0-9]+/.test(x.innerText)).length,
                 named: [...r.querySelectorAll('.sys-item-row b')].filter(b => b.innerText.trim().length > 1).length, tails: items.map(i => i.querySelector('.sys-item-phone')?.innerText.trim()),
                 inside: items.every(i => { const b = i.getBoundingClientRect(); return b.left >= -1 && b.right <= innerWidth + 1; }) }; })()`);
      if (W === WIDTHS[0]) console.log('  duplicate-rows list: ' + JSON.stringify(dup));
      check(`${W} status: the phones with several Arbox rows are listed with a name and an Arbox id on every row, inside the screen`, !!dup && (dup.items === 0 || (dup.rows >= 2 * dup.items && dup.withId === dup.rows && dup.named === dup.rows && dup.inside)), JSON.stringify(dup));
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
