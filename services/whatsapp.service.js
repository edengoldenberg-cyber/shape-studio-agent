require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');
const { isQuietHours, nextMorningRelease } = require('../utils/time');

// Evaluated lazily — fails loudly at call-time if credentials are missing, not silently at boot.
// GREEN_API_URL  : host portion only, e.g. "1103.api.green-api.com"
// GREEN_API_INSTANCE_ID : numeric instance ID shown in your Green API console
// GREEN_API_TOKEN       : API token shown in your Green API console
const SEND_URL = () => {
  const host       = process.env.GREEN_API_URL;
  const instanceId = process.env.GREEN_API_INSTANCE_ID;
  const token      = process.env.GREEN_API_TOKEN;
  if (!host || !instanceId || !token) {
    throw new Error('Green API credentials not configured (GREEN_API_URL / GREEN_API_INSTANCE_ID / GREEN_API_TOKEN)');
  }
  return `https://${host}/waInstance${instanceId}/sendMessage/${token}`;
};

// Green API uses auth-in-URL; no Authorization header needed.
const HEADERS = { 'Content-Type': 'application/json' };

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
 * Alert the studio owner — always sent immediately, quiet hours do NOT apply.
 */
async function alertOwner(subject, body) {
  const ownerPhone = process.env.STUDIO_OWNER_PHONE;
  if (!ownerPhone) {
    logger.error('STUDIO_OWNER_PHONE not configured — cannot send owner alert');
    return;
  }
  const message = `🚨 *Shape Studio Agent Alert*\n\n*${subject}*\n\n${body}`;
  return _dispatch(ownerPhone, message);
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
  try {
    const payload = {
      chatId:  toChatId(to),
      message: text,
    };
    const { data } = await axios.post(SEND_URL(), payload, { headers: HEADERS });
    logger.debug('WhatsApp message sent via Green API', { to, idMessage: data?.idMessage });
    return data;
  } catch (err) {
    logger.error('WhatsApp send failed', { to, error: err.response?.data ?? err.message });
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
  const phones = (process.env.NOTIFY_PHONES ?? process.env.STUDIO_OWNER_PHONE ?? '')
    .split(',')
    .map(p => p.trim().replace(/^\+/, ''))
    .filter(Boolean);

  if (!phones.length) {
    logger.warn('notifyLeadTeam: no phones configured (NOTIFY_PHONES / STUDIO_OWNER_PHONE)');
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

module.exports = { sendText, alertOwner, notifyLeadTeam, releaseQueuedMessages, verifyWebhook, parseInbound, parseInboundRich };
