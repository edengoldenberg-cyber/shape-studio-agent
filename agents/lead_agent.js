require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const OpenAI  = require('openai');
const logger  = require('../utils/logger');
const store   = require('../utils/lead_store');
const { sendText, alertOwner } = require('../services/whatsapp.service');
const { tryDeterministicWazeReply, tryDeterministicScheduleReply } = require('./deterministic_reply');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const studioAssets  = require('../utils/studio_assets');
const memoryService = require('../services/memory.service');
const handoffService = require('../services/handoff.service');
const memberCache   = require('../utils/member_cache');
const { checkOperationalIntent } = require('../utils/operational_interceptor');
const aptStore      = require('../utils/appointment_store');
const calendarSvc   = require('../services/calendar.service');

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/system_prompt.md'),
  'utf8'
);

// ── Pricing context builder ───────────────────────────────────────────────────
// Reads subscription_packages.json at call time so price changes take effect
// without a server restart. Returns a markdown-formatted pricing block.
function buildPricingContext() {
  try {
    const DATA_DIR = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
    const pkg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'subscription_packages.json'), 'utf8'));
    const lines = [];
    if (pkg.trial) {
      lines.push(`הצעת היכרות: ${pkg.trial.entries} אימונים ב-${pkg.trial.price_ils} ₪ — ${pkg.trial.description}`);
    }
    const configured = (pkg.packages ?? []).filter(p => p.price_ils !== null && p.price_ils !== undefined);
    const unconfigured = (pkg.packages ?? []).filter(p => p.price_ils === null || p.price_ils === undefined);
    for (const p of configured) {
      lines.push(`${p.name}: ${p.price_ils} ₪ לחודש — ${p.description}`);
    }
    if (unconfigured.length > 0 && configured.length === 0) {
      lines.push(`חבילות חודשיות: המחיר תלוי בתדירות. הצוות ישמח לפרט — לא מפורסם אונליין.`);
    } else if (unconfigured.length > 0) {
      lines.push(`חבילות נוספות: פנה/י לצוות לפרטים.`);
    }
    if (pkg._universal_access) {
      lines.push(`גישה: ${pkg._universal_access}`);
    }
    return lines.length > 0 ? `## מחירים ומנויים\n${lines.join('\n')}` : '';
  } catch {
    return '## מחירים ומנויים\nלפרטי מחיר — פנה/י לצוות ישירות.';
  }
}

/**
 * Returns a short markdown section with the studio's live asset URLs.
 * Called on every prompt build so dashboard edits take effect immediately.
 */
function buildAssetContext() {
  const assets = studioAssets.getAssets();

  // ── Waze rule ──────────────────────────────────────────────────────────────
  // The URL is embedded directly so the AI can copy-paste it without looking elsewhere.
  const wazeRule = assets.wazeUrl
    ? [
        `## ⚠️ MANDATORY WAZE RULE`,
        `When address / location / directions are mentioned or requested (even on Turn 1 if explicitly asked):`,
        `  ALWAYS reply with BOTH lines — never one without the other:`,
        `  Line 1: "דרך השדה 12, פרדס חנה-כרכור"`,
        `  Line 2 — COPY THIS URL EXACTLY, CHARACTER BY CHARACTER: ${assets.wazeUrl}`,
        `  ⚠️ DO NOT percent-encode Hebrew characters. The URL above must appear in your reply UNCHANGED.`,
        `     Output it as plain text exactly as written. Never produce %D7... sequences.`,
        `  Example reply: "דרך השדה 12, פרדס חנה-כרכור 🗺️\n${assets.wazeUrl}"`,
        `  FORBIDDEN: address without the link. FORBIDDEN: a URL containing %D7 or any percent-encoding. FORBIDDEN: inventing a link.`,
      ].join('\n')
    : `## WAZE: not configured — if asked for directions, say "אשלח לך קישור ניווט ישיר"`;

  // ── Schedule / timetable rule ──────────────────────────────────────────────
  // The scheduling pipeline handles actual image sending. AI's job: confirm it's coming.
  const scheduleRule = [
    `## ⚠️ MANDATORY SCHEDULE RULE`,
    `When asked about schedule, opening hours, timetable, or "יש תמונה?":`,
    `  ALWAYS say exactly: "שולח לך את המערכת עכשיו 📅"`,
    `  Do NOT append a qualification question — the images follow automatically.`,
    `  After the lead sees the schedule and responds naturally, you may ask about their preferred days/times.`,
    `  FORBIDDEN: "אין לי תמונה" / "הצוות ישלח" / showing a single-day class list as a schedule.`,
    assets.timetableUrl ? `  Timetable URL: ${assets.timetableUrl}` : '',
  ].filter(Boolean).join('\n');

  return [wazeRule, '', scheduleRule].join('\n');
}

// ── Language rule builder ─────────────────────────────────────────────────────
//
// Returns the LANGUAGE instruction block for the Turn 1 minimal prompt.
// When an Arabic dialect has been detected on this message, the rule
// overrides the default Hebrew-only constraint.
function _buildLanguageRule(qualData) {
  if (qualData?.dialect === 'arabic_script') {
    return [
      `LANGUAGE — ABSOLUTE RULE: The lead is writing in Arabic. Respond ENTIRELY in Arabic.`,
      `Use warm Levantine/Palestinian dialect. Maintain the same qualification flow.`,
      `Never switch to Hebrew unless the lead does first.`,
    ].join('\n');
  }
  if (qualData?.dialect === 'arabic_hebrew') {
    return [
      `LANGUAGE — ABSOLUTE RULE: Respond in Hebrew only.`,
      `The lead uses Arabic-influenced slang. Match their warm, casual register.`,
      `Zero corporate tone. Short, natural sentences. No "נשמח לעמוד לרשותך".`,
    ].join('\n');
  }
  return [
    `LANGUAGE — ABSOLUTE RULE: Respond ONLY in Hebrew. Not a single English word in the reply.`,
    `This is an Israeli studio (Pardes Hanna). Every message must be natural, warm, conversational Hebrew.`,
  ].join('\n');
}

// ── Location viability detection ──────────────────────────────────────────────
//
// These regexes classify the lead's location into three buckets:
//   NEARBY  → proceed normally
//   FAR     → pause and ask if traveling to Pardes Hanna is realistic
//   NEITHER → let the AI decide (location text too ambiguous)
//
// Travel-confirmation / travel-decline patterns are tested only after a FAR
// location has been flagged, so they don't fire spuriously on unrelated text.

// Nearby areas (~25 min from Pardes Hanna-Karkur).
// Detection sets locationCheckNeeded=true + locationNearby=true so Barak asks
// a soft "is the studio convenient for you?" — never auto-confirmed.
const NEARBY_LOCATION_RE =
  /פרדס חנה|חדרה|קיסריה|זכרון יעקב|בנימינה|אור עקיבא|ג'סר א-?זרקא|בת שלמה|עמק חפר|גנות הדר|חריש|עירון|מאיר שפיה|טנינים|רמות מנשה|נתניה/i;

// Distant areas — Barak asks if traveling to Pardes Hanna is realistic.
const FAR_LOCATION_RE =
  /תל אביב|ת"א|ירושלים|באר שבע|חיפה|נצרת|רחובות|ראשון לציון|פתח תקווה|רמת גן|גבעתיים|הרצליה|כפר יונה|רעננה|הוד השרון|נס ציונה|מודיעין|אשדוד|אשקלון|לוד|רמלה|קרית שמונה|טבריה|אלעד|בני ברק|גבעת שמואל/i;

// Positive confirmation that the location / travel works for the lead.
// Applies to BOTH nearby (studio convenience) and far (travel feasibility).
// Note: \b does not work reliably with Hebrew (non-ASCII) — use explicit anchors/punctuation instead.
const TRAVEL_CONFIRM_RE =
  /אין בעיה|לא רחוק|שווה לי|מגיע|מגיעה|אבוא|קרוב|קרובה|לא בעיה|ריאלי|אפשרי|נוסע|נוסעת|בא לי|באה לי|יכול להגיע|יכולה להגיע|זה בסדר|לא מפריע לי|מגיע לשם|נוסע לשם|נוח לי|מתאים לי|מתאים עבורי|בסדר מבחינתי|ממש קרוב|לא בעיה לי|^כן$|^כן[,!. ]|כן, |כן\.|כן!|^סבבה|^ברור|^בטח|^מצוין|^בהחלט|^כמובן|^נכון|^אין בעיה|^יש אפשרות|^אפשרי/i;

// Negative — lead signals location / travel is a problem.
const TRAVEL_DECLINE_RE =
  /רחוק לי|רחוק מדי|לא שווה|לא מגיע\b|לא מגיעה\b|לא יכול\b|לא יכולה\b|לא ריאלי|לא אבוא|לא אסע|בעיה עם המרחק|לא כדאי|רחוק מדי עבורי|זה מרחק|לא נוח לי|לא מתאים לי|לא כל כך נוח/i;

// ── Demo / testing debug capture ─────────────────────────────────────────────
// Populated on every handleInbound call so the /demo simulator can display
// exactly which code path fired and what postProcessReply transformed.
// Never affects production behaviour — purely additive metadata.
let _lastDebugCtx = null;
function getLastDebugContext() { return _lastDebugCtx; }
const demoCapture = require('../utils/demo_capture');

// ── State-flag validation regexes ────────────────────────────────────────────
//
// callProposed and nameAsked are only stamped true when the AI's actual reply
// contains the matching phrase.  Previously these were set unconditionally,
// causing the state machine to believe a call was proposed even when the AI
// answered a question instead.

const CALL_PROPOSAL_RE =
  /יתקשר|שיחה קצרה|5 דקות|באיזו שעה נוח|מה שעה נוחה|לתאם שיחה|אתקשר אליך|שיצרו קשר|נציג.*יחזור אליך|נציג מהסטודיו|לחזור אליך/;

