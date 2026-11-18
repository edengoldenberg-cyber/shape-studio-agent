'use strict';
/**
 * service_misses_2026_11_16.test.js — the three conversations of 16.11.2026 in which Barak and Tomer did not finish
 * the job, replayed through the REAL pipeline (server.js, lead_agent, callback.service, member_handoff, the stores on
 * a fresh temporary DATA_DIR). Only the transports are mocked: WhatsApp sends (captured), OpenAI (scripted) and the
 * Arbox HTTP layer (a fake that can only be READ - a write throws and is counted).
 *
 *   1. a member asks to move from the 18:00 class to 17:00           (was: a model's free text, no task, no alert)
 *   2. a lead asks what a trial costs, then a call is arranged       (was: a robotic closer; the call arranged by
 *      by hand for "tomorrow between 14:00-16:00"                      hand was never recorded and nobody was told)
 *   3. a member sends a voice message                                (was: "the staff will get back to you" - no task)
 *   4. a human who steps in pauses the automatic replies
 * Nothing here talks to a real customer: every phone is synthetic and every send is captured.
 */
// As in production today: the new Tomer flow is test-only and serves nobody here, so every member is on the legacy route.
const _savedTomerMode = process.env.TOMER_MODE;
delete process.env.TOMER_MODE; delete process.env.TOMER_TEST_ONLY_PHONES; delete process.env.TOMER_TEST_ROUTE_OVERRIDE;
const mockMembers = new Set();
const mockGw = { bookings: [], classes: [], fail: false, writes: 0, calls: [] };
jest.mock('../services/arbox_gateway', () => {
  const actual = jest.requireActual('../services/arbox_gateway');
  return { ...actual,
    resolveMember: jest.fn(async phone => { mockGw.calls.push('resolveMember');
      if (mockGw.fail) return { status: 'unavailable', error: 'arbox down' };
      return mockMembers.has(String(phone)) ? { status: 'found', member: { userId: 'u-' + String(phone).slice(-4), name: 'מתאמנת בדיקה', active: true, role: 'client' } } : { status: 'not_found' }; }),
    getBookings: jest.fn(async () => { mockGw.calls.push('getBookings'); if (mockGw.fail) throw new Error('arbox down'); return { bookings: mockGw.bookings, source: 'mock' }; }),
    getClasses: jest.fn(async () => { mockGw.calls.push('getClasses'); if (mockGw.fail) throw new Error('arbox down'); return { classes: mockGw.classes, occupancyAvailable: true, source: 'mock' }; }),
    executeWrite: jest.fn(async () => { mockGw.writes++; throw new Error('an Arbox write must never be attempted'); }),
  };
});

const fs   = require('fs');
const path = require('path');

process.env.TEST_MODE           = 'true';
process.env.WHATSAPP_AUTO_REPLY = 'true';
process.env.BACKEND_URL         = 'https://panel.example.test';
process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true';
process.env.CALLBACK_PENDING_REMINDER_MIN     = '30';
delete process.env.CALLBACK_PENDING_REMINDER_PHONES;
process.env.QUIET_HOUR_START = '22';
process.env.QUIET_HOUR_END   = '8';

const DATA_DIR  = process.env.DATA_DIR;                       // fresh temp dir from jest setup
const APTS_FILE = path.join(DATA_DIR, 'appointments.json');
const MANAGER   = '972509000001';                              // synthetic (isolated_env)
const WAZE_URL  = 'https://waze.com/ul?q=דרך+השדה+12,+פרדס+חנה-כרכור&navigate=yes';
fs.writeFileSync(path.join(DATA_DIR, 'studio_assets.json'), JSON.stringify({ wazeUrl: WAZE_URL }));

// ── Mocks: transports only ────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockOut = {
  texts: [],          // { to, text, id, aptFileAtSend }
  alerts: [],         // { phone, subject, body, id, linkPreview }
  failTextTo: null,   // phone → sendText rejects
  queueTextTo: null,  // phone → sendText answers like the real quiet-hours path: { queued: true }
  queued: [],
  hangTextTo: null,   // phone → sendText never settles (provider hang / process killed mid-send)
  failManager: false, // manager dispatch returns no idMessage
  seq: 0,
  aptsFile: null,
};

jest.mock('../services/whatsapp.service', () => {
  const actual = jest.requireActual('../services/whatsapp.service');
  const mfs = require('fs');
  return {
    ...actual,
    sendText: jest.fn((to, text, opts = {}) => {
      if (mockOut.failTextTo === to) return Promise.reject(new Error('simulated_send_fail'));
      if (mockOut.hangTextTo === to) return new Promise(() => {});
      if (mockOut.queueTextTo === to) { mockOut.queued.push({ to, text }); return Promise.resolve({ queued: true, releaseAt: new Date() }); }
      const id = `MSG_${++mockOut.seq}`;
      let aptFileAtSend = null;
      try { aptFileAtSend = mfs.readFileSync(mockOut.aptsFile, 'utf8'); } catch { /* no file yet */ }
      mockOut.texts.push({ to, text, id, aptFileAtSend, linkPreview: opts.linkPreview });
      return Promise.resolve({ idMessage: id });
    }),
    alertOwner: jest.fn((subject, body, opts = {}) => {
      const phone = '972509000001';
      if (opts.skipPhones instanceof Set && opts.skipPhones.has(phone)) {
        return Promise.resolve({ sent: 0, results: [{ phone, skipped: true, idMessage: null, error: null }] });
      }
      if (mockOut.failManager) {
        return Promise.resolve({ sent: 0, results: [{ phone, skipped: false, idMessage: null, error: 'simulated_mgr_fail' }] });
      }
      const id = `MGR_${++mockOut.seq}`;
      let aptFileAtSend = null;
      try { aptFileAtSend = mfs.readFileSync(mockOut.aptsFile, 'utf8'); } catch { /* no file yet */ }
      mockOut.alerts.push({ phone, subject, body, id, linkPreview: opts.linkPreview, aptFileAtSend });
      return Promise.resolve({ sent: 1, results: [{ phone, skipped: false, idMessage: id, error: null }] });
    }),
    sendFileByUrl: jest.fn(() => Promise.resolve({ idMessage: `FILE_${++mockOut.seq}` })),
  };
});
mockOut.aptsFile = APTS_FILE;

const mockAi = { queue: [], calls: 0, fallback: 'מעולה! ספרי לי קצת מה המטרה שלך באימונים 🙂' };
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn(() => {
    mockAi.calls++;
    const content = mockAi.queue.length ? mockAi.queue.shift() : mockAi.fallback;
    return Promise.resolve({ choices: [{ message: { content } }] });
  }) } },
})));

// Arbox HTTP client: reachable, and nobody is a member (so every phone is a cold lead).
jest.mock('../services/arbox.service', () => ({
  getMembers:  jest.fn(() => Promise.resolve([])),
  getLeads:    jest.fn(() => Promise.resolve([])),
  getAllUsers: jest.fn(() => Promise.resolve([])),
  getUpcomingClasses: jest.fn(() => Promise.resolve([])),
  getStaff:    jest.fn(() => Promise.resolve([])),
  testConnection: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../services/greenapi.service', () => ({
  isConfigured: jest.fn(() => false), parseWebhook: jest.fn(() => null),
  syncToInbox: jest.fn(() => Promise.resolve({ chats: 0, messages: 0 })),
  sendText: jest.fn(() => Promise.resolve({ idMessage: 'GREEN_MOCK' })),
  sendFileByUrl: jest.fn(() => Promise.resolve({ idMessage: 'GREEN_MOCK' })),
}));
jest.mock('../utils/phone_registry', () => ({
  init: jest.fn(() => Promise.resolve()), isMember: jest.fn(p => mockMembers.has(String(p))), getAll: jest.fn(() => []), size: 0,
}));
// Identity is not this suite's subject: the stand-in follows the member_cache / phone_registry mocks below.
jest.mock('../services/identity_resolver', () => require('./helpers/identity_mock.cjs'));
jest.mock('../utils/member_cache', () => ({
  isConfirmed: jest.fn(() => false), isFresh: jest.fn(() => false), getEntry: jest.fn(() => null),
  markConfirmed: jest.fn(), invalidate: jest.fn(), size: jest.fn(() => 0), flush: jest.fn(),
  seedFromArbox: jest.fn(() => Promise.resolve({ seeded: 0 })), isKnownMemberFile: jest.fn(() => false),
}));
jest.mock('../services/handoff.service', () => ({
  scoreReadiness: jest.fn(() => ({ level: 'MEDIUM', evidence: 'test' })),
  generateHandoffBrief: jest.fn(() => Promise.resolve({ briefData: {}, readiness: { level: 'MEDIUM' }, briefLines: 'brief' })),
}));
jest.mock('../services/memory.service', () => ({
  touchSession: jest.fn(), buildMemoryInjection: jest.fn(() => null),
  generateAndSaveSessionSummary: jest.fn(() => Promise.resolve()),
}));
jest.mock('../utils/demo_capture', () => ({ record: jest.fn(), isActive: jest.fn(() => false) }));


