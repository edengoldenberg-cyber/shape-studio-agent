'use strict';

/**
 * sales_refusal.js — an explicit decision NOT to register / NOT to be called, and what may be said after it.
 *
 * Production, 2026-11-17: a lead wrote "אני בסוף החלטתי לא להרשם", was answered politely, wrote "תודה רבה על הניסיון"
 * and was then asked "רוצה שנציג יחזור אליך ויעזור לבחור את האימון המתאים?". The offer was added by a fixed rule in the
 * code (the word "ניסיון" in her thank-you matched a "sales question" pattern), not by the model.
 *
 * Owner rules (2026-11-18):
 *   1. an explicit refusal is stored (date, source, context) and stops sales offers, requests to arrange a call and
 *      automatic follow-ups for that interest; it never raises the lead's score
 *   2. "thank you", an emoji or a courtesy after a refusal does not reopen the sale — also days later, also after a
 *      restart: one short answer, then silence
 *   3. a new, explicit question is answered — a refusal to register is not a block on service, and answering does not
 *      cancel the refusal
 *   4. every rule that adds an offer of a representative respects the refusal (stripOffers is the one gate)
 *   5. an explicit request for a call or to register opens a NEW interest, and that is recorded
 *   6. "אל תתקשרו אליי" is not a request for a call: no callback is created and no reminder is sent
 *   7. when the message is unclear (hesitation, several intentions) nothing is offered automatically
 * Nothing here touches Arbox: a refusal in a sales conversation changes no registration and no membership.
 *
 * Pure functions, no I/O.
 */

const HEB = 'א-ת';
const Q = /[?？]/;
const B = `(?<![${HEB}])`, E = `(?![${HEB}])`;

// ── Explicit refusal to register / to continue ────────────────────────────────
const REFUSAL_RES = [
  // "החלטתי (בסוף) (ש)לא" — on its own, or about registering / continuing. "החלטתי לא לבוא היום" is about one lesson.
  new RegExp(`החלט(?:תי|נו)\\s+(?:בסוף\\s+|בינתיים\\s+|כרגע\\s+)?ש?לא${E}(?:\\s+(?:להי?רשם|להמשיך|להצטרף|לעשות\\s+מנוי|לקחת\\s+מנוי|ללכת\\s+על\\s+זה|כרגע|בינתיים|הפעם|בסוף))?\\s*(?:$|[.!,;🙏]|תודה)`, 'u'),
  new RegExp(`(?:בסוף|בינתיים|לצערי)\\s+(?:אני\\s+|אנחנו\\s+)?(?:החלט(?:תי|נו)\\s+)?ש?לא\\s+(?:א?י?רשם|ני?רשם|להי?רשם|אמשיך|נמשיך|להמשיך|אגיע|נגיע|אצטרף|נצטרף|להצטרף|מתאים|רלוונטי|יוצא)`),
  new RegExp(`${B}לא\\s+(?:אי?רשם|ני?רשם|אמשיך|נמשיך|אצטרף|נצטרף|ממשיכ(?:ה|ים|ות)?)${E}`),
  new RegExp(`${B}לא\\s+(?:רוצה|רוצים|מתכוונת?|מתכננת?|הולכת?)\\s+(?:להי?רשם|להמשיך|להצטרף|מנוי|לעשות\\s+מנוי|לקחת\\s+מנוי)`),
  new RegExp(`${B}לא\\s+מעוניינ(?:ת|ים|ות)?${E}(?!\\s+(?:ב?שיחה|שי?תקשרו|שי?חזרו|בטלפון|כרגע\\s+בשיחה))`),
  new RegExp(`${B}(?:זה\\s+)?(?:כבר\\s+)?לא\\s+רלוונטי`),
  new RegExp(`${B}(?:זה\\s+)?לא\\s+(?:בשבילי|בשבילנו)${E}`),
  new RegExp(`${B}(?:זה\\s+)?לא\\s+מתאים\\s+לי${E}(?!\\s+(?:היום|מחר|השבוע|בשעה|בשעות|בימי|ביום|בבוקר|בערב|כרגע|עכשיו))`),
  new RegExp(`${B}(?:ויתרתי|ויתרנו|אני\\s+מוותרת?|נוותר|מוותרים|אוותר)${E}`),
  new RegExp(`(?:נרשמתי|נרשמנו|הצטרפתי|סגרתי|התחלתי)\\s+(?:כבר\\s+)?(?:ל|ב|עם\\s+|אצל\\s+)?(?:מקום|סטודיו|מכון|חדר\\s+כושר)\\s+אחר`),
  new RegExp(`מצאתי\\s+(?:לי\\s+|כבר\\s+)?(?:מקום|סטודיו|מכון|משהו)\\s+אחר`),
  new RegExp(`${B}(?:תורידו|תסירו|תמחקו)\\s+אותי\\s+מ(?:ה)?(?:רשימ|תור|מעקב)`),
];

