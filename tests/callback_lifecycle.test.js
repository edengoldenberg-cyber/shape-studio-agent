'use strict';
/**
 * callback_lifecycle.test.js — Barak lead → callback workflow, end to end.
 *
 * What is REAL here: server.js pipeline, lead_agent, callback.service, callback_time,
 * appointment_store (disk), persist (disk), notification.service, appointment_worker,
 * lead_store, ownership — all against a fresh temporary DATA_DIR.
 * What is MOCKED: only outbound transports — the WhatsApp send functions (captured),
 * OpenAI (scripted replies), the Arbox HTTP client (returns "not a member").
 *
 * No final state is seeded: every scenario starts from inbound messages and panel
 * actions. `restart()` reloads the whole server module from disk (jest.resetModules),
 * so in-memory guards are gone and only durable state can prevent duplicates.
 * The clock is fixed and moved explicitly (Date only — timers stay real).
 */

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
  init: jest.fn(() => Promise.resolve()), isMember: jest.fn(() => false), getAll: jest.fn(() => []), size: 0,
}));
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

// ── Harness ───────────────────────────────────────────────────────────────────

const request = require('supertest');
let app, store, aptStore, worker, callbackTime;

/** Load (or reload = restart) the whole server from disk. */
function restart() {
  jest.resetModules();
  store        = require('../utils/lead_store');
  aptStore     = require('../utils/appointment_store');
  worker       = require('../workers/appointment_worker');
  callbackTime = require('../utils/callback_time');
  app          = require('../server');
}

// Fixed clock: Monday 16.11.2026 10:00 Israel time (UTC+2). Only Date is faked.
const T0 = new Date('2026-11-16T08:00:00.000Z');
function setNow(d) { jest.setSystemTime(d instanceof Date ? d : new Date(d)); }
function il(y, m, d, h, min = 0) { return callbackTime.ilDate(y, m - 1, d, h, min); }

let phoneSeq = 100;
function newPhone() { return `97258${String(7000000 + (++phoneSeq)).padStart(7, '0')}`; }

