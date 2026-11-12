'use strict';

/**
 * appointment_worker.js — Background worker for appointment reminders & no-show detection.
 *
 * Runs every 15 minutes:
 *  • Reminder pass: finds appointments starting in the next 20 min → sends WhatsApp to staff
 *  • No-show pass: finds confirmed appointments 15+ min overdue → sends follow-up to lead,
 *    updates status to 'no_show'
 */

const cron         = require('node-cron');
const logger       = require('../utils/logger');
const aptStore     = require('../utils/appointment_store');
const { sendStaffReminder, sendNoShowFollowUp } = require('../services/notification.service');

// Loaded lazily to avoid circular dependency with server.js
let _staffConfig = null;
function getStaffConfig() {
  if (_staffConfig) return _staffConfig;
  try {
    const nodePath = require('path');
    // Respects DATA_DIR so production (Railway Volume) and local share the same path.
    const dataDir  = (process.env.DATA_DIR ?? nodePath.join(__dirname, '../data')).replace(/\/$/, '');
    _staffConfig   = JSON.parse(
      require('fs').readFileSync(nodePath.join(dataDir, 'staff_config.json'), 'utf8')
    );
  } catch { _staffConfig = { staff: [] }; }
  return _staffConfig;
}

function findStaff(staffId) {
  return getStaffConfig().staff?.find(s => s.id === staffId) ?? null;
}

// ── Reminder pass ─────────────────────────────────────────────────────────────

async function runReminderPass(store) {
  const due = aptStore.getDueForReminder(20 * 60 * 1000); // 20-min window
  if (!due.length) return { reminders: 0 };

  logger.info('[apt-worker] Reminder pass', { due: due.length });
  let sent = 0;
  for (const apt of due) {
    const staff = findStaff(apt.assignedStaffId);
    await sendStaffReminder(apt, staff);
    aptStore.markReminderSent(apt.id);
    store?.logEvent('appointment_reminder_sent', apt.leadPhone, { aptId: apt.id });
    sent++;
  }
  return { reminders: sent };
}

// ── No-show pass ──────────────────────────────────────────────────────────────

async function runNoShowPass(store) {
  const overdue = aptStore.getOverdue(15 * 60 * 1000); // 15-min buffer
  if (!overdue.length) return { noShows: 0 };

  logger.info('[apt-worker] No-show pass', { overdue: overdue.length });
  let flagged = 0;
  for (const apt of overdue) {
    // Mark as no_show and alert the lead
    aptStore.update(apt.id, { status: 'no_show', noShowAlerted: true });
    await sendNoShowFollowUp(apt);
    store?.logEvent('appointment_no_show', apt.leadPhone, { aptId: apt.id, rawTime: apt.rawTime });
    // Set lead meta back to awaitingCallbackTime so the NEXT reply is treated as a new time
    store?.upsertLead(apt.leadPhone, {
      meta: {
        ...(store.getLead(apt.leadPhone)?.meta ?? {}),
        awaitingCallbackTime: true,
        callbackRequestedAt:  new Date().toISOString(),
        noShowAptId:          apt.id,
      },
    });
    flagged++;
  }
  return { noShows: flagged };
}

// ── Callback-pending reminder pass ────────────────────────────────────────────
//
// Staff-only reminder for AI-detected callbacks (callback_pending status).
// Unlike the confirmed reminder, this never contacts the prospect.
//
// ACTIVATION:
//   Set CALLBACK_PENDING_REMINDER_ENABLED=true in Railway Variables to activate.
//   Default: disabled. The timing window is CALLBACK_PENDING_REMINDER_MIN (default 30).
//   Remind staff N minutes before the requested callback time so they're not caught
//   off-guard. Must be > 15 min to avoid missing the reminder due to the 15-min poll.
//
// Deduplication: reminderSent flag on the aptStore entry (same as confirmed reminder).
// A restart will not re-send if reminderSent is already true.

