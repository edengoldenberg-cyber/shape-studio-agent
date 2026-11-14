'use strict';

/**
 * calendar.service.js — Calendar integration + multi-staff alerts for Shape Studio.
 *
 * Responsibilities:
 *   1. ICS generation (served at /api/calendar/appointment/:id.ics — always works)
 *   2. Google Calendar event creation/cancellation via REST API (optional env vars)
 *   3. Hebrew free-text time parsing via OpenAI
 *   4. Staff alert broadcast — notifies all active staff with phones (Eden + Melanie + any others)
 *
 * Env vars (all optional — ICS always works without them):
 *   GOOGLE_CALENDAR_ID            — target calendar ID (e.g. primary)
 *   GOOGLE_SERVICE_ACCOUNT_KEY    — full JSON of the service account key (base64 or raw JSON)
 *   BACKEND_URL                   — base URL for ICS download links
 *   OPENAI_API_KEY                — required for Hebrew time parsing
 *   WHATSAPP_ACCESS_TOKEN         — required for WhatsApp staff alerts
 *   WHATSAPP_PHONE_NUMBER_ID      — required for WhatsApp staff alerts
 */

const axios  = require('axios');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

// ── Staff config (re-read from disk each call so hot-reloads are reflected) ──

function loadStaffConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(process.env.STAFF_CONFIG_PATH ?? path.join(__dirname, '../data/staff_config.json'), 'utf8')
    );
  } catch {
    return { staff: [], default_assignee_id: null };
  }
}

/** Returns all active staff members who have a phone number configured. */
function activeStaffWithPhones() {
  const cfg = loadStaffConfig();
  return (cfg.staff ?? []).filter(s => s.active && s.phone);
}

// ── ICS generation ─────────────────────────────────────────────────────────────

/**
 * Build an RFC 5545-compliant ICS string for an appointment.
 * @param {object} apt   - appointment record from AppointmentStore
 * @param {object} staff - staff record from staff_config.json
 * @returns {string|null} ICS content, or null if scheduledAt is missing
 */
function buildICS(apt, staff) {
  if (!apt.scheduledAt) return null;

  const start = apt.scheduledAt;
  const end   = new Date(start.getTime() + (apt.durationMin || 30) * 60_000);
  const stamp = new Date();

  // fmt produces RFC 5545 UTC format: "20261107T130000Z"
  // toISOString() already appends Z so we never add TZID — mixing TZID with
  // a Z suffix is an RFC 5545 violation that iOS rejects and other clients
  // interpret inconsistently. Pure UTC (Z) is accepted by every client.
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const summary = `שיחת ייעוץ — ${apt.leadName ?? apt.leadPhone}`;
  const desc    = [
    `לקוח/ה: ${apt.leadName ?? '—'}`,
    `טלפון: ${apt.leadPhone}`,
    `WhatsApp: https://wa.me/${apt.leadPhone}`,
    `נציג: ${staff?.name_he ?? staff?.name_en ?? apt.assignedStaffId}`,
    `נקבע ב: ${apt.createdAt.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`,
  ].join('\\n');

  const organizerEmail = staff?.email || `studio@shapestudio.local`;
  const organizerName  = staff?.name_en ?? staff?.name_he ?? 'Shape Studio';

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Shape Studio Agent//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `DTSTART:${fmt(start)}`,           // UTC — toISOString() already has Z
    `DTEND:${fmt(end)}`,               // UTC — no TZID to avoid Z+TZID conflict
    `DTSTAMP:${fmt(stamp)}`,           // fmt already includes Z; no extra Z needed
    `UID:${apt.id}@shape-studio-agent`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${desc}`,
    `ORGANIZER;CN=${organizerName}:mailto:${organizerEmail}`,
    `STATUS:CONFIRMED`,
    `SEQUENCE:0`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// ── Google Calendar via service account (optional) ────────────────────────────

function getGoogleConfig() {
  const calId  = process.env.GOOGLE_CALENDAR_ID;
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!calId || !keyRaw) return null;
  try {
    const key = JSON.parse(
      Buffer.isBuffer(keyRaw) ? keyRaw.toString('utf8')
        : (keyRaw.trim().startsWith('{') ? keyRaw : Buffer.from(keyRaw, 'base64').toString('utf8'))
    );
    return { calId, key };
  } catch (err) {
    logger.warn('[calendar] GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON:', err.message);
    return null;
  }
}

/** Create a JWT access token for the Google service account using only axios + crypto. */
async function getGoogleAccessToken(key) {
  const { createSign } = require('crypto');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;

  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   key.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud:   'https://oauth2.googleapis.com/token',
    iat, exp,
  })).toString('base64url');

  const sigInput  = `${header}.${payload}`;
  const sign      = createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(key.private_key, 'base64url');
  const jwt       = `${sigInput}.${signature}`;

  const { data } = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:  jwt,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  return data.access_token;
}

/** Create a Google Calendar event. Returns the event ID or null on failure. */
async function createGoogleCalendarEvent(apt, staff) {
  const cfg = getGoogleConfig();
  if (!cfg || !apt.scheduledAt) return null;

  try {
    const token = await getGoogleAccessToken(cfg.key);
    const start = apt.scheduledAt.toISOString();
    const end   = new Date(apt.scheduledAt.getTime() + (apt.durationMin || 30) * 60_000).toISOString();

    const event = {
      summary:     `שיחת ייעוץ — ${apt.leadName ?? apt.leadPhone}`,
      description: `לקוח: ${apt.leadName ?? '—'}\nטלפון: ${apt.leadPhone}\nWhatsApp: https://wa.me/${apt.leadPhone}`,
      start:       { dateTime: start, timeZone: 'Asia/Jerusalem' },
      end:         { dateTime: end,   timeZone: 'Asia/Jerusalem' },
      attendees:   staff?.email ? [{ email: staff.email }] : [],
      reminders:   { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    };

    const { data } = await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calId)}/events`,
      event,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    logger.info('[calendar] Google Calendar event created', { eventId: data.id, aptId: apt.id });
    return data.id;
  } catch (err) {
    logger.warn('[calendar] Google Calendar create failed — ICS only', { error: err.message });
    return null;
  }
}

/** Update a Google Calendar event (e.g. set status to 'cancelled'). */
async function updateGoogleCalendarEvent(eventId, patch) {
  const cfg = getGoogleConfig();
  if (!cfg || !eventId) return false;
  try {
    const token = await getGoogleAccessToken(cfg.key);
    await axios.patch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calId)}/events/${eventId}`,
      patch,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return true;
  } catch (err) {
    logger.warn('[calendar] Google Calendar update failed', { error: err.message });
    return false;
  }
}

