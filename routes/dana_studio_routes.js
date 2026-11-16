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
const refs      = require('../services/dana_references');
const skills    = require('../services/dana_skills');

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
/** Any other file of the project that the job needs: a further source video, the music, the narration. By content hash. */
workerRouter.get('/jobs/:id/files/:sha', wrap((req, res) => {
  const j = studio.leasedJob(req.params.id, leaseOf(req));
  const f = media_.fileFor(studio.getProject(j.projectId), String(req.params.sha));
  if (!f) throw new studio.StudioError(404, 'file_not_found', 'the file does not belong to this project');
  sendRange(req, res, media_.filePath(f), 'application/octet-stream', { 'X-Content-SHA256': f.sha256 });
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
// Reference analysis: the worker leases a reference FILE the owner uploaded, analyses it locally and posts the result.
workerRouter.post('/references/lease', json, wrap((req, res) => { const l = refs.leaseNext(req.body ?? {}); return l ? res.json(l) : res.status(204).end(); }));
workerRouter.get('/references/:id/file', wrap((req, res) => {
  const f = refs.leasedFile(req.params.id, leaseOf(req));
  sendRange(req, res, f.path, 'application/octet-stream', { 'X-Content-SHA256': f.sha256 });
}));
workerRouter.post('/references/:id/analysis', json, wrap((req, res) => { const r = refs.submitAnalysis(req.params.id, leaseOf(req), req.body ?? {}); res.json({ ok: true, status: r.status }); }));
// Skill drafts from the owner's written instructions: structured by a tool-free model call on the editing computer.
workerRouter.post('/skills/lease', json, wrap((req, res) => { const l = skills.leaseNext(req.body ?? {}); return l ? res.json(l) : res.status(204).end(); }));
workerRouter.post('/skills/:id/draft', json, wrap((req, res) => { const k = skills.submitDraft(req.params.id, leaseOf(req), req.body ?? {}); res.json({ ok: true, status: k.status }); }));
workerRouter.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// ── Panel API ─────────────────────────────────────────────────────────────────
const media_ = require('../services/dana_media');
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
  notifications: require('../services/dana_notify').realEnabled() ? 'real' : 'mock', maxUploadMb: maxUploadMb(), brandMissing: brand.missing(),
  instagramAccount: brand.get().instagram_account.value ?? null, defaultProfile: refs.defaultProfile(), styleLimits: studio.STYLE_OVERRIDABLE,
  accounts: brand.accounts(), adjustmentKinds: studio.ADJUSTMENT_KINDS, phases: studio.PHASES, targets: studio.TARGETS,
  connectors: connectors(),
  // Set only on a preview that shows test material: the page then marks everything as test data and synthetic approvals.
  dataBanner: process.env.DANA_DATA_BANNER ? String(process.env.DANA_DATA_BANNER).slice(0, 300) : null })));
// ── Notification: configuration check and ONE explicit test (real mode only) ──
panelRouter.get('/notify/status', wrap((_req, res) => res.json({ ok: true, notify: require('../services/dana_notify').status() })));
panelRouter.post('/notify/test', json, wrap(async (req, res) => res.json({ ok: true, ...(await require('../services/dana_notify').sendTest(req.body ?? {})) })));

panelRouter.get('/projects', wrap((_req, res) => { studio.recover(); require('../services/dana_notify').flush().catch(() => {}); res.json({ ok: true, worker: studio.workerStatus(), projects: studio.list() }); }));
/** `?version=N` shows that version (read-only); without it: the current version, or the last finished one while a new one is being made. */
panelRouter.get('/projects/:id', wrap((req, res) => { studio.recover();
  const n = req.query.version !== undefined && /^\d{1,4}$/.test(String(req.query.version)) ? Number(req.query.version) : undefined;
  res.json({ ok: true, worker: studio.workerStatus(), project: studio.view(studio.getProject(req.params.id), n) }); }));

