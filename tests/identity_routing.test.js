'use strict';
/**
 * identity_routing.test.js — the inbound pipeline routes by the ONE identity resolver.
 *
 * REAL: server.js pipeline, identity_resolver, phone_registry, member_cache, arbox_gateway
 * (HTTP against the LOCAL Arbox stand-in), tomer_service, lead store, inbox.
 * MOCKED: outbound WhatsApp (captured), OpenAI. Synthetic people only.
 */
const fs   = require('fs');
const path = require('path');
const { createArboxMock } = require('./helpers/arbox_mock.cjs');
const { waitFor } = require('./helpers/isolated_env.cjs');

process.env.TEST_MODE            = 'true';
process.env.WHATSAPP_AUTO_REPLY  = 'true';
process.env.BACKEND_URL          = 'https://panel.example.test';
process.env.ARBOX_TIMEOUT_MS     = '400';
process.env.ARBOX_MIN_GAP_MS     = '0';
process.env.ARBOX_VERIFY_DELAY_MS = '0';
process.env.ARBOX_LOCATION_ID    = '1';
delete process.env.ARBOX_WRITES_ENABLED;
delete process.env.ARBOX_TEST_ASSUME_CONTRACT;

const DATA_DIR   = process.env.DATA_DIR;
const CASES_FILE = path.join(DATA_DIR, 'service_cases.json');
const MANAGER    = '972509000001';
fs.writeFileSync(path.join(DATA_DIR, 'studio_assets.json'), JSON.stringify({ wazeUrl: 'https://waze.example.test/studio' }));

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// texts = sends to members · mgr = case alerts that reached the manager · alerts = alertOwner (system alarms)
const mockOut = { texts: [], alerts: [], mgr: [], seq: 0, mgrMode: 'ok', mgrCalls: 0, memberMode: 'ok' };
jest.mock('../services/whatsapp.service', () => {
  const actual = jest.requireActual('../services/whatsapp.service');
  return {
    ...actual,
    sendText: jest.fn((to, text, opts = {}) => {
      const fail = mode => {
        if (mode === 'reject')  { const e = new Error('Request failed with status code 400'); e.response = { status: 400 }; return Promise.reject(e); }
        if (mode === 'timeout') { const e = new Error('timeout of 15000ms exceeded'); e.code = 'ECONNABORTED'; return Promise.reject(e); }
        if (mode === 'noid')    return Promise.resolve({});
        if (mode === 'slow')    return new Promise(r => setTimeout(() => { const id = `MGR_${++mockOut.seq}`; mockOut.mgr.push({ text, id, opts }); r({ idMessage: id }); }, 150));
        return null;
      };
      if (to === '972509000001') {                                    // the one manager phone
        mockOut.mgrCalls++;
        const f = fail(mockOut.mgrMode); if (f) return f;
        const id = `MGR_${++mockOut.seq}`; mockOut.mgr.push({ text, id, opts }); return Promise.resolve({ idMessage: id });
      }
      const f = fail(mockOut.memberMode); if (f) return f;
      const id = `MSG_${++mockOut.seq}`; mockOut.texts.push({ to, text, id, opts }); return Promise.resolve({ idMessage: id });
    }),
    alertOwner: jest.fn((subject, body, opts = {}) => {
      const phone = '972509000001';
      const id = `ALERT_${++mockOut.seq}`;
      mockOut.alerts.push({ subject, body, id, linkPreview: opts.linkPreview });
      return Promise.resolve({ sent: 1, results: [{ phone, skipped: false, idMessage: id, error: null }] });
    }),
    sendFileByUrl: jest.fn(() => Promise.resolve({ idMessage: `FILE_${++mockOut.seq}` })),
  };
});
const mockAi = { queue: [], calls: 0, fallback: 'NEED_STAFF' };
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn(() => { mockAi.calls++; return Promise.resolve({ choices: [{ message: { content: mockAi.queue.length ? mockAi.queue.shift() : mockAi.fallback } }] }); }) } },
})));
jest.mock('../services/arbox.service', () => ({
  getMembers: jest.fn(() => Promise.resolve([])), getLeads: jest.fn(() => Promise.resolve([])), getAllUsers: jest.fn(() => Promise.resolve([])),
  getUpcomingClasses: jest.fn(() => Promise.resolve([])), getStaff: jest.fn(() => Promise.resolve([])), testConnection: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../services/greenapi.service', () => ({
  isConfigured: jest.fn(() => false), parseWebhook: jest.fn(() => null), syncToInbox: jest.fn(() => Promise.resolve({ chats: 0, messages: 0 })),
  sendText: jest.fn(() => Promise.resolve({ idMessage: 'GREEN_MOCK' })), sendFileByUrl: jest.fn(() => Promise.resolve({ idMessage: 'GREEN_MOCK' })),
}));
jest.mock('../services/handoff.service', () => ({ scoreReadiness: jest.fn(() => ({ level: 'MEDIUM' })), generateHandoffBrief: jest.fn(() => Promise.resolve({ briefData: {}, readiness: {}, briefLines: '' })) }));
jest.mock('../services/memory.service', () => ({ touchSession: jest.fn(), buildMemoryInjection: jest.fn(() => null), generateAndSaveSessionSummary: jest.fn(() => Promise.resolve()) }));
jest.mock('../utils/demo_capture', () => ({ record: jest.fn(), isActive: jest.fn(() => false) }));

