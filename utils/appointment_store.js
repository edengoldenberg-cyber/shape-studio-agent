'use strict';

/**
 * appointment_store.js — Appointment registry with in-memory Map + JSON file persistence.
 *
 * Appointment shape:
 * {
 *   id:              'apt_<timestamp>_<rand>',
 *   leadPhone:       '972XXXXXXXXX',
 *   leadName:        string | null,
 *   rawTime:         string,              // original Hebrew text, e.g. "מחר בשעה 15:00"
 *   scheduledAt:     Date | null,         // resolved instant; the ONLY source for displayed dates
 *   durationMin:     number,              // default 30
 *   assignedStaffId: string,              // staff.id from staff_config.json
 *   kind:            'callback',          // telephone callback — the only kind this system creates
 *   status:          'callback_pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_answer'
 *                    (+ legacy 'no_show' / 'rescheduled' on old records)
 *                      callback_pending = requested by the prospect, awaiting staff approval
 *                      confirmed        = staff approved the callback (staffConfirmedAt set)
 *   staffConfirmedAt:       ISO string | null
 *   prospectAvailability:   null | 'confirmed' | 'rescheduled' | 'cancelled'
 *   reminderSent / reminderSentTo / prospectReminderSent / prospectReminderSentTo
 *   notifications:   { '<type>|<scheduledAt ISO>': [phones] }   // durable dedup
 *   createdAt, updatedAt: Date
 * }
 *
 * Three independent facts are stored separately and never inferred from one another:
 *   staff approval        → status === 'confirmed' + staffConfirmedAt
 *   prospect availability → prospectAvailability
 *   call outcome          → status completed / no_answer / cancelled
 *
 * Telephone callbacks are never processed by no-show detection: the system must not
 * message a prospect about a "missed" call. Staff record the outcome in the panel.
 *
 * Persistence:
 *   Data is saved to DATA_DIR/appointments.json after every mutating operation, atomically
 *   (tmp + rename). A failed write is ALWAYS visible to the caller: the in-memory change
 *   is rolled back and the error is rethrown. Nothing in this module reports success for
 *   a change that is not on disk.
 *   On startup the file is read and Date fields are rehydrated.
 *   If the file is missing or corrupt the store starts empty (non-fatal).
 */

const { randomUUID } = require('crypto');
const path           = require('path');
const fs             = require('fs');

const DATA_DIR  = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, '');
const APTS_FILE = path.join(DATA_DIR, 'appointments.json');

// Fields stored as ISO strings on disk that must be rehydrated as Date objects
const DATE_FIELDS = ['scheduledAt', 'createdAt', 'updatedAt'];

// Open (not yet resolved) callback statuses.
const ACTIVE_STATUSES = new Set(['callback_pending', 'confirmed']);

function validDate(d) { return d instanceof Date && !isNaN(d.getTime()); }

