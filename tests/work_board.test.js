'use strict';
/**
 * work_board.test.js — Tomer's one work board (services/owner_tasks.js → board()) and the role map
 * (services/tomer_roles.js). All people are invented.
 *
 * Owner rules, 2026-11-18: one source of truth linked to the cases and the member cards; status, the person on it and
 * the due time are separate; a sent alert / an opened card is not a done task; a proposal of a retention program is not
 * a task; a counter and its list must agree; zero is not the same as "not loaded".
 */
const fs = require('fs'), os = require('os'), path = require('path');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const il = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h - 2, m));           // Israel time, November 2026 (UTC+2)
const MANAGER = '972509000001';
function world({ dir = null } = {}) {
  process.env.DATA_DIR = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'shape-wb-'));
  jest.resetModules();
  const w = { dir: process.env.DATA_DIR, now: il(18, 10), sent: [], closed: [], fail: {}, writesFor: new Set(),
    cases: [
      { id: 'c1', phone: '972587000001', memberUserId: 101, memberName: 'מתאמנת א', category: 'membership_freeze', summary: 'בקשת הקפאה 1.12–15.12', status: 'awaiting_staff', owner: 'tomer', createdAt: il(16, 9).toISOString(),
        notification: { state: 'accepted' }, events: [{ type: 'opened', at: il(16, 9).toISOString(), by: 'tomer' }, { type: 'staff_notified', at: il(16, 9, 1).toISOString(), by: 'tomer' }] },
      { id: 'c2', phone: '972587000002', memberUserId: 102, memberName: 'מתאמנת ב', category: 'general_request', summary: 'שאלה על חיוב', status: 'awaiting_member', owner: 'מירי', createdAt: il(17, 9).toISOString(), events: [] },
    ],
    tasks: [
      { id: 't1', type: 'class_change', kind: 'book', phone: '972587000003', arboxId: 103, memberName: 'מתאמנת ג', summary: 'רישום לשיעור — בבירור', memberMessage: 'אני רוצה להשתבץ היום ב-18', status: 'open', missing: 'target_type', alert: null, createdAt: il(18, 9, 50).toISOString(), updatedAt: il(18, 9, 50).toISOString() },
      { id: 't2', type: 'class_change', kind: 'book', phone: '972587000004', arboxId: 104, memberName: 'מתאמנת ד', summary: 'רישום לשיעור — רישום לALL IN ב-18:00 היום', memberMessage: 'תרשום אותי לALL IN', status: 'open', missing: null,
        alert: { state: 'sent', lastAt: il(18, 9, 30).toISOString(), attempts: 1 }, memberReply: { state: 'sent', at: il(18, 9, 30).toISOString() }, createdAt: il(18, 9, 29).toISOString(), updatedAt: il(18, 9, 30).toISOString() },
      { id: 't3', type: 'class_change', kind: 'move', phone: '972587000005', arboxId: 105, memberName: 'מתאמנת ה', summary: 'מעבר לשיעור אחר', status: 'open', missing: null, alert: { state: 'sent', lastAt: il(18, 8).toISOString() }, action: { state: 'unknown' }, createdAt: il(18, 8).toISOString(), updatedAt: il(18, 8).toISOString() },
      { id: 't4', type: 'freeze_request', phone: '972587000006', memberName: 'מתאמנת ו', status: 'open', createdAt: il(12, 9).toISOString(), updatedAt: il(12, 9).toISOString() },
    ],
    apts: [
      { id: 'a1', leadPhone: '972587000007', leadName: 'ליד ז', status: 'callback_pending', scheduledAt: il(18, 14), windowEndAt: il(18, 16).toISOString(), createdAt: il(18, 7) },
      { id: 'a2', leadPhone: '972587000008', leadName: 'ליד ח', status: 'callback_pending', scheduledAt: il(17, 14), windowEndAt: il(17, 16).toISOString(), createdAt: il(17, 7) },
    ],
    episodes: [] };
  const guard = (name, fn) => () => { if (w.fail[name]) throw new Error(w.fail[name]); return fn(); };
  w.ot = require('../services/owner_tasks').createOwnerTasks({
    now: () => w.now, isQuietHours: () => false, managerPhone: () => MANAGER, baseUrl: () => 'https://panel.example.test',
    cases: { list: guard('cases', () => w.cases.filter(c => c.status !== 'resolved')) }, tomerStore: { getOpenTasks: guard('tasks', () => w.tasks.filter(t => t.status === 'open')) },
    aptStore: { getAll: guard('callbacks', () => w.apts), ACTIVE_STATUSES: new Set(['callback_pending', 'confirmed']) },
    care: { openEpisodes: guard('care', () => w.episodes), label: id => ({ absence7: '7 ימים בלי אימון' }[id] ?? id) },
    classWritesFor: p => w.writesFor.has(p), caseLabel: c => ({ membership_freeze: 'בקשת הקפאת מנוי', general_request: 'פנייה כללית' }[c.category]),
    sendManager: async (phone, text) => { w.sent.push({ phone, text }); return { idMessage: `M${w.sent.length}` }; },
    closeSource: async (key, action) => { w.closed.push([key, action]); return { ok: true }; },
  });
  return w;
}
const byKey = (b, k) => [...b.items, ...b.recentDone].find(x => x.key === k);

