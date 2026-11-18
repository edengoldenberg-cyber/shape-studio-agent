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
    getBookings: async () => { s.reads++; if (s.fail.read) throw new Error('arbox down');
      return { bookings: (s.lag.hide ? s.bookings.filter(b => b.time !== s.lag.hide) : s.bookings.slice()).map(b => ({ ...b, sessionsLeft: s.sessions ?? null })), source: 'fake' }; },
    getClasses: async () => ({ classes: s.classes, occupancyAvailable: true, source: 'fake' }),
    getMemberships: async () => { if (s.fail.memberships) throw new Error('arbox down'); return { memberships: s.memberships }; },
    executeWrite: async (op, args) => {
      s.writes.push({ op, args: { ...args } });
      const f = s.fail[op];
      if (f === 'rejected') { const e = new Error('Arbox class_x → 422'); e.kind = 'rejected'; e.submitted = true; e.detail = 'The selected schedule id is invalid.'; throw e; }
      const c = s.classes.find(x => x.scheduleId === args.scheduleId);
      // a punch card (s.sessions) is charged on booking and refunded on cancelling, unless Arbox keeps the charge (s.noRefund)
      const apply = () => { if (op === 'class_book') { s.bookings.push(booking(c.start)); if (s.sessions != null) s.sessions -= 1; if (s.doubleBook) s.bookings.push(booking(c.start)); }
        else { s.bookings = s.bookings.filter(b => b.time !== c.start); if (s.sessions != null && !s.noRefund) s.sessions += 1; } };
      if (f === 'timeout_applied') { apply(); const e = new Error('timeout'); e.kind = 'unavailable'; e.uncertain = true; e.submitted = true; throw e; }
      if (f === 'timeout_lost') { const e = new Error('timeout'); e.kind = 'unavailable'; e.uncertain = true; e.submitted = true; throw e; }
      if (f !== 'accepted_not_applied') apply();
      return { accepted: true, status: 200 };
    },
  };
  return { s, gw };
}
const actionsOn = (gw, extra = {}) => createClassActions({ gateway: gw, logger: require('../utils/logger'), now: () => NOW, sleep: async () => {}, verifyWaitMs: 0, audience: () => true, ...extra });
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
    ['the original class is inside its cancellation window and a late move was not verified against Arbox', s => { s.classes[1].cancelLockHours = 48; }, 'late_move_unverified'],
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

  test('inside the cancellation window: a cancellation alone is never automatic; a MOVE is, once the late-move capability is on', async () => {
    const { s, gw } = fakeArbox();
    const at1543 = { now: () => ilDate(2026, 10, 18, 15, 43) };                        // the day itself, 15:43: 18:00 is 2h17m away, the rule is 8h
    const late = actionsOn(gw, at1543);
    expect((await late.plan({ kind: 'cancel', ...facts(s, { tgt: null }) })).reason).toBe('inside_cancellation_window');
    expect((await late.plan({ kind: 'move', ...facts(s) })).reason).toBe('late_move_unverified');   // approved by the owner, not yet verified against Arbox
    expect(s.writes).toHaveLength(0);
    s.enabled.add('class_move_late');                                                  // after the controlled verification
    const pl = await late.plan({ kind: 'move', ...facts(s) });
    expect(pl).toMatchObject({ ok: true, late: true });
    expect(pl.steps.map(x => x.op)).toEqual(['class_book', 'class_cancel']);           // still: the new class first
    expect((await late.plan({ kind: 'cancel', ...facts(s, { tgt: null }) })).reason).toBe('inside_cancellation_window');   // the exception is for a move only
    expect((await actionsOn(gw).plan({ kind: 'move', ...facts(s) })).late).toBe(false);                                   // outside the window nothing is "late"
  });

  test('both classes must not have started', async () => {
    const { s, gw } = fakeArbox(); s.enabled.add('class_move_late');
    const after17 = actionsOn(gw, { now: () => ilDate(2026, 10, 18, 17, 5) });
    expect((await after17.plan({ kind: 'book', ...facts(s, { cur: null }) })).reason).toBe('target_started');
    expect((await after17.plan({ kind: 'move', ...facts(s) })).reason).toBe('target_started');
    s.classes.push(cls(103, '19:00'));
    const after18 = actionsOn(gw, { now: () => ilDate(2026, 10, 18, 18, 5) });
    expect((await after18.plan({ kind: 'move', ...facts(s, { tgt: '19:00' }) })).reason).toBe('current_started');
    expect((await actionsOn(gw).plan({ kind: 'move', ...facts(s, { tgt: '18:00' }) })).reason).toBe('same_class');     // "move me" to the class she is in
    expect(s.writes).toHaveLength(0);
  });

  test('who: only a phone on the test list, until the audience is opened to everyone', async () => {
    const { s, gw } = fakeArbox();
    const saved = { a: process.env.ARBOX_WRITE_AUDIENCE, p: process.env.ARBOX_WRITE_TEST_PHONES };
    try {
      delete process.env.ARBOX_WRITE_AUDIENCE; delete process.env.ARBOX_WRITE_TEST_PHONES;
      const real = createClassActions({ gateway: gw, logger: require('../utils/logger'), now: () => NOW, sleep: async () => {} });   // the shipped audience rule
      expect((await real.plan({ kind: 'move', phone: '972500000001', ...facts(s) })).reason).toBe('not_in_test_audience');           // nothing configured = nobody
      process.env.ARBOX_WRITE_TEST_PHONES = '972500000009, 0500000001';
      expect((await real.plan({ kind: 'move', phone: '972500000001', ...facts(s) })).reason).toBe('not_in_test_audience');           // an Israeli-format number is not a match by accident
      process.env.ARBOX_WRITE_TEST_PHONES = '972500000009,972500000001';
      expect((await real.plan({ kind: 'move', phone: '972500000001', ...facts(s) })).ok).toBe(true);
      expect((await real.plan({ kind: 'move', phone: '972500000002', ...facts(s) })).reason).toBe('not_in_test_audience');
      process.env.ARBOX_WRITE_AUDIENCE = 'all';
      expect((await real.plan({ kind: 'move', phone: '972500000002', ...facts(s) })).ok).toBe(true);
      expect(s.writes).toHaveLength(0);
    } finally {
      for (const [k, v] of [['ARBOX_WRITE_AUDIENCE', saved.a], ['ARBOX_WRITE_TEST_PHONES', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe('B. bookings and sessions are read before and after: no double charge passes as a success', () => {
  const run = async (over, kind = 'move') => { const { s, gw } = fakeArbox(over); const a = actionsOn(gw); const pl = await a.plan({ kind, ...facts(s, kind === 'book' ? { cur: null } : kind === 'cancel' ? { tgt: null } : {}) }); return { s, res: await a.execute(pl) }; };

  test('a move on a punch card: one session before, one session after', async () => {
    const { res } = await run({ sessions: 5 });
    expect(res.ok).toBe(true);
    expect(res.balance).toMatchObject({ check: 'ok', before: { count: 1, sessionsLeft: 5 }, after: { count: 1, sessionsLeft: 5 } });
  });
  test('Arbox kept the charge of the cancelled class: the move is verified, the balance is NOT, and that is reported', async () => {
    const { res } = await run({ sessions: 5, noRefund: true });
    expect(res.ok).toBe(true);
    expect(res.balance).toMatchObject({ check: 'mismatch', before: { sessionsLeft: 5 }, after: { sessionsLeft: 4 } });
    expect(res.balance.note).toMatch(/ירדה מ-5 ל-4/);
  });
  test('a booking may cost exactly one session; a cancellation none', async () => {
    const b = await run({ sessions: 5, bookings: [] }, 'book');
    expect(b.res.balance).toMatchObject({ check: 'ok', before: { count: 0, sessionsLeft: null }, after: { count: 1, sessionsLeft: 4 } });   // a first booking: nothing to compare with, the count is verified
    const c = await run({ sessions: 5 }, 'cancel');
    expect(c.res.balance).toMatchObject({ check: 'ok', after: { count: 0 } });
  });
  test('the same class booked twice is seen', async () => {
    const { res } = await run({ doubleBook: true, bookings: [] }, 'book');
    expect(res.balance.check).toBe('mismatch');
    expect(res.balance.note).toMatch(/רישום כפול/);
  });
  test('a period membership (Arbox reports no count): the number of bookings is what is checked', async () => {
    const { res } = await run();
    expect(res.balance).toMatchObject({ check: 'ok', before: { sessionsLeft: null }, after: { sessionsLeft: null, count: 1 } });
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
  function world(over, opts = {}) {
    const { s, gw } = fakeArbox(over);
    const tasks = [], sent = [], alerts = [];
    const clock = { t: NOW };
    let seq = 0;
    const tomerStore = {
      getTasks: ({ phone, type } = {}) => tasks.filter(t => (!phone || t.phone === phone) && (!type || t.type === type)),
      getOpenTasks: () => tasks.filter(t => t.status === 'open'),
      createTask: t => { const x = { id: `t${++seq}`, status: 'open', createdAt: clock.t.toISOString(), updatedAt: clock.t.toISOString(), ...t }; tasks.push(x); return x; },
      updateTask: (id, u) => Object.assign(tasks.find(t => t.id === id), u, { updatedAt: clock.t.toISOString() }),
      resolveTask: (id, r) => Object.assign(tasks.find(t => t.id === id), { status: 'resolved', ...r }),
      appendAudit: () => {},
    };
    const h = createMemberHandoff({ gateway: gw, tomerStore, logger: require('../utils/logger'), now: () => clock.t, classActions: actionsOn(gw, { now: () => clock.t, ...(opts.actions ?? {}) }),
      alertOwner: async (subject, body) => { alerts.push({ subject, body }); return { results: [{ phone: 'mgr', idMessage: `A${alerts.length}` }] }; },
      sendText: async (to, text) => { sent.push({ to, text }); return { idMessage: `M${sent.length}` }; } });
    const say = (text, extra = {}) => h.handleClassRequest({ phone: P, text, sentAt: clock.t, ...extra });
    return { s, h, tasks, sent, alerts, clock, say, last: () => sent[sent.length - 1]?.text ?? null };
  }
  const P = '972500000001';
  const ASK = 'אני רשומה מחר לפילאטיס ב-18:00 ורוצה לעבור ל-17:00';
  const minutes = (w, n) => { w.clock.t = new Date(w.clock.t.getTime() + n * 60000); };

  test('NOTHING is written on the request alone: the exact action is shown and a written "כן" is awaited', async () => {
    const w = world();
    const r = await w.say(ASK);
    expect(r.action).toMatchObject({ state: 'awaiting_member_confirmation' });
    expect(w.s.writes).toHaveLength(0);
    expect(w.sent[0].text).toBe('רק לוודא לפני שאני משנה ב-Arbox:\nמעבר מפילאטיס מכשירים ב-18:00 לפילאטיס מכשירים ב-17:00, ביום רביעי 18.11.\nלאשר? אפשר לענות "כן" ואבצע, או "לא" ולא אשנה דבר.');
    expect(w.tasks[0]).toMatchObject({ status: 'open', action: { state: 'awaiting_member_confirmation' }, pendingConfirm: { date: DAY, kind: 'move', current: { time: '18:00' }, target: { time: '17:00', scheduleId: 101 } } });
    expect(w.alerts).toHaveLength(0);                                       // nothing is waiting for the staff yet
  });

  test('"לא": nothing is sent to Arbox, the task is closed, and she is told her registration is as it was', async () => {
    const w = world();
    await w.say(ASK); await w.say('לא תודה');
    expect(w.s.writes).toHaveLength(0);
    expect(w.tasks[0]).toMatchObject({ status: 'resolved', pendingConfirm: null, action: { state: 'declined_by_member' } });
    expect(w.last()).toMatch(/לא שיניתי דבר/);
    expect(await w.say('כן')).toBeNull();                                   // a later "כן" confirms nothing
    expect(w.s.writes).toHaveLength(0);
  });

  test('a "כן" after 30 minutes does not act on old facts: Arbox is read again and the question is asked again', async () => {
    const w = world();
    await w.say(ASK); minutes(w, 45);
    const r = await w.say('כן');
    expect(r.action.state).toBe('awaiting_member_confirmation');
    expect(w.s.writes).toHaveLength(0);
    expect(w.last()).toMatch(/^עבר זמן מאז ששאלתי, אז בדקתי שוב ב-Arbox/);
    expect(w.tasks).toHaveLength(1);
    minutes(w, 1);
    expect((await w.say('כן')).action.state).toBe('done');                  // the fresh question, answered in time
    expect(w.s.bookings.map(b => b.time)).toEqual(['17:00']);
  });

  test('no answer: after 30 minutes the request goes to the staff once, with what was asked; the member is not messaged', async () => {
    const w = world();
    await w.say(ASK); minutes(w, 31);
    expect(await w.h.sweepConfirmations()).toBe(1);
    expect(await w.h.sweepConfirmations()).toBe(0);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].subject).toMatch(/לא אישר\/ה בכתב/);
    expect(w.alerts[0].body).toMatch(/לא בוצע שום שינוי ב-Arbox/);
    expect(w.sent).toHaveLength(1);
    expect(w.tasks[0]).toMatchObject({ status: 'open', action: { state: 'not_confirmed_by_member' }, alert: { state: 'sent' } });
    minutes(w, 6 * 60);
    await w.h.sweepConfirmations();
    expect(w.tasks[0].pendingConfirm).toBeNull();
    expect(await w.say('כן')).toBeNull();
    expect(w.s.writes).toHaveLength(0);
  });

  test('a new request before the answer replaces the old question; the old one can no longer be confirmed', async () => {
    const w = world();
    w.s.classes.push(cls(103, '19:00'));
    await w.say(ASK);
    await w.say('אני רשומה מחר לפילאטיס ב-18:00 ורוצה לעבור ל-19:00');
    expect(w.tasks.map(t => t.status)).toEqual(['resolved', 'open']);
    expect(w.tasks[0].action.state).toBe('replaced_by_new_request');
    await w.say('כן');
    expect(w.s.writes.map(x => x.args.scheduleId)).toEqual([103, 102]);     // 19:00 was booked, 18:00 released; 17:00 never touched
  });

  test('the class filled up between the question and the "כן": nothing is sent, the staff get the reason', async () => {
    const w = world();
    await w.say(ASK);
    w.s.classes[0].occupancy = { registered: 8, capacity: 8, standby: 0, spotsLeft: 0 };
    await w.say('כן');
    expect(w.s.writes).toHaveLength(0);
    expect(w.tasks).toHaveLength(1);
    expect(w.tasks[0]).toMatchObject({ status: 'open', pendingConfirm: null, action: { state: 'not_done_after_confirmation' }, alert: { state: 'sent' } });
    expect(w.last()).toMatch(/לא ביצעתי את זה בעצמי: השיעור המבוקש מלא/);
  });

  test('a phone outside the test audience: no question, no write - the staff task, as before', async () => {
    const w = world(undefined, { actions: { audience: () => false } });
    const r = await w.say(ASK);
    expect(r.action).toBeUndefined();
    expect(w.s.writes).toHaveLength(0);
    expect(w.alerts).toHaveLength(1);
    expect(w.last()).toMatch(/אין לי הרשאה לשנות רישום בעצמי, אז העברתי את הבקשה לצוות/);
    expect(w.tasks[0].detail).toMatch(/אין לתומר הרשאה לשנות רישום/);
  });

  test('a request that came from a voice transcript is asked about in writing, and a spoken "כן" confirms nothing', async () => {
    const w = world();
    const r = await w.say(ASK, { fromVoice: true });
    expect(r.action.state).toBe('awaiting_member_confirmation');
    expect(w.sent[0].text).toMatch(/^מהתמלול של ההודעה הקולית הבנתי את הבקשה כך:/);
    expect(w.tasks[0].pendingConfirm.fromVoice).toBe(true);
    expect(await w.say('כן', { fromVoice: true })).toBeNull();              // a transcript saying "כן"
    expect(w.s.writes).toHaveLength(0);
    expect((await w.say('כן')).action.state).toBe('done');                  // the written one
  });

  test('a late move, once the capability is on: asked, confirmed, booked first, verified', async () => {
    const w = world(); w.s.enabled.add('class_move_late');
    w.clock.t = ilDate(2026, 10, 18, 15, 43);                              // inside the 8-hour window of the 18:00 class
    const r = await w.say('אני רשומה היום לפילאטיס ב-18:00 ורוצה לעבור ל-17:00');
    expect(r.action.state).toBe('awaiting_member_confirmation');
    expect(w.sent[0].text).toMatch(/מעבר מפילאטיס מכשירים ב-18:00 לפילאטיס מכשירים ב-17:00, היום, יום רביעי 18\.11\./);
    expect(w.tasks[0].pendingConfirm.late).toBe(true);
    await w.say('מאשרת');
    expect(w.s.writes.map(x => x.op)).toEqual(['class_book', 'class_cancel']);
    expect(w.tasks[0]).toMatchObject({ status: 'resolved', action: { state: 'done', late: true } });
  });

  test('done, but the sessions dropped: she is told the move was made, the staff are asked to check the balance, the task stays open', async () => {
    const w = world({ sessions: 5, noRefund: true });
    await w.say(ASK); await w.say('כן');
    expect(w.last()).toMatch(/^בוצע ✅ עברת מ-18:00 ל-17:00/);
    expect(w.last()).toMatch(/ביקשתי מהצוות לוודא את יתרת הכניסות/);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].body).toMatch(/ירדה מ-5 ל-4/);
    expect(w.tasks[0]).toMatchObject({ status: 'open', priority: 'high', action: { state: 'done', balance: { check: 'mismatch' } } });
    expect(w.s.writes).toHaveLength(2);                                     // nothing further was sent
  });

  test('the "כן" is used once, for the action that was shown, and by the member it was shown to', async () => {
    const w = world();
    await w.say(ASK);
    await w.say('כן');
    const writes = w.s.writes.length, sent = w.sent.length;
    expect(await w.say('כן')).toBeNull();                                   // a second "כן" confirms nothing
    expect(w.s.writes).toHaveLength(writes);
    expect(w.sent).toHaveLength(sent);
    // another member's "כן" has no question to answer: nothing is written for her and nothing of the first member's is touched
    expect(await w.h.handleClassRequest({ phone: '972500000002', text: 'כן', sentAt: w.clock.t })).toBeNull();
    expect(w.s.writes).toHaveLength(writes);
    expect(w.tasks).toHaveLength(1);
  });

  test('a staff takeover between the question and the "כן": nothing is written, the request goes to the staff', async () => {
    const { s, gw } = fakeArbox();
    const tasks = [], sent = [], alerts = []; let seq = 0, owned = false;
    const tomerStore = {
      getTasks: ({ phone, type } = {}) => tasks.filter(t => (!phone || t.phone === phone) && (!type || t.type === type)),
      getOpenTasks: () => tasks.filter(t => t.status === 'open'),
      createTask: t => { const x = { id: `t${++seq}`, status: 'open', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...t }; tasks.push(x); return x; },
      updateTask: (id, u) => Object.assign(tasks.find(t => t.id === id), u, { updatedAt: NOW.toISOString() }),
      resolveTask: (id, r) => Object.assign(tasks.find(t => t.id === id), { status: 'resolved', ...r }),
      appendAudit: () => {},
    };
    const h = createMemberHandoff({ gateway: gw, tomerStore, logger: require('../utils/logger'), now: () => NOW, classActions: actionsOn(gw), canAutoReply: () => !owned,
      alertOwner: async (subject, body) => { alerts.push({ subject, body }); return { results: [{ phone: 'mgr', idMessage: `A${alerts.length}` }] }; },
      sendText: async (to, text) => { sent.push({ to, text }); return { idMessage: `M${sent.length}` }; } });
    await h.handleClassRequest({ phone: P, text: ASK, sentAt: NOW });
    owned = true;                                                           // the staff took the conversation over
    const r = await h.handleClassRequest({ phone: P, text: 'כן', sentAt: NOW });
    expect(s.writes).toHaveLength(0);
    expect(r.action?.state).not.toBe('done');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toMatch(/טיפול ידני/);
  });

  test('done and verified: the member is told it was done; the task is recorded as closed and nobody is alerted', async () => {
    const w = world();
    await w.say(ASK);
    const r = await w.say('כן');
    expect(r.action).toMatchObject({ state: 'done' });
    expect(w.s.bookings.map(b => b.time)).toEqual(['17:00']);
    expect(w.sent[1].text).toMatch(/^בוצע ✅ עברת מ-18:00 ל-17:00/);
    expect(w.sent[1].text).toMatch(/אימתתי את זה עכשיו מול Arbox/);
    expect(w.tasks).toHaveLength(1);
    expect(w.tasks[0]).toMatchObject({ status: 'resolved', resolvedBy: 'tomer', pendingConfirm: null, action: { state: 'done', balance: { check: 'ok' }, confirmedText: 'כן' } });
    expect(w.alerts).toHaveLength(0);
  });

  test('refused by a rule: nothing is sent to Arbox, the staff get the exact reason, the member keeps her place and is told so', async () => {
    const w = world();
    w.s.classes[0].occupancy = { registered: 8, capacity: 8, standby: 1, spotsLeft: 0 };
    await w.say(ASK);
    expect(w.s.writes).toHaveLength(0);
    expect(w.tasks[0]).toMatchObject({ status: 'open' });
    expect(w.tasks[0].detail).toMatch(/לא בוצע אוטומטית: השיעור המבוקש מלא/);
    expect(w.alerts).toHaveLength(1);
    expect(w.sent[0].text).toMatch(/לא ביצעתי את זה בעצמי: השיעור המבוקש מלא/);
    expect(w.sent[0].text).toMatch(/הרישום הקיים שלך לא השתנה/);
  });

  test('the booking fails: she is told it was NOT done and that her registration is unchanged; the staff are alerted', async () => {
    const w = world({ fail: { class_book: 'rejected' } });
    await w.say(ASK); await w.say('כן');
    expect(w.s.bookings.map(b => b.time)).toEqual(['18:00']);
    expect(w.sent[1].text).toMatch(/ניסיתי לבצע את זה ב-Arbox ולא הצלחתי/);
    expect(w.sent[1].text).toMatch(/הרישום הקיים שלך לא השתנה/);
    expect(w.sent[1].text).not.toMatch(/בוצע ✅/);
    expect(w.s.writes).toHaveLength(1);                                     // the refused request was not repeated
    expect(w.alerts[0].body).toMatch(/לא בוצע שום שינוי ב-Arbox/);
    expect(w.tasks[0]).toMatchObject({ status: 'open', priority: 'high', action: { state: 'nothing_changed' } });
  });

  test('booked but the old class could not be cancelled: she is told she holds both, and the staff are asked to cancel one', async () => {
    const w = world({ fail: { class_cancel: 'rejected' } });
    await w.say(ASK); await w.say('כן');
    expect(w.sent[1].text).toMatch(/רשמתי אותך לפילאטיס מכשירים ב-17:00/);
    expect(w.sent[1].text).toMatch(/כרגע יש לך רישום לשני השיעורים/);
    expect(w.s.writes.map(x => x.op)).toEqual(['class_book', 'class_cancel']);   // stopped: no second cancel, no undo of the booking
    expect(w.alerts[0].body).toMatch(/הרישום החדש בוצע ב-Arbox; הרישום הקודם לא בוטל — נדרש ביטול ידני/);
  });

  test('an unknown outcome is never reported as done', async () => {
    const w = world({ fail: { class_book: 'accepted_not_applied' } });
    await w.say(ASK); await w.say('כן');
    expect(w.sent[1].text).toMatch(/לא הצלחתי לאמת שהיא בוצעה, ולכן אני לא אומר לך שזה נעשה/);
    expect(w.s.writes).toHaveLength(1);
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
    // since 2026-11-18 booking and cancelling a class are verified against Arbox (owner's test member); being verified is
    // still not enough: the operation must be named, and the switch must be on
    expect(g.writeStatus().class_cancel).toMatchObject({ contractVerified: true, needsAllowList: true, namedInAllowList: false, executable: false });
    expect(g.writeStatus().class_move_late).toMatchObject({ contractVerified: true, executable: false });      // verified on 2026-11-18 18:44; still off unless named
    delete process.env.ARBOX_TEST_ASSUME_CONTRACT; process.env.ARBOX_WRITE_OPS = 'class_book,class_cancel,class_move_late,membership_hold,membership_cancel'; g = fresh();
    expect(['class_book', 'class_cancel', 'class_move_late', 'membership_hold', 'membership_cancel'].map(op => g.writesEnabled(op))).toEqual([true, true, true, false, false]);   // naming an unverified operation (freeze, membership cancel) does not open it
    delete process.env.ARBOX_WRITES_ENABLED; g = fresh();
    expect(g.writesEnabled('class_book')).toBe(false);                     // verified and named, switch off → off
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
