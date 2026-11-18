'use strict';
/**
 * members_board.test.js — Tomer's member-management board (services/members_board.js) and the kind of a stored
 * conversation record (utils/contact_kind.js).
 *
 * Production, 2026-11-18: the "חברים" pane read a legacy store and showed 0 members while Arbox held ~150; the leads
 * list showed 29 records of which 19 were a test batch, 1 was the owner and 36 members carried a sales score.
 * All people here are invented.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { createMembersBoard } = require('../services/members_board');
const { classifyAll, kindOf } = require('../utils/contact_kind');

const TODAY = '2026-11-18';
const day = n => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const ok = (extra = {}) => ({ ok: true, fetchedAt: '2026-11-18T07:00:00.000Z', stale: false, source: 'Arbox', ...extra });
const plan = (start, end, o = {}) => ({ name: 'מנוי חודשי', kind: 'plan', startDate: start, endDate: end, active: true, cancelled: false, recurring: end === null, ...o });
function member(id, name, o = {}) {
  const ms = o.memberships ?? [plan(day(-200), null)];
  const activeMs = ms.filter(m => m.active && !m.cancelled && (!m.startDate || m.startDate <= TODAY) && (!m.endDate || m.endDate >= TODAY));
  const checkins = o.checkins ?? [day(-2), day(-5), day(-9), day(-16), day(-20)];
  const last = checkins.slice().sort().at(-1) ?? null;
  return { userId: String(id), name, phone: o.phone ?? `97258700${String(id).padStart(4, '0')}`, phoneShared: false, isActive: activeMs.length > 0, freeze: o.freeze ?? 'not_frozen', memberships: ms, activeMs,
    firstStart: o.firstStart ?? ms[0]?.startDate ?? null, checkins, lastAttendance: last, daysAbsent: last ? Math.round((Date.parse(TODAY) - Date.parse(last)) / 86400000) : null,
    future: o.future ?? [], neverAttended: !!o.neverAttended, earliestActiveStart: activeMs[0]?.startDate ?? null };
}
const MEMBERS = () => [
  member(1, 'א רגילה'),
  member(2, 'ב חדשה', { memberships: [plan(day(-10), day(20))], checkins: [day(-4), day(-1)], future: [{ date: day(2), time: '18:00', className: 'אימון כח' }] }),
  member(3, 'ג מסתיים', { memberships: [plan(day(-80), day(6))] }),
  member(4, 'ד חידשה', { memberships: [plan(day(-80), day(6)), plan(day(7), day(37), { active: true })] }),
  member(5, 'ה הסתיים', { memberships: [plan(day(-60), day(-8))] }),
  member(6, 'ו מזמן', { memberships: [plan(day(-200), day(-90))] }),
  member(7, 'ז נעדרת', { checkins: [day(-12), day(-19)] }),
  member(8, 'ח יורדת', { checkins: [day(-3), day(-15), day(-17), day(-20), day(-24)] }),
  member(9, 'ט בהקפאה', { freeze: 'frozen', checkins: [day(-25)] }),
  member(10, 'י לא התחילה', { memberships: [plan(day(-6), day(24))], checkins: [], neverAttended: true }),
  member(11, 'כ בלי מנוי', { memberships: [] }),
  member(12, 'ל ותיקה שחידשה', { memberships: [plan(day(-300), day(-17), { active: false }), plan(day(-16), null)], firstStart: day(-300), checkins: [], neverAttended: true }),
];
function world({ src = {}, members = MEMBERS(), cases = [], tasks = [] } = {}) {
  const snap = { today: TODAY, members, byId: new Map(members.map(m => [m.userId, m])), freeze: { sourceConfirmed: false },
    src: { users: ok(), memberships: ok(), types: ok(), attendance: ok(), futureBookings: ok(), cancellations: ok(), holds: ok(), transactions: ok(), ...src } };
  return createMembersBoard({ now: () => new Date('2026-11-18T07:00:00Z'), care: { loadSnapshot: jest.fn(async () => snap) },
    cases: { list: ({ phone, open } = {}) => cases.filter(c => (!phone || c.phone === phone) && (!open || c.status !== 'resolved')) }, tomerStore: { getOpenTasks: () => tasks, getTasks: ({ phone }) => tasks.filter(t => t.phone === phone) } });
}
const inGroup = (b, id) => b.members.filter(m => m.groups.includes(id)).map(m => m.name).sort();
const grp = (b, id) => b.groups.find(g => g.id === id);

describe('the board follows the source data and states its rules', () => {
  test('each group holds exactly the members its rule describes', async () => {
    const b = await world().board();
    expect(b.ok).toBe(true);
    expect(inGroup(b, 'active')).toEqual(['א רגילה', 'ב חדשה', 'ג מסתיים', 'ד חידשה', 'ז נעדרת', 'ח יורדת', 'ט בהקפאה', 'י לא התחילה', 'ל ותיקה שחידשה']);
    expect(inGroup(b, 'first_month')).toEqual(['ב חדשה', 'י לא התחילה']);
    expect(inGroup(b, 'expiring')).toEqual(['ג מסתיים']);                         // "ד חידשה" has a next membership: not expiring
    expect(inGroup(b, 'expired')).toEqual(['ה הסתיים']);                          // "ו מזמן" ended 90 days ago: not listed at all
    expect(inGroup(b, 'absent')).toEqual(['ז נעדרת', 'ל ותיקה שחידשה']);          // the frozen member is not "absent"; a long-time member who renewed and did not come is absent, not "new"
    expect(inGroup(b, 'declining')).toEqual(['ח יורדת']);
    expect(inGroup(b, 'frozen')).toEqual(['ט בהקפאה']);
    expect(inGroup(b, 'not_started')).toEqual(['י לא התחילה']);
    expect(b.members.map(m => m.name)).not.toContain('כ בלי מנוי');                // a client row without a membership is not a member
    for (const g of b.groups) expect([g.id, g.count, typeof g.rule, !!g.source, !!g.fetchedAt]).toEqual([g.id, inGroup(b, g.id).length, 'string', true, true]);
  });

  test('a threshold the owner has not approved is marked provisional and listed as a decision; nothing here sends anything', async () => {
    const board = world();
    const b = await board.board();
    expect(grp(b, 'absent').provisional.ask).toMatch(/כמה ימים בלי אימון/);
    expect(grp(b, 'active').provisional).toBeNull();
    expect(b.decisions).toHaveLength(5);
    expect(Object.keys(board).sort()).toEqual(['RULES', 'board', 'card']);         // no send, no write
  });

  test('a row carries what the owner needs: membership, dates, last attendance, next booking, next action — and no fake balance', async () => {
    const b = await world().board();
    const m = b.members.find(x => x.name === 'ב חדשה');
    expect(m).toMatchObject({ active: true, membership: { name: 'מנוי חודשי', start: day(-10), end: day(20), current: true, entriesLeft: null },
      lastAttendance: day(-1), daysAbsent: 1, nextBooking: { date: day(2), time: '18:00' }, nextAction: 'חודש ראשון' });
    expect(m.phoneMasked).toMatch(/•••/);
    expect(JSON.stringify(b.members)).not.toMatch(/"phone":/);
    expect(b.notes.join(' ')).toMatch(/יתרת כניסות אינה חלק מרשימת המנויים/);
  });

  test('open cases and staff tasks put the member in "open requests" and decide the next action', async () => {
    const b = await world({ cases: [{ id: 'case-9', phone: '972587000001', category: 'membership_freeze', status: 'awaiting_staff', createdAt: '2026-11-16T10:00:00Z' }],
                            tasks: [{ id: 'task-9', phone: '972587000007', type: 'cancel_request', status: 'open', createdAt: '2026-11-17T10:00:00Z' }] }).board();
    expect(inGroup(b, 'open_requests')).toEqual(['א רגילה', 'ז נעדרת']);
    expect(b.members.find(m => m.name === 'א רגילה')).toMatchObject({ nextAction: 'בקשה פתוחה — בטיפול הצוות', openCases: [{ id: 'case-9' }] });
  });
});

describe('zero is not a substitute for missing data', () => {
  test('Arbox not read → the board says "not loaded" with the reason, not an empty list', async () => {
    const b = await world({ src: { users: { ok: false, error: 'Arbox GET /v3/users failed: ECONNABORTED' } } }).board();
    expect(b).toMatchObject({ ok: false, state: 'not_loaded' });
    expect(b.error).toMatch(/ECONNABORTED/);
    expect(b.members).toBeUndefined();
  });
  test('Arbox refuses the key → "no permission"', async () => {
    expect(await world({ src: { memberships: { ok: false, error: 'Arbox GET /v3/users/memberships → 401' } } }).board()).toMatchObject({ ok: false, state: 'no_permission' });
  });
  test('the snapshot throws → "sync error"', async () => {
    const board = createMembersBoard({ care: { loadSnapshot: async () => { throw new Error('boom'); } }, cases: { list: () => [] }, tomerStore: { getOpenTasks: () => [] } });
    expect(await board.board()).toMatchObject({ ok: false, state: 'sync_error', error: 'boom' });
  });
  test('attendance not read → the attendance groups are "unavailable" (count null), the membership groups still work', async () => {
    const b = await world({ src: { attendance: { ok: false, error: 'bookingsReport 500' } } }).board();
    expect(b.ok).toBe(true);
    expect(grp(b, 'absent')).toMatchObject({ state: 'unavailable', count: null });
    expect(grp(b, 'absent').error).toMatch(/bookingsReport 500/);
    expect(grp(b, 'expiring')).toMatchObject({ state: 'ok', count: 1 });
    expect(b.members.find(m => m.name === 'א רגילה')).toMatchObject({ attendanceKnown: false, lastAttendance: null, daysAbsent: null });
  });
  test('a group with nobody in it is an honest zero with state ok', async () => {
    const b = await world({ members: [member(1, 'א רגילה')] }).board();
    expect(grp(b, 'expired')).toMatchObject({ state: 'ok', count: 0 });
  });
});

describe('member card', () => {
  test('memberships, attendance, coming bookings, handling history and the next action', async () => {
    const c = await world({ cases: [{ id: 'case-9', phone: '972587000002', category: 'membership_freeze', status: 'resolved', createdAt: '2026-11-10T10:00:00Z', resolution: { note: 'הוקפא ב-Arbox' } }] }).card('2');
    expect(c).toMatchObject({ ok: true, member: { name: 'ב חדשה' }, attendance: { known: true, dates: [day(-1), day(-4)] }, upcoming: { known: true, bookings: [{ date: day(2) }] }, nextAction: 'חודש ראשון' });
    expect(c.memberships[0]).toMatchObject({ name: 'מנוי חודשי', active: true });
    expect(c.history).toEqual([expect.objectContaining({ kind: 'פנייה', id: 'case-9', resolution: 'הוקפא ב-Arbox' })]);
  });
  test('balance of entries: what Arbox stated on the latest booking row, with its date; unknown stays unknown, never zero', async () => {
    const mk = getMemberBookings => { const w = world(); return createMembersBoard({ now: () => new Date('2026-11-18T07:00:00Z'), care: { loadSnapshot: async () => (await w.board(), w._snap) }, cases: { list: () => [] }, tomerStore: { getOpenTasks: () => [], getTasks: () => [] }, getMemberBookings }); };
    const snapOf = () => { const members = MEMBERS(); return { today: TODAY, members, byId: new Map(members.map(m => [m.userId, m])), freeze: {}, src: { users: ok(), memberships: ok(), types: ok(), attendance: ok(), futureBookings: ok(), holds: ok() } }; };
    const board = fn => createMembersBoard({ now: () => new Date('2026-11-18T07:00:00Z'), care: { loadSnapshot: async () => snapOf() }, cases: { list: () => [] }, tomerStore: { getOpenTasks: () => [], getTasks: () => [] }, getMemberBookings: fn });
    expect((await board(async () => ({ bookings: [{ date: day(-9), sessionsLeft: 6 }, { date: day(-2), sessionsLeft: 4, membershipName: 'כרטיסייה' }, { date: day(-1), sessionsLeft: null }] })).card('1')).entries).toEqual({ known: true, left: 4, asOf: day(-2), membership: 'כרטיסייה' });
    expect((await board(async () => ({ bookings: [{ date: day(-1), sessionsLeft: null }] })).card('1')).entries).toMatchObject({ known: false });
    expect((await board(async () => { throw new Error('ECONNABORTED'); }).card('1')).entries).toMatchObject({ known: false, reason: expect.stringMatching(/ECONNABORTED/) });
    expect((await board(null).card('1')).entries).toMatchObject({ known: false });
    expect(typeof mk).toBe('function');
  });
  test('attendance not read → the card says so; an unknown member → not found', async () => {
    const w = world({ src: { attendance: { ok: false, error: 'x' } } });
    expect((await w.card('2')).attendance).toMatchObject({ known: false, error: 'x' });
    expect(await world().card('999')).toMatchObject({ ok: false, state: 'not_found' });
  });
});

describe('a WhatsApp conversation is not necessarily a sales lead', () => {
  const id = (category, extra = {}) => ({ category, stale: false, others: [], ambiguous: false, reason: null, ...extra });
  const realIn = { messages: [{ direction: 'in', id: 'AC0DD945B486D69CC052810A130854A6' }] };
  test('member, staff, former member, Arbox lead, lead, a number the staff merely wrote to, unclear', () => {
    const k = (lead, i, extra) => kindOf(lead, { id: i, ...extra });
    expect(k({ status: 'human_owns', score: 4 }, id('member'))).toMatchObject({ kind: 'member', salesList: false });
    expect(k({ status: 'human_owns' }, id('staff'))).toMatchObject({ kind: 'staff', salesList: false });
    expect(k({ status: 'human_owns' }, id('former_member'))).toMatchObject({ kind: 'former_member', salesList: true });
    expect(k({ status: 'cold' }, id('lead'))).toMatchObject({ kind: 'trial', salesList: true, label: 'ליד ב-Arbox (ניסיון / התעניינות)' });
    expect(k({ status: 'warm', history: [{ role: 'user', content: 'x' }] }, id('unknown'))).toMatchObject({ kind: 'lead', salesList: true });
    expect(k({ status: 'human_owns', meta: { humanOwnsReason: 'staff_manual_reply' }, history: [] }, id('unknown'), { thread: realIn })).toMatchObject({ kind: 'contact', salesList: false });
    expect(k({ status: 'human_owns', meta: { humanOwnsReason: 'staff_manual_reply' }, history: [] }, id('unknown'), { hasAppointment: true })).toMatchObject({ kind: 'lead' });
    expect(k({ status: 'cold' }, id('unavailable'))).toMatchObject({ kind: 'unclear', salesList: true });
    expect(k({ status: 'converted_member' }, id('member', { others: ['lead'] }))).toMatchObject({ kind: 'member', mixed: true });
  });
  test('a test batch needs strong evidence: a wave of real leads in the same hour is never marked as test', () => {
    const t0 = Date.parse('2026-11-10T19:15:00Z'), peek = () => id('unknown');
    const mk = (phone, min, extra = {}) => ({ phone, status: 'new', firstSeen: new Date(t0 + min * 60000).toISOString(), history: [], ...extra });
    const batch = ['972509100001', '972509100002', '972509100003', '972509100004', '972509100005'].map((p, i) => mk(p, i));
    const invalid = mk('97200010002', 2);
    const real = ['972521234567', '972549876543', '972502223344', '972533334455', '972586667788'].map((p, i) => mk(p, i + 3, { status: 'warm' }));
    const replied = mk('972509100003', 9);                                         // same pattern, but a real WhatsApp message arrived from it
    const threads = new Map([[replied.phone + 'x', null]]);
    const kinds = classifyAll([...batch.filter(b => b.phone !== replied.phone), invalid, ...real], { peek, getThread: () => null });
    expect([...kinds.values()].map(k => k.kind)).toEqual(['test', 'test', 'test', 'test', 'test', 'lead', 'lead', 'lead', 'lead', 'lead']);
    const k2 = classifyAll([...batch], { peek, getThread: p => (p === replied.phone ? realIn : null) });
    expect(k2.get(replied.phone).kind).not.toBe('test');
    expect(threads.size).toBe(1);
    // production 2026-11-18: a minute after the directory was read its answers are marked stale — the kind must not flip
    const staleKinds = classifyAll(batch, { peek: () => id('unknown', { stale: true, ageMs: 5 * 60000 }), getThread: () => null });
    expect([...staleKinds.values()].map(k => k.kind)).toEqual(['test', 'test', 'test', 'test', 'test']);
    expect([...classifyAll(batch, { peek: () => id('unavailable', { stale: true }), getThread: () => null }).values()].map(k => k.kind)).toEqual(Array(5).fill('unclear'));
    // four such records are not a batch
    expect([...classifyAll(batch.slice(0, 4), { peek, getThread: () => null }).values()].every(k => k.kind !== 'test')).toBe(true);
  });
});