// Callback refusal — lead explicitly declines a callback invitation.
// Sets callbackDeclined so the invitation is not repeated.
const CALLBACK_DECLINE_RE =
  /לא עכשיו|לא צריך|לא מעוניין|לא מעוניינת|תודה לא|לא תודה|לא רוצה שיתקשר|אל תתקשר|אני אחזור|אני אפנה|אבדוק בעצמ/i;

const NAME_ASK_RE =
  /איך קוראים לך|מה שמך|מה השם שלך|ואיך קוראים|קוראים לך\?|שמך\?/;

// ── Pricing objection detection ───────────────────────────────────────────────
// Triggered when a lead signals price is a concern.  Sets qualData.pricingObjection
// so the stage context can inject category-repositioning framing.
const PRICE_OBJECTION_RE =
  /יקר\b|יקרה\b|יקר לי|יקר מדי|יקר מאוד|לא שווה|ראיתי.*זול|זול יותר|מחיר גבוה|לא יכול.*להרשות|לא יכולה.*להרשות|יש.*מקומות.*יותר|מקומות.*יותר זולים|כמה.*מחיר.*כי|מה.*יקר|לא מתאים לתקציב|אין לי תקציב/i;

// ── Arabic dialect detection ───────────────────────────────────────────────────
// ARABIC_SCRIPT_RE: any Arabic Unicode character → respond fully in Arabic.
// ARABIC_HEBREW_RE: 2+ Hebrew-script Arabic markers → respond in warm Hebrew only.
const ARABIC_SCRIPT_RE      = /[؀-ۿ]/;
const ARABIC_HEBREW_MARKERS = /חביבי|יאללה|אהלן|ואלה|אינשאללה|מרחבא|שלונכ|סאחבי|בדי[^ג]|שו[\s,!?]|מניח|כיפו/ig;

// ── Post-processor: enforce output invariants after every AI reply ────────────
//
// Guarantees that the AI output satisfies operational rules regardless of
// whether the model followed prompt instructions.  Called synchronously after
// completion.choices[0].message.content is retrieved.

function postProcessReply(reply, qualData, assets) {
  if (!reply) return reply;
  let out = reply;
  const ppChanges = [];

  // 1. Strip "no image" hallucinations regardless of exact phrasing.
  //    Covers: "אין לי תמונה", "אין תמונות זמינות כרגע", "אין תמונה זמינה",
  //            "לא יש לי תמונה", "לא נמצאה תמונה", etc.
  const afterStrip = out.replace(/(?:אין|לא\s+יש|לא\s+נמצא)[^\n.!?]{0,25}תמונ[^\n.!?]*[.!?]?\s*/gi,
    'שולח לך את המערכת עכשיו 📅 ');
  if (afterStrip !== out) { ppChanges.push('hallucination_stripped'); out = afterStrip; }

  // 2. If the reply mentions the studio address/city but the Waze link is absent, inject it.
  //
  //    Two-tier approach:
  //    (a) If the specific street address is present → insert link immediately after it.
  //    (b) If only "פרדס חנה" is present (but not the street address) → append the
  //        full address + link at the end.  This fixes the mismatch where addressPresent
  //        detected "פרדס חנה" but the replace regex only looked for "דרך השדה 12".
  //
  //    Uses a literal string replacement via a replacer function to avoid $-sequence
  //    interpretation in the replacement string (e.g. a wazeUrl containing $1 or $&).
  const addressPresent  = /דרך השדה 12|פרדס חנה/.test(out);
  const wazeLinkPresent = /waze\.com|waze:\/\//.test(out);
  if (addressPresent && !wazeLinkPresent && assets?.wazeUrl) {
    if (/דרך השדה 12/.test(out)) {
      // Insert link on a new line immediately after the street address occurrence.
      // The replacer function avoids $-sequence interpretation entirely.
      out = out.replace(/(דרך השדה 12[^.\n!?]*)/, (match) => `${match}\n${assets.wazeUrl}`);
    } else {
      // AI wrote "פרדס חנה" but not the full street address — append both.
      out = out.trimEnd() + `\n\nדרך השדה 12, פרדס חנה-כרכור 🗺️\n${assets.wazeUrl}`;
    }
    ppChanges.push('waze_injected');
  }

  // 2.5 Gate 3 — Conversational Hygiene Guard.
  //     Hard-strips AI-generated re-asks for data that is already confirmed.
  //     Runs before the question-enforcement block so we don't re-add what we just removed.

  // Never re-ask for name when it's already confirmed
  if (qualData.confirmedName && NAME_ASK_RE.test(out)) {
    // Strip the sentence containing the name question
    const stripped = out.replace(/[^.!?\n]*(?:איך קוראים לך|מה שמך|מה השם שלך|ואיך קוראים|קוראים לך\?|שמך\?)[^.!?\n]*[.!?\n]?/gi, '').trim();
    if (stripped.length >= 10) {
      out = stripped;
      ppChanges.push('gate3_name_reasked_stripped');
    }
  }

  // Never re-propose a callback time after it's already been confirmed
  if (qualData.callTimeGiven && /באיזו\s+שעה|מתי\s+נוח|מה\s+שעה\s+נוח/.test(out)) {
    const stripped = out.replace(/[^.!?\n]*(?:באיזו\s+שעה|מתי\s+נוח|מה\s+שעה\s+נוח)[^.!?\n]*[.!?\n]?/gi, '').trim();
    if (stripped.length >= 10) {
      out = stripped;
      ppChanges.push('gate3_callback_loop_stripped');
    }
  }

  // 3. CLOSE state — strip trailing question when conversation is finished.
  //    Open state — the AI decides whether to ask; no forced appending.
  const isClose = !!(qualData.callTimeGiven || qualData.locationViable === false);
  if (isClose) {
    // Strip the last sentence if it ends with a question mark.
    // [\s\S] after the ? allows for trailing emoji, whitespace, or any Unicode char.
    const stripped = out.replace(/\s*[^.!?\n]{1,120}\?[\s\S]{0,10}$/u, '').trim();
    if (stripped.length >= 15) {
      if (stripped !== out) ppChanges.push('close_question_stripped');
      out = stripped;
    }
  }

  // Record for demo inspector
  _lastDebugCtx = { ...(_lastDebugCtx ?? {}), postProcess: { changes: ppChanges, clean: ppChanges.length === 0 } };

  return out.trim();
}

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
    // Determine what the lead already gave us so we can skip redundant questions
    const hasLocation       = !!qualData.location;
    const hasFitnessInterest = !!qualData.fitnessInterest;

    return [
      `You are Barak, a WhatsApp representative for Shape Studio.`,
      `A lead has just contacted you. READ THEIR MESSAGE before writing anything.`,
      ``,
      `── STEP 1: UNDERSTAND WHAT THEY ALREADY TOLD YOU ──`,
      `Check their message. Did they mention:`,
      `  (A) Their city or area? ${hasLocation ? `YES — "${qualData.location}" is already known. DO NOT ask again.` : 'Not yet — you need to find out.'}`,
      `  (B) A specific class or fitness interest (e.g. פילאטיס מכשירים, strength, yoga, cardio)?`,
      `      ${hasFitnessInterest ? `YES — "${qualData.fitnessInterest}" already mentioned. DO NOT ask about their interest again — go deeper.` : 'If YES — engage with it directly. If NO — do not name any classes yourself.'}`,
      ``,
      `── STEP 2: CHOOSE YOUR REPLY PATTERN ──`,
      ``,
      `CASE A — They gave BOTH location AND a fitness interest:`,
      `  → Sentence 1: Engage with their SPECIFIC interest — make it feel personal, not promotional`,
      `     For Reformer: lead with the BENEFIT, not the number. "הרפורמר אצלנו זה שיעורים של 8 אנשים — מדריכ/ת שמכיר/ה אותך לפי שם ומתקדמת איתך."`,
      `     NOT: "סטודיו בוטיק עם 8 מקומות ברפורמר" ← the number sounds like a limitation`,
      `  → Sentence 2 (optional, only if relevant): Address their location naturally`,
      `     "מחדרה יש לנו חברות שמגיעות כל שבוע — 15 דקות נסיעה."`,
      `  → End with ONE sharp, specific question about what they want to achieve`,
      `  → Example for Reformer: "הרפורמר אצלנו זה שיעורים אישיים בתוך קבוצה קטנה — ממש שונה ממכון. מה מביא אותך אליו — חיזוק, יציבה, שיקום?"`,
      `  → Example for Strength: "אימוני הכוח שלנו הם פונקציונליים — לא עוד מכונות. מה הכיוון שחיפשת — עיצוב גוף, חוזק, עצמאות תנועתית?"`,
      ``,
      `CASE B — They gave ONLY their location:`,
      `  → Acknowledge location warmly (1 sentence), then ask about their fitness interest`,
      ``,
      `CASE C — They gave ONLY a fitness interest (no location):`,
      `  → Engage with that interest specifically (1 sentence), then ask where they're from`,
      ``,
      `CASE D — Minimal message ("שלום", "היי", "אשמח לפרטים", just a greeting):`,
      `  → 1 warm, natural sentence (NOT a cliché opener) + ONE focused question`,
      `  → Ask the single most useful unknown: what they're looking for.`,
      `  → Good: "שלום! מה מחפשים?"`,
      `  → Good: "היי! ספר/י לי — מה מביא אותך אלינו?"`,
      `  → Good: "שלום! מה מחפשים בסטודיו?"`,
      `  → BAD: "מאיזה אזור את/ה ומה מחפשים?" ← two questions combined into one sentence`,
      `  → BAD: any opener that starts with "שמחים", "ברוכים", "כיף", "איזה כיף"`,
      ``,
      `── HARD PROHIBITIONS ──`,
      `  ✗ FORBIDDEN openers — these sound like a bad chatbot, never use them:`,
      `    "איזה כיף שקפצת לבקר" / "שמחים שפנית" / "ברוכ/ה הבא/ה" / "כיף שפנית" / "שמחים לעזור"`,
      `    Any opener that is a generic platitude, not a real response to what they said.`,
      `  ✗ Never ask about location if they already gave it`,
      `  ✗ Never ask what they're looking for if they already told you`,
      `  ✗ Never volunteer class names they did NOT mention`,
      `  ✗ Never volunteer the studio address or Waze link on this turn UNLESS they explicitly asked for directions/address`,
      `     (If they explicitly asked: give address + Waze link verbatim, then ask where THEY are from)`,
      `  ✗ Never volunteer studio address or Waze link UNLESS they explicitly asked for it`,
      `  ✗ Never use their WhatsApp display name`,
      `  ✗ Never ask two questions in the same message`,
      `  ✗ Max 3 sentences total`,
      `  EXCEPTION — if they ask about price on Turn 1: give the confirmed pricing (see Pricing below)`,
      ``,
      `WhatsApp contact name (profile metadata — NOT confirmed): "${name ?? 'unknown'}". Do not use it.`,
      `Phone: ${from}.`,
      ``,
      buildAssetContext(),
      buildPricingContext(),
      _buildLanguageRule(qualData),
    ].join('\n');
  }

  // Turn 2+: full system prompt + live studio data + optional memory block + fresh stage context
  const memBlock     = memoryService.buildMemoryInjection(from, qualData);
  const memSection   = memBlock ? `\n\n${memBlock}` : '';
  const pricingCtx   = buildPricingContext();
  const pricingSection = pricingCtx ? `\n\n${pricingCtx}` : '';
  return `${SYSTEM_PROMPT}\n\n${buildAssetContext()}${pricingSection}${memSection}\n\n---\n\n## Current Turn Instruction\n\n${buildStageContext(completedTurns, qualData, msgCount)}`;
}

