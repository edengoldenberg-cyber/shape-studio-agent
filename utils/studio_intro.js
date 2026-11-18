'use strict';

/**
 * studio_intro.js — a lead who asks for general details about the studio gets a short introduction and ONE focused
 * question, built only from verified studio knowledge. Deterministic: it does not depend on the model.
 *
 * Production, 2026-11-18 16:23: "היי אשמח לקבל פרטים נוספים על הסטודיו" was answered with
 * "קיבלנו את הודעתך. כדי שנוכל לעזור — במה אפשר לעזור?" — the lead had already said what he wanted. The message held
 * none of the "sales intent" words, so it was filed as an unclassified contact and got the fixed greeting; Barak was
 * never called. And the restored class list was not part of Barak's lead conversation at all.
 *
 *   isInfoRequest(text)   an explicit request to hear about the studio / what it offers (not a supplier's pitch)
 *   isSpecific(text)      the message already names a class, a price, a time or the address — answered by the usual flow
 *   build({ classNames }) the introduction + one question. With no verified class list it says nothing it cannot
 *                         stand behind and asks the same one question; `partial: true` then tells the caller to report it.
 */

const H = '[א-ת]';
// asks to RECEIVE details / information ("אשמח לקבל פרטים", "אפשר מידע?", "פרטים בבקשה")
const ASKS_DETAILS = new RegExp([
  `(?:לקבל|אפשר|אשמח|רוצה|רציתי|מבקש(?:ת)?|תשלח[וי]?\\s+לי|שלח[וי]?\\s+לי|תנ[וי]\\s+לי|יש\\s+לכם)[^.?!\\n]{0,25}(?:פרטים|מידע|אינפורמציה|הסבר)`,
  `^(?:היי+|הי+|שלום|אהלן|ערב טוב|בוקר טוב)?[\\s,!.]*(?:פרטים|מידע)(?:\\s+נוספים|\\s+נוסף)?(?:\\s+בבקשה)?[\\s.!?🙏😊]*$`,
].join('|'));
// asks to hear about the place / what is on offer
const ASKS_ABOUT = new RegExp([
  `(?:לשמוע|לדעת|לברר|להבין)\\s+(?:עוד\\s+|קצת\\s+|יותר\\s+)?(?:על|מה)`,
  `(?:ספר[וי]?|תספר[וי]?|תסביר[וי]?|הסביר[וי]?)\\s+לי`,
  `מה\\s+(?:אתם|את|אתה)\\s+(?:מציע|עוש)`, `מה\\s+יש\\s+(?:אצלכם|לכם|בסטודיו)`, `איזה\\s+(?:שיעורים|אימונים|חוגים)\\s+יש`, `מה\\s+מציעים`,
  `(?<!${H})מתענ(?:יינ|ין)`, `(?<!${H})מעונ(?:יינ|ין)`, `איך\\s+זה\\s+עובד\\s+אצלכם`,
].join('|'));
// what a supplier or a job seeker writes — never an interest in training
const NOT_A_LEAD = /להציע\s+לכם|הצעת\s+מחיר\s+ל|שיתוף\s+פעולה|שירותי\s|ספק(?:ית)?|קורות\s+חיים|משרה|לעבוד\s+אצלכם|דרוש|פרסום\s+ל|חשבונית/;
const SPECIFIC = /פילאטיס|יוגה|(?<![א-ת])כו?ח(?![א-ת])|קנגו|רפורמר|מכשירים|barre|toning|all\s*in|מחיר|כמה\s+(?:זה\s+)?עולה|עלות|תשלום|שעות|לוח|מערכת|מתי\s+יש|ניסיון|היכרות|כתובת|איפה\s+(?:אתם|זה|הסטודיו)|להירשם|להרשם/i;

const clean = t => String(t ?? '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
const isInfoRequest = text => { const t = clean(text); return !!t && !NOT_A_LEAD.test(t) && (ASKS_DETAILS.test(t) || ASKS_ABOUT.test(t)); };
const isSpecific = text => SPECIFIC.test(clean(text));

const heList = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} ו${/^[\dA-Za-z]/.test(a[a.length - 1]) ? '-' : ''}${a[a.length - 1]}`);

/**
 * @param {{ classNames?: string[] }} k  class types as the studio names them, already verified by the caller
 * @returns {{ text: string, partial: boolean, used: string[] }}
 */
function build({ classNames = [] } = {}) {
  const names = [...new Set((classNames ?? []).map(n => String(n ?? '').trim()).filter(Boolean))].slice(0, 7);
  if (!names.length) {
    return { partial: true, used: [], text: 'היי 😊 כאן ברק מ-Shape Studio, שמח שפנית.\nכדי שאכוון אותך נכון — איזה סוג אימון מעניין אותך?' };
  }
  const pick = names.slice(0, 2);
  return { partial: false, used: names,
    text: `היי 😊 כאן ברק מ-Shape Studio.\nיש אצלנו ${heList(names)}.\nמה הכי מעניין אותך — ${pick.join(', ')} או משהו אחר?` };
}

module.exports = { isInfoRequest, isSpecific, build };
