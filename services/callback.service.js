'use strict';

/**
 * callback.service.js — the single owner of Barak's lead → callback lifecycle.
 *
 * Every entry path (explicit callback request, time given after an AI invitation,
 * name capture, admin retry, panel actions, reminder replies) goes through the
 * functions here, so the rules below hold everywhere:
 *
 *   1. PERSIST FIRST. Nothing is told to a prospect or a manager about a callback
 *      unless a matching appointment with a resolved scheduledAt is on disk.
 *   2. scheduledAt is resolved once, strictly, from the message that supplied the
 *      time (utils/callback_time.js). Displayed dates always come from the persisted
 *      scheduledAt — never from re-parsing text, never from the current clock.
 *   3. ONE manager summary and ONE prospect summary per appointment + scheduled
 *      time. Dedup is durable (stored on the appointment, per recipient), so restarts,
 *      retries and duplicate inbound events cannot replay a summary.
 *   4. Staff approval, prospect availability and call outcome are separate facts.
 *   5. Human ownership and opt-out are never overridden: no automated prospect
 *      message and no lead-status change while either is in force.
 *
 * Dependencies are injected so the same code runs in production and in tests.
 */

const aptStore = require('../utils/appointment_store');
const { resolveCallbackTime, formatCallbackTime } = require('../utils/callback_time');

const STOP_STATUSES     = new Set(['opted_out', 'human_owns', 'converted_member', 'attribution_review']);
const NO_AUTO_MSG       = new Set(['opted_out', 'human_owns']);
const CALLBACK_STATUSES = new Set(['callback_requested', 'call_scheduled']);

// Prospect replies to the reminder ("עדיין נוח לך לדבר בשעה הזו?")
const AVAIL_CONFIRM_RE    = /^(?:כן|בסדר(?:\s+גמור)?|אוקיי?|אוקי|יופי|מצוין|מעולה|sure|yes|ok|okay|טוב|בטח|ברור|נכון|מתאים|נוח|סבבה|👍|✅)(?:[\s,.!]|$)/i;
const AVAIL_RESCHEDULE_RE = /לא\s*(?:נוח|מתאים|יכול|יכולה|אפשרי|מסתדר)|לא\s+ok|לא\s+בסדר|אי\s*אפשר|לשנות|לדחות|להזיז|מועד\s+אחר|שעה\s+אחרת|זמן\s+אחר|יום\s+אחר|reschedule/i;
const AVAIL_CANCEL_RE     = /לבטל|אבטל|מבטל|תבטלו|לא\s*רוצ[הי]|לא\s*מעוניי?נ|לא\s+רלוונטי|לא\s+צריך|not interested|cancel/i;

function validDate(d) { return d instanceof Date && !isNaN(d.getTime()); }
function firstName(n) { return String(n ?? '').trim().split(/\s+/)[0] || null; }
function localPhone(p) { return String(p).startsWith('972') ? '0' + String(p).slice(3) : String(p); }

