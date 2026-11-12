'use strict';

/**
 * notification.service.js — All appointment-related notifications for Shape Studio.
 *
 * WhatsApp alerts are sent to ALL active staff members who have a phone configured
 * (Eden + Melanie + any others). This means every new appointment, reminder, and
 * reschedule lands in every relevant inbox automatically.
 *
 * Email is sent only to the assigned staff member (requires SMTP env vars):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');
const logger     = require('../utils/logger');
const { sendText } = require('./whatsapp.service');

// ── Staff roster loader ───────────────────────────────────────────────────────
// Reads from DATA_DIR (Railway Volume) so the same file edited through the
// production admin panel is used here. Falls back to the app-root data/
// directory when DATA_DIR is not set (local development).

function loadStaffRoster() {
  const dataDir = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'staff_config.json'), 'utf8'));
  } catch { return { staff: [] }; }
}

/**
 * All active staff members who have a phone number configured.
 * Falls back to NOTIFY_PHONES / STUDIO_OWNER_PHONE when staff_config.json
 * has no active entries — keeps broadcastToStaff aligned with alertOwner.
 */
function activeStaffWithPhones() {
  const configured = (loadStaffRoster().staff ?? []).filter(s => s.active && s.phone);
  if (configured.length) return configured;
  // No staff in roster — fall back to env-var phones so reminders reach someone.
  const envRaw = (process.env.NOTIFY_PHONES ?? process.env.STUDIO_OWNER_PHONE ?? '');
  return envRaw.split(',')
    .map((p, i) => ({ id: `env_${i}`, name: 'Staff', phone: p.trim().replace(/^\+/, ''), active: true }))
    .filter(s => s.phone && /^\d{7,15}$/.test(s.phone));
}

// ── Email transporter (lazy — built only when first needed) ───────────────────

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  _transporter = nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: parseInt(process.env.SMTP_PORT ?? '587', 10) === 465,
    auth:   { user, pass },
  });
  return _transporter;
}

async function sendEmail({ to, subject, text, html }) {
  const transport = getTransporter();
  if (!transport || !to) {
    logger.debug('[notify] SMTP not configured — skipping email', { to, subject });
    return false;
  }
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject,
      text: text ?? (html ? require('html-to-text').htmlToText(html) : ''),
      html,
    });
    logger.info('[notify] Email sent', { to, subject });
    return true;
  } catch (err) {
    logger.warn('[notify] Email send failed', { to, error: err.message });
    return false;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function waLink(phone) {
  return `https://wa.me/${phone}`;
}

function formatTime(scheduledAt, rawTime) {
  if (scheduledAt) {
    return scheduledAt.toLocaleString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit',
    });
  }
  return rawTime;
}

/**
 * Send a WhatsApp message to every active staff member who has a phone.
 * Always bypasses quiet hours — outbound alerts to staff must never be queued
 * or trigger the "Got your message" ack that is meant for inbound client messages.
 *
 * Returns an array of per-recipient results:
 *   { staffId, phone, ok: true,  idMessage }   — provider accepted
 *   { staffId, phone, ok: true,  skipped: true } — already accepted (in skipPhones)
 *   { staffId, phone, ok: false, error }         — send failed
 *
 * @param {string} message
 * @param {{ skipPhones?: Set<string> }} [opts]
 */
async function broadcastToStaff(message, { skipPhones = new Set() } = {}) {
  const recipients = activeStaffWithPhones();
  const results = [];
  for (const member of recipients) {
    if (skipPhones.has(member.phone)) {
      results.push({ staffId: member.id, phone: member.phone, ok: true, skipped: true });
      continue;
    }
    try {
      const res = await sendText(member.phone, message, { bypassQuietHours: true });
      results.push({ staffId: member.id, phone: member.phone, ok: true, idMessage: res?.idMessage ?? null });
    } catch (err) {
      logger.warn('[notify] broadcastToStaff failed', { staffId: member.id, error: err.message });
      results.push({ staffId: member.id, phone: member.phone, ok: false, error: err.message });
    }
  }
  return results;
}

// ── Public functions ──────────────────────────────────────────────────────────

/**
 * Notify staff immediately when a callback is confirmed.
 * WhatsApp broadcast → all active staff with phones (Eden + Melanie + others).
 * Email → assigned staff member only (if email is configured).
 */
