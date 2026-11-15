'use strict';

/**
 * dana_notify.js — ONE "package ready" notification per package version.
 *
 * The sender is MOCKED by default: the message is recorded in
 * DATA_DIR/dana/notifications.jsonl and nothing leaves the server.
 * A real WhatsApp message is sent only when BOTH are set, and only to the owner phone:
 *   DANA_NOTIFY_REAL=true      (separate, explicit authorization by the owner)
 *   DANA_NOTIFY_PHONE=<phone>
 * The message is a link to the review page. A reply to it approves nothing.
 */

const fs   = require('fs');
const path = require('path');

const logFile = () => path.join(require('./dana_studio').dir(), 'notifications.jsonl');
const realEnabled = () => process.env.DANA_NOTIFY_REAL === 'true' && /^\d{10,15}$/.test(process.env.DANA_NOTIFY_PHONE || '');

function baseUrl() {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

function buildMessage(project, version) {
  const open = (version.package?.failed_checks ?? []).length;
  const link = baseUrl() ? `${baseUrl()}/dana-studio.html#${project.id}` : `(פתח/י את הפאנל → דנה סטודיו → ${project.title})`;
  return [`🎬 דנה: חבילת פרסום מוכנה לבדיקה — "${project.title}" (גרסה ${version.n})`,
          open ? `⚠️ ${open} בדיקות אוטומטיות דורשות החלטה שלך.` : '✅ כל הבדיקות האוטומטיות עברו.',
          `לצפייה ולאישור: ${link}`,
          'אישור ניתן רק בדף הבדיקה. תשובה להודעה הזו אינה מאשרת פרסום.'].join('\n');
}

async function packageReady(project, version) {
  const studio = require('./dana_studio');
  if (version.notifiedAt) return { sent: false, reason: 'already_notified' };       // exactly once per version
  const text = buildMessage(project, version);
  const mode = realEnabled() ? 'real' : 'mock';
  version.notifiedAt = new Date().toISOString();
  version.notifyMode = mode;
  studio.save();                                                                     // persist BEFORE sending → no duplicate after a restart
  const record = { at: version.notifiedAt, mode, projectId: project.id, version: version.n, text,
                   to: mode === 'real' ? process.env.DANA_NOTIFY_PHONE : '(mock — not sent)' };
  let outcome = 'recorded';
  if (mode === 'real') {
    try { await require('./whatsapp.service').sendText(process.env.DANA_NOTIFY_PHONE, text, { linkPreview: false }); outcome = 'sent'; }
    catch (e) { outcome = 'uncertain: ' + e.message; }                               // never re-sent automatically
  }
  try { fs.appendFileSync(logFile(), JSON.stringify({ ...record, outcome }) + '\n'); } catch { /* log only */ }
  return { sent: mode === 'real', mode, outcome };
}

function sentLog() {
  try { return fs.readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

module.exports = { packageReady, buildMessage, sentLog, realEnabled };
