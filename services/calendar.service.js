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
      fs.readFileSync(path.join(__dirname, '../data/staff_config.json'), 'utf8')
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
    `DTSTART;TZID=Asia/Jerusalem:${fmt(start)}`,
    `DTEND;TZID=Asia/Jerusalem:${fmt(end)}`,
    `DTSTAMP:${fmt(stamp)}Z`,
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

/**
 * Parse a Hebrew free-text time reference into a JS Date using OpenAI.
 * Returns null when parsing fails or OPENAI_API_KEY is not set.
 * Examples: "מחר בשעה 15:00", "ביום שלישי בשעה 10 בבוקר", "בעוד שעתיים"
 */
async function parseHebrewTime(rawText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !rawText) return null;

  const nowIL = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });

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
  parseHebrewTime,
  createCalendarEntry,
  cancelCalendarEvent,
  notifyAllActiveStaff,
  notifyEden,
};
