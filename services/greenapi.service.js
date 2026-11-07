'use strict';

/**
 * greenapi.service.js — Green API history sync for Shape Studio dashboard.
 *
 * Fetches recent message history from the connected Green API instance and
 * populates the WhatsApp inbox thread store so the dashboard immediately
 * reflects active chats shown in the Green API console.
 *
 * Docs: https://green-api.com/en/docs/api/
 *
 * Required env vars (same ones used by whatsapp.service.js):
 *   GREEN_API_URL           — host only, e.g. "1103.api.green-api.com"
 *   GREEN_API_INSTANCE_ID   — numeric instance ID from the console
 *   GREEN_API_TOKEN         — API token from the console
 *
 * Optional env vars:
 *   GREEN_SYNC_MINUTES      — look-back window in minutes (default: 1440 = 24h)
 *   GREEN_SYNC_PER_CHAT     — max messages per chat (default: 50)
 */

const axios  = require('axios');
const logger = require('../utils/logger');

// ── Credential helpers ────────────────────────────────────────────────────────

// ── Credential resolution — MUST stay in sync with whatsapp.service.js ───────
// Canonical Railway variables (set exactly these):
//   GREEN_API_URL              — host only, e.g. "api.green-api.com"
//   GREEN_API_ID_INSTANCE      — numeric instance ID from the Green API console
//   GREEN_API_TOKEN_INSTANCE   — API token from the Green API console
//
// Fallback aliases accepted in this exact priority order (same as whatsapp.service.js
// to prevent split-brain when both variables are set and only one is updated):
//   instanceId: GREEN_API_ID_INSTANCE → GREEN_API_INSTANCE_ID
//   token:      GREEN_API_TOKEN_INSTANCE → GREEN_API_API_TOKEN_INSTANCE → GREEN_API_TOKEN
//
// All values are trimmed — prevents invisible whitespace causing 401.
function _env(name) {
  const v = process.env[name];
  return v ? v.trim() : null;
}

