'use strict';
/**
 * tomer_test_mode.test.js — the TEST-ONLY restriction of the new Tomer flow.
 *
 * Same real pipeline and mocks as tomer_member_flow.test.js, but in the service's DEFAULT
 * mode (TOMER_MODE unset = test_only). Proves:
 *   • with no allowlist nobody is served by the new flow (fail closed);
 *   • a member who is NOT on the allowlist cannot receive any message from the new flow —
 *     inbound, direct service call, staff reply from a case, alert retry, after a restart;
 *   • the allowlisted test phone — a Barak LEAD with an appointment — is served through an
 *     explicit routing override with SYNTHETIC member data, while its lead record and its
 *     appointment stay byte-for-byte unchanged, and no Arbox member lookup is made for it;
 *   • takeover / release / opt-out of the test identity never touch the lead record;
 *   • removing the override returns the phone to Barak;
 *   • manager alerts go only to the explicitly configured manager phone;
 *   • proactive programs are locked.
 * All phones are synthetic; nothing leaves the machine.
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
delete process.env.TOMER_MODE;                 // unset = test_only (fail closed)

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
jest.mock('../utils/phone_registry', () => ({ init: jest.fn(() => Promise.resolve()), isMember: jest.fn(() => false), getAll: jest.fn(() => []), size: 0 }));
const mockMembers = new Set();
jest.mock('../utils/member_cache', () => ({
  isConfirmed: jest.fn(p => mockMembers.has(p)), isFresh: jest.fn(p => mockMembers.has(p)),
  getEntry: jest.fn(p => (mockMembers.has(p) ? { name: null, role: 'client' } : null)),
  markConfirmed: jest.fn(), invalidate: jest.fn(), size: jest.fn(() => 0), flush: jest.fn(),
  seedFromArbox: jest.fn(() => Promise.resolve({ seeded: 0 })), isKnownMemberFile: jest.fn(() => false),
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

// Fixed clock: Monday 16.11.2026 10:00 Israel time. Only Date is faked.
const T0 = new Date('2026-11-16T08:00:00.000Z');
const TODAY = '2026-11-16', TOMORROW = '2026-11-17';

let seq = 500, msgSeq = 0;
/** A synthetic member: registered in the Arbox stand-in under `arboxPhone` format. */
function member({ fmt = 'local', role = 'client', active = 1, gender = 'female', first = 'דנה', membership = true } = {}) {
  const n = ++seq; const tail = `50${String(7000000 + n)}`;          // 9 digits after 0 / 972
  const phone = `972${tail}`;
  const arboxPhone = fmt === 'local' ? `0${tail.slice(0, 2)}-${tail.slice(2)}` : fmt === 'plus' ? `+972${tail}` : phone;
  const userId = 1000 + n;
  arbox.state.users.push({ user_id: userId, first_name: first, last_name: 'בדיקה', phone: arboxPhone, user_role: role, active, gender });
  const mid = 9000 + n;
  if (membership) arbox.state.memberships.push({ membership_user_id: mid, user_id: userId, membership_type_name: 'מנוי חודשי 2 בשבוע', type: 'plan', price: 400, debt: 0, start_time: '2026-10-01', end_time: '2026-12-31', active: 1, cancelled: 0 });
  mockMembers.add(phone);
  gateway.clearCache();
  return { phone, userId, mid };
}
function seedSchedule() {
  arbox.state.schedule.push(
    { schedule_id: 1, date: TODAY,    start_time: '19:00', end_time: '20:00', session_name: 'כח',               staff_member: { name: 'מירי כהן' },   max_participants: 12, registration_link: 'https://book.example.test/c/1', registration_count: 3 },
    { schedule_id: 2, date: TOMORROW, start_time: '09:00', end_time: '10:00', session_name: 'פילאטיס מכשירים', staff_member: { name: 'מלאני לוי' }, max_participants: 10, registration_link: 'https://book.example.test/c/2', registration_count: 7 },
    { schedule_id: 3, date: TOMORROW, start_time: '19:00', end_time: '20:00', session_name: 'פילאטיס מכשירים', staff_member: { name: 'עדן גל' },    max_participants: 10, registration_link: 'https://book.example.test/c/3', registration_count: 10, standby_members: 2 },
    { schedule_id: 4, date: TOMORROW, start_time: '08:00', end_time: '09:00', session_name: 'יוגה',             staff_member: { name: 'מירי כהן' },   max_participants: 10, registration_link: 'https://book.example.test/c/4', registration_count: 0, status: 'cancelled' },
  );
}
const book = (m, cls) => arbox.state.bookings.push({ user_id: m.userId, date: cls.date, time: cls.start_time, class_name: cls.session_name, staff_member: cls.staff_member.name, check_in: 'No', sessions_left: null, membership_type_name: 'מנוי חודשי 2 בשבוע' });
const cls = id => arbox.state.schedule.find(c => c.schedule_id === id);

