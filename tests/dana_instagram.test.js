'use strict';
/**
 * Dana — the REAL Instagram adapter, tested against a local fake that speaks the documented contract
 * (docs/DANA_INSTAGRAM_CONTRACT.md). This proves request shapes, error mapping, secret handling and
 * the lifecycle wiring. It does NOT prove anything about a real account: no request leaves localhost.
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const TOKEN = 'IGTOKEN-secret-value-0123456789';
const WTOKEN = 'test-worker-token-0123456789abcdef';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let fake, app, studio, publisher, ig;

/** Minimal fake of the documented Graph endpoints for one account. */
function startFake() {
  const a = express(); const st = { containers: {}, media: {}, seen: [], uploads: [], fail: {}, polls: 0, username: 'shape.test', seq: 0 };
  a.use((req, _res, next) => { st.seen.push({ method: req.method, url: req.originalUrl, auth: req.headers.authorization, headers: req.headers }); next(); });
  const err = (res, status, code, message, sub) => res.status(status).json({ error: { message, type: 'OAuthException', code, error_subcode: sub, fbtrace_id: 'TRACE' } });
  a.use((req, res, next) => {
    if (st.fail.token) return err(res, 400, 190, `Error validating access token: Session has expired. token=${TOKEN}`, 463);
    const ok = req.path.startsWith('/ig-api-upload/') ? req.headers.authorization === `OAuth ${TOKEN}` : req.headers.authorization === `Bearer ${TOKEN}`;
    return ok ? next() : err(res, 400, 190, 'Invalid OAuth access token.');
  });
  a.get('/v26.0/1784000000', (_q, res) => res.json({ id: '1784000000', username: st.username }));
  a.get('/v26.0/1784000000/content_publishing_limit', (_q, res) => res.json({ data: [{ quota_usage: 2, config: { quota_total: 50, quota_duration: 86400 } }] }));
  a.post('/v26.0/1784000000/media', (req, res) => {
    if (st.fail.limit) return err(res, 400, 9, 'You reached maximum number of posts', 2207042);
    const id = `1790${++st.seq}`;
    st.containers[id] = { id, q: req.query, status_code: 'IN_PROGRESS', uploaded: false };
    res.json({ id, uri: `http://127.0.0.1:${fake.port}/ig-api-upload/v26.0/${id}` });
  });
  a.post('/ig-api-upload/v26.0/:id', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
    const c = st.containers[req.params.id];
    st.uploads.push({ id: req.params.id, offset: req.headers.offset, file_size: req.headers.file_size, bytes: req.body.length, sha: sha(req.body) });
    if (st.fail.upload) return res.json({ debug_info: { retriable: false, type: 'ProcessingFailedError', message: 'bad file' } });
    c.uploaded = true; res.json({ success: true, message: 'Upload successful.' });
  });
  a.get('/v26.0/1784000000/media', (_q, res) => res.json({ data: Object.values(st.media) }));
  a.post('/v26.0/1784000000/media_publish', (req, res) => {
    const c = st.containers[req.query.creation_id];
    if (!c || c.status_code !== 'FINISHED') return err(res, 400, 9007, 'The media is not ready for publishing, please wait for a moment', 2207027);
    const id = `1800${++st.seq}`; c.status_code = 'PUBLISHED';
    st.media[id] = { id, caption: c.q.caption, permalink: `https://www.instagram.com/reel/FAKE${id}/`, timestamp: new Date().toISOString(), media_product_type: 'REELS' };
    if (st.fail.publishHang) return;                                            // posted; the caller never hears back
    res.json({ id });
  });
  a.get('/v26.0/:id/insights', (req, res) => st.media[req.params.id]
    ? res.json({ data: String(req.query.metric).split(',').map((name, k) => ({ name, period: 'lifetime', values: [{ value: 10 + k }], id: `${req.params.id}/insights/${name}/lifetime` })) })
    : err(res, 400, 100, 'Unsupported get request.'));
  a.get('/v26.0/:id', (req, res) => {
    const c = st.containers[req.params.id], m = st.media[req.params.id];
    if (c) { if (c.status_code === 'IN_PROGRESS' && c.uploaded && ++st.polls > (st.fail.polls ?? 0)) c.status_code = 'FINISHED'; return res.json({ id: c.id, status_code: c.status_code }); }
    return m ? res.json(m) : err(res, 400, 100, 'Unsupported get request.');
  });
  return new Promise(r => { const server = a.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, st })); });
}

