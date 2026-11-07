require('dotenv').config();
const axios  = require('axios');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');
const { isQuietHours, nextMorningRelease } = require('../utils/time');

// ── Admin phone resolution ────────────────────────────────────────────────────
// Returns de-duplicated E.164 phone list of all active staff who have phones,
// merged with any explicit NOTIFY_PHONES / STUDIO_OWNER_PHONE env overrides.
// Placeholder values that must never be treated as real phone numbers
const PHONE_PLACEHOLDERS = new Set(['REPLACE_ME', '972XXXXXXXXX', 'XXXXXXXXXX', '']);

function isRealPhone(p) {
  return !!(p && !PHONE_PLACEHOLDERS.has(p) && /^[0-9]{7,15}$/.test(p));
}

function getAdminPhones() {
  const envPhones = (process.env.NOTIFY_PHONES ?? process.env.STUDIO_OWNER_PHONE ?? '')
    .split(',')
    .map(p => p.trim().replace(/^\+/, ''))
    .filter(isRealPhone);
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../data/staff_config.json'), 'utf8')
    );
    const cfgPhones = (cfg.staff ?? [])
      .filter(s => s.active && isRealPhone(s.phone))
      .map(s => s.phone);
    return [...new Set([...cfgPhones, ...envPhones])];
  } catch {
    return envPhones;
  }
}

// ── Green API credential resolution ──────────────────────────────────────────
// Canonical Railway variable names (set exactly these):
//   GREEN_API_URL              — host only, e.g. "api.green-api.com"
//   GREEN_API_ID_INSTANCE      — numeric instance ID shown in the Green API console
//   GREEN_API_TOKEN_INSTANCE   — API token shown in the Green API console
//
// Legacy / alternate names accepted as fallbacks (checked in order):
//   host:       GREEN_API_URL → GREEN_API_HOST
//   instanceId: GREEN_API_ID_INSTANCE → GREEN_API_INSTANCE_ID
//   token:      GREEN_API_TOKEN_INSTANCE → GREEN_API_API_TOKEN_INSTANCE → GREEN_API_TOKEN
//
// All values are trimmed — prevents invisible whitespace/newline in Railway vars
// from producing a 401 when the token is otherwise correct.
// Host is stripped of any accidental https:// prefix to prevent ENOTFOUND.
function _env(name) {
  const v = process.env[name];
  return v ? v.trim() : null;
}

function getGreenCreds() {
  const rawHost    = _env('GREEN_API_URL') ?? _env('GREEN_API_HOST');
  const host       = rawHost ? rawHost.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const instanceId = _env('GREEN_API_ID_INSTANCE')     ?? _env('GREEN_API_INSTANCE_ID') ?? null;
  const token      = _env('GREEN_API_TOKEN_INSTANCE')  ?? _env('GREEN_API_API_TOKEN_INSTANCE') ?? _env('GREEN_API_TOKEN') ?? null;
  return { host, instanceId, token };
}

/** Returns the Railway variable name that actually provided the token (for diagnostic logs). */
function _tokenSourceVar() {
  if (_env('GREEN_API_TOKEN_INSTANCE'))     return 'GREEN_API_TOKEN_INSTANCE';
  if (_env('GREEN_API_API_TOKEN_INSTANCE')) return 'GREEN_API_API_TOKEN_INSTANCE';
  if (_env('GREEN_API_TOKEN'))              return 'GREEN_API_TOKEN';
  return 'NOT_SET';
}