async function say(phone, text, { type = 'text', messageId = null } = {}) {
  const res = await request(app).post('/api/whatsapp/simulate')
    .send({ from: phone, text, name: 'WA Profile', type, messageId: messageId ?? `tm-${++msgSeq}`, timestamp: new Date().toISOString() })
    .set('Content-Type', 'application/json');
  if (res.status !== 200) throw new Error(`simulate ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}
const post = (url, body = {}) => request(app).post(url).send(body).set('Content-Type', 'application/json');
const get  = url => request(app).get(url);
/** A message typed by staff on the studio phone: the provider's outgoing-message webhook. */
async function phoneSend(phone, text) {
  const chatId = `${phone}@c.us`;
  const r = await request(app).post('/api/green-api/webhook').set('Content-Type', 'application/json').send({
    typeWebhook: 'outgoingMessageReceived', instanceData: { idInstance: 1234, wid: '972535716559@c.us' }, timestamp: Math.floor(Date.now() / 1000),
    idMessage: `PHONE_${++msgSeq}`, senderData: { chatId, sender: chatId, senderName: 'Shape Studio' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
  });
  expect(r.status).toBe(200);
  const ok = await waitFor(() => store.getLead(phone)?.status === 'human_owns');
  expect(ok).toBeTruthy();
}
const textsTo = p => mockOut.texts.filter(t => t.to === p).map(t => t.text);
const lastTo  = p => textsTo(p).at(-1) ?? null;
const openCases = p => cases.list({ phone: p, open: true });
const diskCase  = id => JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')).cases.find(c => c.id === id);
const FALSE_CONFIRM = /בקשת הביטול התקבלה|קיבלנו את אישור התשלום|רוצה מקום\?|נרשמת בהצלחה|ביטלתי לך|הקפאתי/;
const PROMISE        = /תוך (?:שעה|יום|\d)|עד מחר|עד סוף היום|בהקדם|אעדכן|נחזור אליך|יחזרו אליך|ניצור איתך קשר/;       // unconfigured deadlines / follow-up promises
const NOTIFIED_CLAIM = /העברתי|הודעתי לצוות|עדכנתי את הצוות|הצוות קיבל|סימנתי לצוות/;                                // "staff were notified" is never claimed
const INTRO = 'אני תומר, העוזר הדיגיטלי של Shape Studio.';

beforeAll(async () => {
  jest.useFakeTimers({ now: T0, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
  process.env.ARBOX_BASE_URL = await arbox.listen();
  restart();
});
beforeEach(() => {
  jest.setSystemTime(T0);
  mockOut.texts.length = 0; mockOut.alerts.length = 0; mockOut.mgr.length = 0; mockOut.mgrMode = 'ok'; mockOut.memberMode = 'ok'; mockOut.mgrCalls = 0; mockAi.queue.length = 0;
  arbox.reset(); seedSchedule(); gateway.clearCache();
  delete process.env.ARBOX_WRITES_ENABLED; delete process.env.ARBOX_TEST_ASSUME_CONTRACT;
});
afterAll(async () => { jest.useRealTimers(); await arbox.close(); });

const TESTP = '972587700001';                     // stands in for the approved test phone: a Barak lead, not an Arbox member
const APTS_FILE = path.join(DATA_DIR, 'appointments.json');
const tomerAudit = p => require('../utils/tomer_store').getAudit({ phone: p, limit: 200 }).filter(e => e.event === 'tomer_message' || e.event === 'case_opened');
const newFlowOut = p => (inbox.getThread(p)?.messages ?? []).filter(x => x.direction === 'out' && x.meta?.agent === 'tomer');
const sentTo = p => mockOut.texts.filter(t => t.to === p);
const setMode = ({ allow = null, override = false, manager = MANAGER } = {}) => {
  delete process.env.TOMER_MODE;
  if (allow) process.env.TOMER_TEST_ONLY_PHONES = allow; else delete process.env.TOMER_TEST_ONLY_PHONES;
  if (override) process.env.TOMER_TEST_ROUTE_OVERRIDE = 'true'; else delete process.env.TOMER_TEST_ROUTE_OVERRIDE;
  if (manager) process.env.TOMER_MANAGER_PHONE = manager; else delete process.env.TOMER_MANAGER_PHONE;
};
/** The test phone exactly as production has it: a Barak lead with a confirmed callback appointment. */
function seedBarakLead() {
  store.upsertLead(TESTP, { name: 'ליד בדיקה', status: 'call_scheduled', score: 70, meta: { qualData: { goal: 'x' }, callTimeGiven: true, source: 'whatsapp' } });
  const aptStore = require('../utils/appointment_store');
  if (!aptStore.getAll().some(a => a.leadPhone === TESTP)) aptStore.create({ leadPhone: TESTP, leadName: 'ליד בדיקה', rawTime: 'היום ב-18', scheduledAt: '2026-11-16T16:00:00.000Z', status: 'confirmed' });
  require('../utils/persist').saveLeads(store);
  return { lead: JSON.stringify(store.getLead(TESTP)), apts: fs.readFileSync(APTS_FILE, 'utf8') };
}
const barakState = () => ({ lead: JSON.stringify(store.getLead(TESTP)), apts: fs.readFileSync(APTS_FILE, 'utf8') });
afterAll(() => { for (const k of ['TOMER_TEST_ONLY_PHONES', 'TOMER_TEST_ROUTE_OVERRIDE', 'TOMER_MANAGER_PHONE', 'TOMER_PROACTIVE_ENABLED']) delete process.env[k]; process.env.TOMER_MODE = 'all'; });

describe('1. Fail closed and the allowlist', () => {
  test('module: unset / unknown mode is test_only; only listed phones are allowed; override needs the switch AND the list', () => {
    const tm = require('../services/tomer_test_mode');
    setMode({});
    expect(tm.mode()).toBe('test_only');
    expect(tm.isAllowed('972537605023')).toBe(false);
    process.env.TOMER_MODE = 'ALL'; expect(tm.mode()).toBe('test_only'); delete process.env.TOMER_MODE;
    setMode({ allow: ' 972537605023 , garbage, ' });
    expect([...tm.allowlist()]).toEqual(['972537605023']);
    expect(tm.isAllowed('972537605023')).toBe(true);
    expect(tm.isAllowed('972537605024')).toBe(false);
    expect(tm.routeOverride('972537605023')).toBe(false);                 // listed, but the override switch is off
    setMode({ allow: '972537605023', override: true });
    expect(tm.routeOverride('972537605023')).toBe(true);
    expect(tm.routeOverride('972537605024')).toBe(false);
    expect(tm.proactiveEnabled()).toBe(false);
    process.env.TOMER_PROACTIVE_ENABLED = 'true'; expect(tm.proactiveEnabled()).toBe(false); delete process.env.TOMER_PROACTIVE_ENABLED;   // still locked in test_only
  });

  test('no allowlist at all: a real member is not served by the new flow and receives nothing from it', async () => {
    setMode({});
    const m = member();
    const r = await say(m.phone, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    expect(r.route).not.toMatch(/^tomer_/);
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
    expect(newFlowOut(m.phone)).toHaveLength(0);
    expect(tomerAudit(m.phone)).toHaveLength(0);
    expect(mockOut.mgr).toHaveLength(0);
    expect(mockOut.texts.map(t => t.text).join('\n')).not.toMatch(/אני תומר, העוזר הדיגיטלי/);
  });
});

describe('2. A member who is NOT on the allowlist cannot receive a message from the new flow', () => {
  test('inbound, direct service call, staff reply, alert retry — and again after a restart', async () => {
    setMode({ allow: TESTP, override: true });
    const m = member();
    const before = mockOut.seq;
    // inbound → the previous production routing, not the new flow
    const r = await say(m.phone, 'לא הבנתי על מה חויבתי ועל איזה חודש');
    expect(r.route).not.toMatch(/^tomer_/);
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
    expect(newFlowOut(m.phone)).toHaveLength(0);
    // the service refuses even when called directly
    const direct = await app.locals.tomerService.handleMemberMessage({ phone: m.phone, text: 'רוצה לבטל את המנוי', type: 'text' });
    expect(direct.outcome).toBe('not_enabled');
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
    // a case that somehow exists for this member (e.g. created before the restriction): panel paths
    const c = cases.create({ phone: m.phone, memberName: 'דנה בדיקה', category: 'general_request', summary: 'ישן', memberText: 'x' });
    const legacyTexts = sentTo(m.phone).length;
    const reply = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי', by: 'עדן' });
    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe('recipient_not_allowed');
    await post(`/api/tomer/cases/${c.id}/retry-notification`, {});                   // an alert goes to the manager only
    await post(`/api/tomer/cases/${c.id}/resolve`, { note: 'נסגר', by: 'עדן' });
    await post(`/api/tomer/cases/${c.id}/takeover`, { by: 'עדן' });
    await post(`/api/tomer/cases/${c.id}/release`, { by: 'עדן' });
    expect(sentTo(m.phone)).toHaveLength(legacyTexts);                                // nothing reached the member
    expect(newFlowOut(m.phone)).toHaveLength(0);
    expect(tomerAudit(m.phone)).toHaveLength(0);
    expect(mockOut.mgr.every(x => true) && mockOut.texts.every(t => t.to === m.phone || t.to === TESTP)).toBe(true);

    restart();
    const r2 = await say(m.phone, 'רוצה לבטל את המנוי');
    expect(r2.route).not.toMatch(/^tomer_/);
    const reply2 = await post(`/api/tomer/cases/${c.id}/reopen`, { by: 'עדן' }).then(() => post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי', by: 'עדן' }));
    expect(reply2.body.error).toBe('recipient_not_allowed');
    expect(newFlowOut(m.phone)).toHaveLength(0);
    expect(tomerAudit(m.phone)).toHaveLength(0);
    expect(cases.list({ phone: m.phone })).toHaveLength(1);                           // only the seeded one
    expect(before).toBeLessThanOrEqual(mockOut.seq);
  });

  test('the timetable image and every reply path are closed for a non-allowlisted member', async () => {
    setMode({ allow: TESTP, override: true });
    const m = member();
    const whatsapp = require('../services/whatsapp.service');
    const files = whatsapp.sendFileByUrl.mock.calls.length;
    for (const text of ['מה יש מחר?', 'תשלחו לי את הלוז', 'עד מתי המנוי שלי בתוקף?', 'צריכה לדבר איתך בהקדם']) await app.locals.tomerService.handleMemberMessage({ phone: m.phone, text, type: 'text' });
    await app.locals.tomerService.handleMemberMessage({ phone: m.phone, text: '', type: 'image' });
    expect(whatsapp.sendFileByUrl.mock.calls.length).toBe(files);
    expect(sentTo(m.phone)).toHaveLength(0);
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
    expect(mockOut.mgr).toHaveLength(0);
  });
});

describe('3. The allowlisted test phone: routing override, synthetic identity, Barak state preserved', () => {
  test('full service flow on the test phone; lead record and appointment are byte-for-byte unchanged; no Arbox member lookup', async () => {
    setMode({ allow: TESTP, override: true });
    const snap = seedBarakLead();

    // A. member-information question → SYNTHETIC data, labelled
    const a = await say(TESTP, 'עד מתי המנוי שלי בתוקף?');
    expect(a.route).toBe('tomer_answered');
    expect(lastTo(TESTP).startsWith(INTRO + '\n')).toBe(true);
    expect(lastTo(TESTP)).toMatch(/מנוי בדיקה \(נתון מדומה\): בתוקף עד 31\.12\.2099/);
    expect(newFlowOut(TESTP).at(-1).meta.dataSource).toMatch(/נתון מדומה לבדיקה — לא Arbox/);
    // studio timetable is the REAL (here: stand-in) Arbox schedule
    await say(TESTP, 'מה יש מחר?');
    expect(lastTo(TESTP)).toMatch(/09:00 פילאטיס מכשירים/);

    // B + C. freeze → ONE case, ONE alert to the manager only, "not frozen"
    const b = await say(TESTP, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    expect(b.route).toBe('tomer_case_opened');
    expect(lastTo(TESTP)).toMatch(/המנוי לא הוקפא בשלב זה/);
    const [c] = cases.list({ phone: TESTP, open: true });
    expect(c).toMatchObject({ category: 'membership_freeze', memberUserId: `test-${TESTP}`, request: { from: '2026-12-01', to: '2026-12-15' } });
    expect(c.facts.source).toMatch(/נתון מדומה/);
    expect(mockOut.mgr).toHaveLength(1);
    expect(mockOut.mgr[0].text).toContain(`#tomer/case/${c.id}`);
    expect(mockOut.mgr[0].text).toMatch(/מנוי בדיקה \(נתון מדומה\)/);
    // E. repeat → no duplicate case, no duplicate alert
    await say(TESTP, 'רוצה להקפיא את המנוי');
    expect(cases.list({ phone: TESTP, open: true })).toHaveLength(1);
    expect(mockOut.mgr).toHaveLength(1);

    // F. staff reply pauses Tomer — ownership is kept on the test identity, not on the lead
    const rep = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי, בודקת', by: 'עדן' });
    expect(rep.body).toMatchObject({ ok: true, case: { conversationOwner: 'human' } });
    const n = sentTo(TESTP).length;
    expect((await say(TESTP, 'ומה עם מחר?')).route).toBe('human_owns_hold');
    expect(sentTo(TESTP)).toHaveLength(n);
    expect(cases.get(c.id).context.at(-1).text).toBe('ומה עם מחר?');
    restart();                                                                       // ownership + restriction survive a restart
    expect((await say(TESTP, 'עדיין כאן?')).route).toBe('human_owns_hold');
    expect(sentTo(TESTP)).toHaveLength(n);
    // G. release → Tomer answers again; release again → no change
    const rel = await post(`/api/tomer/cases/${c.id}/release`, { by: 'עדן' });
    expect(rel.body).toMatchObject({ unchanged: false, conversationOwner: 'tomer', restoredTo: 'tomer_test' });
    expect((await post(`/api/tomer/cases/${c.id}/release`, { by: 'עדן' })).body.unchanged).toBe(true);
    expect((await say(TESTP, 'עד מתי המנוי שלי בתוקף?')).route).toBe('tomer_answered');
    // a reply typed on the studio phone also pauses Tomer, again without touching the lead
    await request(app).post('/api/green-api/webhook').set('Content-Type', 'application/json').send({
      typeWebhook: 'outgoingMessageReceived', instanceData: { idInstance: 1, wid: '972535716559@c.us' }, timestamp: 1, idMessage: 'PHONE_TM_1',
      senderData: { chatId: `${TESTP}@c.us`, sender: `${TESTP}@c.us`, senderName: 'Shape' }, messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'אני על זה' } } });
    expect(await waitFor(() => (cases.getMember(TESTP)?.humanOwned ? true : null))).toBe(true);
    expect((await say(TESTP, 'תודה, ומה לגבי ההקפאה, אפשר?')).route).toBe('human_owns_hold');
    await post(`/api/tomer/cases/${c.id}/release`, { by: 'עדן' });
    // H. resolve persists; the read-only check is synthetic; nothing was written anywhere in Arbox
    const res = await post(`/api/tomer/cases/${c.id}/resolve`, { outcome: 'declined', note: 'בדיקה בלבד', by: 'עדן' });
    expect(res.body.case.status).toBe('resolved');
    expect(diskCase(c.id).resolution).toMatchObject({ outcome: 'declined', note: 'בדיקה בלבד' });
    const chk = await post(`/api/tomer/cases/${c.id}/refresh-arbox`, { by: 'עדן' });
    expect(chk.body.case.arboxCheck.source).toMatch(/נתון מדומה/);
    // opt-out of the test identity is also kept off the lead record
    await say(TESTP, 'הסר אותי מהרשימה');
    expect(cases.getMember(TESTP).optedOut).toBeTruthy();
    expect((await say(TESTP, 'מה יש מחר?')).route).toBe('opted_out_silent');

    // ── Barak's stored state is exactly what it was ──
    expect(barakState()).toEqual(snap);
    expect(JSON.parse(snap.lead)).toMatchObject({ status: 'call_scheduled', meta: { callTimeGiven: true } });
    // ── Arbox: no member lookup, no per-member read, no write for the test identity ──
    expect(arbox.log.filter(l => l.path === '/v3/users')).toHaveLength(0);
    expect(arbox.log.filter(l => /memberships|bookingsReport|bookingCancellationReport|membersOnHoldReport/.test(l.path))).toHaveLength(0);
    expect(arbox.writes()).toHaveLength(0);
    // ── every message of the run went to the test phone or the manager ──
    expect(mockOut.texts.every(t => t.to === TESTP)).toBe(true);
    expect(mockOut.mgrCalls).toBe(1);
  });

  test('override removed → the phone is Barak\'s again; stored Tomer test state is simply not consulted', async () => {
    setMode({ allow: TESTP, override: true });
    seedBarakLead();
    cases.patchMember(TESTP, { optedOut: null, humanOwned: null });
    expect((await say(TESTP, 'עד מתי המנוי שלי בתוקף?')).route).toBe('tomer_answered');
    setMode({ allow: TESTP, override: false });                                      // = delete TOMER_TEST_ROUTE_OVERRIDE
    const lead = JSON.stringify(store.getLead(TESTP));
    const n = cases.list({ phone: TESTP }).length;
    const r = await say(TESTP, 'מה יש מחר?');
    expect(r.route).not.toMatch(/^tomer/);
    expect(cases.list({ phone: TESTP })).toHaveLength(n);
    expect(JSON.parse(lead).status).toBe('call_scheduled');
    const view = await get('/api/tomer/test-mode');
    expect(view.body).toMatchObject({ mode: 'test_only', allowlist: [TESTP], routeOverrideEnabled: false, routeOverridePhones: [], proactiveEnabled: false, managerPhone: MANAGER });
  });
});

