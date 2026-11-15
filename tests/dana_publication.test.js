'use strict';
/**
 * Dana — scheduling, publication, verification and metrics, DRY RUN against a local mock API.
 * Nothing here talks to a real service. "Published" in this file always means published to the mock.
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const TOKEN = 'test-worker-token-0123456789abcdef';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const W = r => r.set('Authorization', `Bearer ${TOKEN}`);
let app, studio, publisher, mock;

function boot({ keepData = false } = {}) {
  if (!keepData) process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-pub-'));
  Object.assign(process.env, { DANA_WORKER_TOKEN: TOKEN, DANA_PUBLISHING_ENABLED: 'true', DANA_PUBLISHER_MODE: 'mock', DANA_PUBLISH_API_BASE: mock.base,
    DANA_PUBLISH_API_TOKEN: mock.token, DANA_PUBLISH_TIMEOUT_MS: '250', DANA_METRICS_OFFSETS_H: '48,168' });
  jest.resetModules();
  studio = require('../services/dana_studio'); publisher = require('../services/dana_publisher');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express(); app.use('/api/dana/worker', workerRouter); app.use('/api/dana/studio', panelRouter);
  studio.reconcileOnStartup();
}
beforeAll(async () => { mock = await require('../scripts/dana_mock_social_api.cjs').start({ port: 0 }); });
afterAll(() => mock.server.close());
beforeEach(() => { Object.assign(mock.state, { containers: {}, media: {}, next: {}, tokenExpired: false, containerPolls: 0, calls: [] }); boot(); });

const A = id => `/api/dana/studio/projects/${id}`;
const get = async id => (await request(app).get(A(id))).body.project;
const tick = (now) => request(app).post('/api/dana/studio/publisher/tick').send(now ? { now: new Date(now).toISOString() } : {});
const posts = () => Object.values(mock.state.media);

/** A package that a TEST actor approved, with consent recorded and a time in the past → ready to go out. */
async function scheduled({ when = Date.now() - 1000 } = {}) {
  const buf = Buffer.concat([Buffer.from('src'), crypto.randomBytes(2048)]);
  const up = await request(app).post('/api/dana/studio/upload').attach('video', buf, `c-${crypto.randomBytes(3).toString('hex')}.mp4`);
  const l = (await W(request(app).post('/api/dana/worker/lease')).send({ workerId: 'w1' })).body;
  const pkg = { pipeline_version: '1.0.0', status: 'success', source: { sha256: up.body.project.source.sha256 }, segment: { in_s: 0, out_s: 20 }, duration: 20, adapter: 'scripted',
    spoken_text: 'ציטוט', cards: [], cover: { text: 'ציטוט' }, caption: { text: 'קפשן בדיקה', cta: null }, checks: [], failed_checks: [], issues: [], review_items: [] };
  const files = { 'final.mp4': crypto.randomBytes(2000), 'cover.jpg': crypto.randomBytes(300), 'package.json': Buffer.from(JSON.stringify(pkg)), 'checks.json': Buffer.from('{}'), 'captions.json': Buffer.from('[]') };
  for (const [name, b] of Object.entries(files))
    await W(request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken).set('X-Content-SHA256', sha(b)).set('Content-Type', 'application/octet-stream').send(b);
  await W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
  const id = up.body.project.id;
  await request(app).patch(A(id) + '/package').send({ account: 'test-account', scheduledAt: new Date(when).toISOString() });
  await request(app).post(A(id) + '/consent').send({ status: 'confirmed', by: 'TEST ACTOR (not the owner)' });
  await request(app).post(A(id) + '/approve').send({ fingerprint: (await get(id)).version.fingerprint, by: 'TEST ACTOR (not the owner)' });
  expect((await request(app).post(A(id) + '/publish').send({})).status).toBe(200);
  return id;
}

