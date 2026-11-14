'use strict';
/**
 * Regression tests for the Nofar / Neta / Yifat member-conversation incident.
 *
 * Root causes found and fixed:
 *   1. PAYMENT_RE: "ביטלתי" contains "ביט" (Bit app) → false payment ACK to Neta.
 *      Fix: added (?<![א-ת])ביט(?![א-ת]) word-boundary lookbehind/lookahead.
 *
 *   2. Payment check ran BEFORE human_owns gate → manual staff sends could not
 *      suppress payment ACK even if human_owns was set.
 *      Fix: payment block now skips when status is human_owns or opted_out.
 *
 *   3. reschedule intent matched "לא הצלחתי" (missed-class apology) → Yifat got
 *      a scheduling question instead of AI context handling.
 *      Fix: removed "לא הצלחתי" / "פספסנו" from reschedule pattern.
 *
 *   4. Dashboard manual send (/api/whatsapp/threads/:phone/send) did not set
 *      human_owns → bot continued to reply after staff intervened via panel.
 *      Fix: added _applyStaffTakeover() call in dashboard send handler.
 *
 * Tests verify:
 *   A. "ביטלתי" does not trigger payment ACK (Neta scenario)
 *   B. human_owns blocks payment ACK even for genuine payment text (gate order)
 *   C. "לא הצלחתי להגיע" does not trigger scheduling template (Yifat scenario)
 *   D. Dashboard manual send sets human_owns; subsequent inbound gets hold route
 *   E. All automated agents blocked after human_owns is set
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
    sendText: jest.fn((to, text) => {
      mockSentTexts.push({ to, text });
      return Promise.resolve({ idMessage: `MSG_${Date.now()}_${Math.random().toString(36).slice(2,6)}` });
    }),
    alertOwner: jest.fn((subject, body, opts = {}) => {
      mockSentAlerts.push({ subject, body });
      return Promise.resolve({ results: [{ phone: '972547598919', idMessage: `MGR_${Date.now()}`, skipped: false, error: null }] });
    }),
    sendFileByUrl: jest.fn(() => Promise.resolve()),
    getAdminPhones: jest.fn(() => ['972547598919']),
  };
});

jest.mock('../utils/member_cache', () => ({
  isConfirmed:       jest.fn(() => false),
  isFresh:           jest.fn(() => false),
  getEntry:          jest.fn(() => null),
  markConfirmed:     jest.fn(),
  invalidate:        jest.fn(),
  size:              jest.fn(() => 0),
  flush:             jest.fn(),
  seedFromArbox:     jest.fn(() => Promise.resolve({ seeded: 0 })),
  isKnownMemberFile: jest.fn(() => false),
}));

jest.mock('../utils/operational_interceptor', () => ({
  checkOperationalIntent: jest.fn(() => ({ blocked: false })),
}));

jest.mock('../utils/studio_assets', () => ({
  getAssets: jest.fn(() => ({ wazeUrl: null, timetableUrl: null, timetableImageExt: 'png', timetable2ImageExt: 'png' })),
  getTimetableImagePath:  jest.fn(() => null),
  getTimetable2ImagePath: jest.fn(() => null),
}));

jest.mock('../utils/demo_capture', () => ({
  record: jest.fn(), isActive: jest.fn(() => false),
}));

jest.mock('../utils/persist', () => ({
  loadLeads: jest.fn(), loadInbox:  jest.fn(), saveLeads: jest.fn(),
  saveInbox: jest.fn(), saveAll:    jest.fn(),
}));

jest.mock('../services/arbox.service', () => ({
  searchMemberByPhone:  jest.fn(() => Promise.resolve(null)),
  getActiveMemberships: jest.fn(() => Promise.resolve([])),
  getAttendanceHistory: jest.fn(() => Promise.resolve([])),
  getMembers:           jest.fn(() => Promise.resolve([])),
  getLeads:             jest.fn(() => Promise.resolve([])),
}));

jest.mock('../services/handoff.service', () => ({
  scoreReadiness:       jest.fn(() => ({ level: 'MEDIUM', evidence: 'test' })),
  generateHandoffBrief: jest.fn(() => Promise.resolve({ briefData: {}, readiness: { level: 'MEDIUM' } })),
}));

jest.mock('../services/memory.service', () => ({
  touchSession: jest.fn(), buildMemoryInjection: jest.fn(() => null),
  generateAndSaveSessionSummary: jest.fn(() => Promise.resolve()),
}));

jest.mock('../utils/phone_registry', () => ({
  init: jest.fn(() => Promise.resolve()),
  isMember: jest.fn(() => false),
  getAll: jest.fn(() => []),
  size: 0,
}));

jest.mock('../services/calendar.service', () => ({
  parseCallbackTime: jest.fn(() => null),
}));

jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn(() => Promise.resolve({
      choices: [{ message: { content: 'שלום, אני יכולה לעזור לך.' } }]
    })) } },
  }))
);

// ── Load store and app ─────────────────────────────────────────────────────────

const store   = require('../utils/lead_store');
const request = require('supertest');
const app     = require('../server');

const NETA_PHONE  = '972500000081';
const YIFAT_PHONE = '972500000082';
const NOFAR_PHONE = '972500000083';

function resetAll() {
  mockSentTexts.length  = 0;
  mockSentAlerts.length = 0;
  [NETA_PHONE, YIFAT_PHONE, NOFAR_PHONE].forEach(p => {
    store.upsertLead(p, { status: 'new', name: null, meta: {} });
  });
}

async function simulate(phone, text, name = 'Test') {
  const r = await request(app)
    .post('/api/whatsapp/simulate')
    .send({ from: phone, text, name, type: 'text' })
    .set('Content-Type', 'application/json');
  expect([200, 500]).toContain(r.status);
  await new Promise(res => setTimeout(res, 80));
  return r.body;
}

// ── A. Neta scenario: ביטלתי MUST NOT trigger payment ACK ─────────────────────

describe('A — Neta: "ביטלתי היום" is a cancellation, not a payment', () => {
  beforeEach(resetAll);

  test('ביטלתי היום → no payment ack sent, intent=cancellation', async () => {
    const r = await simulate(NETA_PHONE, 'ביטלתי היום');
    expect(r.route).not.toBe('payment_ack');
    // No payment-ack text should appear in any send
    const paymentAckText = 'קיבלנו את אישור התשלום';
    expect(mockSentTexts.some(s => s.text.includes(paymentAckText))).toBe(false);
  });

  test('שלחתי ביט → payment ack fires (genuine Bit payment)', async () => {
    const r = await simulate(NETA_PHONE, 'שלחתי ביט');
    expect(r.route).toBe('payment_ack');
    expect(mockSentTexts.some(s => s.text.includes('קיבלנו את אישור התשלום'))).toBe(true);
  });

  test('שלמתי → payment ack fires', async () => {
    const r = await simulate(NETA_PHONE, 'שלמתי');
    expect(r.route).toBe('payment_ack');
  });
});

// ── B. human_owns blocks payment ACK ──────────────────────────────────────────

describe('B — human_owns gates payment ACK', () => {
  beforeEach(resetAll);

  test('staff owns conversation → payment ack suppressed even for genuine payment text', async () => {
    // Staff manually sends via dashboard → human_owns is set
    const dashRes = await request(app)
      .post(`/api/whatsapp/threads/${NETA_PHONE}/send`)
      .send({ text: 'שלום נטע, בדיוק ראיתי את ההודעה', name: 'Neta' })
      .set('Content-Type', 'application/json');
    expect(dashRes.status).toBe(200);

    // Verify human_owns was set
    const status = store.getLead(NETA_PHONE)?.status;
    expect(status).toBe('human_owns');

    mockSentTexts.length = 0;  // reset send log

    // Now send genuine payment message
    const r = await simulate(NETA_PHONE, 'שלחתי ביט');
    expect(r.route).toBe('human_owns_hold');  // blocked by ownership
    expect(mockSentTexts.some(s => s.text.includes('קיבלנו את אישור התשלום'))).toBe(false);
  });

  test('without human_owns, genuine payment fires normally', async () => {
    const r = await simulate(NETA_PHONE, 'שלחתי ביט');
    expect(r.route).toBe('payment_ack');
  });
});

// ── C. Yifat scenario: missed-class apology MUST NOT trigger scheduling template ─

describe('C — Yifat: "לא הצלחתי להגיע" is attendance, not reschedule', () => {
  beforeEach(resetAll);

  test('לא הצלחתי להגיע ולא לבטל → NOT classified as reschedule', async () => {
    const r = await simulate(YIFAT_PHONE, 'לא הצלחתי להגיע ולא לבטל');
    // Must NOT receive the deterministic scheduling template
    const schedulingTemplate = 'באיזו שעה או יום יהיה לך נוח? 🗓️';
    expect(mockSentTexts.some(s => s.text.includes(schedulingTemplate))).toBe(false);
    // Route should not be a reschedule ack
    expect(r.route).not.toMatch(/reschedule/);
  });

  test('לשנות שעה → still classified as reschedule (explicit request)', async () => {
    const r = await simulate(YIFAT_PHONE, 'רוצה לשנות שעה');
    // Classification is unchanged: an explicit request IS a reschedule intent.
    expect(r.intent).toBe('reschedule');
    // Behaviour change: a contact with no callback on record is no longer put into
    // "awaiting callback time" by this sentence alone (that happened before the
    // ownership gates and turned the next message into a callback). Nothing is created.
    const lead = store.getLead(YIFAT_PHONE);
    expect(lead?.meta?.awaitingCallbackTime).not.toBe(true);
    expect(require('../utils/appointment_store').getByPhone(YIFAT_PHONE)).toHaveLength(0);
  });
});

// ── D. Dashboard manual send sets human_owns ──────────────────────────────────

describe('D — Dashboard manual send establishes human_owns', () => {
  beforeEach(resetAll);

  test('POST /threads/:phone/send → human_owns set immediately', async () => {
    expect(store.getLead(NOFAR_PHONE)?.status).not.toBe('human_owns');

    await request(app)
      .post(`/api/whatsapp/threads/${NOFAR_PHONE}/send`)
      .send({ text: 'היי נופר מה קורה?' })
      .set('Content-Type', 'application/json');

    expect(store.getLead(NOFAR_PHONE)?.status).toBe('human_owns');
  });

  test('after dashboard send, inbound message is held (all agents blocked)', async () => {
    await request(app)
      .post(`/api/whatsapp/threads/${NOFAR_PHONE}/send`)
      .send({ text: 'היי נופר מה קורה?' })
      .set('Content-Type', 'application/json');

    mockSentTexts.length = 0;
    const r = await simulate(NOFAR_PHONE, 'סליחה לא ראיתי ופספסתי את השעה');
    expect(r.route).toBe('human_owns_hold');
    expect(mockSentTexts).toHaveLength(0);  // no bot reply
  });
});

// ── E. All agents blocked after human_owns ────────────────────────────────────

describe('E — All automated agents respect human_owns', () => {
  beforeEach(() => {
    resetAll();
    // Set human_owns directly
    [NETA_PHONE, YIFAT_PHONE, NOFAR_PHONE].forEach(p =>
      store.upsertLead(p, { status: 'human_owns', meta: {} })
    );
  });

  test('general message → human_owns_hold (Barak blocked)', async () => {
    const r = await simulate(NETA_PHONE, 'שלום מחפשת שיעורים');
    expect(r.route).toBe('human_owns_hold');
    expect(mockSentTexts).toHaveLength(0);
  });

  test('scheduling message → human_owns_hold (Tomer blocked)', async () => {
    const r = await simulate(YIFAT_PHONE, 'מה יש מחר?');
    expect(r.route).toBe('human_owns_hold');
    expect(mockSentTexts).toHaveLength(0);
  });

  test('cancellation message → human_owns_hold (payment ACK blocked)', async () => {
    const r = await simulate(NETA_PHONE, 'ביטלתי היום');
    expect(r.route).toBe('human_owns_hold');
    expect(mockSentTexts.some(s => s.text.includes('קיבלנו את אישור התשלום'))).toBe(false);
  });

  test('release ownership → automation resumes', async () => {
    // Release human_owns
    store.upsertLead(NETA_PHONE, { status: 'new', meta: {} });

    const r = await simulate(NETA_PHONE, 'מה יש מחר?');
    expect(r.route).not.toBe('human_owns_hold');
    expect(r.route).not.toBe('');
  });
});