async function runCallbackPendingReminderPass(store) {
  if (process.env.CALLBACK_PENDING_REMINDER_ENABLED !== 'true') return { pendingReminders: 0 };

  const reminderMinutes = parseInt(process.env.CALLBACK_PENDING_REMINDER_MIN ?? '30', 10);
  const windowMs        = Math.max(reminderMinutes, 20) * 60 * 1000; // floor at 20 min

  // Per-phone allowlist: when CALLBACK_PENDING_REMINDER_PHONES is set (comma-separated)
  // only remind entries whose leadPhone is in the list. Used for controlled tests.
  // When the var is absent or empty, all due entries are reminded.
  const _allowlistRaw = (process.env.CALLBACK_PENDING_REMINDER_PHONES ?? '').trim();
  const _allowlist    = _allowlistRaw ? new Set(_allowlistRaw.split(',').map(s => s.trim()).filter(Boolean)) : null;

  let due = aptStore.getPendingCallbacksDueForReminder(windowMs);
  if (_allowlist) due = due.filter(a => _allowlist.has(a.leadPhone));
  if (!due.length) return { pendingReminders: 0 };

  logger.info('[apt-worker] Callback-pending reminder pass', { due: due.length, windowMin: reminderMinutes, allowlist: _allowlist ? [..._allowlist] : 'all' });

  const { sendStaffReminder } = require('../services/notification.service');
  let attempted = 0;
  for (const apt of due) {
    const staff = findStaff(apt.assignedStaffId);

    // Build the set of phones that have already confirmed receipt so we never resend.
    const alreadyAccepted = new Set(apt.reminderSentTo ?? []);

    // Send to remaining recipients (broadcastToStaff skips phones in alreadyAccepted).
    const results = await sendStaffReminder(apt, staff, { skipPhones: alreadyAccepted });

    // Record newly-succeeded phones.
    const newSucceeded = results.filter(r => r.ok && !r.skipped).map(r => r.phone);
    if (newSucceeded.length) {
      const updatedSentTo = [...alreadyAccepted, ...newSucceeded];
      aptStore.update(apt.id, { reminderSentTo: updatedSentTo });
    }

    // Mark complete only when every current active recipient is covered (sent or skipped-ok).
    // If any recipient failed, the entry stays in the next cycle's due list for retry.
    const allCovered = results.length > 0 && results.every(r => r.ok);
    if (allCovered) {
      aptStore.markReminderSent(apt.id);
      store?.logEvent('callback_pending_reminder_sent', apt.leadPhone, {
        aptId:          apt.id,
        rawTime:        apt.rawTime,
        reminderMinutes,
      });
    } else {
      const failedCount = results.filter(r => !r.ok).length;
      logger.warn('[apt-worker] Callback-pending reminder: partial/full failure — will retry next cycle', {
        aptId: apt.id, failedCount, results: results.map(r => ({ phone: r.phone, ok: r.ok })),
      });
    }

    attempted++;
  }
  return { pendingReminders: attempted };
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initAppointmentWorker(store) {
  // Every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const r = await runReminderPass(store);
      const n = await runNoShowPass(store);
      const p = await runCallbackPendingReminderPass(store);
      if (r.reminders || n.noShows || p.pendingReminders) {
        logger.info('[apt-worker] Cycle complete', { ...r, ...n, ...p });
      }
    } catch (err) {
      logger.error('[apt-worker] Error', { error: err.message });
    }
  }, { timezone: 'Asia/Jerusalem' });

  const reminderStatus = process.env.CALLBACK_PENDING_REMINDER_ENABLED === 'true'
    ? `enabled — ${process.env.CALLBACK_PENDING_REMINDER_MIN ?? '30'} min window`
    : 'disabled (set CALLBACK_PENDING_REMINDER_ENABLED=true to activate)';
  logger.info('Worker[Appointments]: reminder + no-show worker scheduled — every 15 min', {
    callbackPendingReminder: reminderStatus,
  });
}

module.exports = { initAppointmentWorker, runReminderPass, runNoShowPass, runCallbackPendingReminderPass };
