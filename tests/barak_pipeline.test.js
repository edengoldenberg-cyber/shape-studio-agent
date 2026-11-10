'use strict';
/**
 * Integration tests: Barak WhatsApp pipeline — through processInboundWAMessage.
 *
 * Sends real HTTP requests to the server on localhost:3000.
 * Demo phones (972000000001-9) are intercepted by the sendText demo gate —
 * no real Green API calls are made. The /api/test/sends endpoint returns a log
 * of every intercepted send attempt, letting tests assert exact outbound counts.
 *
 * Run with: npm test -- --testPathPattern=barak_pipeline
 * Requires: server restarted from current code on localhost:3000
 */

const supertest = require('supertest');

const BASE  = 'http://localhost:3000';
const agent = supertest(BASE);

let serverUp = false;

// All phones are in the demo gate range 972000000001-9 so sendText is intercepted.
const DEMO_PHONES = {
  newLead:   '972000000006',
  optedOut:  '972000000007',
  humanOwns: '972000000008',
  member:    '972000000009',
  dedup:     '972000000005',
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function greenApiBody(phone, text, name = 'Test Lead', messageId = null) {
  return {
    typeWebhook:  'incomingMessageReceived',
    instanceData: { idInstance: 7103533626, wid: '972500000000@c.us', typeInstance: 'whatsapp' },
    timestamp:    Math.floor(Date.now() / 1000),
    idMessage:    messageId ?? `TEST_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    senderData:   { chatId: `${phone}@c.us`, sender: `${phone}@c.us`, senderName: name },
    messageData:  { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
  };
}

async function postWebhook(phone, text, name, messageId) {
  await agent
    .post('/api/green-api/webhook')
    .send(greenApiBody(phone, text, name, messageId))
    .set('Content-Type', 'application/json')
    .expect(200);
}

/** Clear the send log and reply cooldowns before a test so counts and routing are unambiguous. */
async function clearSends() {
  await agent.delete('/api/test/sends').expect(200);
  await agent.delete('/api/test/cooldowns').expect(200);
}

/**
 * Poll the send log until at least minCount sends for phone appear, or timeout.
 * Matches by the last 4 digits of the phone (send log stores masked tails only).
 */
async function waitForSends(phone, { minCount = 1, timeoutMs = 4000, intervalMs = 80 } = {}) {
  const tail = phone.slice(-4);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await agent.get('/api/test/sends').expect(200);
    const sends = (res.body?.sends ?? []).filter(s => s.tail === tail);
    if (sends.length >= minCount) return sends;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  const res = await agent.get('/api/test/sends').expect(200);
  return (res.body?.sends ?? []).filter(s => s.tail === tail);
}

/**
 * Poll the event store until an event of the given type appears for phone, or timeout.
 * Uses GET /api/test/events (TEST_MODE gated). Event type is the discriminator:
 *   'message_in'        → Barak/lead path ran (step 5b upserted lead record)
 *   'client_message_in' → Tomer/member path ran (step 5c logged client event)
 *   'score_update'      → leadAgent.handleInbound completed scoring
 */
async function waitForEvent(phone, eventType, { since = null, timeoutMs = 20000, intervalMs = 100 } = {}) {
  const afterTs = since ?? new Date(Date.now() - 500).toISOString();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await agent
      .get(`/api/test/events?phone=${encodeURIComponent(phone)}&since=${encodeURIComponent(afterTs)}`)
      .expect(200);
    const match = (res.body?.events ?? []).find(e => e.type === eventType);
    if (match) return match;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/** Count sends in the log for a given phone (by last-4-digit tail). */
async function countSends(phone) {
  const tail = phone.slice(-4);
  const res = await agent.get('/api/test/sends').expect(200);
  return (res.body?.sends ?? []).filter(s => s.tail === tail).length;
}

/** Poll inbox for a message received after sentAt, for the given phone. */
async function waitForInboxEntry(phone, { timeoutMs = 5000, intervalMs = 80, sentAt = null } = {}) {
  const after   = sentAt ?? (Date.now() - 500);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await agent.get('/api/whatsapp/inbox?limit=200').expect(200);
    // getAll() returns newest-first; find the first (most recent) entry for this phone after sentAt
    const match = (res.body?.messages ?? []).find(e => {
      if (!(e.from === phone || e.from?.startsWith(phone))) return false;
      return new Date(e.receivedAt ?? e.timestamp ?? 0).getTime() >= after;
    });
    if (match) return match;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/** Poll inbox for an entry with this specific messageId. Returns all matches. */
async function waitForMessageId(messageId, { timeoutMs = 3000, intervalMs = 80 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await agent.get('/api/whatsapp/inbox?limit=200').expect(200);
    const matches = (res.body?.messages ?? []).filter(e => e.messageId === messageId);
    if (matches.length > 0) return { entries: matches, count: matches.length };
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { entries: [], count: 0 };
}

async function deleteLead(phone) {
  try { await agent.delete(`/api/leads/${encodeURIComponent(phone)}`); } catch {}
}

async function getLead(phone) {
  const res = await agent.get('/api/leads').expect(200);
  // Masked format: "97200••••006" — only last 3 digits are unmasked.
  // Use slice(-3) so matching works regardless of mask length.
  const tail = phone.slice(-3);
  return (res.body ?? []).find(l => l.phone?.endsWith(tail)) ?? null;
}

async function addKnownMember(phone) {
  await agent.post('/api/members/known').send({ phone }).expect(200);
}

async function removeKnownMember(phone) {
  try { await agent.delete(`/api/members/known/${encodeURIComponent(phone)}`); } catch {}
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    await agent.get('/health').timeout(5000).expect(200);
    serverUp = true;
  } catch (e) {
    console.warn('Server not up:', e.message);
  }
});

afterAll(async () => {
  if (!serverUp) return;
  for (const phone of Object.values(DEMO_PHONES)) {
    await deleteLead(phone);
    await removeKnownMember(phone);
  }
  await clearSends();
});

function skipIfDown() {
  if (!serverUp) return pending('Server not running on localhost:3000 — skipping');
}

// ── 1. Unknown lead enters Barak's flow ───────────────────────────────────────
describe('New lead routing → Barak', () => {
  beforeEach(async () => {
    await deleteLead(DEMO_PHONES.newLead);
    await clearSends();
  });
  afterEach(async () => { await deleteLead(DEMO_PHONES.newLead); });

  test('schedule query → route=barak, sendText fired, message_in event logged', async () => {
    skipIfDown();
    // The schedule-query path sets barakReply and calls sendText directly.
    // Tier-3 Arbox lookup runs first (unknown phone — may take several seconds).
    const sentAt = Date.now();
    await postWebhook(DEMO_PHONES.newLead, 'מה מערכת השעות?');

    // Wait for inbox entry — appears right before sendText is called
    const entry = await waitForInboxEntry(DEMO_PHONES.newLead, { sentAt, timeoutMs: 15000 });
    expect(entry).not.toBeNull();
    expect(entry.route).toBe('barak');
    expect(['opted_out_silent', 'human_owns_hold', 'tomer']).not.toContain(entry.route);

    // Send log confirms sendText was called (send log is TEST_MODE gated)
    const sends = await waitForSends(DEMO_PHONES.newLead, { minCount: 1, timeoutMs: 2000 });
    expect(sends.length).toBeGreaterThanOrEqual(1);

    // Event store confirms the lead path ran (not the member/Tomer path)
    const ev = await waitForEvent(DEMO_PHONES.newLead, 'message_in', { since: new Date(sentAt).toISOString(), timeoutMs: 3000 });
    expect(ev).not.toBeNull();
  });

  test('general message → route=barak, score_update event confirms leadAgent ran', async () => {
    skipIfDown();
    // AI path: leadAgent.handleInbound calls OpenAI + sendText + logs score_update.
    // Arbox Tier-3 lookup + OpenAI call both run → allow up to 15s.
    const sentAt = Date.now();
    await postWebhook(DEMO_PHONES.newLead, 'מחפש/ת שיעורי פילאטיס');

    const entry = await waitForInboxEntry(DEMO_PHONES.newLead, { sentAt, timeoutMs: 15000 });
    expect(entry).not.toBeNull();
    expect(entry.route).toBe('barak');
    expect(['opted_out_silent', 'human_owns_hold', 'tomer']).not.toContain(entry.route);

    // score_update is logged by leadAgent.handleInbound — proves AI agent ran and scored the lead
    const scoreEv = await waitForEvent(DEMO_PHONES.newLead, 'score_update', { since: new Date(sentAt).toISOString(), timeoutMs: 5000 });
    expect(scoreEv).not.toBeNull();

    // sendText was called (the AI qualification reply)
    const sends = await waitForSends(DEMO_PHONES.newLead, { minCount: 1, timeoutMs: 2000 });
    expect(sends.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 2. Known member → Tomer, zero Barak sales sends ──────────────────────────
// buildSchedulingReply makes a live Arbox call that can take >5s on local dev.
// Extend Jest timeout for this describe block.
jest.setTimeout(30000);

describe('Known member routing → Tomer, zero Barak sends', () => {
  beforeEach(async () => {
    await deleteLead(DEMO_PHONES.member);
    await addKnownMember(DEMO_PHONES.member);
    await clearSends();
  });
  afterEach(async () => {
    await removeKnownMember(DEMO_PHONES.member);
    await deleteLead(DEMO_PHONES.member);
  });

  test('known member general message → client_message_in event confirms Tomer path, no score_update', async () => {
    skipIfDown();
    // 'רוצה לדעת על מערכת השיעורים' (> 20 chars) does not match isBriefAck.
    // The member path logs 'client_message_in'; Barak's path logs 'message_in' + 'score_update'.
    // Asserting client_message_in AND absence of score_update proves leadAgent.handleInbound
    // was never invoked — not just that the route label says 'tomer'.
    const sentAt = Date.now();
    await postWebhook(DEMO_PHONES.member, 'רוצה לדעת על מערכת השיעורים');

    const entry = await waitForInboxEntry(DEMO_PHONES.member, { sentAt, timeoutMs: 20000 });
    expect(entry).not.toBeNull();
    expect(entry.route).toBe('tomer');

    // client_message_in confirms the pipeline took the member branch (step 5c)
    const clientEv = await waitForEvent(DEMO_PHONES.member, 'client_message_in', { since: new Date(sentAt).toISOString(), timeoutMs: 5000 });
    expect(clientEv).not.toBeNull();

    // score_update is logged by leadAgent.handleInbound — its absence proves Barak never ran
    const scoreEv = await waitForEvent(DEMO_PHONES.member, 'score_update', { since: new Date(sentAt).toISOString(), timeoutMs: 1000 });
    expect(scoreEv).toBeNull();
  });

  test('known member schedule query → route=tomer, client_message_in logged', async () => {
    skipIfDown();
    // buildSchedulingReply makes a live Arbox call that can take several seconds.
    // Inbox push happens after the routing block completes; waitForInboxEntry must wait.
    const sentAt = Date.now();
    await postWebhook(DEMO_PHONES.member, 'מה מערכת השעות?');

    const entry = await waitForInboxEntry(DEMO_PHONES.member, { sentAt, timeoutMs: 20000 });
    expect(entry).not.toBeNull();
    expect(entry.route).toBe('tomer');

    const clientEv = await waitForEvent(DEMO_PHONES.member, 'client_message_in', { since: new Date(sentAt).toISOString(), timeoutMs: 5000 });
    expect(clientEv).not.toBeNull();

    const scoreEv = await waitForEvent(DEMO_PHONES.member, 'score_update', { since: new Date(sentAt).toISOString(), timeoutMs: 1000 });
    expect(scoreEv).toBeNull();
  });
});

// ── 3. Opted-out → silent, zero sends ────────────────────────────────────────
describe('Opted-out contact → no automated sales send', () => {
  beforeEach(async () => {
    await deleteLead(DEMO_PHONES.optedOut);
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.optedOut)}/opt-out`)
      .send({}).expect(200);
    await clearSends();
  });
  afterEach(async () => { await deleteLead(DEMO_PHONES.optedOut); });

  test('opted-out → route=opted_out_silent, barakReply=null, zero sends', async () => {
    skipIfDown();
    const sentAt = Date.now();
    await postWebhook(DEMO_PHONES.optedOut, 'שלום שוב');

    const entry = await waitForInboxEntry(DEMO_PHONES.optedOut, { sentAt });
    expect(entry).not.toBeNull();
    expect(entry.route).toBe('opted_out_silent');
    expect(entry.barakReply).toBeNull();

    // Zero outbound sends — opted_out returns before any sendText call
    expect(await countSends(DEMO_PHONES.optedOut)).toBe(0);
  });
});

