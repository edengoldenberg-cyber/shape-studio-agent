'use strict';
/**
 * class_actions.test.js — booking, cancelling and moving a member's class in Arbox, ISOLATED.
 *
 * Nothing here reaches Arbox. Two layers are exercised:
 *   A. services/arbox_gateway.js against a LOCAL mock HTTP server: the exact request that would be sent, and the three
 *      switches that must all be on before anything is sent;
 *   B. services/class_actions.js + services/member_handoff.js against a stateful fake of the gateway: the order of a
 *      move (book, read back, cancel, read back), every refusal, and that a failure never leaves the member without
 *      her original place.
 */
const http = require('http');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { createClassActions } = require('../services/class_actions');
const { createMemberHandoff } = require('../services/member_handoff');
const { ilDate } = require('../utils/callback_time');

const DAY = '2026-11-18';
const NOW = ilDate(2026, 10, 17, 10, 0);                         // Tuesday 17.11.2026 10:00 Israel time: the classes are tomorrow
const cls = (id, start, o = {}) => ({ scheduleId: id, date: DAY, start, end: start, name: 'פילאטיס מכשירים', capacity: 8, cancelLockHours: 8, lateCancellationAllowed: true, status: 'active',
  occupancy: { registered: 5, capacity: 8, standby: 0, spotsLeft: 3 }, ...o });
const booking = time => ({ date: DAY, time, className: 'פילאטיס מכשירים', checkedIn: false });

/** A stateful fake of Arbox as the gateway shows it. Writes change the bookings unless told to fail. */
function fakeArbox(over = {}) {
  const s = { bookings: [booking('18:00')], classes: [cls(101, '17:00'), cls(102, '18:00')], memberships: [{ membershipUserId: 77, active: true, cancelled: false, startDate: '2026-01-01', endDate: '2026-12-31', type: 'plan' }],
    enabled: new Set(['class_book', 'class_cancel']), writes: [], reads: 0, fail: {}, lag: {}, ...over };
  const gw = {
    writesEnabled: op => s.enabled.has(op),
    resolveMember: async () => ({ status: 'found', member: { userId: 500, name: 'מתאמנת בדיקה', active: true, role: 'client' } }),
    getBookings: async () => { s.reads++; if (s.fail.read) throw new Error('arbox down'); return { bookings: s.lag.hide ? s.bookings.filter(b => b.time !== s.lag.hide) : s.bookings.slice(), source: 'fake' }; },
    getClasses: async () => ({ classes: s.classes, occupancyAvailable: true, source: 'fake' }),
    getMemberships: async () => { if (s.fail.memberships) throw new Error('arbox down'); return { memberships: s.memberships }; },
    executeWrite: async (op, args) => {
      s.writes.push({ op, args: { ...args } });
      const f = s.fail[op];
      if (f === 'rejected') { const e = new Error('Arbox class_x → 422'); e.kind = 'rejected'; e.submitted = true; e.detail = 'The selected schedule id is invalid.'; throw e; }
      const c = s.classes.find(x => x.scheduleId === args.scheduleId);
      const apply = () => { if (op === 'class_book') s.bookings.push(booking(c.start)); else s.bookings = s.bookings.filter(b => b.time !== c.start); };
      if (f === 'timeout_applied') { apply(); const e = new Error('timeout'); e.kind = 'unavailable'; e.uncertain = true; e.submitted = true; throw e; }
      if (f === 'timeout_lost') { const e = new Error('timeout'); e.kind = 'unavailable'; e.uncertain = true; e.submitted = true; throw e; }
      if (f !== 'accepted_not_applied') apply();
      return { accepted: true, status: 200 };
    },
  };
  return { s, gw };
}
const actionsOn = gw => createClassActions({ gateway: gw, logger: require('../utils/logger'), now: () => NOW, sleep: async () => {}, verifyWaitMs: 0 });
const facts = (s, { cur = '18:00', tgt = '17:00' } = {}) => ({ member: { userId: 500 }, date: DAY, bookings: s.bookings.slice(), classes: s.classes,
  current: cur ? { booking: s.bookings.find(b => b.time === cur) ?? null } : null, target: tgt ? { cls: s.classes.find(c => c.start === tgt) ?? null } : null });