// Universal rules injected into every stage context.
// These override any stage-specific instruction when they conflict.
const UNIVERSAL_STAGE_RULES = [
  `UNIVERSAL RULES — these override ALL stage instructions:`,
  `U1. WAZE + ADDRESS: If the lead asks about location, address, or directions — always reply with:`,
  `    (a) "דרך השדה 12, פרדס חנה-כרכור"`,
  `    (b) the exact Waze link from the Studio Assets section — copy the URL CHARACTER BY CHARACTER, unchanged.`,
  `    ⚠️ NEVER percent-encode Hebrew: do NOT output %D7... sequences. Output the URL as plain readable text.`,
  `    Then ask: "המיקום מתאים לך? תרצה/י לתאם ביקור?"`,
  `    Never give the address without the Waze link. Never give a Waze link you invented or modified.`,
  `U2. ANSWER FIRST: If the lead asks ANY question or requests more details — answer it genuinely`,
  `    and fully (up to 3 sentences). Only after answering, return naturally to the stage.`,
  `    Do NOT cut the answer short just to push for a callback. Pushing before answering = broken trust.`,
  `U3. NO REPEAT QUESTIONS: If a question was already answered by the lead (location, fitness interest, goal, name),`,
  `    never ask it again. Read the "ALREADY KNOWN" section below before writing anything.`,
  `U4. FORWARD MOVEMENT: When you fulfilled what was explicitly requested (timetable sent,`,
  `    address given, specific question answered), no follow-up question is required — let`,
  `    the lead respond. When continuing an open conversation, end with ONE focused question.`,
  `    Never ask two questions in one message. After a first greeting with no specific request,`,
  `    one question is appropriate.`,
].join('\n');

/**
 * Returns true when qualData already has enough information to skip discovery
 * stages and move to the call proposal. Used to short-circuit turn-count-driven
 * stages so a lead who supplies multiple facts in one message doesn't get asked
 * questions they already answered.
 */
function buildStageContext(completedTurns, qualData, msgCount) {
  // ── Build "ALREADY KNOWN" summary — injected into every stage context ─────────
  const knownFacts = [];
  if (qualData.location)        knownFacts.push(`📍 אזור: "${qualData.location}"`);
  if (qualData.fitnessInterest) knownFacts.push(`💪 ענין: "${qualData.fitnessInterest}"`);
  if (qualData.goal)            knownFacts.push(`🎯 מטרה: "${qualData.goal}"`);
  if (qualData.workoutStyle)    knownFacts.push(`🏋️ סגנון: "${qualData.workoutStyle}"`);
  if (qualData.confirmedName)   knownFacts.push(`👤 שם: "${qualData.confirmedName}"`);
  const knownSection = knownFacts.length > 0
    ? `⛔ כבר ידוע — אסור לשאול שוב:\n${knownFacts.map(f => `  • ${f}`).join('\n')}`
    : `⛔ אין עדיין מידע מאושר.`;

  // ── HARD STATE OVERRIDES — these fire regardless of turn count ──────────────

  // 0. Reported booking — person already self-reported attending
  //    Do NOT continue the generic sales funnel; answer helpfully without pushing a call.
  if (qualData.reportedBookingAt) {
    return [
      `STATE: REPORTED_BOOKING.`,
      `The person said they already have a booking or are coming in. Exact text: "${qualData.reportedBookingText ?? ''}".`,
      `Do NOT propose another call. Do NOT ask for a callback time.`,
      `Respond warmly: acknowledge the booking, answer any open question they have.`,
      `If they ask about something (schedule, what to bring, parking) — answer it.`,
      `If there is nothing to respond to: respond with SILENCE.`,
      knownSection,
    ].join('\n');
  }

  // 1. Location not viable — close, nothing more
  if (qualData.locationViable === false) {
    return [
      `STATE: LOCATION NOT VIABLE.`,
      `Close warmly in one sentence. Leave the door open.`,
      `Example: "מבין/ה — אם זה ישתנה בעתיד תמיד ברוכ/ה לפנות 😊"`,
      `FORBIDDEN: call proposal, class info, pricing, any forward steps.`,
    ].join('\n');
  }

  // 2. Call time confirmed — conversation is finished
  if (qualData.callTimeGiven) {
    return [
      `STATE: CALL TIME CONFIRMED. Conversation is complete.`,
      `Write 1 warm sentence confirming the call time. No question mark. No new topics.`,
      `Confirmed time: "${qualData.callTimeGiven}"`,
      `Example: "מצוין — הצוות יצור קשר ב${qualData.callTimeGiven} 😊"`,
    ].join('\n');
  }

  // 3. Pricing objection (not a plain price question — an explicit "it's expensive" signal)
  if (qualData.pricingObjection && !qualData.pricingObjectionHandled) {
    return [
      `STATE: PRICING CONCERN expressed. Reframe — do not argue or deflect.`,
      ``,
      knownSection,
      ``,
      `REFRAME: "את/ה צודק/ת שכדאי להשוות. מה שאנחנו עושים שונה: כיתות של עד 8 אנשים`,
      `על ציוד Reformer מקצועי, עם מדריך/ה שרואה אותך בכל תנועה."`,
      `Then ask ONE of: "כמה פעמים בשבוע חשבת להגיע?" OR propose a brief call.`,
      `FORBIDDEN: exact NIS, competitor names, "אין לי מידע על מחירים".`,
    ].join('\n');
  }

  // 4. Location check needed (asked once, waiting for confirmation)
  if (qualData.locationCheckNeeded && qualData.locationViable !== true) {
    return [
      qualData.locationNearby
        ? `STATE: LOCATION CONVENIENCE CHECK. Ask once, lightly.`
        : `STATE: LOCATION FEASIBILITY CHECK. Ask once, naturally.`,
      ``,
      knownSection,
      ``,
      qualData.locationNearby
        ? `Their area: "${qualData.location}". Ask if דרך השדה 12 is convenient.`
        : `Their area: "${qualData.location}". Ask if traveling to Pardes Hanna is realistic.`,
      `Max 2 sentences. If they give any positive or neutral reply, proceed.`,
    ].join('\n');
  }

  // ── OPEN CONVERSATION — context injection, not scripted stages ───────────────
  //
  // The AI decides what to do next based on context. The stage context supplies:
  //   • what's already confirmed (don't re-ask)
  //   • the conversation state (call proposed? name known?)
  //   • a light suggestion for the next appropriate move
  //
  // The AI is trusted to answer the actual question first, then advance naturally.

  const nextSuggestion = (() => {
    if (qualData.callProposed) {
      // Call was already invited. If they asked a question, answer it first.
      // If they expressed interest but haven't given a time, ask once for a time.
      // Declined — close naturally. No re-invite, no replacement pitch.
      if (qualData.callbackDeclined) {
        return `The lead declined the callback. Close warmly in one sentence. Leave the door open. No pitch, no alternative offer.`;
      }
      // Callback was invited. Only ask for a time after CLEAR acceptance.
      // "מעולה", "תודה", "אחלה תודה רבה" = polite acknowledgment, NOT acceptance.
      //   → Respond with a warm close. Do NOT ask for a time.
      // Clear acceptance = "כן", "אשמח", "בבקשה", "נשמע טוב", "בשמחה", etc.
      //   → Ask once: "מתי נוח לך שנחזור אליך?"
      // If they asked a question, answer it first. No time request on the same turn as an answer.
      return `A callback was invited. Next steps:
  • If they asked a question — answer it. No time request on this turn.
  • If they clearly accepted ("כן", "אשמח", "בשמחה", "נשמע טוב") — ask once: "מתי נוח לך שנחזור אליך?"
  • If they said something like "תודה", "אחלה", "מעולה", "תודה רבה" with no explicit yes — this is a polite closing, not acceptance. Reply warmly and close. Do NOT ask for a time and do NOT make another offer.`;
    }

    const hasLocation = qualData.locationViable === true || (qualData.location && !qualData.locationCheckNeeded);
    const hasIntent   = !!(qualData.fitnessInterest || qualData.goal);
    const hasName     = !!qualData.confirmedName;
    const callbackDeclined = !!qualData.callbackDeclined;

    // After showing real interest (2+ turns, intent known), offer a contextual callback invite.
    // Only if: not already proposed/declined/booked, and the reply has a natural pause.
    // Do NOT append this mechanically — only when no open question remains from the lead.
    // Do NOT use a fixed sentence. Adapt the wording to the specific topic just answered:
    //   after a question about Reformer: "רוצה שנציג מהסטודיו יחזור אליך לשיחה קצרה ויעזור לך לבחור?"
    //   after a question about classes: "רוצה שנציג יחזור אליך ויסביר מה מתאים לך הכי טוב?"
    //   after a question about schedule: "רוצה שנציג יחזור אליך ונתאם ביחד?"
    // FORBIDDEN: "אם יש שאלות נוספות אני כאן" — never use this generic closing.
    if (hasIntent && completedTurns >= 2 && !callbackDeclined) {
      return [
        `The lead has shown real interest. After answering their question fully:`,
        `  • If no open question remains from them, offer a callback naturally — adapt wording to the topic just discussed.`,
        `    Example: "רוצה שנציג מהסטודיו יחזור אליך לשיחה קצרה ויעזור לך לבחור את המסלול המתאים?"`,
        `    Vary it: reference the specific class or topic they asked about.`,
        `  • If their message still has an open question, answer it — do not add the callback invite yet.`,
        `  • NEVER end with "אם יש שאלות נוספות אני כאן" — that closes the door. The invite opens it.`,
        `  • ONE question total in this reply (the callback invite counts as the question).`,
        hasLocation ? '' : `  • Location not yet known — if relevant, weave it in after the callback invite.`,
      ].filter(Boolean).join('\n');
    }

    if (hasLocation && hasIntent && hasName) {
      return `All key facts known. When the conversation has a natural pause (no open question from them), propose the team call: "רוצה שנציג מהסטודיו יחזור אליך לשיחה קצרה ויעזור לך לבחור את המסלול המתאים?"`;
    }
    if (hasLocation && hasIntent && !hasName) {
      return `Location and interest known. If the conversation reaches a natural pause and no question is pending, ask their first name. Otherwise keep helping.`;
    }
    if (hasIntent && !hasLocation) {
      return `Interest known. If location hasn't come up naturally, ask where they're from.`;
    }
    if (!hasIntent) {
      return `Interest/goal not yet clear. ONE focused question: what they're looking for.`;
    }
    return `Learn what they need. ONE question. Natural.`;
  })();

  return [
    UNIVERSAL_STAGE_RULES,
    ``,
    knownSection,
    ``,
    `GUIDANCE FOR THIS REPLY (Reply #${msgCount + 1}):`,
    nextSuggestion,
    ``,
    `⚠ TOP RULE: Answer what they just asked FIRST. Only then — if appropriate — one suggestion or question.`,
    `After answering a direct question, adding another question is optional. Zero questions is often right.`,
  ].join('\n');
}

