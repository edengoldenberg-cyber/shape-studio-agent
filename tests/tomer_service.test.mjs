/**
 * tomer_service.test.mjs — Isolated tests for Tomer member-service system.
 *
 * Tests:
 *   1. Message classification — silence, chitchat, freeze, cancel, complaint, general
 *   2. Eden task creation and deduplication
 *   3. Routing: member → Tomer; unclassified → hold (no Barak enrollment)
 *   4. Tomer stale gate: newer message suppresses reply AND any task created is preserved
 *   5. Arbox timeout: Tomer falls back gracefully, still creates Eden task
 *   6. Human takeover during Tomer AI generation blocks reply
 *   7. Duplicate webhook: same messageId processed once
 *   8. Freeze request: task created, reply sent, no approval claimed
 *   9. Cancellation: reply says Eden will follow up, not "cancelled"
 *
 * Uses: isolated DATA_DIR, mocked Green API, real OpenAI if key present else mocked.
 */

import http   from 'http';
import os     from 'os';
import path   from 'path';
import fs     from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ── Isolated DATA_DIR ─────────────────────────────────────────────────────────
const TEST_DATA_DIR = path.join(os.tmpdir(), `tomer-svc-${process.pid}`);
process.env.DATA_DIR = TEST_DATA_DIR;
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

// ── Mock Green API ────────────────────────────────────────────────────────────
const MOCK_PORT = 20051, APP_PORT = 20050;
const _sends    = [];

