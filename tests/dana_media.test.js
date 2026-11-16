'use strict';
/**
 * Dana — several source files in one project, uploaded music and narration, mix settings, and what a job is told.
 * Isolated temp DATA_DIR; the worker is simulated.
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
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-media-'));
  process.env.DANA_WORKER_TOKEN = TOKEN;
  delete process.env.DANA_PUBLISHING_ENABLED; delete process.env.DANA_NOTIFY_REAL; delete process.env.DANA_PUBLISHER_MODE;
  jest.resetModules();
  studio = require('../services/dana_studio');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express(); app.use('/api/dana/worker', workerRouter); app.use(S, panelRouter);
  studio.reconcileOnStartup();
});
const post = (p, body) => request(app).post(S + p).send(body);
const patch = (p, body) => request(app).patch(S + p).send(body);
const get = async id => (await request(app).get(`${S}/projects/${id}`)).body.project;
const lease = async () => (await W(request(app).post('/api/dana/worker/lease')).send({ workerId: 'w1', pipelineVersion: '1.4.0' }));
const vid = () => Buffer.concat([Buffer.from('src-'), crypto.randomBytes(4096)]);
const upload = (options, buf = vid()) => request(app).post(`${S}/upload`).field('options', JSON.stringify(options)).attach('video', buf, 'a.mp4');
const addSource = (id, buf = vid(), name = 'b.mp4') => request(app).post(`${S}/projects/${id}/sources`).field('by', 'עדן').attach('video', buf, name);
const addAsset = (id, kind, buf = crypto.randomBytes(3000), name = 'track.mp3') => request(app).post(`${S}/projects/${id}/assets`).field('by', 'עדן').field('kind', kind).attach('file', buf, name);
function pkgFor(s) {
  return { pipeline_version: '1.4.0', status: 'success', source: { sha256: s, duration: 30 }, segment: { in_s: 0, out_s: 20 }, duration: 20, adapter: 'claude', judgement_mode: 'model',
    style: { caption_size: 96 }, spoken_text: 'שלום', plan: { message: 'מ', content_judgement: 'model', segments: [{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20 }] },
    cards: [], zooms: [], cover: { text: '', frame_s: 1 }, caption: { text: 'טיוטה', cta: null }, checks: [], failed_checks: [], issues: [],
    rules_used: { skill: { name: 'dana-editing', version: '0.1.0' }, profile: { id: 'center-bold-v1', version: '2', status: 'unapproved' }, references: [] }, timings_s: {}, total_s: 10 };
}
async function finish(l, s) {
  const files = { 'final.mp4': crypto.randomBytes(3000), 'cover.jpg': crypto.randomBytes(500), 'package.json': Buffer.from(JSON.stringify(pkgFor(s))), 'checks.json': Buffer.from('{"records":[]}'), 'captions.json': Buffer.from('[]') };
  for (const [name, buf] of Object.entries(files))
    await W(request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken).set('X-Content-SHA256', sha(buf)).set('Content-Type', 'application/octet-stream').send(buf);
  return W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
}

describe('several source files in one project', () => {
  test('files are uploaded together: the edit waits for "start", and the job carries every source with its marks and the kind of project', async () => {
    expect((await upload({ project_type: 'vlog' })).body.error).toBe('project_type_invalid');
    const up = await upload({ project_type: 'montage', more_files: true });
    const id = up.body.project.id;
    expect((await lease()).status).toBe(204);                          // nothing starts while files are still coming
    expect((await get(id)).waitingForFiles).toBe(true);
    const b = vid(), r2 = await addSource(id, b, 'אימון בוקר.mp4');
    expect(r2.status).toBe(201);
    expect((await addSource(id, b)).body.duplicate).toBe(true);        // the same file twice is one source
    await addSource(id, vid(), 'c.mov');
    expect((await request(app).post(`${S}/projects/${id}/sources`).field('by', 'עדן').attach('video', crypto.randomBytes(2000), 'x.txt')).body.error).toBe('format_unsupported');
    const p1 = await get(id);
    expect(p1.media.sources.map(s => [s.id, s.name, s.primary])).toEqual([['src1', 'a.mp4', true], ['src2', 'אימון בוקר.mp4', false], ['src3', 'c.mov', false]]);
    expect(p1.media.projectType).toBe('montage');
    // marks belong to one file: what must be in the video, and what must never be used
    expect((await patch(`/projects/${id}/sources/src2/marks`, { by: 'עדן', marks: [{ from_s: 5, to_s: 5.1, kind: 'must' }] })).body.error).toBe('marks_invalid');
    expect((await patch(`/projects/${id}/sources/src2/marks`, { by: 'עדן', marks: [{ from_s: 5, to_s: 9, kind: 'must' }, { from_s: 8, to_s: 12, kind: 'never' }] })).body.error).toBe('marks_conflict');
    await patch(`/projects/${id}/sources/src2/marks`, { by: 'עדן', marks: [{ from_s: 12, to_s: 20, kind: 'never', note: 'מישהו עובר' }, { from_s: 3, to_s: 7.5, kind: 'must' }] });
    expect((await post(`/projects/${id}/start`, { by: 'עדן' })).body.project.waitingForFiles).toBe(false);
    expect((await post(`/projects/${id}/start`, { by: 'עדן' })).body.error).toBe('nothing_waiting');
    const l = (await lease()).body;
    expect(l.job.options.project_type).toBe('montage');
    expect(l.job.options.sources.map(s => [s.id, s.name, s.marks.map(m => `${m.kind}:${m.from_s}-${m.to_s}`)])).toEqual(
      [['src1', 'a.mp4', []], ['src2', 'אימון בוקר.mp4', ['must:3-7.5', 'never:12-20']], ['src3', 'c.mov', []]]);
    // the worker may download any file of the project by its hash - and nothing else
    const got = await W(request(app).get(`/api/dana/worker/jobs/${l.job.id}/files/${sha(b)}`)).set('X-Lease-Token', l.leaseToken).buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(sha(got.body)).toBe(sha(b));
    expect((await W(request(app).get(`/api/dana/worker/jobs/${l.job.id}/files/${'0'.repeat(64)}`)).set('X-Lease-Token', l.leaseToken)).status).toBe(404);
    expect((await addSource(id)).body.error).toBe('job_in_progress');   // not while the worker is editing
  });

  test('a file added later is used by the NEXT version only; a removed source stays on disk and in the versions made with it', async () => {
    const up = await upload({}); const id = up.body.project.id;
    const l = (await lease()).body;
    expect(l.job.options.sources).toBeUndefined();                     // one file, no marks: the job is exactly as before
    await finish(l, up.body.project.source.sha256);
    const extra = vid(); await addSource(id, extra);
    expect((await get(id)).currentVersion).toBe(1);                    // adding a file does not start anything by itself
    expect((await post(`/projects/${id}/replan`, {})).body.error).toBe('by_required');
    const r = await post(`/projects/${id}/replan`, { by: 'עדן', project_type: 'mixed' });
    expect(r.body.project).toMatchObject({ currentVersion: 2, media: { projectType: 'mixed' } });
    expect(r.body.project.versions.map(v => v.n)).toEqual(expect.arrayContaining([1, 2]));
    const l2 = (await lease()).body;
    expect(l2.job.options.sources).toHaveLength(2);
    await finish(l2, up.body.project.source.sha256);
    expect((await request(app).delete(`${S}/projects/${id}/sources/src1`).send({ by: 'עדן' })).body.error).toBe('primary_source');
    const del = await request(app).delete(`${S}/projects/${id}/sources/src2`).send({ by: 'עדן' });
    expect(del.body.project.media.sources.find(s => s.id === 'src2').removed).toBe(true);
    expect(fs.existsSync(path.join(process.env.DATA_DIR, 'dana', 'sources', `${sha(extra)}.mp4`))).toBe(true);
  });
});

describe('uploaded music and narration, and the mix', () => {
  test('a music file is never marked as licensed by itself; the mix settings travel with the next job', async () => {
    const up = await upload({}); const id = up.body.project.id;
    await finish((await lease()).body, up.body.project.source.sha256);
    expect((await addAsset(id, 'video')).body.error).toBe('asset_kind_invalid');
    expect((await addAsset(id, 'music', crypto.randomBytes(3000), 'track.exe')).body.error).toBe('format_unsupported');
    const m = (await addAsset(id, 'music')).body;
    expect(m.asset).toMatchObject({ kind: 'music', license: { status: 'not_confirmed' } });
    const n = (await addAsset(id, 'narration', crypto.randomBytes(2500), 'קריינות.wav')).body;
    expect(n.asset).toMatchObject({ kind: 'narration', script: { is_script: null } });
    expect((await request(app).get(`${S}/projects/${id}/assets/${m.asset.id}/audio`)).headers['content-type']).toMatch(/audio\/mpeg/);
    expect((await post(`/projects/${id}/assets/${m.asset.id}/license`, { by: 'עדן', status: 'owner_confirmed' })).body.error).toBe('license_source_required');
    expect((await patch(`/projects/${id}/audio`, { by: 'עדן', music: { asset: 'mus_nope' } })).body.error).toBe('asset_not_found');
    const a = (await patch(`/projects/${id}/audio`, { by: 'עדן', music: { asset: m.asset.id, start_s: 12.5, volume_db: -60, fade_in_s: 1, fade_out_s: 99 },
      narration: { asset: n.asset.id }, original: { mode: 'mute' }, cut_on_beat: true })).body.project.media.audio;
    expect(a.music).toEqual({ asset: m.asset.id, start_s: 12.5, volume_db: -40, fade_in_s: 1, fade_out_s: 10, duck: true, duck_db: 10 });      // clamped to the limits
    expect(a).toMatchObject({ narration: { asset: n.asset.id, volume_db: 0 }, original: { mode: 'mute' }, cut_on_beat: true });
    expect((await get(id)).currentVersion).toBe(1);                    // settings alone render nothing
    await post(`/projects/${id}/assets/${n.asset.id}/narration-info`, { by: 'עדן', is_script: true, text: 'טקסט שנכתב לסרטון' });
    await post(`/projects/${id}/replan`, { by: 'עדן' });
    const j = (await lease()).body.job;
    expect(j.options.audio).toMatchObject({ cut_on_beat: true, original: { mode: 'mute' },
      music: { start_s: 12.5, file: { sha256: m.asset.sha256, ext: 'mp3' }, license: { status: 'not_confirmed' } },
      narration: { file: { ext: 'wav' }, script: { is_script: true, text: 'טקסט שנכתב לסרטון' } } });
  });

  test('replacing the music is a locked revision: the cut is kept and only the mix changes; the earlier version and its approval rules stay', async () => {
    const up = await upload({}); const id = up.body.project.id;
    await finish((await lease()).body, up.body.project.source.sha256);
    const m1 = (await addAsset(id, 'music')).body.asset, m2 = (await addAsset(id, 'music', crypto.randomBytes(3100), 'other.mp3')).body.asset;
    await patch(`/projects/${id}/audio`, { by: 'עדן', music: { asset: m1.id } });
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', audio: { music: { asset: m1.id } } })).body.error).toBe('nothing_to_revise');     // the same mix is not a change
    const r = await post(`/projects/${id}/revise`, { by: 'עדן', audio: { music: { asset: m2.id, volume_db: -22 } } });
    expect(r.body.ok).toBe(true);
    const j = (await lease()).body.job;
    expect(j.options.previous).toBeDefined();                          // locked to the previous plan: nothing is planned again
    expect(j.options.audio.music).toMatchObject({ volume_db: -22, file: { sha256: m2.sha256 } });
    expect((await get(id)).versions.map(v => v.n)).toEqual(expect.arrayContaining([1, 2]));
  });

  test('replacing or removing ONE segment of a compilation is carried to the worker as exactly that', async () => {
    const up = await upload({ project_type: 'montage' }); const id = up.body.project.id;
    await finish((await lease()).body, up.body.project.source.sha256);
    await addSource(id);
    expect((await post(`/projects/${id}/revise`, { by: 'עדן', segment_edits: [{ n: 2, action: 'replace', source_id: 'src2', from_s: 4, to_s: 4.2 }] })).body.error).toBe('segment_edits_invalid');
    await post(`/projects/${id}/revise`, { by: 'עדן', segment_edits: [{ n: 2, action: 'replace', source_id: 'src2', from_s: 4, to_s: 7 }, { n: 5, action: 'remove' }] });
    const j = (await lease()).body.job;
    expect(j.options.segment_edits.map(e => [e.n, e.action, e.source_id ?? null])).toEqual([[2, 'replace', 'src2'], [5, 'remove', null]]);
    expect(j.options.previous).toBeDefined();
  });
});
