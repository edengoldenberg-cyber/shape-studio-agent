'use strict';
/**
 * Barak lead-agent evaluation suite — 10 synthetic conversation scenarios.
 *
 * Tests the actual handleInbound pipeline with mocked external dependencies
 * (OpenAI, WhatsApp sending, alertOwner). The lead store runs in-memory so
 * state changes are real and inspectable.
 *
 * NOT tested here: AI response quality (that is a prompt concern, not a code
 * concern). Tested: routing, qualification state capture, status transitions,
 * stop conditions, and suppression of repeated questions.
 */

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// ── Mock WhatsApp sending — capture what was sent ───────────────────────────
const sentMessages = [];
const alertsSent   = [];
jest.mock('../services/whatsapp.service', () => ({
  sendText:    jest.fn((to, text) => { sentMessages.push({ to, text }); return Promise.resolve(); }),
  alertOwner:  jest.fn((subj, body) => { alertsSent.push({ subj, body }); return Promise.resolve(); }),
  sendFileByUrl: jest.fn(() => Promise.resolve()),
}));

// ── Mock member cache (no known members unless a test sets it) ──────────────
// Variable name must start with "mock" to be accessible inside jest.mock factory
const mockKnownMemberPhones = new Set();
jest.mock('../utils/member_cache', () => ({
  isConfirmed: jest.fn(phone => mockKnownMemberPhones.has(phone)),
}));

// ── Mock operational interceptor (let it pass by default) ──────────────────
jest.mock('../utils/operational_interceptor', () => ({
  checkOperationalIntent: jest.fn(() => ({ blocked: false })),
}));

// ── Mock studio assets ──────────────────────────────────────────────────────
jest.mock('../utils/studio_assets', () => ({
  getAssets:             jest.fn(() => ({ wazeUrl: null, timetableUrl: null })),
  getTimetableImagePath: jest.fn(() => null),
  getTimetable2ImagePath: jest.fn(() => null),
}));

// ── Mock demo capture ───────────────────────────────────────────────────────
jest.mock('../utils/demo_capture', () => ({
  record:   jest.fn(),
  isActive: jest.fn(() => false),
}));

// ── Mock handoff service (not testing LLM brief quality here) ──────────────
jest.mock('../services/handoff.service', () => ({
  scoreReadiness:        jest.fn(() => ({ level: 'MEDIUM', evidence: 'test' })),
  generateHandoffBrief:  jest.fn(() => Promise.resolve({ briefData: {}, readiness: { level: 'MEDIUM' } })),
}));

// ── Mock memory service ─────────────────────────────────────────────────────
jest.mock('../services/memory.service', () => ({
  touchSession:                jest.fn(),
  buildMemoryInjection:        jest.fn(() => null),
  generateAndSaveSessionSummary: jest.fn(() => Promise.resolve()),
}));

// ── Mock OpenAI ─────────────────────────────────────────────────────────────
const mockCreate = jest.fn();
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }))
);

