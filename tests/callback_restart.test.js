'use strict';

/**
 * Restart-flow integration test for the callback booking path.
 *
 * Tests that the full pipeline survives a server restart between each step:
 *   actual proposal handling → persist → reload → time acceptance → persist →
 *   reload → name capture → appointment saved with scheduledAt → confirmation sent.
 *
 * Uses real persist (file I/O to a temp dir) and real aptStore disk persistence.
 * Does NOT use manually seeded store state — all qualData flags (callProposed,
 * callTimeGiven, nameAsked) are set by actual message processing.
 *
 * appointment_store reads DATA_DIR at module load time, so DATA_DIR must be set
 * before any requires.
 */

// ── Set DATA_DIR BEFORE all requires ─────────────────────────────────────────
const os   = require('os');
const fs   = require('fs');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-restart-'));
process.env.DATA_DIR           = tmpDir;
process.env.TEST_MODE          = 'true';
process.env.WHATSAPP_AUTO_REPLY = 'true';
process.env.NODE_ENV           = 'test';

// ── Mocks (before server require) ────────────────────────────────────────────

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
      const id = `MSG_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      mockSentTexts.push({ to, text, id });
      return Promise.resolve({ idMessage: id });
    }),
    alertOwner: jest.fn((subject, body, opts = {}) => {
      const phones = ['972547598919'];
      const results = phones.map(phone => ({
        phone,
        skipped:   opts?.skipPhones instanceof Set && opts.skipPhones.has(phone),
        idMessage: `MGR_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        error:     null,
      })).map(r => r.skipped ? { ...r, idMessage: null } : r);
      mockSentAlerts.push({ subject, body });
      return Promise.resolve({ results });
    }),
    sendFileByUrl:  jest.fn(() => Promise.resolve()),
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
  getAssets: jest.fn(() => ({
    wazeUrl:            'https://waze.com/ul?q=test',
    timetableUrl:       null,
    timetableImageExt:  'png',
    timetable2ImageExt: 'png',
  })),
  getTimetableImagePath:  jest.fn(() => null),
  getTimetable2ImagePath: jest.fn(() => null),
}));

jest.mock('../utils/demo_capture', () => ({
  record:   jest.fn(),
  isActive: jest.fn(() => false),
}));

// arbox mock must include getMembers + getLeads so barak_agent.lookupClient
// returns {total:0, memberLookupFailed:false} → arboxLookupFailed=false → Tier-4 skipped.
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
  touchSession:                  jest.fn(),
  buildMemoryInjection:          jest.fn(() => null),
  generateAndSaveSessionSummary: jest.fn(() => Promise.resolve()),
}));

jest.mock('../services/greenapi.service', () => ({
  isConfigured:  jest.fn(() => false),
  parseWebhook:  jest.fn(() => null),
  syncToInbox:   jest.fn(() => Promise.resolve({ chats: 0, messages: 0 })),
  sendText:      jest.fn(() => Promise.resolve({ idMessage: 'GREEN_MOCK' })),
  sendFileByUrl: jest.fn(() => Promise.resolve({ idMessage: 'GREEN_MOCK' })),
}));

jest.mock('../utils/phone_registry', () => ({
  init:     jest.fn(() => Promise.resolve()),
  isMember: jest.fn(() => false),
  getAll:   jest.fn(() => []),
  size:     0,
}));

// OpenAI mock: returns a reply that contains BOTH a call-proposal phrase AND a
// name-ask phrase. This ensures:
//   - CALL_PROPOSAL_RE fires when completedTurns >= 2 → callProposed=true (persisted)
//   - NAME_ASK_RE fires when callTimeGiven is set → nameAsked=true (persisted)
// Both flags come from actual AI-reply processing, not manual upsertLead calls.
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn(() => Promise.resolve({
      choices: [{ message: {
        content: 'נשמע מצוין! שיחה קצרה עם נציג מהסטודיו — ואיך קוראים לך?',
      } }],
    })) } },
  }))
);

// parseHebrewTimeLocal: resolve any day-name or digit pattern to a fixed
// 48-hours-ahead Date, anchored to the ref argument so midnight-crossing
// tests remain deterministic. null for strings without a recognisable pattern.
jest.mock('../services/calendar.service', () => ({
  parseCallbackTime:   jest.fn(() => null),
  parseHebrewTimeLocal: jest.fn((rawText, ref) => {
    if (!rawText) return null;
    if (/ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|מחר|היום|\d/.test(rawText)) {
      return new Date((ref ?? new Date()).getTime() + 48 * 3600 * 1000);
    }
    return null;
  }),
  parseHebrewTime:     jest.fn((rawText, ref) => Promise.resolve(
    new Date((ref ?? new Date()).getTime() + 48 * 3600 * 1000)
  )),
  createCalendarEntry: jest.fn(() => Promise.resolve({
    scheduledAt:    new Date(Date.now() + 48 * 3600 * 1000),
    icsContent:     null,
    googleEventId:  null,
  })),
  cancelCalendarEvent:  jest.fn(() => Promise.resolve(false)),
  notifyAllActiveStaff: jest.fn(() => Promise.resolve({ notified: 0, total: 0 })),
  notifyEden:           jest.fn(() => Promise.resolve({ notified: 0 })),
}));

// ── Load modules (persist is NOT mocked — real file I/O to tmpDir) ────────────
const store    = require('../utils/lead_store');
const aptStore = require('../utils/appointment_store');
const persist  = require('../utils/persist');
const request  = require('supertest');
const app      = require('../server');

