/**
 * integration_callback_aptstore.test.mjs
 *
 * Proves the production-path integration between inbound messages and aptStore:
 *
 *   1. Lead with callProposed=true sends acceptance with time
 *      → exactly one callback_pending aptStore record is created
 *      → scheduledAt is parsed in Asia/Jerusalem (not UTC, not server local)
 *      → leadName is null (name not known yet)
 *
 *   2. Lead sends their first name
 *      → aptStore record's leadName is updated to the confirmed name
 *      → entry is still callback_pending (not completed or cancelled)
 *
 *   3. Dup acceptance must NOT create a second aptStore entry.
 *
 * Uses the same full-server approach as callback_full.test.mjs (real
 * processInboundWAMessage pipeline, not individual function mocks).
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

// ── Isolated DATA_DIR ─────────────────────────────────────────────────────────

const tmpDir  = mkdtempSync(path.join(tmpdir(), 'ica_test_'));
const dataDir = path.join(tmpDir, 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'staff_config.json'),
  JSON.stringify({ staff: [], default_assignee_id: null, appointment_duration_min: 30 }));

// ── Free port finder ──────────────────────────────────────────────────────────

function freePort() {
  return new Promise(resolve => {
    const srv = req('net').createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

// ── Mock Green API ────────────────────────────────────────────────────────────

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

// ── App server ────────────────────────────────────────────────────────────────

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
        GREEN_API_TOKEN_INSTANCE: 'mock-tok-ica',
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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

// ── Test ──────────────────────────────────────────────────────────────────────

const LEAD = '972509970055';
let APP_PORT, MOCK_PORT, proc, mock;

try {
  [APP_PORT, MOCK_PORT] = await Promise.all([freePort(), freePort()]);
  [mock, proc] = await Promise.all([startMock(MOCK_PORT), startApp(APP_PORT, MOCK_PORT)]);

  const sim     = text => post(APP_PORT, '/api/whatsapp/simulate', { from: LEAD, name: 'Test', text });
  const setQual = q    => post(APP_PORT, `/api/leads/${encodeURIComponent(LEAD)}/set-qual`, q);
  const getLead = ()   => get(APP_PORT, `/api/test/lead/${encodeURIComponent(LEAD)}`).then(r => r?.ok ? r.lead : null);
  const getApts = ()   => get(APP_PORT, '/api/admin/appointments?limit=50').then(r => r?.appointments ?? []);
  const clearCD = ()   => del(APP_PORT, '/api/test/cooldowns');

  // Fresh store (data dir is isolated, but reset for clarity)
  await post(APP_PORT, '/api/store/reset', {});

  // ── Setup: register lead and seed callProposed ────────────────────────────
  // "פילאטיס" triggers SALES_INTENT_RE → Barak path, skips unclassified hold.
  await sim('מחפשת פילאטיס בחדרה');
  await sleep(300);
  await clearCD();
  await setQual({ callProposed: true, locationViable: true, locationCheckNeeded: false });
  await sleep(100);

  // ── 1. Acceptance with time → callback_pending created ───────────────────
  console.log('\n── 1. Acceptance → exactly one callback_pending entry ──');

  await sim('כן, היום בשעה 15 יתאים לי');
  await sleep(600);

  const leadAcc = await getLead();
  const qd      = leadAcc?.meta?.qualData ?? {};

  test('status = callback_requested', leadAcc?.status, 'callback_requested');
  truthy('callTimeGiven set in qualData', typeof qd.callTimeGiven === 'string' && qd.callTimeGiven.length > 0);

  const apts1 = await getApts();
  const pending1 = apts1.filter(a => a.leadPhone === LEAD && a.status === 'callback_pending');

  test('exactly 1 callback_pending entry', pending1.length, 1);

  if (pending1.length === 1) {
    const apt = pending1[0];
    console.log(`  [info] aptStore entry id=${apt.id}, scheduledAt=${apt.scheduledAt}, leadName=${apt.leadName}`);

    test('leadPhone correct', apt.leadPhone, LEAD);
    // leadName is set to the WhatsApp display name ("Test") at creation time —
    // it is not null. The confirmed name ("שרה") replaces it after name capture.
    truthy('leadName set at creation (WhatsApp display name)', typeof apt.leadName === 'string');
    truthy('scheduledAt populated', apt.scheduledAt != null);

    if (apt.scheduledAt) {
      // Verify parsed time is in Asia/Jerusalem: "היום בשעה 15" → 15:00 IL
      const ilHour = parseInt(
        new Date(apt.scheduledAt).toLocaleString('he-IL', {
          timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
        }), 10
      );
      test('scheduledAt parsed to 15:00 IL (not UTC 15)', ilHour, 15);
      console.log(`  [info] IL time: ${new Date(apt.scheduledAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);
    }

    // ── 2. Name capture → aptStore leadName updated ───────────────────────
    console.log('\n── 2. Name capture → aptStore leadName updated ──');

    await clearCD();
    // nameAsked was set by the agent in the acceptance reply (production path, not manual)
    // but seed it to guarantee the gate fires even with sk-test delay
    await setQual({ nameAsked: true });
    await sim('שרה');
    await sleep(600);

    const leadName = await getLead();
    test('confirmedName in lead qualData', leadName?.meta?.qualData?.confirmedName, 'שרה');

    const apts2    = await getApts();
    const aptAfter = apts2.find(a => a.id === apt.id);
    test('aptStore entry still exists after name capture', aptAfter != null, true);
    test('aptStore entry status still callback_pending', aptAfter?.status, 'callback_pending');
    test('aptStore leadName updated to confirmed name', aptAfter?.leadName, 'שרה');

    // ── 3. Dup acceptance must NOT create a second entry ──────────────────
    console.log('\n── 3. Dup acceptance → no second entry ──');

    await clearCD();
    await sim('כן, היום בשעה 15 יתאים לי');
    await sleep(500);

    const apts3    = await getApts();
    const pending3 = apts3.filter(a => a.leadPhone === LEAD && a.status === 'callback_pending');
    test('still exactly 1 callback_pending after dup', pending3.length, 1);

    // ── 4. handoffSentTo populated after name-capture manager alert ──
    // With the notification-consolidation fix (3a35b0c), the manager summary is
    // deferred until name is confirmed. So handoffSentTo is empty at apt creation
    // (time-only stage) and is populated after the name-capture manager alert fires.
    // The name was captured in step 2; by now the alert has completed.
    console.log('\n── 4. handoffSentTo populated after name-capture manager alert ──');

    const aptAfter3 = apts3.find(a => a.id === apt.id);
    // The mock returns a real idMessage so NOTIFY_PHONES phone is in handoffSentTo
    // after the name-capture manager alert fires and propagates to the apt entry.
    truthy('handoffSentTo is not empty after name-capture manager alert', (aptAfter3?.handoffSentTo ?? []).length > 0);
    truthy('handoffSentTo includes NOTIFY_PHONES phone',
      (aptAfter3?.handoffSentTo ?? []).includes('972509000001'));
  }

} catch (err) {
  console.error('[FATAL]', err.message, err.stack);
  fail++;
} finally {
  try { proc?.kill(); } catch {}
  try { mock?.close(); } catch {}
}

console.log('\n─────────────────────────────────────────────────────────');
console.log(`integration_callback_aptstore.test.mjs: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) process.exit(1);
