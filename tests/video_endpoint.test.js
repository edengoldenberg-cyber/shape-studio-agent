'use strict';
/**
 * Integration tests: GET /api/dana/video/:id
 *
 * Requires the server to be running on localhost:3000.
 * Run with: npm test -- --testPathPattern=video_endpoint
 *
 * We use supertest against the running server so there is no double-listen
 * conflict. The DATA_DIR must match the server's configured data directory.
 */
const fs         = require('fs');
const path       = require('path');
const supertest  = require('supertest');

// UUID-format hex ID that passes /^[a-f0-9-]{30,40}$/ and is unique per run
const TEST_ID   = 'deadbeef-cafe-babe-feed-' + Date.now().toString(16).padStart(12, '0');
const DATA_DIR  = process.env.DATA_DIR ?? path.join(__dirname, '../data');
const VIDEO_DIR = path.join(DATA_DIR, 'videos', TEST_ID);

const agent = supertest('http://localhost:3000');

let serverUp = false;

beforeAll(async () => {
  // Check server is reachable — skip all tests otherwise
  try {
    await agent.get('/health').timeout(3000).expect(200);
    serverUp = true;
  } catch {}

  if (!serverUp) return; // tests will be skipped below

  // Create a 1 KB dummy video + matching report
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  fs.writeFileSync(path.join(VIDEO_DIR, 'video.mp4'), Buffer.alloc(1000, 0xAB));
  fs.writeFileSync(path.join(VIDEO_DIR, 'report.json'), JSON.stringify({
    id: TEST_ID, title: 'video-endpoint-test', createdAt: new Date().toISOString(),
    readiness: 50, verdict: 'לתקן קודם', format: 'feed', goal: 'leads',
  }));
});

afterAll(() => {
  try { fs.rmSync(VIDEO_DIR, { recursive: true, force: true }); } catch {}
});

function skipIfDown() {
  if (!serverUp) pending('Server not running on localhost:3000 — skipping');
}

describe('GET /api/dana/video/:id — security', () => {
  test('invalid ID format → 400', async () => {
    skipIfDown();
    await agent.get('/api/dana/video/not-a-uuid!').expect(400);
  });

  test('missing report → 404 JSON', async () => {
    skipIfDown();
    const r = await agent.get('/api/dana/video/00000000-0000-0000-0000-000000000000').expect(404);
    expect(r.body.error).toBeTruthy();
  });
});

describe('GET /api/dana/video/:id — full response', () => {
  test('200 + correct MIME + Accept-Ranges + correct size', async () => {
    skipIfDown();
    const r = await agent.get('/api/dana/video/' + TEST_ID).expect(200);
    expect(r.headers['content-type']).toContain('video/mp4');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(Number(r.headers['content-length'])).toBe(1000);
    expect(r.body.length).toBe(1000);
  });
});

describe('GET /api/dana/video/:id — Range requests', () => {
  test('bytes=0-99 → 206, correct Content-Range, 100 bytes', async () => {
    skipIfDown();
    const r = await agent
      .get('/api/dana/video/' + TEST_ID)
      .set('Range', 'bytes=0-99')
      .expect(206);
    expect(r.headers['content-range']).toBe('bytes 0-99/1000');
    expect(Number(r.headers['content-length'])).toBe(100);
    expect(r.body.length).toBe(100);
  });

  test('open-ended bytes=500- → 206, starts at 500', async () => {
    skipIfDown();
    const r = await agent
      .get('/api/dana/video/' + TEST_ID)
      .set('Range', 'bytes=500-')
      .expect(206);
    expect(r.headers['content-range']).toMatch(/^bytes 500-/);
  });

  test('out-of-range bytes=2000-3000 → 416', async () => {
    skipIfDown();
    await agent
      .get('/api/dana/video/' + TEST_ID)
      .set('Range', 'bytes=2000-3000')
      .expect(416);
  });
});