// ── Harness ────────────────────────────────────────────────────────────────
const request = require('supertest');
let app, store, aptStore, callbackTime, tomerStore, worker;
function restart() {
  jest.resetModules();
  store        = require('../utils/lead_store');
  aptStore     = require('../utils/appointment_store');
  callbackTime = require('../utils/callback_time');
  tomerStore   = require('../utils/tomer_store');
  worker       = require('../workers/appointment_worker');
  app          = require('../server');
}
const T0 = new Date('2026-11-16T08:00:00.000Z');                 // Monday 16.11.2026 10:00 Israel time
function setNow(d) { jest.setSystemTime(d instanceof Date ? d : new Date(d)); }
function il(y, m, d, h, min = 0) { return callbackTime.ilDate(y, m - 1, d, h, min); }
let phoneSeq = 500, msgSeq = 0;
const newPhone = () => `97258${String(7000000 + (++phoneSeq)).padStart(7, '0')}`;
async function say(phone, text, { name = 'WA Profile', at, type = 'text' } = {}) {
  const res = await request(app).post('/api/whatsapp/simulate')
    .send({ from: phone, text, name, type, messageId: `m-${++msgSeq}`, timestamp: (at ?? new Date()).toISOString() }).set('Content-Type', 'application/json');
  if (res.status !== 200) throw new Error(`simulate ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}
/** A message typed BY HAND on the studio phone (the outgoing webhook), as Eden does. */
async function staffTypes(phone, text) {
  const chatId = `${phone}@c.us`;
  const r = await request(app).post('/api/green-api/webhook').set('Content-Type', 'application/json').send({
    typeWebhook: 'outgoingMessageReceived', instanceData: { idInstance: 1234, wid: '972500000000@c.us' }, timestamp: Math.floor(Date.now() / 1000),
    idMessage: `2A${(++msgSeq).toString(16).toUpperCase().padStart(8, '0')}FF`, senderData: { chatId, sender: chatId, senderName: 'Staff' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } } });
  expect(r.status).toBe(200);
  await new Promise(res => setTimeout(res, 80));
}
const textsTo = phone => mockOut.texts.filter(t => t.to === phone);
const lastTo  = phone => textsTo(phone).at(-1)?.text ?? null;
const alerts  = () => mockOut.alerts;
const openApt = phone => aptStore.getActiveCallback(phone);
const aptsOf  = phone => JSON.parse(fs.readFileSync(APTS_FILE, 'utf8')).filter(a => a.leadPhone === phone);
const tasksOf = (phone, type) => tomerStore.getTasks({ phone, type });
function clearOut() { mockOut.texts.length = 0; mockOut.alerts.length = 0; mockOut.failTextTo = null; mockOut.hangTextTo = null; mockOut.queueTextTo = null; mockOut.queued.length = 0; mockOut.failManager = false; }
const newMember = () => { const p = newPhone(); mockMembers.add(p); return p; };
async function newLead() { const phone = newPhone(); const r = await say(phone, 'היי, מתעניינת בפילאטיס מכשירים'); expect(r.route).toBe('barak'); return phone; }
const DAY = '2026-11-16';
const CLASSES = [
  { scheduleId: 1, date: DAY, start: '17:00:00', end: '18:00:00', name: 'פילאטיס מכשירים', instructor: 'מדריכה', capacity: 8, status: 'active', occupancy: { registered: 5, capacity: 8, standby: 0, spotsLeft: 3 } },
  { scheduleId: 2, date: DAY, start: '18:00:00', end: '19:00:00', name: 'פילאטיס מכשירים', instructor: 'מדריכה', capacity: 8, status: 'active', occupancy: { registered: 8, capacity: 8, standby: 1, spotsLeft: 0 } },
];
const BOOKED_18 = [{ date: DAY, time: '18:00:00', className: 'פילאטיס מכשירים', instructor: 'מדריכה', checkedIn: false }];

beforeAll(() => {
  jest.useFakeTimers({ now: T0, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'] });
  restart();
});
beforeEach(() => { setNow(T0); clearOut(); mockAi.queue.length = 0; mockGw.bookings = BOOKED_18; mockGw.classes = CLASSES; mockGw.fail = false; mockGw.calls.length = 0; });
afterAll(() => { jest.useRealTimers(); if (_savedTomerMode === undefined) delete process.env.TOMER_MODE; else process.env.TOMER_MODE = _savedTomerMode; });

// ════════════════════════════════════════════════════════════════════════════
describe('1. Tomer — a member asks to move to another class', () => {
  const ASK = 'הי נרשמתי לשש פילאטיס ואני רוצה לבוא ב 17:00';

  test('the request is checked in Arbox (read-only), recorded as ONE staff task, the manager is alerted, and the member is told only what is true', async () => {
    const m = newMember(), ai = mockAi.calls;
    const r = await say(m, ASK, { name: 'חגית' });
    expect(r.route).toBe('tomer_handoff');
    expect(mockAi.calls).toBe(ai);                                           // no free-text model answers an action request
    expect(mockGw.calls).toEqual(['resolveMember', 'getBookings', 'getClasses']);
    expect(mockGw.writes).toBe(0);                                           // nothing was written to Arbox
    const tasks = tasksOf(m, 'class_change');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'open', kind: 'move', missing: null, alert: { state: 'sent', attempts: 1 }, memberReply: { state: 'sent' } });
    expect(tasks[0].detail).toMatch(/רישום קיים \(Arbox\): פילאטיס מכשירים 18:00/);
    expect(tasks[0].detail).toMatch(/שיעור מבוקש \(Arbox\): פילאטיס מכשירים 17:00 .* 5\/8 רשומים, 3 פנויים/);
    expect(tasks[0].detail).toMatch(/אין לתומר הרשאה לשנות רישום לשיעור ב-Arbox/);
    expect(tasks[0].arboxCalls.join(' ')).toMatch(/resolveMember → found .*getBookings 2026-11-16 → 1 .*getClasses 2026-11-16 → 2/);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/תומר: מעבר לשיעור אחר — חגית/);
    expect(alerts()[0].body).toMatch(/מעבר מ-18:00 ל-17:00 היום/);
    expect(alerts()[0].body).toMatch(/לא בוצע שום שינוי ב-Arbox/);
    const reply = lastTo(m);
    expect(textsTo(m)).toHaveLength(1);
    expect(reply).toMatch(/קיבלתי את הבקשה: מעבר מ-18:00 ל-17:00 היום/);
    expect(reply).toMatch(/בדקתי ב-Arbox: יש לך רישום לפילאטיס מכשירים ב-18:00 היום/);
    expect(reply).toMatch(/ב-17:00 יש פילאטיס מכשירים, ונכון לעכשיו יש בו 3 מקומות פנויים/);
    expect(reply).toMatch(/אין לי הרשאה לשנות רישום בעצמי, אז העברתי את הבקשה לצוות/);
    expect(reply).toMatch(/הרישום הקיים שלך לא השתנה/);                      // she is never left without her original place
    expect(reply).not.toMatch(/רשמתי אותך|עברת ל|שיניתי את|תצטרכי לבדוק|באפליקציה|אני רואה ש/);
  });

  test('the same request again does not open a second task and does not alert the manager twice', async () => {
    const m = newMember();
    await say(m, ASK); await say(m, ASK);
    expect(tasksOf(m, 'class_change')).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    expect(mockGw.writes).toBe(0);
  });

  test('a manager alert the provider did not accept is kept as FAILED, the member is not told it was passed on, and the retry is controlled', async () => {
    const m = newMember();
    mockOut.failManager = true;
    await say(m, ASK);
    let t = tasksOf(m, 'class_change')[0];
    expect(t.alert).toMatchObject({ state: 'failed', attempts: 1 });
    expect(lastTo(m)).toMatch(/רשמתי את הבקשה לטיפול הצוות/);
    expect(lastTo(m)).not.toMatch(/העברתי את הבקשה לצוות/);
    expect((await request(app).get('/api/tomer/tasks')).body.tasks.find(x => x.id === t.id).alert.state).toBe('failed');       // visible to the panel
    await app.locals.memberHandoff.retryFailedAlerts();                      // still failing
    await app.locals.memberHandoff.retryFailedAlerts();
    expect(tasksOf(m, 'class_change')[0].alert).toMatchObject({ state: 'failed', attempts: 3 });
    expect((await app.locals.memberHandoff.retryFailedAlerts()).retried).toBe(0);            // three attempts, then it waits for a human
    const m2 = newMember();
    await say(m2, ASK);
    mockOut.failManager = false;
    expect(await app.locals.memberHandoff.retryFailedAlerts()).toMatchObject({ retried: 1, sent: 1 });
    expect(tasksOf(m2, 'class_change')[0].alert).toMatchObject({ state: 'sent', attempts: 2 });
    expect(alerts().filter(a => a.body.includes('0' + m2.slice(3)))).toHaveLength(1);        // sent once
    expect((await app.locals.memberHandoff.retryFailedAlerts()).retried).toBe(0);
  });

  test('when one detail is missing only that is asked, and the answer completes the SAME task', async () => {
    const m = newMember();
    await say(m, 'אני רשומה היום לפילאטיס ורוצה לעבור לשעה אחרת');
    let t = tasksOf(m, 'class_change')[0];
    expect(t.missing).toBe('target_time');
    expect(lastTo(m)).toMatch(/יש לך רישום לפילאטיס מכשירים ב-18:00 היום\. לאיזו שעה לעבור\?$/);
    expect(lastTo(m)).not.toMatch(/הרשאה|לצוות/);
    await say(m, 'ב-17:00');
    const all = tasksOf(m, 'class_change');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: t.id, missing: null });
    expect(all[0].summary).toMatch(/מעבר מ-18:00 ל-17:00/);
    // owner rule 2026-11-18: no alert while the member is still being asked for a detail — ONE alert when the request is ready
    expect(alerts().map(a => a.subject)).toEqual([expect.stringMatching(/📌 תומר: מעבר/)]);
    expect(lastTo(m)).toMatch(/קיבלתי את הבקשה: מעבר מ-18:00 ל-17:00 היום/);
  });

  test('when Arbox cannot be read nothing is claimed as checked, and the request still reaches the staff', async () => {
    const m = newMember();
    mockGw.fail = true;
    await say(m, ASK);
    expect(lastTo(m)).toMatch(/לא הצלחתי לבדוק כרגע את הרישום שלך ב-Arbox/);
    expect(lastTo(m)).not.toMatch(/בדקתי ב-Arbox/);
    expect(tasksOf(m, 'class_change')[0].detail).toMatch(/Arbox לא זמין/);
    expect(alerts()).toHaveLength(1);
  });

  test('a reply to the member that the provider did not accept is recorded on the task as failed', async () => {
    const m = newMember();
    mockOut.failTextTo = m;
    await say(m, ASK);
    expect(tasksOf(m, 'class_change')[0].memberReply.state).toBe('failed');
    expect(alerts()).toHaveLength(1);                                         // the staff still know
  });

  test('an ordinary member question is not turned into a task', async () => {
    const m = newMember();
    mockAi.queue.push('אפשר להגיע עם גרביים רגילות 🙂');
    const r = await say(m, 'צריך להביא גרביים מיוחדות לשיעור?');
    expect(r.route).toBe('tomer');
    expect(tasksOf(m, 'class_change')).toHaveLength(0);
    expect(alerts()).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('2. Barak — the price question, the next step, and a callback given as a range of hours', () => {
  test('a robotic closer is removed and one concrete next step is offered; "כן בבקשה" is answered, not swallowed', async () => {
    const lead = await newLead();
    clearOut();
    mockAi.queue.push('הצעת ההיכרות שלנו היא 2 אימונים ב-60 ₪, ללא התחייבות. אם יש לך שאלות נוספות או תרצה/י לדעת על חבילות חודשיות, אני כאן לעזור!');
    await say(lead, 'כמה עולה שיעור ניסיון');
    expect(lastTo(lead)).toBe('הצעת ההיכרות שלנו היא 2 אימונים ב-60 ₪, ללא התחייבות.\nרוצה שנציג יחזור אליך ויעזור לבחור את האימון המתאים?');
    const r = await say(lead, 'כן בבקשה');
    expect(r.route).toBe('callback_time_requested');
    expect(lastTo(lead)).toMatch(/מתי נוח לך שנחזור אליך\? \(יום ושעה\)/);
    expect(lastTo(lead)).not.toMatch(/נציג יחזור אליך ויעזור/);              // the offer is not repeated after she agreed
  });

  test('a MEMBERSHIP price question is never answered with the trial offer: no approved membership price → says so and offers a representative', async () => {
    const lead = await newLead();
    clearOut();
    mockAi.queue.push('הצעת ההיכרות שלנו היא 2 אימונים ב-60 ₪, ללא התחייבות. אם יש לך שאלות נוספות אני כאן!');   // the production miss
    await say(lead, 'כמה עולה מנוי לפילאטיס מכשירים?');
    expect(lastTo(lead)).toBe('אין לי כאן מחיר מעודכן למנוי, ואני לא רוצה לתת לך מספר לא מדויק 🙏\nרוצה שנציג יחזור אליך עם המחירים המדויקים?');
    const r = await say(lead, 'כן');
    expect(r.route).toBe('callback_time_requested');                         // the offer leads into the callback flow
  });

  test('a price the model made up is never sent; with approved membership prices the answer is built from them', async () => {
    const lead = await newLead();
    clearOut();
    mockAi.queue.push('המנוי החודשי עולה 450 ₪ לחודש 🙂');                   // not in any approved source
    await say(lead, 'מה המחיר של מנוי חודשי?');
    expect(lastTo(lead)).not.toMatch(/450/);
    expect(lastTo(lead)).toMatch(/אין לי כאן מחיר מעודכן למנוי/);
    const lead2 = await newLead();
    clearOut();
    const pkgFile = path.join(DATA_DIR, 'subscription_packages.json');
    fs.writeFileSync(pkgFile, JSON.stringify({ trial: { entries: 2, price_ils: 60, commitment: false }, packages: [{ name: '8 כניסות לחודש', price_ils: 390 }, { name: 'ללא הגבלה', price_ils: null }] }));
    try {
      mockAi.queue.push('הצעת ההיכרות שלנו היא 2 אימונים ב-60 ₪.');
      await say(lead2, 'כמה עולה מנוי?');
      expect(lastTo(lead2)).toMatch(/8 כניסות לחודש — 390 ₪ לחודש/);          // the owner's saved price
      expect(lastTo(lead2)).not.toMatch(/ללא הגבלה/);                         // a package without a price is not quoted
      expect(lastTo(lead2)).not.toMatch(/היכרות/);
    } finally { fs.unlinkSync(pkgFile); }
  });

  test('the range is stored with an explicit Israel date, confirmed to the lead as a range, and the manager gets ONE summary', async () => {
    const lead = await newLead();
    await say(lead, 'אשמח שיחזרו אליי');
    clearOut();
    await say(lead, 'מחר אני פנויה בין 14:00-16:00');
    const apt = openApt(lead);
    expect(apt.scheduledAt.toISOString()).toBe(il(2026, 11, 17, 14).toISOString());
    expect(apt.windowEndAt).toBe(il(2026, 11, 17, 16).toISOString());
    expect(lastTo(lead)).toMatch(/רשמתי בקשת שיחה: יום שלישי, 17\.11\.2026 בין 14:00 ל-16:00/);
    expect(alerts()).toHaveLength(0);                                         // the summary waits for the name
    await say(lead, 'יעל');
    expect(lastTo(lead)).toMatch(/יעל, קיבלנו את בקשת השיחה שלך ✅\n📞 יום שלישי, 17\.11\.2026 בין 14:00 ל-16:00\nנציג מהצוות של Shape Studio יצור איתך קשר בטווח השעות הזה\./);
    expect(lastTo(lead)).not.toMatch(/בשעה 14:00/);                           // a range is never presented as an appointed hour
    const sums = alerts().filter(a => /בקשת שיחה חדשה/.test(a.body));
    expect(sums).toHaveLength(1);
    expect(sums[0].body).toMatch(/📅 יום שלישי, 17\.11\.2026 בין 14:00 ל-16:00/);
    expect(sums[0].body).toMatch(/הליד מסר\/ה טווח שעות, לא שעה מדויקת/);
    expect(sums[0].body).toMatch(new RegExp('0' + lead.slice(3)));
    expect(sums[0].aptFileAtSend).toContain(apt.id);                          // persisted BEFORE anyone was told
  });

  test('a new time updates the SAME request: one record, the old reminders cannot fire, one "time changed" summary', async () => {
    const lead = await newLead();
    await say(lead, 'אשמח שיחזרו אליי'); await say(lead, 'מחר אני פנויה בין 14:00-16:00'); await say(lead, 'יעל');
    const first = openApt(lead);
    aptStore.update(first.id, { prospectReminderSent: true });               // as if the reminder for the old time had gone out
    clearOut();
    await say(lead, 'לא נוח לי, אפשר מועד אחר?');
    await say(lead, 'מחר בין 10:00 ל-12:00');
    const apt = openApt(lead);
    expect(apt.id).toBe(first.id);
    expect(aptsOf(lead)).toHaveLength(1);
    expect(apt.scheduledAt.toISOString()).toBe(il(2026, 11, 17, 10).toISOString());
    expect(apt.windowEndAt).toBe(il(2026, 11, 17, 12).toISOString());
    expect(apt.prospectReminderSent).toBeFalsy();
    const changed = alerts().filter(a => /שינוי מועד שיחה/.test(a.body));
    expect(changed).toHaveLength(1);
    expect(changed[0].body).toMatch(/בין 10:00 ל-12:00/);
    await say(lead, 'מחר בין 10:00 ל-12:00');                                // said again: nothing new
    expect(alerts().filter(a => /שינוי מועד שיחה|בקשת שיחה חדשה/.test(a.body))).toHaveLength(1);
  });

  test('a manager summary that failed is shown as failed and retried in a controlled way, once, without duplicates', async () => {
    const lead = await newLead();
    await say(lead, 'אשמח שיחזרו אליי'); await say(lead, 'מחר ב-11:00');
    mockOut.failManager = true;
    await say(lead, 'יעל');
    expect(store.getLead(lead).meta).toMatchObject({ closingSummaryManagerState: 'failed', handoffAlertStatus: 'failed' });
    expect(alerts()).toHaveLength(0);
    mockOut.failManager = false;
    expect((await app.locals.retryFailedCallbackSummaries()).retried).toBeGreaterThanOrEqual(1);
    expect(alerts().filter(a => /בקשת שיחה חדשה/.test(a.body) && a.body.includes('0' + lead.slice(3)))).toHaveLength(1);
    expect(store.getLead(lead).meta.closingSummaryManagerState).toBe('accepted');
    await app.locals.retryFailedCallbackSummaries();
    expect(alerts().filter(a => a.body.includes('0' + lead.slice(3)))).toHaveLength(1);
    expect(textsTo(lead).filter(t => /קיבלנו את בקשת השיחה/.test(t.text))).toHaveLength(1);                // the lead's confirmation was not sent twice
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('3. A callback arranged BY HAND while a human owns the conversation (what actually happened on 16.11)', () => {
  async function handArranged() {
    const lead = await newLead();
    await staffTypes(lead, 'תרצי שנתאם שיחה עם נציג?');
    expect(store.getLead(lead).status).toBe('human_owns');
    clearOut();
    await say(lead, 'כן בבקשה', { name: 'Yael' });
    await staffTypes(lead, 'מתי יהיה לך נוח שניצור קשר');
    return lead;
  }

  test('the lead\'s answer is recorded as a callback request and the manager is told; NOTHING automatic is sent to the lead', async () => {
    const lead = await handArranged();
    const r = await say(lead, 'מחר אני פנויה בין 14:00-16:00', { name: 'Yael' });
    expect(r.route).toBe('human_owns_callback_captured');
    const apt = openApt(lead);
    expect(apt).toMatchObject({ status: 'callback_pending', capturedDuring: 'human_hold', nameProvisional: true, windowEndAt: il(2026, 11, 17, 16).toISOString() });
    expect(apt.scheduledAt.toISOString()).toBe(il(2026, 11, 17, 14).toISOString());
    expect(textsTo(lead)).toHaveLength(0);                                    // the human owns the conversation
    expect(store.getLead(lead).status).toBe('human_owns');
    const sums = alerts().filter(a => /בקשת שיחה חדשה/.test(a.body));
    expect(sums).toHaveLength(1);
    expect(sums[0].body).toMatch(/📅 יום שלישי, 17\.11\.2026 בין 14:00 ל-16:00/);
    expect(sums[0].body).toMatch(/השיחה בטיפול ידני: לא נשלח אישור אוטומטי לליד/);
    expect(sums[0].body).toMatch(/השם מפרופיל הוואטסאפ, לא אומת/);
    expect(sums[0].aptFileAtSend).toContain(apt.id);
    await say(lead, 'תודה רבה');                                              // as in the real conversation
    expect(textsTo(lead)).toHaveLength(0);
  });

  test('the same answer twice is one request and one alert; a changed time moves the same request', async () => {
    const lead = await handArranged();
    await say(lead, 'מחר אני פנויה בין 14:00-16:00');
    await say(lead, 'מחר אני פנויה בין 14:00-16:00');
    expect(aptsOf(lead)).toHaveLength(1);
    expect(alerts().filter(a => /בקשת שיחה/.test(a.subject))).toHaveLength(1);
    const id = openApt(lead).id;
    const r = await say(lead, 'בעצם עדיף מחר בין 10:00 ל-12:00');
    expect(r.route).toBe('human_owns_callback_rescheduled');
    expect(openApt(lead)).toMatchObject({ id, windowEndAt: il(2026, 11, 17, 12).toISOString() });
    expect(aptsOf(lead)).toHaveLength(1);
    expect(alerts().filter(a => /שינוי מועד/.test(a.subject))).toHaveLength(1);
    expect(textsTo(lead)).toHaveLength(0);
  });

  test('a manager alert that fails here is recorded as failed and retried once it can be sent', async () => {
    const lead = await handArranged();
    mockOut.failManager = true;
    await say(lead, 'מחר אני פנויה בין 14:00-16:00');
    expect(openApt(lead)).toBeTruthy();                                       // the request is on disk regardless
    expect(store.getLead(lead).meta.closingSummaryManagerState).toBe('failed');
    mockOut.failManager = false;
    await app.locals.retryFailedCallbackSummaries();
    expect(alerts().filter(a => /בקשת שיחה חדשה/.test(a.body))).toHaveLength(1);
    expect(textsTo(lead)).toHaveLength(0);
  });

  test('a time that cannot be resolved is not guessed: no request is stored and the manager is told to arrange it by hand', async () => {
    const lead = await handArranged();
    const r = await say(lead, 'מחר בבוקר');
    if (r.route === 'human_owns_callback_unresolved') {
      expect(openApt(lead)).toBeFalsy();
      expect(alerts().filter(a => /מועד לשיחה שלא נרשם/.test(a.subject))).toHaveLength(1);
    } else expect(r.route).toBe('human_owns_hold');
    expect(textsTo(lead)).toHaveLength(0);
  });

  test('a day and hour in a human-owned chat that is NOT an answer about a call is left alone', async () => {
    const lead = await newLead();
    await staffTypes(lead, 'היי, מה שלומך?');
    clearOut();
    const r = await say(lead, 'יש שיעור מחר ב-10:00?');
    expect(r.route).toBe('human_owns_hold');
    expect(openApt(lead)).toBeFalsy();
    expect(alerts()).toHaveLength(0);
    expect(textsTo(lead)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('3b. The owner approves a summary and a reminder to the lead from the panel', () => {
  const post = (url, body = {}) => request(app).post(url).send(body).set('Content-Type', 'application/json');
  async function captured() {
    const lead = await newLead();
    await staffTypes(lead, 'מתי יהיה לך נוח שניצור קשר?');
    await say(lead, 'מחר אני פנויה בין 14:00-16:00', { name: 'Yael' });
    clearOut();
    return { lead, apt: openApt(lead) };
  }
  const row = async lead => (await request(app).get('/api/barak/callbacks')).body.callbacks.find(c => c.fullPhone === lead);

  test('ONE summary goes to the lead with the range she gave - not an hour; the chat stays human-owned and Barak stays silent', async () => {
    const { lead, apt } = await captured();
    expect((await post(`/api/admin/appointments/${apt.id}/owner-summary`, { name: 'יעל' })).status).toBe(400);            // who approved is required
    expect(await row(lead)).toMatchObject({ humanOwned: true, apt: { capturedDuring: 'human_hold', isWindow: true, prospectSummarySent: false, ownerApproved: null } });
    const r = await post(`/api/admin/appointments/${apt.id}/owner-summary`, { by: 'עדן', name: 'יעל', reminder: true });
    expect(r.body).toMatchObject({ ok: true, state: 'accepted', reminder: true });
    expect(textsTo(lead)).toHaveLength(1);
    expect(lastTo(lead)).toBe('יעל, רשמנו את בקשת השיחה שלך ✅\n📞 יום שלישי, 17.11.2026 בין 14:00 ל-16:00\nנציג מהצוות של Shape Studio יצור איתך קשר בטווח השעות הזה.');
    expect(lastTo(lead)).not.toMatch(/בשעה/);                                // no hour was made up from the range
    expect(store.getLead(lead).status).toBe('human_owns');
    expect(await row(lead)).toMatchObject({ humanOwned: true, apt: { prospectSummarySent: true, ownerApproved: { by: 'עדן', reminder: true } } });
    await say(lead, 'תודה רבה');
    expect(textsTo(lead)).toHaveLength(1);                                    // nothing automatic answers her
    // pressed again: nothing is sent twice
    expect((await post(`/api/admin/appointments/${apt.id}/owner-summary`, { by: 'עדן', name: 'יעל', reminder: true })).body).toMatchObject({ ok: true, alreadySent: true });
    expect(textsTo(lead)).toHaveLength(1);
  });

  test('the approved reminder is timed from the start of the range and worded as a range; without an approval none is sent', async () => {
    const a = await captured(), b = await captured();
    await post(`/api/admin/appointments/${a.apt.id}/owner-summary`, { by: 'עדן', name: 'יעל', reminder: true });
    clearOut();
    setNow(il(2026, 11, 17, 13, 40));                                        // 20 minutes before the range starts
    await worker.runCycle(store);
    const rem = textsTo(a.lead).filter(t => /תזכורת לבקשת השיחה/.test(t.text));
    expect(rem).toHaveLength(1);
    expect(rem[0].text).toMatch(/יום שלישי, 17\.11\.2026 בין 14:00 ל-16:00 📞\nעדיין נוח לך בטווח השעות הזה\?/);
    expect(textsTo(b.lead)).toHaveLength(0);                                  // human-owned and not approved: silence, as before
    await worker.runCycle(store);
    expect(textsTo(a.lead).filter(t => /תזכורת/.test(t.text))).toHaveLength(1);        // once
    expect(store.getLead(a.lead).status).toBe('human_owns');
  });

  test('a summary without the reminder sends no reminder; a new time needs a new approval', async () => {
    const { lead, apt } = await captured();
    await post(`/api/admin/appointments/${apt.id}/owner-summary`, { by: 'עדן', reminder: false });
    expect(lastTo(lead)).toMatch(/^רשמנו את בקשת השיחה שלך ✅/);              // no name was confirmed, so none is used
    await staffTypes(lead, 'אפשר גם מועד אחר לשיחה אם נוח לך');
    await say(lead, 'בעצם עדיף מחר בין 10:00 ל-12:00');
    expect(openApt(lead).id).toBe(apt.id);
    expect((await row(lead)).apt).toMatchObject({ ownerApproved: null, prospectSummarySent: false });         // the approval was for the old time
    clearOut();
    setNow(il(2026, 11, 17, 9, 40));
    await worker.runCycle(store);
    expect(textsTo(lead)).toHaveLength(0);
  });

  test('a send the provider did not accept is reported as failed, shown in the panel, and can be sent again - once', async () => {
    const { lead, apt } = await captured();
    mockOut.failTextTo = lead;
    const r = await post(`/api/admin/appointments/${apt.id}/owner-summary`, { by: 'עדן', name: 'יעל', reminder: true });
    expect([r.status, r.body.ok, r.body.state]).toEqual([502, false, 'failed']);
    expect((await row(lead)).apt).toMatchObject({ prospectSummarySent: false, ownerSummary: { state: 'failed' } });
    mockOut.failTextTo = null;
    expect((await post(`/api/admin/appointments/${apt.id}/owner-summary`, { by: 'עדן', name: 'יעל', reminder: true })).body.state).toBe('accepted');
    expect(textsTo(lead)).toHaveLength(1);
  });

  test('refused for a closed or expired request and for a lead who opted out', async () => {
    const { lead, apt } = await captured();
    setNow(il(2026, 11, 17, 16, 30));
    expect((await post(`/api/admin/appointments/${apt.id}/owner-summary`, { by: 'עדן' })).body.error).toBe('callback_expired');
    expect((await post(`/api/admin/appointments/nope/owner-summary`, { by: 'עדן' })).body.error).toBe('not_open');
    expect(textsTo(lead)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('4. A voice message from a member', () => {
  test('no promise without a task: a documented task is opened, the manager is alerted, and the member is told the truth', async () => {
    const m = newMember();
    const r = await say(m, '[הודעה קולית]', { type: 'audio', name: 'כרמית' });
    expect(r.route).toBe('tomer_handoff');
    const t = tasksOf(m, 'voice_message');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'open', transcription: { state: 'not_transcribed', reason: 'off' }, alert: { state: 'sent' }, memberReply: { state: 'sent' } });
    expect(t[0].detail).toMatch(/לא תומללה/);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/תומר: הודעה קולית — כרמית/);
    expect(lastTo(m)).toMatch(/קיבלתי את ההודעה הקולית 🙏 אני לא מאזין להקלטות, אז רשמתי פנייה והעברתי אותה לצוות\.\nאם נוח לך, אפשר לכתוב לי כאן בקצרה במה מדובר/);
    expect(lastTo(m)).not.toMatch(/הצוות שלנו יחזור אליך בהקדם/);
  });

  test('a second voice message joins the open task: no second alert and no second automatic reply', async () => {
    const m = newMember();
    await say(m, '[הודעה קולית]', { type: 'audio' });
    await say(m, '[הודעה קולית]', { type: 'audio' });
    expect(tasksOf(m, 'voice_message')).toHaveLength(1);
    expect(tasksOf(m, 'voice_message')[0].received).toBe(2);
    expect(alerts()).toHaveLength(1);
    expect(textsTo(m)).toHaveLength(1);
  });

  test('when the alert fails the member is not told the staff were informed, and the task shows the failure', async () => {
    const m = newMember();
    mockOut.failManager = true;
    await say(m, '[הודעה קולית]', { type: 'audio' });
    expect(tasksOf(m, 'voice_message')[0].alert.state).toBe('failed');
    expect(lastTo(m)).toMatch(/רשמתי פנייה לטיפול הצוות/);
    expect(lastTo(m)).not.toMatch(/והעברתי אותה לצוות/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('4b. Voice messages with local transcription on the editing PC', () => {
  const TOKEN = 'test-worker-token-0123456789abcdef';
  const AUDIO = Buffer.from('OggS\u0000 fake opus bytes of a member recording');
  const URL_SECRET = 'https://media.provider.example/file/SECRET-PATH-123.oga';
  const VOICE_DIR = path.join(DATA_DIR, 'voice');
  const W = { Authorization: `Bearer ${TOKEN}` };
  let dl;
  const intake = () => app.locals.voiceIntake;
  const hook = () => { dl = jest.fn(async () => AUDIO); intake()._setDownload(dl); };
  const audioFiles = () => { try { return fs.readdirSync(VOICE_DIR).filter(f => !f.startsWith('jobs.json')); } catch { return []; } };
  const jobs = () => { try { return Object.values(JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'jobs.json'), 'utf8')).jobs); } catch { return []; } };
  const poll = () => request(app).post('/api/voice/worker/lease').set(W).send({ workerId: 'w1' });
  const workerOnline = async () => { expect((await poll()).status).toBe(204); };
  async function voice(phone, { name = 'כרמית', mimeType = 'audio/ogg; codecs=opus', id } = {}) {
    const res = await request(app).post('/api/whatsapp/simulate').set('Content-Type', 'application/json')
      .send({ from: phone, text: '[הודעה קולית]', name, type: 'audio', messageId: id ?? `v-${++msgSeq}`, timestamp: new Date().toISOString(), mediaUrl: URL_SECRET, mimeType });
    expect(res.status).toBe(200);
    return res.body;
  }
  async function leaseOne() { const l = await poll(); expect(l.status).toBe(200); return l.body; }
  const result = (l, body) => request(app).post(`/api/voice/worker/jobs/${l.job.id}/result`).set(W).set('X-Lease-Token', l.leaseToken).send(body);
  const transcribed = (l, text) => result(l, { status: 'transcribed', text, language: 'he', duration_s: 12.4, model: 'large-v3' });
  const minutes = n => setNow(new Date(Date.now() + n * 60000));
  let saved;
  beforeAll(() => { saved = { v: process.env.VOICE_TRANSCRIPTION_ENABLED, t: process.env.DANA_WORKER_TOKEN, w: process.env.VOICE_WAIT_MS };
    process.env.VOICE_TRANSCRIPTION_ENABLED = 'true'; process.env.DANA_WORKER_TOKEN = TOKEN; delete process.env.VOICE_WAIT_MS; });
  afterAll(() => { for (const [k, v] of [['VOICE_TRANSCRIPTION_ENABLED', saved.v], ['DANA_WORKER_TOKEN', saved.t], ['VOICE_WAIT_MS', saved.w]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  beforeEach(() => { fs.rmSync(VOICE_DIR, { recursive: true, force: true }); intake()._reset(); hook(); });

  test('worker reachable: the task is opened first and says "waiting"; nobody is messaged; the transcript arrives and the request is handled like a written one', async () => {
    const m = newMember();
    await workerOnline();
    const r = await voice(m);
    expect(r.route).toBe('tomer_handoff');
    let t = tasksOf(m, 'voice_message');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'open', transcription: { state: 'waiting' } });
    expect(textsTo(m)).toHaveLength(0);
    expect(alerts()).toHaveLength(0);
    expect(dl).toHaveBeenCalledTimes(1);
    expect(audioFiles()).toHaveLength(1);                                   // the server copy, until the transcript is stored

    const l = await leaseOne();
    expect(l.job).toMatchObject({ ext: 'ogg', bytes: AUDIO.length, sha256: require('crypto').createHash('sha256').update(AUDIO).digest('hex') });
    expect(JSON.stringify(l)).not.toMatch(new RegExp(m));                   // the worker is given no phone number
    const a = await request(app).get(`/api/voice/worker/jobs/${l.job.id}/audio`).set(W).set('X-Lease-Token', l.leaseToken).responseType('blob');
    expect(a.status).toBe(200);
    expect(Buffer.compare(a.body, AUDIO)).toBe(0);
    expect((await transcribed(l, 'היי אני רשומה היום ב-18:00 ורוצה לעבור ל-17:00 תודה')).body).toMatchObject({ ok: true, state: 'transcribed' });

    expect(audioFiles()).toHaveLength(0);                                   // deleted as soon as the transcript was stored
    expect(jobs()[0]).toMatchObject({ state: 'transcribed', audioDeletedWhy: 'transcribed' });
    expect(JSON.stringify(jobs())).not.toMatch(/רשומה/);                    // the text does not stay on the job
    t = tasksOf(m, 'voice_message');
    expect(t[0]).toMatchObject({ status: 'resolved', transcription: { state: 'done', unverified: true, text: expect.stringMatching(/לעבור ל-17:00/) } });
    const c = tasksOf(m, 'class_change');
    expect(c).toHaveLength(1);
    expect(t[0].linkedTaskId).toBe(c[0].id);
    expect(c[0].summary).toMatch(/מעבר מ-18:00 ל-17:00/);
    expect(alerts()).toHaveLength(1);                                       // one alert, for the class request
    expect(textsTo(m)).toHaveLength(1);
    expect(lastTo(m)).toMatch(/קיבלתי את הבקשה: מעבר מ-18:00 ל-17:00 היום/);
    expect(mockGw.writes ?? 0).toBe(0);                                     // a transcript never writes to Arbox
  });

  test('a transcript that is not a class request: the staff get it, marked unverified; the member is told who has it', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    await transcribed(await leaseOne(), 'רציתי לשאול אם אפשר לקבל חשבונית על החודש שעבר');
    const t = tasksOf(m, 'voice_message')[0];
    expect(t).toMatchObject({ status: 'open', alert: { state: 'sent' }, memberReply: { state: 'sent' } });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].body).toMatch(/תמלול אוטומטי \(לא אומת\): "רציתי לשאול אם אפשר לקבל חשבונית/);
    expect(lastTo(m)).toBe('קיבלתי את ההודעה הקולית 🙏 העברתי אותה לצוות, ויענו לך כאן.');
  });

  test('a member\'s spoken question that Tomer can answer is answered by the regular flow: no alert, the voice task is closed, no second task', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    mockAi.queue.push('תשובת מודל שאינה ממקור מאושר ואסור שתישלח');
    await transcribed(await leaseOne(), 'היי רציתי לשאול מתי יש שיעורים היום');
    expect(textsTo(m)).toHaveLength(1);
    // the answer is to what was asked (today's classes), and its fact is what the timetable read from Arbox holds for
    // that day - in this harness the Arbox timetable is empty, so the true answer is that there are none - not a model's text
    expect(lastTo(m)).toMatch(/^אין שיעורים בשני 16\.11\./);
    expect(lastTo(m)).not.toMatch(/תשובת מודל/);
    expect(alerts()).toHaveLength(0);                                       // nothing needed a person
    const t = tasksOf(m, 'voice_message');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'resolved', routedTo: 'tomer', transcription: { state: 'done', doubtful: false } });
    expect(tomerStore.getTasks({ phone: m }).filter(x => x.status !== 'resolved')).toHaveLength(0);
  });

  test('a doubtful transcription is not answered from: the staff get it with the reason', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    mockAi.queue.push('תשובה שאסור שתישלח');
    await result(await leaseOne(), { status: 'transcribed', text: 'מתי יש שיעורים מחר או ש', language: 'he', duration_s: 3, model: 'large-v3', avg_logprob: -1.4 });
    expect(lastTo(m)).toBe('קיבלתי את ההודעה הקולית 🙏 העברתי אותה לצוות, ויענו לך כאן.');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].body).toMatch(/התמלול אינו ודאי מספיק כדי לענות לפיו/);
    expect(tasksOf(m, 'voice_message')[0]).toMatchObject({ status: 'open', transcription: { doubtful: true } });
    mockAi.queue.length = 0;
  });

  test('a LEAD\'s voice message: same queue and deletion; the transcript enters Barak\'s conversation and Barak answers - one reply, no alert, no open task', async () => {
    const lead = await newLead(); clearOut();
    await workerOnline();
    const r = await voice(lead, { name: 'מיכל' });
    expect(r.route).toBe('barak_voice');
    expect(textsTo(lead)).toHaveLength(0);
    expect(audioFiles()).toHaveLength(1);
    expect(tasksOf(lead, 'voice_message')[0]).toMatchObject({ status: 'open', agent: 'barak', transcription: { state: 'waiting' } });
    // the model answers a MEMBERSHIP question with the trial offer - exactly the miss seen in production. It must not be sent.
    mockAi.queue.push('הצעת ההיכרות שלנו היא 2 אימונים ב-60 ₪, ללא התחייבות.');
    await transcribed(await leaseOne(), 'היי כמה עולה מנוי לפילאטיס מכשירים');
    expect(audioFiles()).toHaveLength(0);
    expect(textsTo(lead)).toHaveLength(1);
    // the answer is about what was asked: no membership price is approved, so it says so and offers a representative
    expect(lastTo(lead)).toBe('אין לי כאן מחיר מעודכן למנוי, ואני לא רוצה לתת לך מספר לא מדויק 🙏\nרוצה שנציג יחזור אליך עם המחירים המדויקים?');
    expect(lastTo(lead)).not.toMatch(/60|היכרות|ניסיון/);
    expect(alerts()).toHaveLength(0);
    const t = tasksOf(lead, 'voice_message');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: 'resolved', routedTo: 'barak' });
    expect(store.getLead(lead).history.some(h => /כמה עולה מנוי/.test(h.content ?? ''))).toBe(true);   // it is part of the lead's conversation
  });

  test('a lead\'s voice message while the worker is offline: a task, an alert marked as Barak\'s, and an invitation to write', async () => {
    const lead = await newLead(); clearOut();
    await voice(lead, { name: 'מיכל' });
    expect(dl).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/ברק: הודעה קולית — מיכל/);
    expect(tasksOf(lead, 'voice_message')[0].summary).toMatch(/מליד/);
    expect(lastTo(lead)).toMatch(/לא הצלחתי להאזין לה כרגע/);
  });

  test('worker offline: nothing is downloaded; the task, the alert and the invitation to write happen at once', async () => {
    const m = newMember();
    await voice(m);                                                         // nobody polled
    expect(dl).not.toHaveBeenCalled();
    expect(audioFiles()).toHaveLength(0);
    const t = tasksOf(m, 'voice_message')[0];
    expect(t).toMatchObject({ status: 'open', transcription: { state: 'not_transcribed', reason: 'worker_offline' }, alert: { state: 'sent' }, memberReply: { state: 'sent' } });
    expect(t.detail).toMatch(/מחשב התמלול אינו מחובר כרגע/);
    expect(lastTo(m)).toMatch(/לא הצלחתי להאזין לה כרגע, אז רשמתי פנייה והעברתי אותה לצוות\.\nאם נוח לך, אפשר לכתוב לי כאן/);
  });

  test('worker busy editing for Dana: the recording is queued AND the staff are alerted at once; the late transcript is added, with no second message to the member', async () => {
    const m = newMember();
    const hb = await request(app).post('/api/dana/worker/heartbeat').set(W).send({ workerId: 'w1', state: 'busy', pipelineVersion: '1.5.0' });
    expect(hb.status).toBe(200);
    expect(intake().availability().state).toBe('busy');
    await voice(m);
    expect(audioFiles()).toHaveLength(1);
    let t = tasksOf(m, 'voice_message')[0];
    expect(t).toMatchObject({ transcription: { state: 'waiting_after_handoff', reason: 'worker_busy' }, alert: { state: 'sent' } });
    expect(t.detail).toMatch(/עסוק כרגע בעריכת סרטון/);
    expect(alerts()).toHaveLength(1);
    expect(textsTo(m)).toHaveLength(1);
    minutes(7);                                                             // the edit ended; the worker polls again
    await transcribed(await leaseOne(), 'אני רוצה להקפיא את המנוי לשבועיים');
    t = tasksOf(m, 'voice_message')[0];
    expect(t).toMatchObject({ status: 'open', transcription: { state: 'done' }, alertUpdate: { state: 'sent' } });
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1].subject).toMatch(/התמלול הגיע/);
    expect(textsTo(m)).toHaveLength(1);                                     // she was already asked to write; nothing more
    expect(audioFiles()).toHaveLength(0);
    await intake().tick();
    expect(alerts()).toHaveLength(2);
  });

  test('the transcript does not arrive in time: one hand-over to the staff, once', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    minutes(1); await intake().tick();
    expect(alerts()).toHaveLength(0);                                       // still inside the wait
    minutes(1.5); await intake().tick(); await intake().tick();
    expect(alerts()).toHaveLength(1);
    expect(textsTo(m)).toHaveLength(1);
    expect(tasksOf(m, 'voice_message')[0]).toMatchObject({ transcription: { state: 'waiting_after_handoff', reason: 'waited_too_long' } });
    expect(tasksOf(m, 'voice_message')[0].detail).toMatch(/התמלול לא הגיע בזמן/);
  });

  test('the worker fails: one more try, then the staff; a recording with no speech is not retried', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    expect((await result(await leaseOne(), { status: 'failed', error: { code: 'voice_asr_failed', message: 'x' } })).body.state).toBe('failed');
    expect(alerts()).toHaveLength(0);
    await result(await leaseOne(), { status: 'failed', error: { code: 'voice_timeout', message: 'x' } });
    expect(alerts()).toHaveLength(1);
    expect(audioFiles()).toHaveLength(0);
    expect(tasksOf(m, 'voice_message')[0]).toMatchObject({ transcription: { state: 'not_transcribed', reason: 'transcription_failed' } });
    expect((await poll()).status).toBe(204);

    const m2 = newMember(); clearOut();
    await voice(m2);
    await result(await leaseOne(), { status: 'failed', error: { code: 'voice_no_speech', message: 'x' } });
    expect(tasksOf(m2, 'voice_message')[0].detail).toMatch(/בהקלטה לא זוהה דיבור/);
    expect(alerts()).toHaveLength(1);
    expect((await poll()).status).toBe(204);
  });

  test('a worker that takes a recording and disappears: the lease returns, then the staff; the audio is gone', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    const l1 = await leaseOne();
    minutes(5); await intake().tick();                                      // lease expired, and the wait is over
    expect(alerts()).toHaveLength(1);
    expect((await transcribed(l1, 'מאוחר מדי')).status).toBe(409);          // the old lease is worth nothing
    const l2 = await leaseOne();
    expect(l2.job.id).toBe(l1.job.id);
    minutes(5); await intake().tick();
    expect(jobs()[0]).toMatchObject({ state: 'failed' });
    expect(audioFiles()).toHaveLength(0);
    expect(alerts()).toHaveLength(1);                                       // still one hand-over
  });

  test('24 hours: the server copy is deleted whatever happened, and so is every leftover file - also after a restart', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    await leaseOne();                                                       // taken, never answered
    fs.writeFileSync(path.join(VOICE_DIR, 'vX_interrupted.ogg.part'), 'half a download');
    fs.writeFileSync(path.join(VOICE_DIR, 'stray.ogg'), 'belongs to no job');
    restart(); hook();                                                      // the server crashed and came back
    await intake().recover();
    expect(audioFiles()).toHaveLength(1);                                   // only the job's own audio survived the sweep
    expect(jobs()[0].state).toBe('queued');                                 // the lease was returned
    setNow(new Date(Date.now() + 24 * 3600 * 1000 + 60000));
    restart(); hook();
    await intake().recover();
    expect(audioFiles()).toHaveLength(0);
    expect(jobs()[0]).toMatchObject({ state: 'expired', audioDeletedWhy: 'older_than_24h' });
    expect((await poll()).status).toBe(204);
    expect(tasksOf(m, 'voice_message')[0].alert.state).toBe('sent');        // handed to the staff, not lost
  });

  test('a chat a human owns: the transcript goes to the staff and nothing is sent to the member', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    await staffTypes(m, 'היי, אני בודקת ואחזור אלייך');
    clearOut();
    await transcribed(await leaseOne(), 'אני רשומה היום ב-18:00 ורוצה לעבור ל-17:00');
    expect(textsTo(m)).toHaveLength(0);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].body).toMatch(/השיחה בטיפול ידני: לא נשלחה תשובה אוטומטית/);
    expect(tasksOf(m, 'class_change')).toHaveLength(0);
  });

  test('the same WhatsApp message delivered twice is one recording and one task', async () => {
    const m = newMember();
    await workerOnline();
    await voice(m, { id: 'dup-1' });
    // the pipeline itself drops a repeated message id; the queue would not take it either
    await request(app).post('/api/whatsapp/simulate').set('Content-Type', 'application/json').send({ from: m, text: '[הודעה קולית]', type: 'audio', messageId: 'dup-1', mediaUrl: URL_SECRET, mimeType: 'audio/ogg' });
    expect(await intake().receive({ phone: m, messageId: 'dup-1', mediaUrl: URL_SECRET, mimeType: 'audio/ogg' })).toMatchObject({ duplicate: true });
    expect(dl).toHaveBeenCalledTimes(1);
    expect(jobs()).toHaveLength(1);
    expect(tasksOf(m, 'voice_message')).toHaveLength(1);
  });

  test('access: only the worker token, only a live lease; nothing about a recording is logged', async () => {
    const m = newMember();
    await workerOnline(); await voice(m);
    expect((await request(app).post('/api/voice/worker/lease').send({})).status).toBe(401);
    expect((await request(app).post('/api/voice/worker/lease').set({ Authorization: 'Bearer wrong-token-wrong-token-wrong' }).send({})).status).toBe(401);
    const l = await leaseOne();
    expect((await request(app).get(`/api/voice/worker/jobs/${l.job.id}/audio`).set(W).set('X-Lease-Token', 'x'.repeat(48))).status).toBe(404);
    expect((await request(app).get(`/api/voice/worker/jobs/${l.job.id}/audio`)).status).toBe(401);
    expect((await request(app).get('/api/voice/worker/jobs/..%2Fjobs.json/audio').set(W).set('X-Lease-Token', l.leaseToken)).status).toBe(404);
    await transcribed(l, 'משפט סודי שאסור שיופיע בלוג');
    const logger = require('../utils/logger');
    const logged = JSON.stringify([logger.info, logger.warn, logger.error, logger.debug].flatMap(f => f.mock.calls));
    expect(logged).not.toMatch(/SECRET-PATH-123/);
    expect(logged).not.toMatch(/משפט סודי/);
    expect(logged).not.toMatch(new RegExp(TOKEN));
    const st = (await request(app).get('/api/tomer/automation-status')).body;
    expect(st.voice).toMatchObject({ availability: { state: 'online', enabled: true }, keepHours: 24, audioOnServer: 0 });
    expect(JSON.stringify(st.voice)).not.toMatch(new RegExp(m));
    process.env.VOICE_TRANSCRIPTION_ENABLED = 'false';
    try { expect((await poll()).status).toBe(404); } finally { process.env.VOICE_TRANSCRIPTION_ENABLED = 'true'; }   // switched off = the routes are gone
  });
});

describe('5. A human who steps in pauses the automatic flow', () => {
  test('after a message typed by hand, a member\'s class request and voice message get no automatic reply and open no automatic task', async () => {
    const m = newMember();
    await staffTypes(m, 'אני רושם אותך');
    expect(store.getLead(m).status).toBe('human_owns');
    clearOut();
    const r1 = await say(m, 'הי נרשמתי לשש פילאטיס ואני רוצה לבוא ב 17:00');
    const r2 = await say(m, '[הודעה קולית]', { type: 'audio' });
    expect([r1.route, r2.route]).toEqual(['human_owns_hold', 'human_owns_hold']);
    expect(textsTo(m)).toHaveLength(0);
    expect(tasksOf(m, 'class_change')).toHaveLength(0);
    expect(tasksOf(m, 'voice_message')).toHaveLength(0);
    expect(mockGw.writes).toBe(0);
  });

  test('a manual message is told apart from an automatic one: Barak\'s own reply does not put the chat on hold', async () => {
    const lead = await newLead();
    expect(store.getLead(lead).status).not.toBe('human_owns');               // the bot answered: still automatic
    await staffTypes(lead, 'היי, אני מהצוות');
    expect(store.getLead(lead).status).toBe('human_owns');
    expect(store.getLead(lead).meta.humanOwnsReason).toBe('staff_manual_reply');
    const ai = mockAi.calls;
    clearOut();
    await say(lead, 'כמה עולה שיעור ניסיון');
    expect(mockAi.calls).toBe(ai);                                           // Barak did not answer over the human
    expect(textsTo(lead)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('5b. "The staff will get back to you" is said only with a task and an alert behind it', () => {
  const FALSE_PROMISE = /בקשת הביטול התקבלה|נחזור אליך עם אישור|ייצור איתך קשר תוך שעה|הצוות שלנו יחזור אליך בהקדם/;
  const anyTask = phone => tomerStore.getTasks({ phone });

  test('a lead asks to cancel: nothing is confirmed, no deadline is promised, and a task plus an alert exist before the reply', async () => {
    const lead = await newLead(); clearOut();
    await say(lead, 'אני רוצה לבטל את השיעור של מחר');
    expect(lastTo(lead)).not.toMatch(FALSE_PROMISE);
    expect(lastTo(lead)).toMatch(/קיבלתי את בקשת הביטול 🙏 העברתי אותה לצוות\.\nעדיין לא בוטל דבר/);
    const t = anyTask(lead);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ type: 'cancel_request', status: 'open', alert: { state: 'sent' } });
    expect(alerts()).toHaveLength(1);
    await say(lead, 'אז אפשר לבטל?');                                       // again: the same task, no second alert
    expect(anyTask(lead)).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
  });

  test('when the alert is not accepted the reply does not say the staff were told, and the task shows the failure', async () => {
    const lead = await newLead(); clearOut();
    mockOut.failManager = true;
    await say(lead, 'אני רוצה לבטל את השיעור של מחר');
    expect(lastTo(lead)).toMatch(/רשמתי אותה לטיפול הצוות/);
    expect(lastTo(lead)).not.toMatch(/העברתי אותה לצוות/);
    expect(anyTask(lead)[0].alert.state).toBe('failed');
    mockOut.failManager = false;
    const before = alerts().length;
    await app.locals.memberHandoff.retryFailedAlerts();                     // the controlled retry (other suites' failed alerts may be retried too)
    expect(alerts().slice(before).filter(a => a.subject.includes('בקשת ביטול'))).toHaveLength(1);
    expect(anyTask(lead)[0].alert.state).toBe('sent');
  });

  test('a request for a fixed weekly slot: no "within an hour", a task and an alert', async () => {
    const lead = await newLead(); clearOut();
    await say(lead, 'אפשר לשבץ אותי קבוע בימי שלישי?');
    expect(lastTo(lead)).not.toMatch(FALSE_PROMISE);
    expect(anyTask(lead)[0]).toMatchObject({ type: 'fixed_booking_request', alert: { state: 'sent' } });
  });

  test('a member who writes that she will not come gets no false confirmation either', async () => {
    const m = newMember();
    await say(m, 'לא אגיע היום לשיעור של 18:00');
    expect(lastTo(m)).not.toMatch(FALSE_PROMISE);
    expect(anyTask(m).length).toBeGreaterThanOrEqual(1);
    expect(mockGw.writes ?? 0).toBe(0);
  });
});

describe('6. The range resolver', () => {
  const ref = new Date('2026-11-16T15:48:09Z');                              // Monday 17:48 Israel time, when the lead wrote
  const f = t => { const r = callbackTime.resolveCallbackTime(t, ref); return r.ok ? callbackTime.formatCallbackTime(r.scheduledAt, r.windowEndAt) : r.reason; };
  test('a range keeps its start as the scheduled time and its end as the end of the window', () => {
    expect(f('מחר אני פנויה בין 14:00-16:00')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(f('מחר בין 2 ל-4')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');                        // was resolved to 16:00 before
    expect(f('ביום רביעי בין 10:00 ל-12:00')).toBe('יום רביעי, 18.11.2026 בין 10:00 ל-12:00');
    expect(f('מחר מ-9 עד 11')).toBe('יום שלישי, 17.11.2026 בין 09:00 ל-11:00');
  });
  test('a single hour is unchanged', () => {
    expect(f('מחר ב-15:00')).toBe('יום שלישי, 17.11.2026 בשעה 15:00');
    expect(f('ב-17.11 בשעה 15:00')).toBe('יום שלישי, 17.11.2026 בשעה 15:00');
    expect(f('מחר בסביבות 15')).toBe('יום שלישי, 17.11.2026 בשעה 15:00');
  });
  // Owner rule, 2026-11-18: a range is a valid callback request and is kept as a range. It is never turned into one
  // appointed hour (before: "בין שתיים לארבע" → 16:00, "בין 20:00 ל-23:00" → 20:00, "עד 12:00" → 12:00), and it is
  // never refused for being a range ("מחר 14-16" was answered "באיזו שעה נוח לך?").
  test('a range in words, without "בין", with dots or with half hours is still a range', () => {
    expect(f('מחר בין שתיים לארבע')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(f('מתישהו מחר בין שתיים לארבע בצהריים')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(f('מחר בין עשר לשתים עשרה')).toBe('יום שלישי, 17.11.2026 בין 10:00 ל-12:00');
    expect(f('מחר בין שתיים וחצי לארבע')).toBe('יום שלישי, 17.11.2026 בין 14:30 ל-16:00');
    expect(f('מחר 14-16')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(f('מחר 10-12')).toBe('יום שלישי, 17.11.2026 בין 10:00 ל-12:00');
    expect(f('אני זמינה 14-16')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(f('מחר בין 14.00 ל16.00')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(f('מחר בין 14:00–16:00')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(f('מחר מהשעה 9 עד השעה 11')).toBe('יום שלישי, 17.11.2026 בין 09:00 ל-11:00');
  });
  // Owner correction, 2026-11-18: 08:00-22:00 is the system's quiet-hours window, not a calling policy the owner
  // approved. "after" / "until" are kept as CONSTRAINTS (one side only), a range is kept as the prospect gave it, and
  // no hours of activity are stated to the prospect.
  const fa = t => { const r = callbackTime.resolveCallbackTime(t, ref); return r.ok ? callbackTime.formatCallbackTime(r.scheduledAt, r.windowEndAt, r.availability) : r.reason; };
  test('"after" and "until" are availability constraints: one side, no invented other side, not an appointed hour', () => {
    const r = t => callbackTime.resolveCallbackTime(t, ref);
    expect(r('מחר אחרי 16:00')).toMatchObject({ ok: true, availability: 'after' });
    expect(r('מחר אחרי 16:00').windowEndAt).toBeUndefined();
    expect(fa('מחר אחרי 16:00')).toBe('יום שלישי, 17.11.2026 אחרי 16:00');
    expect(fa('מחר רק אחרי ארבע')).toBe('יום שלישי, 17.11.2026 אחרי 16:00');
    expect(r('מחר עד 12:00')).toMatchObject({ ok: true, availability: 'until' });
    expect(r('מחר עד 12:00').windowEndAt).toBeUndefined();
    expect(fa('מחר עד 12:00')).toBe('יום שלישי, 17.11.2026 עד 12:00');
    expect(fa('מחר לפני 12')).toBe('יום שלישי, 17.11.2026 עד 12:00');
    expect(fa('היום עד 20:00')).toBe('יום שני, 16.11.2026 עד 20:00');
    expect(fa('היום עד 17:00')).toBe('past');
    // an appointed hour and a range are told apart from a constraint
    expect(r('מחר ב-16:00').availability).toBeUndefined();
    expect(r('מחר בין 14:00 ל-16:00').availability).toBeUndefined();
    expect(fa('מחר ב-16:00')).toBe('יום שלישי, 17.11.2026 בשעה 16:00');
  });
  test('a range is kept as given; one that cannot be placed is asked about; no hours of activity are stated', () => {
    const r = t => callbackTime.resolveCallbackTime(t, ref);
    expect(r('מחר בין 16:00 ל-14:00')).toMatchObject({ ok: false, reason: 'range_unclear' });
    expect(fa('מחר בין 20:00 ל-23:00')).toBe('יום שלישי, 17.11.2026 בין 20:00 ל-23:00');
    expect(fa('מחר בין 20:00 ל-22:00')).toBe('יום שלישי, 17.11.2026 בין 20:00 ל-22:00');
    for (const t of ['מחר ב-23:30', 'מחר ב-02:00 בלילה', 'מחר בין 16:00 ל-14:00', 'מחר', 'tomorrow at 3']) {
      const out = r(t);
      expect([t, out.ok]).toEqual([t, false]);
      expect([t, /\d{1,2}:00\s*[–-]\s*\d{1,2}:00|08:00|22:00/.test(out.clarification.split('\n')[0].replace(/למשל.*$/, ''))]).toEqual([t, false]);
    }
    expect(r('מחר ב-23:30')).toMatchObject({ ok: false, reason: 'outside_hours' });
    // "at night" with a small hour is after midnight, not the afternoon ("2 בלילה" was stored as 14:00)
    expect(r('מחר ב-2 בלילה')).toMatchObject({ ok: false, reason: 'outside_hours' });
    expect(r('מחר ב-12 בלילה')).toMatchObject({ ok: false, reason: 'outside_hours' });
    expect(fa('מחר ב-9 בלילה')).toBe('יום שלישי, 17.11.2026 בשעה 21:00');
    expect(fa('מחר ב-10 בלילה')).toBe('outside_hours');
  });
  // Before 2026-11-18 "tomorrow between 14:00 and 16:00" was stored as TODAY at 14:00.
  test('a time written in English is never stored from a guess: the prospect is asked to write it in numbers', () => {
    const r = t => callbackTime.resolveCallbackTime(t, ref);
    for (const t of ['tomorrow between 14:00 and 16:00', 'Tomorrow at 3pm', 'today after 5', 'call me on Monday morning', 'next week', 'at 10 please',
                     'between 2 and 4', 'tonight', 'in the afternoon', 'thursday 14:00', 'in 2 hours', 'מחר at 15:00']) {
      expect([t, r(t).ok, r(t).reason]).toEqual([t, false, 'english_time']);
      expect([t, callbackTime.hasTimeSignal(t)]).toEqual([t, true]);
    }
    expect(r('tomorrow at 3pm').clarification).toMatch(/במספרים/);
    expect(r('tomorrow at 3pm').clarification).toMatch(/in numbers/);
    // what the clarification asks for is understood, and English words that are not about time change nothing
    expect(fa('17.11 14:00-16:00')).toBe('יום שלישי, 17.11.2026 בין 14:00 ל-16:00');
    expect(fa('17.11 15:00')).toBe('יום שלישי, 17.11.2026 בשעה 15:00');
    expect(fa('ok מחר ב-15:00 thanks')).toBe('יום שלישי, 17.11.2026 בשעה 15:00');
    expect(fa('מחר 5 pm')).toBe('יום שלישי, 17.11.2026 בשעה 17:00');
    expect(callbackTime.hasTimeSignal('what happens after the trial lesson?')).toBe(false);
  });
  test('numbers that are not hours are not read as a range', () => {
    const r = t => callbackTime.resolveCallbackTime(t, ref);
    expect(r('אני בחו"ל בין 15.11 ל-20.11').windowEndAt).toBeUndefined();
    expect(r('אני בחופשה עד 20.12').windowEndAt).toBeUndefined();
    expect(r('אחרי 2 אימונים אני אחליט').ok).toBe(false);
    expect(r('אני רוצה 2-3 אימונים בשבוע').ok).toBe(false);
    expect(r('מנוי ל-3 חודשים').ok).toBe(false);
    expect(r('מחר אחרי הצהריים')).toMatchObject({ ok: false, reason: 'missing_hour' });
    expect(f('מחר ב-10 אחרי האימון')).toBe('יום שלישי, 17.11.2026 בשעה 10:00');
  });
});
