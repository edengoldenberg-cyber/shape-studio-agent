'use strict';

/**
 * tomer_store.js — Durable service state for the Tomer member-service agent.
 *
 * Owns three separate concerns:
 *
 *   1. ServiceTask      — freeze requests, cancellation requests, complaints,
 *                         unsupported operations. Each needs Eden attention.
 *
 *   2. MemberHistory    — per-phone conversation history for Tomer's AI context.
 *                         Stored in memory, persisted to disk on change.
 *
 *   3. ActionAudit      — append-only log: what was requested, what Tomer did,
 *                         Arbox response, what member was told, who owns it.
 *
 * Persistence:
 *   data/service_tasks.json  — tasks (array, durable)
 *   data/tomer_history.json  — member conversation histories
 *   data/tomer_audit.json    — recent audit entries (ring buffer, last 500)
 *
 * Usage:
 *   const tomerStore = require('./utils/tomer_store');
 *   const task = tomerStore.createTask({ ... });
 *   tomerStore.resolveTask(task.id, { note: 'Handled by Eden' });
 *   tomerStore.appendAudit({ ... });
 */

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

// ── Storage paths (DATA_DIR override for tests) ───────────────────────────────
const DATA_DIR = () => (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, '');
const tasksPath    = () => path.join(DATA_DIR(), 'service_tasks.json');
const historyPath  = () => path.join(DATA_DIR(), 'tomer_history.json');
const auditPath    = () => path.join(DATA_DIR(), 'tomer_audit.json');

// ── Atomic write helper ───────────────────────────────────────────────────────
function _write(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    logger.error('[tomer_store] Write failed', { file, error: e.message });
  }
}

function _readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SERVICE TASKS
// ════════════════════════════════════════════════════════════════════════════

/*
 * Task shape:
 * {
 *   id:          string    — unique, e.g. "task-20261111-abc12"
 *   type:        string    — 'freeze_request' | 'cancellation_request' | 'complaint'
 *                           | 'unsupported_action' | 'billing_question' | 'other'
 *   phone:       string    — member's E.164 phone
 *   memberName:  string    — Arbox name or WhatsApp display name
 *   arboxId:     string?   — Arbox user_id if known
 *   summary:     string    — one-sentence description of the request
 *   detail:      string?   — full member message or additional context
 *   requestedDates: string? — e.g. "1–14 Jan" for freeze requests
 *   memberMessage: string? — verbatim text that created this task
 *   status:      string    — 'open' | 'eden_assigned' | 'in_progress' | 'resolved' | 'cancelled'
 *   priority:    string    — 'high' | 'normal' | 'low'
 *   createdAt:   string    — ISO timestamp
 *   updatedAt:   string    — ISO timestamp
 *   resolvedAt:  string?   — ISO timestamp
 *   assignedTo:  string?   — staff name / "Eden"
 *   resolutionNote: string? — how it was resolved
 *   tomerReplyGiven: string? — what Tomer told the member
 * }
 */

let _tasks = null; // lazy-loaded

function _loadTasks() {
  if (_tasks !== null) return;
  _tasks = _readJSON(tasksPath(), []);
  logger.info('[tomer_store] Tasks loaded', { count: _tasks.length });
}

function _saveTasks() {
  _write(tasksPath(), _tasks);
}

function _makeId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 7);
  return `task-${date}-${rand}`;
}

/** Create a new service task. Returns the task object. */
function createTask({
  type, phone, memberName = null, arboxId = null, summary,
  detail = null, requestedDates = null, memberMessage = null,
  priority = 'normal', tomerReplyGiven = null,
}) {
  _loadTasks();
  const now = new Date().toISOString();
  const task = {
    id: _makeId(),
    type,
    phone,
    memberName,
    arboxId,
    summary,
    detail,
    requestedDates,
    memberMessage,
    status:    'open',
    priority,
    createdAt: now,
    updatedAt: now,
    resolvedAt:    null,
    assignedTo:    null,
    resolutionNote: null,
    tomerReplyGiven,
  };
  _tasks.push(task);
  _saveTasks();
  logger.info('[tomer_store] Task created', { id: task.id, type, phone, summary });
  return task;
}

/** Update task fields. Returns updated task or null. */
function updateTask(id, updates = {}) {
  _loadTasks();
  const task = _tasks.find(t => t.id === id);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  _saveTasks();
  return task;
}

/** Mark task resolved. */
function resolveTask(id, { resolutionNote = null, resolvedBy = null } = {}) {
  return updateTask(id, {
    status: 'resolved',
    resolutionNote,
    assignedTo: resolvedBy,
    resolvedAt: new Date().toISOString(),
  });
}

/** Mark task as assigned to Eden (or another staff member). */
function assignTask(id, assignedTo = 'Eden') {
  return updateTask(id, { status: 'eden_assigned', assignedTo });
}

