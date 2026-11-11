/**
 * panel_check_local.js — isolated local server for Tomer-panel browser check.
 *
 * What it does:
 *   - Starts the server on port 3099 with a temp DATA_DIR (no production data touched)
 *   - Mocks Green API and Arbox so no real sends or external calls happen
 *   - Seeds one Arbox member + one lead in attribution_review
 *   - Prints the URL to open and the checklist
 *
 * Run:  node tests/panel_check_local.js
 * Stop: Ctrl+C
 */

'use strict';

const http   = require('http');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');

// ── Isolated environment ──────────────────────────────────────────────────
const DATA_DIR = path.join(os.tmpdir(), `panel-check-${process.pid}`);
fs.mkdirSync(DATA_DIR, { recursive: true });

const MOCK_PORT = 20081;
const APP_PORT  = 3099;

// Test member: realistic format but clearly synthetic (prefix 97200 = demo range)
const TEST_PHONE   = '972001234567';
const TEST_ARBOX_ID = 99901;
const TEST_MEMBER  = {
  user_id:               TEST_ARBOX_ID,
  first_name:            'בדיקה',
  last_name:             'ייחוס',
  phone:                 TEST_PHONE,
  user_role:             'client',   // required for classifyMemberships to include this member
  active:                1,          // Arbox API uses 0/1 integers
  membership_start_date: '2026-01-01',
  membership_end_date:   '2027-06-01', // far future → classified as 'active', not expiringSoon
  allow_sms:             true,
  allow_email:           true,
};

// ── Mock Green API + Arbox server ─────────────────────────────────────────
// All sends are silently dropped. Arbox returns exactly one member.
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url.includes('sendMessage')) {
      // Drop all sends — no real WhatsApp traffic
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ idMessage: `mock-${Date.now()}` }));
      return;
    }
    if (req.url.includes('getStateInstance')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateInstance: 'authorized' }));
      return;
    }
    if (req.url.includes('/v3/users')) {
      // Always return the single test member
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [TEST_MEMBER] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
});

mockServer.listen(MOCK_PORT, () => {
  console.log(`[setup] Mock server listening on :${MOCK_PORT}`);
});

// ── Env (must be set before server.js is require()d) ─────────────────────
process.env.DATA_DIR                 = DATA_DIR;
process.env.PORT                     = String(APP_PORT);
process.env.TEST_MODE                = 'true';
process.env.WHATSAPP_AUTO_REPLY      = 'false';  // no bot replies during check
process.env.GREEN_API_URL            = `localhost:${MOCK_PORT}`;
process.env.GREEN_API_ID_INSTANCE    = '9999999';
process.env.GREEN_API_TOKEN_INSTANCE = 'mock-token';
process.env.ARBOX_BASE_URL           = `http://localhost:${MOCK_PORT}/arbox`;
process.env.ARBOX_API_KEY            = 'mock-arbox-key';   // mock ignores auth
process.env.ARBOX_LOCATION_ID        = '1';
process.env.TEST_ALLOWLIST_PHONES    = TEST_PHONE;

// Suppress AI and all crons from actually firing
delete process.env.OPENAI_API_KEY;

// ── Boot server ───────────────────────────────────────────────────────────
const store = require('../utils/lead_store');

require('../server.js');
// NOTE: do NOT seed the lead before server starts.
// The startup purge (runs during app.listen) converts any Arbox-member lead
// to converted_member. The seed happens AFTER startup in the setTimeout below.

// ── Seed attribution_review AFTER startup purge ───────────────────────────
// The startup purge (running during app.listen) converts member leads to
// converted_member. We re-seed after the purge completes.
setTimeout(() => {
  store.upsertLead(TEST_PHONE, {
    name:         'בדיקה ייחוס',
    status:       'attribution_review',
    score:        6,
    messageCount: 3,
    meta: {
      attributionReviewSince:      new Date().toISOString(),
      attributionReviewIdMessage:  'test-echo-id-99901',
      attributionReviewReason:     'grace_expired_unresolved',
      attributionReviewPrevStatus: 'warm',
    },
  });
  console.log('[setup] attribution_review lead seeded for', TEST_PHONE);
}, 2000);

// ── Print checklist once server is up ────────────────────────────────────
setTimeout(() => {
  console.log('\n' + '═'.repeat(60));
  console.log('  TOMER PANEL LOCAL CHECK');
  console.log('═'.repeat(60));
  console.log(`\n  URL: http://localhost:${APP_PORT}`);
  console.log('       → Click tab "💌 תומר"');
  console.log('       → Click sub-tab "חברים" (Members)\n');
  console.log('  Test member: בדיקה ייחוס  |  arboxId:', TEST_ARBOX_ID);
  console.log('  Lead status: attribution_review (seeded directly)\n');
  console.log('─'.repeat(60));
  console.log('  CHECKLIST\n');
  console.log('  □ 1. Members tab shows row for "בדיקה ייחוס"');
  console.log('        Owner column: ⚠️ badge labelled "בחינה"');
  console.log('  □ 2. Click the row → drawer opens');
  console.log('        Profile shows: name, Arbox status badge, last contact');
  console.log('  □ 3. Drawer "Today\'s Work" (היום tab):');
  console.log('        Shows open tasks count (0) and upcoming messages (0)');
  console.log('  □ 4. Drawer "Upcoming Messages" (הודעות קרובות):');
  console.log('        Shows empty state or scheduled messages');
  console.log('  □ 5. attribution_review resolution:');
  console.log('        In the Members row: "אשר ידני" button is visible');
  console.log('        Click it → confirm dialog → takeover API fires');
  console.log('        Row badge changes from ⚠️ to 👤 (human/manual)');
  console.log('        Verify via: GET /api/leads/' + TEST_PHONE);
  console.log('        Expect: { "status": "human_owns" }');
  console.log('\n  API cross-checks (run in another terminal):');
  console.log(`    curl http://localhost:${APP_PORT}/api/tomer/members-enriched | python -c "import sys,json; d=json.load(sys.stdin); print([m for m in d['members'] if m.get('arboxId')==${TEST_ARBOX_ID}])"`);
  console.log(`    curl http://localhost:${APP_PORT}/api/tomer/member/id/${TEST_ARBOX_ID}`);
  console.log(`    curl http://localhost:${APP_PORT}/api/tomer/today`);
  console.log('\n─'.repeat(60));
  console.log('  Stop: Ctrl+C');
  console.log('═'.repeat(60) + '\n');
}, 2500);
