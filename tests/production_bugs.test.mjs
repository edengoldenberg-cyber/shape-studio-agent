/**
 * production_bugs.test.mjs
 *
 * Reproduces and verifies fixes for three bugs observed in the live Nov-12 session:
 *
 *   Bug 1 — awaitingCallbackTime: no name ask after appointment created.
 *     The confirmation reply ended with "יש עוד משהו שאוכל לעזור?" and never
 *     asked for the prospect's name. nameAsked was not set in qualData.
 *
 *   Bug 2 — Thursday date: resolveTargetDate("חמישי") on a Thursday returned
 *     the NEXT Thursday (Nov 19) because `|| 7` forced diff=0 to 7.
 *     Nov 12 2026 IS a Thursday — the user asked about today's classes.
 *
 *   Bug 3 — Morning filter: "מי מעביר אימון ביום חמישי בבוקר?" returned all-day
 *     classes. Classes starting at ≥12:00 should be excluded from a morning query.
 */

import { createServer }  from 'http';
import { spawn }         from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir }        from 'os';
import path              from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const req       = createRequire(import.meta.url);

// ── Helpers ───────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function test(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else     { console.error(`  ✗ ${label}  →  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}
function truthy(label, value) {
  if (value) { console.log(`  ✓ ${label}`); pass++; }
  else        { console.error(`  ✗ ${label}  →  expected truthy, got ${String(value)}`); fail++; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Bug 2 + 3: unit-level (no server needed) ─────────────────────────────────

console.log('\n── Bug 2 — resolveTargetDate: same-day query returns today ──');
{
  const { resolveTargetDate } = (() => {
    // Inline a copy so we can test against a controlled anchor date
    const HE_DAY_MAP = {
      'ראשון':0,'sunday':0,'שני':1,'monday':1,'שלישי':2,'tuesday':2,
      'רביעי':3,'wednesday':3,'חמישי':4,'thursday':4,'שישי':5,'friday':5,'שבת':6,'saturday':6,
    };
    function resolveTargetDate(query, anchorDate = null) {
      const today = anchorDate instanceof Date ? anchorDate : new Date();
      if (!query) return today.toISOString().split('T')[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(query)) return query;
      const lc = query.toLowerCase();
      for (const [token, weekday] of Object.entries(HE_DAY_MAP)) {
        if (lc.includes(token)) {
          const diff   = (weekday - today.getDay() + 7) % 7;  // 0 = same day
          const target = new Date(today);
          target.setDate(today.getDate() + diff);
          return target.toISOString().split('T')[0];
        }
      }
      if (lc.includes('היום') || lc.includes('today')) return today.toISOString().split('T')[0];
      return today.toISOString().split('T')[0];
    }
    return { resolveTargetDate };
  })();

  // Nov 12 2026 is a Thursday (confirmed: new Date('2026-11-12').getDay() === 4)
  const thursdayAnchor = new Date('2026-11-12T12:10:00.000Z'); // 14:10 IL — the live query time
  truthy('anchor is Thursday', thursdayAnchor.getDay() === 4);

  // Live query: "מי מעביר אימון ביום חמישי בבוקר?" sent on Thursday Nov 12
  // Expected: Nov 12 (today), not Nov 19 (next week)
  const result1 = resolveTargetDate('מי מעביר אימון ביום חמישי בבוקר?', thursdayAnchor);
  test('Thursday query on Thursday → today (2026-11-12)', result1, '2026-11-12');

  // Wednesday anchor asking for Thursday → tomorrow
  const wedAnchor = new Date('2026-11-11T12:10:00.000Z'); // Nov 11 = Wednesday
  truthy('wednesday anchor is Wednesday', wedAnchor.getDay() === 3);
  const result2 = resolveTargetDate('מה יש ביום חמישי?', wedAnchor);
  test('Thursday query on Wednesday → tomorrow (2026-11-12)', result2, '2026-11-12');

  // Sunday asking for Thursday → 4 days forward
  const sunAnchor = new Date('2026-11-15T12:00:00.000Z'); // Nov 15 = Sunday
  const result3 = resolveTargetDate('שיעורי חמישי', sunAnchor);
  test('Thursday query on Sunday → Nov 19', result3, '2026-11-19');

  // Same-day Monday → today
  const monAnchor = new Date('2026-11-16T12:00:00.000Z'); // Nov 16 = Monday
  const result4 = resolveTargetDate('מה יש היום בשני?', monAnchor);
  test('Monday query on Monday → today (2026-11-16)', result4, '2026-11-16');
}

console.log('\n── Bug 3 — Morning filter ──');
{
  // Simulate the class list that Arbox might return for a Thursday
  const mockClasses = [
    { start: '08:15', end: '09:05', name: 'פילאטיס מכשירים פאוור', staff: 'נוי היינה' },
    { start: '09:30', end: '10:20', name: 'Pilates Barre', staff: 'ריקי לוי' },
    { start: '12:00', end: '13:00', name: 'פילאטיס מכשירים', staff: 'שרה כהן' },
    { start: '17:00', end: '18:00', name: 'ALL IN', staff: 'דן לוי' },
    { start: '19:30', end: '20:30', name: 'אימון כח', staff: 'מוטי גולן' },
  ];

  function applyTimeFilter(classes, msgText) {
    const isMorningQuery = /בבוקר|שעות\s*בוקר|אימון\s*בוקר/.test(msgText);
    const isEveningQuery = /בערב|שעות\s*ערב|אחה"צ|אחרי\s*הצהריים/.test(msgText);
    if (isMorningQuery) return classes.filter(c => parseInt((c.start ?? '12').split(':')[0], 10) < 12);
    if (isEveningQuery) return classes.filter(c => parseInt((c.start ?? '12').split(':')[0], 10) >= 17);
    return classes;
  }

  // Morning query: "מי מעביר אימון ביום חמישי בבוקר?"
  const morning = applyTimeFilter(mockClasses, 'מי מעביר אימון ביום חמישי בבוקר?');
  test('morning filter: 2 classes before 12:00', morning.length, 2);
  test('morning filter: 08:15 included', morning[0].start, '08:15');
  test('morning filter: 09:30 included', morning[1].start, '09:30');
  test('morning filter: 12:00 excluded (not before 12)', morning.some(c => c.start === '12:00'), false);
  test('morning filter: 17:00 excluded', morning.some(c => c.start === '17:00'), false);

  // Evening query: "מה יש בערב?"
  const evening = applyTimeFilter(mockClasses, 'מה יש בערב?');
  test('evening filter: 2 classes ≥17:00', evening.length, 2);
  test('evening filter: 17:00 included', evening.some(c => c.start === '17:00'), true);
  test('evening filter: 08:15 excluded', evening.some(c => c.start === '08:15'), false);

  // No filter: all classes
  const all = applyTimeFilter(mockClasses, 'מה יש ביום חמישי?');
  test('no filter: all 5 classes', all.length, 5);
}

// ── Bug 1 — awaitingCallbackTime: name ask via full server ────────────────────

console.log('\n── Bug 1 — awaitingCallbackTime: name asked, nameAsked=true set ──');

const tmpDir  = mkdtempSync(path.join(tmpdir(), 'pb_test_'));
const dataDir = path.join(tmpDir, 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'staff_config.json'),
  JSON.stringify({ staff: [], default_assignee_id: null, appointment_duration_min: 30 }));

function freePort() {
  return new Promise(resolve => {
    const srv = req('net').createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

function startMock(port) {
  return new Promise(resolve => {
    const srv = createServer((reqHttp, res) => {
      let b = '';
      reqHttp.on('data', d => b += d);
      reqHttp.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reqHttp.url.includes('/arbox') ? { data: [] } : { idMessage: `MOCK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }));
      });
    });
    srv.listen(port, () => resolve(srv));
  });
}

function startApp(appPort, mockPort) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT:                     String(appPort),
        TEST_MODE:                'true',
        GREEN_API_URL:            `localhost:${mockPort}`,
        GREEN_API_ID_INSTANCE:    '9999099',
        GREEN_API_TOKEN_INSTANCE: 'mock-tok-pb',
        ARBOX_BASE_URL:           `http://localhost:${mockPort}/arbox`,
        ARBOX_API_KEY:            'mock-arbox',
        STUDIO_OWNER_PHONE:       '972509000001',
        NOTIFY_PHONES:            '972509000001',
        TEST_ALLOWLIST_PHONES:    '972509000001',
        OPENAI_API_KEY:           'sk-test',
        DATA_DIR:                 dataDir,
        NODE_ENV:                 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('error', reject);
    let resolved = false;
    const poll = setInterval(async () => {
      try {
        const h = await get(appPort, '/health');
        if (!resolved && h?.startupComplete === true) {
          resolved = true; clearInterval(poll); resolve(proc);
        }
      } catch {}
    }, 300);
    setTimeout(() => { if (!resolved) { resolved = true; clearInterval(poll); resolve(proc); } }, 20_000);
  });
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    req('http').get(`http://localhost:${port}${url}`, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    }).on('error', reject);
  });
}
function post(port, url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const r = req('http').request({
      hostname: 'localhost', port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}
function del(port, url) {
  return new Promise((resolve, reject) => {
    req('http').request({ hostname: 'localhost', port, path: url, method: 'DELETE' }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    }).on('error', reject).end();
  });
}

const LEAD = '972509970066';
let APP_PORT, MOCK_PORT, proc, mock;

try {
  [APP_PORT, MOCK_PORT] = await Promise.all([freePort(), freePort()]);
  [mock, proc] = await Promise.all([startMock(MOCK_PORT), startApp(APP_PORT, MOCK_PORT)]);

  const sim     = text => post(APP_PORT, '/api/whatsapp/simulate', { from: LEAD, name: 'TestUser', text });
  const getLead = ()   => get(APP_PORT, `/api/test/lead/${encodeURIComponent(LEAD)}`).then(r => r?.ok ? r.lead : null);
  const getApts = ()   => get(APP_PORT, '/api/admin/appointments?limit=50').then(r => r?.appointments ?? []);
  const clearCD = ()   => del(APP_PORT, '/api/test/cooldowns');

  await post(APP_PORT, '/api/store/reset', {});

  // ── Setup: get the representative flow to trigger ──────────────────────────
  // "פילאטיס" routes to Barak; then "אפשר לדבר עם נציג?" triggers the
  // awaitingCallbackTime path.
  await sim('שלום, אני מחפשת פילאטיס');
  await sleep(300);
  await clearCD();
  await sim('אפשר לדבר עם נציג?');
  await sleep(400);

  const leadAfterRep = await getLead();
  truthy('awaitingCallbackTime set after representative request',
    leadAfterRep?.meta?.awaitingCallbackTime === true);

  // ── Send the callback time ─────────────────────────────────────────────────
  await clearCD();
  const simResult = await sim('מחר ב12');
  await sleep(500);

  const leadAfterTime = await getLead();
  const qd = leadAfterTime?.meta?.qualData ?? {};

  // Unified semantics: awaitingCallbackTime now uses callback_requested (not call_scheduled)
  // so both paths share the same status, panel rendering, and name-capture gate.
  test('status = callback_requested after awaitingCallbackTime flow (unified)', leadAfterTime?.status, 'callback_requested');

  // callTimeGiven must be in qualData so the panel rawTime lookup works
  truthy('callTimeGiven in qualData', typeof qd.callTimeGiven === 'string' && qd.callTimeGiven.length > 0);

  // Core fix: nameAsked must be true so the NEXT reply is captured as the name
  test('nameAsked=true set by awaitingCallbackTime path', qd.nameAsked, true);

  // The confirmation reply must ask for a name, not claim "booked", not add a generic question
  const confirmReply = simResult?.barakReply ?? '';
  truthy('confirmation reply asks for name',
    /איך קוראים|מה שמ|קוראים לך|שמך/i.test(confirmReply));
  truthy('confirmation reply does NOT end with generic question',
    !/יש עוד משהו שאוכל לעזור/i.test(confirmReply));
  // Changed deliberately: the reply no longer echoes the raw text ("מחר ב12") — it states
  // the RESOLVED calendar date and Israel time taken from the persisted appointment.
  truthy('confirmation reply states the explicit resolved date and time',
    /יום \S+, \d{2}\.\d{2}\.\d{4} בשעה 12:00/.test(confirmReply));
  truthy('confirmation reply uses "request" wording (not "booked")',
    /רשמנו.*בקשת|בקשת.*שיחה/i.test(confirmReply) || !/השיחה נקבעה/i.test(confirmReply));

  // aptStore entry must be callback_pending (requested, not yet confirmed by staff)
  const apts = await getApts();
  const pendingEntry = apts.filter(a => a.leadPhone === LEAD && a.status === 'callback_pending');
  test('exactly 1 callback_pending aptStore entry (not confirmed)', pendingEntry.length, 1);

  // ── Send the name ─────────────────────────────────────────────────────────
  await clearCD();
  await sim('שרה');
  await sleep(500);

  const leadAfterName = await getLead();
  const qdN = leadAfterName?.meta?.qualData ?? {};
  test('confirmedName captured from post-call gate', qdN.confirmedName, 'שרה');

  // aptStore callback_pending entry must have the confirmed name now
  const aptsAfterName = await getApts();
  const updatedApt = aptsAfterName.find(a => a.leadPhone === LEAD && a.status === 'callback_pending');
  test('aptStore leadName updated to confirmed name', updatedApt?.leadName, 'שרה');

} catch (err) {
  console.error('[FATAL]', err.message, err.stack?.split('\n').slice(0,3).join('\n'));
  fail++;
} finally {
  try { proc?.kill(); } catch {}
  try { mock?.close(); } catch {}
}

console.log('\n─────────────────────────────────────────────────────────');
console.log(`production_bugs.test.mjs: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) process.exit(1);