describe('B. the plan: what may be done automatically', () => {
  test('with the writes off (the default) nothing is planned and nothing is sent', async () => {
    const { s, gw } = fakeArbox({ enabled: new Set() });
    const pl = await actionsOn(gw).plan({ kind: 'move', ...facts(s) });
    expect(pl).toMatchObject({ ok: false, reason: 'writes_disabled' });
    expect(s.writes).toHaveLength(0);
    // one of the two operations is not enough for a move
    const half = fakeArbox({ enabled: new Set(['class_book']) });
    expect((await actionsOn(half.gw).plan({ kind: 'move', ...facts(half.s) })).reason).toBe('writes_disabled');
  });

  test('a move books the new class FIRST and cancels the original second, on the member\'s single active membership', async () => {
    const { s, gw } = fakeArbox();
    const pl = await actionsOn(gw).plan({ kind: 'move', ...facts(s) });
    expect(pl.ok).toBe(true);
    expect(pl.steps.map(x => [x.op, x.args])).toEqual([
      ['class_book', { userId: 500, scheduleId: 101, membershipUserId: 77 }],
      ['class_cancel', { userId: 500, scheduleId: 102 }]]);
    expect(s.writes).toHaveLength(0);                                      // planning sends nothing
  });

  test.each([
    ['the class she asks for is full', s => { s.classes[0].occupancy = { registered: 8, capacity: 8, standby: 2, spotsLeft: 0 }; }, 'target_full'],
    ['its occupancy could not be read', s => { s.classes[0].occupancy = null; }, 'occupancy_unknown'],
    ['she is already booked into it', s => { s.bookings.push(booking('17:00')); }, 'already_booked'],
    ['the class she asks for does not exist', s => { s.classes.splice(0, 1); }, 'target_not_found'],
    ['no active membership covers the day', s => { s.memberships[0].endDate = '2026-11-01'; }, 'no_active_membership'],
    ['two active memberships: it is not clear which to charge', s => { s.memberships.push({ membershipUserId: 78, active: true, cancelled: false, startDate: '2026-01-01', endDate: null }); }, 'membership_ambiguous'],
    ['the membership cannot be read', s => { s.fail.memberships = true; }, 'membership_unreadable'],
    ['the original class is inside its cancellation window in Arbox', s => { s.classes[1].cancelLockHours = 48; }, 'inside_cancellation_window'],
    ['the cancellation rule of the original class is unknown', s => { s.classes[1].cancelLockHours = null; }, 'cancel_rule_unknown'],
    ['the original booking is not in Arbox', s => { s.bookings.length = 0; }, 'current_not_found'],
    ['two classes start at the hour of the original booking', s => { s.classes.push(cls(103, '18:00')); }, 'current_class_unclear'],
  ])('refused, and nothing is sent, when %s', async (_n, change, reason) => {
    const { s, gw } = fakeArbox();
    change(s);
    const pl = await actionsOn(gw).plan({ kind: 'move', ...facts(s) });
    expect(pl).toMatchObject({ ok: false, reason });
    expect(pl.text).toBeTruthy();
    expect(s.writes).toHaveLength(0);
  });

  test('a class that already started is not booked, and a late cancellation is never automatic', async () => {
    const { s, gw } = fakeArbox();
    const late = createClassActions({ gateway: gw, logger: require('../utils/logger'), now: () => ilDate(2026, 10, 18, 15, 43), sleep: async () => {} });   // the day itself, 15:43
    expect((await late.plan({ kind: 'cancel', ...facts(s, { tgt: null }) })).reason).toBe('inside_cancellation_window');     // 18:00 is 2h17m away, the rule is 8h
    expect((await late.plan({ kind: 'move', ...facts(s) })).reason).toBe('inside_cancellation_window');                       // …so the move is not started at all
    const after = createClassActions({ gateway: gw, logger: require('../utils/logger'), now: () => ilDate(2026, 10, 18, 17, 5), sleep: async () => {} });
    expect((await after.plan({ kind: 'book', ...facts(s, { cur: null }) })).reason).toBe('target_started');
  });
});