function sanitiseHost(raw) {
  if (!raw) return null;
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function getConfig() {
  const host       = sanitiseHost(_env('GREEN_API_URL') ?? _env('GREEN_API_HOST'));
  const instanceId = _env('GREEN_API_ID_INSTANCE')    ?? _env('GREEN_API_INSTANCE_ID')      ?? null;
  const token      = _env('GREEN_API_TOKEN_INSTANCE') ?? _env('GREEN_API_API_TOKEN_INSTANCE') ?? _env('GREEN_API_TOKEN') ?? null;
  if (!host || !instanceId || !token) return null;
  return {
    base:  `https://${host}/waInstance${instanceId}`,
    token,
    instanceId,
  };
}

function isConfigured() {
  const host       = _env('GREEN_API_URL') ?? _env('GREEN_API_HOST');
  const instanceId = _env('GREEN_API_ID_INSTANCE')    ?? _env('GREEN_API_INSTANCE_ID');
  const token      = _env('GREEN_API_TOKEN_INSTANCE') ?? _env('GREEN_API_API_TOKEN_INSTANCE') ?? _env('GREEN_API_TOKEN');
  return !!(host && instanceId && token);
}

// ── Low-level Green API calls ─────────────────────────────────────────────────

/**
 * Probe the instance state.
 * Returns 'authorized' | 'notAuthorized' | 'blocked' | 'sleeping' | null.
 */
async function getInstanceState() {
  const cfg = getConfig();
  if (!cfg) return null;
  const tokenVar = _env('GREEN_API_TOKEN_INSTANCE')     ? 'GREEN_API_TOKEN_INSTANCE'
                 : _env('GREEN_API_API_TOKEN_INSTANCE') ? 'GREEN_API_API_TOKEN_INSTANCE'
                 : 'GREEN_API_TOKEN';
  try {
    const { data } = await axios.get(
      `${cfg.base}/getStateInstance/${cfg.token}`,
      { timeout: 8000 }
    );
    return data?.stateInstance ?? null;
  } catch (err) {
    const status = err.response?.status;
    logger.warn('[green-sync] getStateInstance failed', {
      error:        err.message,
      httpStatus:   status,
      instanceId:   cfg.instanceId,
      tokenFrom:    tokenVar,
      tokenLength:  cfg.token.length,
      hint: status === 401
        ? 'Token rejected — verify GREEN_API_TOKEN_INSTANCE matches the API Token Instance in the Green API console for this instance ID'
        : undefined,
    });
    return null;
  }
}

/**
 * GET lastIncomingMessages — returns up to ~20 incoming messages from the
 * last `minutes` minutes. No body, minutes is a query param.
 */
async function fetchLastIncoming(minutes = 1440) {
  const cfg = getConfig();
  if (!cfg) return [];
  try {
    const { data } = await axios.get(
      `${cfg.base}/lastIncomingMessages/${cfg.token}`,
      { params: { minutes }, timeout: 15000 }
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('[green-sync] lastIncomingMessages failed', { error: err.message });
    return [];
  }
}

/**
 * GET lastOutgoingMessages — same but for outgoing.
 */
async function fetchLastOutgoing(minutes = 1440) {
  const cfg = getConfig();
  if (!cfg) return [];
  try {
    const { data } = await axios.get(
      `${cfg.base}/lastOutgoingMessages/${cfg.token}`,
      { params: { minutes }, timeout: 15000 }
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('[green-sync] lastOutgoingMessages failed', { error: err.message });
    return [];
  }
}

/**
 * POST getChatHistory — full history for one chatId (both directions).
 * Returns up to `count` messages, newest first.
 */
async function fetchChatHistory(chatId, count = 50) {
  const cfg = getConfig();
  if (!cfg) return [];
  try {
    const { data } = await axios.post(
      `${cfg.base}/getChatHistory/${cfg.token}`,
      { chatId, count },
      { timeout: 15000 }
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    // 403 means this endpoint isn't available on the current plan — degrade gracefully
    const status = err.response?.status;
    logger.warn('[green-sync] getChatHistory failed', { chatId, status, error: err.message });
    return [];
  }
}

// ── Message parsing ───────────────────────────────────────────────────────────

/**
 * Convert a raw Green API history message (from lastIncoming/Outgoing or
 * getChatHistory) into the inbox thread message shape.
 *
 * Returns null for group chats, unsupported types, or parse errors.
 *
 * Raw shape (both endpoints share this structure):
 * {
 *   type:        "incoming" | "outgoing",
 *   idMessage:   "BAE5F4886F532323",
 *   timestamp:   1234567890,          // unix seconds
 *   typeMessage: "textMessage" | "imageMessage" | ...,
 *   chatId:      "972XXXXXXXXX@c.us",
 *   textMessage: "...",               // for text
 *   caption:     "...",               // for media
 *   fileName:    "...",               // for documents
 *   senderName:  "...",               // for incoming
 *   senderId:    "..."
 * }
 */
function parseHistoryMsg(raw) {
  try {
    const chatId = raw.chatId ?? raw.senderId ?? null;
    if (!chatId) return null;

    // Skip groups and broadcast lists
    if (chatId.endsWith('@g.us') || chatId.endsWith('@lid')) return null;

    const phone     = chatId.replace(/@.*$/, '');
    const direction = raw.type === 'outgoing' ? 'out' : 'in';
    const timestamp = raw.timestamp
      ? new Date(raw.timestamp * 1000)
      : new Date();
    const idMessage = raw.idMessage ?? null;
    const typMsg    = raw.typeMessage ?? 'textMessage';

    let text      = '';
    let mediaType = null;

    switch (typMsg) {
      case 'textMessage':
        text      = raw.textMessage ?? raw.text ?? '';
        break;
      case 'extendedTextMessage':
        text      = raw.extendedTextMessageData?.text ?? raw.textMessage ?? raw.text ?? '';
        break;
      case 'imageMessage':
        text      = raw.caption ?? '[תמונה]';
        mediaType = 'image';
        break;
      case 'videoMessage':
        text      = raw.caption ?? '[וידאו]';
        mediaType = 'video';
        break;
      case 'audioMessage':
      case 'pttMessage':
        text      = '[הודעה קולית]';
        mediaType = 'audio';
        break;
      case 'documentMessage':
        text      = raw.caption ?? raw.fileName ?? '[מסמך]';
        mediaType = 'document';
        break;
      case 'locationMessage':
        text      = `[מיקום] ${raw.nameLocation ?? ''}`.trim();
        mediaType = 'location';
        break;
      case 'contactMessage':
        text      = '[איש קשר]';
        mediaType = 'contact';
        break;
      default:
        // Catch-all: try to extract any text field
        text      = raw.textMessage ?? raw.caption ?? raw.text ?? `[${typMsg}]`;
        mediaType = typMsg !== 'textMessage' ? typMsg : null;
    }

    return {
      phone,
      direction,
      text,
      timestamp,
      mediaType,
      idMessage,
      senderName: raw.senderName ?? raw.senderContactName ?? null,
      agentId:    direction === 'out' ? 'green-api' : null,
    };
  } catch (err) {
    logger.warn('[green-sync] parseHistoryMsg error', { error: err.message });
    return null;
  }
}

// ── Main sync ─────────────────────────────────────────────────────────────────

/**
 * Sync Green API message history into the WhatsApp inbox thread store.
 *
 * Strategy:
 *  1. Probe instance state — bail if not authorized.
 *  2. Fetch lastIncomingMessages + lastOutgoingMessages to discover active chatIds.
 *  3. For each unique chatId, fetch getChatHistory to get the full conversation.
 *  4. Parse each message and load into inbox threads (deduplicated by idMessage).
 *
 * @param {object}  inbox                   — WhatsAppInbox singleton
 * @param {object}  [opts]
 * @param {number}  opts.minutes            — look-back window (default from env or 1440)
 * @param {number}  opts.perChatCount       — messages per chat (default from env or 50)
 * @param {boolean} opts.deepHistory        — fetch getChatHistory per chat (default true)
 * @param {number}  opts.chatDelay          — ms delay between getChatHistory calls (default 150)
 *
 * @returns {{ ok, chats, messages, skipped, errors, state, syncedAt }}
 */
async function syncToInbox(inbox, {
  minutes      = parseInt(process.env.GREEN_SYNC_MINUTES   ?? '1440', 10),
  perChatCount = parseInt(process.env.GREEN_SYNC_PER_CHAT  ?? '50',   10),
  deepHistory  = true,
  chatDelay    = 150,
} = {}) {
  if (!isConfigured()) {
    return { ok: false, reason: 'Green API credentials not configured (GREEN_API_URL / GREEN_API_INSTANCE_ID / GREEN_API_TOKEN)' };
  }

  // 1. Probe instance state
  const state = await getInstanceState();
  if (state && state !== 'authorized') {
    logger.warn('[green-sync] Instance not authorized', { state });
    return { ok: false, reason: `Instance state: ${state}`, state };
  }

  logger.info('[green-sync] Starting sync', { minutes, perChatCount, deepHistory });

  // 2. Discover active chat IDs from last N minutes
  const [rawIn, rawOut] = await Promise.all([
    fetchLastIncoming(minutes),
    fetchLastOutgoing(minutes),
  ]);

  const chatIds = new Set();
  [...rawIn, ...rawOut].forEach(m => {
    const id = m.chatId ?? m.senderId;
    if (id && !id.endsWith('@g.us') && !id.endsWith('@lid')) chatIds.add(id);
  });

  logger.info('[green-sync] Active chats discovered', {
    chats: chatIds.size,
    rawIncoming: rawIn.length,
    rawOutgoing: rawOut.length,
  });

  const result = { ok: true, chats: 0, messages: 0, skipped: 0, errors: 0, state, syncedAt: new Date() };

  if (deepHistory && chatIds.size > 0) {
    // 3. Per-chat deep history fetch
    for (const chatId of chatIds) {
      try {
        const history = await fetchChatHistory(chatId, perChatCount);

        if (!history.length) {
          // getChatHistory returned nothing — fall back to lastIncoming/Outgoing for this chat
          [...rawIn, ...rawOut]
            .filter(m => (m.chatId ?? m.senderId) === chatId)
            .forEach(raw => {
              const parsed = parseHistoryMsg(raw);
              if (!parsed) return;
              inbox.loadMessage(parsed) ? result.messages++ : result.skipped++;
            });
        } else {
          history.forEach(raw => {
            const parsed = parseHistoryMsg(raw);
            if (!parsed) return;
            inbox.loadMessage(parsed) ? result.messages++ : result.skipped++;
          });
        }
        result.chats++;
      } catch (err) {
        logger.warn('[green-sync] Error syncing chat', { chatId, error: err.message });
        result.errors++;
      }

      // Polite delay to avoid hammering the API
      if (chatDelay > 0) await new Promise(r => setTimeout(r, chatDelay));
    }
  } else {
    // Shallow path: only use lastIncoming/Outgoing arrays
    [...rawIn, ...rawOut].forEach(raw => {
      const parsed = parseHistoryMsg(raw);
      if (!parsed) return;
      inbox.loadMessage(parsed) ? result.messages++ : result.skipped++;
    });
    result.chats = chatIds.size;
  }

  // Store result metadata on the inbox so the status endpoint can report it
  inbox.recordSyncResult(result);

  logger.info('[green-sync] Sync complete', result);
  return result;
}

module.exports = {
  syncToInbox,
  isConfigured,
  getInstanceState,
  parseHistoryMsg,
  fetchLastIncoming,
  fetchLastOutgoing,
  fetchChatHistory,
};
