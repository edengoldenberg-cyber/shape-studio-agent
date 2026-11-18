'use strict';

/**
 * callback_time.js — strict, deterministic resolver for a prospect's requested callback time.
 *
 * resolveCallbackTime(text, ref, opts) → one of
 *   { ok: true,  scheduledAt: Date, hasDate: boolean }
 *   { ok: false, reason, clarification }
 *
 * `ref` MUST be the timestamp of the message that supplied the time. All calendar
 * arithmetic is done in Asia/Jerusalem regardless of the server's own timezone.
 *
 * Design rules (each one is a past production defect):
 *   • Never default a missing hour (no silent "noon").
 *   • Never guess around an invalid explicit date (30.02, 31.11, hour 25) — ask.
 *   • Never accept a weekday that contradicts the explicit date — ask.
 *   • Never return a time that is not in the future relative to `ref`.
 *   • No AI fallback: an unresolved time is a clarification question, not a guess.
 *
 * Reasons: 'no_time' | 'missing_hour' | 'missing_day_ambiguous' | 'invalid_date' |
 *          'invalid_hour' | 'weekday_date_conflict' | 'past' | 'too_far' | 'outside_hours'
 */

const TZ = 'Asia/Jerusalem';

const HE_WEEKDAY = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
const HE_WEEKDAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTH = {
  'ינואר': 0, 'פברואר': 1, 'מרץ': 2, 'מרס': 2, 'מארס': 2, 'אפריל': 3, 'מאי': 4, 'יוני': 5,
  'יולי': 6, 'אוגוסט': 7, 'ספטמבר': 8, 'אוקטובר': 9, 'נובמבר': 10, 'דצמבר': 11,
};
// Spoken hours. Longer phrases first so "אחת עשרה" is not read as "אחת".
const HE_HOUR_WORDS = [
  ['שתים עשרה', 12], ['שתיים עשרה', 12], ['שתיים-עשרה', 12], ['שתים-עשרה', 12],
  ['אחת עשרה', 11], ['אחת-עשרה', 11], ['אחד עשר', 11],
  ['עשר', 10], ['תשע', 9], ['שמונה', 8], ['שבע', 7], ['שש', 6], ['חמש', 5],
  ['ארבע', 4], ['שלוש', 3], ['שתיים', 2], ['שתים', 2], ['אחת', 1],
];

const MAX_DAYS_AHEAD = 60;

// ── Asia/Jerusalem calendar helpers (independent of process TZ) ────────────────

const _partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in Israel. month is 0-based. */
function ilParts(date) {
  const p = {};
  for (const { type, value } of _partsFmt.formatToParts(date)) p[type] = value;
  return {
    year: +p.year, month: +p.month - 1, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second, weekday: _WD[p.weekday],
  };
}

/**
 * Israel wall-clock → UTC instant. Returns null when that wall-clock time does not
 * exist (spring-forward gap) or when the calendar date itself is invalid.
 */
function ilDate(year, month0, day, hour = 0, minute = 0) {
  const probeUtc = Date.UTC(year, month0, day, hour, minute, 0);
  // Reject non-existent calendar dates (Date.UTC silently rolls 30 Feb → 2 Mar).
  const chk = new Date(probeUtc);
  if (chk.getUTCFullYear() !== year || chk.getUTCMonth() !== month0 || chk.getUTCDate() !== day) return null;
  for (const offsetH of [2, 3]) {
    const cand = new Date(probeUtc - offsetH * 3600 * 1000);
    const p = ilParts(cand);
    if (p.year === year && p.month === month0 && p.day === day && p.hour === hour && p.minute === minute) return cand;
  }
  return null;
}

/** Add whole calendar days to an Israel calendar date (DST-safe). */
function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

function weekdayOf({ year, month, day }) {
  return new Date(Date.UTC(year, month, day)).getUTCDay();
}