describe('B. carrying a move out: success is what Arbox shows afterwards', () => {
  const run = async (over) => { const { s, gw } = fakeArbox(over); const a = actionsOn(gw); const pl = await a.plan({ kind: 'move', ...facts(s) }); return { s, res: await a.execute(pl) }; };

  test('book, read back, cancel, read back - and only then "done"', async () => {
    const { s, res } = await run();
    expect(res).toMatchObject({ ok: true, state: 'done', done: ['class_book', 'class_cancel'] });
    expect(s.writes.map(w => w.op)).toEqual(['class_book', 'class_cancel']);
    expect(s.bookings.map(b => b.time)).toEqual(['17:00']);
    expect(res.log.every(l => l.accepted && l.verify.verified)).toBe(true);
  });

  test('the new booking is refused by Arbox: nothing changed, the original place is kept, no cancel is sent', async () => {
    const { s, res } = await run({ fail: { class_book: 'rejected' } });
    expect(res).toMatchObject({ ok: false, state: 'nothing_changed', failed: { op: 'class_book', stage: 'request' } });
    expect(s.writes.map(w => w.op)).toEqual(['class_book']);
    expect(s.bookings.map(b => b.time)).toEqual(['18:00']);
  });

  test('the new booking was accepted but is not visible in Arbox: STOP - the original is not cancelled', async () => {
    const { s, res } = await run({ fail: { class_book: 'accepted_not_applied' } });
    expect(res).toMatchObject({ ok: false, state: 'unknown', failed: { op: 'class_book', stage: 'verify' } });
    expect(s.writes.map(w => w.op)).toEqual(['class_book']);
    expect(s.bookings.map(b => b.time)).toEqual(['18:00']);
  });

  test('a timeout after the booking request: it is NOT sent again; what Arbox shows decides', async () => {
    const applied = await run({ fail: { class_book: 'timeout_applied' } });           // the request did arrive
    expect(applied.res).toMatchObject({ ok: true, state: 'done' });
    expect(applied.s.writes.filter(w => w.op === 'class_book')).toHaveLength(1);
    const lost = await run({ fail: { class_book: 'timeout_lost' } });                 // it did not
    expect(lost.res).toMatchObject({ ok: false, state: 'unknown' });
    expect(lost.s.writes.filter(w => w.op === 'class_book')).toHaveLength(1);
    expect(lost.s.writes.some(w => w.op === 'class_cancel')).toBe(false);
    expect(lost.s.bookings.map(b => b.time)).toEqual(['18:00']);
  });

  test('the cancel of the original fails after the new booking succeeded: she holds BOTH, never neither', async () => {
    const { s, res } = await run({ fail: { class_cancel: 'rejected' } });
    expect(res).toMatchObject({ ok: false, state: 'holds_both', done: ['class_book'], failed: { op: 'class_cancel' } });
    expect(s.bookings.map(b => b.time).sort()).toEqual(['17:00', '18:00']);
  });

  test('Arbox cannot be read after a write: the outcome is unknown and nothing more is sent', async () => {
    const { s, gw } = fakeArbox();
    const a = actionsOn(gw), pl = await a.plan({ kind: 'move', ...facts(s) });
    s.fail.read = true;
    const res = await a.execute(pl);
    expect(res).toMatchObject({ ok: false, state: 'unknown' });
    expect(s.writes.map(w => w.op)).toEqual(['class_book']);
  });
});