function buildSendUrl(method = 'sendMessage') {
  const { host, instanceId, token } = getGreenCreds();
  if (!host || !instanceId || !token) {
    const missing = [
      !host       && 'GREEN_API_URL (or GREEN_API_HOST)',
      !instanceId && 'GREEN_API_ID_INSTANCE (or GREEN_API_INSTANCE_ID)',
      !token      && 'GREEN_API_TOKEN_INSTANCE (or GREEN_API_TOKEN)',
    ].filter(Boolean).join(', ');
    throw new Error(`Green API credentials missing on Railway: ${missing}`);
  }
  // Guard against the common typo: "greenapi.com" (no hyphen) instead of
  // "green-api.com".  Both may resolve at the DNS level but only the hyphenated
  // domain is Green API's real API server.
  if (/greenapi\.com/i.test(host) && !/green-api\.com/i.test(host)) {
    logger.warn('[Green API] Host looks incorrect — domain should be green-api.com (with hyphen), got: ' + host);
  }
  return `https://${host}/waInstance${instanceId}/${method}/${token}`;
}

// Keep the old name so existing callers inside this file still work.
const SEND_URL = () => buildSendUrl('sendMessage');

// Green API uses auth-in-URL; no Authorization header needed.
const HEADERS = { 'Content-Type': 'application/json' };

/**
 * Probe the Green API instance state and log the result.
 * Call this at server startup so Railway logs immediately show whether
 * the credentials are correct and the WhatsApp instance is authorized.
 */
async function probeGreenApiConnection() {
  const { host, instanceId, token } = getGreenCreds();

  if (!host || !instanceId || !token) {
    logger.error('[Green API] Credentials NOT configured — WhatsApp sending is disabled', {
      GREEN_API_URL:                  _env('GREEN_API_URL')                  ? 'SET' : 'MISSING',
      GREEN_API_HOST:                 _env('GREEN_API_HOST')                 ? 'SET' : 'MISSING',
      GREEN_API_ID_INSTANCE:          _env('GREEN_API_ID_INSTANCE')          ? 'SET' : 'MISSING',
      GREEN_API_INSTANCE_ID:          _env('GREEN_API_INSTANCE_ID')          ? 'SET' : 'MISSING',
      GREEN_API_TOKEN_INSTANCE:       _env('GREEN_API_TOKEN_INSTANCE')       ? 'SET' : 'MISSING',
      GREEN_API_API_TOKEN_INSTANCE:   _env('GREEN_API_API_TOKEN_INSTANCE')   ? 'SET' : 'MISSING',
      GREEN_API_TOKEN:                _env('GREEN_API_TOKEN')                ? 'SET' : 'MISSING',
    });
    return { ok: false, reason: 'credentials missing' };
  }

  // Log the masked endpoint + which variable actually provided the token.
  // If the wrong variable is being read, this line makes it immediately visible in Railway logs.
  const maskedToken = token.length >= 10
    ? token.slice(0, 4) + '...' + token.slice(-4)
    : '(token too short — check value)';
  const tokenSourceVar = _tokenSourceVar();
  logger.info('[Green API] Probing connection', {
    host,
    instanceId,
    tokenFrom:    tokenSourceVar,
    tokenMasked:  maskedToken,
    tokenLength:  token.length,
  });

  try {
    const { data } = await axios.get(
      `https://${host}/waInstance${instanceId}/getStateInstance/${token}`,
      { timeout: 8000 }
    );
    const state = data?.stateInstance ?? 'unknown';
    if (state === 'authorized') {
      logger.info('[Green API] ✅ Instance authorized — WhatsApp sending is ACTIVE', { instanceId, state });
    } else {
      logger.warn('[Green API] ⚠️ Instance NOT authorized — messages will fail', { instanceId, state });
    }
    return { ok: state === 'authorized', state };
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    logger.error('[Green API] Probe failed', { instanceId, httpStatus: status, response: body, error: err.message });
    return { ok: false, reason: err.message };
  }
}

// Convert a plain E.164 phone (972XXXXXXXXX) to Green API chat ID format (972XXXXXXXXX@c.us).
// Idempotent — already-formatted IDs pass through unchanged.
function toChatId(phone) {
  const clean = String(phone).replace(/[\s+\-()]/g, '');
  return clean.includes('@') ? clean : `${clean}@c.us`;
}

// In-memory quiet-hours queue (replace with Redis/DB in production)
const quietQueue = [];

/**
 * Send a plain text WhatsApp message.
 * Automatically queues if quiet hours are active.
 */