// ── Hebrew time parser ────────────────────────────────────────────────────────

// ── Hebrew day names (Sunday=0 .. Saturday=6, Israeli week) ──────────────────
const HE_WEEKDAY = {
  ראשון: 0, יום_ראשון: 0,
  שני:   1, יום_שני:   1,
  שלישי: 2, יום_שלישי: 2,
  רביעי: 3, יום_רביעי: 3,
  חמישי: 4, יום_חמישי: 4,
  שישי:  5, יום_שישי:  5,
  שבת:   6,
};

// ── Hebrew month names → 0-based index ───────────────────────────────────────
const HE_MONTH = {
  ינואר: 0, פברואר: 1, מרץ: 2, מארס: 2, אפריל: 3, מאי: 4, יוני: 5,
  יולי: 6, אוגוסט: 7, ספטמבר: 8, אוקטובר: 9, נובמבר: 10, דצמבר: 11,
};

/**
 * Deterministic local resolver for common Israeli Hebrew time references.
 * Resolves relative to `ref` in Asia/Jerusalem (defaults to now).
 *
 * Supported patterns (in priority order):
 *   1. Explicit calendar date: "15 בנובמבר בשעה 10", "15.11.2026 בשעה 10:00"
 *   2. "מחר", "היום"
 *   3. Hebrew day name ("ראשון", "חמישי", etc.)
 *   4. Bare "בשעה N" / "שעה N" (no day reference)
 *
 * Returns a Date on success, or null when the pattern is unrecognised.
 * Returns null for invalid calendar dates (e.g. Feb 30) rather than guessing.
 * Does NOT fall through to bare-hour for explicit-date patterns that fail to parse.
 */