/** Get all tasks, optionally filtered. */
function getTasks({ status, phone, type, limit = 200 } = {}) {
  _loadTasks();
  let result = [..._tasks];
  if (status) result = result.filter(t => t.status === status);
  if (phone)  result = result.filter(t => t.phone === phone);
  if (type)   result = result.filter(t => t.type === type);
  return result
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

/** Open tasks — the Eden queue. */
function getOpenTasks() {
  return getTasks({ status: 'open' }).concat(getTasks({ status: 'eden_assigned' }))
    .sort((a, b) => {
      const pri = { high: 0, normal: 1, low: 2 };
      return (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1) ||
             new Date(a.createdAt) - new Date(b.createdAt);
    });
}

/** Check if an open task already exists for this phone+type to avoid duplicates. */
function hasOpenTask(phone, type) {
  _loadTasks();
  return _tasks.some(t => t.phone === phone && t.type === type &&
    ['open', 'eden_assigned', 'in_progress'].includes(t.status));
}

// ════════════════════════════════════════════════════════════════════════════
//  MEMBER CONVERSATION HISTORY (Tomer's per-member AI context)
// ════════════════════════════════════════════════════════════════════════════

/*
 * Stored as: { [phone]: { history: [{role, content}], updatedAt: ISO } }
 * Max 20 turns per member (40 messages — 20 user + 20 assistant).
 * Not the same as the WhatsApp inbox — this is Tomer's AI message history.
 */

let _histories = null;
let _historiesDirty = false;
const HISTORY_SAVE_DEBOUNCE_MS = 2000;
let _historySaveTimer = null;

function _loadHistories() {
  if (_histories !== null) return;
  _histories = _readJSON(historyPath(), {});
}

function _scheduleSaveHistories() {
  if (_historySaveTimer) return;
  _historySaveTimer = setTimeout(() => {
    _historySaveTimer = null;
    _write(historyPath(), _histories);
  }, HISTORY_SAVE_DEBOUNCE_MS);
}

/** Get Tomer's AI conversation history for a member. */
function getMemberHistory(phone) {
  _loadHistories();
  return (_histories[phone]?.history ?? []).filter(m => m.role !== 'system');
}

/** Set (replace) Tomer's AI history for a member. Max 20 turns. */
function setMemberHistory(phone, history) {
  _loadHistories();
  const trimmed = history.slice(-40); // keep last 40 messages (20 turns)
  _histories[phone] = { history: trimmed, updatedAt: new Date().toISOString() };
  _scheduleSaveHistories();
}

/** Append a turn to member history. */
function appendMemberHistory(phone, role, content) {
  _loadHistories();
  const existing = _histories[phone]?.history ?? [];
  const updated  = [...existing, { role, content }].slice(-40);
  _histories[phone] = { history: updated, updatedAt: new Date().toISOString() };
  _scheduleSaveHistories();
}

/** Clear a member's Tomer history (e.g. after escalation). */
function clearMemberHistory(phone) {
  _loadHistories();
  delete _histories[phone];
  _scheduleSaveHistories();
}

// ════════════════════════════════════════════════════════════════════════════
//  ACTION AUDIT LOG
// ════════════════════════════════════════════════════════════════════════════

/*
 * Append-only ring buffer (last 500 entries).
 * Each entry:
 * {
 *   ts:           ISO timestamp
 *   phone:        member phone
 *   memberName:   string
 *   event:        string  — e.g. 'tomer_responded', 'task_created', 'route_changed'
 *   requestPreview: string — first 100 chars of member message
 *   tomerAction:  string  — what Tomer did
 *   arboxStatus:  string? — 'ok' | 'failed' | 'not_attempted'
 *   replyPreview: string? — first 100 chars of what was sent
 *   owner:        string? — 'tomer' | 'barak' | 'eden' | 'human' | 'unclassified'
 *   taskId:       string? — if a task was created
 * }
 */

let _audit = null;
const AUDIT_MAX = 500;

function _loadAudit() {
  if (_audit !== null) return;
  _audit = _readJSON(auditPath(), []);
}

function appendAudit(entry) {
  _loadAudit();
  _audit.push({ ts: new Date().toISOString(), ...entry });
  if (_audit.length > AUDIT_MAX) _audit = _audit.slice(-AUDIT_MAX);
  _write(auditPath(), _audit);
}

function getAudit({ phone, event, limit = 100 } = {}) {
  _loadAudit();
  let result = [..._audit];
  if (phone) result = result.filter(e => e.phone === phone);
  if (event) result = result.filter(e => e.event === event);
  return result.slice(-limit).reverse();
}

// ════════════════════════════════════════════════════════════════════════════
//  UNCLASSIFIED CONTACTS
// ════════════════════════════════════════════════════════════════════════════

/*
 * Tracks contacts that received a neutral greeting but haven't been routed.
 * Stored in-memory; cleared on restart (intentional — fresh start is fine).
 * Shape: { phone: { firstSeenAt, firstMessage, greetingSentAt, clarityReached } }
 */

const _unclassified = new Map();

function markUnclassified(phone, { firstMessage = '', greetingSent = false } = {}) {
  if (!_unclassified.has(phone)) {
    _unclassified.set(phone, {
      phone,
      firstSeenAt:    new Date().toISOString(),
      firstMessage:   firstMessage.slice(0, 120),
      greetingSentAt: greetingSent ? new Date().toISOString() : null,
      clarityReached: false,
    });
  } else if (greetingSent) {
    _unclassified.get(phone).greetingSentAt = new Date().toISOString();
  }
}

function hasGreetedUnclassified(phone) {
  return !!_unclassified.get(phone)?.greetingSentAt;
}

function resolveUnclassified(phone, routedTo) {
  const entry = _unclassified.get(phone);
  if (entry) { entry.clarityReached = true; entry.routedTo = routedTo; }
}

function getAllUnclassified() {
  return Array.from(_unclassified.values()).filter(u => !u.clarityReached);
}

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Service tasks
  createTask,
  updateTask,
  resolveTask,
  assignTask,
  getTasks,
  getOpenTasks,
  hasOpenTask,

  // Member AI history
  getMemberHistory,
  setMemberHistory,
  appendMemberHistory,
  clearMemberHistory,

  // Audit
  appendAudit,
  getAudit,

  // Unclassified
  markUnclassified,
  hasGreetedUnclassified,
  resolveUnclassified,
  getAllUnclassified,
};
