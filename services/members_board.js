'use strict';

/**
 * members_board.js — the member-management view of Tomer's panel: who the members are, and who needs attention.
 *
 * Read-only. Everything comes from the same Arbox snapshot the member-care module reads (users, memberships, membership
 * types, 30 days of attendance, 7 days of future bookings, holds), plus the open service cases and staff tasks.
 * Nothing here sends a message, and no retention outreach is started from it.
 *
 * Every group states its RULE, its SOURCE and when the source was read. A group whose source could not be read is
 * 'unavailable' with the reason — never an empty list and never a zero. A threshold the owner has not approved is
 * marked `provisional` and listed under `decisions`.
 */

const DAY = 86400000;
const addD = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const diffD = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);
const maskPhone = p => (p ? `${String(p).slice(0, 5)}•••${String(p).slice(-3)}` : null);

// Thresholds. `approved: false` = taken from the existing (not yet approved) member-care program definitions, or a
// working value: shown as provisional, and listed for the owner's decision. They only group a list — nothing is sent.
const RULES = {
  firstMonthDays:  { value: 30, approved: false, ask: 'כמה ימים נחשבים "חודש ראשון" (כרגע 30 יום מתחילת המנוי הראשון)?' },
  expiringDays:    { value: 14, approved: false, ask: 'כמה ימים לפני סיום מנוי להציג "עומד להסתיים" (כרגע 14 יום; בתוכנית הליווי הקיימת מוגדר 5)?' },
  expiredDays:     { value: 30, approved: false, ask: 'כמה ימים אחרי סיום מנוי להציג "הסתיים לאחרונה" (כרגע 30 יום)?' },
  absentDays:      { value: 7,  approved: false, ask: 'אחרי כמה ימים בלי אימון מנוי נחשב "נעדר" (כרגע 7 ימים; בתוכנית הליווי הקיימת מוגדרים 7 ו-14)?' },
  declineRatio:    { value: 0.5, approved: false, ask: 'מה נחשב "ירידה בהגעה" (כרגע: פחות ממחצית האימונים ב-14 הימים האחרונים לעומת 14 הימים שלפניהם, כשהיו לפחות 2)?' },
};

// what each Arbox read is, in the owner's words (the endpoint names stay in the logs)
const SRC_HE = { users: 'רשימת הלקוחות', memberships: 'רשימת המנויים', types: 'סוגי המנוי', attendance: 'דוח הנוכחות (30 הימים האחרונים)', futureBookings: 'רישומים ל-7 הימים הבאים', holds: 'דוח ההקפאות', cancellations: 'ביטולי רישום', transactions: 'דוח התשלומים' };

