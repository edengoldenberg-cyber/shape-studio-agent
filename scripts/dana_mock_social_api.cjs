'use strict';
/**
 * dana_mock_social_api.cjs — a LOCAL stand-in for a social publishing API. It is NOT Instagram
 * and proves nothing about a real account. It exists so the publication lifecycle (container →
 * status → publish → verify → metrics) can be exercised with timeouts, expired credentials and
 * uncertain outcomes, without any external write.
 *
 *   node scripts/dana_mock_social_api.cjs [port]         default 3190, token "mock-token"
 *
 * Fault injection:  POST /__control { "next": { "<op>": "<mode>" }, "tokenExpired": bool, "containerPolls": n }
 *   op   = createContainer | status | publish | media | insights
 *   mode = timeout | 500 | publish_then_timeout   (the post IS created, the response never arrives)
 * State for assertions:  GET /__state
 */
const express = require('express');

function start({ port = Number(process.argv[2]) || 3190, token = 'mock-token' } = {}) {
  const app = express();
  app.use(express.json());
  const st = { containers: {}, media: {}, next: {}, tokenExpired: false, containerPolls: 0, calls: [], seq: 0 };
  const hang = () => new Promise(() => {});                           // never answers → the client times out
  const fault = async (op, res) => {
    const m = st.next[op]; if (!m) return false;
    delete st.next[op];
    if (m === 'timeout') { await hang(); return true; }
    if (m === '500') { res.status(500).json({ error: 'mock server error' }); return true; }
    return m;                                                          // e.g. publish_then_timeout: handled by the caller
  };
  app.post('/__control', (req, res) => { Object.assign(st, { ...req.body, next: { ...st.next, ...(req.body.next ?? {}) } }); res.json({ ok: true }); });
  app.get('/__state', (_req, res) => res.json({ containers: Object.values(st.containers), media: Object.values(st.media), calls: st.calls, mock: true }));
  app.use((req, res, next) => {
    st.calls.push(`${req.method} ${req.path}`);
    if (req.headers.authorization !== `Bearer ${token}` || st.tokenExpired) return res.status(401).json({ error: 'mock: invalid or expired token' });
    next();
  });
  app.post('/:acct/media', async (req, res) => {
    if (await fault('createContainer', res)) return;
    const id = `mockc_${++st.seq}`;
    st.containers[id] = { id, account: req.params.acct, caption: req.body.caption, client_ref: req.body.client_ref, video_sha256: req.body.video_sha256,
      status_code: 'IN_PROGRESS', polls: 0, media_id: null };
    res.json({ id });
  });
  app.get('/containers/:id', async (req, res) => {
    if (await fault('status', res)) return;
    const c = st.containers[req.params.id]; if (!c) return res.status(404).json({ error: 'unknown container' });
    if (c.status_code === 'IN_PROGRESS' && ++c.polls > st.containerPolls) c.status_code = 'FINISHED';
    res.json({ id: c.id, status_code: c.status_code });
  });
  app.post('/:acct/media_publish', async (req, res) => {
    const f = await fault('publish', res); if (f === true) return;
    const c = st.containers[req.body.creation_id]; if (!c) return res.status(404).json({ error: 'unknown container' });
    if (c.status_code === 'PUBLISHED') return res.status(400).json({ error: 'mock: container already published' });   // a real API's behaviour here is unverified
    const id = `mockm_${++st.seq}`;
    c.status_code = 'PUBLISHED'; c.media_id = id;
    st.media[id] = { id, account: req.params.acct, caption: c.caption, client_ref: c.client_ref, permalink: `https://mock.invalid/reel/${id}`, timestamp: new Date().toISOString(), mock: true };
    if (f === 'publish_then_timeout') return hang();                   // posted, but the caller never hears back
    res.json({ id });
  });
  app.get('/media/:id', async (req, res) => { if (await fault('media', res)) return; const m = st.media[req.params.id]; return m ? res.json(m) : res.status(404).json({ error: 'unknown media' }); });
  app.get('/:acct/media', (req, res) => res.json({ data: Object.values(st.media).filter(m => m.account === req.params.acct) }));
  app.get('/media/:id/insights', async (req, res) => {
    if (await fault('insights', res)) return;
    const m = st.media[req.params.id]; if (!m) return res.status(404).json({ error: 'unknown media' });
    const n = Number(req.params.id.split('_')[1]);                     // fixed numbers derived from the id: obviously synthetic
    res.json({ media_id: m.id, mock: true, values: { views: 1000 + n, reach: 800 + n, likes: 50 + n, comments: 5, saved: 7, shares: 3, avg_watch_time_s: 9.5 } });
  });
  return new Promise(resolve => { const server = app.listen(port, '127.0.0.1', () => { const p = server.address().port; resolve({ server, port: p, token, base: `http://127.0.0.1:${p}`, state: st }); }); });
}

module.exports = { start };
if (require.main === module) start().then(x => console.log(`MOCK social API on ${x.base} (token "${x.token}") — not a real service`));
