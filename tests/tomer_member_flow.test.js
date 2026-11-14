'use strict';
/**
 * tomer_member_flow.test.js — Tomer (existing-member service), end to end.
 *
 * REAL: server.js pipeline, tomer_service, member_intent, arbox_gateway
 * (real HTTP against a LOCAL Arbox stand-in), service_case_store (disk), lead_store,
 * inbox, ownership/takeover — all on a fresh temporary DATA_DIR.
 * MOCKED: outbound WhatsApp transports (captured), OpenAI (scripted), and the member
 * identity cache (so the pipeline routes the synthetic phones as members).
 *
 * Every scenario starts from inbound member messages and panel API calls; nothing is
 * seeded into the case store except the one crash scenario (a process death cannot be
 * produced any other way). All phones are synthetic; nothing leaves the machine.
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
beforeEach(() => {
  jest.setSystemTime(T0);
  mockOut.texts.length = 0; mockOut.alerts.length = 0; mockOut.mgr.length = 0; mockOut.mgrMode = 'ok'; mockOut.memberMode = 'ok'; mockOut.mgrCalls = 0; mockAi.queue.length = 0;
  arbox.reset(); seedSchedule(); gateway.clearCache();
  delete process.env.ARBOX_WRITES_ENABLED; delete process.env.ARBOX_TEST_ASSUME_CONTRACT;
});
afterAll(async () => { jest.useRealTimers(); await arbox.close(); });

// ══════════════════════════════════════════════════════════════════════════════
describe('A. No false confirmations, no dropped requests', () => {
  test('membership cancellation → staff-handled case + ONE manager alert with a link to the case; nothing is written to Arbox', async () => {
    const m = member();
    const r = await say(m.phone, 'רוצה לבטל את המנוי');
    expect(r.route).toBe('tomer_case_opened');
    expect(lastTo(m.phone)).toMatch(/רשמתי אותה לטיפול הצוות/);
    expect(lastTo(m.phone)).toMatch(/המנוי לא בוטל/);
    expect(textsTo(m.phone).join('\n')).not.toMatch(FALSE_CONFIRM);
    expect(textsTo(m.phone).join('\n')).not.toMatch(PROMISE);
    const [c] = openCases(m.phone);
    expect(c).toMatchObject({ category: 'membership_cancel', status: 'awaiting_staff', priority: 'high',
      request: { type: 'membership_cancel', userId: m.userId, membershipUserId: m.mid } });
    expect(c.action).toBeUndefined();
    expect(mockOut.mgr).toHaveLength(1);
    const alert = mockOut.mgr[0].text;
    expect(alert).toContain('בקשת ביטול מנוי');
    expect(alert).toContain('דנה בדיקה');
    expect(alert).toContain(`0${m.phone.slice(3)}`);
    expect(alert).toContain(`https://wa.me/${m.phone}`);
    expect(alert).toContain('רוצה לבטל את המנוי');
    expect(alert).toContain(`https://panel.example.test/#tomer/case/${c.id}`);
    expect(alert).toMatch(/לא בוצע שום שינוי ב-Arbox/);
    expect(mockOut.mgr[0].opts).toMatchObject({ bypassQuietHours: true, linkPreview: false });
    expect(diskCase(c.id).notification).toMatchObject({ state: 'accepted', attempts: 1, sentTo: [MANAGER], inFlightSince: null });
    expect(arbox.writes()).toHaveLength(0);
  });

  test('a repeated request joins the open case: no second case, no second manager alert', async () => {
    const m = member();
    await say(m.phone, 'אני רוצה לבטל את המנוי שלי');
    await say(m.phone, 'רוצה לבטל את המנוי');
    expect(openCases(m.phone)).toHaveLength(1);
    expect(openCases(m.phone)[0].context.filter(x => x.from === 'member')).toHaveLength(2);
    expect(openCases(m.phone)[0].unreadMember).toBe(true);
    expect(mockOut.mgr).toHaveLength(1);
    expect(lastTo(m.phone)).toMatch(/כבר רשומה אצל הצוות/);
  });

  test('an unrelated issue from the same member is a separate case with its own alert', async () => {
    const m = member();
    await say(m.phone, 'לא הבנתי על מה חויבתי ועל איזה חודש');
    await say(m.phone, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    expect(openCases(m.phone).map(c => c.category).sort()).toEqual(['billing_dispute', 'membership_freeze']);
    expect(mockOut.mgr).toHaveLength(2);
  });

  test.each([
    ['הי\nתתקשר אלי כשתוכל', 'staff_request'],
    ['יכול לבדוק עבורי, ולזכות את חשבוני .\nתודה רבה🙏🏻', 'refund_request'],
    ['מוזר זה היה נראה שבוטל באפליקציה', 'app_problem'],
    ['לא הבנתי על מה חויבתי ועל איזה חודש', 'billing_dispute'],
    ['אני מאוד מאוכזבת מהיחס בשיעור אתמול', 'complaint'],
  ])('short real request %j is not dropped → case %s + one alert, recorded (not "passed on")', async (text, category) => {
    const m = member();
    await say(m.phone, text);
    const [c] = openCases(m.phone);
    expect(c?.category).toBe(category);
    expect(mockOut.mgr).toHaveLength(1);
    expect(textsTo(m.phone)).toHaveLength(1);
    expect(lastTo(m.phone)).not.toMatch(FALSE_CONFIRM);
    expect(lastTo(m.phone)).not.toMatch(PROMISE);
    expect(lastTo(m.phone)).not.toMatch(NOTIFIED_CLAIM);
  });

  test('an unclear request gets ONE clarification, then becomes a case', async () => {
    const m = member();
    const r1 = await say(m.phone, 'אשמח להסבר');
    expect(r1.route).toBe('tomer_clarification');
    expect(openCases(m.phone)).toHaveLength(0);
    await say(m.phone, 'על התשלום של החודש');
    const [c] = openCases(m.phone);
    expect(c).toBeTruthy();
    expect(c.context[0].text).toContain('אשמח להסבר');
    expect(mockOut.mgr).toHaveLength(1);
    expect(textsTo(m.phone)).toHaveLength(2);
  });

  test('an unclear follow-up while a case is open is added to it and acknowledged — never dropped', async () => {
    const m = member();
    await say(m.phone, 'לא הבנתי על מה חויבתי ועל איזה חודש');
    const r = await say(m.phone, 'אפשר עדכון?');
    expect(r.route).toBe('tomer_case_updated');
    expect(lastTo(m.phone)).toMatch(/הוספתי את ההודעה לפנייה/);
    const [c] = openCases(m.phone);
    expect(c.context.at(-1)).toMatchObject({ from: 'member', text: 'אפשר עדכון?' });
    expect(mockOut.mgr).toHaveLength(1);
    // A plain statement adds detail to the case without a reply.
    const n = textsTo(m.phone).length;
    await say(m.phone, 'זה היה בחיוב של אוקטובר, 400 שקל');
    expect(openCases(m.phone)).toHaveLength(1);
  });

  test('an image is never acknowledged as a payment or as "handled"', async () => {
    const m = member();
    await say(m.phone, '[תמונה]', { type: 'image' });
    expect(lastTo(m.phone)).toMatch(/אין לי אפשרות לצפות בתמונות/);
    expect(lastTo(m.phone)).not.toMatch(/אישור התשלום|יחזור אליך בהקדם/);
    expect(openCases(m.phone)[0].category).toBe('media_message');
    expect(mockOut.mgr).toHaveLength(1);
    await say(m.phone, '[תמונה]', { type: 'image' });
    expect(textsTo(m.phone)).toHaveLength(1);
    expect(mockOut.mgr).toHaveLength(1);
  });

  test('"שלחתי ביט" is recorded as an UNVERIFIED payment claim', async () => {
    const m = member();
    await say(m.phone, 'שלחתי ביט');
    expect(lastTo(m.phone)).toMatch(/לא אישור שהתשלום התקבל/);
    expect(openCases(m.phone)[0].category).toBe('payment_claim');
  });

  test.each(['תודה רבה❤️', 'כן ראיתי, תודה רבה!!', '🥳🥳🥳', 'אגיע בשבוע הבא'])('ordinary message %j → silence, no case, no alert', async (text) => {
    const m = member();
    const r = await say(m.phone, text);
    expect(r.route).toBe('tomer_silent');
    expect(textsTo(m.phone)).toHaveLength(0);
    expect(openCases(m.phone)).toHaveLength(0);
    expect(mockOut.mgr).toHaveLength(0);
  });

  test('injury goes to staff as a high-priority case; Tomer gives no medical advice', async () => {
    const m = member();
    await say(m.phone, 'נפצעתי בברך באימון אתמול, אפשר להמשיך להתאמן?');
    expect(lastTo(m.phone)).toMatch(/לא יכול לתת הנחיה רפואית/);
    expect(openCases(m.phone)[0]).toMatchObject({ category: 'injury', priority: 'high' });
  });

  test('the approved introduction opens a new service conversation once — not every reply', async () => {
    const m = member();
    await say(m.phone, 'מה יש מחר?');
    expect(textsTo(m.phone)[0].startsWith(INTRO + '\n')).toBe(true);
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    await say(m.phone, '[תמונה]', { type: 'image' });
    expect(textsTo(m.phone)).toHaveLength(3);
    expect(textsTo(m.phone).slice(1).join('\n')).not.toMatch(/אני תומר/);
    // More than a week without a Tomer message = a new service conversation.
    cases.patchMember(m.phone, { lastTomerAt: new Date(T0.getTime() - 8 * 24 * 3600 * 1000).toISOString() });
    await say(m.phone, 'עד מתי המנוי שלי בתוקף?');
    expect(lastTo(m.phone).startsWith(INTRO + '\n')).toBe(true);
    expect(textsTo(m.phone).join('\n')).not.toMatch(/אני עדן|כאן עדן/);          // never speaks as Eden
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('B. Verified Arbox reads', () => {
  test.each(['local', 'plus', 'intl'])('member stored in Arbox with phone format %s is identified', async (fmt) => {
    const m = member({ fmt });
    await say(m.phone, 'עד מתי המנוי שלי בתוקף?');
    expect(lastTo(m.phone)).toMatch(/מנוי חודשי 2 בשבוע: בתוקף עד 31\.12\.2026/);
  });

  test('two active members on one phone → no personal data, staff case', async () => {
    const a = member();
    arbox.state.users.push({ user_id: 7777, first_name: 'אחר', last_name: 'בדיקה', phone: arbox.state.users.at(-1).phone, user_role: 'client', active: 1, gender: 'male' });
    gateway.clearCache();
    await say(a.phone, 'עד מתי המנוי שלי בתוקף?');
    expect(lastTo(a.phone)).toMatch(/לא הצלחתי לזהות אותך בוודאות/);
    expect(lastTo(a.phone)).not.toMatch(/31\.12/);
    expect(openCases(a.phone)).toHaveLength(1);
  });

  test('schedule answer shows real occupancy, hides cancelled classes, never invents spots', async () => {
    const m = member();
    await say(m.phone, 'מה יש מחר?');
    const t = lastTo(m.phone);
    expect(t).toMatch(/09:00 פילאטיס מכשירים — מלאני לוי \(רשומים 7 מתוך 10\)/);
    expect(t).toMatch(/19:00 פילאטיס מכשירים — עדן גל \(מלא \(10\/10\), 2 ברשימת המתנה\)/);
    expect(t).not.toMatch(/יוגה/);
    expect(t).not.toMatch(/\*\*|רוצה מקום/);
  });

  test('occupancy report down → schedule without any occupancy claim', async () => {
    const m = member();
    arbox.mode.occupancyDown = true;
    await say(m.phone, 'מה יש מחר?');
    expect(lastTo(m.phone)).toMatch(/אין לי כרגע נתוני תפוסה/);
    expect(lastTo(m.phone)).toMatch(/המערכת המתוכננת בלבד/);
    expect(lastTo(m.phone)).not.toMatch(/רשומים \d|מלא \(|\(מלא/);
  });

  test('Arbox unavailable → says so; a request still becomes a case', async () => {
    const m = member();
    await say(m.phone, 'היי');                       // warms nothing: social
    arbox.mode.down = true; gateway.clearCache();
    await say(m.phone, 'מה יש מחר?');
    expect(lastTo(m.phone)).toMatch(/אין לי כרגע גישה לנתונים מ-Arbox/);
    await say(m.phone, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    const [c] = openCases(m.phone);
    expect(c.category).toBe('membership_freeze');
    expect(lastTo(m.phone)).toMatch(/המנוי לא הוקפא/);
  });

  test('Arbox timeout is handled like unavailability (no hang, no guess)', async () => {
    const m = member();
    await require('../services/identity_resolver').shared().refresh();      // she is a known member before Arbox stops answering
    arbox.mode.hang = true; gateway.clearCache();
    await say(m.phone, 'לאיזה שיעורים אני רשומה השבוע?');
    expect(lastTo(m.phone)).toMatch(/לא הצלחתי לזהות|אין לי כרגע גישה/);
    expect(lastTo(m.phone)).not.toMatch(/אין לך כרגע רישומים/);
  });

  test('my bookings come from the member\'s own Arbox bookings', async () => {
    const m = member(); const other = member();
    book(m, cls(1)); book(other, cls(2));
    await say(m.phone, 'לאיזה שיעורים אני רשומה השבוע?');
    expect(lastTo(m.phone)).toMatch(/כח — יום שני, 16\.11\.2026 בשעה 19:00/);
    expect(lastTo(m.phone)).not.toMatch(/פילאטיס/);
  });

  test('a general question is answered only from verified facts; unsupported model claims are blocked', async () => {
    const m = member();
    mockAi.queue.push('בטח! יש מקום מחר ב-9, רשמתי אותך 😊');
    await say(m.phone, 'רציתי לשאול אם הסטודיו פתוח עכשיו? ללכת לעשות אופן ג׳ים');
    expect(textsTo(m.phone).join('\n')).not.toMatch(/רשמתי אותך|יש מקום/);
    expect(openCases(m.phone)[0].category).toBe('general_request');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('C. Classes: self-service + verification from Arbox', () => {
  test('booking: resolves the class, never claims to book, verifies only after Arbox shows it', async () => {
    const m = member();
    await say(m.phone, 'תרשמי אותי למחר ב-9 לפילאטיס');
    expect(lastTo(m.phone)).toMatch(/אני לא יכול לבצע רישום במקומך/);
    expect(lastTo(m.phone)).toContain('https://book.example.test/c/2');
    expect(lastTo(m.phone)).toMatch(/רשומים 7 מתוך 10/);
    await say(m.phone, 'נרשמתי');
    expect(lastTo(m.phone)).toMatch(/עדיין לא רואה ב-Arbox רישום/);
    book(m, cls(2));
    await say(m.phone, 'נרשמתי');
    expect(lastTo(m.phone)).toMatch(/מאומת ✅ לפי Arbox את רשומה: פילאטיס מכשירים — יום שלישי, 17\.11\.2026 בשעה 09:00/);
    expect(arbox.writes()).toHaveLength(0);
  });

  test('booking a full class states it is full (real count)', async () => {
    const m = member();
    await say(m.phone, 'תרשמי אותי למחר ב-19 לפילאטיס');
    expect(lastTo(m.phone)).toMatch(/השיעור מלא \(10\/10\), ו-2 ברשימת המתנה/);
  });

  test('ambiguous class → asks which one; the choice continues the flow', async () => {
    const m = member();
    await say(m.phone, 'תרשמי אותי לפילאטיס מחר');
    expect(lastTo(m.phone)).toMatch(/לאיזה מהם\?\n1\. .*09:00.*\n2\. .*19:00/s);
    await say(m.phone, '1');
    expect(lastTo(m.phone)).toContain('https://book.example.test/c/2');
  });

  test('already booked → says so from Arbox', async () => {
    const m = member(); book(m, cls(2));
    await say(m.phone, 'תרשמי אותי למחר ב-9 לפילאטיס');
    expect(lastTo(m.phone)).toMatch(/את כבר רשומה ✅/);
  });

  test('class cancellation: booking stays until Arbox records the cancellation', async () => {
    const m = member(); book(m, cls(1));
    await say(m.phone, 'לא אספיק להגיע היום');
    expect(lastTo(m.phone)).toMatch(/כח — יום שני, 16\.11\.2026 בשעה 19:00/);
    expect(lastTo(m.phone)).toMatch(/הרישום עדיין קיים/);
    expect(lastTo(m.phone)).not.toMatch(FALSE_CONFIRM);
    await say(m.phone, 'ביטלתי');
    expect(lastTo(m.phone)).toMatch(/לפי Arbox הרישום עדיין קיים/);
    arbox.state.bookings.length = 0;
    arbox.state.cancellations.push({ user_id: m.userId, schedule_id: 1, date: TODAY, start_time: '19:00:00', class_name: 'כח', cancelled_time: '2026-11-16 10:01:00' });
    await say(m.phone, 'ביטלתי');
    expect(lastTo(m.phone)).toMatch(/מאומת ✅ לפי Arbox נרשם ביטול של:\n• כח/);
  });

  test('"cannot come" with no booking → nothing to cancel (no invented cancellation)', async () => {
    const m = member();
    await say(m.phone, 'לא יכולה להגיע מחר לשיעור');
    expect(lastTo(m.phone)).toMatch(/לא מצאתי רישום שלך/);
  });

  test('reschedule: book the new class first, verify, only then cancel the old one', async () => {
    const m = member(); book(m, cls(1));
    await say(m.phone, 'אפשר להעביר אותי למחר ב-9 לפילאטיס?');
    expect(lastTo(m.phone)).toMatch(/קודם להירשם לשיעור החדש, ורק אחרי שהרישום נקלט — לבטל את הישן/);
    await say(m.phone, 'נרשמתי');
    expect(lastTo(m.phone)).toMatch(/עדיין לא רואה/);           // old booking untouched, nothing claimed
    book(m, cls(2));
    await say(m.phone, 'נרשמתי');
    expect(lastTo(m.phone)).toMatch(/מאומת ✅.*\nעכשיו אפשר לבטל את הרישום הישן/s);
  });

  test('waitlist: states the limits, shows real standby count', async () => {
    const m = member();
    await say(m.phone, 'אני ברשימת המתנה לפילאטיס מחר ב-19, יש סיכוי?');
    expect(lastTo(m.phone)).toMatch(/2 ברשימת המתנה/);
    expect(lastTo(m.phone)).toMatch(/אין לי גישה למיקום שלך ברשימה/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('D. Membership freeze / cancellation are STAFF-HANDLED', () => {
  async function freezeCase(m, text = 'רוצה להקפיא את המנוי מ-1.12 עד 15.12') {
    await say(m.phone, text);
    return openCases(m.phone).find(c => c.category === 'membership_freeze');
  }

  test('freeze with dates: recorded with the dates, alert carries them, member is told it is NOT frozen', async () => {
    const m = member();
    const c = await freezeCase(m);
    expect(c.request).toMatchObject({ type: 'membership_freeze', from: '2026-12-01', to: '2026-12-15', membershipUserId: m.mid });
    expect(lastTo(m.phone)).toMatch(/01\.12\.2026 – 15\.12\.2026/);
    expect(lastTo(m.phone)).toMatch(/המנוי לא הוקפא בשלב זה/);
    expect(lastTo(m.phone)).not.toMatch(PROMISE);
    expect(mockOut.mgr[0].text).toMatch(/תאריכים מבוקשים: 01\.12\.2026 – 15\.12\.2026/);
    expect(arbox.writes()).toHaveLength(0);
  });

  test('freeze without dates: the case and the alert are created at once; dates are optional and enrich the same case', async () => {
    const m = member();
    const c = await freezeCase(m, 'אפשר להקפיא את המנוי?');
    expect(c).toBeTruthy();
    expect(mockOut.mgr).toHaveLength(1);
    expect(lastTo(m.phone)).toMatch(/רשמתי אותה לטיפול הצוות/);
    expect(lastTo(m.phone)).not.toMatch(/\?\s*$/);                      // not held behind a question
    await say(m.phone, '1.12.26 עד 20.12.26');
    expect(cases.get(c.id).request).toMatchObject({ from: '2026-12-01', to: '2026-12-20' });
    expect(openCases(m.phone)).toHaveLength(1);
    expect(mockOut.mgr).toHaveLength(1);
    expect(lastTo(m.phone)).toMatch(/הוספתי לפנייה: 01\.12\.2026 – 20\.12\.2026/);
  });

  test('there is no approve / execute path: the old action endpoints do not exist and no write is ever sent', async () => {
    process.env.ARBOX_WRITES_ENABLED = 'true'; process.env.ARBOX_TEST_ASSUME_CONTRACT = 'true';   // even if someone flips the switches
    const m = member();
    const c = await freezeCase(m);
    for (const op of ['approve', 'reject', 'mark-executed', 'execute-now', 'recheck']) {
      expect((await post(`/api/tomer/cases/${c.id}/${op}`)).status).toBe(404);
    }
    await post(`/api/tomer/cases/${c.id}/resolve`, { outcome: 'done_in_arbox', note: 'הוקפא ידנית', by: 'עדן' });
    expect(arbox.writes()).toHaveLength(0);
  });

  test('staff-reported completion is stored apart from what Arbox shows (cancel)', async () => {
    const m = member();
    await say(m.phone, 'רוצה לבטל את המנוי');
    const [c] = openCases(m.phone);
    expect((await post(`/api/tomer/cases/${c.id}/resolve`, { outcome: 'done_in_arbox', by: 'עדן' })).body.error).toBe('note_required');
    expect((await post(`/api/tomer/cases/${c.id}/resolve`, { note: 'בוטל', by: 'עדן' })).body.error).toBe('outcome_required');
    expect(cases.get(c.id).status).toBe('awaiting_staff');
    const before = textsTo(m.phone).length;
    // Staff say it is done, but Arbox still shows an active membership.
    const r = await post(`/api/tomer/cases/${c.id}/resolve`, { outcome: 'done_in_arbox', note: 'בוטל בטלפון עם החברה', by: 'עדן' });
    expect(r.body.case.status).toBe('resolved');
    expect(r.body.case.resolution).toMatchObject({ outcome: 'done_in_arbox', note: 'בוטל בטלפון עם החברה', by: 'עדן' });
    expect(r.body.case.arboxCheck).toMatchObject({ verified: false });
    expect(r.body.case.arboxCheck.summary).toMatch(/מנוי פעיל/);
    expect(textsTo(m.phone)).toHaveLength(before);                    // closing a case sends the member nothing
    // Later Arbox shows the cancellation → the read-only check turns true; the staff report is untouched.
    const ms = arbox.state.memberships.find(x => x.membership_user_id === m.mid); ms.cancelled = 1; ms.active = 0;
    const chk = await post(`/api/tomer/cases/${c.id}/refresh-arbox`, { by: 'עדן' });
    expect(chk.body.case.arboxCheck).toMatchObject({ verified: true });
    expect(chk.body.case.resolution).toMatchObject({ outcome: 'done_in_arbox', by: 'עדן' });
    expect(arbox.writes()).toHaveLength(0);
  });

  test('freeze: the read-only check reads the hold report; a declined request is recorded as declined', async () => {
    const a = member();
    const ca = await freezeCase(a);
    arbox.state.holds.push({ user_id: a.userId, membership_user_id: a.mid, start_date: '2026-12-01', end_date: '2026-12-15' });
    const ra = await post(`/api/tomer/cases/${ca.id}/resolve`, { outcome: 'done_in_arbox', note: 'הוקפא', by: 'עדן' });
    expect(ra.body.case.arboxCheck).toMatchObject({ verified: true });
    const b = member();
    const cb = await freezeCase(b);
    const rb = await post(`/api/tomer/cases/${cb.id}/resolve`, { outcome: 'declined', note: 'אין זכאות להקפאה החודש', by: 'עדן' });
    expect(rb.body.case.resolution.outcome).toBe('declined');
    expect(rb.body.case.arboxCheck).toBeNull();                       // nothing was claimed, nothing to verify
  });

  test('Arbox unavailable: the check says so (verified = unknown), never "done"', async () => {
    const m = member();
    await say(m.phone, 'רוצה לבטל את המנוי');
    const [c] = openCases(m.phone);
    arbox.mode.down = true; gateway.clearCache();
    const r = await post(`/api/tomer/cases/${c.id}/refresh-arbox`, { by: 'עדן' });
    expect(r.body.arboxAvailable).toBe(false);
    expect(r.body.case.facts.error).toBeTruthy();
    expect(r.body.case.arboxCheck).toMatchObject({ verified: null });
  });

  test('disk failure: no case is claimed, the member gets no false "recorded", the manager is told', async () => {
    const m = member();
    const real = fs.renameSync;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((a, b) => { if (String(b).endsWith('service_cases.json')) throw new Error('ENOSPC'); return real(a, b); });
    try {
      const r = await say(m.phone, 'רוצה לבטל את המנוי');
      expect(r.route).toBe('tomer_error');
      expect(textsTo(m.phone)).toHaveLength(0);
      expect(cases.list({ phone: m.phone })).toHaveLength(0);
      expect(mockOut.mgr).toHaveLength(0);
      expect(mockOut.alerts).toHaveLength(1);
      expect(mockOut.alerts[0].subject).toMatch(/לא טופלה/);
    } finally { spy.mockRestore(); }
    await say(m.phone, 'רוצה לבטל את המנוי');
    expect(openCases(m.phone)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('E. Manager notification: failure, ambiguity, retry, restart', () => {
  test('provider rejects the alert → "failed"; the member is told only that it was recorded; panel retry sends once', async () => {
    const m = member();
    mockOut.mgrMode = 'reject';
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    const [c] = openCases(m.phone);
    expect(c.notification).toMatchObject({ state: 'failed', attempts: 1 });
    expect(lastTo(m.phone)).toMatch(/רשמתי פנייה/);
    expect(lastTo(m.phone)).not.toMatch(NOTIFIED_CLAIM);
    const still = await post(`/api/tomer/cases/${c.id}/retry-notification`);
    expect(still.status).toBe(502);
    expect(still.body.error).toBe('notify_failed');
    mockOut.mgrMode = 'slow';                                           // the provider takes a moment: a double click overlaps
    const [r1, r2] = await Promise.all([post(`/api/tomer/cases/${c.id}/retry-notification`), post(`/api/tomer/cases/${c.id}/retry-notification`)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);          // the second click finds one in flight
    expect([r1.body.error, r2.body.error]).toContain('notification_in_flight');
    expect(cases.get(c.id).notification.state).toBe('accepted');
    mockOut.mgrMode = 'ok';
    const again = await post(`/api/tomer/cases/${c.id}/retry-notification`);
    expect(again.body.unchanged).toBe(true);
    expect(mockOut.mgr).toHaveLength(1);                                // exactly one alert reached the manager
  });

  test('timeout → "uncertain": not repeated by itself, not repeated by a plain retry; only an explicit forced retry sends', async () => {
    const m = member();
    mockOut.mgrMode = 'timeout';
    await say(m.phone, 'רוצה לבטל את המנוי');
    const [c] = openCases(m.phone);
    expect(c.notification.state).toBe('uncertain');
    const calls = mockOut.mgrCalls;
    await say(m.phone, 'רוצה לבטל את המנוי');                          // a follow-up never re-alerts
    const plain = await post(`/api/tomer/cases/${c.id}/retry-notification`);
    expect(plain.status).toBe(409);
    expect(plain.body.error).toBe('uncertain_needs_confirm');
    expect(mockOut.mgrCalls).toBe(calls);
    mockOut.mgrMode = 'ok';
    const forced = await post(`/api/tomer/cases/${c.id}/retry-notification`, { force: true });
    expect(forced.body.case.notification.state).toBe('accepted');
    expect(mockOut.mgrCalls).toBe(calls + 1);
  });

  test('a provider answer without a message id is not "sent"', async () => {
    const m = member();
    mockOut.mgrMode = 'noid';
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    expect(openCases(m.phone)[0].notification.state).toBe('failed');
  });

  test('restart: nothing is replayed — an alert in flight becomes "uncertain", an unsent one "failed", accepted stays', async () => {
    const [a, b, c] = [member(), member(), member()];
    await say(a.phone, 'צריכה לדבר איתך בהקדם');
    await say(b.phone, 'צריכה לדבר איתך בהקדם');
    await say(c.phone, 'צריכה לדבר איתך בהקדם');
    const [ca] = openCases(a.phone), [cb] = openCases(b.phone), [cc] = openCases(c.phone);
    // The only way to produce a process death mid-send / before send: write the durable markers.
    cases.update(ca.id, {}, null, { notificationPatch: { state: 'pending', inFlightSince: new Date().toISOString() } });
    cases.update(cb.id, {}, null, { notificationPatch: { state: 'pending', inFlightSince: null } });
    const calls = mockOut.mgrCalls;
    restart();
    const ok = await waitFor(() => cases.get(ca.id)?.notification?.state === 'uncertain' && cases.get(cb.id)?.notification?.state === 'failed');
    expect(ok).toBeTruthy();
    expect(cases.get(cc.id).notification.state).toBe('accepted');
    expect(mockOut.mgrCalls).toBe(calls);                               // no historical alert was re-sent
    expect(openCases(a.phone)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('F. The staff workflow on a case (panel API)', () => {
  test('assign → in progress; awaiting member → the member\'s answer brings it back; counters follow', async () => {
    const m = member();
    await say(m.phone, 'לא הבנתי על מה חויבתי ועל איזה חודש');
    const [c] = openCases(m.phone);
    const base = (await get('/api/tomer/cases?open=1')).body.counts;
    expect((await post(`/api/tomer/cases/${c.id}/assign`, { by: 'עדן' })).body.error).toBe('owner_required');
    const as = await post(`/api/tomer/cases/${c.id}/assign`, { to: 'עדן', by: 'עדן' });
    expect(as.body.case).toMatchObject({ owner: 'עדן', status: 'in_progress' });
    const st = await post(`/api/tomer/cases/${c.id}/status`, { status: 'awaiting_member', by: 'עדן' });
    expect(st.body.case.status).toBe('awaiting_member');
    expect((await post(`/api/tomer/cases/${c.id}/status`, { status: 'resolved', by: 'עדן' })).body.error).toBe('bad_status');
    const mid = (await get('/api/tomer/cases?open=1')).body.counts;
    expect(mid.awaiting_member).toBe(base.awaiting_member + 1);
    expect(mid.awaiting_staff).toBe(base.awaiting_staff - 1);
    expect(mid.open).toBe(base.open);
    await say(m.phone, 'החיוב של אוקטובר, למה חויבתי 400?');
    expect(cases.get(c.id)).toMatchObject({ status: 'in_progress', unreadMember: true });
    expect(mockOut.mgr).toHaveLength(1);
    const by = (await get('/api/tomer/cases?status=in_progress')).body.cases.map(x => x.id);
    expect(by).toContain(c.id);
  });

  test('a staff reply is sent as staff, recorded as staff (never as Tomer), and takes the conversation over', async () => {
    const m = member();
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    const [c] = openCases(m.phone);
    const r = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי, אני מתקשרת עוד רגע', by: 'עדן', awaitMember: true });
    expect(r.body.ok).toBe(true);
    const sent = mockOut.texts.filter(t => t.to === m.phone).at(-1);
    expect(sent.text).toBe('היי, אני מתקשרת עוד רגע');                 // no Tomer introduction on a human message
    expect(r.body.case).toMatchObject({ status: 'awaiting_member', owner: 'עדן', conversationOwner: 'human' });
    expect(r.body.case.context.at(-1)).toMatchObject({ from: 'staff', by: 'עדן' });
    const out = inbox.getThread(m.phone).messages.filter(x => x.direction === 'out').at(-1);
    expect(out).toMatchObject({ agentId: 'staff', meta: { agent: 'staff', handler: 'case_staff_reply', by: 'עדן' } });
    expect(store.getLead(m.phone)).toMatchObject({ status: 'human_owns', meta: { humanOwnsBy: 'עדן', previousStatus: 'converted_member' } });
    const view = (await get(`/api/tomer/cases/${c.id}`)).body;
    expect(view.conversation.owner).toBe('human');
    expect(view.conversation.messages.at(-1)).toMatchObject({ who: 'staff', by: 'עדן', text: 'היי, אני מתקשרת עוד רגע' });
    expect(view.conversation.messages.some(x => x.who === 'tomer')).toBe(true);
    expect(view.conversation.messages.some(x => x.who === 'member')).toBe(true);
    // While staff own the conversation Tomer is silent, but the member's message reaches the case.
    const n = textsTo(m.phone).length;
    const held = await say(m.phone, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    expect(held.route).toBe('human_owns_hold');
    expect(textsTo(m.phone)).toHaveLength(n);
    expect(cases.get(c.id)).toMatchObject({ unreadMember: true, status: 'in_progress' });
    expect(cases.get(c.id).context.at(-1).text).toMatch(/להקפיא/);
  });

  test('a staff reply that the provider rejects or times out is reported — no takeover, nothing recorded as sent', async () => {
    const m = member();
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    const [c] = openCases(m.phone);
    mockOut.memberMode = 'reject';
    const bad = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי', by: 'עדן' });
    expect(bad.status).toBe(502);
    expect(bad.body.error).toBe('send_failed');
    mockOut.memberMode = 'timeout';
    const unk = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי', by: 'עדן' });
    expect(unk.body.error).toBe('send_uncertain');
    expect(store.getLead(m.phone)?.status).not.toBe('human_owns');
    expect(cases.get(c.id).context.some(x => x.from === 'staff')).toBe(false);
    expect((await post(`/api/tomer/cases/${c.id}/reply`, { text: '  ', by: 'עדן' })).body.error).toBe('text_required');
  });

  test('resolve needs a note; a resolved case leaves the open list, cannot be replied to, and can be reopened', async () => {
    const m = member();
    await say(m.phone, 'לא הבנתי על מה חויבתי ועל איזה חודש');
    const [c] = openCases(m.phone);
    expect((await post(`/api/tomer/cases/${c.id}/resolve`, { by: 'עדן' })).body.error).toBe('note_required');
    const r = await post(`/api/tomer/cases/${c.id}/resolve`, { note: 'הוסבר בטלפון, אין טעות בחיוב', by: 'עדן' });
    expect(r.body.case).toMatchObject({ status: 'resolved', resolution: { outcome: 'handled', by: 'עדן' } });
    expect(openCases(m.phone)).toHaveLength(0);
    expect((await post(`/api/tomer/cases/${c.id}/resolve`, { note: 'שוב', by: 'עדן' })).body.unchanged).toBe(true);
    expect((await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי', by: 'עדן' })).body.error).toBe('case_closed');
    expect(diskCase(c.id).resolution.note).toBe('הוסבר בטלפון, אין טעות בחיוב');
    // The same issue raised again after closing is a NEW case with a new alert.
    await say(m.phone, 'שוב חויבתי פעמיים החודש');
    expect(openCases(m.phone)).toHaveLength(1);
    expect(openCases(m.phone)[0].id).not.toBe(c.id);
    expect(mockOut.mgr).toHaveLength(2);
    const ro = await post(`/api/tomer/cases/${c.id}/reopen`, { by: 'עדן' });
    expect(ro.body.case).toMatchObject({ status: 'in_progress', resolution: null });
  });

  test('unknown case id → 404 on read and on every operation', async () => {
    expect((await get('/api/tomer/cases/case-nope')).status).toBe(404);
    expect((await post('/api/tomer/cases/case-nope/resolve', { note: 'x y' })).status).toBe(404);
    expect((await post('/api/tomer/cases/case-nope/takeover', {})).status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('G. Human takeover for members (converted_member), restart, release', () => {
  test('a reply typed on the studio phone silences Tomer for a member; survives restart; release is idempotent and restores the member state', async () => {
    const m = member();
    // A former lead that became a member: the audited case where a phone reply did NOT pause Tomer.
    store.upsertLead(m.phone, { status: 'converted_member', meta: { isConfirmedMember: true } });
    await say(m.phone, 'לא הבנתי על מה חויבתי ועל איזה חודש');
    expect(store.getLead(m.phone)?.status).toBe('converted_member');
    const [c] = openCases(m.phone);
    await phoneSend(m.phone, 'היי, בודקת ומעדכנת');
    expect(store.getLead(m.phone)).toMatchObject({ status: 'human_owns', meta: { previousStatus: 'converted_member' } });
    const out = inbox.getThread(m.phone).messages.filter(x => x.direction === 'out').at(-1);
    expect(out).toMatchObject({ agentId: 'staff', text: 'היי, בודקת ומעדכנת', meta: { agent: 'staff', handler: 'phone_reply' } });
    expect(cases.get(c.id).events.some(e => e.type === 'human_takeover')).toBe(true);
    const n = textsTo(m.phone).length;
    expect((await say(m.phone, 'מה יש מחר?')).route).toBe('human_owns_hold');
    expect(textsTo(m.phone)).toHaveLength(n);

    restart();
    expect(store.getLead(m.phone)?.status).toBe('human_owns');          // read back from disk
    expect((await say(m.phone, 'ומה עם מחרתיים?')).route).toBe('human_owns_hold');
    expect(textsTo(m.phone)).toHaveLength(n);

    // A second takeover (dashboard) must not overwrite the state to restore.
    await post(`/api/tomer/cases/${c.id}/takeover`, { by: 'עדן' });
    expect(store.getLead(m.phone).meta.previousStatus).toBe('converted_member');
    const rel = await post(`/api/tomer/cases/${c.id}/release`, { by: 'עדן' });
    expect(rel.body).toMatchObject({ ok: true, unchanged: false, restoredTo: 'converted_member', conversationOwner: 'tomer' });
    const rel2 = await post(`/api/tomer/cases/${c.id}/release`, { by: 'עדן' });
    expect(rel2.body).toMatchObject({ ok: true, unchanged: true, conversationOwner: 'tomer' });
    expect(store.getLead(m.phone).status).toBe('converted_member');
    expect(cases.get(c.id).events.filter(e => e.type === 'human_release')).toHaveLength(1);
    gateway.clearCache();
    expect((await say(m.phone, 'מה יש מחר?')).route).toBe('tomer_answered');   // Tomer answers again
    expect(textsTo(m.phone).length).toBe(n + 1);
  });

  test('takeover from the case works for a member with no lead record at all and is released back to Tomer', async () => {
    const m = member();
    const c = cases.create({ phone: m.phone, memberName: 'דנה בדיקה', category: 'general_request', summary: 'בדיקה', notificationRequired: false });
    expect(store.getLead(m.phone)).toBeFalsy();
    const t = await post(`/api/tomer/cases/${c.id}/takeover`, { by: 'עדן' });
    expect(t.body).toMatchObject({ ok: true, conversationOwner: 'human' });
    expect((await say(m.phone, 'מה יש מחר?')).route).toBe('human_owns_hold');
    const r = await post(`/api/tomer/cases/${c.id}/release`, { by: 'עדן' });
    expect(r.body.conversationOwner).toBe('tomer');
    expect((await say(m.phone, 'מה יש מחר?')).route).toBe('tomer_answered');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H. Duplicate suppression across a restart', () => {
  test('a provider message id handled before the restart is not handled again after it', async () => {
    const m = member();
    await say(m.phone, 'רוצה לבטל את המנוי', { messageId: 'DUP-1' });
    const [c] = openCases(m.phone);
    const n = textsTo(m.phone).length, ctx = c.context.length, mgr = mockOut.mgr.length;
    restart();
    const r = await say(m.phone, 'רוצה לבטל את המנוי', { messageId: 'DUP-1' });
    expect(r.route).toBe('tomer_duplicate');
    expect(textsTo(m.phone)).toHaveLength(n);
    expect(cases.get(c.id).context).toHaveLength(ctx);
    expect(mockOut.mgr).toHaveLength(mgr);
    // A genuinely new message (new id) with the same words is a follow-up on the same case.
    await say(m.phone, 'רוצה לבטל את המנוי', { messageId: 'DUP-2' });
    expect(cases.get(c.id).context).toHaveLength(ctx + 1);
    expect(openCases(m.phone)).toHaveLength(1);
    expect(mockOut.mgr).toHaveLength(mgr);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('I. Opt-out, attribution, Barak', () => {
  test('member opt-out is honoured and survives the member bookkeeping step', async () => {
    const m = member();
    await say(m.phone, 'הסר אותי מהרשימה');
    expect(store.getLead(m.phone).status).toBe('opted_out');
    expect(lastTo(m.phone)).toMatch(/לא אשלח הודעות נוספות/);
    const n = textsTo(m.phone).length;
    const r = await say(m.phone, 'מה יש מחר?');
    expect(r.route).toBe('opted_out_silent');
    expect(textsTo(m.phone)).toHaveLength(n);
  });

  test('a member who opted out cannot be messaged from a case', async () => {
    const m = member();
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    const [c] = openCases(m.phone);
    await say(m.phone, 'הסר אותי מהרשימה');
    const n = textsTo(m.phone).length;
    const r = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי', by: 'עדן' });
    expect(r.body.error).toBe('member_opted_out');
    expect(textsTo(m.phone)).toHaveLength(n);
  });

  test('every Tomer message is attributed (agent, handler, trigger, data source, provider id)', async () => {
    const m = member();
    await say(m.phone, 'מה יש מחר?');
    const thread = inbox.getThread ? inbox.getThread(m.phone) : null;
    const msgs = (thread?.messages ?? []).filter(x => x.direction === 'out');
    expect(msgs.at(-1)).toMatchObject({ agentId: 'tomer', meta: { agent: 'tomer', handler: 'schedule', trigger: 'schedule_query', sendState: 'sent' } });
    expect(msgs.at(-1).meta.idMessage).toMatch(/^MSG_/);
    expect(msgs.at(-1).meta.dataSource).toMatch(/schedule/);
    // A reply to a member who just wrote is sent directly — never the shared quiet-hours
    // "נחזור אליך מחר בבוקר" promise + in-memory queue.
    expect(mockOut.texts.filter(t => t.to === m.phone).at(-1).opts).toMatchObject({ bypassQuietHours: true });
  });

  test('a lead is still handled by Barak, and Tomer never sees it', async () => {
    const phone = '972587009999';
    mockAi.queue.push('היי! ספרי לי מה המטרה שלך 🙂');
    const r = await say(phone, 'היי, מתעניינת בפילאטיס מכשירים');
    expect(r.route).toBe('barak');
    expect(cases.list({ phone })).toHaveLength(0);
    expect(mockOut.texts.filter(t => t.to === phone).map(t => t.text).join('\n')).not.toMatch(/אני תומר/);
  });

  test('kill switch TOMER_SERVICE_ENABLED=false restores the previous routing', async () => {
    const m = member();
    process.env.TOMER_SERVICE_ENABLED = 'false';
    try {
      const r = await say(m.phone, 'תודה');
      expect(r.route).not.toMatch(/^tomer_/);
    } finally { delete process.env.TOMER_SERVICE_ENABLED; }
  });
});
