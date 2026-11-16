'use strict';
/**
 * Dana — round 4 on the server: a target per output (reel / story / both from one source), a skill from a brief together
 * with example videos, a targeted upgrade of a skill from a reference, combining skills, and what a package shows of the
 * final review and the timeline. Isolated temp DATA_DIR; the worker is simulated.
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const TOKEN = 'test-worker-token-0123456789abcdef', S = '/api/dana/studio';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const W = r => r.set('Authorization', `Bearer ${TOKEN}`);
let app, studio;
beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-r4-'));
  process.env.DANA_WORKER_TOKEN = TOKEN;
  delete process.env.DANA_PUBLISHING_ENABLED; delete process.env.DANA_NOTIFY_REAL; delete process.env.DANA_PUBLISHER_MODE;
  jest.resetModules();
  studio = require('../services/dana_studio');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express(); app.use('/api/dana/worker', workerRouter); app.use(S, panelRouter);
  studio.reconcileOnStartup();
});
const post = (p, body) => request(app).post(S + p).send(body);
const put = (p, body) => request(app).put(S + p).send(body);
const patch = (p, body) => request(app).patch(S + p).send(body);
const get = async id => (await request(app).get(`${S}/projects/${id}`)).body.project;
const skill = async id => (await request(app).get(`${S}/skills/${id}`)).body.skill;
const lease = async () => (await W(request(app).post('/api/dana/worker/lease')).send({ workerId: 'w1', pipelineVersion: '1.3.0' })).body;
const skLease = async () => (await W(request(app).post('/api/dana/worker/skills/lease')).send({ workerId: 'w1' }));
const skDraft = (id, l, draft) => W(request(app).post(`/api/dana/worker/skills/${id}/draft`)).set('X-Lease-Token', l.leaseToken).send({ status: 'drafted', draft });
const finishAll = () => { for (const j of Object.values(studio.state().jobs)) if (['queued', 'leased'].includes(j.status)) j.status = 'succeeded'; };

const analysis = (size, lines) => ({ summary: 'פתיחה ישירה וכתוביות גדולות', fits_us: ['עדויות'], coverage: { not_done: ['לא הוקשב לסאונד'] }, measured: { duration_s: 30 },
  aspects: [{ aspect: 'opening', observation: 'נפתח על המשפט המרכזי', rule: 'לפתוח על המשפט החזק ביותר', basis: 'model_assessment', example_times_s: [0.4] },
            { aspect: 'captions', observation: 'כתוביות גדולות במרכז, שורה אחת', rule: 'כתובית אחת בשורה אחת במרכז', basis: 'seen_in_stills', example_times_s: [2.1, 9] },
            { aspect: 'motion_graphics', observation: 'כותרת מונפשת בפתיחה', rule: 'כותרת פתיחה מונפשת', basis: 'seen_in_stills', example_times_s: [0.2] }],
  proposed_profile: { params: { caption_size: size, caption_max_lines: lines }, rules: [] } });
async function upRef(title) {
  return (await request(app).post(`${S}/references`).field('title', title).field('by', 'עדן').field('owner_note', 'אהבתי').attach('file', crypto.randomBytes(2000), 'r.mp4')).body.reference.id;
}
async function analyse(a) {
  const l = (await W(request(app).post('/api/dana/worker/references/lease')).send({ workerId: 'w1' })).body;
  await W(request(app).post(`/api/dana/worker/references/${l.reference.id}/analysis`)).set('X-Lease-Token', l.leaseToken).send({ status: 'analysed', analysis: a });
}
async function reference(title = 'רפרנס א', size = 110, lines = 1) { const id = await upRef(title); await analyse(analysis(size, lines)); return id; }
const pick = (ref, ...aspects) => ({ aspects: aspects.map(aspect => ({ ref, aspect })), params: { caption_size: ref } });
async function approved(name, aspects, { size = 110, make_default = false } = {}) {
  const ref = await reference(name + ' ref', size);
  const k = (await post('/skills/from-analysis', { by: 'עדן', name, ids: [ref], picks: pick(ref, ...aspects) })).body.skill;
  return (await post(`/skills/${k.id}/approve`, { by: 'עדן', make_default })).body.skill;
}
function pkgFor(s, extra = {}) {
  return { pipeline_version: '1.3.0', status: 'success', source: { sha256: s, duration: 30 }, segment: { in_s: 0, out_s: 20 }, duration: 20, adapter: 'claude', judgement_mode: 'model',
    style: { caption_size: 96 }, spoken_text: 'שלום', plan: { message: 'מ', content_judgement: 'model', segments: [{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20 }] },
    cards: [{ i: 1, text: 'שלום לכולם', highlight: [], start: 0, dur: 1.2, source_start_s: 3, source_end_s: 4.2 }], zooms: [], cover: { text: 'שלום', frame_s: 1 }, caption: { text: 'טיוטה', cta: null },
    checks: [], failed_checks: [], issues: [], rules_used: { skill: { name: 'dana-editing', version: '0.1.0' }, profile: { id: 'center-bold-v1', version: '2', status: 'unapproved' }, references: [] }, timings_s: {}, total_s: 10, ...extra };
}
async function finish(l, s, pkg, more = {}) {
  const files = { 'final.mp4': crypto.randomBytes(3000), 'cover.jpg': crypto.randomBytes(500), 'package.json': Buffer.from(JSON.stringify(pkg ?? pkgFor(s))), 'checks.json': Buffer.from('{"records":[]}'),
    'captions.json': Buffer.from('[]'), ...more };
  for (const [name, buf] of Object.entries(files))
    expect((await W(request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken).set('X-Content-SHA256', sha(buf)).set('Content-Type', 'application/octet-stream').send(buf)).status).toBe(200);
  return W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
}
const upload = (options, buf = Buffer.concat([Buffer.from('src-'), crypto.randomBytes(4096)])) =>
  request(app).post(`${S}/upload`).field('options', JSON.stringify(options)).attach('video', buf, `c-${crypto.randomBytes(3).toString('hex')}.mp4`);

describe('the target: reel, story, or both from one source', () => {
  test('"שתי גרסאות" makes two separate outputs of one source, each with its own job, versions and review; the target travels to the worker', async () => {
    expect((await upload({ target: 'tiktok' })).body.error).toBe('target_invalid');
    const up = await upload({ target: 'both' });
    const all = Object.values(studio.state().projects);
    expect(all.map(p => p.target).sort()).toEqual(['reel', 'story']);
    expect(new Set(all.map(p => p.source.sha256)).size).toBe(1);
    expect(new Set(all.map(p => p.groupId)).size).toBe(1);
    const reel = await lease();                                         // one job at a time: the reel was queued first
    expect(reel.job.options.target).toBe('reel');
    expect((await get(reel.job.projectId)).status).toBe('editing');
    await finish(reel, up.body.project.source.sha256);
    const story = await lease();
    expect(story.job.options.target).toBe('story');
    expect(story.job.projectId).not.toBe(reel.job.projectId);
    const part = crypto.randomBytes(900);
    await finish(story, up.body.project.source.sha256, pkgFor(up.body.project.source.sha256, { target: { key: 'story', label: 'סטורי', publish: 'לא נבדק' }, outputs: { 1: { seconds: 9 }, 2: { seconds: 8 } } }),
      { 'story_part_1.mp4': part, 'story_part_2.mp4': crypto.randomBytes(800) });
    const sp = await get(story.job.projectId), rp = await get(reel.job.projectId);
    expect(sp).toMatchObject({ target: 'story', targetLabel: 'סטורי', siblings: [{ id: rp.id, target: 'reel', targetLabel: 'ריל' }] });
    expect(sp.version.storyParts).toEqual(['story_part_1.mp4', 'story_part_2.mp4']);
    expect(sp.version.package.target).toMatchObject({ key: 'story' });
    expect(sp.status).not.toBe('approved');
    expect(rp.version.storyParts).toEqual([]);                          // the reel is its own output, with its own version and files
    expect(rp.version.package.target).toBeNull();
    const got = await request(app).get(`${S}/projects/${sp.id}/versions/1/story-part-1`).buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(sha(got.body)).toBe(sha(part));
    expect((await request(app).get(`${S}/status`)).body.targets).toEqual({ reel: 'ריל', story: 'סטורי' });
  });

  test('a target that was not asked for is a reel; the same source can later get the other target without duplicating the first', async () => {
    const buf = Buffer.concat([Buffer.from('src-'), crypto.randomBytes(4096)]);
    const a = await upload({}, buf);
    expect((await get(a.body.project.id)).target).toBe('reel');
    expect((await upload({ target: 'reel' }, buf)).body.duplicate).toBe(true);
    const b = await upload({ target: 'story' }, buf);
    expect(b.body.duplicate).toBe(false);
    expect(Object.values(studio.state().projects).map(p => p.target).sort()).toEqual(['reel', 'story']);
    expect((await get(a.body.project.id)).siblings).toEqual([expect.objectContaining({ id: b.body.project.id, target: 'story' })]);
  });
});

describe('a skill from a brief together with example videos', () => {
  const DRAFT = { purpose: 'עדויות אישיות', suitable_for: ['עדות מתאמנת'], params: { caption_max_lines: 2 },
    rules: [{ text: 'כתוביות בשתי שורות', domain: 'captions', source: 'owner', mandatory: true, executable: true },
            { text: 'כתובית אחת בשורה אחת במרכז', domain: 'captions', source: 'reference', reference: 1, aspect: 'captions', executable: true },
            { text: 'לפתוח על המשפט החזק ביותר', domain: 'opening', source: 'reference', reference: 1, aspect: 'opening', executable: true },
            { text: 'זום קל על משפט המפתח', domain: 'zooms', source: 'dana', executable: true },
            { text: 'מעבר מסתובב', domain: 'transitions', source: 'reference', reference: 1, aspect: 'nope', executable: false }],
    conflicts: [{ rule: 0, other_rule: 1, why: 'ההוראה מבקשת שתי שורות; בדוגמה שורה אחת', suggestion: 'שתי שורות' }],
    uncertain: ['לא ברור אם הכוונה לשתי שורות תמיד'], coverage_gaps: ['הסאונד של הדוגמה לא נותח'], criteria: [] };

  test('every rule says where it came from; an explicit instruction outranks the example, openly; a suggestion is not a rule', async () => {
    const ref = await reference();
    const made = await post('/skills/from-prompt', { by: 'עדן', name: 'עדות אישית', prompt: 'עריכה רגועה של עדות', goal: 'שירגיש אישי', must: 'כתוביות בשתי שורות\n', open: ['איפה לשים זום'],
      avoid: 'לא את המוזיקה', ids: [ref], take: { [ref]: 'את הפתיחה והכתוביות' } });
    expect(made.body.skill.status).toBe('drafting');                   // the saved analysis is used as is: no new analysis is queued
    expect((await W(request(app).post('/api/dana/worker/references/lease')).send({ workerId: 'w1' })).status).toBe(204);
    const l = (await skLease()).body;
    expect(l.skill).toMatchObject({ mode: 'draft', goal: 'שירגיש אישי', must: ['כתוביות בשתי שורות'], open: ['איפה לשים זום'], avoid: 'לא את המוזיקה',
      references: [{ title: 'רפרנס א', take: 'את הפתיחה והכתוביות', not_done: ['לא הוקשב לסאונד'] }] });
    expect(l.skill.references[0].aspects).toHaveLength(3);
    expect((await skDraft(made.body.skill.id, l, DRAFT)).body.status).toBe('draft');
    const d = (await skill(made.body.skill.id)).draft;
    expect(d.rules.map(r => [r.source.type, r.basis, r.active])).toEqual([['prompt', 'owner_instruction', true], ['reference', 'seen_in_stills', false], ['reference', 'model_assessment', true],
      ['dana', 'dana_suggestion', false], ['dana', 'dana_suggestion', false]]);
    expect(d.rules[0].mandatory).toBe(true);
    expect(d.rules[1]).toMatchObject({ overruled: { by: 'r1' }, source: { ref, aspect: 'captions', times_s: [2.1, 9] } });      // the finding and its times come from the stored analysis
    expect(d.rules[4].source.note).toMatch(/לא נמצא ממצא תואם/);        // a "reference" rule with no finding behind it is only a suggestion
    expect(d.conflicts).toEqual([expect.objectContaining({ a: 'r1', b: 'r2', auto: true, resolvedBy: 'owner_instruction_wins' })]);
    expect(d).toMatchObject({ uncertain: ['לא ברור אם הכוונה לשתי שורות תמיד'], coverage_gaps: ['הסאונד של הדוגמה לא נותח'], brief: { goal: 'שירגיש אישי', avoid: 'לא את המוזיקה' } });
    expect(d.params.caption_max_lines).toBe(2);
    // a suggestion becomes a rule only when the owner adopts it
    const after = (await put(`/skills/${made.body.skill.id}`, { by: 'עדן', rules: [{ id: 'r4', adopt: true }] })).body.skill.draft;
    expect(after.rules.find(r => r.id === 'r4')).toMatchObject({ active: true, basis: 'owner_instruction' });
  });

  test('a new example video is analysed first, once; the draft waits for it and then goes to the worker', async () => {
    const ref = await upRef('דוגמה חדשה');
    const made = await post('/skills/from-prompt', { by: 'עדן', name: 'מהדוגמה', prompt: 'לערוך כמו בסרטון המצורף', ids: [ref] });
    expect(made.body.skill.status).toBe('waiting_analysis');
    expect((await skLease()).status).toBe(204);
    expect((await put(`/skills/${made.body.skill.id}`, { by: 'עדן', name: 'x' })).body.error).toBe('skill_drafting');
    await analyse(analysis(110, 1));
    const l = await skLease();
    expect(l.status).toBe(200);
    expect(l.body.skill.references[0]).toMatchObject({ title: 'דוגמה חדשה', summary: 'פתיחה ישירה וכתוביות גדולות' });
  });

  test('a brief needs instructions; a prompt alone still works', async () => {
    expect((await post('/skills/from-prompt', { by: 'עדן', name: 'ריק', prompt: 'קצר' })).body.error).toBe('prompt_required');
    expect((await post('/skills/from-prompt', { by: 'עדן', name: 'רק הוראות', prompt: 'כתוביות גדולות במרכז המסך' })).body.skill.status).toBe('drafting');
    expect((await skLease()).body.skill).toMatchObject({ mode: 'draft', references: [] });
  });
});

describe('"שדרג סקיל באמצעות רפרנס"', () => {
  test('a targeted change as a draft of the next version, with a comparison; the approved version, the default and pinned projects stay until approval', async () => {
    const k = await approved('סגנון', ['opening', 'captions'], { make_default: true });
    const up0 = await upload({}); const l0 = await lease(); await finish(l0, up0.body.project.source.sha256);
    await patch(`/projects/${up0.body.project.id}/settings`, { skill: { mode: 'pinned', id: k.id } });
    const ref2 = await reference('רפרנס חדש', 124);
    expect((await post(`/skills/${k.id}/upgrade`, { by: 'עדן', ids: [] })).body.error).toBe('references_required');
    const u = await post(`/skills/${k.id}/upgrade`, { by: 'עדן', ids: [ref2], prompt: 'לשפר רק את הפתיחה' });
    expect(u.status).toBe(201);
    expect(u.body.skill).toMatchObject({ status: 'drafting', default: true, defaultVersion: 1 });
    expect((await post(`/skills/${k.id}/upgrade`, { by: 'עדן', ids: [ref2] })).body.error).toBe('draft_exists');
    const l = (await skLease()).body;
    expect(l.skill).toMatchObject({ mode: 'upgrade', prompt: 'לשפר רק את הפתיחה', current_rules: [{ id: 'r1' }, { id: 'r2' }], current_params: { caption_size: 110 }, references: [{ title: 'רפרנס חדש' }] });
    await skDraft(k.id, l, { summary: 'פתיחה חדה יותר וכותרת', change: [{ rule_id: 'r1', text: 'לפתוח על המשפט החזק ביותר, בלי הקדמה', why: 'ברפרנס הפתיחה מיידית' }, { rule_id: 'r9', text: 'x', why: 'y' }],
      add: [{ text: 'כותרת פתיחה מונפשת', domain: 'motion_graphics', source: 'reference', reference: 1, aspect: 'motion_graphics', executable: true, why: 'נראה ב-0.2s' }],
      remove: [], params: [{ key: 'caption_size', value: 124, why: 'כתוביות גדולות יותר ברפרנס' }, { key: 'nope', value: 1, why: 'x' }] });
    const s1 = await skill(k.id);
    expect(s1).toMatchObject({ status: 'approved_with_draft', defaultVersion: 1, approved: { version: 1 }, draft: { version: 2 } });
    const diff = s1.draft.upgrade.diff;
    expect(diff).toMatchObject({ summary: 'פתיחה חדה יותר וכותרת', large_change: false, kept: [{ id: 'r2' }],
      changed: [{ id: 'r1', before: 'לפתוח על המשפט החזק ביותר', after: 'לפתוח על המשפט החזק ביותר, בלי הקדמה', why: 'ברפרנס הפתיחה מיידית' }],
      added: [{ text: 'כותרת פתיחה מונפשת', domain: 'motion_graphics', why: 'נראה ב-0.2s' }], removed: [], params: [{ key: 'caption_size', before: 110, after: 124 }] });
    expect(diff.ignored).toEqual(['שינוי לכלל לא מוכר: r9']);
    expect(s1.approved.rules.find(r => r.id === 'r1').text).toBe('לפתוח על המשפט החזק ביותר');       // version 1 is untouched
    // until approval nothing uses the draft
    finishAll();
    const n1 = await upload({}); const j1 = await lease();
    expect(j1.job.options.skill_set[0].skill.version).toBe(1);
    await finish(j1, n1.body.project.source.sha256);
    // approval: future edits use version 2; the pinned project and version 1 itself remain
    const ap = (await post(`/skills/${k.id}/approve`, { by: 'עדן' })).body.skill;
    expect(ap).toMatchObject({ status: 'approved', default: true, defaultVersion: 2 });
    expect(ap.versions.map(v => [v.version, v.status])).toEqual([[1, 'approved'], [2, 'approved']]);
    const n2 = await upload({}); const j2 = await lease();
    expect(j2.job.options.skill_set[0]).toMatchObject({ skill: { version: 2 }, profile: { params: { caption_size: 124 } } });
    await finish(j2, n2.body.project.source.sha256);
    await post(`/projects/${up0.body.project.id}/apply-skill`, { by: 'עדן' });
    expect((await lease()).job.options.skill_set[0]).toMatchObject({ skill: { version: 1 }, profile: { params: { caption_size: 110 } } });
  });

  test('an upgrade cannot remove a mandatory instruction of the owner, and a sweeping change is called out', async () => {
    await post('/skills/from-prompt', { by: 'עדן', name: 'חובה', prompt: 'כתוביות גדולות במרכז המסך', must: ['בלי זומים'] });
    const l = (await skLease()).body;
    await skDraft(l.skill.id, l, { purpose: 'p', suitable_for: [], params: {}, rules: [{ text: 'בלי זומים', domain: 'zooms', source: 'owner', mandatory: true, executable: true },
      { text: 'כתוביות גדולות', domain: 'captions', source: 'owner', executable: true }], conflicts: [], criteria: [] });
    await post(`/skills/${l.skill.id}/approve`, { by: 'עדן' });
    const ref = await reference('אחר');
    await post(`/skills/${l.skill.id}/upgrade`, { by: 'עדן', ids: [ref] });
    const l2 = (await skLease()).body;
    await skDraft(l.skill.id, l2, { summary: 's', change: [], add: [], params: [], remove: [{ rule_id: 'r1', why: 'ברפרנס יש זומים' }, { rule_id: 'r2', why: 'לא מתאים' }] });
    const d = (await skill(l.skill.id)).draft;
    expect(d.rules.map(r => r.id)).toEqual(['r1']);
    expect(d.upgrade.diff).toMatchObject({ removed: [{ id: 'r2' }], large_change: false });
    expect(d.upgrade.diff.ignored[0]).toMatch(/הוראת חובה/);
  });
});

describe('combining skills in one edit', () => {
  test('a project carries an ordered combination; a contradiction is shown and has to be confirmed before anything is produced', async () => {
    const a = await approved('תוכן', ['opening'], { size: 84 }), b = await approved('גרפיקה', ['motion_graphics'], { size: 124 });
    const up = await upload({}); const l = await lease();
    expect(l.job.options.skill_set).toBeUndefined();
    await finish(l, up.body.project.source.sha256);
    const id = up.body.project.id;
    expect((await patch(`/projects/${id}/settings`, { skill: { mode: 'set', ids: [] } })).body.error).toBe('skills_required');
    await patch(`/projects/${id}/settings`, { skill: { mode: 'set', ids: [a.id, b.id] }, animation_scene: true });
    const p = await get(id);
    expect(p).toMatchObject({ animationScene: true, skill: { mode: 'set', items: [{ id: a.id, version: 1, name: 'תוכן' }, { id: b.id, version: 1, name: 'גרפיקה' }] } });
    expect(p.skillConflicts).toEqual([expect.objectContaining({ kind: 'parameter', key: 'caption_size', used: { skill: 'תוכן', value: 84 }, not_used: { skill: 'גרפיקה', value: 124 } })]);
    const refused = await post(`/projects/${id}/apply-skill`, { by: 'עדן' });
    expect(refused.body).toMatchObject({ error: 'skill_conflicts', conflicts: [{ key: 'caption_size' }] });
    expect(Object.values(studio.state().jobs).filter(j => j.status === 'queued')).toHaveLength(0);
    expect((await post(`/projects/${id}/apply-skill`, { by: 'עדן', confirm_conflicts: true })).body.ok).toBe(true);
    const j = (await lease()).job;
    expect(j.options.skill_set.map(c => [c.skill.name, c.skill.version, c.skill.chosen_by])).toEqual([['תוכן', 1, 'owner'], ['גרפיקה', 1, 'owner']]);
    expect(j.options).toMatchObject({ animation_scene: true, target: 'reel' });
    expect(j.options.profile).toBeUndefined();
    expect((await get(id)).status).not.toBe('approved');
  });

  test('an approved default combination is used automatically, in its order; conflicting skills need a confirmed order', async () => {
    const a = await approved('תוכן', ['opening'], { size: 84 }), b = await approved('גרפיקה', ['motion_graphics'], { size: 124 }), c = await approved('אותו גודל', ['captions'], { size: 84 });
    expect((await post('/skills/default-set', { by: 'עדן', ids: [b.id, a.id] })).body).toMatchObject({ error: 'skill_conflicts' });
    expect((await request(app).get(`${S}/skills`)).body.skills.filter(k => k.default)).toHaveLength(0);
    const ok = await post('/skills/default-set', { by: 'עדן', ids: [b.id, a.id], confirm_conflicts: true });
    expect(ok.body.skills.filter(k => k.default).sort((x, y) => x.defaultOrder - y.defaultOrder).map(k => k.name)).toEqual(['גרפיקה', 'תוכן']);
    await upload({});
    const j = (await lease()).job;
    expect(j.options.skill_set.map(x => [x.skill.name, x.skill.chosen_by])).toEqual([['גרפיקה', 'default'], ['תוכן', 'default']]);
    finishAll();
    expect((await post('/skills/default-set', { by: 'עדן', ids: [a.id, c.id] })).body.skills.filter(k => k.default).map(k => k.name).sort()).toEqual(['אותו גודל', 'תוכן']);   // no contradiction: nothing to confirm
    const draft = (await post('/skills/from-prompt', { by: 'עדן', name: 'טיוטה', prompt: 'כתוביות גדולות במרכז המסך' })).body.skill;
    expect((await post('/skills/default-set', { by: 'עדן', ids: [a.id, draft.id] })).body.error).toBe('not_approved');
  });
});

describe('what a package shows, and fixing one thing', () => {
  const FINAL = { title: 'הביקורת הסופית של דנה', verdict: 'needs_owner', skills: [{ name: 'dana-review', version: 'r1', role: 'סקיל הביקורת' }], coverage: { criteria: 40, decided: 30 } };
  const TL = { note: 'n', spans: [{ t0: 0, t1: 5, picture: 'footage' }, { t0: 5, t1: 7.5, picture: 'animation_scene' }], events: [] };

  test('the final review, the timeline and the previous review travel with the versions; removing one graphic is a locked revision that drops the approval', async () => {
    const up = await upload({}); const l = await lease();
    expect(l.job.options.previous_review).toBeUndefined();
    await finish(l, up.body.project.source.sha256, pkgFor(up.body.project.source.sha256, { final_review: FINAL, timeline: TL, review_compact: { rubric_version: 'r1', criteria: { A1: 'met' } },
      graphics: [{ id: 'animation_scene@12.0', kind: 'animation_scene', layer: 'replaces_picture' }, { id: 'hook_title@3.0', kind: 'hook_title', layer: 'over_picture' }] }));
    const id = up.body.project.id, p = await get(id);
    expect(p.version.package).toMatchObject({ finalReview: { verdict: 'needs_owner' }, timeline: { spans: [{ picture: 'footage' }, { picture: 'animation_scene' }] } });
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', graphic_edits: [{ id: 'x y', action: 'remove' }] })).body.error).toBe('graphic_edits_invalid');
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', graphic_edits: [{ id: 'animation_scene@12.0', action: 'boost' }] })).body.error).toBe('graphic_edits_invalid');
    const r = await post(`/projects/${id}/revise`, { by: 'עדן', graphic_edits: [{ id: 'animation_scene@12.0', action: 'remove' }] });
    expect(r.body.ok).toBe(true);
    const j = (await lease()).job;
    expect(j.options.graphic_edits).toEqual([expect.objectContaining({ id: 'animation_scene@12.0', action: 'remove' })]);
    expect(j.options.previous).toBeDefined();                          // the rest of the edit is kept: the plan is locked to the previous version
    expect(j.options.previous_review).toEqual({ rubric_version: 'r1', criteria: { A1: 'met' } });
    const now = await get(id);
    expect(now.status).not.toBe('approved');
    expect(now.versions.map(v => v.n)).toEqual(expect.arrayContaining([1, 2]));      // version 1 is kept
    expect((await request(app).get(`${S}/status`)).body.adjustmentKinds.animation).toMatch(/מחליפים את הצילום/);
  });
});
