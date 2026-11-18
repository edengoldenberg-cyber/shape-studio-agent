'use strict';

/**
 * delivery_ledger.js — what is actually known about each message this system sent through WhatsApp.
 *
 * "The provider accepted the message" is not "the customer received a readable message". Production, 2026-11-18:
 * a lead saw "ממתין להודעה" instead of Barak's reply, and nothing on the server could tell - Green API reported
 * "sent" for every message of the day (also for messages the recipient had read and answered), and not one delivery
 * status reached the webhook. So every sent message is recorded here with the best status that ever arrived for it:
 *   accepted  the provider returned an id                      (never proof of delivery)
 *   sent / delivered / read / failed / noAccount …             only when the provider reported it (webhook)
 * and the panel says in so many words when NO delivery confirmation is arriving at all.
 * Stores no message text and no full phone number.
 */

const fs = require('fs');
const path = require('path');

const MAX = 3000;
const RANK = { accepted: 0, pending: 1, sent: 2, delivered: 3, read: 4 };
const file = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'delivery_ledger.json');
let _s = null, _dirty = null;
const load = () => { if (_s) return _s; try { _s = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { _s = {}; } _s.messages = _s.messages ?? {}; _s.connection = _s.connection ?? []; return _s; };
const save = () => { if (_dirty) return; _dirty = setTimeout(() => { _dirty = null; try { fs.mkdirSync(path.dirname(file()), { recursive: true }); const tmp = file() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_s), 'utf8'); fs.renameSync(tmp, file()); } catch { /* the ledger is evidence, not state: a failed save loses history only */ } }, 500); if (_dirty.unref) _dirty.unref(); };
const tail = p => String(p ?? '').replace(/\D/g, '').slice(-4) || null;

/** The provider accepted a message and returned its id. */
function recordAccepted(idMessage, phone, at = new Date()) {
  if (!idMessage) return;
  const s = load();
  if (!s.messages[idMessage]) s.messages[idMessage] = { tail: tail(phone), acceptedAt: at.toISOString(), status: 'accepted', statusAt: null, history: [] };
  const keys = Object.keys(s.messages);
  if (keys.length > MAX) for (const k of keys.slice(0, keys.length - MAX)) delete s.messages[k];
  save();
}

/** A delivery status the provider reported for a message (webhook outgoingMessageStatus). */
function recordStatus(idMessage, status, { at = new Date(), description = null } = {}) {
  if (!idMessage || !status) return null;
  const s = load(), st = String(status);
  const m = s.messages[idMessage] ?? (s.messages[idMessage] = { tail: null, acceptedAt: null, status: 'accepted', statusAt: null, history: [], unknownOrigin: true });
  m.history = [...(m.history ?? []), { at: at.toISOString(), status: st, description: description ? String(description).slice(0, 120) : null }].slice(-8);
  const bad = !(st in RANK);                                   // failed, noAccount, notInGroup, yellowCard …: always recorded as the state
  if (bad || (RANK[st] ?? 0) >= (RANK[m.status] ?? 0)) { m.status = st; m.statusAt = at.toISOString(); }
  save();
  return m;
}

/** The connection's own reports (state / status / device webhooks), newest last. */
function recordConnection(kind, value, at = new Date()) {
  const s = load();
  s.connection = [...s.connection, { at: at.toISOString(), kind, value: String(value ?? '').slice(0, 80) }].slice(-60);
  save();
}

const get = id => load().messages[id] ?? null;

/** What the last `hours` say: how many were accepted, and for how many anything better was ever reported. */
function summary({ hours = 24, now = new Date() } = {}) {
  const s = load(), from = now.getTime() - hours * 3600000;
  const rows = Object.values(s.messages).filter(m => m.acceptedAt && Date.parse(m.acceptedAt) >= from);
  const by = {}; for (const m of rows) by[m.status] = (by[m.status] ?? 0) + 1;
  const confirmed = rows.filter(m => m.status === 'delivered' || m.status === 'read').length;
  const failed = rows.filter(m => !(m.status in RANK)).length;
  return { hours, accepted: rows.length, byStatus: by, confirmed, failed, anyStatusReported: rows.some(m => (m.history ?? []).length > 0),
    oldestUnconfirmedAt: rows.filter(m => m.status === 'accepted' || m.status === 'sent').map(m => m.acceptedAt).sort()[0] ?? null,
    connection: s.connection.slice(-5) };
}

module.exports = { recordAccepted, recordStatus, recordConnection, get, summary, _reset() { _s = null; } };