async function notifyStaffCallbackConfirmed(apt, assignedStaff, icsDownloadUrl) {
  const timeLabel = formatTime(apt.scheduledAt, apt.rawTime);
  const lead      = apt.leadName ?? apt.leadPhone;

  const waMsg = [
    `📞 *שיחת ייעוץ נקבעה!*`,
    ``,
    `👤 לקוח/ה: *${lead}*`,
    `📱 טלפון: ${apt.leadPhone}`,
    `💬 WhatsApp: ${waLink(apt.leadPhone)}`,
    `🕐 זמן: *${timeLabel}*`,
    icsDownloadUrl ? `📅 הוסף ליומן: ${icsDownloadUrl}` : null,
    ``,
    `נקבע אוטומטית על ידי הסוכן 🤖`,
  ].filter(l => l !== null).join('\n');

  // WhatsApp: all active staff (Eden + Melanie + any configured)
  const waResults = await broadcastToStaff(waMsg);
  const sent = waResults.filter(r => r.ok && !r.skipped).length;
  if (!waResults.length && assignedStaff?.phone) {
    // No roster configured — fall back to assigned staff only
    await sendText(assignedStaff.phone, waMsg).catch(err =>
      logger.warn('[notify] Fallback staff WhatsApp failed', { error: err.message })
    );
  }

  // Email: assigned staff only
  if (assignedStaff?.email) {
    const subject = `📞 שיחה עם ${lead} — ${timeLabel}`;
    const html = `
      <h2 style="direction:rtl">שיחת ייעוץ נקבעה</h2>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;direction:rtl">
        <tr><td style="padding:4px 12px;font-weight:bold">לקוח/ה</td><td>${lead}</td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold">טלפון</td><td><a href="tel:${apt.leadPhone}">${apt.leadPhone}</a></td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold">WhatsApp</td><td><a href="${waLink(apt.leadPhone)}">פתח WhatsApp</a></td></tr>
        <tr><td style="padding:4px 12px;font-weight:bold">זמן</td><td>${timeLabel}</td></tr>
        ${icsDownloadUrl ? `<tr><td style="padding:4px 12px;font-weight:bold">יומן</td><td><a href="${icsDownloadUrl}">הוסף ל-Google Calendar / Outlook</a></td></tr>` : ''}
      </table>
    `;
    await sendEmail({ to: assignedStaff.email, subject, html });
  }

  logger.info('[notify] Staff callback notification sent', {
    staffId: apt.assignedStaffId, aptId: apt.id, waRecipients: sent,
  });
}

/**
 * Send a WhatsApp reminder to ALL active staff 15–20 minutes before the call.
 *
 * @param {object} apt
 * @param {object|null} assignedStaff
 * @param {{ skipPhones?: Set<string> }} [opts]  skipPhones = phones already accepted
 * @returns {Array}  per-recipient result array from broadcastToStaff
 */
async function sendStaffReminder(apt, assignedStaff, { skipPhones = new Set() } = {}) {
  const timeLabel = formatTime(apt.scheduledAt, apt.rawTime);
  const lead      = apt.leadName ?? apt.leadPhone;

  const msg = [
    `⏰ *תזכורת: שיחה בעוד 15 דקות!*`,
    ``,
    `👤 ${lead}`,
    `📱 ${apt.leadPhone}`,
    `💬 ${waLink(apt.leadPhone)}`,
    `🕐 ${timeLabel}`,
  ].join('\n');

  const results = await broadcastToStaff(msg, { skipPhones });
  const sent    = results.filter(r => r.ok && !r.skipped).length;
  const failed  = results.filter(r => !r.ok).length;
  if (!results.length && assignedStaff?.phone) {
    // No roster configured — fall back to assigned staff only (not tracked per-recipient)
    await sendText(assignedStaff.phone, msg).catch(err =>
      logger.warn('[notify] Reminder fallback failed', { error: err.message })
    );
  }
  logger.info('[notify] Staff reminder attempted', { aptId: apt.id, sent, failed, skipped: results.filter(r => r.skipped).length });
  return results;
}

/**
 * Send a no-show follow-up to the LEAD asking to reschedule.
 * This goes to the client, not the staff.
 */
async function sendNoShowFollowUp(apt) {
  const name      = (apt.leadName ?? '').split(' ')[0] || 'שלום';
  const timeLabel = formatTime(apt.scheduledAt, apt.rawTime);
  const msg       = `ראיתי שפספסנו את השיחה ב-${timeLabel}. ${name}, באיזו שעה נוספת יהיה לך נוח שנדבר? 😊`;

  if (!apt.leadPhone) return;
  await sendText(apt.leadPhone, msg).catch(err =>
    logger.warn('[notify] No-show follow-up failed', { phone: apt.leadPhone, error: err.message })
  );
  logger.info('[notify] No-show follow-up sent to lead', { aptId: apt.id });
}

