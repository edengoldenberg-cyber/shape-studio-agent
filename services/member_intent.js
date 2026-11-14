'use strict';

/**
 * member_intent.js — what does an existing member want?
 *
 * Deterministic and ordered. Runs for members BEFORE any shared scheduling template.
 * Returns { category, hasRequest, reason }.
 *
 * Design rules (each one is an audited production failure):
 *   • A request is never dropped because it is short or lacks a keyword: anything with a
 *     request signal that fits no category becomes 'unknown_request' (→ one focused
 *     clarification, then a staff case) — never silence.
 *   • Cancelling a MEMBERSHIP and cancelling one CLASS are different categories.
 *   • Money words win over the word "הקפאה": "חויבתי ואני בהקפאה" is a billing dispute.
 *   • Reporting something that already happened ("ביטלתי", "פספסתי") is not a request to do it.
 *   • Ordinary acknowledgements and small talk produce no reply and no case.
 */

const H = '[א-ת]';
const nb = w => new RegExp(`(?<!${H})${w}(?!${H})`);          // whole Hebrew word

// ── No-reply classes ──────────────────────────────────────────────────────────
const ACK_RE = new RegExp('^(?:' + [
  'תודה(?: רבה)?(?: לך)?(?: עדן)?', 'תנקיו', 'טנקיו', 'thanks?', 'thank you', 'thx', 'ok(?:ay)?', 'אוקיי?', 'אוקי', 'סבבה', 'בסדר(?: גמור)?',
  'קיבלתי', 'הבנתי', 'ברור', 'מעולה', 'נהדר', 'מצוין', 'מושלם', 'אחלה', 'יופי', 'מגניב', 'חמוד', 'כיף', 'איזה כיף(?: לי)?', 'טוב',
  'כן', 'לא', 'אה+', 'אהה+', 'אממ*', 'וואו', 'חח+', 'הה+', 'לול', 'ביי', 'bye', 'להתראות', 'נתראה', 'שמעתי', 'ראיתי', 'כן ראיתי', 'סגור',
].join('|') + ')(?:[\\s,.!]+(?:' + ['תודה(?: רבה)?', 'רבה', 'לך', 'עדן', 'על העדכון', 'על הכל'].join('|') + '))*[\\s.!…]*$', 'i');
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}️‍\s.!?]+$/u;
const GREETING_RE = /^(?:היי+|הי+|שלום|הלו|אהלן|בוקר טוב|בוקר אור|ערב טוב|צהריים טובים|לילה טוב|שבת שלום|שבוע טוב|חג שמח|מה נשמע|מה שלומך|מה קורה|מה המצב)(?:\s+(?:עדן|תומר|לך|לכם))?[\s!.?,]*$/i;

// ── Signals ───────────────────────────────────────────────────────────────────
const REQUEST_RE = /\?|אפשר|אשמח|תוכל|תוכלי|תוכלו|יכול(?:ה|ים)?\s+ל|רוצה|רציתי|צריכ[הה]?(?!\s+להיות)|צריך|מבקש|אבקש|בבקשה|לבדוק|תבדק|תבדוק|לברר|תברר|עזרה|תעזר|לעזור|תשלח|תשלחי|לשלוח לי|תעדכנ|לעדכן|תסביר|להסביר|להסבר|איך\s|מתי\s|כמה\s|האם\s|למה\s|מה עם|מה קורה עם|נא\s/;

const OPT_OUT_RES = [
  /^\s*(?:STOP|unsubscribe|HDR)\s*$/i,
  /(?:^|[ ,.!?])(?:הסר|תסיר|הסירו|תסירו)[ו]?\s+אות[יה]/,
  /אל\s+תשלח[ו]?(?:\s+לי)?(?:\s+(?:יותר|עוד))?(?:\s+הודעות)?/,
  /לא\s+רוצה\s+(?:לקבל\s+)?(?:יותר\s+)?הודעות/,
  /הסר\s+מ(?:ה)?רשימ/,
];