const request = require('supertest');
const arbox = createArboxMock();
let app, store, cases, gateway, inbox;

function restart() {
  jest.resetModules();
  store   = require('../utils/lead_store');
  cases   = require('../utils/service_case_store');
  gateway = require('../services/arbox_gateway');
  inbox   = require('../utils/whatsapp_inbox');
  app     = require('../server');
}


const T0 = new Date('2026-11-16T08:00:00.000Z');                                // Monday 10:00 Israel time
const TODAY = '2026-11-16';
const day = n => new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
let uid = 3000, mid = 70000, msgSeq = 0, identity, memberCache;

function person({ role = 'client', active = 1, phone, first = 'דנה' }) {
  const id = ++uid;
  arbox.state.users.push({ user_id: id, first_name: first, last_name: 'בדיקה', phone, user_role: role, active, gender: 'female' });
  return id;
}
function plan(userId, { start = day(-40), end = day(40), active = 1, cancelled = 0 } = {}) {
  arbox.state.memberships.push({ membership_user_id: ++mid, user_id: userId, membership_type_id: 1, membership_type_name: 'מנוי חודשי', type: 'plan', start_time: start, end_time: end, active, cancelled, debt: 0, created_at: `${start} 09:00` });
}
async function say(phone, text) {
  const res = await request(app).post('/api/whatsapp/simulate').send({ from: phone, text, name: 'WA Profile', messageId: `ir-${++msgSeq}`, timestamp: new Date().toISOString() }).set('Content-Type', 'application/json');
  if (res.status !== 200) throw new Error(`simulate ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}
const textsTo = p => mockOut.texts.filter(t => t.to === p).map(t => t.text);
const TOMER_INTRO = /אני תומר, העוזר הדיגיטלי/;

function world() {
  for (const f of ['service_cases.json', 'leads_persist.json', 'inbox_persist.json', 'tomer_audit.json', 'member_cache.json', 'identity_directory.json']) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* absent */ } }
  arbox.reset();
  arbox.state.membershipTypes.push({ membership_type_id: 1, membership_type_name: 'מנוי חודשי', type: 'plan', is_recurring_payment: 1 });
  mockOut.texts.length = 0; mockOut.mgr.length = 0; mockOut.alerts.length = 0; mockAi.queue.length = 0; mockAi.fallback = 'היי! אשמח לעזור 😊 מה מחפשים?';
  process.env.TOMER_MODE = 'all'; delete process.env.TOMER_TEST_ONLY_PHONES; delete process.env.TOMER_TEST_ROUTE_OVERRIDE; process.env.TOMER_MANAGER_PHONE = MANAGER;
  restart();
  identity = require('../services/identity_resolver').shared();
  memberCache = require('../utils/member_cache');
}

beforeAll(async () => {
  jest.useFakeTimers({ now: T0, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
  process.env.ARBOX_BASE_URL = await arbox.listen();
});
afterAll(async () => { jest.useRealTimers(); await arbox.close(); process.env.TOMER_MODE = 'all'; });

describe('Routing follows the one identity resolver', () => {
  test('a client with a currently valid membership → Tomer', async () => {
    world();
    plan(person({ phone: '0507100001' }));
    const r = await say('972507100001', 'מה הכתובת של הסטודיו?');
    expect(r.clientMatch.identity).toMatchObject({ category: 'member', stale: false });
    expect(r.route).toMatch(/^tomer_/);
    expect(textsTo('972507100001').join(' ')).toMatch(TOMER_INTRO);
  });

  test('a LEAD with the Arbox active flag is a lead (was a "member" under the old cache rule) → Barak, never Tomer', async () => {
    world();
    person({ role: 'lead', active: 1, phone: '0507200001', first: 'ליד' });
    // exactly what production held before the fix: the lead cached as a confirmed member
    memberCache.markConfirmed('972507200001', { role: 'lead', source: 'arbox_scheduled' });
    const r = await say('972507200001', 'היי, אני מחפשת פילאטיס מכשירים');
    expect(r.clientMatch.identity.category).toBe('lead');
    expect(r.clientMatch.matchType).toBe('lead');
    expect(r.route).not.toMatch(/^tomer/);
    expect(r.route).not.toBe('staff_bypass');
    expect(textsTo('972507200001').join(' ')).not.toMatch(TOMER_INTRO);
    expect(cases.list({ phone: '972507200001' })).toHaveLength(0);
    expect(store.getLead('972507200001')).toBeTruthy();                        // handled in the lead world
    expect(store.getLead('972507200001').status).not.toBe('converted_member');
  });

  test('a client row with the active flag but NO membership is not a member → Barak', async () => {
    world();
    person({ phone: '0507300001', active: 1 });
    const r = await say('972507300001', 'כמה עולה מנוי?');
    expect(r.clientMatch.identity).toMatchObject({ category: 'lead', reason: 'client_row_without_membership' });
    expect(r.route).not.toMatch(/^tomer/);
  });

  test('unknown number with studio interest → Barak; unknown number without it → neutral unclassified hold (unchanged)', async () => {
    world();
    const a = await say('972507400001', 'היי, רוצה להצטרף לשיעור ניסיון');
    expect(a.clientMatch.identity.category).toBe('unknown');
    expect(a.route).not.toMatch(/^tomer/);
    const b = await say('972507400002', 'שלום');
    expect(b.route).toBe('unclassified');
  });

  test('former member: identified, history kept, renewal interest → Barak', async () => {
    world();
    plan(person({ phone: '0507500001', first: 'רונית' }), { start: day(-200), end: day(-20) });
    // her old lead record was parked while she was a member, with its conversation history
    store.upsertLead('972507500001', { name: 'רונית', status: 'converted_member', messageCount: 4, history: [{ role: 'user', content: 'היי' }, { role: 'assistant', content: 'שלום!' }], meta: { isConfirmedMember: true } });
    const r = await say('972507500001', 'היי, אני רוצה לחדש את המנוי, כמה זה עולה היום?');
    expect(r.clientMatch.identity.category).toBe('former_member');
    expect(r.clientMatch).toMatchObject({ matchType: 'former_member', isActive: false });
    expect(r.route).not.toMatch(/^tomer/);
    expect(r.route).not.toBe('former_member_staff');
    const lead = store.getLead('972507500001');
    expect(lead.status).not.toBe('converted_member');                          // reopened for Barak
    expect(lead.meta).toMatchObject({ formerMember: true });
    expect(lead.meta.reopenedFromConvertedMemberAt).toBeTruthy();
    expect((lead.history ?? []).slice(0, 2)).toEqual([{ role: 'user', content: 'היי' }, { role: 'assistant', content: 'שלום!' }]);   // history preserved
    expect(textsTo('972507500001').join(' ')).not.toMatch(TOMER_INTRO);
    expect(mockOut.alerts.filter(a => /חבר\/ה לשעבר/.test(a.subject))).toHaveLength(0);
  });

  test('former member with a billing / service issue → staff: one alert, an honest acknowledgement, no Barak and no Tomer', async () => {
    world();
    plan(person({ phone: '0507600001', first: 'מיכל' }), { start: day(-200), end: day(-20) });
    const ai0 = mockAi.calls;
    const r = await say('972507600001', 'חייבתם אותי פעמיים החודש, אני רוצה החזר כספי');
    expect(r.clientMatch.identity.category).toBe('former_member');
    expect(r.route).toBe('former_member_staff');
    expect(textsTo('972507600001')).toEqual(['קיבלנו את הודעתך 🙏 הפנייה נרשמה לטיפול צוות הסטודיו.']);
    const alerts = mockOut.alerts.filter(a => /חבר\/ה לשעבר/.test(a.subject));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toMatch(/אין מנוי בתוקף/);
    expect(mockAi.calls).toBe(ai0);                                            // no sales model call
    expect(cases.list({ phone: '972507600001' })).toHaveLength(0);             // not a Tomer member case
  });

  test('Arbox staff who are not in the local roster → staff bypass: stored, nothing sent, never Barak', async () => {
    world();
    person({ role: 'staffMember', active: 1, phone: '0507700001', first: 'מדריכה' });
    const ai0 = mockAi.calls;
    const r = await say('972507700001', 'היי, כמה עולה מנוי אצלכם?');
    expect(r.route).toBe('staff_bypass');
    expect(r.clientMatch.identity.category).toBe('staff');
    expect(textsTo('972507700001')).toHaveLength(0);
    expect(mockAi.calls).toBe(ai0);
    expect(store.getLead('972507700001')).toBeFalsy();
  });

  test('aggregator member is identified separately and keeps the existing member handling', async () => {
    world();
    person({ role: 'aggregatorMember', active: 0, phone: '0507800001' });
    const r = await say('972507800001', 'מה הכתובת של הסטודיו?');
    expect(r.clientMatch.identity.category).toBe('aggregator');
    expect(r.clientMatch).toMatchObject({ matchType: 'member', role: 'aggregatorMember' });
    expect(r.route).toMatch(/^tomer/);
  });

  test('shared phone: a member and a lead on one number → member, with the conflict recorded', async () => {
    world();
    person({ role: 'lead', active: 1, phone: '0507900001' }); plan(person({ phone: '050-7900001' }));
    const r = await say('972507900001', 'מה הכתובת של הסטודיו?');
    expect(r.clientMatch.identity).toMatchObject({ category: 'member', shared: true, others: ['lead'] });
    expect(r.route).toMatch(/^tomer_/);
  });

  test('Arbox unreadable: an unknown contact is HELD (not sent to Barak); a known member is still served; a lead confirmed minutes ago passes', async () => {
    world();
    plan(person({ phone: '0508000001' }));
    person({ role: 'lead', active: 1, phone: '0508000002' });
    await say('972508000002', 'היי, מחפשת פילאטיס');                            // fresh data: confirmed as a lead
    await identity.refresh();
    arbox.mode.down = true; gateway.clearCache();
    jest.setSystemTime(new Date(T0.getTime() + 5 * 60 * 1000));
    const ai0 = mockAi.calls;
    const unknown = await say('972508000003', 'היי, רוצה להצטרף לפילאטיס');
    expect(unknown.route).toBe('arbox_outage_hold');
    expect(unknown.clientMatch.identity).toMatchObject({ refreshFailed: true });
    expect(mockAi.calls).toBe(ai0);
    const member = await say('972508000001', 'מה הכתובת של הסטודיו?');
    expect(member.clientMatch.identity).toMatchObject({ category: 'member', stale: true });
    expect(member.route).toMatch(/^tomer_/);
    const lead = await say('972508000002', 'ומה המחיר?');
    expect(lead.route).not.toBe('arbox_outage_hold');
    expect(lead.route).not.toMatch(/^tomer/);
    jest.setSystemTime(T0);
  });

  test('test-only mode is unchanged: a real member is not opened to the new Tomer service; the synthetic override phone still is', async () => {
    world();
    plan(person({ phone: '0508100001' }));
    delete process.env.TOMER_MODE; process.env.TOMER_TEST_ONLY_PHONES = '972537605023'; process.env.TOMER_TEST_ROUTE_OVERRIDE = 'true';
    const real = await say('972508100001', 'אני רוצה להקפיא את המנוי');
    expect(real.clientMatch.identity.category).toBe('member');
    expect(real.route).not.toMatch(/^tomer_/);                                  // not the new service
    expect(cases.list({ phone: '972508100001' })).toHaveLength(0);
    expect(textsTo('972508100001').join(' ')).not.toMatch(TOMER_INTRO);
    const test = await say('972537605023', 'אני רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    expect(test.route).toMatch(/^tomer_/);
    expect(cases.list({ phone: '972537605023', open: true })).toHaveLength(1);
    expect(arbox.writes()).toHaveLength(0);
  });
});
