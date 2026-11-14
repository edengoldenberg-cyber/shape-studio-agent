'use strict';
/**
 * identity_resolver.test.js — the ONE identity resolver, against the local Arbox stand-in.
 *
 * REAL: services/identity_resolver.js, services/arbox_gateway.js (real HTTP, real pagination,
 * real phone normalisation), utils/phone_registry.js, utils/member_cache.js.
 * Synthetic people only; nothing leaves the machine.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createArboxMock } = require('./helpers/arbox_mock.cjs');

process.env.ARBOX_TIMEOUT_MS  = '500';
process.env.ARBOX_MIN_GAP_MS  = '0';
process.env.ARBOX_LOCATION_ID = '1';
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const arbox = createArboxMock();
let gateway, createIdentityResolver;
const TODAY = '2026-11-16';
let clock = new Date(`${TODAY}T08:00:00Z`);
const now = () => clock;
const advance = ms => { clock = new Date(clock.getTime() + ms); };
const day = n => new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const H = 3600 * 1000;

let uid = 100, mid = 5000;
function user({ role = 'client', active = 1, phone, first = 'בדיקה' }) {
  const id = ++uid;
  arbox.state.users.push({ user_id: id, first_name: first, last_name: 'מדומה', phone, user_role: role, active });
  return id;
}
function membership(userId, { type = 'plan', typeId = 1, start = day(-30), end = day(30), active = 1, cancelled = 0 } = {}) {
  arbox.state.memberships.push({ membership_user_id: ++mid, user_id: userId, membership_type_id: typeId, membership_type_name: 'מנוי', type, start_time: start, end_time: end, active, cancelled, created_at: `${start} 09:00` });
}
function fresh(dataDir = null) {
  gateway.clearCache();
  return createIdentityResolver({ gateway, now, dataDir, logger: { info() {}, warn() {}, error() {} } });
}

beforeAll(async () => {
  process.env.ARBOX_BASE_URL = await arbox.listen();
  gateway = require('../services/arbox_gateway');
  ({ createIdentityResolver } = require('../services/identity_resolver'));
});
afterAll(() => arbox.close());
beforeEach(() => {
  arbox.reset(); gateway.clearCache(); clock = new Date(`${TODAY}T08:00:00Z`);
  arbox.state.membershipTypes.push({ membership_type_id: 1, membership_type_name: 'מנוי חודשי', type: 'plan', is_recurring_payment: 1 },
    { membership_type_id: 2, membership_type_name: 'כרטיסייה', type: 'session', is_recurring_payment: 0 },
    { membership_type_id: 3, membership_type_name: 'אימון ניסיון', type: 'trial', is_recurring_payment: 0 });
});

describe('1. Every identity category', () => {
  test('member = a client row with a currently valid membership; the Arbox active flag decides nothing', async () => {
    membership(user({ phone: '0501000001' }));                                              // valid plan
    membership(user({ phone: '0501000002' }), { typeId: 2, type: 'session', end: null });   // punch card, no end date
    membership(user({ phone: '0501000003', active: 0 }));                                   // flag off, membership valid → still a member
    user({ phone: '0501000004', active: 1 });                                               // flag on, NO membership → not a member
    const id = fresh();
    for (const p of ['972501000001', '972501000002', '972501000003']) expect(await id.resolve(p)).toMatchObject({ category: 'member', stale: false, shared: false, ambiguous: false });
    expect(await id.resolve('972501000004')).toMatchObject({ category: 'lead', reason: 'client_row_without_membership' });
  });

  test('former member: expired, cancelled or deactivated membership — identified as such, never as a member', async () => {
    membership(user({ phone: '0502000001' }), { end: day(-1) });                            // ended yesterday
    membership(user({ phone: '0502000002' }), { cancelled: 1 });
    membership(user({ phone: '0502000003' }), { active: 0 });
    membership(user({ phone: '0502000004', active: 0 }), { start: day(-400), end: day(-200) });
    const ends = user({ phone: '0502000005' }); membership(ends, { end: TODAY });           // last valid day is today → still a member
    const id = fresh();
    for (const p of ['972502000001', '972502000002', '972502000003', '972502000004']) expect((await id.resolve(p)).category).toBe('former_member');
    expect((await id.resolve('972502000005')).category).toBe('member');
  });

  test('lead, trial-only client, not-yet-started membership, staff, former staff, aggregator, unknown', async () => {
    user({ role: 'lead', active: 1, phone: '0503000001' });                                 // the case that was routed as a member before
    user({ role: 'lead', active: 0, phone: '0503000002' });
    membership(user({ phone: '0503000003' }), { typeId: 3, type: 'trial' });                // a trial is not a membership
    membership(user({ phone: '0503000004' }), { start: day(5), end: day(35) });             // bought, starts next week
    user({ role: 'staffMember', active: 1, phone: '0503000005' });
    user({ role: 'staffMember', active: 0, phone: '0503000006' });
    user({ role: 'aggregatorMember', active: 0, phone: '0503000007' });
    const id = fresh();
    const cat = async p => (await id.resolve(p)).category;
    expect(await cat('972503000001')).toBe('lead');
    expect(await cat('972503000002')).toBe('lead');
    expect(await cat('972503000003')).toBe('lead');
    expect(await id.resolve('972503000004')).toMatchObject({ category: 'lead', reason: 'membership_not_started_yet' });
    expect(await cat('972503000005')).toBe('staff');
    expect(await cat('972503000006')).toBe('unknown');                                      // a former staff row proves nothing
    expect(await cat('972503000007')).toBe('aggregator');
    expect(await id.resolve('972509999999')).toMatchObject({ category: 'unknown', reason: 'not_in_arbox' });
    expect(await id.resolve('abc')).toMatchObject({ category: 'unknown', reason: 'bad_phone' });
  });

  test('a membership whose type was deleted in Arbox still counts by the row\'s own kind', async () => {
    membership(user({ phone: '0504000001' }), { typeId: 999, type: 'plan' });               // type 999 is not in membershipTypes
    membership(user({ phone: '0504000002' }), { typeId: 998, type: 'item' });               // a product, not a membership
    const id = fresh();
    expect((await id.resolve('972504000001')).category).toBe('member');
    expect((await id.resolve('972504000002')).category).toBe('lead');
  });
});

describe('2. Complete pagination and normalised phones', () => {
  test('members on the third page of users and of memberships are found; a lead on page one is not a member', async () => {
    for (let i = 0; i < 430; i++) user({ role: 'lead', active: 1, phone: `0521${String(i).padStart(6, '0')}` });
    for (let i = 0; i < 430; i++) { const u = user({ phone: `0522${String(i).padStart(6, '0')}`, active: 0 }); membership(u, { end: day(-10) }); }
    const late = user({ phone: '0523000001' }); membership(late);                           // user #861, membership #431 → third pages
    const id = fresh();
    expect((await id.resolve('972523000001')).category).toBe('member');
    expect((await id.resolve('972521000000')).category).toBe('lead');
    expect((await id.resolve('972522000429')).category).toBe('former_member');
    const pages = p => arbox.log.filter(l => l.path === p && !l.query.user_id).map(l => Number(l.query.page));
    expect(Math.max(...pages('/v3/users'))).toBeGreaterThanOrEqual(5);
    expect(Math.max(...pages('/v3/users/memberships'))).toBeGreaterThanOrEqual(3);
    expect(id.summary()).toMatchObject({ phones: 861, counts: { member: 1, lead: 430, former_member: 430 } });
  });

  test('every way a phone is written resolves to the same person', async () => {
    membership(user({ phone: '‏050-123 4567‎' }));                                // RTL / LTR marks, dash, space
    membership(user({ phone: '+972 52-7654321' }));
    membership(user({ phone: '00972531112222' }));
    const id = fresh();
    for (const p of ['0501234567', '972501234567', '+972501234567', '050-1234567', '501234567']) expect((await id.resolve(p)).category).toBe('member');
    expect((await id.resolve('0527654321')).category).toBe('member');
    expect((await id.resolve('972531112222')).category).toBe('member');
    expect((await id.resolve('0501234568')).category).toBe('unknown');                      // one digit off is nobody
  });
});

describe('3. Shared phones and conflicting rows', () => {
  test('the strongest category wins and the conflict is reported, not hidden', async () => {
    user({ role: 'lead', active: 1, phone: '0541000001' }); membership(user({ phone: '054-1000001' }));                    // lead + member
    membership(user({ phone: '0541000002' })); membership(user({ phone: '0541000002', first: 'אחות' }));                    // two members
    user({ role: 'staffMember', active: 1, phone: '0541000003' }); membership(user({ phone: '0541000003' }));               // staff who also trains
    membership(user({ phone: '0541000004' }), { end: day(-5) }); user({ role: 'lead', active: 1, phone: '0541000004' });    // former + lead
    user({ role: 'aggregatorMember', active: 1, phone: '0541000005' }); membership(user({ phone: '0541000005' }), { end: day(-5) });   // aggregator + former
    const id = fresh();
    expect(await id.resolve('972541000001')).toMatchObject({ category: 'member', shared: true, others: ['lead'], ambiguous: false });
    expect(await id.resolve('972541000002')).toMatchObject({ category: 'member', shared: true, ambiguous: true });
    expect((await id.resolve('972541000002')).userIds).toHaveLength(2);
    expect(await id.resolve('972541000003')).toMatchObject({ category: 'staff', shared: true, others: ['member'] });
    expect(await id.resolve('972541000004')).toMatchObject({ category: 'former_member', shared: true, others: ['lead'] });
    expect(await id.resolve('972541000005')).toMatchObject({ category: 'aggregator', shared: true, others: ['former_member'] });
    expect(id.summary()).toMatchObject({ sharedPhones: 5, ambiguousMembers: 1 });
  });
});

describe('4. Stale data', () => {
  test('a stored directory cannot keep an expired membership alive: dates are re-checked at every lookup', async () => {
    membership(user({ phone: '0551000001' }), { end: day(1) });                             // valid until tomorrow
    const id = fresh();
    expect((await id.resolve('972551000001')).category).toBe('member');
    arbox.mode.down = true; gateway.clearCache();
    advance(6 * H);                                                                         // same day, Arbox down
    expect(await id.resolve('972551000001')).toMatchObject({ category: 'member', stale: true, refreshFailed: true });
    advance(48 * H - 6 * H - 9 * H);                                                        // two days later would exceed the limit — step to 33h first
    expect((await id.resolve('972551000001')).category).toBe('unavailable');                // older than 24h: no longer trusted at all
  });

  test('within the 24h limit an expired membership turns into "former member" without any Arbox read', async () => {
    clock = new Date(`${TODAY}T20:30:00Z`);                                                 // 22:30 Israel time
    membership(user({ phone: '0551000002' }), { end: TODAY });
    const id = fresh();
    expect((await id.resolve('972551000002')).category).toBe('member');
    arbox.mode.down = true; gateway.clearCache();
    advance(3 * H);                                                                         // 01:30 the next day in Israel
    expect(await id.resolve('972551000002')).toMatchObject({ category: 'former_member', stale: true, refreshFailed: true });
  });

  test('a new member appears as soon as the cached Arbox data is dropped or the directory is a minute old', async () => {
    const id = fresh();
    expect((await id.resolve('972561000001')).category).toBe('unknown');
    membership(user({ phone: '0561000001' }));
    expect((await id.resolve('972561000001')).category).toBe('unknown');                    // same instant, same directory
    gateway.clearCache();
    expect((await id.resolve('972561000001')).category).toBe('member');
  });

  test('"not a member" from an older copy while Arbox is unreadable is flagged as unproven', async () => {
    const id = fresh();
    await id.refresh();
    arbox.mode.down = true; gateway.clearCache(); advance(5 * 60 * 1000);
    expect(await id.resolve('972567000001')).toMatchObject({ category: 'unknown', stale: true, refreshFailed: true });
  });

  test('the saved directory serves a restart during an outage, marked stale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
    membership(user({ phone: '0571000001' })); user({ role: 'lead', active: 1, phone: '0571000002' });
    const a = fresh(dir); await a.refresh();
    expect(fs.existsSync(path.join(dir, 'identity_directory.json'))).toBe(true);
    arbox.mode.down = true;
    const b = fresh(dir);                                                                   // "restart"
    expect((await b.resolve('972571000001')).category).toBe('unavailable');                 // nothing loaded yet, Arbox down
    expect(b.load()).toBe(true);
    advance(2 * H);
    expect(await b.resolve('972571000001')).toMatchObject({ category: 'member', stale: true });
    expect(await b.resolve('972571000002')).toMatchObject({ category: 'lead', stale: true, refreshFailed: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('5. Arbox failure', () => {
  test('nothing readable and no earlier copy → unavailable for everyone, never a guess', async () => {
    membership(user({ phone: '0581000001' }));
    arbox.mode.usersDown = true;
    const id = fresh();
    expect(await id.resolve('972581000001')).toMatchObject({ category: 'unavailable' });
    expect(await id.resolve('972589999999')).toMatchObject({ category: 'unavailable' });
    expect(id.peek('972581000001').category).toBe('unavailable');
  });

  test('memberships unreadable, no earlier copy: a client is unavailable (could be a member); lead, staff and unknown stay known', async () => {
    membership(user({ phone: '0582000001' })); user({ phone: '0582000002', active: 1 });
    user({ role: 'lead', active: 1, phone: '0582000003' }); user({ role: 'staffMember', active: 1, phone: '0582000004' });
    user({ role: 'aggregatorMember', active: 1, phone: '0582000005' });
    arbox.mode.membershipsDown = true;
    const id = fresh();
    expect(await id.resolve('972582000001')).toMatchObject({ category: 'unavailable', reason: 'memberships_unavailable' });
    expect(await id.resolve('972582000002')).toMatchObject({ category: 'unavailable', reason: 'memberships_unavailable' });
    expect((await id.resolve('972582000003')).category).toBe('lead');
    expect((await id.resolve('972582000004')).category).toBe('staff');
    expect((await id.resolve('972582000005')).category).toBe('aggregator');
    expect((await id.resolve('972589999999')).category).toBe('unknown');
  });

  test('memberships unreadable AFTER a good read: the earlier memberships are used (stale); a brand-new client is unavailable', async () => {
    membership(user({ phone: '0583000001' }));
    const id = fresh(); await id.refresh();
    arbox.mode.membershipsDown = true; user({ phone: '0583000002', active: 1 });
    gateway.clearCache(); advance(2 * 60 * 1000);
    expect(await id.resolve('972583000001')).toMatchObject({ category: 'member', stale: true });
    expect(await id.resolve('972583000002')).toMatchObject({ category: 'unavailable', reason: 'memberships_unavailable' });
  });

  test('a timeout is handled like a failure (no hang)', async () => {
    membership(user({ phone: '0584000001' }));
    const id = fresh(); await id.refresh();
    arbox.mode.hang = true; gateway.clearCache();
    const t0 = Date.now();
    expect(await id.resolve('972584000001')).toMatchObject({ category: 'member', stale: true, refreshFailed: true });
    expect(Date.now() - t0).toBeLessThan(5000);
    arbox.mode.hang = false;
  });
});

describe('6. The registry and the member cache have no rule of their own', () => {
  test('both mirror the resolver: an active-flag lead and active staff are not members; stale cache entries are purged; a manual entry survives', async () => {
    jest.resetModules();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-rc-'));
    process.env.DATA_DIR = dir;
    const gw = require('../services/arbox_gateway'); gw.clearCache();
    membership(user({ phone: '0591000001' }));
    user({ role: 'lead', active: 1, phone: '0591000002' });
    user({ role: 'staffMember', active: 1, phone: '0591000003' });
    membership(user({ phone: '0591000004' }), { end: day(-3) });
    user({ role: 'aggregatorMember', active: 0, phone: '0591000005' });
    const cache = require('../utils/member_cache');
    const registry = require('../utils/phone_registry');
    // what the old seeding rule (active flag only) had put in the cache, plus one explicit staff decision
    cache.markConfirmed('972591000002', { role: 'lead', source: 'arbox_scheduled' });
    cache.markConfirmed('972591000003', { role: 'staffMember', source: 'arbox_scheduled' });
    cache.markConfirmed('972591000004', { role: 'client', source: 'arbox_live' });
    cache.markConfirmed('972599000009', { role: 'client', source: 'manual_conversion' });
    const out = await cache.seedFromArbox();
    expect(out).toMatchObject({ seeded: 2, removed: 3 });
    expect(cache.isConfirmed('972591000001')).toBe(true);
    expect(cache.isConfirmed('972591000005')).toBe(true);
    for (const p of ['972591000002', '972591000003', '972591000004']) expect(cache.isConfirmed(p)).toBe(false);
    expect(cache.isConfirmed('972599000009')).toBe(true);
    expect(cache.getEntry('972591000005').role).toBe('aggregatorMember');
    await registry.init({ timeoutMs: 5000 }); registry.stop();
    expect(registry.size()).toBe(2);
    expect(registry.isMember('0591000001')).toBe(true);
    expect(registry.isMember('0591000005')).toBe(true);
    for (const p of ['0591000002', '0591000003', '0591000004']) expect(registry.isMember(p)).toBe(false);
    // memberships unreadable: nobody is un-confirmed by a guess
    arbox.mode.membershipsDown = true; gw.clearCache();
    const again = await cache.seedFromArbox();
    expect(again.removed).toBe(0);
    expect(cache.isConfirmed('972591000001')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
