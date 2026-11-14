'use strict';

/**
 * member_care.js — Tomer's proactive member care: welcome, weekly / 7-day / 14-day
 * attendance follow-up, birthdays, failed monthly payment, non-recurring expiry,
 * two-week onboarding and first-month check-in (with guest-session entitlement).
 *
 * Principles
 *   • Every program is OFF until enabled in the panel, AND the deployment switch
 *     TOMER_PROACTIVE_ENABLED must be 'true', AND the recipient must pass the test-only
 *     allowlist. A program whose configuration or data is missing is BLOCKED, visibly.
 *   • No historical backlog: a program only acts on events that happen on / after its
 *     activation baseline (the moment it was first enabled).
 *   • Unknown is never treated as negative: no attendance DATA ≠ absence; no billing data
 *     ≠ failed payment; a membership ROW's creation time ≠ joining time (see firstMembership).
 *   • One eligibility episode = one durable record (member, program, source dates, message
 *     id, conversation outcome). An episode is sent at most once; an ambiguous provider
 *     result is 'uncertain' and is never re-sent automatically.
 *   • Eligibility is re-read from Arbox for that member immediately before sending.
 *   • Replies continue the episode's conversation (handleReply) instead of falling into
 *     unrelated templates.
 *
 * Arbox sources (observed with GET-only probes, 2026-11-14 — see arbox_gateway.js):
 *   members / birthdays      /v3/users                         (all pages)
 *   memberships              /v3/users/memberships             (all pages; created_at, start/end)
 *   recurring or not         /v3/membershipTypes               (is_recurring_payment; deleted types are absent)
 *   verified attendance      /v3/reports/bookingsReport        (check_in === 'Yes'; ≤ 31 days per call)
 *   future bookings          same report, future dates; cancellations removed via bookingCancellationReport
 *   freezes                  /v3/reports/membersOnHoldReport   (row shape never observed live)
 *   failed charges           /v3/reports/transactionsReport    (status 'FAIL', type 'RECURRING')
 */

const { ilParts, ilDateString } = require('../utils/callback_time');
const policyLib = require('./contact_policy');

// ── dates (Israel calendar dates as 'YYYY-MM-DD') ─────────────────────────────
const utc   = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const addD  = (iso, n) => new Date(utc(iso) + n * 86400000).toISOString().slice(0, 10);
const diffD = (a, b) => Math.round((utc(a) - utc(b)) / 86400000);
const wday  = iso => new Date(utc(iso)).getUTCDay();
const dmy   = iso => String(iso ?? '').slice(0, 10).split('-').reverse().join('.');
const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const PROGRAMS = {
  welcome:        { label: 'ברוכים הבאים',                 needs: ['users', 'memberships', 'types'] },
  payment_failed: { label: 'חיוב חודשי שנכשל',             needs: ['users', 'transactions'] },
  birthday:       { label: 'יום הולדת',                    needs: ['users', 'memberships'] },
  expiry5:        { label: 'מנוי לא-מתחדש — 5 ימים לסיום', needs: ['users', 'memberships', 'types'] },
  absence14:      { label: '14 ימים בלי אימון',            needs: ['users', 'memberships', 'attendance', 'futureBookings'] },
  absence7:       { label: '7 ימים בלי אימון',             needs: ['users', 'memberships', 'attendance', 'futureBookings'] },
  tuesday:        { label: 'יום שלישי — אין אימון השבוע',   needs: ['users', 'memberships', 'attendance', 'futureBookings'] },
  onboarding14:   { label: 'שבועיים מההצטרפות',            needs: ['users', 'memberships', 'types', 'attendance'] },
  month1:         { label: 'חודש ראשון + אימוני אורח',      needs: ['users', 'memberships', 'types', 'attendance'] },
};
const PRIORITY = ['welcome', 'payment_failed', 'birthday', 'expiry5', 'absence14', 'absence7', 'tuesday', 'onboarding14', 'month1'];
const DONE = new Set(['sending', 'sent', 'uncertain', 'closed', 'expired', 'cancelled']);   // never (re)sent by a run

const EXCL_HE = {
  not_active: 'אין מנוי פעיל', joined_this_week: 'הצטרף/ה השבוע', attended_this_week: 'כבר התאמן/ה השבוע (כניסה מאומתת)',
  has_booking_this_week: 'יש רישום פעיל להמשך השבוע', absence_track: 'בטיפול תוכנית ההיעדרות (7+ ימים)',
  attendance_unknown: 'אין כניסה מאומתת ב-30 הימים האחרונים — משך ההיעדרות לא ידוע', new_never_attended: 'חבר/ה חדש/ה שעוד לא הגיע/ה לאימון ראשון',
  not_in_window: 'לא בחלון הימים של התוכנית', before_baseline: 'האירוע קדם להפעלת התוכנית (אין שליחה רטרואקטיבית)', has_upcoming_booking: 'יש רישום לאימון קרוב',
  no_birthday: 'אין תאריך לידה ב-Arbox', birthday_invalid: 'תאריך הלידה ב-Arbox אינו סביר', not_today: 'לא היום',
  recurring: 'מנוי מתחדש אוטומטית', type_unknown: 'סוג המנוי נמחק ב-Arbox — לא ידוע אם מתחדש', no_end_date: 'אין תאריך סיום', renewed: 'כבר קיים מנוי חדש / ממשיך',
  not_first: 'אינו המנוי הראשון (חידוש)', earlier_unknown: 'קיים מנוי קודם מסוג לא ידוע — לא ניתן לאשר שזה חבר/ה חדש/ה', member_since_earlier: 'לפי Arbox החברות התחילה לפני המנוי הזה (ייבוא / חבר/ה ותיק/ה)',
  no_first_membership: 'לא נמצא מנוי ראשון מזוהה', too_old: 'ההצטרפות לפני יותר משבוע', resolved: 'החיוב הוסדר', in_grace: 'ממתין לזמן החסד אחרי הכשל', already_handled: 'כבר טופל באפיזודה הזו',
};

