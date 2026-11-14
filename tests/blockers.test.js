'use strict';
/**
 * blockers.test.js
 *
 * Tests for the three release blockers identified in the audit:
 *
 * A. Gate 3b: Short-reply guard bypass — booking commitments must be stripped
 *    even when the stripped result is shorter than 10 characters or empty.
 *    Empty result gets a safe fallback, never silent abandonment.
 *
 * B. Explicit calendar dates: parseHebrewTimeLocal must resolve "15 בנובמבר"
 *    and "15.11.2026" before the bare-hour fallback, with year rollover, leap
 *    year validation, Asia/Jerusalem conversion and invalid-date rejection.
 *
 * C. Staff confirmation lifecycle:
 *    - POST /api/admin/appointments/:id/confirm upgrades callback_pending → confirmed
 *      and lead status → call_scheduled.
 *    - Idempotency: re-confirming returns unchanged:true without mutation.
 *    - Stop-statuses (opted_out, human_owns) are not overridden.
 *    - Reminder eligibility: confirmed apts are due for getDueForReminder,
 *      callback_pending apts are due for getPendingCallbacksDueForReminder.
 *    - no-answer: sets status=no_answer + noShowAlerted=true (prevents automated
 *      "פספסנו" message). Idempotent.
 *    - complete, cancel: idempotent.
 *    - Startup migration: corrupt callTimeGivenAt (+058838...) repaired from
 *      callbackRequestedAt.
 */

process.env.TEST_MODE           = 'true';
process.env.WHATSAPP_AUTO_REPLY = 'true';
process.env.NODE_ENV            = 'test';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockSentTexts  = [];
const mockSentAlerts = [];

jest.mock('../services/whatsapp.service', () => {
  const actual = jest.requireActual('../services/whatsapp.service');
  return {
    ...actual,
    sendText:      jest.fn((to, text) => { mockSentTexts.push({ to, text }); return Promise.resolve({ idMessage: `MSG_${Date.now()}` }); }),
    alertOwner:    jest.fn((subject, body) => { mockSentAlerts.push({ subject, body }); return Promise.resolve({ results: [{ phone: '972547598919', idMessage: `MGR_${Date.now()}` }] }); }),
    sendFileByUrl: jest.fn(() => Promise.resolve()),
    getAdminPhones: jest.fn(() => ['972547598919']),
  };
});

jest.mock('../utils/member_cache', () => ({
  isConfirmed: jest.fn(() => false), isFresh: jest.fn(() => false),
  getEntry: jest.fn(() => null), markConfirmed: jest.fn(),
  invalidate: jest.fn(), size: jest.fn(() => 0), flush: jest.fn(),
  seedFromArbox: jest.fn(() => Promise.resolve({ seeded: 0 })),
  isKnownMemberFile: jest.fn(() => false),
}));
jest.mock('../utils/operational_interceptor', () => ({ checkOperationalIntent: jest.fn(() => ({ blocked: false })) }));
jest.mock('../utils/studio_assets', () => ({
  getAssets: jest.fn(() => ({ wazeUrl: null, timetableUrl: null, timetableImageExt: 'png', timetable2ImageExt: 'png' })),
  getTimetableImagePath: jest.fn(() => null), getTimetable2ImagePath: jest.fn(() => null),
}));
jest.mock('../utils/demo_capture', () => ({ record: jest.fn(), isActive: jest.fn(() => false) }));
jest.mock('../utils/persist', () => ({
  loadLeads: jest.fn(), loadInbox: jest.fn(), saveLeads: jest.fn(), saveInbox: jest.fn(), saveAll: jest.fn(),
}));
jest.mock('../services/arbox.service', () => ({
  searchMemberByPhone: jest.fn(() => Promise.resolve(null)),
  getActiveMemberships: jest.fn(() => Promise.resolve([])),
  getAttendanceHistory: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../services/handoff.service', () => ({
  scoreReadiness:       jest.fn(() => ({ level: 'MEDIUM', evidence: 'test' })),
  generateHandoffBrief: jest.fn(() => Promise.resolve({ briefData: {}, readiness: { level: 'MEDIUM' }, briefLines: 'brief' })),
}));
jest.mock('../services/memory.service', () => ({
  touchSession: jest.fn(), buildMemoryInjection: jest.fn(() => null),
  generateAndSaveSessionSummary: jest.fn(() => Promise.resolve()),
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
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn(() => Promise.resolve({ choices: [{ message: { content: 'mock reply' } }] })) } },
})));
jest.mock('../services/calendar.service', () => ({
  parseCallbackTime:    jest.fn(() => null),
  parseHebrewTimeLocal: jest.requireActual('../services/calendar.service').parseHebrewTimeLocal,
  parseHebrewTime:      jest.fn((t, ref) => Promise.resolve(new Date((ref ?? new Date()).getTime() + 24 * 3600 * 1000))),
  createCalendarEntry:  jest.fn(() => Promise.resolve({ scheduledAt: new Date(Date.now() + 24 * 3600 * 1000), icsContent: null, googleEventId: null })),
  cancelCalendarEvent:  jest.fn(() => Promise.resolve(false)),
  notifyAllActiveStaff: jest.fn(() => Promise.resolve({ notified: 0, total: 0 })),
  notifyEden:           jest.fn(() => Promise.resolve({ notified: 0 })),
}));

