/**
 * panel_demo_local.js — populated Tomer panel demo with mocked external services.
 *
 * All data is synthetic. Names, phones (972001… prefix), and Arbox IDs (9000x) are
 * clearly in the demo range and cannot be confused with real members.
 *
 * What is seeded:
 *   • 5 Arbox members (mock returns them from /v3/users)
 *   • 2 protected leads: human_owns (דנה), attribution_review (רונית)
 *   • 1 aging conversation 3h old (לאה, non-Arbox lead)
 *   • 2 Eden tasks: freeze_request HIGH + cancel_request normal
 *   • 3 audit entries: 1 failed send + 2 sent
 *   • onboarding1 workflow enabled → eligible member visible in Upcoming tab
 *   • Inbox thread for דנה (3-message conversation) visible in member drawer
 *
 * Run:  node tests/panel_demo_local.js
 * Stop: Ctrl+C
 */

'use strict';

const http = require('http');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── Isolated environment ──────────────────────────────────────────────────────
const DATA_DIR  = path.join(os.tmpdir(), `panel-demo-${process.pid}`);
fs.mkdirSync(DATA_DIR, { recursive: true });

const MOCK_PORT = 20083;
const APP_PORT  = 3099;

// ── Demo phones (972001 prefix = synthetic range, never real IL numbers) ──────
const P_DANA    = '972001100001';  // דנה כהן    — human_owns, freeze task
const P_RONIT   = '972001100002';  // רונית שמיר  — attribution_review, onboarding w1
const P_MAYA    = '972001100003';  // מאיה ברקוביץ — expiring in 5 days
const P_NOA     = '972001100004';  // נועה אביב   — birthday today
const P_SARA    = '972001100005';  // שרה לוי    — active member, cancel task
const P_LEAH    = '972001200001';  // לאה מזרחי   — warm lead (NOT Arbox), aging convo

const today     = new Date();
const todayStr  = today.toISOString().slice(0, 10);
const ago7      = new Date(today - 7 * 86400000).toISOString().slice(0, 10);   // onboarding1
const exp5      = new Date(today.getTime() + 5 * 86400000).toISOString().slice(0, 10);  // expiring
const joined60  = new Date(today - 60 * 86400000).toISOString().slice(0, 10);
const joined90  = new Date(today - 90 * 86400000).toISOString().slice(0, 10);

// ── Mock Arbox member records ─────────────────────────────────────────────────
const ARBOX_MEMBERS = [
  { user_id: 90001, first_name: 'דנה',  last_name: 'כהן',       phone: P_DANA,  user_role: 'client', active: 1,
    membership_start_date: joined60, membership_end_date: joined60.replace(/\d{4}$/, String(today.getFullYear() + 1)), allow_sms: true },
  { user_id: 90002, first_name: 'רונית', last_name: 'שמיר',      phone: P_RONIT, user_role: 'client', active: 1,
    membership_start_date: ago7,     membership_end_date: new Date(today.getTime() + 350 * 86400000).toISOString().slice(0,10), allow_sms: true },
  { user_id: 90003, first_name: 'מאיה', last_name: 'ברקוביץ',    phone: P_MAYA,  user_role: 'client', active: 1,
    membership_start_date: joined90, membership_end_date: exp5, allow_sms: true },
  { user_id: 90004, first_name: 'נועה',  last_name: 'אביב',       phone: P_NOA,   user_role: 'client', active: 1,
    membership_start_date: joined60, membership_end_date: new Date(today.getTime() + 300 * 86400000).toISOString().slice(0,10),
    birthday: todayStr, allow_sms: true },
  { user_id: 90005, first_name: 'שרה',  last_name: 'לוי',        phone: P_SARA,  user_role: 'client', active: 1,
    membership_start_date: joined90, membership_end_date: new Date(today.getTime() + 270 * 86400000).toISOString().slice(0,10), allow_sms: true },
];

// ── Mock Green API + Arbox ────────────────────────────────────────────────────
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    // Drop all WhatsApp sends silently
    if (req.url.includes('sendMessage') || req.url.includes('sendFileByUrl')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ idMessage: `demo-${Date.now()}` }));
      return;
    }
    if (req.url.includes('getStateInstance')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stateInstance: 'authorized' }));
      return;
    }
    if (req.url.includes('/v3/users')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: ARBOX_MEMBERS }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
});

