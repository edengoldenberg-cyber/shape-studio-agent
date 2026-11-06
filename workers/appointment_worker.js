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
    const path = require('path');
    _staffConfig = JSON.parse(
      require('fs').readFileSync(path.join(__dirname, '../data/staff_config.json'), 'utf8')
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

// ── Init ──────────────────────────────────────────────────────────────────────

function initAppointmentWorker(store) {
  // Every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const r = await runReminderPass(store);
      const n = await runNoShowPass(store);
      if (r.reminders || n.noShows) {
        logger.info('[apt-worker] Cycle complete', r, n);
      }
    } catch (err) {
      logger.error('[apt-worker] Error', { error: err.message });
    }
  }, { timezone: 'Asia/Jerusalem' });
  logger.info('Worker[Appointments]: reminder + no-show worker scheduled — every 15 min');
}

module.exports = { initAppointmentWorker, runReminderPass, runNoShowPass };