function isValidYmd(year, month0, day) {
  if (!(month0 >= 0 && month0 <= 11) || !(day >= 1 && day <= 31)) return false;
  const d = new Date(Date.UTC(year, month0, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month0 && d.getUTCDate() === day;
}

/**
 * "יום ראשון, 15.11.2026 בשעה 11:00" — always from a concrete instant, in Israel time.
 * With `windowEnd` (the prospect gave a RANGE of hours): "יום ראשון, 15.11.2026 בין 14:00 ל-16:00".
 * A range is the prospect's availability, never an appointed hour, and is always written as a range.
 */
/**
 * `availability` ('after' | 'until'): the prospect gave a CONSTRAINT, not a time ("אחרי 16:00", "עד 12:00"). It is
 * written exactly as a constraint — never as an appointed hour and never as a range with an end nobody gave.
 */
function formatCallbackTime(date, windowEnd = null, availability = null) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const p  = ilParts(d);
  const dd = String(p.day).padStart(2, '0'), mm = String(p.month + 1).padStart(2, '0');
  const hh = String(p.hour).padStart(2, '0'), mi = String(p.minute).padStart(2, '0');
  const e  = windowEnd ? (windowEnd instanceof Date ? windowEnd : new Date(windowEnd)) : null;
  if (e && !isNaN(e.getTime()) && e.getTime() > d.getTime()) {
    const q = ilParts(e);
    if (q.year === p.year && q.month === p.month && q.day === p.day)
      return `יום ${HE_WEEKDAY_NAMES[p.weekday]}, ${dd}.${mm}.${p.year} בין ${hh}:${mi} ל-${String(q.hour).padStart(2, '0')}:${String(q.minute).padStart(2, '0')}`;
  }
  if (availability === 'after') return `יום ${HE_WEEKDAY_NAMES[p.weekday]}, ${dd}.${mm}.${p.year} אחרי ${hh}:${mi}`;
  if (availability === 'until') return `יום ${HE_WEEKDAY_NAMES[p.weekday]}, ${dd}.${mm}.${p.year} עד ${hh}:${mi}`;
  return `יום ${HE_WEEKDAY_NAMES[p.weekday]}, ${dd}.${mm}.${p.year} בשעה ${hh}:${mi}`;
}

// ── Calling hours ─────────────────────────────────────────────────────────────
// The configured quiet-hours window (QUIET_HOUR_START/QUIET_HOUR_END, Israel time) is
// the only calling-hours configuration in the system: callbacks may be requested for
// [QUIET_HOUR_END, QUIET_HOUR_START). Overridable via CALLBACK_HOUR_START/END.
function callingHours() {
  const start = parseInt(process.env.CALLBACK_HOUR_START ?? process.env.QUIET_HOUR_END   ?? '8',  10);
  const end   = parseInt(process.env.CALLBACK_HOUR_END   ?? process.env.QUIET_HOUR_START ?? '22', 10);
  const ok = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 && start < end;
  return ok ? { start, end } : { start: 8, end: 22 };
}
function withinHours(h, m, { start, end }) {
  const mins = h * 60 + m;
  return mins >= start * 60 && mins < end * 60;
}

// ── Clarification texts (truthful next steps — never a commitment) ────────────
function clarify(reason, ctx = {}) {
  switch (reason) {
    case 'missing_hour':
      return `באיזו שעה נוח לך? 🙂 (למשל 10:00 או 17:30)`;
    case 'missing_day_ambiguous':
      return `רק כדי לוודא — לאיזה יום ובאיזו שעה? (למשל "מחר ב-10:00")`;
    case 'invalid_date':
      return `התאריך שכתבת לא קיים בלוח השנה 🙂 לאיזה יום ושעה לרשום את השיחה?`;
    case 'invalid_hour':
      return `לא הצלחתי להבין את השעה 🙂 באיזו שעה נוח לך? (למשל 10:00 או 17:30)`;
    case 'weekday_date_conflict':
      return ctx.dateLabel && ctx.weekdayLabel
        ? `רק כדי לוודא — ${ctx.dateLabel} יוצא ביום ${ctx.actualWeekdayLabel}, לא ביום ${ctx.weekdayLabel}. לאיזה יום התכוונת?`
        : `היום והתאריך שכתבת לא תואמים 🙂 לאיזה יום התכוונת?`;
    case 'past':
      return `המועד הזה כבר עבר 🙂 מתי יהיה לך נוח שנחזור אליך? (יום ושעה)`;
    case 'too_far':
      return `אפשר לתאם שיחה לשבועות הקרובים 🙂 איזה יום ושעה מתאימים לך?`;
    // The window used here is the system's quiet-hours setting (when nothing automatic is sent). It is NOT a calling
    // policy the owner approved, so no hours are stated or promised to the prospect.
    case 'outside_hours':
      return `בשעה הזו לא אוכל לרשום בקשת שיחה 🙂 איזו שעה אחרת במהלך היום נוחה לך?`;
    case 'range_unclear':
      return `לא הצלחתי להבין את טווח השעות 🙂 בין איזו שעה לאיזו שעה נוח לך? (למשל "מחר בין 14:00 ל-16:00")`;
    case 'english_time':
      return `כדי שלא אטעה במועד — אפשר לכתוב את התאריך והשעה במספרים? למשל: 19.11 בשעה 14:00, או 19.11 בין 14:00 ל-16:00 🙂\nSo I don't get it wrong - could you write the date and time in numbers? For example: 19.11 14:00-16:00`;
    default:
      return `מתי יהיה לך נוח שנחזור אליך? (יום ושעה, למשל "מחר ב-10:00")`;
  }
}
function fail(reason, ctx) { return { ok: false, reason, clarification: clarify(reason, ctx) }; }

// ── Text helpers ──────────────────────────────────────────────────────────────
const HEB = 'א-ת';
// A Hebrew word boundary: not preceded/followed by another Hebrew letter. One-letter
// prefixes (ב/ל/ה/ו/מ/ש/כ) are allowed in front of the word.
function heWord(word) {
  return new RegExp(`(?<![${HEB}])(?:[בלהומשכ]{0,2})${word}(?![${HEB}])`);
}

function normalize(raw) {
  return String(raw ?? '')
    .replace(/[‎‏‪-‮]/g, '')   // bidi marks
    .replace(/[״”“]/g, '"').replace(/[׳’‘]/g, "'")
    .replace(/[–—־]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Date extraction ───────────────────────────────────────────────────────────

/**
 * Finds an explicit calendar date. Returns
 *   { found:false } | { found:true, valid:false } | { found:true, valid:true, day, month, year|null, rest }
 * `rest` is the text with the date removed, so "15.11" is never re-read as an hour.
 */
function extractExplicitDate(t) {
  // DD.MM.YYYY / DD/MM/YY / DD-MM-YYYY
  let m = t.match(/(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?!\d)/);
  if (m) {
    const day = +m[1], month = +m[2] - 1;
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const rest = t.replace(m[0], ' ');
    return { found: true, valid: isValidYmd(year, month, day), day, month, year, rest };
  }
  // DD.MM or DD/MM (no year). The second field must be a plausible month; a value
  // above 12 means this is a time written with a dot ("10.30"), not a date.
  m = t.match(/(?<![\d:.])(\d{1,2})\s*[./]\s*(\d{1,2})(?![\d:.])/);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    const day = +m[1], month = +m[2] - 1;
    const rest = t.replace(m[0], ' ');
    return { found: true, valid: day >= 1 && day <= 31, day, month, year: null, rest };
  }
  // "15 בנובמבר [2026]" / "15 לנובמבר" / "15 נובמבר"
  for (const [name, idx] of Object.entries(HE_MONTH)) {
    const re = new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:ב|ל|ב-|ל-)?\\s*${name}(?![${HEB}])(?:\\s+(\\d{4}))?`);
    m = t.match(re);
    if (m) {
      const day = +m[1];
      const year = m[2] ? +m[2] : null;
      const rest = t.replace(m[0], ' ');
      return { found: true, valid: day >= 1 && day <= 31, day, month: idx, year, rest };
    }
  }
  return { found: false };
}

function extractWeekday(t) {
  // "יום ראשון", "ביום שני", "בראשון", "ראשון הבא", "יום א'"
  for (const [name, wd] of Object.entries(HE_WEEKDAY)) {
    // Prefix ה is deliberately not allowed: "השיעור הראשון" is an ordinal, not a weekday.
    const re = new RegExp(`(?<![${HEB}])(?:ו?[בל]?)(?:יום\\s+ה?)?${name}(?![${HEB}])`);
    // "שני" also means "second"/"two" — require an explicit day marker for it.
    if (name === 'שני') {
      if (/(?<![א-ת])(?:[בלהו]{0,2})יום\s+שני(?![א-ת])|(?<![א-ת])בשני(?![א-ת])|שני\s+הבא/.test(t)) return wd;
      continue;
    }
    if (re.test(t)) return wd;
  }
  const letter = t.match(/(?<![א-ת])(?:[בל])?יום\s+([א-ו])['"]?(?![א-ת])/);
  if (letter) return 'אבגדהו'.indexOf(letter[1]);
  return null;
}

// ── Hour extraction ───────────────────────────────────────────────────────────

/**
 * Returns { found:false } | { found:true, valid:false } |
 *         { found:true, valid:true, h, min, explicit24:boolean }
 * explicit24 = the prospect wrote an unambiguous 24h value (HH:MM with HH ≥ 13, or 0).
 */
// A bare "ב-5" / "ל-3" is only an hour when the day is known or nothing but a time-ish
// word follows — "מנוי ל-3 חודשים" must never become 15:00.
const BARE_TAIL = '(?=\\s*(?:$|[,.!?)]|בבוקר|בערב|בלילה|בצהריים|אחה"צ|אחר|אחרי|וחצי|ורבע|בדיוק|אם|זה|מתאים|נוח|טוב|בסדר|אפשר|יהיה|בבקשה|תודה))';
const BARE_HOUR_STRICT = new RegExp('(?<![א-ת\\d])(?:[בל]|אחרי|לקראת|סביב|עד)\\s*-?\\s*(\\d{1,2})(?![\\d./:])' + BARE_TAIL);
const BARE_HOUR_LOOSE  = new RegExp('(?<![א-ת\\d])(?:[בל]|אחרי|לקראת|סביב|עד)\\s*-?\\s*(\\d{1,2})(?![\\d./:])');

function extractHour(t, { dayKnown = false } = {}) {
  const qualifierPm = /(?<![א-ת])(?:ב|ל)?(?:ערב|לילה)(?![א-ת])|אחה"צ|אחר\s+ה?צהריים|אחרי\s+ה?צהריים|בצהריים|(?<![א-ת])צהריים(?![א-ת])|\bpm\b/i.test(t);
  const qualifierAm = /(?<![א-ת])(?:ב|ל)?בוקר(?![א-ת])|לפני\s+ה?צהריים|\bam\b/i.test(t);

  let h = null, min = 0;

  // HH:MM (or HH.MM where MM > 12 was not consumed as a date)
  let m = t.match(/(?<![\d:.])(\d{1,2})\s*[:.]\s*(\d{2})(?![\d:.])/);
  if (m) { h = +m[1]; min = +m[2]; }

  // "בשעה 10", "שעה 5", "ב-10", "ב10", "ל-9", "בסביבות 4", "10 בבוקר", "5 בערב"
  if (h === null) {
    m = t.match(/(?:בשעה|שעה|בסביבות(?:\s+ה?שעה)?)\s*-?\s*(\d{1,2})(?!\d)/)
      ?? t.match(dayKnown ? BARE_HOUR_LOOSE : BARE_HOUR_STRICT)
      ?? t.match(/(?<!\d)(\d{1,2})\s*(?:בבוקר|בערב|בלילה|בצהריים|אחה"צ|אחר\s+ה?צהריים|אחרי\s+ה?צהריים|am|pm)/i);
    if (m) h = +m[1];
  }

  // Spoken hours: "בעשר", "בשעה חמש", "בשתיים וחצי"
  if (h === null) {
    for (const [word, val] of HE_HOUR_WORDS) {
      const re = new RegExp(`(?<![${HEB}])(?:בשעה\\s+|שעה\\s+|ב|ל|בסביבות\\s+)${word}(?![${HEB}])`);
      if (re.test(t)) { h = val; break; }
    }
  }

  if (h === null) return { found: false, qualifierPm, qualifierAm };

  // Half / quarter: "10 וחצי", "בעשר ורבע", "רבע לחמש" is not supported (asks instead).
  if (min === 0) {
    if (/וחצי(?![א-ת])/.test(t)) min = 30;
    else if (/ורבע(?![א-ת])/.test(t)) min = 15;
  }
  if (/רבע\s+ל/.test(t)) return { found: true, valid: false };

  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return { found: true, valid: false };

  const explicit24 = h >= 13 || h === 0;
  // "בלילה" with a small hour is after midnight ("2 בלילה" = 02:00, "12 בלילה" = 00:00) - never the afternoon
  const night = /(?<![א-ת])(?:ב|ל)?לילה(?![א-ת])/.test(t);
  return { found: true, valid: true, h, min, explicit24, qualifierPm, qualifierAm, night };
}

/**
 * Resolve a 12h-ambiguous hour using an explicit qualifier or, failing that, the
 * configured calling hours. Returns { h } or { reason }.
 */
function resolveMeridiem(hour, hours) {
  let { h } = hour;
  const { min } = hour;
  if (hour.explicit24) {
    return withinHours(h, min, hours) ? { h } : { reason: 'outside_hours' };
  }
  if (hour.night && (h <= 5 || h === 12)) { if (h === 12) h = 0; }          // before 2026-11-18: "2 בלילה" → 14:00
  else if (hour.qualifierPm && h < 12) h += 12;
  else if (hour.qualifierAm) { /* as written */ }
  else {
    // No qualifier: accept the reading that falls inside calling hours.
    const amOk = withinHours(h, min, hours);
    const pmOk = h < 12 && withinHours(h + 12, min, hours);
    if (amOk && pmOk) {
      // Both readings are callable (e.g. "ב-9" → 09:00 or 21:00). Daytime convention:
      // 8–11 is morning, 1–7 is afternoon/evening; anything else must be clarified.
      if (h >= 8 && h <= 11) { /* morning */ }
      else if (h >= 1 && h <= 7) h += 12;
      else return { reason: 'missing_hour' };
    } else if (!amOk && pmOk) h += 12;
    else if (!amOk && !pmOk) return { reason: 'outside_hours' };
  }
  return withinHours(h, min, hours) ? { h } : { reason: 'outside_hours' };
}

// ── Main resolver ─────────────────────────────────────────────────────────────

// A RANGE of hours ("בין 14:00-16:00", "בין 2 ל-4", "בין שתיים לארבע", "מ-10 עד 12", "14:00–16:00", "מחר 14-16").
// The range is the prospect's availability: its start becomes scheduledAt (reminders are timed from it) and its end is
// kept as windowEndAt. A range is never turned into one appointed hour: when its end cannot be placed after its start,
// or it leaves the calling hours, the prospect is asked — nothing is guessed and nothing valid is refused.
const HOUR_WORD_ALT = HE_HOUR_WORDS.map(([w]) => w).join('|');
// one hour inside a range: "14", "14:00", "14.00", "שתיים", optionally followed by "וחצי" / "ורבע"  (2 groups: token, suffix)
const TOK = `(\\d{1,2}(?:[:.]\\d{2})?|${HOUR_WORD_ALT})(?![${HEB}\\d])(?:\\s*(וחצי|ורבע)(?![${HEB}]))?`;
const DAY_LEAD = '(?:היום|מחר|מחרתיים|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בשעות|בשעה|שעות)';
const WINDOW_RES = [
  new RegExp(`בין\\s*(?:השעות\\s*|השעה\\s*)?${TOK}\\s*(?:-|עד|ו-?|ל-?)\\s*(?:ה?שעה\\s*)?${TOK}`),
  new RegExp(`(?<![\\d:.])(\\d{1,2}:\\d{2})()\\s*(?:-|עד)\\s*(\\d{1,2}:\\d{2})()(?![\\d:.])`),
  new RegExp(`(?<![${HEB}])מ-?\\s*(?:ה?שעה\\s*)?${TOK}\\s*(?:עד|-)\\s*(?:ה?שעה\\s*)?${TOK}`),
  // a bare "14-16" only when it is unmistakably hours: right after a day / "בשעות" …
  new RegExp(`(?<=${DAY_LEAD}\\s+(?:ב-?\\s*)?)(\\d{1,2})()\\s*-\\s*(\\d{1,2})()(?![\\d./:${HEB}])`),
];
// … or written on the 24-hour clock ("14-16", "9-13")
const BARE_24H_RANGE = /(?<![\d./:א-ת-])(\d{1,2})()\s*-\s*(\d{1,2})()(?![\d./:א-ת-])/;

/** One hour token → { h, m, written } or null (a "15.11" is a date, not 15:11). */
function parseHourToken(raw, suffix) {
  const d = /^(\d{1,2})(?:([:.])(\d{2}))?$/.exec(raw);
  let h, m = 0, written = false;
  if (d) {
    h = Number(d[1]);
    if (d[3] !== undefined) {
      m = Number(d[3]); written = true;
      if (d[2] === '.' && ![0, 15, 30, 45].includes(m)) return null;
    }
  } else {
    const w = HE_HOUR_WORDS.find(([word]) => word === raw);
    if (!w) return null;
    h = w[1];
  }
  if (!written && suffix) m = suffix === 'וחצי' ? 30 : 15;
  if (h > 23 || m > 59) return null;
  return { h, m, written };
}
function extractWindow(text) {
  const tryMatch = m => {
    if (!m) return null;
    const a = parseHourToken(m[1], m[2]), b = parseHourToken(m[3], m[4]);
    return a && b ? { match: m[0], startH: a.h, startM: a.m, startExplicit: a.written || a.h >= 13, endH: b.h, endM: b.m } : null;
  };
  for (const re of WINDOW_RES) { const w = tryMatch(re.exec(text)); if (w) return w; }
  const w = tryMatch(BARE_24H_RANGE.exec(text));
  return w && (w.startH >= 13 || w.endH >= 13) && w.startH < w.endH ? w : null;
}

// A CONSTRAINT on availability: "אחרי 16:00" / "עד 12:00", "לפני 12". The prospect gave one side only. It is kept as
// exactly that — `availability: 'after' | 'until'` with the hour that was given — and is never completed into a range
// (the system has no approved calling hours to complete it with) nor treated as an appointed hour. A bare number counts
// only at the end of a clause ("אחרי 2 אימונים" is not an hour).
const OPEN_TAIL = '(?=\\s*(?:$|[,.!?)]|בבוקר|בערב|בלילה|בצהריים|אחה"צ|אחר|אחרי|בדיוק|אם|זה|מתאים|נוח|טוב|בסדר|אפשר|יהיה|בבקשה|תודה))';
const OPEN_HOUR = `(?:ה?שעה\\s*)?-?\\s*(?:(\\d{1,2}[:.]\\d{2})|(\\d{1,2}|${HOUR_WORD_ALT})(?![${HEB}\\d:.])(?:\\s*(וחצי|ורבע)(?![${HEB}]))?${OPEN_TAIL})`;
const OPEN_RES = [
  ['until', new RegExp(`(?<![${HEB}])(?:עד|לפני)\\s*${OPEN_HOUR}`)],
  ['after', new RegExp(`(?<![${HEB}])(?:רק\\s+)?(?:אחרי|החל\\s+מ-?)\\s*${OPEN_HOUR}`)],
];
function extractOpenEnded(text) {
  for (const [kind, re] of OPEN_RES) {
    const m = re.exec(text);
    if (!m) continue;
    const tok = parseHourToken(m[1] ?? m[2], m[3]);
    if (tok) return { kind, match: m[0], ...tok };
  }
  return null;
}

const pad2 = n => String(n).padStart(2, '0');
const hourText = (h, m, written) => (written || h >= 13 || m ? `${pad2(h)}:${pad2(m)}` : String(h));

// A time written in English. The resolver reads Hebrew and numbers; before 2026-11-18 "tomorrow between 14:00 and
// 16:00" was stored as TODAY at 14:00 (the day word was not understood and the first number was taken). Until there
// is a reliable reading, such a message is answered with a request to write the date and time in numbers.
const ENGLISH_TIME = /\b(?:tomorrow|today|tonight|noon|midnight|next\s+week|this\s+(?:morning|afternoon|evening|week)|in\s+the\s+(?:morning|afternoon|evening)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b|\b(?:at|between|after|before|until|till|from|around|by)\s+\d|\bo'?clock\b|\b(?:an?|one|two|\d+)\s+(?:hours?|minutes?)\b/i;
const isEnglishTime = text => ENGLISH_TIME.test(String(text ?? ''));

// "עוד עשר דקות", "בעוד רבע שעה", "עוד 40 דקות", "עוד שלוש שעות" -> minutes from the moment the message was sent.
// A vague offset ("עוד כמה דקות", "עוד מעט") is not a time.
const REL_WORDS = [['חמש עשרה', 15], ['עשרים וחמש', 25], ['שלושים וחמש', 35], ['ארבעים וחמש', 45], ['חמישים', 50], ['ארבעים', 40], ['שלושים', 30], ['עשרים', 20],
  ['שתיים', 2], ['שמונה', 8], ['שלוש', 3], ['ארבע', 4], ['חמש', 5], ['שבע', 7], ['תשע', 9], ['עשר', 10], ['שתי', 2], ['שש', 6]];
function relativeOffsetMin(t) {
  const m0 = String(t ?? '').match(/(?:^|[^א-ת])ב?עוד\s+(.{1,40})/);
  if (!m0) return null;
  const r = m0[1];
  if (/^חצי\s+שעה/.test(r)) return 30;
  if (/^רבע\s+שעה/.test(r)) return 15;
  if (/^שלושת?\s+רבעי\s+שעה/.test(r)) return 45;
  if (/^שעה\s+וחצי/.test(r)) return 90;
  if (/^שעה\s+ורבע/.test(r)) return 75;
  if (/^שעתיים/.test(r)) return 120;
  if (/^שעה(?![א-ת])/.test(r)) return 60;
  let m = r.match(/^(\d{1,3})\s+(דקות|דק(?![א-ת])|שעות)/);
  if (m) return +m[1] * (m[2] === 'שעות' ? 60 : 1);
  for (const [w, n] of REL_WORDS) { m = r.match(new RegExp('^' + w + '\\s+(דקות|שעות)')); if (m) return n * (m[1] === 'שעות' ? 60 : 1); }
  return null;
}

function resolveCallbackTime(rawText, ref = new Date(), opts = {}) {
  const hours = opts.hours ?? callingHours();
  const text = normalize(rawText);
  if (isEnglishTime(text)) return fail('english_time');
  const w = extractWindow(text);
  if (w) {
    // The range is replaced by its START hour and resolved by the ordinary strict rules (so "בין 2 ל-4" becomes the
    // afternoon exactly as "ב-2" would). The end is then placed after the resolved start, on the same day. The end is
    // kept as the prospect gave it: a range is not cut or refused against hours the owner has not defined.
    const res = resolveSingleTime(text.replace(w.match, ` ב-${hourText(w.startH, w.startM, w.startExplicit)} `), ref, opts);
    if (!res.ok) return res;
    const p = ilParts(res.scheduledAt);
    let endH = w.endH;
    while (endH * 60 + w.endM <= p.hour * 60 + p.minute && endH + 12 <= 23) endH += 12;
    if (endH * 60 + w.endM <= p.hour * 60 + p.minute) return fail('range_unclear');
    return { ...res, windowEndAt: ilDate(p.year, p.month, p.day, endH, w.endM) };
  }
  const o = extractOpenEnded(text);
  if (!o) return resolveSingleTime(text, ref, opts);
  // the hour is read by the ordinary rules (day, morning / evening, not in the past); "until" may name the last minute
  // of the window in which a request can be registered
  const single = text.replace(o.match, ` ב-${hourText(o.h, o.m, o.written)} `);
  const res = resolveSingleTime(single, ref, o.kind === 'until' ? { ...opts, hours: { start: hours.start, end: Math.min(hours.end + 1, 24) } } : opts);
  if (!res.ok) return res;
  if (o.kind === 'until') { const e = ilParts(res.scheduledAt); if (e.hour * 60 + e.minute > hours.end * 60) return fail('outside_hours'); }
  return { ...res, availability: o.kind };
}

function resolveSingleTime(rawText, ref = new Date(), opts = {}) {
  const hours = opts.hours ?? callingHours();
  const refDate = ref instanceof Date ? ref : new Date(ref);
  if (isNaN(refDate.getTime())) throw new Error('resolveCallbackTime: invalid reference timestamp');
  const t = normalize(rawText);
  if (!t) return fail('no_time');

  const now = ilParts(refDate);
  const today = { year: now.year, month: now.month, day: now.day };

  // ── "בעוד שעה" / "בעוד 40 דקות" — relative offsets ───────────────────────────
  {
    const offsetMin = relativeOffsetMin(t);
    if (offsetMin !== null) {
      if (offsetMin < 5 || offsetMin > 24 * 60) return fail('invalid_hour');
      const at = new Date(refDate.getTime() + offsetMin * 60000);
      at.setUTCSeconds(0, 0);
      const p = ilParts(at);
      if (!withinHours(p.hour, p.minute, hours)) return fail('outside_hours', { hours });
      // counted from the moment the message was SENT; if it is handled late and the moment has passed, a new time is asked for
      if (opts.now instanceof Date && at.getTime() <= opts.now.getTime()) return fail('past');
      return { ok: true, scheduledAt: at, hasDate: true, relative: true };
    }
  }

  // ── Day component ────────────────────────────────────────────────────────────
  const explicit = extractExplicitDate(t);
  if (explicit.found && !explicit.valid) return fail('invalid_date');
  const restForHour = explicit.found ? explicit.rest : t;

  const weekday   = extractWeekday(restForHour);
  const hasDayAfter = heWord('מחרתיים').test(restForHour);
  const hasTomorrow = !hasDayAfter && heWord('מחר').test(restForHour);
  const hasToday    = heWord('היום').test(restForHour) || /(?<![א-ת])עכשיו(?![א-ת])/.test(restForHour);

  let target = null;          // { year, month, day }
  let dayExplicit = false;    // the prospect named a day in some form

  if (explicit.found) {
    dayExplicit = true;
    let year = explicit.year ?? now.year;
    if (!isValidYmd(year, explicit.month, explicit.day)) {
      // 29.02 without a year: valid only if the coming occurrence exists.
      if (explicit.year === null && isValidYmd(year + 1, explicit.month, explicit.day)) year += 1;
      else return fail('invalid_date');
    }
    target = { year, month: explicit.month, day: explicit.day };
    if (explicit.year === null) {
      const before = Date.UTC(target.year, target.month, target.day) < Date.UTC(today.year, today.month, today.day);
      if (before) {
        // Year rollover (e.g. "3 בינואר" said in December). Only when the next
        // occurrence is near; otherwise the date is simply in the past.
        if (!isValidYmd(year + 1, explicit.month, explicit.day)) return fail('past');
        const next = { year: year + 1, month: explicit.month, day: explicit.day };
        const daysAhead = (Date.UTC(next.year, next.month, next.day) - Date.UTC(today.year, today.month, today.day)) / 86400000;
        if (daysAhead > MAX_DAYS_AHEAD) return fail('past');
        target = next;
      }
    }
    // Weekday named together with an explicit date must agree with it.
    if (weekday !== null && weekdayOf(target) !== weekday) {
      const dd = String(target.day).padStart(2, '0'), mm = String(target.month + 1).padStart(2, '0');
      return fail('weekday_date_conflict', {
        dateLabel: `${dd}.${mm}`,
        weekdayLabel: HE_WEEKDAY_NAMES[weekday],
        actualWeekdayLabel: HE_WEEKDAY_NAMES[weekdayOf(target)],
      });
    }
  } else if (hasDayAfter || hasTomorrow || hasToday) {
    dayExplicit = true;
    target = addDays(today, hasDayAfter ? 2 : hasTomorrow ? 1 : 0);
    if (weekday !== null && weekdayOf(target) !== weekday) {
      const dd = String(target.day).padStart(2, '0'), mm = String(target.month + 1).padStart(2, '0');
      return fail('weekday_date_conflict', {
        dateLabel: `${hasDayAfter ? 'מחרתיים' : hasTomorrow ? 'מחר' : 'היום'} (${dd}.${mm})`,
        weekdayLabel: HE_WEEKDAY_NAMES[weekday],
        actualWeekdayLabel: HE_WEEKDAY_NAMES[weekdayOf(target)],
      });
    }
  } else if (weekday !== null) {
    dayExplicit = true;
    // Next occurrence of that weekday. Same weekday as today → next week
    // (a prospect who means today says "היום").
    const ahead = ((weekday - now.weekday + 7) % 7) || 7;
    target = addDays(today, ahead);
  }

  // ── Hour component ───────────────────────────────────────────────────────────
  const hour = extractHour(restForHour, { dayKnown: dayExplicit });
  if (hour.found && !hour.valid) return fail('invalid_hour');

  if (!hour.found) {
    if (dayExplicit) return fail('missing_hour');
    if (hour.qualifierAm || hour.qualifierPm) return fail('missing_day_ambiguous');
    return fail('no_time');
  }

  const mer = resolveMeridiem(hour, hours);
  if (mer.reason) return fail(mer.reason, { hours });
  const h = mer.h, min = hour.min;

  // ── Hour only, no day: today if still ahead, otherwise tomorrow ──────────────
  if (!target) {
    let cand = ilDate(today.year, today.month, today.day, h, min);
    if (!cand || cand.getTime() <= refDate.getTime()) {
      const tm = addDays(today, 1);
      cand = ilDate(tm.year, tm.month, tm.day, h, min);
    }
    if (!cand) return fail('invalid_hour');
    return { ok: true, scheduledAt: cand, hasDate: false };
  }

  const scheduledAt = ilDate(target.year, target.month, target.day, h, min);
  if (!scheduledAt) return fail('invalid_date');
  if (scheduledAt.getTime() <= refDate.getTime()) return fail('past');
  if (scheduledAt.getTime() - refDate.getTime() > MAX_DAYS_AHEAD * 86400000) return fail('too_far');
  return { ok: true, scheduledAt, hasDate: true };
}

/**
 * True when the text contains any time/day signal at all. Used to decide whether a
 * message in a callback context is an attempted time (→ resolve or clarify) or an
 * unrelated message (→ normal pipeline).
 */
function hasTimeSignal(rawText) {
  const t = normalize(rawText);
  if (!t) return false;
  if (extractExplicitDate(t).found) return true;
  if (extractWeekday(t) !== null) return true;
  if (heWord('מחרתיים').test(t) || heWord('מחר').test(t) || heWord('היום').test(t)) return true;
  if (isEnglishTime(t)) return true;                       // answered with a request to write it in numbers
  if (relativeOffsetMin(t) !== null) return true;
  const hr = extractHour(t);
  return hr.found || !!hr.qualifierAm || !!hr.qualifierPm;
}

/**
 * Day (and optional clock time) named in a text, WITHOUT callback rules (no calling
 * hours, no "must be in the future"). Used for class questions: "מה יש מחר?",
 * "ביום שלישי ב-9". Returns { day:{year,month,day}|null, hour:{h,min,ambiguous}|null,
 * invalid:reason|null }. month is 0-based.
 */
function extractDayAndTime(rawText, ref = new Date()) {
  const refDate = ref instanceof Date ? ref : new Date(ref);
  const t = normalize(rawText);
  const now = ilParts(refDate);
  const today = { year: now.year, month: now.month, day: now.day };
  const explicit = extractExplicitDate(t);
  if (explicit.found && !explicit.valid) return { day: null, hour: null, invalid: 'invalid_date' };
  const rest = explicit.found ? explicit.rest : t;
  let day = null;
  if (explicit.found) {
    let year = explicit.year ?? now.year;
    if (!isValidYmd(year, explicit.month, explicit.day)) return { day: null, hour: null, invalid: 'invalid_date' };
    if (explicit.year === null && Date.UTC(year, explicit.month, explicit.day) < Date.UTC(today.year, today.month, today.day) - 300 * 86400000) year += 1;
    day = { year, month: explicit.month, day: explicit.day };
  } else if (heWord('מחרתיים').test(rest)) day = addDays(today, 2);
  else if (heWord('מחר').test(rest)) day = addDays(today, 1);
  else if (heWord('אתמול').test(rest)) day = addDays(today, -1);
  else if (heWord('היום').test(rest) || heWord('הערב').test(rest) || heWord('הבוקר').test(rest)) day = today;
  else {
    const wd = extractWeekday(rest);
    if (wd !== null) day = addDays(today, (wd - now.weekday + 7) % 7);   // today counts as "this <weekday>"
  }
  const hr = extractHour(rest, { dayKnown: true });
  let hour = null;
  if (hr.found && hr.valid) {
    let h = hr.h;
    const ambiguous = !hr.explicit24 && !hr.qualifierPm && !hr.qualifierAm && h >= 1 && h <= 11;
    if (hr.qualifierPm && h < 12) h += 12;
    hour = { h, min: hr.min, ambiguous };
  }
  return { day, hour, invalid: null };
}

/** YYYY-MM-DD of an instant, or of a {year,month,day} triple, in Israel time. */
function ilDateString(v = new Date()) {
  const p = v instanceof Date ? ilParts(v) : v;
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

module.exports = {
  resolveCallbackTime, hasTimeSignal, formatCallbackTime, extractDayAndTime, ilDateString,
  relativeOffsetMin: t => relativeOffsetMin(normalize(t)),
  ilParts, ilDate, addDays, callingHours, TZ, MAX_DAYS_AHEAD, HE_WEEKDAY_NAMES,
};