function createMemberCare(deps) {
  const {
    gateway, store, cases, logger,
    sendMember,                                  // async (phone, text, meta) → { state: 'sent'|'uncertain'|'failed'|'blocked'|'queued', idMessage, error }
    state: st,                                   // { proactiveOn(), allowed(phone), owner(phone), lastConversationAt(phone), testPhones() }
    audit = () => {},
    now = () => new Date(),
  } = deps;
  const OWNER = 'care-' + Math.random().toString(36).slice(2, 10);

  // ── configuration / blocking ────────────────────────────────────────────────
  function programBlocks(id, settings = store.getSettings()) {
    const out = [];
    if (id === 'welcome' && !/^https:\/\/chat\.whatsapp\.com\/\S{10,}$/.test(String(settings.groupLink ?? ''))) out.push({ code: 'group_link_missing', text: 'לא הוגדר קישור מאושר לקבוצת הוואטסאפ של הסטודיו' });
    if (id === 'payment_failed') {
      if (!String(settings.paymentResolution ?? '').trim()) out.push({ code: 'payment_resolution_missing', text: 'לא הוגדרה דרך מאושרת ובטוחה להסדרת התשלום (קישור / הנחיה)' });
      if (!settings.billingDataConfirmed) out.push({ code: 'billing_data_unconfirmed', text: 'משמעות נתוני החיוב ב-Arbox (FAIL בדוח העסקאות) עוד לא אושרה על ידי בעלת הסטודיו' });
    }
    return out;
  }
  const baseline = (id, settings, today) => (settings.programs[id]?.activatedAt ? ilDateString(new Date(settings.programs[id].activatedAt)) : today);

  // ── snapshot of Arbox ───────────────────────────────────────────────────────
  async function loadSnapshot({ fresh = false } = {}) {
    const today = ilDateString(now());
    const p = ilParts(now());
    const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    if (fresh) for (const k of ['bookings:all', 'cancellations:all', 'memberships:all', 'transactions', 'holds']) gateway.clearCache(k);
    const src = {};
    const grab = async (name, fn) => {
      try { const r = await fn(); src[name] = { ok: true, fetchedAt: new Date(r.fetchedAt ?? now().getTime()).toISOString(), stale: !!r.stale, source: r.source }; return r; }
      catch (err) { src[name] = { ok: false, error: err.message }; return null; }
    };
    const users = await grab('users', () => gateway.getAllUsers());
    const mems  = await grab('memberships', () => gateway.getAllMemberships());
    const types = await grab('types', () => gateway.getMembershipTypes());
    const past  = await grab('attendance', () => gateway.getAllBookings({ from: addD(today, -30), to: today }));
    const fut   = await grab('futureBookings', () => gateway.getAllBookings({ from: addD(today, 1), to: addD(today, 7) }));
    const canc  = await grab('cancellations', () => gateway.getAllCancellations({ from: today, to: addD(today, 7) }));
    const holds = await grab('holds', () => gateway.getHolds({ from: addD(today, -1), to: addD(today, 29) }));
    const tx    = await grab('transactions', () => gateway.getTransactions({ from: addD(today, -30), to: today }));
    if (!canc) src.futureBookings = { ok: false, error: 'cancellations unavailable — a cancelled booking could be counted as a booking' };

    const typeById = new Map((types?.types ?? []).map(t => [String(t.typeId), t]));
    const kindOf = m => typeById.get(String(m.typeId))?.kind ?? 'unknown';
    const memsBy = new Map();
    for (const m of mems?.memberships ?? []) { const k = String(m.userId); if (!memsBy.has(k)) memsBy.set(k, []); memsBy.get(k).push({ ...m, kind: kindOf(m), recurring: typeById.get(String(m.typeId))?.recurring ?? null }); }
    const cancelled = new Set((canc?.cancellations ?? []).map(c => `${c.userId}|${c.date}|${c.time}`));
    const checkins = new Map(), future = new Map();
    for (const b of [...(past?.bookings ?? []), ...(fut?.bookings ?? [])]) {
      const k = String(b.userId);
      if (b.checkedIn && b.date <= today) { if (!checkins.has(k)) checkins.set(k, new Set()); checkins.get(k).add(b.date); }
      else if ((b.date > today || (b.date === today && b.time > hhmm)) && !cancelled.has(`${b.userId}|${b.date}|${b.time}`)) { if (!future.has(k)) future.set(k, []); future.get(k).push({ date: b.date, time: b.time, className: b.className }); }
    }
    const onHold = new Set(holds?.userIds ?? []);
    const clients = (users?.users ?? []).filter(u => u.role === 'client');
    const phoneCount = new Map(); for (const u of clients) if (u.active && u.phone) phoneCount.set(u.phone, (phoneCount.get(u.phone) ?? 0) + 1);
    const weekStart = addD(today, -wday(today)), weekEnd = addD(weekStart, 6);
    const SERVICE = k => k === 'plan' || k === 'session' || k === 'unknown';

    const members = clients.map(u => {
      const id = String(u.userId);
      const ms = (memsBy.get(id) ?? []).slice().sort((a, b) => String(a.createdAt ?? a.startDate ?? '').localeCompare(String(b.createdAt ?? b.startDate ?? '')));
      const activeMs = ms.filter(m => m.active && !m.cancelled && SERVICE(m.kind) && (!m.startDate || m.startDate <= today) && (!m.endDate || m.endDate >= today));
      const known = ms.filter(m => m.kind === 'plan' || m.kind === 'session');
      const first = known[0] ?? null;
      const firstStart = first ? (first.startDate ?? String(first.createdAt ?? '').slice(0, 10)) : null;
      let firstWhyNot = null;
      if (!first) firstWhyNot = 'no_first_membership';
      else if (ms.some(m => m.kind === 'unknown' && String(m.createdAt ?? '') < String(first.createdAt ?? ''))) firstWhyNot = 'earlier_unknown';
      else if (u.memberSince && firstStart && diffD(firstStart, u.memberSince) > 3) firstWhyNot = 'member_since_earlier';
      const ci = [...(checkins.get(id) ?? [])].sort();
      const last = ci.at(-1) ?? null;
      const fb = (future.get(id) ?? []).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      const earliestStart = activeMs.map(m => m.startDate).filter(Boolean).sort()[0] ?? null;
      return {
        userId: id, phone: u.phone ?? null, phoneShared: !!u.phone && (phoneCount.get(u.phone) ?? 0) > 1,
        name: u.name, firstName: u.firstName, gender: u.gender, birthday: u.birthday, memberSince: u.memberSince,
        isActive: !!u.active && activeMs.length > 0, onHold: onHold.has(id), memberships: ms, activeMs,
        first: firstWhyNot ? null : first, firstStart: firstWhyNot ? null : firstStart, firstWhyNot,
        checkins: ci, lastAttendance: last, daysAbsent: last ? diffD(today, last) : null,
        attendedThisWeek: ci.some(d => d >= weekStart), future: fb, futureThisWeek: fb.filter(b => b.date <= weekEnd),
        earliestActiveStart: earliestStart,
        neverAttended: !last && !!earliestStart && diffD(today, earliestStart) <= 30,
      };
    });
    return { today, hhmm, weekStart, weekEnd, src, members, byId: new Map(members.map(m => [m.userId, m])), transactions: tx?.transactions ?? null };
  }

  // ── eligibility per program (pure on a snapshot) ────────────────────────────
  // Each evaluator returns { cand: {key, variant, sourceDates, validUntil, vars} } or { excl: [codes] }.
  const E = {
    welcome(m, snap, base) {
      if (!m.isActive) return { excl: ['not_active'] };
      if (!m.first) return { excl: [m.firstWhyNot] };
      const created = String(m.first.createdAt ?? m.first.startDate ?? '').slice(0, 10);
      if (m.memberships.filter(x => x.kind === 'plan' || x.kind === 'session').length > 1) return { excl: ['not_first'] };
      if (created < base) return { excl: ['before_baseline'] };
      if (diffD(snap.today, created) > 7) return { excl: ['too_old'] };
      return { cand: { key: `first:${m.first.membershipUserId}`, variant: 'default', sourceDates: { membershipCreatedAt: m.first.createdAt, membershipStart: m.first.startDate, membershipUserId: m.first.membershipUserId }, validUntil: addD(created, 7), vars: {} } };
    },
    tuesday(m, snap) {
      if (wday(snap.today) !== 2) return { excl: ['not_today'] };
      if (!m.isActive) return { excl: ['not_active'] };
      if (m.earliestActiveStart && m.earliestActiveStart > snap.weekStart) return { excl: ['joined_this_week'] };
      if (m.attendedThisWeek) return { excl: ['attended_this_week'] };
      if (m.futureThisWeek.length) return { excl: ['has_booking_this_week'] };
      if (m.neverAttended) return { excl: ['new_never_attended'] };
      if (m.daysAbsent === null) return { excl: ['attendance_unknown'] };
      if (m.daysAbsent >= 7) return { excl: ['absence_track'] };
      return { cand: { key: `week:${snap.weekStart}`, variant: 'default', sourceDates: { weekStart: snap.weekStart, weekEnd: snap.weekEnd, lastAttendance: m.lastAttendance }, validUntil: snap.today, vars: {} } };
    },
    _absence(m, snap, base, days, id) {
      if (!m.isActive) return { excl: ['not_active'] };
      if (m.neverAttended) return { excl: ['new_never_attended'] };
      if (m.daysAbsent === null) return { excl: ['attendance_unknown'] };
      if (m.daysAbsent < days || m.daysAbsent > days + 6) return { excl: ['not_in_window'] };
      if (addD(m.lastAttendance, days) < base) return { excl: ['before_baseline'] };
      if (m.future.length) return { excl: ['has_upcoming_booking'] };
      let variant = 'default';
      if (id === 'absence14') {
        const prev = store.getEpisode(store.episodeKey('absence7', m.userId, `abs:${m.lastAttendance}`));
        variant = !prev || !['sent', 'closed'].includes(prev.status) ? 'standalone' : prev.conversation?.outcome ? `after_${prev.conversation.outcome}` : 'no_reply';
      }
      return { cand: { key: `abs:${m.lastAttendance}`, variant, sourceDates: { lastAttendance: m.lastAttendance, daysAbsent: m.daysAbsent }, validUntil: addD(m.lastAttendance, days + 6), vars: {} } };
    },
    absence7(m, snap, base)  { return E._absence(m, snap, base, 7, 'absence7'); },
    absence14(m, snap, base) { return E._absence(m, snap, base, 14, 'absence14'); },
    birthday(m, snap, _base, settings) {
      if (!m.isActive) return { excl: ['not_active'] };
      if (!m.birthday) return { excl: ['no_birthday'] };
      const [by, bm, bd] = m.birthday.split('-').map(Number);
      const year = Number(snap.today.slice(0, 4));
      if (by < 1930 || by > year - 10) return { excl: ['birthday_invalid'] };
      // 29 February: greeted on 28 February in a year that has no 29th.
      const day = bm === 2 && bd === 29 && !isLeap(year) ? 28 : bd;
      const date = `${year}-${String(bm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      let sendOn = date, variant = 'default';
      if (wday(date) === 6 && !settings.policy.saturday) { if (settings.policy.birthdaySaturday === 'sunday') { sendOn = addD(date, 1); variant = 'belated'; } else { sendOn = addD(date, -1); variant = 'eve'; } }
      if (sendOn !== snap.today) return { excl: ['not_today'] };
      return { cand: { key: `bday:${year}`, variant, sourceDates: { birthdayThisYear: date }, validUntil: sendOn, vars: {} } };   // the birth YEAR is never stored or shown
    },
    expiry5(m, snap) {
      if (!m.isActive) return { excl: ['not_active'] };
      const ending = m.activeMs.filter(x => x.endDate && diffD(x.endDate, snap.today) >= 1 && diffD(x.endDate, snap.today) <= 5);
      if (!ending.length) return { excl: [m.activeMs.some(x => x.endDate) ? 'not_in_window' : 'no_end_date'] };
      const x = ending.sort((a, b) => a.endDate.localeCompare(b.endDate))[0];
      if (x.kind === 'unknown' || x.recurring === null) return { excl: ['type_unknown'] };
      if (x.recurring) return { excl: ['recurring'] };
      const later = m.memberships.some(o => o.membershipUserId !== x.membershipUserId && !o.cancelled && (o.kind === 'plan' || o.kind === 'session' || o.kind === 'unknown')
        && (!o.endDate || o.endDate > x.endDate) && (o.active || (o.startDate && o.startDate > snap.today)));
      if (later) return { excl: ['renewed'] };
      return { cand: { key: `exp:${x.membershipUserId}`, variant: 'default', sourceDates: { membershipUserId: x.membershipUserId, endDate: x.endDate, membershipName: x.name }, validUntil: addD(x.endDate, -1), vars: { membershipName: x.name, endDate: x.endDate } } };
    },
    _first(m, snap, base, days, prefix) {
      if (!m.isActive) return { excl: ['not_active'] };
      if (!m.first) return { excl: [m.firstWhyNot] };
      if (!m.first.active || m.first.cancelled) return { excl: ['not_active'] };
      const since = diffD(snap.today, m.firstStart);
      if (since < days || since > days + 6) return { excl: ['not_in_window'] };
      if (addD(m.firstStart, days) < base) return { excl: ['before_baseline'] };
      const attended = m.checkins.filter(d => d >= m.firstStart).length;
      return { cand: { key: `${prefix}:${m.first.membershipUserId}`, variant: attended ? 'attended' : 'not_attended', sourceDates: { firstMembershipStart: m.firstStart, membershipUserId: m.first.membershipUserId, verifiedSessionsSinceStart: attended }, validUntil: addD(m.firstStart, days + 6), vars: {} } };
    },
    onboarding14(m, snap, base) { return E._first(m, snap, base, 14, 'ob14'); },
    month1(m, snap, base)       { return E._first(m, snap, base, 30, 'm1'); },
  };

  /** Unresolved failed recurring charges, one per membership + month of the first failure. */
  function failedCharges(snap, base, settings) {
    const out = [];
    if (!snap.transactions) return out;
    const byM = new Map();
    for (const t of snap.transactions) { if (t.kind !== 'RECURRING' || !t.membershipUserId) continue; const k = String(t.membershipUserId); if (!byM.has(k)) byM.set(k, []); byM.get(k).push(t); }
    for (const [mid, rows] of byM) {
      rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const fails = rows.filter(t => t.status === 'FAIL');
      if (!fails.length) continue;
      const lastFail = fails.at(-1), firstFail = fails[0];
      const m = snap.byId.get(String(lastFail.userId));
      if (!m) continue;
      const key = `charge:${mid}:${String(firstFail.date).slice(0, 7)}`;
      const resolved = rows.some(t => t.status === 'SUCCESS' && String(t.at) > String(lastFail.at));
      const ageH = (now().getTime() - new Date(String(lastFail.at).replace(' ', 'T') + ':00+02:00').getTime()) / 3600000;
      const c = { key, variant: 'default', sourceDates: { membershipUserId: mid, firstFailureAt: firstFail.at, lastFailureAt: lastFail.at, failures: fails.length }, validUntil: addD(String(firstFail.date).slice(0, 10), 14), vars: {} };
      if (resolved) out.push({ m, excl: ['resolved'], key });
      else if (String(firstFail.date).slice(0, 10) < base) out.push({ m, excl: ['before_baseline'], key });
      else if (ageH < settings.policy.paymentGraceHours) out.push({ m, cand: c, defer: 'in_grace' });
      else out.push({ m, cand: c });
    }
    return out;
  }

  // ── wording ─────────────────────────────────────────────────────────────────
  function render(program, variant, m, vars, settings) {
    const name = m.firstName || 'שלום';
    const f = m.gender === 'female', male = m.gender === 'male';
    const g = (fe, ma, neutral) => (f ? fe : male ? ma : neutral);
    switch (program) {
      case 'welcome': return `היי ${name}, ברוכים הבאים ל־Shape Studio! 💛\nשמחים שבחרת בנו ומתרגשים להתחיל יחד.\nכאן מצטרפים לקבוצת הוואטסאפ של הסטודיו:\n${settings.groupLink}\nאם צריך עזרה עם ההתחלה, אני כאן 😊`;
      case 'tuesday': return `היי ${name} 😊 לפי מה שרשום אצלי עוד לא נקבע לך אימון השבוע.\nרוצה שאעזור למצוא שיעור שמתאים? אפשר לכתוב לי יום ושעה שנוחים לך.`;
      case 'absence7': return `היי ${name} 💛 לא ראינו אותך בסטודיו בשבוע האחרון, ורציתי לבדוק שהכול בסדר.\nמה שלומך?`;
      case 'absence14':
        if (variant === 'standalone') return `היי ${name} 💛 עברו כשבועיים מאז האימון האחרון שלך אצלנו, ורציתי לבדוק שהכול בסדר.\nיש משהו שאפשר לעזור בו כדי לחזור?`;
        if (variant === 'after_schedule') return `היי ${name}, חוזר אלייך אחרי השיחה שלנו על השעות. אם משהו השתנה בלו"ז — אשמח לבדוק שוב אילו שיעורים יכולים להתאים. מתי נוח לך?`;
        if (variant.startsWith('after_')) return `היי ${name}, חוזר אלייך אחרי השיחה שלנו בשבוע שעבר 💛 איך הולך? אם יעזור — אחפש יחד איתך שיעור לשבוע הקרוב.`;
        return `היי ${name}, עברו כבר שבועיים מאז האימון האחרון שלך. אנחנו כאן כשיתאים לך לחזור — ואם משהו מקשה (שעות, עומס או כל דבר אחר), אשמח לשמוע ולנסות לעזור.`;
      case 'birthday':
        if (variant === 'eve') return `${name}, מזל טוב לקראת יום ההולדת שלך מחר! 🎉\nכל הצוות של Shape Studio מאחל לך שנה של בריאות, כוח ושמחה 💛`;
        if (variant === 'belated') return `${name}, מזל טוב ליום ההולדת (באיחור קל)! 🎉\nכל הצוות של Shape Studio מאחל לך שנה של בריאות, כוח ושמחה 💛`;
        return `${name}, מזל טוב ליום ההולדת! 🎉\nכל הצוות של Shape Studio מאחל לך שנה של בריאות, כוח ושמחה 💛`;
      case 'payment_failed': return `היי ${name}, הודעה קצרה ודיסקרטית: החיוב החודשי האחרון על המנוי לא עבר.\n${String(settings.paymentResolution).trim()}\nמטעמי אבטחה, לא שולחים פרטי כרטיס או קוד אבטחה בוואטסאפ. אם זה כבר הוסדר — אפשר להתעלם 🙏`;
      case 'expiry5': return `היי ${name}, המנוי שלך${vars.membershipName ? ` (${vars.membershipName})` : ''} בתוקף עד ${dmy(vars.endDate)}.\nרוצה לחדש אותו? אם כן — כתבו לי ואפתח בקשה לצוות. אני לא מחדש ולא מחייב בעצמי.`;
      case 'onboarding14':
        return variant === 'attended'
          ? `היי ${name}, עברו שבועיים מאז שהצטרפת 💛 איך ההרגשה עד עכשיו?\nאם אפשר לעזור במשהו — בחירת שיעורים, שעות, כל דבר — אני כאן.`
          : `היי ${name}, עברו שבועיים מאז ההצטרפות, ולפי מה שרשום אצלי עוד לא יצא לך להגיע לאימון.\nרוצה שאעזור למצוא שיעור ראשון שמתאים לך?`;
      case 'month1':
        return (variant === 'attended'
          ? `היי ${name}, חודש ראשון ב־Shape Studio מאחוריך 🎉 איך היה? נשמח לשמוע.`
          : `היי ${name}, עבר חודש מאז שהצטרפת ל־Shape Studio 💛 לפי מה שרשום אצלי עוד לא יצא לך להתאמן — אם אפשר לעזור למצוא שיעור מתאים, אני כאן.`)
          + `\nולכבוד החודש הראשון: שני אימוני אורח במתנה, לחברים או למשפחה. ${g('רוצה', 'רוצה', 'רוצים')} להביא מישהו? כתבו לי ואבקש מהצוות לתאם.`;
      default: return '';
    }
  }

  // ── contact policy state for one member ─────────────────────────────────────
  function policyFor(program, m, settings) {
    const eps = m.phone ? store.listEpisodes({ phone: m.phone, limit: 200 }).filter(e => ['sent', 'uncertain', 'closed'].includes(e.status) && e.send?.at) : [];
    const ts = e => new Date(e.send.at).getTime();
    return policyLib.evaluate({
      program, now: now(), policy: settings.policy,
      member: { phone: m.phone, phoneShared: m.phoneShared, isActive: m.isActive, onHold: m.onHold },
      state: {
        proactiveOn: st.proactiveOn(), allowed: m.phone ? st.allowed(m.phone) : false, owner: m.phone ? st.owner(m.phone) : 'tomer',
        careOptOut: m.phone ? store.isCareOptedOut(m.phone) : false, pause: m.phone ? store.getPause(m.phone, now()) : null,
        openCase: m.phone ? cases.list({ phone: m.phone, open: true, limit: 1 }).length > 0 : false,
        lastConversationAt: m.phone ? st.lastConversationAt(m.phone) : null,
        lastProactiveAt: eps.length ? Math.max(...eps.map(ts)) : null,
        lastAttendanceMsgAt: (() => { const a = eps.filter(e => policyLib.ATTENDANCE_FAMILY.has(e.program)); return a.length ? Math.max(...a.map(ts)) : null; })(),
      },
    });
  }

  /** Candidates + exclusions of one program on a snapshot. */
  function evaluateProgram(id, snap, settings) {
    const base = baseline(id, settings, snap.today);
    const missing = PROGRAMS[id].needs.filter(n => !snap.src[n]?.ok);
    if (missing.length) return { dataBlocked: missing.map(n => ({ source: n, error: snap.src[n]?.error ?? 'unavailable' })), included: [], excluded: [] };
    const included = [], excluded = [];
    const rows = id === 'payment_failed' ? failedCharges(snap, base, settings) : snap.members.filter(m => m.isActive || id === 'welcome').map(m => ({ m, ...E[id](m, snap, base, settings) }));
    for (const r of rows) {
      if (r.excl) { excluded.push({ userId: r.m.userId, name: r.m.name, reasons: r.excl }); continue; }
      const key = store.episodeKey(id, r.m.userId, r.cand.key);
      const ep = store.getEpisode(key);
      if (ep && DONE.has(ep.status)) { excluded.push({ userId: r.m.userId, name: r.m.name, reasons: ['already_handled'], episodeStatus: ep.status }); continue; }
      const pol = r.defer ? { decision: 'defer', reasons: [r.defer] } : policyFor(id, r.m, settings);
      included.push({ m: r.m, key, cand: r.cand, policy: pol, text: render(id, r.cand.variant, r.m, r.cand.vars, settings) });
    }
    return { dataBlocked: null, included, excluded, baseline: base };
  }

  // ── preview (no sending, no state change) ───────────────────────────────────
  async function preview(id) {
    if (!PROGRAMS[id]) return { ok: false, error: 'unknown_program' };
    const settings = store.getSettings();
    const snap = await loadSnapshot();
    const ev = evaluateProgram(id, snap, settings);
    const reasonText = c => policyLib.REASON_HE[c] ?? EXCL_HE[c] ?? c;
    const counts = {}; for (const x of ev.excluded) for (const r of x.reasons) counts[r] = (counts[r] ?? 0) + 1;
    return {
      ok: true, program: id, label: PROGRAMS[id].label, enabled: !!settings.programs[id].enabled, blocks: programBlocks(id, settings),
      dataBlocked: ev.dataBlocked, baseline: ev.baseline ?? null, activated: !!settings.programs[id].activatedAt, today: snap.today, sources: snap.src,
      included: ev.included.map(x => ({ userId: x.m.userId, name: x.m.name, phone: x.m.phone, variant: x.cand.variant, sourceDates: x.cand.sourceDates, decision: x.policy.decision, reasons: x.policy.reasons.map(c => ({ code: c, text: reasonText(c) })), message: x.text })),
      excludedCounts: Object.entries(counts).map(([code, n]) => ({ code, text: reasonText(code), count: n })).sort((a, b) => b.count - a.count),
      excluded: ev.excluded.slice(0, 300).map(x => ({ userId: x.userId, name: x.name, reasons: x.reasons.map(c => ({ code: c, text: reasonText(c) })) })),
      totalMembers: snap.members.filter(m => m.isActive).length,
    };
  }

  // ── revalidation immediately before a send (fresh, per member) ──────────────
  async function revalidate(id, x, snap) {
    try {
      if (['tuesday', 'absence7', 'absence14'].includes(id)) {
        const r = await gateway.getBookings(x.m.userId, { from: addD(snap.today, -20), to: addD(snap.today, 7), fresh: true });
        const after = id === 'tuesday' ? snap.weekStart : addD(x.m.lastAttendance, 1);
        if (r.bookings.some(b => b.checkedIn && b.date >= after && b.date <= snap.today)) return 'attended_since';
        const horizon = id === 'tuesday' ? snap.weekEnd : addD(snap.today, 7);
        const canc = await gateway.getCancellations(x.m.userId, { from: snap.today, to: addD(snap.today, 7) });
        const gone = new Set(canc.cancellations.map(c => `${c.date}|${c.time}`));
        if (r.bookings.some(b => !b.checkedIn && (b.date > snap.today || (b.date === snap.today && b.time > snap.hhmm)) && b.date <= horizon && !gone.has(`${b.date}|${b.time}`))) return 'booked_since';
      } else if (id === 'payment_failed') {
        gateway.clearCache('transactions');
        const t = await gateway.getTransactions({ from: addD(snap.today, -30), to: snap.today });
        const rows = t.transactions.filter(r => String(r.membershipUserId) === String(x.cand.sourceDates.membershipUserId));
        const lastFail = rows.filter(r => r.status === 'FAIL').map(r => String(r.at)).sort().at(-1);
        if (!lastFail || rows.some(r => r.status === 'SUCCESS' && String(r.at) > lastFail)) return 'resolved';
      } else if (id === 'expiry5') {
        gateway.clearCache(`memberships:${x.m.userId}`);
        const r = await gateway.getMemberships(x.m.userId);
        const cur = r.memberships.find(q => String(q.membershipUserId) === String(x.cand.sourceDates.membershipUserId));
        if (!cur || !cur.active || cur.cancelled || cur.endDate !== x.cand.sourceDates.endDate) return 'membership_changed';
        if (r.memberships.some(q => String(q.membershipUserId) !== String(cur.membershipUserId) && !q.cancelled && q.type === 'plan' && (!q.endDate || q.endDate > cur.endDate) && (q.active || (q.startDate && q.startDate > snap.today)))) return 'renewed';
      }
      return null;
    } catch (err) { return { unavailable: err.message }; }
  }

  // ── run ─────────────────────────────────────────────────────────────────────
  let _running = false;                          // one run at a time in this process …
  async function run({ programs = null, trigger = 'schedule', by = 'system' } = {}) {
    if (!st.proactiveOn()) return { ok: false, reason: 'proactive_locked' };
    if (_running) return { ok: false, reason: 'already_running' };
    _running = true;
    try {
      // … and across processes (two workers, or old + new instance during a deploy).
      if (!store.acquireLock(OWNER, 10 * 60 * 1000, now().getTime())) return { ok: false, reason: 'already_running' };
      return await _run({ programs, trigger, by });
    } finally { _running = false; }
  }
  async function _run({ programs, trigger, by }) {
    const summary = { trigger, by, programs: [], considered: 0, sent: 0, deferred: 0, blocked: 0, failed: 0, uncertain: 0, cancelled: 0, expired: 0, errors: 0, dataBlocked: [] };
    try {
      const settings = store.getSettings();
      const ids = PRIORITY.filter(id => (programs ? programs.includes(id) : true) && settings.programs[id].enabled && !programBlocks(id, settings).length);
      summary.programs = ids;
      if (!ids.length) return { ok: true, ...summary };
      const snap = await loadSnapshot({ fresh: true });
      const perMember = new Map();   // userId → candidates in priority order
      const live = new Set();
      for (const id of ids) {
        const ev = evaluateProgram(id, snap, settings);
        if (ev.dataBlocked) { summary.dataBlocked.push({ program: id, missing: ev.dataBlocked }); continue; }
        for (const x of ev.included) { live.add(x.key); if (!perMember.has(x.m.userId)) perMember.set(x.m.userId, []); perMember.get(x.m.userId).push({ id, ...x }); }
        // unsent episodes of this program that are no longer eligible → cancelled / expired (kept, never dropped)
        for (const ep of store.listEpisodes({ program: id, status: ['pending', 'deferred', 'blocked', 'failed'], limit: 5000 })) {
          if (live.has(ep.key) || ep.synthetic) continue;
          const expired = ep.validUntil && ep.validUntil < snap.today;
          store.upsertEpisode(ep.key, { status: expired ? 'expired' : 'cancelled', reasons: expired ? ep.reasons : ['no_longer_eligible'] }, { type: expired ? 'expired' : 'cancelled', detail: expired ? `not sent by ${ep.validUntil}` : 'no longer eligible (source data changed)' });
          summary[expired ? 'expired' : 'cancelled']++;
        }
      }
      closeFinished(snap, summary);
      for (const [, list] of perMember) {
        let sentOne = false;
        for (const x of list) {
          summary.considered++;
          const base = { program: x.id, userId: x.m.userId, phone: x.m.phone, name: x.m.name, episodeKey: x.cand.key, variant: x.cand.variant, sourceDates: x.cand.sourceDates, validUntil: x.cand.validUntil };
          let pol = x.policy;
          if (pol.decision === 'send' && sentOne) pol = { decision: 'defer', reasons: ['one_message_per_run'] };
          if (pol.decision !== 'send') {
            try { store.upsertEpisode(x.key, { ...base, status: pol.decision === 'block' ? 'blocked' : 'deferred', reasons: pol.reasons }, { type: pol.decision === 'block' ? 'blocked' : 'deferred', detail: pol.reasons.join(',') }); }
            catch (err) { summary.errors++; logger.error('[member-care] deferral not recorded', { key: x.key, error: err.message }); continue; }
            summary[pol.decision === 'block' ? 'blocked' : 'deferred']++;
            continue;
          }
          let out;
          // A failure to record state stops THIS episode before anything is sent (the durable
          // 'sending' record comes first); it never stops the other members' episodes silently.
          try { out = await sendEpisode(x, base, snap, settings); }
          catch (err) { out = 'errors'; logger.error('[member-care] episode not processed', { key: x.key, error: err.message }); }
          summary[out] = (summary[out] ?? 0) + 1;
          if (out === 'sent' || out === 'uncertain') sentOne = true;
        }
      }
      return { ok: true, ...summary };
    } finally {
      try { store.recordRun(summary); } catch (err) { logger.error('[member-care] run summary not saved', { error: err.message }); }
      try { store.releaseLock(OWNER); } catch (err) { logger.error('[member-care] lock not released (expires by itself)', { error: err.message }); }
    }
  }

  /** Revalidate, record 'sending' durably, send once, record the outcome. Returns the summary bucket. */
  async function sendEpisode(x, base, snap, settings) {
    const rv = await revalidate(x.id, x, snap);
    if (rv && rv.unavailable) { store.upsertEpisode(x.key, { ...base, status: 'deferred', reasons: ['revalidation_unavailable'] }, { type: 'deferred', detail: `Arbox could not be re-read before sending: ${rv.unavailable}` }); return 'deferred'; }
    if (rv) { store.upsertEpisode(x.key, { ...base, status: 'cancelled', reasons: [rv] }, { type: 'cancelled', detail: `changed before sending: ${rv}` }); return 'cancelled'; }
    const again = policyFor(x.id, x.m, settings);
    if (again.decision !== 'send') { store.upsertEpisode(x.key, { ...base, status: again.decision === 'block' ? 'blocked' : 'deferred', reasons: again.reasons }, { type: 'deferred', detail: again.reasons.join(',') }); return again.decision === 'block' ? 'blocked' : 'deferred'; }
    const prev = store.getEpisode(x.key);
    if (prev && DONE.has(prev.status)) return 'deferred';                              // another worker got here first
    // Durable BEFORE the request leaves: after a crash this episode reads 'sending' → 'uncertain', never re-sent.
    store.upsertEpisode(x.key, { ...base, status: 'sending', reasons: [], send: { state: 'sending', startedAt: now().toISOString(), text: x.text, attempts: (prev?.send?.attempts ?? 0) + 1 } }, { type: 'sending' });
    let r;
    try { r = await sendMember(x.m.phone, x.text, { handler: `care:${x.id}`, trigger: 'proactive', name: x.m.firstName ?? x.m.name, dataSource: PROGRAMS[x.id].needs.join('+') }); }
    catch (err) { r = { state: 'uncertain', error: err.message }; }
    const status = r.state === 'sent' ? 'sent' : r.state === 'uncertain' ? 'uncertain' : r.state === 'blocked' ? 'blocked' : 'failed';
    try {
      store.upsertEpisode(x.key, { status, reasons: status === 'blocked' ? ['send_blocked'] : [], send: { state: status, at: now().toISOString(), idMessage: r.idMessage ?? null, error: r.error ?? null } },
        { type: status === 'sent' ? 'sent' : `send_${status}`, detail: r.error ?? r.idMessage ?? null });
      if (status === 'sent' && x.id === 'month1') store.issueEntitlement({ userId: x.m.userId, phone: x.m.phone, name: x.m.name, total: 2, episodeKey: x.key });
    } catch (err) { logger.error('[member-care] send outcome not saved — episode stays "sending" and will read as uncertain', { key: x.key, outcome: status, error: err.message }); }
    audit({ phone: x.m.phone, memberName: x.m.name, event: 'care_message', tomerAction: `${x.id} (${x.cand.variant})`, sendState: status, idMessage: r.idMessage ?? null });
    return status === 'blocked' ? 'blocked' : status;
  }

  /** Sent episodes whose situation resolved itself: verified return to attendance, payment succeeded, long silence. */
  function closeFinished(snap, summary = {}) {
    for (const ep of store.listEpisodes({ status: 'sent', limit: 5000 })) {
      if (ep.synthetic) continue;
      const m = snap.byId.get(String(ep.userId));
      if (policyLib.ATTENDANCE_FAMILY.has(ep.program) && snap.src.attendance?.ok && m && m.lastAttendance && m.lastAttendance > String(ep.send.at).slice(0, 10)) {
        store.upsertEpisode(ep.key, { status: 'closed', conversation: { outcome: ep.conversation?.outcome ?? 'returned', awaiting: null }, returnedOn: m.lastAttendance }, { type: 'returned', detail: `verified attendance on ${m.lastAttendance}` });
        summary.returned = (summary.returned ?? 0) + 1;
      } else if (ep.program === 'payment_failed' && snap.transactions) {
        const rows = snap.transactions.filter(t => String(t.membershipUserId) === String(ep.sourceDates?.membershipUserId));
        if (rows.some(t => t.status === 'SUCCESS' && String(t.at) > String(ep.sourceDates?.lastFailureAt))) store.upsertEpisode(ep.key, { status: 'closed', conversation: { outcome: 'resolved', awaiting: null } }, { type: 'resolved', detail: 'a later successful charge is recorded' });
      } else if (now().getTime() - new Date(ep.send.at).getTime() > 30 * 86400000) {
        store.upsertEpisode(ep.key, { status: 'closed', conversation: { outcome: ep.conversation?.outcome ?? 'no_reply', awaiting: null } }, { type: 'closed', detail: 'no reply within 30 days' });
      }
    }
  }

  /** Scheduled entry: runs each enabled program once per Israel day, at / after its hour. */
  async function tick() {
    if (!st.proactiveOn()) return { ok: false, reason: 'proactive_locked' };
    const settings = store.getSettings();
    const p = ilParts(now()); const today = ilDateString(now());
    const due = PRIORITY.filter(id => settings.programs[id].enabled && p.hour >= Number(settings.programs[id].hour ?? 10) && store.lastRunDate(id) !== today);
    // Episodes deferred earlier today are retried on every tick while the send window is open.
    const retry = PRIORITY.filter(id => settings.programs[id].enabled && !due.includes(id) && store.listEpisodes({ program: id, status: ['deferred', 'failed'], limit: 1 }).length);
    if (!due.length && !retry.length) return { ok: true, due: [] };
    const out = await run({ programs: [...due, ...retry], trigger: 'schedule' });
    if (out.ok) for (const id of due) if (!out.dataBlocked.some(d => d.program === id)) store.markRan(id, today);
    return { ...out, due };
  }

  /** After a restart: an episode left 'sending' may or may not have gone out → 'uncertain'. Nothing is sent. */
  function reconcileOnStartup() {
    const out = [];
    for (const ep of store.listEpisodes({ status: 'sending', limit: 5000 })) {
      store.upsertEpisode(ep.key, { status: 'uncertain', send: { state: 'uncertain', error: 'process restarted while the message was being sent' } }, { type: 'send_uncertain', detail: 'restart during send' });
      out.push(ep.key);
    }
    if (out.length) logger.warn('[member-care] unfinished sends found after restart — marked uncertain, not re-sent', { count: out.length });
    return out;
  }

  // ── staff decisions on a single episode ─────────────────────────────────────
  function resolveUncertain(key, { action, by = 'staff' } = {}) {
    const ep = store.getEpisode(key);
    if (!ep) return { ok: false, error: 'not_found' };
    if (!['uncertain', 'failed'].includes(ep.status)) return { ok: false, error: 'not_uncertain' };
    if (action === 'mark_sent') return { ok: true, episode: store.upsertEpisode(key, { status: 'sent', send: { state: 'sent', at: ep.send.at ?? now().toISOString() } }, { type: 'marked_sent', detail: `by ${by}` }) };
    if (action === 'mark_not_sent') return { ok: true, episode: store.upsertEpisode(key, { status: 'pending', reasons: [], send: { state: null } }, { type: 'marked_not_sent', detail: `by ${by} — will be re-evaluated on the next run` }) };
    return { ok: false, error: 'bad_action' };
  }

  // ── reports ─────────────────────────────────────────────────────────────────
  async function absenceReport() {
    const snap = await loadSnapshot();
    if (!snap.src.users?.ok || !snap.src.memberships?.ok) return { ok: false, error: 'arbox_unavailable', sources: snap.src };
    const attOk = !!snap.src.attendance?.ok;
    const rows = snap.members.filter(m => m.isActive).map(m => {
      const eps = m.phone ? store.listEpisodes({ userId: m.userId, limit: 50 }).filter(e => policyLib.ATTENDANCE_FAMILY.has(e.program)) : [];
      const last = eps.find(e => ['sent', 'uncertain', 'closed'].includes(e.status) && e.send?.at) ?? null;
      const pause = m.phone ? store.getPause(m.phone, now()) : null;
      const openCase = m.phone ? cases.list({ phone: m.phone, open: true, limit: 1 })[0] ?? null : null;
      const owner = m.phone ? st.owner(m.phone) : 'tomer';
      let next = '—';
      if (!attOk) next = 'נתוני נוכחות לא זמינים';
      else if (openCase) next = 'פנייה פתוחה — בטיפול הצוות';
      else if (pause) next = `בהשהיה${pause.until ? ' עד ' + dmy(pause.until) : ''}`;
      else if (owner === 'human') next = 'הצוות מנהל את השיחה';
      else if (m.neverAttended) next = 'חדש/ה — טרם הגיע/ה (אין תוכנית מאושרת)';
      else if (m.daysAbsent === null) next = 'היעדרות ארוכה — לשיקול הצוות';
      else if (m.future.length) next = `רשום/ה לאימון ב-${dmy(m.future[0].date)}`;
      else if (m.daysAbsent >= 14) next = 'מעקב 14 ימים';
      else if (m.daysAbsent >= 7) next = 'בדיקת 7 ימים';
      return {
        userId: m.userId, name: m.name, phone: m.phone, membership: m.onHold ? 'בהקפאה' : 'פעיל',
        lastAttendance: attOk ? m.lastAttendance : null, daysAbsent: attOk ? m.daysAbsent : null, attendanceKnown: attOk && (m.lastAttendance !== null || m.neverAttended),
        neverAttended: m.neverAttended, futureBooking: m.future[0] ?? null,
        lastOutreach: last ? { program: last.program, label: PROGRAMS[last.program].label, at: last.send.at, status: last.status } : null,
        response: last?.conversation?.outcome ?? null, owner: openCase?.owner && openCase.owner !== 'tomer' ? openCase.owner : owner === 'human' ? 'צוות' : 'תומר', caseId: openCase?.id ?? null, nextAction: next,
      };
    }).sort((a, b) => (b.daysAbsent ?? 999) - (a.daysAbsent ?? 999));
    return { ok: true, today: snap.today, sources: snap.src, rows };
  }

  async function visibility() {
    const snap = await loadSnapshot();
    const returned = store.listEpisodes({ status: 'closed', limit: 2000 }).filter(e => e.returnedOn).slice(0, 100)
      .map(e => ({ userId: e.userId, name: e.name, program: e.program, label: PROGRAMS[e.program]?.label, absentSince: e.sourceDates?.lastAttendance ?? null, returnedOn: e.returnedOn }));
    return { ok: true, sources: snap.src, attendanceKnown: !!snap.src.attendance?.ok,
      newNotAttended: snap.src.attendance?.ok ? snap.members.filter(m => m.isActive && m.neverAttended).map(m => ({ userId: m.userId, name: m.name, phone: m.phone, membershipStart: m.earliestActiveStart, daysSinceStart: diffD(snap.today, m.earliestActiveStart), futureBooking: m.future[0] ?? null })) : [],
      returned };
  }

  function overview() {
    const settings = store.getSettings();
    const eps = store.listEpisodes({ limit: 100000 });
    return {
      proactiveOn: st.proactiveOn(), settings, policyDefaults: require('../utils/member_care_store').DEFAULT_POLICY,
      programs: PRIORITY.map(id => {
        const mine = eps.filter(e => e.program === id);
        const n = s => mine.filter(e => e.status === s).length;
        return { id, label: PROGRAMS[id].label, needs: PROGRAMS[id].needs, ...settings.programs[id], blocks: programBlocks(id, settings), lastRun: store.lastRunDate(id),
          counts: { sent: n('sent') + n('closed'), awaitingSend: n('pending') + n('deferred'), blocked: n('blocked'), failed: n('failed'), uncertain: n('uncertain'), cancelled: n('cancelled') + n('expired') } };
      }),
      pauses: store.listPauses(), entitlements: store.listEntitlements(), runs: store.listRuns(10),
      missingPolicy: ['תוקף אימוני האורח (עד מתי אפשר לממש)', 'מי רשאי/ת להגיע כאורח/ת (חבר/ה חדש/ה בלבד? גיל מינימלי?)', 'לאילו שיעורים האורח/ת יכול/ה להגיע', 'האם אותו אורח יכול לממש את שני האימונים', 'איך רושמים אורח ב-Arbox (מנוי ניסיון? רישום ידני?)', 'האם החבר/ה חייב/ת להגיע יחד עם האורח/ת'],
    };
  }

  /** Enable / disable / reschedule a program. Enabling a blocked program is refused; the first enable sets the baseline. */
  function setProgram(id, { enabled, hour }, by = 'staff') {
    if (!PROGRAMS[id]) return { ok: false, error: 'unknown_program' };
    const settings = store.getSettings();
    const patch = {};
    if (hour !== undefined) { const h = Number(hour); if (!Number.isInteger(h) || h < settings.policy.windowStart || h >= settings.policy.windowEnd) return { ok: false, error: 'bad_hour' }; patch.hour = h; }
    if (enabled === true) {
      const blocks = programBlocks(id, settings);
      if (blocks.length) return { ok: false, error: 'program_blocked', blocks };
      patch.enabled = true;
      if (!settings.programs[id].activatedAt) patch.activatedAt = now().toISOString();   // baseline: nothing before this moment is ever acted on
    } else if (enabled === false) patch.enabled = false;
    return { ok: true, settings: store.updateSettings({ programs: { [id]: patch } }, by) };
  }

  /** A labelled message to the route-overridden TEST phone only, so reply continuity can be tried live. */
  async function testSend(id, { by = 'staff' } = {}) {
    if (!PROGRAMS[id]) return { ok: false, error: 'unknown_program' };
    if (!st.proactiveOn()) return { ok: false, error: 'proactive_locked' };
    const phone = st.testPhones()[0];
    if (!phone) return { ok: false, error: 'no_test_phone' };
    const settings = store.getSettings();
    const blocks = programBlocks(id, settings);
    if (blocks.length) return { ok: false, error: 'program_blocked', blocks };
    const today = ilDateString(now());
    const m = { userId: `test-${phone}`, phone, phoneShared: false, name: 'חבר/ת בדיקה (זהות מדומה)', firstName: 'בדיקה', gender: null, isActive: true, onHold: false, lastAttendance: addD(today, -8) };
    const pol = policyFor(id, m, settings);
    if (pol.decision !== 'send') return { ok: false, error: 'policy', reasons: pol.reasons.map(c => ({ code: c, text: policyLib.REASON_HE[c] ?? c })) };
    const variant = id === 'absence14' ? 'standalone' : ['onboarding14', 'month1'].includes(id) ? 'attended' : 'default';
    const vars = id === 'expiry5' ? { membershipName: 'מנוי בדיקה (נתון מדומה)', endDate: addD(today, 5) } : {};
    const key = store.episodeKey(id, m.userId, `test:${now().getTime()}`);
    const x = { id, key, m, cand: { key: `test:${now().getTime()}`, variant, vars, sourceDates: { synthetic: true } }, text: render(id, variant, m, vars, settings) };
    const base = { program: id, userId: m.userId, phone, name: m.name, episodeKey: x.cand.key, variant, sourceDates: { synthetic: true }, validUntil: today, synthetic: true };
    store.upsertEpisode(key, { ...base, status: 'sending', send: { state: 'sending', startedAt: now().toISOString(), text: x.text, attempts: 1 } }, { type: 'test_send', detail: `by ${by}` });
    let r; try { r = await sendMember(phone, x.text, { handler: `care:${id}`, trigger: 'test_send', name: m.firstName, dataSource: 'נתון מדומה לבדיקה — לא Arbox' }); } catch (err) { r = { state: 'uncertain', error: err.message }; }
    const status = r.state === 'sent' ? 'sent' : r.state === 'uncertain' ? 'uncertain' : 'failed';
    const ep = store.upsertEpisode(key, { status, send: { state: status, at: now().toISOString(), idMessage: r.idMessage ?? null, error: r.error ?? null } }, { type: status === 'sent' ? 'sent' : `send_${status}`, detail: r.error ?? null });
    if (status === 'sent' && id === 'month1') store.issueEntitlement({ userId: m.userId, phone, name: m.name, total: 2, episodeKey: key });
    return { ok: status === 'sent', episode: ep, error: status === 'sent' ? undefined : `send_${status}` };
  }

  const replies = require('./member_care_replies')({ store, gateway, cases, logger, now, PROGRAMS, addD, diffD, dmy, wday });

  return { PROGRAMS, PRIORITY, EXCL_HE, programBlocks, loadSnapshot, evaluateProgram, preview, run, tick, reconcileOnStartup, resolveUncertain,
    absenceReport, visibility, overview, setProgram, testSend, render,
    activeConversation: replies.activeConversation, handleReply: replies.handleReply };
}

module.exports = { createMemberCare, PROGRAMS, PRIORITY };
