#!/usr/bin/env node
/**
 * member_care_browser_check.mjs — the "ליווי חברים" (member care) area in a real browser.
 *
 * Isolated server (temp DATA_DIR, loopback WhatsApp-provider mock, loopback Arbox
 * stand-in with invented members, a fixed starting clock for the care engine), then a
 * real headless Chrome clicks through: settings, enable / disable, eligibility previews
 * with inclusion / exclusion reasons, run, sent / uncertain messages, a member's reply,
 * pauses, guest-session entitlement and redemption, the absence report, visibility lists,
 * missing-data states, and persistence across a server restart.
 *
 * Usage:  node tests/member_care_browser_check.mjs [--screenshot <file.png>]
 */
import { spawn, spawnSync } from 'child_process';
import { createServer }     from 'http';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir }           from 'os';
import path                 from 'path';

const require = createRequire(import.meta.url);
const { createIsolatedDataDir, removeDir, isolatedChildEnv, freePort, waitFor, TEST_MANAGER_PHONE } = require('./helpers/isolated_env.cjs');
const { createArboxMock } = require('./helpers/arbox_mock.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotIdx = process.argv.indexOf('--screenshot');
const shotFile = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.error(`  ✗ ${label}${detail ? '  →  ' + String(detail).slice(0, 500) : ''}`); }
}
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const browserBin = process.env.CHROME_BIN ?? BROWSERS.find(p => existsSync(p));
if (!browserBin) { console.error('[FATAL] No Chrome/Edge binary found (set CHROME_BIN).'); process.exit(2); }
const children = [];
function killTree(pid) { if (!pid) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }

