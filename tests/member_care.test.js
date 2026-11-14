'use strict';
/**
 * member_care.test.js — Tomer's proactive member care, end to end.
 *
 * REAL: server.js, member_care (+ replies), contact_policy, member_care_store (disk),
 * tomer_service, arbox_gateway (real HTTP against the LOCAL Arbox stand-in), cases, inbox.
 * MOCKED: outbound WhatsApp (captured), OpenAI. Controlled clock (Asia/Jerusalem), synthetic
 * members only, a temporary data directory. Nothing leaves the machine.
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
// Each test builds its own world (see world()): time only ever moves forward inside a world.
afterAll(async () => { jest.useRealTimers(); await arbox.close(); });

process.env.TOMER_PROACTIVE_ENABLED = 'true';
afterAll(() => { delete process.env.TOMER_PROACTIVE_ENABLED; process.env.TOMER_MODE = 'all'; for (const k of ['TOMER_TEST_ONLY_PHONES', 'TOMER_TEST_ROUTE_OVERRIDE']) delete process.env[k]; });

const CARE_FILE = path.join(DATA_DIR, 'member_care.json');
const GROUP = 'https://chat.whatsapp.com/TestGroupLink123456';
const T_REC = 501, T_FIX = 502, T_TRIAL = 503, T_DELETED = 999;
let care, careStore, uid = 7000;
const IL = (date, hhmm = '10:05') => new Date(`${date}T${hhmm}:00+02:00`);        // Israel winter time
const MON = '2026-11-16', TUE = '2026-11-17';

/** A fresh isolated world at an Israel date/time: empty stores, empty Arbox stand-in, restarted server. */
function world(date, hhmm = '10:05', { raw = false } = {}) {
  jest.setSystemTime(IL(date, hhmm));
  for (const f of ['member_care.json', 'service_cases.json', 'leads_persist.json', 'inbox_persist.json', 'tomer_audit.json']) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* absent */ } }
  arbox.reset(); mockMembers.clear();
  arbox.state.membershipTypes.push(
    { membership_type_id: T_REC, membership_type_name: 'מנוי חודשי מתחדש', type: 'plan', is_recurring_payment: 1 },
    { membership_type_id: T_FIX, membership_type_name: 'מנוי 3 חודשים', type: 'plan', is_recurring_payment: 0 },
    { membership_type_id: T_TRIAL, membership_type_name: 'אימון ניסיון', type: 'trial', is_recurring_payment: 0 });
  arbox.state.schedule.push({ schedule_id: 1, date: addIso(date, 1), start_time: '19:00', end_time: '20:00', session_name: 'פילאטיס מכשירים', staff_member: { name: 'עדן גל' }, max_participants: 10, registration_link: 'https://book.example.test/c/1', registration_count: 3 });
  Object.assign(mockOut, { mgrMode: 'ok', memberMode: 'ok', mgrCalls: 0 }); mockOut.texts.length = 0; mockOut.mgr.length = 0; mockOut.alerts.length = 0;
  process.env.TOMER_MODE = 'all'; delete process.env.TOMER_TEST_ONLY_PHONES; delete process.env.TOMER_TEST_ROUTE_OVERRIDE; process.env.TOMER_MANAGER_PHONE = MANAGER;
  reboot();
  if (!raw) approveWorld();
}
/** The synthetic owner approves the policy as it stands and staff confirm the hold report (test worlds only). */
function approveWorld() {
  const a = care.approvePolicy({ approved: true, fingerprint: care.policyApproval().fingerprint, by: 'בעלים (בדיקה)' });
  const f = care.confirmFreezeSource({ confirmed: true, by: 'צוות (בדיקה)' });
  if (!a.ok || !f.ok) throw new Error('approveWorld failed');
}
function reboot() { restart(); care = app.locals.memberCare; careStore = require('../utils/member_care_store'); }
const at = (date, hhmm = '10:05') => { jest.setSystemTime(IL(date, hhmm)); gateway.clearCache(); };
const addIso = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

/** Synthetic member. `plan` adds one recurring plan membership created/started on that date (default: long ago). */
function cm({ first = 'דנה', gender = 'female', birthday = null, memberSince = null, plan = '2026-01-10', active = 1, phone = null } = {}) {
  const id = ++uid; const ph = phone ?? `97250${id}000`.slice(0, 12);
  arbox.state.users.push({ user_id: id, first_name: first, last_name: 'בדיקה', phone: ph, user_role: 'client', active, gender, birthday, membership_start_date: memberSince, created_time: '2026-01-01 10:00' });
  mockMembers.add(ph);
  const m = { userId: id, phone: ph };
  if (plan) ms(m, { start: plan });
  return m;
}
function ms(m, { typeId = T_REC, start, created = null, end = null, active = 1, cancelled = 0, name = null } = {}) {
  const id = 90000 + arbox.state.memberships.length;
  arbox.state.memberships.push({ membership_user_id: id, user_id: m.userId, membership_type_id: typeId, membership_type_name: name ?? (typeId === T_FIX ? 'מנוי 3 חודשים' : typeId === T_TRIAL ? 'אימון ניסיון' : 'מנוי חודשי מתחדש'), type: 'plan', start_time: start, end_time: end, created_at: created ?? `${start} 09:00`, active, cancelled, debt: 0 });
  return id;
}
const attend = (m, date, time = '09:00') => arbox.state.bookings.push({ user_id: m.userId, user_role: 'client', date, time, class_name: 'כח', check_in: 'Yes', is_first_session: 'No' });
const booked = (m, date, time = '18:00') => arbox.state.bookings.push({ user_id: m.userId, user_role: 'client', date, time, class_name: 'כח', check_in: 'No', is_first_session: 'No' });
const cancelBooking = (m, date, time = '18:00') => arbox.state.cancellations.push({ user_id: m.userId, date, start_time: `${time}:00`, class_name: 'כח' });
const tx = (m, mid, at_, status, kind = 'RECURRING') => arbox.state.transactions.push({ transaction_id: 1000 + arbox.state.transactions.length, user_id: m.userId, membership_user_id: mid, recurring_payment_id: 5000 + mid, transaction_date: at_.slice(0, 10), transaction_date_time: at_, type: kind, status, item_name: 'מנוי חודשי מתחדש', last_four_digits: '1234' });

const enable = async (...ids) => { for (const id of ids) { const r = await post(`/api/tomer/care/programs/${id}`, { enabled: true, by: 'עדן' }); if (r.status !== 200) throw new Error(`enable ${id}: ${JSON.stringify(r.body)}`); } gateway.clearCache(); };
const runAll = async () => { gateway.clearCache(); return care.run({ trigger: 'test' }); };
const got = m => mockOut.texts.filter(t => t.to === m.phone).map(t => t.text);
const eps = (program, m) => careStore.listEpisodes({ program, userId: m.userId });
const ep1 = (program, m) => eps(program, m)[0] ?? null;
const reasons = async (id, m) => { gateway.clearCache(); const p = (await get(`/api/tomer/care/preview/${id}`)).body; const inc = p.included.find(x => x.userId === String(m.userId)); return inc ? { included: true, decision: inc.decision, reasons: inc.reasons.map(r => r.code), message: inc.message, variant: inc.variant } : { included: false, reasons: (p.excluded.find(x => x.userId === String(m.userId))?.reasons ?? []).map(r => r.code) }; };
const setLead = (m, status) => { store.upsertLead(m.phone, { status, meta: { previousStatus: 'converted_member', isConfirmedMember: true } }); };

