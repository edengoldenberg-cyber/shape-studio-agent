'use strict';

/**
 * dana_notify.js — ONE "ready for owner review" notification per reviewable package version.
 *
 * Default: MOCK. The message is recorded in DATA_DIR/dana/notifications.jsonl and nothing is sent.
 * A real WhatsApp message (existing Green API integration, whatsapp.service.sendText) is sent only
 * when ALL of these hold:
 *   DANA_NOTIFY_REAL=true             separate, explicit owner authorization
 *   DANA_NOTIFY_PHONE=<digits>        the owner/manager number — one recipient, nobody else
 *   a public base URL is configured   BACKEND_URL or RAILWAY_PUBLIC_DOMAIN, so the link opens the
 *                                     AUTHENTICATED review page (login first, then the package)
 * Rules:
 *   • once per version: the version is stamped on disk BEFORE sending, so a restart cannot resend;
 *   • a send whose outcome is unknown is recorded as "uncertain" and is NOT repeated automatically;
 *   • during quiet hours (22:00–08:00 Israel by default) nothing is sent: the notification waits and
 *     goes out at the next flush() after quiet hours — the shared "queued reply" path is not used;
 *   • the text never contains the caption, the video or any credential — only a title and a link;
 *   • a reply to the message approves nothing.
 */

const fs   = require('fs');
const path = require('path');

const studio  = () => require('./dana_studio');
const logFile = () => path.join(studio().dir(), 'notifications.jsonl');
const phone   = () => String(process.env.DANA_NOTIFY_PHONE || '').replace(/[^\d]/g, '');

function baseUrl() {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}
const realEnabled = () => process.env.DANA_NOTIFY_REAL === 'true' && /^\d{10,15}$/.test(phone()) && !!baseUrl();

/** What is configured, without revealing more than the last four digits of the number. */
function status() {
  const p = phone();
  return { mode: realEnabled() ? 'real' : 'mock', switchOn: process.env.DANA_NOTIFY_REAL === 'true',
    recipientConfigured: /^\d{10,15}$/.test(p), recipientTail: p ? p.slice(-4) : null, baseUrlConfigured: !!baseUrl(),
    link: baseUrl() ? `${baseUrl()}/dana-studio.html#<project>` : null, quietHoursNow: quiet(),
    pending: pendingVersions().length,
    why: realEnabled() ? null : [process.env.DANA_NOTIFY_REAL !== 'true' && 'DANA_NOTIFY_REAL is not "true"', !/^\d{10,15}$/.test(p) && 'DANA_NOTIFY_PHONE is not set',
      !baseUrl() && 'no public base URL (BACKEND_URL / RAILWAY_PUBLIC_DOMAIN)'].filter(Boolean) };
}
function quiet() { try { return require('../utils/time').isQuietHours(); } catch { return false; } }

function buildMessage(project, version) {
  const open = (version.package?.review_items ?? version.package?.failed_checks ?? []).length;
  const link = baseUrl() ? `${baseUrl()}/dana-studio.html#${project.id}` : `(פתח/י את הפאנל → דנה סטודיו → ${project.title})`;
  return [`🎬 דנה: חבילת פרסום מוכנה לבדיקה — "${project.title}" (גרסה ${version.n})`,
          open ? `⚠️ ${open} פריטים דורשים את הבדיקה שלך.` : '✅ כל הבדיקות האוטומטיות עברו.',
          `לצפייה ולאישור (נדרשת התחברות): ${link}`,
          'אישור ניתן רק בדף הבדיקה. תשובה להודעה הזו אינה מאשרת פרסום.'].join('\n');
}
/** The provider's answer → an outcome. Only a real message id counts as sent. */
function classify(r) {
  if (r?.blocked) return 'blocked: TEST_MODE allowlist does not include this number';
  if (r?.demo) return 'not_sent: demo capture is active';
  if (r?.queued) return 'uncertain: queued by quiet hours';
  if (r?.idMessage) return 'sent';
  return 'uncertain: the provider returned no message id' + (r?.error ? ` (${String(r.error).slice(0, 100)})` : '');
}
function record(entry) { try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); fs.appendFileSync(logFile(), JSON.stringify(entry) + '\n'); } catch { /* log only */ } }