describe('one board: every open piece of work once, with status, person and time kept apart', () => {
  test('each source appears once with the right status, who it waits for, and what closes it', () => {
    const w = world(), b = w.ot.board();
    expect(b.ok).toBe(true);
    expect(b.items.map(x => x.key).sort()).toEqual(['apt:a1', 'apt:a2', 'case:c1', 'case:c2', 'task:t1', 'task:t2', 'task:t3', 'task:t4']);
    expect(byKey(b, 'case:c1')).toMatchObject({ board: 'waiting_owner', boardLabel: 'ממתין לעדן', assignee: 'עדן', userId: 101, reason: 'בקשת הקפאה 1.12–15.12', overdue: false, dueSetAt: null });
    expect(byKey(b, 'case:c1').trail.map(x => x.text)).toEqual(['הפנייה נפתחה', expect.stringMatching(/התקבלה אצל ספק השליחה \(אין אישור מסירה למכשיר\)/)]);
    expect(byKey(b, 'case:c1').closeRule).toMatch(/קריאת הפנייה או שליחת התראה אינן סגירה/);
    expect(byKey(b, 'case:c2')).toMatchObject({ board: 'waiting_member', assignee: 'מירי' });
    expect(byKey(b, 'task:t1')).toMatchObject({ board: 'waiting_member', assignee: 'תומר', kind: 'בקשת שיעור' });       // still being clarified with the member
    expect(byKey(b, 'task:t1').next).toMatch(/נשאל\/ה על הפרט החסר/);
    expect(byKey(b, 'task:t2')).toMatchObject({ board: 'waiting_owner', assignee: 'עדן' });
    expect(byKey(b, 'task:t2').closeRule).toMatch(/תומר אינו מורשה לבצע אותה בעצמו/);
    expect(byKey(b, 'task:t3')).toMatchObject({ board: 'blocked', blocked: expect.stringMatching(/תוצאתה לא אומתה/) });
    expect(byKey(b, 'apt:a1')).toMatchObject({ board: 'planned', overdue: false });                                     // its time has not come
    expect(byKey(b, 'apt:a2')).toMatchObject({ board: 'waiting_owner', overdue: true });                                // its time passed
    expect(byKey(b, 'task:t4')).toMatchObject({ title: 'בקשת הקפאת מנוי', overdue: false });                            // no time was set: waiting, not "overdue"
  });

  test('where Tomer may carry out the class action himself, the closing condition says so', () => {
    const w = world(); w.writesFor.add('972587000004');
    expect(byKey(w.ot.board(), 'task:t2').closeRule).toMatch(/נסגרת לבד כשתומר ביצע את הפעולה ב-Arbox ואימת אותה/);
  });

  test('"היום והבא בתור": every counter is the length of the list it opens, and every key is on the board', () => {
    const w = world(), b = w.ot.board();
    for (const [k, keys] of Object.entries(b.today)) { expect(b.counts[k]).toBe(keys.length); for (const key of keys) expect(byKey(b, key)).toBeTruthy(); }
    expect(b.today.needsOwner.sort()).toEqual(['apt:a2', 'case:c1', 'task:t2', 'task:t3', 'task:t4']);
    expect(b.today.tomerCan.sort()).toEqual(['case:c2', 'task:t1']);
    expect(b.today.overdue).toEqual(['apt:a2']);
    expect(b.today.stuck.sort()).toEqual(['case:c2', 'task:t3']);                // blocked, and a member who has not answered for over 30 minutes
    expect(b.today.planned).toEqual(['apt:a1']);
    expect(b.counts.open).toBe(8);
    expect(Object.values(b.counts.byStatus).reduce((a, n) => a + n, 0)).toBe(8);
  });

  test('a request that is still being clarified with the member is not in the owner\'s reminder; a ripe one is', () => {
    const w = world();
    w.ot.sync();                                                                 // what the reminder tick does first
    const keys = w.ot.due().map(x => x.key);
    expect(keys).not.toContain('task:t1');
    expect(keys).not.toContain('case:c2');
    expect(keys).toEqual(expect.arrayContaining(['task:t2', 'case:c1', 'apt:a2']));
    expect(keys).not.toContain('apt:a1');
  });
});