// The care engine's clock starts on a fixed Monday at 10:30 Israel time; all data is relative to it.
const TODAY = '2026-11-16', NOW = `${TODAY}T10:30:00+02:00`;
const day = n => new Date(new Date(TODAY + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const dmy = iso => iso.split('-').reverse().join('.');
const GROUP = 'https://chat.whatsapp.com/PreviewGroupLink12345';
const P = { A: '972507200001', B: '972507200002', C: '972507200003', N: '972507200004', M: '972507200005', W: '972507200006' };
const dataDir    = createIsolatedDataDir('shape-care-panel-');
writeFileSync(path.join(dataDir, 'known_members.json'), JSON.stringify({ phones: Object.values(P), names: {} }));
const profileDir = mkdtempSync(path.join(tmpdir(), 'shape-care-chrome-'));
const sent = []; const prov = { failFor: null };
const arbox = createArboxMock();
let green, ws;

try {
  const [appPort, greenPort, dbgPort] = [await freePort(), await freePort(), await freePort()];
  const BASE = `http://127.0.0.1:${appPort}`;
  green = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => {
      let j = null; try { j = JSON.parse(b); } catch { /* not json */ }
      if (j && prov.failFor && String(j.chatId ?? '').startsWith(prov.failFor)) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{}'); }
      if (j) sent.push(j);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ idMessage: `MOCK-${sent.length}` }));
    });
  });
  await new Promise(r => green.listen(greenPort, '127.0.0.1', r));
  const arboxUrl = await arbox.listen();
  const S = arbox.state;
  S.membershipTypes.push({ membership_type_id: 501, membership_type_name: 'מנוי חודשי', type: 'plan', is_recurring_payment: 1 });
  const add = (id, first, phone, planStart, created = null) => {
    S.users.push({ user_id: id, first_name: first, last_name: 'לדוגמה', phone, user_role: 'client', active: 1, gender: 'female', birthday: null, membership_start_date: null, created_time: '2026-01-01 10:00' });
    S.memberships.push({ membership_user_id: 100 + id, user_id: id, membership_type_id: 501, membership_type_name: 'מנוי חודשי', type: 'plan', start_time: planStart, end_time: null, created_at: created ?? `${planStart} 09:00`, active: 1, cancelled: 0, debt: 0 });
  };
  const attend = (id, d) => S.bookings.push({ user_id: id, user_role: 'client', date: d, time: '09:00', class_name: 'כח', check_in: 'Yes', is_first_session: 'No' });
  add(1, 'אביגיל', P.A, '2026-01-10'); attend(1, day(-7));
  add(2, 'בתיה', P.B, '2026-01-10');   attend(2, day(-7)); S.bookings.push({ user_id: 2, user_role: 'client', date: day(2), time: '18:00', class_name: 'כח', check_in: 'No', is_first_session: 'No' });
  add(3, 'גליה', P.C, '2026-01-10');   attend(3, day(-7));
  add(4, 'נועה', P.N, day(-9));                                              // new, never attended
  add(5, 'מיכל', P.M, day(-30));       attend(5, day(-4));                   // first month
  add(6, 'ורד', P.W, TODAY, `${TODAY} 10:40`);                               // joins after the welcome program is enabled

  let serverErr = '';
  function startServer() {
    const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
      env: isolatedChildEnv(dataDir, { PORT: String(appPort), TEST_MODE: 'true', WHATSAPP_AUTO_REPLY: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
        GREEN_API_URL: `127.0.0.1:${greenPort}`, GREEN_API_ID_INSTANCE: '9990002', GREEN_API_TOKEN_INSTANCE: 'mock-care',
        ARBOX_BASE_URL: arboxUrl, ARBOX_CLIENT_ID: 'mock', ARBOX_LOCATION_ID: '1', ARBOX_MIN_GAP_MS: '0', ARBOX_TIMEOUT_MS: '1500',
        TEST_ALLOWLIST_PHONES: [TEST_MANAGER_PHONE, ...Object.values(P)].join(','), TOMER_MANAGER_PHONE: TEST_MANAGER_PHONE,
        TOMER_PROACTIVE_ENABLED: 'true', MEMBER_CARE_TEST_NOW: NOW, BACKEND_URL: BASE }) });
    children.push(server); server.stderr.on('data', d => { serverErr += d.toString(); });
    return server;
  }
  let server = startServer();
  const api = async (method, url, body) => (await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
  const waitUp = () => waitFor(async () => (await (await fetch(`${BASE}/health`)).json()).startupComplete === true, { timeoutMs: 30000, intervalMs: 200 });
  if (!(await waitUp())) throw new Error('server did not start: ' + serverErr.slice(-400));
  const toMember = p => sent.filter(s => String(s.chatId ?? '').startsWith(p));
  const overview = () => api('GET', '/api/tomer/care/overview');

  const chrome = spawn(browserBin, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1500,1300', 'about:blank'], { stdio: 'ignore' });
  children.push(chrome);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()).find(t => t.type === 'page'), { timeoutMs: 20000, intervalMs: 200 });
  if (!target) throw new Error('browser did not expose a page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket error')); });
  let seq = 0; const pending = new Map(); const pageErrors = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? 'unknown'); };
  const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  async function evalJs(expr) { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result.value; }
  await cdp('Page.enable'); await cdp('Runtime.enable');
  const q = s => JSON.stringify(s);
  async function click(selector) {
    const box = await evalJs(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!box || !box.w || !box.h) throw new Error('element not clickable: ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  async function fill(selector, text) { await evalJs(`(() => { const e = document.querySelector(${q(selector)}); e.focus(); e.value = ''; return true; })()`); await click(selector); if (text) await cdp('Input.insertText', { text }); }
  const until = (expr, timeoutMs = 10000) => waitFor(() => evalJs(expr), { timeoutMs });
  const txt = sel => evalJs(`document.querySelector(${q(sel)})?.innerText ?? null`);
  const attr = (sel, a) => evalJs(`document.querySelector(${q(sel)})?.getAttribute(${q(a)}) ?? null`);
  const exists = sel => evalJs(`!!document.querySelector(${q(sel)})`);
  const flashed = (kind, re) => waitFor(async () => { const f = await evalJs(`(() => { const e = document.getElementById('tc-flash'); return e ? { text: e.textContent, kind: e.dataset.kind ?? null } : null; })()`); return f && f.kind === kind && re.test(f.text) ? f : null; }, { timeoutMs: 12000 });
  const prog = id => `#tc-programs tr[data-program="${id}"]`;
  const state = id => attr(prog(id), 'data-state');
  const act = (id, a) => `${prog(id)} [data-care="${a}"]`;
  const tab = async f => { await click(`#twp-care [data-ef="${f}"]`); await new Promise(r => setTimeout(r, 400)); };

  // ── open the area ───────────────────────────────────────────────────────────
  await cdp('Page.navigate', { url: `${BASE}/#tomer` });
  await until(`document.readyState === 'complete' && document.querySelector('.tab-btn.active')?.dataset.tab === 'tomer'`, 15000);
  await click('.tw-tab[data-pane="care"]');
  check('the "ליווי חברים" tab lists the nine programs', (await until(`document.querySelectorAll('#tc-programs tr[data-program]').length === 9`)) === true, JSON.stringify(pageErrors));
  check('the old "אוטומציה" / "הודעות מתוזמנות" tabs are gone', !(await exists('.tw-tab[data-pane="automation"]')) && !(await exists('.tw-tab[data-pane="upcoming"]')));
  // ── as shipped: the contact policy is not owner-approved → nothing can be activated ──
  check('as shipped, ALL nine programs are blocked: the contact policy is not owner-approved yet',
    (await evalJs(`[...document.querySelectorAll('#tc-programs tr[data-program]')].map(r => r.dataset.state).join(',')`)) === Array(9).fill('blocked').join(',')
    && /מדיניות הקשר.*עוד לא אושרה על ידי בעלת הסטודיו/.test(await txt(prog('birthday'))) && (await evalJs(`document.querySelector(${q(act('birthday', 'enable'))}).disabled`)) === true);
  check('the API refuses to enable an unapproved program too', (await api('POST', '/api/tomer/care/programs/birthday', { enabled: true, by: 'בדיקה' })).error === 'program_blocked');
  // ── owner approval of the contact policy — through the panel controls ───────
  const R1 = '#tc-absence tr[data-abs="1"]';
  const setVal = (sel, v) => evalJs(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const approvalText = await txt('#tc-approval-values');
  check('approval card shows the policy that is being approved (hours, Friday, Saturday, birthday rule, cooldowns, program hours, priority) and that it is NOT approved',
    (await attr('#tc-approval', 'data-approval')) === 'none' && /לא אושרה — אי אפשר להפעיל אף תוכנית/.test(await txt('#tc-approval'))
    && /שעות שליחה: 09:00–20:00/.test(approvalText) && /יום שישי: עד 13:00/.test(approvalText) && /שבת: לא נשלח/.test(approvalText) && /יום הולדת שחל בשבת: ברכה ביום שישי/.test(approvalText)
    && /מרווח בין הודעות יזומות: 72 שעות/.test(approvalText) && /מרווח בין הודעות נוכחות: 6 ימים/.test(approvalText) && /יום הולדת 09:00/.test(approvalText) && /ברוכים הבאים › חיוב חודשי שנכשל › יום הולדת/.test(approvalText), approvalText);
  await click('#tc-approval [data-care="policy-approve"]');
  check('approval without ticking the confirmation is refused', !!(await flashed('error', /יש לסמן את תיבת האישור/)) && (await overview()).policyApproval.approved === false);
  await click('#tc-approve-ok');
  await click('#tc-approval [data-care="policy-approve"]');
  check('approval without the approver name is refused', !!(await flashed('error', /שם המאשר/)) && (await overview()).policyApproval.approved === false);
  await fill('#tc-approver', 'בעלים (בדיקה)');
  await click('#tc-approve-ok');
  await click('#tc-approval [data-care="policy-approve"]');
  check('panel approval is recorded with the approver, the time and the approved values; programs are no longer blocked by it',
    !!(await flashed('ok', /מדיניות הקשר אושרה/)) && (await until(`document.querySelector('#tc-approval')?.dataset.approval === 'approved'`)) === true
    && /אושרה על ידי בעלים \(בדיקה\)/.test(await txt('#tc-approval-who'))
    && await (async () => { const a = (await overview()).settings.policyApproval; return a.by === 'בעלים (בדיקה)' && a.approved.policy.windowEnd === 20 && a.approved.hours.birthday === 9 && a.approved.priority[0] === 'welcome'; })()
    && (await state('birthday')) === 'off');
  // changing a value voids it — visibly — and it must be approved again
  await fill('#tc-p-cooldownHours', '48');
  await click('#tc-save');
  check('changing a policy value voids the approval in the panel and blocks every program again',
    !!(await flashed('ok', /ההגדרות נשמרו/)) && (await until(`document.querySelector('#tc-approval')?.dataset.approval === 'stale'`)) === true
    && /האישור בוטל — ערך שונה אחרי האישור/.test(await txt('#tc-approval')) && /מרווח בין הודעות יזומות: 48 שעות/.test(await txt('#tc-approval-values')) && (await state('birthday')) === 'blocked');
  await fill('#tc-p-cooldownHours', '72');
  await click('#tc-save');
  await flashed('ok', /ההגדרות נשמרו/);
  await until(`document.querySelector('#tc-approval')?.dataset.approval === 'approved'`);   // the approved values are back → the approval stands again
  check('restoring the approved values restores the approval (same fingerprint); revoke and re-approve work', (await overview()).policyApproval.approved === true);
  await click('#tc-approval [data-care="policy-revoke"]');
  await flashed('ok', /האישור בוטל/);
  await until(`document.querySelector('#tc-approval')?.dataset.approval === 'none'`);
  await fill('#tc-approver', 'בעלים (בדיקה)'); await click('#tc-approve-ok'); await click('#tc-approval [data-care="policy-approve"]');
  await flashed('ok', /מדיניות הקשר אושרה/);
  await until(`document.querySelector('#tc-approval')?.dataset.approval === 'approved'`);

  // ── freeze status: evidence, one member's staff review, then the source confirmation ──
  await click('#tc-absence-load');
  await until(`!!document.querySelector('#tc-freeze') && !!document.querySelector(${q(R1)})`);
  check('freeze evidence is shown: the report was read, it is NOT confirmed, and every member is "unknown"',
    (await attr('#tc-freeze', 'data-freeze-confirmed')) === '0' && /דוח ההקפאות של Arbox: נקרא/.test(await txt('#tc-freeze-evidence')) && /לא בהקפאה 0/.test(await txt('#tc-freeze-evidence'))
    && /לא אושר/.test(await txt('#tc-freeze')) && (await attr(`${R1} [data-freeze]`, 'data-freeze')) === 'unknown' && /הדוח לא אושר כמקור/.test(await txt(`${R1} .tc-freeze-cell`)), await txt('#tc-freeze'));
  await click(`${R1} .tc-freeze-form summary`);
  await setVal(`${R1} .tc-fz-status`, 'not_frozen');
  await fill(`${R1} .tc-fz-by`, 'עדן (בדיקה)');
  await click(`${R1} [data-care="freeze-review-save"]`);
  check('a freeze review without evidence is refused', !!(await flashed('error', /מה נבדק ואיפה/)) && (await overview()).freeze.reviews.length === 0);
  await until(`!!document.querySelector(${q(R1)})`);
  await click(`${R1} .tc-freeze-form summary`);
  await setVal(`${R1} .tc-fz-status`, 'not_frozen');
  await fill(`${R1} .tc-fz-note`, 'כרטיס החברה ב-Arbox: אין הקפאה פעילה');
  await fill(`${R1} .tc-fz-by`, 'עדן (בדיקה)');
  await click(`${R1} [data-care="freeze-review-save"]`);
  check('a staff review of one member is saved and shown with reviewer, evidence and expiry; only that member becomes "not frozen"',
    !!(await flashed('ok', /בדיקת ההקפאה נשמרה/)) && (await until(`document.querySelector(${q(R1 + ' [data-freeze]')})?.dataset.freeze === 'not_frozen'`)) === true
    && await (async () => { const c = await txt(`${R1} .tc-freeze-cell`); return /בדיקת צוות/.test(c) && /נבדק על ידי עדן \(בדיקה\)/.test(c) && /ראיה: כרטיס החברה ב-Arbox: אין הקפאה פעילה/.test(c) && /בתוקף עד/.test(c); })()
    && (await attr('#tc-absence tr[data-abs="2"] [data-freeze]', 'data-freeze')) === 'unknown' && /לא בהקפאה 1/.test(await txt('#tc-freeze-evidence')));
  await click(`${R1} [data-care="freeze-review-clear"]`);
  check('clearing the review returns the member to "unknown"', !!(await flashed('ok', /הבדיקה נוקתה/)) && (await until(`document.querySelector(${q(R1 + ' [data-freeze]')})?.dataset.freeze === 'unknown'`)) === true && (await overview()).freeze.reviews.length === 0);
  await click('#tc-freeze [data-care="freeze-source-confirm"]');
  check('confirming the hold report needs the tick and a reviewer name', !!(await flashed('error', /יש לסמן את תיבת האישור/)) && (await overview()).freeze.sourceConfirmed === null);
  await until(`!!document.querySelector('#tc-freeze-source-ok')`);
  await click('#tc-freeze-source-ok');
  await fill('#tc-freeze-source-by', 'צוות (בדיקה)');
  await click('#tc-freeze [data-care="freeze-source-confirm"]');
  check('the confirmed source is shown with who confirmed it; members without a hold row are now "not frozen"',
    !!(await flashed('ok', /דוח ההקפאות אושר/)) && (await until(`document.querySelector('#tc-freeze')?.dataset.freezeConfirmed === '1'`)) === true
    && /אושר כמקור אמין על ידי צוות \(בדיקה\)/.test(await txt('#tc-freeze')) && (await attr(`${R1} [data-freeze]`, 'data-freeze')) === 'not_frozen' && (await overview()).freeze.sourceConfirmed.by === 'צוות (בדיקה)');
  check('every program starts disabled; welcome and failed-payment are BLOCKED with the missing setting named',
    (await evalJs(`[...document.querySelectorAll('#tc-programs tr[data-program]')].map(r => r.dataset.state).join(',')`)) === 'blocked,blocked,off,off,off,off,off,off,off'
    && /קישור מאושר לקבוצת הוואטסאפ/.test(await txt(prog('welcome'))) && /דרך מאושרת ובטוחה/.test(await txt(prog('payment_failed'))) && /עוד לא אושרה/.test(await txt(prog('payment_failed'))));
  check('a blocked program cannot be enabled (button disabled)', (await evalJs(`document.querySelector(${q(act('welcome', 'enable'))}).disabled`)) === true);
  check('missing guest-session policy decisions are listed', /תוקף אימוני האורח/.test(await txt('#tc-settings .tc-missing')) && /איך רושמים אורח ב-Arbox/.test(await txt('#tc-settings .tc-missing')));
  check('proposed contact-policy defaults are shown (09–20, Friday 13, 72h, 6 days, 24h)', (await evalJs(`['windowStart','windowEnd','fridayEnd','cooldownHours','attendanceCooldownDays','recentConversationHours'].map(k => document.getElementById('tc-p-' + k).value).join(',')`)) === '9,20,13,72,6,24');

  // ── settings ────────────────────────────────────────────────────────────────
  await fill('#tc-group-link', 'https://example.com/not-whatsapp');
  await click('#tc-save');
  check('settings: a link that is not a WhatsApp invite is refused', !!(await flashed('error', /קישור הזמנה של וואטסאפ/)) && (await overview()).settings.groupLink === null);
  await fill('#tc-group-link', GROUP);
  await click('#tc-save');
  check('settings: the approved group link is saved; welcome is no longer blocked', !!(await flashed('ok', /ההגדרות נשמרו/)) && (await until(`document.querySelector(${q(prog('welcome'))})?.dataset.state === 'off'`)) === true && (await overview()).settings.groupLink === GROUP);

  // ── preview before enabling: who would get it and why not the others ───────
  await click(act('absence7', 'preview'));
  check('preview (7 days): Arbox sources with read time; says the program is not yet activated', (await until(`!!document.querySelector('#tc-preview [data-inc]')`)) === true && (await evalJs(`[...document.querySelectorAll('#tc-preview [data-src]')].every(e => e.dataset.srcOk === '1')`)) === true && /התוכנית טרם הופעלה/.test(await txt('#tc-preview')));
  check('preview: אביגיל and גליה (7 days today) are included with the exact source date and the message text', (await evalJs(`[...document.querySelectorAll('#tc-preview [data-inc]')].map(e => e.dataset.inc + ':' + e.dataset.decision).sort().join(',')`)) === '1:send,3:send'
    && (await txt('#tc-preview [data-inc="1"]')).includes(`lastAttendance: ${day(-7)}`) && /לא ראינו אותך בסטודיו בשבוע האחרון/.test(await evalJs(`document.querySelector('#tc-preview [data-inc="1"] .tw-cd-text').textContent`)));
  check('preview: exclusions are counted by reason (upcoming booking, new member who never attended, not in the window)', (await exists('#tc-preview [data-excl="has_upcoming_booking"]')) && (await exists('#tc-preview [data-excl="new_never_attended"]')) && (await exists('#tc-preview [data-excl="not_in_window"]')));
  check('preview sent nothing', sent.length === 0);

  // ── pause one member, then enable and run ──────────────────────────────────
  await click('#tc-pauses [data-care="pause-add"]');
  check('pause: phone and reason are required', !!(await flashed('error', /מספר טלפון לא תקין|יש לכתוב סיבה/)));
  await fill('#tc-pause-phone', '0507200003'); await fill('#tc-pause-reason', 'מילואים');
  await evalJs(`(() => { const e = document.getElementById('tc-pause-until'); e.value = ${q(day(10))}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await click('#tc-pauses [data-care="pause-add"]');
  check('pause: added with reason and end date', !!(await flashed('ok', /ההשהיה נוספה/)) && (await until(`!!document.querySelector('#tc-pauses [data-pause="${P.C}"]')`)) === true && new RegExp(`מילואים[\\s\\S]*${dmy(day(10)).replace(/\./g, '\\.')}`).test(await txt(`#tc-pauses [data-pause="${P.C}"]`)));
  await click(act('absence7', 'enable'));
  check('enable: the program is on and shows its baseline (no retroactive sending)', !!(await flashed('ok', /תפעל רק על אירועים מעכשיו/)) && (await state('absence7')) === 'on' && /פועל על אירועים מ-/.test(await txt(prog('absence7'))));
  check('tab badge counts enabled programs', (await evalJs(`document.getElementById('tw-badge-care').textContent`)) === '1');
  await click(act('absence7', 'preview'));
  check('preview after the pause: גליה is now "blocked — השהיה פעילה"', (await until(`document.querySelector('#tc-preview [data-inc="3"]')?.dataset.decision === 'block'`)) === true && /השהיה פעילה/.test(await txt('#tc-preview [data-inc="3"]')));
  await click(act('absence7', 'run'));
  check('run now: one message sent, one blocked — reported as such', !!(await flashed('ok', /נשלחו 1, נדחו 0, חסומות 1/)));
  check('only אביגיל received the 7-day message (with Tomer\'s introduction); the paused and the booked members received nothing', toMember(P.A).length === 1 && /^אני תומר, העוזר הדיגיטלי של Shape Studio\.\nהיי אביגיל 💛 לא ראינו אותך/.test(toMember(P.A)[0].message) && sent.length === 1, JSON.stringify(sent.map(s => s.chatId)));
  await tab('sent');
  check('"נשלחו": the message is listed as sent, waiting for a reply, with its wording', (await until(`document.querySelectorAll('#tc-episodes tr[data-episode]').length === 1`)) === true && /נשלח/.test(await txt('#tc-episodes tr[data-episode]')) && /ממתין לתגובה/.test(await txt('#tc-episodes tr[data-episode]')));
  await tab('upcoming');
  check('"ממתינות / נדחו": the blocked episode is kept with its reason — not dropped', /חסום[\s\S]*השהיה פעילה/.test(await txt('#tc-episodes tr[data-episode]')));

  // ── the member answers; the conversation continues and pauses outreach ─────
  const reply = await api('POST', '/api/whatsapp/simulate', { from: P.A, name: 'WA', text: 'אני בחופשה שבועיים' });
  check('reply "אני בחופשה שבועיים" continues the proactive conversation (not a service template)', reply.route === 'tomer_care_reply' && /לא אכתוב לך עד/.test(toMember(P.A).at(-1)?.message ?? ''), reply.route);
  await click('#tw-refresh');
  check('pauses: the member\'s own vacation appears, set by the member, until the date she gave', (await until(`!!document.querySelector('#tc-pauses [data-pause="${P.A}"]')`)) === true && /חופשה[\s\S]*החבר\/ה/.test(await txt(`#tc-pauses [data-pause="${P.A}"]`)) && (await txt(`#tc-pauses [data-pause="${P.A}"]`)).includes(dmy(day(14))));
  await tab('sent');
  check('messages: the conversation outcome and the reply text are shown', (await until(`/חופשה \\/ היעדרות/.test(document.querySelector('#tc-episodes tr[data-episode]')?.innerText ?? '')`)) === true && /אני בחופשה שבועיים/.test(await txt('#tc-episodes tr[data-episode]')));

  // ── first month → guest entitlement, reservation, redemption ───────────────
  await click(act('month1', 'enable'));
  await flashed('ok', /הופעלה/);
  await click(act('month1', 'run'));
  check('first-month message sent to מיכל with the approved offer', !!(await flashed('ok', /נשלחו 1/)) && /שני אימוני אורח במתנה/.test(toMember(P.M).at(-1)?.message ?? ''));
  check('guest entitlement issued: 2 remaining', (await until(`document.querySelector('#tc-entitlements [data-ent="5"] [data-ent-remaining]')?.dataset.entRemaining === '2'`)) === true);
  const ask = await api('POST', '/api/whatsapp/simulate', { from: P.M, name: 'WA', text: 'רוצה להביא חברה' });
  check('"רוצה להביא חברה" opens a staff case (guest_pass); nothing is claimed as booked', ask.route === 'tomer_case_opened' && /האימון עוד לא נקבע בשלב זה/.test(toMember(P.M).at(-1)?.message ?? ''), ask.route);
  await click('#tw-refresh');
  await until(`!!document.querySelector('#tc-entitlements [data-ent="5"] .tc-guest-name')`);
  await fill('#tc-entitlements [data-ent="5"] .tc-guest-name', 'רונית');
  await click('#tc-entitlements [data-ent="5"] [data-care="ent-reserve"]');
  check('reserve: one session reserved for the named guest → 1 remaining', !!(await flashed('ok', /אימון אורח נשמר/)) && (await until(`document.querySelector('#tc-entitlements [data-ent="5"] [data-ent-remaining]')?.dataset.entRemaining === '1'`)) === true && /שמור — רונית/.test(await txt('#tc-entitlements [data-ent="5"]')), await txt('#tc-entitlements'));
  await click('#tc-entitlements [data-ent="5"] [data-care="ent-redeem"]');
  check('redeem: marked as redeemed, no redeem button left on it', !!(await flashed('ok', /סומן כמומש/)) && (await until(`document.querySelector('#tc-entitlements [data-ent="5"] [data-item-status="redeemed"]') && !document.querySelector('#tc-entitlements [data-ent="5"] [data-item-status="redeemed"] [data-care]')`)) === true);
  await fill('#tc-entitlements [data-ent="5"] .tc-guest-name', 'דפנה');
  await click('#tc-entitlements [data-ent="5"] [data-care="ent-reserve"]');
  check('second reservation → 0 remaining; no further reservation is offered', (await until(`document.querySelector('#tc-entitlements [data-ent="5"] [data-ent-remaining]')?.dataset.entRemaining === '0' && !document.querySelector('#tc-entitlements [data-ent="5"] .tc-guest-name')`)) === true);
  check('server refuses a third reservation', (await api('POST', '/api/tomer/care/entitlements/5/reserve', {})).error === 'none_remaining');
  await click('#tc-entitlements [data-ent="5"] [data-item-status="reserved"] [data-care="ent-release"]');
  check('release: the unused reservation returns → 1 remaining; history keeps all three steps', (await until(`document.querySelector('#tc-entitlements [data-ent="5"] [data-ent-remaining]')?.dataset.entRemaining === '1'`)) === true && (await evalJs(`[...document.querySelectorAll('#tc-entitlements [data-ent="5"] [data-item]')].map(e => e.dataset.itemStatus).join(',')`)) === 'redeemed,released');

  // ── welcome: uncertain provider result → staff decide → sent once ──────────
  await click(act('welcome', 'enable'));
  await flashed('ok', /הופעלה/);
  prov.failFor = P.W;
  await click(act('welcome', 'run'));
  check('provider gives no clear answer → reported as "לא ודאי", not as sent', !!(await flashed('ok', /לא ודאי 1/)) && toMember(P.W).length === 0);
  await tab('problem');
  check('"נכשלו / לא ודאי": the message waits for a staff decision', (await until(`document.querySelector('#tc-episodes tr[data-episode]')?.dataset.epStatus === 'uncertain'`)) === true && (await exists('#tc-episodes [data-care="ep-retry"]')) && (await exists('#tc-episodes [data-care="ep-sent"]')));
  prov.failFor = null;
  await click(act('welcome', 'run'));
  check('an uncertain message is NOT re-sent by another run', !!(await flashed('ok', /נשלחו 0/)) && toMember(P.W).length === 0);
  await click('#tc-episodes [data-care="ep-retry"]');
  await flashed('ok', /יישלח בריצה הבאה/);
  await click(act('welcome', 'run'));
  check('after staff say it did not arrive, the next run sends it — once, with the group link', !!(await flashed('ok', /נשלחו 1/)) && toMember(P.W).length === 1 && toMember(P.W)[0].message.includes(GROUP) && /היי ורד, ברוכים הבאים ל־Shape Studio! 💛/.test(toMember(P.W)[0].message));

  // ── reports ────────────────────────────────────────────────────────────────
  await click('#tc-absence-load');
  check('absence report: rows with last verified attendance, days, future booking, last outreach, response, owner, next action',
    (await until(`!!document.querySelector('#tc-absence tr[data-abs="1"]')`)) === true
    && await (async () => { const a = await txt('#tc-absence tr[data-abs="1"]'), b = await txt('#tc-absence tr[data-abs="2"]'), n = await txt('#tc-absence tr[data-abs="4"]');
      return a.includes(dmy(day(-7))) && /7 ימים בלי אימון/.test(a) && /חופשה \/ היעדרות/.test(a) && /בהשהיה עד/.test(a) && b.includes(dmy(day(2))) && /רשום\/ה לאימון/.test(b) && /טרם הגיע\/ה/.test(n); })(), await txt('#tc-absence'));
  await click('#tc-visibility-load');
  check('visibility: the new member who has not attended a first session is listed; no outreach exists for her', (await until(`!!document.querySelector('#tc-visibility [data-new="4"]')`)) === true && /ממתין לאישור/.test(await txt('#tc-visibility')) && toMember(P.N).length === 0);

  // ── missing data is shown as missing, never as absence ─────────────────────
  arbox.mode.bookingsDown = true;
  await new Promise(r => setTimeout(r, 300));
  await evalJs(`fetch('/api/tomer/care/preview/tuesday').then(() => true)`);     // lets the 5-minute attendance cache be bypassed by a fresh run below
  await click(act('absence7', 'run'));
  check('attendance data unavailable: the run reports it and sends nothing', !!(await flashed('ok', /נתוני Arbox חסרים — לא בוצע/)));
  arbox.mode.bookingsDown = false;

  // ── remove pause, disable, remove the link ─────────────────────────────────
  await click(`#tc-pauses [data-pause="${P.C}"] [data-care="pause-remove"]`);
  check('pause removed', !!(await flashed('ok', /ההשהיה הוסרה/)) && (await until(`!document.querySelector('#tc-pauses [data-pause="${P.C}"]')`)) === true);
  await click(act('month1', 'disable'));
  check('disable: the program is off again', !!(await flashed('ok', /התוכנית כובתה/)) && (await state('month1')) === 'off');
  await fill('#tc-group-link', '');
  await click('#tc-save');
  check('removing the group link blocks AND disables the welcome program', !!(await flashed('ok', /ההגדרות נשמרו/)) && (await until(`document.querySelector(${q(prog('welcome'))})?.dataset.state === 'blocked'`)) === true && (await overview()).programs.find(p => p.id === 'welcome').enabled === false);

  // ── restart: everything persisted, nothing sent ────────────────────────────
  const before = sent.length, ovBefore = await overview();
  killTree(server.pid);
  await waitFor(async () => { try { await fetch(`${BASE}/health`); return false; } catch { return true; } }, { timeoutMs: 10000, intervalMs: 200 });
  server = startServer();
  if (!(await waitUp())) throw new Error('server did not restart: ' + serverErr.slice(-400));
  await new Promise(r => setTimeout(r, 1200));
  const ovAfter = await overview();
  check('restart: programs, baselines, pauses and entitlements are identical; nothing was sent', JSON.stringify(ovAfter.programs.map(p => [p.id, p.enabled, p.activatedAt])) === JSON.stringify(ovBefore.programs.map(p => [p.id, p.enabled, p.activatedAt]))
    && JSON.stringify(ovAfter.pauses) === JSON.stringify(ovBefore.pauses) && JSON.stringify(ovAfter.entitlements) === JSON.stringify(ovBefore.entitlements) && sent.length === before);
  await cdp('Page.reload');
  await until(`document.readyState === 'complete' && !!document.querySelector('.tw-tab[data-pane="care"]')`, 15000);
  await click('.tab-btn[data-tab="tomer"]'); await click('.tw-tab[data-pane="care"]');
  check('restart: the panel shows the persisted state (7-day on, entitlement 1 remaining, member pause)', (await until(`document.querySelector(${q(prog('absence7'))})?.dataset.state === 'on' && document.querySelector('#tc-entitlements [data-ent="5"] [data-ent-remaining]')?.dataset.entRemaining === '1' && !!document.querySelector('#tc-pauses [data-pause="${P.A}"]')`, 15000)) === true);
  check('every message of the whole run went to an invented member or nowhere; the manager got only the one actionable case', sent.every(s => [...Object.values(P), TEST_MANAGER_PHONE].some(p => String(s.chatId).startsWith(p))) && sent.filter(s => String(s.chatId).startsWith(TEST_MANAGER_PHONE)).length === 1);

  if (shotFile) { const shot = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(shotFile, Buffer.from(shot.data, 'base64')); console.log(`  screenshot: ${shotFile}`); }
  check('browser: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  fail++; console.error('[ERROR]', err.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  for (const c of children) killTree(c.pid);
  try { green?.close(); } catch { /* ignore */ }
  try { await arbox.close(); } catch { /* ignore */ }
  removeDir(dataDir);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\nMember care browser check: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