const ENV = () => ({ DANA_WORKER_TOKEN: WTOKEN, DANA_PUBLISHING_ENABLED: 'true', DANA_PUBLISHER_MODE: 'instagram', DANA_INSTAGRAM_LIVE: 'true', DANA_IG_LOGIN: 'facebook',
  DANA_IG_API_VERSION: 'v26.0', DANA_IG_USER_ID: '1784000000', DANA_IG_ACCESS_TOKEN: TOKEN, DANA_PUBLISH_TIMEOUT_MS: '400', DANA_METRICS_OFFSETS_H: '48' });
function boot(env = {}) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-ig-'));
  for (const k of Object.keys(process.env)) if (k.startsWith('DANA_')) delete process.env[k];
  Object.assign(process.env, ENV(), env);
  jest.resetModules();
  studio = require('../services/dana_studio'); publisher = require('../services/dana_publisher'); ig = require('../services/dana_instagram');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express(); app.use('/api/dana/worker', workerRouter); app.use('/api/dana/studio', panelRouter);
}
const adapter = (extra = {}) => new ig.InstagramPublisher({ files: (p, n, name) => studio.artifactPath(p, n, name), base: `http://127.0.0.1:${fake.port}`, uploadBase: `http://127.0.0.1:${fake.port}`, ...extra });
beforeAll(async () => { fake = await startFake(); });
afterAll(() => fake.server.close());
beforeEach(() => { Object.assign(fake.st, { containers: {}, media: {}, seen: [], uploads: [], fail: {}, polls: 0, username: 'shape.test' }); boot(); });

const A = id => `/api/dana/studio/projects/${id}`;
const get = async id => (await request(app).get(A(id))).body.project;
const VIDEO = crypto.randomBytes(5000);
async function approved({ account = 'shape.test', when = Date.now() - 1000 } = {}) {
  const up = await request(app).post('/api/dana/studio/upload').attach('video', Buffer.concat([Buffer.from('s'), crypto.randomBytes(2048)]), 'c.mp4');
  const l = (await request(app).post('/api/dana/worker/lease').set('Authorization', `Bearer ${WTOKEN}`).send({ workerId: 'w' })).body;
  const pkg = { pipeline_version: '1', status: 'success', source: { sha256: up.body.project.source.sha256 }, segment: { in_s: 0, out_s: 20 }, duration: 20, adapter: 'scripted', spoken_text: 'x', cards: [],
    cover: { text: 'ציטוט', frame_s: 6.5 }, caption: { text: 'קפשן\nשורה שנייה', cta: null }, checks: [], failed_checks: [], issues: [], review_items: [] };
  const files = { 'final.mp4': VIDEO, 'cover.jpg': crypto.randomBytes(300), 'package.json': Buffer.from(JSON.stringify(pkg)), 'checks.json': Buffer.from('{}'), 'captions.json': Buffer.from('[]') };
  for (const [name, b] of Object.entries(files))
    await request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`).set('Authorization', `Bearer ${WTOKEN}`).set('X-Lease-Token', l.leaseToken).set('X-Content-SHA256', sha(b)).set('Content-Type', 'application/octet-stream').send(b);
  await request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`).set('Authorization', `Bearer ${WTOKEN}`).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
  const id = up.body.project.id;
  await request(app).patch(A(id) + '/package').send({ account, scheduledAt: new Date(when).toISOString() });
  await request(app).post(A(id) + '/consent').send({ status: 'confirmed', by: 'TEST ACTOR' });
  await request(app).post(A(id) + '/approve').send({ fingerprint: (await get(id)).version.fingerprint, by: 'TEST ACTOR' });
  return id;
}
const advance = async (id, n = 1, p = adapter()) => { for (let i = 0; i < n; i++) await publisher.advance(studio.getProject(id), p); return studio.getProject(id).publication; };