/**
 * Send confirmation to the LEAD when a callback is booked.
 */
async function sendLeadConfirmation(apt) {
  const name      = (apt.leadName ?? '').split(' ')[0] || 'שלום';
  const timeLabel = formatTime(apt.scheduledAt, apt.rawTime);
  const msg       = `מעולה ${name}! השיחה נקבעה ל-${timeLabel} ✅\nאנחנו ניצור איתך קשר בזמן. יש עוד משהו שאוכל לעזור? 😊`;

  if (!apt.leadPhone) return;
  await sendText(apt.leadPhone, msg).catch(err =>
    logger.warn('[notify] Lead confirmation failed', { phone: apt.leadPhone, error: err.message })
  );
}

/**
 * Notify ALL active staff that an appointment was rescheduled.
 * Includes the old time and the new time for clarity.
 */
async function notifyStaffRescheduled(apt, assignedStaff, oldTimeLabel) {
  const lead     = apt.leadName ?? apt.leadPhone;
  const newTime  = formatTime(apt.scheduledAt, apt.rawTime);

  const msg = [
    `🔄 *שיחה עברה תיזמון מחדש*`,
    ``,
    `👤 ${lead} | ${apt.leadPhone}`,
    `💬 ${waLink(apt.leadPhone)}`,
    `❌ היה: ${oldTimeLabel}`,
    `🕐 חדש: *${newTime}*`,
  ].join('\n');

  const rsResults = await broadcastToStaff(msg);
  const sent = rsResults.filter(r => r.ok && !r.skipped).length;
  if (!rsResults.length && assignedStaff?.phone) {
    await sendText(assignedStaff.phone, msg).catch(() => {});
  }

  if (assignedStaff?.email) {
    await sendEmail({
      to:      assignedStaff.email,
      subject: `🔄 שיחה עם ${lead} — תיזמון מחדש`,
      text:    msg,
    });
  }

  logger.info('[notify] Staff rescheduled notification sent', {
    aptId: apt.id, waRecipients: sent, oldTime: oldTimeLabel,
  });
}

/**
 * Alert Eden (the owner) directly with a critical/priority message.
 * Falls back silently if Eden has no phone.
 */
async function alertEden(message) {
  const roster = loadStaffRoster();
  const eden   = (roster.staff ?? []).find(s => s.id === 'eden' && s.active && s.phone);
  if (!eden) return false;
  try {
    await sendText(eden.phone, message);
    return true;
  } catch (err) {
    logger.warn('[notify] alertEden failed', { error: err.message });
    return false;
  }
}

/**
 * Immediate alert to ALL active staff when a client asks for a human representative.
 * Fires as soon as the intent is detected — before the appointment is booked —
 * so the team knows someone needs personal attention right now.
 */
async function notifyRepresentativeRequest(leadPhone, leadName) {
  const displayPhone = String(leadPhone).startsWith('972')
    ? '0' + String(leadPhone).slice(3)
    : leadPhone;

  const msg = [
    `🙋 *נציג התבקש!*`,
    ``,
    `👤 ${leadName ?? 'לקוח/ה לא מזוהה'}`,
    `📱 ${displayPhone}`,
    `💬 WhatsApp: ${waLink(leadPhone)}`,
    ``,
    `הלקוח/ה מבקש/ת לדבר עם נציג — הבוט ביקש/ה זמן מועדף לשיחה.`,
    `בקרוב תקבלו הודעה עם השעה המועדפת.`,
  ].join('\n');

  const rrResults = await broadcastToStaff(msg);
  const rrSent = rrResults.filter(r => r.ok && !r.skipped).length;
  logger.info('[notify] Representative request alert sent', { leadPhone, waRecipients: rrSent });
}

/**
 * Send the daily end-of-day summary report via WhatsApp to all active staff.
 * Called by the 20:00 cron worker in scheduler.js.
 */
async function sendDailySummaryToAdmins(summaryText) {
  const dsResults = await broadcastToStaff(summaryText);
  const dsSent = dsResults.filter(r => r.ok && !r.skipped).length;
  logger.info('[notify] Daily summary sent', { waRecipients: dsSent });
  return dsSent;
}

module.exports = {
  notifyStaffCallbackConfirmed,
  sendStaffReminder,
  sendNoShowFollowUp,
  sendLeadConfirmation,
  notifyStaffRescheduled,
  alertEden,
  notifyRepresentativeRequest,
  sendDailySummaryToAdmins,
};
