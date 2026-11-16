'use strict';
/**
 * Dana — rating an EXISTING final file on the server: a 'rereview' job is about one stored file (by SHA-256), it creates no
 * version and changes no video; every review of a version is kept in a history; a mark that does not follow from its
 * criteria, or a rating of another file, is refused. Isolated temp DATA_DIR; the worker is simulated.
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
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-rating-'));
  process.env.DANA_WORKER_TOKEN = TOKEN;
  delete process.env.DANA_PUBLISHING_ENABLED; delete process.env.DANA_NOTIFY_REAL; delete process.env.DANA_PUBLISHER_MODE;
  jest.resetModules();
  studio = require('../services/dana_studio');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express(); app.use('/api/dana/worker', workerRouter); app.use(S, panelRouter);
  studio.reconcileOnStartup();
});
const post = (p, body) => request(app).post(S + p).send(body);
const get = async (id, n) => (await request(app).get(`${S}/projects/${id}${n ? `?version=${n}` : ''}`)).body.project;
const lease = async () => (await W(request(app).post('/api/dana/worker/lease')).send({ workerId: 'w1', pipelineVersion: '1.4.0' })).body;
const upload = () => request(app).post(`${S}/upload`).field('options', '{}').attach('video', Buffer.concat([Buffer.from('src-'), crypto.randomBytes(4096)]), `c-${crypto.randomBytes(3).toString('hex')}.mp4`);

const row = (id, category, status, basis = 'measured') => ({ id, category, criterion: id, status, basis, note: 'n', time_s: null });
const CATS = (extra = []) => [{ key: 'message', label: 'מסר', level: 'תקין', met: 1, decided: 1, not_checked: 0, criteria: [row('M1', 'message', 'met', 'model')] },
  { key: 'sync', label: 'סנכרון', level: 'דורש שיפור', met: 1, decided: 2, not_checked: 0, criteria: [row('Y1', 'sync', 'not_met'), row('Y2', 'sync', 'met'), ...extra] }];
const REVIEW = (rubric, cats = CATS()) => ({ rubric_version: rubric, kind: 'edit', categories: cats, improvements: [{ id: 'c:Y1', criterion_id: 'Y1', category: 'sync', problem: 'סנכרון', can_apply: true, importance: 1 }] });
const FINAL = { title: 'הביקורת הסופית של דנה', verdict: 'needs_fix', skills: [{ name: 'dana-review', version: 'r1', role: 'סקיל הביקורת' }], coverage: { criteria: 3, decided: 3 } };
let VIDEO;
function pkgFor(s, final) {
  return { pipeline_version: '1.4.0', status: 'success', source: { sha256: s, duration: 30 }, segment: { in_s: 0, out_s: 20 }, duration: 20, adapter: 'claude', judgement_mode: 'model',
    style: { caption_size: 96 }, spoken_text: 'שלום', cards: [{ i: 1, text: 'שלום לכולם', highlight: [], start: 0, dur: 1.2, source_start_s: 3, source_end_s: 4.2 }], zooms: [], cover: { text: 'שלום', frame_s: 1 },
    caption: { text: 'טיוטה', cta: null }, checks: [], failed_checks: [], issues: [], rules_used: { skill: { name: 'dana-editing', version: '0.1.0' }, references: [] }, timings_s: {}, total_s: 10,
    dana_review: REVIEW('r1'), final_review: FINAL, review_compact: { rubric_version: 'r1' },
    review_provenance: { reviewed_at: '2026-11-16T16:12:37+0200', final_sha256: final, on_delivered_file: true, review_rounds: 1 } };
}
async function deliver() {
  const up = await upload(), l = await lease();
  VIDEO = crypto.randomBytes(3000);
  const files = { 'final.mp4': VIDEO, 'cover.jpg': crypto.randomBytes(500), 'package.json': Buffer.from(JSON.stringify(pkgFor(up.body.project.source.sha256, sha(VIDEO)))),
    'checks.json': Buffer.from('{"records":[]}'), 'captions.json': Buffer.from('[]') };
  for (const [name, buf] of Object.entries(files))
    await W(request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken).set('X-Content-SHA256', sha(buf)).set('Content-Type', 'application/octet-stream').send(buf);
  expect((await W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' })).status).toBe(200);
  return up.body.project.id;
}
/** What the worker's rating module returns for the stored file: the criteria in force, the mark computed from them. */
function rating(file, version, over = {}) {
  const cats = CATS([row('Y9', 'sync', 'met')]);                  // one criterion the newer rubric added
  const groups = [{ key: 'message_opening', label: 'מסר ופתיחה', score: 100, met: 1, decided: 1 }, { key: 'captions_sync', label: 'כתוביות וסנכרון', score: 67, met: 2, decided: 3 },
    { key: 'visual', label: 'עריכה חזותית וגרפיקה', score: null, met: 0, decided: 0 }];
  const dana_review = REVIEW('r2', cats);
  return { schema: 1, mode: 'rubric_upgrade', version, file_sha256: file, rated_at: '2026-11-16T22:00:00+0200', measured_at: '2026-11-16T16:12:37+0200', rubric_version: 'r2', score_version: 's1',
    skills: [{ name: 'dana-review', version: 'r2', role: 'סקיל הביקורת' }], model_called: false, rendered: false, dana_review,
    final_review: { ...FINAL, rubric_version: 'r2', file_sha256: file, score: { version: 's1', overall: 84, out_of: 100, groups, coverage: { decided: 4, applicable: 4 } },
      next_steps: { dana: [], owner: [], blockers: [], open_items: 0, apply: { count: 0, replan: 0, text: '' } }, same_file: { text: 'הקריטריונים עודכנו', criteria: [] } },
    review_compact: { rubric_version: 'r2' }, review_provenance: { reviewed_at: '2026-11-16T16:12:37+0200', final_sha256: file, on_delivered_file: true, rated_at: '2026-11-16T22:00:00+0200' }, ...over };
}
const submit = (l, review) => W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/review-result`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success', review });

describe('rating the existing final file of a version', () => {
  test('a rating job is about the stored file: no version, no video, no change of status; the review is replaced and the history keeps both', async () => {
    const id = await deliver(), before = await get(id), file = sha(VIDEO);
    expect(before.reviews).toHaveLength(1);
    expect(before.reviews[0]).toMatchObject({ mode: 'delivered', rubricVersion: 'r1', overall: null, fileSha256: file, shown: true, aboutStoredFile: true, upToDate: true });
    expect((await post(`/projects/${id}/rating`, {})).body.error).toBe('by_required');
    const r = await post(`/projects/${id}/rating`, { by: 'עדן' });
    expect(r.status).toBe(200);
    expect(r.body.project).toMatchObject({ currentVersion: 1, status: 'ready_for_review', rating: { status: 'queued', version: 1, by: 'עדן' } });
    expect(r.body.project.versions).toHaveLength(1);
    expect(r.body.project.job.status).toBe('succeeded');                                   // the job of the VERSION is untouched
    expect((await post(`/projects/${id}/rating`, { by: 'עדן' })).body.error).toBe('job_in_progress');
    expect((await post(`/projects/${id}/apply-review`, { by: 'עדן' })).body.error).toBe('job_in_progress');     // nothing is rendered while a rating waits

    const l = await lease();
    expect(l.job).toMatchObject({ type: 'rereview', version: 1, options: { review_of: { version: 1, file_sha256: file } } });
    const input = n => W(request(app).get(`/api/dana/worker/jobs/${l.job.id}/review-input/${n}`)).set('X-Lease-Token', l.leaseToken);
    expect(JSON.parse((await input('package.json')).text).dana_review.rubric_version).toBe('r1');
    expect((await input('checks.json')).status).toBe(200);
    expect((await input('final.mp4')).status).toBe(404);                                   // the video is not an input: nothing is rendered from it
    expect((await W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' })).body.error).toBe('wrong_job_type');
    expect((await submit(l, rating(file, 1))).status).toBe(200);

    const p = await get(id);
    expect(p).toMatchObject({ currentVersion: 1, status: 'ready_for_review', rating: { status: 'succeeded' } });
    expect(p.versions).toHaveLength(1);
    expect(p.version.package.finalReview.score).toMatchObject({ overall: 84, version: 's1' });
    expect(p.version.package.danaReview.rubric_version).toBe('r2');
    expect(p.review).toMatchObject({ upToDate: true, rubricVersion: 'r2', finalSha256: file });
    expect(p.reviews.map(e => [e.mode, e.rubricVersion, e.overall, e.shown, e.by])).toEqual([['delivered', 'r1', null, false, 'worker'], ['rubric_upgrade', 'r2', 84, true, 'עדן']]);
    expect(p.reviews.every(e => e.fileSha256 === file && e.aboutStoredFile)).toBe(true);
    // the delivered files are exactly what they were
    const dir = path.join(process.env.DATA_DIR, 'dana', 'projects', id, 'v1');
    expect(sha(fs.readFileSync(path.join(dir, 'final.mp4')))).toBe(file);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dana_review.rubric_version).toBe('r1');
    expect(p.history.map(h => h.action)).toEqual(expect.arrayContaining(['rating_requested', 'rating_ready']));
    // a second rating is one more entry; the earlier ones stay
    await post(`/projects/${id}/rating`, { by: 'עדן' });
    await submit(await lease(), rating(file, 1, { mode: 'rating_added' }));
    expect((await get(id)).reviews.map(e => e.mode)).toEqual(['delivered', 'rubric_upgrade', 'rating_added']);
  });

  test('a rating of another file, of another version, with a made-up mark or with a render is refused, and nothing changes', async () => {
    const id = await deliver(), file = sha(VIDEO);
    await post(`/projects/${id}/rating`, { by: 'עדן' });
    const l = await lease();
    const bad = async (over, patch) => { const r = rating(file, 1, over); if (patch) patch(r); const res = await submit(l, r); expect(res.status).toBe(422); return res.body.message; };
    expect(await bad({ file_sha256: 'b'.repeat(64) })).toMatch(/different file/);
    expect(await bad({ version: 2 })).toMatch(/different version/);
    expect(await bad({ rendered: true })).toMatch(/must not render/);
    expect(await bad({}, r => { r.final_review.score.overall = 101; })).toMatch(/malformed/);
    expect(await bad({}, r => { r.final_review.score.groups[1].score = 95; })).toMatch(/does not follow/);       // 2 of 3 is 67, not 95
    expect(await bad({}, r => { r.final_review.score.groups[2].score = 50; })).toMatch(/does not follow/);       // nothing decided: no number
    expect(await bad({}, r => { r.final_review.score.overall = 90; })).toMatch(/total does not follow/);          // the average of 100 and 67 is 84
    expect(await bad({}, r => { delete r.final_review.score; })).toMatch(/malformed/);
    const p = await get(id);
    expect(p.reviews).toHaveLength(1);
    expect(p.version.package.danaReview.rubric_version).toBe('r1');
  });

  test('a stored video that is no longer the recorded file cannot be rated from the stored measurements', async () => {
    const id = await deliver();
    fs.writeFileSync(path.join(process.env.DATA_DIR, 'dana', 'projects', id, 'v1', 'final.mp4'), crypto.randomBytes(3000));
    const r = await post(`/projects/${id}/rating`, { by: 'עדן' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('file_changed');
    expect(Object.values(studio.state().jobs).filter(j => j.type === 'rereview')).toHaveLength(0);
  });

  test('a rating that fails or is lost never touches the version; a new version makes the earlier review not up to date', async () => {
    const id = await deliver(), file = sha(VIDEO);
    await post(`/projects/${id}/rating`, { by: 'עדן' });
    let l = await lease();
    await W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/fail`)).set('X-Lease-Token', l.leaseToken).send({ status: 'failure', code: 'review_of_other_file', message: 'קובץ אחר', retryable: false });
    let p = await get(id);
    expect(p).toMatchObject({ status: 'ready_for_review', rating: { status: 'failed', error: { code: 'review_of_other_file' } } });
    expect(p.version.status).toBe('ready_for_review');
    // a worker that disappears in the middle of a rating, three times: the job fails, the version does not
    await post(`/projects/${id}/rating`, { by: 'עדן' });
    for (let k = 0; k < 3; k++) { l = await lease(); const j = studio.state().jobs[l.job.id]; j.lease.expiresAt = new Date(Date.now() - 1000).toISOString(); studio.recover(); }
    p = await get(id);
    expect(p.rating.status).toBe('failed');
    expect(p).toMatchObject({ status: 'ready_for_review', version: { status: 'ready_for_review' } });
    // the video changes (a new version): the review of version 1 is marked as not about what is current
    await post(`/projects/${id}/rating`, { by: 'עדן' });
    await submit(await lease(), rating(file, 1));
    expect((await post(`/projects/${id}/apply-review`, { by: 'עדן' })).status).toBe(200);
    const old = await get(id, 1);
    expect(old.currentVersion).toBe(2);
    expect(old.review.upToDate).toBe(false);
    expect(old.reviews.every(e => e.upToDate === false && e.aboutStoredFile === true)).toBe(true);
    expect((await lease()).job).toMatchObject({ type: 'edit', version: 2, options: { previous_review: { rubric_version: 'r2' } } });   // the next version is compared with the rating in force
  });
});
