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
 *     window a CANCELLATION WITH NO REPLACEMENT CLASS is never automatic - it stays under the cancellation policy.
 *   • MOVING inside that window (owner's business approval, 2026-11-17: the app's limit exists so that the member
 *     contacts the studio, and Tomer handles that contact on the studio's behalf): allowed for a move ONLY, when both
 *     classes have not started, and only when the separate capability `class_move_late` is switched on - which
 *     happens after a late move was verified against the real Arbox. The business approval is not proof that the API
 *     accepts a late cancellation; until that is verified a late move goes to the staff with the reason.
 *   • WHO: while ARBOX_WRITE_AUDIENCE is not 'all', only phones named in ARBOX_WRITE_TEST_PHONES (fail closed).
 *   • the member's bookings and remaining sessions are read BEFORE and AFTER (execute → balance), so a double
 *     charge or a double booking is seen and reported to the staff instead of being called a success.
 *
 * A MOVE NEVER LEAVES THE MEMBER WITHOUT A PLACE:
 *   1. book the new class            — refused or failed → nothing changed, the original booking is untouched
 *   2. read back from Arbox          — the new booking is not visible → STOP; the original is untouched
 *   3. cancel the original           — failed → she holds BOTH; the staff are told to cancel one by hand
 *   4. read back from Arbox          — success is stated to the member only after this read
 * A request whose outcome is unknown (timeout after sending) is never repeated; the state is read instead.
 */

const { ilDate, ilParts, ilDateString, addDays } = require('../utils/callback_time');

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
  inside_cancellation_window: 'הביטול נסגר לפי הכלל של השיעור ב-Arbox (ביטול מאוחר). ביטול בלי שיעור חלופי כפוף למדיניות הביטול, וההחלטה אצל הצוות.',
  late_move_unverified:      'המעבר הוא בתוך חלון הביטול של השיעור. מעבר מאוחר מאושר עסקית, אבל עדיין לא אומת ש-Arbox מאפשר אותו דרך ה-API, ולכן הוא מבוצע על ידי הצוות.',
  current_started:           'השיעור שממנו מבקשים לעבור כבר התחיל.',
  same_class:                'השיעור המבוקש הוא השיעור שהיא כבר רשומה אליו.',
  not_in_test_audience:      'פעולות הרישום של תומר פתוחות כרגע למספרי בדיקה בלבד.',
};

const digits = p => String(p ?? '').replace(/[^\d]/g, '');
/** Who may trigger a write: everyone only when ARBOX_WRITE_AUDIENCE=all; otherwise the phones in ARBOX_WRITE_TEST_PHONES. */
function defaultAudience(phone) {
  if (process.env.ARBOX_WRITE_AUDIENCE === 'all') return true;
  const list = new Set(String(process.env.ARBOX_WRITE_TEST_PHONES ?? '').split(',').map(digits).filter(p => /^\d{9,15}$/.test(p)));
  return list.has(digits(phone));
}