panelRouter.post('/upload', upload, wrap(async (req, res) => {
  if (!req.file) throw new studio.StudioError(400, 'file_missing', 'לא נבחר קובץ וידאו (שדה: video)');
  let options = {};
  if (req.body?.options) { try { options = JSON.parse(req.body.options); } catch { fs.rmSync(req.file.path, { force: true }); throw new studio.StudioError(400, 'options_invalid', 'options must be JSON'); } }
  try {
    const r = await studio.registerUpload({ tmpPath: req.file.path, originalName: req.file.originalname, options });
    res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: r.duplicate, project: studio.view(r.project) });
  } catch (e) { fs.rmSync(req.file.path, { force: true }); throw e; }
}));

// ── external connections: what is prepared, what is active, and the ONE action that is still needed ──
// Nothing here calls a provider. The narration key lives only on the editing computer; the panel learns only whether it is present.
const TTS_RATES = { eleven_v3: 0.08, eleven_v4: 0.08, eleven_v4_turbo: 0.04 }, TTS_READ_ON = '2026-11-16';
function connectors() {
  const tts = studio.workerStatus()?.capabilities?.narration_tts ?? null;
  return {
    narration_tts: { provider: 'ElevenLabs', state: tts?.active ? 'active' : 'prepared_not_active', key_present: tts?.key_present ?? null, enabled: tts?.enabled ?? null,
      what: 'קריינות מטקסט מאושר (תסריט, לא ציטוט). דיבוב אודיו קיים הוא יכולת נפרדת של אותו ספק, עם שכפול קול כבוי כברירת מחדל.',
      never_called: !tts?.active, rates_usd_per_1000_chars: TTS_RATES, rates_read_on: TTS_READ_ON, dubbing_usd_per_minute: { v1: 0.5, v2: 2.2 },
      needs: tts?.active ? [] : ['חשבון ElevenLabs במסלול בתשלום (המסלול החינמי אסור לשימוש מסחרי; המינימום שנקרא: Starter, 6$ לחודש)',
        'בהגדרות החשבון: ביטול השימוש בתוכן לאימון, לפני השליחה הראשונה', 'מפתח API, שיוגדר במחשב העריכה בלבד (לא בפאנל)', 'אישור שלך לטקסט ולתקרת עלות לפני כל יצירה'],
      next_action: tts?.active ? null : 'לפתוח חשבון בתשלום ב-ElevenLabs ולמסור לי שהמפתח מוכן להגדרה במחשב העריכה. עד אז: העלאת קריינות מוכנה עובדת.' },
    music_library: { state: 'manual_upload_only', what: 'מוזיקה נכנסת בהעלאה ידנית בלבד. לכל רצועה נשמרים המקור והרישיון שרשמת; קובץ שהועלה אינו מסומן כמורשה מעצמו.',
      options: [{ name: 'ספרייה מקומית מרצועות שהורדת בעצמך (למשל Jamendo Licensing או Pixabay)', state: 'עובד היום דרך ההעלאה', needs: 'לאשר מול הספק שהרישיון מכסה חשבון עסקי ופוסטים ממומנים' },
        { name: 'Epidemic Sound (חיפוש לפי סגנון, מצב רוח וקצב)', state: 'לא מחובר', needs: 'מנוי, אישור שלהם לשימוש בכלי אוטומטי משלנו, ומחיר — לא אומתו' },
        { name: 'CapCut', state: 'לא אפשרי', needs: 'אין API, והתנאים אוסרים שימוש מחוץ לאפליקציה' }],
      next_action: 'להחליט אם להסתפק בספרייה מקומית, או לברר מול Epidemic Sound מחיר ותנאי שימוש בכלי אוטומטי.' },
    publishing: { state: 'off', what: 'פרסום והתראות אמיתיות כבויים. פרסום סטורי לא נוסה מעולם.' } };
}
/** What is stored, how much room is left, and the one cleanup the owner may ask for (leftovers of interrupted uploads). */
panelRouter.get('/storage', wrap((_req, res) => res.json({ ok: true, storage: studio.storage() })));
panelRouter.post('/storage/cleanup-upload-leftovers', json, wrap((req, res) => {
  if (!String(req.body?.by ?? '').trim()) throw new studio.StudioError(400, 'by_required', 'נדרש שם מי שמבקש/ת');
  res.json({ ok: true, storage: studio.storage({ cleanup: true }) });
}));
/** How much a narration of this text would cost. Arithmetic only: no request leaves the computer. The text is a SCRIPT. */
panelRouter.post('/narration/estimate', json, wrap((req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 20000), model = TTS_RATES[req.body?.model] ? req.body.model : 'eleven_v3', takes = Math.min(10, Math.max(1, Number(req.body?.takes) || 1));
  if (text.trim().length < 2) throw new studio.StudioError(400, 'text_required', 'נדרש טקסט התסריט');
  res.json({ ok: true, estimate: { characters: text.length, model, usd_per_1000_chars: TTS_RATES[model], takes, estimated_usd: Math.round(text.length / 1000 * TTS_RATES[model] * takes * 10000) / 10000,
    within_request_limit: text.length <= 5000, text_is: 'script',
    basis: `מחירון ה-API של ElevenLabs כפי שנקרא ב-${TTS_READ_ON}; יש לאמת מול הדף העדכני לפני אישור. לא נשלח דבר לספק.` }, connector: connectors().narration_tts });
}));