describe('4. Manager alerts and proactive programs', () => {
  test('test_only: the manager phone must be named explicitly — otherwise no alert leaves (and it is shown as failed)', async () => {
    setMode({ allow: TESTP, override: true, manager: null });
    cases.patchMember(TESTP, { optedOut: null, humanOwned: null });
    await say(TESTP, 'צריכה לדבר איתך בהקדם');
    const c = cases.list({ phone: TESTP, open: true }).find(x => x.category === 'staff_request');
    expect(c.notification).toMatchObject({ state: 'failed', lastError: 'no manager phone configured' });
    expect(mockOut.mgrCalls).toBe(0);
    expect(mockOut.alerts).toHaveLength(0);
    setMode({ allow: TESTP, override: true, manager: MANAGER });
    const r = await post(`/api/tomer/cases/${c.id}/retry-notification`, {});
    expect(r.body.case.notification).toMatchObject({ state: 'accepted', sentTo: [MANAGER] });
    expect(mockOut.mgrCalls).toBe(1);
  });

  test('proactive onboarding / retention programs cannot be enabled or run', async () => {
    setMode({ allow: TESTP, override: true });
    const t = await post('/api/tomer/retention/toggle', { workflowId: 'onboarding1', enabled: true });
    expect(t.status).toBe(409);
    expect(t.body.error).toBe('proactive_locked');
    const run = await post('/api/tomer/retention/run/onboarding1', {});
    expect(run.body.reason).toBe('proactive_locked');
    const act = await post('/api/tomer/action', { segment: 'onboarding', phone: TESTP, name: 'x' });
    expect(act.status).toBe(409);
    const rw = require('../workers/retention_worker');
    rw.enableWorkflow('birthday');
    expect(Object.values(rw.getConfig()).some(w => w.enabled)).toBe(false);
    expect((await rw.runAllWorkflows()).reason).toBe('proactive_locked');
    expect(mockOut.texts).toHaveLength(0);
  });
});
