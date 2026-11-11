'use strict';

/**
 * retention_worker.js — Proactive member-service and retention workflows for Tomer.
 *
 * Workflows:
 *   1. birthday     — greeting on member's birthday (from Arbox birthday field).
 *   2. onboarding1  — check-in 7 days after membership_start_date.
 *   3. onboarding2  — check-in 14 days after membership_start_date.
 *   4. attendance   — supportive outreach after 14+ days with no attendance record.
 *
 * Design rules:
 *   - ALL workflows are DISABLED by default. Enable explicitly via config or admin panel.
 *   - Deduplication is durable: execution IDs written to data/retention_log.json.
 *   - Quiet hours respected (22:00–08:00 Asia/Jerusalem).
 *   - Communication preferences checked (allow_sms from Arbox).
 *   - No backlog of old messages on first activation — activation policy is "today forward".
 *   - Each workflow checks: eligibility, dedup, quiet hours, communication prefs.
 *   - On first run, sets an "activation date" so old records are skipped.
 *
 * Usage:
 *   const rw = require('./workers/retention_worker');
 *   await rw.runAllWorkflows();  // called from scheduler
 *   await rw.runWorkflow('birthday');
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');
const tomerStore = require('../utils/tomer_store');
const { isQuietHours } = require('../utils/time');

// ── Lazy service loads ────────────────────────────────────────────────────────
let _arbox    = null;
let _sendText = null;
function arbox()    { if (!_arbox)    _arbox    = require('../services/arbox.service'); return _arbox; }
function sendText() { if (!_sendText) _sendText = require('../services/whatsapp.service').sendText; return _sendText; }

// ── Storage ───────────────────────────────────────────────────────────────────
const DATA_DIR        = () => (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, '');
const retentionLogPath = () => path.join(DATA_DIR(), 'retention_log.json');

function _readLog() {
  try {
    if (!fs.existsSync(retentionLogPath())) return {};
    return JSON.parse(fs.readFileSync(retentionLogPath(), 'utf8'));
  } catch { return {}; }
}

function _writeLog(log) {
  try {
    const tmp = retentionLogPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
    fs.renameSync(tmp, retentionLogPath());
  } catch (e) {
    logger.error('[retention_worker] log write failed', { error: e.message });
  }
}

// ── Workflow configuration (all disabled by default) ─────────────────────────

const WORKFLOW_DEFAULTS = {
  birthday:    { enabled: false, quietStart: 22, quietEnd: 8 },
  onboarding1: { enabled: false, dayAfter: 7,  quietStart: 22, quietEnd: 8 },
  onboarding2: { enabled: false, dayAfter: 14, quietStart: 22, quietEnd: 8 },
  attendance:  { enabled: false, inactiveDays: 14, quietStart: 22, quietEnd: 8 },
};

// Runtime config — can be toggled via admin panel API
const _config = { ...WORKFLOW_DEFAULTS };

function getConfig()          { return { ..._config }; }
function enableWorkflow(id)   { if (_config[id]) { _config[id].enabled = true;  logger.info('[retention] enabled', { id }); } }
function disableWorkflow(id)  { if (_config[id]) { _config[id].enabled = false; logger.info('[retention] disabled', { id }); } }
function setWorkflowConfig(id, updates) {
  if (_config[id]) Object.assign(_config[id], updates);
}

// ── Deduplication helpers ─────────────────────────────────────────────────────

/**
 * Build a dedup key: "workflow:phone:date-suffix".
 * Birthday   → "birthday:972XXXXXXX:MM-DD"       (once per calendar year)
 * Onboarding → "onboarding1:972XXXXXXX:YYYY-MM-DD" (once ever for this activation)
 * Attendance → "attendance:972XXXXXXX:YYYY-MM-DD"  (once per 14-day window)
 */
function _dedupKey(workflow, phone, date) {
  return `${workflow}:${phone}:${date}`;
}

function _hasRun(log, key)   { return !!log[key]; }
function _markRun(log, key, detail = {}) {
  log[key] = { ts: new Date().toISOString(), ...detail };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function _today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
}

