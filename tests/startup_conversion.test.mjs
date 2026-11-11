/**
 * startup_conversion.test.mjs
 *
 * Verifies that membership identity refresh (reclassifyAsConvertedMember, called at
 * startup and on reactive API reads) does not overwrite protected lead statuses.
 *
 * Tests:
 *   1. Unit: reclassifyAsConvertedMember protects human_owns / opted_out / attribution_review.
 *   2. Persist/reload: each protected status survives a data round-trip and the
 *      startup purge pass (_purgeKnownMembersFromLeadStore called with mock Arbox).
 *   3. Pipeline suppression: after reload+purge, automated replies are suppressed
 *      for each protected status (simulate endpoint returns hold routes).
 *
 * Run: node tests/startup_conversion.test.mjs
 */

import http   from 'http';
import os     from 'os';
import path   from 'path';
import fs     from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ── Isolated environment ──────────────────────────────────────────────────────
const DATA_DIR  = path.join(os.tmpdir(), `startup-conv-${process.pid}`);
const MOCK_PORT = 20095;
const APP_PORT  = 20096;
fs.mkdirSync(DATA_DIR, { recursive: true });

// Three test phones — one per protected status.
// All three will be returned as Arbox members by the mock, triggering startup purge.
const PHONE_HO = '972509961001';  // human_owns
const PHONE_OO = '972509961002';  // opted_out
const PHONE_AR = '972509961003';  // attribution_review
const ALL_PHONES = [PHONE_HO, PHONE_OO, PHONE_AR];

function arboxMember(phone, id) {
  return { user_id: id, first_name: 'Test', last_name: 'Member' + id,
           phone, user_role: 'client', active: 1,
           membership_start_date: '2026-01-01', membership_end_date: '2027-06-01' };
}

// ── Mock Green API + Arbox ────────────────────────────────────────────────────
const mockServer = http.createServer((req, res) => {
  if (req.url.includes('/v3/users')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: ALL_PHONES.map((p, i) => arboxMember(p, 20001 + i)) }));
    return;
  }
  if (req.url.includes('getStateInstance')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stateInstance: 'authorized' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [] }));
});
await new Promise(r => mockServer.listen(MOCK_PORT, r));

// ── Env setup ─────────────────────────────────────────────────────────────────
process.env.DATA_DIR                 = DATA_DIR;
process.env.PORT                     = String(APP_PORT);
process.env.TEST_MODE                = 'true';
process.env.WHATSAPP_AUTO_REPLY      = 'true';
process.env.GREEN_API_URL            = `localhost:${MOCK_PORT}`;
process.env.GREEN_API_ID_INSTANCE    = '9999999997';
process.env.GREEN_API_TOKEN_INSTANCE = 'mock-token-sc';
process.env.ARBOX_BASE_URL           = `http://localhost:${MOCK_PORT}/arbox`;
process.env.ARBOX_API_KEY            = 'mock-key';
process.env.ARBOX_LOCATION_ID        = '1';
process.env.BURST_WINDOW_MS          = '100';
process.env.TEST_ALLOWLIST_PHONES    = ALL_PHONES.join(',');
process.env.TEST_AI_DELAY_MS         = '0';     // skip AI delay in this test
delete process.env.OPENAI_API_KEY;

// ── Helpers ───────────────────────────────────────────────────────────────────
const passed = [], failed = [];
function assert(ok, label, detail = '') {
  if (ok) { passed.push(label); console.log(`  ✓ ${label}`); }
  else     { failed.push(label); console.error(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 120) : ''}`); }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function simPost(phone, text) {
  return new Promise(resolve => {
    const body = JSON.stringify({ from: phone, text });
    const req  = http.request(`http://localhost:${APP_PORT}/api/whatsapp/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ err: d }); } });
    });
    req.on('error', e => resolve({ err: e.message }));
    req.write(body); req.end();
  });
}

// ── Suite 1: Unit — reclassifyAsConvertedMember ───────────────────────────────
console.log('\n── Suite 1: reclassifyAsConvertedMember protects stop-statuses ──');
{
  // Load store before server.js (same singleton, no server needed here)
  const store = require('../utils/lead_store');
  const UNIT_PHONES = {
    human_owns:         '972509962001',
    opted_out:          '972509962002',
    attribution_review: '972509962003',
    warm:               '972509962004',
  };

  for (const [status, phone] of Object.entries(UNIT_PHONES)) {
    store.upsertLead(phone, { name: 'Unit Test', status, messageCount: 1 });
  }

  for (const phone of Object.values(UNIT_PHONES)) {
    store.reclassifyAsConvertedMember(phone, { name: 'Member', source: 'test' });
  }

  assert(store.getLead(UNIT_PHONES.human_owns)?.status         === 'human_owns',
         '1a: human_owns preserved by reclassifyAsConvertedMember');
  assert(store.getLead(UNIT_PHONES.opted_out)?.status          === 'opted_out',
         '1b: opted_out preserved by reclassifyAsConvertedMember');
  assert(store.getLead(UNIT_PHONES.attribution_review)?.status === 'attribution_review',
         '1c: attribution_review preserved by reclassifyAsConvertedMember');
  assert(store.getLead(UNIT_PHONES.warm)?.status               === 'converted_member',
         '1d: non-protected (warm) → converted_member as expected');

  // Verify meta is stamped even for protected statuses
  assert(store.getLead(UNIT_PHONES.human_owns)?.meta?.isConfirmedMember === true,
         '1e: human_owns meta.isConfirmedMember stamped (membership fact recorded)');
  assert(store.getLead(UNIT_PHONES.attribution_review)?.meta?.isConfirmedMember === true,
         '1f: attribution_review meta.isConfirmedMember stamped');

  // Clean up unit-test phones so they don't interfere with later suites
  for (const phone of Object.values(UNIT_PHONES)) store.deleteLead(phone);
}

