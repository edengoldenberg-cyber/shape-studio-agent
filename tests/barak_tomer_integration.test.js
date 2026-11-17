'use strict';
/**
 * barak_tomer_integration.test.js — Barak (leads) and Tomer (members) on ONE pipeline: one routing decision, no double
 * answers, and nothing automatic after the conversation changed hands.
 *
 * Same real pipeline and stand-ins as tomer_member_flow.test.js (real server.js, identity resolver, Tomer service,
 * class flow, Arbox gateway against a LOCAL Arbox stand-in; outbound WhatsApp captured; the model scripted).
 * All phones are synthetic; nothing leaves the machine.
 */
process.env.QUIET_HOUR_START = '22';
process.env.QUIET_HOUR_END   = '8';
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
  chat: { completions: { create: jest.fn(() => { mockAi.calls++; if (mockAi.onCall) { const f = mockAi.onCall; mockAi.onCall = null; f(); } return Promise.resolve({ choices: [{ message: { content: mockAi.queue.length ? mockAi.queue.shift() : mockAi.fallback } }] }); }) } },
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


const taskAlerts = () => mockOut.alerts.filter(a => /תומר/.test(a.subject));
const takeOver = phone => { const cur = store.getLead(phone) ?? {}; store.upsertLead(phone, { status: 'human_owns', meta: { ...(cur.meta ?? {}), humanOwnsReason: 'staff_manual_reply', humanOwnsSince: new Date().toISOString(), humanOwnsBy: 'staff', previousStatus: cur.status ?? 'converted_member' } }); };
const writesOn = () => { process.env.ARBOX_WRITES_ENABLED = 'true'; process.env.ARBOX_TEST_ASSUME_CONTRACT = 'true'; process.env.ARBOX_WRITE_OPS = 'class_book,class_cancel'; process.env.ARBOX_WRITE_AUDIENCE = 'all'; };
afterEach(() => { delete process.env.ARBOX_WRITE_OPS; delete process.env.ARBOX_WRITE_AUDIENCE; mockAi.onCall = null; });