async function sendText(to, text, { bypassQuietHours = false } = {}) {
  if (!bypassQuietHours && isQuietHours()) {
    logger.info('Quiet hours active — queuing message', { to });
    quietQueue.push({ to, text, queuedAt: new Date() });
    // Send an immediate acknowledgement
    await _dispatch(to, `Hey! Got your message 🙂 I'll get back to you first thing in the morning. Have a great evening!`);
    return { queued: true, releaseAt: nextMorningRelease() };
  }
  return _dispatch(to, text);
}

/**
 * Alert all admin/staff phones about a system event.
 * Sends to every active staff member with a phone in staff_config.json,
 * plus any STUDIO_OWNER_PHONE / NOTIFY_PHONES env overrides.
 * Quiet hours do NOT apply to alerts.
 */
async function alertOwner(subject, body) {
  const phones = getAdminPhones();
  if (!phones.length) {
    logger.error('alertOwner: no admin phones configured (staff_config.json or STUDIO_OWNER_PHONE)');
    return;
  }
  const message = `🚨 *Shape Studio Agent Alert*\n\n*${subject}*\n\n${body}`;
  await Promise.allSettled(
    phones.map(phone =>
      _dispatch(phone, message).catch(err =>
        logger.warn('alertOwner: dispatch failed', { phone, error: err.message })
      )
    )
  );
}

/**
 * Release all queued messages (called at 08:30 by cron job in server.js).
 */
async function releaseQueuedMessages() {
  if (quietQueue.length === 0) return;
  logger.info(`Releasing ${quietQueue.length} queued messages`);

  while (quietQueue.length > 0) {
    const { to, text } = quietQueue.shift();
    const morning = `Good morning ☀️ Hope your day is off to a great start!\n\n${text}`;
    await _dispatch(to, morning);
  }
}

async function _dispatch(to, text) {
  const chatId = toChatId(to);
  let url;
  try {
    url = SEND_URL(); // throws clearly if credentials are missing
  } catch (credErr) {
    logger.error('[Green API] Cannot send — credentials error', { to, chatId, error: credErr.message });
    throw credErr;
  }

  // Log the masked URL at INFO level BEFORE the request so Railway logs always
  // show which host is being targeted — the most common silent failure is a
  // wrong domain (e.g. greenapi.com vs green-api.com) that only surfaces here.
  const maskedUrl = url.replace(/\/[^/]{20,}$/, '/***TOKEN***');
  logger.info('[Green API] Dispatching message', { to, chatId, endpoint: maskedUrl });

  try {
    const payload = { chatId, message: text };
    const { data } = await axios.post(url, payload, { headers: HEADERS, timeout: 15000 });

    // Success path — log at INFO so it appears in Railway default log view.
    // debug() is filtered out at the default log level and would hide deliveries.
    if (data?.idMessage) {
      logger.info('[Green API] Message sent ✓', { to, chatId, idMessage: data.idMessage });
    } else {
      // Green API returned HTTP 200 but no idMessage — message was NOT queued.
      // This typically means the WhatsApp session is not authorized (needs QR scan).
      logger.warn('[Green API] Send returned 200 but no idMessage — message may NOT have been delivered', {
        to, chatId, responseData: JSON.stringify(data).slice(0, 300),
        hint: 'Check Green API console → instance state. If "notAuthorized", scan the QR code.',
      });
    }
    return data;
  } catch (err) {
    // Log the full HTTP error so Railway shows exactly what Green API returned
    const httpStatus   = err.response?.status;
    const responseBody = err.response?.data;
    const { host, instanceId } = getGreenCreds();

    logger.error('[Green API] Send failed', {
      to,
      chatId,
      httpStatus,
      responseBody,
      endpoint:     maskedUrl,
      instanceId,
      networkError: !err.response ? err.message : undefined,
      hint: httpStatus === 401
        ? 'Token rejected — verify GREEN_API_TOKEN_INSTANCE matches the API Token Instance for this instance ID in the Green API console'
        : httpStatus === 404
        ? 'Instance not found — verify GREEN_API_ID_INSTANCE and that the host URL matches the instance server'
        : !err.response
        ? 'Network error — verify GREEN_API_URL is correct (should be e.g. 7103.api.green-api.com with hyphen)'
        : undefined,
    });
    throw err;
  }
}

