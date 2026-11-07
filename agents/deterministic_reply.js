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
const WAZE_REQUEST_RE =
  /^כתובת\b|^ניווט\b|^וויז\b|^waze\b|מה.*כתובת|שלח.*כתובת|שלחי.*כתובת|כתובת.*הסטודיו|ניווט|וויז\b|waze\b|איך מגיעים|איך מגיעות|איך להגיע|גוגל מפות|navigation|directions|how to get|מה.*מיקום.*(?:שלכם|הסטודיו)|מיקום.*(?:שלכם|הסטודיו)|היכן.*(?:אתם|הסטודיו|אתן)|(?:אתם|הסטודיו|אתן).*(?:איפה|כתובת)|איפה.*(?:אתם|הסטודיו|נמצאים|נמצאות)/i;

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

module.exports = { tryDeterministicWazeReply, WAZE_REQUEST_RE };