// ── 4. Human-owned → hold, zero sales sends ──────────────────────────────────
describe('Human-owned contact → no automated sales send', () => {
  beforeEach(async () => {
    await deleteLead(DEMO_PHONES.humanOwns);
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.humanOwns)}/takeover`)
      .send({ reason: 'test', staffName: 'Test Staff' }).expect(200);
    await clearSends();
  });
  afterEach(async () => { await deleteLead(DEMO_PHONES.humanOwns); });

  test('human_owns → route=human_owns_hold, barakReply=null, zero sends', async () => {
    skipIfDown();
    const sentAt = Date.now();
    await postWebhook(DEMO_PHONES.humanOwns, 'אז מה קורה?');

    const entry = await waitForInboxEntry(DEMO_PHONES.humanOwns, { sentAt });
    expect(entry).not.toBeNull();
    expect(entry.route).toBe('human_owns_hold');
    expect(entry.barakReply).toBeNull();

    expect(await countSends(DEMO_PHONES.humanOwns)).toBe(0);
  });
});

// ── 5. Release semantics ─────────────────────────────────────────────────────
describe('Release semantics — terminal statuses preserved', () => {
  afterEach(async () => {
    await deleteLead(DEMO_PHONES.optedOut);
    await deleteLead(DEMO_PHONES.humanOwns);
  });

  test('opted_out survives human_owns takeover + release', async () => {
    skipIfDown();
    await deleteLead(DEMO_PHONES.optedOut);
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.optedOut)}/opt-out`)
      .send({}).expect(200);
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.optedOut)}/takeover`)
      .send({ reason: 'manual' }).expect(200);

    const res = await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.optedOut)}/release`)
      .send({}).expect(200);

    expect(res.body.status).toBe('opted_out');
    expect(res.body.automationResumed).toBe(false);
    expect(res.body.reason).toBe('opted_out_preserved');
  });

  test('previousStatus=opted_out preserved even without meta.optedOutAt (legacy path)', async () => {
    skipIfDown();
    // Both the meta.optedOutAt AND previousStatus guards should fire.
    // Here the opt-out API sets meta.optedOutAt, so both paths agree.
    // Legacy records lacking meta.optedOutAt are protected by previousStatus.
    await deleteLead(DEMO_PHONES.optedOut);
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.optedOut)}/opt-out`)
      .send({}).expect(200);
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.optedOut)}/takeover`)
      .send({ reason: 'test' }).expect(200);

    const res = await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.optedOut)}/release`)
      .send({}).expect(200);
    expect(res.body.status).toBe('opted_out');
    expect(res.body.automationResumed).toBe(false);
  });

  test('plain cold lead restores to automation after release', async () => {
    skipIfDown();
    await deleteLead(DEMO_PHONES.humanOwns);
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.humanOwns)}/takeover`)
      .send({ reason: 'manual' }).expect(200);

    const res = await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.humanOwns)}/release`)
      .send({}).expect(200);
    expect(res.body.status).not.toBe('human_owns');
    expect(res.body.automationResumed).toBe(true);
  });
});

// ── 6. Callback ≠ confirmed appointment ─────────────────────────────────────
describe('Callback request vs confirmed appointment', () => {
  afterEach(async () => { await deleteLead(DEMO_PHONES.newLead); });

  test('time mention without prior callProposed → not call_scheduled', async () => {
    skipIfDown();
    await deleteLead(DEMO_PHONES.newLead);
    await postWebhook(DEMO_PHONES.newLead, 'יום שני בעשר בבוקר');
    // Poll briefly for the lead to be created (may not exist if swallowed)
    await new Promise(r => setTimeout(r, 500));
    const lead = await getLead(DEMO_PHONES.newLead);
    if (lead) {
      // If a lead exists, it must not have been elevated to call_scheduled
      // (only an aptStore entry can do that — the AI flow sets callback_requested)
      expect(lead.status).not.toBe('call_scheduled');
    }
    // No lead at all is also valid (ack-swallowed or spam-filtered)
  });
});

// ── 7. Duplicate webhook → exactly one outbound action ───────────────────────
describe('Duplicate webhook deduplication', () => {
  beforeEach(async () => {
    await deleteLead(DEMO_PHONES.dedup);
    // Opt-out so the pipeline exits before any sendText call,
    // making processing deterministic and fast (no AI or Arbox).
    await agent.post(`/api/leads/${encodeURIComponent(DEMO_PHONES.dedup)}/opt-out`)
      .send({}).expect(200);
    await clearSends();
  });
  afterEach(async () => { await deleteLead(DEMO_PHONES.dedup); });

  test('identical messageId sent twice → exactly one inbox entry, zero sends', async () => {
    skipIfDown();
    const messageId = `DEDUP_${Date.now()}`;

    // Send the same webhook body twice (opted_out path is synchronous — no race)
    await postWebhook(DEMO_PHONES.dedup, 'בדיקת כפילות', 'Test', messageId);
    await postWebhook(DEMO_PHONES.dedup, 'בדיקת כפילות', 'Test', messageId);

    // Poll until the entry appears (opted_out is fast: no AI, no Arbox)
    const { entries, count } = await waitForMessageId(messageId, { timeoutMs: 2000 });
    // Exactly one entry for this messageId (the second was deduplicated)
    expect(count).toBe(1);
    // opted_out path performs no outbound send
    expect(entries[0].route).toBe('opted_out_silent');
    expect(entries[0].barakReply).toBeNull();

    // The send log confirms zero outbound sends for this phone
    expect(await countSends(DEMO_PHONES.dedup)).toBe(0);
  });
});

// ── 8. Phone registry ─────────────────────────────────────────────────────────
describe('Phone registry', () => {
  test('/api/version returns a numeric phoneRegistrySize > 0', async () => {
    skipIfDown();
    const res = await agent.get('/api/version').expect(200);
    expect(typeof res.body?.phoneRegistrySize).toBe('number');
    expect(res.body.phoneRegistrySize).toBeGreaterThan(0);
  });

  test('/api/health/registry reports registry OK', async () => {
    skipIfDown();
    const res = await agent.get('/api/health/registry').expect(200);
    expect(res.body?.registry?.diagnosis).toBe('OK');
    expect(res.body?.timetable).toBeDefined();
  });
});
