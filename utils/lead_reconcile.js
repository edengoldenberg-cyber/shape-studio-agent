'use strict';

/**
 * lead_reconcile.js — brings stored lead records back in line with the evidence. Runs at startup and after every
 * Arbox sync, so neither a sync nor a restart can bring a wrong classification back or drop a recorded refusal.
 *
 * Two things were wrong in production on 2026-11-17:
 *   1. the conversion detector treated every active Arbox row as a member — also a row with role 'lead' (someone who
 *      came to a trial lesson) and the owner's own 'staffMember' row. Such records became "converted_member".
 *   2. an explicit refusal to register lived only in the conversation history; no field recorded it.
 *
 * What this module does (and only this):
 *   A. Classification. A record marked as a member (status 'converted_member', or the member mark kept under a
 *      stop-status) is checked against the identity resolver — the same rule that routes Barak / Tomer:
 *        member / aggregator                         → correct, untouched
 *        lead / former member / staff, fresh, clear  → the member mark is removed; a 'converted_member' status goes
 *                                                      back to 'cold'. human_owns / opted_out are never changed.
 *        anything unclear (Arbox unreadable or old, several Arbox rows of different kinds on one phone, not in Arbox)
 *                                                    → marked for review, nothing guessed
 *      A corrected or review-marked record is put on an outreach hold: a correction never starts a campaign, a
 *      reminder or a follow-up.
 *   B. Refusal. A record without a refusal field whose stored history holds an explicit refusal that was not followed
 *      by an explicit request gets the field, with the original text, the original time (from the inbox) and the
 *      source 'history'.
 *
 * It never deletes a record, never sends anything, never touches Arbox and never releases human ownership.
 * Idempotent: a second run changes nothing.
 */

const salesRefusal = require('./sales_refusal');

const MEMBER_CATS   = new Set(['member', 'aggregator']);
const NOT_MEMBER    = new Set(['lead', 'former_member', 'staff']);
const STOP_STATUSES = new Set(['human_owns', 'opted_out', 'attribution_review', 'crisis', 'escalated']);
const KEEP_ON_REFUSAL = new Set([...STOP_STATUSES, 'converted_member', 'callback_requested', 'call_scheduled']);

const tail = p => `…${String(p).slice(-4)}`;

/**
 * @param {object} d
 *   store        lead store (getAllLeads, getLead, upsertLead, logEvent)
 *   identity     identity resolver (peek)
 *   inbox        optional: getThread(phone) → { messages: [{direction, text, timestamp, id}] }
 *   aptStore     optional: getActiveCallback(phone)
 *   computeProfile  optional: (lead, qualData, history) → qualProfile
 *   logger, now
 * @returns {{ checked, corrected: object[], review: object[], refusals: object[], unchanged: number }}
 */
