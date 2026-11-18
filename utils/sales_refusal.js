'use strict';

/**
 * sales_refusal.js — an explicit decision NOT to register, and what may be said after it.
 *
 * Production, 2026-11-17: a lead wrote "אני בסוף החלטתי לא להרשם", was answered politely, wrote "תודה רבה על הניסיון"
 * and was then asked "רוצה שנציג יחזור אליך ויעזור לבחור את האימון המתאים?". The offer was added by a fixed rule in the
 * code (the word "ניסיון" in her thank-you matched a "sales question" pattern), not by the model.
 *
 * Owner rules (2026-11-18):
 *   1. an explicit refusal stops sales offers, requests to arrange a call and automatic follow-ups for that interest
 *   2. "thank you", an emoji or a courtesy after a refusal does not reopen the sale: a short answer once, then silence
 *   3. a new, explicit question is answered — a refusal to register is not a block on service
 *   4. every rule that adds an offer of a representative respects the refusal (stripOffers is the one gate)
 *   5. an explicit request for a call or to register reopens the conversation
 * Nothing here touches Arbox: a refusal in a sales conversation changes no registration and no membership.
 *
 * Pure functions, no I/O.
 */

const HEB = 'א-ת';
const Q = /[?？]/;

// "החלטתי (בסוף) (ש)לא להירשם / להמשיך / להצטרף", "לא אירשם", "לא מעוניינת", "לא רלוונטי", "ויתרתי", "מצאתי מקום אחר"…
const REFUSAL_RES = [
  /החלטתי\s+(?:בסוף\s+|בינתיים\s+)?ש?לא(?![א-ת])/,
  /(?:בסוף|בינתיים|כרגע)\s+(?:אני\s+)?(?:החלטתי\s+)?ש?לא\s+(?:א?י?רשם|להי?רשם|אמשיך|להמשיך|אגיע|אצטרף|להצטרף|מתאים|רלוונטי)/,
  /(?<![א-ת])לא\s+(?:אי?רשם|ני?רשם|אמשיך|נמשיך|אצטרף)(?![א-ת])/,
  /(?<![א-ת])לא\s+(?:רוצה|מתכוונת?|מתכננת?)\s+(?:להי?רשם|להמשיך|להצטרף|מנוי|לעשות\s+מנוי)/,
  /(?<![א-ת])לא\s+מעוניינ(?:ת|ים|ות)?(?![א-ת])(?!\s+(?:ב?שיחה|שי?תקשרו|שי?חזרו|בטלפון|כרגע\s+בשיחה))/,
  /(?<![א-ת])(?:זה\s+)?(?:כבר\s+)?לא\s+רלוונטי/,
  /(?<![א-ת])(?:זה\s+)?לא\s+(?:מתאים|בשבילי|בשביל\s+אני)\s*(?:לי)?(?![א-ת])/,
  /(?<![א-ת])(?:ויתרתי|אני\s+מוותרת?|נוותר|מוותרים)(?![א-ת])/,
  /(?:נרשמתי|הצטרפתי|סגרתי)\s+(?:כבר\s+)?(?:ל|ב|עם\s+)?(?:מקום|סטודיו|מכון|חדר\s+כושר)\s+אחר/,
  /מצאתי\s+(?:לי\s+)?(?:מקום|סטודיו|מכון|משהו)\s+אחר/,
];

// An explicit request to be called, to speak with someone, or to register after all.
const CALL_REQUEST_RES = [
  /(?:אשמח|רוצה|אפשר|תוכלו|אפשרי|מעוניינת?|מבקשת?)[^.!?\n]{0,25}(?:שי?חזרו|שתחזרו|שי?תקשרו|שתתקשרו|לדבר\s+עם|שיחה\s+עם|נציג|שיחת\s+טלפון)/,
  /(?<![א-ת])(?:תחזרו|חזרו|תתקשרו|התקשרו)\s+אלי/,
  /(?:אשמח|רוצה|מעוניינת?|החלטתי)\s+(?:בכל\s+זאת\s+|בסוף\s+כן\s+|כן\s+)?(?:להי?רשם|להצטרף|לקבוע|לתאם|לנסות\s+שוב)/,
  /התחרטתי|שיניתי\s+את\s+דעתי|חשבתי\s+על\s+זה\s+שוב/,
];
const NEGATED_REQUEST = /(?<![א-ת])(?:לא|אל|בלי)\s+(?:צריך\s+|רוצה\s+|מעוניינת?\s+)?(?:ש?[ית]?חזרו|ש?[ית]?תקשרו|שיחה|נציג|להי?רשם|להצטרף)/;

