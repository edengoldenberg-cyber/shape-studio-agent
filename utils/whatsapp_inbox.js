'use strict';

/**
 * WhatsApp Inbox — in-memory ring buffer for inbound messages,
 * with thread-based grouping for the dashboard chat interface.
 *
 * Flat message shape (backward-compatible):
 *   { id, from, fromIsraeli, name, text, mediaType, messageId,
 *     timestamp, receivedAt, clientMatch, intent, route, barakReply, readAt }
 *
 * Thread shape:
 *   { phone, name, fromIsraeli, lastText, lastAt, unreadCount, clientMatch, messages[] }
 *
 * Thread message shape:
 *   { id, direction: 'in'|'out', text, timestamp, intent, route,
 *     agentId, mediaType, clientMatch }
 */

const MAX_MESSAGES = 300;

class WhatsAppInbox {
  constructor() {
    this._msgs       = [];          // flat ring buffer (all existing endpoints still work)
    this._unread     = 0;           // global unread count
    this._threads    = new Map();   // phone → thread object
    this._seenIds    = new Set();   // idMessage deduplication for history sync
    this._lastSync   = null;        // last greenapi sync result
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _getOrCreateThread(phone, name, fromIsraeli) {
    if (!this._threads.has(phone)) {
      this._threads.set(phone, {
        phone,
        name:        name ?? phone,
        fromIsraeli: fromIsraeli ?? null,
        lastText:    '',
        lastAt:      new Date(),
        unreadCount: 0,
        clientMatch: null,
        messages:    [],
      });
    }
    const t = this._threads.get(phone);
    if (name && name !== phone) t.name = name;
    if (fromIsraeli) t.fromIsraeli = fromIsraeli;
    return t;
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  push(msg) {
    const id    = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry = { id, ...msg, readAt: null };

    // Flat ring buffer (all existing endpoints rely on this)
    this._msgs.push(entry);
    if (this._msgs.length > MAX_MESSAGES) this._msgs.shift();
    this._unread++;

    // Thread update
    const phone = msg.from;
    if (phone) {
      const thread = this._getOrCreateThread(phone, msg.name, msg.fromIsraeli);

      // Inbound message
      thread.messages.push({
        id,
        direction:   'in',
        text:        msg.text ?? '',
        timestamp:   msg.receivedAt ? new Date(msg.receivedAt) : new Date(),
        intent:      msg.intent      ?? null,
        route:       msg.route       ?? null,
        mediaType:   msg.mediaType   ?? null,
        clientMatch: msg.clientMatch ?? null,
      });

      // Outbound (barakReply) stored as a second message in the same thread
      if (msg.barakReply) {
        thread.messages.push({
          id:        `${id}-reply`,
          direction: 'out',
          text:      msg.barakReply,
          timestamp: new Date(),
          agentId:   'barak',
        });
        thread.lastText = msg.barakReply.slice(0, 60);
      } else {
        thread.lastText = (msg.text ?? '').slice(0, 60);
      }

      thread.lastAt      = new Date();
      thread.unreadCount++;
      if (msg.clientMatch) thread.clientMatch = msg.clientMatch;
    }

    return entry;
  }

  /** Add a message sent outbound from the dashboard (manual reply). */
  pushOutbound({ phone, name, text, agentId = 'manual', fromIsraeli = null }) {
    const thread = this._getOrCreateThread(phone, name, fromIsraeli);
    const id     = `wa-out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    thread.messages.push({
      id,
      direction: 'out',
      text,
      timestamp: new Date(),
      agentId,
    });
    thread.lastText = text.slice(0, 60);
    thread.lastAt   = new Date();
    return id;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  get(id) { return this._msgs.find(m => m.id === id) ?? null; }

  getAll({ limit = 50, unreadOnly = false } = {}) {
    let list = this._msgs.slice().reverse();
    if (unreadOnly) list = list.filter(m => !m.readAt);
    return list.slice(0, limit);
  }

  getByPhone(phone, { limit = 20 } = {}) {
    return this._msgs
      .filter(m => m.from === phone || m.fromIsraeli === phone)
      .slice(-limit)
      .reverse();
  }

  getById(id) { return this._msgs.find(m => m.id === id) ?? null; }

  /** All threads sorted newest-first. */
  getThreads({ limit = 60 } = {}) {
    return Array.from(this._threads.values())
      .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt))
      .slice(0, limit);
  }

  /** Full thread object including complete messages array. Returns null if not found. */
  getThread(phone) {
    return this._threads.get(phone) ?? null;
  }

  // ── Marks ───────────────────────────────────────────────────────────────────

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
    this._threads.forEach(t => { t.unreadCount = 0; });
  }

  /** Mark all inbound messages in one thread as read. */
  markThreadRead(phone) {
    const thread = this._threads.get(phone);
    if (!thread) return;
    const wasUnread    = thread.unreadCount;
    thread.unreadCount = 0;
    this._unread       = Math.max(0, this._unread - wasUnread);
    const now = new Date();
    this._msgs.forEach(m => { if (m.from === phone && !m.readAt) m.readAt = now; });
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

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
      threads:       this._threads.size,
      intentCounts,
      routeCounts,
      lastMessageAt: this._msgs.at(-1)?.receivedAt ?? null,
    };
  }

  // ── History sync ────────────────────────────────────────────────────────────

  /**
   * Load a single pre-parsed history message into the thread store.
   * Called by greenapi.service syncToInbox() — does NOT touch the flat ring
   * buffer or increment global unread (history messages are already "seen").
   *
   * @param {{ phone, direction, text, timestamp, mediaType, idMessage, senderName, agentId }}
   * @returns {boolean} true if added, false if duplicate or invalid
   */
  loadMessage({ phone, direction, text, timestamp, mediaType, idMessage, senderName, agentId }) {
    if (!phone || text === undefined || text === null) return false;

    // Deduplication — skip if we've already loaded this message ID
    if (idMessage) {
      if (this._seenIds.has(idMessage)) return false;
      this._seenIds.add(idMessage);
    }

    const thread = this._getOrCreateThread(phone, senderName, null);

    const msgObj = {
      id:          idMessage ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      direction:   direction ?? 'in',
      text:        String(text),
      timestamp:   timestamp instanceof Date ? timestamp : new Date(timestamp ?? Date.now()),
      mediaType:   mediaType   ?? null,
      agentId:     direction === 'out' ? (agentId ?? 'green-api') : null,
      intent:      null,
      route:       null,
      clientMatch: null,
    };

    thread.messages.push(msgObj);

    // Keep messages in chronological order
    thread.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Update thread summary to reflect the most recent message
    const last = thread.messages[thread.messages.length - 1];
    thread.lastText = (last.text ?? '').slice(0, 60);
    thread.lastAt   = last.timestamp;

    return true;
  }

  /** Store the result metadata from the last Green API sync. */
  recordSyncResult(result) {
    this._lastSync = { ...result, recordedAt: new Date() };
  }

  /** Return last sync metadata for the status endpoint. */
  getSyncStatus() {
    return {
      lastSync:    this._lastSync,
      seenIds:     this._seenIds.size,
      threadCount: this._threads.size,
    };
  }

  clear() {
    this._msgs    = [];
    this._unread  = 0;
    this._threads = new Map();
    this._seenIds = new Set();
    this._lastSync = null;
  }
}

module.exports = new WhatsAppInbox();