describe('calendar and proposed time (Asia/Jerusalem)', () => {
  test('a new package gets a concrete proposal: next day 12:00 Israel time, a day apart from other items', async () => {
    // on an empty calendar (independent of the machine clock)
    expect(publisher.toLocal(publisher.proposeTime(Date.parse('2026-11-15T08:00:00Z')))).toBe('2026-11-16T12:00');
    expect(publisher.toLocal(publisher.proposeTime(Date.parse('2026-07-01T08:00:00Z')))).toBe('2026-07-02T12:00');   // summer time handled
    const a = await scheduled(); const pa = await get(a);
    expect(pa.version.timezone).toBe('Asia/Jerusalem');
    // an item already on the calendar pushes the next proposal at least a day away from it
    const busy = Date.parse(studio.getProject(a).publication.scheduledAt);
    const next = Date.parse(publisher.proposeTime(busy - 20 * 3600e3));
    expect(Math.abs(next - busy)).toBeGreaterThanOrEqual(24 * 3600e3);
    expect(publisher.toLocal(new Date(next).toISOString())).toMatch(/T12:00$/);
    expect(publisher.fromLocal('2026-11-16T12:00').toISOString()).toBe('2026-11-16T10:00:00.000Z');
    expect(publisher.fromLocal('2026-07-02T12:00').toISOString()).toBe('2026-07-02T09:00:00.000Z');
    const r = await request(app).patch(A(a) + '/package').send({ scheduledLocal: '2026-12-01T19:30' });
    expect(r.body.project.version).toMatchObject({ scheduledLocal: '2026-12-01T19:30', scheduledAt: '2026-12-01T17:30:00.000Z', scheduleProposed: false });
    expect(r.body.project.version.approval).toBeNull();                                  // a new time invalidates the approval
    const cal = (await request(app).get('/api/dana/studio/calendar')).body;
    expect(cal).toMatchObject({ timezone: 'Asia/Jerusalem', mode: 'mock', paused: false });
    expect(cal.items[0]).toMatchObject({ projectId: a });
  });
});

describe('mock publication lifecycle', () => {
  test('scheduled → processing → published once, verified by media id, permalink and caption; later ticks do nothing', async () => {
    mock.state.containerPolls = 1;                                             // the container needs one more poll
    const id = await scheduled();
    expect((await get(id)).publication.record).toMatchObject({ state: 'scheduled', mode: 'mock' });
    await tick(); expect((await get(id)).publication.record.state).toBe('processing');
    await tick();
    const pub = (await get(id)).publication.record;
    expect(pub).toMatchObject({ state: 'published', mode: 'mock' });
    expect(pub.permalink).toMatch(/^https:\/\/mock\.invalid\/reel\/mockm_/);
    expect(pub.verification).toMatchObject({ mediaId: pub.mediaId, captionMatches: true, via: 'publish_response' });
    await tick(); await tick();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ caption: 'קפשן בדיקה', client_ref: pub.id, mock: true });
    expect(Object.keys(mock.state.containers)).toHaveLength(1);
  });

  test('not due yet: nothing is sent; cancelling a scheduled publication stops it for good', async () => {
    const id = await scheduled({ when: Date.now() + 3600e3 });
    await tick();
    expect(mock.state.calls.filter(c => c.startsWith('POST'))).toEqual([]);
    expect((await request(app).post(A(id) + '/publish/cancel').send({})).body.project.publication.record.state).toBe('cancelled');
    await tick(Date.now() + 7200e3);
    expect(posts()).toHaveLength(0);
  });

  test('global pause holds everything; releasing it lets the due item go out', async () => {
    const id = await scheduled();
    expect((await request(app).post('/api/dana/studio/settings/pause').send({ paused: true })).body.settings.publishingPaused).toBe(true);
    await tick(); await tick();
    expect((await get(id)).publication).toMatchObject({ paused: true }); expect(posts()).toHaveLength(0);
    await request(app).post('/api/dana/studio/settings/pause').send({ paused: false });
    await tick();
    expect((await get(id)).publication.record.state).toBe('published'); expect(posts()).toHaveLength(1);
  });

  test('timeout AFTER the post was created → uncertain, no second publish; reconciliation finds the one post', async () => {
    mock.state.next.publish = 'publish_then_timeout';
    const id = await scheduled();
    await tick();
    let pub = (await get(id)).publication.record;
    expect(pub.state).toBe('uncertain'); expect(pub.mediaId).toBeNull();
    await tick(); await tick();                                               // the scheduler must not try again
    expect(posts()).toHaveLength(1);
    expect(mock.state.calls.filter(c => c.endsWith('/media_publish'))).toHaveLength(1);
    const r = await request(app).post(A(id) + '/publish/reconcile').send({});
    pub = r.body.project.publication.record;
    expect(pub).toMatchObject({ state: 'published', mediaId: posts()[0].id });
    expect(pub.verification.via).toBe('reconciliation');
    expect(posts()).toHaveLength(1);
  });

  test('timeout BEFORE anything was created → uncertain; the provider says "not published" so it continues, once', async () => {
    mock.state.next.publish = 'timeout';
    const id = await scheduled();
    await tick();
    expect((await get(id)).publication.record.state).toBe('uncertain'); expect(posts()).toHaveLength(0);
    expect((await request(app).post(A(id) + '/publish/reconcile').send({})).body.project.publication.record.state).toBe('processing');
    await tick();
    expect((await get(id)).publication.record.state).toBe('published'); expect(posts()).toHaveLength(1);
    expect(Object.keys(mock.state.containers)).toHaveLength(1);              // same container, not a new one
  });

  test('expired credentials: fails before anything goes out, says why, and resumes after renewal', async () => {
    mock.state.tokenExpired = true;
    const id = await scheduled();
    await tick();
    let pub = (await get(id)).publication.record;
    expect(pub).toMatchObject({ state: 'failed', errorCode: 'auth_expired', resumable: true }); expect(posts()).toHaveLength(0);
    await tick(); expect(mock.state.calls.length).toBe(1);                    // a failed publication is not retried on its own
    mock.state.tokenExpired = false;
    expect((await request(app).post(A(id) + '/publish/resume').send({})).body.project.publication.record.state).toBe('processing');
    await tick();
    pub = (await get(id)).publication.record;
    expect(pub.state).toBe('published'); expect(posts()).toHaveLength(1);
  });

  test('server restart between container and publish: resumes from disk, one container, one post', async () => {
    mock.state.containerPolls = 2;
    const id = await scheduled();
    await tick();
    expect((await get(id)).publication.record).toMatchObject({ state: 'processing' });
    boot({ keepData: true });                                                 // process restart, same disk
    expect(studio.getProject(id).publication.containerId).toMatch(/^mockc_/);
    await tick(); await tick(); await tick();
    expect((await get(id)).publication.record.state).toBe('published');
    expect(Object.keys(mock.state.containers)).toHaveLength(1); expect(posts()).toHaveLength(1);
  });

  test('content changed after scheduling → fails closed, nothing is sent', async () => {
    const id = await scheduled();
    await request(app).patch(A(id) + '/package').send({ caption: 'שונה אחרי האישור' });
    await tick();
    expect((await get(id)).publication.record).toMatchObject({ state: 'failed', errorCode: 'gate_closed' }); expect(posts()).toHaveLength(0);
  });
});