function reconcile(d) {
  const { identity, inbox = null, aptStore = null, computeProfile = null, logger = console } = d;
  const nowIso = (d.now ? d.now() : new Date()).toISOString();
  const out = { checked: 0, corrected: [], review: [], refusals: [], unchanged: 0, deferred: 0 };
  // A correction is not activity of the lead: the store stamps lastActivity on every write, so it is put back.
  const store = { ...d.store, getAllLeads: () => d.store.getAllLeads(), getLead: p => d.store.getLead(p), logEvent: (...a) => d.store.logEvent(...a),
    upsertLead(phone, patch) { const before = d.store.getLead(phone)?.lastActivity; const rec = d.store.upsertLead(phone, patch); if (rec && before !== undefined) rec.lastActivity = before; return rec; } };

  for (const lead0 of store.getAllLeads()) {
    if (!lead0?.phone) continue;
    out.checked++;
    let changed = false;

    // ── A. classification ───────────────────────────────────────────────────────
    {
      const lead = store.getLead(lead0.phone), meta = lead.meta ?? {};
      const marked = lead.status === 'converted_member' || meta.isConfirmedMember === true || meta.previousStatus === 'converted_member';
      if (marked) {
        const id = identity?.peek ? identity.peek(lead.phone) : null;
        const cat = id?.category ?? 'unavailable';
        const mixed = (id?.others ?? []).length > 0 || id?.shared === true || id?.ambiguous === true;
        if (cat === 'unavailable' || id?.stale === true) {
          // Arbox could not be read, or the copy is old: no evidence either way. Nothing is marked; the next run decides.
          out.deferred = (out.deferred ?? 0) + 1;
        } else if (MEMBER_CATS.has(cat) && !mixed) {
          if (meta.classificationReview) {                    // the doubt is over: a valid membership, one Arbox row
            const { classificationReview, ...rest } = meta;
            store.upsertLead(lead.phone, { meta: rest }); changed = true;
          }
        } else if (NOT_MEMBER.has(cat) && !mixed) {
          const { isConfirmedMember, convertedAt, convertedSource, classificationReview, ...rest } = meta;
          const was = lead.status === 'converted_member' ? 'status converted_member' : 'member mark under ' + lead.status;
          const patch = { meta: { ...rest,
            ...(rest.previousStatus === 'converted_member' ? { previousStatus: 'cold' } : {}),
            classificationCorrected: { at: nowIso, was, evidence: cat, markedBy: convertedSource ?? null, markedAt: convertedAt ?? null, by: 'lead_reconcile' },
            outreachHold: { reason: 'classification_corrected', at: nowIso } } };
          if (lead.status === 'converted_member') patch.status = 'cold';
          store.upsertLead(lead.phone, patch);
          store.logEvent('classification_corrected', lead.phone, { was, evidence: cat });
          logger.info('[lead-reconcile] member mark removed — the Arbox evidence says otherwise', { phone: tail(lead.phone), was, evidence: cat });
          out.corrected.push({ phone: lead.phone, was, evidence: cat, status: patch.status ?? lead.status });
          changed = true;
        } else {
          const reason = mixed ? `כמה שורות Arbox על אותו טלפון: ${[cat, ...(id.others ?? [])].join(' + ')}`
            : cat === 'unknown' ? 'הטלפון אינו נמצא ב-Arbox' : `סיווג לא צפוי: ${cat}`;
          if (meta.classificationReview?.reason !== reason) {
            store.upsertLead(lead.phone, { meta: { ...meta, classificationReview: { at: meta.classificationReview?.at ?? nowIso, reason, evidence: cat, others: id?.others ?? [] },
              outreachHold: meta.outreachHold ?? { reason: 'classification_review', at: nowIso } } });
            store.logEvent('classification_review', lead.phone, { reason });
            logger.info('[lead-reconcile] classification left for review — nothing guessed', { phone: tail(lead.phone), reason });
            changed = true;
          }
          out.review.push({ phone: lead.phone, status: lead.status, reason });
        }
      }
    }

    // ── B. a refusal recorded only in the history ───────────────────────────────
    {
      const lead = store.getLead(lead0.phone), meta = lead.meta ?? {}, qd = meta.qualData ?? {};
      const never = qd.registrationDeclined === undefined && !qd.registrationReopenedAt;
      const userTexts = (lead.history ?? []).filter(m => m.role === 'user').map(m => String(m.content ?? ''));
      const st = never && userTexts.length ? salesRefusal.stateFromHistory(userTexts) : { declined: false };
      if (st.declined) {
        // the original time and id come from the inbox copy of that message; without one the time stays unknown
        const msgs = inbox?.getThread ? (inbox.getThread(lead.phone)?.messages ?? []) : [];
        // (the inbox can hold the WhatsApp message itself and the pipeline's own record of it: the WhatsApp one is the original)
        const same = msgs.filter(m => m.direction === 'in' && String(m.text ?? '').replace(/\s+/g, ' ').trim() === userTexts[st.index].replace(/\s+/g, ' ').trim());
        const src = [...same].reverse().find(m => !String(m.id ?? '').startsWith('wa-')) ?? same[same.length - 1] ?? null;
        const at = src?.timestamp ? new Date(src.timestamp).toISOString() : null;
        const openCb = aptStore?.getActiveCallback ? aptStore.getActiveCallback(lead.phone) : null;
        const qualData = { ...qd, registrationDeclined: true, registrationDeclinedAt: at, registrationDeclinedText: st.text,
          registrationDeclinedSource: 'history', registrationDeclinedMessageId: src?.id ?? null, registrationDeclinedRecordedAt: nowIso,
          declineCourtesyAnswered: st.courtesyAfter, callbackDeclined: true, callProposed: false };
        const keep = KEEP_ON_REFUSAL.has(lead.status);
        const patch = { score: Math.min(lead.score ?? 0, 2), meta: { ...meta, awaitingCallbackTime: false, qualData,
          ...(openCb ? { refusalReview: { at: nowIso, reason: 'בקשת חזרה פתוחה קיימת לצד סירוב מתועד — לסגירה בידי הצוות', aptId: openCb.id } } : {}) } };
        if (!keep) patch.status = 'cold';
        if (computeProfile) { try { patch.meta.qualProfile = computeProfile({ ...lead, ...patch }, qualData, lead.history ?? []); } catch { /* the profile is a display aid */ } }
        store.upsertLead(lead.phone, patch);
        store.logEvent('registration_declined_backfilled', lead.phone, { at, source: 'history' });
        logger.info('[lead-reconcile] refusal found in the stored history was recorded on the lead', { phone: tail(lead.phone), at, hadOpenCallback: !!openCb });
        out.refusals.push({ phone: lead.phone, at, text: st.text, openCallback: !!openCb });
        changed = true;
      }
    }
    if (!changed) out.unchanged++;
  }
  return out;
}

module.exports = { reconcile, MEMBER_CATS, NOT_MEMBER };