let msgSeq = 0;
async function say(phone, text, { name = 'WA Profile', at } = {}) {
  const res = await request(app).post('/api/whatsapp/simulate')
    .send({ from: phone, text, name, type: 'text', messageId: `t-${++msgSeq}`, timestamp: (at ?? new Date()).toISOString() })
    .set('Content-Type', 'application/json');
  if (res.status !== 200) throw new Error(`simulate ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}
const post = (url, body = {}) => request(app).post(url).send(body).set('Content-Type', 'application/json');
const textsTo  = phone => mockOut.texts.filter(t => t.to === phone);
const lastTo   = phone => textsTo(phone).at(-1)?.text ?? null;
const alerts   = ()    => mockOut.alerts;
const summaries = ()   => mockOut.alerts.filter(a => /בקשת שיחה חדשה/.test(a.body));
const openApt  = phone => aptStore.getActiveCallback(phone);
const diskApts = ()    => JSON.parse(fs.readFileSync(APTS_FILE, 'utf8'));
async function panelRow(phone) {
  const r = await request(app).get('/api/barak/callbacks');
  return (r.body.callbacks ?? []).find(c => c.fullPhone === phone) ?? null;
}
const local = phone => '0' + phone.slice(3);
/** Staff reminders that concern one specific lead (the store is shared across tests). */
const staffRemindersFor    = phone => textsTo(MANAGER).filter(t => /תזכורת: שיחה/.test(t.text) && t.text.includes(local(phone)));
const prospectRemindersFor = phone => textsTo(phone).filter(t => /עדיין נוח לך/.test(t.text));
function clearOut() { mockOut.texts.length = 0; mockOut.alerts.length = 0; mockOut.failTextTo = null; mockOut.hangTextTo = null; mockOut.failManager = false; }

/** A genuine lead: first message shows studio interest so Barak (not unclassified) owns it. */
async function newLead() {
  const phone = newPhone();
  const r = await say(phone, 'היי, מתעניינת בפילאטיס מכשירים');
  expect(r.route).toBe('barak');
  return phone;
}
/** Real flow up to a persisted callback with name → ONE manager summary. */
async function leadWithCallback({ timeText = 'מחר ב-10:30', name = 'דנה' } = {}) {
  const phone = await newLead();
  await say(phone, 'אשמח שיחזרו אליי');
  await say(phone, timeText);
  await say(phone, name);
  return phone;
}

beforeAll(() => {
  jest.useFakeTimers({
    now: T0,
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
                'nextTick', 'queueMicrotask', 'hrtime', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
                'requestIdleCallback', 'cancelIdleCallback'],
  });
  restart();
});
beforeEach(() => { setNow(T0); clearOut(); mockAi.queue.length = 0; });
afterAll(() => { jest.useRealTimers(); });

// ══════════════════════════════════════════════════════════════════════════════
describe('1. Routing, answers, policy', () => {
  test('a genuine lead is handled by Barak (lead agent), never by Tomer', async () => {
    const phone = newPhone();
    const before = mockAi.calls;
    const r = await say(phone, 'היי, מתעניינת בפילאטיס מכשירים');
    expect(r.route).toBe('barak');
    expect(mockAi.calls).toBe(before + 1);
    expect(lastTo(phone)).toBeTruthy();
    expect(store.getLead(phone)).toBeTruthy();
  });

  test.each(['היי, מתעניינת באימונים אצלכם', 'שלום, רוצה לשמוע על אימוני כוח', 'אפשר פרטים על שיעורי הפילאטיס?'])(
    'first message "%s" from an unknown contact is recognised as studio interest → Barak', async (text) => {
      const r = await say(newPhone(), text);
      expect(r.route).toBe('barak');
    });

  test('an unknown contact with no studio interest is NOT pulled into Barak or a callback', async () => {
    const phone = newPhone();
    const r = await say(phone, 'היי מה נשמע, זה יוסי מהמוסך');
    expect(r.route).toBe('unclassified');
    const r2 = await say(phone, 'תחזור אליי מחר ב-10');
    expect(r2.route).toBe('unclassified');
    expect(openApt(phone)).toBeNull();
  });

  test('location question → deterministic reply with the exact configured Waze URL', async () => {
    const phone = await newLead();
    const before = mockAi.calls;
    await say(phone, 'איפה אתם נמצאים? זה רלוונטי לי?');
    expect(mockAi.calls).toBe(before);                         // no model involved
    expect(lastTo(phone)).toContain(WAZE_URL);                 // byte-for-byte
    expect(lastTo(phone)).toContain('דרך השדה 12');
  });

  test('AI reply that mentions the address without the link gets the exact Waze URL injected', async () => {
    const phone = await newLead();
    mockAi.queue.push('אנחנו בפרדס חנה 🙂 זה נוח לך מבחינת מיקום?');
    await say(phone, 'אני גרה בבנימינה');
    expect(lastTo(phone)).toContain(WAZE_URL);
  });

  test('membership prices are not available to the model under the current policy', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'subscription_packages.json'), 'utf8'));
    // Policy is enforced by configuration: no membership package carries a price, so the
    // pricing context handed to the model cannot contain one.
    expect(pkg.packages.every(p => p.price_ils === null || p.price_ils === undefined)).toBe(true);
  });

  test('AI text that promises a call when no appointment exists is never sent as written', async () => {
    const phone = await newLead();
    mockAi.queue.push('יש לנו שיעורי רפורמר בבוקר ובערב. נציג יחזור אליך מחר ב-10:00.');
    await say(phone, 'אני רוצה לחזק את הגב, מה מתאים לי?');
    const sent = lastTo(phone);
    expect(sent).toContain('רפורמר');
    expect(sent).not.toMatch(/יחזור אליך|יצור קשר|נקבע/);
    expect(openApt(phone)).toBeNull();

    // A reply that is nothing but a promise is replaced by a truthful next step.
    mockAi.queue.push('הצוות יצור איתך קשר היום ב-17:00');
    await say(phone, 'נשמע טוב');
    expect(lastTo(phone)).not.toMatch(/יצור איתך קשר|17:00/);
    expect(lastTo(phone)).toMatch(/מתי יהיה לך נוח/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('2. Callback request → persisted time → name → ONE summary (with restarts)', () => {
  test.each([
    'תתקשרו אליי בבקשה',
    'אשמח לשיחה עם מישהו מהצוות',
    'אפשר שיחת טלפון?',
    'אפשר שמישהו יחזור אליי?',
    'מעדיפה לדבר בטלפון',
  ])('natural request "%s" starts the callback flow without any AI proposal phrase', async (phrase) => {
    const phone = await newLead();
    const before = mockAi.calls;
    const r = await say(phone, phrase);
    expect(r.route).toBe('callback_time_requested');
    expect(mockAi.calls).toBe(before);
    expect(lastTo(phone)).toMatch(/מתי נוח לך/);
    expect(store.getLead(phone).meta.awaitingCallbackTime).toBe(true);
    expect(alerts()).toHaveLength(0);                          // no "נציג התבקש" pre-alert
    expect((await panelRow(phone)).stage).toBe('awaiting_time'); // visible + actionable
  });

  test('request and time in one message', async () => {
    const phone = await newLead();
    const r = await say(phone, 'תחזרו אליי מחר ב-10:30');
    expect(r.route).toBe('appointment_created');
    expect(openApt(phone).scheduledAt.toISOString()).toBe(il(2026, 11, 17, 10, 30).toISOString());
  });

  test('answering Barak\'s invitation with a time works even when the AI wording is unusual', async () => {
    const phone = await newLead();
    mockAi.queue.push('נשמע שזה בדיוק בשבילך! בא לך שמישהי מאיתנו תרים אלייך טלפון קצר? מתי נוח?');
    await say(phone, 'אני רוצה לחזק את הגב');
    const r = await say(phone, 'כן, מחר ב-16:00');
    expect(r.route).toBe('appointment_created');
    expect(openApt(phone).scheduledAt.toISOString()).toBe(il(2026, 11, 17, 16, 0).toISOString());
  });

  test('full flow, restart between every step, persistence precedes every commitment', async () => {
    const phone = await newLead();

    await say(phone, 'אשמח שיחזרו אליי');
    restart();
    expect(store.getLead(phone).meta.awaitingCallbackTime).toBe(true);

    // ── time ──
    clearOut();
    const r2 = await say(phone, 'מחר ב-10:30');
    expect(r2.route).toBe('appointment_created');
    const apt = openApt(phone);
    expect(apt.status).toBe('callback_pending');
    expect(apt.scheduledAt.toISOString()).toBe(il(2026, 11, 17, 10, 30).toISOString());
    expect(diskApts().find(a => a.id === apt.id).scheduledAt).toBe(apt.scheduledAt.toISOString());
    const timeReply = textsTo(phone)[0];
    expect(timeReply.text).toContain('יום שלישי, 17.11.2026 בשעה 10:30');   // explicit date + IL time
    expect(timeReply.text).toMatch(/איך קוראים לך/);
    expect(timeReply.text).not.toMatch(/יצור איתך קשר|ייצור איתך קשר|נקבעה/); // no call promise yet
    expect(timeReply.aptFileAtSend).toContain(apt.id);                         // on disk BEFORE the reply
    expect(alerts()).toHaveLength(0);                                         // manager waits for the name
    expect(store.getLead(phone).status).toBe('callback_requested');
    expect((await panelRow(phone)).stage).toBe('awaiting_name');

    restart();
    expect(openApt(phone).id).toBe(apt.id);

    // ── name ──
    clearOut();
    const r3 = await say(phone, 'דנה');
    expect(r3.route).toBe('post_call_name_captured');
    expect(summaries()).toHaveLength(1);
    const mgr = summaries()[0];
    expect(mgr.subject).toBe('📞 בקשת שיחה — דנה');
    expect(mgr.body).toContain('📞 בקשת שיחה חדשה — דנה');
    expect(mgr.body).toContain('📅 יום שלישי, 17.11.2026 בשעה 10:30');
    expect(mgr.body).toContain('⏳ בקשת שיחה — ממתינה לאישור הצוות');
    expect(mgr.body).toContain(`https://wa.me/${phone}`);
    expect(mgr.body).toContain('https://panel.example.test/#barak');
    expect(mgr.body).not.toMatch(/\*\*|undefined|null|נקבעה|אושרה/);
    expect(mgr.body).toContain('💪 עניין: פילאטיס');            // present field included
    expect(mgr.body).not.toMatch(/📍 מיקום|🎯 מטרה/);           // absent fields omitted, not blank
    expect(mgr.body).toContain(`📱 0${phone.slice(3)}`);
    expect(mgr.linkPreview).toBe(false);
    expect(mgr.aptFileAtSend).toContain(apt.id);
    const prospect = textsTo(phone);
    expect(prospect).toHaveLength(1);
    expect(prospect[0].text).toBe('דנה, קיבלנו את בקשת השיחה שלך ✅\n📞 יום שלישי, 17.11.2026 בשעה 10:30\nנציג מהצוות של Shape Studio יצור איתך קשר.');
    expect(prospect[0].aptFileAtSend).toContain(apt.id);

    const row = await panelRow(phone);
    expect(row.stage).toBe('pending_staff');
    expect(row.apt.scheduledLabel).toBe('יום שלישי, 17.11.2026 בשעה 10:30');
    expect(row.meta.qualData.confirmedName).toBe('דנה');
    expect(row.meta.handoffAlertStatus).toBe('sent');

    // ── duplicates after a restart: nothing is replayed ──
    restart();
    clearOut();
    await say(phone, 'מחר ב-10:30');                          // same time again
    await say(phone, 'דנה');                                   // same name again
    const retry = await post(`/api/admin/send-closing-summary/${phone}`, {});
    expect(retry.status).toBe(409);
    const forced = await post(`/api/admin/send-closing-summary/${phone}`, { force: true });
    expect(forced.status).toBe(200);
    const notify = await post(`/api/admin/appointments/${apt.id}/retry-notify`, {});
    expect(notify.body.sent).toBe(0);
    expect(summaries()).toHaveLength(0);
    expect(textsTo(phone).filter(t => /קיבלנו את בקשת השיחה/.test(t.text))).toHaveLength(0);
    expect(aptStore.getByPhone(phone)).toHaveLength(1);       // still exactly one appointment
  });

  test('name already known when the time arrives → one summary immediately, never a second format', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    await say(phone, 'מחר ב-9');
    await say(phone, 'נועה');
    expect(summaries()).toHaveLength(1);
    // Call takes place; later the same lead asks again — name is known this time.
    await post(`/api/admin/appointments/${openApt(phone).id}/complete`, {});
    clearOut();
    await say(phone, 'אפשר שיחזרו אליי ביום חמישי ב-12:00?');
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].body).toContain('📅 יום חמישי, 19.11.2026 בשעה 12:00');
    expect(alerts().some(a => /ליד מוכן|נציג התבקש|שיחת ייעוץ נקבעה/.test(a.subject + a.body))).toBe(false);
    expect(textsTo(phone)).toHaveLength(1);
    expect(textsTo(phone)[0].text).toContain('נועה, קיבלנו את בקשת השיחה שלך');
  });

  test('manager send fails → recorded as failed; a single retry sends exactly one summary', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    await say(phone, 'מחר ב-11');
    mockOut.failManager = true;
    await say(phone, 'מיכל');
    expect(summaries()).toHaveLength(0);
    expect(store.getLead(phone).meta.closingSummaryManagerState).toBe('failed');
    expect(store.getLead(phone).meta.qualData.closingSummarySent).toBe(false);
    expect((await panelRow(phone)).flags).toContain('manager_summary_failed');

    restart();
    mockOut.failManager = false;
    const prospectBefore = textsTo(phone).length;
    const res = await post(`/api/admin/send-closing-summary/${phone}`, {});
    expect(res.status).toBe(200);
    expect(res.body.bothAccepted).toBe(true);
    expect(summaries()).toHaveLength(1);
    expect(textsTo(phone).length).toBe(prospectBefore);       // prospect not messaged twice
    const again = await post(`/api/admin/appointments/${openApt(phone).id}/retry-notify`, {});
    expect(again.body.sent).toBe(0);
    expect(summaries()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('3. Storage failure', () => {
  function failAptWrites() {
    const real = fs.writeFileSync;
    return jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      if (String(file).startsWith(APTS_FILE)) throw new Error('ENOSPC: simulated disk full');
      return real.call(fs, file, ...rest);
    });
  }

  test('appointment cannot be written → no confirmation, truthful reply, manager told, nothing in memory', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    clearOut();
    const spy = failAptWrites();
    let r;
    try { r = await say(phone, 'מחר ב-10:30'); } finally { spy.mockRestore(); }

    expect(r.route).toBe('callback_persist_failed');
    expect(openApt(phone)).toBeNull();
    expect(aptStore.getByPhone(phone)).toHaveLength(0);
    const reply = lastTo(phone);
    expect(reply).toMatch(/לא הצלחתי לרשום/);
    expect(reply).not.toMatch(/17\.11|רשמתי בקשת שיחה|קיבלנו את בקשת השיחה/);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/לא נשמרה/);
    expect(store.getLead(phone).status).not.toBe('callback_requested');
    expect(store.getLead(phone).meta.qualData?.callTimeGiven).toBeUndefined();

    // Storage recovers → the same request now goes through normally.
    clearOut();
    await say(phone, 'אשמח שיחזרו אליי');
    const ok = await say(phone, 'מחר ב-10:30');
    expect(ok.route).toBe('appointment_created');
    expect(openApt(phone)).toBeTruthy();
  });

  test('update / updateBatch: a failed write throws and memory is rolled back', async () => {
    const phone = await leadWithCallback();
    const apt = openApt(phone);
    const spy = failAptWrites();
    try {
      expect(() => aptStore.update(apt.id, { leadName: 'X' })).toThrow(/ENOSPC/);
      expect(() => aptStore.updateBatch([apt.id], { leadName: 'Y' })).toThrow(/ENOSPC/);
      expect(() => aptStore.staffConfirm(apt.id)).toThrow(/ENOSPC/);
    } finally { spy.mockRestore(); }
    expect(aptStore.get(apt.id).leadName).toBe('דנה');
    expect(aptStore.get(apt.id).status).toBe('callback_pending');
    expect(diskApts().find(a => a.id === apt.id).status).toBe('callback_pending');
  });

  test('panel confirm during a storage failure reports the failure and changes nothing', async () => {
    const phone = await leadWithCallback();
    const apt = openApt(phone);
    const spy = failAptWrites();
    let res;
    try { res = await post(`/api/admin/appointments/${apt.id}/confirm`); } finally { spy.mockRestore(); }
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(aptStore.get(apt.id).status).toBe('callback_pending');
    expect(store.getLead(phone).status).toBe('callback_requested');
  });

  test('name arrives while storage is failing → no summaries are sent', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    await say(phone, 'מחר ב-10:30');
    clearOut();
    const spy = failAptWrites();
    try { await say(phone, 'דנה'); } finally { spy.mockRestore(); }
    expect(summaries()).toHaveLength(0);
    expect(textsTo(phone).filter(t => /קיבלנו את בקשת השיחה/.test(t.text))).toHaveLength(0);
    // Once storage is back the summary can be sent exactly once.
    const res = await post(`/api/admin/send-closing-summary/${phone}`, {});
    expect(res.body.bothAccepted).toBe(true);
    expect(summaries()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('4. Date and time handling', () => {
  // T0 = Monday 16.11.2026 10:00 IL
  const R = (text, ref = T0) => callbackTime.resolveCallbackTime(text, ref);
  const ok = (text, expected, ref = T0) => {
    const r = R(text, ref);
    expect({ text, ok: r.ok, at: r.ok ? r.scheduledAt.toISOString() : r.reason })
      .toEqual({ text, ok: true, at: expected.toISOString() });
  };
  const ask = (text, reason, ref = T0) => {
    const r = R(text, ref);
    expect({ text, ok: r.ok, reason: r.reason }).toEqual({ text, ok: false, reason });
    expect(r.clarification).toMatch(/\?/);
  };

  test('explicit numeric dates', () => {
    ok('17.11.2026 בשעה 10:00', il(2026, 11, 17, 10));
    ok('17/11/26 ב-14:30',      il(2026, 11, 17, 14, 30));
    ok('17.11 ב-17:30',         il(2026, 11, 17, 17, 30));
    ok('מחר ב-10.30',           il(2026, 11, 17, 10, 30));   // dot = time, not a date
  });
  test('Hebrew month names', () => {
    ok('17 בנובמבר בשעה 10', il(2026, 11, 17, 10));
    ok('2 בדצמבר ב-9:15',    il(2026, 12, 2, 9, 15));
    ok('20 לנובמבר 2026 ב-12', il(2026, 11, 20, 12));
  });
  test('relative days', () => {
    ok('היום ב-15:00',       il(2026, 11, 16, 15));
    ok('מחר ב12',            il(2026, 11, 17, 12));
    ok('מחרתיים ב-4 אחה"צ',  il(2026, 11, 18, 16));
    ok('בעוד שעתיים',        new Date(T0.getTime() + 2 * 3600e3));
    ok('שעה 14',             il(2026, 11, 16, 14));          // hour only, still ahead today
    ok('ב-9',                il(2026, 11, 17, 9));           // hour only, already passed today → tomorrow
  });
  test('weekday references', () => {
    ok('ביום רביעי ב-11',    il(2026, 11, 18, 11));
    ok('ראשון ב11',          il(2026, 11, 22, 11));
    ok('יום שני ב-10',       il(2026, 11, 23, 10));          // today is Monday → next Monday
    ok('ביום ה\' ב-16:00',   il(2026, 11, 19, 16));
    ok('יום שלישי בעשר וחצי', il(2026, 11, 17, 10, 30));
  });
  test('12-hour ambiguity is resolved by qualifier or calling hours — never silently', () => {
    ok('מחר ב-5',            il(2026, 11, 17, 17));          // 05:00 is outside calling hours
    ok('מחר ב-8 בערב',       il(2026, 11, 17, 20));
    ok('מחר ב-8 בבוקר',      il(2026, 11, 17, 8));
    ask('מחר ב-7 בבוקר', 'outside_hours');
    ask('מחר ב-23:00',   'outside_hours');
  });
  test('year rollover', () => {
    ok('3 בינואר ב-10',  il(2027, 1, 3, 10), new Date('2026-12-28T08:00:00Z'));
    ok('1.1 ב-10',       il(2027, 1, 1, 10), new Date('2026-12-30T08:00:00Z'));
    ask('3 באוקטובר ב-10', 'past');                           // 11 months away is not a rollover
  });
  test('timezone boundaries', () => {
    // 23:50 in Israel on 16.11 is still 16.11 → "מחר" = 17.11 (UTC date is also 16.11)
    ok('מחר ב-12', il(2026, 11, 17, 12), new Date('2026-11-16T21:50:00Z'));
    // 00:30 in Israel on 17.11 is 22:30 UTC on 16.11 → "היום" must be the 17th
    ok('היום ב-12', il(2026, 11, 17, 12), new Date('2026-11-16T22:30:00Z'));
    ok('מחר ב-12',  il(2026, 11, 18, 12), new Date('2026-11-16T22:30:00Z'));
    // DST start (27.3.2026): the offset changes from +2 to +3
    expect(R('מחר ב-10', new Date('2026-03-26T10:00:00Z')).scheduledAt.toISOString()).toBe('2026-03-27T07:00:00.000Z');
    expect(R('היום ב-15', new Date('2026-03-26T10:00:00Z')).scheduledAt.toISOString()).toBe('2026-03-26T13:00:00.000Z');
  });
  test('missing or invalid input is clarified, never defaulted', () => {
    ask('מחר',                 'missing_hour');
    ask('ביום רביעי',          'missing_hour');
    ask('מחר בבוקר',           'missing_hour');
    ask('17.11',               'missing_hour');
    ask('בערב',                'missing_day_ambiguous');
    ask('30.02 בשעה 10',       'invalid_date');
    ask('31.11.2026 ב-10',     'invalid_date');
    ask('מחר ב-25',            'invalid_hour');
    ask('יום שני 17.11 ב-10',  'weekday_date_conflict');     // 17.11.2026 is a Tuesday
    ask('מחר ביום חמישי ב-10', 'weekday_date_conflict');
    ask('15.11 ב-10',          'past');
    ask('היום ב-9',            'past');
    ask('16.11.2025 ב-10',     'past');
    ask('20.3.2027 ב-10',      'too_far');
    ask('כמה עולה מנוי ל-3 חודשים?', 'no_time');
  });
  test('formatting uses Israel time regardless of process timezone', () => {
    expect(callbackTime.formatCallbackTime(new Date('2026-11-16T22:30:00Z'))).toBe('יום שלישי, 17.11.2026 בשעה 00:30');
  });

  test('pipeline: the time is anchored to the message timestamp, not to processing time', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    // Sent 23:50 on the 16th; processed 00:20 on the 17th (delayed webhook).
    setNow('2026-11-16T22:20:00Z');
    await say(phone, 'מחר ב-12', { at: new Date('2026-11-16T21:50:00Z') });
    expect(openApt(phone).scheduledAt.toISOString()).toBe(il(2026, 11, 17, 12).toISOString());
    // The name arrives the next afternoon — displayed date still comes from scheduledAt.
    setNow('2026-11-17T07:00:00Z');
    clearOut();
    await say(phone, 'יעל');
    expect(summaries()[0].body).toContain('📅 יום שלישי, 17.11.2026 בשעה 12:00');
    expect(lastTo(phone)).toContain('📞 יום שלישי, 17.11.2026 בשעה 12:00');
  });

  test.each([
    ['מחר',                  /באיזו שעה/],
    ['30.02 בשעה 10',        /לא קיים בלוח השנה/],
    ['יום שני 17.11 ב-10',   /17\.11 יוצא ביום שלישי/],
    ['מחר ב-23:30',          /08:00–22:00/],
  ])('pipeline: "%s" → clarification, no appointment, no model call', async (text, re) => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    const aiBefore = mockAi.calls;
    const r = await say(phone, text);
    expect(r.route).toBe('callback_time_clarify');
    expect(lastTo(phone)).toMatch(re);
    expect(openApt(phone)).toBeNull();
    expect(mockAi.calls).toBe(aiBefore);
    expect(store.getLead(phone).meta.awaitingCallbackTime).toBe(true);
    expect(alerts()).toHaveLength(0);
    // A proper answer afterwards is accepted.
    const ok2 = await say(phone, 'מחר ב-11:00');
    expect(ok2.route).toBe('appointment_created');
  });

  test('three unclear answers → truthful hand-over to staff, no invented time', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    await say(phone, 'מחר');
    await say(phone, 'בבוקר');
    clearOut();
    const r = await say(phone, 'מתישהו בערב');
    expect(r.route).toBe('callback_time_unresolved_handoff');
    expect(lastTo(phone)).toMatch(/העברתי את הבקשה לצוות/);
    expect(openApt(phone)).toBeNull();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/ללא מועד ברור/);
  });

  test('while a time is awaited, an unrelated question is answered normally', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    const r = await say(phone, 'ומה צריך להביא לאימון?');
    expect(r.route).toBe('barak');
    expect(openApt(phone)).toBeNull();
    expect(store.getLead(phone).meta.awaitingCallbackTime).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('5. Staff confirmation and outcomes', () => {
  test('confirm: pending → confirmed, repeat is a no-op, lead and panel follow', async () => {
    const phone = await leadWithCallback();
    const apt = openApt(phone);
    clearOut();
    const r1 = await post(`/api/admin/appointments/${apt.id}/confirm`);
    expect(r1.status).toBe(200);
    expect(r1.body.unchanged).toBe(false);
    expect(aptStore.get(apt.id).status).toBe('confirmed');
    expect(aptStore.get(apt.id).staffConfirmedAt).toBeTruthy();
    expect(store.getLead(phone).status).toBe('call_scheduled');
    const row = await panelRow(phone);
    expect(row.stage).toBe('staff_confirmed');
    expect(row.apt.prospectAvailability).toBeNull();          // approval ≠ availability
    const stamp = aptStore.get(apt.id).staffConfirmedAt;

    const r2 = await post(`/api/admin/appointments/${apt.id}/confirm`);
    expect(r2.status).toBe(200);
    expect(r2.body.unchanged).toBe(true);
    expect(aptStore.get(apt.id).staffConfirmedAt).toBe(stamp);
    expect(textsTo(phone)).toHaveLength(0);
    expect(alerts()).toHaveLength(0);

    restart();
    expect(aptStore.get(apt.id).status).toBe('confirmed');
  });

  test('confirm after the reminders were sent does NOT reset them (no duplicate reminders)', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-11:00' });
    const apt = openApt(phone);
    setNow(il(2026, 11, 16, 10, 35));                         // 25 min before
    clearOut();
    await worker.runCycle(store);
    expect(alerts()).toHaveLength(0);
    const staffReminders = () => staffRemindersFor(phone);
    const prospectReminders = () => prospectRemindersFor(phone);
    expect(staffReminders()).toHaveLength(1);
    expect(prospectReminders()).toHaveLength(1);

    await post(`/api/admin/appointments/${apt.id}/confirm`);
    const a = aptStore.get(apt.id);
    expect(a.status).toBe('confirmed');
    expect(a.reminderSent).toBe(true);
    expect(a.reminderSentTo).toEqual([MANAGER]);
    expect(a.prospectReminderSent).toBe(true);

    await worker.runCycle(store);
    restart();
    await worker.runCycle(store);
    expect(staffReminders()).toHaveLength(1);
    expect(prospectReminders()).toHaveLength(1);
  });

  test.each(['complete', 'cancel', 'no-answer'])('a callback closed by "%s" cannot be confirmed or revived', async (action) => {
    const phone = await leadWithCallback();
    const apt = openApt(phone);
    const done = await post(`/api/admin/appointments/${apt.id}/${action}`, {});
    expect(done.status).toBe(200);
    const closedStatus = aptStore.get(apt.id).status;
    expect(closedStatus).toBe({ complete: 'completed', cancel: 'cancelled', 'no-answer': 'no_answer' }[action]);

    const conf = await post(`/api/admin/appointments/${apt.id}/confirm`);
    expect(conf.status).toBe(409);
    for (const other of ['complete', 'cancel', 'no-answer'].filter(x => x !== action)) {
      expect((await post(`/api/admin/appointments/${apt.id}/${other}`, {})).status).toBe(409);
    }
    expect((await post(`/api/admin/appointments/${apt.id}/reschedule`, { rawTime: 'מחר ב-12' })).status).toBe(409);
    const patch = await request(app).patch(`/api/admin/appointments/${apt.id}`).send({ status: 'confirmed' });
    expect(patch.status).toBe(400);
    expect(aptStore.get(apt.id).status).toBe(closedStatus);

    // Repeating the same outcome is a no-op.
    const again = await post(`/api/admin/appointments/${apt.id}/${action}`, {});
    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(true);
  });

  test('outcomes keep lead + panel consistent; closed callbacks leave the queue and get no reminders', async () => {
    for (const [action, leadStatus] of [['complete', 'call_completed'], ['cancel', 'call_cancelled'], ['no-answer', 'call_no_answer']]) {
      setNow(T0);
      const phone = await leadWithCallback({ timeText: 'היום ב-11:00' });
      const apt = openApt(phone);
      await post(`/api/admin/appointments/${apt.id}/confirm`);
      clearOut();
      await post(`/api/admin/appointments/${apt.id}/${action}`, {});
      expect(store.getLead(phone).status).toBe(leadStatus);
      expect(await panelRow(phone)).toBeNull();
      expect(textsTo(phone)).toHaveLength(0);                 // no automated prospect message
      setNow(il(2026, 11, 16, 10, 40));
      await worker.runCycle(store);
      expect(textsTo(phone)).toHaveLength(0);
      expect(staffRemindersFor(phone)).toHaveLength(0);
      expect(store.getSendableLeads().some(l => l.phone === phone)).toBe(false);
    }
  });

  test('after an outcome the lead talks to Barak normally again; a new request starts a new cycle', async () => {
    const phone = await leadWithCallback();
    const firstId = openApt(phone).id;
    await post(`/api/admin/appointments/${firstId}/complete`, { notes: 'דיברנו' });
    expect(store.getLead(phone).meta.qualData.callTimeGiven).toBeNull();
    expect(store.getLead(phone).meta.qualData.confirmedName).toBe('דנה');   // the name is kept
    clearOut();
    mockAi.queue.push('בשמחה! יש לנו מסלולים לפי מספר אימונים בשבוע 🙂');
    const r = await say(phone, 'תודה על השיחה! רציתי לשאול עוד משהו על המסלולים');
    expect(r.route).toBe('barak');
    expect(lastTo(phone)).toContain('מסלולים לפי מספר אימונים');
    expect(alerts()).toHaveLength(0);
    // A second request later is a NEW appointment; the completed one is untouched.
    await say(phone, 'אפשר שיחזרו אליי שוב מחר ב-13:00?');
    expect(openApt(phone).id).not.toBe(firstId);
    expect(aptStore.get(firstId).status).toBe('completed');
    expect(aptStore.get(firstId).completionNotes).toBe('דיברנו');
    expect(summaries()).toHaveLength(1);
  });

  test('an older request left open (expired, no outcome) never resurfaces after a newer request is closed', async () => {
    // Same shape as the production test record: an expired pending request with no outcome…
    const phone = await leadWithCallback({ timeText: 'היום ב-11:00' });
    const oldId = openApt(phone).id;
    setNow(il(2026, 11, 16, 12, 0));
    const oldBefore = JSON.stringify(diskApts().find(a => a.id === oldId));
    // …then a new request, confirmed and completed.
    await say(phone, 'אשמח שיחזרו אליי היום ב-14:00');
    const newId = openApt(phone).id;
    expect(newId).not.toBe(oldId);
    await post(`/api/admin/appointments/${newId}/confirm`);
    expect(store.getLead(phone).status).toBe('call_scheduled');
    await post(`/api/admin/appointments/${newId}/complete`, {});

    expect(store.getLead(phone).status).toBe('call_completed');           // lead follows the CURRENT request
    expect(openApt(phone)).toBeNull();                                     // the old one is not "current" again
    expect(await panelRow(phone)).toBeNull();                              // and does not reappear in the queue
    expect(JSON.stringify(diskApts().find(a => a.id === oldId))).toBe(oldBefore);   // history untouched, byte for byte
    restart();
    expect(openApt(phone)).toBeNull();
    clearOut();
    setNow(il(2026, 11, 16, 13, 35));
    await worker.runCycle(store);
    expect(textsTo(phone)).toHaveLength(0);
    expect(staffRemindersFor(phone)).toHaveLength(0);
  });

  test('an expired callback cannot be confirmed; it waits for an outcome and no "missed call" message is sent', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-11:00' });
    const apt = openApt(phone);
    await post(`/api/admin/appointments/${apt.id}/confirm`);
    setNow(il(2026, 11, 16, 11, 40));                         // 40 min after the call time
    clearOut();
    const res = await worker.runCycle(store);
    expect(res.noShows).toBe(0);
    expect(textsTo(phone)).toHaveLength(0);                   // telephone callback: no no-show text
    expect(aptStore.get(apt.id).status).toBe('confirmed');
    expect(store.getLead(phone).meta.awaitingCallbackTime).not.toBe(true);
    expect((await panelRow(phone)).stage).toBe('awaiting_outcome');

    const phone2 = await leadWithCallback({ timeText: 'היום ב-12:30' });
    setNow(il(2026, 11, 16, 12, 45));
    const late = await post(`/api/admin/appointments/${openApt(phone2).id}/confirm`);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('expired');
  });

  test('staff reschedule: strict time, approval and reminders reset, prospect informed, manager not messaged', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-11:00' });
    const apt = openApt(phone);
    await post(`/api/admin/appointments/${apt.id}/confirm`);
    setNow(il(2026, 11, 16, 10, 35));
    await worker.runCycle(store);                             // reminders for 11:00 go out
    clearOut();

    const bad = await post(`/api/admin/appointments/${apt.id}/reschedule`, { rawTime: '30.02 ב-10' });
    expect(bad.status).toBe(422);
    expect(aptStore.get(apt.id).scheduledAt.toISOString()).toBe(il(2026, 11, 16, 11).toISOString());

    const good = await post(`/api/admin/appointments/${apt.id}/reschedule`, { rawTime: 'מחר ב-15:00' });
    expect(good.status).toBe(200);
    const a = aptStore.get(apt.id);
    expect(a.scheduledAt.toISOString()).toBe(il(2026, 11, 17, 15).toISOString());
    expect(a.status).toBe('callback_pending');                // needs approval again
    expect(a.staffConfirmedAt).toBeNull();
    expect([a.reminderSent, a.prospectReminderSent, a.reminderSentTo]).toEqual([false, false, []]);
    expect(store.getLead(phone).status).toBe('callback_requested');
    expect(textsTo(phone)).toHaveLength(1);
    expect(textsTo(phone)[0].text).toContain('עדכנו את בקשת השיחה');
    expect(textsTo(phone)[0].text).toContain('יום שלישי, 17.11.2026 בשעה 15:00');
    expect(alerts()).toHaveLength(0);

    // Old time passes: nothing fires. New time approaches: exactly one new cycle.
    clearOut();
    setNow(il(2026, 11, 16, 10, 50));
    await worker.runCycle(store);
    expect(textsTo(phone)).toHaveLength(0);
    expect(staffRemindersFor(phone)).toHaveLength(0);
    setNow(il(2026, 11, 17, 14, 35));
    await worker.runCycle(store);
    await worker.runCycle(store);
    expect(staffRemindersFor(phone)).toHaveLength(1);
    expect(prospectRemindersFor(phone)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('6. Reminders (real worker cycle)', () => {
  const prospectReminders = prospectRemindersFor;

  test('worker is registered with the effective configuration', async () => {
    const r = await request(app).get('/api/admin/appointments/worker-status');
    expect(r.body.worker).toMatchObject({ pendingAndProspectRemindersEnabled: true, reminderMinutes: 30, leadAllowlist: null });
    expect(r.body.callingHours).toEqual({ start: 8, end: 22 });
  });

  test('pending callback: one staff + one prospect reminder inside the window, never twice', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-14:00' });
    clearOut();
    setNow(il(2026, 11, 16, 13, 0));                          // 60 min before → not yet
    await worker.runCycle(store);
    expect(textsTo(phone)).toHaveLength(0);
    expect(staffRemindersFor(phone)).toHaveLength(0);

    setNow(il(2026, 11, 16, 13, 30));                         // 30 min before
    await worker.runCycle(store);
    expect(staffRemindersFor(phone)).toHaveLength(1);
    expect(staffRemindersFor(phone)[0].text).toContain('יום שני, 16.11.2026 בשעה 14:00');
    expect(staffRemindersFor(phone)[0].text).toContain('ממתינה לאישור הצוות');
    expect(staffRemindersFor(phone)[0].text).toContain('דנה');
    expect(prospectReminders(phone)).toHaveLength(1);
    expect(prospectReminders(phone)[0].text).toContain('יום שני, 16.11.2026 בשעה 14:00');

    setNow(il(2026, 11, 16, 13, 45));
    await worker.runCycle(store);
    restart();
    await worker.runCycle(store);
    expect(staffRemindersFor(phone)).toHaveLength(1);
    expect(prospectReminders(phone)).toHaveLength(1);
  });

  test('staff-confirmed callback receives both reminders too', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-14:00' });
    await post(`/api/admin/appointments/${openApt(phone).id}/confirm`);
    clearOut();
    setNow(il(2026, 11, 16, 13, 35));
    await worker.runCycle(store);
    expect(staffRemindersFor(phone)).toHaveLength(1);
    expect(staffRemindersFor(phone)[0].text).toContain('אושרה על ידי הצוות');
    expect(prospectReminders(phone)).toHaveLength(1);
  });

  test('expired, cancelled and superseded times are never reminded', async () => {
    const expired = await leadWithCallback({ timeText: 'היום ב-11:00' });
    const cancelled = await leadWithCallback({ timeText: 'היום ב-14:00' });
    await post(`/api/admin/appointments/${openApt(cancelled).id}/cancel`, {});
    // superseded: an old open record plus a newer request for the same lead
    const sup = await leadWithCallback({ timeText: 'היום ב-11:00' });
    const oldId = openApt(sup).id;
    setNow(il(2026, 11, 16, 11, 30));                         // first time expired, no outcome recorded
    await say(sup, 'אפשר שיחזרו אליי היום ב-14:00?');
    const newId = openApt(sup).id;
    expect(newId).not.toBe(oldId);
    expect(aptStore.get(oldId).status).toBe('callback_pending'); // history untouched

    clearOut();
    setNow(il(2026, 11, 16, 13, 35));
    await worker.runCycle(store);
    expect(prospectReminders(expired)).toHaveLength(0);
    expect(prospectReminders(cancelled)).toHaveLength(0);
    expect(prospectReminders(sup)).toHaveLength(1);
    expect(staffRemindersFor(sup)).toHaveLength(1);           // only the superseding request
    expect(staffRemindersFor(expired)).toHaveLength(0);
    expect(staffRemindersFor(cancelled)).toHaveLength(0);
    expect(aptStore.get(oldId).reminderSent).toBe(false);
  });

  test('lead allowlist restricts reminders; disabled flag stops pending + prospect reminders', async () => {
    const a = await leadWithCallback({ timeText: 'היום ב-14:00' });
    const b = await leadWithCallback({ timeText: 'היום ב-14:00' });
    clearOut();
    setNow(il(2026, 11, 16, 13, 35));
    process.env.CALLBACK_PENDING_REMINDER_PHONES = a;
    try { await worker.runCycle(store); } finally { delete process.env.CALLBACK_PENDING_REMINDER_PHONES; }
    expect(prospectReminders(a)).toHaveLength(1);
    expect(prospectReminders(b)).toHaveLength(0);

    process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'false';
    try { await worker.runCycle(store); } finally { process.env.CALLBACK_PENDING_REMINDER_ENABLED = 'true'; }
    expect(prospectReminders(b)).toHaveLength(0);
  });

  test('provider rejects the prospect reminder → not marked sent, retried next cycle', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-14:00' });
    clearOut();
    setNow(il(2026, 11, 16, 13, 35));
    mockOut.failTextTo = phone;
    await worker.runCycle(store);
    expect(openApt(phone).prospectReminderSent).toBe(false);
    mockOut.failTextTo = null;
    setNow(il(2026, 11, 16, 13, 50));
    await worker.runCycle(store);
    expect(prospectReminders(phone)).toHaveLength(1);
    expect(openApt(phone).prospectReminderSent).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('7. Prospect replies to the reminder', () => {
  async function reminded({ confirmFirst = false } = {}) {
    const phone = await leadWithCallback({ timeText: 'היום ב-14:00' });
    if (confirmFirst) await post(`/api/admin/appointments/${openApt(phone).id}/confirm`);
    setNow(il(2026, 11, 16, 13, 35));
    await worker.runCycle(store);
    clearOut();
    return phone;
  }

  test.each([[false], [true]])('"כן" → availability saved, acknowledged, manager told once (staff-confirmed=%s)', async (confirmFirst) => {
    const phone = await reminded({ confirmFirst });
    const r = await say(phone, 'כן');
    expect(r.route).toBe('post_call_avail_confirmed');
    const apt = openApt(phone);
    expect(apt.prospectAvailability).toBe('confirmed');
    expect(apt.status).toBe(confirmFirst ? 'confirmed' : 'callback_pending');   // availability ≠ approval
    expect(lastTo(phone)).toContain('תודה על האישור');
    expect(lastTo(phone)).toContain('יום שני, 16.11.2026 בשעה 14:00');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/אישר\/ה זמינות — דנה/);
    expect(alerts()[0].body).toContain(confirmFirst ? 'אושרה על ידי הצוות' : 'ממתינה לאישור הצוות');
    expect((await panelRow(phone)).apt.prospectAvailability).toBe('confirmed');

    // Duplicate affirmations (also after a restart): silent, no second alert.
    restart();
    const d1 = await say(phone, 'כן');
    const d2 = await say(phone, 'מעולה');
    expect(d1.route).toBe('post_call_avail_already_confirmed');
    expect(d2.route).toBe('post_call_avail_already_confirmed');
    expect(alerts()).toHaveLength(1);
    expect(textsTo(phone)).toHaveLength(1);

    // A new substantive question is NOT swallowed as a duplicate.
    const q = await say(phone, 'רגע, כמה זמן השיחה תיקח ומי יתקשר אליי?');
    expect(q.route).toBe('post_call_staff_hold');
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1].body).toContain('כמה זמן השיחה תיקח');
  });

  test('"לא נוח" → asks for a new time, request is NOT cancelled; new time restarts the reminder cycle', async () => {
    const phone = await reminded({ confirmFirst: true });
    const aptId = openApt(phone).id;
    const r = await say(phone, 'לא נוח לי בסוף');
    expect(r.route).toBe('post_call_avail_rescheduled');
    expect(openApt(phone).id).toBe(aptId);
    expect(openApt(phone).status).toBe('confirmed');          // still open
    expect(openApt(phone).prospectAvailability).toBe('rescheduled');
    expect(lastTo(phone)).toMatch(/מתי יהיה לך נוח/);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/ביקש\/ה מועד אחר/);
    expect((await panelRow(phone)).stage).toBe('awaiting_new_time');

    restart();
    clearOut();
    const r2 = await say(phone, 'מחר ב-16:00');
    expect(r2.route).toBe('appointment_rescheduled');
    const a = openApt(phone);
    expect(a.id).toBe(aptId);                                  // same record, history kept
    expect(a.scheduledAt.toISOString()).toBe(il(2026, 11, 17, 16).toISOString());
    expect(a.previousScheduledAt).toBe(il(2026, 11, 16, 14).toISOString());
    expect(a.status).toBe('callback_pending');                // new time needs new approval
    expect([a.reminderSent, a.prospectReminderSent, a.prospectAvailability]).toEqual([false, false, null]);
    expect(textsTo(phone)).toHaveLength(1);
    expect(textsTo(phone)[0].text).toContain('עדכנו את בקשת השיחה');
    expect(textsTo(phone)[0].text).toContain('יום שלישי, 17.11.2026 בשעה 16:00');
    expect(alerts()).toHaveLength(1);                          // ONE manager message for the change
    expect(alerts()[0].subject).toBe('🔄 שינוי מועד — דנה');
    expect(alerts()[0].body).toContain('📅 יום שלישי, 17.11.2026 בשעה 16:00');
    expect(alerts()[0].body).toContain('מועד קודם: יום שני, 16.11.2026 בשעה 14:00');

    clearOut();
    setNow(il(2026, 11, 16, 13, 50));                         // old time: nothing
    await worker.runCycle(store);
    expect(textsTo(phone)).toHaveLength(0);
    expect(staffRemindersFor(phone)).toHaveLength(0);
    setNow(il(2026, 11, 17, 15, 35));                         // new time: fresh cycle
    await worker.runCycle(store);
    await worker.runCycle(store);
    expect(prospectRemindersFor(phone)).toHaveLength(1);
    expect(prospectRemindersFor(phone)[0].text).toContain('17.11.2026 בשעה 16:00');
    expect(staffRemindersFor(phone)).toHaveLength(1);
  });

  test('explicit cancellation → appointment and reminders invalidated, queue cleared, manager told once', async () => {
    const phone = await reminded();
    const aptId = openApt(phone).id;
    const r = await say(phone, 'אני רוצה לבטל את השיחה');
    expect(r.route).toBe('post_call_avail_cancelled');
    expect(aptStore.get(aptId).status).toBe('cancelled');
    expect(aptStore.get(aptId).cancelledBy).toBe('prospect');
    expect(openApt(phone)).toBeNull();
    expect(store.getLead(phone).status).toBe('call_cancelled');
    expect(await panelRow(phone)).toBeNull();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/ביטל\/ה את בקשת השיחה/);
    clearOut();
    setNow(il(2026, 11, 16, 13, 50));
    await worker.runCycle(store);
    expect(textsTo(phone)).toHaveLength(0);
    expect(staffRemindersFor(phone)).toHaveLength(0);
  });

  test('cancellation before any reminder also works; an unrelated "לא רוצה" sentence does not cancel', async () => {
    const phone = await leadWithCallback();
    clearOut();
    const q = await say(phone, 'אני לא רוצה פילאטיס על מזרן, יש לכם רק מכשירים נכון? ומה עם חניה באזור?');
    expect(q.route).toBe('post_call_staff_hold');
    expect(openApt(phone)).toBeTruthy();
    const c = await say(phone, 'לבטל בבקשה');
    expect(c.route).toBe('post_call_avail_cancelled');
    expect(openApt(phone)).toBeNull();
  });

  test('silence → availability stays unconfirmed', async () => {
    const phone = await reminded();
    setNow(il(2026, 11, 16, 13, 58));
    await worker.runCycle(store);
    expect(openApt(phone).prospectAvailability).toBeNull();
    expect(alerts()).toHaveLength(0);
    expect((await panelRow(phone)).apt.prospectReminderSent).toBe(true);
  });

  test('late "כן" (after the call time) is not recorded as confirmation of a future call', async () => {
    const phone = await reminded();
    setNow(il(2026, 11, 16, 15, 10));                         // 70 min after the call time
    const r = await say(phone, 'כן');
    expect(r.route).toBe('post_call_avail_late');
    expect(openApt(phone).prospectAvailability).toBeNull();
    expect(lastTo(phone)).toMatch(/כבר עבר/);
    expect(lastTo(phone)).not.toMatch(/תודה על האישור|נדבר/);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].subject).toMatch(/תשובה מאוחרת/);
    // A second late "כן" adds nothing.
    await say(phone, 'כן');
    expect(alerts()).toHaveLength(1);
    expect(textsTo(phone)).toHaveLength(1);
  });

  test('a brief acknowledgement that is not a reply to a reminder stays silent', async () => {
    const phone = await leadWithCallback();
    clearOut();
    const r = await say(phone, 'תודה');
    expect(r.route).toBe('post_call_silent');
    expect(mockOut.texts).toHaveLength(0);
    expect(alerts()).toHaveLength(0);
    expect(openApt(phone).prospectAvailability).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('8. Human ownership, release and opt-out are preserved', () => {
  test('takeover: no bot reply, no prospect reminder; staff still reminded; staff actions keep ownership; release restores', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-14:00' });
    const apt = openApt(phone);
    const t = await post(`/api/leads/${phone}/takeover`, { reason: 'manual', staffName: 'eden' });
    expect(t.body.status).toBe('human_owns');
    clearOut();

    const r = await say(phone, 'מחר ב-16:00');                // would otherwise reschedule
    expect(r.route).toBe('human_owns_hold');
    expect(mockOut.texts).toHaveLength(0);
    expect(openApt(phone).scheduledAt.toISOString()).toBe(il(2026, 11, 16, 14).toISOString());
    expect((await panelRow(phone)).humanOwned).toBe(true);    // still visible in the queue

    await post(`/api/admin/appointments/${apt.id}/confirm`);
    expect(store.getLead(phone).status).toBe('human_owns');   // not overridden
    expect(aptStore.get(apt.id).status).toBe('confirmed');

    setNow(il(2026, 11, 16, 13, 35));
    await worker.runCycle(store);
    expect(textsTo(phone)).toHaveLength(0);                   // no automated prospect message
    expect(staffRemindersFor(phone)).toHaveLength(1);

    const rel = await post(`/api/leads/${phone}/release`, {});
    expect(rel.body.status).toBe('call_scheduled');           // reflects the staff approval
    const rel2 = await post(`/api/leads/${phone}/release`, {});
    expect(rel2.body.unchanged).toBe(true);                   // idempotent
    expect(store.getLead(phone).status).toBe('call_scheduled');
  });

  test('opt-out during an open callback: one acknowledgement, callback closed, nothing further', async () => {
    const phone = await leadWithCallback({ timeText: 'היום ב-14:00' });
    const aptId = openApt(phone).id;
    clearOut();
    await say(phone, 'הסר אותי');
    expect(store.getLead(phone).status).toBe('opted_out');
    expect(aptStore.get(aptId).status).toBe('cancelled');
    expect(textsTo(phone)).toHaveLength(1);
    expect(textsTo(phone)[0].text).toMatch(/הסרנו אותך/);
    clearOut();
    const r = await say(phone, 'מחר ב-10');
    expect(r.route).toBe('opted_out_silent');
    expect(textsTo(phone)).toHaveLength(0);
    setNow(il(2026, 11, 16, 13, 35));
    await worker.runCycle(store);
    expect(textsTo(phone)).toHaveLength(0);
    expect(staffRemindersFor(phone)).toHaveLength(0);
    expect(await panelRow(phone)).toBeNull();
  });

  test('opted-out lead cannot be pulled back into a callback by a request', async () => {
    const phone = await newLead();
    await say(phone, 'הסר אותי');
    clearOut();
    const r = await say(phone, 'תתקשרו אליי מחר ב-10');
    expect(r.route).toBe('opted_out_silent');
    expect(openApt(phone)).toBeNull();
    expect(mockOut.texts).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('9. Historical data is never guessed at', () => {
  test('a corrupt historical callTimeGivenAt is preserved, flagged, and not "repaired" on startup', async () => {
    const phone = await leadWithCallback();
    const CORRUPT = '+058838-04-21T11:50:00.000Z';
    // Reproduce the historical record shape on disk (written by the old double-×1000 bug).
    const leadsFile = path.join(DATA_DIR, 'leads_persist.json');
    require('../utils/persist').saveLeads(store);
    const snap = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    const entry = snap.leads.find(([k]) => k === phone)[1];
    entry.meta.callTimeGivenAt = CORRUPT;
    entry.meta.qualData.callTimeGivenAt = CORRUPT;
    entry.meta.callbackRequestedAt = '2026-11-13T17:18:07.671Z';
    fs.writeFileSync(leadsFile, JSON.stringify(snap));
    const scheduledBefore = openApt(phone).scheduledAt.toISOString();

    restart();
    const m = store.getLead(phone).meta;
    expect(m.callTimeGivenAt).toBe(CORRUPT);                  // untouched
    expect(m.qualData.callTimeGivenAt).toBe(CORRUPT);
    expect(Object.keys(m).some(k => /corrupt_bak|_flagged/.test(k))).toBe(false);
    expect(openApt(phone).scheduledAt.toISOString()).toBe(scheduledBefore);
    const row = await panelRow(phone);
    expect(row.flags).toContain('call_time_timestamp_invalid_review');
    expect(row.apt.scheduledLabel).toBe('יום שלישי, 17.11.2026 בשעה 10:30');   // display from scheduledAt

    // A NEW request starts a clean cycle; the old cycle's values and provider ids are archived verbatim.
    await post(`/api/admin/appointments/${openApt(phone).id}/complete`, {});
    await say(phone, 'אפשר שיחזרו אליי מחר ב-12:00?');
    const m2 = store.getLead(phone).meta;
    expect(new Date(m2.callTimeGivenAt).getUTCFullYear()).toBe(2026);
    const archived = m2.closingSummaryHistory.at(-1);
    expect(archived.callTimeGivenAt).toBe(CORRUPT);
    expect(archived.prospectIdMessage).toMatch(/^MSG_/);
    expect(archived.managerIdMessage).toMatch(/^MGR_/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('10. Crash recovery and startup retry (real startup routine)', () => {
  const leadsOnDisk = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'leads_persist.json'), 'utf8'));
  const metaOnDisk  = phone => leadsOnDisk().leads.find(([k]) => k === phone)?.[1]?.meta ?? {};

  test('process dies mid-send → state is "uncertain" after restart; nothing is resent automatically', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    await say(phone, 'מחר ב-10:30');
    clearOut();

    // The prospect send never returns (provider hang) and the process is "killed".
    mockOut.hangTextTo = phone;
    say(phone, 'דנה').catch(() => {});                         // deliberately not awaited
    const { waitFor } = require('./helpers/isolated_env.cjs');
    const inFlight = await waitFor(() => metaOnDisk(phone).closingSummaryProspectState === 'in_flight', { timeoutMs: 5000 });
    expect(inFlight).toBe(true);                               // the marker is durable BEFORE the send returns
    mockOut.hangTextTo = null;

    restart();                                                 // crash + new process
    const rec = app._recoverClosingSummaries();
    await rec.retries;
    expect(rec.uncertain).toBe(1);
    const m = store.getLead(phone).meta;
    expect(m.closingSummaryProspectState).toBe('uncertain');
    expect(m.closingSummaryManagerState).toBe('uncertain');
    expect(summaries()).toHaveLength(0);                       // no automatic resend
    expect(textsTo(phone)).toHaveLength(0);
    expect((await panelRow(phone)).flags).toContain('summary_send_uncertain_review');

    // The lead repeats the name: still nothing automatic.
    await say(phone, 'דנה');
    expect(summaries()).toHaveLength(0);
    expect(textsTo(phone).filter(t => /קיבלנו את בקשת השיחה/.test(t.text))).toHaveLength(0);

    // A second startup does not escalate 'uncertain' into a retry either.
    restart();
    await app._recoverClosingSummaries().retries;
    expect(summaries()).toHaveLength(0);
  });

  test('a definitively failed manager summary is retried once at startup — and only while the callback is still ahead', async () => {
    const phone = await newLead();
    await say(phone, 'אשמח שיחזרו אליי');
    await say(phone, 'היום ב-14:00');
    mockOut.failManager = true;
    await say(phone, 'מיכל');
    mockOut.failManager = false;
    expect(store.getLead(phone).meta.closingSummaryManagerState).toBe('failed');

    const expiredPhone = await newLead();
    await say(expiredPhone, 'אשמח שיחזרו אליי');
    await say(expiredPhone, 'היום ב-11:00');
    mockOut.failManager = true;
    await say(expiredPhone, 'רונית');
    mockOut.failManager = false;

    setNow(il(2026, 11, 16, 12, 0));                           // 11:00 has passed, 14:00 has not
    restart();
    clearOut();
    await app._recoverClosingSummaries().retries;
    const sent = summaries();
    expect(sent.filter(a => a.body.includes('מיכל'))).toHaveLength(1);
    expect(sent.filter(a => a.body.includes('רונית'))).toHaveLength(0);   // expired: not replayed
    expect(textsTo(phone)).toHaveLength(0);                    // prospect already had the summary

    restart();
    clearOut();
    await app._recoverClosingSummaries().retries;
    expect(summaries()).toHaveLength(0);                       // not retried twice
  });
});