// ── more files in a project: further source videos, music, narration; marks and mix settings ──
const oneFile = (field, mb) => (req, res, next) => multer({
  storage: multer.diskStorage({ destination: (_r, _f, cb) => cb(null, tmpDir()), filename: (_r, _f, cb) => cb(null, `up_${crypto.randomBytes(8).toString('hex')}`) }),
  limits: { fileSize: mb() * 1024 * 1024, files: 1 },
}).single(field)(req, res, err => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, error: err.code ?? 'upload_failed', message: err.code === 'LIMIT_FILE_SIZE' ? `הקובץ גדול מהמותר (${mb()}MB)` : err.message });
  next();
});
panelRouter.post('/projects/:id/sources', oneFile('video', maxUploadMb), wrap(async (req, res) => {
  if (!req.file) throw new studio.StudioError(400, 'file_missing', 'לא נבחר קובץ וידאו (שדה: video)');
  const r = await media_.addSource(req.params.id, { tmpPath: req.file.path, originalName: req.file.originalname, by: req.body?.by });
  res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: r.duplicate, project: r.project });
}));
panelRouter.patch('/projects/:id/sources/:sid/marks', json, wrap((req, res) => res.json({ ok: true, project: media_.setMarks(req.params.id, req.params.sid, req.body ?? {}) })));
panelRouter.delete('/projects/:id/sources/:sid', json, wrap((req, res) => res.json({ ok: true, project: media_.removeSource(req.params.id, req.params.sid, req.body ?? {}) })));
panelRouter.get('/projects/:id/sources/:sid/video', wrap((req, res) => {
  const s = media_.sourcesOf(studio.getProject(req.params.id)).find(x => x.id === req.params.sid);
  if (!s) throw new studio.StudioError(404, 'source_not_found', 'קובץ המקור לא נמצא');
  sendRange(req, res, media_.filePath(s), 'video/mp4', { ETag: `"${s.sha256}"` });
}));
panelRouter.post('/projects/:id/assets', oneFile('file', () => Math.min(maxUploadMb(), 300)), wrap(async (req, res) => {
  if (!req.file) throw new studio.StudioError(400, 'file_missing', 'לא נבחר קובץ אודיו (שדה: file)');
  const r = await media_.addAsset(req.params.id, { tmpPath: req.file.path, originalName: req.file.originalname, kind: req.body?.kind, by: req.body?.by });
  res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: r.duplicate, asset: r.asset, project: r.project });
}));
panelRouter.get('/projects/:id/assets/:aid/audio', wrap((req, res) => {
  const a = (studio.getProject(req.params.id).assets ?? []).find(x => x.id === req.params.aid);
  if (!a) throw new studio.StudioError(404, 'asset_not_found', 'קובץ האודיו לא נמצא');
  sendRange(req, res, media_.filePath(a), media_.AUDIO_MIME[a.ext] ?? 'application/octet-stream', { ETag: `"${a.sha256}"` });
}));
panelRouter.post('/projects/:id/assets/:aid/license', json, wrap((req, res) => res.json({ ok: true, project: media_.setLicense(req.params.id, req.params.aid, req.body ?? {}) })));
panelRouter.post('/projects/:id/assets/:aid/narration-info', json, wrap((req, res) => res.json({ ok: true, project: media_.setNarrationInfo(req.params.id, req.params.aid, req.body ?? {}) })));
panelRouter.patch('/projects/:id/brief', json, wrap((req, res) => res.json({ ok: true, project: media_.setBrief(req.params.id, req.body ?? {}) })));
panelRouter.patch('/projects/:id/audio', json, wrap((req, res) => res.json({ ok: true, project: media_.setAudio(req.params.id, req.body ?? {}) })));