function createMembersBoard(d) {
  const { care, cases, tomerStore, logger = console, getMemberBookings = null } = d;
  const now = d.now ?? (() => new Date());

  const srcOk = (snap, names) => names.every(n => snap.src[n]?.ok);
  const srcWhy = (snap, names) => names.filter(n => !snap.src[n]?.ok).map(n => `${n}: ${snap.src[n]?.error ?? 'לא נקרא'}`).join('; ');
  const srcAt = (snap, names) => names.map(n => snap.src[n]?.fetchedAt).filter(Boolean).sort()[0] ?? null;

  function memberRow(m, snap, extra) {
    const act = m.activeMs.slice().sort((a, b) => String(b.endDate ?? '9999').localeCompare(String(a.endDate ?? '9999')))[0] ?? null;
    const latest = m.memberships.filter(x => x.kind === 'plan' || x.kind === 'session' || x.kind === 'unknown').slice().sort((a, b) => String(b.endDate ?? b.startDate ?? '').localeCompare(String(a.endDate ?? a.startDate ?? '')))[0] ?? null;
    const ms = act ?? latest;
    const attOk = !!snap.src.attendance?.ok;
    const last14 = m.checkins.filter(dd => dd > addD(snap.today, -14)).length, prev14 = m.checkins.filter(dd => dd <= addD(snap.today, -14) && dd > addD(snap.today, -28)).length;
    return {
      userId: m.userId, name: m.name ?? '(ללא שם)', phoneMasked: maskPhone(m.phone), hasPhone: !!m.phone, phoneShared: m.phoneShared,
      active: m.isActive, freeze: m.freeze,
      membership: ms ? { name: ms.name ?? null, kind: ms.kind, start: ms.startDate ?? null, end: ms.endDate ?? null, recurring: ms.recurring ?? null, current: !!act,
                         // Arbox's membership list does not carry a balance of entries; it is shown as unknown, not as zero
                         entriesLeft: null } : null,
      firstStart: m.firstStart ?? null,
      lastAttendance: attOk ? m.lastAttendance : null, daysAbsent: attOk ? m.daysAbsent : null, attendanceKnown: attOk,
      attended14: attOk ? last14 : null, attendedPrev14: attOk ? prev14 : null,
      nextBooking: snap.src.futureBookings?.ok ? (m.future[0] ?? null) : null, bookingsKnown: !!snap.src.futureBookings?.ok,
      ...extra,
    };
  }

  /** The whole board: groups with rule / source / time, and the member rows. */
  async function board({ fresh = false } = {}) {
    let snap;
    try { snap = await care.loadSnapshot({ fresh }); }
    catch (err) { logger.warn('[members-board] snapshot failed', { error: err.message }); return { ok: false, state: 'sync_error', error: String(err.message).slice(0, 200), generatedAt: now().toISOString() }; }
    if (!srcOk(snap, ['users', 'memberships'])) {
      const why = srcWhy(snap, ['users', 'memberships']);
      return { ok: false, state: /401|403|unauthor|forbidden|permission/i.test(why) ? 'no_permission' : 'not_loaded', error: why, sources: snap.src, generatedAt: now().toISOString() };
    }
    const today = snap.today, R = Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v.value]));
    const openCases = new Map(), openTasks = new Map();
    for (const c of cases.list({ open: true, limit: 1000 })) { if (!openCases.has(c.phone)) openCases.set(c.phone, []); openCases.get(c.phone).push({ id: c.id, category: c.category, status: c.status, createdAt: c.createdAt }); }
    for (const t of tomerStore.getOpenTasks()) { if (!openTasks.has(t.phone)) openTasks.set(t.phone, []); openTasks.get(t.phone).push({ id: t.id, type: t.type, title: t.title ?? null, createdAt: t.createdAt, status: t.status }); }

    const rows = [];
    for (const m of snap.members) {
      const service = m.memberships.filter(x => x.kind === 'plan' || x.kind === 'session' || x.kind === 'unknown');
      if (!m.isActive && !service.length) continue;                       // a client row that never had a membership is not a member
      const lastEnd = service.map(x => x.endDate).filter(Boolean).sort().at(-1) ?? null;
      const expiredRecently = !m.isActive && lastEnd && lastEnd < today && diffD(today, lastEnd) <= R.expiredDays;
      if (!m.isActive && !expiredRecently) continue;                      // long-gone members are not listed
      const curEnd = m.activeMs.map(x => x.endDate).filter(Boolean).sort().at(-1) ?? null;
      const openEnded = m.activeMs.some(x => !x.endDate);
      const renewed = service.some(x => x.startDate && curEnd && x.startDate > curEnd);
      // "new and has not come yet" is only someone whose FIRST membership ever is recent. A long-time member who renewed and
      // has no check-in in the 30 days that are read is absent, not new (production sample, 2026-11-18).
      const notStarted = m.neverAttended && !!m.firstStart && diffD(today, m.firstStart) >= 0 && diffD(today, m.firstStart) <= 30;
      const groups = [];
      if (m.isActive) groups.push('active');
      if (m.isActive && m.firstStart && diffD(today, m.firstStart) >= 0 && diffD(today, m.firstStart) <= R.firstMonthDays) groups.push('first_month');
      if (m.isActive && !openEnded && curEnd && diffD(curEnd, today) <= R.expiringDays && !renewed) groups.push('expiring');
      if (expiredRecently) groups.push('expired');
      if (m.isActive && snap.src.attendance?.ok && m.freeze !== 'frozen') {
        if (m.daysAbsent === null ? !notStarted : m.daysAbsent >= R.absentDays) groups.push('absent');
        const last14 = m.checkins.filter(dd => dd > addD(today, -14)).length, prev14 = m.checkins.filter(dd => dd <= addD(today, -14) && dd > addD(today, -28)).length;
        if (prev14 >= 2 && last14 < prev14 * R.declineRatio && !groups.includes('absent')) groups.push('declining');
        if (notStarted) groups.push('not_started');
      }
      if (m.freeze === 'frozen') groups.push('frozen');
      const oc = m.phone ? (openCases.get(m.phone) ?? []) : [], ot = m.phone ? (openTasks.get(m.phone) ?? []) : [];
      if (oc.length || ot.length) groups.push('open_requests');
      rows.push(memberRow(m, snap, { groups, openCases: oc, openTasks: ot, lastMembershipEnd: lastEnd,
        nextAction: oc.length || ot.length ? 'בקשה פתוחה — בטיפול הצוות' : groups.includes('expired') ? 'מנוי הסתיים — לשיקול הצוות' : groups.includes('expiring') ? 'מנוי עומד להסתיים' : groups.includes('absent') ? 'נעדר/ת — לשיקול הצוות'.replace('/ת', '') : groups.includes('declining') ? 'ירידה בהגעה' : groups.includes('not_started') ? 'מנוי חדש שעוד לא התחיל להתאמן' : groups.includes('first_month') ? 'חודש ראשון' : null }));
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));

    const G = (id, label, rule, needs, { provisional = null, unit = 'מנויים' } = {}) => {
      const ok = srcOk(snap, needs);
      return { id, label, rule, source: 'Arbox — ' + needs.map(n => SRC_HE[n] ?? n).join(', '), fetchedAt: srcAt(snap, needs),
        state: ok ? 'ok' : 'unavailable', error: ok ? null : srcWhy(snap, needs), count: ok ? rows.filter(r => r.groups.includes(id)).length : null,
        provisional: provisional ? { rule: provisional, ask: RULES[provisional].ask } : null, unit };
    };
    const groups = [
      G('active', 'מנויים פעילים', 'שורת לקוח פעילה ב-Arbox עם מנוי שתחילתו עברה וסיומו לא עבר, שלא בוטל.', ['users', 'memberships', 'types']),
      G('first_month', 'בחודש הראשון', `מנוי פעיל שהמנוי הראשון שלו התחיל ב-${R.firstMonthDays} הימים האחרונים.`, ['users', 'memberships', 'types'], { provisional: 'firstMonthDays' }),
      G('not_started', 'מנוי חדש שלא הגיע לאימון', 'מנוי פעיל שהמנוי הראשון שלו התחיל ב-30 הימים האחרונים ואין לו אף כניסה רשומה. מנוי ותיק שחידש ולא הגיע מופיע ב"נעדרים".', ['users', 'memberships', 'attendance']),
      G('expiring', 'מנוי עומד להסתיים', `מנוי פעיל עם תאריך סיום בתוך ${R.expiringDays} ימים, שאין אחריו מנוי נוסף. מנוי בלי תאריך סיום (מתחדש) אינו נכלל.`, ['users', 'memberships', 'types'], { provisional: 'expiringDays' }),
      G('expired', 'מנוי שהסתיים לאחרונה', `אין מנוי בתוקף, והמנוי האחרון הסתיים ב-${R.expiredDays} הימים האחרונים.`, ['users', 'memberships', 'types'], { provisional: 'expiredDays' }),
      G('absent', 'נעדרים', `מנוי פעיל, לא בהקפאה, שהכניסה האחרונה שלו הייתה לפני ${R.absentDays} ימים או יותר (או שאין כניסה ב-30 הימים האחרונים).`, ['users', 'memberships', 'attendance'], { provisional: 'absentDays' }),
      G('declining', 'ירידה בהגעה', `מנוי פעיל שהגיע ב-14 הימים האחרונים לפחות מ-${Math.round(R.declineRatio * 100)}% ממספר האימונים ב-14 הימים שלפניהם (כשהיו לפחות 2), ואינו ברשימת הנעדרים.`, ['users', 'memberships', 'attendance'], { provisional: 'declineRatio' }),
      G('frozen', 'בהקפאה', 'מופיע בדוח ההקפאות של Arbox (או שהצוות סימן כך).', ['users', 'memberships', 'holds']),
      { id: 'open_requests', label: 'פניות, הקפאות, בקשות ביטול ומשימות פתוחות', rule: 'פנייה פתוחה בשירות תומר או משימת צוות פתוחה על הטלפון של המנוי.', source: 'פניות ומשימות שנשמרו במערכת',
        fetchedAt: now().toISOString(), state: 'ok', error: null, count: rows.filter(r => r.groups.includes('open_requests')).length, provisional: null, unit: 'מנויים' },
    ];
    return { ok: true, state: 'ok', today, generatedAt: now().toISOString(), sources: snap.src, groups, members: rows,
      notes: ['הלוח כולל לקוחות עם מנוי ישיר בסטודיו. חברי מועדון דרך גורם חיצוני ואנשי צוות אינם נכללים בו.', 'יתרת כניסות אינה חלק מרשימת המנויים ש-Arbox מחזיר. היא מוצגת בכרטיס הלקוח, לפי הרישום האחרון שלו ב-Arbox.', 'נוכחות: 30 הימים האחרונים. רישומים קרובים: 7 הימים הבאים.',
              snap.freeze?.sourceConfirmed ? null : 'מקור ההקפאות (דוח ההקפאות של Arbox) עדיין לא אושר מול Arbox — מנוי שאינו בדוח מוצג כ"הקפאה לא אומתה".'].filter(Boolean),
      decisions: Object.values(RULES).filter(r => !r.approved).map(r => r.ask) };
  }

  /** One member: memberships, attendance, coming bookings, the handling history and the next action. */
  async function card(userId) {
    const b = await board();
    if (!b.ok) return b;
    const row = b.members.find(r => String(r.userId) === String(userId));
    if (!row) return { ok: false, state: 'not_found', error: 'המנוי לא נמצא ברשימה הנוכחית' };
    const snap = await care.loadSnapshot();
    const m = snap.byId.get(String(userId));
    const phone = m?.phone ?? null;
    // Balance of entries: Arbox states it on each booking row of the member. The latest row that carries one is shown,
    // with its date — it is what Arbox said then, not a computed number. Unknown stays unknown.
    let entries = { known: false, reason: 'לא נקרא' };
    if (getMemberBookings) {
      try { const r = await getMemberBookings(String(userId), { from: addD(snap.today, -30), to: addD(snap.today, 0) });
        const withBal = (r.bookings ?? []).filter(x => x.sessionsLeft !== null && Number.isFinite(x.sessionsLeft)).at(-1);
        entries = withBal ? { known: true, left: withBal.sessionsLeft, asOf: withBal.date, membership: withBal.membershipName ?? null } : { known: false, reason: 'Arbox אינו מציין יתרה למנוי הזה (למשל מנוי ללא הגבלה), או שאין רישום ב-30 הימים האחרונים' }; }
      catch (err) { entries = { known: false, reason: `לא נקרא מ-Arbox (${String(err.message).slice(0, 80)})` }; }
    }
    const allCases = phone ? cases.list({ phone, limit: 50 }) : [];
    const tasks = phone ? tomerStore.getTasks({ phone, limit: 50 }) : [];
    return { ok: true, member: row, entries,
      memberships: (m?.memberships ?? []).map(x => ({ name: x.name, kind: x.kind, start: x.startDate, end: x.endDate, active: x.active && !x.cancelled, cancelled: x.cancelled, recurring: x.recurring ?? null })).reverse(),
      attendance: snap.src.attendance?.ok ? { known: true, dates: (m?.checkins ?? []).slice().reverse(), window: '30 הימים האחרונים' } : { known: false, error: snap.src.attendance?.error ?? 'לא נקרא' },
      upcoming: snap.src.futureBookings?.ok ? { known: true, bookings: m?.future ?? [], window: '7 הימים הבאים' } : { known: false, error: snap.src.futureBookings?.error ?? 'לא נקרא' },
      history: [...allCases.map(c => ({ kind: 'פנייה', id: c.id, what: c.category, status: c.status, at: c.createdAt, resolution: c.resolution?.note ?? null })),
                ...tasks.map(t => ({ kind: 'משימה', id: t.id, what: t.title ?? t.type, status: t.status, at: t.createdAt, resolution: t.resolution ?? t.resolvedNote ?? null }))].sort((a, c) => String(c.at).localeCompare(String(a.at))),
      nextAction: row.nextAction, sources: snap.src, generatedAt: now().toISOString() };
  }

  return { board, card, RULES };
}

module.exports = { createMembersBoard, RULES };
