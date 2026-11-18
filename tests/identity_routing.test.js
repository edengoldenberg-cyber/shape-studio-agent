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

  // Owner rule, 2026-11-18 (three such phones in production — the same name on a client row and on a lead row): the
  // phone is served by the member service, but nobody is picked automatically. General information is given; nothing
  // about "the" membership is shown and no action is taken until the owner settles the rows in Arbox.
  test('two Arbox rows on one phone: general information yes — membership details, class actions and Arbox requests no', async () => {
    world();
    person({ role: 'lead', active: 1, phone: '0507900002', first: 'אילנה', last: 'לוי' });
    plan(person({ phone: '050-7900002', first: 'אילנה', last: 'לוי' }), { end: day(25) });
    const gw = require('../services/arbox_gateway');
    expect(await gw.resolveMember('972507900002')).toMatchObject({ status: 'ambiguous', reason: 'several_rows_on_phone', count: 2 });
    expect((await gw.resolveMember('972507900002')).member).toBeUndefined();

    const a = await say('972507900002', 'מה הכתובת של הסטודיו?');
    expect(a.route).toMatch(/^tomer_/);
    expect(textsTo('972507900002').join('\n')).toMatch(/דרך השדה|waze/i);                      // general information is given

    mockOut.texts.length = 0; mockOut.mgr.length = 0;
    await say('972507900002', 'עד מתי המנוי שלי בתוקף?');
    const about = textsTo('972507900002').join('\n');
    expect(about).not.toMatch(/\d{1,2}\.\d{1,2}\.\d{4}|מנוי חודשי|בתוקף עד|כניסות/);          // no detail of a membership
    expect(about).not.toMatch(/אילנה/);                                                         // nobody is addressed as the member

    mockOut.texts.length = 0;
    const calls0 = arbox.state.writes?.length ?? 0;
    await say('972507900002', 'אפשר להעביר אותי מהשיעור של מחר ב-18:00 לשיעור של 19:00?');
    await say('972507900002', 'כן');
    expect(arbox.state.writes?.length ?? 0).toBe(calls0);                                       // nothing was requested from Arbox
    const reply = textsTo('972507900002').join('\n');
    expect(reply).not.toMatch(/נרשמת|רשמתי אותך|הועברת|בוטל|ביטלתי/);                          // no claim that anything was done
    expect(reply).toMatch(/העברתי את הבקשה לצוות/);
    const cases = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'service_cases.json'), 'utf8')).cases.filter(c => c.phone === '972507900002');
    const tasks = require('../utils/tomer_store').getTasks({ phone: '972507900002' });
    expect(cases.length + tasks.length).toBeGreaterThanOrEqual(1);                              // the request went to the staff
    expect(mockOut.mgr.length + mockOut.alerts.length).toBeGreaterThanOrEqual(1);
  });

  test('one Arbox row on the phone is still identified and served as before', async () => {
    world();
    plan(person({ phone: '050-7900003', first: 'נועה', last: 'כהן' }), { end: day(25) });
    expect(await require('../services/arbox_gateway').resolveMember('972507900003')).toMatchObject({ status: 'found', member: { firstName: 'נועה' } });
    // an INACTIVE second row does not make the phone unclear
    person({ role: 'lead', active: 0, phone: '0507900003', first: 'נועה', last: 'כהן' });
    require('../services/arbox_gateway').clearCache();
    expect(await require('../services/arbox_gateway').resolveMember('972507900003')).toMatchObject({ status: 'found' });
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

// ═══════════════════════════════════════════════════════════════════════════════
// Owner acceptance list, 2026-11-18 — information and customer management, through the real pipeline against the local
// Arbox stand-in. Nothing is sent to a customer outside the captured stand-in sends.
describe('Members, leads, live availability and the management screens', () => {
  const scheduleReads = () => arbox.log.filter(l => l.path === '/v3/schedule').length;
  const seed = () => arbox.state.schedule.push(
    { schedule_id: 11, date: day(1), start_time: '09:00', end_time: '10:00', session_name: 'פילאטיס מכשירים', staff_member: { name: 'מלאני לוי' }, max_participants: 10, registration_count: 7 },
    { schedule_id: 12, date: day(1), start_time: '19:00', end_time: '20:00', session_name: 'פילאטיס מכשירים', staff_member: { name: 'עדן גל' }, max_participants: 10, registration_count: 10, standby_members: 2 });
  const json = (method, url, body) => request(app)[method](url).send(body ?? {}).set('Content-Type', 'application/json');

  test("a member's message goes to Tomer and creates no sales lead: not in the leads list, no score, no sales action", async () => {
    world();
    plan(person({ phone: '0507110001' }));
    const r = await say('972507110001', 'מה הכתובת של הסטודיו?');
    expect(r.route).toMatch(/^tomer_/);
    const leads = (await request(app).get('/api/leads')).body;
    expect(leads.filter(l => l.kind === 'member')).toEqual([]);
    const rec = require('../utils/lead_store').getLead('972507110001');
    if (rec) { expect(rec.score ?? 0).toBeLessThanOrEqual(4); expect(rec.meta?.qualProfile ?? null).toBeNull(); }
    const kinds = (await request(app).get('/api/leads/kinds')).body;
    expect(kinds.ok).toBe(true);
    expect(kinds.inSalesList).toBe(leads.length);
  });

  test('a lead and a member with lead records: only the leads are in the sales list, each record carries its kind', async () => {
    world();
    plan(person({ phone: '0507110002' }));
    person({ role: 'lead', active: 1, phone: '0507110003' });
    const store = require('../utils/lead_store');
    store.upsertLead('972507110002', { status: 'human_owns', score: 4, meta: { humanOwnsReason: 'staff_manual_reply' } });   // the staff answered a member by hand
    await say('972507110003', 'היי, מתעניינת בפילאטיס מכשירים');
    await say('972507110004', 'היי, מתעניינת בפילאטיס מכשירים');                                                           // not in Arbox at all
    const list = (await request(app).get('/api/leads')).body, all = (await request(app).get('/api/leads?all=1')).body;
    expect(list.map(l => l.kind).sort()).toEqual(['lead', 'trial']);
    expect(all.map(l => l.kind).sort()).toEqual(['lead', 'member', 'trial']);
    expect(all.find(l => l.kind === 'member').kindLabel).toBe('מנוי');
    // the reconcile pass takes the sales score off the member record and keeps its ownership
    app._reconcileLeads('test');
    expect(store.getLead('972507110002')).toMatchObject({ status: 'human_owns', score: 0, meta: { notSalesLead: { kind: 'member' }, humanOwnsReason: 'staff_manual_reply' } });
    expect(store.getActiveLeads().map(l => l.phone)).not.toContain('972507110002');
    expect(store.getSendableLeads().map(l => l.phone)).not.toContain('972507110002');
  });

  test('an ordinary conversation reads no schedule; a question about room in a class reads that class now and answers with the live number', async () => {
    world(); seed();
    await say('972507110005', 'היי, מתעניינת בפילאטיס מכשירים');
    await say('972507110005', 'אני מחפשת משהו לחיזוק הגב');
    expect(scheduleReads()).toBe(0);
    const r = await say('972507110005', 'יש מקום מחר ב-9:00 בפילאטיס מכשירים?');
    expect(scheduleReads()).toBe(1);
    expect(r.barakReply).toMatch(/נכון לרגע זה לפי Arbox/);
    expect(r.barakReply).toMatch(/09:00 \| פילאטיס מכשירים.*יש מקום \(3 מתוך 10 פנויים\)/);
    expect(r.barakReply).not.toMatch(/19:00/);
    const full = await say('972507110005', 'ויש מקום מחר ב-19:00 בפילאטיס מכשירים?');
    expect(full.barakReply).toMatch(/מלא כרגע, 2 ברשימת המתנה/);
  });

  test('a missing detail is the only thing asked; Arbox without occupancy or unreachable → "cannot verify", never full / free / zero', async () => {
    world(); seed();
    await say('972507110006', 'היי, מתעניינת בפילאטיס מכשירים');
    const ask = await say('972507110006', 'יש מקום בשיעור פילאטיס מכשירים?');
    expect(ask.barakReply).toMatch(/חסר לי רק: יום/);
    const hour = await say('972507110006', 'יש מקום מחר בפילאטיס מכשירים?');
    expect(hour.barakReply).toMatch(/חסר לי רק: שעה/);
    expect(hour.barakReply).toMatch(/09:00 \| פילאטיס מכשירים/);
    expect(hour.barakReply).not.toMatch(/פנויים|מלא/);
    arbox.mode.occupancyDown = true; gateway.clearCache();
    const noOcc = await say('972507110006', 'יש מקום מחר ב-9:00 בפילאטיס מכשירים?');
    expect(noOcc.barakReply).toMatch(/לא הצלחתי לאמת כרגע את התפוסה/);
    arbox.mode.occupancyDown = false;
  });

  test('knowledge through the panel endpoints: restore → waiting for the owner → confirm; the sync answer is operational, not "success"', async () => {
    for (const f of ['staff_directory.json', 'classes_knowledge.json']) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* absent */ } }   // as in production before the restore
    world(); seed();
    const st0 = (await request(app).get('/api/admin/knowledge/status')).body;
    expect(st0.summary.rows.find(r => r.id === 'staff').state).toBe('empty');
    const res = await json('post', '/api/admin/knowledge/restore', { type: 'staff' });
    expect(res.body).toMatchObject({ ok: true, restored: 14 });
    const st1 = res.body.summary.rows.find(r => r.id === 'staff');
    expect(st1.state).toBe('partial');
    expect(st1.text).toMatch(/טרם אושרו/);
    const sync = (await json('post', '/api/admin/sync-agent-knowledge')).body;
    expect(sync.summary.state).toBe('partial');                                   // not a blanket success
    expect(sync.summary.rows.find(r => r.id === 'classes').state).toBe('empty');
    const conf = (await json('post', '/api/admin/knowledge/confirm', { type: 'staff' })).body;
    expect(conf.summary.rows.find(r => r.id === 'staff').state).toBe('ok');
    // the owner edits and saves; a restore over it is refused — newer information is never overwritten
    const cur = require('../agents/barak_agent').getRawKnowledge().staff;
    await json('post', '/api/admin/knowledge/staff', { ...cur, instructors: cur.instructors.slice(0, 3) });
    const again = await json('post', '/api/admin/knowledge/restore', { type: 'staff' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, error: 'newer_information_exists' });
    expect(require('../agents/barak_agent').getRawKnowledge().staff.instructors).toHaveLength(3);
  });

  test("the members board and the owner's tasks answer from the real stores", async () => {
    world();
    plan(person({ phone: '0507110007', first: 'נועה' }), { start: day(-10), end: day(5) });
    plan(person({ phone: '0507110008', first: 'מיכל' }));
    const b = (await request(app).get('/api/tomer/members-board')).body;
    expect(b.ok).toBe(true);
    expect(b.groups.find(g => g.id === 'active').count).toBe(2);
    expect(b.groups.find(g => g.id === 'expiring').count).toBe(1);
    expect(b.groups.find(g => g.id === 'first_month').count).toBe(1);
    expect(b.groups.every(g => g.rule && g.source)).toBe(true);
    const id = b.members.find(m => m.groups.includes('expiring')).userId;
    const card = (await request(app).get(`/api/tomer/members-board/${id}`)).body;
    expect(card).toMatchObject({ ok: true, member: { userId: String(id) } });
    await say('972507110007', 'אני רוצה להקפיא את המנוי מ-1.12 עד 15.12');           // opens a case for the staff
    const ot = (await request(app).get('/api/owner-tasks')).body;
    expect(ot.ok).toBe(true);
    expect(ot.open.some(t => t.key.startsWith('case:') && t.agent === 'tomer')).toBe(true);
    expect(ot.reminders.state).toBe('needs_settings');                              // nothing is sent until the owner sets the times
    const key = ot.open.find(t => t.key.startsWith('case:')).key;
    const done = (await json('post', '/api/owner-tasks/act', { key, action: 'done', by: 'עדן' })).body;
    expect(done).toMatchObject({ ok: true, task: { state: 'done' } });
    expect((await request(app).get('/api/owner-tasks')).body.open.map(t => t.key)).not.toContain(key);
    const cases = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'service_cases.json'), 'utf8')).cases;
    expect(cases.find(c => `case:${c.id}` === key).status).toBe('resolved');        // the owner's word is recorded on the case too
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Live test on production, 2026-11-18 11:35, from the owner's Arbox test member:
//   1. "היי אני רוצה להשתבץ לשיעור היום בשעה 18"  → Tomer asked "שיעור, מנוי, תשלום או משהו אחר?"
//   2. "אני רוצה להשתבץ לאימון כוח בשעה 18"       → "מצטער על התקלה", the app, an "app problem" case
// Cause: "להשתבץ" was not a registration verb, so the class flow never ran (nothing was read from Arbox); the second
// message was filed as an app problem because it held the word "אימון". The schedule below is that day's: at 18:00
// there are ALL IN and Pilates Barre (full); strength is at 17:00, 19:00 and 20:00.
describe('A registration request in two messages (live failure 2026-11-18)', () => {
  const P = '972507120001';
  const tasksOf = p => require('../utils/tomer_store').getTasks({ phone: p, type: 'class_change' });
  const casesOf = p => { try { return JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')).cases.filter(c => c.phone === p); } catch { return []; } };
  const reads = re => arbox.log.filter(l => l.method === 'GET' && re.test(l.path)).length;
  const cls = (id, start, name, registered, cap, who = 'מירי כהן') => ({ schedule_id: id, date: day(0), start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, session_name: name, staff_member: { name: who }, max_participants: cap, registration_count: registered });
  function setup(phone = P) {
    world();
    for (const t of require('../utils/tomer_store').getOpenTasks()) require('../utils/tomer_store').resolveTask(t.id, { resolutionNote: 'test reset', resolvedBy: 'test' });   // the task file is shared by the whole suite
    const id = person({ phone: '0' + phone.slice(3), first: 'בדיקה' });
    plan(id, { start: day(0), end: null });
    arbox.state.schedule.push(cls(21, '17:00', 'אימון כח', 5, 10), cls(22, '18:00', 'ALL IN', 3, 10, 'נוי לוי'), cls(23, '18:00', 'פילאטיס בר', 8, 8, 'דנה גל'), cls(24, '19:00', 'אימון כח', 5, 10), cls(25, '20:00', 'אימון כח', 0, 10));
    return id;
  }
  const last = p => textsTo(p).at(-1) ?? '';

  test('message 1 is a registration request: the class at 18:00 is read from Arbox and only the missing detail (the type) is asked', async () => {
    setup();
    const r = await say(P, 'היי אני רוצה להשתבץ לשיעור היום בשעה 18');
    expect(r.route).toMatch(/^tomer/);
    expect(last(P)).toMatch(/ב-18:00 היום יש ALL IN ופילאטיס בר\. איזה שיעור התכוונת\?/);
    expect(last(P)).not.toMatch(/לרשום אותך/);                                    // it must not sound as if the registration is about to be made
    expect(mockOut.alerts).toHaveLength(0);                                       // a detail the member can supply: the manager is not alerted yet
    expect(last(P)).not.toMatch(/שיעור, מנוי, תשלום|תקלה|אפליקצי/);
    expect(reads(/\/v3\/schedule/)).toBeGreaterThan(0);                            // the exact day was read
    expect(tasksOf(P).filter(t => t.status === 'open')).toHaveLength(1);
    expect(tasksOf(P)[0]).toMatchObject({ kind: 'book', missing: 'target_type' });
    expect(casesOf(P)).toHaveLength(0);                                           // no "unknown request" case
    expect(arbox.writes()).toHaveLength(0);
  });

  test('message 2 completes the SAME request with the day and hour kept; a class that does not exist is said so, with what there is — never a "fault", never the app', async () => {
    setup();
    await say(P, 'היי אני רוצה להשתבץ לשיעור היום בשעה 18');
    await say(P, 'אני רוצה להשתבץ לאימון כוח בשעה 18');
    const t = last(P);
    expect(t).toMatch(/לא מצאתי ב-Arbox אימון כח ב-18:00 היום\./);
    expect(t).toMatch(/אימון כח יש היום ב-17:00, 19:00 ו-20:00\./);
    expect(t).toMatch(/ב-18:00 יש ALL IN ופילאטיס בר\./);
    expect(t).toMatch(/איזה שיעור התכוונת\?.*עדיין לא נרשמת/);
    expect(t).not.toMatch(/תקלה|אפליקצי|העברתי|רשמתי את הבקשה/);                    // nothing was handed over yet, and it is not claimed
    const open = tasksOf(P).filter(x => x.status === 'open');
    expect(open).toHaveLength(1);                                                 // one request, not two
    expect(open[0]).toMatchObject({ kind: 'book', missing: 'target_class' });
    expect(open[0].memberMessage).toMatch(/היום בשעה 18.*אימון כוח בשעה 18/s);
    expect(casesOf(P)).toHaveLength(0);
    expect(mockOut.alerts).toHaveLength(0);                                       // still being clarified: no alert
    // on the board it waits for the MEMBER: it is not among what needs the owner, and not in his reminders
    const bd = (await request(app).get('/api/tomer/board')).body;
    expect(bd.items.find(x => x.key === `task:${open[0].id}`)).toMatchObject({ board: 'waiting_member', assignee: 'תומר' });
    expect(bd.today.needsOwner).not.toContain(`task:${open[0].id}`);
    expect(bd.today.tomerCan).toContain(`task:${open[0].id}`);

    // the member picks an existing class: the request is complete, handed to the staff, and said exactly so
    await say(P, 'ב-19');
    const done = last(P);
    expect(done).toMatch(/קיבלתי את הבקשה: רישום לאימון כח ב-19:00 היום\./);
    expect(done).not.toMatch(/מקומות פנויים|מקום פנוי/);                           // the count is told when the member asks about room, not here
    expect(done).toMatch(/העברתי את הבקשה לצוות\./);
    expect(done).toMatch(/עדיין לא נרשמת: הצוות יאשר לך כאן\./);
    expect(done).not.toMatch(/תקלה|אפליקצי|מצטער/);
    const fin = tasksOf(P).filter(x => x.status === 'open');
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({ kind: 'book', missing: null, alert: { state: 'sent' } });
    expect(fin[0].detail).toMatch(/שיעור מבוקש \(Arbox\): אימון כח 19:00 .* 5\/10 רשומים, 5 פנויים/);
    expect(fin[0].detail).toMatch(/מנוי בתוקף \(Arbox\): מנוי חודשי/);
    const bd2 = (await request(app).get('/api/tomer/board')).body;                // now it is the owner's
    expect(bd2.items.find(x => x.key === `task:${fin[0].id}`)).toMatchObject({ board: 'waiting_owner', assignee: 'עדן', userId: expect.anything() });
    expect(bd2.today.needsOwner).toContain(`task:${fin[0].id}`);
    expect(bd2.counts.needsOwner).toBe(bd2.today.needsOwner.length);
    const alert = mockOut.alerts.at(-1);
    expect(mockOut.alerts).toHaveLength(1);                                       // ONE alert, when the request is ready for the owner
    expect(alert.subject).toMatch(/^📌 תומר: רישום לשיעור/);
    expect(alert.body).toMatch(/בקשה: רישום לאימון כח ב-19:00 היום/);
    expect(alert.body).toMatch(/לא בוצע שום שינוי ב-Arbox/);
    expect(reads(/\/v3\/users\/memberships/)).toBeGreaterThan(0);
    expect(reads(/bookingsReport/)).toBeGreaterThan(0);
    expect(arbox.writes()).toHaveLength(0);                                       // Arbox writes are off: nothing was sent
  });

  test('a complete request in one message goes straight to the staff; the type alone is enough when it names one class', async () => {
    setup('972507120002');
    await say('972507120002', 'אני רוצה להשתבץ לאימון כוח היום בשעה 19');
    expect(last('972507120002')).toMatch(/קיבלתי את הבקשה: רישום לאימון כח ב-19:00 היום\.[\s\S]*העברתי את הבקשה לצוות\.[\s\S]*עדיין לא נרשמת/);
    expect(tasksOf('972507120002').filter(x => x.status === 'open')).toHaveLength(1);
    setup('972507120003');
    await say('972507120003', 'אני רוצה להשתבץ לשיעור היום בשעה 18');
    await say('972507120003', 'ALL IN');                                           // the answer to "לאיזה מהם?"
    expect(last('972507120003')).toMatch(/קיבלתי את הבקשה: רישום לALL IN ב-18:00 היום\.[\s\S]*העברתי את הבקשה לצוות/);
    expect(tasksOf('972507120003').filter(x => x.status === 'open')).toHaveLength(1);
  });

  test('the staff were NOT reached: the member is told the request is recorded, not that it was passed on', async () => {
    setup('972507120004');
    require('../services/whatsapp.service').alertOwner.mockImplementation(() => Promise.resolve({ sent: 0, results: [{ phone: MANAGER, skipped: false, idMessage: null, error: 'provider refused' }] }));
    await say('972507120004', 'אני רוצה להשתבץ לאימון כוח היום בשעה 19');
    const t = last('972507120004');
    expect(t).toMatch(/רשמתי את הבקשה לטיפול הצוות\./);
    expect(t).not.toMatch(/העברתי/);
    expect(t).toMatch(/עדיין לא נרשמת/);
    expect(tasksOf('972507120004').find(x => x.status === 'open')).toMatchObject({ alert: { state: 'failed', error: 'provider refused' } });
  });

  test('the clarification is stuck: after 30 minutes without an answer the manager is told once; nothing is sent to the member', async () => {
    setup('972507120006');
    await say('972507120006', 'היי אני רוצה להשתבץ לשיעור היום בשעה 18');
    const sentToMember = textsTo('972507120006').length;
    const store2 = require('../utils/tomer_store');
    const t = tasksOf('972507120006').find(x => x.status === 'open');
    expect(mockOut.alerts).toHaveLength(0);
    jest.setSystemTime(new Date(T0.getTime() + 31 * 60 * 1000));
    try {
      await app._memberHandoff.retryFailedAlerts();                              // what the 15-minute job runs
      expect(mockOut.alerts).toHaveLength(1);
      expect(mockOut.alerts[0].subject).toMatch(/רישום לשיעור — .*\(הבירור נתקע\)/);
      expect(mockOut.alerts[0].body).toMatch(/לא התקבלה תשובה בתוך 30 דקות/);
      await app._memberHandoff.retryFailedAlerts();
      expect(mockOut.alerts).toHaveLength(1);                                     // once
      expect(textsTo('972507120006')).toHaveLength(sentToMember);                 // the member is not messaged
      expect(store2.getTasks({ phone: '972507120006', type: 'class_change' }).find(x => x.id === t.id).status).toBe('open');
    } finally { jest.setSystemTime(T0); }
  });

  test('after "במה מדובר?" a class word is a topic, not a fault: no "מצטער על התקלה", no app-problem case', async () => {
    setup('972507120005');
    await say('972507120005', 'אפשר עזרה בבקשה');
    expect(last('972507120005')).toMatch(/שיעור, מנוי, תשלום או משהו אחר/);
    await say('972507120005', 'שיעור');
    expect(last('972507120005')).toMatch(/רשמתי פנייה לצוות עם מה שכתבת\. שום רישום לא השתנה\./);
    expect(last('972507120005')).not.toMatch(/תקלה|אפליקצי/);
    expect(casesOf('972507120005').map(c => c.category)).toEqual(['general_request']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Second live test, 2026-11-18 12:03–12:05 (same member, same day's schedule):
//   א. "אני רוצה להשתבץ לשיעור היום בשעה 18"   → ALL IN / פילאטיס בר offered (right), the manager alerted (too early)
//   ב. "מי מעביר את השיעורים?"                  → a timetable of several days (the two classes just offered were forgotten)
//   ג. "יש מקום היום לפילאטיס בר?"              → taken as the CHOICE of a class: the request went to the staff for Pilates Barre
//   ד. "אתה יכול לרשום אותי לall in?"           → the task changed to ALL IN silently: the staff's last alert still said Pilates Barre
describe('A registration conversation with questions in the middle (live failure 2026-11-18 12:03)', () => {
  const tasksOf = p => require('../utils/tomer_store').getTasks({ phone: p, type: 'class_change' });
  const openOf = p => tasksOf(p).filter(t => t.status === 'open');
  const casesOf = p => { try { return JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')).cases.filter(c => c.phone === p); } catch { return []; } };
  const cls = (id, start, name, registered, cap, who) => ({ schedule_id: id, date: day(0), start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, session_name: name, staff_member: { name: who }, max_participants: cap, registration_count: registered });
  function setup(phone) {
    world();
    for (const t of require('../utils/tomer_store').getOpenTasks()) require('../utils/tomer_store').resolveTask(t.id, { resolutionNote: 'test reset', resolvedBy: 'test' });
    plan(person({ phone: '0' + phone.slice(3), first: 'בדיקה' }), { start: day(0), end: null });
    arbox.state.schedule.push(cls(31, '17:00', 'אימון כח', 5, 10, 'מירי כהן'), cls(32, '18:00', 'ALL IN', 3, 10, 'נוי לוי'), cls(33, '18:00', 'פילאטיס בר', 8, 8, 'דנה גל'), cls(34, '19:00', 'אימון כח', 5, 10, 'מירי כהן'));
  }
  const last = p => textsTo(p).at(-1) ?? '';

  test('the four messages: the question about instructors and the question about room are answered and change nothing; the explicit request uses the day and hour already given; ONE task, ONE alert', async () => {
    const P = '972507130001'; setup(P);
    // א
    await say(P, 'אני רוצה להשתבץ לשיעור היום בשעה 18');
    expect(last(P)).toMatch(/ב-18:00 היום יש ALL IN ופילאטיס בר\. איזה שיעור התכוונת\?/);
    expect(openOf(P)).toHaveLength(1);
    const id = openOf(P)[0].id;
    expect(mockOut.alerts).toHaveLength(0);
    // ב — who teaches them: the two classes that were just offered, from Arbox; the request still waits
    const rb = await say(P, 'מי מעביר את השיעורים?');
    expect(rb.route).toBe('tomer_handoff');
    expect(last(P)).toMatch(/לפי Arbox, היום:\n• ALL IN ב-18:00 — עם נוי לוי\n• פילאטיס בר ב-18:00 — עם דנה גל/);
    expect(last(P)).toMatch(/בקשת הרישום שלך עדיין ממתינה, ושום דבר לא נרשם\. איזה שיעור התכוונת\?/);
    expect(last(P)).not.toMatch(/17:00|19:00|אימון כח/);                             // not a timetable
    expect(openOf(P)[0]).toMatchObject({ id, missing: 'target_type' });
    expect(mockOut.alerts).toHaveLength(0);
    // ג — is there room in Pilates Barre: the live number for that class at the hour already given; NOT a choice
    await say(P, 'יש מקום היום לפילאטיס בר?');
    expect(last(P)).toMatch(/נכון לרגע זה, לפי Arbox, היום:\n• פילאטיס בר ב-18:00 — מלא כרגע \(8\/8\)/);
    expect(last(P)).not.toMatch(/העברתי|רשמתי את הבקשה|קיבלתי את הבקשה/);
    expect(last(P)).toMatch(/שום דבר לא נרשם/);
    expect(openOf(P)).toHaveLength(1);
    expect(openOf(P)[0]).toMatchObject({ id, missing: 'target_type' });             // still waiting for the member's choice
    expect(openOf(P)[0].summary).not.toMatch(/פילאטיס בר/);
    expect(mockOut.alerts).toHaveLength(0);
    expect(casesOf(P)).toHaveLength(0);
    // ד — the explicit request: ALL IN, today at 18:00 from the context; membership and room were read; staff, once
    await say(P, 'אתה יכול לרשום אותי לall in?');
    const d = last(P);
    expect(d).toMatch(/קיבלתי את הבקשה: רישום לALL IN ב-18:00 היום\./);
    expect(d).toMatch(/העברתי את הבקשה לצוות\./);
    expect(d).toMatch(/עדיין לא נרשמת: הצוות יאשר לך כאן\./);
    expect(d).not.toMatch(/תקלה|אפליקצי|מקומות פנויים|פילאטיס בר/);
    const fin = openOf(P);
    expect(fin).toHaveLength(1);                                                   // one request for the staff
    expect(fin[0]).toMatchObject({ id, kind: 'book', missing: null, alert: { state: 'sent' }, ctx: { target: { name: 'ALL IN', time: '18:00' } } });
    expect(fin[0].detail).toMatch(/שיעור מבוקש \(Arbox\): ALL IN 18:00 .* 3\/10 רשומים, 7 פנויים/);
    expect(fin[0].detail).toMatch(/מנוי בתוקף \(Arbox\)/);
    expect(mockOut.alerts).toHaveLength(1);                                        // one alert, for the ripe request
    expect(mockOut.alerts[0].subject).toMatch(/^📌 תומר: רישום לשיעור/);
    expect(mockOut.alerts[0].body).toMatch(/בקשה: רישום לALL IN ב-18:00 היום/);
    expect(mockOut.alerts[0].body).not.toMatch(/פילאטיס בר 18:00/);
    expect(arbox.writes()).toHaveLength(0);
  });

  test('the member changes the choice after the request reached the staff: the SAME request is updated and the staff are told it replaces the earlier one', async () => {
    const P = '972507130002'; setup(P);
    await say(P, 'תרשום אותי לALL IN היום ב-18');
    expect(mockOut.alerts).toHaveLength(1);
    await say(P, 'בעצם תרשום אותי לאימון כוח ב-19');
    expect(last(P)).toMatch(/עדכנתי את הבקשה: רישום לאימון כח ב-19:00 היום \(במקום ALL IN ב-18:00\)\./);
    expect(last(P)).toMatch(/עדיין לא נרשמת/);
    expect(openOf(P)).toHaveLength(1);
    expect(mockOut.alerts).toHaveLength(2);
    expect(mockOut.alerts[1].subject).toMatch(/^🔁 תומר — עדכון: רישום לשיעור/);
    expect(mockOut.alerts[1].body).toMatch(/מחליף את הבקשה הקודמת \(ALL IN ב-18:00\) — זו הבקשה היחידה שפתוחה/);
    await say(P, 'תרשום אותי לאימון כוח ב-19');                                      // the same request again: nothing new for the staff
    expect(mockOut.alerts).toHaveLength(2);
  });

  test.each([
    ['מי המדריכה?', /ALL IN ב-18:00 — עם נוי לוי[\s\S]*פילאטיס בר ב-18:00 — עם דנה גל/],
    ['עם מי השיעורים האלה', /ALL IN ב-18:00 — עם נוי לוי/],
    ['מי מלמדת את הALL IN?', /^לפי Arbox, היום:\n• ALL IN ב-18:00 — עם נוי לוי\n/],
    ['נשאר מקום בבר?', /פילאטיס בר ב-18:00 — מלא כרגע \(8\/8\)/],
    ['יש עוד מקום ב-ALL IN?', /ALL IN ב-18:00 — יש מקום \(7 מתוך 10 פנויים\)/],
    ['הפילאטיס בר מלא?', /פילאטיס בר ב-18:00 — מלא כרגע/],
    ['ויש מקום באימון כוח ב-19?', /אימון כח ב-19:00 — יש מקום \(5 מתוך 10 פנויים\)/],
  ])('a question in other words — "%s" — is answered from Arbox and leaves the waiting request as it was', async (q, re) => {
    const P = '972507130003'; setup(P);
    await say(P, 'אני רוצה להשתבץ לשיעור היום בשעה 18');
    const before = openOf(P)[0];
    await say(P, q);
    expect(last(P)).toMatch(re);
    expect(last(P)).toMatch(/איזה שיעור התכוונת\?$/);
    expect(openOf(P)).toHaveLength(1);
    expect(openOf(P)[0]).toMatchObject({ id: before.id, missing: 'target_type', summary: before.summary });
    expect(mockOut.alerts).toHaveLength(0);
    expect(casesOf(P)).toHaveLength(0);
  });

  test.each([
    ['ALL IN', /רישום לALL IN ב-18:00 היום/],
    ['אני אלך על ALL IN', /רישום לALL IN ב-18:00 היום/],
    ['אול אין בבקשה', /רישום לALL IN ב-18:00 היום/],
    ['תרשום אותי לאול אין', /רישום לALL IN ב-18:00 היום/],
    ['אני רוצה להירשם ל-ALL IN', /רישום לALL IN ב-18:00 היום/],
  ])('the choice in other words — "%s" — completes the same request with the day and hour kept', async (a, re) => {
    const P = '972507130004'; setup(P);
    await say(P, 'אני רוצה להשתבץ לשיעור היום בשעה 18');
    const id = openOf(P)[0].id;
    await say(P, a);
    expect(last(P)).toMatch(re);
    expect(last(P)).toMatch(/העברתי את הבקשה לצוות\.[\s\S]*עדיין לא נרשמת/);
    expect(openOf(P)).toHaveLength(1);
    expect(openOf(P)[0]).toMatchObject({ id, missing: null });
    expect(mockOut.alerts).toHaveLength(1);
  });

  test('a full class is said to be full in the request reply (without a count), and the request still goes to the staff as not done', async () => {
    const P = '972507130005'; setup(P);
    await say(P, 'תרשום אותי לפילאטיס בר היום ב-18');
    expect(last(P)).toMatch(/פילאטיס בר ב-18:00 היום מלא כרגע\./);
    expect(last(P)).not.toMatch(/8\/8|מקומות פנויים/);
    expect(last(P)).toMatch(/עדיין לא נרשמת/);
  });

  test('with no open request, "who teaches" is answered from Arbox for the class named, or asks which class', async () => {
    const P = '972507130006'; setup(P);
    await say(P, 'מי מעביר את האימון כוח היום ב-19?');
    expect(last(P)).toMatch(/לפי Arbox:\n• .* 19:00 אימון כח — עם מירי כהן/);
    await say(P, 'מי מעביר את השיעורים?');
    expect(last(P)).toMatch(/על איזה שיעור מדובר\?/);
    expect(openOf(P)).toHaveLength(0);
    expect(casesOf(P)).toHaveLength(0);
    expect(mockOut.alerts).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Class registration and cancellation are switched on for the owner's test phone only (2026-11-18, after the direct
// verification against Arbox). Through the full pipeline against the local Arbox stand-in.
describe('Registration carried out in Arbox for the test phone only', () => {
  const TESTER = '972507140001', OTHER = '972507140002';
  const tasksOf = p => require('../utils/tomer_store').getTasks({ phone: p, type: 'class_change' });
  const cls = (id, start, name, registered, cap, who) => ({ schedule_id: id, date: day(0), start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:00`, session_name: name, staff_member: { name: who }, max_participants: cap, registration_count: registered });
  const last = p => textsTo(p).at(-1) ?? '';
  let ids;
  function setup() {
    world();
    for (const t of require('../utils/tomer_store').getOpenTasks()) require('../utils/tomer_store').resolveTask(t.id, { resolutionNote: 'test reset', resolvedBy: 'test' });
    ids = { tester: person({ phone: '0' + TESTER.slice(3), first: 'בדיקה' }), other: person({ phone: '0' + OTHER.slice(3), first: 'מיכל' }) };
    plan(ids.tester, { start: day(0), end: null }); plan(ids.other);
    arbox.state.schedule.push(cls(41, '18:00', 'ALL IN', 3, 10, 'נוי לוי'), cls(42, '18:00', 'פילאטיס בר', 8, 8, 'דנה גל'), cls(43, '19:00', 'אימון כח', 5, 10, 'מירי כהן'));
    process.env.ARBOX_WRITES_ENABLED = 'true'; process.env.ARBOX_WRITE_OPS = 'class_book,class_cancel'; process.env.ARBOX_WRITE_TEST_PHONES = TESTER; delete process.env.ARBOX_WRITE_AUDIENCE;
  }
  afterEach(() => { delete process.env.ARBOX_WRITES_ENABLED; delete process.env.ARBOX_WRITE_OPS; delete process.env.ARBOX_WRITE_TEST_PHONES; });
  const posts = re => arbox.writes().filter(w => re.test(w.path));

  test('only what was verified is executable: booking and cancelling a class; late move, freeze and membership cancel stay off', () => {
    setup();
    const st = gateway.writeStatus();
    expect([st.class_book.executable, st.class_cancel.executable]).toEqual([true, true]);
    expect([st.class_move_late.executable, st.membership_hold.executable, st.membership_cancel.executable]).toEqual([false, false, false]);
  });

  test('the conversation: choice → the exact action is shown → a question in the middle confirms nothing → "כן" → booked in Arbox → "נרשמת" only after the read-back', async () => {
    setup();
    await say(TESTER, 'אני רוצה להשתבץ לשיעור היום בשעה 18');
    expect(last(TESTER)).toMatch(/ב-18:00 היום יש ALL IN ופילאטיס בר\. איזה שיעור התכוונת\?/);
    await say(TESTER, 'אתה יכול לרשום אותי לall in?');
    expect(last(TESTER)).toMatch(/רק לוודא לפני שאני משנה ב-Arbox:\nרישום לALL IN ב-18:00, היום, .*\nלאשר\?/);
    expect(arbox.writes()).toHaveLength(0);                                       // nothing is sent before the written "כן"
    await say(TESTER, 'יש מקום?');                                                // a question: not a confirmation
    expect(last(TESTER)).toMatch(/ALL IN ב-18:00 — יש מקום \(7 מתוך 10 פנויים\)/);
    expect(last(TESTER)).toMatch(/עדיין מחכה לאישור שלך: רישום לALL IN ב-18:00/);
    expect(arbox.writes()).toHaveLength(0);
    await say(TESTER, 'כן');
    expect(posts(/bookSession/)).toHaveLength(1);
    expect(posts(/bookSession/)[0].body).toMatchObject({ user_id: ids.tester, schedule_id: 41 });
    expect(last(TESTER)).toMatch(/בוצע ✅ נרשמת לALL IN ב-18:00 היום\.\nאימתתי את זה עכשיו מול Arbox\./);
    expect(arbox.state.bookings.filter(b => b.user_id === ids.tester)).toHaveLength(1);
    expect(tasksOf(TESTER).filter(t => t.status === 'open')).toHaveLength(0);     // done and verified: nothing waits for the staff
    expect(mockOut.alerts).toHaveLength(0);
    // a confirmation is for that action only: a "כן" afterwards does nothing
    await say(TESTER, 'כן');
    expect(posts(/bookSession/)).toHaveLength(1);
  });

  test('"כן" to one class is not a "כן" to another: a new request replaces the one that was waiting, and asks again', async () => {
    setup();
    await say(TESTER, 'תרשום אותי לALL IN היום ב-18');
    expect(last(TESTER)).toMatch(/רישום לALL IN ב-18:00[\s\S]*לאשר\?/);
    await say(TESTER, 'בעצם תרשום אותי לאימון כוח ב-19');
    expect(last(TESTER)).toMatch(/רישום לאימון כח ב-19:00[\s\S]*לאשר\?/);
    expect(arbox.writes()).toHaveLength(0);
    await say(TESTER, 'כן');
    expect(posts(/bookSession/).map(w => w.body.schedule_id)).toEqual([43]);
    expect(last(TESTER)).toMatch(/נרשמת לאימון כח ב-19:00 היום/);
  });

  test('any other member: nothing is written, the request goes to the staff and she is told she is not registered yet', async () => {
    setup();
    await say(OTHER, 'תרשמי אותי לALL IN היום ב-18');
    expect(last(OTHER)).toMatch(/קיבלתי את הבקשה: רישום לALL IN ב-18:00 היום\.[\s\S]*העברתי את הבקשה לצוות\.[\s\S]*עדיין לא נרשמת/);
    expect(last(OTHER)).not.toMatch(/לאשר\?|בוצע/);
    expect(arbox.writes()).toHaveLength(0);
    expect(tasksOf(OTHER).filter(t => t.status === 'open')).toHaveLength(1);
  });

  test('Arbox answers 500 (as it did once on 2026-11-18): nothing is claimed, nothing is sent again, the staff are told the exact state', async () => {
    setup();
    await say(TESTER, 'תרשום אותי לALL IN היום ב-18');
    arbox.mode.write = 'error500_no_apply';
    await say(TESTER, 'כן');
    arbox.mode.write = 'success';
    expect(posts(/bookSession/)).toHaveLength(1);                                 // not repeated
    expect(last(TESTER)).not.toMatch(/נרשמת ל|בוצע ✅/);
    expect(arbox.state.bookings.filter(b => b.user_id === ids.tester)).toHaveLength(0);
    expect(mockOut.alerts.length).toBeGreaterThanOrEqual(1);
    await say(TESTER, 'כן');                                                      // a later "כן" does not resend the request blindly
    expect(posts(/bookSession/).length).toBeLessThanOrEqual(1);
  });

  test('Arbox refuses the booking: no "נרשמת"; the member is told it was not done and the staff are alerted', async () => {
    setup();
    await say(TESTER, 'תרשום אותי לALL IN היום ב-18');
    arbox.mode.write = 'reject';
    await say(TESTER, 'כן');
    arbox.mode.write = 'success';
    expect(last(TESTER)).not.toMatch(/נרשמת ל|בוצע ✅/);
    expect(last(TESTER)).toMatch(/עדיין לא נרשמת/);
    expect(arbox.state.bookings.filter(b => b.user_id === ids.tester)).toHaveLength(0);
    expect(mockOut.alerts.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Third live test, 2026-11-18 13:20–13:22 (writes on for the test phone). The booking was real and verified:
//   "תרשום אותי ליוגה בשעה 8:30" → "ביום שישי ב8:30" → "כן" → booked in Arbox, read back.
//   "תבטל אותי מהשיעור בבקשה"            → "no booking today", handed to the staff
//   "תבטל אותי מהיוגה ביום שישי בבקשה"   → Arbox was read and DID return the booking (08:30) - and Tomer still said it
//                                           was not found, because a booking was recognised only by an hour in the message.
describe('Book → cancel on the wrong day → the right day → cancelled (live failure 2026-11-18 13:22)', () => {
  const P = '972507150001';
  const store2 = () => require('../utils/tomer_store');
  const tasksOf = p => store2().getTasks({ phone: p, type: 'class_change' });
  const openOf = p => tasksOf(p).filter(t => t.status === 'open');
  const last = p => textsTo(p).at(-1) ?? '';
  const posts = re => arbox.writes().filter(w => re.test(w.path));
  const row = (id, date, start, name, registered, cap) => ({ schedule_id: id, date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}:${start.slice(3)}`, session_name: name, staff_member: { name: 'רעיה לוי' }, max_participants: cap, registration_count: registered, disable_cancellation_time: 12, enable_late_cancellation: 1 });   // the cancellation rule, as the real Arbox rows carry it
  const FRI = day(4);                                                              // T0 is Monday 2026-11-16 10:00 → Friday 2026-11-20
  let uid2;
  function setup({ writes = true, phone = P } = {}) {
    world();
    for (const t of store2().getOpenTasks()) store2().resolveTask(t.id, { resolutionNote: 'test reset', resolvedBy: 'test' });
    uid2 = person({ phone: '0' + phone.slice(3), first: 'בדיקה' });
    plan(uid2, { start: day(0), end: null });
    arbox.state.schedule.push(row(51, day(0), '09:15', 'אימון כח', 5, 10), row(52, day(0), '18:00', 'ALL IN', 3, 10), row(53, FRI, '08:30', 'יוגה', 2, 10), row(54, FRI, '10:30', 'אימון כח', 6, 10));
    // the baseline of the live test: a booking today in a class that already took place
    arbox.state.bookings.push({ user_id: uid2, date: day(0), time: '09:15', class_name: 'אימון כח', staff_member: 'רעיה לוי', check_in: 'No', sessions_left: null, membership_type_name: 'מנוי חודשי' });
    if (writes) { process.env.ARBOX_WRITES_ENABLED = 'true'; process.env.ARBOX_WRITE_OPS = 'class_book,class_cancel'; process.env.ARBOX_WRITE_TEST_PHONES = phone; }
    delete process.env.ARBOX_WRITE_AUDIENCE;
  }
  afterEach(() => { delete process.env.ARBOX_WRITES_ENABLED; delete process.env.ARBOX_WRITE_OPS; delete process.env.ARBOX_WRITE_TEST_PHONES; });
  const fri = b => b.user_id === uid2 && b.date === FRI && b.time === '08:30';

  test('the whole sequence: book → "כן" → read back → cancel with no day → the Friday booking is found → "כן" → cancelled and read back', async () => {
    setup();
    await say(P, 'תרשום אותי ליוגה בשעה 8:30');
    expect(last(P)).toMatch(/לא מצאתי ב-Arbox שיעור כזה ב-08:30 היום\./);            // today there is no yoga
    expect(last(P)).toMatch(/עדיין לא נרשמת לשום שיעור/);
    await say(P, 'ביום שישי ב8:30');
    expect(last(P)).toMatch(/רק לוודא לפני שאני משנה ב-Arbox:\nרישום ליוגה ב-08:30, ביום שישי 20\.11\.\nלאשר\?/);
    await say(P, 'כן');
    expect(last(P)).toMatch(/בוצע ✅ נרשמת ליוגה ב-08:30 ביום שישי 20\.11\.\nאימתתי את זה עכשיו מול Arbox\./);
    expect(arbox.state.bookings.filter(fri)).toHaveLength(1);                      // the evidence: this member, this day, this hour
    expect(posts(/bookSession/)).toHaveLength(1);
    const alertsAfterBooking = mockOut.alerts.length;

    // immediately after the write: the cancellation reads the member's bookings afresh and finds the booking just made
    await say(P, 'תבטל אותי מהשיעור בבקשה');
    expect(last(P)).toMatch(/רק לוודא לפני שאני משנה ב-Arbox:\nביטול הרישום ליוגה ב-08:30, ביום שישי 20\.11\.\nלאשר\?/);
    expect(last(P)).not.toMatch(/לא מצאתי|לצוות/);
    expect(posts(/cancelUserBooking/)).toHaveLength(0);                            // nothing is cancelled before the written "כן"
    expect(arbox.state.bookings.filter(fri)).toHaveLength(1);
    await say(P, 'כן');
    expect(posts(/cancelUserBooking/)).toHaveLength(1);
    expect(posts(/cancelUserBooking/)[0].body).toMatchObject({ user_id: uid2, schedule_id: 53 });
    expect(last(P)).toMatch(/בוצע ✅ הרישום שלך ל-08:30 ביום שישי 20\.11 בוטל\.\nאימתתי את זה עכשיו מול Arbox\./);
    expect(arbox.state.bookings.filter(fri)).toHaveLength(0);                      // removed in Arbox
    expect(arbox.state.bookings.filter(b => b.user_id === uid2)).toHaveLength(1);  // the baseline booking was not touched
    expect(openOf(P)).toHaveLength(0);                                             // nothing is left with the staff
    expect(mockOut.alerts.length).toBe(alertsAfterBooking);                        // and they were not alerted
  });

  test('a cancellation "for today" does not cancel Friday: today\'s class has started, the Friday booking is offered and asked about; "כן" identifies it, a second "כן" confirms the action', async () => {
    setup();
    arbox.state.bookings.push({ user_id: uid2, date: FRI, time: '08:30', class_name: 'יוגה', staff_member: 'רעיה לוי', check_in: 'No', sessions_left: null, membership_type_name: 'מנוי חודשי' });
    const cancelTasksBefore = tasksOf(P).filter(x => x.kind === 'cancel').length;   // the task file is shared by the suite
    await say(P, 'תבטל אותי מהשיעור היום בבקשה');
    const t = last(P);
    expect(t).toMatch(/בדקתי ב-Arbox ולא מצאתי רישום שלך היום\./);
    expect(t).toMatch(/אימון כח של היום ב-09:15 כבר התחיל, אז אין מה לבטל בו\./);
    expect(t).toMatch(/יש לך רישום ליוגה ביום שישי 20\.11 ב-08:30\. אליו התכוונת\?/);
    expect(t).toMatch(/שום דבר לא בוטל\./);
    expect(t).not.toMatch(/לצוות|הרישום שלך לא בוטל עד/);
    expect(posts(/cancelUserBooking/)).toHaveLength(0);
    expect(mockOut.alerts).toHaveLength(0);                                        // a clarification: the staff are not alerted
    expect(openOf(P)).toHaveLength(1);
    expect(openOf(P)[0]).toMatchObject({ kind: 'cancel', missing: 'which_class' });
    await say(P, 'כן');                                                            // "yes, that one" - identifies the booking
    expect(last(P)).toMatch(/ביטול הרישום ליוגה ב-08:30, ביום שישי 20\.11\.\nלאשר\?/);
    expect(posts(/cancelUserBooking/)).toHaveLength(0);
    await say(P, 'כן');                                                            // the written confirmation of the exact action
    expect(posts(/cancelUserBooking/)).toHaveLength(1);
    expect(last(P)).toMatch(/הרישום שלך ל-08:30 ביום שישי 20\.11 בוטל/);
    expect(openOf(P)).toHaveLength(0);
    expect(tasksOf(P).filter(x => x.kind === 'cancel').length - cancelTasksBefore).toBe(1);   // one request with its history, not two
  });

  test.each([
    'תבטל אותי מהיוגה ביום שישי בבקשה',
    'תבטלי לי את היוגה',
    'אני לא אגיע ביום שישי',
    'תבטל לי את השיעור של שישי ב-8:30',
    'לבטל את הרישום ליוגה בשישי',
  ])('an explicit cancellation in other words — "%s" — finds the Friday booking and asks to confirm exactly it', async q => {
    setup();
    arbox.state.bookings.push({ user_id: uid2, date: FRI, time: '08:30', class_name: 'יוגה', staff_member: 'רעיה לוי', check_in: 'No', sessions_left: null, membership_type_name: 'מנוי חודשי' });
    await say(P, q);
    expect(last(P)).toMatch(/ביטול הרישום ליוגה ב-08:30, ביום שישי 20\.11\.\nלאשר\?/);
    expect(posts(/cancelUserBooking/)).toHaveLength(0);
    expect(mockOut.alerts).toHaveLength(0);
  });

  test('"לא" to "אליו התכוונת?" cancels nothing and closes the question; several bookings → she is asked which', async () => {
    setup();
    arbox.state.bookings.push({ user_id: uid2, date: FRI, time: '08:30', class_name: 'יוגה', staff_member: 'רעיה לוי', check_in: 'No', sessions_left: null, membership_type_name: 'מנוי חודשי' });
    await say(P, 'תבטל אותי מהשיעור היום');
    await say(P, 'לא');
    expect(last(P)).toMatch(/לא ביטלתי דבר/);
    expect(openOf(P)).toHaveLength(0);
    arbox.state.bookings.push({ user_id: uid2, date: FRI, time: '10:30', class_name: 'אימון כח', staff_member: 'רעיה לוי', check_in: 'No', sessions_left: null, membership_type_name: 'מנוי חודשי' });
    await say(P, 'תבטל אותי ביום שישי');
    expect(last(P)).toMatch(/מצאתי כמה רישומים שמתאימים:\n• יוגה ביום שישי 20\.11 ב-08:30\n• אימון כח ביום שישי 20\.11 ב-10:30\nאיזה מהם לבטל\?/);
    await say(P, 'את האימון כוח');
    expect(last(P)).toMatch(/ביטול הרישום לאימון כח ב-10:30, ביום שישי 20\.11\.\nלאשר\?/);
    expect(posts(/cancelUserBooking/)).toHaveLength(0);
  });

  test('Arbox cannot be read: it is said as "could not check" and goes to the staff — never "no booking"; no booking at all is said only when Arbox shows none', async () => {
    setup();
    arbox.state.bookings.length = 0;
    await say(P, 'תבטל אותי מהיוגה ביום שישי');
    expect(last(P)).toMatch(/בדקתי ב-Arbox ואין לך כרגע רישום עתידי לשיעור, כך שאין מה לבטל\./);
    expect(last(P)).not.toMatch(/לא בוטל עד/);
    expect(openOf(P)).toHaveLength(0);
    expect(mockOut.alerts).toHaveLength(0);
    arbox.mode.down = true; gateway.clearCache();
    await say(P, 'תבטל אותי מהיוגה ביום שישי');
    arbox.mode.down = false; gateway.clearCache();
    const t = last(P);
    expect(t).not.toMatch(/אין לך כרגע רישום|לא מצאתי רישום/);
    expect(t).toMatch(/לא הצלחתי|אין לי כרגע גישה/);
  });

  test('writes off (every other member): the Friday booking is found and the request goes to the staff, saying the booking is still there', async () => {
    setup({ writes: false, phone: '972507150002' });
    const Q = '972507150002';
    arbox.state.bookings.push({ user_id: uid2, date: FRI, time: '08:30', class_name: 'יוגה', staff_member: 'רעיה לוי', check_in: 'No', sessions_left: null, membership_type_name: 'מנוי חודשי' });
    await say(Q, 'תבטל אותי מהיוגה ביום שישי בבקשה');
    const t = last(Q);
    expect(t).toMatch(/בדקתי ב-Arbox: יש לך רישום ליוגה ב-08:30 ביום שישי 20\.11\./);
    expect(t).toMatch(/העברתי את הבקשה לצוות\.\nהרישום שלך לא בוטל עד שהצוות יאשר לך כאן\./);
    expect(t).not.toMatch(/לא מצאתי/);
    expect(arbox.writes()).toHaveLength(0);
    expect(mockOut.alerts).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Production, 2026-11-18 16:23 — a new number wrote "היי אשמח לקבל פרטים נוספים על הסטודיו" and got
// "שלום! 😊 קיבלנו את הודעתך. כדי שנוכל לעזור — במה אפשר לעזור?". Cause (from the log): the message held none of the
// "sales intent" words, so it was held as an UNCLASSIFIED contact and got that fixed greeting; Barak was never called.
// And the restored class list was not part of Barak's lead conversation.
describe('A lead asks for details about the studio (production 2026-11-18 16:23)', () => {
  const json = (url, body) => request(app).post(url).send(body ?? {}).set('Content-Type', 'application/json');
  const last = p => textsTo(p).at(-1) ?? '';
  const NAMES = ['פילאטיס מכשירים', 'אימון כוח', 'Pilates Barre', 'ALL IN', 'Concept Toning', 'Ashtanga Yoga', 'Kangoo Jumps'];
  async function withKnowledge() {
    world();
    for (const type of ['classes', 'staff']) { await json('/api/admin/knowledge/restore', { type }); await json('/api/admin/knowledge/confirm', { type }); }
  }
  function withoutKnowledge() {
    for (const f of ['staff_directory.json', 'classes_knowledge.json']) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* absent */ } }
    world();
    require('../agents/barak_agent').reloadKnowledge({ staffData: { instructors: [] }, classesData: { classes: [] } });
  }
  let n = 0; const phone = () => `97250716${String(++n).padStart(4, '0')}`;

  test.each([
    'היי אשמח לקבל פרטים נוספים על הסטודיו',
    'אשמח לשמוע על המקום',
    'מה אתם מציעים?',
    'היי, מתעניינת',
    'אפשר פרטים בבקשה?',
    'ספרו לי קצת על הסטודיו',
  ])('"%s" → Barak answers: a short introduction from the verified class list and ONE focused question', async text => {
    await withKnowledge();
    const P = phone(), calls = mockAi.calls;
    const r = await say(P, text);
    expect(r.route).not.toBe('unclassified');
    const t = last(P);
    expect(t).toBe('היי 😊 כאן ברק מ-Shape Studio.\nיש אצלנו פילאטיס, אימוני כוח ויוגה ועוד.\nמה הכי מעניין אותך?');   // short, Hebrew, only families the verified list holds
    expect(NAMES.length).toBe(7);
    expect((t.match(/\?/g) ?? []).length).toBe(1);                                 // one question
    expect(t).not.toMatch(/במה אפשר לעזור|קיבלנו את הודעתך|₪|ש"ח|מחיר/);
    expect(mockAi.calls).toBe(calls);                                              // it does not depend on the model
    expect(textsTo(P)).toHaveLength(1);
  });

  test('no verified class list is loaded: nothing is invented and the lead is not asked to explain himself again; it is recorded for the panel', async () => {
    withoutKnowledge();
    const P = phone();
    await say(P, 'היי אשמח לקבל פרטים נוספים על הסטודיו');
    const t = last(P);
    expect(t).toBe('היי 😊 כאן ברק מ-Shape Studio, שמח שפנית.\nכדי שאכוון אותך נכון — איזה סוג אימון מעניין אותך?');
    expect(t).not.toMatch(/במה אפשר לעזור|פילאטיס|יוגה|₪/);
    expect(require('../utils/lead_store').getEvents?.({ type: 'studio_intro_partial' })?.length ?? 1).toBeGreaterThan(0);
    const st = (await request(app).get('/api/admin/knowledge/status')).body.summary;
    expect(st.rows.find(x => x.id === 'classes').state).toBe('empty');             // and the panel says the list is missing
  });

  test('the model is down: the introduction still goes out (it never needed the model)', async () => {
    await withKnowledge();
    const OpenAI = require('openai');
    const P = phone(), before = mockAi.calls;
    mockAi.fallback = null;                                                        // a model answer of null would break a model-made reply
    await say(P, 'אשמח לשמוע על המקום');
    mockAi.fallback = 'היי! אשמח לעזור 😊 מה מחפשים?';
    expect(last(P)).toMatch(/כאן ברק מ-Shape Studio\.\nיש אצלנו פילאטיס, אימוני כוח ויוגה ועוד\./);
    expect(last(P)).not.toMatch(/תקלה/);
    expect(mockAi.calls).toBe(before);
    expect(typeof OpenAI).toBe('function');
  });

  test('a request that already names something is answered by the usual conversation, with the verified lists in Barak\'s context; the introduction is given once', async () => {
    await withKnowledge();
    const ctx = require('../agents/lead_agent').buildKnowledgeContext();
    expect(ctx).toMatch(/VERIFIED STUDIO FACTS/);
    expect(ctx).toMatch(/Class types at the studio: פילאטיס מכשירים, אימון כוח, Pilates Barre, ALL IN/);
    expect(ctx).toMatch(/Instructors: /);
    expect(ctx).toMatch(/Never invent a class, an instructor, a price/);
    const P = phone(), calls = mockAi.calls;
    await say(P, 'אשמח לקבל פרטים על פילאטיס מכשירים');
    expect(mockAi.calls).toBe(calls + 1);                                          // the model, not the fixed greeting and not the general introduction
    expect(last(P)).not.toMatch(/קיבלנו את הודעתך|כאן ברק מ-Shape Studio\.\nיש אצלנו/);
    const Q = phone();
    await say(Q, 'מה אתם מציעים?');
    const c2 = mockAi.calls;
    await say(Q, 'אפשר עוד פרטים?');
    expect(mockAi.calls).toBe(c2 + 1);                                             // the second time the conversation goes on - the introduction is not repeated
    expect(textsTo(Q).filter(x => /כאן ברק מ-Shape Studio\.\nיש אצלנו/.test(x))).toHaveLength(1);
    // a follow-up that holds NO sales word ("מה ההבדל ביניהם?") stays with Barak: the same conversation, with the
    // introduction in its history and the verified lists in its context - it does not fall back to the fixed greeting
    const F = phone();
    await say(F, 'היי אשמח לקבל פרטים נוספים על הסטודיו');
    const c3 = mockAi.calls;
    const rf = await say(F, 'מה ההבדל ביניהם?');
    expect(rf.route).not.toBe('unclassified');
    expect(mockAi.calls).toBe(c3 + 1);
    expect(last(F)).not.toMatch(/קיבלנו את הודעתך|במה אפשר לעזור/);
    const OpenAI = require('openai');
    const sent = OpenAI.mock.results.map(r => r.value?.chat?.completions?.create?.mock?.calls ?? []).flat().map(c => c[0]?.messages ?? []).filter(ms => ms.some(m => m.role === 'user' && m.content === 'מה ההבדל ביניהם?')).at(-1);
    expect(sent.find(m => m.role === 'system').content).toMatch(/VERIFIED STUDIO FACTS[\s\S]*Class types at the studio: פילאטיס מכשירים, אימון כוח/);
    expect(sent.some(m => m.role === 'assistant' && /כאן ברק מ-Shape Studio/.test(m.content))).toBe(true);   // the introduction is part of the context
    expect(sent.some(m => m.role === 'user' && /פרטים נוספים על הסטודיו/.test(m.content))).toBe(true);
  });

  test('with no verified lists Barak\'s context says so and forbids naming classes', () => {
    withoutKnowledge();
    expect(require('../agents/lead_agent').buildKnowledgeContext()).toMatch(/No verified list of class types or instructors is loaded\. Do not name any class type or instructor/);
  });

  test('a bare greeting and a supplier\'s pitch are still not treated as leads', async () => {
    await withKnowledge();
    const A = phone(), B = phone();
    expect((await say(A, 'היי')).route).toBe('unclassified');
    expect((await say(B, 'שלום, אשמח להציע לכם שירותי ניקיון לסטודיו, אפשר פרטים למי לפנות?')).route).toBe('unclassified');
    expect(last(B)).not.toMatch(/כאן ברק מ-Shape Studio/);
  });
});

// "The provider accepted the message" is not "the customer received a readable message" (production 2026-11-18 16:23:
// the lead saw "ממתין להודעה"; every message of the day was "sent" at the provider and no delivery status ever arrived).
describe('What is known about the delivery of a sent message', () => {
  const ledger = () => require('../utils/delivery_ledger');
  const hook = body => request(app).post('/api/green-api/webhook').send(body).set('Content-Type', 'application/json');
  const row = async () => (await request(app).get('/api/system/status')).body.rows.find(r => r.id === 'wa_delivery');

  test('accepted by the provider is recorded as accepted only; with no delivery confirmation at all the panel says it cannot tell', async () => {
    world(); ledger()._reset(); try { fs.unlinkSync(path.join(DATA_DIR, 'delivery_ledger.json')); } catch { /* absent */ }
    ledger().recordAccepted('3EB0AAA1', '972507170001'); ledger().recordAccepted('3EB0AAA2', '972507170002');
    expect(ledger().get('3EB0AAA1')).toMatchObject({ status: 'accepted', tail: '0001', history: [] });
    expect(ledger().summary()).toMatchObject({ accepted: 2, confirmed: 0, failed: 0, anyStatusReported: false });
    const r = await row();
    expect(r.state).toBe('blocked');
    expect(r.detail).toMatch(/לאף אחת מהן לא התקבל אישור מסירה או קריאה — אי אפשר לדעת אם הלקוחות קיבלו הודעה קריאה/);
    expect(r.action).toMatch(/מכשירים מקושרים/);
  });

  test('a delivery status from the provider is recorded on the message and never goes backwards; a failure is always shown', async () => {
    world(); ledger()._reset(); try { fs.unlinkSync(path.join(DATA_DIR, 'delivery_ledger.json')); } catch { /* absent */ }
    ledger().recordAccepted('3EB0BBB1', '972507170003'); ledger().recordAccepted('3EB0BBB2', '972507170004');
    await hook({ typeWebhook: 'outgoingMessageStatus', idMessage: '3EB0BBB1', status: 'delivered' });
    await hook({ typeWebhook: 'outgoingMessageStatus', idMessage: '3EB0BBB1', status: 'read' });
    await hook({ typeWebhook: 'outgoingMessageStatus', idMessage: '3EB0BBB1', status: 'sent' });          // a late, lower status
    await waitFor(() => ledger().get('3EB0BBB1')?.history?.length === 3);
    expect(ledger().get('3EB0BBB1')).toMatchObject({ status: 'read' });
    expect((await row()).state).toBe('partial');
    await hook({ typeWebhook: 'outgoingMessageStatus', idMessage: '3EB0BBB2', status: 'failed', description: 'not delivered' });
    await waitFor(() => ledger().get('3EB0BBB2')?.status === 'failed');
    const r = await row();
    expect(r.state).toBe('fail');
    expect(r.detail).toMatch(/ל-1 מהן דווח כשל מסירה/);
    expect(textsTo('972507170003')).toHaveLength(0);                                // a status webhook never produces a reply
  });
});