const media = (name) => wrap((req, res) => {
  const p = studio.getProject(req.params.id);
  const n = Number(req.params.n);
  const v = p.versions.find(x => x.n === n);
  if (!v || !v.artifacts[name]) throw new studio.StudioError(404, 'artifact_not_found', 'הקובץ לא קיים בגרסה הזו');
  sendRange(req, res, studio.artifactPath(p.id, n, name), studio.ARTIFACTS[name].mime, { ETag: `"${v.artifacts[name].sha256}"` });
});
/** The video of a version. For a review-only version it is the file the owner uploaded (nothing was rendered). */
panelRouter.get('/projects/:id/versions/:n/video', wrap((req, res) => {
  const p = studio.getProject(req.params.id), n = Number(req.params.n), v = p.versions.find(x => x.n === n);
  if (v?.videoIsSource) return sendRange(req, res, studio.sourcePath(p.source), 'video/mp4', { ETag: `"${p.source.sha256}"` });
  if (!v || !v.artifacts['final.mp4']) throw new studio.StudioError(404, 'artifact_not_found', 'הקובץ לא קיים בגרסה הזו');
  sendRange(req, res, studio.artifactPath(p.id, n, 'final.mp4'), 'video/mp4', { ETag: `"${v.artifacts['final.mp4'].sha256}"` });
}));
panelRouter.get('/projects/:id/versions/:n/compare-frames', media('compare_frames.jpg'));
for (const k of [1, 2, 3, 4]) panelRouter.get(`/projects/:id/versions/:n/story-part-${k}`, media(`story_part_${k}.mp4`));
panelRouter.get('/projects/:id/versions/:n/compare-clip',   media('compare_clip.mp4'));
panelRouter.get('/projects/:id/versions/:n/readable-compare', media('readable_compare.mp4'));
panelRouter.get('/projects/:id/versions/:n/cover',  media('cover.jpg'));
panelRouter.get('/projects/:id/versions/:n/checks', media('checks.json'));
panelRouter.get('/projects/:id/versions/:n/editorial', media('editorial.json'));