function parseHebrewTimeLocal(rawText, ref = new Date()) {
  if (!rawText) return null;
  const t = rawText.toLowerCase().trim();

  // Reference time components in Asia/Jerusalem
  const refStr  = ref.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false });
  // "11/12/2026, 06:41" → extract fields
  const dateMatch = refStr.match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2})/);
  if (!dateMatch) return null;
  const [, mm, dd, yyyy, hh, mi] = dateMatch;
  const refYear  = parseInt(yyyy), refMonth = parseInt(mm) - 1, refDay = parseInt(dd);
  const refHour  = parseInt(hh);

  // Helper: build a Date at a specific calendar day + hour in IL tz
  function ilDate(year, month, day, hour = 12, minute = 0) {
    // 'month' is 0-based
    const s = `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00`;
    const probe = new Date(s + '+00:00');
    const ilOffset = (() => {
      const ilStr = probe.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const m = ilStr.match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2})/);
      if (!m) return 0;
      const utcH = probe.getUTCHours(), ilH = parseInt(m[4]);
      let diff = ilH - utcH; if (diff < -12) diff += 24; if (diff > 12) diff -= 24;
      return diff;
    })();
    return new Date(s + (ilOffset >= 0 ? `+0${ilOffset}:00` : `-0${Math.abs(ilOffset)}:00`));
  }

  // Validate that a calendar date actually exists (rejects Feb 30, Apr 31, etc.)
  function isValidDate(year, month0, day) {
    const d = new Date(Date.UTC(year, month0, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month0 && d.getUTCDate() === day;
  }

  // Extract hour from text, e.g. "בשעה 12", "שעה 15:30", "ב-9", "ב9"
  function extractHour(text) {
    const m = text.match(/(?:ב[-–]?|שעה\s+|בשעה\s*)(\d{1,2})(?::(\d{2}))?/);
    if (!m) return null;
    return { h: parseInt(m[1]), min: m[2] ? parseInt(m[2]) : 0 };
  }

  // ── 1. Explicit calendar date ─────────────────────────────────────────────
  //
  // Pattern A: "15 בנובמבר" / "15 בנובמבר 2027" (Hebrew month name)
  // Pattern B: "15.11.2026" / "15/11/2026" / "15-11-2026" (numeric DD.MM.YYYY)
  //
  // When an explicit date is detected, we NEVER fall through to the bare-hour
  // branch — if the date is invalid we return null so the caller can fall back
  // to the async OpenAI parser rather than silently scheduling on the wrong day.

  // Pattern A: DD בMMM [YYYY]
  for (const [monthName, monthIdx] of Object.entries(HE_MONTH)) {
    const reName = new RegExp(`(\\d{1,2})\\s+ב${monthName}(?:\\s+(\\d{4}))?`);
    const mA = t.match(reName);
    if (mA) {
      const dayNum = parseInt(mA[1]);
      let year = mA[2] ? parseInt(mA[2]) : refYear;
      // Year rollover: if the specified month/day is in the past this year, use next year
      if (!mA[2]) {
        const testDate = ilDate(year, monthIdx, dayNum, 12, 0);
        const refMidnight = ilDate(refYear, refMonth, refDay, 0, 0);
        if (testDate < refMidnight) year += 1;
      }
      if (!isValidDate(year, monthIdx, dayNum)) return null; // e.g. Feb 30
      const hour = extractHour(t);
      const h = hour?.h ?? 12, min = hour?.min ?? 0;
      return ilDate(year, monthIdx, dayNum, h, min);
    }
  }

  // Pattern B: DD.MM.YYYY or DD/MM/YYYY or DD-MM-YYYY (with explicit 4-digit year)
  const mB = t.match(/(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})/);
  if (mB) {
    const dayNum = parseInt(mB[1]), monIdx = parseInt(mB[2]) - 1, year = parseInt(mB[3]);
    if (!isValidDate(year, monIdx, dayNum)) return null;
    const hour = extractHour(t);
    const h = hour?.h ?? 12, min = hour?.min ?? 0;
    return ilDate(year, monIdx, dayNum, h, min);
  }

  // Pattern B2: DD.MM without year (e.g. "15.11 בשעה 10")
  // Only matches when the second field is a valid month (01-12) and not year-like (not 4 digits).
  const mB2 = t.match(/^(\d{1,2})[./](\d{1,2})(?:\s|$|[^./\-\d])/);
  if (mB2) {
    const dayNum = parseInt(mB2[1]), monIdx = parseInt(mB2[2]) - 1;
    if (monIdx >= 0 && monIdx <= 11) {
      let year = refYear;
      if (!isValidDate(year, monIdx, dayNum)) return null;
      const testDate = ilDate(year, monIdx, dayNum, 12, 0);
      const refMidnight = ilDate(refYear, refMonth, refDay, 0, 0);
      if (testDate < refMidnight) year += 1;
      if (!isValidDate(year, monIdx, dayNum)) return null;
      const hour = extractHour(t);
      const h = hour?.h ?? 12, min = hour?.min ?? 0;
      return ilDate(year, monIdx, dayNum, h, min);
    }
  }

  // ── 2. Relative day references ────────────────────────────────────────────

  // "מחר" or "למחר" (tomorrow)
  if (/מחר/.test(t) && !/מחרתיים/.test(t)) {
    const hour = extractHour(t);
    const h = hour?.h ?? 12, min = hour?.min ?? 0;
    return ilDate(refYear, refMonth, refDay + 1, h, min);
  }
  // "היום" or "להיום" (today)
  if (/היום/.test(t)) {
    const hour = extractHour(t);
    const h = hour?.h ?? refHour + 1, min = hour?.min ?? 0;
    return ilDate(refYear, refMonth, refDay, h, min);
  }

  // ── 3. Hebrew day name ────────────────────────────────────────────────────
  for (const [name, weekday] of Object.entries(HE_WEEKDAY)) {
    if (t.includes(name)) {
      const refWeekday = new Date(ilDate(refYear, refMonth, refDay, 12)).getDay();
      let daysAhead = (weekday - refWeekday + 7) % 7 || 7; // always future
      const hour = extractHour(t);
      const h = hour?.h ?? 12, min = hour?.min ?? 0;
      return ilDate(refYear, refMonth, refDay + daysAhead, h, min);
    }
  }

  // ── 4. Bare "בשעה N" / "שעה N" (no other day reference) ──────────────────
  if (/(?:בשעה|שעה)\s+\d/.test(t) && !/ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|מחר|היום/.test(t)) {
    const hour = extractHour(t);
    if (hour) {
      let d = ilDate(refYear, refMonth, refDay, hour.h, hour.min);
      if (d <= ref) d = ilDate(refYear, refMonth, refDay + 1, hour.h, hour.min); // next day if past
      return d;
    }
  }

  return null;
}

