'use strict';

/**
 * class_actions.js — booking, cancelling and MOVING a member's class in Arbox, for Tomer.
 *
 * OFF BY DEFAULT. Nothing here sends a request unless the gateway says the operation is executable, which needs ALL of:
 *   ARBOX_WRITES_ENABLED=true · the operation named in ARBOX_WRITE_OPS · its contract marked verified in
 *   services/arbox_gateway.js (after one approved request against a test member).
 * Until then plan() answers { ok:false, reason:'writes_disabled' } and the caller hands the request to the staff.
 *
 * The two operations (official OpenAPI, https://arboxserver.arboxapp.com/docs/api.json):
 *   class_book    POST /v3/schedule/bookSession        { user_id, schedule_id, membership_user_id }
 *   class_cancel  POST /v3/schedule/cancelUserBooking  { schedule_id, user_id }
 * No other field is ever sent (no book_without_membership, no late-cancellation flags: their effect is undocumented).
 *
 * RULES (every one is checked from data READ from Arbox just before acting; a rule that cannot be checked refuses):
 *   • the member is identified unambiguously, and has exactly ONE active membership that covers the day of the class;
 *   • booking: the class exists, has not started, its real occupancy is known and a place is free, and she is not
 *     already booked into it;
 *   • cancelling: the booking exists in Arbox, the class is identified by exactly one schedule row, and the class's own
 *     cancellation rule in Arbox (disable_cancellation_time, hours before the start) is still open. Inside that
 *     window nothing is cancelled automatically - it is a late cancellation and a decision for the staff.
 *
 * A MOVE NEVER LEAVES THE MEMBER WITHOUT A PLACE:
 *   1. book the new class            — refused or failed → nothing changed, the original booking is untouched
 *   2. read back from Arbox          — the new booking is not visible → STOP; the original is untouched
 *   3. cancel the original           — failed → she holds BOTH; the staff are told to cancel one by hand
 *   4. read back from Arbox          — success is stated to the member only after this read
 * A request whose outcome is unknown (timeout after sending) is never repeated; the state is read instead.
 */

const { ilDate } = require('../utils/callback_time');

const hhmm = t => String(t ?? '').slice(0, 5);
const REASON_HE = {
  writes_disabled:           'אין לתומר הרשאה לשנות רישום לשיעור ב-Arbox (פעולות הכתיבה כבויות).',
  member_not_identified:     'המתאמנ/ת לא זוהתה באופן חד-משמעי ב-Arbox לפי מספר הטלפון.',
  no_active_membership:      'לא נמצא ב-Arbox מנוי פעיל שמכסה את יום השיעור.',
  membership_ambiguous:      'יש ב-Arbox יותר ממנוי פעיל אחד, ולא ברור על איזה מהם לרשום.',
  membership_unreadable:     'המנוי לא נקרא מ-Arbox.',
  target_not_found:          'השיעור המבוקש לא נמצא ב-Arbox.',
  target_started:            'השיעור המבוקש כבר התחיל.',
  occupancy_unknown:         'מספר המקומות הפנויים בשיעור המבוקש לא נקרא מ-Arbox.',
  target_full:               'השיעור המבוקש מלא. אין ב-Arbox פעולה מתועדת להצטרפות לרשימת המתנה.',
  already_booked:            'כבר קיים ב-Arbox רישום לשיעור המבוקש.',
  current_not_found:         'הרישום שמבקשים לבטל לא נמצא ב-Arbox.',
  current_class_unclear:     'השיעור של הרישום הקיים לא זוהה באופן חד-משמעי במערכת השיעורים.',
  cancel_rule_unknown:       'כלל הביטול של השיעור לא נקרא מ-Arbox.',
  inside_cancellation_window: 'הביטול נסגר לפי הכלל של השיעור ב-Arbox (ביטול מאוחר). ההחלטה אצל הצוות.',
};