// ── "Do not call me" (not a refusal to register, and never a request for a call) ─
const NO_CALL_RES = [
  new RegExp(`${B}(?:אל|לא)\\s+(?:ל)?(?:ת)?תקשרו(?:\\s+אלי)?`), new RegExp(`${B}(?:אל|לא)\\s+(?:ל)?(?:ת)?חזרו\\s+אלי`),
  new RegExp(`${B}(?:בבקשה\\s+)?לא\\s+להתקשר`), new RegExp(`${B}בלי\\s+(?:שיחות|טלפונים|שיחת\\s+טלפון)`),
  new RegExp(`${B}לא\\s+(?:רוצה|צריך|צריכה|מעוניינת?)\\s+(?:ש(?:י|ת)?(?:תקשרו|חזרו)|שיחה|שיחת|טלפון|שנציג)`),
  new RegExp(`${B}(?:אל|לא)\\s+(?:ת|ל)?(?:צלצלו|צלצל)`), new RegExp(`${B}רק\\s+(?:ב)?(?:הודעות|וואטסאפ|ווטסאפ|כתב|בכתב)`),
  new RegExp(`${B}(?:תפסיקו|הפסיקו|די)\\s+ל(?:התקשר|חייג|צלצל)`),
];

// ── An explicit request for a call, a representative, or to register after all ─
const CALL_REQUEST_RES = [
  new RegExp(`(?:אשמח|רוצה|רוצים|אפשר|תוכלו|אפשרי|מעוניינת?|מבקשת?|בא\\s+לי)[^.!?\\n]{0,25}(?:שי?חזרו|שתחזרו|שי?תקשרו|שתתקשרו|לדבר\\s+עם|שיחה\\s+עם|נציג|שיחת\\s+טלפון)`),
  new RegExp(`${B}(?:תחזרו|חזרו|תתקשרו|התקשרו|צלצלו)\\s+אלי`),
  new RegExp(`(?:אשמח|רוצה|רוצים|מעוניינת?|החלטתי|החלטנו)\\s+(?:בכל\\s+זאת\\s+|בסוף\\s+כן\\s+|בסוף\\s+|כן\\s+)?(?:להי?רשם|להצטרף|לקבוע|לתאם|לנסות\\s+שוב)`),
  new RegExp(`התחרטתי|שיניתי\\s+את\\s+דעתי|חשבתי\\s+על\\s+זה\\s+שוב`),
];

// ── Hesitation: not a refusal, but not a moment to add an offer automatically ───
const HESITATION = new RegExp(`אחשוב\\s+על|נחשוב\\s+על|צריכה?\\s+לחשוב|אולי\\s+(?:בעתיד|בהמשך|אחר\\s+כך|פעם)|לא\\s+(?:עכשיו|כרגע|בטוחה?|יודעת?|סגורה?)|${B}נראה${E}|אחזור\\s+אליכ|אעדכן|אודיע|נדבר|בהמשך|יקר\\s+לי|לא\\s+בתקציב|קשה\\s+לי|עמוס|לא\\s+מסתדר|לא\\s+יוצא\\s+לי|${B}לא${E}[^.!?\\n]{0,20}(?:להי?רשם|מנוי|להמשיך|להצטרף|מתאים)`);

// Courtesy only: thanks, a greeting, an acknowledgement, emoji, punctuation.
const COURTESY_TOKENS = [
  'תודה רבה רבה', 'תודה רבה', 'המון תודה', 'תודה', 'תודות', 'מעולה', 'מצוין', 'מושלם', 'אחלה', 'יופי', 'סבבה', 'בסדר גמור', 'בסדר',
  'אוקיי', 'אוקי', 'או קיי', 'הבנתי', 'קיבלתי', 'סורי', 'סליחה', 'ביי', 'להתראות', 'להת', 'יום טוב', 'יום נפלא', 'יום מקסים',
  'שבוע טוב', 'שבת שלום', 'ערב טוב', 'לילה טוב', 'בוקר טוב', 'חג שמח', 'בהצלחה', 'שיהיה בהצלחה', 'גם לך', 'גם לכם', 'גם לכן', 'גם אתם',
  'מעריכה', 'מעריך', 'אין בעד מה', 'היה נעים', 'חחח', 'חח', 'thanks', 'thank you', 'thx', 'ok', 'okay', 'bye', 'כן', 'אין בעיה', 'נחמד', 'מקסים',
];
const COURTESY_TAIL = /על\s+(?:ה[א-ת]+(?:\s+ה[א-ת]+)?|הכל|הכול)/g;                      // "תודה על הניסיון", "תודה על המענה"

