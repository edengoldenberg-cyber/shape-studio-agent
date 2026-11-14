'use strict';

/**
 * member_care_replies.js — a member's reply to a proactive message continues THAT
 * conversation: the episode (program, source dates, what was asked) decides what the
 * reply means, before the general member classifier gets a chance to file it under an
 * unrelated payment / cancellation / sales template.
 *
 * One useful question at a time. Nothing is promised that the system cannot do:
 * renewals, guest sessions and anything needing a decision become staff cases.
 */

const { ilDateString } = require('../utils/callback_time');

const H = '[א-ת]';
const RE = {
  stop:     /תפסיק[וי]?(?:\s+בבקשה)?\s+(?:לשלוח|לכתוב|להטריד)|אל\s+תכתב[וי]?\s+לי|בלי\s+הודעות|די\s+עם\s+ההודעות|לא\s+רוצה\s+(?:לקבל\s+)?(?:תזכורות|הודעות כאלה)/,
  injury:   /פצוע|פציעה|נפצעתי|נפגעתי|חול[הי](?![א-ת])|מחלה|ניתוח|כאב|שבר(?:תי)?|לא\s+מרגיש(?:ה)?\s+טוב|הריון|ליד[הת]|רופא|פיזיותרפ|דלקת|שיקום/,
  vacation: /חופש[הת]?(?![א-ת])|בחו"ל|בחו״ל|חו"ל|חו״ל|נסיעה|נוסע(?:ת|ים)?(?![א-ת])|טס(?:ה|ים)?(?![א-ת])|מילואים|טיול|שבתון|לא\s+בארץ|מחוץ\s+לעיר/,
  dispute:  /כבר\s+(?:הייתי|התאמנתי|הגעתי|נרשמתי|קבעתי)|הייתי\s+(?:השבוע|אתמול|היום|ביום)|כן\s+הגעתי|התאמנתי\s+(?:השבוע|אתמול|היום)|הגעתי\s+(?:השבוע|אתמול|היום)|אני\s+(?:כן\s+)?רשומ(?:ה)?|יש\s+לי\s+(?:שיעור|אימון)\s+(?:קבוע|מחר|היום|ביום)/,
  dislike:  /לא\s+התחברתי|לא\s+אהבתי|לא\s+נהניתי|לא\s+בשבילי|פחות\s+מתאים|לא\s+מתאים\s+לי\s+(?:הסטודיו|המקום|הסגנון)|התאכזבתי/,
  schedule: /שעות|לו"ז|לו״ז|(?<![א-ת])לוז(?![א-ת])|לא\s+מסתדר|זמנים|עומס|עבודה|אין\s+לי\s+זמן|עסוק(?:ה)?|לחוצ?(?:ה)?\s+בזמן|ילדים/,
  guest:    /להביא\s+(?:חבר|חברה|את|מישהו|מישהי|אורח|בן|בת)|חבר(?:ה)?\s+(?:שלי\s+)?(?:רוצה|תגיע|יגיע|מעוניינ)|אימו(?:ן|ני)\s+אורח|(?<![א-ת])אורח(?:ת)?(?![א-ת])/,
  renew:    /לחדש|חידוש|להמשיך\s+(?:את\s+)?(?:ה)?מנוי|עוד\s+(?:חודש|תקופה)/,
  paid:     /שילמתי|שלמתי|עדכנתי|הסדרתי|סידרתי|טופל|סודר|הוסדר/,
  yes:      new RegExp(`^(?:כן|בטח|ברור|אשמח|יאללה|בשמחה|מעוניינ(?:ת)?|רוצה|אפשר|סבבה)(?!${H})`),
  no:       new RegExp(`^(?:לא|לא תודה|לא כרגע|אין צורך|ממש לא|לא מעוניינ(?:ת)?)(?!${H})`),
  fine:     /הכ[ו]?ל\s+(?:בסדר|טוב|מעולה)|בסדר\s+גמור|אחזור|חוזר(?:ת)?\s+(?:בקרוב|השבוע|בשבוע)|אגיע|מגיע(?:ה)?\s+(?:השבוע|מחר|היום)|מעולה|נהדר|כיף|אוהב(?:ת)?|נהני(?:ת|תי)|מרוצ(?:ה)?|תודה/,
};
// Topics that clearly belong to the general member service — the proactive conversation steps aside.
const FOREIGN = new Set(['membership_cancel', 'membership_freeze', 'billing_dispute', 'refund_request', 'receipt_request', 'class_book', 'class_cancel', 'class_reschedule',
  'class_cancelled_report', 'my_bookings', 'membership_info', 'location', 'staff_request', 'complaint', 'app_problem', 'waitlist', 'availability', 'schedule_query', 'regular_booking']);