/**
 * Parse a Hebrew free-text time reference into a JS Date.
 * Primary: local deterministic resolver (no network required, synchronous-like).
 * Fallback: OpenAI gpt-4o-mini (requires OPENAI_API_KEY; async).
 *
 * @param {string}    rawText       - Hebrew time text, e.g. "מחר בשעה 12"
 * @param {Date|null} referenceTime - anchor for relative dates. MUST be the original
 *   inbound message timestamp (stored in meta.callTimeGivenAt), not processing time.
 *   "מחר" on a message sent Nov-12 at 06:41 IL → Nov-13 at 12:00 IL.
 */
async function parseHebrewTime(rawText, referenceTime = null) {
  if (!rawText) return null;
  const ref = (referenceTime instanceof Date && !isNaN(referenceTime)) ? referenceTime : new Date();

  // Try local resolver first — no network, deterministic, testable
  const local = parseHebrewTimeLocal(rawText, ref);
  if (local) return local;

  // Fall back to OpenAI for complex expressions ("בעוד שעתיים", "בין 10 ל-11")
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const nowIL = ref.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content:
            `Parse this Hebrew time/date reference into ISO 8601.\n` +
            `Reference: "${rawText}"\n` +
            `Current Israel time: ${nowIL}\n\n` +
            `Respond with ONLY valid JSON: { "iso": "2026-11-07T15:00:00+02:00" }\n` +
            `If you cannot determine the time, respond: { "iso": null }`,
        }],
        temperature: 0,
        max_tokens:  60,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );

    const content = data.choices[0].message.content.trim();
    const parsed  = JSON.parse(content.match(/\{.*\}/s)?.[0] ?? 'null');
    if (!parsed?.iso) return null;
    const d = new Date(parsed.iso);
    return isNaN(d.getTime()) ? null : d;
  } catch (err) {
    logger.warn('[calendar] parseHebrewTime failed', { error: err.message });
    return null;
  }
}

// ── Main calendar entry point ─────────────────────────────────────────────────

/**
 * Create full calendar entry for an appointment:
 *  1. Parse the raw Hebrew time text → scheduledAt
 *  2. Build ICS content
 *  3. Optionally create Google Calendar event
 *  4. Return { scheduledAt, icsContent, googleEventId }
 */
async function createCalendarEntry(apt, staff) {
  const scheduledAt  = await parseHebrewTime(apt.rawTime);
  const aptWithTime  = { ...apt, scheduledAt };
  const icsContent   = scheduledAt ? buildICS(aptWithTime, staff) : null;
  const googleEventId = scheduledAt
    ? await createGoogleCalendarEvent(aptWithTime, staff)
    : null;

  return { scheduledAt, icsContent, googleEventId };
}

/** Cancel a Google Calendar event when an appointment is no-show or rescheduled. */
async function cancelCalendarEvent(appointment) {
  if (!appointment.calendarEventId) return false;
  return updateGoogleCalendarEvent(appointment.calendarEventId, { status: 'cancelled' });
}

// ── Multi-staff alert broadcast ───────────────────────────────────────────────