describe('metrics (mock)', () => {
  test('collected at 48h and 7d, attached to the right publication, labelled MOCK; never duplicated', async () => {
    const a = await scheduled(), b = await scheduled();
    await tick();
    const pubA = (await get(a)).publication.record, pubB = (await get(b)).publication.record;
    expect(pubA.metrics).toEqual([]);                                          // too early
    await tick(Date.now() + 49 * 3600e3);
    await tick(Date.now() + 50 * 3600e3);
    let pa = (await get(a)).publication.record, pb = (await get(b)).publication.record;
    expect(pa.metrics.map(m => [m.offsetHours, m.source, m.mediaId])).toEqual([[48, 'MOCK', pubA.mediaId]]);
    expect(pb.metrics[0].mediaId).toBe(pubB.mediaId);
    expect(pa.metrics[0].values.views).not.toBe(pb.metrics[0].values.views);    // each post got its own numbers
    expect(pa.metrics[0].note).toMatch(/נתוני דמה/);
    await tick(Date.now() + 8 * 24 * 3600e3);
    pa = (await get(a)).publication.record;
    expect(pa.metrics.map(m => m.offsetHours)).toEqual([48, 168]);
  });

  test('numbers that belong to another post are rejected', async () => {
    const id = await scheduled(); await tick();
    const p = studio.getProject(id);
    const wrong = { getInsights: async () => ({ media_id: 'someone-elses-post', values: { views: 999999 } }) };
    expect(await publisher.collectMetrics(p, wrong, { now: Date.now() + 72 * 3600e3 })).toEqual([]);
    expect(p.publication.metrics).toEqual([]);
    expect(p.history.some(h => h.action === 'metrics_rejected')).toBe(true);
  });
});

describe('closed by default', () => {
  test('without the switch or the mock mode nothing can be scheduled, and a real host is refused', async () => {
    const id = await scheduled({ when: Date.now() + 3600e3 });
    await request(app).post(A(id) + '/publish/cancel').send({});
    delete process.env.DANA_PUBLISHING_ENABLED;
    expect((await request(app).post(A(id) + '/publish').send({})).body.blocked.map(b => b.code)).toEqual(['publishing_disabled']);
    expect((await tick()).body.error).toBe('publisher_not_configured');
    process.env.DANA_PUBLISHING_ENABLED = 'true'; process.env.DANA_PUBLISHER_MODE = 'instagram';
    expect((await request(app).post(A(id) + '/publish').send({})).body.blocked.map(b => b.code)).toEqual(['publisher_not_configured']);
    expect(() => new publisher.HttpPublisher({ base: 'https://graph.facebook.com', token: 'x' })).toThrow(/only a local mock API/);
  });
});
