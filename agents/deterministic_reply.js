'use strict';

/**
 * deterministic_reply.js
 *
 * Pre-interceptors that return a guaranteed-correct reply BEFORE the OpenAI
 * call is made.  Used for critical operations where prompt instructions have
 * proven unreliable due to attention dilution, token truncation, or model
 * improvisation:
 *
 *   • Waze / address requests — LLM sometimes omits the URL, percent-encodes
 *     Hebrew characters, or forgets the link entirely when it hits max_tokens.
 *
 * Returns { reply: string, type: string } when a deterministic handler fires,
 * or null to fall through to the AI as normal.
 */

// Matches messages that are asking for OUR studio location / address / navigation.
// Anchored variants (^) cover short standalone queries ("כתובת?", "ניווט").
// Combined patterns require both a navigation term and a studio reference to
// reduce false positives (e.g. "איפה אתה גר?" should NOT trigger this).
// Matches any inbound message that is asking for OUR studio's physical location,
// address, or navigation link.  Grouped by intent type for readability.
const WAZE_REQUEST_RE = new RegExp(
  [
    // Standalone bare queries (anchored to start)
    '^כתובת\\b', '^ניווט\\b', '^וויז\\b', '^waze\\b',
    // Address requests
    'מה.*כתובת', 'שלח.*כתובת', 'שלחי.*כתובת', 'כתובת.*הסטודיו',
    // Navigation with studio context (require context word to avoid bare ניווט false positives)
    'ניווט.*(?:אליכם|לסטודיו|שלכם|אליכן)',
    // Waze brand name (anchored with word boundary)
    'וויז\\b', 'waze\\b',
    // How-to-get-there (all gender/number variants)
    'איך מגיעים', 'איך מגיעות', 'איך להגיע', 'איך מגיע\\b', 'איך מגיעה\\b',
    // English / Maps app terms
    'גוגל מפות', 'navigation', 'directions', 'how to get',
    // "Send me a link" patterns
    'שלח.*קישור.*(?:ניווט|מפה|לכם)', 'שלחי.*קישור.*(?:ניווט|מפה|לכן)',
    'אפשר.*קישור.*(?:ניווט|מפה)', 'קישור.*(?:לניווט|למפה)',
    // Location queries with studio reference
    'מה.*מיקום.*(?:שלכם|הסטודיו)', 'מיקום.*(?:שלכם|הסטודיו)',
    'היכן.*(?:אתם|הסטודיו|אתן)',
    '(?:אתם|הסטודיו|אתן).*(?:איפה|כתובת)',
    'איפה.*(?:אתם|הסטודיו|נמצאים|נמצאות)',
    // "You're in [place]?" confirmation-seeking questions
    'אתם.*(?:ב|ב-)(?:פרדס|חדרה|קיסריה|בנימינה)',
    'הסטודיו.*(?:ב|ב-)(?:פרדס|חדרה|קיסריה|בנימינה)',
  ].join('|'),
  'i'
);

/**
 * Returns a deterministic Waze reply if the inbound message is requesting
 * the studio address or a navigation link; returns null otherwise.
 *
 * @param {string} text   - raw inbound message text
 * @param {object} assets - result of studioAssets.getAssets()
 * @returns {{ reply: string, type: string } | null}
 */
function tryDeterministicWazeReply(text, assets) {
  if (!text || !WAZE_REQUEST_RE.test(text)) return null;

  const address = 'דרך השדה 12, פרדס חנה-כרכור';
  const waze    = assets?.wazeUrl ?? null;

  const reply = waze
    ? `${address} 🗺️\n${waze}\nהמיקום מתאים לך? תרצה/י לתאם ביקור אימון?`
    : `${address} 🗺️\nאשלח לך קישור ניווט ישיר — המיקום מתאים לך?`;

  return { reply, type: 'waze_deterministic' };
}

// ── Schedule / timetable request interceptor ─────────────────────────────────
//
// The LLM occasionally ignores the MANDATORY SCHEDULE RULE and either dumps a
// class list or says "אין לי תמונה". This deterministic handler fires first so
// the response is always consistent with the mandated scripted phrase.
//
// Matches messages that are asking for the full weekly timetable or schedule image.
// Day-specific queries (e.g. "מה יש ביום שני?") are intentionally excluded — those
// should go to the AI for a live Arbox lookup answer.

const SCHEDULE_TIMETABLE_RE = /מערכת שעות|לוח שיעורים|לוח.*שבוע|שבוע.*לוח|שלח[יה]?.*לוח|שלח[יה]?.*מערכת|הלוח שלכם|הלוח שלך|שעות.*הסטודיו|שעות.*שלכם|שעות.*שלך|שעות פעילות|שעות פתיחה|מתי פתוח[ים]?|לראות.*שעות|רוצה.*לוח|יש לכם.*תמונה.*לוח|יש תמונה|תמונה.*לוח|לוח.*תמונה|אפשר.*לראות.*לוח|לראות.*מערכת|שלח.*מערכת|רוצה.*מערכת|מה יש.*השבוע|השבוע.*לוח|שלח[יה]?\s+לי\s+תמונה|תשלח[יה]?\s+לי\s+תמונה|אפשר\s+תמונה|לשלוח\s+לי\s+תמונה|שלוח\s+לי\s+תמונה/i;

const SPECIFIC_DAY_RE = /היום|מחר|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת/;

/**
 * Returns a deterministic schedule reply if the message is requesting the full
 * timetable/schedule (not a day-specific query). Returns null to fall through to AI.
 *
 * @param {string} text   - raw inbound message text
 * @param {object} assets - result of studioAssets.getAssets()
 * @returns {{ reply: string, type: string } | null}
 */
function tryDeterministicScheduleReply(text, assets) {
  if (!text) return null;
  if (!SCHEDULE_TIMETABLE_RE.test(text)) return null;
  // Day-specific queries need live Arbox data — let the AI handle them
  if (SPECIFIC_DAY_RE.test(text)) return null;

  // Mirror the Waze pattern: only promise the image when we can actually deliver it.
  // When timetableUrl is null, return an honest conversational nudge instead of
  // "שולח לך את המערכת עכשיו" — a phrase that server.js cannot fulfil without a URL.
  if (assets?.timetableUrl) {
    return {
      reply: `שולח לך את המערכת עכשיו 📅\nאחרי שתראה/י — ספר/י לי איזה יום ושעה בדרך כלל עובדים לך 😊`,
      type:  'schedule_deterministic',
    };
  }

  // No image configured — honest fallback that keeps the conversation moving
  // without making a promise we cannot keep.
  return {
    reply: `הלוח שלנו משתנה תדיר 😊 ספר/י לי איזה יום ושעה בדרך כלל עובדים לך — ואמצא לך מה יש.`,
    type:  'schedule_deterministic_no_image',
  };
}

module.exports = {
  tryDeterministicWazeReply,
  WAZE_REQUEST_RE,
  tryDeterministicScheduleReply,
  SCHEDULE_TIMETABLE_RE,
};