describe('B. through the member hand-off: what the member and the staff are told', () => {
  function world(over) {
    const { s, gw } = fakeArbox(over);
    const tasks = [], sent = [], alerts = [];
    let seq = 0;
    const tomerStore = {
      getTasks: ({ phone, type } = {}) => tasks.filter(t => (!phone || t.phone === phone) && (!type || t.type === type)),
      getOpenTasks: () => tasks.filter(t => t.status === 'open'),
      createTask: t => { const x = { id: `t${++seq}`, status: 'open', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...t }; tasks.push(x); return x; },
      updateTask: (id, u) => Object.assign(tasks.find(t => t.id === id), u, { updatedAt: NOW.toISOString() }),
      resolveTask: (id, r) => Object.assign(tasks.find(t => t.id === id), { status: 'resolved', ...r }),
      appendAudit: () => {},
    };
    const h = createMemberHandoff({ gateway: gw, tomerStore, logger: require('../utils/logger'), now: () => NOW, classActions: actionsOn(gw),
      alertOwner: async (subject, body) => { alerts.push({ subject, body }); return { results: [{ phone: 'mgr', idMessage: `A${alerts.length}` }] }; },
      sendText: async (to, text) => { sent.push({ to, text }); return { idMessage: `M${sent.length}` }; } });
    return { s, h, tasks, sent, alerts };
  }
  const ASK = 'אני רשומה מחר לפילאטיס ב-18:00 ורוצה לעבור ל-17:00';

  test('done and verified: the member is told it was done; the task is recorded as closed and nobody is alerted', async () => {
    const w = world();
    const r = await w.h.handleClassRequest({ phone: '972500000001', text: ASK, sentAt: NOW });
    expect(r.action).toMatchObject({ state: 'done' });
    expect(w.s.bookings.map(b => b.time)).toEqual(['17:00']);
    expect(w.sent[0].text).toMatch(/^בוצע ✅ עברת מ-18:00 ל-17:00/);
    expect(w.sent[0].text).toMatch(/אימתתי את זה עכשיו מול Arbox/);
    expect(w.tasks[0]).toMatchObject({ status: 'resolved', resolvedBy: 'tomer', action: { state: 'done' } });
    expect(w.alerts).toHaveLength(0);
  });

  test('refused by a rule: nothing is sent to Arbox, the staff get the exact reason, the member keeps her place and is told so', async () => {
    const w = world();
    w.s.classes[0].occupancy = { registered: 8, capacity: 8, standby: 1, spotsLeft: 0 };
    await w.h.handleClassRequest({ phone: '972500000001', text: ASK, sentAt: NOW });
    expect(w.s.writes).toHaveLength(0);
    expect(w.tasks[0]).toMatchObject({ status: 'open' });
    expect(w.tasks[0].detail).toMatch(/לא בוצע אוטומטית: השיעור המבוקש מלא/);
    expect(w.alerts).toHaveLength(1);
    expect(w.sent[0].text).toMatch(/לא ביצעתי את זה בעצמי: השיעור המבוקש מלא/);
    expect(w.sent[0].text).toMatch(/הרישום הקיים שלך לא השתנה/);
  });

  test('the booking fails: she is told it was NOT done and that her registration is unchanged; the staff are alerted', async () => {
    const w = world({ fail: { class_book: 'rejected' } });
    await w.h.handleClassRequest({ phone: '972500000001', text: ASK, sentAt: NOW });
    expect(w.s.bookings.map(b => b.time)).toEqual(['18:00']);
    expect(w.sent[0].text).toMatch(/ניסיתי לבצע את זה ב-Arbox ולא הצלחתי/);
    expect(w.sent[0].text).toMatch(/הרישום הקיים שלך לא השתנה/);
    expect(w.sent[0].text).not.toMatch(/בוצע ✅/);
    expect(w.alerts[0].body).toMatch(/לא בוצע שום שינוי ב-Arbox/);
    expect(w.tasks[0]).toMatchObject({ status: 'open', priority: 'high', action: { state: 'nothing_changed' } });
  });

  test('booked but the old class could not be cancelled: she is told she holds both, and the staff are asked to cancel one', async () => {
    const w = world({ fail: { class_cancel: 'rejected' } });
    await w.h.handleClassRequest({ phone: '972500000001', text: ASK, sentAt: NOW });
    expect(w.sent[0].text).toMatch(/רשמתי אותך לפילאטיס מכשירים ב-17:00/);
    expect(w.sent[0].text).toMatch(/כרגע יש לך רישום לשני השיעורים/);
    expect(w.alerts[0].body).toMatch(/הרישום החדש בוצע ב-Arbox; הרישום הקודם לא בוטל — נדרש ביטול ידני/);
  });

  test('an unknown outcome is never reported as done', async () => {
    const w = world({ fail: { class_book: 'accepted_not_applied' } });
    await w.h.handleClassRequest({ phone: '972500000001', text: ASK, sentAt: NOW });
    expect(w.sent[0].text).toMatch(/לא הצלחתי לאמת שהיא בוצעה, ולכן אני לא אומר לך שזה נעשה/);
    expect(w.alerts[0].body).toMatch(/תוצאתה לא אומתה — נא לבדוק ב-Arbox/);
  });
});