/**
 * Send a file (image, PDF, etc.) by public URL using Green API's sendFileByUrl endpoint.
 * The URL must be publicly reachable by Green API's servers.
 *
 * @param {string} to       — E.164 phone number (972XXXXXXXXX)
 * @param {string} fileUrl  — Publicly accessible URL of the file
 * @param {string} fileName — Filename shown in WhatsApp (e.g. "schedule.png")
 * @param {string} [caption]— Optional caption text beneath the file
 */
async function sendFileByUrl(to, fileUrl, fileName, caption = '') {
  const url = buildSendUrl('sendFileByUrl'); // uses same dual-name credential resolution
  try {
    const { data } = await axios.post(url, {
      chatId:   toChatId(to),
      urlFile:  fileUrl,
      fileName: fileName ?? 'file',
      caption:  caption,
    }, { headers: HEADERS, timeout: 20000 });
    logger.debug('[Green API] File sent', { to, fileName, idMessage: data?.idMessage });
    return data;
  } catch (err) {
    logger.error('[Green API] sendFileByUrl failed', {
      to,
      fileName,
      httpStatus:   err.response?.status,
      responseBody: err.response?.data,
      error:        err.message,
    });
    throw err;
  }
}

/**
 * Verify the webhook challenge from Meta.
 */
function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed');
  res.sendStatus(403);
}

/**
 * Parse an inbound webhook payload into a normalised message object.
 * Returns null if the payload contains no user message.
 */
function parseInbound(body) {
  try {
    const entry   = body?.entry?.[0];
    const change  = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    const contact = change?.contacts?.[0];

    if (!message || message.type !== 'text') return null;

    return {
      from:      message.from,          // E.164 number
      name:      contact?.profile?.name ?? null,
      text:      message.text.body,
      messageId: message.id,
      timestamp: new Date(parseInt(message.timestamp, 10) * 1000),
    };
  } catch {
    return null;
  }
}

/**
 * Parse an inbound webhook payload into a rich normalised message object.
 * Handles: text, image, video, audio, document, sticker, voice,
 *          location, interactive (button/list reply), reaction.
 * Returns null for status updates and unsupported event shapes.
 */
function parseInboundRich(body) {
  try {
    const entry   = body?.entry?.[0];
    const change  = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    const contact = change?.contacts?.[0];
    if (!message) return null;

    const base = {
      from:      message.from,
      name:      contact?.profile?.name ?? null,
      messageId: message.id,
      timestamp: new Date(parseInt(message.timestamp, 10) * 1000),
      type:      message.type,
    };

    switch (message.type) {
      case 'text':
        return { ...base, text: message.text?.body ?? '', mediaType: 'text', mediaCaption: null };

      case 'image':
      case 'video':
      case 'audio':
      case 'voice':
      case 'sticker': {
        const media = message[message.type] ?? {};
        return {
          ...base,
          text:          media.caption ?? `[${message.type}]`,
          mediaType:     message.type,
          mediaCaption:  media.caption ?? null,
          mediaId:       media.id ?? null,
          mediaMimeType: media.mime_type ?? null,
        };
      }

      case 'document': {
        const doc = message.document ?? {};
        return {
          ...base,
          text:          doc.caption ?? doc.filename ?? '[document]',
          mediaType:     'document',
          mediaCaption:  doc.caption ?? null,
          mediaId:       doc.id ?? null,
          mediaFilename: doc.filename ?? null,
        };
      }

      case 'location': {
        const loc = message.location ?? {};
        return {
          ...base,
          text:         `[מיקום] ${loc.name ?? ''} ${loc.address ?? `${loc.latitude},${loc.longitude}`}`.trim(),
          mediaType:    'location',
          mediaCaption: null,
          locationData: { lat: loc.latitude, lng: loc.longitude, name: loc.name, address: loc.address },
        };
      }

      case 'interactive': {
        const ir    = message.interactive ?? {};
        const reply = ir.button_reply ?? ir.list_reply ?? {};
        return {
          ...base,
          text:          reply.title ?? reply.id ?? '[interactive]',
          mediaType:     'interactive',
          mediaCaption:  ir.type ?? null,
          interactiveId: reply.id ?? null,
        };
      }

      case 'reaction': {
        const rxn = message.reaction ?? {};
        return {
          ...base,
          text:          `[reaction: ${rxn.emoji ?? '?'}]`,
          mediaType:     'reaction',
          mediaCaption:  null,
          reactionEmoji: rxn.emoji ?? null,
          reactedToId:   rxn.message_id ?? null,
        };
      }

      default:
        return { ...base, text: `[${message.type}]`, mediaType: message.type, mediaCaption: null };
    }
  } catch {
    return null;
  }
}

