'use strict';

/**
 * dana_studio_routes.js — HTTP surface of Dana phase 1A.
 *
 *   workerRouter  /api/dana/worker/*   mounted BEFORE the dashboard auth. Its own scoped
 *                                      credential (DANA_WORKER_TOKEN); fails closed when unset.
 *                                      The dashboard password / API token do not work here,
 *                                      and the worker token works nowhere else.
 *   panelRouter   /api/dana/studio/*   behind the existing dashboard session + CSRF.
 */

const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const multer  = require('multer');

const studio    = require('../services/dana_studio');
const publisher = require('../services/dana_publisher');
const brand     = require('../utils/dana_brand');

const json = express.json({ limit: '300kb' });
const wrap = fn => (req, res) => new Promise(resolve => resolve(fn(req, res))).catch(err => {   // sync throws too
  if (err instanceof studio.StudioError || err.status) return res.status(err.status).json({ ok: false, error: err.code ?? 'bad_request', message: err.message, ...(err.extra ?? {}) });
  try { require('../utils/logger').error('[dana-studio] request failed', { path: req.path, error: err.message }); } catch { /* */ }
  res.status(500).json({ ok: false, error: 'internal', message: 'שגיאה פנימית' });
});
const tmpDir = () => { const d = path.join(studio.dir(), 'tmp'); fs.mkdirSync(d, { recursive: true }); return d; };

