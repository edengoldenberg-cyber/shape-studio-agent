'use strict';
/**
 * Dana round 2 on the server: verify-and-save a caption, measured progress, review-only projects and
 * "apply improvements", per-project settings (connected account, adjustment switches), comparing references
 * and a combined profile. Isolated temp DATA_DIR; the worker is simulated over the real routes.
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const TOKEN = 'test-worker-token-0123456789abcdef';
const S = '/api/dana/studio';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const W = r => r.set('Authorization', `Bearer ${TOKEN}`);

let app, studio, refs;
beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-round2-'));
  process.env.DANA_WORKER_TOKEN = TOKEN;
  delete process.env.DANA_PUBLISHING_ENABLED; delete process.env.DANA_NOTIFY_REAL; delete process.env.DANA_PUBLISHER_MODE;
  jest.resetModules();
  studio = require('../services/dana_studio'); refs = require('../services/dana_references');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express();
  app.use('/api/dana/worker', workerRouter);
  app.use(S, panelRouter);
  studio.reconcileOnStartup();
});

const upload = (options, name = `clip-${crypto.randomBytes(3).toString('hex')}.mp4`) => {
  const r = request(app).post(`${S}/upload`).attach('video', Buffer.concat([Buffer.from('fake-source-video-'), crypto.randomBytes(4096)]), name);
  return options ? r.field('options', JSON.stringify(options)) : r;
};
const lease = async () => (await W(request(app).post('/api/dana/worker/lease')).send({ workerId: 'w1', pipelineVersion: '1.1.0' })).body;
const get = async id => (await request(app).get(`${S}/projects/${id}`)).body.project;
const post = (p, body) => request(app).post(S + p).send(body);

const REVIEW = { rubric_version: 'r1', categories: [{ key: 'sound', label: 'סאונד', level: 'דורש שיפור', met: 1, decided: 2, not_checked: 1, criteria: [] }],
  improvements: [{ id: 'c:A1', importance: 1, kind: 'technical_defect', category: 'sound', problem: 'p', correction: 'c', can_apply: true }] };
function pkgFor(sourceSha, extra = {}) {
  return { pipeline_version: '1.1.0', status: 'success', source: { sha256: sourceSha, duration: 30 }, segment: { in_s: 0, out_s: 20, reason: 't' }, duration: 20, adapter: 'claude',
    judgement_mode: 'model', style: { caption_size: 96, caption_y_px: 960, backing: false, highlight_enabled: true, font_family: 'Heebo', caption_animation: 'rise' },
    spoken_text: 'שלום לכולם זה מבחן',
    plan: { message: 'מסר', hook: 'פתיחה', rationale: 'נימוק', content_judgement: 'model', brief: [], segments: [{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20, role: 'hook', why: 'כי' }] },
    cards: [{ i: 1, text: 'שלום לכולם', highlight: [], start: 0, dur: 1.2, source_start_s: 3.0, source_end_s: 4.2 }, { i: 2, text: 'זה מבחן', highlight: [], start: 1.2, dur: 1, source_start_s: 4.2, source_end_s: 5.2 }],
    zooms: [], graphics: [], cover: { text: 'שלום', frame_s: 1 }, caption: { text: 'טיוטה', cta: null }, checks: [{ id: 'sync_lead', status: 'pass', summary: 's' }], failed_checks: [], issues: [],
    transcript: { status: 'auto_unverified', doubts: [], corrections_applied: [] }, dana_review: REVIEW, timings_s: { plan: 30, render_base: 20, review: 10 }, total_s: 60, ...extra };
}
async function finish(l, sourceSha, pkg, { review = false } = {}) {
  const files = { 'cover.jpg': crypto.randomBytes(500), 'package.json': Buffer.from(JSON.stringify(pkg ?? pkgFor(sourceSha))), 'checks.json': Buffer.from('{"records":[]}'),
    ...(review ? {} : { 'final.mp4': crypto.randomBytes(3000), 'captions.json': Buffer.from('[]'), 'compare_frames.jpg': crypto.randomBytes(300), 'compare_clip.mp4': crypto.randomBytes(300) }) };
  for (const [name, buf] of Object.entries(files))
    expect((await W(request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken)
      .set('X-Content-SHA256', sha(buf)).set('Content-Type', 'application/octet-stream').send(buf)).status).toBe(200);
  return W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
}
async function ready(pkgExtra, options) {
  const up = await upload(options); const l = await lease();
  expect((await finish(l, up.body.project.source.sha256, pkgFor(up.body.project.source.sha256, pkgExtra))).status).toBe(200);
  return { id: up.body.project.id, sha: up.body.project.source.sha256, job: l.job };
}

describe('"אמת ושמור תיקון": correct, listen, verify', () => {
  const span = { source_start_s: 4.2, source_end_s: 5.2, original: 'זה מבחן' };

  test('every caption starts unchecked; verifying needs a name and a listen', async () => {
    const { id } = await ready();
    expect((await get(id)).cardStates.map(c => c.status)).toEqual(['unchecked', 'unchecked']);
    expect((await post(`/projects/${id}/captions/verify`, { ...span, text: 'זה מבחן', listened: true })).body.error).toBe('by_required');
    expect((await post(`/projects/${id}/captions/verify`, { ...span, text: 'זה מבחן', by: 'עדן' })).body.error).toBe('listen_required');
  });

  test('a caption confirmed as written is verified; nothing is rendered and nothing is approved', async () => {
    const { id } = await ready();
    const r = await post(`/projects/${id}/captions/verify`, { ...span, text: 'זה מבחן', by: 'עדן', listened: true });
    expect(r.status).toBe(200);
    expect(r.body.project.cardStates[1]).toMatchObject({ status: 'verified', original: null, inVideo: true, by: 'עדן' });
    expect(r.body.project).toMatchObject({ currentVersion: 1, pendingCorrections: 0, status: 'ready_for_review' });
    expect(r.body.project.version.approval).toBeNull();
  });

  test('a correction keeps before/after, waits for the next version, travels with the job and drops an approval', async () => {
    const { id } = await ready();
    let p = await get(id);
    await post(`/projects/${id}/approve`, { fingerprint: p.version.fingerprint, by: 'עדן' });
    const r = await post(`/projects/${id}/captions/verify`, { ...span, text: 'זה המבחן', by: 'עדן', listened: true });
    expect(r.body.project.cardStates[1]).toMatchObject({ status: 'verified', original: 'זה מבחן', saved: 'זה המבחן', inVideo: false });
    expect(r.body.project).toMatchObject({ pendingCorrections: 1, status: 'ready_for_review' });
    expect(r.body.project.version.approval).toBeNull();                       // the approved video does not show the verified text
    expect(r.body.project.nextAction.key).toBe('render_corrections');
    const rv = await post(`/projects/${id}/revise`, { by: 'עדן' });            // no other change: the saved correction is enough
    expect(rv.body.project.currentVersion).toBe(2);
    const l = await lease();
    expect(l.job.options.caption_edits).toEqual([expect.objectContaining({ source_start_s: 4.2, source_end_s: 5.2, original: 'זה מבחן', text: 'זה המבחן', status: 'verified' })]);
    expect(l.job.options.change_request).toBeUndefined();                     // no note → the worker locks the revision to the previous plan
    expect(l.job.options.previous.cards).toHaveLength(2);
  });

  test('a corrected-then-rendered caption shows as in the video; a later job still carries it', async () => {
    const { id, sha: s } = await ready();
    await post(`/projects/${id}/captions/verify`, { ...span, text: 'זה המבחן', by: 'עדן', listened: true });
    await post(`/projects/${id}/revise`, { by: 'עדן' });
    const l = await lease();
    const pk = pkgFor(s); pk.cards[1].text = 'זה המבחן';
    await finish(l, s, pk);
    const p = await get(id);
    expect(p.cardStates[1]).toMatchObject({ status: 'verified', inVideo: true, original: 'זה מבחן' });
    expect(p.pendingCorrections).toBe(0);
    await post(`/projects/${id}/revise`, { by: 'עדן', style_overrides: { caption_size: 80 } });
    expect((await lease()).job.options.caption_edits).toHaveLength(1);        // a re-transcription cannot lose it: it is sent again
  });

  test("a correction Dana derived from the owner's free-text request is stored as corrected, not as verified", async () => {
    const { id, sha: s } = await ready();
    await post(`/projects/${id}/revise`, { by: 'עדן', note: 'במקום מבחן צריך להיות המבחן', note_scope: 'project' });
    const l = await lease();
    expect(l.job.options.change_request).toBe('במקום מבחן צריך להיות המבחן');
    const pk = pkgFor(s, { revision_mode: 'locked_to_previous_plan', request_interpretation: { mode: 'targeted', domains: ['captions_text'], needs_replan: false,
      caption_edits: [{ source_start_s: 4.2, source_end_s: 5.2, original: 'זה מבחן', text: 'זה המבחן' }] } });
    pk.cards[1].text = 'זה המבחן';
    await finish(l, s, pk);
    const p = await get(id);
    expect(p.cardStates[1]).toMatchObject({ status: 'corrected', from: 'owner_request', inVideo: true });
    expect(p.version.package.requestInterpretation.mode).toBe('targeted');
    expect((await request(app).get(`${S}/rules`)).body.rules).toEqual([]);     // a project-only note never becomes a rule
  });
});

describe('progress: measured stages, a labelled estimate, 100% only when the package is there', () => {
  test('queued → no percentage; running → estimated and below 100; ready → 100 measured', async () => {
    await ready();                                                             // an earlier edit to learn stage times from
    const up = await upload(); const id = up.body.project.id;
    let p = await get(id);
    expect(p.progress).toMatchObject({ phase: null, percent: null });
    expect(p.nextAction.key).toBe('wait');
    const l = await lease();
    const prog = (stage, note) => W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/progress`)).set('X-Lease-Token', l.leaseToken).send({ stage, note });
    await prog('transcribe_source', 'מתמלל');
    p = await get(id);
    expect(p.progress).toMatchObject({ phase: 'transcribe', percentBasis: 'estimated', stage: 'transcribe_source' });
    expect(p.progress.percentNote).toMatch(/משוער/);
    const early = p.progress.percent;
    await prog('plan', 'מתכנן'); await prog('render_base', 'חותך'); await prog('review', 'בודק');
    p = await get(id);
    expect(p.progress.phase).toBe('review');
    expect(p.progress.percent).toBeGreaterThan(early);
    expect(p.progress.percent).toBeLessThan(100);
    expect(p.progress.phases.map(x => x.state)).toEqual(['done', 'done', 'done', 'done', 'current', 'todo', 'todo']);
    expect(typeof p.progress.elapsedS).toBe('number');
    await prog('revise', 'מתקן'); await prog('composite_1', 'מרכיב');
    expect((await get(id)).progress).toMatchObject({ phase: 'fixes', percent: null });   // no invented percentage for a correction round                      // an edit stage after a revision is the "fixes" phase
    await finish(l, up.body.project.source.sha256);
    p = await get(id);
    expect(p.progress).toMatchObject({ phase: 'ready', percent: 100, percentBasis: 'measured' });
  });

  test('a failure shows the reason and can be retried', async () => {
    const up = await upload(); const id = up.body.project.id; const l = await lease();
    await W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/fail`)).set('X-Lease-Token', l.leaseToken).send({ status: 'failure', code: 'render_failed', message: 'ffmpeg exited 1', retryable: false });
    const p = await get(id);
    expect(p.job.error).toMatchObject({ code: 'render_failed', message: 'ffmpeg exited 1' });
    expect(p.nextAction.key).toBe('retry');
    expect(p.progress.percent).toBeNull();
    expect((await post(`/projects/${id}/retry`, {})).body.project.currentVersion).toBe(2);
  });
});

describe('project settings: a connected account and adjustment switches', () => {
  test('pilates_barre_power is listed as connected and verified, and can be chosen for a project', async () => {
    const st = (await request(app).get(`${S}/status`)).body;
    expect(st.accounts).toEqual([expect.objectContaining({ username: 'pilates_barre_power', platform: 'instagram', verifiedAt: '2026-11-15' })]);
    expect(st.publishingEnabled).toBe(false);
    expect((await upload({ account: 'someone_else' })).body.error).toBe('account_unknown');
    const { id } = await ready(undefined, { account: 'pilates_barre_power' });
    const p = await get(id);
    expect(p.account).toBe('pilates_barre_power');
    expect(p.version.destination.account).toBe('pilates_barre_power');
    expect(p.publication.allowed).toBe(false);                                // choosing an account publishes nothing
  });

  test('changing the account of an approved version drops the approval', async () => {
    const { id } = await ready();
    let p = await get(id);
    await post(`/projects/${id}/approve`, { fingerprint: p.version.fingerprint, by: 'עדן' });
    const r = await request(app).patch(`${S}/projects/${id}/settings`).send({ account: 'pilates_barre_power' });
    expect(r.body.project.version.destination.account).toBe('pilates_barre_power');
    expect(r.body.project.version.approval).toBeNull();
  });

  test('every kind of adjustment can be switched off; the switch travels with the next job; unknown kinds are refused', async () => {
    const { id } = await ready();
    expect(Object.keys((await get(id)).adjustmentKinds)).toEqual(['color', 'audio_cleanup', 'zooms', 'caption_animation', 'graphics']);
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', adjustments: { sparkle: false } })).body.error).toBe('adjustments_invalid');
    const r = await post(`/projects/${id}/revise`, { by: 'עדן', adjustments: { color: false, graphics: false } });
    expect(r.body.project.currentVersion).toBe(2);
    const l = await lease();
    expect(l.job.options.adjustments).toEqual({ color: false, graphics: false });
    expect(l.job.options.change_request).toBeUndefined();
    expect((await post(`/projects/${id}/revise`, { by: 'עדן' })).status).toBe(409);   // a job is running
  });

  test('new style keys are validated', async () => {
    const { id } = await ready();
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', style_overrides: { caption_animation: 'spin' } })).body.error).toBe('style_override_invalid');
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', style_overrides: { caption_ink: 'red' } })).body.error).toBe('style_override_invalid');
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', style_overrides: { caption_animation: 'fade', caption_highlight: '#FF00AA' } })).status).toBe(200);
  });
});

describe('an edited video submitted for Dana\'s review, and "apply improvements"', () => {
  const reviewPkg = s => ({ pipeline_version: '1.1.0', kind: 'review_only', status: 'success', judgement_mode: 'review_only', source: { sha256: s, duration: 23 }, duration: 23,
    transcript: { status: 'auto_unverified', text: 'מה שנאמר' }, burned_in_text: { present: true, examples: [] }, dana_review: REVIEW,
    dana_can_apply: [{ id: 'loudness', what: 'נרמול עוצמה', evidence: '-19 LUFS' }], polish_options: { burned_in_text: true, add_captions: false }, checks: [], failed_checks: [], review_items: [], issues: [], total_s: 40 });

  test('review-only: a review job, no edit; the uploaded file is the video; it cannot be approved or revised', async () => {
    const up = await upload({ kind: 'review_only' }); const id = up.body.project.id, s = up.body.project.source.sha256;
    expect(up.body.project.kind).toBe('review_only');
    const l = await lease();
    expect(l.job.type).toBe('review');
    expect((await finish(l, s, reviewPkg(s), { review: true })).status).toBe(200);        // no final.mp4 is required
    const p = await get(id);
    expect(p).toMatchObject({ status: 'reviewed', kind: 'review_only' });
    expect(p.version).toMatchObject({ kind: 'review_only', hasVideo: true });
    expect(p.version.package.danaReview.categories[0].level).toBe('דורש שיפור');
    expect(p.nextAction.key).toBe('apply_review');
    const vid = await request(app).get(`${S}/projects/${id}/versions/1/video`).set('Range', 'bytes=0-9');
    expect(vid.status).toBe(206);                                             // served from the uploaded source
    expect((await post(`/projects/${id}/approve`, { fingerprint: 'x', by: 'עדן' })).status).toBe(409);
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', note: 'x', note_scope: 'project' })).body.error).toBe('review_only');
  });

  test('"apply improvements" on a reviewed upload queues an EDIT that keeps the owner\'s content (polish) and keeps both versions', async () => {
    const up = await upload({ kind: 'review_only' }); const id = up.body.project.id, s = up.body.project.source.sha256;
    await finish(await lease(), s, reviewPkg(s), { review: true });
    expect((await post(`/projects/${id}/apply-review`, {})).body.error).toBe('by_required');
    const r = await post(`/projects/${id}/apply-review`, { by: 'עדן' });
    expect(r.body.project).toMatchObject({ currentVersion: 2, status: 'editing' });
    const l = await lease();
    expect(l.job.type).toBe('edit');
    expect(l.job.options.polish).toEqual({ burned_in_text: true, add_captions: false });
    await finish(l, s, pkgFor(s, { revision_mode: 'polish', review_vs_previous: [{ key: 'sound', label: 'סאונד', before: { level: 'דורש שיפור', met: 1, decided: 2 }, after: { level: 'תקין', met: 2, decided: 2 } }] }));
    const p = await get(id);
    expect(p.versions.map(v => [v.n, v.kind, v.hasVideo])).toEqual([[1, 'review_only', true], [2, 'edit', true]]);
    expect(p.version).toMatchObject({ hasCompare: true, hasCompareClip: true });
    expect(p.version.package.reviewVsPrevious[0].after.level).toBe('תקין');
    expect((await request(app).get(`${S}/projects/${id}/versions/2/compare-frames`)).status).toBe(200);
  });

  test("on Dana's own edit it keeps the plan and lets the editor act on the review; with nothing to apply it says so", async () => {
    const { id } = await ready();
    const r = await post(`/projects/${id}/apply-review`, { by: 'עדן' });
    expect(r.body.project.currentVersion).toBe(2);
    const l = await lease();
    expect(l.job.options).toMatchObject({ apply_review: true });
    expect(l.job.options.previous.dana_review).toEqual({ rubric_version: 'r1', categories: [{ key: 'sound', label: 'סאונד', level: 'דורש שיפור', met: 1, decided: 2 }] });
    expect(l.job.options.change_request).toBeUndefined();
    for (const j of Object.values(studio.state().jobs)) j.status = 'succeeded';
    const clean = await ready({ dana_review: { ...REVIEW, improvements: [{ id: 'x', can_apply: false }] } });
    expect((await post(`/projects/${clean.id}/apply-review`, { by: 'עדן' })).body.error).toBe('nothing_to_apply');
  });
});

describe('comparing references and a combined profile', () => {
  const analysis = (size, basis) => ({ summary: 's', aspects: [{ aspect: 'captions', observation: 'o', rule: 'r', basis, example_times_s: [1] }, { aspect: 'zooms', observation: 'z', rule: 'r', basis: 'measured', example_times_s: [] }],
    measured: { duration_s: 30, cut_count: 4 }, coverage: { not_done: ['x'] }, fits_us: ['a'], does_not_fit_us: ['b'],
    proposed_profile: { params: { caption_size: size, ...(size > 100 ? { zoom_scale_light: 1.1 } : {}) }, rules: [`כלל ${size}`] } });
  async function analysed(size, basis) {
    const r = await request(app).post(`${S}/references`).field('title', `ref ${size}`).field('by', 'עדן').field('owner_note', 'אהבתי').attach('file', crypto.randomBytes(2000), `r${size}.mp4`);
    const l = (await W(request(app).post('/api/dana/worker/references/lease')).send({ workerId: 'w1' })).body;
    await W(request(app).post(`/api/dana/worker/references/${l.reference.id}/analysis`)).set('X-Lease-Token', l.leaseToken).send({ status: 'analysed', analysis: analysis(size, basis) });
    return r.body.reference.id;
  }

  test('compare needs two analysed references; the proposal says what each suggests and on what basis', async () => {
    const a = await analysed(90, 'seen_in_stills'), b = await analysed(120, 'measured');
    expect((await post('/references/compare', { ids: [a] })).body.error).toBe('compare_needs_two');
    const c = (await post('/references/compare', { ids: [a, b] })).body.comparison;
    expect(c.references.map(r => r.owner_note)).toEqual(['אהבתי', 'אהבתי']);
    expect(c.aspects.find(x => x.aspect === 'captions').by_reference.map(x => x.basis)).toEqual(['seen_in_stills', 'measured']);
    expect(c.proposal.params.caption_size).toMatchObject({ suggested: b, options: [{ ref: a, value: 90, basis: 'seen_in_stills' }, { ref: b, value: 120, basis: 'measured' }] });
    expect(c.proposal.params.zoom_scale_light).toMatchObject({ suggested: b, why: 'רק רפרנס אחד נותן את המספר הזה' });
    expect(refs.defaultProfile()).toBeNull();                                  // a proposal is not a default
  });

  test('equally founded numbers are left for the owner; approval is versioned, records each source and is used by the next job only as default', async () => {
    const a = await analysed(90, 'measured'), b = await analysed(120, 'measured');
    const c = (await post('/references/compare', { ids: [a, b] })).body.comparison;
    expect(c.proposal.params.caption_size.suggested).toBeNull();
    expect((await post('/profiles/combined', { ids: [a, b], picks: { caption_size: a } })).body.error).toBe('by_required');
    expect((await post('/profiles/combined', { by: 'עדן', ids: [a, b], picks: { caption_size: 'ref_x' } })).body.error).toBe('picks_invalid');
    const r1 = await post('/profiles/combined', { by: 'עדן', ids: [a, b], picks: { caption_size: a, zoom_scale_light: b }, rules: [{ ref: b, index: 0 }] });
    expect(r1.status).toBe(201);
    expect(r1.body.profile).toMatchObject({ id: 'combined', version: 1, default: false, params: { caption_size: 90, zoom_scale_light: 1.1 }, rules: ['כלל 120'],
      param_sources: { caption_size: { ref: a }, zoom_scale_light: { ref: b } }, source_references: [a, b], approved_by: 'עדן' });
    await upload();
    expect((await lease()).job.options.profile).toBeUndefined();              // approved, but not the default
    const r2 = await post('/profiles/combined', { by: 'עדן', ids: [a, b], picks: { caption_size: b }, make_default: true });
    expect(r2.body.profile).toMatchObject({ version: 2, default: true });
    expect(refs.profiles().filter(p => p.id === 'combined').map(p => p.version)).toEqual([1, 2]);   // every version is kept
    const st = studio.state(); for (const j of Object.values(st.jobs)) j.status = 'succeeded';
    await upload();
    expect((await lease()).job.options.profile).toMatchObject({ id: 'combined', version: 2, params: { caption_size: 120 }, source_reference: b });
  });
});