// ── Crisis detection — always runs before anything else ──────────────────────
const CRISIS_PATTERNS = [
  /\b(injury|injured|pain|hurt|pulled|sprained|fell|doctor|hospital|blood)\b/i,
  /\b(angry|furious|disgusted|scam|lawyer|lawsuit|complaint|awful|terrible)\b/i,
  /\bpost (about|this|it)\b/i,
  /\b(cancel\s*(my\s*)?(membership|subscription)|leaving|quitting|done with|refund|money back)\b/i,
  /\b(help me|emergency|I can't|struggling|upset)\b/i,
  // Hebrew additions
  // NOTE: "כאב" alone is NOT a crisis trigger — many leads mention back/knee pain as
  //       their fitness motivation.  Only escalate when כאב co-occurs with acute/medical
  //       language (hospital, doctor, fell, serious).
  /(?:פציעה|נפלתי|בית חולים|רופא).*(?:כאב|בעיה)|(?:כאב).*(?:חמור|חד|נורא|אסור לי|אסור|לא יכול|רופא|בית חולים)/i,
  /\b(נפלתי|בית חולים)\b/i,
  /\b(כועס|עורך דין|תלונה|הונאה)\b/i,
  /\b(ביטול מנוי|עוזב|עוזבת|החזר כספי)\b/i,
  /\b(עזרה|חירום)\b/i,
];

// Regex to detect a callback time in the user's message.
// Covers: day names, HH:MM, time-of-day words, AM/PM, "מחר"/"היום",
// "בשעה N" (bare hour without colon — the most common Israeli WhatsApp form).
const TIME_PATTERN =
  /\b(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{1,2}:\d{2}\b|\b(בוקר|ערב|צהריים|אחה"צ|אחרי עבודה)\b|\b\d{1,2}\s*(am|pm)\b|\bמחר\b|\bהיום\b|\bבשעה\s+\d{1,2}\b/i;

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
  demoCapture.record('qual_flag_changed', { updates, before: current });
}

// ── Lead profile: qualification reason + next best action ────────────────────
//
// Computed after every scored turn and stored in meta.qualProfile.
// Gives the team panel a one-glance summary without reading the conversation.

function computeLeadProfile(lead, qualData, history) {
  const { scoreReadiness } = handoffService;
  const readiness = scoreReadiness(history ?? [], qualData);

  // Human-readable explanation of why the lead is at this level
  const reasonParts = [];
  if (qualData.fitnessInterest)        reasonParts.push(`ענין: ${qualData.fitnessInterest}`);
  if (qualData.goal && !qualData.fitnessInterest) reasonParts.push(`מטרה: ${qualData.goal}`);
  if (qualData.location) {
    const travelNote =
      qualData.locationViable === true  ? ' (מרחק בסדר)' :
      qualData.locationViable === false ? ' (מרחק בעיה)'  : '';
    reasonParts.push(`אזור: ${qualData.location}${travelNote}`);
  }
  if (qualData.pricingObjection)       reasonParts.push('התנגדות מחיר');
  if (qualData.callTimeGiven)          reasonParts.push(`זמן שיחה: ${qualData.callTimeGiven}`);
  else if (qualData.callProposed)      reasonParts.push('הוצעה שיחה, ממתין לאישור');
  const qualificationReason = reasonParts.length > 0 ? reasonParts.join(' · ') : 'אין עדיין מידע';

  // What the team should do next
  const st = lead?.status ?? 'cold';
  let nextBestAction;
  if      (st === 'opted_out')           nextBestAction = 'אין פעולה — ביקש/ה הסרה';
  else if (st === 'human_owns')          nextBestAction = `המשך ידני${lead?.meta?.humanOwnsBy ? ' — ' + lead.meta.humanOwnsBy : ''}`;
  else if (st === 'call_scheduled')      nextBestAction = `שיחה מתוזמנת${qualData.callTimeGiven ? ': ' + qualData.callTimeGiven : ''} — לא נדרשת פעולה נוספת`;
  else if (st === 'callback_requested')  nextBestAction = `חזור${qualData.callbackTime ? ': ' + qualData.callbackTime : ''} — ממתין לשיחה`;
  else if (qualData.locationViable === false) nextBestAction = 'סגור — מרחק לא ריאלי';
  else if (readiness.level === 'HIGH')   nextBestAction = 'התקשר כמה שיותר מהר — מוכנות גבוהה';
  else if (readiness.level === 'MEDIUM') nextBestAction = 'המשך את הבוט — בירור נוסף נדרש';
  else                                   nextBestAction = 'המתן — מעורבות נמוכה';

  const appointmentState =
    qualData.callTimeGiven ? (st === 'call_scheduled' ? 'confirmed' : 'requested') :
    qualData.callProposed  ? 'proposed' : 'none';

  return {
    readiness:          readiness.level,
    readinessEvidence:  readiness.evidence,
    qualificationReason,
    nextBestAction,
    appointmentState,
    preferredCallTime:  qualData.callTimeGiven ?? qualData.callbackTime ?? null,
    interests:          qualData.fitnessInterest ?? qualData.goal ?? null,
    location:           qualData.location ?? null,
    updatedAt:          new Date().toISOString(),
  };
}

// ── Reliable handoff alert ────────────────────────────────────────────────────
//
// Four-phase approach:
//   1. Persistent idempotency: skip if the same call-time alert was already sent.
//   2. Concurrent deduplication: in-flight Set prevents parallel webhook deliveries
//      from firing two alerts for the same lead+callTime.
//   3. Race the LLM brief (10s timeout). generateHandoffBrief returns briefLines
//      WITHOUT calling alertOwner — all sends go through the notificationSent gate
//      below, so a late-arriving brief after a timeout cannot produce a second send.
//   4. Persist the durable outcome so the dashboard reflects delivery status.
//
// Always called with await at the call site in handleInbound.

const _handoffInFlight = new Set();

async function reliableHandoffAlert(phone, name, history, latestQualData) {
  const qd  = latestQualData;
  const { scoreReadiness } = handoffService;
  const readiness = scoreReadiness(history, qd);

  // 1. Persistent idempotency: skip if already sent for this call time.
  const existingMeta = store.getLead(phone)?.meta ?? {};
  if (existingMeta.handoffAlertSentAt && existingMeta.handoffCallTime === qd.callTimeGiven) {
    logger.info('[lead_agent] Handoff already sent for this call time — skipping duplicate', { phone });
    return;
  }

  // 2. Concurrent deduplication: prevent parallel webhook deliveries from both sending.
  const inFlightKey = `${phone}:${qd.callTimeGiven ?? ''}`;
  if (_handoffInFlight.has(inFlightKey)) {
    logger.info('[lead_agent] Handoff in-flight for this key — skipping concurrent duplicate', { phone });
    return;
  }
  _handoffInFlight.add(inFlightKey);

  store.upsertLead(phone, {
    meta: { ...existingMeta, handoffAlertStatus: 'pending', handoffCallTime: qd.callTimeGiven, handoffReadiness: readiness.level },
  });

  let notificationSent = false;
  let briefErr = null;

  try {
    // 3. Race the LLM brief against a 10-second timeout.
    //    generateHandoffBrief returns { briefData, readiness, briefLines } without sending.
    //    If the brief arrives: send via alertOwner through the notificationSent gate.
    //    If the timeout fires: brief is still running but has no internal send, so the
    //    fallback below fires once and the late brief resolves harmlessly with no effect.
    let briefResult = null;
    let timer;

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('brief generation timed out after 10s')), 10000);
      });
      briefResult = await Promise.race([
        handoffService.generateHandoffBrief(phone, name, history, qd).then(r => { clearTimeout(timer); return r; }),
        timeoutPromise,
      ]);
    } catch (raceErr) {
      clearTimeout(timer);
      briefErr = raceErr;
      logger.warn('[lead_agent] Handoff brief failed — sending direct fallback', { phone, error: raceErr.message });
    }

    // Single sending gate — both success and fallback paths check notificationSent.
    if (briefResult && !notificationSent) {
      try {
        await alertOwner(`📋 ליד מוכן לשיחה — ${name ?? phone}`, briefResult.briefLines);
        notificationSent = true;
        logger.info('[lead_agent] Handoff brief sent to team', { phone, readiness: readiness.level });
      } catch (sendErr) {
        logger.warn('[lead_agent] Brief alertOwner failed — will try fallback', { phone, error: sendErr.message });
        briefErr = sendErr;
      }
    }

    if (!notificationSent) {
      const fallbackLines = [
        `📋 ליד חדש — ${name ?? phone}`,
        `📱 ${phone}`,
        qd.callTimeGiven   ? `📞 זמן שיחה: ${qd.callTimeGiven}` : '📞 זמן שיחה: לא נקבע',
        qd.location        ? `📍 ${qd.location}` : '',
        qd.fitnessInterest ? `💪 ענין: ${qd.fitnessInterest}` : '',
        qd.goal            ? `🎯 מטרה: ${qd.goal}` : '',
        `📊 מוכנות: ${readiness.level} — ${readiness.evidence}`,
        `\n⚠️ Brief מפורט לא הצליח (${briefErr?.message ?? 'unknown'}). בדוק/י ב-dashboard.`,
      ].filter(Boolean).join('\n');
      try {
        await alertOwner(`📋 ליד (fallback) — ${name ?? phone}`, fallbackLines);
        notificationSent = true;
        logger.info('[lead_agent] Fallback handoff alert sent', { phone });
      } catch (alertErr) {
        logger.error('[lead_agent] Even fallback handoff alert failed', { phone, error: alertErr.message });
      }
    }
  } finally {
    _handoffInFlight.delete(inFlightKey);
  }

  // 4. Persist the durable outcome so the team panel reflects delivery status.
  const updatedMeta = store.getLead(phone)?.meta ?? {};
  store.upsertLead(phone, {
    meta: {
      ...updatedMeta,
      handoffAlertStatus:   notificationSent ? 'sent' : 'failed',
      handoffAlertSentAt:   notificationSent ? new Date().toISOString() : null,
      handoffAlertFailedAt: notificationSent ? null : new Date().toISOString(),
    },
  });
}