const MONEY_RE      = /חויבתי|חוייבתי|חייבו אותי|חייבת אותי|חיוב|חיובים|ירד לי|ירדו לי|הורידו לי|נגבה|גבו ממני|כפל|כפול|פעמיים|תשלום|שילמתי|שלמתי|כסף|ש"ח|ש״ח|שקל|₪|אשראי|כרטיס|הוראת קבע/;
const REFUND_RE     = /זיכוי|לזכות|תזכו|יזכו|זיכו|החזר(?:\s+כספי)?|להחזיר לי|יחזירו לי|תחזירו לי/;
const DISPUTE_RE    = /לא הבנתי על מה|על מה חויבתי|למה חויבתי|למה ירד|חויבתי (?:פעמיים|כפול|בטעות|סתם)|חיוב (?:כפול|שגוי|לא נכון|מוזר)|טעות בחיוב|לא אמור(?:ה)? להיות מחויב|חויבתי למרות/;
const DECLINED_RE   = /סירוב|נדח(?:ה|תה)|לא עבר|נכשל|לא הצליח לחייב|כרטיס (?:חדש|אחר)|לעדכן (?:את )?(?:ה)?כרטיס|להחליף (?:את )?(?:ה)?כרטיס|פרטי אשראי/;
const RECEIPT_RE    = /קבלה|חשבונית|אישור תשלום|אסמכתא/;
const PAID_CLAIM_RE = /(?<![א-ת])ביט(?![א-ת])|\bbit\b|paybox|פייבוקס|העברה בנקאית|העברתי|שילמתי|שלמתי|שלחתי תשלום|שלחתי העברה|ביצעתי העברה|שלחתי\s+\S*\s*₪|הועבר/i;

const MEMBERSHIP_WORD = /מנוי|מינוי|חברות|כרטיסי(?:י)?ה/;
const MEMB_CANCEL_RE  = /(?:לבטל|ביטול|לסיים|להפסיק|לעצור לגמרי|לסגור|לצאת מ)[^.?!\n]{0,25}(?:ה)?(?:מנוי|מינוי|חברות)|לעזוב את הסטודיו|להפסיק להתאמן אצלכם|cancel (?:my )?membership/i;
const FREEZE_RE       = /להקפיא|הקפאה|הקפאת|תקפיא|תקפיאי|להשהות|השהיה|השהיית|freeze|pause/i;
const FREEZE_STATE_RE = /(?:אני|כבר|הייתי|נמצאת|נמצא)\s+(?:\S+\s+){0,4}בהקפאה|בהקפאה של|המנוי (?:שלי )?(?:מוקפא|בהקפאה)/;
const RENEW_RE        = /לחדש|חידוש|להאריך|הארכת|הארכה|לרכוש מנוי|לקנות (?:מנוי|כרטיסיי?ה)|לשדרג|לעבור למנוי|להחליף מנוי/;
const MEMB_INFO_RE    = /כמה (?:כניסות|אימונים|שיעורים) (?:נשאר|נותר|יש לי)|נשארו לי|נותרו לי|יתרת (?:ה)?כניסות|תוקף|עד מתי (?:ה)?מנוי|מתי (?:ה)?מנוי (?:שלי )?(?:נגמר|מסתיים|פג|מתחדש)|מתי (?:נגמר|מסתיים|פג) (?:לי )?(?:ה)?מנוי|איזה מנוי יש לי|מה המנוי שלי|סטטוס (?:ה)?מנוי|המנוי שלי (?:פעיל|בתוקף)/;

