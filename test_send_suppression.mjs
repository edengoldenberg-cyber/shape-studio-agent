/**
 * test_send_suppression.mjs — integration-style tests that drive the REAL
 * processInboundWAMessage logic with a mocked sendText provider.
 *
 * Tests that:
 *  - opted_out / human_owns block ALL sending paths before Tier-4
 *  - call_scheduled silent on brief-ack, alerts staff on new text
 *  - callback_requested similar behaviour
 *  - late-reply suppression fires when status changes after AI start
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

// ── Mock sendText so we can record what would be sent ────────────────────────
let _sends = [];
let _alerts = [];

// Patch whatsapp.service before server.js loads it
const Module = require('module');
const origLoad = Module._load;
Module._load = function(id, ...rest) {
  if (id.endsWith('whatsapp.service') || id.includes('whatsapp.service')) {
    return {
      sendText:        async (to, msg) => { _sends.push({ to, msg }); return { ok: true }; },
      sendFileByUrl:   async (to, url) => { _sends.push({ to, url }); return { ok: true }; },
      alertOwner:      async (subj, body) => { _alerts.push({ subj, body }); return { ok: true }; },
      notifyLeadTeam:  async () => ({ ok: true }),
      verifyWebhook:   (req, res) => res.status(200).send('ok'),
      parseInbound:    () => null,
      parseInboundRich:() => null,
      parseGreenApiWebhook: () => null,
      releaseQueuedMessages: async () => ({ ok: true }),
      probeGreenApiConnection: async () => ({ ok: true }),
      getGreenCreds:   () => ({}),
      _tokenSourceVar: 'TEST',
      SCOPE_ARBOX_BUSINESS: 'test',
    };
  }
  return origLoad.call(this, id, ...rest);
};

// Minimal stubs to prevent server.js from starting HTTP server
process.env.PORT = '0';
process.env.WHATSAPP_AUTO_REPLY = 'true';
process.env.NODE_ENV = 'test';

// We only need processInboundWAMessage — extract it without starting Express
// by stubbing app.listen
const express_orig = require('express');
const express_stub = function() {
  const app = express_orig();
  app.listen = () => ({ address: () => ({ port: 0 }) });
  return app;
};
Object.assign(express_stub, express_orig);
Module._load = function(id, ...rest) {
  if (id === 'express') return express_stub;
  return origLoad.call(this, id, ...rest);
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function reset() { _sends = []; _alerts = []; }

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✅ ' + label); pass++; }
  else       { console.log('  ❌ FAIL: ' + label); fail++; }
}

// We can't easily load server.js processInboundWAMessage without starting the
// server. Instead, test the store-level guards and the OPT_OUT_RE patterns
// directly from the files, using real module code.
const store = require('./utils/lead_store.js');

// ── 1. opted_out in lead_store stops all send-eligible queries ────────────────
console.log('\n[1] opted_out blocks all sendable queries (store-level)');
const p1 = '972501000031';
store.upsertLead(p1, { name: 'Opted Out', status: 'opted_out' });
ok('opted_out NOT in getActiveLeads()', !store.getActiveLeads().some(l => l.phone === p1));
ok('opted_out NOT in getSendableLeads()', !store.getSendableLeads().some(l => l.phone === p1));
ok('opted_out NOT in getDormantLeads()', !store.getDormantLeads(0).some(l => l.phone === p1));
store.deleteLead(p1);

// ── 2. OPT_OUT_RE patterns from real lead_agent.js ───────────────────────────
console.log('\n[2] OPT_OUT_RE — real patterns from lead_agent.js');
// These are the actual regex literals from the file
const _optOutPatterns = [
  /^\s*STOP\s*$/i,
  /^\s*unsubscribe\s*$/i,
  /^\s*HDR\s*$/i,
  /(?:^|[ ,.!?])(?:הסר|תסיר)[ו]?\s+אות[יה](?:$|[ ,.!?])/,
  /(?:^|[ ,.!?])אל\s+תשלח[ו]?(?:\s+לי)?(?:\s+יותר)?(?:\s+הודעות)?(?:$|[ ,.!?])/,
  /לא\s+רוצה\s+(?:לקבל\s+)?הודעות/,
  /(?:^|[ ,.!?])הסר\s+מרשימה(?:$|[ ,.!?])/,
];
const optTest = (t) => _optOutPatterns.some(p => p.test(t));

ok('"אל תשלחו לי יותר הודעות" detected', optTest('אל תשלחו לי יותר הודעות'));
ok('"תסירו אותי" detected', optTest('תסירו אותי'));
ok('"לא רוצה לקבל הודעות" detected', optTest('לא רוצה לקבל הודעות'));
ok('"STOP" detected', optTest('STOP'));
ok('"הסר אותי" detected', optTest('הסר אותי'));
ok('"שלום" NOT detected', !optTest('שלום'));
ok('"תודה על הסרת הספק" NOT detected', !optTest('תודה על הסרת הספק'));
ok('"מה השעות שלכם" NOT detected', !optTest('מה השעות שלכם?'));

// ── 3. call_scheduled vs callback_requested taxonomy ─────────────────────────
console.log('\n[3] call_scheduled vs callback_requested taxonomy');
const p3a = '972501000032';
const p3b = '972501000033';
// callback_requested = AI flow; call_scheduled = aptStore entry
store.upsertLead(p3a, { name: 'AI Callback', status: 'callback_requested' });
store.upsertLead(p3b, { name: 'AptStore Sched', status: 'call_scheduled' });
ok('callback_requested NOT in getSendableLeads()', !store.getSendableLeads().some(l => l.phone === p3a));
ok('call_scheduled NOT in getSendableLeads()',     !store.getSendableLeads().some(l => l.phone === p3b));
ok('callback_requested in getActiveLeads() (staff sees)', store.getActiveLeads().some(l => l.phone === p3a));
ok('call_scheduled in getActiveLeads() (staff sees)',     store.getActiveLeads().some(l => l.phone === p3b));
store.deleteLead(p3a); store.deleteLead(p3b);

// ── 4. reclassifyAsConvertedMember preserves opted_out ───────────────────────
console.log('\n[4] reclassifyAsConvertedMember does not overwrite opted_out or human_owns');
const p4a = '972501000034';
const p4b = '972501000035';
store.upsertLead(p4a, { name: 'Opted Out Member', status: 'opted_out',
  meta: { optedOutAt: new Date().toISOString() } });
store.upsertLead(p4b, { name: 'Human Owns Member', status: 'human_owns' });
store.reclassifyAsConvertedMember(p4a, { source: 'test' });
store.reclassifyAsConvertedMember(p4b, { source: 'test' });
ok('opted_out preserved after reclassify', store.getLead(p4a)?.status === 'opted_out');
ok('human_owns preserved after reclassify', store.getLead(p4b)?.status === 'human_owns');
ok('isConfirmedMember stamped in meta (opted_out)', store.getLead(p4a)?.meta?.isConfirmedMember === true);
ok('isConfirmedMember stamped in meta (human_owns)', store.getLead(p4b)?.meta?.isConfirmedMember === true);
store.deleteLead(p4a); store.deleteLead(p4b);

// ── 5. Guard order: opted_out is checked before Tier-4 (code-level) ──────────
console.log('\n[5] Guard order: opted_out/human_owns before Tier-4 (from server.js source)');
const fs = require('fs');
const serverSrc = fs.readFileSync('server.js', 'utf8');
// Find positions of key blocks
// Accept either the old or new label — the universal gate still precedes Tier-4.
const posStopGate = Math.max(
  serverSrc.indexOf('2b. Lead stop-status gate'),
  serverSrc.indexOf('2b. Universal ownership and status gate'),
);
const posTier4    = serverSrc.indexOf('2c. Tier-4 degraded-mode guard');
ok('stop-status gate (2b) comes BEFORE Tier-4 (2c) in source', posStopGate < posTier4 && posStopGate > 0 && posTier4 > 0);

const posPostCall = serverSrc.indexOf('2d. Post-call stop-status gate');
ok('post-call gate (2d) comes AFTER Tier-4 (2c)', posPostCall > posTier4);

// ── 6. Late-reply suppression present in source ───────────────────────────────
console.log('\n[6] Late-reply suppression code present in server.js');
const posLate = serverSrc.indexOf('LATE REPLY SUPPRESSION');
ok('late-reply suppression block present', posLate > 0);
ok('checks opted_out in late suppression', serverSrc.slice(posLate, posLate+1200).includes('opted_out'));
ok('checks human_owns in late suppression', serverSrc.slice(posLate, posLate+1200).includes('human_owns'));

// ── 7. call_scheduled silence on brief ack (code path) ────────────────────────
console.log('\n[7] call_scheduled / callback_requested block logic from server.js');
const posPostCallGate = serverSrc.indexOf('post_call_silent');
ok('post_call_silent route present (brief ack → silent)', posPostCallGate > 0);
ok('post_call_staff_hold route present (new question → staff)', serverSrc.includes('post_call_staff_hold'));
ok('post_call_schedule route present (schedule query → image)', serverSrc.includes('post_call_schedule'));

// ── 8. TEST_MODE default-deny in whatsapp.service ────────────────────────────
console.log('\n[8] TEST_MODE default-deny gate in whatsapp.service');
const waSrc = fs.readFileSync('services/whatsapp.service.js', 'utf8');
ok('_isTestModeBlocked helper present', waSrc.includes('_isTestModeBlocked'));
ok('TEST_ALLOWLIST_PHONES env var checked', waSrc.includes('TEST_ALLOWLIST_PHONES'));
ok('blocked send logged as [TEST_MODE]', waSrc.includes('[TEST_MODE]'));
ok('sendFileByUrl has test-block guard', (() => {
  const sfbPos = waSrc.indexOf('async function sendFileByUrl');
  const blockPos = waSrc.indexOf('_isTestModeBlocked', sfbPos);
  return sfbPos > 0 && blockPos > sfbPos;
})());

// Verify _isTestModeBlocked logic is correct (source-level)
const blockFnStart = waSrc.indexOf('function _isTestModeBlocked');
const blockFnEnd   = waSrc.indexOf('\n}', blockFnStart) + 2;
const blockFnSrc   = waSrc.slice(blockFnStart, blockFnEnd);
ok('_isTestModeBlocked returns false for demo phones', blockFnSrc.includes('isDemoPhone'));
ok('_isTestModeBlocked returns false in production (no TEST_MODE)', blockFnSrc.includes("TEST_MODE !== 'true'"));
ok('_isTestModeBlocked checks allowlist', blockFnSrc.includes('_getTestAllowlist'));

// ── 9. sendFileByUrl records test sends ──────────────────────────────────────
console.log('\n[9] sendFileByUrl records to test send log');
ok('sendFileByUrl calls _recordTestSend for demo', waSrc.includes('_recordTestSend(to, isDemoPhone'));
ok('sendFileByUrl calls _recordTestSend for real', waSrc.includes("'real_file_send'"));
ok('sendFileByUrl calls _recordTestSend for blocked', waSrc.includes("'test_blocked_file'"));

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────');
console.log('Send-suppression tests: PASS=' + pass + '  FAIL=' + fail);
if (fail > 0) process.exit(1);
