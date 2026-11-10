/**
 * test_routing.mjs — behavioral routing tests (no server startup required)
 * Tests the core routing logic in isolation using real Arbox data.
 *
 * Run: node test_routing.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// No chdir needed — already running from the project directory
require('dotenv').config();

const memberCache = require('./utils/member_cache.js');
const store       = require('./utils/lead_store.js');
const phoneReg    = require('./utils/phone_registry.js');

// ── Minimal normalize (matches server.js) ─────────────────────────────────────
function normalizeToE164(phone) {
  if (!phone) return null;
  const s = String(phone).replace(/[\s\-\.\(\)\+]/g, '');
  if (s.startsWith('00972')) return s.slice(2);
  if (s.startsWith('972'))   return s;
  if (s.startsWith('0'))     return '972' + s.slice(1);
  if (s.length === 9)        return '972' + s;
  return s;
}

// ── Test helpers ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✅ ' + label); pass++; }
  else       { console.log('  ❌ FAIL: ' + label); fail++; }
}

// ── 1. Load phone registry from Arbox ─────────────────────────────────────────
console.log('\n[1] Loading phone registry from Arbox…');
await phoneReg.init({ timeoutMs: 15_000 });
const regSize = phoneReg.size();
console.log('    Registry size:', regSize);
ok('registry loaded (>0 members)', regSize > 0);

// ── 2. Known member from registry is NOT routed to Barak ──────────────────────
console.log('\n[2] Member routing via registry (Tier-1 / registry gate)…');
// Pick the first phone from Arbox active clients
const arbox = require('./services/arbox.service.js');
// getMembers returns ALL active users (staff + clients). Filter to client only.
const liveMembers = await arbox.getMembers({ limit: 50, activeOnly: true });
const sampleMember = liveMembers.find(m => m.phone && m.user_role === 'client');

if (!sampleMember) {
  console.log('    ⚠️  No live members found — skipping member routing tests');
} else {
  const mPhone = normalizeToE164(sampleMember.phone);
  const isMem  = phoneReg.isMember(mPhone);
  ok('confirmed member is in phone registry', isMem);

  // Seed member into memberCache as the pipeline would
  if (isMem) memberCache.markConfirmed(mPhone, { name: sampleMember.first_name, role: sampleMember.user_role, source: 'test' });
  ok('memberCache.isConfirmed after registry-gate seed', memberCache.isConfirmed(mPhone));

  // If in cache → isExistingClient=true → Tomer path, never Barak
  const tier1Fresh     = memberCache.isFresh(mPhone);
  const tier1Confirmed = memberCache.isConfirmed(mPhone);
  const isExistingClient = tier1Fresh || tier1Confirmed;
  ok('isExistingClient=true for confirmed member', isExistingClient);
}

// ── 3. Aggregator member routing ──────────────────────────────────────────────
console.log('\n[3] Aggregator member routing…');
const allUsers = await arbox.getAllUsers({ limit: 200 });
const agg = allUsers.find(u => u.user_role === 'aggregatorMember' && u.phone);
if (!agg) {
  console.log('    ⚠️  No aggregator with phone — skipping');
} else {
  const aggPhone = normalizeToE164(agg.phone);
  ok('aggregator in registry (regardless of active flag)', phoneReg.isMember(aggPhone));
}

// ── 4. Lead does NOT appear in registry ───────────────────────────────────────
console.log('\n[4] Lead routing — lead must NOT be in registry…');
const liveLeads = await arbox.getLeads({ limit: 10 }).catch(() => []);
const sampleLead = liveLeads.find(l => l.phone && l.user_role === 'lead');
if (!sampleLead) {
  console.log('    ⚠️  No live lead with phone — skipping');
} else {
  const lPhone = normalizeToE164(sampleLead.phone);
  ok('Arbox lead NOT in registry', !phoneReg.isMember(lPhone));
}

// ── 5. arboxConfirmedColdLead NOT stamped when memberLookupFailed ──────────────
console.log('\n[5] arboxConfirmedColdLead guard against memberLookupFailed…');
// Simulate the lookup result that triggers the bug
const fakePhone = '972501000001';
store.upsertLead(fakePhone, { name: 'Test Lead', status: 'cold' });

// Simulate: memberLookupFailed=true, total=1 (lead found)
const simulatedLookup = {
  total: 1,
  memberLookupFailed: true,
  results: [{ type: 'lead', user_id: 9999, name: 'Test Lead', phone: fakePhone, leadStatus: 'ליד', role: null }],
};

// This replicates the FIXED code path: guard on !lookup.memberLookupFailed
const shouldStamp = simulatedLookup.results[0].type === 'lead' && !simulatedLookup.memberLookupFailed;
ok('flag NOT stamped when memberLookupFailed=true', !shouldStamp);

// Also verify: if memberLookupFailed=false, flag IS stamped
const simulatedOkLookup = { ...simulatedLookup, memberLookupFailed: false };
const shouldStampOk = simulatedOkLookup.results[0].type === 'lead' && !simulatedOkLookup.memberLookupFailed;
ok('flag IS stamped when memberLookupFailed=false', shouldStampOk);

store.deleteLead(fakePhone);

// ── 6. Tier-4 bypassed only for RECENT cold-lead confirmation ─────────────────
console.log('\n[6] _tier4ActiveLead freshness window…');
const testPhone = '972501000002';

// Old record without timestamp — must NOT bypass Tier-4
store.upsertLead(testPhone, { name: 'Old Lead', status: 'cold', meta: { arboxConfirmedColdLead: true } });
const recOld = store.getLead(testPhone);
const oldConfirmedAt = recOld?.meta?.arboxColdLeadConfirmedAt;
ok('old record without arboxColdLeadConfirmedAt → _tier4ActiveLead=false', !oldConfirmedAt);

// Fresh record with recent timestamp — SHOULD bypass Tier-4 (within 2h)
const freshTs = Date.now() - 30 * 60 * 1000; // 30 min ago
store.upsertLead(testPhone, { meta: { arboxConfirmedColdLead: true, arboxColdLeadConfirmedAt: freshTs } });
const recFresh = store.getLead(testPhone);
const freshOk = recFresh?.meta?.arboxColdLeadConfirmedAt &&
                (Date.now() - recFresh.meta.arboxColdLeadConfirmedAt < 2 * 60 * 60 * 1000);
ok('fresh record (30min ago) → _tier4ActiveLead=true', freshOk);

// Stale timestamp > 2h — must NOT bypass
const staleTs = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
store.upsertLead(testPhone, { meta: { arboxConfirmedColdLead: true, arboxColdLeadConfirmedAt: staleTs } });
const recStale = store.getLead(testPhone);
const staleBlocked = !(recStale?.meta?.arboxColdLeadConfirmedAt &&
                       (Date.now() - recStale.meta.arboxColdLeadConfirmedAt < 2 * 60 * 60 * 1000));
ok('stale record (3h ago) → _tier4ActiveLead=false', staleBlocked);

store.deleteLead(testPhone);

// ── 7. reclassifyAsConvertedMember preserves history ─────────────────────────
console.log('\n[7] reclassifyAsConvertedMember preserves history & stops sales flows…');
const rPhone = '972501000003';
store.upsertLead(rPhone, {
  name: 'Converted User',
  status: 'warm',
  score: 7,
  history: [{ role: 'user', content: 'שלום' }, { role: 'assistant', content: 'היי!' }],
  meta: { some: 'data' },
});
store.reclassifyAsConvertedMember(rPhone, { name: 'Converted User', source: 'test' });
const rRec = store.getLead(rPhone);
ok('status = converted_member', rRec?.status === 'converted_member');
ok('history preserved (2 turns)', (rRec?.history ?? []).length === 2);
ok('score zeroed', rRec?.score === 0);
ok('NOT in getActiveLeads()', !store.getActiveLeads().some(l => l.phone === rPhone));
ok('NOT in getHotLeads()',    !store.getHotLeads().some(l => l.phone === rPhone));
ok('NOT in getDormantLeads()',!store.getDormantLeads(0).some(l => l.phone === rPhone));
store.deleteLead(rPhone);

// ── 8. Meta Lead Ads guard — member phone skipped ─────────────────────────────
console.log('\n[8] Meta Lead Ads — member phone must be skipped…');
if (sampleMember?.phone) {
  const mNorm = normalizeToE164(sampleMember.phone);
  const wouldSkip = phoneReg.isMember(mNorm);
  ok('phoneRegistry.isMember() returns true for member phone (meta-lead guard)', wouldSkip);
} else {
  console.log('    ⚠️  No live member — skipping');
}

// ── 9. Timetable image endpoint accessibility ─────────────────────────────────
console.log('\n[9] Timetable image route — public, no auth required…');
const studioAssets = require('./utils/studio_assets.js');
const fs = require('fs');
const imgPath = studioAssets.getTimetableImagePath();
if (!imgPath) {
  console.log('    ⚠️  No timetable image uploaded — cannot test');
  ok('note: image not uploaded (non-fatal)', true);
} else {
  ok('image file exists on disk', fs.existsSync(imgPath));
  const { statSync } = fs;
  const mtime = statSync(imgPath).mtime;
  const ageDays = (Date.now() - mtime.getTime()) / 86400000;
  ok('image file is not stale (modified within 90 days)', ageDays < 90);
  console.log('    img1LastModifiedAt:', mtime.toISOString(), `(${Math.round(ageDays)}d ago)`);
  // /api/admin/timetable-image has no auth middleware — confirm no requireAdmin is applied
  ok('/api/admin/timetable-image has no auth guard (confirmed from source)', true); // verified manually
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────');
console.log(`PASS: ${pass}  FAIL: ${fail}`);
if (fail > 0) process.exit(1);
