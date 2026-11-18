'use strict';
/**
 * owner_tasks.test.js — the owner's open tasks from Barak and Tomer, his explicit confirmation, and the ONE reminder
 * message to him (services/owner_tasks.js).
 *
 * Owner rules, 2026-11-18: an alert, an opened case or a read message does not complete a task; a task closes only on
 * the owner's "בוצע" or on a verified close in the system that owns it; "בטיפול" / "דחה למועד" / "בוטל" / reopen with
 * history; reminders respect the due time, a snooze and the quiet hours, are consolidated, never duplicated and never
 * a burst; a failed send stays visible and is retried in a controlled way; nothing is ever sent to a customer.
 * All data is invented; the only "send" is a stand-in that records what the manager would receive.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const MANAGER = '972509000001';
const il = (d, h, m = 0) => new Date(Date.UTC(2026, 10, d, h - 2, m));          // November 2026, Israel = UTC+2

function world({ quiet = () => false } = {}) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-ot-'));
  jest.resetModules();
  const w = { now: il(18, 8, 0), sent: [], fail: null, closed: [],
    cases: [{ id: 'case-1', phone: '972587000001', memberName: 'מתאמנת א', category: 'membership_freeze', status: 'awaiting_staff', createdAt: il(12, 9).toISOString() }],
    tasks: [{ id: 'task-1', phone: '972587000002', memberName: 'מתאמנת ב', type: 'cancel_request', title: 'בקשת ביטול', status: 'open', createdAt: il(16, 15).toISOString() }],
    apts: [{ id: 'apt-1', leadPhone: '972587000003', leadName: 'ליד ג', status: 'callback_pending', scheduledAt: il(18, 14), windowEndAt: il(18, 16).toISOString(), createdAt: il(18, 7) }] };
  w.ot = require('../services/owner_tasks').createOwnerTasks({
    now: () => w.now, isQuietHours: () => quiet(w.now), managerPhone: () => MANAGER, baseUrl: () => 'https://panel.example.test',
    cases: { list: () => w.cases.filter(c => c.status !== 'resolved') }, tomerStore: { getOpenTasks: () => w.tasks.filter(t => t.status === 'open') },
    aptStore: { getAll: () => w.apts, ACTIVE_STATUSES: new Set(['callback_pending', 'confirmed']) },
    caseLabel: () => 'בקשת הקפאת מנוי',
    sendManager: async (phone, text) => { if (w.fail) throw new Error(w.fail); w.sent.push({ phone, text }); return { idMessage: `M${w.sent.length}` }; },
    closeSource: async (key, action) => { w.closed.push([key, action]); return { ok: true }; },
  });
  return w;
}
const open = w => w.ot.list().open;
const at = (w, d, h, m = 0) => { w.now = il(d, h, m); };

describe('what counts as open, and what closes a task', () => {
  test('the three sources appear as tasks with how long they have waited; nothing is closed by being listed or read', () => {
    const w = world();
    const l = w.ot.list(); w.ot.list(); w.ot.list();                             // reading the list any number of times
    expect(l.open.map(t => t.key).sort()).toEqual(['apt:apt-1', 'case:case-1', 'task:task-1']);
    expect(l.open.find(t => t.key === 'case:case-1')).toMatchObject({ agent: 'tomer', title: 'בקשת הקפאת מנוי', who: 'מתאמנת א', state: 'open', waiting: '5 ימים', lastReminderAt: null });
    expect(l.open.find(t => t.key === 'apt:apt-1')).toMatchObject({ agent: 'barak', notYetDue: true });
    expect(open(w)).toHaveLength(3);
    expect(w.sent).toHaveLength(0);
  });

  test('"בוצע" closes the task, records who and when, and closes it where it lives; reopening brings it back with its history', async () => {
    const w = world();
    const r = await w.ot.act('task:task-1', 'done', { by: 'עדן', note: 'טופל ב-Arbox' });
    expect(r).toMatchObject({ ok: true, task: { state: 'done', closedBy: 'owner' } });
    expect(w.closed).toEqual([['task:task-1', 'done']]);
    expect(open(w).map(t => t.key)).not.toContain('task:task-1');
    const again = await w.ot.act('task:task-1', 'reopen', { by: 'עדן' });
    expect(again.task.state).toBe('open');
    expect(again.task.history.map(h => h.action)).toEqual(['done', 'reopen']);
    expect(again.task.history[0]).toMatchObject({ by: 'עדן', note: 'טופל ב-Arbox', source: 'נסגר גם במקור' });
  });

  test('a verified close at the source closes the task; a source that reopens it brings it back', () => {
    const w = world();
    w.ot.list();
    w.cases[0].status = 'resolved';                                              // the case was resolved in Tomer's panel
    const l = w.ot.list({ includeClosed: true });
    expect(l.open.map(t => t.key)).not.toContain('case:case-1');
    expect(l.closed.find(t => t.key === 'case:case-1')).toMatchObject({ state: 'done', closedBy: 'source' });
    w.cases[0].status = 'in_progress';                                           // reopened there
    expect(open(w).map(t => t.key)).toContain('case:case-1');
  });

  test('"בטיפול" keeps it open; "דחה למועד" needs a future time; "בוטל" closes it; an unknown action or task is refused', async () => {
    const w = world();
    expect((await w.ot.act('case:case-1', 'in_progress', { by: 'עדן' })).task.state).toBe('in_progress');
    expect(open(w).map(t => t.key)).toContain('case:case-1');
    expect(await w.ot.act('case:case-1', 'snooze', { until: il(17, 9).toISOString() })).toMatchObject({ ok: false, error: 'snooze_needs_future_time' });
    expect((await w.ot.act('case:case-1', 'snooze', { until: il(20, 9).toISOString() })).task).toMatchObject({ state: 'snoozed' });
    expect((await w.ot.act('task:task-1', 'cancel', { by: 'עדן', note: 'כפילות' })).task.state).toBe('cancelled');
    expect(await w.ot.act('task:task-1', 'delete')).toMatchObject({ ok: false, error: 'bad_action' });
    expect(await w.ot.act('task:nope', 'done')).toMatchObject({ ok: false, error: 'not_found' });
  });

  test('a source that cannot be read does not close anything', () => {
    const w = world();
    w.ot.list();
    w.ot = Object.assign(w.ot);                                                  // same instance
    const realList = w.cases; w.casesBroken = true;
    const broken = require('../services/owner_tasks').createOwnerTasks({ now: () => w.now, managerPhone: () => MANAGER, sendManager: async () => ({}),
      cases: { list: () => { throw new Error('disk'); } }, tomerStore: { getOpenTasks: () => w.tasks }, aptStore: { getAll: () => w.apts, ACTIVE_STATUSES: new Set(['callback_pending']) } });
    const l = broken.list();
    expect(l.sourceError).toMatch(/cases: disk/);
    expect(l.open.map(t => t.key)).toContain('case:case-1');                      // still open: "not read" is not "closed"
    expect(realList).toHaveLength(1);
  });
});

describe('reminders to the owner', () => {
  test('no times set → nothing is sent, and the status says what is missing', async () => {
    const w = world();
    at(w, 18, 9, 0);
    expect(await w.ot.tick()).toMatchObject({ sent: false, reason: 'off' });
    expect(w.ot.status()).toMatchObject({ state: 'needs_settings' });
    expect(w.ot.setSettings({ enabled: true })).toMatchObject({ ok: false, error: 'times_required' });
    expect(w.sent).toHaveLength(0);
  });

  test('old tasks do not burst: ONE consolidated message at the configured time, only for tasks whose time has come', async () => {
    const w = world();
    expect(w.ot.preview().count).toBe(2);                                        // the callback of 14:00–16:00 is not due yet
    w.ot.setSettings({ enabled: true, times: ['09:00', '17:00'] });
    at(w, 18, 8, 50); expect((await w.ot.tick()).reason).toBe('not_a_send_time');
    at(w, 18, 9, 3);
    expect(await w.ot.tick()).toMatchObject({ sent: true, count: 2 });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].phone).toBe(MANAGER);
    expect(w.sent[0].text).toMatch(/2 משימות מחכות לאישור ביצוע/);
    expect(w.sent[0].text).toMatch(/תומר · פנייה: בקשת הקפאת מנוי — מתאמנת א · ממתין 6 ימים/);
    expect(w.sent[0].text).not.toMatch(/ליד ג/);
    expect(w.sent[0].text).not.toMatch(/9725\d{8}/);                             // no phone number of a customer
    // the same slot again, and five minutes later: nothing more
    expect((await w.ot.tick()).reason).toBe('slot_done');
    at(w, 18, 9, 10); expect((await w.ot.tick()).reason).toBe('slot_done');
    expect(w.sent).toHaveLength(1);
    expect(open(w).find(t => t.key === 'case:case-1')).toMatchObject({ reminderCount: 1 });
    expect(open(w).find(t => t.key === 'case:case-1').lastReminderAt).toBe(il(18, 9, 3).toISOString());
  });

  test('the same task is not mentioned again before the gap; the callback joins once its time has passed', async () => {
    const w = world();
    w.ot.setSettings({ enabled: true, times: ['09:00', '17:00'], minGapHours: 20 });
    at(w, 18, 9, 0); await w.ot.tick();
    at(w, 18, 17, 0);
    expect(await w.ot.tick()).toMatchObject({ sent: true, count: 1 });           // only the callback whose window ended at 16:00
    expect(w.sent[1].text).toMatch(/ברק · שיחה חוזרת: לחזור לליד בטלפון — ליד ג/);
    expect(w.sent[1].text).not.toMatch(/מתאמנת א/);
    at(w, 19, 9, 0);
    expect(await w.ot.tick()).toMatchObject({ sent: true, count: 2 });           // 24 h later: the two older ones again; the callback (16 h ago) not yet
    expect(w.sent).toHaveLength(3);
  });

  test('"בוצע" stops the reminders; a snooze is respected and ends on time; "בטיפול" is still reminded and marked', async () => {
    const w = world();
    w.ot.setSettings({ enabled: true, times: ['09:00'] });
    await w.ot.act('task:task-1', 'done', { by: 'עדן' });
    await w.ot.act('case:case-1', 'snooze', { by: 'עדן', until: il(19, 12).toISOString() });
    at(w, 18, 9, 0);
    expect(await w.ot.tick()).toMatchObject({ sent: false, reason: 'nothing_due' });
    expect(w.sent).toHaveLength(0);
    at(w, 19, 9, 0);
    expect((await w.ot.tick()).count).toBe(1);                                   // only the callback; the snoozed case is still asleep
    expect(w.sent[0].text).not.toMatch(/מתאמנת א|מתאמנת ב/);
    await w.ot.act('case:case-1', 'in_progress', { by: 'עדן' });
    at(w, 20, 9, 0);
    await w.ot.tick();
    expect(w.sent[1].text).toMatch(/מתאמנת א.*בטיפול/);
    expect(w.sent[1].text).not.toMatch(/מתאמנת ב/);
  });

  test('quiet hours and the weekly rest day: nothing is sent', async () => {
    const w = world({ quiet: t => { const h = (t.getUTCHours() + 2) % 24; return h >= 22 || h < 8; } });
    w.ot.setSettings({ enabled: true, times: ['07:00', '09:00'] });
    at(w, 18, 7, 0); expect((await w.ot.tick()).reason).toBe('quiet_hours');
    at(w, 21, 9, 0); expect((await w.ot.tick()).reason).toBe('not_today');       // 21.11.2026 is a Saturday
    expect(w.sent).toHaveLength(0);
  });

  test('a failed send stays visible, is retried inside the same slot, and stops after three attempts', async () => {
    const w = world();
    w.ot.setSettings({ enabled: true, times: ['09:00'] });
    w.fail = 'Request failed with status code 500';
    at(w, 18, 9, 0);  expect(await w.ot.tick()).toMatchObject({ sent: false, error: 'Request failed with status code 500' });
    expect(w.ot.status()).toMatchObject({ state: 'failed' });
    expect(w.ot.status().text).toMatch(/ניסיון 1 מתוך 3/);
    expect(open(w).find(t => t.key === 'case:case-1').lastReminderAt).toBeNull();   // not counted as reminded
    at(w, 18, 9, 5);  await w.ot.tick();
    at(w, 18, 9, 10); await w.ot.tick();
    at(w, 18, 9, 15); expect((await w.ot.tick()).reason).toBe('attempts_exhausted');
    w.fail = null;
    at(w, 19, 9, 0);  expect((await w.ot.tick()).sent).toBe(true);
    expect(w.sent).toHaveLength(1);
    expect(w.ot.status().state).toBe('on');
  });

  test('the state survives a restart: no second message for a slot that was already sent', async () => {
    const w = world();
    w.ot.setSettings({ enabled: true, times: ['09:00'] });
    at(w, 18, 9, 0); await w.ot.tick();
    w.ot._reset();                                                               // restart: read again from disk
    at(w, 18, 9, 6);
    expect((await w.ot.tick()).reason).toBe('slot_done');
    expect(w.ot.list().settings).toMatchObject({ enabled: true, times: ['09:00'] });
    expect(w.sent).toHaveLength(1);
  });
});

test('a task is titled in Hebrew, never by its internal type code', () => {
  const w = world();
  w.tasks = [{ id: 't1', type: 'freeze_request', phone: '972587000004', status: 'open', createdAt: il(17, 8).toISOString() }, { id: 't2', type: 'something_new', phone: '972587000005', status: 'open', createdAt: il(17, 8).toISOString() }];
  const titles = open(w).map(t => t.title);
  expect(titles).toEqual(expect.arrayContaining(['בקשת הקפאת מנוי', 'משימה לצוות']));
  expect(titles.join(' ')).not.toMatch(/[a-z]_[a-z]/);
});