function createClassActions({ gateway, logger, now = () => new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)), verifyTries = 3, verifyWaitMs = 1500, audience = defaultAudience }) {
  const enabled = op => gateway.writesEnabled(op) === true;
  const refuse = (reason, extra = {}) => ({ ok: false, reason, text: REASON_HE[reason] ?? reason, ...extra });
  const startOf = (date, time) => { const [y, mo, d] = String(date).split('-').map(Number), [h, mi] = hhmm(time).split(':').map(Number); return ilDate(y, mo - 1, d, h, mi); };   // Israel time, DST included
  const sameSlot = (b, date, time) => b.date === date && hhmm(b.time) === hhmm(time);

  /**
   * Decide what may be done, from facts already read (member, bookings of the day, classes of the day).
   * Pure: sends nothing. -> { ok:true, kind, steps:[{op,args,what}], membershipUserId } | { ok:false, reason, text }
   */
  async function plan({ kind, member, date, bookings, classes, current, target, phone = null }) {
    const need = kind === 'move' ? ['class_book', 'class_cancel'] : kind === 'book' ? ['class_book'] : kind === 'cancel' ? ['class_cancel'] : null;
    if (!need) return refuse('writes_disabled');
    if (!need.every(enabled)) return refuse('writes_disabled');
    if (!audience(phone)) return refuse('not_in_test_audience');
    if (!member?.userId) return refuse('member_not_identified');
    const steps = [];
    let membershipUserId = null, late = false;

    if (kind === 'move' || kind === 'cancel') {
      const b = current?.booking;
      if (!b || !(bookings ?? []).some(x => sameSlot(x, b.date, b.time))) return refuse('current_not_found');
      const rows = (classes ?? []).filter(c => c.date === b.date && hhmm(c.start) === hhmm(b.time) && (!b.className || c.name === b.className));
      if (rows.length !== 1) return refuse('current_class_unclear');
      const cls = rows[0];
      if (!Number.isFinite(cls.cancelLockHours)) return refuse('cancel_rule_unknown');
      const hoursLeft = (startOf(cls.date, cls.start).getTime() - now().getTime()) / 3600000;
      const win = { hoursLeft: Math.round(hoursLeft * 10) / 10, lockHours: cls.cancelLockHours };
      if (hoursLeft <= 0) return refuse(kind === 'move' ? 'current_started' : 'inside_cancellation_window', win);
      if (hoursLeft < cls.cancelLockHours) {
        // a cancellation with no replacement stays under the cancellation policy; a MOVE is the owner-approved exception
        if (kind !== 'move') return refuse('inside_cancellation_window', win);
        if (!enabled('class_move_late')) return refuse('late_move_unverified', win);
        late = true;
      }
      steps.push({ op: 'class_cancel', args: { userId: member.userId, scheduleId: cls.scheduleId }, slot: { date: cls.date, time: hhmm(cls.start), name: cls.name }, what: `ביטול ${cls.name} ${hhmm(cls.start)}` });
    }
    if (kind === 'move' || kind === 'book') {
      const cls = target?.cls;
      if (!cls?.scheduleId) return refuse('target_not_found');
      if (startOf(cls.date, cls.start).getTime() <= now().getTime()) return refuse('target_started');
      if ((bookings ?? []).some(x => sameSlot(x, cls.date, cls.start))) return refuse(kind === 'move' && current?.booking && sameSlot(current.booking, cls.date, cls.start) ? 'same_class' : 'already_booked');
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
    return { ok: true, kind, steps, membershipUserId, userId: member.userId, date, late };
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
   * The member's bookings from today for 30 days and the sessions left that Arbox reports on them. Read fresh.
   * -> { ok:true, count, sessionsLeft:number|null, slots:[…] } | { ok:false, error }
   * sessionsLeft is the lowest value Arbox shows on those rows; null = Arbox reports no count (a period membership).
   */
  async function balance(userId) {
    try {
      const p = ilParts(now());
      const from = ilDateString({ year: p.year, month: p.month, day: p.day }), to = ilDateString(addDays({ year: p.year, month: p.month, day: p.day }, 30));
      const r = await gateway.getBookings(userId, { from, to, fresh: true });
      const left = r.bookings.map(b => b.sessionsLeft).filter(v => Number.isFinite(v));
      const slots = r.bookings.map(b => `${b.date} ${hhmm(b.time)}`);
      return { ok: true, count: r.bookings.length, sessionsLeft: left.length ? Math.min(...left) : null, slots, duplicates: slots.filter((x, i) => slots.indexOf(x) !== i) };
    } catch (err) { return { ok: false, error: String(err.message).slice(0, 200) }; }
  }
  /** What the two readings say about a finished plan. 'ok' only when the number of bookings changed exactly as planned and the sessions did not drop more than a new booking explains. */
  function compareBalance(kind, before, after) {
    if (!before?.ok || !after?.ok) return { check: 'unknown', note: 'יתרת הכניסות לא נקראה מ-Arbox לפני או אחרי הפעולה' };
    if (after.duplicates.length) return { check: 'mismatch', note: `רישום כפול לאותו שיעור: ${after.duplicates.join(', ')}` };
    const wantCount = before.count + (kind === 'book' ? 1 : kind === 'cancel' ? -1 : 0);
    if (after.count !== wantCount) return { check: 'mismatch', note: `מספר הרישומים הוא ${after.count}, והיה צריך להיות ${wantCount}` };
    if (before.sessionsLeft === null && after.sessionsLeft === null) return { check: 'ok', note: 'Arbox לא מדווח יתרת כניסות למנוי הזה; מספר הרישומים תקין' };
    if (before.sessionsLeft === null || after.sessionsLeft === null) {
      // Arbox reports the sessions on booking rows only: with no booking on one side (a first booking, a last cancellation)
      // there is nothing to compare, and the number of bookings is what was verified. A MOVE always has a row on both sides.
      const note = `יתרת כניסות לפני: ${before.sessionsLeft ?? 'לא מדווחת (אין רישום)'}, אחרי: ${after.sessionsLeft ?? 'לא מדווחת (אין רישום)'}; מספר הרישומים תקין`;
      return { check: kind === 'move' ? 'unknown' : 'ok', note };
    }
    const drop = before.sessionsLeft - after.sessionsLeft, allowed = kind === 'book' ? 1 : 0;
    if (drop > allowed) return { check: 'mismatch', note: `יתרת הכניסות ירדה מ-${before.sessionsLeft} ל-${after.sessionsLeft} (צפוי: ${allowed ? 'ירידה של כניסה אחת לכל היותר' : 'ללא שינוי'})` };
    return { check: 'ok', note: `יתרת כניסות לפני: ${before.sessionsLeft}, אחרי: ${after.sessionsLeft}` };
  }

  /**
   * Carry a plan out. -> { ok, done:[…], failed:{op,stage,…}|null, state:'done'|'nothing_changed'|'holds_both'|'unknown', log:[…] }
   * `ok` is true only when every step was accepted by Arbox AND seen in Arbox afterwards.
   * `balance` = { before, after, check:'ok'|'mismatch'|'unknown', note } - bookings and sessions read before and after.
   */
  async function execute(pl) {
    const log = [], done = [];
    const before = await balance(pl.userId);
    const out = async r => { const after = await balance(pl.userId); return { ...r, balance: { before, after, ...(r.ok ? compareBalance(pl.kind, before, after) : { check: 'unknown', note: 'הפעולה לא הושלמה' }) } }; };
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
          return out({ ok: false, done, failed: { op: st.op, stage: 'request', reason: entry.error.message, detail: entry.error.detail }, state: done.length ? 'holds_both' : 'nothing_changed', log });
        }
      }
      // accepted, or sent with an unknown outcome: only what Arbox shows now counts. Never a second request.
      entry.verify = await readState(pl.userId, st.slot, want);
      if (!entry.verify.verified) {
        logger.error('[class-actions] step not confirmed by a read-back — stopping', { op: st.op, verify: entry.verify });
        return out({ ok: false, done, failed: { op: st.op, stage: 'verify', reason: entry.verify.error ?? 'the change is not visible in Arbox' },
                 state: done.length ? 'holds_both' : 'unknown', log });
      }
      done.push(st.op);
    }
    return out({ ok: true, done, failed: null, state: 'done', log });
  }

  return { plan, execute, balance, enabled: () => enabled('class_book') || enabled('class_cancel'), allowedFor: phone => audience(phone), REASON_HE };
}

module.exports = { createClassActions, REASON_HE, defaultAudience };
