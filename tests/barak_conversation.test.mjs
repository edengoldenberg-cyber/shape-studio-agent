/**
 * Barak conversation quality tests — real model, isolated leads.
 *
 * Uses the /api/simulate/whatsapp endpoint on localhost (no real WhatsApp sends).
 * Each scenario uses a unique synthetic phone number so lead state is isolated.
 *
 * Run: node tests/barak_conversation.test.mjs
 *
 * PASS criteria (checked automatically):
 *   - No reply contains two independent questions.
 *   - Previously supplied facts are not re-asked.
 *   - Timetable requests receive the image confirmation reply.
 *   - "תודה" after timetable is silently acknowledged (no AI reply).
 *   - Burst: combined context visible in reply.
 *   - Non-scheduling follow-up after a reply is processed (not cooldown-dropped).
 *
 * Price data must come from subscription_packages.json at runtime.
 * No medical suitability, rehabilitation claims, or invented travel times.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
// Synthetic phones: valid 12-digit Israeli format (97250990XXXX) so Green API
// accepts the format without a 400 validation error. These numbers don't correspond
// to real subscribers — WhatsApp delivery fails silently at the network level.
const PHONE_PREFIX = '97250990';
let phoneCounter = 1;

function syntheticPhone() {
  return `${PHONE_PREFIX}${String(phoneCounter++).padStart(4, '0')}`;
}

async function simulate(phone, text, name = null) {
  const body = { from: phone, text, ...(name ? { name } : {}) };
  const res = await fetch(`${BASE}/api/whatsapp/simulate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`simulate HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Remove lead state between scenarios when TEST_MODE is available. */
