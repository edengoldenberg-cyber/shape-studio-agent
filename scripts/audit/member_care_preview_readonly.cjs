#!/usr/bin/env node
/**
 * member_care_preview_readonly.cjs — eligibility PREVIEW of the member-care programs on the
 * real Arbox data, READ-ONLY, aggregated.
 *
 *   node scripts/audit/member_care_preview_readonly.cjs
 *
 * What it does:  runs the real engine's preview() for every program and prints COUNTS only.
 * What it cannot do, by construction:
 *   • send anything            — no WhatsApp module is loaded; the injected sender throws and is counted
 *   • write to Arbox           — every outgoing HTTP request is intercepted: only GET to the Arbox host passes
 *   • touch production state   — DATA_DIR is a fresh temporary directory (production state lives on the server)
 *   • create episodes / cases / alerts / guest entitlements — preview() never does; this is verified below
 *     (the temporary directory must still be EMPTY after the previews) and reported.
 * Output: no name, phone, e-mail, user id or message text — numbers and reason codes only.
 *
 * Two lenses:
 *   A  "as shipped"   — the store exactly as a fresh deployment has it (nothing approved, nothing enabled,
 *                        freeze source unconfirmed, activation baseline = today → no backlog).
 *   B  "population"   — diagnostic only: the activation baseline moved 30 days back IN THE TEMPORARY STORE,
 *                        to show how many members currently sit inside each program's window.
 */
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'care-preview-ro-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';
process.env.LOG_TO_FILE = 'false';
process.env.LOG_SILENT = 'true';
delete process.env.ARBOX_WRITES_ENABLED;
delete process.env.TOMER_PROACTIVE_ENABLED;

const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('ARBOX_BASE_URL points at a mock — this script is for the real, read-only preview'); process.exit(2); }
const ARBOX_HOST = new URL(BASE).hostname;

// ── network guard: GET to the Arbox host only ─────────────────────────────────
const net = { GET: 0, refused: [] };
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function guarded(...args) {
    const o = typeof args[0] === 'string' || args[0] instanceof URL ? { ...(typeof args[1] === 'object' ? args[1] : {}), ...(() => { const u = new URL(String(args[0])); return { hostname: u.hostname }; })() } : (args[0] ?? {});
    const method = String(o.method ?? 'GET').toUpperCase();
    const host = String(o.hostname ?? o.host ?? '').replace(/:\d+$/, '');
    if (method !== 'GET' || host !== ARBOX_HOST) {
      net.refused.push(`${method} ${host}`);
      throw new Error(`read-only preview: refused ${method} ${host}`);
    }
    net.GET++;
    return orig.apply(this, args);
  };
}

const gateway   = require('../../services/arbox_gateway');
const careStore = require('../../utils/member_care_store');
const { createMemberCare } = require('../../services/member_care');

const TEST_PHONE = '972537605023';
let sendAttempts = 0, caseWrites = 0;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const care = createMemberCare({
  gateway, store: careStore, logger: quiet,
  cases: { list: () => [], create: () => { caseWrites++; throw new Error('read-only preview: no cases'); } },
  sendMember: async () => { sendAttempts++; throw new Error('read-only preview: sending is impossible here'); },
  state: {
    proactiveOn: () => true,                       // hypothetical: shows what the OTHER gates do
    allowed: phone => phone === TEST_PHONE,        // the test-only allowlist as it will be deployed
    owner: () => 'tomer', lastConversationAt: () => null, testPhones: () => [TEST_PHONE],
  },
});

const dirState = () => fs.readdirSync(TMP).sort().map(f => `${f}:${fs.statSync(path.join(TMP, f)).size}`).join('|');
const tally = (rows, key) => { const o = {}; for (const r of rows) for (const k of [].concat(key(r))) o[k] = (o[k] ?? 0) + 1; return o; };

