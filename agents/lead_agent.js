require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const OpenAI  = require('openai');
const logger  = require('../utils/logger');
const store   = require('../utils/lead_store');
const { sendText, alertOwner } = require('../services/whatsapp.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/system_prompt.md'),
  'utf8'
);

// ── Turn system-prompt builder ────────────────────────────────────────────────
//
// Turn 1 (completedTurns === 0) gets a completely isolated minimal prompt —
// the full SYSTEM_PROMPT is intentionally never passed to the model on the
// first message.  This eliminates the root cause of info-dumping: the model
// cannot mention studio details it has not been shown.
//
// All later turns receive the full SYSTEM_PROMPT plus a fresh stage-context
// block appended at the end.  Stage context is NEVER stored in history — it
// is rebuilt from live state on every call so there are no stale injections.

function buildTurnSystemPrompt(completedTurns, qualData, name, from, msgCount) {
  if (completedTurns === 0) {
    return [
      `You are Barak, a WhatsApp representative for Shape Studio.`,
      `A lead has just contacted you for the very first time.`,
      ``,
      `YOUR ENTIRE REPLY MUST HAVE EXACTLY TWO PARTS — NOTHING MORE:`,
      `  Part 1: One warm acknowledgement sentence (under 10 words).`,
      `  Part 2: One combined question asking (a) which city/area they live in AND (b) what they are looking for.`,
      ``,
      `Correct example:`,
      `  "בשמחה רבה! לפני שנצלול לפרטים — מאיזה אזור את/ה, ומה הכי חשוב לך למצוא באימונים?"`,
      ``,
      `HARD PROHIBITIONS — violating any of these is a critical failure:`,
      `  ✗ Do not describe the studio`,
      `  ✗ Do not mention any class name or type`,
      `  ✗ Do not mention prices, memberships, or packages`,
      `  ✗ Do not mention the trial offer (60 NIS / 2 workouts)`,
      `  ✗ Do not give the studio address or location`,
      `  ✗ Do not start with the lead's name`,
      `  ✗ Do not ask more than one question`,
      ``,
      `Lead name: ${name ?? 'unknown'}. Phone: ${from}.`,
      `Respond in Hebrew.`,
    ].join('\n');
  }

  // Turn 2+: full system prompt + fresh stage context suffix
  return `${SYSTEM_PROMPT}\n\n---\n\n## Current Turn Instruction\n\n${buildStageContext(completedTurns, qualData, msgCount)}`;
}

function buildStageContext(completedTurns, qualData, msgCount) {
  const loc = qualData.location ? `Location captured: "${qualData.location}".` : 'Location not yet confirmed.';

  if (completedTurns === 1) {
    return [
      `TURN 2 — GOAL DISCOVERY. Reply #${msgCount + 1}.`,
      loc,
      `Acknowledge location warmly (one sentence). Ask ONE question about their fitness goal.`,
      `If their location is very far from Pardes Hanna-Karkur, gently note the distance first.`,
      `Max 3 sentences. No pricing. No class list.`,
    ].join('\n');
  }

  if (completedTurns === 2) {
    return [
      `TURN 3 — STYLE DISCOVERY. Reply #${msgCount + 1}.`,
      `Acknowledge their goal. Ask ONE question about workout preference or experience level.`,
      `You may mention one specific class name if it matches what they told you — one line only.`,
      `Max 3 sentences. No pricing. No trial offer.`,
    ].join('\n');
  }

  if (completedTurns >= 3) {
    if (qualData.callTimeGiven) {
      return [
        `CLOSE — CONFIRM CALL. Reply #${msgCount + 1}.`,
        `Call time given: "${qualData.callTimeGiven}".`,
        `Confirm warmly. Tell them to expect the team's call. Thank them briefly.`,
        `Max 2 sentences. No questions unless they raised something new.`,
      ].join('\n');
    }

    if (!qualData.callProposed) {
      return [
        `TURN 4 — PROPOSE CALL. Reply #${msgCount + 1}.`,
        `Connect what they shared to Shape Studio in one sentence.`,
        `Then propose: "מה אם אחד מהצוות יתקשר אליך לשיחה קצרה של 5 דקות — לתאם כניסה ולענות על שאלות? באיזו שעה נוח לך?"`,
        `The final question MUST ask for a callback time.`,
        `Max 4 sentences. Do not list classes. Do not mention pricing.`,
      ].join('\n');
    }

    return [
      `FOLLOW-UP — AWAITING CALL TIME. Reply #${msgCount + 1}.`,
      `The call has been proposed. No callback time given yet.`,
      `If they asked a question: answer in one sentence, then ask for the callback time again.`,
      `If they declined a call: offer the trial (2 workouts, 60 NIS) as an alternative path.`,
      `Max 3 sentences.`,
    ].join('\n');
  }

  return `Reply #${msgCount + 1}. Max 4 sentences. End with one question. Do not start with the person's name.`;
}