describe('the owner\'s actions change one thing each, and are recorded', () => {
  test('postponing keeps the new time and the reason; when the time comes the task is back, and overdue', async () => {
    const w = world();
    const r = await w.ot.act('case:c1', 'snooze', { by: 'עדן', until: il(19, 9).toISOString(), note: 'ממתין לתשובת רואה החשבון' });
    expect(r.ok).toBe(true);
    let t = byKey(w.ot.board(), 'case:c1');
    expect(t).toMatchObject({ board: 'planned', snoozeReason: 'ממתין לתשובת רואה החשבון', overdue: false, assignee: 'עדן' });
    expect(t.history.at(-1)).toMatchObject({ action: 'snooze', by: 'עדן', note: 'ממתין לתשובת רואה החשבון' });
    expect(w.ot.due().map(x => x.key)).not.toContain('case:c1');                 // a postponed task is not reminded
    w.now = il(19, 9, 5);
    t = byKey(w.ot.board(), 'case:c1');
    expect(t).toMatchObject({ board: 'waiting_owner', overdue: true });
    expect(w.ot.board().today.overdue).toContain('case:c1');
  });

  test('assigning changes who is on it and nothing else; "בטיפול" changes the status and keeps the person and the time', async () => {
    const w = world();
    await w.ot.act('apt:a2', 'assign', { by: 'עדן', to: 'מירי' });
    let t = byKey(w.ot.board(), 'apt:a2');
    expect(t).toMatchObject({ assignee: 'מירי', board: 'waiting_owner', overdue: true });
    await w.ot.act('apt:a2', 'in_progress', { by: 'מירי' });
    t = byKey(w.ot.board(), 'apt:a2');
    expect(t).toMatchObject({ assignee: 'מירי', board: 'in_progress', overdue: true });
    expect(t.history.map(h => h.action)).toEqual(['assign', 'in_progress']);
    expect((await w.ot.act('apt:a2', 'assign', { to: '  ' })).error).toBe('assignee_required');
  });

  test('"בוצע" closes it here and where it lives; it shows under "recently done"; reopening brings it back with its history', async () => {
    const w = world();
    await w.ot.act('task:t2', 'done', { by: 'עדן', note: 'נרשמה ב-Arbox' });
    expect(w.closed).toEqual([['task:t2', 'done']]);
    let b = w.ot.board();
    expect(b.items.map(x => x.key)).not.toContain('task:t2');
    expect(b.today.recentDone).toContain('task:t2');
    expect(byKey(b, 'task:t2')).toMatchObject({ board: 'done', boardLabel: 'בוצע' });
    await w.ot.act('task:t2', 'reopen', { by: 'עדן' });
    b = w.ot.board();
    expect(byKey(b, 'task:t2').history.map(h => h.action)).toEqual(['done', 'reopen']);
    expect(b.items.map(x => x.key)).toContain('task:t2');
  });
});

