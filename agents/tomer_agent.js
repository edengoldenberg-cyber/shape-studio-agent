'use strict';

/**
 * tomer_agent.js — Shape Studio member-service agent.
 *
 * Responsibilities:
 *   - Handle inbound WhatsApp from confirmed Arbox members.
 *   - Classify message intent (service request vs. social vs. silence).
 *   - Inject real Arbox context (subscription status, upcoming schedule, member profile).
 *   - Create durable Eden tasks for requests that require human authority.
 *   - Maintain per-member conversation history keyed by phone (no global shared array).
 *
 * API limitations (honest):
 *   - Cannot book or cancel a specific class (Arbox public API v3 has no booking endpoint).
 *   - Cannot view a member's personal booking list or attendance history.
 *   - Cannot see or modify freeze/block status.
 *   - Cannot approve membership freezes or cancellations (Eden only).
 */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const logger = require('../utils/logger');
const store  = require('../utils/lead_store');
const tomerStore = require('../utils/tomer_store');
const { sendText, alertOwner } = require('../services/whatsapp.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Lazy-load Arbox to avoid circular deps at module load ─────────────────────
let _arbox = null;
function arbox() {
  if (!_arbox) _arbox = require('../services/arbox.service');
  return _arbox;
}

// ── Prompt loading ─────────────────────────────────────────────────────────────
const TOMER_PROMPT = (() => {
  try {
    const ctx   = fs.readFileSync(path.join(__dirname, '../prompts/business_context.md'), 'utf8');
    const tomer = fs.readFileSync(path.join(__dirname, '../prompts/tomer_prompt.md'), 'utf8');
    return `${ctx}\n\n---\n\n${tomer}`;
  } catch {
    return fs.readFileSync(path.join(__dirname, '../prompts/tomer_prompt.md'), 'utf8');
  }
})();

// ════════════════════════════════════════════════════════════════════════════
//  MESSAGE CLASSIFICATION
// ════════════════════════════════════════════════════════════════════════════

const SILENCE_RE  = /^(תודה( רבה)?|תנקיו|thanks?|ok[ay]?|אוקיי?|סבבה?|בסדר( גמור)?|קיבלתי|הבנתי|ברור|מעולה|נהדר|מצוין|חמוד|מגניב|יופי|שמעתי|פה|כאן|ביי|bye|ciao|😊|👍|🙏|❤️|✅|🙂|😁|💪|🎉|👌|🫡|🌸|⭐)\.?!*$/iu;
const CHITCHAT_RE = /^(היי|hey|hi|hola|מה שלומך|מה נשמע|מה קורה|תהיה טוב|יהיה בסדר|בהצלחה|להתראות|שבת שלום|חג שמח|בוקר טוב|לילה טוב)!*[\p{Emoji}]?$/iu;
const ACTIONABLE_RE = /ביטול|לבטל|לשנות|שעה|שיעור|לוח|מנוי|חידוש|תשלום|כניסה|להגיע|מגיע[ה]?|להירשם|בעיה|שאלה|עזרה|אימון|להצטרף|לקבוע|תיאום|סיום|הארכה|הפסקה|הקפאה|חזרה|חסרתי|לא הגעתי|קרה משהו|רשמי|תרשמי|תבטל|שינוי|לשנות|מתי|היכן|איפה|מחיר|כמה|מה כולל|לא עובד|שגיאה|לא הצלח/i;

// FREEZE_RE: matches הקפאה/הקפיא/להקפיא variants and compound phrases
const FREEZE_RE    = /הקפא[הית]?|להקפיא|הקפאת?\s+מנוי|לעצור\s+מנוי|pause|freeze/i;
// CANCEL_RE: matches cancellation regardless of filler words between לבטל and מנוי
// Note: \b doesn't work with Hebrew chars — use \s to anchor after לבטל
const CANCEL_RE    = /לבטל\s[^.?!]{0,25}מנוי|ביטול\s+מנוי|לסיים\s+מנוי|לעזוב\s+את\s+הסטודיו|cancel\s+membership|לצאת\s+מה?מנוי/i;
// COMPLAINT_RE: "בעיה עם" alone is a service query, not a complaint — require stronger signals
const COMPLAINT_RE = /תלונה|מתלונן|לא מרוצה|אכזבתם|שירות גרוע|לא הסכמנו|חוויה גרועה|מאוכזב|ציפיתי|הבטחתם|לא קיבלתי מה שהובטח/i;

function classifyMessage(text) {
  if (!text?.trim()) return 'silence';
  const t = text.trim();

  if (t.length <= 25 && SILENCE_RE.test(t))  return 'silence';
  if (t.length <= 60 && CHITCHAT_RE.test(t)) return 'chitchat';

  if (CANCEL_RE.test(t))    return 'cancel_request';
  if (FREEZE_RE.test(t))    return 'freeze_request';
  if (COMPLAINT_RE.test(t)) return 'complaint';

  if (/לוח\s+שיעורים|מערכת\s+שעות|מה\s+יש\s+היום|מה\s+יש\s+מחר|שעות\s+פעילות|מתי\s+יש\s+שיעור/i.test(t))
    return 'schedule_query';
  if (/מנוי|חידוש|כניסות|כמה\s+כניסות|תוקף|מתי\s+פג|מתי\s+מסתיים/i.test(t))
    return 'subscription_query';

  if (t.length <= 50 && !ACTIONABLE_RE.test(t)) return 'chitchat';
  return 'general';
}

// ════════════════════════════════════════════════════════════════════════════
//  ARBOX CONTEXT BUILDER
// ════════════════════════════════════════════════════════════════════════════

async function buildMemberContext(phone, clientMatch = {}) {
  const lines = ['[MEMBER_CONTEXT]'];

  try {
    let member = null;
    if (clientMatch.arboxId) {
      try {
        const all = await arbox().getAllUsers({ limit: 500 });
        member = all.find(u => String(u.user_id) === String(clientMatch.arboxId)) ?? null;
      } catch { /* fall through to phone lookup */ }
    }
    if (!member) {
      member = await arbox().getMemberByPhone(phone).catch(() => null);
    }

    if (member) {
      const name = `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim();
      const end  = member.membership_end_date?.slice(0, 10) ?? null;
      const now  = new Date();

      lines.push(`שם ב-Arbox: ${name || '(לא צוין)'}`);
      lines.push(`מזהה Arbox: ${member.user_id}`);
      lines.push(`סטטוס: ${member.active ? 'מנוי פעיל' : 'לא פעיל'}`);
      if (member.membership_start_date) lines.push(`הצטרף/ה: ${member.membership_start_date.slice(0, 10)}`);
      if (end) {
        const daysLeft = Math.ceil((new Date(end) - now) / 86400000);
        if (daysLeft > 0) {
          lines.push(`תוקף מנוי: ${end} (עוד ${daysLeft} ימים)${daysLeft <= 30 ? ' ⚠️ פג בקרוב' : ''}`);
        } else {
          lines.push(`תוקף מנוי: ${end} (פג לפני ${Math.abs(daysLeft)} ימים)`);
        }
      }
      if (member.gender)   lines.push(`מגדר: ${member.gender === 'female' ? 'נקבה' : member.gender === 'male' ? 'זכר' : member.gender}`);
      if (member.birthday) lines.push(`יום הולדת: ${(member.birthday ?? '').slice(0, 10)}`);
      lines.push(`תקשורת: SMS=${member.allow_sms ? 'כן' : 'לא'}, דוא"ל=${member.allow_email ? 'כן' : 'לא'}`);
    } else {
      lines.push('אין נתוני Arbox עבור מספר זה.');
      if (clientMatch.arboxName) lines.push(`שם ממקור אחר: ${clientMatch.arboxName}`);
    }

    // Studio schedule (not member-specific — Arbox public API v3 has no per-member bookings)
    try {
      const classes = await arbox().getUpcomingClasses({ days: 5, limit: 8 });
      if (classes.length > 0) {
        lines.push('', 'לוח שיעורים קרוב (כל הסטודיו):');
        const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
        classes.forEach(c => {
          const d    = new Date(c.date + 'T' + (c.start_time ?? '00:00'));
          const day  = dayNames[d.getDay()] ?? c.date;
          const link = c.registration_link ? ` | 🔗 ${c.registration_link}` : '';
          const cap  = c.max_participants ? ` (מקס ${c.max_participants})` : '';
          lines.push(`  • ${day} ${c.start_time ?? ''} — ${c.session_name ?? 'שיעור'}${cap} | ${c.staff_member?.name ?? '—'}${link}`);
        });
        lines.push('(הרשמה: דרך אפליקציית Arbox או הלינקים לעיל)');
      }
    } catch { /* non-fatal */ }

  } catch (err) {
    logger.warn('[tomer_agent] buildMemberContext failed', { phone, error: err.message });
    lines.push('(Arbox לא זמין כרגע)');
  }

  lines.push('[/MEMBER_CONTEXT]');
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
//  EDEN TASK CREATOR
// ════════════════════════════════════════════════════════════════════════════

function createEdenTask({ type, phone, memberName, arboxId, memberMessage, detail, requestedDates }) {
  if (tomerStore.hasOpenTask(phone, type)) {
    logger.info('[tomer_agent] Duplicate task suppressed', { phone, type });
    return { task: null, isNew: false };
  }

  const summaries = {
    freeze_request:     'בקשת הקפאת מנוי',
    cancel_request:     'בקשת ביטול מנוי',
    complaint:          'תלונה / בעיה שלא נפתרה',
    unsupported_action: 'פעולה שאינה נתמכת',
    billing_question:   'שאלת חיוב',
    other:              'פניית שירות כללית',
  };
  const summary  = (summaries[type] ?? 'פניית שירות') + (requestedDates ? ` — ${requestedDates}` : '');
  const priority = type === 'complaint' || type === 'cancel_request' ? 'high' : 'normal';

  const task = tomerStore.createTask({
    type, phone, memberName, arboxId,
    summary, detail, requestedDates, memberMessage, priority,
  });

  if (priority === 'high') {
    alertOwner(
      `🚨 תומר: ${summary} — ${memberName ?? phone.slice(-4)}`,
      `*חבר/ה:* ${memberName ?? '(לא ידוע)'}\n*טלפון:* ${phone}\n*בקשה:* ${(memberMessage ?? detail ?? '—').slice(0, 200)}\n*מזהה:* ${task.id}`
    ).catch(err => logger.warn('[tomer_agent] Eden alert failed', { error: err.message }));
  }

  return { task, isNew: true };
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN INBOUND HANDLER
// ════════════════════════════════════════════════════════════════════════════

async function handleInboundMember({ name, text, phone, clientMatch = {}, _pendingMessages = null }) {
  const memberName = clientMatch.arboxName ?? name ?? null;
  const arboxId    = clientMatch.arboxId ?? null;
  const msgText    = (text ?? '').trim();

  const msgClass = classifyMessage(msgText);

  store.logEvent(
    msgClass === 'silence' || msgClass === 'chitchat' ? 'tomer_silent' : 'tomer_responded',
    phone,
    { class: msgClass, preview: msgText.slice(0, 60), memberName }
  );

  if (msgClass === 'silence' || msgClass === 'chitchat') {
    logger.info('[tomer] Silent', { class: msgClass, phone });
    tomerStore.appendAudit({ phone, memberName, event: 'tomer_silent',
      requestPreview: msgText.slice(0, 100), tomerAction: `silent:${msgClass}`, owner: 'tomer' });
    return { reply: null, decision: 'silence', reason: msgClass };
  }

  // ── Eden task for escalation-required requests ───────────────────────────
  let taskCreated = null;
  if (msgClass === 'freeze_request' || msgClass === 'cancel_request' || msgClass === 'complaint') {
    const datesMatch = msgText.match(/\d{1,2}[\s./\-]\d{1,2}(?:[\s./\-]\d{2,4})?/g);
    const { task, isNew } = createEdenTask({
      type: msgClass, phone, memberName, arboxId,
      memberMessage: msgText,
      detail: msgText.slice(0, 300),
      requestedDates: datesMatch ? datesMatch.join(' — ') : null,
    });
    if (isNew && task) taskCreated = task;
  }

  // ── Arbox context (3-second timeout) ─────────────────────────────────────
  let memberContext;
  try {
    memberContext = await Promise.race([
      buildMemberContext(phone, clientMatch),
      new Promise(r => setTimeout(() => r('(Arbox timeout)'), 3000)),
    ]);
  } catch { memberContext = '(Arbox error)'; }

  // ── Stage hints for escalated requests ───────────────────────────────────
  const stageHints = {
    freeze_request:  '\n\n[STAGE] פתחתי משימה לעדן. ענה על הבקשה, ציין שהעברתי לעדן, שאל לתאריכים אם לא סופקו (שאלה אחת).',
    cancel_request:  '\n\n[STAGE] פתחתי משימה לעדן. ציין שהעברתי לעדן ואל תאשר ביטול.',
    complaint:       '\n\n[STAGE] פתחתי משימה לעדן. קבל את הדברים ברצינות ואמור שעדן תחזור.',
  };

  const history   = tomerStore.getMemberHistory(phone);
  const systemMsg = `${TOMER_PROMPT}\n\n${memberContext}${stageHints[msgClass] ?? ''}`;

  // ── OpenAI ────────────────────────────────────────────────────────────────
  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:    process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages: [
        { role: 'system', content: systemMsg },
        ...history,
        { role: 'user', content: msgText },
      ],
      temperature: 0.5,
      max_tokens:  350,
    });
    reply = completion.choices[0].message.content.trim();
  } catch (err) {
    logger.error('[tomer_agent] OpenAI error', { phone, error: err.message });
    // Safe fallback for requests where silence would abandon the member
    if (msgClass === 'freeze_request' || msgClass === 'cancel_request') {
      reply = 'קיבלתי את הבקשה שלך — העברתי לעדן ותחזור אליך בהקדם.';
    } else {
      return { reply: null, decision: 'silence', reason: 'ai-error', taskCreated };
    }
  }

  if (!reply || /^SILENCE$/i.test(reply.trim())) {
    tomerStore.appendAudit({ phone, memberName, event: 'tomer_ai_silence',
      requestPreview: msgText.slice(0, 100), tomerAction: 'ai returned SILENCE', owner: 'tomer' });
    return { reply: null, decision: 'silence', reason: 'ai-decided', taskCreated };
  }

  // ── Stale gate ────────────────────────────────────────────────────────────
  if (_pendingMessages?.has(phone)) {
    logger.info('[tomer_agent] Stale reply suppressed', { phone });
    store.logEvent('reply_suppressed_stale', phone, { agent: 'tomer' });
    return { reply, decision: 'silence', reason: 'stale', sendState: 'skipped_stale', taskCreated };
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  let sendState = 'sent';
  try {
    await sendText(phone, reply);
  } catch (sendErr) {
    logger.error('[tomer_agent] sendText failed', { phone, error: sendErr.message });
    sendState = 'failed';
  }

  tomerStore.appendMemberHistory(phone, 'user',      msgText);
  tomerStore.appendMemberHistory(phone, 'assistant', reply);

  tomerStore.appendAudit({
    phone, memberName, event: 'tomer_responded',
    requestPreview: msgText.slice(0, 100),
    tomerAction:    `replied (${msgClass})${taskCreated ? ` task:${taskCreated.id}` : ''}`,
    replyPreview:   reply.slice(0, 100),
    arboxStatus:    memberContext.includes('timeout') || memberContext.includes('error') ? 'degraded' : 'ok',
    owner: 'tomer', taskId: taskCreated?.id ?? null, sendState,
  });

  logger.info('[tomer] Responded', { phone, class: msgClass, sendState, task: taskCreated?.id ?? null });
  return { reply, decision: 'respond', reason: msgClass, sendState, taskCreated };
}

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN CHAT  (admin panel chat box)
// ════════════════════════════════════════════════════════════════════════════

let _adminHistory = [];

async function chat(userMessage) {
  _adminHistory.push({ role: 'user', content: userMessage });

  const openTasks = tomerStore.getOpenTasks();
  const ctx = [
    `## מצב שירות — ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`,
    `משימות פתוחות לעדן: ${openTasks.length}`,
    openTasks.slice(0, 5).map(t =>
      `  • [${t.priority}] ${t.type} — ${t.memberName ?? t.phone?.slice(-4)} (${t.createdAt.slice(0,10)})`
    ).join('\n') || '  (אין)',
  ].join('\n');

  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:    process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages: [
        { role: 'system', content: TOMER_PROMPT + '\n\n' + ctx },
        ..._adminHistory,
      ],
      temperature: 0.6,
      max_tokens:  600,
    });
    reply = completion.choices[0].message.content.trim();
  } catch (err) {
    logger.error('[tomer_agent] admin chat error', { error: err.message });
    reply = 'שגיאה טכנית.';
  }

  _adminHistory.push({ role: 'assistant', content: reply });
  _adminHistory = _adminHistory.slice(-30);
  return reply;
}

function clearHistory() { _adminHistory = []; }

// ════════════════════════════════════════════════════════════════════════════
//  LEGACY SHIM — runDailyChecks (delegates to retention_worker)
// ════════════════════════════════════════════════════════════════════════════

async function runDailyChecks() {
  logger.info('[tomer_agent] runDailyChecks — delegating to retention_worker');
  try {
    const rw = require('../workers/retention_worker');
    return await rw.runAllWorkflows();
  } catch (err) {
    logger.warn('[tomer_agent] retention_worker unavailable', { error: err.message });
    return { reEngaged: 0, skipped: 0, errors: 1 };
  }
}

module.exports = {
  handleInboundMember,
  classifyMessage,
  chat,
  clearHistory,
  runDailyChecks,
  buildMemberContext,
  createEdenTask,
};