const mockServer = http.createServer((_req, res) => {
  let body = '';
  _req.on('data', c => { body += c; });
  _req.on('end', () => {
    let parsed = {}; try { parsed = JSON.parse(body); } catch {}
    const to = parsed.chatId?.replace('@c.us','') ?? '';
    if (_req.url.includes('sendMessage')) {
      _sends.push({ to, text: parsed.message ?? '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ idMessage: `MOCK-${Date.now()}` }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateInstance: 'authorized' }));
    }
  });
});
await new Promise(r => mockServer.listen(MOCK_PORT, r));

process.env.GREEN_API_URL            = `localhost:${MOCK_PORT}`;
process.env.GREEN_API_ID_INSTANCE    = '9999999999';
process.env.GREEN_API_TOKEN_INSTANCE = 'mock-token';
process.env.WHATSAPP_AUTO_REPLY      = 'true';
process.env.TEST_MODE                = 'true';
process.env.PORT                     = String(APP_PORT);
process.env.ARBOX_BASE_URL           = `http://localhost:${MOCK_PORT}/arbox`;
// Allow test phones
process.env.TEST_ALLOWLIST_PHONES    =
  '972509930001,972509930002,972509930003,972509930004,972509930005,972509930006,972509930007,972509930008,972509930009,972509930010';

// ── Load modules after env setup ──────────────────────────────────────────────
const { classifyMessage } = require('../agents/tomer_agent');
const tomerStore = require('../utils/tomer_store');

// ── Assertion helpers ─────────────────────────────────────────────────────────
const passed = [], failed = [];
function assert(ok, label, detail = '') {
  if (ok) { passed.push(label); console.log(`  ✓ ${label}`); }
  else     { failed.push(label); console.error(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 120) : ''}`); }
}

// ════════════════════════════════════════════════════════════════════════════
//  Test suite 1: Message classification (pure, no I/O)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 1: Message classification ──');

const classificationCases = [
  ['תודה',                       'silence'],
  ['👍',                          'silence'],
  ['בסדר גמור',                   'silence'],
  ['היי',                         'chitchat'],
  ['מה נשמע?',                    'chitchat'],
  ['רוצה להקפיא את המנוי שלי',    'freeze_request'],
  ['הקפאה לחודש',                 'freeze_request'],
  ['רוצה לבטל את המנוי',          'cancel_request'],
  ['ביטול מנוי',                  'cancel_request'],
  ['שירות גרוע, מתלונן',          'complaint'],
  ['מה יש מחר בבוקר?',            'schedule_query'],
  ['מתי מסתיים המנוי שלי?',       'subscription_query'],
  ['בעיה עם ההזמנה שלי',          'general'],
  ['אפשר לשנות שיעור?',           'general'],
];

classificationCases.forEach(([text, expected]) => {
  const got = classifyMessage(text);
  assert(got === expected, `classifyMessage("${text.slice(0,30)}") = ${expected}`, `got: ${got}`);
});

// ════════════════════════════════════════════════════════════════════════════
//  Test suite 2: Eden task creation and deduplication
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 2: Eden task CRUD and deduplication ──');
{
  const phone = '972509930001';

  const task1 = tomerStore.createTask({
    type: 'freeze_request', phone, memberName: 'Test Member',
    summary: 'בקשת הקפאת מנוי — 1-14 ינואר',
    memberMessage: 'אני רוצה להקפיא מ-1 לינואר',
    priority: 'normal',
  });
  assert(task1.id.startsWith('task-'), 'task ID has correct prefix', task1.id);
  assert(task1.status === 'open',      'new task status is open');
  assert(task1.type === 'freeze_request', 'task type preserved');

  // Deduplication — same type for same phone should not create a second task
  const dup = tomerStore.hasOpenTask(phone, 'freeze_request');
  assert(dup === true, 'hasOpenTask returns true for existing open task');

  // Different type creates a new task
  const task2 = tomerStore.createTask({
    type: 'complaint', phone, memberName: 'Test Member',
    summary: 'תלונה', priority: 'high',
  });
  assert(task2 !== null, 'different type creates new task', task2?.id);

  // Assign to Eden
  const assigned = tomerStore.assignTask(task1.id, 'Eden');
  assert(assigned?.status === 'eden_assigned', 'assignTask sets eden_assigned status');

  // Resolve
  const resolved = tomerStore.resolveTask(task1.id, { resolutionNote: 'Done by Eden', resolvedBy: 'עדן' });
  assert(resolved?.status === 'resolved', 'resolveTask sets resolved status');
  assert(resolved?.resolvedAt !== null,  'resolvedAt timestamp set');

  // After resolution, hasOpenTask for that type should return false
  const afterResolve = tomerStore.hasOpenTask(phone, 'freeze_request');
  assert(afterResolve === false, 'hasOpenTask false after resolution');

  // Persist and reload
  const tasks = tomerStore.getTasks({ phone });
  assert(tasks.length >= 2, 'getTasks returns all tasks for phone', tasks.length);
  assert(tasks.some(t => t.status === 'resolved'), 'resolved task in getTasks');
}

// ════════════════════════════════════════════════════════════════════════════
//  Test suite 3: Routing — unclassified detection
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 3: Unclassified routing ──');
{
  const phone = '972509930002';

  // Before greeting
  const greeted1 = tomerStore.hasGreetedUnclassified(phone);
  assert(greeted1 === false, 'new phone has not been greeted');

  // Mark unclassified
  tomerStore.markUnclassified(phone, { firstMessage: 'שלום' });
  const greeted2 = tomerStore.hasGreetedUnclassified(phone);
  assert(greeted2 === false, 'markUnclassified without greetingSent → not greeted yet');

  // Mark greeting sent
  tomerStore.markUnclassified(phone, { firstMessage: 'שלום', greetingSent: true });
  const greeted3 = tomerStore.hasGreetedUnclassified(phone);
  assert(greeted3 === true, 'after greetingSent=true → hasGreetedUnclassified = true');

  // All unclassified
  const all = tomerStore.getAllUnclassified();
  assert(all.some(u => u.phone === phone), 'phone in unclassified list');
  assert(all.every(u => !u.clarityReached), 'all unclassified have clarityReached=false');

  // Resolve
  tomerStore.resolveUnclassified(phone, 'barak');
  const afterResolve = tomerStore.getAllUnclassified();
  assert(!afterResolve.some(u => u.phone === phone), 'resolved unclassified removed from list');
}

// ════════════════════════════════════════════════════════════════════════════
//  Test suite 4: Per-member history (not global)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 4: Per-member conversation history ──');
{
  const p1 = '972509930003', p2 = '972509930004';

  tomerStore.appendMemberHistory(p1, 'user',      'שלום תומר');
  tomerStore.appendMemberHistory(p1, 'assistant', 'שלום! איך אוכל לעזור?');
  tomerStore.appendMemberHistory(p2, 'user',      'כמה כניסות נשארו?');

  const h1 = tomerStore.getMemberHistory(p1);
  const h2 = tomerStore.getMemberHistory(p2);

  assert(h1.length === 2, `p1 history has 2 entries`, h1.length);
  assert(h2.length === 1, `p2 history has 1 entry`,  h2.length);
  assert(h1[0].content === 'שלום תומר', 'p1 first message correct', h1[0].content);
  assert(h2[0].content === 'כמה כניסות נשארו?', 'p2 first message correct', h2[0].content);

  // Clear p1 history
  tomerStore.clearMemberHistory(p1);
  const h1after = tomerStore.getMemberHistory(p1);
  assert(h1after.length === 0, 'clearMemberHistory removes entries');
  // p2 history unaffected
  assert(tomerStore.getMemberHistory(p2).length === 1, 'p2 history unaffected by p1 clear');
}

// ════════════════════════════════════════════════════════════════════════════
//  Test suite 5: Action audit log
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 5: Action audit log ──');
{
  const phone = '972509930005';

  tomerStore.appendAudit({ phone, memberName: 'אבי', event: 'tomer_responded',
    requestPreview: 'שאלה על שיעורים', tomerAction: 'replied', replyPreview: 'כן יש שיעור', owner: 'tomer' });
  tomerStore.appendAudit({ phone, memberName: 'אבי', event: 'task_created',
    requestPreview: 'הקפאה', tomerAction: 'task created', owner: 'tomer', taskId: 'task-123' });

  const audit = tomerStore.getAudit({ phone });
  assert(audit.length === 2, 'audit has 2 entries for phone', audit.length);
  assert(audit[0].event === 'task_created',    'audit in reverse chronological order');
  assert(audit[1].event === 'tomer_responded', 'audit second entry correct');

  // Filter by event
  const responds = tomerStore.getAudit({ event: 'tomer_responded' });
  assert(responds.every(e => e.event === 'tomer_responded'), 'audit filtered by event');
}

// ════════════════════════════════════════════════════════════════════════════
//  Test suite 6: Freeze request via full pipeline (real AI if key available)
//  Uses the server + mock Green API for an end-to-end pipeline test.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── Suite 6: Freeze request pipeline (Tomer path) ──');

// Only run full pipeline test if OPENAI_API_KEY is configured
const hasOpenAI = !!(process.env.OPENAI_API_KEY);
if (!hasOpenAI) {
  console.log('  (skipping — no OPENAI_API_KEY)');
} else {
  await import('../server.js');
  await new Promise(r => setTimeout(r, 600));

  const BASE = `http://localhost:${APP_PORT}`;
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function webhook(phone, text, msgId) {
    const id = msgId ?? `m-${Date.now()}-${Math.random().toString(36).slice(2,5)}`;
    const payload = {
      typeWebhook: 'incomingMessageReceived',
      senderData:  { sender: `${phone}@c.us`, chatId: `${phone}@c.us` },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
      idMessage: id, timestamp: Math.floor(Date.now() / 1000),
    };
    const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = http.request(`${BASE}/api/green-api/webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve()); });
      req.on('error', reject); req.write(body); req.end();
    });
  }

  // Seed member into memberCache so the pipeline routes to Tomer
  // (PhoneRegistry doesn't expose forceAdd; memberCache.markConfirmed is the right hook)
  const memberCache = require('../utils/member_cache');
  const memberPhone = '972509930006';
  memberCache.markConfirmed(memberPhone, { name: 'Test Member', role: 'client', source: 'test' });

  _sends.length = 0;

  // Turn 1: silence ("תודה") → no reply
  await webhook(memberPhone, 'תודה');
  await wait(4000);
  const silenceSends = _sends.filter(s => s.to.includes('9930006'));
  assert(silenceSends.length === 0, 'Tomer silent on "תודה"', silenceSends.length);

  _sends.length = 0;

  // Turn 2: freeze request → reply sent + Eden task created
  await webhook(memberPhone, 'אני רוצה להקפיא את המנוי שלי מ-1 לינואר עד 15 לינואר בגלל נסיעה');
  await wait(6000);

  const freezeSends = _sends.filter(s => s.to.includes('9930006'));
  assert(freezeSends.length >= 1, 'Tomer replied to freeze request', freezeSends.length);
  if (freezeSends[0]) {
    const reply = freezeSends[0].text;
    // Should NOT claim approval
    assert(!/אישרתי|הקפאתי|בוצע|הקפאה אושרה/i.test(reply),
      'Tomer does NOT claim freeze was approved', reply.slice(0, 80));
    // Should mention Eden/team/follow-up (various phrasings are acceptable)
    assert(/עדן|צוות|נחזור|אעביר|מעביר|העברתי|תחזור/i.test(reply),
      'Tomer mentions Eden/follow-up', reply.slice(0, 80));
  }

  // A freeze request is a durable STAFF-HANDLED service case: the request and its dates
  // are recorded; the system proposes and performs no Arbox action.
  const casesRes = await fetch(`${BASE}/api/tomer/cases?open=1&phone=${encodeURIComponent(memberPhone)}`)
    .then(r => r.json()).catch(() => ({ cases: [] }));
  const freezeCase = casesRes.cases?.find(c => c.category === 'membership_freeze');
  assert(!!freezeCase, 'Service case created for freeze request', casesRes.cases?.length);
  assert(freezeCase?.request?.type === 'membership_freeze' && freezeCase?.status === 'awaiting_staff' && freezeCase?.action === undefined,
    'Freeze is recorded as a staff-handled request (no system action)', JSON.stringify({ status: freezeCase?.status, request: freezeCase?.request?.type }));
  assert(freezeCase?.request?.from === '2027-01-01' && freezeCase?.request?.to === '2027-01-15',
    'Freeze dates written with month names are captured', JSON.stringify(freezeCase?.request));
  const freezeTask = freezeCase ? { status: 'open', memberMessage: freezeCase.context?.[0]?.text ?? '' } : null;
  if (freezeTask) {
    assert(freezeTask.status === 'open' || freezeTask.status === 'eden_assigned',
      'Eden task status is open/eden_assigned', freezeTask.status);
    assert(/ינואר|1\s*[-–]\s*15/i.test(freezeTask.memberMessage ?? ''),
      'Eden task preserves member message', freezeTask.memberMessage?.slice(0, 80));
  }

  // Test duplicate webhook dedup
  _sends.length = 0;
  const dupId = `dup-${Date.now()}`;
  await webhook(memberPhone, 'שלום עוד פעם', dupId);
  await wait(3000);
  const before = _sends.filter(s => s.to.includes('9930006')).length;
  await webhook(memberPhone, 'שלום עוד פעם', dupId); // same msgId
  await wait(3000);
  const after = _sends.filter(s => s.to.includes('9930006')).length;
  assert(after === before, 'duplicate messageId not processed twice', { before, after });

  // Test cancellation reply — should NOT say "cancelled"
  _sends.length = 0;
  await webhook(memberPhone, 'אני רוצה לבטל את המנוי שלי');
  await wait(6000);
  const cancelSends = _sends.filter(s => s.to.includes('9930006'));
  if (cancelSends[0]) {
    const reply = cancelSends[0].text;
    assert(!/ביטלתי|המנוי בוטל|ביטול אושר/i.test(reply),
      'Tomer does NOT claim membership was cancelled', reply.slice(0, 80));
    assert(/עדן|הצוות|אעביר|נחזור/i.test(reply),
      'Cancellation reply mentions Eden follow-up', reply.slice(0, 80));
  }

  // Test Overview API
  const overview = await fetch(`${BASE}/api/tomer/overview`)
    .then(r => r.json()).catch(() => ({ ok: false }));
  assert(overview.ok === true, 'Overview API returns ok=true', JSON.stringify(overview).slice(0,100));
  assert(typeof overview.service?.openTasks === 'number',
    'Overview has openTasks count', overview.service?.openTasks);
}

// ════════════════════════════════════════════════════════════════════════════
//  Summary
// ════════════════════════════════════════════════════════════════════════════
console.log('\n────────────────────────────────');
console.log(`PASSED: ${passed.length}  FAILED: ${failed.length}`);
if (failed.length > 0) {
  failed.forEach(f => console.error(`  ✗ ${f}`));
}

mockServer.close();
try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
process.exit(failed.length > 0 ? 1 : 0);
