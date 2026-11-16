'use strict';
/**
 * Dana — the editing-skill library on the server: drafting from analysis and from written instructions, hypotheses and
 * unsupported rules, approval and default, what a job carries, pinned versions, testing a draft on a clip, applying a
 * skill to a project, and which version a review belongs to. Isolated temp DATA_DIR; the worker is simulated.
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const TOKEN = 'test-worker-token-0123456789abcdef', S = '/api/dana/studio';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const W = r => r.set('Authorization', `Bearer ${TOKEN}`);
let app, studio, skills;
beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-skills-'));
  process.env.DANA_WORKER_TOKEN = TOKEN;
  delete process.env.DANA_PUBLISHING_ENABLED; delete process.env.DANA_NOTIFY_REAL; delete process.env.DANA_PUBLISHER_MODE;
  jest.resetModules();
  studio = require('../services/dana_studio'); skills = require('../services/dana_skills');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express(); app.use('/api/dana/worker', workerRouter); app.use(S, panelRouter);
  studio.reconcileOnStartup();
});
const post = (p, body) => request(app).post(S + p).send(body);
const put = (p, body) => request(app).put(S + p).send(body);
const get = async id => (await request(app).get(`${S}/projects/${id}`)).body.project;
const lease = async () => (await W(request(app).post('/api/dana/worker/lease')).send({ workerId: 'w1', pipelineVersion: '1.2.0' })).body;
const finishAll = () => { for (const j of Object.values(studio.state().jobs)) if (['queued', 'leased'].includes(j.status)) j.status = 'succeeded'; };

const ANALYSIS = { summary: 'פתיחה ישירה וכתוביות גדולות', fits_us: ['עדויות מתאמנות'], coverage: { not_done: ['x'] }, measured: { duration_s: 30 },
  aspects: [{ aspect: 'opening', observation: 'נפתח על המשפט המרכזי', rule: 'לפתוח על המשפט החזק ביותר', basis: 'model_assessment', example_times_s: [0.4] },
            { aspect: 'captions', observation: 'כתוביות גדולות במרכז', rule: 'כתובית אחת בשורה אחת במרכז', basis: 'seen_in_stills', example_times_s: [2.1, 9] },
            { aspect: 'transitions', observation: 'נראה דיזולב בין שוטים', rule: 'מעבר דיזולב בין קטעים', basis: 'hypothesis', example_times_s: [] },
            { aspect: 'sound', observation: 'ייתכן שיש מוזיקת רקע', rule: 'להוסיף מוזיקת רקע שקטה', basis: 'hypothesis', example_times_s: [] }],
  proposed_profile: { params: { caption_size: 110, caption_max_lines: 1 }, rules: ['לפתוח על המשפט החזק'] } };
async function reference(title = 'רפרנס א') {
  const r = await request(app).post(`${S}/references`).field('title', title).field('by', 'עדן').field('owner_note', 'אהבתי').attach('file', crypto.randomBytes(2000), 'r.mp4');
  const l = (await W(request(app).post('/api/dana/worker/references/lease')).send({ workerId: 'w1' })).body;
  await W(request(app).post(`/api/dana/worker/references/${l.reference.id}/analysis`)).set('X-Lease-Token', l.leaseToken).send({ status: 'analysed', analysis: ANALYSIS });
  return r.body.reference.id;
}
const pick = (ref, ...aspects) => ({ aspects: aspects.map(aspect => ({ ref, aspect })), params: { caption_size: ref } });
const REVIEW = { rubric_version: 'r1', categories: [{ key: 'sound', label: 'סאונד', level: 'תקין', met: 2, decided: 2, not_checked: 1,
  criteria: [{ id: 'A1', category: 'sound', criterion: 'עוצמה', status: 'met', basis: 'measured', note: 'n' }, { id: 'M1', category: 'message', criterion: 'מסר', status: 'met', basis: 'model', note: 'n' },
             { id: 'A3', category: 'sound', criterion: 'נשמע טבעי', status: 'not_checked', basis: 'human', note: 'n' }] }], improvements: [] };
function pkgFor(s, extra = {}) {
  return { pipeline_version: '1.2.0', status: 'success', source: { sha256: s, duration: 30 }, segment: { in_s: 0, out_s: 20 }, duration: 20, adapter: 'claude', judgement_mode: 'model',
    style: { caption_size: 96 }, spoken_text: 'שלום', plan: { message: 'מ', content_judgement: 'model', segments: [{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20 }] },
    cards: [{ i: 1, text: 'שלום לכולם', highlight: [], start: 0, dur: 1.2, source_start_s: 3, source_end_s: 4.2 }], zooms: [], cover: { text: 'שלום', frame_s: 1 }, caption: { text: 'טיוטה', cta: null },
    checks: [], failed_checks: [], issues: [], dana_review: REVIEW, rules_used: { skill: { name: 'dana-editing', version: '0.1.0' }, profile: { id: 'center-bold-v1', version: '2', status: 'unapproved' }, references: [] }, timings_s: {}, total_s: 10, ...extra };
}
async function finish(l, s, pkg) {
  const video = crypto.randomBytes(3000);
  const p = pkg ?? pkgFor(s);
  if (p.review_provenance === 'MATCH') p.review_provenance = { reviewed_at: '2026-11-16T10:00:00+0200', final_sha256: sha(video), reviewed_sha256: sha(video), on_delivered_file: true, review_rounds: 1 };
  const files = { 'final.mp4': video, 'cover.jpg': crypto.randomBytes(500), 'package.json': Buffer.from(JSON.stringify(p)), 'checks.json': Buffer.from('{"records":[]}'), 'captions.json': Buffer.from('[]') };
  for (const [name, buf] of Object.entries(files))
    expect((await W(request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken).set('X-Content-SHA256', sha(buf)).set('Content-Type', 'application/octet-stream').send(buf)).status).toBe(200);
  return W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
}
async function project(pkgExtra) {
  const up = await request(app).post(`${S}/upload`).attach('video', Buffer.concat([Buffer.from('src-'), crypto.randomBytes(4096)]), `c-${crypto.randomBytes(3).toString('hex')}.mp4`);
  const l = await lease(); await finish(l, up.body.project.source.sha256, pkgFor(up.body.project.source.sha256, pkgExtra));
  return { id: up.body.project.id, sha: up.body.project.source.sha256, job: l.job };
}

describe('"צור סקיל מהניתוח"', () => {
  test('every rule is tied to its finding and time; a hypothesis is not a rule; an unsupported rule is never active', async () => {
    const ref = await reference();
    expect((await post('/skills/from-analysis', { by: 'עדן', name: 'ראיון רגוע', ids: [ref], picks: {} })).body.error).toBe('picks_required');
    expect((await post('/skills/from-analysis', { by: 'עדן', name: 'ראיון רגוע', ids: [ref], picks: pick(ref, 'opening', 'nope') })).body.error).toBe('picks_invalid');
    const r = await post('/skills/from-analysis', { by: 'עדן', name: 'ראיון רגוע', ids: [ref], picks: pick(ref, 'opening', 'captions', 'transitions', 'sound') });
    expect(r.status).toBe(201);
    const k = r.body.skill, d = k.draft;
    expect(k).toMatchObject({ name: 'ראיון רגוע', status: 'draft', default: false, approved: null });
    expect(d.rules.map(x => [x.domain, x.basis, x.support, x.active])).toEqual([
      ['opening', 'model_assessment', 'supported', true], ['captions', 'seen_in_stills', 'supported', true],
      ['transitions', 'hypothesis', 'unsupported', false],            // the worker makes hard cuts only
      ['sound', 'hypothesis', 'partial', false]]);                    // a hypothesis: not a rule until adopted
    expect(d.rules[1].source).toMatchObject({ type: 'reference', ref, title: 'רפרנס א', aspect: 'captions', times_s: [2.1, 9], observation: 'כתוביות גדולות במרכז' });
    expect(d.params).toEqual({ caption_size: 110 });
    expect(d.param_sources.caption_size).toMatchObject({ ref, basis: 'seen_in_stills' });
    expect(d.counts).toEqual({ active: 2, partial: 0, hypotheses: 1, unsupported: 1, open_conflicts: 0 });
    expect(d.fully_supported).toBe(false);
    expect(d.criteria).toHaveLength(2);                              // one per active rule
    expect(d.requires.find(x => x.domain === 'transitions')).toMatchObject({ support: 'unsupported' });
    expect(d.skill_md).toMatch(/Not supported by the editing worker/);
    expect(fs.existsSync(path.join(process.env.DATA_DIR, 'dana', 'skills', k.id, 'v1', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.env.DATA_DIR, 'dana', 'skills', k.id, 'v1', 'profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(process.env.DATA_DIR, 'dana', 'skills', k.id, 'v1', 'criteria.json'))).toBe(true);
  });

  test('the owner can adopt a hypothesis as their own instruction; an unsupported rule cannot be switched on', async () => {
    const ref = await reference();
    const k = (await post('/skills/from-analysis', { by: 'עדן', name: 'סקיל א', ids: [ref], picks: pick(ref, 'transitions', 'sound') })).body.skill;
    expect((await post(`/skills/${k.id}/approve`, { by: 'עדן' })).body.error).toBeUndefined();   // it has a parameter, so it is not empty
    const k2 = (await post('/skills/from-analysis', { by: 'עדן', name: 'סקיל ב', ids: [ref], picks: { aspects: [{ ref, aspect: 'transitions' }, { ref, aspect: 'sound' }] } })).body.skill;
    expect((await post(`/skills/${k2.id}/approve`, { by: 'עדן' })).body.error).toBe('skill_empty');   // only a hypothesis and an unsupported rule
    const r = await put(`/skills/${k2.id}`, { by: 'עדן', rules: [{ id: 'r2', adopt: true }, { id: 'r1', adopt: true, active: true }] });
    const rules = r.body.skill.draft.rules;
    expect(rules.find(x => x.id === 'r2')).toMatchObject({ basis: 'owner_instruction', active: true, adopted: { by: 'עדן', from: 'hypothesis' } });
    expect(rules.find(x => x.id === 'r1')).toMatchObject({ support: 'unsupported', active: false });
    expect(r.body.skill.draft.history.at(-1)).toMatchObject({ action: 'draft_saved', by: 'עדן' });
  });
});

describe('"צור סקיל מהוראות"', () => {
  const DRAFT = { purpose: 'סרטוני עדות קצרים', suitable_for: ['עדות מתאמנת'],
    rules: [{ text: 'לפתוח במשפט הכי חזק', domain: 'opening', executable: true }, { text: 'כתוביות בשתי שורות', domain: 'captions', executable: true },
            { text: 'להוסיף מוזיקה קצבית', domain: 'music', executable: false, note: 'העובד לא מוסיף מוזיקה' }, { text: 'לפרסם מיד בסיום', domain: 'other', executable: false, note: 'סקיל מתאר עריכה בלבד' }],
    params: { caption_max_lines: 2, caption_size: 999, evil: 'rm -rf' }, criteria: [{ text: 'הסרטון נפתח במשפט המרכזי', domain: 'opening' }],
    conflicts: [{ prompt_rule: 1, reference_rule: 'r1', why: 'שורה אחת מול שתי שורות', suggestion: 'שורה אחת, ושתיים רק כשהמשפט ארוך' }] };

  test('the worker structures the prompt; unsupported and non-editing instructions are marked; a conflict blocks approval until resolved', async () => {
    const ref = await reference();
    expect((await post('/skills/from-prompt', { by: 'עדן', name: 'שלי', prompt: 'קצר' })).body.error).toBe('prompt_required');
    const made = await post('/skills/from-prompt', { by: 'עדן', name: 'שלי', prompt: 'לפתוח במשפט הכי חזק, כתוביות בשתי שורות, מוזיקה קצבית, ולפרסם מיד', ids: [ref], picks: { aspects: [{ ref, aspect: 'captions' }] } });
    const id = made.body.skill.id;
    expect(made.body.skill.status).toBe('drafting');
    expect((await post(`/skills/${id}/approve`, { by: 'עדן' })).body.error).toBe('no_draft');
    const l = (await W(request(app).post('/api/dana/worker/skills/lease')).send({ workerId: 'w1' })).body;
    expect(l.skill).toMatchObject({ id, name: 'שלי', reference_rules: [{ id: 'r1', domain: 'captions' }] });
    expect(l.skill.prompt).toMatch(/מוזיקה קצבית/);
    expect(l.skill.domains.music.support).toBe('unsupported');
    expect((await W(request(app).post(`/api/dana/worker/skills/${id}/draft`)).set('X-Lease-Token', 'wrong').send({ status: 'drafted', draft: DRAFT })).status).toBe(409);
    expect((await W(request(app).post(`/api/dana/worker/skills/${id}/draft`)).set('X-Lease-Token', l.leaseToken).send({ status: 'drafted', draft: DRAFT })).body.status).toBe('draft');
    const d = (await request(app).get(`${S}/skills/${id}`)).body.skill.draft;
    expect(d.origin).toBe('combined');
    expect(d.rules.map(x => [x.id, x.source.type, x.support, x.active])).toEqual([['r1', 'reference', 'supported', true], ['r2', 'prompt', 'supported', true], ['r3', 'prompt', 'supported', true],
      ['r4', 'prompt', 'unsupported', false], ['r5', 'prompt', 'unsupported', false]]);
    expect(d.rules[4].support_note).toBe('סקיל מתאר עריכה בלבד');     // "publish immediately" is not editing and is never executed
    expect(d.params).toEqual({ caption_max_lines: 2, caption_size: 130 });   // clamped to the limits; an unknown key is dropped
    expect(d.conflicts).toEqual([expect.objectContaining({ a: 'r3', b: 'r1', resolution: null })]);
    expect((await post(`/skills/${id}/approve`, { by: 'עדן' })).body).toMatchObject({ error: 'conflicts_open', conflicts: ['c1'] });
    const res = await put(`/skills/${id}`, { by: 'עדן', resolve: [{ id: 'c1', resolution: 'suggestion' }] });
    const after = res.body.skill.draft;
    expect(after.rules.filter(x => x.active).map(x => x.text)).toEqual(['לפתוח במשפט הכי חזק', 'שורה אחת, ושתיים רק כשהמשפט ארוך']);
    expect((await post(`/skills/${id}/approve`, { by: 'עדן' })).body.skill).toMatchObject({ status: 'approved', default: false });
  });

  test('a failed draft is reported and nothing becomes usable', async () => {
    const made = await post('/skills/from-prompt', { by: 'עדן', name: 'שלי', prompt: 'כתוביות גדולות במרכז המסך' });
    const l = (await W(request(app).post('/api/dana/worker/skills/lease')).send({ workerId: 'w1' })).body;
    await W(request(app).post(`/api/dana/worker/skills/${made.body.skill.id}/draft`)).set('X-Lease-Token', l.leaseToken).send({ status: 'failed', error: { code: 'judgement_failed', message: 'x' } });
    expect((await request(app).get(`${S}/skills/${made.body.skill.id}`)).body.skill).toMatchObject({ status: 'draft_failed', approved: null });
  });
});

describe('approval, default and what a job carries', () => {
  async function approved(name = 'מאושר', make_default = false) {
    const ref = await reference(name + ' ref');
    const k = (await post('/skills/from-analysis', { by: 'עדן', name, ids: [ref], picks: pick(ref, 'opening', 'captions', 'transitions') })).body.skill;
    return (await post(`/skills/${k.id}/approve`, { by: 'עדן', make_default })).body.skill;
  }

  test('a draft is never a default and never reaches a job; only an approved default does, with rules, parameters and criteria', async () => {
    const ref = await reference();
    const k = (await post('/skills/from-analysis', { by: 'עדן', name: 'טיוטה', ids: [ref], picks: pick(ref, 'opening') })).body.skill;
    expect((await post(`/skills/${k.id}/default`, { by: 'עדן' })).body.error).toBe('not_approved');
    const a = await project();
    expect(a.job.options.skill).toBeUndefined();                       // a draft exists, and the job carries nothing of it
    expect((await request(app).patch(`${S}/projects/${a.id}/settings`).send({ skill: { mode: 'pinned', id: k.id } })).body.error).toBe('not_approved');
    finishAll();
    const ap = await post(`/skills/${k.id}/approve`, { by: 'עדן', make_default: true });
    expect(ap.body.skill).toMatchObject({ status: 'approved', default: true, defaultVersion: 1 });
    const b = await project();
    expect(b.job.options.skill).toMatchObject({ id: k.id, name: 'טיוטה', version: 1, chosen_by: 'default', status: 'approved',
      rules: [{ id: 'r1', domain: 'opening', support: 'supported' }], criteria: [{ id: 'k1' }], unsupported: [] });
    expect(b.job.options.profile).toMatchObject({ id: `skill:${k.id}`, version: '1', params: { caption_size: 110 }, rules: ['לפתוח על המשפט החזק ביותר'], status: 'owner_approved' });
  });

  test('an approved version is immutable: an edit opens a new draft; a pinned project keeps its version; a new project gets the default', async () => {
    const k = await approved('סגנון', true);
    const a = await project();
    await request(app).patch(`${S}/projects/${a.id}/settings`).send({ skill: { mode: 'pinned', id: k.id } });
    expect((await get(a.id)).skill).toMatchObject({ mode: 'pinned', id: k.id, version: 1 });
    finishAll();
    // version 2 of the skill: different rule text
    const d = await put(`/skills/${k.id}`, { by: 'עדן', rules: [{ id: 'r1', text: 'לפתוח בשאלה' }] });
    expect(d.body.skill).toMatchObject({ status: 'approved_with_draft', defaultVersion: 1 });
    expect(d.body.skill.approved.rules[0].text).toBe('לפתוח על המשפט החזק ביותר');      // version 1 is untouched
    await post(`/skills/${k.id}/approve`, { by: 'עדן' });
    const now = (await request(app).get(`${S}/skills/${k.id}`)).body.skill;
    expect(now.versions.map(v => [v.version, v.status])).toEqual([[1, 'approved'], [2, 'approved']]);
    expect(now.defaultVersion).toBe(1);                                // a new approved version does not replace the default silently
    // the pinned project still edits by version 1
    await post(`/projects/${a.id}/revise`, { by: 'עדן', style_overrides: { caption_size: 80 } });
    const l = await lease();
    expect(l.job.options.skill).toMatchObject({ version: 1, rules: [expect.objectContaining({ text: 'לפתוח על המשפט החזק ביותר' }), expect.anything()] });
    expect(l.job.options.style_overrides).toEqual({ caption_size: 80 });   // a project-only adjustment rides on top; the skill itself is unchanged
    expect((await get(a.id)).versions[0].skill).toMatchObject({ version: 1 });   // the existing version was not rewritten to the new skill version
    finishAll();
    await post(`/skills/${k.id}/default`, { by: 'עדן', version: 2 });
    expect((await project()).job.options.skill).toMatchObject({ version: 2, rules: [expect.objectContaining({ text: 'לפתוח בשאלה' }), expect.anything()] });
  });

  test('"let Dana suggest": the job carries only APPROVED skills as candidates; "none" carries nothing', async () => {
    const k = await approved('אלף'); const ref = await reference('ב ref');
    await post('/skills/from-analysis', { by: 'עדן', name: 'טיוטה בלבד', ids: [ref], picks: pick(ref, 'opening') });
    const a = await project(); finishAll();
    await request(app).patch(`${S}/projects/${a.id}/settings`).send({ skill: { mode: 'none' } });
    expect((await post(`/projects/${a.id}/apply-skill`, { by: 'עדן' })).body.error).toBe('no_skill');
    await request(app).patch(`${S}/projects/${a.id}/settings`).send({ skill: { mode: 'suggest' } });
    await post(`/projects/${a.id}/apply-skill`, { by: 'עדן' });
    const l = await lease();
    expect(l.job.options.skill).toBeUndefined();
    expect(l.job.options.skill_candidates.map(c => c.skill.name)).toEqual(['אלף']);
    expect(k.id).toBeTruthy();
  });

  test('applying a skill to an existing project makes a NEW version and drops the approval; the old version stays', async () => {
    const k = await approved('להחלה');
    const a = await project();
    let p = await get(a.id);
    await post(`/projects/${a.id}/approve`, { fingerprint: p.version.fingerprint, by: 'עדן' });
    const r = await post(`/projects/${a.id}/apply-skill`, { by: 'עדן', skill: { mode: 'pinned', id: k.id } });
    expect(r.body.project).toMatchObject({ currentVersion: 2, status: 'editing' });
    expect(r.body.project.versions[0]).toMatchObject({ n: 1, approved: false, hasVideo: true });
    const l = await lease();
    expect(l.job.options.skill.id).toBe(k.id);
    expect(l.job.options.previous).toBeUndefined();                    // planned again, by the skill
  });

  test('testing a DRAFT on a clip: a marked test version, an example recorded on the draft, and still no default', async () => {
    const ref = await reference();
    const k = (await post('/skills/from-analysis', { by: 'עדן', name: 'לבדיקה', ids: [ref], picks: pick(ref, 'opening', 'captions') })).body.skill;
    const a = await project(); finishAll();
    expect((await post(`/skills/${k.id}/test`, { projectId: a.id })).body.error).toBe('by_required');
    const t = await post(`/skills/${k.id}/test`, { by: 'עדן', projectId: a.id });
    expect(t.body.project.currentVersion).toBe(2);
    const l = await lease();
    expect(l.job.options.skill).toMatchObject({ id: k.id, status: 'draft_test', chosen_by: 'owner_test' });
    expect(l.job.options.profile.status).toBe('draft_test');
    const report = { skill: { id: k.id, name: 'לבדיקה', version: 1, status: 'draft_test', chosen_by: 'owner_test' },
      rules: [{ id: 'r1', status: 'applied' }, { id: 'r2', status: 'not_followed' }], params: [], criteria: [], summary: { applied: 1, not_followed: 1, not_applicable: 0, unsupported: 0, not_checked: 0, fully_applied: false } };
    await finish(l, a.sha, pkgFor(a.sha, { skill_report: report }));
    const p = await get(a.id);
    expect(p.versions[1].skill).toMatchObject({ id: k.id, version: 1, test: true });
    expect(p.version.package.skillReport.summary.fully_applied).toBe(false);
    const after = (await request(app).get(`${S}/skills/${k.id}`)).body.skill;
    expect(after).toMatchObject({ status: 'draft', default: false });
    expect(after.draft.sample).toMatchObject({ projectId: a.id, versionN: 2, applied: 1, not_followed: 1 });
    finishAll();
    expect((await project()).job.options.skill).toBeUndefined();        // the tested draft is still not used by anything else
  });
});

describe('which version a review belongs to', () => {
  test('while a new version is being produced the last finished one stays on screen, and its review is marked as not current', async () => {
    const a = await project({ review_provenance: 'MATCH' });
    let p = await get(a.id);
    expect(p.shown).toMatchObject({ n: 1, isCurrent: true });
    expect(p.review).toMatchObject({ versionN: 1, onFinalFile: true, upToDate: true, stale: [], counts: { measured: 1, model: 1, frames: 0, not_checked: 1 }, rubricVersion: 'r1' });
    expect(p.review.notChecked).toEqual([{ criterion: 'נשמע טבעי', why: 'דורש צפייה או האזנה שלך' }]);
    expect(p.review.note).toMatch(/אינו אישור פרסום/);
    await post(`/projects/${a.id}/revise`, { by: 'עדן', style_overrides: { caption_size: 80 } });
    p = await get(a.id);
    expect(p).toMatchObject({ currentVersion: 2, status: 'editing' });
    expect(p.shown).toMatchObject({ n: 1, isCurrent: false, currentN: 2, currentHasPackage: false });
    expect(p.version.package.danaReview.rubric_version).toBe('r1');     // the review did not vanish
    expect(p.review.upToDate).toBe(false);
    expect(p.review.stale[0]).toMatch(/הביקורת של גרסה 1/);
    expect(p.nextAction.key).toBe('wait');                              // actions and progress are about the CURRENT version
  });

  test('a saved correction, an edited caption or a different file make the review stale; any version can be shown on request', async () => {
    const a = await project({ review_provenance: 'MATCH' });
    await post(`/projects/${a.id}/captions/verify`, { source_start_s: 3, source_end_s: 4.2, original: 'שלום לכולם', text: 'שלום לכולן', by: 'עדן', listened: true });
    expect((await get(a.id)).review.stale).toEqual([expect.stringMatching(/תיקוני מלל נשמרו אחרי הביקורת/)]);
    await request(app).patch(`${S}/projects/${a.id}/package`).send({ caption: 'קפשן חדש' });
    expect((await get(a.id)).review.stale).toHaveLength(2);
    const b = await project({ review_provenance: { reviewed_at: 'x', final_sha256: 'a'.repeat(64), on_delivered_file: true } });
    expect((await get(b.id)).review).toMatchObject({ onFinalFile: false, upToDate: false });
    await post(`/projects/${a.id}/revise`, { by: 'עדן' }); const l = await lease(); await finish(l, a.sha, pkgFor(a.sha, { review_provenance: 'MATCH' }));
    expect((await get(a.id)).shown).toMatchObject({ n: 2, isCurrent: true });
    const old = (await request(app).get(`${S}/projects/${a.id}?version=1`)).body.project;
    expect(old.shown).toMatchObject({ n: 1, isCurrent: false, currentHasPackage: true });
    expect(old.review.stale[0]).toMatch(/הגרסה הנוכחית היא 2/);
  });
});
