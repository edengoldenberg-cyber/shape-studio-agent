'use strict';

/**
 * appointment_worker.js — Background worker for callback reminders.
 *
 * Runs every 15 minutes (Asia/Jerusalem):
 *  • Staff reminder     — open callbacks (pending AND staff-confirmed) starting within the
 *                         reminder window → WhatsApp to staff, once per recipient per time.
 *  • Prospect reminder  — the same callbacks → "עדיין נוח לך?" to the prospect, once per time.
 *
 * Eligibility (enforced by appointment_store):
 *  • only the LATEST open record of a lead — superseded records never remind
 *  • scheduledAt strictly in the future — expired records never remind
 *  • cancelled / completed / no_answer records never remind
 *  • a rescheduled record starts a fresh reminder cycle (its flags were reset)
 *
 * Telephone callbacks are never sent an automated "we missed our call" message: the
 * no-show pass only applies to in-person appointments, which this system does not create.
 *
 * Configuration (Railway Variables):
 *   CALLBACK_PENDING_REMINDER_ENABLED=true   activates pending-callback + prospect reminders
 *   CALLBACK_PENDING_REMINDER_MIN=30         minutes before the call (floor: 20)
 *   CALLBACK_PENDING_REMINDER_PHONES=…       optional lead-phone allowlist (controlled tests)
 */

const cron         = require('node-cron');
const logger       = require('../utils/logger');
const aptStore     = require('../utils/appointment_store');
const { sendStaffReminder, sendNoShowFollowUp, sendProspectReminder } = require('../services/notification.service');
const { formatCallbackTime } = require('../utils/callback_time');
const { isQuietHours } = require('../utils/time');

// Loaded lazily to avoid circular dependency with server.js
let _staffConfig = null;
function getStaffConfig() {
  if (_staffConfig) return _staffConfig;
  try {
    const nodePath = require('path');
    const dataDir  = (process.env.DATA_DIR ?? nodePath.join(__dirname, '../data')).replace(/[/\\]$/, '');
    _staffConfig   = JSON.parse(
      require('fs').readFileSync(nodePath.join(dataDir, 'staff_config.json'), 'utf8')
    );
  } catch { _staffConfig = { staff: [] }; }
  return _staffConfig;
}

function findStaff(staffId) {
  return getStaffConfig().staff?.find(s => s.id === staffId) ?? null;
}

// ── Effective configuration ───────────────────────────────────────────────────

function reminderConfig() {
  const enabled = process.env.CALLBACK_PENDING_REMINDER_ENABLED === 'true';
  const raw     = parseInt(process.env.CALLBACK_PENDING_REMINDER_MIN ?? '30', 10);
  // Floor at 20 min: the worker polls every 15 min, so a smaller window could be missed.
  const minutes = Math.max(Number.isFinite(raw) ? raw : 30, 20);
  const listRaw = (process.env.CALLBACK_PENDING_REMINDER_PHONES ?? '').trim();
  const allowlist = listRaw ? new Set(listRaw.split(',').map(s => s.trim()).filter(Boolean)) : null;
  return { enabled, minutes, windowMs: minutes * 60 * 1000, allowlist };
}

function applyAllowlist(due, allowlist) {
  return allowlist ? due.filter(a => allowlist.has(a.leadPhone)) : due;
}

// ── Staff reminder (shared by confirmed + pending passes) ─────────────────────