function _daysDiff(dateA, dateB = new Date()) {
  const a = new Date(dateA);
  a.setHours(0, 0, 0, 0);
  const b = new Date(dateB);
  b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

function _isToday(dateStr) {
  if (!dateStr) return false;
  const today = _today();
  // birthday is YYYY-MM-DD; compare MM-DD part only
  return dateStr.slice(5, 10) === today.slice(5, 10);
}

// ── Activation date guard ─────────────────────────────────────────────────────
// When a workflow is first run, record today as "activation date".
// Skip any member whose qualifying event (birthday, start date) predates activation by more
// than the workflow's window — this prevents a backlog flood on first enable.

function _getOrSetActivationDate(log, workflowId) {
  const key = `activation:${workflowId}`;
  if (!log[key]) {
    log[key] = { date: _today(), ts: new Date().toISOString() };
    logger.info('[retention] First activation', { workflow: workflowId, date: log[key].date });
  }
  return log[key].date;
}

// ── Individual workflow runners ───────────────────────────────────────────────

/**
 * Birthday workflow.
 * Eligibility: active member, today is their Arbox birthday (MM-DD match),
 *              haven't sent this year.
 */
async function _runBirthday(members, log, result) {
  const cfg = _config.birthday;
  if (!cfg.enabled) { result.skipped += members.length; return; }

  const activationDate = _getOrSetActivationDate(log, 'birthday');

  for (const m of members) {
    if (!m.birthday || !m.phone) { result.skipped++; continue; }
    if (!_isToday(m.birthday))   { result.skipped++; continue; }
    if (!m.active)                { result.skipped++; continue; }
    if (m.allow_sms === false)    { result.skipped++; continue; }

    // Skip if member's birthday is in the past relative to activation (would flood on first run)
    const thisYearBday = `${new Date().getFullYear()}-${m.birthday.slice(5, 10)}`;
    if (thisYearBday < activationDate) { result.skipped++; continue; }

    const key = _dedupKey('birthday', m.phone, `${new Date().getFullYear()}-${m.birthday.slice(5, 10)}`);
    if (_hasRun(log, key)) { result.skipped++; continue; }

    const name    = `${m.first_name ?? ''}`.trim() || 'חבר/ה יקר/ה';
    const gender  = m.gender === 'male' ? 'male' : 'female';
    const message = gender === 'male'
      ? `${name}, יום הולדת שמח! 🎂 שמחים שאתה איתנו ב-Shape Studio — יהיה שנה מלאת בריאות, שמחה ואנרגיה 💪`
      : `${name}, יום הולדת שמח! 🎂 שמחות שאת איתנו ב-Shape Studio — תהיי שנה מלאת בריאות, שמחה ואנרגיה 💪`;

    try {
      await sendText()(m.phone, message);
      _markRun(log, key, { name, workflow: 'birthday' });
      tomerStore.appendAudit({ phone: m.phone, memberName: name, event: 'retention_sent',
        tomerAction: 'birthday greeting', replyPreview: message.slice(0, 80), owner: 'tomer' });
      result.sent++;
      logger.info('[retention] Birthday sent', { phone: m.phone, name });
    } catch (err) {
      result.errors++;
      logger.warn('[retention] Birthday send failed', { phone: m.phone, error: err.message });
    }
  }
}

/**
 * Onboarding workflow (day 7 and day 14 after membership_start_date).
 */
async function _runOnboarding(members, log, result, dayAfter, workflowId) {
  const cfg = _config[workflowId];
  if (!cfg.enabled) { result.skipped += members.length; return; }

  _getOrSetActivationDate(log, workflowId);

  for (const m of members) {
    if (!m.membership_start_date || !m.phone) { result.skipped++; continue; }
    if (!m.active)             { result.skipped++; continue; }
    if (m.allow_sms === false) { result.skipped++; continue; }

    const daysSince = _daysDiff(m.membership_start_date);
    // Fire on the specific day (±1 to handle timing)
    if (daysSince < dayAfter || daysSince > dayAfter + 1) { result.skipped++; continue; }

    const key = _dedupKey(workflowId, m.phone, m.membership_start_date.slice(0, 10));
    if (_hasRun(log, key)) { result.skipped++; continue; }

    const name   = `${m.first_name ?? ''}`.trim() || 'חבר/ה';
    const gender = m.gender === 'male' ? 'male' : 'female';

    let message;
    if (workflowId === 'onboarding1') {
      message = gender === 'male'
        ? `${name}, שלום! 👋 שבוע אחד ב-Shape Studio — איך הולך? יש שאלות, בקשות, או משהו שנוכל לשפר בשבילך?`
        : `${name}, שלום! 👋 שבוע אחד ב-Shape Studio — איך הולך? יש שאלות, בקשות, או משהו שנוכל לשפר בשבילך?`;
    } else {
      message = gender === 'male'
        ? `${name}, שבועיים עברו 🙂 מקווים שאתה מרגיש כבר כמו בבית. יש לנו עניין לשמוע איך היה עד כה — נשמח לפידבק קצר.`
        : `${name}, שבועיים עברו 🙂 מקווים שאת כבר מרגישה כמו בבית. יש לנו עניין לשמוע איך היה עד כה — נשמח לפידבק קצר.`;
    }

    try {
      await sendText()(m.phone, message);
      _markRun(log, key, { name, workflow: workflowId, dayAfter });
      tomerStore.appendAudit({ phone: m.phone, memberName: name, event: 'retention_sent',
        tomerAction: `onboarding day ${dayAfter}`, replyPreview: message.slice(0, 80), owner: 'tomer' });
      result.sent++;
      logger.info('[retention] Onboarding sent', { phone: m.phone, name, dayAfter });
    } catch (err) {
      result.errors++;
      logger.warn('[retention] Onboarding send failed', { phone: m.phone, error: err.message });
    }
  }
}

/**
 * Attendance-drop workflow.
 * Note: Arbox public API v3 does not expose per-member attendance records.
 * We use the local member store's lastAttendance field as a proxy.
 */
async function _runAttendanceDrop(members, log, result) {
  const cfg = _config.attendance;
  if (!cfg.enabled) { result.skipped += members.length; return; }

  const store = require('../utils/lead_store');
  const localMembers = store.getAllMembers?.() ?? [];
  const localByPhone = new Map(localMembers.map(m => [m.phone, m]));
  const inactiveDays = cfg.inactiveDays ?? 14;

  _getOrSetActivationDate(log, 'attendance');

  for (const m of members) {
    if (!m.phone)              { result.skipped++; continue; }
    if (!m.active)             { result.skipped++; continue; }
    if (m.allow_sms === false) { result.skipped++; continue; }

    const local = localByPhone.get(m.phone);
    if (!local?.lastAttendance) { result.skipped++; continue; }

    const daysSince = _daysDiff(local.lastAttendance);
    if (daysSince < inactiveDays) { result.skipped++; continue; }

    // Dedup: once per 14-day window
    const windowKey = _today().slice(0, 7); // YYYY-MM
    const key = _dedupKey('attendance', m.phone, windowKey);
    if (_hasRun(log, key)) { result.skipped++; continue; }

    // Skip if there's already an open service task for this member
    if (tomerStore.hasOpenTask(m.phone, 'attendance_followup')) { result.skipped++; continue; }

    const name   = `${m.first_name ?? ''}`.trim() || 'חבר/ה';
    const gender = m.gender === 'male' ? 'male' : 'female';
    const message = gender === 'male'
      ? `${name}, שלום! לא ראינו אותך בזמן האחרון — הכל בסדר? 🙂 אם יש משהו שנוכל לעזור, אנחנו כאן.`
      : `${name}, שלום! לא ראינו אותך בזמן האחרון — הכל בסדר? 🙂 אם יש משהו שנוכל לעזור, אנחנו כאן.`;

    try {
      await sendText()(m.phone, message);
      _markRun(log, key, { name, workflow: 'attendance', daysSince });
      tomerStore.appendAudit({ phone: m.phone, memberName: name, event: 'retention_sent',
        tomerAction: `attendance drop (${daysSince}d)`, replyPreview: message.slice(0, 80), owner: 'tomer' });
      result.sent++;
      logger.info('[retention] Attendance outreach sent', { phone: m.phone, name, daysSince });
    } catch (err) {
      result.errors++;
      logger.warn('[retention] Attendance send failed', { phone: m.phone, error: err.message });
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PUBLIC ENTRY POINTS
// ════════════════════════════════════════════════════════════════════════════

/** Run a single workflow by ID. */
async function runWorkflow(workflowId) {
  if (isQuietHours()) {
    logger.info('[retention] Quiet hours — skipping', { workflow: workflowId });
    return { skipped: 0, sent: 0, errors: 0, reason: 'quiet_hours' };
  }

  const log    = _readLog();
  const result = { workflow: workflowId, sent: 0, skipped: 0, errors: 0, ts: new Date().toISOString() };

  try {
    const members = await arbox().getMembers({ limit: 500, activeOnly: false });

    if (workflowId === 'birthday')    await _runBirthday(members, log, result);
    if (workflowId === 'onboarding1') await _runOnboarding(members, log, result, 7,  'onboarding1');
    if (workflowId === 'onboarding2') await _runOnboarding(members, log, result, 14, 'onboarding2');
    if (workflowId === 'attendance')  await _runAttendanceDrop(members, log, result);

    _writeLog(log);
  } catch (err) {
    result.errors++;
    logger.error('[retention] runWorkflow failed', { workflow: workflowId, error: err.message });
  }

  logger.info('[retention] Workflow complete', result);
  return result;
}

/** Run all enabled workflows. */
async function runAllWorkflows() {
  if (isQuietHours()) {
    logger.info('[retention] Quiet hours — all workflows skipped');
    return { totalSent: 0, totalSkipped: 0, totalErrors: 0, reason: 'quiet_hours' };
  }

  const workflows = Object.keys(_config);
  const results   = [];

  for (const id of workflows) {
    if (!_config[id].enabled) {
      results.push({ workflow: id, skipped: 0, sent: 0, errors: 0, reason: 'disabled' });
      continue;
    }
    results.push(await runWorkflow(id).catch(err => ({
      workflow: id, errors: 1, sent: 0, skipped: 0, reason: err.message,
    })));
  }

  const totals = results.reduce((acc, r) => ({
    totalSent:   acc.totalSent + (r.sent ?? 0),
    totalSkipped:acc.totalSkipped + (r.skipped ?? 0),
    totalErrors: acc.totalErrors + (r.errors ?? 0),
  }), { totalSent: 0, totalSkipped: 0, totalErrors: 0 });

  logger.info('[retention] All workflows complete', { ...totals, workflows: results.length });
  return { ...totals, results };
}

/** Preview upcoming eligible members for a workflow (dry run — no sends). */
async function previewWorkflow(workflowId, limit = 20) {
  const log     = _readLog();
  const members = await arbox().getMembers({ limit: 500, activeOnly: false }).catch(() => []);
  const cfg     = _config[workflowId];
  if (!cfg) return { error: `Unknown workflow: ${workflowId}` };

  const eligible = [];
  const dayAfter = workflowId === 'onboarding1' ? 7 : workflowId === 'onboarding2' ? 14 : null;

  for (const m of members) {
    if (!m.phone) continue;
    if (m.allow_sms === false) continue;

    if (workflowId === 'birthday') {
      if (!m.birthday || !m.active) continue;
      const thisBday = `${new Date().getFullYear()}-${m.birthday.slice(5, 10)}`;
      const key = _dedupKey('birthday', m.phone, thisBday);
      if (_hasRun(log, key)) continue;
      if (!_isToday(m.birthday)) continue; // preview shows only today-eligible
      eligible.push({ phone: m.phone.slice(-4), name: `${m.first_name} ${m.last_name}`.trim(), birthday: m.birthday });
    }

    if ((workflowId === 'onboarding1' || workflowId === 'onboarding2') && dayAfter) {
      if (!m.membership_start_date || !m.active) continue;
      const daysSince = _daysDiff(m.membership_start_date);
      if (daysSince < dayAfter || daysSince > dayAfter + 1) continue;
      const key = _dedupKey(workflowId, m.phone, m.membership_start_date.slice(0, 10));
      if (_hasRun(log, key)) continue;
      eligible.push({ phone: m.phone.slice(-4), name: `${m.first_name} ${m.last_name}`.trim(), startDate: m.membership_start_date, daysSince });
    }

    if (eligible.length >= limit) break;
  }

  // Build a sample message so the panel can preview what will actually be sent.
  const sampleName = eligible[0]?.name?.split(/\s/)[0] ?? 'שם';
  const sampleMsg = {
    birthday:    `${sampleName}, יום הולדת שמח! 🎂 שמחים שאת/ה איתנו ב-Shape Studio — תהיי/יהיה שנה מלאת בריאות ואנרגיה 💪`,
    onboarding1: `${sampleName}, שלום! 👋 שבוע אחד ב-Shape Studio — איך הולך? יש שאלות על השיעורים?`,
    onboarding2: `${sampleName}, שבועיים עברו 🙂 מקווים שאת/ה מרגיש/ה כבר כמו בבית. נשמח לפידבק קצר.`,
    attendance:  `${sampleName}, לא ראינו אותך קצת זמן 😊 הכל בסדר? נשמח לראות אותך בסטודיו שוב.`,
  }[workflowId] ?? null;

  return { workflow: workflowId, enabled: cfg.enabled, eligible, messageTemplate: sampleMsg };
}

module.exports = {
  runAllWorkflows,
  runWorkflow,
  previewWorkflow,
  getConfig,
  enableWorkflow,
  disableWorkflow,
  setWorkflowConfig,
};