// ── Lead brief generation ─────────────────────────────────────────────────────

/**
 * Calls gpt-4o-mini to extract a structured JSON brief from the conversation.
 * Stores the result in meta.leadBrief and fires a team alert.
 * Non-blocking — always called with .catch() so failures never affect the main flow.
 */
async function generateLeadBrief(phone, history, callTimeGiven, { alertTeam = false } = {}) {
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
  demoCapture.record('lead_brief_generated', { brief });

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

  // Alert only when a callback time was actually captured — not on every Stage-3 entry
  if (alertTeam) {
    await alertOwner(
      `📋 ליד מוכן לשיחה — ${name}`,
      `*${name}* (${phone})\n\n${lines}\n\nהרשומה מלאה זמינה בדשבורד.`
    ).catch(err => logger.warn('[lead_agent] Team brief alert failed', { error: err.message }));
  }

  return brief;
}

// ── Name extraction helper ────────────────────────────────────────────────────

// Words that are never names — used by extractNameFromMessage to reject false captures.
// Keeps the set small and focused on the patterns that actually appear as 1–2 word messages
// right after Barak asks "איך קוראים לך?" (price questions, affirmations, time preferences, etc.).
const _NAME_REJECT_WORDS = new Set([
  'כמה', 'מה', 'לא', 'כן', 'אין', 'יש', 'יקר', 'זול', 'בסדר',
  'אוקי', 'אוקיי', 'מחיר', 'עולה', 'שיעורים', 'שעות', 'מנוי',
  'נוח', 'מחפש', 'מחפשת', 'רוצה', 'מקום', 'סטודיו', 'מיקום',
  'כתובת', 'בוקר', 'ערב', 'צהריים', 'לילה', 'שבת', 'ראשון',
  'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'תודה',
]);

/**
 * Try to extract a first name (1–2 words) from a short freetext reply.
 * Called when nameAsked=true so the message is expected to be "my name is X".
 *
 * Rejects:
 *   - Messages with a question mark (questions, not names)
 *   - Messages whose meaningful-word count exceeds 2 after prefix stripping
 *     (3+ word messages are almost never bare name replies)
 *   - Messages whose words appear in _NAME_REJECT_WORDS
 */
function extractNameFromMessage(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.length > 50) return null;
  if (/\?/.test(t)) return null; // questions are not names
  const stripped = t
    .replace(/^(אני\s+|שמי\s+|קוראים לי\s+|שם שלי\s+|שם שלי הוא\s+|אפשר לקרוא לי\s+|הקשר ל\s+)/i, '');
  const heOrLatin = /[א-תװ-״a-zA-Z]/;
  const words = stripped.split(/[\s,.–—׃!]+/).filter(w => w.length >= 2 && heOrLatin.test(w));
  if (!words.length || words.length > 2) return null; // 3+ word messages are not bare name replies
  if (words.some(w => _NAME_REJECT_WORDS.has(w))) return null;
  const name = words.slice(0, 2).join(' ');
  return name.length >= 2 ? name : null;
}

// ── Safety net — block known members from ever entering the lead flow ─────────

function _loadKnownMemberPhones() {
  try {
    const data = JSON.parse(
      require('fs').readFileSync(require('path').join(__dirname, '../data/known_members.json'), 'utf8')
    );
    return new Set(data.phones ?? []);
  } catch { return new Set(); }
}