const act = fn => [json, wrap((req, res) => res.json({ ok: true, project: fn(req.params.id, req.body ?? {}) }))];
panelRouter.patch('/projects/:id/package',        ...act(studio.editPackage));
panelRouter.post('/projects/:id/exceptions',      ...act(studio.recordException));
panelRouter.post('/projects/:id/review-confirm',  ...act(studio.confirmReview));
panelRouter.post('/projects/:id/hearing',         ...act(studio.decideHearing));
panelRouter.post('/projects/:id/start',           ...act(studio.start));
panelRouter.post('/projects/:id/replan',          ...act(studio.replan));
panelRouter.post('/projects/:id/approve',         ...act(studio.approve));
panelRouter.post('/projects/:id/request-changes', ...act(studio.requestChanges));
/** "הפק גרסה מתוקנת": caption corrections + style + zoom changes + an optional note (project-only or standing rule) → the next version. */
panelRouter.post('/projects/:id/revise',          ...act(studio.revise));
panelRouter.post('/projects/:id/reject',          ...act(studio.reject));
/** "אמת ושמור תיקון": one caption, after listening. Stored on the project; not an approval to publish. */
panelRouter.post('/projects/:id/captions/verify', ...act(studio.verifyCaption));
/** Destination account (one of the connected accounts) and which kinds of adjustment are on for this project. */
panelRouter.patch('/projects/:id/settings',       ...act(studio.setSettings));
/** "יישם שיפורים והפק גרסה חדשה": Dana applies what her review found and she may change by herself. */
panelRouter.post('/projects/:id/apply-review',    ...act(studio.applyReview));
/** A new version of this project, planned, edited and reviewed by a library skill (the project's choice or the approved default). */
panelRouter.post('/projects/:id/apply-skill',     ...act(studio.applySkill));
panelRouter.post('/projects/:id/consent',         ...act(studio.setConsent));
panelRouter.post('/projects/:id/retry',           ...act((id) => studio.retry(id)));
/** RESCHEDULE: a new time for content that is already approved is a re-approval of the same content. */
panelRouter.post('/projects/:id/reschedule', json, wrap((req, res) => {
  const p = studio.getProject(req.params.id), v = studio.currentVersion(p), was = studio.approvalValid(v);
  studio.editPackage(p.id, req.body?.scheduledLocal !== undefined ? { scheduledLocal: req.body.scheduledLocal } : { scheduledAt: req.body?.scheduledAt ?? null });
  if (was && req.body?.keepApproval === true) studio.approve(p.id, { fingerprint: studio.fingerprint(v), by: req.body?.by });
  res.json({ ok: true, project: studio.view(p) });
}));
/** The seam only: scheduling a publication is refused while any gate is closed. Nothing is ever posted here. */
panelRouter.post('/projects/:id/publish', json, wrap((req, res) => { const p = studio.getProject(req.params.id); publisher.createPublication(p); res.json({ ok: true, project: studio.view(p) }); }));
panelRouter.post('/projects/:id/publish/cancel', json, wrap((req, res) => { const p = studio.getProject(req.params.id); publisher.cancel(p); res.json({ ok: true, project: studio.view(p) }); }));

// ── Calendar, global pause, publication recovery (dry-run: MOCK publisher only) ──
panelRouter.get('/calendar', wrap((_req, res) => res.json({ ok: true, timezone: publisher.TZ, paused: publisher.paused(), mode: publisher.enabled() ? publisher.mode() : null, items: publisher.calendar() })));
panelRouter.post('/settings/pause', json, wrap((req, res) => res.json({ ok: true, settings: publisher.setPaused(req.body?.paused === true) })));
panelRouter.post('/projects/:id/publish/resume', json, wrap((req, res) => { const p = studio.getProject(req.params.id); publisher.resume(p); res.json({ ok: true, project: studio.view(p) }); }));
panelRouter.post('/projects/:id/publish/reconcile', json, wrap(async (req, res) => { const p = studio.getProject(req.params.id); await publisher.reconcile(p, publisher.configuredPublisher()); res.json({ ok: true, project: studio.view(p) }); }));
/** One scheduler pass. `now` may be supplied only with the MOCK publisher (a dry run reaching a scheduled time); a real provider always uses the clock. */
panelRouter.post('/publisher/tick', json, wrap(async (req, res) => {
  const mock = publisher.mode() === 'mock';
  const now = mock && req.body?.now ? Date.parse(req.body.now) : Date.now();
  res.json({ ok: true, mock, report: await publisher.tick(publisher.configuredPublisher(), { now }) });
}));
/** Read-only connection check for the real provider: configuration (names only) and, on request, who the token belongs to. Publishes nothing. */
panelRouter.get('/publisher/status', wrap(async (req, res) => {
  const ig = require('../services/dana_instagram');
  const out = { ok: true, enabled: publisher.enabled(), mode: publisher.mode(), paused: publisher.paused(), instagram: ig.status() };
  // The probe is two GET requests (account, quota). It works with every publishing switch off, so the
  // connection can be checked right after a deployment and long before anything may be published.
  if (req.query.probe === '1' && ig.status().credentialsConfigured) {
    const p = new ig.InstagramPublisher({ files: () => null, readOnly: true });
    try { out.account = await p.whoAmI(); out.limit = await p.publishingLimit(); } catch (e) { out.probeError = { code: e.code, message: e.message }; }
  }
  res.json(out);
}));