// ── Load modules ──────────────────────────────────────────────────────────────
const store    = require('../utils/lead_store');
const aptStore = require('../utils/appointment_store');
const request  = require('supertest');
const app      = require('../server');

const TEST_PHONE = '972500000055';
const PAST_DATE  = new Date(Date.now() - 2 * 3600 * 1000); // 2 hours ago
const FUTURE_30  = new Date(Date.now() + 25 * 60 * 1000);  // 25 min from now

function resetState() {
  mockSentTexts.length = 0; mockSentAlerts.length = 0;
  store.upsertLead(TEST_PHONE, { status: 'new', name: null, messageCount: 0, meta: {} });
  aptStore.getByPhone(TEST_PHONE).forEach(a => aptStore.update(a.id, { status: 'cancelled' }));
}

// ── A. Gate 3b guard ──────────────────────────────────────────────────────────

describe('Gate 3b — short-reply bypass closed', () => {
  const { postProcessReply } = require('../agents/lead_agent');
  const assets = { wazeUrl: null };

  test('single-sentence commitment stripped; fallback = ask for name when callTimeGiven set', () => {
    const q = { callTimeGiven: 'מחר ב11', confirmedName: null };
    const r = postProcessReply('הצוות יצור קשר מחר ב11!', q, assets);
    expect(r).not.toMatch(/יצור קשר/);
    // safe fallback: ask for name
    expect(r).toMatch(/קוראים לך|שמך/i);
  });

  test('single-sentence commitment stripped; fallback = ask for time when callTimeGiven absent', () => {
    const q = { callTimeGiven: null, confirmedName: null };
    const r = postProcessReply('הצוות יצור קשר ב19:00!', q, assets);
    expect(r).not.toMatch(/יצור קשר/);
    // safe fallback: ask when convenient
    expect(r).toMatch(/מתי|שעה|נוח/i);
  });

  test('bare commitment sentence stripped', () => {
    const q = { callTimeGiven: null, confirmedName: null };
    const r = postProcessReply('הצוות יצור קשר ב19:00', q, assets);
    expect(r).not.toMatch(/יצור קשר/);
  });

  test('short prefix preserved after stripping; not replaced by fallback', () => {
    const q = { callTimeGiven: null, confirmedName: null };
    const r = postProcessReply('מצוין! 😊 הצוות יצור קשר ב19:00', q, assets);
    expect(r).not.toMatch(/יצור קשר/);
    // "מצוין! 😊" should survive as-is (prefix before the commitment)
    expect(r).toContain('מצוין');
  });

  test('long reply: commitment stripped, valuable remainder kept', () => {
    const q = { callTimeGiven: null, confirmedName: null };
    const r = postProcessReply(
      'שמחתי לשמוע שמתאים לך פילאטיס! הצוות יצור קשר ב19:00 ומה שם שלך?', q, assets);
    expect(r).not.toMatch(/יצור קשר/);
    expect(r).toMatch(/פילאטיס/);
  });

  test('commitment is preserved ONLY when a persisted future appointment exists', () => {
    const q = { callTimeGiven: 'מחר ב11', confirmedName: 'אריק' };
    const text = 'מצוין אריק — הצוות יצור קשר מחר ב11 😊';
    // Persisted appointment (fact passed in from appointment_store) → truthful, kept.
    expect(postProcessReply(text, q, assets, { hasPersistedCallback: true })).toMatch(/יצור קשר/);
    // Flags alone (callTimeGiven + confirmedName) are NOT proof of a booking → stripped.
    expect(postProcessReply(text, q, assets)).not.toMatch(/יצור קשר/);
    expect(postProcessReply(text, q, assets, { hasPersistedCallback: false })).not.toMatch(/יצור קשר/);
  });

  test('an offer is kept; a promise with a question tacked on is not', () => {
    const q = { callTimeGiven: null, confirmedName: null };
    expect(postProcessReply('רוצה שנציג מהסטודיו יחזור אליך לשיחה קצרה?', q, assets)).toMatch(/יחזור אליך/);
    expect(postProcessReply('אשמח שנחזור אליך טלפונית — מתי נוח לך?', q, assets)).toMatch(/נחזור אליך/);
    expect(postProcessReply('נציג יחזור אליך מחר, בסדר?', q, assets)).not.toMatch(/יחזור אליך/);
    expect(postProcessReply('קבענו לך שיחה למחר ב-10.', q, assets)).not.toMatch(/קבענו/);
  });
});