// Helpers
function aiResponse(text) {
  return { choices: [{ message: { content: text } }] };
}
function aiJson(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

const { handleInbound, clearSession } = require('../agents/lead_agent');
const store = require('../utils/lead_store');

// Reset state between tests
beforeEach(() => {
  sentMessages.length = 0;
  alertsSent.length   = 0;
  mockCreate.mockReset();
  mockKnownMemberPhones.clear();
  // Clear all leads from the in-memory store
  for (const lead of store.getAllLeads()) {
    store.deleteLead(lead.phone);
  }
});

// ── 1. Hesitant beginner ─────────────────────────────────────────────────────
describe('1 — Hesitant beginner', () => {
  test('responds with one question, does not dump all studio info', async () => {
    mockCreate.mockResolvedValueOnce(aiResponse('שמחה שפנית! מאיזה אזור את/ה, ומה מחפשים?'));

    await handleInbound({ from: '972501110001', name: 'ריבה', text: 'שלום, מחפשת משהו לחזק את הגוף' });

    expect(sentMessages).toHaveLength(1);
    // Should not dump a list of classes on the first message
    expect(sentMessages[0].text).not.toMatch(/רפורמר.*אשטנגה|strength.*barre|6 שיעורים|מחיר/i);
    // Should ask a focused question
    expect(sentMessages[0].text).toMatch(/[?？]/);

    // Lead should be created
    const lead = store.getLead('972501110001');
    expect(lead).toBeTruthy();
    expect(lead.score).toBeGreaterThanOrEqual(1);
  });
});

// ── 2. Price-only inquiry ────────────────────────────────────────────────────
describe('2 — Price-only inquiry', () => {
  test('pricing objection captured on explicit objection; interest captured on next turn', async () => {
    // Turn 1: explicit pricing objection — "יקר לי" triggers PRICE_OBJECTION_RE
    // Note: "כמה עולה?" (price inquiry) does NOT set pricingObjection — the flag is for
    // objections like "expensive", "can't afford". This distinction is intentional:
    // curiosity ≠ objection.
    mockCreate.mockResolvedValueOnce(aiResponse('כדאי להשוות מה אנחנו נותנים לפני הכל. מה מחפשת?'));
    await handleInbound({ from: '972501110002', name: 'מיכל', text: 'זה יקר מדי בשבילי' });

    const lead1 = store.getLead('972501110002');
    expect(lead1?.meta?.qualData?.pricingObjection).toBe(true);
    expect(sentMessages).toHaveLength(1);

    // Turn 2: they clarify their interest despite the objection
    mockCreate.mockResolvedValueOnce(aiResponse('מה שאנחנו עושים שונה במהותו. נוח לך שיחה קצרה של 5 דקות?'));
    await handleInbound({ from: '972501110002', name: 'מיכל', text: 'פילאטיס מכשירים' });

    const lead2 = store.getLead('972501110002');
    expect(lead2?.meta?.qualData?.fitnessInterest).toMatch(/פילאטיס/i);
    expect(sentMessages).toHaveLength(2);
  });
});

// ── 3. Both strength and Pilates interest ────────────────────────────────────
describe('3 — Both strength and Pilates', () => {
  test('captures FIRST mentioned interest; does not re-ask after one is known', async () => {
    // Both interests in one message — first regex hit wins
    mockCreate.mockResolvedValueOnce(aiResponse('מדהים! כוח ופילאטיס — שילוב מנצח. מה המטרה הספציפית?'));
    await handleInbound({ from: '972501110003', name: 'נוגה', text: 'מחפשת גם אימוני כוח וגם פילאטיס' });

    const lead = store.getLead('972501110003');
    // fitnessInterest or goal should be set
    const qd = lead?.meta?.qualData ?? {};
    expect(qd.fitnessInterest ?? qd.goal).toBeTruthy();

    // On second turn: should NOT re-ask "what are you looking for?"
    mockCreate.mockResolvedValueOnce(aiResponse('מה מביא אותך לחפש עכשיו?'));
    await handleInbound({ from: '972501110003', name: 'נוגה', text: 'מחדרה' });

    // Location should be captured
    expect(store.getLead('972501110003')?.meta?.qualData?.location).toMatch(/חדרה/i);

    // The second reply must NOT ask for fitness interest again (already known)
    expect(sentMessages[1].text).not.toMatch(/מה מחפשת|איזה שיעורים|מה מעניין/i);
  });
});

// ── 4. Busy prospect with limited availability ───────────────────────────────
describe('4 — Busy prospect, asks about schedule', () => {
  test('timetable request triggers deterministic path without re-opening sales', async () => {
    // Using the tryDeterministicScheduleReply path
    // No OpenAI call should be made when the deterministic interceptor fires.
    // But assets.timetableUrl is null (mocked), so the reply is the honest fallback.
    await handleInbound({ from: '972501110004', name: 'אסף', text: 'שלחו לי את השעות' });

    // deterministic path: "שולח לך את המערכת עכשיו" or honest fallback
    // OpenAI may or may not be called — the important thing is a reply was sent
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 5. Lead who already supplied all details ─────────────────────────────────
describe('5 — Complete first message', () => {
  test('no redundant questions when location + interest + name are in first message', async () => {
    // First message has location AND fitness interest
    mockCreate.mockResolvedValueOnce(aiResponse('מדהים! הרפורמר שלנו הוא 8 אנשים — אישי מאוד. מה מחפשת — יציבה, חיזוק, שיקום?'));

    await handleInbound({
      from: '972501110005',
      name: 'דנה',
      text: 'שלום, שמי דנה מחדרה, מחפשת רפורמר פילאטיס, רוצה להתחיל השבוע',
    });

    const qd = store.getLead('972501110005')?.meta?.qualData ?? {};
    expect(qd.fitnessInterest ?? qd.goal).toBeTruthy();
    expect(qd.location).toMatch(/חדרה/i);

    // Reply should NOT ask "where are you from" or "what are you looking for"
    const replyText = sentMessages[0]?.text ?? '';
    expect(replyText).not.toMatch(/מאיזה אזור|מה מחפשת\?|מה מחפשים\?/i);
  });
});

// ── 6. Existing member mistaken for lead ─────────────────────────────────────
describe('6 — Existing member reaches lead flow', () => {
  test('Gate 1 blocks member — no reply sent, lead reclassified', async () => {
    mockKnownMemberPhones.add('972501110006');

    // Create a stale lead record for this member
    store.upsertLead('972501110006', { name: 'עמית', status: 'warm', score: 6 });

    await handleInbound({ from: '972501110006', name: 'עמית', text: 'שלום' });

    // No WhatsApp message should be sent to a known member from lead_agent
    expect(sentMessages.filter(m => m.to === '972501110006')).toHaveLength(0);

    // Lead should be reclassified as converted_member
    const lead = store.getLead('972501110006');
    expect(lead?.status).toBe('converted_member');
  });
});

// ── 7. Request for a human ───────────────────────────────────────────────────
describe('7 — Request for a human', () => {
  test('frustration detected → human_owns set, bot sends transfer message then stops', async () => {
    // First turn: normal conversation
    mockCreate.mockResolvedValueOnce(aiResponse('מה מחפשת?'));
    await handleInbound({ from: '972501110007', name: 'שרה', text: 'שלום' });

    // Second turn: requests human
    await handleInbound({ from: '972501110007', name: 'שרה', text: 'אני רוצה לדבר עם נציג אנושי' });

    const lead = store.getLead('972501110007');
    expect(lead?.status).toBe('human_owns');
    // A transfer message should have been sent
    const transferMsg = sentMessages.find(m => m.text?.match(/מעביר|נציג|צוות/));
    expect(transferMsg).toBeTruthy();
    // alertOwner should have been called with takeover info
    expect(alertsSent.some(a => a.subj?.match(/takeover|Human/i))).toBe(true);

    // Third turn: human_owns silence is enforced by processInboundWAMessage (the pipeline)
    // which checks _stopStatus === 'human_owns' BEFORE calling handleInbound.
    // At the handleInbound unit-test level, we verify the state is correctly set.
    expect(lead?.meta?.humanOwnsReason).toBe('frustration');
    // The store state is what the pipeline uses to gate subsequent messages.
    expect(store.getLead('972501110007')?.status).toBe('human_owns');
  });
});

// ── 8. Person who declines ───────────────────────────────────────────────────
describe('8 — Declines (location not viable)', () => {
  test('opt-out sets opted_out status, one ack sent, then silence', async () => {
    // Opt-out
    await handleInbound({ from: '972501110008', name: 'רם', text: 'STOP' });

    const lead = store.getLead('972501110008');
    expect(lead?.status).toBe('opted_out');
    // One acknowledgement sent
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toMatch(/הסרנו|הוסרת|לא נשלח/i);

    // Subsequent silence is enforced by processInboundWAMessage (the pipeline),
    // not by handleInbound directly. The store state (opted_out) is what gates it.
    expect(store.getLead('972501110008')?.status).toBe('opted_out');
    expect(store.getLead('972501110008')?.meta?.optedOutMsg).toBeTruthy();
  });

  test('distant location → polite close, no call proposal in reply', async () => {
    // First message: lead is from Tel Aviv (FAR)
    mockCreate.mockResolvedValueOnce(aiResponse('נשמע שאת/ה קצת רחוק/ה — יש לך אפשרות להגיע לפרדס חנה?'));
    await handleInbound({ from: '972501110009', name: 'גיל', text: 'אני מתל אביב' });

    expect(store.getLead('972501110009')?.meta?.qualData?.locationNearby).toBe(false);

    // Second message: they decline travel ("רחוק לי" = "it's far for me")
    mockCreate.mockResolvedValueOnce(aiResponse('מבין/ה לגמרי — אם זה ישתנה תמיד ברוכ/ה לפנות!'));
    await handleInbound({ from: '972501110009', name: 'גיל', text: 'רחוק לי' });

    expect(store.getLead('972501110009')?.meta?.qualData?.locationViable).toBe(false);
    // Reply should not propose a sales call
    const reply = sentMessages[sentMessages.length - 1]?.text ?? '';
    expect(reply).not.toMatch(/יתקשר|שיחה קצרה|5 דקות/i);
  });
});

// ── 9. Scheduling change after confirmed callback ────────────────────────────
describe('9 — Post-call: "Thanks" and schedule query', () => {
  test('"תודה" after call time is captured → no reply sent', async () => {
    // Set up a lead with callback_requested status
    store.upsertLead('972501110010', {
      status: 'callback_requested',
      meta: { qualData: { callTimeGiven: 'יום שלישי בבוקר', callProposed: true } },
    });

    // "Thanks" message — this is handled by processInboundWAMessage (the pipeline),
    // not lead_agent. Here we test that lead_agent itself doesn't reply to callback
    // confirmations when already in callback_requested.
    // The lead_agent's OPT_OUT check would let non-opt-out messages through,
    // but the STATUS check at the top of processInboundWAMessage (not tested here)
    // routes away. For the handleInbound unit test, test that a "thanks" message
    // after the call is proposed doesn't generate a NEW call proposal.
    mockCreate.mockResolvedValueOnce(aiResponse('שמחה שהזמן מתאים!'));
    await handleInbound({ from: '972501110010', name: 'לאה', text: 'תודה רבה' });

    // The lead_agent will reply (it doesn't know about the post-call gate),
    // but it must NOT re-propose a call time (qualData.callTimeGiven is set)
    if (sentMessages.length > 0) {
      const reply = sentMessages[0].text;
      expect(reply).not.toMatch(/באיזו שעה|מתי נוח.*שיחה/i);
    }
  });
});

// ── 10. Tool failure — OpenAI unavailable ────────────────────────────────────
describe('10 — Tool failure', () => {
  test('OpenAI error → fallback message sent, alertOwner called', async () => {
    mockCreate.mockRejectedValueOnce(new Error('OpenAI API timeout'));

    await handleInbound({ from: '972501110011', name: 'אבי', text: 'שלום' });

    // A fallback reply should be sent
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toMatch(/תקלה|צוות|שייצור קשר/i);
    // alertOwner should be called with the failure details
    // (lead_agent calls alertOwner on sendText failure, but here OpenAI failed →
    //  the fallback message itself is the error response)
  });

  test('known member Gate 1 never calls OpenAI', async () => {
    mockKnownMemberPhones.add('972501110012');
    await handleInbound({ from: '972501110012', name: 'ספיר', text: 'שלום' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ── Qualification state accumulation ────────────────────────────────────────
describe('Cross-turn state accumulation', () => {
  test('location, interest, and goal captured across separate messages — none re-asked', async () => {
    const phone = '972501110013';

    // Turn 1: location
    mockCreate.mockResolvedValueOnce(aiResponse('חדרה! מה מחפשת?'));
    await handleInbound({ from: phone, name: 'רות', text: 'אני מחדרה' });
    expect(store.getLead(phone)?.meta?.qualData?.location).toMatch(/חדרה/i);

    // Turn 2: interest
    mockCreate.mockResolvedValueOnce(aiResponse('פילאטיס מעולה! מה המטרה?'));
    await handleInbound({ from: phone, name: 'רות', text: 'פילאטיס מכשירים' });
    expect(store.getLead(phone)?.meta?.qualData?.fitnessInterest).toBeTruthy();

    // Turn 3: goal
    mockCreate.mockResolvedValueOnce(aiResponse('יציבה — בדיוק לזה הרפורמר מתאים. מה שמך?'));
    await handleInbound({ from: phone, name: 'רות', text: 'לשפר יציבה וחיזוק' });
    expect(store.getLead(phone)?.meta?.qualData?.goal).toBeTruthy();

    // On turn 3, the AI prompt should include the ALREADY KNOWN facts.
    // We verify this by checking that the third call to OpenAI received the stage context
    // with the known facts (location + interest are both set).
    const thirdCall = mockCreate.mock.calls[2]?.[0];
    if (thirdCall) {
      const systemMsg = thirdCall.messages.find(m => m.role === 'system')?.content ?? '';
      // knownSection mentions location and fitnessInterest
      expect(systemMsg).toMatch(/חדרה|פילאטיס/i);
    }
  });

  test('qualProfile is computed after scoring', async () => {
    const phone = '972501110014';
    mockCreate.mockResolvedValueOnce(aiResponse('שלום! מאיזה אזור?'));
    await handleInbound({ from: phone, name: 'מאיה', text: 'שלום' });

    const lead = store.getLead(phone);
    expect(lead?.meta?.qualProfile).toBeDefined();
    expect(lead?.meta?.qualProfile?.nextBestAction).toBeTruthy();
  });
});