/**
 * Send a WhatsApp alert to ALL active staff members who have a phone configured.
 * Covers Eden and Melanie (and any other active staff) automatically.
 *
 * @param {object}      apt    - appointment record (may include scheduledAt)
 * @param {string|null} icsUrl - ICS download URL to include in the message, or null
 * @param {'confirmed'|'rescheduled'|'no_show'} event - what triggered the alert
 * @param {string|null} oldTimeLabel - for reschedule events, the previous time text
 */
async function notifyAllActiveStaff(apt, icsUrl, event = 'confirmed', oldTimeLabel = null) {
  const recipients = activeStaffWithPhones();
  if (!recipients.length) {
    logger.debug('[calendar] notifyAllActiveStaff: no active staff with phones configured');
    return { notified: 0, total: 0 };
  }

  const lead      = apt.leadName ?? apt.leadPhone;
  const timeLabel = apt.scheduledAt
    ? apt.scheduledAt.toLocaleString('he-IL', {
        timeZone: 'Asia/Jerusalem',
        weekday:  'long', day:    'numeric',
        month:    'long', hour:   '2-digit', minute: '2-digit',
      })
    : apt.rawTime;

  const header =
    event === 'rescheduled' ? '🔄 *שיחה עברה תיזמון מחדש*' :
    event === 'no_show'     ? '❌ *לקוח לא הגיע לשיחה*' :
                              '📞 *שיחת ייעוץ נקבעה!*';

  const lines = [
    header,
    ``,
    `👤 לקוח/ה: *${lead}*`,
    `📱 טלפון: ${apt.leadPhone}`,
    `💬 WhatsApp: https://wa.me/${apt.leadPhone}`,
    event === 'rescheduled' && oldTimeLabel ? `❌ היה: ${oldTimeLabel}` : null,
    `🕐 ${event === 'rescheduled' ? 'חדש' : 'זמן'}: *${timeLabel}*`,
    icsUrl ? `📅 הוסף ליומן: ${icsUrl}` : null,
    ``,
    `נקבע אוטומטית על ידי הסוכן 🤖`,
  ].filter(l => l !== null).join('\n');

  // Lazy-require to avoid circular dep at module load time
  const { sendText } = require('./whatsapp.service');

  let notified = 0;
  for (const member of recipients) {
    try {
      await sendText(member.phone, lines);
      logger.info('[calendar] Staff alert sent', { staffId: member.id, event });
      notified++;
    } catch (err) {
      logger.warn('[calendar] Staff alert failed', { staffId: member.id, phone: member.phone, error: err.message });
    }
  }

  logger.info('[calendar] notifyAllActiveStaff complete', { notified, total: recipients.length, event });
  return { notified, total: recipients.length };
}

/**
 * Convenience: alert Eden (the default owner) only — for high-priority or critical events.
 * Falls back silently if Eden has no phone configured.
 */
async function notifyEden(apt, icsUrl, event = 'confirmed', oldTimeLabel = null) {
  const cfg   = loadStaffConfig();
  const eden  = (cfg.staff ?? []).find(s => s.id === 'eden' && s.active && s.phone);
  if (!eden) {
    logger.debug('[calendar] notifyEden: Eden not configured or no phone');
    return { notified: 0 };
  }

  const lead      = apt.leadName ?? apt.leadPhone;
  const timeLabel = apt.scheduledAt
    ? apt.scheduledAt.toLocaleString('he-IL', {
        timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric',
        month: 'long', hour: '2-digit', minute: '2-digit',
      })
    : apt.rawTime;

  const lines = [
    event === 'rescheduled' ? '🔄 *שיחה עברה תיזמון מחדש*' : '📞 *שיחת ייעוץ נקבעה!*',
    ``,
    `👤 *${lead}* | ${apt.leadPhone}`,
    event === 'rescheduled' && oldTimeLabel ? `❌ היה: ${oldTimeLabel}` : null,
    `🕐 ${event === 'rescheduled' ? 'חדש' : 'זמן'}: *${timeLabel}*`,
    icsUrl ? `📅 ${icsUrl}` : null,
  ].filter(l => l !== null).join('\n');

  const { sendText } = require('./whatsapp.service');
  try {
    await sendText(eden.phone, lines);
    return { notified: 1 };
  } catch (err) {
    logger.warn('[calendar] notifyEden failed', { error: err.message });
    return { notified: 0 };
  }
}

module.exports = {
  buildICS,
  parseHebrewTimeLocal,
  parseHebrewTime,
  createCalendarEntry,
  cancelCalendarEvent,
  notifyAllActiveStaff,
  notifyEden,
};