function createCallbackService(deps) {
  const {
    store, persist, logger,
    sendText, alertOwner,
    markBotSent   = () => {},
    getBackendBase = () => null,
    getStaffId    = () => 'eden',
    getDurationMin = () => 30,
    cancelCalendarEvent = async () => {},
  } = deps;

  // In-process guards (secondary to the durable dedup on the appointment).
  const _finalizing = new Set();   // aptIds with a summary send in progress
  const _sentKeys   = new Set();   // `${aptId}|${key}|${phone}` accepted this process

  const autoReplyOn = () => process.env.WHATSAPP_AUTO_REPLY === 'true';

  function getLead(phone) { return store.getLead(phone) ?? null; }
  function patchLead(phone, top, metaPatch) {
    const cur = getLead(phone);
    store.upsertLead(phone, { ...top, meta: { ...(cur?.meta ?? {}), ...metaPatch } });
  }
  /** Set a lead status without ever overriding a stop-status. While a human owns the
   *  conversation the new status is remembered as previousStatus so release restores it. */
  function setLeadStatus(phone, status, metaPatch = {}) {
    const cur = getLead(phone);
    if (!cur) return;
    if (cur.status === 'human_owns') {
      patchLead(phone, {}, { ...metaPatch, previousStatus: status });
    } else if (STOP_STATUSES.has(cur.status)) {
      patchLead(phone, {}, metaPatch);
    } else {
      patchLead(phone, { status }, metaPatch);
    }
  }

  function openCallback(phone) { return aptStore.getActiveCallback(phone); }
  function isFuture(apt, now = Date.now()) { return !!apt && validDate(apt.scheduledAt) && apt.scheduledAt.getTime() > now; }

  // ── Durable notification helpers ────────────────────────────────────────────

  function alreadyNotified(apt, type) {
    const key = aptStore.notificationKey(apt, type);
    const durable = aptStore.getNotified(apt.id, type);
    const mem = [..._sentKeys].filter(k => k.startsWith(`${apt.id}|${key}|`)).map(k => k.split('|').pop());
    return new Set([...durable, ...mem]);
  }
  function recordNotified(apt, type, phones) {
    if (!phones.length) return true;
    const key = aptStore.notificationKey(apt, type);
    for (const p of phones) _sentKeys.add(`${apt.id}|${key}|${p}`);
    try {
      aptStore.recordNotified(apt.id, type, phones);
      return true;
    } catch (err) {
      // The send happened but the record is not durable. Say so loudly; the in-process
      // guard still prevents a duplicate until the next restart.
      logger.error('[callback] notification record NOT persisted', { aptId: apt.id, type, error: err.message });
      store.logEvent('callback_notification_record_failed', apt.leadPhone, { aptId: apt.id, type });
      return false;
    }
  }

  /** Manager message sent at most once per appointment + scheduled time + recipient. */
  async function notifyManagersOnce(apt, type, subject, body) {
    const skip = alreadyNotified(apt, type);
    let ar;
    try {
      ar = await alertOwner(subject, body, { skipPhones: skip, linkPreview: false });
    } catch (err) {
      logger.warn('[callback] manager notification failed', { aptId: apt.id, type, error: err.message });
      return { accepted: false, newSent: [], results: [], error: err.message };
    }
    const results   = ar?.results ?? [];
    const newSent   = results.filter(r => r.idMessage && !r.skipped).map(r => r.phone);
    const anyFailed = results.some(r => !r.skipped && !r.idMessage);
    const durable   = recordNotified(apt, type, newSent);
    const covered   = skip.size + newSent.length;
    return {
      accepted: covered > 0 && !anyFailed, durable, newSent, results,
      allSentTo: [...new Set([...skip, ...newSent])],
      idMessage: results.find(r => r.idMessage)?.idMessage ?? null,
      nothingToSend: results.length > 0 && results.every(r => r.skipped),
    };
  }

  // ── 1. Accept a requested time (persist first) ──────────────────────────────

  /**
   * Resolve `text` against the timestamp of the message that carried it and persist
   * the callback. Returns
   *   { ok:true, apt, isReschedule, unchanged }             — appointment is on disk
   *   { ok:false, reason, clarification }                    — ask the prospect (nothing stored)
   *   { ok:false, reason:'persist_failed', clarification }   — storage failed (nothing stored)
   */
  function acceptTime({ phone, text, sentAt, source = 'unknown' }) {
    const ref = validDate(sentAt) ? sentAt : new Date();
    const res = resolveCallbackTime(text, ref);
    if (!res.ok) return { ok: false, reason: res.reason, clarification: res.clarification };

    const lead = getLead(phone);
    const meta = lead?.meta ?? {};
    const qd   = meta.qualData ?? {};
    const open = openCallback(phone);
    const rawTime = String(text).trim().slice(0, 120);

    let apt, isReschedule = false;
    try {
      if (isFuture(open)) {
        if (open.scheduledAt.getTime() === res.scheduledAt.getTime()) {
          return { ok: true, apt: open, isReschedule: false, unchanged: true };
        }
        apt = aptStore.reschedule(open.id, { rawTime, scheduledAt: res.scheduledAt });
        isReschedule = true;
      } else {
        // No open callback, or the open one already expired without an outcome: the
        // expired record is left exactly as it is (history) and a new one is created.
        apt = aptStore.createCallbackPending({
          leadPhone:       phone,
          // Confirmed name when known; otherwise the WhatsApp profile name as a provisional
          // label for staff. finalize() overwrites it with the confirmed name.
          leadName:        qd.confirmedName ?? lead?.name ?? null,
          rawTime,
          scheduledAt:     res.scheduledAt,
          durationMin:     getDurationMin(),
          assignedStaffId: getStaffId(),
        });
      }
    } catch (err) {
      logger.error('[callback] appointment NOT persisted — no confirmation will be sent', { phone, source, error: err.message });
      store.logEvent('callback_persist_failed', phone, { source, error: err.message });
      return {
        ok: false, reason: 'persist_failed', error: err.message,
        clarification: `קיבלתי את הבקשה, אבל לא הצלחתי לרשום את המועד כרגע 🙏 העברתי לצוות — יחזרו אליך כאן בוואטסאפ לתיאום.`,
      };
    }

    // Archive the previous summary cycle (provider ids included) before starting a new one.
    const hadCycle = meta.closingSummaryProspectState != null || meta.closingSummaryManagerState != null
                  || meta.closingSummarySent != null;
    const history = Array.isArray(meta.closingSummaryHistory) ? meta.closingSummaryHistory : [];
    const archived = hadCycle ? [...history, {
      aptId:             meta.callbackAptId ?? null,
      callTimeGiven:     qd.callTimeGiven ?? null,
      callTimeGivenAt:   qd.callTimeGivenAt ?? meta.callTimeGivenAt ?? null,   // preserved verbatim
      prospectState:     meta.closingSummaryProspectState ?? null,
      prospectIdMessage: meta.closingSummaryProspectIdMessage ?? null,
      managerState:      meta.closingSummaryManagerState ?? null,
      managerIdMessage:  meta.closingSummaryManagerIdMessage ?? null,
      managerSentTo:     meta.closingSummaryManagerSentTo ?? [],
      sentAt:            meta.closingSummarySentAt ?? null,
      handoffAlertIdMessage: meta.handoffAlertIdMessage ?? null,
      archivedAt:        new Date().toISOString(),
    }].slice(-20) : history;

    const sentIso = ref.toISOString();
    const metaPatch = {
      awaitingCallbackTime:  false,
      callbackTimeAttempts:  0,
      callbackTime:          rawTime,
      callbackRequestedAt:   sentIso,
      callTimeGivenAt:       sentIso,
      callbackAptId:         apt.id,
      handoffCallTime:       rawTime,
      handoffAlertStatus:    'deferred_pending_name',
      handoffAlertSentAt:    null,
      noShowAptId:           null,
      reschedulingAptId:     null,
      reschedulingOldTime:   null,
      closingSummarySent:              false,
      closingSummarySentAt:            null,
      closingSummaryProspectState:     null,
      closingSummaryProspectReply:     null,
      closingSummaryProspectIdMessage: null,
      closingSummaryManagerState:      null,
      closingSummaryManagerIdMessage:  null,
      closingSummaryManagerSentTo:     [],
      closingSummaryHistory:           archived,
      qualData: {
        ...qd,
        callTimeGiven:      rawTime,
        callTimeGivenAt:    sentIso,
        closingSummarySent: false,
        callbackDeclined:   false,
      },
    };
    setLeadStatus(phone, 'callback_requested', metaPatch);
    persist.saveLeads(store);
    store.logEvent(isReschedule ? 'callback_rescheduled' : 'call_time_captured', phone, {
      aptId: apt.id, rawTime, scheduledAt: apt.scheduledAt.toISOString(), source,
    });
    logger.info('[callback] time accepted and persisted', {
      phone, aptId: apt.id, scheduledAt: apt.scheduledAt.toISOString(), isReschedule, source,
    });
    return { ok: true, apt, isReschedule, unchanged: false };
  }

  // ── 2. Summaries ────────────────────────────────────────────────────────────

  function buildProspectSummary(name, apt, isReschedule) {
    const fmt = formatCallbackTime(apt.scheduledAt);
    return [
      isReschedule ? `${name}, עדכנו את בקשת השיחה שלך ✅` : `${name}, קיבלנו את בקשת השיחה שלך ✅`,
      `📞 ${fmt}`,
      `נציג מהצוות של Shape Studio יצור איתך קשר.`,
    ].join('\n');
  }

  function buildManagerSummary(phone, name, apt, isReschedule) {
    const qd  = getLead(phone)?.meta?.qualData ?? {};
    const fmt = formatCallbackTime(apt.scheduledAt);
    const base = getBackendBase();
    const prev = isReschedule && apt.previousScheduledAt ? formatCallbackTime(new Date(apt.previousScheduledAt)) : null;
    const body = [
      isReschedule ? `🔄 שינוי מועד שיחה — ${name}` : `📞 בקשת שיחה חדשה — ${name}`,
      `📅 ${fmt}`,
      prev ? `↩️ מועד קודם: ${prev}` : null,
      `📱 ${localPhone(phone)}`,
      qd.fitnessInterest ? `💪 עניין: ${qd.fitnessInterest}` : null,
      qd.location        ? `📍 מיקום: ${qd.location}` : null,
      qd.goal            ? `🎯 מטרה: ${qd.goal}` : null,
      `⏳ בקשת שיחה — ממתינה לאישור הצוות`,
      `💬 https://wa.me/${phone}`,
      base ? `📋 ${base}/#barak` : null,
    ].filter(Boolean).join('\n');
    const subject = isReschedule ? `🔄 שינוי מועד — ${name}` : `📞 בקשת שיחה — ${name}`;
    return { subject, body };
  }

  /**
   * Send the prospect summary and the ONE consolidated manager summary for the lead's
   * open callback. Safe to call repeatedly: each part is sent at most once per
   * appointment + scheduled time (+ recipient). Never sends for an expired, missing or
   * unscheduled appointment.
   *
   * opts.notifyManager=false — staff changed the time themselves in the panel.
   */
  async function finalize({ phone, trigger = 'unknown', notifyManager = true } = {}) {
    const lead = getLead(phone);
    if (!lead) return { ok: false, error: 'lead_not_found' };
    const name = firstName(lead.meta?.qualData?.confirmedName);
    if (!name) return { ok: false, error: 'no_name' };
    const apt0 = openCallback(phone);
    if (!apt0 || !validDate(apt0.scheduledAt)) return { ok: false, error: 'no_persisted_callback' };
    if (!isFuture(apt0)) return { ok: false, error: 'callback_expired' };
    if (_finalizing.has(apt0.id)) return { ok: false, error: 'in_flight' };

    _finalizing.add(apt0.id);
    try {
      // Keep the appointment's name in sync BEFORE any send; if that cannot be
      // persisted nothing is sent.
      let apt = apt0;
      if (apt.leadName !== lead.meta.qualData.confirmedName) {
        try { apt = aptStore.update(apt.id, { leadName: lead.meta.qualData.confirmedName }); }
        catch (err) {
          logger.error('[callback] name not persisted — summaries withheld', { phone, error: err.message });
          return { ok: false, error: 'persist_failed' };
        }
      }
      // A reschedule is announced as such only when a summary for an earlier time went out.
      const curIso = apt.scheduledAt.toISOString();
      const priorSummary = Object.keys(apt.notifications ?? {}).some(k =>
        (k.startsWith('manager_summary|') || k.startsWith('prospect_summary|')) && !k.endsWith('|' + curIso));
      const isReschedule = (apt.rescheduleCount ?? 0) > 0 && priorSummary;

      const prospectMsg = buildProspectSummary(name, apt, isReschedule);
      const { subject, body } = buildManagerSummary(phone, name, apt, isReschedule);

      // Durable in-flight marker: if the process dies between a send and its record, the
      // next startup turns this into 'uncertain' (review needed) — never an automatic resend.
      const prospectPending = !alreadyNotified(apt, 'prospect_summary').has(phone);
      patchLead(phone, { name: lead.meta.qualData.confirmedName }, {
        closingSummaryProspectReply: prospectMsg,
        callbackAptId: apt.id,
        closingSummaryProspectState: prospectPending ? 'in_flight' : 'accepted',
        closingSummaryManagerState:  notifyManager ? 'in_flight' : 'accepted',
      });
      persist.saveLeads(store);

      // ── Prospect ──────────────────────────────────────────────────────────
      let prospect = { state: 'accepted', idMessage: null, alreadySent: true };
      if (!alreadyNotified(apt, 'prospect_summary').has(phone)) {
        const st = getLead(phone)?.status;
        if (NO_AUTO_MSG.has(st)) {
          prospect = { state: 'skipped', reason: st };
          store.logEvent('closing_prospect_suppressed_' + st, phone, { aptId: apt.id });
        } else if (!autoReplyOn()) {
          prospect = { state: 'skipped', reason: 'auto_reply_off' };
        } else {
          markBotSent(phone);
          try {
            const r  = await sendText(phone, prospectMsg);
            // A send intercepted by the TEST_MODE allowlist never reached the provider.
            const id = r?.blocked ? null : (r?.idMessage ?? null);
            if (id) {
              recordNotified(apt, 'prospect_summary', [phone]);
              prospect = { state: 'accepted', idMessage: id };
            } else if (r?.queued) {
              // Quiet hours: the prospect got the short receipt now and the summary is
              // queued for the morning release. Recorded as covered so no retry can send
              // a second copy; reported as 'queued', not as delivered.
              recordNotified(apt, 'prospect_summary', [phone]);
              prospect = { state: 'queued', idMessage: null, releaseAt: r.releaseAt ?? null };
            } else {
              prospect = { state: 'failed', reason: r?.blocked ? 'blocked_test_mode' : 'no_provider_id' };
            }
          } catch (err) {
            prospect = { state: 'failed', reason: err.message };
            logger.warn('[callback] prospect summary send failed', { phone, error: err.message });
          }
        }
      }

      // ── Manager (ONE consolidated summary) ────────────────────────────────
      let manager = { accepted: true, newSent: [], allSentTo: [...alreadyNotified(apt, 'manager_summary')], idMessage: null, skipped: true };
      if (notifyManager) {
        manager = await notifyManagersOnce(apt, 'manager_summary', subject, body);
        if (manager.newSent.length) {
          try { aptStore.update(apt.id, { handoffSentTo: [...new Set([...(apt.handoffSentTo ?? []), ...manager.newSent])] }); }
          catch (err) { logger.error('[callback] handoffSentTo not persisted', { phone, error: err.message }); }
        }
      } else {
        // Staff made this change themselves; mark the cycle covered so no later retry
        // sends them a summary for it.
        recordNotified(apt, 'manager_summary', ['staff_action']);
      }

      // ── Lead meta (panel / admin compatibility) ───────────────────────────
      const cur = getLead(phone)?.meta ?? {};
      const prospectAccepted = prospect.state === 'accepted' || prospect.state === 'queued';
      const both = prospectAccepted && manager.accepted;
      patchLead(phone, {}, {
        closingSummaryProspectState:     prospect.state,
        closingSummaryProspectIdMessage: prospect.idMessage ?? cur.closingSummaryProspectIdMessage ?? null,
        closingSummaryManagerState:      manager.accepted ? 'accepted' : 'failed',
        closingSummaryManagerIdMessage:  manager.idMessage ?? cur.closingSummaryManagerIdMessage ?? null,
        closingSummaryManagerSentTo:     (manager.allSentTo ?? []).filter(p => p !== 'staff_action'),
        closingSummarySent:              both,
        closingSummarySentAt:            both ? (cur.closingSummarySentAt ?? new Date().toISOString()) : null,
        handoffAlertStatus:              manager.accepted ? 'sent' : 'failed',
        handoffAlertSentAt:              manager.accepted ? (cur.handoffAlertSentAt ?? new Date().toISOString()) : cur.handoffAlertSentAt ?? null,
        handoffAlertFailedAt:            manager.accepted ? null : new Date().toISOString(),
        handoffAlertIdMessage:           manager.idMessage ?? cur.handoffAlertIdMessage ?? null,
        qualData: { ...(cur.qualData ?? {}), closingSummarySent: both, nameConfirmedAlertSent: manager.accepted },
      });
      persist.saveLeads(store);
      store.logEvent('closing_summary_sent', phone, {
        aptId: apt.id, trigger, scheduledAt: apt.scheduledAt.toISOString(),
        prospect: prospect.state, manager: manager.accepted ? 'accepted' : 'failed',
        managerNew: manager.newSent, isReschedule,
      });
      logger.info('[callback] summaries processed', {
        phone, aptId: apt.id, trigger, prospect: prospect.state, managerAccepted: manager.accepted, newManagerSends: manager.newSent.length,
      });
      return { ok: both, apt, isReschedule, prospectMsg, managerMsg: body, prospect, manager, bothAccepted: both };
    } finally {
      _finalizing.delete(apt0.id);
    }
  }

  // ── 3. Prospect replies about an open callback ──────────────────────────────

  /**
   * Handle a prospect message that confirms availability, asks for another time or
   * cancels. Returns null when the message is none of those (caller continues).
   * Otherwise returns { route, reply, state } after everything is persisted.
   */
  async function handleAvailabilityReply({ phone, text, sentAt, displayName }) {
    const apt = openCallback(phone);
    if (!apt || !validDate(apt.scheduledAt)) return null;
    const msg   = String(text ?? '').trim();
    if (!msg) return null;
    const name  = firstName(getLead(phone)?.meta?.qualData?.confirmedName) ?? firstName(apt.leadName) ?? firstName(displayName);
    const who   = name ?? localPhone(phone);
    const fmt   = formatCallbackTime(apt.scheduledAt);
    const now   = Date.now();
    const future = apt.scheduledAt.getTime() > now;

    // A reply to the reminder is read generously. Outside that context a message only
    // counts as cancelling / moving the call when it is short or says so explicitly —
    // "אני לא רוצה פילאטיס, יש משהו אחר?" must not cancel a callback.
    const reminderCtx  = apt.prospectReminderSent === true && (apt.prospectAvailability == null || apt.prospectAvailability === 'confirmed');
    const short        = msg.length <= 30;
    const isCancel     = AVAIL_CANCEL_RE.test(msg) && (reminderCtx || short || /בטל|cancel/i.test(msg));
    const isReschedule = !isCancel && AVAIL_RESCHEDULE_RE.test(msg)
                         && (reminderCtx || short || /לשנות|לדחות|להזיז|מועד|שעה|זמן אחר|יום אחר|reschedule/i.test(msg));
    const isConfirm    = !isCancel && !isReschedule && AVAIL_CONFIRM_RE.test(msg) && msg.length <= 40;
    if (!isCancel && !isReschedule && !isConfirm) return null;

    const send = async (reply) => {
      if (!reply || !autoReplyOn() || NO_AUTO_MSG.has(getLead(phone)?.status)) return;
      markBotSent(phone);
      await sendText(phone, reply).catch(err => logger.warn('[callback] availability reply send failed', { phone, error: err.message }));
    };
    const stamp = (validDate(sentAt) ? sentAt : new Date()).toISOString();

    // ── Explicit cancellation — valid at any point while the callback is open ──
    if (isCancel) {
      let r;
      try { r = aptStore.cancel(apt.id, { by: 'prospect', reason: msg.slice(0, 200) }); aptStore.update(apt.id, { prospectAvailability: 'cancelled', prospectAvailabilityAt: stamp }); }
      catch (err) { logger.error('[callback] cancellation not persisted', { phone, error: err.message }); return { route: 'post_call_staff_hold', reply: null, state: 'persist_failed' }; }
      setLeadStatus(phone, 'call_cancelled', { awaitingCallbackTime: false, callbackCancelledAt: stamp, ...closedCycleQualPatch(phone) });
      persist.saveLeads(store);
      cancelCalendarEvent(r.apt).catch(() => {});
      const reply = `הבנתי, ביטלתי את בקשת השיחה 🙏 אם תרצה/י לתאם בעתיד — אנחנו כאן 😊`;
      await send(reply);
      await notifyManagersOnce(apt, 'prospect_cancelled', `❌ הליד ביטל/ה את בקשת השיחה — ${who}`,
        [`👤 ${who}`, `📱 ${localPhone(phone)}`, `📅 המועד שבוטל: ${fmt}`, `💬 "${msg.slice(0, 200)}"`, `הבקשה נסגרה ולא יישלחו תזכורות.`].join('\n'));
      store.logEvent('prospect_availability_replied', phone, { aptId: apt.id, availState: 'cancelled' });
      return { route: 'post_call_avail_cancelled', reply, state: 'cancelled' };
    }

    // ── "Not convenient" — keep the request, ask for another time ─────────────
    if (isReschedule) {
      try { aptStore.update(apt.id, { prospectAvailability: 'rescheduled', prospectAvailabilityAt: stamp }); }
      catch (err) { logger.error('[callback] reschedule request not persisted', { phone, error: err.message }); return { route: 'post_call_staff_hold', reply: null, state: 'persist_failed' }; }
      patchLead(phone, {}, { awaitingCallbackTime: true, callbackTimeAttempts: 0 });
      persist.saveLeads(store);
      const reply = `אין בעיה 🙂 מתי יהיה לך נוח במקום? (יום ושעה)`;
      await send(reply);
      await notifyManagersOnce(apt, 'prospect_reschedule_requested', `🔄 הליד ביקש/ה מועד אחר — ${who}`,
        [`👤 ${who}`, `📱 ${localPhone(phone)}`, `📅 המועד ${fmt} לא נוח.`, `💬 "${msg.slice(0, 200)}"`, `ביקשנו מועד חדש — תתעדכנו כשיתקבל.`].join('\n'));
      store.logEvent('prospect_availability_replied', phone, { aptId: apt.id, availState: 'rescheduled' });
      return { route: 'post_call_avail_rescheduled', reply, state: 'rescheduled' };
    }

    // ── Affirmation ───────────────────────────────────────────────────────────
    if (!apt.prospectReminderSent) return null;              // nothing was asked — just an ack
    if (apt.prospectAvailability === 'confirmed') {
      store.logEvent('post_call_avail_dup_affirm', phone, { aptId: apt.id });
      return { route: 'post_call_avail_already_confirmed', reply: null, state: 'confirmed' };
    }
    if (apt.prospectAvailability != null) return null;

    if (!future) {
      // The reminder was for a time that has already passed. Never present this as
      // confirmation of a future call.
      if (apt.lateAvailabilityReplyAt) return { route: 'post_call_avail_late', reply: null, state: 'late' };
      try { aptStore.update(apt.id, { lateAvailabilityReplyAt: stamp }); }
      catch (err) { logger.error('[callback] late reply not persisted', { phone, error: err.message }); }
      const reply = `תודה על התשובה 🙏 המועד שנרשם (${fmt}) כבר עבר. אם תרצה/י — כתבו לי יום ושעה חדשים ואעדכן את הצוות.`;
      patchLead(phone, {}, { awaitingCallbackTime: true, callbackTimeAttempts: 0 });
      persist.saveLeads(store);
      await send(reply);
      await notifyManagersOnce(apt, 'prospect_late_reply', `⏰ תשובה מאוחרת מהליד — ${who}`,
        [`👤 ${who}`, `📱 ${localPhone(phone)}`, `הליד ענה/תה אחרי מועד השיחה (${fmt}).`, `💬 "${msg.slice(0, 200)}"`, `לא נרשם אישור זמינות. נא לעדכן תוצאת שיחה בפאנל.`].join('\n'));
      store.logEvent('prospect_availability_late', phone, { aptId: apt.id });
      return { route: 'post_call_avail_late', reply, state: 'late' };
    }

    try { aptStore.update(apt.id, { prospectAvailability: 'confirmed', prospectAvailabilityAt: stamp }); }
    catch (err) { logger.error('[callback] availability not persisted', { phone, error: err.message }); return { route: 'post_call_staff_hold', reply: null, state: 'persist_failed' }; }
    const reply = `מעולה${name ? ' ' + name : ''}, תודה על האישור 🙏 נדבר ${fmt}.`;
    await send(reply);
    await notifyManagersOnce(apt, 'prospect_available', `✅ הליד אישר/ה זמינות — ${who}`,
      [`👤 ${who}`, `📱 ${localPhone(phone)}`, `📅 ${fmt}`, `הליד אישר/ה שהמועד נוח.`,
       apt.status === 'confirmed' ? `✅ השיחה אושרה על ידי הצוות` : `⏳ השיחה עדיין ממתינה לאישור הצוות בפאנל`,
       `💬 https://wa.me/${phone}`].join('\n'));
    store.logEvent('prospect_availability_replied', phone, { aptId: apt.id, availState: 'confirmed' });
    return { route: 'post_call_avail_confirmed', reply, state: 'confirmed' };
  }

  /** Opt-out while a callback is open: close it so no reminder can follow. */
  function cancelForOptOut(phone) {
    const apt = openCallback(phone);
    if (!apt) return null;
    try {
      const r = aptStore.cancel(apt.id, { by: 'prospect_opt_out' });
      cancelCalendarEvent(r.apt).catch(() => {});
      store.logEvent('callback_cancelled_opt_out', phone, { aptId: apt.id });
      return r.apt;
    } catch (err) {
      logger.error('[callback] opt-out cancellation not persisted', { phone, error: err.message });
      return null;
    }
  }

  // ── 4. Staff actions (panel) ────────────────────────────────────────────────

  const OUTCOME_LEAD_STATUS = { completed: 'call_completed', cancelled: 'call_cancelled', no_answer: 'call_no_answer' };

  /** Lead status follows the appointment only when this appointment is the lead's
   *  current one — an old record's outcome never rewrites a newer request. */
  function syncLeadAfter(apt, leadStatus, metaPatch = {}) {
    if (!apt?.leadPhone || !getLead(apt.leadPhone)) return;
    const newer = openCallback(apt.leadPhone);
    if (newer && newer.id !== apt.id) return;
    setLeadStatus(apt.leadPhone, leadStatus, { awaitingCallbackTime: false, ...metaPatch });
    persist.saveLeads(store);
  }

  /** Once a callback is closed, the conversation state that described it is cleared so
   *  Barak no longer treats the lead as "call time confirmed" (the request, its time and
   *  its provider ids stay on the appointment and in closingSummaryHistory). */
  function closedCycleQualPatch(phone) {
    const qd = getLead(phone)?.meta?.qualData ?? {};
    // Timestamps are left exactly as they were (historical values are never rewritten).
    return { qualData: { ...qd, callTimeGiven: null, callProposed: false, closingSummarySent: false } };
  }

  function staffConfirm(id) {
    const r = aptStore.staffConfirm(id);   // throws on persistence failure
    if (r.ok && !r.unchanged) {
      syncLeadAfter(r.apt, 'call_scheduled', { staffConfirmedAt: r.apt.staffConfirmedAt });
      store.logEvent('appointment_confirmed_by_staff', r.apt.leadPhone, { aptId: r.apt.id });
    }
    return r;
  }

  function staffOutcome(id, outcome, extra = {}) {
    const fn = outcome === 'completed' ? () => aptStore.complete(id, extra)
             : outcome === 'cancelled' ? () => aptStore.cancel(id, { by: 'staff', ...extra })
             : outcome === 'no_answer' ? () => aptStore.noAnswer(id, extra)
             : null;
    if (!fn) return { ok: false, error: 'bad_outcome', apt: null };
    const r = fn();                          // throws on persistence failure
    if (r.ok && !r.unchanged) {
      syncLeadAfter(r.apt, OUTCOME_LEAD_STATUS[outcome], { callOutcome: outcome, callOutcomeAt: r.apt.outcomeAt, ...closedCycleQualPatch(r.apt.leadPhone) });
      if (outcome === 'cancelled') cancelCalendarEvent(r.apt).catch(() => {});
      store.logEvent(`appointment_${outcome}`, r.apt.leadPhone, { aptId: r.apt.id, ...extra });
    }
    return r;
  }

  /**
   * Staff move an OPEN callback to another time (strictly resolved against now).
   * The prospect receives the updated summary; managers are not messaged about a
   * change they made themselves.
   */
  async function staffReschedule(id, rawTime) {
    const apt = aptStore.get(id);
    if (!apt) return { ok: false, error: 'not_found' };
    if (!aptStore.ACTIVE_STATUSES.has(apt.status)) return { ok: false, error: 'not_open', apt };
    const res = resolveCallbackTime(rawTime, new Date());
    if (!res.ok) return { ok: false, error: 'invalid_time', reason: res.reason, clarification: res.clarification, apt };
    const oldTime = validDate(apt.scheduledAt) ? formatCallbackTime(apt.scheduledAt) : (apt.rawTime ?? null);
    const updated = aptStore.reschedule(id, { rawTime: String(rawTime).trim(), scheduledAt: res.scheduledAt }); // throws on failure
    cancelCalendarEvent(apt).catch(() => {});
    if (getLead(apt.leadPhone)) {
      const cur = getLead(apt.leadPhone).meta ?? {};
      setLeadStatus(apt.leadPhone, 'callback_requested', {
        awaitingCallbackTime: false,
        handoffCallTime: String(rawTime).trim(),
        callbackAptId: updated.id,
        qualData: { ...(cur.qualData ?? {}), callTimeGiven: String(rawTime).trim(), closingSummarySent: false },
      });
      persist.saveLeads(store);
    }
    store.logEvent('appointment_rescheduled_manual', apt.leadPhone, {
      aptId: id, oldTime, newTime: rawTime, scheduledAt: res.scheduledAt.toISOString(),
    });
    const fin = await finalize({ phone: apt.leadPhone, trigger: 'staff_reschedule', notifyManager: false });
    return { ok: true, appointment: updated, scheduledAt: res.scheduledAt, oldTime, summary: fin };
  }

  // ── 5. Panel view ───────────────────────────────────────────────────────────

  /** One row per lead that needs callback attention, with an explicit stage. */
  function panelRows(maskPhone = p => p) {
    const now  = Date.now();
    const rows = [];
    for (const lead of store.getAllLeads()) {
      const meta = lead.meta ?? {};
      const qd   = meta.qualData ?? {};
      const open = openCallback(lead.phone);
      const inCb = CALLBACK_STATUSES.has(lead.status) || (lead.status === 'human_owns' && CALLBACK_STATUSES.has(meta.previousStatus));
      const awaitingTime = meta.awaitingCallbackTime === true && !['opted_out', 'converted_member'].includes(lead.status);
      if (!open && !inCb && !awaitingTime) continue;
      if (['opted_out', 'converted_member'].includes(lead.status) && !open) continue;

      let stage, needsAction;
      if (!open) {
        stage = awaitingTime ? 'awaiting_time' : 'no_open_callback';
        needsAction = awaitingTime ? 'הליד ביקש שיחה ועדיין לא נתן מועד — אפשר ליצור קשר ישירות'
                                   : 'אין בקשת שיחה פתוחה לליד הזה — לבדוק ידנית';
      } else if (!validDate(open.scheduledAt)) {
        stage = 'unscheduled';        needsAction = 'לבקשה אין מועד תקין — לקבוע מועד ("שנה מועד")';
      } else if (open.scheduledAt.getTime() <= now) {
        stage = 'awaiting_outcome';   needsAction = 'מועד השיחה עבר — לעדכן תוצאה (הושלם / לא ענה / בטל / שנה מועד)';
      } else if (open.prospectAvailability === 'rescheduled' || awaitingTime) {
        stage = 'awaiting_new_time';  needsAction = 'הליד ביקש מועד אחר — ממתינים למועד חדש';
      } else if (!qd.confirmedName) {
        stage = 'awaiting_name';      needsAction = 'חסר שם — סיכום למנהל יישלח כשהליד ימסור שם';
      } else if (open.status === 'callback_pending') {
        stage = 'pending_staff';      needsAction = 'ממתין לאישור הצוות ("אשר שיחה")';
      } else {
        stage = 'staff_confirmed';    needsAction = null;
      }

      const ts = qd.callTimeGivenAt ?? meta.callTimeGivenAt ?? null;
      const tsYear = ts ? new Date(ts).getUTCFullYear() : null;
      const flags = [];
      if (ts && !(tsYear >= 2020 && tsYear <= 2100)) flags.push('call_time_timestamp_invalid_review');
      if (meta.closingSummaryManagerState === 'failed') flags.push('manager_summary_failed');
      if (meta.closingSummaryManagerState === 'uncertain' || meta.closingSummaryProspectState === 'uncertain') flags.push('summary_send_uncertain_review');
      if (meta.closingSummaryProspectState === 'failed') flags.push('prospect_summary_failed');

      const { history, ...safe } = lead;
      rows.push({
        ...safe,
        fullPhone:   lead.phone,
        maskedPhone: maskPhone(lead.phone),
        stage, needsAction, flags,
        humanOwned:  lead.status === 'human_owns',
        apt: open ? {
          id:                    open.id,
          status:                open.status,
          rawTime:               open.rawTime,
          scheduledAt:           open.scheduledAt,
          scheduledLabel:        validDate(open.scheduledAt) ? formatCallbackTime(open.scheduledAt) : null,
          expired:               validDate(open.scheduledAt) ? open.scheduledAt.getTime() <= now : false,
          assignedStaffId:       open.assignedStaffId,
          staffConfirmedAt:      open.staffConfirmedAt ?? null,
          reminderSent:          open.reminderSent,
          reminderSentTo:        open.reminderSentTo ?? [],
          handoffSentTo:         open.handoffSentTo  ?? [],
          prospectReminderSent:  open.prospectReminderSent === true,
          prospectAvailability:  open.prospectAvailability ?? null,
          rescheduleCount:       open.rescheduleCount ?? 0,
          createdAt:             open.createdAt,
          updatedAt:             open.updatedAt,
        } : null,
      });
    }
    // Soonest call first; rows without a time last.
    rows.sort((a, b) => {
      const ta = a.apt?.scheduledAt ? new Date(a.apt.scheduledAt).getTime() : Infinity;
      const tb = b.apt?.scheduledAt ? new Date(b.apt.scheduledAt).getTime() : Infinity;
      return ta - tb;
    });
    return rows;
  }

  return {
    acceptTime, finalize, handleAvailabilityReply, cancelForOptOut,
    staffConfirm, staffOutcome, staffReschedule, panelRows,
    openCallback, isFuture, setLeadStatus,
    STOP_STATUSES, CALLBACK_STATUSES,
  };
}

module.exports = { createCallbackService, AVAIL_CONFIRM_RE, AVAIL_RESCHEDULE_RE, AVAIL_CANCEL_RE };