/**
 * Notify the courier-recruitment team about a new Meta Lead Ads lead.
 * Sends to every phone in NOTIFY_PHONES (comma-separated), falling back to STUDIO_OWNER_PHONE.
 * Quiet hours do NOT apply — leads are time-sensitive.
 */
async function notifyLeadTeam(lead, { formId, adId } = {}) {
  const phones = getAdminPhones();

  if (!phones.length) {
    logger.warn('notifyLeadTeam: no admin phones in staff_config.json or env vars');
    return;
  }

  const lines = [
    `🟢 *ליד חדש התקבל!*`,
    ``,
    `👤 שם: ${lead.name        || '—'}`,
    `📱 טלפון: ${lead.phone    || '—'}`,
    lead.email        ? `📧 ${lead.email}`                  : null,
    lead.deliveryArea ? `📍 אזור: ${lead.deliveryArea}`     : null,
    lead.vehicleType  ? `🚗 רכב: ${lead.vehicleType}`      : null,
    lead.brand        ? `🏷️ מותג: ${lead.brand}`           : null,
    ``,
    `🕐 ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`,
    formId            ? `📋 Form: ${formId}`                : null,
    adId              ? `🎯 Ad: ${adId}`                    : null,
  ].filter(l => l !== null);

  const message = lines.join('\n');

  await Promise.allSettled(
    phones.map(phone =>
      _dispatch(phone, message).catch(err =>
        logger.error('notifyLeadTeam: dispatch failed', { phone, error: err.message })
      )
    )
  );
}

/**
 * Parse an inbound webhook payload from Green API into the same normalised
 * message shape that processInboundWAMessage() and parseInboundRich() produce.
 *
 * Green API format (reference: https://green-api.com/en/docs/api/receiving/technology-webhook-endpoint/):
 * {
 *   typeWebhook:  "incomingMessageReceived",
 *   instanceData: { idInstance, wid },
 *   timestamp:    1234567890,
 *   idMessage:    "BAE5F4886F532323",
 *   senderData:   { chatId:"972XXXXXXXXX@c.us", chatName, senderName, senderContactName },
 *   messageData:  { typeMessage:"textMessage", textMessageData:{ textMessage:"..." } }
 * }
 *
 * Returns null for:
 *   - Non-incoming events (status updates, outgoing echos, state changes)
 *   - Group chat messages (chatId ends in @g.us)
 *   - Unsupported message types (polls, etc.)
 */