const STAFF_RE   = /תתקשר[יו]?\s*(?:אלי|אליי)|תחזר[יו]?\s*(?:אלי|אליי)|תחזור\s*(?:אלי|אליי)|שיחזרו (?:אלי|אליי)|שיתקשרו|להתקשר (?:אלי|אליי)|דבר[יו]?\s*(?:איתי|אתי)|תדבר[יו]?\s*(?:איתי|אתי)|לדבר (?:איתך|אתך|איתכם|עם (?:מישהו|מישהי|נציג|עדן|הצוות|בן אדם|אדם))|צריכ[הה]?\s+לדבר|צריך\s+לדבר|אפשר לדבר|יכול(?:ה)?\s+לדבר|אם (?:אתה|את) יכול(?:ה)?\s+לדבר|נציג|אדם אמיתי|שיחת טלפון|שיחה טלפונית|כשתתפנ[הי]|תרים[יו]? (?:אלי|אליי|טלפון)|תן לי צלצול|צלצל[יו]? (?:אלי|אליי)/;
const INJURY_RE  = /נפצעתי|פציעה|נפגעתי|כאב(?:ים)?\s|כואב(?:ת)?\s+לי|כואבת?\s|מתיחה|נקע|פריצת דיסק|בלט|דלקת|ניתוח|אחרי לידה|לאחר לידה|בהריון|הריון|פיזיותרפ|אורתופד|אישור רפואי|שיקום|סחרחור|התעלפ|לחץ דם|בעיה (?:בגב|בברך|בכתף|רפואית)|מגבלה רפואית/;
const COMPLAINT_RE = /תלונה|להתלונן|מתלוננת?|לא מרוצה|לא מרוצים|מאוכזב(?:ת)?|אכזבה|אכזבתם|מתוסכל(?:ת)?|כועס(?:ת)?|עצבני(?:ת)?|שירות גרוע|שירות לא|חוויה גרועה|לא מקובל|לא בסדר ש|לא יפה ש|חוסר מקצועיות|זלזול|מזלזל|ביזיון|הבטחתם|לא קיבלתי מה ש|לא ייתכן|לא יתכן|נמאס לי|די כבר/;
const APP_RE     = /אפליקצי|ארבוקס|arbox|(?:ה)?מערכת לא|לא נותנ(?:ת)? לי|לא מצליח(?:ה)?\s+ל(?:היכנס|התחבר|הירשם|הרשם|בטל|שלם|פתוח)|לא נפתח|לא עובד(?:ת)?|תקלה|שגיאה|באג|סיסמ[אה]|קוד אימות|לא מקבל(?:ת)? (?:קוד|סמס|הודעה)|להתחבר|התחברות|נראה ש(?:בוטל|נרשמתי)|היה נראה ש/;
const WAITLIST_RE = /רשימת (?:ה)?המתנה|רשימת (?:ה)?ממתינים|ברשימה|ממתינה? (?:ל|ב)|המתנה לשיעור/;
const AVAIL_RE   = /יש מקום|נשאר מקום|נותר מקום|יש עוד מקום|יש מקומות|מלא\??$|השיעור מלא|התמלא|פנוי/;
const REGULAR_RE = /קבוע(?:ה|ים|ות)?(?![א-ת])/;