async function deliver(project, version) {
  const text = buildMessage(project, version);
  let outcome;
  try {
    const r = await require('./whatsapp.service').sendText(phone(), text, { bypassQuietHours: true, linkPreview: false });
    outcome = classify(r);
    version.notifyMessageId = outcome === 'sent' ? r.idMessage : null;
  } catch (e) { outcome = 'uncertain: ' + String(e.message).slice(0, 120); }      // never re-sent automatically
  version.notifyOutcome = outcome; version.notifyPending = false;
  studio().save();
  record({ at: new Date().toISOString(), mode: 'real', projectId: project.id, version: version.n, to: `…${phone().slice(-4)}`, text, outcome });
  return { sent: outcome === 'sent', mode: 'real', outcome };
}

async function packageReady(project, version) {
  if (version.notifiedAt) return { sent: false, reason: 'already_notified' };       // exactly once per version
  const mode = realEnabled() ? 'real' : 'mock';
  version.notifiedAt = new Date().toISOString();
  version.notifyMode = mode;
  version.notifyPending = mode === 'real' && quiet();
  studio().save();                                                                   // persist BEFORE sending → no duplicate after a restart
  if (mode === 'mock') {
    record({ at: version.notifiedAt, mode, projectId: project.id, version: version.n, text: buildMessage(project, version), to: '(mock — not sent)', outcome: 'recorded' });
    return { sent: false, mode, outcome: 'recorded' };
  }
  if (version.notifyPending) {
    record({ at: version.notifiedAt, mode, projectId: project.id, version: version.n, to: `…${phone().slice(-4)}`, outcome: 'deferred_quiet_hours' });
    return { sent: false, mode, outcome: 'deferred_quiet_hours' };
  }
  return deliver(project, version);
}

function pendingVersions() {
  const out = [];
  try { for (const p of Object.values(studio().state().projects)) for (const v of p.versions) if (v.notifyPending) out.push([p, v]); } catch { /* */ }
  return out;
}
/** Send notifications that waited for quiet hours to end. Only the CURRENT version of a project is still worth announcing. */
async function flush() {
  if (!realEnabled() || quiet()) return 0;
  let n = 0;
  for (const [p, v] of pendingVersions()) {
    if (p.currentVersion !== v.n || v.status !== 'ready_for_review') { v.notifyPending = false; v.notifyOutcome = 'superseded'; studio().save(); continue; }
    v.notifyPending = false; studio().save();                                        // claim it before sending
    await deliver(p, v); n++;
  }
  return n;
}

/**
 * ONE explicit test message to the configured owner number. It runs only in real mode, only when
 * the caller repeats the full number (so a test cannot be triggered by accident), and it is logged.
 */
async function sendTest({ confirmPhone, by }) {
  const s = studio();
  if (!realEnabled()) throw new s.StudioError(409, 'notify_not_real', 'התראות אמיתיות כבויות', { status: status() });
  if (String(confirmPhone || '').replace(/[^\d]/g, '') !== phone()) throw new s.StudioError(400, 'notify_phone_mismatch', 'המספר שהוקלד אינו המספר שהוגדר');
  if (!by || !String(by).trim()) throw new s.StudioError(400, 'notify_by_required', 'נדרש שם המאשר/ת');
  const text = ['🎬 דנה: הודעת בדיקה.', 'אם קיבלת את ההודעה הזו, ההתראות על חבילות מוכנות יגיעו למספר הזה.', `דף הבדיקה (נדרשת התחברות): ${baseUrl()}/dana-studio.html`].join('\n');
  let outcome;
  try { outcome = classify(await require('./whatsapp.service').sendText(phone(), text, { bypassQuietHours: true, linkPreview: false })); }
  catch (e) { outcome = 'uncertain: ' + String(e.message).slice(0, 120); }
  record({ at: new Date().toISOString(), mode: 'real', test: true, by: String(by).slice(0, 80), to: `…${phone().slice(-4)}`, text, outcome });
  return { outcome };
}

function sentLog() {
  try { return fs.readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

module.exports = { packageReady, flush, sendTest, status, buildMessage, sentLog, realEnabled };
