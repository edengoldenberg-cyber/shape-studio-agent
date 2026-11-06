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
 *   scheduledAt:     Date | null,         // parsed datetime; null = unparsed
 *   durationMin:     number,              // default 30
 *   assignedStaffId: string,             // staff.id from staff_config.json
 *   status:          'confirmed' | 'completed' | 'no_show' | 'rescheduled' | 'cancelled',
 *   calendarEventId: string | null,
 *   icsUrl:          string | null,       // /api/calendar/appointment/:id.ics
 *   reminderSent:    boolean,
 *   noShowAlerted:   boolean,
 *   createdAt:       Date,
 *   updatedAt:       Date,
 * }
 *
 * Persistence:
 *   Data is saved to data/appointments.json after every mutating operation.
 *   On startup the file is read and Date fields are rehydrated.
 *   If the file is missing or corrupt the store starts empty (non-fatal).
 */

const { randomUUID } = require('crypto');
const path           = require('path');
const fs             = require('fs');

const DATA_DIR  = path.join(__dirname, '../data');
const APTS_FILE = path.join(DATA_DIR, 'appointments.json');

// Fields stored as ISO strings on disk that must be rehydrated as Date objects
const DATE_FIELDS = ['scheduledAt', 'createdAt', 'updatedAt'];

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

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const records = Array.from(this._apts.values());
      fs.writeFileSync(APTS_FILE, JSON.stringify(records, null, 2), 'utf8');
    } catch (err) {
      console.warn('[apt-store] Could not save appointments.json:', err.message);
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  create({ leadPhone, leadName, rawTime, scheduledAt, durationMin = 30, assignedStaffId }) {
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
      status:          'confirmed',
      calendarEventId: null,
      icsUrl:          `/api/calendar/appointment/${id}.ics`,
      reminderSent:    false,
      noShowAlerted:   false,
      createdAt:       now,
      updatedAt:       now,
    };
    this._apts.set(id, apt);
    this._save();
    return apt;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get(id) { return this._apts.get(id) ?? null; }

  /** All appointments for a lead phone. */
  getByPhone(phone) {
    return Array.from(this._apts.values()).filter(a => a.leadPhone === phone);
  }

  /** Latest confirmed appointment for a lead. */
  getActiveByPhone(phone) {
    return this.getByPhone(phone)
      .filter(a => a.status === 'confirmed')
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  getAll() { return Array.from(this._apts.values()); }

  /** Confirmed appointments whose scheduledAt is 15+ min in the past and not yet flagged. */
  getOverdue(bufferMs = 15 * 60 * 1000) {
    const cutoff = new Date(Date.now() - bufferMs);
    return this.getAll().filter(a =>
      a.status === 'confirmed' &&
      a.scheduledAt != null &&
      a.scheduledAt < cutoff &&
      !a.noShowAlerted
    );
  }

  /** Confirmed appointments whose scheduledAt is within the next windowMs and reminder not sent. */
  getDueForReminder(windowMs = 20 * 60 * 1000) {
    const now    = Date.now();
    const cutoff = now + windowMs;
    return this.getAll().filter(a =>
      a.status === 'confirmed' &&
      a.scheduledAt != null &&
      a.scheduledAt.getTime() > now &&
      a.scheduledAt.getTime() <= cutoff &&
      !a.reminderSent
    );
  }

  // ── Update ────────────────────────────────────────────────────────────────

  update(id, fields) {
    const existing = this._apts.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields, updatedAt: new Date() };
    this._apts.set(id, updated);
    this._save();
    return updated;
  }

  markReminderSent(id)  { return this.update(id, { reminderSent: true }); }
  markNoShowAlerted(id) { return this.update(id, { noShowAlerted: true }); }
  markCompleted(id)     { return this.update(id, { status: 'completed' }); }
  markCancelled(id)     { return this.update(id, { status: 'cancelled' }); }

  reschedule(id, { rawTime, scheduledAt }) {
    return this.update(id, {
      status:        'confirmed',  // reset to confirmed with the new time
      rawTime,
      scheduledAt:   scheduledAt ?? null,
      reminderSent:  false,
      noShowAlerted: false,
    });
  }
}

// Singleton
module.exports = new AppointmentStore();