module.exports = function createReplies({ store, gateway, cases, logger, now, PROGRAMS, addD, diffD, dmy, wday }) {
  const today = () => ilDateString(now());

  /** The proactive conversation a new message from this phone belongs to (or null). */
  function activeConversation(phone) {
    const days = store.getSettings().policy.replyWindowDays;
    const t = now().getTime();
    return store.listEpisodes({ phone, status: 'sent', limit: 50 })
      .filter(e => e.send?.at && (e.conversation?.awaiting || t - new Date(e.send.at).getTime() <= days * 86400000))
      .sort((a, b) => String(b.send.at).localeCompare(String(a.send.at)))[0] ?? null;
  }

  /** "עד 20.12" / "שבועיים" / "עד סוף החודש" → Israel date, or null when the text names no end. */
  function parseUntil(text) {
    const td = today();
    const m = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/.exec(text);
    if (m) {
      let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +td.slice(0, 4);
      const mk = yy => `${yy}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
      if (+m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31) return null;
      if (!m[3] && mk(y) < td) y += 1;
      return mk(y);
    }
    if (/סוף\s+החודש/.test(text)) { const [y, mo] = td.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); }
    const n = /(\d+)\s*(ימים|יום|שבועות|חודשים)/.exec(text);
    if (n) return addD(td, +n[1] * (n[2].startsWith('שבוע') ? 7 : n[2].startsWith('חודש') ? 30 : 1));
    if (/שבועיים/.test(text)) return addD(td, 14);
    if (/חודשיים/.test(text)) return addD(td, 60);
    if (/(?:עוד|למשך|ל)\s*-?\s*שבוע(?![א-ת])|שבוע\s+(?:הבא|אחד)/.test(text)) return addD(td, 7);
    if (/(?:עוד|למשך|ל)\s*-?\s*חודש(?![א-ת])/.test(text)) return addD(td, 30);
    return null;
  }

  async function handleReply(ctx, cls, api) {
    const ep = activeConversation(ctx.phone);
    if (!ep) return null;
    const t = ctx.text;
    const program = ep.program;
    const policy = store.getSettings().policy;
    const say = text => api.say(ctx.phone, text, { handler: `care_reply:${program}`, trigger: 'member_reply', name: ctx.name });
    /** Record the reply on the episode. `outcome` closes the conversation unless `awaiting` keeps it open. */
    const note = (kind, { outcome, awaiting = null, caseId, close = false } = {}) => store.upsertEpisode(ep.key, {
      ...(close ? { status: 'closed' } : {}), ...(caseId ? { caseId } : {}),
      conversation: { lastReplyAt: now().toISOString(), awaiting, ...(outcome ? { outcome } : {}), replies: [...(ep.conversation?.replies ?? []), { at: now().toISOString(), text: t.slice(0, 300), kind }].slice(-12) },
    }, { type: 'reply', detail: kind });
    /** endKnown = the member named the end date; false = a default length, shown as such in the panel. */
    const pause = (reason, until, endKnown, noteText) => store.setPause(ctx.phone, { reason, until, endKnown, note: noteText ?? t.slice(0, 200), setBy: 'member', userId: ep.userId, name: ep.name });
    const openCase = async (category, summary) => (await api.openCase({ ...ctx, text: `[בתגובה ל"${PROGRAMS[program].label}"] ${t}` }, category, { summary })).case;

    // ── answers to a question Tomer just asked ────────────────────────────────
    if (ep.conversation?.awaiting === 'vacation_until') {
      const until = parseUntil(t);
      if (until) { pause(store.getPause(ctx.phone, now())?.reason ?? 'vacation', until, true); note('vacation_until', { outcome: 'vacation' }); await say(`מעולה, לא אכתוב לך עד ${dmy(until)}. כשחוזרים — אנחנו כאן 💛`); }
      else { note('vacation_until_unclear', { outcome: 'vacation' }); await say(`אין בעיה — לא אכתוב לך בשבועיים הקרובים. כשחוזרים, אני כאן 💛`); }
      return api.R('care_reply', { episode: ep.key });
    }
    if (ep.conversation?.awaiting === 'dislike_detail') {
      const c = await openCase('member_feedback', 'משוב מחבר/ה: משהו לא התחבר');
      note('feedback', { outcome: 'feedback', caseId: c.id });
      await say(`תודה ששיתפת, זה חשוב לנו. רשמתי את הדברים לצוות.`);
      return api.R('case_opened', { caseId: c.id, episode: ep.key });
    }
    if (ep.conversation?.awaiting === 'schedule_pref') {
      note('schedule_pref', { outcome: 'schedule' });
      return api.schedule(ctx);                                  // the real timetable for the days / hours they named
    }

    // ── "stop writing to me" — proactive messages only ────────────────────────
    if (RE.stop.test(t)) {
      store.setCareOptOut(ctx.phone, 'member');
      note('stop', { outcome: 'stop', close: true });
      await say(`הבנתי, לא אשלח יותר הודעות יזומות. אם צריך משהו — אפשר תמיד לכתוב לי.`);
      return api.R('care_reply', { episode: ep.key });
    }
    if (cls.category === 'opt_out') { store.setCareOptOut(ctx.phone, 'member'); note('opt_out', { outcome: 'stop', close: true }); return null; }

    // ── injury / illness: staff, and no training nudges meanwhile ─────────────
    if (RE.injury.test(t)) {
      pause('injury', addD(today(), policy.defaultPauseDays), false);
      const c = await openCase('injury', 'חבר/ה דיווח/ה על פציעה או מצב רפואי בתגובה להודעת ליווי');
      note('injury', { outcome: 'injury', caseId: c.id });
      await say(`מצטער לשמוע, ותודה שעדכנת. רשמתי את זה לצוות המקצועי, ולא אשלח הודעות על אימונים בזמן הקרוב. רפואה שלמה 💛`);
      return api.R('case_opened', { caseId: c.id, episode: ep.key });
    }

    // ── away ──────────────────────────────────────────────────────────────────
    if (RE.vacation.test(t)) {
      const until = parseUntil(t);
      if (until) { pause('vacation', until, true); note('vacation', { outcome: 'vacation' }); await say(`תודה שעדכנת! לא אכתוב לך עד ${dmy(until)}. תיהנו 💛`); }
      else {
        // Outreach is paused at once; the end date is asked, not guessed.
        pause('vacation', addD(today(), policy.defaultPauseDays), false, `${t.slice(0, 160)} (תאריך חזרה לא ידוע — ברירת מחדל ${policy.defaultPauseDays} ימים)`);
        note('vacation', { outcome: 'vacation', awaiting: 'vacation_until' });
        await say(`תודה שעדכנת! עד מתי בערך? כך אדע לא לכתוב לך בזמן הזה.`);
      }
      return api.R('care_reply', { episode: ep.key });
    }

    // ── "but I did train / I am booked" — recheck the source before answering ─
    if (RE.dispute.test(t) && ['tuesday', 'absence7', 'absence14', 'onboarding14', 'month1'].includes(program)) {
      let found = null, failed = false;
      try {
        const td = today();
        const r = await gateway.getBookings(ep.userId, { from: addD(td, -20), to: addD(td, 7), fresh: true });
        const since = program === 'tuesday' ? (ep.sourceDates?.weekStart ?? addD(td, -wday(td))) : ep.sourceDates?.lastAttendance ? addD(ep.sourceDates.lastAttendance, 1) : (ep.sourceDates?.firstMembershipStart ?? addD(td, -14));
        const att = r.bookings.filter(b => b.checkedIn && b.date >= since && b.date <= td).at(-1);
        const fut = r.bookings.find(b => !b.checkedIn && b.date > td);
        found = att ? `כניסה רשומה ב-${dmy(att.date)}` : fut ? `רישום לאימון ב-${dmy(fut.date)} בשעה ${fut.time}` : null;
      } catch (err) { failed = true; logger.warn('[member-care] could not recheck attendance for a disputed message', { error: err.message }); }
      if (found) {
        note('dispute_confirmed', { outcome: 'data_corrected', close: true });
        await say(`נכון, סליחה על הבלבול 🙏 עכשיו אני רואה ${found}. נתראה בסטודיו 💛`);
        return api.R('care_reply', { episode: ep.key });
      }
      const c = await openCase('data_review', 'חבר/ה אומר/ת שהנתון ב-Arbox שגוי (נוכחות / רישום) — לבדוק');
      note('dispute_open', { outcome: 'disputed', caseId: c.id });
      await say(failed ? `לא הצלחתי לבדוק כרגע את הנתונים, אז רשמתי לצוות לבדוק את הרישום. סליחה על הבלבול 🙏` : `בדקתי שוב ואני עדיין לא רואה אצלי כניסה או רישום מתאים. רשמתי לצוות לבדוק — סליחה על הבלבול 🙏`);
      return api.R('case_opened', { caseId: c.id, episode: ep.key });
    }

    // ── guest sessions (the approved first-month gift) ────────────────────────
    const ent = store.getEntitlement(ep.userId);
    if (RE.guest.test(t) || (program === 'month1' && RE.yes.test(t))) {
      if (!ent) { if (program !== 'month1') return null; }
      if (ent && ent.remaining <= 0) {
        note('guest_none_left', { outcome: 'guest_none_left' });
        await say(`לפי הרישום אצלי, שני אימוני האורח שלך כבר שמורים או נוצלו. אם זו טעות — כתבו לי ואבקש מהצוות לבדוק.`);
        return api.R('care_reply', { episode: ep.key });
      }
      const c = await openCase('guest_pass', `בקשה לאימון אורח${ent ? ` (נותרו ${ent.remaining} מתוך ${ent.total})` : ''}`);
      note('guest', { outcome: 'guest_requested', caseId: c.id });
      await say(`מעולה! רשמתי לצוות את הבקשה לאימון אורח, והם יתאמו איתך את הפרטים. האימון עוד לא נקבע בשלב זה.`);
      return api.R('case_opened', { caseId: c.id, episode: ep.key });
    }

    // ── renewal (non-recurring membership about to end) ───────────────────────
    if (program === 'expiry5' && (RE.renew.test(t) || RE.yes.test(t)) && !RE.no.test(t)) {
      const c = await openCase('membership_renew', `בקשת חידוש מנוי${ep.sourceDates?.membershipName ? ` — ${ep.sourceDates.membershipName}` : ''} (בתוקף עד ${dmy(ep.sourceDates?.endDate)})`);
      note('renew_yes', { outcome: 'renew_requested', caseId: c.id });
      await say(`מעולה — רשמתי לצוות את הבקשה לחדש את המנוי. המנוי לא חודש ולא בוצע חיוב בשלב זה.`);
      return api.R('case_opened', { caseId: c.id, episode: ep.key });
    }
    if (program === 'expiry5' && RE.no.test(t)) {
      note('renew_no', { outcome: 'declined', close: true });
      await say(`אין בעיה, תודה על העדכון 🙏 אם משהו ישתנה — אני כאן.`);
      return api.R('care_reply', { episode: ep.key });
    }

    // ── failed payment: "I paid" is checked, not believed ─────────────────────
    if (program === 'payment_failed' && RE.paid.test(t)) {
      let resolved = false, failed = false;
      try {
        gateway.clearCache('transactions');
        const r = await gateway.getTransactions({ from: addD(today(), -30), to: today() });
        resolved = r.transactions.some(x => String(x.membershipUserId) === String(ep.sourceDates?.membershipUserId) && x.status === 'SUCCESS' && String(x.at) > String(ep.sourceDates?.lastFailureAt));
      } catch { failed = true; }
      if (resolved) { note('paid_confirmed', { outcome: 'resolved', close: true }); await say(`תודה! אני רואה שהחיוב עבר 🙏`); return api.R('care_reply', { episode: ep.key }); }
      const c = await openCase('payment_issue', 'חבר/ה מדווח/ת שהתשלום הוסדר — עדיין לא נראה חיוב מוצלח');
      note('paid_unverified', { outcome: 'paid_claimed', caseId: c.id });
      await say(failed ? `תודה על העדכון. לא הצלחתי לבדוק כרגע, אז רשמתי לצוות לוודא.` : `תודה על העדכון. אצלי עדיין לא מופיע חיוב שעבר, אז רשמתי לצוות לבדוק.`);
      return api.R('case_opened', { caseId: c.id, episode: ep.key });
    }

    // Anything that is clearly another service topic goes to the general flow.
    if (FOREIGN.has(cls.category)) { note('other_topic', { outcome: ep.conversation?.outcome ?? 'engaged' }); return null; }

    if (RE.dislike.test(t)) {
      note('dislike', { outcome: 'feedback', awaiting: 'dislike_detail' });
      await say(`תודה על הכנות, זה חשוב לנו. מה היה חסר לך, או מה היה עוזר לך להרגיש יותר בבית?`);
      return api.R('care_reply', { episode: ep.key });
    }
    const attendanceTalk = ['tuesday', 'absence7', 'absence14', 'onboarding14'].includes(program);
    if (RE.schedule.test(t) || (attendanceTalk && RE.yes.test(t))) {
      note('schedule', { outcome: 'schedule', awaiting: 'schedule_pref' });
      await say(RE.yes.test(t) ? `בשמחה! אילו ימים ושעות נוחים לך בדרך כלל? אבדוק מה יש במערכת.` : `מבין. אילו ימים ושעות נוחים לך בדרך כלל? אבדוק מה יש במערכת.`);
      return api.R('care_reply', { episode: ep.key });
    }
    if (RE.no.test(t)) { note('no', { outcome: 'declined', close: true }); await say(`אין בעיה 🙏 אנחנו כאן כשיתאים לך.`); return api.R('care_reply', { episode: ep.key }); }
    if (RE.fine.test(t)) {
      note('fine', { outcome: 'ok', close: true });
      if (program === 'birthday' || program === 'welcome') return api.R('silent', { reason: 'thanks after a greeting', episode: ep.key });
      await say(`שמח לשמוע 💛 אנחנו כאן כשמתאים לך.`);
      return api.R('care_reply', { episode: ep.key });
    }
    // Not something this conversation can interpret: recorded on the episode, handled by the general flow.
    note('other', { outcome: ep.conversation?.outcome ?? 'replied' });
    return null;
  }

  return { activeConversation, handleReply, parseUntil };
};