// ══════════════════════════════════════════════════════════════════════════════
describe('1. Gates: everything is off until three things are true', () => {
  test('default: every program disabled; the deployment switch off → nothing runs; blocked programs cannot be enabled', async () => {
    world(MON);
    const ov = (await get('/api/tomer/care/overview')).body;
    expect(ov.programs.map(p => p.enabled)).toEqual(Array(9).fill(false));
    expect(ov.settings.policy.managerDigest).toBe(false);
    expect(ov.programs.find(p => p.id === 'welcome').blocks.map(b => b.code)).toEqual(['group_link_missing']);
    expect(ov.programs.find(p => p.id === 'payment_failed').blocks.map(b => b.code)).toEqual(['payment_resolution_missing', 'billing_data_unconfirmed']);
    expect((await post('/api/tomer/care/programs/welcome', { enabled: true })).body).toMatchObject({ ok: false, error: 'program_blocked' });
    expect((await post('/api/tomer/care/programs/payment_failed', { enabled: true })).status).toBe(409);
    const a = cm(); attend(a, addIso(MON, -7));
    await enable('absence7');
    delete process.env.TOMER_PROACTIVE_ENABLED;
    try {
      expect(await runAll()).toMatchObject({ ok: false, reason: 'proactive_locked' });
      expect((await care.tick()).reason).toBe('proactive_locked');
      expect((await reasons('absence7', a)).reasons).toContain('proactive_locked');
    } finally { process.env.TOMER_PROACTIVE_ENABLED = 'true'; }
    expect(mockOut.texts).toHaveLength(0);
  });

  test('test-only mode: an eligible real member is blocked — only the allowlisted phone can ever receive a proactive message', async () => {
    world(MON, '09:50');
    const a = cm(); attend(a, addIso(MON, -7));
    await enable('absence7');
    delete process.env.TOMER_MODE; process.env.TOMER_TEST_ONLY_PHONES = '972587700001'; process.env.TOMER_TEST_ROUTE_OVERRIDE = 'true';
    at(MON);
    const r = await runAll();
    expect(r).toMatchObject({ ok: true, sent: 0, blocked: 1 });
    expect(ep1('absence7', a)).toMatchObject({ status: 'blocked', reasons: ['test_only'] });
    expect(mockOut.texts).toHaveLength(0);
    // a labelled test message goes to the override phone only, and its reply continues the conversation
    const t = await post('/api/tomer/care/test-send/absence7', { by: 'עדן' });
    expect(t.body.ok).toBe(true);
    expect(mockOut.texts.map(x => x.to)).toEqual(['972587700001']);
    expect(mockOut.texts[0].text).toMatch(/לא ראינו אותך בסטודיו בשבוע האחרון/);
    const reply = await say('972587700001', 'אני בחופשה עד 20.12');
    expect(reply.route).toBe('tomer_care_reply');
    expect(careStore.getPause('972587700001', new Date())).toMatchObject({ reason: 'vacation', until: '2026-12-20', endKnown: true });
    expect(store.getLead('972587700001')).toBeFalsy();                       // the lead store was not touched
    process.env.TOMER_TEST_ROUTE_OVERRIDE = 'false';
    expect((await post('/api/tomer/care/test-send/absence7', {})).body.error).toBe('no_test_phone');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('2. Welcome — genuinely new members only', () => {
  test('needs the approved group link; one welcome for a first membership bought after activation; never for renewals, imports or existing members', async () => {
    world(MON, '09:30');
    expect((await post('/api/tomer/care/settings', { groupLink: 'https://example.com/group' })).body.error).toBe('bad_group_link');
    await post('/api/tomer/care/settings', { groupLink: GROUP });
    const existing = cm({ plan: '2026-10-01' });                              // joined before activation → never welcomed
    await enable('welcome');
    const fresh   = cm({ first: 'נועה', plan: null }); ms(fresh, { start: MON, created: `${MON} 09:45` });
    const renewal = cm({ plan: '2025-06-01' }); ms(renewal, { start: MON, created: `${MON} 09:46` });
    const unknown = cm({ plan: null }); ms(unknown, { typeId: T_DELETED, start: '2025-01-01', active: 0 }); ms(unknown, { start: MON, created: `${MON} 09:47` });
    const trial   = cm({ first: 'מיכל', plan: null }); ms(trial, { typeId: T_TRIAL, start: addIso(MON, -6), active: 0 }); ms(trial, { start: MON, created: `${MON} 09:48` });
    const imported = cm({ plan: null, memberSince: '2024-05-01' }); ms(imported, { start: MON, created: `${MON} 09:49` });
    at(MON);
    expect((await reasons('welcome', existing)).reasons).toEqual(['before_baseline']);
    expect((await reasons('welcome', renewal)).reasons).toEqual(['not_first']);
    expect((await reasons('welcome', unknown)).reasons).toEqual(['earlier_unknown']);
    expect((await reasons('welcome', imported)).reasons).toEqual(['member_since_earlier']);
    const r = await runAll();
    expect(r.sent).toBe(2);
    expect(got(fresh)).toHaveLength(1);
    expect(got(fresh)[0]).toContain('היי נועה, ברוכים הבאים ל־Shape Studio! 💛');
    expect(got(fresh)[0]).toContain(GROUP);
    expect(got(trial)).toHaveLength(1);
    for (const m of [existing, renewal, unknown, imported]) expect(got(m)).toHaveLength(0);
    await runAll(); at(addIso(MON, 1)); await runAll();
    expect(got(fresh)).toHaveLength(1);                                       // one welcome, ever
    expect(ep1('welcome', fresh)).toMatchObject({ status: 'sent', sourceDates: { membershipStart: MON }, send: { idMessage: expect.stringMatching(/^MSG_/) } });
    // removing the link blocks and disables the program
    const off = await post('/api/tomer/care/settings', { groupLink: '' });
    expect(off.body.overview.programs.find(p => p.id === 'welcome')).toMatchObject({ enabled: false, blocks: [{ code: 'group_link_missing' }] });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('3. Tuesday — no training this week (Sunday–Saturday, Asia/Jerusalem)', () => {
  test('verified attendance and valid future bookings exclude; a cancelled booking does not; unknown attendance is not absence', async () => {
    world(TUE, '09:50');
    const sun = addIso(TUE, -2), thu = addIso(TUE, 2), lastThu = addIso(TUE, -5);
    const attended  = cm(); attend(attended, sun);
    const eligible  = cm({ first: 'רותם' }); attend(eligible, lastThu);
    const hasBooking = cm(); attend(hasBooking, lastThu); booked(hasBooking, thu);
    const cancelled = cm(); attend(cancelled, lastThu); booked(cancelled, thu); cancelBooking(cancelled, thu);
    const longGone  = cm(); attend(longGone, addIso(TUE, -12));
    const unknown   = cm();                                                    // no check-in at all in the 30-day window
    const joined    = cm({ plan: addIso(TUE, -1) });
    await enable('tuesday');
    at(TUE);
    expect((await reasons('tuesday', attended)).reasons).toEqual(['attended_this_week']);
    expect((await reasons('tuesday', hasBooking)).reasons).toEqual(['has_booking_this_week']);
    expect((await reasons('tuesday', longGone)).reasons).toEqual(['absence_track']);
    expect((await reasons('tuesday', unknown)).reasons).toEqual(['attendance_unknown']);
    expect((await reasons('tuesday', joined)).reasons).toEqual(['joined_this_week']);
    const r = await runAll();
    expect(r.sent).toBe(2);
    expect(got(eligible)[0]).toMatch(/עוד לא נקבע לך אימון השבוע/);
    expect(got(cancelled)).toHaveLength(1);
    for (const m of [attended, hasBooking, longGone, unknown, joined]) expect(got(m)).toHaveLength(0);
    expect(ep1('tuesday', eligible).sourceDates).toMatchObject({ weekStart: sun, weekEnd: addIso(sun, 6) });
  });

  test('not Tuesday → nobody; attendance data unavailable → the program is blocked for the run, nobody is treated as absent', async () => {
    world(MON, '09:50');
    const a = cm(); attend(a, addIso(MON, -4));
    await enable('tuesday');
    at(MON);
    expect((await reasons('tuesday', a)).reasons).toEqual(['not_today']);
    at(TUE);
    arbox.mode.bookingsDown = true;
    const r = await runAll();
    expect(r.sent).toBe(0);
    expect(r.dataBlocked.map(d => d.program)).toEqual(['tuesday']);
    expect((await get('/api/tomer/care/preview/tuesday')).body.dataBlocked.map(d => d.source)).toEqual(expect.arrayContaining(['attendance']));
    expect(mockOut.texts).toHaveLength(0);
  });

  test('a check-in recorded between the snapshot and the send cancels the message (revalidated just before sending)', async () => {
    world(TUE, '09:50');
    const a = cm(); attend(a, addIso(TUE, -5));
    await enable('tuesday');
    at(TUE);
    // right after the studio-wide attendance read, a check-in for this morning is recorded
    arbox.mode.after = { '/v3/reports/bookingsReport': s => s.bookings.push({ user_id: a.userId, user_role: 'client', date: TUE, time: '08:00', class_name: 'כח', check_in: 'Yes', is_first_session: 'No' }) };
    const r = await runAll();
    expect(r).toMatchObject({ sent: 0, cancelled: 1 });
    expect(ep1('tuesday', a)).toMatchObject({ status: 'cancelled', reasons: ['attended_since'] });
    expect(got(a)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('4. Seven / fourteen days absent — boundaries, no backlog, no overlap, return', () => {
  test('boundaries and baseline; 14-day follows the 7-day conversation without repeating it; a verified return ends the episode', async () => {
    world(MON, '09:50');
    const d6  = cm(); attend(d6,  addIso(MON, -6));
    const d7  = cm({ first: 'שירה' }); attend(d7, addIso(MON, -7));
    const d13 = cm(); attend(d13, addIso(MON, -13));       // crossed 7 days before activation → no backlog
    const d14 = cm({ first: 'הילה' }); attend(d14, addIso(MON, -14));
    const d21 = cm(); attend(d21, addIso(MON, -21));
    const upcoming = cm(); attend(upcoming, addIso(MON, -7)); booked(upcoming, addIso(MON, 3));
    await enable('absence7', 'absence14', 'tuesday');
    at(MON);
    expect((await reasons('absence7', d6)).reasons).toEqual(['not_in_window']);
    expect((await reasons('absence7', d13)).reasons).toEqual(['before_baseline']);
    expect((await reasons('absence14', d21)).reasons).toEqual(['not_in_window']);
    expect((await reasons('absence7', upcoming)).reasons).toEqual(['has_upcoming_booking']);
    const r1 = await runAll();
    expect(r1.sent).toBe(2);
    expect(got(d7)[0]).toMatch(/לא ראינו אותך בסטודיו בשבוע האחרון/);
    expect(got(d14)[0]).toMatch(/עברו כשבועיים מאז האימון האחרון/);            // no 7-day message was ever sent → stand-alone wording
    expect(ep1('absence14', d14).variant).toBe('standalone');
    // Tuesday next day: d6 reaches 7 days and d13 reaches 14 (both crossed AFTER activation) → each gets its
    // absence message; the Tuesday program leaves all absent members to the absence track — nobody gets two.
    at(TUE);
    const r2 = await runAll();
    expect(r2.sent).toBe(2);
    expect(got(d6)).toHaveLength(1); expect(got(d6)[0]).toMatch(/בשבוע האחרון/);
    expect(got(d13)).toHaveLength(1); expect(ep1('absence14', d13).variant).toBe('standalone');
    expect((await reasons('tuesday', d7)).reasons).toEqual(['absence_track']);
    expect(got(d7)).toHaveLength(1);
    expect(mockOut.texts.filter(t => /עוד לא נקבע לך אימון השבוע/.test(t.text))).toHaveLength(0);
    // d14 comes back: verified attendance closes the episode and shows in "returned"
    attend(d14, addIso(MON, 2));
    at(addIso(MON, 3));
    await runAll();
    expect(ep1('absence14', d14)).toMatchObject({ status: 'closed', returnedOn: addIso(MON, 2), conversation: { outcome: 'returned' } });
    expect((await get('/api/tomer/care/visibility')).body.returned.map(x => x.userId)).toEqual([String(d14.userId)]);
    // a week later d7 is 14 days absent and never answered → a DIFFERENT message, once
    at(addIso(MON, 7));
    const r3 = await runAll();
    expect(r3.sent).toBe(2);                                                   // d7, and "upcoming" (she booked but never came → now 14 days absent)
    expect(ep1('absence14', upcoming).variant).toBe('standalone');
    expect(got(d7)).toHaveLength(2);
    expect(got(d7)[1]).toMatch(/עברו כבר שבועיים מאז האימון האחרון שלך\. אנחנו כאן כשיתאים לך לחזור/);
    expect(got(d7)[1]).not.toBe(got(d7)[0]);
    expect(ep1('absence14', d7).variant).toBe('no_reply');
    await runAll();
    expect(got(d7)).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('5. Contact policy — one shared layer', () => {
  test('pause, freeze, opt-outs, shared phone block; human ownership, open case, recent conversation defer — and a deferred episode is sent once the reason is gone', async () => {
    world(MON, '09:50');
    const day = addIso(MON, -7);
    const mk = () => { const m = cm(); attend(m, day); return m; };
    const paused = mk(), frozen = mk(), optedOut = mk(), human = mk(), withCase = mk(), chatting = mk(), careOut = mk(), ok = mk();
    const shared = cm({ phone: '972507770001' }); attend(shared, day); cm({ phone: '972507770001' });
    await enable('absence7');
    careStore.setPause(paused.phone, { reason: 'vacation', until: addIso(MON, 10) });
    arbox.state.holds.push({ user_id: frozen.userId });
    setLead(optedOut, 'opted_out'); setLead(human, 'human_owns');
    cases.create({ phone: withCase.phone, category: 'billing_dispute', summary: 'x', notificationRequired: false });
    inbox.pushOutbound({ phone: chatting.phone, name: null, text: 'שיחה פעילה', agentId: 'staff' });
    careStore.setCareOptOut(careOut.phone);
    at(MON);
    const want = [[paused, 'block', 'paused'], [frozen, 'block', 'on_hold'], [optedOut, 'block', 'opted_out'], [careOut, 'block', 'care_opt_out'], [shared, 'block', 'phone_shared'],
      [human, 'defer', 'human_owns'], [withCase, 'defer', 'open_case'], [chatting, 'defer', 'recent_conversation']];
    for (const [m, decision, code] of want) expect(await reasons('absence7', m)).toMatchObject({ included: true, decision, reasons: expect.arrayContaining([code]) });
    const r = await runAll();
    expect(r).toMatchObject({ sent: 1, blocked: 5, deferred: 3 });
    expect(mockOut.texts.map(t => t.to)).toEqual([ok.phone]);
    expect(ep1('absence7', human)).toMatchObject({ status: 'deferred', reasons: ['human_owns'] });
    // staff release the conversation → the deferred episode goes out on the next run (still inside its window)
    store.upsertLead(human.phone, { status: 'converted_member' });
    at(addIso(MON, 1));
    await runAll();
    expect(got(human)).toHaveLength(1);
    expect(got(paused).length + got(frozen).length + got(optedOut).length + got(careOut).length + got(withCase).length).toBe(0);
  });

  test('send window: evening, Friday afternoon and Saturday defer; nothing is lost', async () => {
    world(MON, '09:50');
    const a = cm(); attend(a, addIso(MON, -7));
    await enable('absence7');
    at(MON, '21:00');
    expect((await runAll()).deferred).toBe(1);
    expect(ep1('absence7', a)).toMatchObject({ status: 'deferred', reasons: ['outside_window'] });
    at(addIso(MON, 4), '14:00');                                               // Friday 14:00
    expect((await reasons('absence7', a)).reasons).toEqual(['outside_window']);
    at(addIso(MON, 5), '11:00');                                               // Saturday
    expect((await reasons('absence7', a)).reasons).toEqual(['outside_window']);
    at(addIso(MON, 6), '10:05');                                               // Sunday, day 13 — still in the window
    expect((await runAll()).sent).toBe(1);
    expect(got(a)).toHaveLength(1);
  });

  test('one proactive message per member per run, by priority; the other waits for the cooldown instead of being dropped', async () => {
    world(MON, '09:50');
    const m = cm({ birthday: `1990-${MON.slice(5)}` }); attend(m, addIso(MON, -7));
    await enable('absence7', 'birthday');
    at(MON);
    expect((await runAll()).sent).toBe(1);
    expect(got(m)[0]).toMatch(/מזל טוב ליום ההולדת/);
    expect(ep1('absence7', m)).toMatchObject({ status: 'deferred', reasons: ['one_message_per_run'] });
    at(addIso(MON, 1));
    await runAll();
    expect(ep1('absence7', m).reasons).toEqual(expect.arrayContaining(['cooldown']));
    at(addIso(MON, 3), '10:30');                                               // 72h later, day 10 of the absence
    await runAll();
    expect(got(m)).toHaveLength(2);
    expect(got(m)[1]).toMatch(/לא ראינו אותך/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('6. Birthdays', () => {
  test('once a year, valid dates only, no age; 29 February is greeted on 28 February in a non-leap year', async () => {
    world('2027-02-28', '08:50');                                              // Sunday; 2027 has no 29 Feb
    const leap = cm({ first: 'יעל', birthday: '1992-02-29' });
    const today = cm({ first: 'עומר', gender: 'male', birthday: '1985-02-28' });
    const bogus = cm({ birthday: '1900-02-28' });
    const none = cm();
    const other = cm({ birthday: '1990-03-01' });
    const yesterday = cm({ birthday: '1990-02-27' });                          // never replayed
    await enable('birthday');
    at('2027-02-28', '09:05');
    expect((await reasons('birthday', bogus)).reasons).toEqual(['birthday_invalid']);
    expect((await reasons('birthday', none)).reasons).toEqual(['no_birthday']);
    expect((await reasons('birthday', other)).reasons).toEqual(['not_today']);
    expect((await reasons('birthday', yesterday)).reasons).toEqual(['not_today']);
    expect((await runAll()).sent).toBe(2);
    expect(got(leap)[0]).toMatch(/^.*יעל, מזל טוב ליום ההולדת! 🎉/s);
    for (const t of [...got(leap), ...got(today)]) expect(t).not.toMatch(/\d{2,}|בת \d|בן \d|גיל/);          // no age, no year
    expect(JSON.stringify(ep1('birthday', leap))).not.toContain('1992');
    await runAll();
    expect(got(leap)).toHaveLength(1);
    expect(got(bogus).length + got(none).length + got(other).length + got(yesterday).length).toBe(0);
  });

  test('a Saturday birthday is greeted on Friday (proposed default), worded as "tomorrow"', async () => {
    world('2026-11-20', '08:50');                                              // Friday; Saturday is 21.11
    const m = cm({ birthday: '1991-11-21' });
    await enable('birthday');
    at('2026-11-20', '09:05');
    expect((await runAll()).sent).toBe(1);
    expect(got(m)[0]).toMatch(/מזל טוב לקראת יום ההולדת שלך מחר/);
    at('2026-11-21', '11:00'); await runAll(); at('2026-11-22', '09:05'); await runAll();
    expect(got(m)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('7. Failed monthly payment', () => {
  const setup = async () => {
    await post('/api/tomer/care/settings', { paymentResolution: 'אפשר לעדכן אמצעי תשלום באפליקציית Arbox, או מול הצוות בסטודיו.', billingDataConfirmed: true });
    await enable('payment_failed');
  };
  test('blocked until a safe resolution method is set and the billing data is confirmed; unsafe wording is refused', async () => {
    world(MON, '09:50');
    expect((await post('/api/tomer/care/settings', { paymentResolution: 'שלחו לי את מספר הכרטיס וה-CVV' })).body.error).toBe('unsafe_payment_text');
    await post('/api/tomer/care/settings', { paymentResolution: 'אפשר לעדכן באפליקציה.' });
    expect((await post('/api/tomer/care/programs/payment_failed', { enabled: true })).body.blocks.map(b => b.code)).toEqual(['billing_data_unconfirmed']);
  });

  test('verified FAIL event → one discreet message per charge after the grace period; resolved-before-send is never sent; nothing is inferred from an expired membership', async () => {
    world(MON, '09:50');
    await setup();
    const a = cm({ first: 'ליאת' }); const ma = arbox.state.memberships.at(-1).membership_user_id;
    const b = cm(); const mb = arbox.state.memberships.at(-1).membership_user_id;
    const old = cm(); const mo = arbox.state.memberships.at(-1).membership_user_id;
    const expired = cm({ plan: null }); ms(expired, { typeId: T_FIX, start: '2026-08-01', end: addIso(MON, -3), active: 0 });   // expired ≠ failed payment
    tx(a, ma, `${MON} 03:00`, 'FAIL'); tx(a, ma, `${MON} 03:05`, 'FAIL');     // a retry of the same charge
    tx(b, mb, `${MON} 03:00`, 'FAIL');
    tx(old, mo, `${addIso(MON, -5)} 03:00`, 'FAIL');                           // before activation
    at(MON);
    const r1 = await runAll();
    expect(r1).toMatchObject({ sent: 0, deferred: 2 });
    expect(ep1('payment_failed', a)).toMatchObject({ status: 'deferred', reasons: ['in_grace'], sourceDates: { failures: 2 } });   // kept, not dropped
    tx(b, mb, `${MON} 15:00`, 'SUCCESS');                                      // b's payment goes through before we write
    at(TUE);
    const r2 = await runAll();
    expect(r2.sent).toBe(1);
    expect(got(a)).toHaveLength(1);
    expect(got(a)[0]).toMatch(/הודעה קצרה ודיסקרטית: החיוב החודשי האחרון על המנוי לא עבר/);
    expect(got(a)[0]).toMatch(/לא שולחים פרטי כרטיס או קוד אבטחה בוואטסאפ/);
    expect(got(a)[0]).not.toMatch(/1234|₪|\d{3,}/);                            // no card digits, no amount
    expect(got(b)).toHaveLength(0);
    expect(ep1('payment_failed', b)).toMatchObject({ status: 'cancelled' });
    expect(got(old).length + got(expired).length).toBe(0);
    at(addIso(MON, 2)); await runAll();
    expect(got(a)).toHaveLength(1);                                            // once per charge
    // "I paid" is checked against Arbox, not believed
    const claim = await say(a.phone, 'שילמתי');
    expect(claim.route).toBe('tomer_case_opened');
    expect(lastTo(a.phone)).toMatch(/עדיין לא מופיע חיוב שעבר/);
    tx(a, ma, `${addIso(MON, 2)} 12:00`, 'SUCCESS');
    at(addIso(MON, 3)); await runAll();
    expect(ep1('payment_failed', a)).toMatchObject({ status: 'closed', conversation: { outcome: 'resolved' } });   // follow-up stops
  });

  test('payment that succeeds between the snapshot and the send cancels the message; missing billing data blocks the program', async () => {
    world(MON, '09:50');
    await setup();
    const a = cm(); const ma = arbox.state.memberships.at(-1).membership_user_id;
    tx(a, ma, `${MON} 03:00`, 'FAIL');
    at(TUE);
    arbox.mode.after = { '/v3/reports/transactionsReport': s => s.transactions.push({ transaction_id: 99, user_id: a.userId, membership_user_id: ma, transaction_date: TUE, transaction_date_time: `${TUE} 09:00`, type: 'RECURRING', status: 'SUCCESS' }) };
    expect(await runAll()).toMatchObject({ sent: 0, cancelled: 1 });
    expect(ep1('payment_failed', a)).toMatchObject({ status: 'cancelled', reasons: ['resolved'] });
    arbox.mode.billingDown = true;
    const r = await runAll();
    expect(r.dataBlocked.map(d => d.program)).toEqual(['payment_failed']);
    expect(mockOut.texts).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('8. Non-recurring membership — five days to expiry', () => {
  test('exact membership and full date; recurring, already-renewed and unknown-type memberships are excluded; "yes" opens a staff case — nothing is renewed or charged', async () => {
    world(MON, '09:50');
    const end = addIso(MON, 5);
    const fixed = cm({ first: 'אורית', plan: null }); ms(fixed, { typeId: T_FIX, start: '2026-08-22', end });
    const recurring = cm({ plan: null }); ms(recurring, { typeId: T_REC, start: '2026-08-22', end });
    const renewed = cm({ plan: null }); ms(renewed, { typeId: T_FIX, start: '2026-08-22', end }); ms(renewed, { typeId: T_FIX, start: addIso(end, 1), end: addIso(end, 90), active: 0 });
    const unknown = cm({ plan: null }); ms(unknown, { typeId: T_DELETED, start: '2026-08-22', end });
    const later = cm({ plan: null }); ms(later, { typeId: T_FIX, start: '2026-08-22', end: addIso(MON, 9) });
    const no = cm({ plan: null }); ms(no, { typeId: T_FIX, start: '2026-08-22', end });
    await enable('expiry5');
    at(MON);
    expect((await reasons('expiry5', recurring)).reasons).toEqual(['recurring']);
    expect((await reasons('expiry5', renewed)).reasons).toEqual(['renewed']);
    expect((await reasons('expiry5', unknown)).reasons).toEqual(['type_unknown']);
    expect((await reasons('expiry5', later)).reasons).toEqual(['not_in_window']);
    expect((await runAll()).sent).toBe(2);
    expect(got(fixed)[0]).toContain(`המנוי שלך (מנוי 3 חודשים) בתוקף עד ${end.split('-').reverse().join('.')}`);
    expect(got(fixed)[0]).toMatch(/אני לא מחדש ולא מחייב בעצמי/);
    at(TUE); await runAll();
    expect(got(fixed)).toHaveLength(1);
    const yes = await say(fixed.phone, 'כן, רוצה לחדש');
    expect(yes.route).toBe('tomer_case_opened');
    const [c] = cases.list({ phone: fixed.phone, open: true });
    expect(c).toMatchObject({ category: 'membership_renew' });
    expect(c.summary).toContain(end.split('-').reverse().join('.'));
    expect(mockOut.mgr).toHaveLength(1);
    expect(lastTo(fixed.phone)).toMatch(/המנוי לא חודש ולא בוצע חיוב בשלב זה/);
    expect(ep1('expiry5', fixed)).toMatchObject({ caseId: c.id, conversation: { outcome: 'renew_requested' } });
    const nope = await say(no.phone, 'לא תודה');
    expect(nope.route).toBe('tomer_care_reply');
    expect(cases.list({ phone: no.phone })).toHaveLength(0);
    expect(arbox.writes()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('9. Onboarding (14 days), first month, guest-session entitlement', () => {
  test('wording follows verified attendance; renewals are not onboarded; the month-1 offer issues ONE durable entitlement of two sessions', async () => {
    world(MON, '09:50');
    const trained = cm({ first: 'מאיה', plan: addIso(MON, -14) }); attend(trained, addIso(MON, -10)); attend(trained, addIso(MON, -3));
    const never = cm({ first: 'טל', plan: addIso(MON, -14) });
    const renewal = cm({ plan: '2025-03-01' }); ms(renewal, { start: addIso(MON, -14) });
    const month = cm({ first: 'נטע', plan: addIso(MON, -30) }); attend(month, addIso(MON, -4));
    await enable('onboarding14', 'month1');
    at(MON, '11:05');
    expect((await reasons('onboarding14', renewal)).included).toBe(false);
    expect((await runAll()).sent).toBe(3);
    expect(got(trained)[0]).toMatch(/עברו שבועיים מאז שהצטרפת 💛 איך ההרגשה עד עכשיו/);
    expect(got(never)[0]).toMatch(/עוד לא יצא לך להגיע לאימון/);                // does not assume they trained
    expect(got(month)[0]).toMatch(/חודש ראשון ב־Shape Studio מאחוריך/);
    expect(got(month)[0]).toMatch(/שני אימוני אורח במתנה, לחברים או למשפחה/);
    expect(got(month)[0]).not.toMatch(/בתוקף עד|עד סוף|ב-Arbox|נקבע/);         // no invented expiry / booking claims
    expect(careStore.getEntitlement(month.userId)).toMatchObject({ total: 2, remaining: 2, reserved: 0, redeemed: 0 });
    await runAll(); at(addIso(MON, 1), '11:05'); await runAll();
    expect(got(month)).toHaveLength(1);
    expect(careStore.listEntitlements()).toHaveLength(1);
    // "I want to bring a friend" → staff case; reservations and redemptions are tracked and capped
    const g = await say(month.phone, 'רוצה להביא חברה');
    expect(g.route).toBe('tomer_case_opened');
    const [c] = cases.list({ phone: month.phone, open: true });
    expect(c.category).toBe('guest_pass');
    expect(lastTo(month.phone)).toMatch(/האימון עוד לא נקבע בשלב זה/);
    const r1 = await post(`/api/tomer/care/entitlements/${month.userId}/reserve`, { guestName: 'חברה א', by: 'עדן', caseId: c.id });
    const r2 = await post(`/api/tomer/care/entitlements/${month.userId}/reserve`, { guestName: 'חברה ב', by: 'עדן' });
    expect(r2.body.entitlement).toMatchObject({ remaining: 0, reserved: 2 });
    expect((await post(`/api/tomer/care/entitlements/${month.userId}/reserve`, {})).body.error).toBe('none_remaining');
    const red = await post(`/api/tomer/care/entitlements/${month.userId}/redeem`, { itemId: r1.body.item.id, by: 'עדן' });
    expect(red.body.entitlement).toMatchObject({ redeemed: 1, reserved: 1, remaining: 0 });
    expect((await post(`/api/tomer/care/entitlements/${month.userId}/redeem`, { itemId: r1.body.item.id })).body.error).toBe('already_redeemed');
    const rel = await post(`/api/tomer/care/entitlements/${month.userId}/release`, { itemId: r2.body.item.id, by: 'עדן' });
    expect(rel.body.entitlement).toMatchObject({ redeemed: 1, reserved: 0, remaining: 1 });
    expect((await post(`/api/tomer/care/entitlements/${month.userId}/release`, { itemId: r1.body.item.id })).body.error).toBe('already_redeemed');
    reboot();
    expect(careStore.getEntitlement(month.userId)).toMatchObject({ redeemed: 1, remaining: 1 });                 // durable
    expect(careStore.issueEntitlement({ userId: month.userId, phone: month.phone, name: 'x' }).alreadyIssued).toBe(true);
  });

  test('visibility: new members who have not attended a first session are listed — and get no absence messages', async () => {
    world(MON, '09:50');
    const newbie = cm({ first: 'אלה', plan: addIso(MON, -9) });
    await enable('absence7', 'tuesday');
    at(MON);
    expect((await reasons('absence7', newbie)).reasons).toEqual(['new_never_attended']);
    const v = (await get('/api/tomer/care/visibility')).body;
    expect(v.newNotAttended).toEqual([expect.objectContaining({ userId: String(newbie.userId), daysSinceStart: 9 })]);
    await runAll();
    expect(got(newbie)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('10. Replies continue the conversation', () => {
  async function absent(first = 'דנה') {
    world(MON, '09:50');
    const m = cm({ first }); attend(m, addIso(MON, -7));
    await enable('absence7', 'absence14', 'tuesday');
    at(MON); await runAll();
    expect(got(m)).toHaveLength(1);
    return m;
  }
  test('"אני בחופשה" pauses outreach at once, asks for the return date instead of guessing, then records it', async () => {
    const m = await absent();
    const r = await say(m.phone, 'אני בחופשה');
    expect(r.route).toBe('tomer_care_reply');
    expect(lastTo(m.phone)).toMatch(/עד מתי בערך\?/);
    expect(careStore.getPause(m.phone, new Date())).toMatchObject({ reason: 'vacation', endKnown: false });
    await say(m.phone, 'חוזרת ב-10.12');
    expect(careStore.getPause(m.phone, new Date())).toMatchObject({ until: '2026-12-10', endKnown: true });
    expect(lastTo(m.phone)).toMatch(/לא אכתוב לך עד 10\.12\.2026/);
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
    at(addIso(MON, 7)); await runAll();                                       // day 14 — paused
    expect(got(m).filter(t => /שבועיים/.test(t))).toHaveLength(0);
    expect(ep1('absence14', m)).toMatchObject({ status: 'blocked', reasons: expect.arrayContaining(['paused']) });
  });

  test('"אני פצועה" → staff case + manager alert + pause; no medical advice', async () => {
    const m = await absent();
    const r = await say(m.phone, 'אני פצועה בגב');
    expect(r.route).toBe('tomer_case_opened');
    expect(cases.list({ phone: m.phone, open: true })[0]).toMatchObject({ category: 'injury', priority: 'high' });
    expect(mockOut.mgr).toHaveLength(1);
    expect(lastTo(m.phone)).toMatch(/לא אשלח הודעות על אימונים בזמן הקרוב/);
    expect(lastTo(m.phone)).not.toMatch(/מומלץ|כדאי ל|תנוח|קרח|תרגיל/);
    expect(careStore.getPause(m.phone, new Date())).toMatchObject({ reason: 'injury', endKnown: false });
  });

  test('"לא מסתדר לי עם השעות" → one question, then the real timetable for what they said', async () => {
    const m = await absent();
    await say(m.phone, 'לא מסתדר לי עם השעות');
    expect(lastTo(m.phone)).toMatch(/אילו ימים ושעות נוחים לך/);
    const r = await say(m.phone, 'מחר בערב');
    expect(r.route).toBe('tomer_answered');
    expect(lastTo(m.phone)).toMatch(/19:00 פילאטיס מכשירים/);
    expect(ep1('absence7', m).conversation).toMatchObject({ outcome: 'schedule', awaiting: null });
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
  });

  test('"כבר הייתי השבוע": the source is re-read — confirmed → apology; not confirmed → a review case, never an argument', async () => {
    world(TUE, '09:50');
    const a = cm(), b = cm(); attend(a, addIso(TUE, -5)); attend(b, addIso(TUE, -5));
    await enable('tuesday');
    at(TUE); await runAll();
    attend(a, addIso(TUE, -1));                                               // the check-in was recorded late
    const ra = await say(a.phone, 'כבר הייתי השבוע');
    expect(ra.route).toBe('tomer_care_reply');
    expect(lastTo(a.phone)).toMatch(/נכון, סליחה על הבלבול/);
    expect(ep1('tuesday', a)).toMatchObject({ status: 'closed', conversation: { outcome: 'data_corrected' } });
    const rb = await say(b.phone, 'כבר הייתי השבוע');
    expect(rb.route).toBe('tomer_case_opened');
    expect(cases.list({ phone: b.phone, open: true })[0].category).toBe('data_review');
    expect(lastTo(b.phone)).toMatch(/רשמתי לצוות לבדוק/);
  });

  test('"לא התחברתי" → one open question, then the answer goes to staff as feedback', async () => {
    world(MON, '09:50');
    const m = cm({ plan: addIso(MON, -14) }); attend(m, addIso(MON, -8));
    await enable('onboarding14');
    at(MON, '11:05'); await runAll();
    await say(m.phone, 'האמת שלא התחברתי');
    expect(lastTo(m.phone)).toMatch(/מה היה חסר לך/);
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
    const r = await say(m.phone, 'השיעורים עמוסים מדי ואין יחס אישי');
    expect(r.route).toBe('tomer_case_opened');
    expect(cases.list({ phone: m.phone, open: true })[0]).toMatchObject({ category: 'member_feedback' });
    expect(cases.list({ phone: m.phone, open: true })[0].context[0].text).toMatch(/עמוסים מדי/);
  });

  test('"תפסיקו לשלוח לי" stops proactive messages only — the member can still ask Tomer anything', async () => {
    const m = await absent();
    const r = await say(m.phone, 'תפסיקו לשלוח לי הודעות כאלה');
    expect(r.route).toBe('tomer_care_reply');
    expect(lastTo(m.phone)).toMatch(/לא אשלח יותר הודעות יזומות/);
    expect(careStore.isCareOptedOut(m.phone)).toBe(true);
    expect(store.getLead(m.phone)?.status).not.toBe('opted_out');
    at(addIso(MON, 7)); await runAll();
    expect(ep1('absence14', m)).toMatchObject({ status: 'blocked', reasons: expect.arrayContaining(['care_opt_out']) });
    const q = await say(m.phone, 'מה יש מחר?');
    expect(q.route).toBe('tomer_answered');
  });

  test('other topics are not swallowed', async () => {
    const m = await absent();
    const c = await say(m.phone, 'רוצה לבטל את המנוי');
    expect(c.route).toBe('tomer_case_opened');
    expect(cases.list({ phone: m.phone, open: true })[0].category).toBe('membership_cancel');
  });

  test('human takeover governs both directions: the reply is held for staff and further proactive messages are deferred', async () => {
    const m = await absent();
    setLead(m, 'human_owns');
    const n0 = got(m).length;
    expect((await say(m.phone, 'אני בחופשה')).route).toBe('human_owns_hold');
    expect(got(m)).toHaveLength(n0);
    expect(careStore.getPause(m.phone, new Date())).toBeNull();               // Tomer did not interpret it
    at(addIso(MON, 7)); await runAll();
    expect(ep1('absence14', m)).toMatchObject({ status: 'deferred', reasons: expect.arrayContaining(['human_owns']) });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('11. Reliability', () => {
  const one = async () => { world(MON, '09:50'); const m = cm(); attend(m, addIso(MON, -7)); await enable('absence7'); at(MON); return m; };

  test('ambiguous provider result → "uncertain": never re-sent by a run; staff decide', async () => {
    const m = await one();
    mockOut.memberMode = 'timeout';
    expect((await runAll()).uncertain).toBe(1);
    mockOut.memberMode = 'ok';
    await runAll(); at(addIso(MON, 1)); await runAll();
    expect(got(m)).toHaveLength(0);
    expect(ep1('absence7', m)).toMatchObject({ status: 'uncertain' });
    const key = ep1('absence7', m).key;
    expect((await post('/api/tomer/care/episodes/resolve', { key, action: 'mark_not_sent', by: 'עדן' })).body.episode.status).toBe('pending');
    await runAll();
    expect(got(m)).toHaveLength(1);
    expect((await post('/api/tomer/care/episodes/resolve', { key, action: 'mark_sent' })).body.error).toBe('not_uncertain');
  });

  test('a refused send is "failed" and retried on the next run — exactly one message arrives', async () => {
    const m = await one();
    mockOut.memberMode = 'reject';
    expect((await runAll()).failed).toBe(1);
    mockOut.memberMode = 'ok';
    await runAll(); await runAll();
    expect(got(m)).toHaveLength(1);
    expect(ep1('absence7', m).send.attempts).toBe(2);
  });

  test('restart in the middle of a send → "uncertain", nothing is sent on startup; state survives', async () => {
    const m = await one();
    await runAll();
    const b = cm(); attend(b, addIso(MON, -7));
    careStore.upsertEpisode(careStore.episodeKey('absence7', b.userId, `abs:${addIso(MON, -7)}`), { program: 'absence7', userId: String(b.userId), phone: b.phone, status: 'sending', send: { state: 'sending', startedAt: new Date().toISOString() } });
    const n = mockOut.texts.length;
    reboot();
    expect(await waitFor(() => (ep1('absence7', b)?.status === 'uncertain' ? true : null))).toBe(true);
    expect(mockOut.texts).toHaveLength(n);
    await runAll();
    expect(got(b)).toHaveLength(0);                                            // not blindly resent
    expect(ep1('absence7', m)).toMatchObject({ status: 'sent' });
    expect((await get('/api/tomer/care/overview')).body.programs.find(p => p.id === 'absence7')).toMatchObject({ enabled: true });
  });

  test('state cannot be saved → nothing is sent (the durable record comes first)', async () => {
    const m = await one();
    const real = fs.renameSync;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((a, b) => { if (String(b).endsWith('member_care.json')) throw new Error('ENOSPC'); return real(a, b); });
    try { await runAll().catch(() => null); } finally { spy.mockRestore(); }
    expect(got(m)).toHaveLength(0);
    await runAll();
    expect(got(m)).toHaveLength(1);
  });

  test('duplicate workers: concurrent runs and a second process holding the lock do not double-send', async () => {
    const m = await one();
    const [a, b] = await Promise.all([runAll(), care.run({ trigger: 'dup' })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a.reason, b.reason]).toContain('already_running');
    expect(got(m)).toHaveLength(1);
    const n = cm(); attend(n, addIso(MON, -7));
    const raw = JSON.parse(fs.readFileSync(CARE_FILE, 'utf8')); raw.lock = { owner: 'another-process', until: Date.now() + 60000 }; fs.writeFileSync(CARE_FILE, JSON.stringify(raw)); careStore.reload();
    expect(await runAll()).toMatchObject({ ok: false, reason: 'already_running' });
    expect(got(n)).toHaveLength(0);
    at(MON, '10:20');                                                          // the foreign lock expired
    expect((await runAll()).sent).toBe(1);
  });

  test('scheduler: each program runs once a day at its hour; not before; settings are validated', async () => {
    const m = await one();
    at(MON, '09:55');
    expect((await care.tick()).due).toEqual([]);
    at(MON, '10:01');
    expect((await care.tick()).due).toEqual(['absence7']);
    expect(got(m)).toHaveLength(1);
    expect((await care.tick()).due).toEqual([]);
    expect((await post('/api/tomer/care/programs/absence7', { hour: 23 })).body.error).toBe('bad_hour');
    expect((await post('/api/tomer/care/settings', { policy: { cooldownHours: -1 } })).body.error).toBe('bad_policy');
    expect((await post('/api/tomer/care/settings', { policy: { cooldownHours: 96, managerDigest: true } })).body.overview.settings.policy).toMatchObject({ cooldownHours: 96, managerDigest: false });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('12. Reports and pauses', () => {
  test('absence report: last verified attendance, days absent, future booking, last outreach, response, owner, next action', async () => {
    world(MON, '09:50');
    const a = cm({ first: 'אביגיל' }); attend(a, addIso(MON, -7));
    const b = cm({ first: 'בתיה' }); attend(b, addIso(MON, -9)); booked(b, addIso(MON, 2));
    const c = cm({ first: 'גליה' });                                           // nothing in 30 days
    await enable('absence7');
    at(MON); await runAll();
    await say(a.phone, 'הכל בסדר, אחזור בשבוע הבא');
    const rep = (await get('/api/tomer/care/absence-report')).body;
    const row = m => rep.rows.find(r => r.userId === String(m.userId));
    expect(row(a)).toMatchObject({ lastAttendance: addIso(MON, -7), daysAbsent: 7, futureBooking: null, lastOutreach: { program: 'absence7', status: 'closed' }, response: 'ok', owner: 'תומר' });
    expect(row(b)).toMatchObject({ daysAbsent: 9, futureBooking: { date: addIso(MON, 2) }, lastOutreach: null });
    expect(row(b).nextAction).toMatch(/רשום\/ה לאימון/);
    expect(row(c)).toMatchObject({ lastAttendance: null, daysAbsent: null, attendanceKnown: false });
    arbox.mode.bookingsDown = true; gateway.clearCache();
    const down = (await get('/api/tomer/care/absence-report')).body;
    expect(down.rows.every(r => r.daysAbsent === null && r.nextAction === 'נתוני נוכחות לא זמינים')).toBe(true);   // unknown, not "absent"
  });

  test('staff pause with a reason and end date blocks attendance outreach until it ends; removing it restores eligibility', async () => {
    world(MON, '09:50');
    const m = cm(); attend(m, addIso(MON, -7));
    await enable('absence7');
    expect((await post('/api/tomer/care/pauses', { phone: m.phone, until: addIso(MON, 2) })).body.error).toBe('reason_required');
    const p = await post('/api/tomer/care/pauses', { phone: `0${m.phone.slice(3)}`, reason: 'חופשה', until: addIso(MON, 2), by: 'עדן' });
    expect(p.body.pauses).toEqual([expect.objectContaining({ phone: m.phone, reason: 'חופשה', until: addIso(MON, 2), setBy: 'עדן' })]);
    at(MON); await runAll();
    expect(got(m)).toHaveLength(0);
    at(addIso(MON, 3)); await runAll();                                        // the pause ended yesterday; day 10 of the absence
    expect(got(m)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('13. Late and ambiguous replies — context or ONE clarification, never a blind template', () => {
  async function absent(first = 'דנה') {
    world(MON, '09:50');
    const m = cm({ first }); attend(m, addIso(MON, -7));
    await enable('absence7');
    at(MON); await runAll();
    expect(got(m)).toHaveLength(1);
    return m;
  }
  const UNRELATED = /לא ראינו אותך|שמח לשמוע|אנחנו כאן כשיתאים|אילו ימים ושעות/;

  test('a bare "כן" six days later is not discarded and not guessed: one clarification naming the message; "כן" continues that conversation', async () => {
    const m = await absent();
    at(addIso(MON, 6), '10:30');                                               // outside the 5-day reply window
    const before = got(m).length;
    const r = await say(m.phone, 'כן');
    expect(r.route).toBe('tomer_care_reply');
    expect(got(m)).toHaveLength(before + 1);
    expect(lastTo(m.phone)).toMatch(/זה בהמשך להודעה ששלחתי לך ב-16\.11\.2026 בנושא החזרה לאימונים\?/);
    expect(lastTo(m.phone)).not.toMatch(UNRELATED);
    const ep = ep1('absence7', m);
    expect(ep.status).toBe('sent');                                            // history kept, nothing closed or dropped
    expect(ep.conversation).toMatchObject({ awaiting: 'late_confirm', pendingText: 'כן' });
    expect(ep.conversation.replies.at(-1)).toMatchObject({ text: 'כן', kind: 'clarify_asked', late: true });
    const c = await say(m.phone, 'כן');                                        // confirms the context
    expect(c.route).toBe('tomer_care_reply');
    expect(lastTo(m.phone)).toMatch(/אילו ימים ושעות נוחים לך/);               // the ORIGINAL "כן" is now read against the absence message
    expect(ep1('absence7', m).conversation).toMatchObject({ outcome: 'schedule', awaiting: 'schedule_pref', pendingText: null });
    expect(ep1('absence7', m).send.idMessage).toBe(ep.send.idMessage);         // the outreach record is intact
  });

  test('"לא" to the clarification detaches the old message: no template, no second clarification, nothing assumed', async () => {
    const m = await absent();
    at(addIso(MON, 8), '11:00');
    await say(m.phone, 'כן');
    expect(lastTo(m.phone)).toMatch(/זה בהמשך להודעה ששלחתי/);
    const r = await say(m.phone, 'לא');
    expect(r.route).toBe('tomer_care_reply');
    expect(lastTo(m.phone)).toMatch(/הבנתי, תודה/);
    expect(lastTo(m.phone)).not.toMatch(UNRELATED);
    expect(ep1('absence7', m).conversation).toMatchObject({ detached: 'member_said_unrelated', awaiting: null });
    expect(cases.list({ phone: m.phone })).toHaveLength(0);
    const n = got(m).length;
    const again = await say(m.phone, 'כן');                                    // a later bare word is no longer tied to that message
    expect(again.viaCare).toBeFalsy();
    expect(got(m).filter(t => /זה בהמשך להודעה/.test(t))).toHaveLength(1);     // the clarification was asked exactly once
    expect(got(m).slice(n).join(' ')).not.toMatch(UNRELATED);
    expect(ep1('absence7', m)).toMatchObject({ status: 'sent' });              // still on record
  });

  test('a late reply that says what it is about is resolved from context without a clarification', async () => {
    const m = await absent();
    at(addIso(MON, 9), '10:30');
    const r = await say(m.phone, 'אני בחופשה עד 20.12');
    expect(r.route).toBe('tomer_care_reply');
    expect(lastTo(m.phone)).toMatch(/לא אכתוב לך עד 20\.12\.2026/);
    expect(got(m).some(t => /זה בהמשך להודעה/.test(t))).toBe(false);
    expect(careStore.getPause(m.phone, new Date())).toMatchObject({ reason: 'vacation', until: '2026-12-20', endKnown: true });
    expect(ep1('absence7', m).conversation.replies.at(-1)).toMatchObject({ kind: 'vacation', late: true });
  });

  test('a late reply on another topic goes to the general service and is recorded on the episode; a late "תודה" gets no program wording', async () => {
    const m = await absent();
    at(addIso(MON, 7), '10:30');
    const c = await say(m.phone, 'רוצה לבטל את המנוי');
    expect(c.route).toBe('tomer_case_opened');
    expect(cases.list({ phone: m.phone, open: true })[0].category).toBe('membership_cancel');
    expect(ep1('absence7', m).conversation.replies.at(-1)).toMatchObject({ kind: 'other_topic', late: true });
    const k = await absent('רונית');
    at(addIso(MON, 7), '10:30');
    const n = got(k).length;
    await say(k.phone, 'תודה');
    expect(got(k).slice(n).join(' ')).not.toMatch(UNRELATED);
    expect(ep1('absence7', k).conversation.replies.at(-1)).toMatchObject({ text: 'תודה', kind: 'fine', late: true });
    expect(ep1('absence7', k).status).toBe('sent');
  });

  test('a reply after the episode was closed for silence (30+ days) is still read against it; beyond the look-back it is a new conversation', async () => {
    const m = await absent();
    at(addIso(MON, 33), '10:30'); await runAll();                              // closes the unanswered episode ("no reply")
    expect(ep1('absence7', m)).toMatchObject({ status: 'closed', conversation: { outcome: 'no_reply' } });
    const r = await say(m.phone, 'כן');
    expect(r.route).toBe('tomer_care_reply');
    expect(lastTo(m.phone)).toMatch(/זה בהמשך להודעה ששלחתי לך ב-16\.11\.2026/);
    const k = await absent('רונית');
    at(addIso(MON, 75), '10:30');
    const far = await say(k.phone, 'כן');
    expect(far.viaCare).toBeFalsy();
    expect(got(k).some(t => /זה בהמשך להודעה/.test(t))).toBe(false);
    expect(ep1('absence7', k).send.idMessage).toBeTruthy();                    // the outreach history itself is never deleted
  });

  test('inside the window, a bare "כן" while two different messages are open is clarified instead of guessed', async () => {
    world(MON, '08:50');
    const m = cm({ first: 'יעל', birthday: '1990-11-16' }); attend(m, addIso(MON, -7));
    await enable('birthday', 'absence7');
    at(MON, '09:05'); await runAll();                                          // birthday (priority) — absence waits
    at(addIso(MON, 3), '10:30'); await runAll();                               // 72h cooldown over; the greeting is still inside its reply window
    expect(got(m)).toHaveLength(2);
    const r = await say(m.phone, 'כן');
    expect(r.route).toBe('tomer_care_reply');
    expect(lastTo(m.phone)).toMatch(/זה בהמשך להודעה ששלחתי לך ב-19\.11\.2026 בנושא החזרה לאימונים\?/);
    await say(m.phone, 'כן');
    expect(lastTo(m.phone)).toMatch(/אילו ימים ושעות נוחים לך/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('14. Freeze status: unknown is unknown, not "not frozen"', () => {
  const setup = () => { world(MON, '09:50', { raw: true }); care.approvePolicy({ approved: true, fingerprint: care.policyApproval().fingerprint, by: 'בעלים (בדיקה)' }); };

  test('hold report unconfirmed → every member is "unknown" and absence-related outreach is blocked; birthday is not', async () => {
    setup();
    const a = cm({ birthday: '1990-11-16' }); attend(a, addIso(MON, -7));
    await enable('absence7', 'birthday');
    at(MON);
    const pv = (await get('/api/tomer/care/preview/absence7')).body;
    expect(pv.freeze).toMatchObject({ known: false, reportRead: true, sourceConfirmed: false, unknown: 1, notFrozen: 0, frozen: 0 });
    expect(await reasons('absence7', a)).toMatchObject({ included: true, decision: 'block', reasons: expect.arrayContaining(['freeze_unknown']) });
    const r = await runAll();
    expect(r).toMatchObject({ sent: 1, blocked: 1 });
    expect(got(a)).toHaveLength(1);
    expect(got(a)[0]).toMatch(/מזל טוב/);                                      // not absence-related
    expect(ep1('absence7', a)).toMatchObject({ status: 'blocked', reasons: expect.arrayContaining(['freeze_unknown']) });
    const rep = (await get('/api/tomer/care/absence-report')).body;
    expect(rep.rows.find(x => x.userId === String(a.userId))).toMatchObject({ freeze: 'unknown', membership: 'פעיל (הקפאה לא אומתה)' });
  });

  test('all five attendance / onboarding programs need a known status', () => {
    const policy = require('../services/contact_policy');
    const base = { now: IL(TUE), policy: require('../utils/member_care_store').DEFAULT_POLICY, state: { proactiveOn: true, allowed: true, owner: 'tomer' } };
    const member = f => ({ phone: '972500000001', phoneShared: false, isActive: true, ...(f ? { freeze: f } : {}) });
    for (const program of ['tuesday', 'absence7', 'absence14', 'onboarding14', 'month1']) {
      expect(policy.evaluate({ ...base, program, member: member('unknown') })).toMatchObject({ decision: 'block', reasons: ['freeze_unknown'] });
      expect(policy.evaluate({ ...base, program, member: member(null) })).toMatchObject({ decision: 'block', reasons: ['freeze_unknown'] });      // missing = unknown
      expect(policy.evaluate({ ...base, program, member: member('frozen') })).toMatchObject({ decision: 'block', reasons: ['on_hold'] });
      expect(policy.evaluate({ ...base, program, member: member('not_frozen') }).decision).toBe('send');
    }
  });

  test('a staff review of ONE member establishes eligibility for a limited time; a review "frozen" blocks; it expires back to unknown', async () => {
    setup();
    const a = cm(), b = cm(), c = cm(); for (const m of [a, b, c]) attend(m, addIso(MON, -7));
    await enable('absence7');
    expect((await post('/api/tomer/care/freeze-review', { userId: a.userId, status: 'not_frozen' })).body.error).toBe('reviewer_required');
    expect((await post('/api/tomer/care/freeze-review', { userId: a.userId, status: 'maybe', by: 'עדן' })).body.error).toBe('bad_freeze_status');
    expect((await post('/api/tomer/care/freeze-review', { userId: a.userId, status: 'not_frozen', by: 'עדן' })).body.error).toBe('evidence_required');
    const ok = await post('/api/tomer/care/freeze-review', { userId: a.userId, status: 'not_frozen', by: 'עדן', note: 'נבדק ב-Arbox' });
    expect(ok.body.review).toMatchObject({ status: 'not_frozen', by: 'עדן', validUntil: addIso(MON, 14) });
    await post('/api/tomer/care/freeze-review', { userId: b.userId, status: 'frozen', by: 'עדן', note: 'הקפאה פעילה בכרטיס החבר/ה' });
    at(MON);
    expect(await reasons('absence7', a)).toMatchObject({ decision: 'send' });
    expect(await reasons('absence7', b)).toMatchObject({ decision: 'block', reasons: expect.arrayContaining(['on_hold']) });
    expect(await reasons('absence7', c)).toMatchObject({ decision: 'block', reasons: expect.arrayContaining(['freeze_unknown']) });
    await runAll();
    expect(mockOut.texts.map(t => t.to)).toEqual([a.phone]);
    expect(arbox.writes()).toHaveLength(0);                                    // a review is never written to Arbox
    // expiry: a member reviewed "not frozen" is unknown again after the review's validity
    const d = cm(); attend(d, addIso(MON, 9));
    await post('/api/tomer/care/freeze-review', { userId: d.userId, status: 'not_frozen', by: 'עדן', note: 'נבדק ב-Arbox' });
    at(addIso(MON, 16));
    expect(await reasons('absence7', d)).toMatchObject({ decision: 'block', reasons: expect.arrayContaining(['freeze_unknown']) });
  });

  test('confirmed source: no row → not frozen, a row → frozen; report unreadable → unknown again (never "not frozen")', async () => {
    setup();
    const a = cm(), f = cm(); attend(a, addIso(MON, -7)); attend(f, addIso(MON, -7));
    arbox.state.holds.push({ user_id: f.userId });
    await enable('absence7');
    expect((await post('/api/tomer/care/settings', { freezeSourceConfirmed: true })).body.error).toBe('reviewer_required');
    expect((await post('/api/tomer/care/settings', { freezeSourceConfirmed: true, by: 'עדן' })).body.overview.freeze.sourceConfirmed).toMatchObject({ by: 'עדן' });
    at(MON);
    expect(await reasons('absence7', a)).toMatchObject({ decision: 'send' });
    expect(await reasons('absence7', f)).toMatchObject({ decision: 'block', reasons: expect.arrayContaining(['on_hold']) });
    arbox.mode.holdsDown = true; gateway.clearCache();
    try {
      expect(await reasons('absence7', a)).toMatchObject({ decision: 'block', reasons: expect.arrayContaining(['freeze_unknown']) });
      expect(await reasons('absence7', f)).toMatchObject({ decision: 'block', reasons: expect.arrayContaining(['freeze_unknown']) });
      const r = await runAll();
      expect(r.sent).toBe(0);
      expect(mockOut.texts).toHaveLength(0);
    } finally { arbox.mode.holdsDown = false; }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('15. Owner approval of the contact policy gates every activation', () => {
  test('shipped defaults: no program can be enabled or run; approval needs a named approver and the fingerprint that was shown', async () => {
    world(MON, '09:50', { raw: true });
    const a = cm(); attend(a, addIso(MON, -7));
    const ov = (await get('/api/tomer/care/overview')).body;
    expect(ov.policyApproval).toMatchObject({ approved: false, stale: false, by: null });
    for (const p of ov.programs) expect(p.blocks.map(b => b.code)).toContain('policy_unapproved');
    for (const id of careStore.PROGRAM_IDS) expect((await post(`/api/tomer/care/programs/${id}`, { enabled: true, by: 'עדן' })).body).toMatchObject({ ok: false, error: 'program_blocked' });
    // even a program switched on directly in the file does not run
    careStore.updateSettings({ programs: { absence7: { enabled: true, activatedAt: new Date().toISOString() } } }, 'test');
    at(MON);
    expect(await runAll()).toMatchObject({ ok: true, programs: [], sent: 0 });
    expect((await care.tick()).sent ?? 0).toBe(0);
    expect(mockOut.texts).toHaveLength(0);
    careStore.updateSettings({ programs: { absence7: { enabled: false } } }, 'test');

    const fp = ov.policyApproval.fingerprint;
    expect((await post('/api/tomer/care/settings', { policyApproved: true, policyFingerprint: fp })).body.error).toBe('approver_required');
    expect((await post('/api/tomer/care/settings', { policyApproved: true, policyFingerprint: 'deadbeefdeadbeef', approvedBy: 'עדן' })).body.error).toBe('approval_fingerprint_mismatch');
    // approving while changing a value in the same request needs the fingerprint of the NEW policy
    expect((await post('/api/tomer/care/settings', { policy: { cooldownHours: 48 }, policyApproved: true, policyFingerprint: fp, approvedBy: 'עדן' })).body.error).toBe('approval_fingerprint_mismatch');
    const fp2 = (await get('/api/tomer/care/overview')).body.policyApproval.fingerprint;
    expect(fp2).not.toBe(fp);
    const ok = (await post('/api/tomer/care/settings', { policyApproved: true, policyFingerprint: fp2, approvedBy: 'עדן' })).body;
    expect(ok.overview.policyApproval).toMatchObject({ approved: true, by: 'עדן', fingerprint: fp2 });
    expect((await post('/api/tomer/care/programs/birthday', { enabled: true, by: 'עדן' })).body.ok).toBe(true);
  });

  test('changing sending hours, the Saturday-birthday rule, a cooldown or a program hour voids the approval and switches programs off', async () => {
    const changes = [{ policy: { windowEnd: 21 } }, { policy: { birthdaySaturday: 'sunday' } }, { policy: { attendanceCooldownDays: 5 } }];
    for (const body of changes) {
      world(MON, '09:50');
      await enable('birthday');
      const ov = (await post('/api/tomer/care/settings', body)).body.overview;
      expect(ov.policyApproval).toMatchObject({ approved: false, stale: true });
      expect(ov.programs.find(p => p.id === 'birthday')).toMatchObject({ enabled: false });
      expect((await post('/api/tomer/care/programs/birthday', { enabled: true })).body.error).toBe('program_blocked');
    }
    world(MON, '09:50');
    await enable('birthday');
    const ov = (await post('/api/tomer/care/programs/birthday', { hour: 12 })).body.overview;
    expect(ov.policyApproval.approved).toBe(false);
    expect(ov.programs.find(p => p.id === 'birthday').enabled).toBe(false);
    // saving the same values again does not void anything
    world(MON, '09:50');
    await enable('birthday');
    expect((await post('/api/tomer/care/settings', { policy: { windowStart: 9, windowEnd: 20 } })).body.overview.policyApproval.approved).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('16. The eligibility preview has no side effects', () => {
  test('previewing every program writes nothing, sends nothing and only reads Arbox', async () => {
    world(MON, '09:50');
    const a = cm({ birthday: '1990-11-16' }); attend(a, addIso(MON, -7));
    const b = cm(); attend(b, addIso(MON, -14));
    const mid = ms(cm(), { typeId: T_FIX, start: '2026-08-20', end: addIso(MON, 3) });
    expect(mid).toBeTruthy();
    await enable('absence7', 'absence14', 'birthday', 'expiry5', 'tuesday', 'onboarding14', 'month1');
    at(MON);
    const snapshot = () => Object.fromEntries(fs.readdirSync(DATA_DIR).sort().map(f => { const st = fs.statSync(path.join(DATA_DIR, f)); return [f, st.isFile() ? fs.readFileSync(path.join(DATA_DIR, f), 'utf8') : 'dir']; }));
    // Earlier worlds' server instances flush their own debounced history file (2 s) — let that settle first.
    await new Promise(r => setTimeout(r, 2600));
    const before = snapshot();
    const logFrom = arbox.log.length;
    for (const id of careStore.PROGRAM_IDS) {
      gateway.clearCache();
      const pv = (await get(`/api/tomer/care/preview/${id}`)).body;
      expect(pv.ok).toBe(true);
    }
    await get('/api/tomer/care/absence-report'); await get('/api/tomer/care/visibility');
    expect(snapshot()).toEqual(before);                                        // no file created or changed (episodes, cases, entitlements, inbox …)
    expect(careStore.listEpisodes({ limit: 1000 })).toHaveLength(0);
    expect(careStore.listEntitlements()).toHaveLength(0);
    expect(cases.list({})).toHaveLength(0);
    expect(mockOut.texts).toHaveLength(0); expect(mockOut.mgr).toHaveLength(0); expect(mockOut.alerts).toHaveLength(0);
    const calls = arbox.log.slice(logFrom);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
});