panelRouter.get('/brand', wrap((_req, res) => res.json({ ok: true, brand: brand.get() })));
panelRouter.put('/brand/:field', json, wrap((req, res) => res.json({ ok: true, brand: brand.set(req.params.field, req.body?.value, req.body?.by) })));

// ── Standing rules (feedback the owner marked "כלל קבוע") ─────────────────────
panelRouter.get('/rules', wrap((_req, res) => res.json({ ok: true, rules: studio.listRules() })));
panelRouter.post('/rules/:id/retire', json, wrap((req, res) => res.json({ ok: true, rules: studio.retireRule(req.params.id, req.body?.by) })));
/** Reword a standing rule: a new version of the same rule (the earlier wording stays in its history). */
panelRouter.post('/rules/:id', json, wrap((req, res) => res.json({ ok: true, rules: studio.editRule(req.params.id, req.body ?? {}) })));

// ── Editing references and the approved profile ───────────────────────────────
// A reference FILE is analysed by the editing worker (it cannot fetch links). The analysis proposes a profile; only the owner approves one.
const REF_MIME = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska',
                   jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const refUpload = (req, res, next) => multer({
  storage: multer.diskStorage({ destination: (_r, _f, cb) => cb(null, tmpDir()), filename: (_r, _f, cb) => cb(null, `ref_${crypto.randomBytes(8).toString('hex')}`) }),
  limits: { fileSize: Math.min(maxUploadMb(), 500) * 1024 * 1024, files: 1 },
}).single('file')(req, res, err => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ ok: false, error: err.code ?? 'upload_failed',
    message: err.code === 'LIMIT_FILE_SIZE' ? 'קובץ הרפרנס גדול מהמותר (500MB)' : err.message });
  next();
});
const refsOut = () => ({ ok: true, references: refs.list(), default: refs.defaultProfile(), worker: studio.workerStatus(),
  analysis: { active: true, note: 'הניתוח נעשה במחשב העריכה, על קובץ שהועלה בלבד. דנה לא מורידה קישורים.' } });
panelRouter.get('/references', wrap((_req, res) => res.json(refsOut())));
panelRouter.post('/references', refUpload, wrap((req, res) => {
  const b = req.body ?? {};
  const ref = refs.add({ title: b.title, source_url: b.source_url, origin: b.origin, usage_permission: b.usage_permission, content_type: b.content_type,
    fits_message: b.fits_message, owner_note: b.owner_note, by: b.by, fixName: studio.fixName,
    file: req.file ? { tmpPath: req.file.path, originalName: req.file.originalname } : null });
  res.status(201).json({ ...refsOut(), reference: ref });
}));
panelRouter.delete('/references/:id', wrap((req, res) => { refs.remove(req.params.id); res.json(refsOut()); }));
panelRouter.post('/references/:id/reanalyse', json, wrap((req, res) => { const reference = refs.reanalyse(req.params.id); res.json({ ...refsOut(), reference }); }));
/** The owner approves the profile Dana proposed from this reference (optionally with adjusted numbers). Never automatic. */
panelRouter.post('/references/:id/approve-profile', json, wrap((req, res) => {
  const out = refs.approveReferenceProfile(req.params.id, { by: req.body?.by, make_default: req.body?.make_default === true, params: req.body?.params });
  res.json({ ...refsOut(), reference: out.reference, profile: out.profile });
}));
panelRouter.post('/references/:id/reject-profile', json, wrap((req, res) => { const reference = refs.rejectReferenceProfile(req.params.id, req.body ?? {}); res.json({ ...refsOut(), reference }); }));
panelRouter.get('/references/:id/file', wrap((req, res) => { const f = refs.filePath(req.params.id); sendRange(req, res, f.path, REF_MIME[f.ext] ?? 'application/octet-stream'); }));

