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

/** "יום ראשון, 15.11.2026 בשעה 11:00" — always from a concrete instant, in Israel time. */
function formatCallbackTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const p  = ilParts(d);
  const dd = String(p.day).padStart(2, '0'), mm = String(p.month + 1).padStart(2, '0');
  const hh = String(p.hour).padStart(2, '0'), mi = String(p.minute).padStart(2, '0');
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
  const hrs = ctx.hours ?? callingHours();
  const range = `${String(hrs.start).padStart(2, '0')}:00–${String(hrs.end).padStart(2, '0')}:00`;
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
    case 'outside_hours':
      return `אפשר לתאם שיחה בין השעות ${range} 🙂 איזו שעה מתאימה לך?`;
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
  return { found: true, valid: true, h, min, explicit24, qualifierPm, qualifierAm };
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
  if (hour.qualifierPm && h < 12) h += 12;
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

function resolveCallbackTime(rawText, ref = new Date(), opts = {}) {
  const hours = opts.hours ?? callingHours();
  const refDate = ref instanceof Date ? ref : new Date(ref);
  if (isNaN(refDate.getTime())) throw new Error('resolveCallbackTime: invalid reference timestamp');
  const t = normalize(rawText);
  if (!t) return fail('no_time');

  const now = ilParts(refDate);
  const today = { year: now.year, month: now.month, day: now.day };

  // ── "בעוד שעה" / "בעוד 40 דקות" — relative offsets ───────────────────────────
  {
    let offsetMin = null;
    let m;
    if (/(?:ב)?עוד\s+חצי\s+שעה/.test(t)) offsetMin = 30;
    else if (/(?:ב)?עוד\s+שעה\s+וחצי/.test(t)) offsetMin = 90;
    else if (/(?:ב)?עוד\s+שעתיים/.test(t)) offsetMin = 120;
    else if (/(?:ב)?עוד\s+שעה(?![א-ת])/.test(t)) offsetMin = 60;
    else if ((m = t.match(/(?:ב)?עוד\s+(\d{1,3})\s+דקות/))) offsetMin = +m[1];
    else if ((m = t.match(/(?:ב)?עוד\s+(\d{1,2})\s+שעות/))) offsetMin = +m[1] * 60;
    if (offsetMin !== null) {
      if (offsetMin < 5 || offsetMin > 24 * 60) return fail('invalid_hour');
      const at = new Date(refDate.getTime() + offsetMin * 60000);
      at.setUTCSeconds(0, 0);
      const p = ilParts(at);
      if (!withinHours(p.hour, p.minute, hours)) return fail('outside_hours', { hours });
      return { ok: true, scheduledAt: at, hasDate: true };
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
  if (/(?:ב)?עוד\s+(?:חצי\s+שעה|שעה|שעתיים|\d{1,3}\s+(?:דקות|שעות))/.test(t)) return true;
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
  ilParts, ilDate, addDays, callingHours, TZ, MAX_DAYS_AHEAD, HE_WEEKDAY_NAMES,
};
