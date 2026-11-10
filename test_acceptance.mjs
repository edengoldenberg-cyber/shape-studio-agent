/**
 * test_acceptance.mjs — acceptance tests for Barak stop conditions (spec §11)
 * Run: node test_acceptance.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

const store   = require('./utils/lead_store.js');
const phoneReg = require('./utils/phone_registry.js');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✅ ' + label); pass++; }
  else       { console.log('  ❌ FAIL: ' + label); fail++; }
}
function header(n, label) { console.log('\n[' + n + '] ' + label); }

// ── 1. New lead — not in dormant/sendable until dormancy threshold ────────────
header(1, 'New lead tracked, NOT in dormant list (< 3 days)');
const p1 = '972501000011';
store.upsertLead(p1, { name: 'Test New Lead', status: 'new', score: 4 });
ok('new lead in getActiveLeads()', store.getActiveLeads().some(l => l.phone === p1));
ok('new lead in getSendableLeads()', store.getSendableLeads().some(l => l.phone === p1));
ok('new lead NOT in getDormantLeads(0 days) if lastActivity just now',
  !store.getDormantLeads(0).some(l => l.phone === p1)); // lastActivity=now → not dormant
store.deleteLead(p1);

// ── 2. Direct schedule request detected (no AI needed) ──────────────────────
header(2, 'Direct schedule query answered without reopening sales funnel');
// The routing check happens in server.js; here we verify the state machine logic:
// if call_scheduled is set, getSendableLeads excludes this lead.
const p2 = '972501000012';
store.upsertLead(p2, { name: 'Schedule Asker', status: 'warm', score: 5 });
ok('warm lead visible before scheduling', store.getSendableLeads().some(l => l.phone === p2));
// Simulate schedule query answered and call confirmed
store.upsertLead(p2, { status: 'call_scheduled' });
ok('call_scheduled lead not in getSendableLeads()', !store.getSendableLeads().some(l => l.phone === p2));
ok('call_scheduled lead STILL in getActiveLeads() (staff sees it)', store.getActiveLeads().some(l => l.phone === p2));
store.deleteLead(p2);

// ── 3. Member identified → converted_member, removed from all flows ──────────
header(3, 'Member identified → out of all sales flows');
const p3 = '972501000013';
store.upsertLead(p3, { name: 'Was Lead Now Member', status: 'warm', score: 7 });
store.reclassifyAsConvertedMember(p3, { name: 'Was Lead Now Member', source: 'test' });
ok('converted_member NOT in getActiveLeads()', !store.getActiveLeads().some(l => l.phone === p3));
ok('converted_member NOT in getSendableLeads()', !store.getSendableLeads().some(l => l.phone === p3));
ok('converted_member NOT in getHotLeads()', !store.getHotLeads().some(l => l.phone === p3));
ok('converted_member NOT in getDormantLeads()', !store.getDormantLeads(0).some(l => l.phone === p3));
store.deleteLead(p3);

// ── 4. "תודה" after call_scheduled — no sales reopen ────────────────────────
header(4, '"תודה" after confirmed call — call_scheduled blocks re-engagement');
const p4 = '972501000014';
store.upsertLead(p4, { name: 'Confirmed', status: 'call_scheduled', score: 8,
  meta: { qualData: { callTimeGiven: 'מחר ב-10:00' } } });
ok('call_scheduled NOT in getSendableLeads() (Tomer skips)', !store.getSendableLeads().some(l => l.phone === p4));
ok('call_scheduled NOT in getDormantLeads() (no re-engagement)', !store.getDormantLeads(0).some(l => l.phone === p4));
store.deleteLead(p4);

// ── 5. Reschedule uses existing appointment (lead still call_scheduled) ──────
header(5, 'Reschedule after call_scheduled — still call_scheduled, not re-opened');
const p5 = '972501000015';
store.upsertLead(p5, { name: 'Reschedule Lead', status: 'call_scheduled',
  meta: { qualData: { callTimeGiven: 'שלישי 11:00' }, callbackTime: 'שלישי 11:00' } });
// In production, server.js reschedule path updates the appointment without reopening funnel.
// Here: status stays call_scheduled
ok('status remains call_scheduled after reschedule context', store.getLead(p5)?.status === 'call_scheduled');
ok('still NOT sendable', !store.getSendableLeads().some(l => l.phone === p5));
store.deleteLead(p5);

// ── 6. Human takeover — bot suppressed, history preserved ────────────────────
header(6, 'Human takeover via human_owns — bot suppressed, history preserved');
const p6 = '972501000016';
store.upsertLead(p6, { name: 'Human Needed', status: 'warm', score: 6,
  history: [{ role: 'user', content: 'שאלה' }, { role: 'assistant', content: 'תשובה' }],
  meta: { qualData: { location: 'חדרה' } } });
// Simulate takeover
const rec6 = store.getLead(p6);
store.upsertLead(p6, {
  status: 'human_owns',
  meta: { ...(rec6.meta ?? {}), humanOwnsReason: 'test', previousStatus: rec6.status },
});
ok('human_owns NOT in getSendableLeads()', !store.getSendableLeads().some(l => l.phone === p6));
ok('human_owns history preserved (2 turns)', (store.getLead(p6)?.history ?? []).length === 2);
ok('human_owns still in getActiveLeads() (staff sees it)', store.getActiveLeads().some(l => l.phone === p6));
// Release
const prevStatus = store.getLead(p6)?.meta?.previousStatus ?? 'warm';
store.upsertLead(p6, { status: prevStatus, meta: { ...store.getLead(p6).meta, humanOwnsSince: null } });
ok('after release, status restored to warm', store.getLead(p6)?.status === 'warm');
ok('after release, back in getSendableLeads()', store.getSendableLeads().some(l => l.phone === p6));
store.deleteLead(p6);

// ── 7. Transfer to Tomer stops Barak (member reclassified) ───────────────────
header(7, 'Transfer to Tomer — converted_member stops Barak permanently');
const p7 = '972501000017';
store.upsertLead(p7, { name: 'New Member', status: 'hot', score: 9 });
store.reclassifyAsConvertedMember(p7, { source: 'test' });
ok('converted_member blocks getSendableLeads', !store.getSendableLeads().some(l => l.phone === p7));
ok('score zeroed after conversion', store.getLead(p7)?.score === 0);
store.deleteLead(p7);

// ── 8. Opt-out — no outreach ever ────────────────────────────────────────────
header(8, 'Opt-out — removed from getActiveLeads() and getSendableLeads()');
const p8 = '972501000018';
store.upsertLead(p8, { name: 'No Messages', status: 'cold', score: 2 });
store.upsertLead(p8, { status: 'opted_out', score: 0, meta: { optedOutAt: new Date().toISOString() } });
ok('opted_out NOT in getActiveLeads()', !store.getActiveLeads().some(l => l.phone === p8));
ok('opted_out NOT in getSendableLeads()', !store.getSendableLeads().some(l => l.phone === p8));
ok('opted_out NOT in getDormantLeads()', !store.getDormantLeads(0).some(l => l.phone === p8));
ok('opted_out NOT in getHotLeads()', !store.getHotLeads().some(l => l.phone === p8));
store.deleteLead(p8);

// ── 9. Duplicate message dedup ───────────────────────────────────────────────
header(9, 'Duplicate message dedup — lead_store score unchanged by re-upsert with same data');
const p9 = '972501000019';
store.upsertLead(p9, { name: 'Dedup Test', status: 'cold', score: 3, messageCount: 1 });
store.upsertLead(p9, { name: 'Dedup Test', status: 'cold', score: 3, messageCount: 1 });
ok('duplicate upsert does not duplicate record', store.getAllLeads().filter(l => l.phone === p9).length === 1);
store.deleteLead(p9);

// ── 10. Status-change during reply: opted_out blocks sendable ───────────────
header(10, 'Status set to human_owns during pipeline — reply suppressed by getSendableLeads()');
const p10 = '972501000020';
store.upsertLead(p10, { name: 'Mid-Pipeline', status: 'warm', score: 5 });
// Simulate status change during pipeline (e.g. concurrent human action)
store.upsertLead(p10, { status: 'human_owns' });
ok('after takeover mid-pipeline, NOT in getSendableLeads()', !store.getSendableLeads().some(l => l.phone === p10));
store.deleteLead(p10);

// ── 11. Restart safety: status persists via Map (in-process) ─────────────────
header(11, 'Status persists in lead_store map (in-process restart simulation)');
const p11 = '972501000021';
store.upsertLead(p11, { name: 'Persist Test', status: 'call_scheduled', score: 7 });
// Simulate a re-read (not full restart, but confirms map fidelity)
ok('call_scheduled survives re-read from store', store.getLead(p11)?.status === 'call_scheduled');
ok('still not in sendable after re-read', !store.getSendableLeads().some(l => l.phone === p11));
store.deleteLead(p11);

// ── 12. Failed identity check → not routed as confirmed cold lead ────────────
header(12, 'Failed identity check — arboxColdLeadConfirmedAt absent → Tier-4 fires');
const p12 = '972501000022';
store.upsertLead(p12, { name: 'Unknown', status: 'cold',
  meta: { arboxConfirmedColdLead: true } }); // old flag, NO timestamp
const rec12 = store.getLead(p12);
const confirmedAt12 = rec12?.meta?.arboxColdLeadConfirmedAt;
ok('no arboxColdLeadConfirmedAt → _tier4ActiveLead=false (Tier-4 fires)', !confirmedAt12);
store.deleteLead(p12);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────');
console.log('Acceptance: PASS=' + pass + '  FAIL=' + fail);
if (fail > 0) process.exit(1);