function _isKnownMemberPhone(phone) {
  if (!phone) return false;

  // Normalize consistently with server.js normalizeToE164
  const s    = String(phone).replace(/[\s\-\.\(\)]/g, '').replace(/^\+/, '');
  const norm = s.startsWith('972')   ? s
             : s.startsWith('00972') ? '972' + s.slice(5)
             : s.startsWith('0')     ? '972' + s.slice(1)
             : s;

  // Tier 1 — in-process memberCache: authoritative real-time source (seeded every 15 min from Arbox)
  if (memberCache.isConfirmed(norm) || memberCache.isConfirmed(phone)) return true;

  // Tier 2 — known_members.json: durable file-backed fallback that survives cache expiry
  const list = _loadKnownMemberPhones();
  return list.has(phone) || list.has(norm);
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Handle an inbound WhatsApp message for lead qualification.
 * Returns { reply, score, status }.
 */
async function handleInbound({ from, name, text, _pendingMessages: pendingMap = null }) {
  // ── GATE 1: Member Firewall ───────────────────────────────────────────────────
  // Checks memberCache (in-process, seeded every 15 min from Arbox) first,
  // then known_members.json. Both must miss before we continue.
  if (_isKnownMemberPhone(from)) {
    logger.warn('[lead_agent] GATE 1 BLOCKED — known member reached lead flow; reclassifying stale record', { from });
    const existing = store.getLead(from);
    if (existing && existing.status !== 'converted_member') {
      store.reclassifyAsConvertedMember(from, { name: existing.name ?? name ?? null, source: 'gate1_block' });
    }
    return { reply: null, score: 0, status: 'member' };
  }

  // ── GATE 2: Operational Intent Interceptor ────────────────────────────────────
  // Belt-and-suspenders against members who slip past Gate 1 (expired cache,
  // phone-format mismatch, Arbox outage). Deterministic regex — cannot fail.
  // Accusatory patterns ("ביטלת לי"), possessives ("האימון שלי"), absence
  // notifications ("לא אהיה ביום רביעי"), membership ops, and complaints
  // all fire here before ANY sales logic runs.
  const opCheck = checkOperationalIntent(text);
  if (opCheck.blocked) {
    logger.warn('[lead_agent] GATE 2 BLOCKED — operational intent intercepted, aborting sales pipeline', {
      from, intent: opCheck.intent, preview: text.slice(0, 80),
    });
    try {
      await sendText(from, opCheck.holdResponse);
    } catch (sendErr) {
      logger.error('[lead_agent] Gate 2 hold-response send failed', { from, error: sendErr.message });
    }
    await alertOwner(
      `🛑 Operational message intercepted — ${name ?? from}`,
      `*Contact:* ${name ?? from}\n*Phone:* ${from}\n` +
      `*Intent:* ${opCheck.intent}\n*Message:* "${text.slice(0, 200)}"\n\n` +
      `Please follow up directly — this person may be an existing member.`
    ).catch(() => {});
    store.logEvent('operational_intercepted', from, {
      intent: opCheck.intent, preview: text.slice(0, 80),
    });
    clearSession(from);
    return { reply: opCheck.holdResponse, score: 0, status: 'member_operational' };
  }

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

  // ── Anti-loop guard ─────────────────────────────────────────────────────────
  // If 4+ messages have arrived but the conversation never advanced past turn 0,
  // the bot is stuck (OpenAI errors, session resets, etc.). Escalate to human.
  if (completedTurns === 0 && msgCount >= 4) {
    logger.warn('[lead_agent] Anti-loop triggered', { from, msgCount });
    const loopMsg = `מצטער/ת — נתקלנו בתקלה טכנית 🙏 מעביר אותך לנציג מהצוות שייצור קשר ישירות.`;
    await sendText(from, loopMsg).catch(() => {});
    store.upsertLead(from, { status: 'escalated' });
    store.logEvent('loop_escalated', from, { msgCount, completedTurns: 0 });
    await alertOwner(
      `🔄 לופ אינסופי — ${name ?? from}`,
      `${msgCount} הודעות נכנסו, 0 תורות הושלמו.\nהודעה: "${text.slice(0, 100)}"`
    ).catch(() => {});
    clearSession(from);
    return { reply: loopMsg, score: 1, status: 'escalated' };
  }

  // ── Opt-out detector (checked BEFORE frustration) ───────────────────────────
  // Explicit request to stop receiving messages. Different from frustration:
  // frustration → human handoff (may resume); opt-out → permanent silence.
  // We send ONE final confirmation, then mark opted_out in the persistent store.
  // opted_out is preserved across restarts via persist.saveLeads.
  //
  // NOTE: \b does NOT work with Hebrew (Hebrew chars are \W in JS Unicode).
  //       Use space/punctuation anchors or rely on the whole-line ^ patterns.
  // Regex literals avoid string-escaping issues that plague new RegExp() with Hebrew text.
  // \b does NOT work with Hebrew characters (Hebrew is \W in JS Unicode ranges).
  // Using start/end anchors and space-class anchors instead.
  const _optOutPatterns = [
    /^\s*STOP\s*$/i,
    /^\s*unsubscribe\s*$/i,
    /^\s*HDR\s*$/i,
    /(?:^|[ ,.!?])(?:הסר|תסיר)[ו]?\s+אות[יה](?:$|[ ,.!?])/,
    /(?:^|[ ,.!?])אל\s+תשלח[ו]?(?:\s+לי)?(?:\s+יותר)?(?:\s+הודעות)?(?:$|[ ,.!?])/,
    /לא\s+רוצה\s+(?:לקבל\s+)?הודעות/,
    /(?:^|[ ,.!?])הסר\s+מרשימה(?:$|[ ,.!?])/,
  ];
  const OPT_OUT_RE = { test: (t) => _optOutPatterns.some(p => p.test(t)) };
  if (OPT_OUT_RE.test(text)) {
    const existing = store.getLead(from) ?? {};
    if (existing.status !== 'opted_out') {
      logger.info('[lead_agent] Opt-out request — marking opted_out', { from });
      store.upsertLead(from, {
        status: 'opted_out',
        meta:   { ...(existing.meta ?? {}), optedOutAt: new Date().toISOString(), optedOutMsg: text.slice(0, 80) },
      });
      store.logEvent('opted_out', from, { preview: text.slice(0, 80) });
      // Single silent acknowledgement; no further messages from any agent.
      const optOutAck = `הסרנו אותך מרשימת ההתקשרויות שלנו. לא נשלח הודעות נוספות.`;
      await sendText(from, optOutAck).catch(() => {});
      return { reply: optOutAck, score: 0, status: 'opted_out', sendState: 'sent' };
    }
    // Already opted_out — stay silent.
    return { reply: null, score: 0, status: 'opted_out' };
  }

  // ── Frustration detector ────────────────────────────────────────────────────
  // Signals frustration with the automated flow → human handoff (escalated).
  // History is preserved via reclassifyEscalated; staff can release ownership later.
  const FRUSTRATION_RE = /תפסיק[יו]?|עצר[ו]?|מה זה בכלל|מה קורה פה|רובוט|בוט|מכונה|לא לאיים|מחריד|מה הבעיה|אל תשלח[יו]? יותר|לא רוצה לקבל הודעות|STOP\b|stop\b|אדם אמיתי|נציג אנושי|לא עונה לשאלה|לא מקשיב[ה]?|לא שומע[ת]?|שטויות|להציק|אל תציק|תעיף.*בוט|הסר.*בוט|בלי.*בוט|לא.*צריך.*בוט|תסגור.*בוט|תבטל.*בוט|עצור.*אוטומט/i;
  if (FRUSTRATION_RE.test(text)) {
    logger.warn('[lead_agent] Frustration detected', { from, preview: text.slice(0, 60) });
    const frustMsg = `מצטער/ת! מעביר אותך עכשיו לנציג מהצוות שייצור קשר ישירות 😊`;
    await sendText(from, frustMsg).catch(() => {});
    // Use human_owns instead of deleting — preserves history for staff and survives restart.
    const existing2 = store.getLead(from) ?? {};
    store.upsertLead(from, {
      status: 'human_owns',
      meta: { ...(existing2.meta ?? {}), humanOwnsReason: 'frustration', humanOwnsSince: new Date().toISOString() },
    });
    store.logEvent('human_takeover_frustration', from, { preview: text.slice(0, 80) });
    alertOwner(
      `🤝 Human takeover required — ${name ?? from}`,
      `*Contact:* ${name ?? from} (${from})\n*Reason:* frustration\n*Message:* "${text.slice(0, 200)}"\n\nHistory preserved. Release via: POST /api/leads/${encodeURIComponent(from)}/release`
    ).catch(() => {});
    // sendState: 'sent' tells the pipeline the message was already dispatched.
    // Without it, the late-reply suppression sees human_owns and clears barakReply,
    // hiding the sent message from logs and the simulate response.
    return { reply: frustMsg, score: 1, status: 'human_owns', sendState: 'sent' };
  }

  // 3a-pre. Reported-booking detector — fires BEFORE call-proposed checks.
  // "קבעתי ליום ראשון", "נרשמתי", "הגעתי בראשון", "אני אגיע ביום שני" etc.
  // The person is telling us they already have a booking — stop the sales funnel.
  // We do NOT claim Arbox verification; we record as self-reported.
  const BOOKING_REPORTED_RE = /(?:קבעתי|נרשמתי|רשמתי\s+(?:את\s+עצמ|לי)|אגיע\s+ב|הגעתי\s+ב|אני\s+אגיע\s+ב|יש\s+לי\s+שיעור\s+ב|קביעה\s+ב|שמרתי\s+מקום|(?:אגיע|הגעתי|רשמתי)\s+(?:ל?יום\s+)?(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת))/i;
  if (BOOKING_REPORTED_RE.test(text) && !qualData.reportedBookingAt) {
    logger.info('[lead_agent] Reported booking detected — stopping sales funnel', { from, preview: text.slice(0, 60) });
    setQualData(from, { reportedBookingAt: new Date().toISOString(), reportedBookingText: text.slice(0, 120) });
    store.logEvent('booking_reported', from, { preview: text.slice(0, 80) });
    // The AI will see [STAGE: reported_booking] and handle gracefully — no forced close.
  }

  // 3a-decline. Detect callback refusal — stop repeating the invitation.
  if (qualData.callProposed && !qualData.callTimeGiven && !qualData.callbackDeclined
      && CALLBACK_DECLINE_RE.test(text)) {
    setQualData(from, { callbackDeclined: true });
    store.logEvent('callback_declined', from, { preview: text.slice(0, 60) });
    logger.info('[lead_agent] Callback declined by lead', { from });
  }

  // 3a. Detect callback time in this inbound message
  if (qualData.callProposed && !qualData.callTimeGiven && TIME_PATTERN.test(text)) {
    const callTime = text.trim().slice(0, 80);
    setQualData(from, { callTimeGiven: callTime });
    // Mark callback_requested (NOT call_scheduled):
    //   • Tomer/Barak workers skip this lead (getSendableLeads excludes callback_requested)
    //   • This is the AI qualification path — team was alerted via handoffService but
    //     no aptStore appointment was created. Use callback_requested to distinguish
    //     from call_scheduled (which requires a real aptStore entry).
    //   • Server.js stop-gate will send a soft ack, not "confirmed as agreed".
    store.upsertLead(from, {
      status: 'callback_requested',
      meta: {
        ...(store.getLead(from)?.meta ?? {}),
        callbackTime:         callTime,
        callbackRequestedAt:  new Date().toISOString(),
        awaitingCallbackTime: false,
      },
    });
    store.logEvent('call_time_captured', from, { callTime, statusSet: 'callback_requested' });
    logger.info('[lead_agent] Call time captured — status → callback_requested', { from, callTime });
  }

  // 3b. Location detection — runs on every message so early mentions are caught.
  //     Both NEARBY and FAR set locationCheckNeeded=true so Barak always asks
  //     a confirmation question before proceeding. The difference is in the
  //     question tone (soft convenience vs. travel feasibility).
  //     Only updates while viability hasn't been resolved.
  if (qualData.locationViable !== true && qualData.locationViable !== false) {
    if (NEARBY_LOCATION_RE.test(text)) {
      const city = text.match(NEARBY_LOCATION_RE)?.[0] ?? text.slice(0, 40);
      // locationNearby=true → "is the studio convenient?" (soft)
      setQualData(from, { locationCheckNeeded: true, locationNearby: true, location: city });
      logger.info('[lead_agent] Nearby location detected — convenience check needed', { from, city });
    } else if (FAR_LOCATION_RE.test(text)) {
      const city = text.match(FAR_LOCATION_RE)?.[0] ?? text.slice(0, 40);
      // locationNearby=false → "can you travel here?" (feasibility)
      setQualData(from, { locationCheckNeeded: true, locationNearby: false, location: city });
      logger.info('[lead_agent] Far location detected — travel feasibility check needed', { from, city });
    }
  }

  // 3c. Travel confirmation / decline — only relevant after a far location was flagged.
  //     If the check was already asked last turn and there's no explicit decline,
  //     assume viable and proceed rather than interrogating the lead repeatedly.
  if (qualData.locationCheckNeeded && qualData.locationViable !== true && qualData.locationViable !== false) {
    if (TRAVEL_CONFIRM_RE.test(text)) {
      setQualData(from, { locationViable: true, locationCheckNeeded: false });
      logger.info('[lead_agent] Travel confirmed by lead', { from });
    } else if (TRAVEL_DECLINE_RE.test(text)) {
      setQualData(from, { locationViable: false });
      logger.info('[lead_agent] Travel declined by lead', { from });
    } else if (qualData.locationCheckAsked) {
      // Question was asked last turn; no explicit decline → assume viable, move on
      setQualData(from, { locationViable: true, locationCheckNeeded: false });
      logger.info('[lead_agent] Location check unanswered — assuming viable, proceeding', { from });
    }
  }

  // 3d. If we're about to show the location check for the first time, mark it
  //     so the NEXT turn knows one ask has already happened.
  {
    const preStep4 = getQualData(from);
    if (preStep4.locationCheckNeeded && preStep4.locationViable !== true && preStep4.locationViable !== false && !preStep4.locationCheckAsked) {
      setQualData(from, { locationCheckAsked: true });
    }
  }

  // 3e. Name capture — when we asked for name, extract it from this message.
  //     Runs until confirmedName is set so a name given after the call is proposed
  //     (e.g. lead answers the price question first then gives their name) is still
  //     captured. The improved extractNameFromMessage rejects non-name inputs.
  {
    const preNameCheck = getQualData(from);
    if (preNameCheck.nameAsked && !preNameCheck.confirmedName) {
      const captured = extractNameFromMessage(text);
      if (captured) {
        store.upsertLead(from, { name: captured });
        setQualData(from, { confirmedName: captured, nameConfirmed: true });
        logger.info('[lead_agent] Name captured', { from, name: captured });
      }
    }
  }

  // 3f. Fitness interest capture — save first mention of a specific class/activity so we
  //     never re-ask what they're looking for.
  //
  //     TWO complementary detectors:
  //       FITNESS_RE — specific class names (Reformer, Barre, etc.) → sets fitnessInterest
  //       GOAL_RE    — natural-language fitness goals ("לחזק", "ירידה במשקל", etc.) → sets goal
  //
  //     Both feed the knownSection so the stage context never loops back to discovery
  //     when the lead already expressed their intent in everyday language.
  if (!getQualData(from).fitnessInterest) {
    const FITNESS_RE = /פילאטיס מכשירים|reformer|pilates barre|barre|strength|אימון כח|אימון כוח|כוח|יוגה|yoga|kangoo|קנגו|all in|toning|עיצוב|חיטוב|ashtanga|פילאטיס/i;
    const fitnessMatch = text.match(FITNESS_RE);
    if (fitnessMatch) {
      setQualData(from, { fitnessInterest: fitnessMatch[0] });
      logger.info('[lead_agent] Fitness interest captured', { from, interest: fitnessMatch[0] });
    }
  }

  if (!getQualData(from).goal) {
    // GOAL_RE matches natural-language fitness goals that don't name a specific class.
    // Captures the first matching phrase so the knownSection can display it.
    const GOAL_RE = /לחזק|חיזוק|להתחזק|ירידה.*במשקל|לרדת.*במשקל|לרזות|לעצב.*גוף|עיצוב.*גוף|שיקום|שיקומי|גמישות|לשפר.*גמישות|יציבה|לשפר.*יציבה|כאב.*גב|כאבי.*גב|לחזור.*כושר|להחזיר.*כושר|לשפר.*כושר|כושר.*כללי|להיות.*פעיל|להרגיש.*טוב|אחרי.*לידה|אחרי.*הריון|לידה|לנוח.*גוף|גוף.*בריא|להיות.*בריא|קרדיו|סיבולת|אנרגיה|להוריד.*משקל|לעלות.*שריר|שריר|כוח.*פונקציונל/i;
    const goalMatch = text.match(GOAL_RE);
    if (goalMatch) {
      setQualData(from, { goal: goalMatch[0] });
      logger.info('[lead_agent] Fitness goal captured', { from, goal: goalMatch[0] });
    }
  }

  // 3g. Arabic dialect detection — runs on every message, sticky once set.
  //     arabic_script takes priority (full Arabic response required).
  //     arabic_hebrew = Hebrew-script Arabic slang → warm Hebrew, no corporate tone.
  {
    const prevDialect = getQualData(from).dialect;
    if (!prevDialect) {
      if (ARABIC_SCRIPT_RE.test(text)) {
        setQualData(from, { dialect: 'arabic_script' });
        logger.info('[lead_agent] Arabic script detected', { from });
      } else {
        const hebrewArabicMatches = (text.match(ARABIC_HEBREW_MARKERS) || []).length;
        if (hebrewArabicMatches >= 2) {
          setQualData(from, { dialect: 'arabic_hebrew' });
          logger.info('[lead_agent] Hebrew-script Arabic dialect detected', { from });
        }
      }
    } else if (prevDialect !== 'arabic_script' && ARABIC_SCRIPT_RE.test(text)) {
      // Upgrade to full Arabic if they switch to Arabic script mid-conversation
      setQualData(from, { dialect: 'arabic_script' });
    }
  }

  // 3h. Pricing objection detection — wire up the PRICE_OBJECTION_RE that was
  //     previously defined but never applied to qualData.
  if (!getQualData(from).pricingObjection && PRICE_OBJECTION_RE.test(text)) {
    setQualData(from, { pricingObjection: true });
    logger.info('[lead_agent] Pricing objection detected', { from });
  }

  // 3i. Mark the pricing objection as handled once the AI replies with a redirect.
  //     (The CALL_PROPOSAL_RE already fires when the AI proposes the call; we reuse
  //     that signal to avoid re-injecting the repositioning block on every turn.)
  //     This is set after the AI reply is generated — see the state-flags block below.

  // 3j. Touch the persistent memory session counter on the very first message
  //     of a new conversation (completedTurns counts user messages in history).
  if (completedTurns === 0) {
    memoryService.touchSession(from);
  }

  // 4. Build the system prompt for this specific turn.
  //    freshQualData is read AFTER all step-3 mutations so the stage context
  //    always reflects the current state (including locationCheckAsked).
  const freshQualData    = getQualData(from);

  // ── Deterministic pre-interceptors ───────────────────────────────────────────
  // Fire BEFORE OpenAI for operations that must be guaranteed 100% regardless of
  // model attention. Currently handles:
  //   • Waze/address requests — LLM omits URLs or percent-encodes Hebrew characters
  //   • Schedule/timetable requests — LLM ignores MANDATORY SCHEDULE RULE and dumps class list
  const assets = studioAssets.getAssets();
  const deterministicResult =
    tryDeterministicWazeReply(text, assets) ??
    tryDeterministicScheduleReply(text, assets);
  if (deterministicResult) {
    _lastDebugCtx = { path: 'deterministic', type: deterministicResult.type, postProcess: { changes: [], clean: true } };
    logger.info('[lead_agent] Deterministic interceptor fired', { from, type: deterministicResult.type });
    // Stale gate: newer message arrived while we were processing — skip send
    if (pendingMap?.has(from)) {
      logger.info('[lead_agent] Stale deterministic send suppressed', { from });
      history.push({ role: 'user',      content: text });
      history.push({ role: 'assistant', content: deterministicResult.reply });
      saveHistory(from, history);
      store.logEvent('reply_suppressed_stale', from, { path: 'deterministic', preview: deterministicResult.reply.slice(0, 60) });
      return { reply: deterministicResult.reply, score: 0, status: 'cold', sendState: 'skipped_stale' };
    }
    try {
      await sendText(from, deterministicResult.reply);
    } catch (sendErr) {
      logger.error('[lead_agent] sendText failed (deterministic path)', { from, error: sendErr.message });
      alertOwner('⚠️ WhatsApp send failure — lead got no reply',
        `Phone: ${from}\nMessage: "${text.slice(0, 100)}"\nError: ${sendErr.message}`
      ).catch(() => {});
      return { reply: deterministicResult.reply, score: 0, status: 'send_error', sendState: 'failed' };
    }
    store.logEvent('message_out',          from, { preview: deterministicResult.reply.slice(0, 80) });
    store.logEvent('deterministic_reply',  from, { type: deterministicResult.type });
    history.push({ role: 'user',      content: text });
    history.push({ role: 'assistant', content: deterministicResult.reply });
    saveHistory(from, history);
    const score       = scoreLeadFromHistory(history, freshQualData);
    const _rawStatDet = score >= 8 ? 'hot' : score >= 5 ? 'warm' : 'cold';
    const _curStDet   = store.getLead(from)?.status;
    const _protDet    = ['human_owns', 'opted_out', 'converted_member'].includes(_curStDet);
    const status      = _protDet ? _curStDet : _rawStatDet;
    store.upsertLead(from, _protDet ? { score } : { score, status });
    store.logEvent('score_update', from, { score, status });
    logger.info('[lead_agent] Score (deterministic)', { from, score, status });
    return { reply: deterministicResult.reply, score, status };
  }

  const turnSystemPrompt = buildTurnSystemPrompt(completedTurns, freshQualData, name, from, msgCount);
  const messagesForApi   = [
    { role: 'system', content: turnSystemPrompt },
    ...history,
    { role: 'user', content: text },
  ];

  // 5. Generate AI reply
  _lastDebugCtx = { path: 'openai', completedTurns, model: process.env.OPENAI_MODEL ?? 'gpt-4o', postProcess: { changes: [], clean: true } };
  // Test hook: TEST_AI_DELAY_MS simulates generation latency so tests can inject
  // concurrent events (human takeover, newer inbound) during "generation".
  if (process.env.TEST_AI_DELAY_MS) await new Promise(r => setTimeout(r, Number(process.env.TEST_AI_DELAY_MS)));
  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:    messagesForApi,
      temperature: 0.2,   // was 0.7 — lower prevents creative rule-bypassing
      max_tokens:  350,   // was 200 — Hebrew address + Waze URL alone is ~80 tokens
    });
    reply = completion.choices[0].message.content.trim();

    // ── Post-processor: enforce output invariants ─────────────────────────────
    // Runs after every AI reply to catch failures the model missed:
    //   • Strips "אין לי תמונה" hallucinations
    //   • Injects Waze link if address is present but link is absent
    //   • Appends a question if the reply ends without one
    reply = postProcessReply(reply, freshQualData, assets);

    // ── State flags: set ONLY when AI reply confirms the action happened ──────
    //
    // Previously these were set unconditionally after any reply at the right
    // turn, causing the state machine to lie about past turns.  Now each flag
    // requires the AI's actual text to contain the relevant phrase.
    const locationResolved = !freshQualData.locationCheckNeeded && freshQualData.locationViable !== false;

    // nameAsked: set any time the AI's actual reply asks for the lead's name.
    // No turn-count guard — the AI won't ask for the name on Turn 1 in practice
    // (the Turn 1 minimal prompt doesn't include it), and removing the guard lets
    // fast-track paths that ask on Turn 2 (completedTurns=1) be recorded correctly.
    if (!freshQualData.nameAsked && !freshQualData.callProposed && locationResolved
        && NAME_ASK_RE.test(reply)) {
      setQualData(from, { nameAsked: true });
    }

    // callProposed: set only if the reply actually contained a callback invitation phrase.
    // Lowered to completedTurns >= 2 to match the new earlier invite condition.
    // nameAsked gate removed — invite can happen before name is known.
    if (completedTurns >= 2 && !freshQualData.callProposed && !freshQualData.callTimeGiven
        && CALL_PROPOSAL_RE.test(reply)) {
      setQualData(from, { callProposed: true });
    }

    // pricingObjectionHandled: set once the call proposal has been delivered after
    // a pricing objection, so the repositioning block stops re-injecting.
    if (freshQualData.pricingObjection && !freshQualData.pricingObjectionHandled && CALL_PROPOSAL_RE.test(reply)) {
      setQualData(from, { pricingObjectionHandled: true });
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
  const prevScore  = store.getLead(from)?.score ?? 4;
  const score      = scoreLeadFromHistory(history, freshQualData);
  const _rawStat   = score >= 8 ? 'hot' : score >= 5 ? 'warm' : 'cold';
  // Guard: don't overwrite a stop-status (human_owns, opted_out, converted_member)
  // that was set during AI generation (e.g. concurrent staff takeover via outgoing webhook).
  const _curSt1    = store.getLead(from)?.status;
  const _protect1  = ['human_owns', 'opted_out', 'converted_member'].includes(_curSt1);
  const status     = _protect1 ? _curSt1 : _rawStat;
  store.upsertLead(from, _protect1 ? { score } : { score, status });
  store.logEvent('score_update', from, { score, status });
  logger.info('[lead_agent] Score', { from, score, status });
  if (score !== prevScore) demoCapture.record('score_changed', { previous: prevScore, current: score, status });

  // 7a. Update qualProfile — computed after every turn for panel display.
  //     Gives the team a one-glance summary (reason + next action) without
  //     reading the full conversation.  Stored in meta so it survives restarts.
  try {
    const currentLead  = store.getLead(from);
    const currentMeta  = currentLead?.meta ?? {};
    const currentQD    = currentMeta.qualData ?? {};
    const qualProfile  = computeLeadProfile({ ...currentLead, status }, currentQD, history);
    store.upsertLead(from, { meta: { ...currentMeta, qualProfile } });
  } catch (profileErr) {
    logger.warn('[lead_agent] qualProfile update failed', { from, error: profileErr.message });
  }

  // 8. Send reply
  //    sendText is outside the OpenAI try/catch because a WhatsApp API failure
  //    is a different class of error from an OpenAI failure.

  // Stale gate: newer message arrived while the AI was generating. Skip the send
  // so the pending burst (which has full context) generates the authoritative reply.
  // History is already saved above; the follow-up will see this turn's exchange.
  if (pendingMap?.has(from)) {
    logger.info('[lead_agent] Stale AI send suppressed — newer message pending', { from });
    store.logEvent('reply_suppressed_stale', from, { path: 'ai', preview: reply.slice(0, 60) });
    return { reply, score, status, sendState: 'skipped_stale' };
  }

  // Guard: status was set to human_owns or opted_out during generation (e.g. concurrent
  // staff reply via outgoing webhook while AI was running). Suppress the send so no
  // bot message follows a staff takeover.
  const _preSendSt = store.getLead(from)?.status;
  if (['human_owns', 'opted_out'].includes(_preSendSt)) {
    logger.info('[lead_agent] Send suppressed — status changed during generation', { from, status: _preSendSt });
    store.logEvent('reply_suppressed_status_change', from, { status: _preSendSt });
    return { reply, score, status: _preSendSt, sendState: 'skipped_status_changed' };
  }

  let sendState = 'sent';
  try {
    await sendText(from, reply);
    store.logEvent('message_out', from, { preview: reply.slice(0, 80) });
  } catch (sendErr) {
    sendState = 'failed';
    logger.error('[lead_agent] sendText failed — lead did not receive reply', {
      from,
      error:   sendErr.message,
      preview: reply.slice(0, 80),
    });
    alertOwner(
      '⚠️ WhatsApp send failure — lead got no reply',
      `Phone: ${from}\nMessage: "${text.slice(0, 100)}"\nDraft reply: "${reply.slice(0, 200)}"\nError: ${sendErr.message}\n\nCheck Green API instance state.`
    ).catch(() => {});
  }

  // 9. Fire-and-forget brief + memory pipeline when entering Stage 3 or when a
  //    call time is captured on this turn.
  //
  //    Gates:
  //    • locationViable !== false  — never alert for leads who said distance is a problem
  //    • !locationCheckNeeded      — don't alert while travel feasibility is pending
  const latestQualData      = getQualData(from);
  const locationOk          = latestQualData.locationViable !== false && !latestQualData.locationCheckNeeded;
  const callTimeCapturedNow = !qualData.callTimeGiven && !!latestQualData.callTimeGiven && locationOk;
  const enteringStage3      = completedTurns >= 3 && !latestQualData.briefGeneratedAt && locationOk;

  if (enteringStage3 || callTimeCapturedNow) {
    // Always persist the JSON brief for the dashboard (no WhatsApp alert here)
    generateLeadBrief(from, history, latestQualData.callTimeGiven ?? null, { alertTeam: false })
      .catch(err => logger.warn('[lead_agent] JSON brief error', { from, error: err.message }));
  }

  if (callTimeCapturedNow) {
    // reliableHandoffAlert is awaited so the persistent handoff record reflects the outcome
    // before handleInbound returns. The lead already has their reply (sent in step 8).
    // This may add up to ~10s to the handleInbound Promise resolution, which is acceptable
    // since it runs after the outbound send and does not delay the lead's experience.
    const handoffLead = store.getLead(from);
    await reliableHandoffAlert(from, handoffLead?.name ?? from, history, latestQualData);

    // Create an aptStore entry so the reminder/no-show worker can fire.
    // The WhatsApp brief was already sent by reliableHandoffAlert above — no second alert.
    // Parse the Hebrew time asynchronously; the entry is immediately visible in the panel
    // with rawTime even if scheduledAt is null (reminder worker skips unresolved times).
    try {
      const staffCfg = JSON.parse(require('fs').readFileSync(
        require('path').join(__dirname, '../data/staff_config.json'), 'utf8'));
      const assignedId = staffCfg.default_assignee_id ?? 'eden';
      const apt = aptStore.create({
        leadPhone:       from,
        leadName:        handoffLead?.name ?? null,
        rawTime:         latestQualData.callTimeGiven,
        scheduledAt:     null,
        durationMin:     staffCfg.appointment_duration_min ?? 30,
        assignedStaffId: assignedId,
      });
      store.logEvent('apt_created_ai_path', from, { aptId: apt.id, rawTime: apt.rawTime });
      logger.info('[lead_agent] aptStore entry created for AI-path callback', { from, aptId: apt.id });

      // Parse the Hebrew time text and update scheduledAt so the reminder window works.
      calendarSvc.parseHebrewTime(apt.rawTime)
        .then(scheduledAt => {
          if (scheduledAt) {
            aptStore.update(apt.id, { scheduledAt });
            logger.info('[lead_agent] aptStore scheduledAt resolved', { aptId: apt.id, scheduledAt });
          }
        })
        .catch(err => logger.warn('[lead_agent] aptStore time parse failed', { aptId: apt.id, error: err.message }));
    } catch (aptErr) {
      logger.warn('[lead_agent] aptStore create failed — reminder will not fire', { from, error: aptErr.message });
    }

    // Save a persistent session summary to the memory store (fire-and-forget is acceptable
    // here — it enriches future conversations but is not required for the team handoff)
    memoryService.generateAndSaveSessionSummary(from, history, latestQualData)
      .catch(err => logger.warn('[lead_agent] Session summary error', { from, error: err.message }));
  }

  return { reply, score, status, sendState };
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

/**
 * Record a scheduling exchange (timetable send, Waze reply, etc.) that was
 * handled by the scheduling pipeline in server.js — NOT by the AI.
 * Without this, follow-up messages like "שלח שוב" or "תמונה" arrive at the AI
 * with no context that the previous turn was about the timetable.
 *
 * Keeps the history cap at 20 entries so memory stays bounded.
 */
function recordSchedulingExchange(phone, userText, agentReply) {
  if (!phone || !userText || !agentReply) return;
  try {
    if (!store.getLead(phone)) store.upsertLead(phone, {});
    const history = store.getLead(phone).history ?? [];
    history.push({ role: 'user',      content: userText  });
    history.push({ role: 'assistant', content: agentReply });
    saveHistory(phone, history);
  } catch (err) {
    logger.warn('[lead_agent] recordSchedulingExchange failed', { phone, error: err.message });
  }
}

module.exports = { handleInbound, clearSession, generateLeadBrief, sendIntroOffer, getLastDebugContext, recordSchedulingExchange, computeLeadProfile };