mockServer.listen(MOCK_PORT, () => {
  console.log(`[demo] Mock server listening on :${MOCK_PORT}`);
});

// ── Pre-seed leads_persist.json (before server starts) ───────────────────────
// human_owns and attribution_review survive the startup purge (reclassifyAsConvertedMember protects them).
// לאה is NOT in Arbox, so her warm status survives unchanged.
const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
const twoDaysAgo    = new Date(Date.now() - 2 * 86400000).toISOString();

fs.writeFileSync(path.join(DATA_DIR, 'leads_persist.json'), JSON.stringify({
  savedAt: new Date().toISOString(),
  leads: [
    [P_DANA,  { phone: P_DANA,  name: '[DEMO] דנה כהן',       score: 7, status: 'human_owns',         messageCount: 4,
                firstSeen: twoDaysAgo, lastActivity: threeHoursAgo, introOfferSent: false,
                history: [], meta: { humanOwnsBy: 'Eden', humanOwnsAt: threeHoursAgo, humanOwnsReason: 'manual_panel' } }],
    [P_RONIT, { phone: P_RONIT, name: '[DEMO] רונית שמיר',     score: 6, status: 'attribution_review', messageCount: 2,
                firstSeen: twoDaysAgo, lastActivity: threeHoursAgo, introOfferSent: false,
                history: [], meta: { attributionReviewIdMessage: 'demo-echo-id-90002',
                                     attributionReviewReason: 'grace_expired_unresolved',
                                     attributionReviewSince: threeHoursAgo,
                                     attributionReviewPrevStatus: 'warm' } }],
    [P_LEAH,  { phone: P_LEAH,  name: '[DEMO] לאה מזרחי',      score: 5, status: 'warm',               messageCount: 3,
                firstSeen: twoDaysAgo, lastActivity: threeHoursAgo, introOfferSent: true,
                history: [], meta: {} }],
  ],
  members: [],
  events:  [],
}), 'utf8');
console.log('[demo] leads_persist.json written');

// ── Pre-seed inbox_persist.json (thread for member drawer) ───────────────────
// Pre-seeding threads populates inbox._threads → visible in the member drawer.
// The flat _msgs ring buffer is populated later (see post-startup injection below).
const t1 = new Date(Date.now() - 3 * 3600000);
const t2 = new Date(Date.now() - 2 * 3600000 - 20 * 60000);
const t3 = new Date(Date.now() - 2 * 3600000);

fs.writeFileSync(path.join(DATA_DIR, 'inbox_persist.json'), JSON.stringify({
  savedAt: new Date().toISOString(),
  threads: [
    { phone: P_DANA, thread: {
        phone: P_DANA, name: '[DEMO] דנה כהן', fromIsraeli: true,
        lastText: 'אפשר להקפיא את המנוי שלי?', lastAt: t3, unreadCount: 1,
        messages: [
          { id: 'demo-d1', direction: 'in',  text: 'שלום, יש לי שאלה לגבי המנוי', timestamp: t1, intent: 'general', route: 'tomer' },
          { id: 'demo-d2', direction: 'out', text: 'שלום דנה! בשמחה, מה השאלה?',  timestamp: new Date(t1.getTime() + 90000), intent: null, route: null, agentId: 'tomer' },
          { id: 'demo-d3', direction: 'in',  text: 'אפשר להקפיא את המנוי שלי? אני עוברת ניתוח בשבוע הבא', timestamp: t3, intent: 'freeze_request', route: 'human_owns_hold' },
        ],
      },
    },
    { phone: P_LEAH, thread: {
        phone: P_LEAH, name: '[DEMO] לאה מזרחי', fromIsraeli: true,
        lastText: 'שלחת לי מחירון?', lastAt: t2, unreadCount: 1,
        messages: [
          { id: 'demo-l1', direction: 'in',  text: 'היי, ראיתי שיש לכם שיעורי פילאטיס', timestamp: new Date(t2.getTime() - 20 * 60000), intent: 'sales', route: 'barak' },
          { id: 'demo-l2', direction: 'out', text: 'כן! יש לנו ריפורמר ומחצלת. את רוצה שאשלח מחירון?', timestamp: new Date(t2.getTime() - 15 * 60000), intent: null, route: null, agentId: 'barak' },
          { id: 'demo-l3', direction: 'in',  text: 'שלחת לי מחירון?', timestamp: t2, intent: 'general', route: 'barak', barakReply: null },
        ],
      },
    },
  ],
  seenIds: ['demo-d1','demo-d2','demo-d3','demo-l1','demo-l2','demo-l3'],
}), 'utf8');
console.log('[demo] inbox_persist.json written');