/** Stream a file with HTTP Range support (phone players seek and resume). */
function sendRange(req, res, filePath, mime, extraHeaders = {}) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return res.status(404).json({ ok: false, error: 'file_not_found' }); }
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0, no-store', ...extraHeaders };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { ...headers, 'Content-Length': stat.size }); return fs.createReadStream(filePath).pipe(res); }
  let start = m[1] === '' ? Math.max(0, stat.size - Number(m[2])) : Number(m[1]);
  let end   = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
  if (!(start <= end) || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

// ── Worker API ────────────────────────────────────────────────────────────────
const workerRouter = express.Router();
const digest = s => crypto.createHash('sha256').update(String(s ?? '')).digest();

workerRouter.use((req, res, next) => {
  const expected = process.env.DANA_WORKER_TOKEN;
  if (!expected || expected.length < 24) return res.status(503).json({ ok: false, error: 'worker_api_not_configured' });   // fail closed
  const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (!given || !crypto.timingSafeEqual(digest(given), digest(expected))) {
    try { require('../utils/logger').warn('[dana-studio] unauthorized worker request', { path: req.path, ip: req.ip }); } catch { /* */ }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});
const leaseOf = req => req.headers['x-lease-token'];

workerRouter.post('/hello',     json, wrap((req, res) => { studio.workerHello(req.body ?? {}); res.json({ ok: true }); }));
workerRouter.post('/heartbeat', json, wrap((req, res) => { studio.heartbeat(req.body ?? {}); res.json({ ok: true }); }));
workerRouter.post('/lease',     json, wrap((req, res) => { const l = studio.lease(req.body ?? {}); return l ? res.json(l) : res.status(204).end(); }));
workerRouter.get('/jobs/:id/source', wrap((req, res) => {
  const j = studio.leasedJob(req.params.id, leaseOf(req));
  const p = studio.getProject(j.projectId);
  sendRange(req, res, studio.sourcePath(p.source), 'application/octet-stream', { 'X-Content-SHA256': p.source.sha256 });
}));
workerRouter.post('/jobs/:id/progress', json, wrap((req, res) => { studio.progress(req.params.id, leaseOf(req), req.body ?? {}); res.json({ ok: true }); }));
workerRouter.put('/jobs/:id/artifacts/:name', wrap(async (req, res) => {
  studio.leasedJob(req.params.id, leaseOf(req));                       // reject before reading the body
  if (!studio.ARTIFACTS[req.params.name]) throw new studio.StudioError(400, 'artifact_unknown', 'unknown artifact');
  const tmp = path.join(tmpDir(), `art_${crypto.randomBytes(8).toString('hex')}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    req.on('aborted', () => { out.destroy(); fs.rm(tmp, { force: true }, () => reject(new studio.StudioError(400, 'transfer_aborted', 'upload aborted'))); });
    req.pipe(out).on('finish', resolve).on('error', reject);
  });
  const saved = await studio.acceptArtifact(req.params.id, leaseOf(req), req.params.name, tmp, req.headers['x-content-sha256'], req.headers['content-length']);
  res.json({ ok: true, ...saved });
}));
workerRouter.post('/jobs/:id/complete', json, wrap((req, res) => { studio.complete(req.params.id, leaseOf(req), req.body ?? {}); res.json({ ok: true }); }));
workerRouter.post('/jobs/:id/fail',     json, wrap((req, res) => res.json({ ok: true, ...studio.fail(req.params.id, leaseOf(req), req.body ?? {}) })));
workerRouter.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// ── Panel API ─────────────────────────────────────────────────────────────────
const panelRouter = express.Router();
const maxUploadMb = () => { const n = Number(process.env.DANA_UPLOAD_MAX_MB); return Number.isFinite(n) && n > 0 ? n : 2048; };
const upload = (req, res, next) => multer({
  storage: multer.diskStorage({ destination: (_r, _f, cb) => cb(null, tmpDir()), filename: (_r, _f, cb) => cb(null, `up_${crypto.randomBytes(8).toString('hex')}`) }),
  limits: { fileSize: maxUploadMb() * 1024 * 1024, files: 1 },
}).single('video')(req, res, err => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, error: err.code ?? 'upload_failed',
    message: err.code === 'LIMIT_FILE_SIZE' ? `הקובץ גדול מהמותר (${maxUploadMb()}MB)` : err.message });
  next();
});

panelRouter.get('/status', wrap((_req, res) => res.json({ ok: true, worker: studio.workerStatus(), publishingEnabled: publisher.enabled(),
  notifications: require('../services/dana_notify').realEnabled() ? 'real' : 'mock', maxUploadMb: maxUploadMb(), brandMissing: brand.missing() })));
panelRouter.get('/projects', wrap((_req, res) => { studio.recover(); res.json({ ok: true, worker: studio.workerStatus(), projects: studio.list() }); }));
panelRouter.get('/projects/:id', wrap((req, res) => { studio.recover(); res.json({ ok: true, worker: studio.workerStatus(), project: studio.view(studio.getProject(req.params.id)) }); }));

panelRouter.post('/upload', upload, wrap(async (req, res) => {
  if (!req.file) throw new studio.StudioError(400, 'file_missing', 'לא נבחר קובץ וידאו (שדה: video)');
  let options = {};
  if (req.body?.options) { try { options = JSON.parse(req.body.options); } catch { fs.rmSync(req.file.path, { force: true }); throw new studio.StudioError(400, 'options_invalid', 'options must be JSON'); } }
  try {
    const r = await studio.registerUpload({ tmpPath: req.file.path, originalName: req.file.originalname, options });
    res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: r.duplicate, project: studio.view(r.project) });
  } catch (e) { fs.rmSync(req.file.path, { force: true }); throw e; }
}));

const media = (name) => wrap((req, res) => {
  const p = studio.getProject(req.params.id);
  const n = Number(req.params.n);
  const v = p.versions.find(x => x.n === n);
  if (!v || !v.artifacts[name]) throw new studio.StudioError(404, 'artifact_not_found', 'הקובץ לא קיים בגרסה הזו');
  sendRange(req, res, studio.artifactPath(p.id, n, name), studio.ARTIFACTS[name].mime, { ETag: `"${v.artifacts[name].sha256}"` });
});
panelRouter.get('/projects/:id/versions/:n/video',  media('final.mp4'));
panelRouter.get('/projects/:id/versions/:n/cover',  media('cover.jpg'));
panelRouter.get('/projects/:id/versions/:n/checks', media('checks.json'));

const act = fn => [json, wrap((req, res) => res.json({ ok: true, project: fn(req.params.id, req.body ?? {}) }))];
panelRouter.patch('/projects/:id/package',        ...act(studio.editPackage));
panelRouter.post('/projects/:id/exceptions',      ...act(studio.recordException));
panelRouter.post('/projects/:id/review-confirm',  ...act(studio.confirmReview));
panelRouter.post('/projects/:id/approve',         ...act(studio.approve));
panelRouter.post('/projects/:id/request-changes', ...act(studio.requestChanges));
panelRouter.post('/projects/:id/reject',          ...act(studio.reject));
panelRouter.post('/projects/:id/consent',         ...act(studio.setConsent));
panelRouter.post('/projects/:id/retry',           ...act((id) => studio.retry(id)));
/** RESCHEDULE: a new time for content that is already approved is a re-approval of the same content. */
panelRouter.post('/projects/:id/reschedule', json, wrap((req, res) => {
  const p = studio.getProject(req.params.id), v = studio.currentVersion(p), was = studio.approvalValid(v);
  studio.editPackage(p.id, { scheduledAt: req.body?.scheduledAt ?? null });
  if (was && req.body?.keepApproval === true) studio.approve(p.id, { fingerprint: studio.fingerprint(v), by: req.body?.by });
  res.json({ ok: true, project: studio.view(p) });
}));
/** The seam only: scheduling a publication is refused while any gate is closed. Nothing is ever posted here. */
panelRouter.post('/projects/:id/publish', json, wrap((req, res) => { const p = studio.getProject(req.params.id); publisher.createPublication(p); res.json({ ok: true, project: studio.view(p) }); }));
panelRouter.post('/projects/:id/publish/cancel', json, wrap((req, res) => { const p = studio.getProject(req.params.id); publisher.cancel(p); res.json({ ok: true, project: studio.view(p) }); }));

panelRouter.get('/brand', wrap((_req, res) => res.json({ ok: true, brand: brand.get() })));
panelRouter.put('/brand/:field', json, wrap((req, res) => res.json({ ok: true, brand: brand.set(req.params.field, req.body?.value, req.body?.by) })));

module.exports = { workerRouter, panelRouter, sendRange };
