'use strict';
/**
 * tomer_member_flow.test.js — Tomer (existing-member service), end to end.
 *
 * REAL: server.js pipeline, tomer_service, member_intent, member_actions, arbox_gateway
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

const mockOut = { texts: [], alerts: [], seq: 0, failManager: false };
jest.mock('../services/whatsapp.service', () => {
  const actual = jest.requireActual('../services/whatsapp.service');
  return {
    ...actual,
    sendText: jest.fn((to, text) => { const id = `MSG_${++mockOut.seq}`; mockOut.texts.push({ to, text, id }); return Promise.resolve({ idMessage: id }); }),
    alertOwner: jest.fn((subject, body, opts = {}) => {
      const phone = '972509000001';
      if (mockOut.failManager) return Promise.resolve({ sent: 0, results: [{ phone, skipped: false, idMessage: null, error: 'simulated_mgr_fail' }] });
      const id = `MGR_${++mockOut.seq}`;
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

async function say(phone, text, { type = 'text' } = {}) {
  const res = await request(app).post('/api/whatsapp/simulate')
    .send({ from: phone, text, name: 'WA Profile', type, messageId: `tm-${++msgSeq}`, timestamp: new Date().toISOString() })
    .set('Content-Type', 'application/json');
  if (res.status !== 200) throw new Error(`simulate ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}
const post = (url, body = {}) => request(app).post(url).send(body).set('Content-Type', 'application/json');
const textsTo = p => mockOut.texts.filter(t => t.to === p).map(t => t.text);
const lastTo  = p => textsTo(p).at(-1) ?? null;
const openCases = p => cases.list({ phone: p, open: true });
const diskCase  = id => JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')).cases.find(c => c.id === id);
const FALSE_CONFIRM = /בקשת הביטול התקבלה|קיבלנו את אישור התשלום|רוצה מקום\?|נרשמת בהצלחה|ביטלתי לך|הקפאתי/;

beforeAll(async () => {
  jest.useFakeTimers({ now: T0, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
  process.env.ARBOX_BASE_URL = await arbox.listen();
  restart();
});
beforeEach(() => {
  jest.setSystemTime(T0);
  mockOut.texts.length = 0; mockOut.alerts.length = 0; mockOut.failManager = false; mockAi.queue.length = 0;
  arbox.reset(); seedSchedule(); gateway.clearCache();
  delete process.env.ARBOX_WRITES_ENABLED; delete process.env.ARBOX_TEST_ASSUME_CONTRACT;
});
afterAll(async () => { jest.useRealTimers(); await arbox.close(); });
const enableWrites = () => { process.env.ARBOX_WRITES_ENABLED = 'true'; process.env.ARBOX_TEST_ASSUME_CONTRACT = 'true'; };

// ══════════════════════════════════════════════════════════════════════════════
describe('A. No false confirmations, no dropped requests', () => {
  test('membership cancellation is a staff-approval case — never the class-cancel template', async () => {
    const m = member();
    const r = await say(m.phone, 'רוצה לבטל את המנוי');
    expect(r.route).toBe('tomer_case_opened');
    expect(lastTo(m.phone)).toMatch(/המנוי לא בוטל/);
    expect(textsTo(m.phone).join('\n')).not.toMatch(FALSE_CONFIRM);
    const [c] = openCases(m.phone);
    expect(c.category).toBe('membership_cancel');
    expect(c.action).toMatchObject({ op: 'membership_cancel', state: 'awaiting_approval', args: { userId: m.userId, membershipUserId: m.mid } });
    expect(mockOut.alerts).toHaveLength(1);
    expect(mockOut.alerts[0].body).toContain(c.id);
    expect(mockOut.alerts[0].linkPreview).toBe(false);
    expect(diskCase(c.id).notification.state).toBe('accepted');
    expect(arbox.writes()).toHaveLength(0);
  });

  test('a repeated request joins the open case: no second case, no second manager alert', async () => {
    const m = member();
    await say(m.phone, 'אני רוצה לבטל את המנוי שלי');
    await say(m.phone, 'רוצה לבטל את המנוי');
    expect(openCases(m.phone)).toHaveLength(1);
    expect(mockOut.alerts).toHaveLength(1);
    expect(lastTo(m.phone)).toMatch(/כבר פתוחה/);
  });

  test.each([
    ['הי\nתתקשר אלי כשתוכל', 'staff_request'],
    ['יכול לבדוק עבורי, ולזכות את חשבוני .\nתודה רבה🙏🏻', 'refund_request'],
    ['מוזר זה היה נראה שבוטל באפליקציה', 'app_problem'],
    ['לא הבנתי על מה חויבתי ועל איזה חודש', 'billing_dispute'],
  ])('short real request %j is not dropped → case %s + one alert', async (text, category) => {
    const m = member();
    await say(m.phone, text);
    const [c] = openCases(m.phone);
    expect(c?.category).toBe(category);
    expect(mockOut.alerts).toHaveLength(1);
    expect(textsTo(m.phone)).toHaveLength(1);
    expect(lastTo(m.phone)).not.toMatch(FALSE_CONFIRM);
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
    expect(mockOut.alerts).toHaveLength(1);
    expect(textsTo(m.phone)).toHaveLength(2);
  });

  test('an image is never acknowledged as a payment or as "handled"', async () => {
    const m = member();
    await say(m.phone, '[תמונה]', { type: 'image' });
    expect(lastTo(m.phone)).toMatch(/אין לי אפשרות לצפות בתמונות/);
    expect(lastTo(m.phone)).not.toMatch(/אישור התשלום|יחזור אליך בהקדם/);
    expect(openCases(m.phone)[0].category).toBe('media_message');
    expect(mockOut.alerts).toHaveLength(1);
    await say(m.phone, '[תמונה]', { type: 'image' });
    expect(textsTo(m.phone)).toHaveLength(1);
    expect(mockOut.alerts).toHaveLength(1);
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
    expect(mockOut.alerts).toHaveLength(0);
  });

  test('injury and complaint go to staff; Tomer gives no medical advice', async () => {
    const m = member();
    await say(m.phone, 'נפצעתי בברך באימון אתמול, אפשר להמשיך להתאמן?');
    expect(lastTo(m.phone)).toMatch(/לא יכול לתת הנחיה רפואית/);
    expect(openCases(m.phone)[0]).toMatchObject({ category: 'injury', priority: 'high' });
  });

  test('a failed manager alert is recorded and can be retried from the panel', async () => {
    const m = member();
    mockOut.failManager = true;
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    const [c] = openCases(m.phone);
    expect(c.notification).toMatchObject({ state: 'failed', attempts: 1 });
    mockOut.failManager = false;
    const r = await post(`/api/tomer/cases/${c.id}/retry-notification`);
    expect(r.body.case.notification.state).toBe('accepted');
    const again = await post(`/api/tomer/cases/${c.id}/retry-notification`);
    expect(again.body.unchanged).toBe(true);
    expect(mockOut.alerts).toHaveLength(1);
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
describe('D. Membership actions: approval, execution, verification', () => {
  async function freezeCase(m, text = 'רוצה להקפיא את המנוי מ-1.12 עד 15.12') {
    await say(m.phone, text);
    return openCases(m.phone).find(c => c.category === 'membership_freeze');
  }

  test('freeze request captures dates; nothing is sent to Arbox before approval', async () => {
    const m = member();
    const c = await freezeCase(m);
    expect(c.action).toMatchObject({ op: 'membership_hold', state: 'awaiting_approval', args: { from: '2026-12-01', to: '2026-12-15', membershipUserId: m.mid } });
    expect(lastTo(m.phone)).toMatch(/המנוי לא הוקפא בשלב זה/);
    expect(arbox.writes()).toHaveLength(0);
  });

  test('freeze without dates → asks once; dates complete the same case', async () => {
    const m = member();
    const c = await freezeCase(m, 'אפשר להקפיא את המנוי?');
    expect(lastTo(m.phone)).toMatch(/מאיזה תאריך ועד איזה תאריך\?/);
    const ap = await post(`/api/tomer/cases/${c.id}/approve`);
    expect(ap.status).toBe(409);
    expect(ap.body.error).toBe('invalid_args');
    await say(m.phone, '1.12.26 עד 20.12.26');
    expect(cases.get(c.id).action.args).toMatchObject({ from: '2026-12-01', to: '2026-12-20' });
    expect(openCases(m.phone)).toHaveLength(1);
    expect(mockOut.alerts).toHaveLength(1);
  });

  test('writes disabled (production default): approve → manual execution → member told only after read-back', async () => {
    const m = member();
    const c = await freezeCase(m);
    const before = textsTo(m.phone).length;
    const ap = await post(`/api/tomer/cases/${c.id}/approve`, { by: 'עדן' });
    expect(ap.body.case.action.state).toBe('awaiting_manual');
    expect(arbox.writes()).toHaveLength(0);
    const nv = await post(`/api/tomer/cases/${c.id}/mark-executed`, { by: 'עדן' });
    expect(nv.body.verified).toBe(false);
    expect(cases.get(c.id).action.state).toBe('not_verified');
    expect(textsTo(m.phone)).toHaveLength(before);               // member told nothing
    arbox.state.holds.push({ user_id: m.userId, membership_user_id: m.mid, start_date: '2026-12-01', end_date: '2026-12-15' });
    const ok = await post(`/api/tomer/cases/${c.id}/mark-executed`, { by: 'עדן' });
    expect(ok.body.verified).toBe(true);
    expect(cases.get(c.id).action).toMatchObject({ state: 'verified', executor: 'staff_manual' });
    expect(lastTo(m.phone)).toMatch(/הקפאת המנוי אושרה ונרשמה ב-Arbox ✅ לתאריכים 01\.12\.2026 – 15\.12\.2026/);
    await post(`/api/tomer/cases/${c.id}/mark-executed`, { by: 'עדן' });
    expect(textsTo(m.phone)).toHaveLength(before + 1);           // told exactly once
  });

  test('rejection reaches the member with the staff note', async () => {
    const m = member();
    const c = await freezeCase(m);
    await post(`/api/tomer/cases/${c.id}/reject`, { by: 'עדן', note: 'הקפאה אפשרית מהחודש הבא' });
    expect(lastTo(m.phone)).toMatch(/בקשת הקפאת מנוי לא אושרה על ידי הצוות\.\nהערת הצוות: הקפאה אפשרית מהחודש הבא/);
    expect(cases.get(c.id).status).toBe('rejected');
    const again = await post(`/api/tomer/cases/${c.id}/approve`);
    expect(again.status).toBe(409);
  });

  test('API executor: one request, verified by read-back; a duplicate approval sends nothing', async () => {
    enableWrites();
    const m = member();
    const c = await freezeCase(m);
    const [a, b] = await Promise.all([post(`/api/tomer/cases/${c.id}/approve`), post(`/api/tomer/cases/${c.id}/approve`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(arbox.writes()).toHaveLength(1);
    expect(arbox.writes()[0].body).toMatchObject({ membership_user_id: m.mid, start_date: '2026-12-01', end_date: '2026-12-15' });
    expect(cases.get(c.id).action).toMatchObject({ state: 'verified', executor: 'api' });
    expect(textsTo(m.phone).filter(t => /נרשמה ב-Arbox ✅/.test(t))).toHaveLength(1);
  });

  test('Arbox rejects → failed; member is not told it succeeded', async () => {
    enableWrites(); arbox.mode.write = 'reject';
    const m = member();
    const c = await freezeCase(m);
    await post(`/api/tomer/cases/${c.id}/approve`);
    expect(cases.get(c.id)).toMatchObject({ status: 'awaiting_staff', action: { state: 'failed' } });
    expect(textsTo(m.phone).join('\n')).not.toMatch(/נרשמה ב-Arbox/);
  });

  test('timeout AFTER Arbox applied the change → verified by read-back, no retry', async () => {
    enableWrites(); arbox.mode.write = 'timeout_after_apply';
    const m = member();
    const c = await freezeCase(m);
    await post(`/api/tomer/cases/${c.id}/approve`);
    expect(arbox.writes()).toHaveLength(1);
    expect(cases.get(c.id).action.state).toBe('verified');
    expect(cases.get(c.id).action.attempts[0].state).toBe('unknown_then_verified');
  });

  test.each(['timeout_no_apply', 'error500_no_apply', 'accept_no_apply'])('%s → uncertain: no blind retry, no success message, staff recheck', async (mode) => {
    enableWrites(); arbox.mode.write = mode;
    const m = member();
    const c = await freezeCase(m);
    await post(`/api/tomer/cases/${c.id}/approve`);
    expect(cases.get(c.id)).toMatchObject({ status: 'awaiting_staff', action: { state: 'uncertain' } });
    expect(arbox.writes()).toHaveLength(1);
    expect(textsTo(m.phone).join('\n')).not.toMatch(/נרשמה ב-Arbox/);
    const again = await post(`/api/tomer/cases/${c.id}/approve`);
    expect(again.body.unchanged).toBe(true);
    await post(`/api/tomer/cases/${c.id}/recheck`);
    expect(arbox.writes()).toHaveLength(1);
    expect(cases.get(c.id).action.state).toBe('uncertain');
    arbox.state.holds.push({ user_id: m.userId, membership_user_id: m.mid });
    const r = await post(`/api/tomer/cases/${c.id}/recheck`);
    expect(r.body.verified).toBe(true);
  });

  test('membership cancel via API executor is verified from the membership record', async () => {
    enableWrites();
    const m = member();
    await say(m.phone, 'רוצה לבטל את המנוי');
    const [c] = openCases(m.phone);
    await post(`/api/tomer/cases/${c.id}/approve`);
    expect(cases.get(c.id).action.state).toBe('verified');
    expect(lastTo(m.phone)).toMatch(/ביטול המנוי אושר ונרשם ב-Arbox ✅/);
  });

  test('disk failure: no case is claimed, the member gets no false "opened", the manager is told', async () => {
    const m = member();
    const real = fs.renameSync;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((a, b) => { if (String(b).endsWith('service_cases.json')) throw new Error('ENOSPC'); return real(a, b); });
    try {
      const r = await say(m.phone, 'רוצה לבטל את המנוי');
      expect(r.route).toBe('tomer_error');
      expect(textsTo(m.phone)).toHaveLength(0);
      expect(cases.list({ phone: m.phone })).toHaveLength(0);
      expect(mockOut.alerts).toHaveLength(1);
      expect(mockOut.alerts[0].subject).toMatch(/לא טופלה/);
    } finally { spy.mockRestore(); }
    await say(m.phone, 'רוצה לבטל את המנוי');
    expect(openCases(m.phone)).toHaveLength(1);
  });

  test('restart: cases survive; an action that was in flight is reconciled by reading, never re-sent', async () => {
    enableWrites();
    const m = member();
    const c = await freezeCase(m);
    // Simulate a process death between "executing recorded" and the provider answer.
    cases.update(c.id, { status: 'in_progress' }, { type: 'action_executing', by: 'test' }, { actionPatch: { state: 'executing', approval: { decision: 'approved', by: 'עדן' }, attempts: [{ id: 'x', state: 'submitted' }] } });
    restart();
    const got = await waitFor(() => (cases.get(c.id)?.action?.state === 'uncertain' ? cases.get(c.id) : null));
    expect(got).toBeTruthy();
    expect(got.status).toBe('awaiting_staff');
    expect(arbox.writes()).toHaveLength(0);
    expect(mockOut.texts.filter(t => /נרשמה ב-Arbox/.test(t.text))).toHaveLength(0);
    expect(openCases(m.phone)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('E. Ownership, opt-out, attribution, Barak', () => {
  test('a staff reply from the case takes the conversation over: Tomer goes silent for the member', async () => {
    const m = member();
    await say(m.phone, 'צריכה לדבר איתך בהקדם');
    const [c] = openCases(m.phone);
    const r = await post(`/api/tomer/cases/${c.id}/reply`, { text: 'היי, אני מתקשרת עוד רגע', by: 'עדן' });
    expect(r.body.ok).toBe(true);
    expect(store.getLead(m.phone).status).toBe('human_owns');
    const n = textsTo(m.phone).length;
    const out = await say(m.phone, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    expect(out.route).toBe('human_owns_hold');
    expect(textsTo(m.phone)).toHaveLength(n);
  });

  test('takeover with an approved action: nothing is executed automatically; "execute now" is explicit', async () => {
    enableWrites();
    const m = member();
    await say(m.phone, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
    const [c] = openCases(m.phone);
    await post(`/api/tomer/cases/${c.id}/reply`, { text: 'בודקת', by: 'עדן' });
    await post(`/api/tomer/cases/${c.id}/approve`, { by: 'עדן' });
    expect(cases.get(c.id).action).toMatchObject({ state: 'approved', heldForTakeover: true });
    expect(arbox.writes()).toHaveLength(0);
    const n = textsTo(m.phone).length;
    await post(`/api/tomer/cases/${c.id}/execute-now`, { by: 'עדן' });
    expect(arbox.writes()).toHaveLength(1);
    expect(cases.get(c.id).action.state).toBe('verified');
    expect(textsTo(m.phone)).toHaveLength(n);                   // human owns the conversation: no bot notice
    expect(cases.get(c.id).memberNotice).toMatchObject({ state: 'withheld', reason: 'human_owns' });
  });

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

  test('every Tomer message is attributed (agent, handler, trigger, data source, provider id)', async () => {
    const m = member();
    await say(m.phone, 'מה יש מחר?');
    const thread = inbox.getThread ? inbox.getThread(m.phone) : null;
    const msgs = (thread?.messages ?? []).filter(x => x.direction === 'out');
    expect(msgs.at(-1)).toMatchObject({ agentId: 'tomer', meta: { agent: 'tomer', handler: 'schedule', trigger: 'schedule_query', sendState: 'sent' } });
    expect(msgs.at(-1).meta.idMessage).toMatch(/^MSG_/);
    expect(msgs.at(-1).meta.dataSource).toMatch(/schedule/);
  });

  test('a lead is still handled by Barak, and Tomer never sees it', async () => {
    const phone = '972587009999';
    mockAi.queue.push('היי! ספרי לי מה המטרה שלך 🙂');
    const r = await say(phone, 'היי, מתעניינת בפילאטיס מכשירים');
    expect(r.route).toBe('barak');
    expect(cases.list({ phone })).toHaveLength(0);
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