async function remindStaffFor(apt, store, eventName, extra = {}) {
  // Re-read: the record may have been cancelled / rescheduled since the list was built.
  const fresh = aptStore.get(apt.id);
  if (!fresh || !aptStore.ACTIVE_STATUSES.has(fresh.status) || fresh.reminderSent) return false;
  if (!(fresh.scheduledAt instanceof Date) || fresh.scheduledAt.getTime() <= Date.now()) return false;
  if (aptStore.isSuperseded(fresh)) return false;

  const lead = store?.getLead?.(fresh.leadPhone);
  const displayName = lead?.meta?.qualData?.confirmedName ?? fresh.leadName ?? lead?.name ?? null;
  const staff   = findStaff(fresh.assignedStaffId);
  const already = new Set(fresh.reminderSentTo ?? []);
  const results = await sendStaffReminder({ ...fresh, leadName: displayName }, staff, { skipPhones: already });

  const newSucceeded = results.filter(r => r.ok && !r.skipped).map(r => r.phone);
  if (newSucceeded.length) {
    aptStore.update(fresh.id, { reminderSentTo: [...new Set([...already, ...newSucceeded])] });
  }
  if (results.length > 0 && results.every(r => r.ok)) {
    aptStore.markReminderSent(fresh.id);
    store?.logEvent(eventName, fresh.leadPhone, { aptId: fresh.id, rawTime: fresh.rawTime, ...extra });
    return true;
  }
  if (results.length === 0) {
    // Zero recipients = configuration failure, not success. Stays due for the next cycle.
    logger.warn('[apt-worker] Staff reminder: no recipients configured — entry stays pending', {
      aptId: fresh.id, leadPhone: fresh.leadPhone,
    });
  } else {
    logger.warn('[apt-worker] Staff reminder: partial/full failure — will retry next cycle', {
      aptId: fresh.id, results: results.map(r => ({ phone: r.phone, ok: r.ok })),
    });
  }
  return false;
}

// ── Staff reminder: staff-confirmed callbacks ─────────────────────────────────

async function runReminderPass(store) {
  const cfg = reminderConfig();
  const due = applyAllowlist(aptStore.getDueForReminder(cfg.windowMs), cfg.allowlist);
  if (!due.length) return { reminders: 0 };
  logger.info('[apt-worker] Reminder pass (staff-confirmed)', { due: due.length, windowMin: cfg.minutes, allowlist: cfg.allowlist ? [...cfg.allowlist] : 'all' });
  let sent = 0;
  for (const apt of due) {
    if (await remindStaffFor(apt, store, 'appointment_reminder_sent')) sent++;
  }
  return { reminders: sent };
}

// ── No-show pass (in-person appointments only — never telephone callbacks) ────

async function runNoShowPass(store) {
  const overdue = aptStore.getOverdue(15 * 60 * 1000);
  if (!overdue.length) return { noShows: 0 };

  logger.info('[apt-worker] No-show pass', { overdue: overdue.length });
  let flagged = 0;
  for (const apt of overdue) {
    const st = store?.getLead(apt.leadPhone)?.status;
    if (st === 'human_owns' || st === 'opted_out') {
      logger.info('[apt-worker] No-show follow-up skipped', { aptId: apt.id, status: st });
      store?.logEvent(`no_show_followup_suppressed_${st}`, apt.leadPhone, { aptId: apt.id });
      continue;
    }
    aptStore.update(apt.id, { status: 'no_show', noShowAlerted: true });
    await sendNoShowFollowUp(apt);
    store?.logEvent('appointment_no_show', apt.leadPhone, { aptId: apt.id, rawTime: apt.rawTime });
    flagged++;
  }
  return { noShows: flagged };
}

// ── Staff reminder: pending (not yet staff-approved) callbacks ────────────────

async function runCallbackPendingReminderPass(store) {
  const cfg = reminderConfig();
  if (!cfg.enabled) return { pendingReminders: 0 };
  const due = applyAllowlist(aptStore.getPendingCallbacksDueForReminder(cfg.windowMs), cfg.allowlist);
  if (!due.length) return { pendingReminders: 0 };
  logger.info('[apt-worker] Callback-pending reminder pass', { due: due.length, windowMin: cfg.minutes, allowlist: cfg.allowlist ? [...cfg.allowlist] : 'all' });
  let attempted = 0;
  for (const apt of due) {
    await remindStaffFor(apt, store, 'callback_pending_reminder_sent', { reminderMinutes: cfg.minutes });
    attempted++;
  }
  return { pendingReminders: attempted };
}

// ── Prospect reminder: pending AND staff-confirmed callbacks ──────────────────