// ── B. Explicit date parsing ──────────────────────────────────────────────────

describe('parseHebrewTimeLocal — explicit calendar dates', () => {
  const { parseHebrewTimeLocal } = require('../services/calendar.service');
  const ref = new Date('2026-11-13T19:00:00+02:00'); // 7pm IL

  test('"15 בנובמבר בשעה 10" → 2026-11-15T08:00:00.000Z', () => {
    const r = parseHebrewTimeLocal('15 בנובמבר בשעה 10', ref);
    expect(r?.toISOString()).toBe('2026-11-15T08:00:00.000Z');
  });

  test('"15.11.2026 בשעה 10:00" → 2026-11-15T08:00:00.000Z', () => {
    const r = parseHebrewTimeLocal('15.11.2026 בשעה 10:00', ref);
    expect(r?.toISOString()).toBe('2026-11-15T08:00:00.000Z');
  });

  test('year rollover: "5 בינואר" past → 2027', () => {
    const r = parseHebrewTimeLocal('5 בינואר בשעה 15', ref);
    expect(r?.getUTCFullYear()).toBe(2027);
    expect(r?.getUTCMonth()).toBe(0);  // January
    expect(r?.getUTCDate()).toBe(5);
  });

  test('invalid date: "30 בפברואר" → null', () => {
    const r = parseHebrewTimeLocal('30 בפברואר', ref);
    expect(r).toBeNull();
  });

  test('invalid non-leap year: "29 בפברואר 2027" → null', () => {
    const r = parseHebrewTimeLocal('29 בפברואר 2027', ref);
    expect(r).toBeNull();
  });

  test('valid leap year: "29 בפברואר 2028" → valid date', () => {
    const r = parseHebrewTimeLocal('29 בפברואר 2028', ref);
    expect(r).not.toBeNull();
    expect(r?.getUTCFullYear()).toBe(2028);
    expect(r?.getUTCMonth()).toBe(1);
    expect(r?.getUTCDate()).toBe(29);
  });

  test('existing day-name patterns still work', () => {
    const r = parseHebrewTimeLocal('ראשון ב11', ref);
    expect(r?.toISOString()).toBe('2026-11-15T09:00:00.000Z');
  });

  test('bare affirmation "כן" → null', () => {
    expect(parseHebrewTimeLocal('כן', ref)).toBeNull();
  });

  test('callTimeGivenAt anchor: same rawTime resolves differently with different ref', () => {
    // Nov 13 at 23:50 IL → "מחר ב12" = Nov 14
    const lateRef  = new Date('2026-11-13T21:50:00+02:00');
    // Nov 14 at 00:10 IL → "מחר ב12" = Nov 15 (different day if wrong anchor)
    const nextDay  = new Date('2026-11-14T22:10:00+02:00');
    const r1 = parseHebrewTimeLocal('מחר ב12', lateRef);
    const r2 = parseHebrewTimeLocal('מחר ב12', nextDay);
    expect(r1?.getUTCDate()).toBe(14); // Nov 14 ✓
    expect(r2?.getUTCDate()).toBe(15); // Nov 15 — wrong if anchor is not preserved
  });
});

