'use strict';

/**
 * WhatsApp Inbox — in-memory ring buffer for inbound client messages.
 * Capped at MAX_MESSAGES entries; newest-first on read.
 *
 * Message shape:
 * {
 *   id, from, fromIsraeli, name, text,
 *   mediaType, mediaCaption, mediaId, messageId,
 *   timestamp, receivedAt,
 *   clientMatch: { found, matchType, arboxName, arboxId, isActive, role },
 *   intent, route, barakReply,
 *   readAt
 * }
 */

const MAX_MESSAGES = 300;

class WhatsAppInbox {
  constructor() {
    this._msgs   = [];
    this._unread = 0;
  }

  push(msg) {
    const id    = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry = { id, ...msg, readAt: null };
    this._msgs.push(entry);
    if (this._msgs.length > MAX_MESSAGES) this._msgs.shift();
    this._unread++;
    return entry;
  }

  getAll({ limit = 50, unreadOnly = false } = {}) {
    let list = this._msgs.slice().reverse(); // newest first
    if (unreadOnly) list = list.filter(m => !m.readAt);
    return list.slice(0, limit);
  }

  getByPhone(phone, { limit = 20 } = {}) {
    return this._msgs
      .filter(m => m.from === phone || m.fromIsraeli === phone)
      .slice(-limit)
      .reverse();
  }

  getById(id) {
    return this._msgs.find(m => m.id === id) ?? null;
  }

  markRead(id) {
    const m = this._msgs.find(m => m.id === id);
    if (m && !m.readAt) {
      m.readAt = new Date();
      this._unread = Math.max(0, this._unread - 1);
    }
    return m ?? null;
  }

  markAllRead() {
    const now = new Date();
    this._msgs.forEach(m => { if (!m.readAt) m.readAt = now; });
    this._unread = 0;
  }

  getStats() {
    const intentCounts = {};
    const routeCounts  = {};
    this._msgs.forEach(m => {
      intentCounts[m.intent ?? 'general'] = (intentCounts[m.intent ?? 'general'] || 0) + 1;
      routeCounts[m.route   ?? 'none']    = (routeCounts[m.route   ?? 'none']    || 0) + 1;
    });
    return {
      total:         this._msgs.length,
      unread:        this._unread,
      intentCounts,
      routeCounts,
      lastMessageAt: this._msgs.at(-1)?.receivedAt ?? null,
    };
  }

  clear() { this._msgs = []; this._unread = 0; }
}

module.exports = new WhatsAppInbox();