function parseGreenApiWebhook(body) {
  try {
    // Only process genuine incoming messages
    if (body?.typeWebhook !== 'incomingMessageReceived') return null;

    const sender  = body.senderData;
    const msgData = body.messageData;
    if (!sender?.chatId || !msgData) return null;

    // Skip group chats — only handle 1:1 messages
    if (sender.chatId.endsWith('@g.us')) return null;

    // Normalise phone: "972501234567@c.us" → "972501234567"
    const from      = sender.chatId.replace(/@.*$/, '');
    const name      = sender.senderContactName ?? sender.senderName ?? sender.chatName ?? null;
    const messageId = body.idMessage ?? null;
    const timestamp = new Date((body.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);
    const type      = msgData.typeMessage;

    switch (type) {
      case 'textMessage':
        return {
          from, name, messageId, timestamp,
          type: 'text',
          text: msgData.textMessageData?.textMessage ?? '',
          mediaType: 'text', mediaCaption: null, mediaId: null,
        };

      case 'imageMessage': {
        const img = msgData.imageMessageData ?? {};
        return {
          from, name, messageId, timestamp,
          type: 'image',
          text: img.caption ?? '[תמונה]',
          mediaType: 'image', mediaCaption: img.caption ?? null, mediaId: null,
        };
      }

      case 'videoMessage': {
        const vid = msgData.videoMessageData ?? {};
        return {
          from, name, messageId, timestamp,
          type: 'video',
          text: vid.caption ?? '[וידאו]',
          mediaType: 'video', mediaCaption: vid.caption ?? null, mediaId: null,
        };
      }

      // Voice note (ptt = push-to-talk) and regular audio
      case 'audioMessage':
      case 'pttMessage':
        return {
          from, name, messageId, timestamp,
          type: 'audio',
          text: '[הודעה קולית]',
          mediaType: 'audio', mediaCaption: null, mediaId: null,
        };

      case 'documentMessage': {
        const doc = msgData.documentMessageData ?? {};
        return {
          from, name, messageId, timestamp,
          type: 'document',
          text: doc.caption ?? doc.fileName ?? '[מסמך]',
          mediaType: 'document', mediaCaption: doc.caption ?? null, mediaId: null,
        };
      }

      case 'locationMessage': {
        const loc = msgData.locationMessageData ?? {};
        const label = [loc.nameLocation, loc.address].filter(Boolean).join(' ')
                   || `${loc.latitude ?? ''},${loc.longitude ?? ''}`;
        return {
          from, name, messageId, timestamp,
          type: 'location',
          text: `[מיקום] ${label}`.trim(),
          mediaType: 'location', mediaCaption: null, mediaId: null,
        };
      }

      case 'contactMessage':
        return {
          from, name, messageId, timestamp,
          type: 'contact',
          text: '[איש קשר]', mediaType: 'contact', mediaCaption: null, mediaId: null,
        };

      case 'reactionMessage': {
        // Green API reaction: { reactionMessage: { messageId: "...", text: "👍" } }
        // isReaction:true is the flag that processInboundWAMessage checks to skip AI routing.
        const rxn = msgData.reactionMessage ?? {};
        return {
          from, name, messageId, timestamp,
          type:          'reaction',
          text:          rxn.text ? `[reaction: ${rxn.text}]` : '[reaction]',
          mediaType:     'reaction',
          mediaCaption:  null,
          mediaId:       null,
          reactionEmoji: rxn.text        ?? null,
          reactedToId:   rxn.messageId   ?? null,
          isReaction:    true,
        };
      }

      default:
        // extendedTextMessage (links with previews) — treat as plain text
        if (msgData.extendedTextMessageData?.text) {
          return {
            from, name, messageId, timestamp,
            type: 'text',
            text: msgData.extendedTextMessageData.text,
            mediaType: 'text', mediaCaption: null, mediaId: null,
          };
        }
        logger.debug('parseGreenApiWebhook: unsupported typeMessage — skipping', { type, from });
        return null;
    }
  } catch (err) {
    logger.error('parseGreenApiWebhook exception', { error: err.message });
    return null;
  }
}

module.exports = { sendText, sendFileByUrl, alertOwner, notifyLeadTeam, releaseQueuedMessages, verifyWebhook, parseInbound, parseInboundRich, parseGreenApiWebhook, probeGreenApiConnection, getGreenCreds, _tokenSourceVar };