// Courtesy only: thanks, a greeting, an acknowledgement, emoji, punctuation.
const COURTESY_TOKENS = [
  'תודה רבה רבה', 'תודה רבה', 'המון תודה', 'תודה', 'תודות', 'מעולה', 'מצוין', 'מושלם', 'אחלה', 'יופי', 'סבבה', 'בסדר גמור', 'בסדר',
  'אוקיי', 'אוקי', 'אוקיי', 'או קיי', 'הבנתי', 'קיבלתי', 'סורי', 'סליחה', 'ביי', 'להתראות', 'להת', 'יום טוב', 'יום נפלא', 'יום מקסים',
  'שבוע טוב', 'שבת שלום', 'ערב טוב', 'לילה טוב', 'בוקר טוב', 'חג שמח', 'בהצלחה', 'שיהיה בהצלחה', 'גם לך', 'גם לכם', 'גם לכן', 'גם אתם',
  'מעריכה', 'מעריך', 'אין בעד מה', 'היה נעים', 'חחח', 'חח', 'thanks', 'thank you', 'thx', 'ok', 'okay', 'bye', 'כן', 'אין בעיה',
];
const COURTESY_TAIL = /על\s+(?:ה[א-ת]+|הכל|הכול|הזמן|המענה|התשובה|העזרה|הסבלנות|ההבנה|הניסיון|השירות|היחס)/g;   // "תודה על הניסיון"