// ── C. Staff confirmation lifecycle ──────────────────────────────────────────

describe('Staff confirmation lifecycle', () => {
  beforeEach(resetState);

  function makeCallbackPending(scheduledAt) {
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, leadName: 'דנה', rawTime: 'ראשון ב11',
      scheduledAt: scheduledAt ?? FUTURE_30, status: 'callback_pending',
    });
    return apt;
  }

  test('confirm: callback_pending → confirmed + lead → call_scheduled', async () => {
    store.upsertLead(TEST_PHONE, { status: 'callback_requested', meta: {} });
    const apt = makeCallbackPending();

    const res = await request(app).post(`/api/admin/appointments/${apt.id}/confirm`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.appointment.status).toBe('confirmed');

    const lead = store.getLead(TEST_PHONE);
    expect(lead?.status).toBe('call_scheduled');
  });

  test('confirm: idempotent — re-confirming returns unchanged:true', async () => {
    store.upsertLead(TEST_PHONE, { status: 'callback_requested', meta: {} });
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, leadName: 'דנה', rawTime: 'ראשון ב11',
      scheduledAt: FUTURE_30, status: 'confirmed',
    });
    const res = await request(app).post(`/api/admin/appointments/${apt.id}/confirm`).send({});
    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
  });

  test('confirm: human_owns lead status is NOT overridden', async () => {
    store.upsertLead(TEST_PHONE, { status: 'human_owns', meta: {} });
    const apt = makeCallbackPending();
    await request(app).post(`/api/admin/appointments/${apt.id}/confirm`).send({});
    expect(store.getLead(TEST_PHONE)?.status).toBe('human_owns');
  });

  test('confirm: opted_out lead status is NOT overridden', async () => {
    store.upsertLead(TEST_PHONE, { status: 'opted_out', meta: {} });
    const apt = makeCallbackPending();
    await request(app).post(`/api/admin/appointments/${apt.id}/confirm`).send({});
    expect(store.getLead(TEST_PHONE)?.status).toBe('opted_out');
  });

  // Changed requirement (was: "confirm resets reminderSent"): staff approval must
  // PRESERVE reminder records already sent for the same scheduled time — resetting them
  // caused a second reminder. End-to-end coverage: callback_lifecycle.test.js §5.
  test('confirm preserves reminder records already sent for the same time', async () => {
    store.upsertLead(TEST_PHONE, { status: 'callback_requested', meta: {} });
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'ראשון ב11', scheduledAt: FUTURE_30,
      status: 'callback_pending',
    });
    aptStore.update(apt.id, { reminderSent: true, reminderSentTo: ['972547598919'],
      prospectReminderSent: true, prospectReminderSentTo: 'MSG_X' });

    await request(app).post(`/api/admin/appointments/${apt.id}/confirm`).send({});

    const updated = aptStore.get(apt.id);
    expect(updated.status).toBe('confirmed');
    expect(updated.reminderSent).toBe(true);
    expect(updated.reminderSentTo).toEqual(['972547598919']);
    expect(updated.prospectReminderSent).toBe(true);
    expect(updated.prospectReminderSentTo).toBe('MSG_X');
    expect(aptStore.getDueForReminder(60 * 60 * 1000).some(a => a.id === apt.id)).toBe(false);
  });

  test('confirm is refused for closed or expired callbacks', async () => {
    for (const status of ['cancelled', 'completed', 'no_answer']) {
      const apt = aptStore.create({ leadPhone: TEST_PHONE, rawTime: 'x', scheduledAt: FUTURE_30, status });
      const res = await request(app).post(`/api/admin/appointments/${apt.id}/confirm`).send({});
      expect(res.status).toBe(409);
      expect(aptStore.get(apt.id).status).toBe(status);
    }
    const expired = aptStore.create({ leadPhone: TEST_PHONE, rawTime: 'x', scheduledAt: PAST_DATE, status: 'callback_pending' });
    const res = await request(app).post(`/api/admin/appointments/${expired.id}/confirm`).send({});
    expect(res.status).toBe(409);
    expect(aptStore.get(expired.id).status).toBe('callback_pending');
  });

  test('confirmed apt enters getDueForReminder window; callback_pending does not', () => {
    const confirmedApt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'now', scheduledAt: FUTURE_30, status: 'confirmed',
    });
    const pendingApt = aptStore.create({
      leadPhone: TEST_PHONE + '1', rawTime: 'now', scheduledAt: FUTURE_30, status: 'callback_pending',
    });

    const confirmedDue = aptStore.getDueForReminder(30 * 60 * 1000)
      .some(a => a.id === confirmedApt.id);
    const pendingDue = aptStore.getDueForReminder(30 * 60 * 1000)
      .some(a => a.id === pendingApt.id);

    expect(confirmedDue).toBe(true);
    expect(pendingDue).toBe(false);  // getPendingCallbacksDueForReminder handles this

    const pendingDue2 = aptStore.getPendingCallbacksDueForReminder(30 * 60 * 1000)
      .some(a => a.id === pendingApt.id);
    expect(pendingDue2).toBe(true);
  });

  // The automated no-show message is now impossible for telephone callbacks by
  // construction (getOverdue only returns in-person appointments), not via a flag.
  test('no-answer: sets no_answer status; no automated no-show can follow', async () => {
    store.upsertLead(TEST_PHONE, { status: 'call_scheduled', meta: {} });
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'ראשון ב11', scheduledAt: FUTURE_30, status: 'confirmed',
    });
    const sentBefore = mockSentTexts.length;
    const res = await request(app).post(`/api/admin/appointments/${apt.id}/no-answer`).send({ note: 'לא ענה' });
    expect(res.status).toBe(200);
    const updated = aptStore.get(apt.id);
    expect(updated.status).toBe('no_answer');
    expect(updated.noAnswerNote).toBe('לא ענה');
    expect(store.getLead(TEST_PHONE).status).toBe('call_no_answer');
    expect(aptStore.getOverdue(0).some(a => a.id === apt.id)).toBe(false);
    expect(mockSentTexts.length).toBe(sentBefore);            // nothing sent to the prospect
  });

  test('an overdue staff-confirmed telephone callback is never returned by getOverdue', () => {
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'past', scheduledAt: PAST_DATE, status: 'confirmed',
    });
    expect(aptStore.getOverdue(0).some(a => a.id === apt.id)).toBe(false);
  });

  test('no-answer: idempotent', async () => {
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'ראשון ב11', scheduledAt: FUTURE_30, status: 'no_answer',
    });
    const res = await request(app).post(`/api/admin/appointments/${apt.id}/no-answer`).send({});
    expect(res.body.unchanged).toBe(true);
  });

  test('complete: idempotent', async () => {
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'ראשון ב11', scheduledAt: FUTURE_30, status: 'completed',
    });
    const res = await request(app).post(`/api/admin/appointments/${apt.id}/complete`).send({});
    expect(res.body.unchanged).toBe(true);
  });

  test('cancel: idempotent', async () => {
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'ראשון ב11', scheduledAt: FUTURE_30, status: 'cancelled',
    });
    const res = await request(app).post(`/api/admin/appointments/${apt.id}/cancel`).send({});
    expect(res.body.unchanged).toBe(true);
  });

  test('no-answer apt is excluded from getOverdue (automated no-show pass skips it)', () => {
    const apt = aptStore.create({
      leadPhone: TEST_PHONE, rawTime: 'past', scheduledAt: PAST_DATE,
      status: 'no_answer',
    });
    aptStore.update(apt.id, { noShowAlerted: true });
    const overdue = aptStore.getOverdue(0);
    expect(overdue.some(a => a.id === apt.id)).toBe(false);
  });
});