describe('A. the gateway: the exact request, and the three switches', () => {
  let server, port, seen;
  const saved = {};
  beforeAll(async () => {
    seen = [];
    server = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { seen.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null });
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ statusCode: 200, data: { booking_id: 1 } })); }); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    for (const k of ['ARBOX_BASE_URL', 'ARBOX_WRITES_ENABLED', 'ARBOX_WRITE_OPS', 'ARBOX_TEST_ASSUME_CONTRACT', 'NODE_ENV']) saved[k] = process.env[k];
    process.env.ARBOX_BASE_URL = `http://127.0.0.1:${port}`; process.env.NODE_ENV = 'test';
  });
  afterAll(async () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await new Promise(r => server.close(r)); });
  const fresh = () => { jest.resetModules(); const g = require('../services/arbox_gateway'); g._resetForTests(); return g; };

  test('off by default; the switch alone is not enough; the operation must be NAMED; the contract must be verified', async () => {
    delete process.env.ARBOX_WRITES_ENABLED; delete process.env.ARBOX_WRITE_OPS; delete process.env.ARBOX_TEST_ASSUME_CONTRACT;
    let g = fresh();
    expect(g.writesEnabled('class_book')).toBe(false);
    await expect(g.executeWrite('class_book', { userId: 1, scheduleId: 2 })).rejects.toMatchObject({ kind: 'write_disabled' });
    process.env.ARBOX_WRITES_ENABLED = 'true'; g = fresh();
    expect(g.writesEnabled('class_book')).toBe(false);                     // not verified, not named
    process.env.ARBOX_TEST_ASSUME_CONTRACT = 'true'; g = fresh();          // tests only: stands in for "verified"
    expect(g.writesEnabled('class_book')).toBe(false);                     // still not named
    expect(g.writesEnabled('membership_hold')).toBe(true);                 // an older operation without the allow-list rule…
    process.env.ARBOX_WRITE_OPS = 'class_book'; g = fresh();
    expect([g.writesEnabled('class_book'), g.writesEnabled('class_cancel'), g.writesEnabled('membership_hold')]).toEqual([true, false, false]);   // …is shut out once a list exists
    expect(g.writeStatus().class_cancel).toMatchObject({ contractVerified: false, needsAllowList: true, namedInAllowList: false, executable: false });
    expect(seen).toHaveLength(0);                                          // none of this sent anything
  });

  test('the documented body, and nothing else, is sent', async () => {
    process.env.ARBOX_WRITES_ENABLED = 'true'; process.env.ARBOX_TEST_ASSUME_CONTRACT = 'true'; process.env.ARBOX_WRITE_OPS = 'class_book,class_cancel';
    const g = fresh();
    await g.executeWrite('class_book', { userId: 500, scheduleId: 101, membershipUserId: 77, bookWithoutMembership: true });
    await g.executeWrite('class_cancel', { userId: 500, scheduleId: 102, lateCancellation: true });
    expect(seen).toEqual([
      { method: 'POST', url: '/v3/schedule/bookSession', body: { user_id: 500, schedule_id: 101, membership_user_id: 77 } },
      { method: 'POST', url: '/v3/schedule/cancelUserBooking', body: { schedule_id: 102, user_id: 500 } }]);
    await expect(g.executeWrite('class_book', { userId: 500 })).rejects.toMatchObject({ kind: 'bad_args' });
    expect(seen).toHaveLength(2);
  });
});