const RESTART_PHONE = '972500000199';

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function simulateMessage(text, name = 'אליאור') {
  const res = await request(app)
    .post('/api/whatsapp/simulate')
    .send({ from: RESTART_PHONE, text, name, type: 'text' })
    .set('Content-Type', 'application/json');
  expect([200, 500]).toContain(res.status);
  await new Promise(r => setTimeout(r, 200));
  return res.body;
}

function simulateRestart() {
  persist.saveLeads(store);
  store.clear();
  aptStore._apts.clear();
  persist.loadLeads(store);
  aptStore._load();
}

// ── Test ──────────────────────────────────────────────────────────────────────

test('restart-flow: proposal → persist → reload → time → persist → reload → name → confirmation', async () => {
  mockSentTexts.length  = 0;
  mockSentAlerts.length = 0;

  // ── Phase 1: proposal ─────────────────────────────────────────────────────
  // completedTurns is computed BEFORE the current message enters history.
  // Message 1: completedTurns=0. Message 2: completedTurns=1. Message 3: completedTurns=2.
  // CALL_PROPOSAL_RE + completedTurns>=2 fires on the THIRD AI reply.
  await simulateMessage('שלום, אני מתעניין בפילאטיס');
  await simulateMessage('גר בחדרה, מחפש לחזק גב');
  await simulateMessage('בעיקר חיזוק ויציבה');

  // CALL_PROPOSAL_RE fires on the third AI reply ("שיחה קצרה עם נציג מהסטודיו")
  // at completedTurns=2 → callProposed=true + lead_agent immediately calls persist.saveLeads.
  const afterProposal = store.getLead(RESTART_PHONE);
  expect(afterProposal?.meta?.qualData?.callProposed).toBe(true);

  // leads_persist.json must exist (written by lead_agent on callProposed)
  expect(fs.existsSync(path.join(tmpDir, 'leads_persist.json'))).toBe(true);

  // ── RESTART 1: between callProposed and time ──────────────────────────────
  simulateRestart();

  const afterReload1 = store.getLead(RESTART_PHONE);
  expect(afterReload1?.meta?.qualData?.callProposed).toBe(true);  // survived disk round-trip

  // ── Phase 2: time acceptance ──────────────────────────────────────────────
  // "ראשון ב11" hits TIME_PATTERN + callProposed=true → callTimeGiven set.
  // Server's auto-create block (line ~4358) creates a callback_pending aptStore entry.
  // AI mock returns "ואיך קוראים לך?" → NAME_ASK_RE fires → nameAsked=true.
  await simulateMessage('ראשון ב11');

  const afterTime = store.getLead(RESTART_PHONE);
  expect(afterTime?.meta?.qualData?.callTimeGiven).toBe('ראשון ב11');
  expect(afterTime?.meta?.qualData?.callTimeGivenAt).toBeTruthy();  // timestamp anchor persisted
  expect(afterTime?.meta?.qualData?.nameAsked).toBe(true);

  // aptStore entry created by the auto-create block (AI flow, not awaitingCallbackTime flow)
  const aptAfterTime = aptStore.getByPhone(RESTART_PHONE)
    .find(a => a.status === 'callback_pending');
  expect(aptAfterTime).toBeDefined();
  expect(aptAfterTime?.scheduledAt).toBeTruthy();  // parseHebrewTimeLocal resolved it

  // aptStore writes appointments.json after every mutation — verify file exists
  expect(fs.existsSync(path.join(tmpDir, 'appointments.json'))).toBe(true);

  // ── RESTART 2: between time and name (the critical restart) ──────────────
  // callTimeGiven, callTimeGivenAt, nameAsked, and the aptStore entry must all
  // survive this restart so the name-capture path can fire correctly.
  simulateRestart();

  const afterReload2 = store.getLead(RESTART_PHONE);
  expect(afterReload2?.meta?.qualData?.callTimeGiven).toBe('ראשון ב11');
  expect(afterReload2?.meta?.qualData?.callTimeGivenAt).toBeTruthy();
  expect(afterReload2?.meta?.qualData?.nameAsked).toBe(true);

  const aptAfterReload = aptStore.getByPhone(RESTART_PHONE)
    .find(a => a.status === 'callback_pending');
  expect(aptAfterReload).toBeDefined();
  expect(aptAfterReload?.scheduledAt).toBeTruthy();  // appointment saved on disk

  // ── Phase 3: name → confirmation ──────────────────────────────────────────
  // The name-capture path fires: callTimeGiven + nameAsked=true + confirmedName=null.
  // The existing callback_pending entry is found → no new creation needed.
  // Prospect receives closing summary; manager receives handoff.
  await simulateMessage('עמית');
  await new Promise(r => setTimeout(r, 300));

  // appointment must still exist with scheduledAt after name capture
  const aptFinal = aptStore.getByPhone(RESTART_PHONE)
    .find(a => (a.status === 'callback_pending' || a.status === 'confirmed') && a.scheduledAt);
  expect(aptFinal).toBeDefined();
  expect(aptFinal?.scheduledAt).toBeTruthy();

  // Prospect received "קיבלנו את בקשת השיחה ✅"
  expect(mockSentTexts.some(s => s.to === RESTART_PHONE && s.text.includes('קיבלנו'))).toBe(true);

  // Manager received consolidated summary with the lead's name
  expect(
    mockSentAlerts.some(a =>
      (a.subject?.includes('עמית') || a.body?.includes('עמית')) &&
      (a.subject?.includes('שיחה') || a.body?.includes('שיחה') || a.body?.includes('wa.me'))
    )
  ).toBe(true);
}, 30000);