describe('zero is not "not loaded"; nothing is duplicated; the state survives a restart', () => {
  test('a source that cannot be read is named, and its tasks are neither closed nor counted as zero', () => {
    const w = world();
    w.ot.board();
    w.fail.cases = 'ECONNRESET';
    const b = w.ot.board();
    expect(b.sources.cases).toEqual({ ok: false, error: 'ECONNRESET' });
    expect(b.sources.tasks.ok).toBe(true);
    expect(b.sourceError).toMatch(/cases: ECONNRESET/);
    expect(byKey(b, 'case:c1')).toMatchObject({ state: 'open' });                 // kept from the last read, not closed
  });

  test('the same event read many times is one task; a task closed at its source is closed here too', () => {
    const w = world();
    for (let i = 0; i < 5; i++) w.ot.board();
    expect(w.ot.board().items).toHaveLength(8);
    w.tasks.find(t => t.id === 't1').status = 'resolved';                         // e.g. Tomer booked and verified it in Arbox
    const b = w.ot.board();
    expect(b.items.map(x => x.key)).not.toContain('task:t1');
    expect(byKey(b, 'task:t1')).toMatchObject({ board: 'done', closedBy: 'source' });
  });

  test('a retention message that exists is on the board; when the member no longer qualifies it leaves the board by itself', () => {
    const w = world();
    w.episodes = [{ key: 'absence7|105|2026-11-18', program: 'absence7', status: 'pending', userId: 105, name: 'מתאמנת ה', phone: '972587000005', createdAt: il(18, 9).toISOString(), sendAt: il(18, 12).toISOString(), reasons: [], history: [] },
                  { key: 'absence7|106|2026-11-18', program: 'absence7', status: 'blocked', userId: 106, name: 'מתאמנת ו', phone: '972587000006', createdAt: il(18, 9).toISOString(), reasons: ['policy_unapproved'], history: [] }];
    let b = w.ot.board();
    expect(byKey(b, 'care:absence7|105|2026-11-18')).toMatchObject({ kind: 'הודעת שימור', title: '7 ימים בלי אימון', board: 'planned', assignee: 'תומר' });
    expect(byKey(b, 'care:absence7|106|2026-11-18')).toMatchObject({ board: 'blocked', blocked: expect.stringMatching(/לא נשלחה/) });
    expect(w.ot.due().map(x => x.key).filter(k => k.startsWith('care:'))).toEqual([]);   // never in the owner's reminder
    w.episodes = [];                                                               // she came back to train: the program cancelled its episode
    b = w.ot.board();
    expect(b.items.some(x => x.key.startsWith('care:'))).toBe(false);
    expect(byKey(b, 'care:absence7|105|2026-11-18')).toMatchObject({ board: 'done', closedBy: 'source' });
  });

  test('after a restart: the owner\'s state, the person on it, the postponement and the history are all there', async () => {
    const w = world();
    await w.ot.act('case:c1', 'assign', { by: 'עדן', to: 'מירי' });
    await w.ot.act('case:c1', 'snooze', { by: 'עדן', until: il(20, 9).toISOString(), note: 'אחרי שיחה עם הלקוחה' });
    const w2 = world({ dir: w.dir });
    w2.cases = w.cases; w2.tasks = w.tasks; w2.apts = w.apts;
    const t = byKey(w2.ot.board(), 'case:c1');
    expect(t).toMatchObject({ assignee: 'מירי', board: 'planned', snoozeReason: 'אחרי שיחה עם הלקוחה' });
    expect(t.history.map(h => h.action)).toEqual(['assign', 'snooze']);
  });

  test('reminders: off until the owner sets the times; the board shows the last and the next one', () => {
    const w = world();
    let r = w.ot.board().reminders;
    expect(r).toMatchObject({ state: 'needs_settings', lastAt: null, nextAt: null });
    w.ot.setSettings({ times: ['09:00', '17:00'], enabled: true });
    r = w.ot.board().reminders;
    expect(r).toMatchObject({ state: 'on', nextAt: '2026-11-18 17:00' });           // it is 10:00 on Wednesday
    w.now = il(20, 18);                                                            // Friday evening → Sunday morning (Saturday is not a sending day)
    expect(w.ot.board().reminders.nextAt).toBe('2026-11-22 09:00');
  });
});

