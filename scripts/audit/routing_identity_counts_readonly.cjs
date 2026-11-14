#!/usr/bin/env node
/**
 * routing_identity_counts_readonly.cjs — READ-ONLY (GET only), counts only.
 * How many Arbox user rows each routing rule would treat as "member", by role / active flag /
 * currently valid membership. Prints no name, phone or id.
 */
'use strict';
const path = require('path');
const http = require('http'), https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
process.env.NODE_ENV = 'test'; process.env.LOG_TO_FILE = 'false'; process.env.LOG_SILENT = 'true';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('mock base url'); process.exit(2); }
const HOST = new URL(BASE).hostname;
let gets = 0;
for (const mod of [http, https]) {
  const orig = mod.request;
  mod.request = function (...a) {
    const o = a[0] ?? {}; const m = String(o.method ?? 'GET').toUpperCase(); const h = String(o.hostname ?? o.host ?? '').replace(/:\d+$/, '');
    if (m !== 'GET' || h !== HOST) throw new Error(`refused ${m} ${h}`);
    gets++; return orig.apply(this, a);
  };
}
const axios = require('axios');
const cli = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json' }, timeout: 30000, validateStatus: () => true });
const LOC = process.env.ARBOX_LOCATION_ID ?? '19392';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pages(p, params = {}) {
  const all = [];
  for (let page = 1; page <= 40; page++) {
    await sleep(300);
    const r = await cli.get(p, { params: { location_id: LOC, limit: 200, page, ...params } });
    if (r.status !== 200) throw new Error(`${p} → ${r.status}`);
    const b = Array.isArray(r.data?.data) ? r.data.data : [];
    all.push(...b);
    if (!r.data?.extra?.pagination?.next_page_url || !b.length) break;
  }
  return all;
}
const tally = (rows, f) => { const o = {}; for (const r of rows) { const k = f(r); o[k] = (o[k] ?? 0) + 1; } return o; };
const norm = raw => { if (!raw) return null; const s = String(raw).replace(/[^\d+]/g, ''); let n = s.startsWith('+972') ? s.slice(1) : s.startsWith('00972') ? s.slice(2) : s.startsWith('972') ? s : s.startsWith('0') ? '972' + s.slice(1) : s.length === 9 ? '972' + s : s.replace(/^\+/, ''); return /^\d{10,15}$/.test(n) ? n : null; };

(async () => {
  const users = await pages('/v3/users');
  const mems = await pages('/v3/users/memberships');
  const types = await pages('/v3/membershipTypes');
  const kind = new Map(types.map(t => [String(t.membership_type_id), t.type]));
  const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
  const valid = new Set(mems.filter(m => m.active === 1 && m.cancelled !== 1 && (!m.start_time || m.start_time <= today) && (!m.end_time || m.end_time >= today)
    && ['plan', 'session', undefined].includes(kind.get(String(m.membership_type_id)))).map(m => String(m.user_id)));
  const anyMembershipEver = new Set(mems.map(m => String(m.user_id)));
  const withPhone = users.filter(u => norm(u.phone));
  const isReg = u => (u.user_role === 'client' && u.active === 1) || u.user_role === 'aggregatorMember';          // phone_registry
  const isCache = u => u.active === 1 || u.user_role === 'aggregatorMember';                                       // member_cache.seedFromArbox
  const firstPageActive = (await cli.get('/v3/users', { params: { location_id: LOC, limit: 200, active: 1 } })).data;
  const fp = Array.isArray(firstPageActive?.data) ? firstPageActive.data : [];
  const out = {
    today, arboxGET: null,
    userRows: users.length, withUsablePhone: withPhone.length,
    byRoleAndActive: tally(users, u => `${u.user_role}/active=${u.active}`),
    registryRule_clientActiveOrAggregator: { rows: withPhone.filter(isReg).length, distinctPhones: new Set(withPhone.filter(isReg).map(u => norm(u.phone))).size },
    memberCacheRule_anyRoleActive: { rows: withPhone.filter(isCache).length, byRole: tally(withPhone.filter(isCache), u => u.user_role) },
    cacheButNotRegistry_byRole: tally(withPhone.filter(u => isCache(u) && !isReg(u)), u => `${u.user_role}/active=${u.active}`),
    activeClients: {
      total: users.filter(u => u.user_role === 'client' && u.active === 1).length,
      withCurrentlyValidPlanOrSession: users.filter(u => u.user_role === 'client' && u.active === 1 && valid.has(String(u.user_id))).length,
      withoutValidMembership: users.filter(u => u.user_role === 'client' && u.active === 1 && !valid.has(String(u.user_id))).length,
      withoutValid_butHadMembershipBefore: users.filter(u => u.user_role === 'client' && u.active === 1 && !valid.has(String(u.user_id)) && anyMembershipEver.has(String(u.user_id))).length,
      withoutValid_neverHadMembership: users.filter(u => u.user_role === 'client' && u.active === 1 && !valid.has(String(u.user_id)) && !anyMembershipEver.has(String(u.user_id))).length,
    },
    inactiveClients: {
      total: users.filter(u => u.user_role === 'client' && u.active !== 1).length,
      butWithCurrentlyValidMembership: users.filter(u => u.user_role === 'client' && u.active !== 1 && valid.has(String(u.user_id))).length,
    },
    phonesSharedBetweenAMemberRowAndANonMemberRow: (() => { const m = new Map(); for (const u of withPhone) { const k = norm(u.phone); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(isReg(u) ? 'member' : u.user_role === 'lead' ? 'lead' : 'other'); } return [...m.values()].filter(s => s.has('member') && s.size > 1).length; })(),
    tier3LiveLookup_firstPageOfActiveOnly: { rowsReturned: fp.length, hasNextPage: !!firstPageActive?.extra?.pagination?.next_page_url, byRole: tally(fp, u => u.user_role),
      activeClientsTotal: users.filter(u => u.user_role === 'client' && u.active === 1).length, activeClientsOnFirstPage: fp.filter(u => u.user_role === 'client').length },
  };
  out.arboxGET = gets;
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