const CLASS_WORD = /שיעור|אימון|פילאטיס|מכשירים|רפורמר|reformer|כ[ו]?ח(?![א-ת])|בר(?![א-ת])|barre|יוגה|קנגו|טונינג|toning|all in|חיטוב|סטרנג|strength/i;
const BOOK_RE    = /תרשמ[יו]?\s*אותי|תרשום אותי|לרשום אותי|להירשם|להרשם|ארשם|אירשם|לשבץ|תשבצ[יו]?|שבצ[יו]? אותי|שבץ אותי|תכניס[יו]? אותי|להכניס אותי|לשריין|תשמר[יו]? לי מקום|שמור לי מקום|רוצה מקום|להצטרף ל(?:שיעור|אימון)|לקבוע (?:שיעור|אימון)|להזמין (?:שיעור|אימון|מקום)/;
const RESCHED_RE = /להעביר (?:אותי|את ה)|תעביר[יו]? אותי|לעבור ל|אעבור ל|להחליף (?:את ה)?(?:שיעור|אימון)|להזיז|לשנות (?:את ה)?(?:שיעור|אימון|שעה|יום)|במקום (?:ה)?(?:שיעור|אימון)|להחליף ל/;
const CLS_CANCEL_RE = /לבטל|תבטל[יו]?|בטל[יו]? (?:לי|אותי)|להוריד אותי|תוריד[יו]? אותי|להסיר אותי מ(?:ה)?(?:שיעור|אימון)|לא (?:אגיע|אוכל להגיע|אספיק|אצליח להגיע|מגיע(?:ה)?|יכול(?:ה)? להגיע|אהיה)|לא יכול(?:ה)?\s+(?:היום|מחר|הערב|הבוקר)|מבטל(?:ת)?/;
const CANCELLED_REPORT_RE = /(?<![א-ת])(?:ביטלתי|כבר ביטלתי|הורדתי את עצמי|ביטלנו)(?![א-ת])/;
const MISSED_RE  = /לא הצלחתי להגיע|לא הגעתי|פספסתי|החמצתי|לא הספקתי להגיע|שכחתי לבטל|לא ביטלתי|לא הצלחתי לבטל|לא הספקתי לבטל|ולא לבטל/;
const MY_BOOK_RE = /(?:ל(?:איזה|אילו|מה)|מתי) (?:שיעור(?:ים)?|אימון(?:ים)?) אני (?:רשומה?|משובצת?|קבועה?)|אני רשומה? (?:ל|ב)|האם אני רשומה?|מה (?:קבעתי|נרשמתי|השיעורים שלי)|השיעורים שלי|הרישומים שלי|למה נרשמתי|נרשמתי\s*\?/;
const SCHED_RE   = /מה יש (?:היום|מחר|מחרתיים|ב|ביום)|איזה (?:שיעורים|אימונים)|אילו (?:שיעורים|אימונים)|לוח (?:ה)?שיעורים|מערכת (?:ה)?שעות|(?:ה)?לוז|לו"ז|לו״ז|מתי יש|באיזה (?:שעה|שעות|ימים)|שעות (?:ה)?(?:פעילות|שיעורים|אימונים)|מי (?:מדריכ|מעביר|מלמד)|עם מי ה(?:שיעור|אימון)|(?:יש|אין) (?:שיעור|אימון|אימונים|שיעורים)|רוב השיעורים|שעות (?:ה)?(?:בוקר|צהריים|ערב)/;
const LOCATION_RE = /כתובת|וויז|waze|ניווט|איך מגיעים|איך להגיע|איפה אתם|איפה הסטודיו|היכן (?:אתם|הסטודיו)|מיקום|חני[הי]/i;

const NEG_CALL_RE = /(?:לא|אל)\s+(?:רוצה ש|צריך ש)?\s*(?:ת)?תקשר|רק (?:וואטסאפ|הודעות)/;