function norm(text) {
  return String(text ?? '').replace(/[‎‏‪-‮]/g, '').replace(/[״”“]/g, '"').replace(/[׳’‘]/g, "'").replace(/\s+/g, ' ').trim();
}
/**
 * Clauses of a message: split at sentence ends, line breaks and contrast words ("…, אבל …"). A comma alone does not
 * split: "אם לא ארשם עכשיו, זה בסדר?" is ONE question. A clause that asks, or that is conditional ("אם …", "נניח ש…"),
 * states nothing and is marked.
 */
const CONDITIONAL = new RegExp(`${B}(?:אם|במידה|נניח|בהנחה|כש|כאשר|לפני\\s+ש|עד\\s+ש)${E}`);
function clauses(text) {
  return norm(String(text ?? '').replace(/\n+/g, '. ')).split(/(?<=[.!?？])\s+|\s*[,;]?\s+(?:אבל|אך|רק\s+ש|חוץ\s+מזה|ובכל\s+זאת|עם\s+זאת)\s+/u).map(s => s.trim()).filter(Boolean)
    .map(s => ({ text: s, asks: Q.test(s) || CONDITIONAL.test(s) }));
}
const any = (res, t) => res.some(re => re.test(t));

/** An explicit "do not call me". */
function isNoCall(text) { const t = norm(text); return !!t && clauses(t).some(c => !c.asks && any(NO_CALL_RES, c.text)); }
/** An explicit request for a call, a representative or to register after all — never a negated one. */
function isCallRequest(text) {
  const t = norm(text);
  if (!t || isNoCall(t)) return false;
  return clauses(t).some(c => any(CALL_REQUEST_RES, c.text) && !new RegExp(`${B}(?:לא|אל|בלי)\\s+(?:צריך\\s+|רוצה\\s+|מעוניינת?\\s+)?(?:להי?רשם|להצטרף|שיחה|נציג)`).test(c.text));
}
/** The message says that the person decided not to register / is not interested. A clause that ASKS is never a refusal. */
function isRefusal(text) {
  const t = norm(text);
  if (!t || isCallRequest(t)) return false;
  return clauses(t).some(c => !c.asks && any(REFUSAL_RES, c.text));
}
/** Hesitation or a negative that is not an explicit refusal: no offer is added automatically after it. */
function isHesitation(text) { const t = norm(text); return !!t && !isRefusal(t) && !isNoCall(t) && HESITATION.test(t); }
/** Only thanks / a greeting / an acknowledgement / emoji — nothing is asked and nothing is requested. */
function isCourtesy(text) {
  let t = norm(text).toLowerCase();
  if (!t || Q.test(t) || t.length > 80) return false;
  t = t.replace(COURTESY_TAIL, ' ');
  for (const tok of [...COURTESY_TOKENS].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(?<![${HEB}a-z])${tok}(?![${HEB}a-z])`, 'g'), ' ');
  }
  t = t.replace(new RegExp(`${B}(?:לך|לכם|לכן|שוב|ממש|באמת|מאוד|רב|היי|הי|אז|טוב|יאללה|ו|היה|הייתם|אתם)${E}`, 'g'), ' ');
  return !/[א-תa-z0-9]/.test(t);
}
/** The message also asks something (a clause with a question mark, or a question word) besides whatever else it says. */
function asksSomething(text) {
  return clauses(text).some(c => c.asks || new RegExp(`${B}(?:כמה|מתי|איפה|היכן|איך|האם|מה\\s+(?:המחיר|הכתובת|השעות|עולה|כולל))${E}`).test(c.text));
}

/**
 * A message with several intentions ("החלטתי לא להירשם, אבל כמה עולה שיעור ניסיון?"): the part that is still to be
 * answered, without the clause that only states the refusal / the "do not call". Any other message is returned as is.
 */
function questionPart(text) {
  const t = norm(text);
  if (!t || !(isRefusal(t) || isNoCall(t)) || !asksSomething(t)) return String(text ?? '');
  const rest = clauses(t).filter(c => c.asks || !(any(REFUSAL_RES, c.text) || any(NO_CALL_RES, c.text))).map(c => c.text).join(' ').trim();
  return rest || String(text ?? '');
}

// ── Offers ────────────────────────────────────────────────────────────────────
// A sentence that offers a call / a representative / a trial / registration (an invitation, or a question about one).
const OFFER_TOPIC = /נציג|שיחה|שיחת|יחזור\s+אליך|יחזרו\s+אליך|נחזור\s+אליך|אחזור\s+אליך|לחזור\s+אליך|יתקשר|נתקשר|להתקשר|לתאם|לקבוע|ניסיון|היכרות|להי?רשם|להצטרף|הרשמה|מתי\s+נוח|באיזו\s+שעה/;
const OFFER_MARK = /(?<!לא )רוצה|רוצים|תרצ[הי]|תרצו|מעוניינ|אשמח|נשמח|מוזמנ|כדאי|אפשר\s+ל|בוא[יו]?(?![א-ת])|מה\s+דעתך|מתאים\s+לך|נוח\s+לך|שנ[א-ת]+|\?/;
/**
 * Remove every sentence that offers a call, a representative, a trial or registration. What answers the question —
 * a price, an address, a fact about the service — stays. Returns the cleaned text; `fallback` when nothing is left.
 */
function stripOffers(reply, fallback = 'תודה 🙏') {
  const r = String(reply ?? '');
  if (!r.trim()) return r;
  // a sentence ends at . ! ? … or a line break, after an emoji, and before a clause that opens an invitation
  // ("יש חניה ליד הסטודיו 🙂 רוצה שנתאם…" is an answer followed by an offer, not one sentence)
  const kept = r.split(/(?<=[.!?…])(?=\s)|(?<=\n)|(?<=\p{Extended_Pictographic}️?)(?=\s)|(?=\s(?:רוצה|רוצים|תרצי|תרצה|תרצו|אשמח|נשמח|מוזמנת?|מוזמנים)\s+(?:ש|ל))/u)
    .filter(sn => !(OFFER_TOPIC.test(sn) && OFFER_MARK.test(sn)));
  const out = kept.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out || fallback;
}
/** True when the text contains an offer that stripOffers would remove. */
const hasOffer = reply => stripOffers(reply, '') !== String(reply ?? '').trim();

const REPLY_TO_REFUSAL  = 'תודה על העדכון 🙏 שיהיה בהצלחה!';
const REPLY_TO_COURTESY = 'בשמחה 🙏';
const REPLY_TO_NO_CALL  = 'בסדר גמור, לא נתקשר 🙏';

/**
 * What to do with an inbound message, given the stored state.
 *   state: { declined, courtesyAnswered, noCall }
 * Returns { action, reply?, patch? }:
 *   'refusal'           a refusal now: fixed short reply, state → declined
 *   'refusal_question'  a refusal AND a question in one message: state → declined, the ordinary flow answers (offers stripped)
 *   'no_call'           "do not call me": no callback, fixed short reply
 *   'courtesy'          thanks (or a repeated refusal) after a refusal: one short reply, no offer
 *   'silent'            more thanks after that one: nothing is sent
 *   'reopen'            an explicit request for a call / to register: a new interest, the ordinary flow continues
 *   'question'          anything else after a refusal / a no-call: the ordinary flow answers it, with offers stripped
 *   'none'              no refusal is involved
 */
function decide(text, state = {}, nowIso = new Date().toISOString()) {
  const declined = state.declined === true, noCall = state.noCall === true;
  if (isCallRequest(text)) {
    if (!declined && !noCall) return { action: 'none' };
    return { action: 'reopen', patch: { registrationDeclined: false, registrationReopenedAt: nowIso, registrationReopenedText: norm(text).slice(0, 120),
                                         declineCourtesyAnswered: false, callbackDeclined: false, doNotCall: false } };
  }
  if (isRefusal(text)) {
    if (declined) return state.courtesyAnswered ? { action: 'silent' } : { action: 'courtesy', reply: REPLY_TO_COURTESY, patch: { declineCourtesyAnswered: true } };
    const patch = { registrationDeclined: true, registrationDeclinedAt: nowIso, registrationDeclinedText: norm(text).slice(0, 160),
                    declineCourtesyAnswered: false, callbackDeclined: true, callProposed: false, ...(isNoCall(text) ? { doNotCall: true, doNotCallAt: nowIso } : {}) };
    return asksSomething(text) ? { action: 'refusal_question', patch } : { action: 'refusal', reply: REPLY_TO_REFUSAL, patch };
  }
  if (isNoCall(text)) {
    if (noCall) return declined || state.courtesyAnswered ? { action: 'silent' } : { action: 'courtesy', reply: REPLY_TO_COURTESY, patch: { declineCourtesyAnswered: true } };
    const patch = { doNotCall: true, doNotCallAt: nowIso, doNotCallText: norm(text).slice(0, 160), callbackDeclined: true, callProposed: false };
    return asksSomething(text) ? { action: 'question', patch } : { action: 'no_call', reply: REPLY_TO_NO_CALL, patch };
  }
  if (!declined && !noCall) return { action: 'none' };
  if (declined && isCourtesy(text)) {
    return state.courtesyAnswered ? { action: 'silent' } : { action: 'courtesy', reply: REPLY_TO_COURTESY, patch: { declineCourtesyAnswered: true } };
  }
  return { action: 'question' };
}

/**
 * The state that a stored conversation implies, for a record that has no refusal field (written before the field
 * existed): the LAST explicit refusal counts unless an explicit request for a call / to register came after it.
 *   userTexts: the lead's messages, oldest first.
 * Returns { declined, index, text, courtesyAfter } — index of the refusal in userTexts, or -1.
 */
function stateFromHistory(userTexts = []) {
  let idx = -1;
  userTexts.forEach((t, i) => { if (isRefusal(t)) idx = i; else if (idx >= 0 && isCallRequest(t)) idx = -1; });
  if (idx < 0) return { declined: false, index: -1, text: null, courtesyAfter: false };
  return { declined: true, index: idx, text: norm(userTexts[idx]).slice(0, 160), courtesyAfter: userTexts.slice(idx + 1).some(isCourtesy) };
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
  [/אם\s+תרצה\/י|אם\s+תרצי\/ה/g, 'אם יתאים לך'],
  [/תרצה\/י\s+ל/g, 'מתאים לך ל'],
  [/תרגיש\/י\s+מה\s+המקום\s+נותן\s+ותחליט\/י/g, 'אפשר להרגיש מה המקום נותן ולהחליט'],
  [/את\/ה\s+צודק\/ת/g, 'נכון'],
  [/איך\s+את\/ה\s+מרגיש\/ה/g, 'איך ההרגשה'],
  [/ספר\/י\s+ל(נו|י)/g, 'אפשר לספר ל$1'],
  [/ענה\/י\s+/g, 'אפשר לענות '],
  [/שלח\/י\s+/g, 'אפשר לשלוח '],
  [/פנה\/י\s+/g, 'אפשר לפנות '],
  [/מה\s+מחפש\/ת/g, 'מה מעניין אותך'],
  [/מצטער\/ת/g, 'סליחה'],
  [/מבין\/ה/g, 'מובן'],
  [/ברוכ\/ה\s+הבא\/ה/g, 'ברוכים הבאים'],
  [/ברוכ\/ה/g, 'אפשר'],
  [/חוזר\/ת/g, 'שוב'],
  [/מוזמנ\/ת|מוזמן\/ת/g, 'אפשר'],
  [/מעוניינ\/ת|מעוניין\/ת/g, 'בעניין'],
  [/מדריכ\/ה\s+מתאים\/ה/g, 'מדריך מתאים מהצוות'],
  [/מדריך\/ה|מדריכ\/ה|מדריכ\/ת/g, 'הדרכה'],
  [/שמכיר\/ה/g, 'שמכירה'],
  [/הלקוח\/ה/g, 'הלקוח'],
];
const SLASH_FORM = /[א-ת]\/(?:ה|ת|י|ים|ות|ית|תי)(?![א-ת])/;
const hasSlashForm = text => SLASH_FORM.test(String(text ?? ''));
function neutralWording(text) {
  let out = String(text ?? '');
  if (!hasSlashForm(out)) return out;
  for (const [re, to] of SLASH_FIXES) out = out.replace(re, to);
  return out;
}

module.exports = { isRefusal, isCallRequest, isNoCall, isCourtesy, isHesitation, asksSomething, questionPart, stripOffers, hasOffer, decide, stateFromHistory,
  neutralWording, hasSlashForm, REPLY_TO_REFUSAL, REPLY_TO_COURTESY, REPLY_TO_NO_CALL };