describe('1. One routing decision', () => {
  test('a lead is Barak\'s; once Arbox shows a valid membership the SAME phone is Tomer\'s, Barak no longer answers, and the lead history is kept', async () => {
    const phone = '972587001111';
    mockAi.queue.push('היי! ספרי לי מה המטרה שלך 🙂');
    const r1 = await say(phone, 'היי, מתעניינת בפילאטיס מכשירים');
    expect(r1.route).toBe('barak');
    expect(cases.list({ phone })).toHaveLength(0);
    const before = store.getLead(phone);
    expect(before).toBeTruthy();
    const historyBefore = (before.history ?? []).length;

    // she joins: a client row with a valid membership appears in Arbox
    arbox.state.users.push({ user_id: 7701, first_name: 'נועה', last_name: 'בדיקה', phone: '058-7001111', user_role: 'client', active: 1, gender: 'female' });
    arbox.state.memberships.push({ membership_user_id: 97701, user_id: 7701, membership_type_name: 'מנוי חודשי', type: 'plan', price: 400, debt: 0, start_time: '2026-11-01', end_time: '2026-12-31', active: 1, cancelled: 0 });
    gateway.clearCache();

    const aiCalls = mockAi.calls, n = textsTo(phone).length;
    const r2 = await say(phone, 'אני רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    expect(String(r2.route)).toMatch(/^tomer/);
    expect(cases.list({ phone, open: true })).toHaveLength(1);                                  // Tomer opened the service case
    expect(textsTo(phone).slice(n).join('\n')).toMatch(/אני תומר/);
    expect(textsTo(phone).slice(n).join('\n')).toMatch(/המנוי לא הוקפא/);
    expect(mockOut.mgr).toHaveLength(1);                                                         // ONE alert to the manager
    expect(mockAi.calls).toBe(aiCalls);                                                           // Barak's model was not asked
    expect((store.getLead(phone)?.history ?? []).length).toBeGreaterThanOrEqual(historyBefore);  // nothing was deleted
  });

  test('a lead who asks to be booked to a class is not given Tomer\'s class flow: no class task, no Arbox request', async () => {
    const phone = '972587002222';
    mockAi.queue.push('בשמחה! אפשר להתחיל בשיעור היכרות 🙂');
    const r = await say(phone, 'תרשמי אותי למחר ב-9 לפילאטיס');
    expect(String(r.route)).not.toMatch(/^tomer/);
    const tasks = (await get('/api/tomer/tasks')).body.tasks.filter(t => t.phone === phone);
    expect(tasks).toHaveLength(0);
    expect(arbox.writes()).toHaveLength(0);
    expect(textsTo(phone).join('\n')).not.toMatch(/רק לוודא לפני שאני משנה ב-Arbox|אני תומר/);
  });

  test('an aggregator member and a phone written with a prefix are routed to Tomer like any member', async () => {
    const ag = member({ role: 'aggregatorMember', fmt: 'plus', first: 'גל' });
    const r = await say(ag.phone, 'אני רוצה להקפיא את המנוי');
    expect(String(r.route)).toMatch(/^tomer/);
    expect(cases.list({ phone: ag.phone, open: true })).toHaveLength(1);
  });

  test('Arbox temporarily unreadable during a class request: nothing is claimed as checked, nothing is written, the request still reaches the staff', async () => {
    writesOn();
    const m = member();
    await say(m.phone, 'מה הכתובת של הסטודיו?');                       // identified while Arbox is readable
    mockOut.alerts.length = 0;
    arbox.mode.down = true; gateway.clearCache();
    try {
      await say(m.phone, 'תרשמי אותי למחר ב-9 לפילאטיס');
    } finally { arbox.mode.down = false; }
    expect(arbox.writes()).toHaveLength(0);
    expect(textsTo(m.phone).join('\n')).not.toMatch(/בוצע ✅|נרשמת ל/);
    expect(textsTo(m.phone).at(-1)).not.toMatch(/לאשר\?/);
    const reached = taskAlerts().length + mockOut.mgr.length + cases.list({ phone: m.phone, open: true }).length;
    expect(reached).toBeGreaterThan(0);
  });
});

describe('2. No double handling', () => {
  test('the same provider message delivered twice: one task and one alert', async () => {
    const m = member();
    await say(m.phone, 'תרשמי אותי למחר ב-9 לפילאטיס', { messageId: 'dup-class-1' });
    const n = textsTo(m.phone).length;
    await request(app).post('/api/whatsapp/simulate').send({ from: m.phone, text: 'תרשמי אותי למחר ב-9 לפילאטיס', name: 'WA Profile', type: 'text', messageId: 'dup-class-1', timestamp: new Date().toISOString() }).set('Content-Type', 'application/json');
    expect(textsTo(m.phone)).toHaveLength(n);
    expect(taskAlerts()).toHaveLength(1);
    expect((await get('/api/tomer/tasks')).body.tasks.filter(t => t.phone === m.phone && t.type === 'class_change')).toHaveLength(1);
  });

  test('a membership freeze asked twice in a row: one case, one alert to the manager', async () => {
    const m = member();
    await say(m.phone, 'אני רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    await say(m.phone, 'אפשר להקפיא את המנוי מ-1.12 עד 15.12?');
    expect(cases.list({ phone: m.phone, open: true })).toHaveLength(1);
    expect(mockOut.mgr).toHaveLength(1);
    expect(mockOut.mgr[0].text).toMatch(/הקפאת מנוי/);
    expect(mockOut.mgr[0].text).toMatch(/01\.12/);
    expect(arbox.writes()).toHaveLength(0);
  });
});

describe('3. Nothing automatic after the conversation changed hands', () => {
  test('the staff take over WHILE Tomer waits for the model: the prepared answer is not sent', async () => {
    const m = member();
    await say(m.phone, 'מה הכתובת של הסטודיו?');
    const n = textsTo(m.phone).length;
    mockAi.queue.push('הסטודיו פתוח היום עד 21:00');
    mockAi.onCall = () => takeOver(m.phone);
    await say(m.phone, 'רציתי לשאול אם הסטודיו פתוח עכשיו? ללכת לעשות אופן ג׳ים');
    expect(textsTo(m.phone)).toHaveLength(n);
    expect(store.getLead(m.phone).status).toBe('human_owns');
  });

  test('the staff take over WHILE the class flow reads Arbox: no "לאשר?" is sent and nothing is written', async () => {
    writesOn();
    const m = member();
    const n = textsTo(m.phone).length;
    arbox.mode.after = { '/v3/schedule': () => takeOver(m.phone) };
    await say(m.phone, 'תרשמי אותי למחר ב-9 לפילאטיס');
    arbox.mode.after = null;
    expect(textsTo(m.phone)).toHaveLength(n);
    expect(arbox.writes()).toHaveLength(0);
  });

  test('a written "כן" that arrives after the staff took over is not carried out: no Arbox request, no automatic reply', async () => {
    writesOn();
    const m = member();
    await say(m.phone, 'תרשמי אותי למחר ב-9 לפילאטיס');
    expect(lastTo(m.phone)).toMatch(/לאשר\?/);
    await phoneSend(m.phone, 'היי, אני מטפלת בזה');
    const n = textsTo(m.phone).length;
    const r = await say(m.phone, 'כן');
    expect(r.route).toBe('human_owns_hold');
    expect(textsTo(m.phone)).toHaveLength(n);
    expect(arbox.writes()).toHaveLength(0);
  });

  test('a reply from the panel reaches the member once, is stored as staff, and causes no automatic answer and no second alert', async () => {
    const m = member();
    await say(m.phone, 'אני רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    const [c] = cases.list({ phone: m.phone, open: true });
    const n = textsTo(m.phone).length, alerts = mockOut.mgr.length;
    const r = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי, בודקת ומעדכנת אותך', by: 'עדן' });
    expect(r.body.ok).toBe(true);
    expect(textsTo(m.phone).slice(n)).toEqual(['היי, בודקת ומעדכנת אותך']);
    const out = inbox.getThread(m.phone).messages.filter(x => x.direction === 'out').at(-1);
    expect(out).toMatchObject({ agentId: 'staff', text: 'היי, בודקת ומעדכנת אותך' });
    const n2 = textsTo(m.phone).length;
    await say(m.phone, 'תודה');
    expect(textsTo(m.phone)).toHaveLength(n2);                       // the staff own the conversation now
    expect(mockOut.mgr).toHaveLength(alerts);
  });
});

describe('4. Quiet hours', () => {
  test('at night a member who has just written is answered directly; a message nobody asked for is refused, not queued', async () => {
    const m = member(), other = member();
    jest.setSystemTime(new Date('2026-11-16T21:00:00.000Z'));       // 23:00 in Israel
    await say(m.phone, 'אני רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    const mine = mockOut.texts.filter(t => t.to === m.phone);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(t => t.opts.bypassQuietHours === true)).toBe(true);
    const n = mockOut.texts.length;
    const out = await app.locals.tomerService.say(other.phone, 'הודעה יזומה שאיש לא ביקש', { handler: 'test', trigger: 'proactive' });
    expect(out.state).toBe('blocked');
    expect(mockOut.texts).toHaveLength(n);
  });

  // (the queue itself)
  test('a message queued at night is dropped in the morning if the conversation was taken over, opted out or became a member\'s', async () => {
    const wa = jest.requireActual('../services/whatsapp.service');
    const night = new Date('2026-11-16T21:30:00.000Z');              // 23:30 in Israel
    jest.setSystemTime(night);
    const q1 = await wa.sendText('972000000001', 'תשובה שנשמרה ללילה 1');
    const q2 = await wa.sendText('972000000002', 'תשובה שנשמרה ללילה 2');
    expect(q1.queued && q2.queued).toBeTruthy();
    const out = await wa.releaseQueuedMessages(to => to !== '972000000001');
    expect(out).toEqual({ sent: 1, dropped: 1 });
    expect(await wa.releaseQueuedMessages(() => true)).toEqual({ sent: 0, dropped: 0 });
  });
});
