#!/usr/bin/env node
/**
 * identity_before_after_readonly.cjs — READ-ONLY (GET only), counts only.
 *
 * BEFORE: who the three old rules called a member (phone registry, member-cache seed, live lookup).
 * AFTER:  the category the ONE identity resolver gives every Arbox phone, and where each
 *         group that the old rules called "member" lands now.
 * Prints no name, phone or id. Nothing is written anywhere (the resolver's directory file is disabled).
 */
'use strict';
const path = require('path');
const http = require('http'), https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
process.env.NODE_ENV = 'test'; process.env.LOG_TO_FILE = 'false'; process.env.LOG_SILENT = 'true';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('mock base url'); process.exit(2); }
const HOST = new URL(BASE).hostname;
let gets = 0; const refused = [];
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function (...a) {
    const o = a[0] ?? {}; const m = String(o.method ?? 'GET').toUpperCase(); const h = String(o.hostname ?? o.host ?? '').replace(/:\d+$/, '');
    if (m !== 'GET' || h !== HOST) { refused.push(`${m} ${h}`); throw new Error(`refused ${m} ${h}`); }
    gets++; return orig.apply(this, a);
  };
}
const gateway = require('../../services/arbox_gateway');
const { createIdentityResolver } = require('../../services/identity_resolver');
const tally = (rows, f) => { const o = {}; for (const r of rows) { const k = f(r); o[k] = (o[k] ?? 0) + 1; } return o; };

(async () => {
  const id = createIdentityResolver({ gateway, logger: { info() {}, warn() {}, error() {} }, dataDir: null });
  const summary = await id.refresh();
  const users = (await gateway.getAllUsers()).users;                          // same read (cached)
  const withPhone = users.filter(u => u.phone);
  const phonesOf = pred => [...new Set(withPhone.filter(pred).map(u => u.phone))];
  // BEFORE — the three old rules
  const oldRegistry = phonesOf(u => (u.role === 'client' && u.active) || u.role === 'aggregatorMember');
  const oldCache    = phonesOf(u => u.active || u.role === 'aggregatorMember');
  const activeFirst200 = users.filter(u => u.active).slice(0, 200);            // the old live lookup read only this page, any role, all called "member"
  const oldLive     = [...new Set(activeFirst200.filter(u => u.phone).map(u => u.phone))];
  const oldMemberAny = [...new Set([...oldRegistry, ...oldCache])];
  const now = p => id.peek(p).category;
  const allPhones = [...new Set(withPhone.map(u => u.phone))];
  const newMember = allPhones.filter(p => ['member', 'aggregator'].includes(now(p)));
  const out = {
    today: gateway.todayIL(), arboxGET: null, refused,
    arboxRows: { users: users.length, withUsablePhone: withPhone.length, distinctPhones: allPhones.length, byRoleAndActiveFlag: tally(users, u => `${u.role}/active=${u.active ? 1 : 0}`) },
    BEFORE_treatedAsMember: {
      phoneRegistry_distinctPhones: oldRegistry.length,
      memberCache_distinctPhones: oldCache.length,
      liveLookup_firstPageOnly_distinctPhones: oldLive.length,
      anyOldRule_distinctPhones: oldMemberAny.length,
    },
    AFTER_categoriesOfAllArboxPhones: summary.counts,
    AFTER_flags: { sharedPhones: summary.sharedPhones, sharedWithDifferentCategories: summary.sharedWithDifferentCategories, ambiguousMembers: summary.ambiguousMembers, membershipsRead: summary.membershipsFresh },
    AFTER_treatedAsMemberPath_memberPlusAggregator: newMember.length,
    whereOldMembersLandNow: {
      phoneRegistryPhones: tally(oldRegistry, now),
      memberCachePhones: tally(oldCache, now),
      liveLookupFirstPagePhones: tally(oldLive, now),
    },
    newlyMember_notMemberUnderAnyOldRule: newMember.filter(p => !oldMemberAny.includes(p)).length,
    noLongerMemberPath: tally(oldMemberAny.filter(p => !newMember.includes(p)), now),
    leadReasons: tally(allPhones.filter(p => now(p) === 'lead'), p => id.peek(p).reason ?? 'lead_row'),
    sharedPhoneOutcomes: tally(allPhones.filter(p => id.peek(p).shared), p => `${now(p)}${id.peek(p).others.length ? ' (+' + id.peek(p).others.join(',') + ')' : ''}`),
  };
  out.arboxGET = gets;
  console.log(JSON.stringify(out, null, 1));
  process.exit(refused.length ? 1 : 0);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