async function runProspectReminderPass(store) {
  const cfg = reminderConfig();
  if (!cfg.enabled) return { prospectReminders: 0 };
  // Quiet hours: no automated message to a prospect. Sending now would only queue the
  // reminder for the 08:30 release — i.e. possibly AFTER the call it is about — so the
  // reminder is simply not sent while quiet hours are in force. Staff are still reminded.
  if (isQuietHours()) return { prospectReminders: 0, skippedQuietHours: true };
  const due = applyAllowlist(aptStore.getCallbacksDueForProspectReminder(cfg.windowMs), cfg.allowlist);
  if (!due.length) return { prospectReminders: 0 };

  logger.info('[apt-worker] Prospect reminder pass', { due: due.length, windowMin: cfg.minutes, allowlist: cfg.allowlist ? [...cfg.allowlist] : 'all' });

  let sent = 0;
  for (const listed of due) {
    const apt = aptStore.get(listed.id);
    if (!apt || !aptStore.ACTIVE_STATUSES.has(apt.status) || apt.prospectReminderSent === true) continue;
    if (!(apt.scheduledAt instanceof Date) || apt.scheduledAt.getTime() <= Date.now()) continue;
    if (aptStore.isSuperseded(apt)) continue;

    // Ownership / opt-out: never send an automated prospect message to a conversation
    // a human owns or to someone who opted out — whatever the appointment state.
    const lead = store?.getLead(apt.leadPhone);
    const st   = lead?.status;
    if (st === 'human_owns' || st === 'opted_out' || st === 'converted_member') {
      logger.info('[apt-worker] Prospect reminder skipped', { aptId: apt.id, leadPhone: apt.leadPhone, status: st });
      store?.logEvent(`prospect_reminder_suppressed_${st}`, apt.leadPhone, { aptId: apt.id });
      continue;
    }
    const fullName      = lead?.meta?.qualData?.confirmedName ?? apt.leadName ?? '';
    const name          = String(fullName).trim().split(/\s+/)[0] || 'שלום';
    const formattedTime = formatCallbackTime(apt.scheduledAt);
    const result        = await sendProspectReminder(apt, name, formattedTime);
    if (result.ok && result.idMessage) {
      aptStore.update(apt.id, {
        prospectReminderSent:   true,
        prospectReminderSentTo: result.idMessage,
        prospectReminderSentAt: new Date().toISOString(),
      });
      store?.logEvent('prospect_reminder_sent', apt.leadPhone, {
        aptId: apt.id, idMessage: result.idMessage, reminderMinutes: cfg.minutes,
      });
      sent++;
    } else {
      logger.warn('[apt-worker] Prospect reminder not accepted — will retry next cycle', {
        aptId: apt.id, leadPhone: apt.leadPhone, error: result.error ?? 'no_provider_id',
      });
    }
  }
  return { prospectReminders: sent };
}

// ── One full cycle (exported so tests drive the real worker logic) ────────────

async function runCycle(store) {
  const r  = await runReminderPass(store);
  const n  = await runNoShowPass(store);
  const p  = await runCallbackPendingReminderPass(store);
  const pr = await runProspectReminderPass(store);
  return { ...r, ...n, ...p, ...pr };
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _registered = false;

function initAppointmentWorker(store) {
  // Every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const out = await runCycle(store);
      if (out.reminders || out.noShows || out.pendingReminders || out.prospectReminders) {
        logger.info('[apt-worker] Cycle complete', out);
      }
    } catch (err) {
      logger.error('[apt-worker] Error', { error: err.message });
    }
  }, { timezone: 'Asia/Jerusalem' });
  _registered = true;

  const cfg = reminderConfig();
  logger.info('Worker[Appointments]: reminder worker scheduled — every 15 min', {
    callbackPendingReminder: cfg.enabled ? `enabled — ${cfg.minutes} min window` : 'disabled (set CALLBACK_PENDING_REMINDER_ENABLED=true to activate)',
    allowlist: cfg.allowlist ? [...cfg.allowlist] : 'all leads',
  });
}

/** Effective worker state, exposed read-only via /api/admin/appointments/worker-status. */
function workerStatus() {
  const cfg = reminderConfig();
  return {
    registered:       _registered,
    schedule:         '*/15 * * * * (Asia/Jerusalem)',
    pendingAndProspectRemindersEnabled: cfg.enabled,
    reminderMinutes:  cfg.minutes,
    leadAllowlist:    cfg.allowlist ? [...cfg.allowlist] : null,
  };
}

module.exports = {
  initAppointmentWorker, runCycle, workerStatus, reminderConfig,
  runReminderPass, runNoShowPass, runCallbackPendingReminderPass, runProspectReminderPass,
};