// ── Suite 2: Persist / reload / startup-purge cycle ──────────────────────────
console.log('\n── Suite 2: Persist → reload → startup purge — statuses survive ──');
{
  const store   = require('../utils/lead_store');
  const persist = require('../utils/persist');

  // Seed the three protected-status leads into an otherwise empty store
  store.upsertLead(PHONE_HO, { name: 'HO Test',  status: 'human_owns',         messageCount: 2 });
  store.upsertLead(PHONE_OO, { name: 'OO Test',  status: 'opted_out',           messageCount: 2 });
  store.upsertLead(PHONE_AR, { name: 'AR Test',  status: 'attribution_review',  messageCount: 2,
    meta: { attributionReviewIdMessage: 'test-echo', attributionReviewReason: 'grace_expired_unresolved' } });

  // Persist to the isolated DATA_DIR
  persist.saveLeads(store);

  // Simulate data layer restart: clear in-memory, reload from disk
  store.clear();
  persist.loadLeads(store);

  assert(store.getLead(PHONE_HO)?.status === 'human_owns',
         '2a: human_owns survives persist/reload');
  assert(store.getLead(PHONE_OO)?.status === 'opted_out',
         '2b: opted_out survives persist/reload');
  assert(store.getLead(PHONE_AR)?.status === 'attribution_review',
         '2c: attribution_review survives persist/reload');

  // Simulate startup purge: reclassify all three as "confirmed members"
  for (const phone of ALL_PHONES) {
    store.reclassifyAsConvertedMember(phone, { name: 'Arbox Member', source: 'startup' });
  }

  assert(store.getLead(PHONE_HO)?.status === 'human_owns',
         '2d: human_owns survives startup reclassification after reload');
  assert(store.getLead(PHONE_OO)?.status === 'opted_out',
         '2e: opted_out survives startup reclassification after reload');
  assert(store.getLead(PHONE_AR)?.status === 'attribution_review',
         '2f: attribution_review survives startup reclassification after reload');
}

// ── Boot server for pipeline suppression tests ────────────────────────────────
// The server will load the persisted leads, build the phone registry from the mock
// Arbox (all three phones → members), and run the startup purge.
// Protected statuses must remain after this real startup sequence.
console.log('\n── Starting server on port', APP_PORT, '(real startup purge will run) ──');
await import('../server.js');
await wait(2500); // allow startup purge + phone registry warm-up to complete

const store = require('../utils/lead_store');

// ── Suite 3: Statuses intact after real server startup purge ──────────────────
console.log('\n── Suite 3: Statuses intact after real server startup purge ──');
{
  const ho = store.getLead(PHONE_HO)?.status;
  const oo = store.getLead(PHONE_OO)?.status;
  const ar = store.getLead(PHONE_AR)?.status;

  assert(ho === 'human_owns',
         '3a: human_owns intact after server startup purge',         ho ?? '(no lead)');
  assert(oo === 'opted_out',
         '3b: opted_out intact after server startup purge',          oo ?? '(no lead)');
  assert(ar === 'attribution_review',
         '3c: attribution_review intact after server startup purge', ar ?? '(no lead)');
}

// ── Suite 4: Pipeline suppression — each protected status blocks automated reply ──
console.log('\n── Suite 4: Pipeline suppression after restart ──');
{
  const rHO = await simPost(PHONE_HO, 'שלום, מחפשת פילאטיס');
  assert(rHO.route === 'human_owns_hold',
         '4a: human_owns blocks automated reply after restart', rHO.route);

  const rOO = await simPost(PHONE_OO, 'שלום');
  assert(rOO.route === 'opted_out_silent',
         '4b: opted_out blocks automated reply after restart', rOO.route);

  const rAR = await simPost(PHONE_AR, 'שלום');
  assert(rAR.route === 'echo_attribution_hold',
         '4c: attribution_review blocks automated reply after restart', rAR.route);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────────────────────────────');
console.log(`startup_conversion.test.mjs: PASS=${passed.length}  FAIL=${failed.length}`);
if (failed.length > 0) {
  failed.forEach(f => console.error('  ✗', f));
  mockServer.close();
  process.exit(1);
}
mockServer.close();
process.exit(0);