// ── Crisis detection — always runs before anything else ──────────────────────
const CRISIS_PATTERNS = [
  /\b(injury|injured|pain|hurt|pulled|sprained|fell|doctor|hospital|blood)\b/i,
  /\b(angry|furious|disgusted|scam|lawyer|lawsuit|complaint|awful|terrible)\b/i,
  /\bpost (about|this|it)\b/i,
  /\b(cancel\s*(my\s*)?(membership|subscription)|leaving|quitting|done with|refund|money back)\b/i,
  /\b(help me|emergency|I can't|struggling|upset)\b/i,
  // Hebrew additions
  /\b(פציעה|כאב|נפלתי|רופא|בית חולים)\b/i,
  /\b(כועס|עורך דין|תלונה|הונאה)\b/i,
  /\b(ביטול מנוי|עוזב|עוזבת|החזר כספי)\b/i,
  /\b(עזרה|חירום)\b/i,
];

// Regex to detect a callback time in the user's message
const TIME_PATTERN =
  /\b(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{1,2}:\d{2}\b|\b(בוקר|ערב|צהריים|אחה"צ|אחרי עבודה)\b|\b\d{1,2}\s*(am|pm)\b/i;

// ── Qualification data helpers ────────────────────────────────────────────────

/**
 * Returns the structured qualification data stored in the lead's meta.
 * Shape: { location, locationViable, goal, workoutStyle, callProposed,
 *          callTimeGiven, briefGeneratedAt }
 */
function getQualData(phone) {
  return store.getLead(phone)?.meta?.qualData ?? {};
}

/**
 * Merges `updates` into the lead's meta.qualData without touching other meta fields.
 */
function setQualData(phone, updates) {
  const lead    = store.getLead(phone);
  const meta    = lead?.meta ?? {};
  const current = meta.qualData ?? {};
  store.upsertLead(phone, { meta: { ...meta, qualData: { ...current, ...updates } } });
}

// ── Lead brief generation ─────────────────────────────────────────────────────

/**
 * Calls gpt-4o-mini to extract a structured JSON brief from the conversation.
 * Stores the result in meta.leadBrief and fires a team alert.
 * Non-blocking — always called with .catch() so failures never affect the main flow.
 */
async function generateLeadBrief(phone, history, callTimeGiven) {
  const lead = store.getLead(phone);
  if (!lead) return null;

  const transcript = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? 'Lead' : 'Barak'}: ${m.content}`)
    .join('\n');

  let brief = null;
  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_BRIEF_MODEL ?? 'gpt-4o-mini',
      temperature: 0,
      max_tokens:  220,
      messages: [
        {
          role:    'system',
          content: 'You extract lead qualification data from WhatsApp conversations. Return ONLY valid JSON — no markdown, no extra text.',
        },
        {
          role:    'user',
          content:
            `Conversation:\n${transcript}\n\n` +
            `Return JSON with these keys (use null when not mentioned):\n` +
            `{"location":"city/area","locationViable":true/false/null,"goal":"fitness goal","workoutStyle":"training preference","experience":"fitness background","availability":"preferred training times","callTimeGiven":"${callTimeGiven ?? 'null'}","notes":"anything else useful for the sales team"}`,
        },
      ],
    });

    const raw = completion.choices[0].message.content.trim();
    brief = JSON.parse(raw);
  } catch (err) {
    logger.warn('[lead_agent] Brief extraction failed — using fallback heuristic', { phone, error: err.message });
    // Fallback: build brief from whatever qualData already has
    const qd = getQualData(phone);
    brief = {
      location:       qd.location       ?? null,
      locationViable: qd.locationViable ?? null,
      goal:           qd.goal           ?? null,
      workoutStyle:   qd.workoutStyle   ?? null,
      experience:     null,
      availability:   null,
      callTimeGiven:  callTimeGiven     ?? null,
      notes:          null,
    };
  }

  // Persist the brief
  const meta = store.getLead(phone)?.meta ?? {};
  store.upsertLead(phone, {
    meta: { ...meta, leadBrief: brief, briefGeneratedAt: new Date().toISOString() },
  });
  setQualData(phone, { briefGeneratedAt: new Date().toISOString() });

  logger.info('[lead_agent] Lead brief saved', { phone, location: brief.location, goal: brief.goal });

  // ── Notify the team with the structured brief ─────────────────────────────
  const name     = lead.name ?? phone;
  const loc      = brief.location     ? `📍 אזור: ${brief.location}`        : '';
  const goal     = brief.goal         ? `🎯 מטרה: ${brief.goal}`            : '';
  const style    = brief.workoutStyle ? `💪 סגנון: ${brief.workoutStyle}`   : '';
  const avail    = brief.availability ? `📅 זמינות: ${brief.availability}`  : '';
  const callTime = brief.callTimeGiven
    ? `📞 זמן שיחה: ${brief.callTimeGiven}`
    : '📞 זמן שיחה: לא נקבע עדיין';
  const notes    = brief.notes        ? `📝 הערות: ${brief.notes}`          : '';

  const lines = [loc, goal, style, avail, callTime, notes].filter(Boolean).join('\n');

  await alertOwner(
    `📋 ליד מוכן לשיחה — ${name}`,
    `*${name}* (${phone})\n\n${lines}\n\nהרשומה מלאה זמינה בדשבורד.`
  ).catch(err => logger.warn('[lead_agent] Team brief alert failed', { error: err.message }));

  return brief;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Handle an inbound WhatsApp message for lead qualification.
 * Returns { reply, score, status }.
 */
async function handleInbound({ from, name, text }) {
  store.logEvent('message_in', from, { name, preview: text.slice(0, 80) });
  store.upsertLead(from, {
    name:         name ?? store.getLead(from)?.name,
    messageCount: (store.getLead(from)?.messageCount ?? 0) + 1,
  });

  // 1. Crisis check — always first
  const crisis = detectCrisis(text);
  if (crisis) {
    logger.warn('[lead_agent] Crisis keyword', { from, crisis });
    store.upsertLead(from, { status: 'crisis' });
    store.logEvent('crisis', from, { crisis, message: text.slice(0, 120) });
    await sendText(from, crisisAcknowledgement(name));
    await alertOwner(
      `⚠️ Crisis / Escalation — ${name ?? from}`,
      `*Contact:* ${name ?? from}\n*Phone:* ${from}\n*Category:* ${crisis}\n*Message:* "${text}"`
    );
    clearSession(from);
    return;
  }

  // 2. Retrieve history and qualification state
  //    Strip any stale system-message injections from previous sessions —
  //    stage context is rebuilt fresh on every call; we only want user/assistant
  //    pairs in the history that is passed to OpenAI.
  const rawHistory     = getHistory(from);
  const history        = rawHistory.filter(m => m.role !== 'system');
  const msgCount       = store.getLead(from)?.messageCount ?? 0;
  const qualData       = getQualData(from);
  const completedTurns = history.filter(m => m.role === 'user').length;

  // 3. Detect callback time in this inbound message
  if (qualData.callProposed && !qualData.callTimeGiven && TIME_PATTERN.test(text)) {
    const callTime = text.trim().slice(0, 80);
    setQualData(from, { callTimeGiven: callTime });
    store.upsertLead(from, {
      meta: {
        ...(store.getLead(from)?.meta ?? {}),
        callbackTime:         callTime,
        callbackRequestedAt:  new Date().toISOString(),
        awaitingCallbackTime: false,
      },
    });
    store.logEvent('call_time_captured', from, { callTime });
    logger.info('[lead_agent] Call time captured', { from, callTime });
  }

  // 4. Build the system prompt for this specific turn.
  //    freshQualData is read AFTER the callback-time detection in step 3 so the
  //    stage context always reflects any mutations made in this same call.
  const freshQualData    = getQualData(from);
  const turnSystemPrompt = buildTurnSystemPrompt(completedTurns, freshQualData, name, from, msgCount);
  const messagesForApi   = [
    { role: 'system', content: turnSystemPrompt },
    ...history,
    { role: 'user', content: text },
  ];

  // 5. Generate AI reply
  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:    messagesForApi,
      temperature: 0.7,
      max_tokens:  completedTurns === 0 ? 80 : 200,
    });
    reply = completion.choices[0].message.content.trim();

    // Mark call proposed only after a successful reply — if the OpenAI call
    // throws, the flag must NOT be written so the next turn retries the proposal
    // rather than skipping to "awaiting call time".
    if (completedTurns >= 3 && !freshQualData.callProposed && !freshQualData.callTimeGiven) {
      setQualData(from, { callProposed: true });
    }

    // Save only user/assistant pairs — no system messages in history
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    saveHistory(from, history);
  } catch (err) {
    logger.error('[lead_agent] OpenAI error', { error: err.message });
    reply = `שלום! נתקלנו בתקלה טכנית קטנה. הצוות שלנו יחזור אליך בהקדם 🙏`;
  }

  // 7. Score the lead (history already has user+assistant appended above)
  const score  = scoreLeadFromHistory(history, freshQualData);
  const status = score >= 8 ? 'hot' : score >= 5 ? 'warm' : 'cold';
  store.upsertLead(from, { score, status });
  store.logEvent('score_update', from, { score, status });
  logger.info('[lead_agent] Score', { from, score, status });

  // 8. Send reply
  await sendText(from, reply);
  store.logEvent('message_out', from, { preview: reply.slice(0, 80) });

  // 9. Trigger brief generation (fire-and-forget) when entering Stage 3 for
  //    the first time, or when a call time is captured on this turn.
  const latestQualData      = getQualData(from);
  const callTimeCapturedNow = !qualData.callTimeGiven && !!latestQualData.callTimeGiven;
  const enteringStage3      = completedTurns >= 3 && !latestQualData.briefGeneratedAt;

  if (enteringStage3 || callTimeCapturedNow) {
    generateLeadBrief(from, history, latestQualData.callTimeGiven ?? null)
      .catch(err => logger.warn('[lead_agent] Brief generation error', { from, error: err.message }));
  }

  return { reply, score, status };
}

// ── Lead scoring ──────────────────────────────────────────────────────────────

/**
 * Score 1–10. Internal only, never exposed to the lead.
 * Highest weight goes to call-commitment signals.
 */
function scoreLeadFromHistory(history, qualData = {}) {
  const fullText = history.map(m => m.content).join(' ').toLowerCase();
  let score = 4; // baseline

  // Highest signal: call time committed
  if (qualData.callTimeGiven) score += 4;

  // Strong intent
  const strongIntent =
    /\b(want to start|ready to|sign up|join|membership|register)\b/.test(fullText) ||
    /רוצה להתחיל|רוצה להצטרף|להירשם|מנוי|מוכנה|מוכן|רוצה לנסות/.test(fullText);
  if (strongIntent) score += 3;

  // Trial / visit intent
  const trialIntent =
    /\b(trial|try it|check it out|visit)\b/.test(fullText) ||
    /ניסיון|לנסות|לבקר|היכרות|אפשר לבוא/.test(fullText);
  if (trialIntent) score += 2;

  // Scheduling signal
  const schedulingSignal =
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|evening|after work|weekend)\b/.test(fullText) ||
    /ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בוקר|ערב|אחה"צ|אחרי עבודה/.test(fullText);
  if (schedulingSignal) score += 1;

  // Goal stated
  const goalSignal =
    /\b(goal|lose weight|get fit|build strength|tone|pilates|yoga|cardio)\b/.test(fullText) ||
    /לרדת במשקל|להתחזק|להיות בכושר|מטרה|פילאטיס|יוגה|כוח|עיצוב|כושר|גמישות/.test(fullText);
  if (goalSignal) score += 1;

  // Multi-turn engagement
  if (history.filter(m => m.role === 'user').length >= 3) score += 1;

  // Location viable bonus
  if (qualData.locationViable === true) score += 1;

  // Negative signals
  const priceBotFirstMsg =
    /\b(price|מחיר|כמה עולה|מה המחיר)\b/.test(fullText) &&
    history.filter(m => m.role === 'user').length <= 1;
  if (priceBotFirstMsg) score -= 2;

  const justBrowsing =
    /\bjust (checking|looking|browsing)\b/.test(fullText) ||
    /רק בודק|רק מסתכל|רק שואל/.test(fullText);
  if (justBrowsing) score -= 2;

  return Math.max(1, Math.min(10, score));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendIntroOffer(to, name) {
  const firstName = name?.split(' ')[0] ?? null;
  const greeting  = firstName ? `${firstName}, ` : '';
  const message =
    `${greeting}אם תרצה/י לנסות לפני הכל — יש לנו הצעת היכרות למצטרפים חדשים.\n\n` +
    `*2 אימונים לבחירה ב-60 ש״ח.* בלי התחייבות, פשוט תרגיש/י מה המקום נותן ותחליט/י.\n\n` +
    `מעניין אותך? 💪`;
  await sendText(to, message);
}

function detectCrisis(text) {
  for (const p of CRISIS_PATTERNS) {
    if (p.test(text)) {
      if (p.source.includes('cancel') || p.source.includes('ביטול')) return 'churn';
      if (p.source.includes('angry')  || p.source.includes('כועס'))  return 'emotional';
      if (p.source.includes('injury') || p.source.includes('פציעה')) return 'physical';
      return 'distress';
    }
  }
  return null;
}

function crisisAcknowledgement(name) {
  const firstName = name?.split(/\s+/)[0] ?? null;
  const opener    = firstName ? `${firstName}, ` : '';
  return (
    `${opener}אני שומע אותך וזה חשוב לנו מאוד. ` +
    `אני רוצה לוודא שתקבל/י תמיכה ישירה עכשיו — ` +
    `הצוות שלנו מקבל התראה ויצור איתך קשר אישית בהקדם. ` +
    `תודה שאמרת לנו 🙏`
  );
}

// ── Session helpers — backed by the shared lead_store singleton ───────────────

function getHistory(phone) {
  if (!store.getLead(phone)) store.upsertLead(phone, {});
  return store.getLead(phone).history;
}
function saveHistory(phone, history) {
  store.upsertLead(phone, { history: history.slice(-20) });
}
function clearSession(phone) {
  store.deleteLead(phone);
}

module.exports = { handleInbound, clearSession, generateLeadBrief, sendIntroOffer };