class AppointmentStore {
  constructor() {
    this._apts = new Map(); // id → appointment
    this._load();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  _load() {
    try {
      if (!fs.existsSync(APTS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(APTS_FILE, 'utf8'));
      if (!Array.isArray(raw)) return;
      for (const apt of raw) {
        for (const field of DATE_FIELDS) {
          if (apt[field]) apt[field] = new Date(apt[field]);
        }
        this._apts.set(apt.id, apt);
      }
    } catch (err) {
      console.warn('[apt-store] Could not load appointments.json — starting fresh:', err.message);
    }
  }

  /** Drop in-memory state and re-read the file (used by tests to simulate a restart). */
  reload() {
    this._apts = new Map();
    this._load();
  }

  // Returns true on success; THROWS on failure. Every mutating method rolls its
  // in-memory change back and rethrows, so memory never claims something the disk
  // does not hold.
  _save() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const records = Array.from(this._apts.values());
    const tmp = APTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmp, APTS_FILE);
    return true;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  create({ leadPhone, leadName, rawTime, scheduledAt, durationMin = 30, assignedStaffId, status = 'confirmed' }) {
    const id  = `apt_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const apt = {
      id,
      leadPhone,
      leadName:        leadName ?? null,
      rawTime,
      scheduledAt:     scheduledAt ?? null,
      durationMin,
      assignedStaffId: assignedStaffId ?? 'eden',
      kind:            'callback',
      status,
      staffConfirmedAt: null,
      calendarEventId: null,
      icsUrl:          `/api/calendar/appointment/${id}.ics`,
      reminderSent:    false,
      reminderSentTo:  [],   // phones that accepted the staff reminder; per-recipient retry
      handoffSentTo:   [],   // phones that accepted the initial manager summary
      noShowAlerted:   false,
      prospectReminderSent:    false,
      prospectReminderSentTo:  null,  // idMessage once sent
      prospectAvailability:    null,  // null | 'confirmed' | 'rescheduled' | 'cancelled'
      prospectAvailabilityAt:  null,
      notifications:           {},
      createdAt:       now,
      updatedAt:       now,
    };
    this._apts.set(id, apt);
    try {
      this._save();
    } catch (saveErr) {
      this._apts.delete(id); // undo in-memory insert
      throw saveErr;         // propagate to caller
    }
    return apt;
  }

  /**
   * Create a callback_pending entry for a prospect's callback request.
   * Throws if the record cannot be persisted.
   */
  createCallbackPending({ leadPhone, leadName, rawTime, scheduledAt = null, durationMin = 30, assignedStaffId }) {
    return this.create({ leadPhone, leadName, rawTime, scheduledAt, durationMin, assignedStaffId, status: 'callback_pending' });
  }

  /**
   * Staff approval of a pending callback.
   *   { ok:true,  apt, unchanged:false }  — callback_pending → confirmed
   *   { ok:true,  apt, unchanged:true  }  — already confirmed (repeat click is a no-op)
   *   { ok:false, error:'not_found' | 'not_pending' | 'no_time' | 'expired', apt }
   * Reminder state is deliberately NOT touched: a reminder already sent for this
   * scheduled time must not be sent again just because staff approved afterwards.
   * Throws if the change cannot be persisted.
   */
  staffConfirm(id, { now = Date.now() } = {}) {
    const apt = this._apts.get(id);
    if (!apt) return { ok: false, error: 'not_found', apt: null };
    if (apt.status === 'confirmed') return { ok: true, unchanged: true, apt };
    if (apt.status !== 'callback_pending') return { ok: false, error: 'not_pending', apt };
    if (!validDate(apt.scheduledAt)) return { ok: false, error: 'no_time', apt };
    if (apt.scheduledAt.getTime() <= now) return { ok: false, error: 'expired', apt };
    const updated = this.update(id, { status: 'confirmed', staffConfirmedAt: new Date(now).toISOString() });
    return { ok: true, unchanged: false, apt: updated };
  }

  /** Legacy alias — returns the updated record, or null when it cannot be confirmed. */
  confirmPending(id) {
    const r = this.staffConfirm(id);
    return r.ok ? r.apt : null;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get(id) { return this._apts.get(id) ?? null; }

  /** All appointments for a lead phone. */
  getByPhone(phone) {
    return Array.from(this._apts.values()).filter(a => a.leadPhone === phone);
  }

  /** Latest staff-confirmed appointment for a lead. */
  getActiveByPhone(phone) {
    return this.getByPhone(phone)
      .filter(a => a.status === 'confirmed')
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  /**
   * THE active callback for a lead: the most recently created record that is still
   * open (callback_pending or confirmed). Older open records for the same phone are
   * superseded and never receive reminders.
   */
  getActiveCallback(phone) {
    const latest = this._latestFor(phone);
    return latest && ACTIVE_STATUSES.has(latest.status) ? latest : null;
  }

  /**
   * The lead's most recent request (any status). A lead has ONE current callback: the
   * latest request. An older record that was left open (e.g. it expired and nobody
   * recorded an outcome) is superseded for good once a newer request exists — it is
   * never modified, never reminded, and never becomes "current" again when the newer
   * one is completed or cancelled.
   */
  _latestFor(phone) {
    let latest = null;
    for (const a of this._apts.values()) {
      if (a.leadPhone !== phone) continue;
      if (!latest || new Date(a.createdAt) >= new Date(latest.createdAt)) latest = a;
    }
    return latest;
  }

  /** True when a newer request exists for the same lead. */
  isSuperseded(apt) {
    const latest = this._latestFor(apt.leadPhone);
    return !!latest && latest.id !== apt.id;
  }

  getAll() { return Array.from(this._apts.values()); }

  /**
   * In-person appointments 15+ min overdue. Telephone callbacks — every record this
   * system creates; legacy records without `kind` are callbacks too — are EXCLUDED:
   * a missed phone call is recorded by staff as an outcome, never auto-messaged to the
   * prospect as a no-show.
   */
  getOverdue(bufferMs = 15 * 60 * 1000) {
    const cutoff = new Date(Date.now() - bufferMs);
    return this.getAll().filter(a =>
      a.kind === 'in_person' &&
      a.status === 'confirmed' &&
      a.scheduledAt != null &&
      a.scheduledAt < cutoff &&
      !a.noShowAlerted
    );
  }

  /** Shared reminder eligibility: open, latest for its lead, scheduled inside (now, now+window]. */
  _dueWithin(windowMs, statuses, now = Date.now()) {
    const cutoff = now + windowMs;
    return this.getAll().filter(a =>
      statuses.has(a.status) &&
      validDate(a.scheduledAt) &&
      a.scheduledAt.getTime() > now &&
      a.scheduledAt.getTime() <= cutoff &&
      !this.isSuperseded(a)
    );
  }

  /** Pending AND staff-confirmed callbacks due for the staff reminder. */
  getCallbacksDueForStaffReminder(windowMs = 20 * 60 * 1000, now = Date.now()) {
    return this._dueWithin(windowMs, ACTIVE_STATUSES, now).filter(a => !a.reminderSent);
  }

  /** Staff-confirmed callbacks due for the staff reminder. */
  getDueForReminder(windowMs = 20 * 60 * 1000) {
    return this._dueWithin(windowMs, new Set(['confirmed'])).filter(a => !a.reminderSent);
  }

  /** Pending (not yet staff-approved) callbacks due for the staff reminder. */
  getPendingCallbacksDueForReminder(windowMs = 20 * 60 * 1000) {
    return this._dueWithin(windowMs, new Set(['callback_pending'])).filter(a => !a.reminderSent);
  }

  /**
   * Open callbacks (pending AND staff-confirmed) due for the prospect reminder.
   *   - latest open record for the lead (superseded records never remind)
   *   - scheduledAt in the future and within the next windowMs
   *   - prospectReminderSent !== true
   *   - the prospect has not already asked for another time or cancelled
   */
  getCallbacksDueForProspectReminder(windowMs = 20 * 60 * 1000, now = Date.now()) {
    return this._dueWithin(windowMs, ACTIVE_STATUSES, now).filter(a =>
      a.prospectReminderSent !== true &&
      a.prospectAvailability !== 'rescheduled' &&
      a.prospectAvailability !== 'cancelled'
    );
  }

  /** All callback_pending entries (for panel display). */
  getCallbackPending() {
    return this.getAll().filter(a => a.status === 'callback_pending');
  }

  // ── Update ────────────────────────────────────────────────────────────────

  /**
   * Patch one record. Returns the updated record, or null when the id is unknown.
   * THROWS when the change cannot be written to disk — the in-memory record is
   * restored first, so callers never see (or act on) state that was not persisted.
   */
  update(id, fields) {
    const existing = this._apts.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields, updatedAt: new Date() };
    this._apts.set(id, updated);
    try {
      this._save();
    } catch (saveErr) {
      this._apts.set(id, existing); // roll back
      throw saveErr;
    }
    return updated;
  }

  /**
   * Apply the same field patch to many entries in a single disk write.
   * Returns the number of records changed. All-or-nothing: on a failed write every
   * record is restored and the error is rethrown.
   */
  updateBatch(ids, fields) {
    const now = new Date();
    const previous = new Map();
    for (const id of ids) {
      const existing = this._apts.get(id);
      if (!existing || previous.has(id)) continue;
      previous.set(id, existing);
      this._apts.set(id, { ...existing, ...fields, updatedAt: now });
    }
    if (!previous.size) return 0;
    try {
      this._save();
    } catch (saveErr) {
      for (const [id, existing] of previous) this._apts.set(id, existing); // roll back all
      throw saveErr;
    }
    return previous.size;
  }

  // ── Durable notification dedup ────────────────────────────────────────────
  //
  // key = '<type>|<scheduledAt ISO>': the same scheduled time can never notify the
  // same recipient twice (also across restarts), while a rescheduled time starts a
  // fresh cycle automatically.

  notificationKey(apt, type) {
    const at = validDate(apt?.scheduledAt) ? apt.scheduledAt.toISOString() : 'unscheduled';
    return `${type}|${at}`;
  }

  /** Phones that already accepted notification `type` for the record's current time. */
  getNotified(id, type) {
    const apt = this._apts.get(id);
    if (!apt) return [];
    return apt.notifications?.[this.notificationKey(apt, type)] ?? [];
  }

  /** Record accepted recipients. Throws if it cannot be persisted. */
  recordNotified(id, type, phones) {
    const apt = this._apts.get(id);
    if (!apt || !phones?.length) return apt ?? null;
    const key  = this.notificationKey(apt, type);
    const prev = apt.notifications?.[key] ?? [];
    const next = [...new Set([...prev, ...phones])];
    if (next.length === prev.length) return apt;
    return this.update(id, { notifications: { ...(apt.notifications ?? {}), [key]: next } });
  }

  markReminderSent(id)  { return this.update(id, { reminderSent: true }); }
  markNoShowAlerted(id) { return this.update(id, { noShowAlerted: true }); }

  // ── Outcomes ──────────────────────────────────────────────────────────────
  //
  // Each returns { ok:true, apt, unchanged } | { ok:false, error:'not_found'|'not_open', apt }.
  // Only an OPEN callback (pending / confirmed) can receive an outcome; a record that
  // already has one is never silently rewritten or revived. Repeating the same outcome
  // is a no-op.

  _setOutcome(id, status, extra = {}) {
    const apt = this._apts.get(id);
    if (!apt) return { ok: false, error: 'not_found', apt: null };
    if (apt.status === status) return { ok: true, unchanged: true, apt };
    if (!ACTIVE_STATUSES.has(apt.status)) return { ok: false, error: 'not_open', apt };
    const updated = this.update(id, { status, outcomeAt: new Date().toISOString(), ...extra });
    return { ok: true, unchanged: false, apt: updated };
  }

  complete(id, { notes = null } = {}) {
    return this._setOutcome(id, 'completed', notes ? { completionNotes: notes } : {});
  }
  cancel(id, { by = 'staff', reason = null } = {}) {
    return this._setOutcome(id, 'cancelled', { cancelledBy: by, cancelReason: reason });
  }
  noAnswer(id, { note = null } = {}) {
    return this._setOutcome(id, 'no_answer', { noAnswerNote: note, noAnswerAt: new Date().toISOString() });
  }

  /** Legacy helpers — return the updated record or null. */
  markCompleted(id) { const r = this.complete(id); return r.ok ? r.apt : null; }
  markCancelled(id) { const r = this.cancel(id);   return r.ok ? r.apt : null; }

  /**
   * Move an OPEN callback to a new time. The old time's reminder cycle is invalidated
   * and a fresh one starts: every reminder flag, the prospect's availability answer and
   * the staff approval are cleared — a new time needs new approval and new reminders.
   * Returns the updated record, or null if the record is unknown or not open.
   * Throws if the change cannot be persisted.
   */
  reschedule(id, { rawTime, scheduledAt }) {
    const apt = this._apts.get(id);
    if (!apt || !ACTIVE_STATUSES.has(apt.status)) return null;
    return this.update(id, {
      status:                 'callback_pending',
      staffConfirmedAt:       null,
      rawTime,
      scheduledAt:            scheduledAt ?? null,
      previousScheduledAt:    validDate(apt.scheduledAt) ? apt.scheduledAt.toISOString() : null,
      previousRawTime:        apt.rawTime ?? null,
      rescheduledAt:          new Date().toISOString(),
      rescheduleCount:        (apt.rescheduleCount ?? 0) + 1,
      reminderSent:           false,
      reminderSentTo:         [],
      noShowAlerted:          false,
      prospectReminderSent:   false,
      prospectReminderSentTo: null,
      prospectAvailability:   null,
      prospectAvailabilityAt: null,
    });
  }
}

// Singleton
module.exports = new AppointmentStore();
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
