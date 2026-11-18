'use strict';
/**
 * care_policy_2026_11_18.test.js — the service and retention policy the owner approved on 2026-11-18, as settings:
 *   Sunday–Thursday 10:00–18:00 · one proactive message per member per 7 days, shared by ALL programs · renewal 7 days
 *   before the end · 14 days without training and an ended membership → a task for the owner, no message · a birthday
 *   on a day without sending is skipped, never greeted late · owner-approved wording with the name only.
 * Pure: the policy layer and the program rules, no network.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const policyLib = require('../services/contact_policy');

const POLICY = { windowStart: 10, windowEnd: 18, fridayEnd: 13, friday: false, saturday: false, birthdaySaturday: 'skip', cooldownHours: 168, cooldownAll: true, attendanceCooldownDays: 6,
  recentConversationHours: 24, replyWindowDays: 5, defaultPauseDays: 14, paymentGraceHours: 24, expiryDays: 7, absence14Task: true };
const il = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h - 2, m));           // November 2026, Israel time (UTC+2). 15 = Sunday … 20 = Friday, 21 = Saturday
const member = { phone: '972587000001', phoneShared: false, isActive: true, freeze: 'not_frozen' };
const state = (extra = {}) => ({ proactiveOn: true, allowed: true, owner: 'tomer', careOptOut: false, pause: null, openCase: false, lastConversationAt: null, lastProactiveAt: null, lastAttendanceMsgAt: null, ...extra });
const ev = (program, now, st = {}, m = member) => policyLib.evaluate({ program, now, policy: POLICY, member: m, state: state(st) });

describe('when a proactive message may go out', () => {
  test('Sunday–Thursday 10:00–18:00 only', () => {
    expect(ev('absence7', il(15, 10)).decision).toBe('send');                    // Sunday 10:00
    expect(ev('absence7', il(19, 17, 59)).decision).toBe('send');                // Thursday 17:59
    for (const t of [il(15, 9, 59), il(19, 18), il(20, 11), il(21, 11)])         // before 10, at 18:00, Friday, Saturday
      expect(ev('absence7', t)).toEqual({ decision: 'defer', reasons: ['outside_window'] });
  });

  test('one proactive message per member in seven days, shared by every program — also the date-bound ones', () => {
    const sixDaysAgo = il(18, 11).getTime() - 6 * 86400000, eightDaysAgo = il(18, 11).getTime() - 8 * 86400000;
    for (const p of ['absence7', 'onboarding7', 'onboarding14', 'welcome', 'birthday', 'expiry5']) {
      expect(ev(p, il(18, 11), { lastProactiveAt: sixDaysAgo }).reasons).toContain('cooldown');
      expect(ev(p, il(18, 11), { lastProactiveAt: eightDaysAgo }).decision).toBe('send');
    }
    // without the shared cap (the earlier default) the date-bound programs were exempt
    expect(policyLib.evaluate({ program: 'birthday', now: il(18, 11), policy: { ...POLICY, cooldownAll: false }, member, state: state({ lastProactiveAt: sixDaysAgo }) }).decision).toBe('send');
  });

  test('manual handling, an opt-out, a freeze and an open case come before any program', () => {
    expect(ev('absence7', il(18, 11), { owner: 'human' })).toEqual({ decision: 'defer', reasons: ['human_owns'] });
    expect(ev('absence7', il(18, 11), { owner: 'opted_out' }).decision).toBe('block');
    expect(ev('birthday', il(18, 11), { careOptOut: true }).reasons).toContain('care_opt_out');
    expect(ev('absence7', il(18, 11), {}, { ...member, freeze: 'frozen' }).reasons).toContain('on_hold');
    expect(ev('absence7', il(18, 11), {}, { ...member, freeze: 'unknown' }).reasons).toContain('freeze_unknown');   // unknown is never read as "not frozen"
    expect(ev('onboarding7', il(18, 11), { openCase: true })).toEqual({ decision: 'defer', reasons: ['open_case'] });
  });
});

describe('the programs, on a snapshot', () => {
  const TODAY = '2026-11-18';
  const day = n => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const ms = (id, start, end, o = {}) => ({ membershipUserId: id, name: 'מנוי 3 חודשים', kind: 'plan', startDate: start, endDate: end, createdAt: `${start} 09:00`, active: !end || end >= TODAY, cancelled: false, recurring: false, ...o });
  function mk(members, { settings = {}, openOwnerTask = jest.fn(() => ({ id: 'task-1' })), now = il(18, 11) } = {}) {
    jest.resetModules();
    const fs = require('fs'), os = require('os'), path = require('path');
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-cp-'));
    const store = require('../utils/member_care_store');
    store.updateSettings({ policy: POLICY, ...settings }, 'test');
    const { createMemberCare } = require('../services/member_care');
    const sent = [];
    const care = createMemberCare({ gateway: { getBookings: async () => ({ bookings: [] }), getCancellations: async () => ({ cancellations: [] }), getMemberships: async () => ({ memberships: [] }), clearCache() {} },
      store, cases: { list: () => [] }, logger: { info() {}, warn() {}, error() {} }, now: () => now, openOwnerTask,
      sendMember: async (phone, text) => { sent.push({ phone, text }); return { state: 'sent', idMessage: `M${sent.length}` }; },
      state: { proactiveOn: () => true, allowed: () => true, owner: () => 'tomer', lastConversationAt: () => null, testPhones: () => ['972526324276'] } });
    const all = members.map((m, i) => { const act = m.memberships.filter(x => x.active && !x.cancelled); const last = (m.checkins ?? []).slice().sort().at(-1) ?? null;
      return { userId: String(100 + i), name: `מתאמנת ${i}`, firstName: 'נועה', gender: 'female', phone: `97258700010${i}`, phoneShared: false, freeze: 'not_frozen', isActive: act.length > 0, activeMs: act,
        first: m.memberships[0], firstStart: m.memberships[0]?.startDate ?? null, earliestActiveStart: act[0]?.startDate ?? null, checkins: m.checkins ?? [], lastAttendance: last,
        daysAbsent: last ? Math.round((Date.parse(TODAY) - Date.parse(last)) / 86400000) : null, neverAttended: false, future: [], futureThisWeek: [], attendedThisWeek: false, birthday: null, ...m }; });
    const okSrc = { ok: true, fetchedAt: now.toISOString() };
    const snap = { today: TODAY, hhmm: '11:00', weekStart: day(-3), weekEnd: day(3), members: all, byId: new Map(all.map(x => [x.userId, x])), transactions: [], freeze: {},
      src: { users: okSrc, memberships: okSrc, types: okSrc, attendance: okSrc, futureBookings: okSrc, cancellations: okSrc, holds: okSrc, transactions: okSrc } };
    return { care, store, snap, sent, openOwnerTask, all, evalP: id => care.evaluateProgram(id, snap, store.getSettings()) };
  }
  const reasons = (w, id, i) => w.evalP(id).excluded.find(x => x.userId === w.all[i].userId)?.reasons ?? null;
  const inc = (w, id, i) => w.evalP(id).included.find(x => x.m.userId === w.all[i].userId) ?? null;

  test('renewal: 7 days before the end, only when nothing follows; the wording carries the date and no price', () => {
    const w = mk([
      { memberships: [ms(1, day(-80), day(7))] },                                   // ends in 7 days
      { memberships: [ms(2, day(-80), day(8))] },                                   // 8 days: not yet
      { memberships: [ms(3, day(-80), day(5)), ms(4, day(6), day(96), { active: true })] },   // renewed
      { memberships: [ms(5, day(-80), null, { recurring: true })] },                // renews by itself
    ]);
    expect(inc(w, 'expiry5', 0).text).toBe('היי נועה, לפי המערכת המנוי שלך מסתיים ב־25.11.2026. רוצה שנציג מהצוות יחזור אליך לגבי המשך?');
    expect(inc(w, 'expiry5', 0).text).not.toMatch(/₪|הנחה|מחיר/);
    expect(reasons(w, 'expiry5', 1)).toEqual(['not_in_window']);
    expect(reasons(w, 'expiry5', 2)).toEqual(['renewed']);
    expect(reasons(w, 'expiry5', 3)).toEqual(['no_end_date']);
  });

  test('the first-month check-ins use the FIRST membership: a long-time member who renewed is never "new"', () => {
    const w = mk([
      { memberships: [ms(1, day(-7), day(83))], checkins: [day(-5)] },             // joined a week ago
      { memberships: [ms(2, day(-14), day(76))], checkins: [day(-10)] },           // joined two weeks ago, trained
      { memberships: [ms(3, day(-300), day(-8), { active: false }), ms(4, day(-7), day(83))], checkins: [day(-3)] },   // veteran, renewed a week ago
    ]);
    expect(inc(w, 'onboarding7', 0).text).toBe('היי נועה, איך עבר השבוע הראשון בשייפ? הסתדרת עם ההרשמה והשיעורים? יש משהו שנוכל לעזור בו?');
    expect(inc(w, 'onboarding14', 1).text).toBe('היי נועה, רציתי לשמוע איך הולך לך בשייפ עד עכשיו — מה עובד טוב ומה נוכל לשפר?');
    expect(inc(w, 'onboarding7', 2)).toBeNull();                                   // her first membership started 300 days ago
    expect(reasons(w, 'onboarding7', 2)).toEqual(['not_active']);                  // judged by her FIRST membership, which ended long ago
    expect(reasons(w, 'welcome', 2)).toEqual(['not_first']);
  });

  test('absence: 7 days → the approved message; missing attendance data is not absence; someone with a booking is left alone', () => {
    const w = mk([
      { memberships: [ms(1, day(-200), null, { recurring: true })], checkins: [day(-7)] },
      { memberships: [ms(2, day(-200), null, { recurring: true })], checkins: [] },                                  // no check-in in the 30 days read
      { memberships: [ms(3, day(-200), null, { recurring: true })], checkins: [day(-7)], future: [{ date: day(1), time: '18:00' }] },
      { memberships: [ms(4, day(-200), null, { recurring: true })], checkins: [day(-3)] },
    ]);
    expect(inc(w, 'absence7', 0).text).toBe('היי נועה, כאן תומר משייפ 🙂 עבר קצת זמן מאז האימון האחרון שלך. איך הולך? יש משהו שנוכל לעזור בו כדי לחזור לשגרה?');
    expect(reasons(w, 'absence7', 1)).toEqual(['attendance_unknown']);
    expect(reasons(w, 'absence7', 2)).toEqual(['has_upcoming_booking']);
    expect(reasons(w, 'absence7', 3)).toEqual(['not_in_window']);
  });

  test('14 days without training and an ended membership open ONE task for the owner each — no message, outside the sending rules, never twice', async () => {
    const w = mk([
      { memberships: [ms(1, day(-200), null, { recurring: true })], checkins: [day(-14)] },
      { memberships: [ms(2, day(-90), day(-2), { active: false })] },                                               // ended two days ago, nothing after it
      { memberships: [ms(3, day(-90), day(-2), { active: false }), ms(4, day(-1), day(89))] },                      // ended, and renewed
    ], { now: il(20, 11) });                                                       // a Friday: no message may go out, a task may be opened
    w.store.updateSettings({ programs: { absence14: { enabled: true, activatedAt: '2026-11-01T08:00:00.000Z' }, expired: { enabled: true, activatedAt: '2026-11-01T08:00:00.000Z' } } }, 'test');
    w.care.approvePolicy({ approved: true, fingerprint: w.care.policyApproval().fingerprint, by: 'עדן' });
    w.care.loadSnapshot = async () => w.snap;
    expect(inc(w, 'absence14', 0)).toMatchObject({ task: true, text: null, policy: { decision: 'send' } });
    expect(inc(w, 'expired', 1)).toMatchObject({ task: true });
    expect(reasons(w, 'expired', 2)).toEqual(['still_active']);
  });

  test('a birthday on a day without sending is skipped and recorded as such — no eve greeting, no late greeting', () => {
    const fri = '1990-11-20', wed = '1990-11-18';
    const w = mk([{ memberships: [ms(1, day(-200), null, { recurring: true })], birthday: wed }, { memberships: [ms(2, day(-200), null, { recurring: true })], birthday: fri }]);
    expect(inc(w, 'birthday', 0).text).toBe('מזל טוב נועה 🎉 מאחלים לך בריאות, שמחה והרבה רגעים טובים. מצוות שייפ!');
    expect(reasons(w, 'birthday', 1)).toEqual(['not_today']);                       // Wednesday: her Friday birthday is not greeted early
    const onFri = mk([{ memberships: [ms(2, day(-200), null, { recurring: true })], birthday: fri }]);
    onFri.snap.today = '2026-11-20';
    expect(onFri.evalP('birthday').excluded[0].reasons).toEqual(['not_sending_day']);
    onFri.snap.today = '2026-11-22';                                               // Sunday: no belated greeting
    expect(onFri.evalP('birthday').excluded[0].reasons).toEqual(['not_today']);
  });

  test('the welcome carries no group link and no guest sessions; an approved text that says who writes is not introduced twice', () => {
    const w = mk([{ memberships: [ms(1, day(0), day(90))], first: { ...ms(1, day(0), day(90)) } }]);
    const x = inc(w, 'welcome', 0);
    expect(x.text).toBe('היי נועה, כאן תומר, העוזר הדיגיטלי של שייפ 🙂 ברוכים הבאים! אני כאן לשאלות ולעזרה עם האימונים והשיעורים.');
    expect(x.text).not.toMatch(/chat\.whatsapp|אורח/);
    expect(w.care.programBlocks('welcome').map(b => b.code)).not.toContain('group_link_missing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The hold report, as measured on the real Arbox on 2026-11-18: it returns holds by their END date inside the range and
// refuses more than 31 days. Reading only the next 30 days missed a hold that is active today and ends later.
describe('who is on hold today — the read covers every hold that is active now', () => {
  const { createArboxMock } = require('./helpers/arbox_mock.cjs');
  const arbox = createArboxMock();
  let gw;
  const day = n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const hold = (id, user, from, to) => ({ membership_hold_id: id, user_id: user, membership_user_id: 9000 + id, start_suspend_time: from, end_suspend_time: to, total_days: 1, suspend_reason: 'x' });
  beforeAll(async () => { process.env.ARBOX_BASE_URL = await arbox.listen(); process.env.ARBOX_CLIENT_ID = 'test'; process.env.ARBOX_MIN_GAP_MS = '0'; process.env.ARBOX_LOCATION_ID = '1'; jest.resetModules(); gw = require('../services/arbox_gateway'); });
  afterAll(async () => { await arbox.close(); });

  test('a long hold that ends in three months is found; an ended one and one that has not started are not "on hold today"', async () => {
    arbox.reset();
    arbox.state.holds.push(hold(1, 11, day(-10), day(12)), hold(2, 22, day(-20), day(95)), hold(3, 33, day(-40), day(-3)), hold(4, 44, day(20), day(50)));
    gw.clearCache();
    const r = await gw.getHolds({ from: day(-1), to: day(29) });
    expect(r.userIds.sort()).toEqual(['11', '22']);                                // 22 ends in 95 days: the 30-day read used to miss it
    expect(r.holds.find(h => h.userId === '22')).toEqual({ userId: '22', from: day(-20), to: day(95) });
    expect(r.windows).toBe(13);
    expect(r.rowsRead).toBe(3);                                                    // the ended hold is outside what is read; the future one is read and not counted
    expect(arbox.log.filter(l => /membersOnHoldReport/.test(l.path)).every(l => (new Date(l.query.toDate) - new Date(l.query.fromDate)) / 86400000 <= 31)).toBe(true);
  });

  test('a failed window fails the whole read — a partial list is never used as "not on hold"', async () => {
    arbox.reset(); arbox.mode.holdsDown = true; gw.clearCache();
    await expect(gw.getHolds({ from: day(-1), to: day(29) })).rejects.toThrow();
    arbox.mode.holdsDown = false;
  });
});