describe('disabled by default; configuration by name only', () => {
  test('every switch and value is required, and status never shows a secret', () => {
    for (const drop of ['DANA_INSTAGRAM_LIVE', 'DANA_IG_LOGIN', 'DANA_IG_API_VERSION', 'DANA_IG_USER_ID', 'DANA_IG_ACCESS_TOKEN']) {
      const env = { ...ENV() }; delete env[drop];
      expect(ig.config(env).ok).toBe(false);
      expect(() => new ig.InstagramPublisher({ env, files: () => null })).toThrow(/not configured/);
    }
    expect(ig.config({ ...ENV(), DANA_IG_API_VERSION: 'latest' }).problems.join()).toMatch(/DANA_IG_API_VERSION/);
    expect(ig.config({ ...ENV(), DANA_IG_LOGIN: 'other' }).ok).toBe(false);
    const s = ig.status();
    expect(s).toMatchObject({ ready: true, login: 'facebook', apiVersion: 'v26.0', tokenConfigured: true, verifiedAgainstRealAccount: false });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(__dirname, '../services/dana_instagram.js'), 'utf8')).not.toMatch(/process\.env\.META_|env\.META_/);   // the lead-ads token is never read
  });
  test('the gate stays closed until the switches are on; mock mode is unaffected', async () => {
    boot({ DANA_INSTAGRAM_LIVE: 'false' });
    const id = await approved();
    const r = await request(app).post(A(id) + '/publish').send({});
    expect(r.status).toBe(409); expect(r.body.blocked.map(b => b.code)).toEqual(['publisher_not_configured']);
    expect((await request(app).get('/api/dana/studio/publisher/status')).body).toMatchObject({ mode: 'instagram', instagram: { ready: false } });
    delete process.env.DANA_PUBLISHING_ENABLED;
    expect((await request(app).post(A(id) + '/publish').send({})).body.blocked.map(b => b.code)).toEqual(['publishing_disabled']);
  });
});

