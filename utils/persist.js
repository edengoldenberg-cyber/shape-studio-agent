'use strict';

/**
 * persist.js — JSON file snapshots for lead_store and whatsapp_inbox.
 *
 * Without a Railway Volume the DATA_DIR lives inside the container image and
 * is wiped on every redeploy. Mount a Volume at /data and set DATA_DIR=/data
 * in Railway Variables for true deploy-safe persistence.
 *
 * Usage in server.js:
 *   const persist = require('./utils/persist');
 *   persist.loadLeads(store);          // on startup
 *   persist.loadInbox(inbox);          // on startup
 *   persist.saveLeads(store);          // after mutations
 *   persist.saveInbox(inbox);          // after mutations
 *   setInterval(() => { persist.saveAll(store, inbox); }, 60_000); // periodic
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const DATA_DIR   = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
const LEADS_FILE = path.join(DATA_DIR, 'leads_persist.json');
const INBOX_FILE = path.join(DATA_DIR, 'inbox_persist.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Atomic write: write to .tmp then rename so a crash never leaves a corrupt file. */
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── Leads ─────────────────────────────────────────────────────────────────────

function saveLeads(store) {
  try {
    ensureDir();
    atomicWrite(LEADS_FILE, {
      leads:   Array.from(store._leads.entries()),
      members: Array.from(store._members.entries()),
      events:  store._events.slice(-500),
      savedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    logger.warn('[persist] saveLeads failed', { error: err.message });
    return false;
  }
}

function loadLeads(store) {
  try {
    if (!fs.existsSync(LEADS_FILE)) {
      logger.info('[persist] No leads snapshot — starting fresh');
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    for (const [k, v] of raw.leads   ?? []) store._leads.set(k, v);
    for (const [k, v] of raw.members ?? []) store._members.set(k, v);
    if (raw.events?.length) store._events.push(...raw.events);
    logger.info('[persist] Leads snapshot restored', {
      leads:   store._leads.size,
      members: store._members.size,
      events:  store._events.length,
      savedAt: raw.savedAt,
    });
    return true;
  } catch (err) {
    logger.warn('[persist] loadLeads failed — starting fresh', { error: err.message });
    return false;
  }
}

// ── Inbox ─────────────────────────────────────────────────────────────────────

function saveInbox(inbox) {
  try {
    ensureDir();
    atomicWrite(INBOX_FILE, {
      threads: Array.from(inbox._threads.entries()).map(([phone, t]) => ({
        phone,
        thread: { ...t, messages: t.messages.slice(-100) },
      })),
      seenIds: Array.from(inbox._seenIds),
      savedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    logger.warn('[persist] saveInbox failed', { error: err.message });
    return false;
  }
}

function loadInbox(inbox) {
  try {
    if (!fs.existsSync(INBOX_FILE)) {
      logger.info('[persist] No inbox snapshot — starting fresh');
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'));
    for (const { phone, thread } of raw.threads ?? []) {
      thread.lastAt   = new Date(thread.lastAt);
      thread.messages = (thread.messages ?? []).map(m => ({
        ...m, timestamp: new Date(m.timestamp),
      }));
      inbox._threads.set(phone, thread);
    }
    for (const id of raw.seenIds ?? []) inbox._seenIds.add(id);
    logger.info('[persist] Inbox snapshot restored', {
      threads: inbox._threads.size,
      seenIds: inbox._seenIds.size,
      savedAt: raw.savedAt,
    });
    return true;
  } catch (err) {
    logger.warn('[persist] loadInbox failed — starting fresh', { error: err.message });
    return false;
  }
}

function saveAll(store, inbox) {
  saveLeads(store);
  saveInbox(inbox);
}

module.exports = { saveLeads, loadLeads, saveInbox, loadInbox, saveAll, DATA_DIR };