// ── Env (must be set before server.js is require()d) ─────────────────────────
process.env.DATA_DIR                 = DATA_DIR;
process.env.PORT                     = String(APP_PORT);
process.env.TEST_MODE                = 'true';
process.env.WHATSAPP_AUTO_REPLY      = 'false';   // zero real sends
process.env.GREEN_API_URL            = `localhost:${MOCK_PORT}`;
process.env.GREEN_API_ID_INSTANCE    = '9999991';
process.env.GREEN_API_TOKEN_INSTANCE = 'demo-token';
process.env.ARBOX_BASE_URL           = `http://localhost:${MOCK_PORT}/arbox`;
process.env.ARBOX_API_KEY            = 'demo-arbox-key';
process.env.ARBOX_LOCATION_ID        = '1';
process.env.TEST_ALLOWLIST_PHONES    = [P_DANA, P_RONIT, P_MAYA, P_NOA, P_SARA, P_LEAH].join(',');
delete process.env.OPENAI_API_KEY;   // prevent AI calls

// ── Boot server ───────────────────────────────────────────────────────────────
const store = require('../utils/lead_store');
require('../server.js');

// ── Post-startup fixture injection ────────────────────────────────────────────
// After 2.5s the startup purge and phone-registry warm-up are complete.
// Inject remaining fixture data directly into module singletons.
setTimeout(async () => {
  const tomerStore       = require('../utils/tomer_store');
  const retentionWorker  = require('../workers/retention_worker');
  const inbox            = require('../utils/whatsapp_inbox');

  // ── 1. Re-seed leads that the startup purge may have reclassified ─────────
  // (human_owns and attribution_review are protected; warm lead לאה is not Arbox so unchanged)
  // Add the aging inbox entry for לאה directly into _msgs so it appears in Today aging list.
  const threeH = new Date(Date.now() - 3 * 3600000);
  const twoHp  = new Date(Date.now() - 2 * 3600000 - 10 * 60000); // 2h10m ago

  // Push inbox flat entries with backdated receivedAt — required for aging conv detection
  inbox._msgs.push({
    id: 'demo-flat-l3', from: P_LEAH, fromIsraeli: true, name: '[DEMO] לאה מזרחי',
    text: 'שלחת לי מחירון?', messageId: 'demo-l3',
    timestamp: twoHp, receivedAt: twoHp,
    clientMatch: null, intent: 'general', route: 'barak', barakReply: null, readAt: null,
    mediaType: 'text', mediaCaption: null, mediaId: null,
  });
  inbox._msgs.push({
    id: 'demo-flat-d3', from: P_DANA, fromIsraeli: true, name: '[DEMO] דנה כהן',
    text: 'אפשר להקפיא את המנוי שלי? אני עוברת ניתוח', messageId: 'demo-d3',
    timestamp: threeH, receivedAt: threeH,
    clientMatch: null, intent: 'freeze_request', route: 'human_owns_hold', barakReply: null, readAt: null,
    mediaType: 'text', mediaCaption: null, mediaId: null,
  });
  console.log('[demo] Aging inbox entries injected');

  // ── 2. Eden tasks ─────────────────────────────────────────────────────────
  const task1 = tomerStore.createTask({
    phone:         P_DANA,
    memberName:    '[DEMO] דנה כהן',
    type:          'freeze_request',
    priority:      'high',
    summary:       'הקפאת מנוי — ניתוח',
    detail:        'דנה מבקשת להקפיא 3 שבועות עקב ניתוח בשבוע הבא. לאשר מול הנהלה ולעדכן Arbox.',
    memberMessage: 'אפשר להקפיא את המנוי שלי? אני עוברת ניתוח בשבוע הבא',
    requestedDates: `${todayStr} עד ${new Date(today.getTime() + 21 * 86400000).toISOString().slice(0,10)}`,
  });
  tomerStore.assignTask(task1.id, 'Eden');

  tomerStore.createTask({
    phone:         P_SARA,
    memberName:    '[DEMO] שרה לוי',
    type:          'cancel_request',
    priority:      'normal',
    summary:       'שיחה על ביטול — עלות',
    detail:        'שרה ציינה שהמחיר גבוה מדי. לנסות שימור לפני ביטול.',
    memberMessage: 'אני חושבת לבטל, זה יקר מדי בשבילי',
  });
  console.log('[demo] Eden tasks created:', task1.id);

  // ── 3. Audit entries (action history) ────────────────────────────────────
  const twoH  = new Date(Date.now() - 2 * 3600000);
  const oneH  = new Date(Date.now() - 1 * 3600000);

  tomerStore.appendAudit({
    phone:          P_RONIT,
    memberName:     '[DEMO] רונית שמיר',
    event:          'onboarding1_sent',
    requestPreview: 'שלום רונית! שבוע הראשון — איך הולך?',
    tomerAction:    'send_whatsapp',
    replyPreview:   null,
    sendState:      'failed',
    arboxStatus:    'active',
    ts:             twoH,
    errorDetail:    '[DEMO] provider_error: temporary Green API outage',
  });

  tomerStore.appendAudit({
    phone:          P_NOA,
    memberName:     '[DEMO] נועה אביב',
    event:          'birthday_sent',
    requestPreview: '🎂 יום הולדת שמח נועה!',
    tomerAction:    'send_whatsapp',
    replyPreview:   'תודה רבה! 🙏',
    sendState:      'sent',
    arboxStatus:    'active',
    ts:             oneH,
  });

  tomerStore.appendAudit({
    phone:          P_SARA,
    memberName:     '[DEMO] שרה לוי',
    event:          'cancel_request_detected',
    requestPreview: 'אני חושבת לבטל, זה יקר מדי',
    tomerAction:    'create_eden_task',
    replyPreview:   'העברתי את הבקשה לטיפול. עדן תחזור אלייך בהקדם.',
    sendState:      'sent',
    arboxStatus:    'active',
    ts:             new Date(Date.now() - 30 * 60000),
  });
  console.log('[demo] Audit entries injected');

  // ── 4. Enable onboarding1 workflow (רונית is eligible — joined 7 days ago) ──
  retentionWorker.enableWorkflow('onboarding1');
  retentionWorker.enableWorkflow('birthday');  // נועה has birthday today
  console.log('[demo] onboarding1 + birthday workflows enabled');

  // ── 4b. Seed a message queue entry (simulates a sent retention message) ───
  const mqEntry = tomerStore.queueMessage({
    workflowId:   'birthday',
    phone:        P_NOA,
    memberName:   '[DEMO] נועה אביב',
    message:      'נועה, יום הולדת שמח! 🎂 שמחות שאת איתנו ב-Shape Studio — תהיי שנה מלאת בריאות ואנרגיה 💪',
    trigger:      'birthday eligibility met',
    scheduledFor: new Date().toISOString(),
  });
  tomerStore.markMessageSent(mqEntry.id, { idMessage: 'demo-green-api-birthday-noa' });

  const mqFail = tomerStore.queueMessage({
    workflowId:   'onboarding1',
    phone:        P_RONIT,
    memberName:   '[DEMO] רונית שמיר',
    message:      'רונית, שלום! 👋 שבוע אחד ב-Shape Studio — איך הולך?',
    trigger:      'onboarding1 eligibility met',
    scheduledFor: new Date().toISOString(),
  });
  tomerStore.markMessageFailed(mqFail.id, { error: '[DEMO] provider_error: temporary Green API outage' });
  console.log('[demo] Message queue entries seeded (1 sent, 1 failed)');

  // ── 5. Verify key APIs before printing checklist ──────────────────────────
  const checkUrl = (url) => new Promise((resolve) => {
    http.get(`http://localhost:${APP_PORT}${url}`, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });

  const [todayData, tasksData, membersData] = await Promise.all([
    checkUrl('/api/tomer/today'),
    checkUrl('/api/tomer/tasks'),
    checkUrl('/api/tomer/members-enriched'),
  ]);

  const aging     = todayData?.awaitingReply?.length  ?? '?';
  const tasks     = tasksData?.openCount              ?? '?';
  const members   = membersData?.members?.length      ?? '?';
  const failed    = todayData?.counts?.failedSends    ?? '?';
  const highPri   = todayData?.counts?.highPriority   ?? '?';

  console.log('\n' + '═'.repeat(62));
  console.log('  [DEMO] TOMER OPERATIONS PANEL — POPULATED FIXTURE');
  console.log('═'.repeat(62));
  console.log(`\n  URL: http://localhost:${APP_PORT}`);
  console.log('       → Click tab "💌 תומר"');
  console.log('\n  API verification:');
  console.log(`    /api/tomer/today    → aging convos: ${aging}, high-pri: ${highPri}, failed: ${failed}`);
  console.log(`    /api/tomer/tasks    → open tasks: ${tasks}`);
  console.log(`    /api/tomer/members-enriched → members: ${members}`);
  console.log('\n  Seeded [DEMO] data:');
  console.log('    דנה כהן     (90001) — human_owns + HIGH freeze task + 3-msg conversation');
  console.log('    רונית שמיר  (90002) — attribution_review + onboarding w1 eligible + failed send');
  console.log('    מאיה ברקוביץ (90003) — expiring in 5 days');
  console.log('    נועה אביב   (90004) — birthday today + sent in audit');
  console.log('    שרה לוי     (90005) — cancel task + cancel audit entry');
  console.log('    לאה מזרחי   (non-Arbox) — warm lead, aging convo 2h+ ago');
  console.log('\n─'.repeat(62));
  console.log('\n  WHAT TO CHECK IN EACH TAB:\n');
  console.log('  היום — KPIs, action list, aging convos, failed sends');
  console.log('  שיחות [NEW] — ALL unanswered threads, no 2h gate; ⚠️ after 2h');
  console.log('    • לאה: 💬 2h+ — inline thread preview, takeover button');
  console.log('    • דנה: 👤 human_owns — visible, release-to-bot button');
  console.log('  הודעות מתוזמנות [renamed + queue]:');
  console.log('    Queue: נועה birthday ✅ ספק אישר | רונית onboarding1 ❌ נכשל');
  console.log('    Eligibility: onboarding1 ✅ 1 זכאים | birthday ✅ | feedback ⏸ (new)');
  console.log('  חברים — 5 Arbox members; click פרופיל on דנה:');
  console.log('    drawer: Arbox profile + 3-msg thread + freeze task (HIGH)');
  console.log('    + studio schedule (5d) + limitations: הקפאה/ביטול/רישום → Arbox');
  console.log('  משימות — ❄️ הקפאה דנה (HIGH, eden_assigned) + 🚫 ביטול שרה');
  console.log('    "פרטים" shows member verbatim request + requested dates');
  console.log('  אוטומציה — onboarding1 ✅ birthday ✅ | onboarding2/attendance/feedback ⏸');
  console.log('  היסטוריה — "✅ ספק אישר" (not "נמסר") | "❌ נכשל" for failures');
  console.log('\n─'.repeat(62));
  console.log('\n  API cross-checks (browser address bar or curl):');
  console.log(`    http://localhost:${APP_PORT}/api/tomer/conversations  ← new: no 2h gate`);
  console.log(`    http://localhost:${APP_PORT}/api/tomer/message-queue  ← new: sent/failed queue`);
  console.log(`    http://localhost:${APP_PORT}/api/tomer/today`);
  console.log(`    http://localhost:${APP_PORT}/api/tomer/tasks`);
  console.log(`    http://localhost:${APP_PORT}/api/tomer/audit`);
  console.log(`    http://localhost:${APP_PORT}/api/tomer/upcoming`);
  console.log(`    http://localhost:${APP_PORT}/api/tomer/member/id/90001`);
  console.log('\n  Stop: Ctrl+C');
  console.log('═'.repeat(62) + '\n');

}, 2500);
