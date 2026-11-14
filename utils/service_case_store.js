'use strict';

/**
 * service_case_store.js — durable service cases for Tomer (existing-member service).
 *
 * One case = one member issue followed to resolution.
 *
 * {
 *   id, phone, memberUserId, memberName,
 *   category,                 // see CATEGORIES in services/tomer_service.js
 *   summary,                  // one line for staff
 *   status,                   // 'awaiting_member' | 'awaiting_staff' | 'in_progress' | 'resolved' | 'rejected' | 'cancelled'
 *   owner,                    // 'tomer' | 'staff' | <staff name>
 *   priority,                 // 'high' | 'normal'
 *   nextAction,               // what has to happen next, in words
 *   context:  [{ at, from: 'member'|'tomer'|'staff'|'system', text }]   (last 30)
 *   events:   [{ at, type, by, detail }]                                 (last 60)
 *   facts,                    // verified Arbox data captured when the case opened (+ source, fetchedAt)
 *   action:   null | {        // linked Arbox action — see services/member_actions.js
 *     id, op, args, state, requiresApproval,
 *     approval: { decision, by, at, note }, attempts: [...], verification: {...}, executor
 *   },
 *   notification: { required, state: 'not_required'|'pending'|'accepted'|'failed', sentTo, idMessage, attempts, lastError, at },
 *   memberNotice: { state, text, at, reason },   // last automatic update sent (or withheld) to the member
 *   resolution: null | { note, by, at },
 *   createdAt, updatedAt,
 * }
 *
 * Also holds per-member conversation state (what Tomer is waiting for).
 *
 * Persistence: DATA_DIR/service_cases.json, atomic (tmp + rename) after every mutation.
 * A failed write THROWS and the in-memory change is rolled back — a case or an action
 * state is never reported as saved when it is not on disk.
 * The legacy data/service_tasks.json is never modified by this module.
 */

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const dataDir = () => (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, '');
const file    = () => path.join(dataDir(), 'service_cases.json');

const OPEN_STATUSES = new Set(['awaiting_member', 'awaiting_staff', 'in_progress']);

let _state = null;   // { cases: Map<id, case>, conv: Map<phone, state> }

function _load() {
  if (_state) return _state;
  const s = { cases: new Map(), conv: new Map() };
  try {
    if (fs.existsSync(file())) {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      for (const c of raw.cases ?? []) s.cases.set(c.id, c);
      for (const [phone, v] of Object.entries(raw.conv ?? {})) s.conv.set(phone, v);
    }
  } catch (err) {
    // A corrupt file must not be silently replaced by an empty one on the next save.
    const bad = file() + '.corrupt-' + Date.now();
    try { fs.copyFileSync(file(), bad); } catch { /* ignore */ }
    console.error('[service-cases] could not read service_cases.json — copied to', bad, err.message);
  }
  _state = s;
  return s;
}

function _persist() {
  const s = _load();
  if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ cases: [...s.cases.values()], conv: Object.fromEntries(s.conv), savedAt: new Date().toISOString() }, null, 2), 'utf8');
  fs.renameSync(tmp, file());
}

/** Run a mutation; on a failed write restore the previous in-memory state and rethrow. */
function _mutate(fn) {
  const s = _load();
  const snapCases = new Map([...s.cases].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const snapConv  = new Map([...s.conv].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  try {
    const out = fn(s);
    _persist();
    return out;
  } catch (err) {
    s.cases = snapCases; s.conv = snapConv;
    throw err;
  }
}

const nowIso = () => new Date().toISOString();
function _id(prefix) {
  const d = nowIso().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${d}-${randomUUID().slice(0, 6)}`;
}
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ── Cases ─────────────────────────────────────────────────────────────────────

function create({ phone, memberUserId = null, memberName = null, category, summary, status = 'awaiting_staff',
                  owner = 'tomer', priority = 'normal', nextAction = null, memberText = null, facts = null,
                  notificationRequired = true, action = null }) {
  return _mutate(s => {
    const at = nowIso();
    const c = {
      id: _id('case'), phone, memberUserId, memberName, category, summary, status, owner, priority, nextAction,
      context: memberText ? [{ at, from: 'member', text: String(memberText).slice(0, 1000) }] : [],
      events:  [{ at, type: 'opened', by: 'tomer', detail: category }],
      facts,
      action,
      notification: { required: !!notificationRequired, state: notificationRequired ? 'pending' : 'not_required', sentTo: [], idMessage: null, attempts: 0, lastError: null, at: null },
      memberNotice: null,
      resolution: null,
      createdAt: at, updatedAt: at,
    };
    s.cases.set(c.id, c);
    return clone(c);
  });
}

function get(id) { return clone(_load().cases.get(id) ?? null); }

function list({ phone, status, category, open, limit = 200 } = {}) {
  let rows = [..._load().cases.values()];
  if (phone)    rows = rows.filter(c => c.phone === phone);
  if (status)   rows = rows.filter(c => c.status === status);
  if (category) rows = rows.filter(c => c.category === category);
  if (open === true)  rows = rows.filter(c => OPEN_STATUSES.has(c.status));
  if (open === false) rows = rows.filter(c => !OPEN_STATUSES.has(c.status));
  rows.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1) || new Date(b.updatedAt) - new Date(a.updatedAt));
  return clone(rows.slice(0, limit));
}

/** The member's open case in a category (one open case per member + category). */
function findOpen(phone, category) {
  const hit = [..._load().cases.values()]
    .filter(c => c.phone === phone && OPEN_STATUSES.has(c.status) && (!category || c.category === category))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return clone(hit ?? null);
}

/**
 * Patch a case and append an event. `patch` may contain any top-level field;
 * `actionPatch` is merged into case.action. Returns the updated case (or null).
 */
function update(id, patch = {}, event = null, { actionPatch = null, contextEntry = null } = {}) {
  return _mutate(s => {
    const c = s.cases.get(id);
    if (!c) return null;
    Object.assign(c, patch);
    if (actionPatch) c.action = { ...(c.action ?? {}), ...actionPatch };
    const at = nowIso();
    if (contextEntry) c.context = [...(c.context ?? []), { at, ...contextEntry, text: String(contextEntry.text ?? '').slice(0, 1000) }].slice(-30);
    if (event) c.events = [...(c.events ?? []), { at, ...event }].slice(-60);
    c.updatedAt = at;
    return clone(c);
  });
}

function isOpen(c) { return !!c && OPEN_STATUSES.has(c.status); }

// ── Conversation state (what Tomer is waiting for from a member) ──────────────
// { awaiting: 'topic'|'class_choice'|'verify_booking'|'verify_cancel'|'freeze_dates'|'callback_details'|…,
//   data: {...}, askedAt, expiresAt }

function getConv(phone) {
  const v = _load().conv.get(phone);
  if (!v) return null;
  if (v.expiresAt && new Date(v.expiresAt).getTime() <= Date.now()) return null;
  return clone(v);
}
function setConv(phone, awaiting, data = {}, ttlMinutes = 60) {
  return _mutate(s => {
    const v = { awaiting, data, askedAt: nowIso(), expiresAt: new Date(Date.now() + ttlMinutes * 60000).toISOString() };
    s.conv.set(phone, v);
    return clone(v);
  });
}
function clearConv(phone) {
  if (!_load().conv.has(phone)) return;
  _mutate(s => { s.conv.delete(phone); });
}

/** Drop in-memory state and re-read the file (tests use this to simulate a restart). */
function reload() { _state = null; return _load(); }

module.exports = { create, get, list, findOpen, update, isOpen, getConv, setConv, clearConv, reload, newActionId: () => _id('act'), OPEN_STATUSES };