async function lens() {
  const out = {};
  for (const id of care.PRIORITY) {
    const p = await care.preview(id);
    out[id] = {
      blockedProgram: p.blocks.map(b => b.code),
      dataBlocked: p.dataBlocked ? p.dataBlocked.map(d => d.source) : null,
      activeMembers: p.totalMembers,
      eligible: p.included.length,
      ofEligible: {
        wouldSend: p.included.filter(x => x.decision === 'send').length,
        blocked: p.included.filter(x => x.decision === 'block').length,
        deferred: p.included.filter(x => x.decision === 'defer').length,
        reasons: tally(p.included, x => x.reasons.map(r => r.code)),
        freeze: tally(p.included, x => x.freeze),
        variants: tally(p.included, x => x.variant),
      },
      excluded: Object.fromEntries(p.excludedCounts.map(c => [c.code, c.count])),
    };
  }
  return out;
}

(async () => {
  const result = { at: new Date().toISOString(), arboxHost: ARBOX_HOST, tmpDataDir: 'temporary (deleted at the end)' };
  const before = dirState();

  // ── Lens A: as shipped ──────────────────────────────────────────────────────
  result.lensA_asShipped = await lens();
  const snap = await care.loadSnapshot();
  const afterA = dirState();
  result.sideEffects = {
    dataDirBefore: before || '(empty)', dataDirAfterPreviews: afterA || '(empty)', unchanged: before === afterA,
    episodes: careStore.listEpisodes({ limit: 100000 }).length, entitlements: careStore.listEntitlements().length,
    pauses: careStore.listPauses().length, sendAttempts, caseWrites,
  };

  // ── sources + data quality (counts only) ────────────────────────────────────
  result.sources = Object.fromEntries(Object.entries(snap.src).map(([k, v]) => [k, v.ok === false ? `FAILED: ${String(v.error).slice(0, 120)}` : { ok: true, stale: !!v.stale }]));
  result.freezeStatusSource = snap.freeze;
  const active = snap.members.filter(m => m.isActive);
  const year = Number(snap.today.slice(0, 4));
  const bucket = d => (d === null ? 'unknown(no check-in in 30d)' : d <= 6 ? '0-6' : d <= 13 ? '7-13' : d <= 20 ? '14-20' : '21-30');
  const phoneOwners = new Map(); for (const m of active) if (m.phone) phoneOwners.set(m.phone, (phoneOwners.get(m.phone) ?? 0) + 1);
  result.dataQuality = {
    today: snap.today,
    clientRows: snap.members.length, activeMembers: active.length,
    phone: { missingOrInvalid: active.filter(m => !m.phone).length, notIsraeliMobile: active.filter(m => m.phone && !/^9725\d{8}$/.test(m.phone)).length, sharedByTwoOrMoreActive: active.filter(m => m.phoneShared).length, distinctSharedNumbers: [...phoneOwners.values()].filter(n => n > 1).length },
    gender: tally(active, m => m.gender ?? 'unknown'),
    birthday: { missing: active.filter(m => !m.birthday).length, implausibleYear: active.filter(m => m.birthday && (Number(m.birthday.slice(0, 4)) < 1930 || Number(m.birthday.slice(0, 4)) > year - 10)).length },
    firstMembership: tally(active, m => m.firstWhyNot ?? 'identified'),
    activeMembershipKinds: tally(active.flatMap(m => m.activeMs), x => x.kind),
    activeMembershipRecurring: tally(active.flatMap(m => m.activeMs), x => (x.recurring === null ? 'unknown(type deleted)' : x.recurring ? 'recurring' : 'non-recurring')),
    activeMembershipsWithoutEndDate: active.flatMap(m => m.activeMs).filter(x => !x.endDate).length,
    membersWithSeveralActiveMemberships: active.filter(m => m.activeMs.length > 1).length,
    attendance: { daysSinceLastVerifiedCheckIn: tally(active, m => bucket(m.daysAbsent)), newNeverAttended: active.filter(m => m.neverAttended).length, withFutureBooking: active.filter(m => m.future.length).length, attendedThisWeek: active.filter(m => m.attendedThisWeek).length },
    freeze: tally(active, m => `${m.freeze} (${m.freezeSource})`),
    transactions30d: snap.transactions ? { rows: snap.transactions.length, byKindStatus: tally(snap.transactions, t => `${t.kind}/${t.status}`), failRecurringWithoutMembershipId: snap.transactions.filter(t => t.kind === 'RECURRING' && t.status === 'FAIL' && !t.membershipUserId).length } : 'unavailable',
  };

  // ── freeze source: what does Arbox actually expose? (key NAMES only) ────────
  const axios = require('axios');
  const raw = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json' }, timeout: 30000, validateStatus: () => true });
  const LOC = process.env.ARBOX_LOCATION_ID ?? '19392';
  const iso = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const HOLDISH = /hold|freez|frozen|suspend|pause/i;
  const probe = async (p, params) => {
    await new Promise(r => setTimeout(r, 350));
    const r = await raw.get(p, { params: { location_id: LOC, ...params } });
    const rows = Array.isArray(r.data?.data) ? r.data.data : [];
    const keys = [...new Set(rows.flatMap(x => Object.keys(x ?? {})))];
    return { http: r.status, rows: rows.length, keys, data: rows, holdLikeKeys: keys.filter(k => HOLDISH.test(k)), holdLikeFilled: Object.fromEntries(keys.filter(k => HOLDISH.test(k)).map(k => [k, rows.filter(x => x[k] !== null && x[k] !== undefined && x[k] !== '' && x[k] !== 0 && x[k] !== false).length])) };
  };
  const holdWindows = {};
  for (const [label, from, to] of [['past 31 days', iso(-31), iso(0)], ['today..+30', iso(0), iso(30)], ['+31..+61', iso(31), iso(61)], ['-62..-32', iso(-62), iso(-32)]]) {
    const r = await probe('/v3/reports/membersOnHoldReport', { fromDate: from, toDate: to, limit: 200 });
    // counts and enum-like values only: how many rows' suspension period covers today, and the task_status values
    const day = v => String(v ?? '').slice(0, 10);
    holdWindows[label] = { http: r.http, rows: r.rows, fieldNames: r.keys, distinctMembers: new Set(r.data.map(x => x.user_id)).size,
      suspensionCoversToday: r.data.filter(x => day(x.start_suspend_time) && day(x.start_suspend_time) <= iso(0) && (!day(x.end_suspend_time) || day(x.end_suspend_time) >= iso(0))).length,
      startsInFuture: r.data.filter(x => day(x.start_suspend_time) > iso(0)).length, endedBeforeToday: r.data.filter(x => day(x.end_suspend_time) && day(x.end_suspend_time) < iso(0)).length,
      taskStatusValues: [...new Set(r.data.map(x => (typeof x.task_status === 'object' ? JSON.stringify(x.task_status) : String(x.task_status)).slice(0, 30)))],
      dateFormats: [...new Set(r.data.flatMap(x => [x.start_suspend_time, x.end_suspend_time]).map(v => (v === null || v === undefined ? 'null' : String(v).replace(/\d/g, 'd'))))] };
  }
  const um = await probe('/v3/users/memberships', { limit: 200, page: 1 });
  const uu = await probe('/v3/users', { limit: 200, page: 1 });
  result.freezeSourceProbe = {
    membersOnHoldReport: holdWindows,
    membershipRowHoldLikeFields: { names: um.holdLikeKeys, filledIn200Rows: um.holdLikeFilled },
    userRowHoldLikeFields: { names: uu.holdLikeKeys, filledIn200Rows: uu.holdLikeFilled },
  };

  // ── Lens B: population inside each window (diagnostic; temporary store only) ─
  const back = new Date(Date.now() - 30 * 86400000).toISOString();
  careStore.updateSettings({ programs: Object.fromEntries(care.PRIORITY.map(id => [id, { activatedAt: back }])) }, 'readonly-preview');
  result.lensB_populationIfBaselineWere30DaysAgo = await lens();
  // … and the same population if the freeze source were confirmed (shows what the freeze gate alone holds back)
  care.confirmFreezeSource({ confirmed: true, by: 'readonly-preview (hypothetical)' });
  const c = await lens();
  result.lensC_sameWithFreezeSourceConfirmed = Object.fromEntries(Object.entries(c).map(([id, v]) => [id, { eligible: v.eligible, reasons: v.ofEligible.reasons, freeze: v.ofEligible.freeze }]));

  result.network = { arboxGET: net.GET, refusedRequests: net.refused, sendAttempts, caseWrites };
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(JSON.stringify(result, null, 1));
  process.exit(net.refused.length || sendAttempts || caseWrites || !result.sideEffects.unchanged ? 1 : 0);
})().catch(err => { console.error('FAILED:', err.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