describe('contract: one Reel through the documented flow', () => {
  test('container (resumable) → upload → status → publish → verify → insights; token only in headers', async () => {
    fake.st.fail.polls = 1;
    const id = await approved();
    expect((await request(app).post(A(id) + '/publish').send({})).status).toBe(200);
    expect((await get(id)).publication.coverNote).toMatch(/6\.5/);                          // the page says which frame becomes the cover
    let pub = await advance(id);
    expect(pub).toMatchObject({ state: 'processing', accountVerified: { username: 'shape.test' } });
    const c = Object.values(fake.st.containers)[0];
    expect(c.q).toMatchObject({ media_type: 'REELS', upload_type: 'resumable', caption: 'קפשן\nשורה שנייה', share_to_feed: 'true', thumb_offset: '6500' });
    expect(c.q.video_url).toBeUndefined(); expect(c.q.cover_url).toBeUndefined();          // nothing public is offered
    expect(fake.st.uploads).toEqual([{ id: c.id, offset: '0', file_size: String(VIDEO.length), bytes: VIDEO.length, sha: sha(VIDEO) }]);
    pub = await advance(id, 2);
    expect(pub.state).toBe('published');
    expect(pub.permalink).toMatch(/^https:\/\/www\.instagram\.com\/reel\/FAKE/);
    expect(pub.verification).toMatchObject({ mediaId: pub.mediaId, captionMatches: true });
    await advance(id, 2);
    expect(Object.keys(fake.st.media)).toHaveLength(1); expect(Object.keys(fake.st.containers)).toHaveLength(1);
    const added = await publisher.collectMetrics(studio.getProject(id), adapter(), { now: Date.now() + 49 * 3600e3 });
    expect(added[0]).toMatchObject({ source: 'instagram', mediaId: pub.mediaId, note: null });
    expect(Object.keys(added[0].values)).toEqual(ig.REEL_METRICS);
    for (const r of fake.st.seen) { expect(r.url).not.toContain(TOKEN); expect(r.url).not.toMatch(/access_token/); }
    expect(fake.st.seen.find(r => r.url.includes('/ig-api-upload/')).auth).toBe(`OAuth ${TOKEN}`);
    expect(JSON.stringify(studio.state())).not.toContain(TOKEN);
  });

  test('the token must belong to the approved destination account, or nothing is created', async () => {
    fake.st.username = 'someone.else';
    const id = await approved(); await request(app).post(A(id) + '/publish').send({});
    const pub = await advance(id);
    expect(pub).toMatchObject({ state: 'failed', errorCode: 'destination_mismatch' });
    expect(Object.keys(fake.st.containers)).toHaveLength(0);
  });

  test('expired token → fails before anything goes out; the stored error has no secret; resumes after renewal', async () => {
    const id = await approved(); await request(app).post(A(id) + '/publish').send({});
    fake.st.fail.token = true;
    let pub = await advance(id);
    expect(pub).toMatchObject({ state: 'failed', errorCode: 'auth_expired', resumable: true });
    expect(JSON.stringify(studio.state())).not.toContain(TOKEN);
    fake.st.fail.token = false;
    await request(app).post(A(id) + '/publish/resume').send({});
    pub = await advance(id, 3);
    expect(pub.state).toBe('published'); expect(Object.keys(fake.st.media)).toHaveLength(1);
  });

  test('publish request with no answer → uncertain, never repeated; the post is found by caption and time', async () => {
    const id = await approved(); await request(app).post(A(id) + '/publish').send({});
    fake.st.fail.publishHang = true;
    let pub = await advance(id, 3);
    expect(pub.state).toBe('uncertain');
    expect(fake.st.seen.filter(r => r.url.includes('/media_publish'))).toHaveLength(1);
    fake.st.fail.publishHang = false;
    pub = await publisher.reconcile(studio.getProject(id), adapter());
    expect(pub).toMatchObject({ state: 'published' }); expect(pub.verification.via).toBe('reconciliation');
    expect(Object.keys(fake.st.media)).toHaveLength(1);
  });

  test('provider refusals are named: publishing limit, rejected upload', async () => {
    let id = await approved(); await request(app).post(A(id) + '/publish').send({});
    fake.st.fail.limit = true;
    expect(await advance(id)).toMatchObject({ state: 'failed', errorCode: 'publishing_limit_reached' });
    boot(); Object.assign(fake.st, { containers: {}, media: {}, fail: { upload: true } });
    id = await approved(); await request(app).post(A(id) + '/publish').send({});
    expect(await advance(id)).toMatchObject({ state: 'failed', errorCode: 'upload_rejected' });
    expect(Object.keys(fake.st.media)).toHaveLength(0);
  });

  test('Instagram Login needs a public media URL, which is not offered: it refuses instead of exposing a file', async () => {
    boot({ DANA_IG_LOGIN: 'instagram' });
    const p = new ig.InstagramPublisher({ files: () => __filename, base: `http://127.0.0.1:${fake.port}` });
    await expect(p.createContainer({ projectId: 'x', version: 1, caption: 'c' })).rejects.toMatchObject({ code: 'signed_url_disabled' });
  });

  test('read-only probe: account and quota, nothing published', async () => {
    const p = adapter();
    expect(await p.whoAmI()).toMatchObject({ id: '1784000000', username: 'shape.test', matchesConfiguredId: true });
    expect(await p.publishingLimit()).toEqual({ used: 2, total: 50 });
    expect(fake.st.seen.every(r => r.method === 'GET')).toBe(true);
    expect(ig.scrub(`bad token ${TOKEN} access_token=abc123`, TOKEN)).toBe('bad token [token] access_token=[token]');
  });

  test('the scheduler does not start under test, in mock mode, or when publishing is off', () => {
    expect(publisher.startScheduler()).toBe(false);
  });
});
