'use strict';
/**
 * booking_guard.test.js
 *
 * Two specific guards verified here:
 *
 * A. Gate 3b — hallucinated time commitment (callTimeGiven absent):
 *    AI reads "19:00" from conversation history and returns "הצוות יצור קשר ב19:00"
 *    even though qualData.callTimeGiven is not set and no appointment exists.
 *    Gate 3b must strip the commitment before it reaches the prospect.
 *
 * B. Real disk-write failure propagation (appointment_store):
 *    fs.writeFileSync throws for appointments.json → appointment_store.create() throws →
 *    name-capture path catches it → no prospect confirmation → manager still notified.
 *    This proves the in-memory object alone is never enough to authorise a booking confirmation.
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
const mockFailControl = { failNextText: false };

jest.mock('../services/whatsapp.service', () => {
  const actual = jest.requireActual('../services/whatsapp.service');
  return {
    ...actual,
    sendText: jest.fn((to, text) => {
      if (mockFailControl.failNextText) { mockFailControl.failNextText = false; return Promise.reject(new Error('simulated_send_fail')); }
      const id = `MSG_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      mockSentTexts.push({ to, text, id });
      return Promise.resolve({ idMessage: id });
    }),
    alertOwner: jest.fn((subject, body, opts = {}) => {
      const phones = ['972547598919'];
      const results = phones.map(phone => ({
        phone,
        skipped: opts?.skipPhones instanceof Set && opts.skipPhones.has(phone),
        idMessage: `MGR_${Date.now()}`,
        error: null,
      })).map(r => r.skipped ? { ...r, idMessage: null } : r);
      mockSentAlerts.push({ subject, body });
      return Promise.resolve({ results });
    }),
    sendFileByUrl:  jest.fn(() => Promise.resolve()),
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

jest.mock('../utils/operational_interceptor', () => ({
  checkOperationalIntent: jest.fn(() => ({ blocked: false })),
}));

jest.mock('../utils/studio_assets', () => ({
  getAssets: jest.fn(() => ({
    wazeUrl: 'https://waze.com/ul?q=test', timetableUrl: null,
    timetableImageExt: 'png', timetable2ImageExt: 'png',
  })),
  getTimetableImagePath:  jest.fn(() => null),
  getTimetable2ImagePath: jest.fn(() => null),
}));

jest.mock('../utils/demo_capture', () => ({ record: jest.fn(), isActive: jest.fn(() => false) }));

jest.mock('../utils/persist', () => ({
  loadLeads: jest.fn(), loadInbox: jest.fn(),
  saveLeads: jest.fn(), saveInbox: jest.fn(), saveAll: jest.fn(),
}));

jest.mock('../services/arbox.service', () => ({
  searchMemberByPhone:  jest.fn(() => Promise.resolve(null)),
  getActiveMemberships: jest.fn(() => Promise.resolve([])),
  getAttendanceHistory: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../services/handoff.service', () => ({
  scoreReadiness:       jest.fn(() => ({ level: 'MEDIUM', evidence: 'test' })),
  generateHandoffBrief: jest.fn(() => Promise.resolve({ briefData: {}, readiness: { level: 'MEDIUM' } })),
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
  init: jest.fn(() => Promise.resolve()), isMember: jest.fn(() => false),
  getAll: jest.fn(() => []), size: 0,
}));

// OpenAI mock with controllable reply content.
// mockOpenAIReply is a module-level variable captured by the closure — tests set it
// before the call and reset it after.
let mockOpenAIReply = 'mock reply';
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn(() => Promise.resolve({
      choices: [{ message: { content: mockOpenAIReply } }],
    })) } },
  }))
);

jest.mock('../services/calendar.service', () => ({
  parseCallbackTime:    jest.fn(() => null),
  parseHebrewTimeLocal: jest.fn((rawText, ref) => {
    if (!rawText) return null;
    if (/\d|מחר|היום|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת/.test(rawText)) {
      return new Date((ref ?? new Date()).getTime() + 24 * 3600 * 1000);
    }
    return null;
  }),
  parseHebrewTime:     jest.fn(() => Promise.resolve(new Date(Date.now() + 24 * 3600 * 1000))),
  createCalendarEntry: jest.fn(() => Promise.resolve({
    scheduledAt: new Date(Date.now() + 24 * 3600 * 1000), icsContent: null, googleEventId: null,
  })),
  cancelCalendarEvent:  jest.fn(() => Promise.resolve(false)),
  notifyAllActiveStaff: jest.fn(() => Promise.resolve({ notified: 0, total: 0 })),
  notifyEden:           jest.fn(() => Promise.resolve({ notified: 0 })),
}));

// ── Load store, aptStore, app ─────────────────────────────────────────────────
const store    = require('../utils/lead_store');
const aptStore = require('../utils/appointment_store');
const request  = require('supertest');
const app      = require('../server');

const GUARD_PHONE = '972500000088';

function resetState() {
  mockSentTexts.length  = 0;
  mockSentAlerts.length = 0;
  mockOpenAIReply          = 'mock reply';
  store.upsertLead(GUARD_PHONE, { status: 'new', name: null, meta: {} });
  aptStore.getByPhone(GUARD_PHONE).forEach(a => aptStore.update(a.id, { status: 'cancelled' }));
}

async function simulateMessage(text, name = 'אליאור', phone = GUARD_PHONE) {
  const res = await request(app)
    .post('/api/whatsapp/simulate')
    .send({ from: phone, text, name, type: 'text' })
    .set('Content-Type', 'application/json');
  expect([200, 500]).toContain(res.status);
  await new Promise(r => setTimeout(r, 100));
  return res.body;
}

// ── A. Gate 3b — Hallucinated time commitment ─────────────────────────────────

describe('Gate 3b — hallucinated scheduling commitment stripped', () => {
  beforeEach(resetState);

  test('AI says "הצוות יצור קשר ב19:00" with callTimeGiven absent → stripped before prospect sees it', async () => {
    // Lead at a stage where the AI might read "19:00" from history and fabricate a commitment.
    // callTimeGiven is NOT in qualData — only the conversation history contained "19:00".
    store.upsertLead(GUARD_PHONE, {
      status: 'warm',
      meta: {
        arboxColdLeadConfirmedAt: Date.now(),
        qualData: {
          callProposed:    true,     // AI invited a callback
          callTimeGiven:   null,     // pipeline has NOT captured a time
          confirmedName:   null,
          fitnessInterest: 'פילאטיס מכשירים',
          location:        'חדרה',
          locationViable:  true,
        },
      },
    });

    // AI fabricates a time it found in conversation history
    mockOpenAIReply = 'מצוין! הצוות יצור קשר ב19:00 😊 ואיך קוראים לך?';

    const r = await simulateMessage('כן, מתאים לי');
    mockOpenAIReply = 'mock reply';

    // The AI's raw reply contained "הצוות יצור קשר ב19:00".
    // Gate 3b (callTimeGiven absent) must strip it before it reaches the prospect.
    expect(mockSentTexts.some(s =>
      s.to === GUARD_PHONE && s.text.includes('יצור קשר ב')
    )).toBe(false);

    // No appointment created — callTimeGiven is not set so the auto-create block won't fire
    const apt = aptStore.getByPhone(GUARD_PHONE).find(a => a.status === 'callback_pending');
    expect(apt).toBeUndefined();
  });

  test('Gate 3b does NOT strip when BOTH callTimeGiven and confirmedName are present (CLOSE state)', () => {
    // Unit test against postProcessReply directly — avoids pipeline routing complexity.
    // The guard condition is: !callTimeGiven || !confirmedName.
    // When both are set, the condition is false and the commitment is preserved.
    const { postProcessReply } = require('../agents/lead_agent');
    const assets = { wazeUrl: null };
    const qd = {
      callTimeGiven:   'מחר ב11',
      confirmedName:   'אליאור',
      callProposed:    true,
      fitnessInterest: 'פילאטיס מכשירים',
      location:        'חדרה',
      locationViable:  true,
    };
    const aiReply   = 'מצוין אליאור — הצוות יצור קשר מחר ב11 😊';
    const processed = postProcessReply(aiReply, qd, assets);
    expect(processed).toContain('יצור קשר');
    expect(processed).toContain('מחר ב11');
  });
});

// ── B. Real disk-write failure propagation ────────────────────────────────────

describe('Real disk-write failure blocks booking confirmation', () => {
  beforeEach(() => {
    resetState();
    // Prime lead at callback_requested with callTimeGiven + nameAsked but no confirmedName.
    // This state causes the name-capture path to call aptStore.createCallbackPending.
    store.upsertLead(GUARD_PHONE, {
      status: 'callback_requested',
      name:   null,
      meta: {
        arboxColdLeadConfirmedAt: Date.now(),
        qualData: {
          callTimeGiven:   'מחר ב11',
          callProposed:    true,
          nameAsked:       true,
          confirmedName:   null,
          fitnessInterest: 'פילאטיס מכשירים',
          location:        'חדרה',
          locationViable:  true,
        },
      },
    });
    // Ensure no existing callback_pending entry (so create path is exercised)
    aptStore.getByPhone(GUARD_PHONE).forEach(a => aptStore.update(a.id, { status: 'cancelled' }));
  });

  test('fs.writeFileSync failure in _save() propagates through createCallbackPending → no prospect confirmation', async () => {
    // Spy on the real fs module's writeFileSync.
    // The same fs object is used by appointment_store (Node.js module cache guarantees this).
    const fs = require('fs');
    const originalWrite = fs.writeFileSync;
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((filePath, data, enc) => {
      if (typeof filePath === 'string' && filePath.includes('appointments.json')) {
        throw new Error('ENOSPC: no space left on device, write');
      }
      return originalWrite.call(fs, filePath, data, enc);
    });

    const alertsBefore = mockSentAlerts.length;
    const r = await simulateMessage('עמית');
    writeSpy.mockRestore();
    await new Promise(res => setTimeout(res, 200));

    expect(r.route).toBe('post_call_name_captured');

    // appointment_store.create() threw (write failed and in-memory insert was undone)
    const apt = aptStore.getByPhone(GUARD_PHONE)
      .find(a => a.status === 'callback_pending');
    expect(apt).toBeUndefined();

    // No prospect confirmation — _aptForSend stayed null
    expect(mockSentTexts.some(s =>
      s.to === GUARD_PHONE && s.text.includes('קיבלנו')
    )).toBe(false);

    // Manager summary still sent — staff can follow up even when storage failed
    expect(mockSentAlerts.length).toBeGreaterThan(alertsBefore);
  });
});