/** Two or more analysed references side by side + a proposed combined profile (a proposal only). */
panelRouter.post('/references/compare', json, wrap((req, res) => res.json({ ok: true, comparison: refs.compare(req.body?.ids, { allowSingle: req.body?.single === true }) })));
/** The owner approves a combined profile: per number, which reference it is taken from. */
panelRouter.post('/profiles/combined', json, wrap((req, res) => {
  const out = refs.approveCombined({ by: req.body?.by, ids: req.body?.ids, picks: req.body?.picks, rules: req.body?.rules, make_default: req.body?.make_default === true });
  res.status(201).json({ ok: true, profile: out.profile, profiles: out.profiles, default: refs.defaultProfile() });
}));
// ── The editing-skill library (built on the references and profiles above) ───
const skillsOut = extra => ({ ok: true, skills: skills.list(), domains: skills.DOMAINS, paramLimits: skills.PARAM_LIMITS, profiles: refs.profiles(), ...extra });
panelRouter.get('/skills', wrap((_req, res) => res.json(skillsOut())));
panelRouter.get('/skills/:id', wrap((req, res) => res.json({ ok: true, skill: skills.get(req.params.id) })));
/** "צור סקיל מהניתוח": chosen findings and numbers of analysed references → a draft. */
panelRouter.post('/skills/from-analysis', json, wrap((req, res) => res.status(201).json(skillsOut({ skill: skills.createFromAnalysis(req.body ?? {}) }))));
/** "צור סקיל מהוראות": the owner's free text (optionally with reference findings) → a draft, structured by the editing worker. */
panelRouter.post('/skills/from-prompt', json, wrap((req, res) => res.status(201).json(skillsOut({ skill: skills.createFromPrompt(req.body ?? {}) }))));
panelRouter.post('/skills/from-profile', json, wrap((req, res) => res.status(201).json(skillsOut({ skill: skills.createFromProfile(req.body ?? {}) }))));
panelRouter.put('/skills/:id', json, wrap((req, res) => res.json(skillsOut({ skill: skills.saveDraft(req.params.id, req.body ?? {}) }))));
panelRouter.post('/skills/:id/approve', json, wrap((req, res) => res.json(skillsOut({ skill: skills.approve(req.params.id, req.body ?? {}) }))));
panelRouter.post('/skills/:id/default', json, wrap((req, res) => res.json(skillsOut({ skill: skills.setDefault(req.params.id, req.body ?? {}) }))));
/** "שדרג סקיל באמצעות רפרנס": a draft of the next version with an explicit comparison; nothing in use changes until it is approved. */
panelRouter.post('/skills/:id/upgrade', json, wrap((req, res) => res.status(201).json(skillsOut({ skill: skills.upgrade(req.params.id, req.body ?? {}) }))));
/** The approved default COMBINATION of skills, in priority order. */
panelRouter.post('/skills/default-set', json, wrap((req, res) => { const out = skills.setDefaultSet(req.body ?? {}); res.json(skillsOut({ conflicts: out.conflicts })); }));
panelRouter.post('/skills/:id/retire', json, wrap((req, res) => res.json(skillsOut({ skill: skills.retire(req.params.id, req.body ?? {}) }))));
/** Try a DRAFT on one clip: a new version of that project, marked as a skill test. */
panelRouter.post('/skills/:id/test', json, wrap((req, res) => res.json({ ok: true, project: studio.testSkill(req.params.id, req.body ?? {}) })));

panelRouter.get('/profiles', wrap((_req, res) => res.json({ ok: true, profiles: refs.profiles(), default: refs.defaultProfile() })));
/** Approve the profile that a finished version was actually edited with as the default for future projects. */
panelRouter.post('/profiles/:id/approve', json, wrap((req, res) => {
  const p = studio.getProject(String(req.body?.projectId ?? '')), v = req.body?.version ? p.versions.find(x => x.n === Number(req.body.version)) : studio.currentVersion(p);
  if (!v?.package) throw new studio.StudioError(409, 'not_reviewable', 'אין חבילה בגרסה הזו');
  res.json({ ok: true, profiles: refs.approveProfile(req.params.id, { package: v.package, projectId: p.id, versionN: v.n, by: req.body?.by }), default: refs.defaultProfile() });
}));
panelRouter.post('/profiles/clear-default', json, wrap((_req, res) => res.json({ ok: true, profiles: refs.clearDefaultProfile(), default: null })));

module.exports = { workerRouter, panelRouter, sendRange };