async function deleteLead(phone) {
  try {
    const res = await fetch(`${BASE}/api/leads/${encodeURIComponent(phone)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404 && res.status !== 404) {
      // 404 = TEST_MODE not set (production) — expected, each test uses a unique phone
    }
  } catch { /* ignore */ }
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

const passed = [];
const failed = [];

function assert(condition, label, evidence = '') {
  if (condition) {
    passed.push(label);
    console.log(`  ✓ ${label}`);
  } else {
    failed.push(label);
    console.error(`  ✗ FAIL: ${label}`);
    if (evidence) console.error(`    evidence: ${JSON.stringify(evidence).slice(0, 200)}`);
  }
}

function countQuestions(text) {
  if (!text) return 0;
  return (text.match(/\?/g) ?? []).length;
}

function containsAny(text, ...patterns) {
  return patterns.some(p => (typeof p === 'string' ? text.includes(p) : p.test(text)));
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

async function scenarioTimetableOnly() {
  console.log('\n── Scenario 1: Lead asks only for the timetable ──');
  const phone = syntheticPhone();
  try {
    const r = await simulate(phone, 'אפשר לקבל מערכת שעות?');
    const reply = r.barakReply ?? '';
    console.log(`  Barak: ${reply}`);

    assert(r.route === 'barak', 'routed to barak', r.route);
    assert(containsAny(reply, 'שולח', 'מערכת', '📅'), 'reply confirms schedule send', reply);
    // After this test we expect the image was sent (not verifiable via simulate, but route/reply indicate it)
  } finally {
    await deleteLead(phone);
  }
}

async function scenarioBurst() {
  console.log('\n── Scenario 2: Three messages in quick succession (burst) ──');
  const phone = syntheticPhone();
  // Send messages back-to-back; simulate endpoint processes one at a time
  // (no burst window in simulate), so we test the COMBINED context via a single
  // message with multi-line text — the same input burst produces.
  try {
    const r = await simulate(phone, 'שלום\nאני מחפשת פילאטיס מכשירים\nמחדרה');
    const reply = r.barakReply ?? '';
    console.log(`  Barak: ${reply}`);

    assert(r.route === 'barak', 'routed to barak', r.route);
    // Should reference pilates/reformer and not ask about interest again
    assert(
      containsAny(reply.toLowerCase(), 'פילאטיס', 'reformer', 'מכשירים'),
      'reply addresses pilates interest',
      reply,
    );
    assert(countQuestions(reply) <= 1, 'at most one question', reply);
    // Should NOT re-ask "מה מחפשים" when already stated
    assert(!containsAny(reply, 'מה מחפשים', 'מה את מחפשת', 'מה אתה מחפש'), 'does not re-ask interest', reply);
  } finally {
    await deleteLead(phone);
  }
}

async function scenarioMultiFactFirst() {
  console.log('\n── Scenario 3: Multiple qualification facts in first message ──');
  const phone = syntheticPhone();
  try {
    const r = await simulate(phone, 'שלום, אני מחדרה, מחפשת פילאטיס מכשירים לאחר לידה');
    const reply = r.barakReply ?? '';
    console.log(`  Barak: ${reply}`);

    assert(r.route === 'barak', 'routed to barak', r.route);
    assert(!containsAny(reply, 'מאיזה אזור', 'מה מחפשים'), 'does not re-ask supplied facts', reply);
    assert(countQuestions(reply) <= 1, 'at most one question', reply);
    assert(
      containsAny(reply.toLowerCase(), 'פילאטיס', 'reformer', 'מכשירים', 'לידה'),
      'reply engages with stated interest',
      reply,
    );
  } finally {
    await deleteLead(phone);
  }
}

async function scenarioPriceQuestion() {
  console.log('\n── Scenario 4: Lead asks about price ──');
  const phone = syntheticPhone();
  try {
    // Turn 1 — give location first so price question is in context
    await simulate(phone, 'שלום, אני מחדרה, מחפשת כוח');
    const r = await simulate(phone, 'כמה עולה מנוי?');
    const reply = r.barakReply ?? '';
    console.log(`  Barak: ${reply}`);

    assert(r.route === 'barak', 'routed to barak', r.route);
    // Must answer the price question — NOT redirect to call without answering
    assert(
      containsAny(reply, 'כניסות', 'מנוי', 'ש"ח', 'שקל', 'מחיר', '₪'),
      'reply addresses price',
      reply,
    );
    // Should not say "אין לי מידע" on price
    assert(!containsAny(reply, 'אין לי מידע'), 'does not claim ignorance on price', reply);
    assert(countQuestions(reply) <= 1, 'at most one question', reply);
  } finally {
    await deleteLead(phone);
  }
}

async function scenarioPriceTooHigh() {
  console.log('\n── Scenario 5: Lead says price is too high ──');
  const phone = syntheticPhone();
  try {
    await simulate(phone, 'שלום, אני מחדרה');
    await simulate(phone, 'מה המחיר?');
    const r = await simulate(phone, 'יקר לי');
    const reply = r.barakReply ?? '';
    console.log(`  Barak: ${reply}`);

    assert(r.route === 'barak', 'routed to barak', r.route);
    // Category repositioning: should not argue or dismiss
    assert(!containsAny(reply, 'לא יקר', 'זול'), 'does not argue the price down', reply);
    assert(countQuestions(reply) <= 1, 'at most one question', reply);
  } finally {
    await deleteLead(phone);
  }
}

async function scenarioDeclineCall() {
  console.log('\n── Scenario 6: Lead wants info but declines a call ──');
  const phone = syntheticPhone();
  try {
    await simulate(phone, 'שלום, מחדרה, מחפשת יוגה');
    await simulate(phone, 'מה סגנון האשטנגה שלכם?');
    const r2 = await simulate(phone, 'לא רוצה שיחה, רק פרטים');
    const reply = r2.barakReply ?? '';
    console.log(`  Barak: ${reply}`);

    assert(r2.route === 'barak', 'routed to barak', r2.route);
    // Should not push the call after explicit decline
    assert(!containsAny(reply, 'שיחה קצרה', 'מתי נוח'), 'does not re-push call after decline', reply);
  } finally {
    await deleteLead(phone);
  }
}

async function scenarioTimetableThenThankyou() {
  console.log('\n── Scenario 7: Timetable request followed by "תודה" ──');
  const phone = syntheticPhone();
  try {
    const r1 = await simulate(phone, 'אפשר לקבל מערכת שעות?');
    console.log(`  Barak (timetable): ${r1.barakReply ?? '(no reply)'}`);

    const r2 = await simulate(phone, 'תודה');
    console.log(`  Barak (תודה): ${r2.barakReply ?? '(silent — correct)'}`);

    assert(r1.route === 'barak', 'timetable: routed to barak', r1.route);
    // "תודה" is a brief ack — should be silently acknowledged (no AI reply)
    assert(
      r2.route === 'acknowledged' || r2.barakReply === null || r2.barakReply === '',
      'תודה gets no AI reply (brief ack)',
      { route: r2.route, reply: r2.barakReply },
    );
  } finally {
    await deleteLead(phone);
  }
}

async function scenarioNonSchedulingFollowup() {
  console.log('\n── Scenario 8: Non-scheduling question after a reply ──');
  const phone = syntheticPhone();
  try {
    await simulate(phone, 'שלום, מחדרה, מחפשת כוח');
    // Send a price question shortly after — should not be dropped by cooldown
    const r = await simulate(phone, 'כמה עולה?');
    const reply = r.barakReply ?? '';
    console.log(`  Barak: ${reply}`);

    assert(r.route === 'barak', 'routed to barak', r.route);
    // Price question must be answered, not dropped or redirected without answering
    assert(
      containsAny(reply, 'כניסות', 'מנוי', 'ש"ח', 'מחיר', '₪', 'תדירות'),
      'price follow-up answered (not dropped)',
      reply,
    );
  } finally {
    await deleteLead(phone);
  }
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function run() {
  console.log(`Running Barak conversation tests against ${BASE}`);
  console.log('(Using real OpenAI model — results depend on current prompt and model)\n');

  try {
    await scenarioTimetableOnly();
    await scenarioBurst();
    await scenarioMultiFactFirst();
    await scenarioPriceQuestion();
    await scenarioPriceTooHigh();
    await scenarioDeclineCall();
    await scenarioTimetableThenThankyou();
    await scenarioNonSchedulingFollowup();
  } catch (err) {
    console.error('\nFATAL test error:', err.message);
  }

  console.log(`\n────────────────────────────────`);
  console.log(`PASSED: ${passed.length}  FAILED: ${failed.length}`);
  if (failed.length > 0) {
    console.error('Failed assertions:');
    failed.forEach(f => console.error(`  ✗ ${f}`));
    process.exit(1);
  } else {
    console.log('All assertions passed.');
  }
}

run();