function classify(rawText, { hasOpenCase = false } = {}) {
  const t = String(rawText ?? '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
  const out = (category, reason, extra = {}) => ({ category, reason, hasRequest: REQUEST_RE.test(t), ...extra });
  if (!t) return out('social', 'empty');

  if (OPT_OUT_RES.some(r => r.test(t))) return out('opt_out', 'opt-out phrase');
  if (EMOJI_ONLY_RE.test(t)) return out('social', 'emoji only');
  const bare = t.replace(/[p{Extended_Pictographic}p{Emoji_Modifier}️‍]/gu, '').trim();
  if (bare.length <= 40 && ACK_RE.test(bare)) return out('social', 'acknowledgement');
  if (/^(?:ח{2,}|ה{2,})(?:s+S+){0,2}$/.test(bare)) return out('social', 'laughter');
  if (t.length <= 40 && GREETING_RE.test(t)) return out('social', 'greeting only');

  const money = MONEY_RE.test(t), refund = REFUND_RE.test(t);

  // Safety / people first.
  if (INJURY_RE.test(t)) return out('injury', 'injury or medical wording');
  if (COMPLAINT_RE.test(t)) return out('complaint', 'dissatisfaction wording');

  // Money (before freeze: "חויבתי ואני בהקפאה" is about the charge).
  if (refund) return out('refund_request', 'refund / credit wording');
  if (DISPUTE_RE.test(t) || (money && /למה|לא הבנתי|לא ברור|טעות|בטעות|פעמיים|כפול|למרות/.test(t))) return out('billing_dispute', 'disputes a charge');
  if (money && DECLINED_RE.test(t)) return out('payment_issue', 'declined payment / card details');
  if (RECEIPT_RE.test(t) && REQUEST_RE.test(t)) return out('receipt_request', 'asks for a receipt');

  // Membership (cancel ≠ class cancel).
  if (MEMB_CANCEL_RE.test(t)) return out('membership_cancel', 'cancel + membership');
  if (FREEZE_RE.test(t) && !FREEZE_STATE_RE.test(t)) return out('membership_freeze', 'freeze wording');
  if (FREEZE_STATE_RE.test(t) && money) return out('billing_dispute', 'charged while on hold');

  // A person.
  if (STAFF_RE.test(t) && !NEG_CALL_RE.test(t)) return out('staff_request', 'asks to talk to / be called by staff');

  if (PAID_CLAIM_RE.test(t)) return out('payment_claim', 'says a payment was made');
  if (money && REQUEST_RE.test(t) && !MEMBERSHIP_WORD.test(t)) return out('billing_question', 'money question');

  // The system blocks me / app trouble (before booking: "המערכת לא נותנת לי להירשם").
  if (APP_RE.test(t)) return out('app_problem', 'app / system problem');

  if (MEMB_INFO_RE.test(t)) return out('membership_info', 'asks about own membership');
  if (RENEW_RE.test(t) && (MEMBERSHIP_WORD.test(t) || /לחדש|חידוש/.test(t))) return out('membership_renew', 'renew / change membership');

  // Classes.
  if (WAITLIST_RE.test(t)) return out('waitlist', 'waitlist wording');
  if (MY_BOOK_RE.test(t)) return out('my_bookings', 'asks what they are booked for');
  if (REGULAR_RE.test(t) && (BOOK_RE.test(t) || CLS_CANCEL_RE.test(t) || RESCHED_RE.test(t) || CLASS_WORD.test(t))) return out('regular_booking', 'standing (fixed) booking change');
  if (MISSED_RE.test(t)) return out('class_missed', 'reports a missed class');
  if (CANCELLED_REPORT_RE.test(t) && !/לא\s+ביטלתי/.test(t)) return out('class_cancelled_report', 'reports having cancelled');
  if (RESCHED_RE.test(t)) return out('class_reschedule', 'wants to move a class');
  if (/לא (?:יכול(?:ה)?|מצליח(?:ה)?) (?:להירשם|להרשם)/.test(t)) return out('app_problem', 'cannot register');
  if (BOOK_RE.test(t)) return out('class_book', 'wants to be registered');
  if (CLS_CANCEL_RE.test(t) && !MEMBERSHIP_WORD.test(t)) return out('class_cancel', 'cannot come / cancel a class');
  if (AVAIL_RE.test(t) && (CLASS_WORD.test(t) || /היום|מחר|ב-?\d/.test(t))) return out('availability', 'asks about free spots');
  if (SCHED_RE.test(t)) return out('schedule_query', 'asks about the timetable');
  if (LOCATION_RE.test(t)) return out('location', 'asks where / how to get there');

  if (MEMBERSHIP_WORD.test(t) && REQUEST_RE.test(t)) return out('membership_info', 'membership question');
  if (REQUEST_RE.test(t)) return out(/\?/.test(t) && t.length > 12 ? 'general_question' : 'unknown_request', 'request signal, no category');
  return out('statement', hasOpenCase ? 'statement while a case is open' : 'no request signal');
}

const NO_REPLY = new Set(['social', 'statement']);

module.exports = { classify, NO_REPLY, REQUEST_RE };