describe('what Tomer does today, role by role — from the running switches', () => {
  const mk = ({ writes = {}, programs = {}, proactive = false, policy = false, aggregators = [], rem = { state: 'needs_settings', text: 'לא הוגדרו שעות שליחה ותדירות.' } } = {}) => {
    const { createTomerRoles } = require('../services/tomer_roles');
    const ws = Object.fromEntries(['class_book', 'class_cancel', 'class_move_late', 'membership_hold', 'membership_cancel'].map(k => [k, { executable: !!writes[k] }]));
    const ids = ['welcome', 'payment_failed', 'birthday', 'expiry5', 'absence14', 'absence7', 'tuesday', 'onboarding14', 'month1'];
    const care = {
      PRIORITY: ids, PROGRAMS: Object.fromEntries(ids.map(id => [id, { label: `תוכנית ${id}` }])),
      overview: () => ({ proactiveOn: proactive, policyApproval: { approved: policy }, programs: ids.map(id => ({ id, label: `תוכנית ${id}`, enabled: !!programs[id], blocks: policy ? [] : [{ code: 'policy_unapproved', text: 'מדיניות הקשר עוד לא אושרה' }] })) }),
      preview: async id => { if (id === 'payment_failed') throw new Error('transactions report 500');
        return { ok: true, program: id, label: `תוכנית ${id}`, enabled: !!programs[id], blocks: policy ? [] : [{ text: 'מדיניות הקשר עוד לא אושרה' }], dataBlocked: null, today: '2026-11-18', totalMembers: 144,
          included: id === 'absence7' ? [{ userId: 1, name: 'מתאמנת א', phone: '972587000001', decision: 'send', reasons: [] }, { userId: 2, name: 'מתאמנת ב', phone: '972587000002', decision: 'send', reasons: [] }] : [], excludedCounts: [{ code: 'x', text: 'יש רישום לאימון קרוב', count: 12 }] }; },
    };
    return createTomerRoles({ gateway: { writeStatus: () => ws }, memberCare: care, ownerTasks: { status: () => rem }, identity: { phonesIn: () => aggregators, summary: () => ({ at: Date.parse('2026-11-18T08:00:00Z') }) }, now: () => new Date('2026-11-18T08:00:00Z') });
  };
  afterEach(() => { delete process.env.ARBOX_WRITE_TEST_PHONES; delete process.env.ARBOX_WRITE_AUDIENCE; });

  test('as it is in production now: class actions for the test phone only, everything proactive off and saying why', () => {
    process.env.ARBOX_WRITE_TEST_PHONES = '972526324276';
    const r = mk({ writes: { class_book: true, class_cancel: true } }).roles();
    const row = id => r.rows.find(x => x.id === id);
    expect(r.rows.map(x => x.id)).toEqual(['class_book_cancel', 'class_move', 'freeze', 'membership_cancel', 'absence', 'first_month', 'renewal', 'birthday', 'service', 'handoff', 'external']);
    expect(row('class_book_cancel')).toMatchObject({ state: 'partial', stateLabel: 'פעיל חלקית' });
    expect(row('class_book_cancel').activeFor).toMatch(/מספר הבדיקה בלבד \(1\)/);
    expect(row('class_move').blocked).toMatch(/בתוך חלון הביטול .* כבוי/);
    expect(row('freeze').blocked).toMatch(/לא אומת ולא אושר — כבוי/);
    for (const id of ['absence', 'first_month', 'renewal', 'birthday']) {
      expect(row(id).state).toBe('blocked');
      expect(row(id).activeFor).toMatch(/כבוי — לא נשלחת שום הודעה יזומה/);
      expect(row(id).blocked).toMatch(/מתג ההודעות היזומות של תומר כבוי · מדיניות הקשר עוד לא אושרה/);
      expect(row(id).live).toMatch(/לא אומת חי/);
    }
    expect(row('handoff')).toMatchObject({ state: 'partial' });
    expect(r.switches).toMatchObject({ proactive: false, classWrites: true, lateMove: false, freeze: false, membershipCancel: false, ownerReminders: 'needs_settings' });
  });

  test('with nothing switched on the class row is "ready but off"; a program that is on, approved and unlocked is "active"', () => {
    expect(mk().roles().rows.find(x => x.id === 'class_book_cancel')).toMatchObject({ state: 'ready_off' });
    const r = mk({ proactive: true, policy: true, programs: { absence7: true } }).roles();
    expect(r.rows.find(x => x.id === 'absence')).toMatchObject({ state: 'active', blocked: null });
    expect(r.rows.find(x => x.id === 'birthday')).toMatchObject({ state: 'ready_off' });
  });

  test('proposals are candidates, not tasks: a program that is off says nothing will be sent; one that failed to load is "not loaded"', async () => {
    const p = await mk().proposals();
    expect(p.ok).toBe(true);
    const a7 = p.programs.find(x => x.id === 'absence7');
    expect(a7).toMatchObject({ state: 'proposal', candidates: 2, totalActive: 144 });
    expect(a7.stateLabel).toMatch(/הצעה לבדיקה — כבויה, שום הודעה לא תישלח/);
    expect(a7.blocks).toEqual(['מתג ההודעות היזומות של תומר כבוי', 'מדיניות הקשר עוד לא אושרה']);
    expect(a7.sample[0]).toEqual({ userId: 1, name: 'מתאמנת א', phone: '•••001', decision: 'send', why: null });   // the phone is masked
    expect(p.programs.find(x => x.id === 'payment_failed')).toMatchObject({ state: 'not_loaded', error: 'transactions report 500' });
    expect(p.programs.find(x => x.id === 'birthday')).toMatchObject({ state: 'proposal', candidates: 0 });           // an honest zero
    const on = await mk({ proactive: true, policy: true, programs: { absence7: true } }).proposals();
    expect(on.programs.find(x => x.id === 'absence7')).toMatchObject({ state: 'approved_active', blocks: [] });
  });

  test('outside-club members: their own list with attendance followed; proactive messages and Arbox writes stay off; unread attendance is "not loaded"', async () => {
    const { createTomerRoles } = require('../services/tomer_roles');
    const gw = ({ att = 'ok' } = {}) => ({ todayIL: () => '2026-11-18',
      getAllUsers: async () => ({ fetchedAt: Date.parse('2026-11-18T08:00:00Z'), users: [{ userId: 1, role: 'aggregatorMember', name: 'חברת מועדון ב', phone: '972587000011' }, { userId: 2, role: 'aggregatorMember', name: 'חבר מועדון א', phone: '972587000012' },
        { userId: 3, role: 'aggregatorMember', name: 'בלי מנוי', phone: '972587000013' }, { userId: 4, role: 'client', name: 'מנויה רגילה', phone: '972587000014' }] }),
      getAllMemberships: async () => ({ memberships: [{ userId: 1, active: true, cancelled: false, startDate: '2026-01-01', endDate: null }, { userId: 2, active: true, cancelled: false, startDate: '2026-01-01', endDate: null }, { userId: 4, active: true, cancelled: false, startDate: '2026-01-01', endDate: null }] }),
      getAllBookings: async () => { if (att !== 'ok') throw new Error('bookingsReport 500'); return { fetchedAt: Date.parse('2026-11-18T08:05:00Z'), bookings: [{ userId: 1, date: '2026-11-16', checkedIn: true }, { userId: 1, date: '2026-11-17', checkedIn: false }, { userId: 4, date: '2026-11-17', checkedIn: true }] }; } });
    const mkr = g => createTomerRoles({ gateway: g, memberCare: {}, ownerTasks: {}, identity: {}, now: () => new Date('2026-11-18T08:10:00Z') });
    const x = await mkr(gw()).external();
    expect(x).toMatchObject({ ok: true, count: 2, fetchedAt: '2026-11-18T08:00:00.000Z', decisions: [] });
    expect(x.members).toEqual([{ name: 'חבר מועדון א', phone: '•••012', lastAttendance: null, daysAbsent: null }, { name: 'חברת מועדון ב', phone: '•••011', lastAttendance: '2026-11-16', daysAbsent: 2 }]);
    expect(x.attendance).toMatchObject({ known: true, trainedLast7: 1, absent7plus: 0, noCheckin30: 1 });       // no check-in in 30 days is "unknown", not "absent"
    expect(x.notAvailable.join(' ')).toMatch(/פניות יזומות .* כבויות/);
    const noAtt = await mkr(gw({ att: 'down' })).external();
    expect(noAtt).toMatchObject({ ok: true, count: 2, attendance: { known: false, error: 'bookingsReport 500' } });
    expect(noAtt.members.every(m => m.lastAttendance === null && m.daysAbsent === null)).toBe(true);
    const broken = await mkr({ todayIL: () => '2026-11-18', getAllUsers: async () => { throw new Error('directory not loaded'); }, getAllMemberships: async () => ({ memberships: [] }) }).external();
    expect(broken).toMatchObject({ ok: false, state: 'not_loaded', error: 'directory not loaded' });
  });
});