function createClassActions({ gateway, logger, now = () => new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)), verifyTries = 3, verifyWaitMs = 1500 }) {
  const enabled = op => gateway.writesEnabled(op) === true;
  const refuse = (reason, extra = {}) => ({ ok: false, reason, text: REASON_HE[reason] ?? reason, ...extra });
  const startOf = (date, time) => { const [y, mo, d] = String(date).split('-').map(Number), [h, mi] = hhmm(time).split(':').map(Number); return ilDate(y, mo - 1, d, h, mi); };   // Israel time, DST included
  const sameSlot = (b, date, time) => b.date === date && hhmm(b.time) === hhmm(time);

  /**
   * Decide what may be done, from facts already read (member, bookings of the day, classes of the day).
   * Pure: sends nothing. -> { ok:true, kind, steps:[{op,args,what}], membershipUserId } | { ok:false, reason, text }
   */
  async function plan({ kind, member, date, bookings, classes, current, target }) {
    const need = kind === 'move' ? ['class_book', 'class_cancel'] : kind === 'book' ? ['class_book'] : kind === 'cancel' ? ['class_cancel'] : null;
    if (!need) return refuse('writes_disabled');
    if (!need.every(enabled)) return refuse('writes_disabled');
    if (!member?.userId) return refuse('member_not_identified');
    const steps = [];
    let membershipUserId = null;

    if (kind === 'move' || kind === 'cancel') {
      const b = current?.booking;
      if (!b || !(bookings ?? []).some(x => sameSlot(x, b.date, b.time))) return refuse('current_not_found');
      const rows = (classes ?? []).filter(c => c.date === b.date && hhmm(c.start) === hhmm(b.time) && (!b.className || c.name === b.className));
      if (rows.length !== 1) return refuse('current_class_unclear');
      const cls = rows[0];
      if (!Number.isFinite(cls.cancelLockHours)) return refuse('cancel_rule_unknown');
      const hoursLeft = (startOf(cls.date, cls.start).getTime() - now().getTime()) / 3600000;
      if (hoursLeft < cls.cancelLockHours || hoursLeft <= 0) return refuse('inside_cancellation_window', { hoursLeft: Math.round(hoursLeft * 10) / 10, lockHours: cls.cancelLockHours });
      steps.push({ op: 'class_cancel', args: { userId: member.userId, scheduleId: cls.scheduleId }, slot: { date: cls.date, time: hhmm(cls.start), name: cls.name }, what: `ביטול ${cls.name} ${hhmm(cls.start)}` });
    }
    if (kind === 'move' || kind === 'book') {
      const cls = target?.cls;
      if (!cls?.scheduleId) return refuse('target_not_found');
      if (startOf(cls.date, cls.start).getTime() <= now().getTime()) return refuse('target_started');
      if ((bookings ?? []).some(x => sameSlot(x, cls.date, cls.start))) return refuse('already_booked');
      if (!cls.occupancy) return refuse('occupancy_unknown');
      if (!(cls.occupancy.spotsLeft > 0)) return refuse('target_full');
      let ms;
      try { ms = (await gateway.getMemberships(member.userId)).memberships; } catch { return refuse('membership_unreadable'); }
      const live = ms.filter(m => m.active && !m.cancelled && (!m.startDate || m.startDate <= cls.date) && (!m.endDate || m.endDate >= cls.date));
      if (!live.length) return refuse('no_active_membership');
      if (live.length > 1) return refuse('membership_ambiguous');
      membershipUserId = live[0].membershipUserId;
      // the new class is booked FIRST: a move must never start by giving up the place she has
      steps.unshift({ op: 'class_book', args: { userId: member.userId, scheduleId: cls.scheduleId, membershipUserId }, slot: { date: cls.date, time: hhmm(cls.start), name: cls.name }, what: `רישום ל${cls.name} ${hhmm(cls.start)}` });
    }
    return { ok: true, kind, steps, membershipUserId, userId: member.userId, date };
  }

  /** Is a booking of that slot visible in Arbox now? Read fresh; a few tries, because a report can lag a write. */
  async function readState(userId, slot, want) {
    let seen = null, error = null;
    for (let k = 0; k < verifyTries; k++) {
      if (k) await sleep(verifyWaitMs);
      try {
        const r = await gateway.getBookings(userId, { from: slot.date, to: slot.date, fresh: true });
        seen = r.bookings.some(b => sameSlot(b, slot.date, slot.time)); error = null;
        if (seen === want) return { verified: true, seen, tries: k + 1 };
      } catch (err) { error = err.message; }
    }
    return { verified: false, seen, error, tries: verifyTries };
  }

  /**
   * Carry a plan out. -> { ok, done:[…], failed:{op,stage,…}|null, state:'done'|'nothing_changed'|'holds_both'|'unknown', log:[…] }
   * `ok` is true only when every step was accepted by Arbox AND seen in Arbox afterwards.
   */
  async function execute(pl) {
    const log = [], done = [];
    for (const st of pl.steps) {
      const want = st.op === 'class_book';
      const entry = { op: st.op, what: st.what, request: { ...st.args }, accepted: null, error: null, verify: null };
      log.push(entry);
      try {
        const r = await gateway.executeWrite(st.op, st.args);
        entry.accepted = true; entry.status = r.status;
      } catch (err) {
        entry.accepted = false; entry.error = { kind: err.kind ?? 'error', message: String(err.message).slice(0, 300), uncertain: !!err.uncertain, detail: err.detail ?? null };
        if (!err.uncertain) {                               // Arbox refused, or nothing was sent: this step changed nothing
          logger.warn('[class-actions] step refused', { op: st.op, kind: err.kind, message: err.message });
          return { ok: false, done, failed: { op: st.op, stage: 'request', reason: entry.error.message }, state: done.length ? 'holds_both' : 'nothing_changed', log };
        }
      }
      // accepted, or sent with an unknown outcome: only what Arbox shows now counts. Never a second request.
      entry.verify = await readState(pl.userId, st.slot, want);
      if (!entry.verify.verified) {
        logger.error('[class-actions] step not confirmed by a read-back — stopping', { op: st.op, verify: entry.verify });
        return { ok: false, done, failed: { op: st.op, stage: 'verify', reason: entry.verify.error ?? 'the change is not visible in Arbox' },
                 state: done.length ? 'holds_both' : 'unknown', log };
      }
      done.push(st.op);
    }
    return { ok: true, done, failed: null, state: 'done', log };
  }

  return { plan, execute, enabled: () => enabled('class_book') || enabled('class_cancel'), REASON_HE };
}

module.exports = { createClassActions, REASON_HE };
