'use strict';
/**
 * studio_knowledge.test.js — instructors and class types: restored from history, verified against the live Arbox
 * schedule, confirmed by the owner; and the live check of free places in ONE class.
 *
 * Production, 2026-11-09 → 2026-11-18: data/ was excluded from the upload, the knowledge files stopped reaching the
 * server, the agents ran with empty lists and the panel said "הסוכן עודכן בהצלחה" over failing checks.
 * Real barak_agent on a temporary DATA_DIR; Arbox is a stand-in object. All names are invented.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const NOW = new Date('2026-11-18T07:00:00Z');
const cls = (date, start, name, instructor, registered, capacity = 10, standby = 0) => ({ scheduleId: `${date}${start}${name}`, date, start, end: start, name, instructor, capacity,
  status: 'active', occupancy: registered === null ? null : { registered, capacity, standby, spotsLeft: Math.max(0, capacity - registered) } });
const LIVE = [cls('2026-11-19', '09:00', 'פילאטיס מכשירים פאוור', 'מלאני מנדוזה', 7, 8), cls('2026-11-19', '18:00', 'אימון כח', 'עדן גולדנברג', 10, 10, 2),
  cls('2026-11-19', '19:00', 'פילאטיס בר', 'ליז שטיין', 3), cls('2026-11-20', '08:00', 'KANGO JUMP', 'נוי היינה', 0), cls('2026-11-20', '10:00', 'יוגה', 'רעיה כהן', null)];

function world({ down = false, occupancy = true, stale = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-kn-'));
  process.env.DATA_DIR = dir;
  jest.resetModules();
  const barakAgent = require('../agents/barak_agent');
  const pricing = require('../utils/pricing');
  const mode = { down, occupancy, stale, calls: [] };
  const gateway = { getClasses: jest.fn(async (q) => { mode.calls.push(q); if (mode.down) throw new Error('ECONNABORTED');
    return { classes: LIVE, occupancyAvailable: mode.occupancy, fetchedAt: NOW.getTime(), stale: mode.stale, source: '/v3/schedule + report' }; }) };
  const kn = require('../services/studio_knowledge').createStudioKnowledge({ gateway, barakAgent, pricing, now: () => NOW });
  return { dir, barakAgent, kn, mode, gateway };
}
const row = (sm, id) => sm.rows.find(r => r.id === id);

describe('what disappeared, and its controlled restore', () => {
  test('nothing saved: the summary says so for each list — it is not "success"', async () => {
    const { kn } = world();
    await kn.refreshLive();
    const sm = kn.summary();
    expect(sm.state).toBe('partial');
    expect(row(sm, 'staff')).toMatchObject({ state: 'empty' });
    expect(row(sm, 'staff').action).toMatch(/לשחזר/);
    expect(row(sm, 'classes').state).toBe('empty');
    expect(row(sm, 'prices').text).toMatch(/אין מה לשחזר/);
    expect(row(sm, 'arbox')).toMatchObject({ state: 'ok' });
  });

  test('restore → waiting for the owner: only what the live Arbox schedule supports is given to the agents', async () => {
    const { kn, barakAgent, dir } = world();
    await kn.refreshLive();
    expect(kn.restoreHistoric('staff')).toMatchObject({ ok: true, restored: 14 });
    expect(kn.restoreHistoric('classes')).toMatchObject({ ok: true, restored: 7 });
    const st = kn.status();
    expect(st.staff).toMatchObject({ saved: 14, pendingApproval: true, verified: 5, givenToAgents: 5 });
    expect(st.staff.notInArbox).toContain('שיר פינקלשטיין');
    expect(st.staff.restored).toMatchObject({ confirmed: false });
    expect(st.staff.file.exists).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'staff_directory.json'), 'utf8'))._restored.from).toMatch(/6–7\.11\.2026/);
    // the agent's context holds the verified names only
    expect(barakAgent.getStaffContext()).toContain('מלאני מנדוזה');
    expect(barakAgent.getStaffContext()).not.toContain('שיר פינקלשטיין');
    // class types: found in Arbox under its own names; capacity comes from Arbox while the list is unconfirmed
    const c = st.classes.rows.find(r => r.name === 'Pilates Barre');
    expect(c).toMatchObject({ verified: true, arboxNames: ['פילאטיס בר'] });
    expect(st.classes.rows.find(r => r.name === 'Kangoo Jumps').verified).toBe(true);
    expect(st.classes.rows.find(r => r.name === 'Concept Toning').verified).toBe(false);          // not in the stand-in schedule
    expect(barakAgent.getClassesContext()).toMatch(/פילאטיס מכשירים.*8 משתתפים מקסימום/);
    const sm = kn.summary();
    expect(row(sm, 'staff')).toMatchObject({ state: 'partial' });
    expect(row(sm, 'staff').text).toMatch(/טרם אושרו/);
    expect(row(sm, 'staff').action).toMatch(/אישור הרשימה/);
    expect(kn.facts().join('\n')).toContain('מלאני מנדוזה');
    expect(kn.facts().join('\n')).not.toContain('שיר פינקלשטיין');
  });

  test('the owner confirms: the whole list is current truth; a second restore changes nothing', async () => {
    const { kn, barakAgent } = world();
    await kn.refreshLive();
    kn.restoreHistoric('staff');
    expect(kn.restoreHistoric('staff')).toMatchObject({ ok: true, unchanged: true });
    expect(kn.confirm('staff', { by: 'עדן' })).toEqual({ ok: true });
    expect(kn.status().staff).toMatchObject({ pendingApproval: false, givenToAgents: 14 });
    expect(kn.status().staff.restored).toMatchObject({ confirmed: true, confirmedBy: 'עדן' });
    expect(barakAgent.getStaffContext()).toContain('שיר פינקלשטיין');
    expect(row(kn.summary(), 'staff').state).toBe('ok');
  });

  test('newer information is never overwritten by a restore', async () => {
    const { kn, barakAgent } = world();
    barakAgent.reloadKnowledge({ staffData: { instructors: [{ name_he: 'מדריכה חדשה', specialties: [] }] } });
    expect(kn.restoreHistoric('staff')).toMatchObject({ ok: false, error: 'newer_information_exists', saved: 1 });
    expect(barakAgent.getRawKnowledge().staff.instructors).toHaveLength(1);
    expect(kn.status().staff.pendingApproval).toBe(false);                                          // the owner's own list needs no approval
  });

  test('Arbox unreadable: a restored, unconfirmed list is not given to the agents, and the summary says it cannot verify', async () => {
    const { kn, barakAgent } = world({ down: true });
    await kn.refreshLive();
    kn.restoreHistoric('staff');
    expect(kn.status().staff).toMatchObject({ saved: 14, givenToAgents: 0, verified: 0 });
    expect(barakAgent.getStaffContext()).not.toContain('מלאני מנדוזה');
    expect(row(kn.summary(), 'staff').text).toMatch(/לא ניתן לאמת כרגע מול Arbox/);
    expect(row(kn.summary(), 'arbox').state).toBe('unknown');
  });

  test('saving one section does not touch the others, and everything is read back after a restart', async () => {
    const { kn, barakAgent, dir } = world();
    await kn.refreshLive();
    kn.restoreHistoric('staff'); kn.restoreHistoric('classes');
    const classesBefore = fs.readFileSync(path.join(dir, 'classes_knowledge.json'), 'utf8');
    barakAgent.reloadKnowledge({ staffData: { instructors: [{ name_he: 'מלאני מנדוזה', specialties: ['רפורמר'] }] } });       // the staff tab is saved
    expect(fs.readFileSync(path.join(dir, 'classes_knowledge.json'), 'utf8')).toBe(classesBefore);
    barakAgent.reloadKnowledge({ pkgData: { trial: null, packages: [{ id: 'p', name: 'x', price_ils: 400 }] } });              // the prices tab is saved
    expect(fs.readFileSync(path.join(dir, 'classes_knowledge.json'), 'utf8')).toBe(classesBefore);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'staff_directory.json'), 'utf8')).instructors).toHaveLength(1);
    jest.resetModules();                                                                              // restart
    const again = require('../agents/barak_agent').getRawKnowledge();
    expect(again.staff.instructors).toHaveLength(1);
    expect(again.classes.classes).toHaveLength(7);
    expect(again.packages.packages[0].price_ils).toBe(400);
  });
});

describe('free places in one class: read from Arbox at the moment of the question', () => {
  const on = (date, start) => ({ pick: classes => ({ classes: classes.filter(c => c.date === date && c.start === start) }) });
  test('a class with room, a full class with a waiting list — the numbers are the live ones, and the read is fresh', async () => {
    const { kn, mode } = world();
    const a = await kn.availability(on('2026-11-19', '09:00'));
    expect(a).toMatchObject({ status: 'found' });
    expect(a.classes[0].occupancy).toMatchObject({ registered: 7, capacity: 8, spotsLeft: 1 });
    expect(mode.calls.at(-1).fresh).toBe(true);
    const b = await kn.availability(on('2026-11-19', '18:00'));
    expect(b.classes[0].occupancy).toMatchObject({ spotsLeft: 0, standby: 2 });
  });
  test('a missing detail is asked for; no such class is "none"', async () => {
    const { kn } = world();
    expect(await kn.availability({ pick: () => ({ missing: ['שעה'], options: LIVE.slice(0, 2) }) })).toMatchObject({ status: 'ask', missing: ['שעה'] });
    expect(await kn.availability(on('2026-11-19', '07:00'))).toEqual({ status: 'none' });
  });
  test('Arbox down, an old copy, or no occupancy data → "unavailable": never full, free or zero', async () => {
    for (const w of [world({ down: true }), world({ stale: true }), world({ occupancy: false })]) {
      const r = await w.kn.availability(on('2026-11-19', '09:00'));
      expect(r.status).toBe('unavailable');
    }
    const { kn } = world();
    expect(await kn.availability(on('2026-11-20', '10:00'))).toMatchObject({ status: 'unavailable', reason: 'no_occupancy_data' });   // this one class has no occupancy row
  });
});