function norm(text) {
  return String(text ?? '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
}
/** The message says explicitly that the person decided not to register / is not interested. A question is never a refusal. */
function isRefusal(text) {
  const t = norm(text);
  if (!t || Q.test(t)) return false;
  if (isCallRequest(t)) return false;
  return REFUSAL_RES.some(re => re.test(t));
}
/** An explicit request for a call, a representative or to register after all (not a negated one). */
function isCallRequest(text) {
  const t = norm(text);
  if (!t || NEGATED_REQUEST.test(t)) return false;
  return CALL_REQUEST_RES.some(re => re.test(t));
}
/** Only thanks / a greeting / an acknowledgement / emoji — nothing is asked and nothing is requested. */
function isCourtesy(text) {
  let t = norm(text).toLowerCase();
  if (!t || Q.test(t) || t.length > 80) return false;
  t = t.replace(COURTESY_TAIL, ' ');
  for (const tok of [...COURTESY_TOKENS].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(?<![${HEB}a-z])${tok}(?![${HEB}a-z])`, 'g'), ' ');
  }
  t = t.replace(/(?<![א-ת])(?:לך|לכם|לכן|שוב|ממש|באמת|מאוד|רב|היי|הי|אז|טוב|יאללה|ו)(?![א-ת])/g, ' ');
  return !/[א-תa-z0-9]/.test(t);
}

// A sentence that offers a call / a representative / a trial / registration (an invitation, or a question about one).
const OFFER_TOPIC = /נציג|שיחה|שיחת|יחזור\s+אליך|יחזרו\s+אליך|נחזור\s+אליך|אחזור\s+אליך|לחזור\s+אליך|יתקשר|נתקשר|להתקשר|לתאם|לקבוע|ניסיון|היכרות|להי?רשם|להצטרף|הרשמה|מתי\s+נוח|באיזו\s+שעה/;
const OFFER_MARK = /(?<!לא )רוצה|רוצים|תרצ[הי]|תרצו|מעוניינ|אשמח|נשמח|מוזמנ|כדאי|אפשר\s+ל|בוא[יו]?(?![א-ת])|מה\s+דעתך|מתאים\s+לך|נוח\s+לך|שנ[א-ת]+|\?/;
/**
 * Remove every sentence that offers a call, a representative, a trial or registration. What answers the question stays.
 * Returns the cleaned text; `fallback` when nothing is left.
 */
function stripOffers(reply, fallback = 'תודה 🙏') {
  const r = String(reply ?? '');
  if (!r.trim()) return r;
  // a sentence ends at . ! ? … or a line break, after an emoji, and before a clause that opens an invitation
  // ("יש חניה ליד הסטודיו 🙂 רוצה שנתאם…" is an answer followed by an offer, not one sentence)
  const kept = r.split(/(?<=[.!?…])(?=\s)|(?<=\n)|(?<=\p{Extended_Pictographic}️?)(?=\s)|(?=\s(?:רוצה|רוצים|תרצי|תרצה|תרצו|אשמח|נשמח)\s+ש)/u).filter(sn => !(OFFER_TOPIC.test(sn) && OFFER_MARK.test(sn)));
  const out = kept.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out || fallback;
}

const REPLY_TO_REFUSAL  = 'תודה על העדכון 🙏 שיהיה בהצלחה!';
const REPLY_TO_COURTESY = 'בשמחה 🙏';

/**
 * What to do with an inbound message, given the stored state.
 *   state: { declined: boolean, courtesyAnswered: boolean }
 * Returns { action, reply?, patch? }:
 *   'refusal'   a refusal now: fixed short reply, state → declined
 *   'courtesy'  thanks after a refusal: one short reply, no offer
 *   'silent'    more thanks after that one: nothing is sent
 *   'reopen'    an explicit request for a call / to register: state cleared, the ordinary flow continues
 *   'question'  anything else after a refusal: the ordinary flow answers it, with offers stripped
 *   'none'      no refusal is involved
 */
function decide(text, state = {}, nowIso = new Date().toISOString()) {
  if (isRefusal(text)) {
    return { action: 'refusal', reply: REPLY_TO_REFUSAL,
             patch: { registrationDeclined: true, registrationDeclinedAt: nowIso, registrationDeclinedText: norm(text).slice(0, 120),
                      declineCourtesyAnswered: false, callbackDeclined: true, callProposed: false } };
  }
  if (!state.declined) return { action: 'none' };
  if (isCallRequest(text)) {
    return { action: 'reopen', patch: { registrationDeclined: false, registrationReopenedAt: nowIso, declineCourtesyAnswered: false, callbackDeclined: false } };
  }
  if (isCourtesy(text)) {
    return state.courtesyAnswered ? { action: 'silent' } : { action: 'courtesy', reply: REPLY_TO_COURTESY, patch: { declineCourtesyAnswered: true } };
  }
  return { action: 'question' };
}

// ── Neutral wording ───────────────────────────────────────────────────────────
// "את/ה", "מחפש/ת", "תחליט/י": the gender is not known and must not be guessed, and a slash is not how people write.
// The frequent forms are rewritten to a neutral phrasing; anything else with a slash is reported by hasSlashForm().
const SLASH_FIXES = [
  [/מאיזה\s+אזור\s+את\/ה(?:\s+מגיע\/ה)?/g, 'מאיזה אזור בארץ'],
  [/שאת\/ה\s+מחפש\/ת/g, 'שמעניין אותך'],
  [/מה\s+את\/ה\s+מחפש\/ת/g, 'מה מעניין אותך'],
  [/את\/ה\s+מחפש\/ת/g, 'מעניין אותך'],
  [/אם\s+תחליט\/י\s+לחזור/g, 'אם יתאים לחזור'],
  [/אם\s+תרצה\/י|אם\s+תרצ[הי]\/[יה]/g, 'אם יתאים לך'],
  [/תרגיש\/י\s+מה\s+המקום\s+נותן\s+ותחליט\/י/g, 'אפשר להרגיש מה המקום נותן ולהחליט'],
  [/את\/ה\s+צודק\/ת/g, 'נכון'],
  [/איך\s+את\/ה\s+מרגיש\/ה/g, 'איך ההרגשה'],
  [/ספר\/י\s+לנו/g, 'אפשר לספר לנו'],
  [/מה\s+מחפש\/ת/g, 'מה מעניין אותך'],
  [/מצטער\/ת/g, 'סליחה'],
  [/מוזמנ\/ת|מוזמן\/ת/g, 'אפשר'],
  [/מעוניינ\/ת|מעוניין\/ת/g, 'בעניין'],
  [/הלקוח\/ה/g, 'הלקוח'],
];
const SLASH_FORM = /[א-ת]\/(?:ה|ת|י|ים|ות|ית|תי)(?![א-ת])/;
const hasSlashForm = text => SLASH_FORM.test(String(text ?? ''));
function neutralWording(text) {
  let out = String(text ?? '');
  if (!hasSlashForm(out)) return out;
  for (const [re, to] of SLASH_FIXES) out = out.replace(re, to);
  // what is left: the slash and the alternative ending are dropped ("תוכל/י" → "תוכל" would guess a gender), so the
  // remaining unknown forms are reported by the caller rather than rewritten
  return out;
}

module.exports = { isRefusal, isCallRequest, isCourtesy, stripOffers, decide, neutralWording, hasSlashForm, REPLY_TO_REFUSAL, REPLY_TO_COURTESY };
