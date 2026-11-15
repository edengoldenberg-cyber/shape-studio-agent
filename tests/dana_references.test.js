'use strict';
/**
 * Dana — reference analysis (worker lease → file → analysis → the owner approves or rejects the proposed
 * profile), versioned standing rules with their source, what a revision carries of the previous version,
 * and the quality fields. Isolated temp DATA_DIR; the worker is simulated over the real routes.
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const TOKEN = 'test-worker-token-0123456789abcdef';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const W = r => r.set('Authorization', `Bearer ${TOKEN}`);
const S = '/api/dana/studio', WK = '/api/dana/worker', R = `${S}/references`;

let app, studio, refs;
function boot() {
  jest.resetModules();
  studio = require('../services/dana_studio'); refs = require('../services/dana_references');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express();
  app.use(WK, workerRouter);
  app.use(S, panelRouter);
  studio.reconcileOnStartup();
}
beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-refs-'));
  process.env.DANA_WORKER_TOKEN = TOKEN;
  delete process.env.DANA_LEASE_SECONDS; delete process.env.DANA_PUBLISHING_ENABLED; delete process.env.DANA_NOTIFY_REAL; delete process.env.DANA_PUBLISHER_MODE;
  boot();
});

const ANALYSIS = {
  summary: 'פתיחה על משפט אחד, כתוביות גדולות במרכז, שני זומים', content_type: 'עדות מתאמנת', fits_message: 'התגברות על חשש',
  measured: { duration_s: 21.4, cuts_s: [4.2, 11.8], avg_shot_s: 7.1, words_per_s: 2.6, face_scale_changes: [{ t_s: 4.2, ratio: 1.18 }], notes: ['נמדד בפריימים דגומים'] },
  aspects: [
    { aspect: 'opening', observation: 'נפתח ישר על המשפט', example_times_s: [0.0, 1.4], rule: 'לפתוח על המשפט החזק', basis: 'measured' },
    { aspect: 'captions', observation: 'כתוביות גדולות, שורה אחת', example_times_s: [2.0], rule: 'עד שלוש מילים בשורה', basis: 'seen_in_stills' },
    { aspect: 'sound', observation: 'ייתכן שיש מוזיקת רקע', example_times_s: [], rule: '', basis: 'hypothesis' }],
  do_not_imitate: ['הלוגו של החשבון האחר'], hypotheses: ['הקצב מותאם למוזיקה'],
  proposed_profile: { params: { caption_size: 104, caption_y_px: 1100, caption_max_lines: 1, zoom_scale_medium: 1.18, font_family: 'Heebo' }, rules: ['לפתוח על המשפט החזק ביותר', 'עד שלוש מילים בשורה'] },
  basis_note: 'מדידות קוד + פריימים בודדים; המודל לא שמע אודיו ולא צפה בתנועה', skill: { name: 'dana-editing', version: '0.2.0', sha256: 'c'.repeat(64) },
  usage: { calls: 1 }, analysed_at: '2026-11-15T12:00:00.000Z',
};
const FILE = crypto.randomBytes(5000);
const addFile = (title = 'רפרנס קובץ') => request(app).post(R).field('title', title).field('by', 'Eden').field('owner_note', 'אהבתי את הפתיחה ואת גודל הכתוביות')
  .field('usage_permission', 'inspiration_only').field('content_type', 'עדות').field('fits_message', 'חשש').field('origin', 'חשבון אחר').attach('file', FILE, 'ref.mp4');
const refLease = () => W(request(app).post(`${WK}/references/lease`)).send({ workerId: 'w1' });
const post = (id, token, body) => W(request(app).post(`${WK}/references/${id}/analysis`)).set('X-Lease-Token', token).send(body);
const one = async id => (await request(app).get(R)).body.references.find(r => r.id === id);

describe('reference analysis: lease → file → analysis', () => {
  test('the worker API is closed without the worker token and nothing waits when nothing was uploaded', async () => {
    expect((await request(app).post(`${WK}/references/lease`).send({})).status).toBe(401);
    expect((await refLease()).status).toBe(204);
  });

  test('a link alone is never leased: the worker cannot fetch links, a file is needed', async () => {
    const a = await request(app).post(R).field('title', 'קישור').field('source_url', 'https://example.com/reel/1').field('by', 'Eden');
    expect(a.body.reference.status).toBe('link_only');
    expect((await refLease()).status).toBe(204);
    const again = await request(app).post(`${R}/${a.body.reference.id}/reanalyse`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('reference_file_missing');
  });

  test('an uploaded file is leased once, downloaded with the lease, analysed, and shown with example times', async () => {
    const id = (await addFile()).body.reference.id;
    const l = await refLease();
    expect(l.status).toBe(200);
    expect(l.body.reference).toEqual({ id, sha256: sha(FILE), ext: 'mp4', bytes: FILE.length, title: 'רפרנס קובץ', owner_note: 'אהבתי את הפתיחה ואת גודל הכתוביות',
      content_type: 'עדות', fits_message: 'חשש', usage_permission: 'inspiration_only', origin: 'חשבון אחר' });
    expect(l.body.leaseToken).toMatch(/^[0-9a-f]{48}$/);
    expect((await one(id)).status).toBe('analysing');
    expect(JSON.stringify(await one(id))).not.toContain(l.body.leaseToken);                 // the token never reaches the panel
    expect((await refLease()).status).toBe(204);                                            // not handed out twice
    // file: only with the lease
    expect((await W(request(app).get(`${WK}/references/${id}/file`))).status).toBe(409);
    expect((await W(request(app).get(`${WK}/references/${id}/file`)).set('X-Lease-Token', 'x'.repeat(48))).status).toBe(409);
    const f = await W(request(app).get(`${WK}/references/${id}/file`)).set('X-Lease-Token', l.body.leaseToken).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(f.status).toBe(200);
    expect(sha(f.body)).toBe(sha(FILE));
    expect(f.headers['x-content-sha256']).toBe(sha(FILE));
    // analysis: validated, stored as data
    expect((await post(id, 'x'.repeat(48), { status: 'analysed', analysis: ANALYSIS })).status).toBe(409);
    expect((await post(id, l.body.leaseToken, { status: 'analysed', analysis: 'text' })).body.error).toBe('analysis_invalid');
    expect((await post(id, l.body.leaseToken, { status: 'analysed', analysis: { ...ANALYSIS, proposed_profile: { params: 'big' } } })).body.error).toBe('analysis_invalid');
    expect((await post(id, l.body.leaseToken, { status: 'nope' })).body.error).toBe('analysis_invalid');
    const done = await post(id, l.body.leaseToken, { status: 'analysed', analysis: ANALYSIS });
    expect(done.body).toEqual({ ok: true, status: 'analysed' });
    const r = await one(id);
    expect(r).toMatchObject({ status: 'analysed', attempts: 1, profile: null, proposed_profile: ANALYSIS.proposed_profile });
    expect(r.analysis.aspects[0]).toEqual(ANALYSIS.aspects[0]);
    expect(r.analysis.measured.cuts_s).toEqual([4.2, 11.8]);
    expect((await post(id, l.body.leaseToken, { status: 'analysed', analysis: ANALYSIS })).status).toBe(409);   // the lease is spent
    // nothing was approved by the analysis
    expect(refs.profiles()).toEqual([]);
    expect(refs.defaultProfile()).toBeNull();
  });

  test('an expired lease returns the reference to the queue; after three attempts it is marked failed; the owner can ask again', async () => {
    process.env.DANA_LEASE_SECONDS = '0.05';
    boot();
    const id = (await addFile()).body.reference.id;
    const tokens = [];
    for (let n = 1; n <= 3; n++) {
      const l = await refLease();
      expect(l.status).toBe(200);
      tokens.push(l.body.leaseToken);
      await new Promise(r => setTimeout(r, 90));
      expect((await one(id)).status).toBe(n < 3 ? 'awaiting_analysis' : 'analysis_failed');
    }
    expect(new Set(tokens).size).toBe(3);
    expect((await post(id, tokens[2], { status: 'analysed', analysis: ANALYSIS })).status).toBe(409);            // too late
    expect((await refLease()).status).toBe(204);
    expect((await one(id)).analysisError).toMatchObject({ code: 'lease_expired' });
    const again = await request(app).post(`${R}/${id}/reanalyse`).send({});
    expect(again.body.reference).toMatchObject({ status: 'awaiting_analysis', attempts: 0 });
    expect((await refLease()).status).toBe(200);
  });

  test('a failure the worker reports is final unless it says it can be retried', async () => {
    const id = (await addFile()).body.reference.id;
    let l = await refLease();
    expect((await post(id, l.body.leaseToken, { status: 'failed', error: { code: 'model_unavailable', message: 'המודל לא זמין', retryable: true } })).body.status).toBe('awaiting_analysis');
    l = await refLease();
    expect((await post(id, l.body.leaseToken, { status: 'failed', error: { code: 'not_a_video', message: 'הקובץ אינו וידאו' } })).body.status).toBe('analysis_failed');
    expect(await one(id)).toMatchObject({ status: 'analysis_failed', attempts: 2, analysis: null, analysisError: { code: 'not_a_video', message: 'הקובץ אינו וידאו' } });
    expect((await refLease()).status).toBe(204);
  });
});

describe('the proposed profile: only the owner approves it', () => {
  async function analysed() {
    const id = (await addFile()).body.reference.id, l = await refLease();
    await post(id, l.body.leaseToken, { status: 'analysed', analysis: ANALYSIS });
    return id;
  }

  test('approval is refused before an analysis exists and needs a name', async () => {
    const id = (await addFile()).body.reference.id;
    expect((await request(app).post(`${R}/${id}/approve-profile`).send({ by: 'Eden' })).body.error).toBe('no_proposed_profile');
    expect((await request(app).post(`${R}/${id}/reject-profile`).send({ by: 'Eden' })).body.error).toBe('no_proposed_profile');
    const ok = await analysed();
    expect((await request(app).post(`${R}/${ok}/approve-profile`).send({})).body.error).toBe('by_required');
  });

  test('approve → a versioned profile with its source; it is sent with jobs only when made the default; re-approval is a new version', async () => {
    const id = await analysed();
    const a = await request(app).post(`${R}/${id}/approve-profile`).send({ by: 'Eden' });
    expect(a.status).toBe(200);
    expect(a.body.profile).toMatchObject({ id: `ref-${id}`, version: 1, params: ANALYSIS.proposed_profile.params, rules: ANALYSIS.proposed_profile.rules,
      source_reference: id, approved_by: 'Eden', approved_at: expect.any(String), default: false });
    expect(a.body.reference).toMatchObject({ status: 'approved', profile: { id: `ref-${id}`, version: 1 } });
    expect(refs.defaultProfile()).toBeNull();                                    // approved, but not a default unless the owner says so
    await request(app).post(`${S}/upload`).attach('video', crypto.randomBytes(4000), 'a.mp4');
    let job = (await W(request(app).post(`${WK}/lease`)).send({ workerId: 'w1' })).body.job;
    expect(job.options.profile).toBeUndefined();
    await W(request(app).post(`${WK}/jobs/${job.id}/fail`)).set('X-Lease-Token', (studio.state().jobs[job.id].lease.token)).send({ status: 'failure', code: 'x', message: 'x', retryable: false });

    // adjusted numbers: only what Dana proposed can be changed, with the same type
    expect((await request(app).post(`${R}/${id}/approve-profile`).send({ by: 'Eden', params: { evil: 1 } })).body.error).toBe('profile_params_invalid');
    expect((await request(app).post(`${R}/${id}/approve-profile`).send({ by: 'Eden', params: { caption_size: 'huge' } })).body.error).toBe('profile_params_invalid');
    const b = await request(app).post(`${R}/${id}/approve-profile`).send({ by: 'Eden', make_default: true, params: { caption_size: 112 } });
    expect(b.body.profile).toMatchObject({ id: `ref-${id}`, version: 2, default: true, adjusted: ['caption_size'], params: { ...ANALYSIS.proposed_profile.params, caption_size: 112 } });
    expect(refs.profiles().map(p => [p.id, p.version, p.default])).toEqual([[`ref-${id}`, 1, false], [`ref-${id}`, 2, true]]);   // history kept
    expect((await request(app).get(`${S}/profiles`)).body.default).toEqual({ id: `ref-${id}`, version: 2, params: { ...ANALYSIS.proposed_profile.params, caption_size: 112 },
      rules: ANALYSIS.proposed_profile.rules, source_reference: id });
    await request(app).post(`${S}/upload`).attach('video', crypto.randomBytes(4100), 'b.mp4');
    job = (await W(request(app).post(`${WK}/lease`)).send({ workerId: 'w1' })).body.job;
    expect(job.options.profile).toEqual({ id: `ref-${id}`, version: 2, params: { ...ANALYSIS.proposed_profile.params, caption_size: 112 },
      rules: ['לפתוח על המשפט החזק ביותר', 'עד שלוש מילים בשורה'], source_reference: id });
    expect((await one(id)).profile).toMatchObject({ version: 2 });
  });

  test('reject → nothing becomes a default and no profile is created', async () => {
    const id = await analysed();
    const r = await request(app).post(`${R}/${id}/reject-profile`).send({ by: 'Eden', reason: 'כתוביות גדולות מדי' });
    expect(r.body.reference).toMatchObject({ status: 'rejected', profile: null, decision: { action: 'rejected', by: 'Eden', reason: 'כתוביות גדולות מדי' } });
    expect(refs.profiles()).toEqual([]);
    expect(refs.defaultProfile()).toBeNull();
    // the owner can still ask for a new analysis
    expect((await request(app).post(`${R}/${id}/reanalyse`).send({})).body.reference.status).toBe('awaiting_analysis');
  });
});

// ── a finished version, for rules / previous / quality ──
const video = () => Buffer.concat([Buffer.from('fake-source-video-'), crypto.randomBytes(4096)]);
const lease = async () => (await W(request(app).post(`${WK}/lease`)).send({ workerId: 'w1', pipelineVersion: '1.1.0' })).body;
const get = async id => (await request(app).get(`${S}/projects/${id}`)).body.project;
function pkgFor(sourceSha, extra = {}) {
  return { pipeline_version: '1.0.0', status: 'success', source: { sha256: sourceSha, duration: 30 }, segment: { in_s: 3, out_s: 23, reason: 'test' },
    duration: 20, adapter: 'claude', judgement_mode: 'model',
    style: { caption_size: 96, caption_y_px: 1040, caption_max_lines: 2, backing: false, highlight_enabled: true, font_family: 'Heebo' },
    spoken_text: 'שלום לכולם זה מבחן',
    cards: [{ i: 1, text: 'שלום לכולם', lines: ['שלום', 'לכולם'], highlight: ['שלום'], start: 0, dur: 1.2, source_start_s: 3.0, source_end_s: 4.2 },
            { i: 2, text: 'זה מבחן', lines: ['זה מבחן'], highlight: [], start: 1.2, dur: 1, source_start_s: 4.2, source_end_s: 5.2 }],
    cover: { text: 'שלום', frame_s: 1 }, caption: { text: 'טיוטה', cta: null, is_draft: true }, checks: [{ id: 'sync_lead', status: 'pass', summary: 's' }],
    failed_checks: [], issues: [], timings_s: {}, total_s: 10,
    plan: { message: 'מסר', hook: 'פתיחה', rationale: 'נימוק', content_judgement: 'model', brief: ['שורה'], left_out: [{ source_in_s: 0, source_out_s: 3, why: 'הקדמה' }],
            segments: [{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20, role: 'hook', why: 'כי' }] },
    zooms: [{ id: 'z@4.2', source_t_s: 4.2, tl_t_s: 1.2, scale: 1.15, strength: 'medium', ease_s: 0.32, hold_until_s: 20, reason: 'משפט מפתח', evidence: 'rms' }],
    transcript: { status: 'auto_unverified', doubts: [], corrections_applied: [] },
    rules_used: { skill: { name: 'dana-editing', version: '0.2.0', sha256: 'a'.repeat(64) }, profile: { id: 'center-bold-v1', version: '1', sha256: 'b'.repeat(64) }, standing_rules: [], references: [] },
    ...extra };
}
async function finish(l, sourceSha, pkg) {
  const files = { 'final.mp4': crypto.randomBytes(3000), 'cover.jpg': crypto.randomBytes(500), 'package.json': Buffer.from(JSON.stringify(pkg ?? pkgFor(sourceSha))),
    'checks.json': Buffer.from('{"records":[]}'), 'captions.json': Buffer.from('[]') };
  for (const [name, buf] of Object.entries(files))
    expect((await W(request(app).put(`${WK}/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken)
      .set('X-Content-SHA256', sha(buf)).set('Content-Type', 'application/octet-stream').send(buf)).status).toBe(200);
  return W(request(app).post(`${WK}/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
}
async function ready(extra) {
  const up = await request(app).post(`${S}/upload`).attach('video', video(), `clip-${crypto.randomBytes(3).toString('hex')}.mp4`);
  const l = await lease();
  expect((await finish(l, up.body.project.source.sha256, pkgFor(up.body.project.source.sha256, extra))).status).toBe(200);
  return up.body.project.id;
}

describe('standing rules: version and source', () => {
  test('a rule records where it came from, rewording it is a new version, and jobs carry id + text + version of active rules only', async () => {
    const a = await ready();
    await request(app).post(`${S}/projects/${a}/revise`).send({ by: 'Eden', note: 'בלי אימוג׳י בכתוביות', note_scope: 'permanent' });
    let rules = (await request(app).get(`${S}/rules`)).body.rules;
    expect(rules).toHaveLength(1);
    const title = (await get(a)).title;
    expect(rules[0]).toMatchObject({ version: 1, status: 'active', text: 'בלי אימוג׳י בכתוביות',
      source: { project_id: a, project_title: title, version_n: 1, by: 'Eden', at: expect.any(String) }, history: [{ version: 1, action: 'created' }] });
    const la = await lease();
    expect(la.job.options.rules).toEqual([{ id: rules[0].id, text: 'בלי אימוג׳י בכתוביות', version: 1 }]);
    await finish(la, (await get(a)).source.sha256);

    expect((await request(app).post(`${S}/rules/${rules[0].id}`).send({ text: 'x', by: 'Eden' })).body.error).toBe('rule_invalid');
    expect((await request(app).post(`${S}/rules/${rules[0].id}`).send({ text: 'בלי אימוג׳י בכלל' })).body.error).toBe('by_required');
    expect((await request(app).post(`${S}/rules/nope`).send({ text: 'בלי אימוג׳י בכלל', by: 'Eden' })).status).toBe(404);
    rules = (await request(app).post(`${S}/rules/${rules[0].id}`).send({ text: 'בלי אימוג׳י בכלל', by: 'Dana-owner' })).body.rules;
    expect(rules[0]).toMatchObject({ version: 2, text: 'בלי אימוג׳י בכלל', source: { project_id: a, version_n: 1 } });      // the source does not move
    expect(rules[0].history.map(h => [h.version, h.text, h.action])).toEqual([[1, 'בלי אימוג׳י בכתוביות', 'created'], [2, 'בלי אימוג׳י בכלל', 'edited']]);
    // the same text again is not a new version
    expect((await request(app).post(`${S}/rules/${rules[0].id}`).send({ text: 'בלי אימוג׳י בכלל', by: 'Eden' })).body.rules[0].version).toBe(2);

    const b = await request(app).post(`${S}/upload`).attach('video', video(), 'other.mp4');
    const lb = await lease();
    expect(lb.job.options.rules).toEqual([{ id: rules[0].id, text: 'בלי אימוג׳י בכלל', version: 2 }]);
    await finish(lb, b.body.project.source.sha256);
    await request(app).post(`${S}/rules/${rules[0].id}/retire`).send({ by: 'Eden' });
    expect((await request(app).post(`${S}/rules/${rules[0].id}`).send({ text: 'משהו אחר', by: 'Eden' })).body.error).toBe('rule_retired');
    await request(app).post(`${S}/projects/${a}/revise`).send({ by: 'Eden', style_overrides: { caption_size: 100 } });
    expect((await lease()).job.options.rules).toBeUndefined();
  });

  test('a project-scope note never becomes a rule', async () => {
    const a = await ready();
    await request(app).post(`${S}/projects/${a}/revise`).send({ by: 'Eden', note: 'רק כאן: לקצר את הסוף', note_scope: 'project' });
    expect((await request(app).get(`${S}/rules`)).body.rules).toEqual([]);
    const l = await lease();
    expect(l.job.options.change_request).toBe('רק כאן: לקצר את הסוף');
    expect(l.job.options.rules).toBeUndefined();
  });

  test('a rule stored before versions existed is read as version 1 with its recorded source', async () => {
    fs.mkdirSync(path.join(process.env.DATA_DIR, 'dana'), { recursive: true });
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'dana', 'rules.json'), JSON.stringify({ rules: [
      { id: 'rule_old', text: 'כלל ישן', status: 'active', by: 'Eden', at: '2026-11-15T10:00:00.000Z', projectId: 'prj_x', retiredBy: null, retiredAt: null }] }));
    const r = (await request(app).get(`${S}/rules`)).body.rules[0];
    expect(r).toMatchObject({ id: 'rule_old', version: 1, history: [], source: { project_id: 'prj_x', project_title: null, version_n: null, by: 'Eden', at: '2026-11-15T10:00:00.000Z' } });
    expect(studio.activeRules()).toEqual([{ id: 'rule_old', text: 'כלל ישן', version: 1 }]);
  });
});

describe('a revision carries the previous version, and a note only when the owner wrote one', () => {
  test('edits without a note: the whole previous package parts travel, and there is NO change_request', async () => {
    const a = await ready();
    const before = (await get(a)).version.package;
    const r = await request(app).post(`${S}/projects/${a}/revise`).send({ by: 'Eden', style_overrides: { caption_size: 104 },
      caption_edits: [{ source_start_s: 4.2, source_end_s: 5.2, original: 'זה מבחן', text: 'זה מבחן אמיתי' }], zoom_edits: [{ id: 'z@4.2', action: 'remove' }] });
    expect(r.status).toBe(200);
    const o = (await lease()).job.options;
    expect(o.change_request).toBeUndefined();
    expect('change_request' in o).toBe(false);
    expect(o.previous.cards).toEqual([
      { i: 1, text: 'שלום לכולם', lines: ['שלום', 'לכולם'], highlight: ['שלום'], start: 0, dur: 1.2, source_start_s: 3.0, source_end_s: 4.2 },
      { i: 2, text: 'זה מבחן', lines: ['זה מבחן'], highlight: [], start: 1.2, dur: 1, source_start_s: 4.2, source_end_s: 5.2 }]);
    expect(o.previous).toMatchObject({ segment: { in_s: 3, out_s: 23 }, cover: { text: 'שלום', frame_s: 1 }, caption: { text: 'טיוטה', cta: null }, judgement_mode: 'model',
      style: before.style, plan: before.plan, zooms: before.zooms,
      story_plan: { message: 'מסר', hook: 'פתיחה', segments: [{ in_s: 3, out_s: 23, role: 'hook' }], zooms: [{ at_s: 4.2, strength: 'medium', reason: 'משפט מפתח' }], cover_quote: 'שלום' } });
    expect(o.previous.plan.segments).toEqual([{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20, role: 'hook', why: 'כי' }]);
    expect(o).toMatchObject({ style_overrides: { caption_size: 104 }, zoom_edits: [{ id: 'z@4.2', action: 'remove' }], caption_edits: [{ text: 'זה מבחן אמיתי' }] });
  });

  test('a note (either scope) is the only thing that produces change_request; request-changes carries the same previous', async () => {
    const a = await ready(), b = await ready(), c = await ready();
    await request(app).post(`${S}/projects/${a}/revise`).send({ by: 'Eden', note: 'לפתוח על משפט אחר', note_scope: 'project', style_overrides: { caption_size: 100 } });
    const la = await lease();
    expect(la.job.options).toMatchObject({ change_request: 'לפתוח על משפט אחר', previous: { plan: { message: 'מסר' }, zooms: [{ id: 'z@4.2' }] } });
    await finish(la, (await get(a)).source.sha256);
    await request(app).post(`${S}/projects/${b}/request-changes`).send({ note: 'לקצר' });
    const lb = await lease();
    expect(lb.job.options).toMatchObject({ change_request: 'לקצר', previous: { cards: [{ i: 1, source_start_s: 3.0 }, { i: 2 }], plan: { hook: 'פתיחה' }, zooms: [{ scale: 1.15 }], style: { caption_size: 96 } } });
    await finish(lb, (await get(b)).source.sha256);
    await request(app).post(`${S}/projects/${c}/request-changes`).send({ style_overrides: { caption_size: 110 } });
    const lc = await lease();
    expect('change_request' in lc.job.options).toBe(false);
    expect(lc.job.options.previous.zooms).toHaveLength(1);
  });

  test('previous is capped at 200 KB: long text is dropped, never segments, zooms or cards', async () => {
    const big = 'ש'.repeat(150 * 1024);                                         // ~300 KB of UTF-8
    const a = await ready({ plan: { message: 'מסר', hook: 'פתיחה', rationale: big, content_judgement: 'model', brief: [big.slice(0, 1000)],
      segments: [{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20, role: 'hook', why: 'כי' }] } });
    await request(app).post(`${S}/projects/${a}/revise`).send({ by: 'Eden', style_overrides: { caption_size: 104 } });
    const prev = (await lease()).job.options.previous;
    expect(Buffer.byteLength(JSON.stringify(prev))).toBeLessThanOrEqual(200 * 1024);
    expect(prev.plan.rationale).toBeUndefined();
    expect(prev.plan.segments).toHaveLength(1);
    expect(prev.plan.message).toBe('מסר');
    expect(prev.zooms).toHaveLength(1);
    expect(prev.cards).toHaveLength(2);
  });

  test('a retried revision keeps the previous version it was based on', async () => {
    const a = await ready();
    await request(app).post(`${S}/projects/${a}/revise`).send({ by: 'Eden', style_overrides: { caption_size: 104 } });
    const l = await lease();
    await W(request(app).post(`${WK}/jobs/${l.job.id}/fail`)).set('X-Lease-Token', l.leaseToken).send({ status: 'failure', code: 'render_failed', message: 'x', retryable: false });
    expect((await request(app).post(`${S}/projects/${a}/retry`).send({})).status).toBe(200);
    const again = (await lease()).job.options;
    expect(again.previous.plan.message).toBe('מסר');
    expect('change_request' in again).toBe(false);
  });
});

describe('quality is shown as it was sent — three separate things, no single score', () => {
  const QUALITY = { technical: { passed: 14, failed: 1, warned: 1, failed_ids: ['caption_text'] },
    content_review: { met: 12, total: 14, not_met: [{ id: 'A9', note: 'אין טקסט קאבר' }], basis: 'תמלול ופריימים בודדים' },
    owner_needed: { listening_doubts: 5, review_items: 1, human_checks: ['listening', 'framing', 'meaning'] }, not_verified: ['תנועת הזום בזמן אמת', 'התמלול מול האודיו'] };

  test('quality and revision_mode pass through unchanged; an old package has neither', async () => {
    const a = await ready({ quality: QUALITY, revision_mode: 'locked_to_previous_plan',
      issues: [{ code: 'owner_correction_kept', severity: 'info', message: 'התיקון שלך נשמר; התמלול החוזר שמע אחרת' }] });
    const p = await get(a);
    expect(p.version.package.quality).toEqual(QUALITY);
    expect(p.version.package.revisionMode).toBe('locked_to_previous_plan');
    expect(p.versions[0].revisionMode).toBe('locked_to_previous_plan');
    expect(p.version.package.issues).toEqual([{ code: 'owner_correction_kept', severity: 'info', message: 'התיקון שלך נשמר; התמלול החוזר שמע אחרת' }]);
    const b = await get(await ready());
    expect(b.version.package.quality).toBeNull();
    expect(b.version.package.revisionMode).toBeNull();
    expect(b.versions[0].revisionMode).toBeNull();
  });
});
