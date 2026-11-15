'use strict';

/**
 * dana_studio.js — Dana phase 1A: raw upload → automated edit → mobile review package.
 *
 * The server only COORDINATES. It never edits video: a local worker polls for jobs
 * (outbound from the worker), edits, and uploads the artifacts back.
 *
 * Durable state lives in DATA_DIR/dana/:
 *   studio.json                      projects, jobs, worker status (atomic write; a failed write throws)
 *   events.jsonl                     append-only log: who did what, when, with which version
 *   sources/<sha256>.<ext>           uploaded originals — content-addressed, never modified
 *   projects/<id>/v<N>/<artifact>    verified artifacts of each package version
 *
 * Job lifecycle:   queued → leased → succeeded | review_required | waiting | failed
 * A lease expires when the worker stops reporting; the job then returns to the queue
 * (bounded attempts) — also after a server restart, because the lease is on disk.
 *
 * Nothing here publishes, messages a customer, or touches Tomer / Barak state.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const LEASE_MS        = Number(process.env.DANA_LEASE_SECONDS  || 120) * 1000;
const WORKER_ALIVE_MS = Number(process.env.DANA_WORKER_ALIVE_SECONDS || 30) * 1000;
const MAX_ATTEMPTS    = 3;
const RETRY_DELAY_MS  = Number(process.env.DANA_RETRY_DELAY_SECONDS ?? 15) * 1000;

const ARTIFACTS = {            // name → { mime, required }
  'final.mp4':              { mime: 'video/mp4',        required: true  },
  'cover.jpg':              { mime: 'image/jpeg',       required: true  },
  'package.json':           { mime: 'application/json', required: true  },
  'checks.json':            { mime: 'application/json', required: true  },
  'captions.json':          { mime: 'application/json', required: true  },
  'editorial.json':         { mime: 'application/json', required: false },
  'transcript_source.json': { mime: 'application/json', required: false },
  'transcript_final.json':  { mime: 'application/json', required: false },
};
const SOURCE_EXT       = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);
// Keys a project may override, with the range the worker accepts. Anything else is refused.
const STYLE_OVERRIDABLE = {
  caption_size: { type: 'number', min: 40, max: 140 }, caption_y_px: { type: 'number', min: 200, max: 1700 },
  caption_max_lines: { type: 'number', oneOf: [1, 2] }, highlight_enabled: { type: 'boolean' }, backing: { type: 'boolean' },
  cover_size: { type: 'number', min: 40, max: 220 }, cover_y_px: { type: 'number', min: 100, max: 1800 },
};
const MAX_CAPTION_EDITS = 300, MAX_ZOOM_EDITS = 60, MAX_ACTIVE_RULES = 50;
const ADAPTERS         = new Set(['heuristic', 'scripted', 'claude']);

const now   = () => new Date().toISOString();
const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const dir   = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'dana');
const file  = () => path.join(dir(), 'studio.json');

class StudioError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

// ── Durable store ─────────────────────────────────────────────────────────────
let _state = null, _stateDir = null;
function state() {
  if (_state && _stateDir === dir()) return _state;
  _stateDir = dir();
  fs.mkdirSync(path.join(_stateDir, 'sources'), { recursive: true });
  try { _state = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`dana studio state is unreadable (${e.message}) — refusing to start empty`);
    _state = { projects: {}, jobs: {}, worker: null };
  }
  return _state;
}
function save() {
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_state, null, 1), 'utf8');   // throws → caller fails loudly
  fs.renameSync(tmp, file());
}
function event(type, data) {
  try { fs.appendFileSync(path.join(dir(), 'events.jsonl'), JSON.stringify({ at: now(), type, ...data }) + '\n'); } catch { /* log only */ }
}
function _resetForTests() { _state = null; _stateDir = null; }

function hist(project, actor, action, detail) {
  project.history.push({ at: now(), actor, action, ...(detail ? { detail } : {}) });
  event(action, { projectId: project.id, actor, detail });
}

// ── Files ─────────────────────────────────────────────────────────────────────
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}
const sourcePath   = (src) => path.join(dir(), 'sources', `${src.sha256}.${src.ext}`);
const versionDir   = (projectId, n) => path.join(dir(), 'projects', projectId, `v${n}`);
const artifactPath = (projectId, n, name) => {
  if (!ARTIFACTS[name]) throw new StudioError(400, 'artifact_unknown', `unknown artifact: ${name}`);
  return path.join(versionDir(projectId, n), name);
};

// ── Projects and uploads ──────────────────────────────────────────────────────
function getProject(id) {
  const p = state().projects[id];
  if (!p) throw new StudioError(404, 'project_not_found', 'פרויקט לא נמצא');
  return p;
}
function currentVersion(p) { return p.versions.find(v => v.n === p.currentVersion) ?? null; }

/**
 * A Hebrew file name arrives from the multipart parser as latin1 bytes ("×©×..."). When the
 * string is pure latin1 and those bytes are valid UTF-8, it is decoded; anything else is left alone.
 */
function fixName(name) {
  const str = String(name ?? '');
  if (!/[\u0080-\u00ff]/.test(str) || /[^\u0000-\u00ff]/.test(str)) return str;
  const u = Buffer.from(str, 'latin1').toString('utf8');
  return u.includes('\ufffd') ? str : u;
}

/**
 * The adapter the SERVER asks for. null = no request: the worker's own configuration decides.
 * Projects created before this rule stored 'heuristic' as a silent default; without the explicit
 * flag that value is not a request.
 */
function projectAdapter(p) {
  if (p.adapterExplicit) return p.adapter ?? null;
  return p.adapter && p.adapter !== 'heuristic' ? p.adapter : null;
}

const num = (x) => typeof x === 'number' && Number.isFinite(x);
function sanitizeCaptionEdits(list) {
  if (!Array.isArray(list) || list.length > MAX_CAPTION_EDITS) throw new StudioError(400, 'caption_edits_invalid', 'רשימת תיקוני הכתוביות אינה תקינה');
  return list.map(e => {
    if (!e || typeof e !== 'object' || !num(e.source_start_s) || !num(e.source_end_s) || e.source_start_s < 0 || !(e.source_end_s > e.source_start_s) || e.source_end_s > 86400)
      throw new StudioError(400, 'caption_edits_invalid', 'תיקון כתובית חייב לכלול זמני מקור תקינים');
    const text = String(e.text ?? '').trim();
    if (!text || text.length > 80 || /[\r\n]/.test(text)) throw new StudioError(400, 'caption_edits_invalid', 'טקסט הכתובית חייב להיות 1–80 תווים, בלי ירידת שורה');
    return { source_start_s: Math.round(e.source_start_s * 1000) / 1000, source_end_s: Math.round(e.source_end_s * 1000) / 1000,
             original: String(e.original ?? '').slice(0, 200), text };
  });
}
function sanitizeZoomEdits(list) {
  if (!Array.isArray(list) || list.length > MAX_ZOOM_EDITS) throw new StudioError(400, 'zoom_edits_invalid', 'רשימת שינויי הזום אינה תקינה');
  return list.map(z => {
    if (!z || typeof z !== 'object' || typeof z.id !== 'string' || !/^[\w@.:-]{1,40}$/.test(z.id) || !['remove', 'set'].includes(z.action))
      throw new StudioError(400, 'zoom_edits_invalid', 'שינוי זום חייב לכלול מזהה ופעולה (remove | set)');
    if (z.action === 'set' && !(num(z.scale) && z.scale >= 1.05 && z.scale <= 1.5)) throw new StudioError(400, 'zoom_edits_invalid', 'עוצמת זום חייבת להיות בין 1.05 ל-1.5');
    return z.action === 'set' ? { id: z.id, action: 'set', scale: Math.round(z.scale * 100) / 100 } : { id: z.id, action: 'remove' };
  });
}

function sanitizeOptions(o = {}) {
  const out = {};
  if (o.adapter !== undefined) {
    if (!ADAPTERS.has(o.adapter)) throw new StudioError(400, 'adapter_invalid', 'adapter must be heuristic | scripted | claude');
    out.adapter = o.adapter;
  }
  if (o.style_overrides && typeof o.style_overrides === 'object') {
    out.style_overrides = {};
    for (const [k, v] of Object.entries(o.style_overrides)) {
      const rule = STYLE_OVERRIDABLE[k];
      if (!rule) throw new StudioError(400, 'style_override_invalid', `style override not allowed: ${k}`);
      if (typeof v !== rule.type || (rule.type === 'number' && !Number.isFinite(v))) throw new StudioError(400, 'style_override_invalid', `${k} must be ${rule.type}`);
      if (rule.oneOf && !rule.oneOf.includes(v)) throw new StudioError(400, 'style_override_invalid', `${k} must be one of ${rule.oneOf.join(' | ')}`);
      if (rule.min != null && (v < rule.min || v > rule.max)) throw new StudioError(400, 'style_override_invalid', `${k} must be between ${rule.min} and ${rule.max}`);
      out.style_overrides[k] = v;
    }
  }
  if (o.decisions !== undefined) {
    // Decisions are DATA for the worker's validator (segment, card texts, cover, caption).
    const d = o.decisions;
    if (!d || typeof d !== 'object' || Array.isArray(d) || !d.segment || !Array.isArray(d.cards)) throw new StudioError(400, 'decisions_invalid', 'decisions need segment and cards');
    if (JSON.stringify(d).length > 200000) throw new StudioError(400, 'decisions_invalid', 'decisions are too large');
    out.decisions = d; out.adapter = 'scripted';
  }
  if (o.change_request) out.change_request = String(o.change_request).slice(0, 2000);
  if (o.test_inject !== undefined) {
    // Engineering verification only: a labelled defect is injected so the review → revise loop can be observed.
    if (o.test_inject !== 'unverified_price_and_paraphrased_cover') throw new StudioError(400, 'test_inject_invalid', 'unknown test injection');
    out.test_inject = o.test_inject;
  }
  if (o.caption_edits !== undefined) out.caption_edits = sanitizeCaptionEdits(o.caption_edits);
  if (o.zoom_edits !== undefined) out.zoom_edits = sanitizeZoomEdits(o.zoom_edits);
  if (o.exclude_ranges !== undefined) {
    const r = o.exclude_ranges;
    if (!Array.isArray(r) || r.length > 30 || !r.every(x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && x[0] < x[1]))
      throw new StudioError(400, 'exclude_ranges_invalid', 'exclude_ranges must be a list of [start, end] seconds');
    out.exclude_ranges = r;
  }
  return out;
}

/** Register an uploaded file. Same bytes as an existing source → no second copy, no second project. */
async function registerUpload({ tmpPath, originalName, options, actor = 'owner' }) {
  originalName = fixName(originalName);
  const ext = (String(originalName || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (!SOURCE_EXT.has(ext)) { fs.rmSync(tmpPath, { force: true }); throw new StudioError(400, 'format_unsupported', `פורמט לא נתמך: .${ext || '?'}`); }
  const bytes = fs.statSync(tmpPath).size;
  if (bytes < 1024) { fs.rmSync(tmpPath, { force: true }); throw new StudioError(400, 'file_empty', 'הקובץ ריק'); }
  const sha256 = await hashFile(tmpPath);
  const s = state();
  const existing = Object.values(s.projects).find(p => p.source.sha256 === sha256);
  if (existing) {
    fs.rmSync(tmpPath, { force: true });
    hist(existing, actor, 'duplicate_upload', { originalName });
    save();
    return { duplicate: true, project: existing };
  }
  const opts = sanitizeOptions(options);
  const source = { sha256, ext, bytes, originalName: String(originalName).slice(0, 200), uploadedAt: now() };
  const dest = sourcePath(source);
  if (!fs.existsSync(dest)) fs.renameSync(tmpPath, dest); else fs.rmSync(tmpPath, { force: true });
  const project = {
    id: newId('prj'), title: String(originalName).replace(/\.[^.]+$/, '').slice(0, 120), createdAt: now(),
    source, status: 'editing', adapter: opts.adapter ?? null, adapterExplicit: opts.adapter !== undefined,   // null → the worker's configuration decides
    styleOverrides: opts.style_overrides ?? {}, excludeRanges: opts.exclude_ranges ?? [], captionEdits: [], zoomEdits: [],
    versions: [], currentVersion: 0,
    consent: { status: 'unknown', note: null, by: null, at: null },   // publication consent of the people in the footage
    rights: { music: 'none' },                                         // phase 1A: no music
    publication: null, history: [],
  };
  s.projects[project.id] = project;
  hist(project, actor, 'uploaded', { sha256, bytes, originalName: source.originalName });
  enqueueEdit(project, opts, actor);
  save();
  return { duplicate: false, project };
}

function enqueueEdit(project, options, actor) {
  const s = state();
  const open = Object.values(s.jobs).find(j => j.projectId === project.id && ['queued', 'leased'].includes(j.status));
  if (open) throw new StudioError(409, 'job_in_progress', 'כבר יש עריכה פעילה לפרויקט הזה');
  const n = (project.versions.at(-1)?.n ?? 0) + 1;
  const adapter = options.adapter ?? projectAdapter(project);
  const rules = activeRules(), profile = require('./dana_references').defaultProfile();
  const job = {
    id: newId('job'), projectId: project.id, version: n, type: 'edit', status: 'queued',
    attempts: 0, maxAttempts: MAX_ATTEMPTS, lease: null, notBefore: null,
    stage: 'queued', note: 'ממתין לעובד העריכה', error: null, uploaded: {},
    options: { ...(adapter ? { adapter } : {}),                       // no key → the worker decides (its config is authoritative)
               style_overrides: { ...project.styleOverrides, ...(options.style_overrides ?? {}) },
               ...(options.decisions ? { decisions: options.decisions } : {}), ...(options.change_request ? { change_request: options.change_request } : {}),
               ...(options.previous ? { previous: options.previous } : {}), ...(options.test_inject ? { test_inject: options.test_inject } : {}),
               ...((project.excludeRanges ?? []).length ? { exclude_ranges: project.excludeRanges } : {}),
               // the owner's standing corrections travel with every later job of the project
               ...((project.captionEdits ?? []).length ? { caption_edits: project.captionEdits } : {}),
               ...((project.zoomEdits ?? []).length ? { zoom_edits: project.zoomEdits } : {}),
               ...(rules.length ? { rules } : {}), ...(profile ? { profile } : {}) },
    createdAt: now(), updatedAt: now(),
  };
  s.jobs[job.id] = job;
  project.versions.push({ n, jobId: job.id, createdAt: now(), status: 'editing', package: null, artifacts: {},
    caption: null, destination: null, scheduledAt: null, exceptions: [], approval: null, notifiedAt: null,
    changeRequest: options.change_request ?? null });
  project.currentVersion = n;
  project.status = 'editing';
  hist(project, actor, 'edit_queued', { jobId: job.id, version: n, adapter: job.options.adapter ?? 'worker_default' });
  return job;
}

// ── Worker: status, leases, recovery ──────────────────────────────────────────
function workerStatus() {
  const w = state().worker;
  const online = !!w && Date.now() - Date.parse(w.lastSeen) < WORKER_ALIVE_MS;
  const jobs = Object.values(state().jobs);
  return { online, state: online ? w.state : 'offline', lastSeen: w?.lastSeen ?? null, workerId: w?.workerId ?? null,
           pipelineVersion: w?.pipelineVersion ?? null,
           queued: jobs.filter(j => j.status === 'queued').length, running: jobs.filter(j => j.status === 'leased').length };
}
function touchWorker(info) {
  const s = state();
  s.worker = { workerId: String(info.workerId || 'worker').slice(0, 60), state: info.state === 'busy' ? 'busy' : 'idle',
               pipelineVersion: String(info.pipelineVersion || s.worker?.pipelineVersion || '').slice(0, 20), lastSeen: now() };
}

/** Return expired leases to the queue (or fail them when the attempts are used up). */
function recover(reason = 'lease_expired') {
  const s = state(); let changed = 0;
  for (const j of Object.values(s.jobs)) {
    if (j.status !== 'leased' || (j.lease && Date.parse(j.lease.expiresAt) > Date.now())) continue;
    releaseJob(j, reason); changed++;
  }
  if (changed) save();
  return changed;
}
function releaseJob(j, reason) {
  const p = state().projects[j.projectId];
  j.lease = null; j.updatedAt = now(); j.uploaded = {};
  if (j.attempts >= j.maxAttempts) {
    j.status = 'failed'; j.error = { code: 'worker_lost', message: 'העובד הפסיק לדווח באמצע העריכה, וכל הניסיונות נוצלו', retryable: false };
    finishVersion(p, j, 'failed');
  } else { j.status = 'queued'; j.stage = 'queued'; j.note = 'העריכה נקטעה — הוחזרה לתור'; }
  if (p) hist(p, 'system', 'job_released', { jobId: j.id, reason, status: j.status, attempts: j.attempts });
}
function finishVersion(p, j, status) {
  if (!p) return;
  const v = p.versions.find(x => x.n === j.version);
  if (v) v.status = status;
  if (p.currentVersion === j.version) p.status = status === 'failed' ? 'failed' : status;
}

function workerHello(info) {
  const s = state(); touchWorker(info);
  for (const j of Object.values(s.jobs)) if (j.status === 'leased' && j.lease?.workerId === s.worker.workerId) releaseJob(j, 'worker_restarted');
  save();
}
function heartbeat(info) {
  touchWorker(info);
  const j = info.jobId ? state().jobs[info.jobId] : null;
  if (j && j.status === 'leased' && j.lease.token === info.leaseToken) j.lease.expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  save();
}

/** One editing job at a time. */
function lease(info) {
  recover();
  const s = state(); touchWorker({ ...info, state: 'idle' });
  const jobs = Object.values(s.jobs);
  if (jobs.some(j => j.status === 'leased')) { save(); return null; }
  const j = jobs.filter(x => x.status === 'queued' && (!x.notBefore || Date.parse(x.notBefore) <= Date.now()))
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!j) { save(); return null; }
  const p = s.projects[j.projectId];
  j.status = 'leased'; j.attempts += 1; j.stage = 'starting'; j.note = 'העובד קיבל את המשימה'; j.updatedAt = now(); j.uploaded = {};
  j.lease = { token: crypto.randomBytes(24).toString('hex'), workerId: s.worker.workerId, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
  s.worker.state = 'busy';
  hist(p, 'worker', 'job_leased', { jobId: j.id, attempt: j.attempts });
  save();
  // The job is DECLARATIVE: what to edit and with which options. No commands.
  return { leaseToken: j.lease.token, job: { id: j.id, projectId: j.projectId, version: j.version, attempt: j.attempts,
           source: { sha256: p.source.sha256, ext: p.source.ext, bytes: p.source.bytes }, options: { ...j.options, brand: brandFacts() } } };
}

function brandFacts() {
  const b = require('../utils/dana_brand').get(), out = {};
  for (const [k, v] of Object.entries(b)) if (v.status === 'set' && k !== 'instagram_account') out[k] = v.value;
  out.not_defined = Object.entries(b).filter(([, v]) => v.status === 'missing').map(([, v]) => v.label);
  return out;
}

function leasedJob(jobId, token) {
  const j = state().jobs[jobId];
  if (!j) throw new StudioError(404, 'job_not_found', 'job not found');
  if (j.status !== 'leased' || !j.lease || !token || j.lease.token !== token) throw new StudioError(409, 'lease_lost', 'this job is no longer leased to this worker');
  if (Date.parse(j.lease.expiresAt) <= Date.now()) { recover(); throw new StudioError(409, 'lease_lost', 'the lease expired'); }
  j.lease.expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  return j;
}
function progress(jobId, token, { stage, note }) {
  const j = leasedJob(jobId, token);
  j.stage = String(stage || '').slice(0, 40); j.note = String(note || '').slice(0, 200); j.updatedAt = now();
  touchWorker({ workerId: j.lease.workerId, state: 'busy' });
  save();
}

/** Store one artifact only when the bytes received match the hash the worker computed. */
async function acceptArtifact(jobId, token, name, tmpPath, claimedSha, claimedBytes) {
  let j;
  try { j = leasedJob(jobId, token); if (!ARTIFACTS[name]) throw new StudioError(400, 'artifact_unknown', `unknown artifact: ${name}`); }
  catch (e) { fs.rmSync(tmpPath, { force: true }); throw e; }
  const bytes = fs.statSync(tmpPath).size, sha = await hashFile(tmpPath);
  if (!/^[0-9a-f]{64}$/.test(claimedSha || '') || sha !== claimedSha || (claimedBytes != null && Number(claimedBytes) !== bytes)) {
    fs.rmSync(tmpPath, { force: true });
    event('artifact_rejected', { jobId, name, received: sha, claimed: claimedSha, bytes });
    throw new StudioError(422, 'transfer_corrupt', 'the uploaded file does not match its hash — send it again');
  }
  const dest = artifactPath(j.projectId, j.version, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmpPath, dest);
  j.uploaded[name] = { sha256: sha, bytes }; j.updatedAt = now();
  save();
  return j.uploaded[name];
}

function complete(jobId, token, body) {
  const j = leasedJob(jobId, token);
  const p = getProject(j.projectId), v = p.versions.find(x => x.n === j.version);
  if (!['success', 'review_required'].includes(body.status)) throw new StudioError(400, 'status_invalid', 'status must be success | review_required');
  for (const [name, spec] of Object.entries(ARTIFACTS)) if (spec.required && !j.uploaded[name]) throw new StudioError(409, 'artifact_missing', `artifact not uploaded: ${name}`);
  for (const a of body.artifacts ?? []) if (j.uploaded[a.name] && j.uploaded[a.name].sha256 !== a.sha256) throw new StudioError(409, 'artifact_mismatch', `artifact hash differs: ${a.name}`);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(artifactPath(p.id, v.n, 'package.json'), 'utf8')); }
  catch { throw new StudioError(422, 'package_invalid', 'package.json is not readable'); }
  if (pkg.source?.sha256 !== p.source.sha256) throw new StudioError(422, 'package_invalid', 'the package was built from a different source file');
  const brand = require('../utils/dana_brand').get();
  v.package = pkg; v.artifacts = { ...j.uploaded };
  // An automatic transcript is not an exact quote: a caption draft may not call it one unless the owner verified the text.
  if (pkg.caption?.text && pkg.transcript?.status !== 'owner_corrected')
    pkg.caption.text = String(pkg.caption.text).replace(/ציטוט מדויק מהסרטון/g, 'תמלול אוטומטי מהסרטון — לא אומת');
  v.caption = { text: String(pkg.caption?.text ?? ''), cta: pkg.caption?.cta ?? brand.cta_default.value ?? null, isDraft: true };
  v.destination = { platform: 'instagram', format: 'reel', account: brand.instagram_account.value ?? null };
  v.scheduledAt = require('./dana_publisher').proposeTime();
  v.scheduleProposed = true;                       // a neutral default, not a timing recommendation
  v.status = 'ready_for_review';
  j.status = body.status === 'success' ? 'succeeded' : 'review_required';
  j.lease = null; j.stage = 'done'; j.note = 'החבילה מוכנה לבדיקה'; j.updatedAt = now(); j.totalSeconds = pkg.total_s ?? null;
  if (p.currentVersion === v.n) p.status = 'ready_for_review';
  if (state().worker) state().worker.state = 'idle';
  hist(p, 'worker', 'package_ready', { version: v.n, jobStatus: j.status, failedChecks: pkg.failed_checks ?? [], totalSeconds: pkg.total_s });
  save();
  require('./dana_notify').packageReady(p, v).catch(() => {});
  return view(p);
}

function fail(jobId, token, body) {
  const j = leasedJob(jobId, token);
  const p = getProject(j.projectId);
  const waiting = body.status === 'waiting';
  j.error = { code: String(body.code || 'unknown').slice(0, 60), message: String(body.message || '').slice(0, 500), retryable: !!body.retryable,
              detail: typeof body.detail === 'string' ? body.detail.slice(0, 2000) : null };
  j.lease = null; j.updatedAt = now(); j.uploaded = {};
  if (state().worker) state().worker.state = 'idle';
  if (waiting) { j.status = 'waiting'; j.note = j.error.message; finishVersion(p, j, 'waiting'); }
  else if (j.error.retryable && j.attempts < j.maxAttempts) {
    j.status = 'queued'; j.stage = 'queued'; j.note = `ניסיון ${j.attempts} נכשל (${j.error.code}) — ינוסה שוב`;
    j.notBefore = new Date(Date.now() + RETRY_DELAY_MS * j.attempts).toISOString();
  } else { j.status = 'failed'; j.note = j.error.message; finishVersion(p, j, 'failed'); }
  hist(p, 'worker', 'job_failed', { jobId: j.id, status: j.status, attempt: j.attempts, ...j.error, detail: undefined });
  save();
  return { status: j.status, attempts: j.attempts };
}

// ── Review package: fingerprint, exceptions, approval ─────────────────────────
/** The approval is bound to exactly this: video, cover, caption, CTA, destination, schedule. */
function fingerprint(v) {
  if (!v?.package) return null;
  return crypto.createHash('sha256').update(JSON.stringify([
    v.artifacts['final.mp4']?.sha256, v.artifacts['cover.jpg']?.sha256, v.caption?.text ?? '', v.caption?.cta ?? null,
    v.destination?.platform ?? null, v.destination?.format ?? null, v.destination?.account ?? null, v.scheduledAt ?? null,
  ])).digest('hex');
}
function unresolved(v) {
  if (!v?.package) return [];
  const excepted = new Set(v.exceptions.map(e => e.id));
  if (Array.isArray(v.package.review_items))
    return v.package.review_items.filter(r => !excepted.has(r.id)).map(r => ({ ...r, summary: r.original }));
  const items = [];
  for (const c of v.package.checks ?? []) if (c.status === 'fail' && !excepted.has(c.id)) items.push({ id: c.id, kind: 'check', summary: c.summary });
  for (const i of v.package.issues ?? []) if (i.severity === 'blocker' && !excepted.has(i.code)) items.push({ id: i.code, kind: 'issue', summary: i.message });
  return items;
}
function approvalValid(v) { return !!v?.approval && v.approval.fingerprint === fingerprint(v); }

const JUDGEMENT_EXCEPTION = 'content_judgement_missing';
/** How the content decisions of a package were made. Old packages have no judgement_mode; their adapter tells. */
function judgementMode(pkg) {
  if (!pkg) return null;
  if (pkg.judgement_mode) return pkg.judgement_mode;
  return pkg.adapter === 'heuristic' ? 'fallback_heuristic' : pkg.adapter === 'claude' ? 'model' : pkg.adapter === 'scripted' ? 'scripted' : null;
}
/** A technical edit whose message, segments, cover and review were NOT judged: an automatic rule chose them. */
function judgementMissing(v) {
  const pkg = v?.package;
  if (!pkg) return false;
  return judgementMode(pkg) === 'fallback_heuristic' || pkg.plan?.content_judgement === 'none';
}
const judgementExcepted = (v) => (v?.exceptions ?? []).some(e => e.id === JUDGEMENT_EXCEPTION);

function reviewable(projectId) {
  const p = getProject(projectId), v = currentVersion(p);
  if (!v || !v.package || !['ready_for_review', 'approved'].includes(v.status)) throw new StudioError(409, 'not_reviewable', 'אין חבילה מוכנה לבדיקה בגרסה הנוכחית');
  return { p, v };
}
function dropApproval(p, v, actor, why) {
  if (!v.approval) return;
  hist(p, actor, 'approval_invalidated', { version: v.n, reason: why, previousFingerprint: v.approval.fingerprint });
  v.approval = null; v.status = 'ready_for_review'; p.status = 'ready_for_review';
}

function editPackage(projectId, body, actor = 'owner') {
  const { p, v } = reviewable(projectId);
  const before = fingerprint(v);
  if (body.caption !== undefined) { v.caption.text = String(body.caption).slice(0, 2200); v.caption.isDraft = false; }
  if (body.cta !== undefined) v.caption.cta = body.cta ? String(body.cta).slice(0, 200) : null;
  if (body.account !== undefined) v.destination.account = body.account ? String(body.account).replace(/^@/, '').slice(0, 60) : null;
  if (body.scheduledLocal !== undefined) {         // wall-clock time in Israel, "YYYY-MM-DDTHH:MM"
    const d = body.scheduledLocal ? require('./dana_publisher').fromLocal(body.scheduledLocal) : null;
    if (body.scheduledLocal && !d) throw new StudioError(400, 'schedule_invalid', 'תאריך לא תקין');
    body = { ...body, scheduledAt: d ? d.toISOString() : null };
  }
  if (body.scheduledAt !== undefined) {
    if (body.scheduledAt && Number.isNaN(Date.parse(body.scheduledAt))) throw new StudioError(400, 'schedule_invalid', 'תאריך לא תקין');
    const next = body.scheduledAt ? new Date(body.scheduledAt).toISOString() : null;
    if (next !== v.scheduledAt) v.scheduleProposed = false;
    v.scheduledAt = next;
  }
  if (fingerprint(v) !== before) { hist(p, actor, 'package_edited', { version: v.n, fields: Object.keys(body) }); dropApproval(p, v, actor, 'content_changed'); }
  save();
  return view(p);
}

/** An explicit, recorded human exception for one failed check / blocking issue. Never implicit. */
function recordException(projectId, { id, reason, by }, actor = 'owner') {
  const { p, v } = reviewable(projectId);
  const applies = id === JUDGEMENT_EXCEPTION ? judgementMissing(v) && !judgementExcepted(v) : unresolved(v).some(u => u.id === id);
  if (!applies) throw new StudioError(400, 'exception_not_applicable', 'אין בעיה פתוחה עם המזהה הזה');
  if (!reason || String(reason).trim().length < 10) throw new StudioError(400, 'exception_reason_required', 'נדרש נימוק כתוב (לפחות 10 תווים)');
  if (!by || !String(by).trim()) throw new StudioError(400, 'exception_by_required', 'נדרש שם המאשר/ת');
  v.exceptions.push({ id, reason: String(reason).trim().slice(0, 1000), by: String(by).trim().slice(0, 80), at: now() });
  hist(p, actor, 'exception_recorded', { version: v.n, id, by });
  save();
  return view(p);
}

/**
 * ONE confirmation for everything in the review section. The owner confirms exactly the
 * items that were shown (ids must match the current open list), after watching the
 * excerpts. Each item keeps its original result and its adjudication in the record.
 */
function confirmReview(projectId, { ids, by, note, watched }, actor = 'owner') {
  const { p, v } = reviewable(projectId);
  const open = unresolved(v);
  if (!open.length) throw new StudioError(409, 'nothing_to_review', 'אין פריטים פתוחים לבדיקה');
  const want = open.map(o => o.id).sort(), got = Array.isArray(ids) ? [...new Set(ids.map(String))].sort() : [];
  if (JSON.stringify(want) !== JSON.stringify(got)) throw new StudioError(409, 'review_list_changed', 'רשימת הפריטים השתנתה — יש לרענן ולבדוק שוב', { ids: want });
  if (watched !== true) throw new StudioError(400, 'review_not_watched', 'יש לאשר שצפית והקשבת לקטעים');
  if (!by || !String(by).trim()) throw new StudioError(400, 'exception_by_required', 'נדרש שם המאשר/ת');
  const at = now(), reason = String(note || '').trim().slice(0, 1000) || 'נבדק בצפייה ובהאזנה לקטעים שהוצגו';
  for (const o of open) v.exceptions.push({ id: o.id, kind: o.kind ?? null, original: o.original ?? o.summary, verdict: o.verdict ?? null,
    reason, by: String(by).trim().slice(0, 80), at, confirmedTogether: want.length });
  hist(p, actor, 'review_confirmed', { version: v.n, by: String(by).trim(), items: want });
  save();
  return view(p);
}

function approve(projectId, { fingerprint: shown, by }, actor = 'owner') {
  const { p, v } = reviewable(projectId);
  const fp = fingerprint(v);
  if (!shown || shown !== fp) throw new StudioError(409, 'fingerprint_mismatch', 'החבילה השתנתה מאז שהוצגה — יש לרענן ולאשר את הגרסה הנוכחית', { fingerprint: fp });
  if (judgementMissing(v) && !judgementExcepted(v))
    throw new StudioError(409, JUDGEMENT_EXCEPTION, 'זו עריכה טכנית בלבד: שיפוט התוכן (מסר, קטעים, קאבר, ביקורת) לא רץ. אפשר להפיק גרסה מתוקנת, או לתעד חריגה מפורשת.');
  const open = unresolved(v);
  if (open.length) throw new StudioError(409, 'unresolved_issues', 'יש בעיות פתוחות שדורשות תיקון או חריגה מתועדת', { unresolved: open });
  v.approval = { fingerprint: fp, by: String(by || 'owner').slice(0, 80), at: now() };
  v.status = 'approved'; p.status = 'approved';
  hist(p, actor, 'approved', { version: v.n, fingerprint: fp, by: v.approval.by });
  save();
  return view(p);
}

function requestChanges(projectId, body, actor = 'owner') {
  const p = getProject(projectId), v = currentVersion(p);
  if (!v || ['editing'].includes(v.status)) throw new StudioError(409, 'not_reviewable', 'העריכה עדיין רצה');
  const note = String(body.note || '').trim();
  if (!note && !body.style_overrides && !body.decisions) throw new StudioError(400, 'note_required', 'נדרש תיאור השינוי');
  const opts = sanitizeOptions({ style_overrides: body.style_overrides, decisions: body.decisions, change_request: note || undefined,
                                 adapter: body.decisions ? undefined : body.adapter });
  dropApproval(p, v, actor, 'changes_requested');
  hist(p, actor, 'changes_requested', { version: v.n, note, overrides: opts.style_overrides ?? null, hasDecisions: !!opts.decisions });
  return queueChange(p, v, opts, note, actor);
}

/** Turn a change (note / style / decisions / stored edits) into the next version's job, or park it when nothing can act on it. */
function queueChange(p, v, opts, note, actor, { hasEdits = false } = {}) {
  if (opts.style_overrides) p.styleOverrides = { ...p.styleOverrides, ...opts.style_overrides };
  const adapter = opts.adapter ?? projectAdapter(p);
  // No explicit adapter (the worker's model path decides) or an explicit model adapter: send the request and the previous result.
  if (!opts.decisions && (adapter === 'claude' || adapter == null) && v.package) {
    if (adapter === 'claude') opts.adapter = 'claude';
    opts.previous = { segment: v.package.segment, cards: v.package.cards.map(c => ({ text: c.text, highlight: c.highlight ?? [] })),
      cover: v.package.cover, caption: { text: v.caption?.text ?? v.package.caption.text, cta: v.caption?.cta ?? null },
      // the content plan of the version being revised, so a revision keeps what the owner did not ask to change
      ...(v.package.plan?.content_judgement === 'model' ? { story_plan: {
        message: v.package.plan.message, hook: v.package.plan.hook,
        segments: (v.package.plan.segments ?? []).map(x => ({ in_s: x.source_in_s, out_s: x.source_out_s, role: x.role })),
        zooms: (v.package.zooms ?? []).map(z => ({ at_s: z.source_t_s, strength: z.strength, reason: z.reason })),
        cover_quote: v.package.cover?.text ?? '' } } : {}) };
    p.pendingChange = null;
    enqueueEdit(p, opts, actor);
    save();
    return view(p);
  }
  // A free-text note needs judgement. With an EXPLICITLY rule-based project nothing can act on it, so nothing is re-rendered blindly.
  if (!opts.style_overrides && !opts.decisions && !hasEdits && adapter === 'heuristic') {
    v.status = 'changes_requested'; p.status = 'changes_requested'; v.changeNote = note;
    p.pendingChange = { note, at: now(), needs: 'operator_decisions' };
    save();
    return view(p);
  }
  // keep the previous decisions when only the style changes (same words, same cut)
  if (!opts.decisions && v.package && adapter !== 'claude' && adapter != null) {
    opts.decisions = { segment: { in_s: v.package.segment.in_s, out_s: v.package.segment.out_s, reason: v.package.segment.reason },
      cards: v.package.cards.map(c => ({ text: c.text, highlight: c.highlight ?? [] })), cover: v.package.cover,
      caption: { text: v.caption?.text ?? v.package.caption.text, cta: v.caption?.cta ?? null } };
    const hom = homophonesOf(v.package);
    if (Object.keys(hom).length) opts.decisions.homophones = hom;
    opts.adapter = 'scripted';
  }
  p.pendingChange = null;
  enqueueEdit(p, opts, actor);
  save();
  return view(p);
}

/**
 * "הפק גרסה מתוקנת": the owner's caption corrections, style choices, zoom changes and an optional
 * note become the next version. Corrections are stored on the project (original text kept beside
 * the correction) and travel with every later job. The approval of the current version is dropped.
 * A note is either for this project only (change_request) or a standing rule for every project.
 */
function revise(projectId, body = {}, actor = 'owner') {
  const p = getProject(projectId), v = currentVersion(p);
  if (!v || v.status === 'editing') throw new StudioError(409, 'not_reviewable', 'העריכה עדיין רצה');
  const by = String(body.by || '').trim().slice(0, 80);
  if (!by) throw new StudioError(400, 'by_required', 'נדרש שם מי שמבקש/ת את התיקון');
  const edits = body.caption_edits !== undefined ? sanitizeCaptionEdits(body.caption_edits) : [];
  const zooms = body.zoom_edits !== undefined ? sanitizeZoomEdits(body.zoom_edits) : [];
  const style = sanitizeOptions({ style_overrides: body.style_overrides && Object.keys(body.style_overrides).length ? body.style_overrides : undefined }).style_overrides;
  const note = String(body.note || '').trim().slice(0, 2000);
  if (note && !['project', 'permanent'].includes(body.note_scope))
    throw new StudioError(400, 'note_scope_required', 'יש לבחור: "תיקון לפרויקט הזה" או "כלל קבוע"');
  if (!edits.length && !zooms.length && !style && !note) throw new StudioError(400, 'nothing_to_revise', 'לא סומן שום תיקון');
  const open = Object.values(state().jobs).find(j => j.projectId === p.id && ['queued', 'leased'].includes(j.status));
  if (open) throw new StudioError(409, 'job_in_progress', 'כבר יש עריכה פעילה לפרויקט הזה');

  const at = now();
  p.captionEdits = p.captionEdits ?? []; p.captionEditHistory = p.captionEditHistory ?? []; p.zoomEdits = p.zoomEdits ?? [];
  const same = (a, e) => Math.abs(a.source_start_s - e.source_start_s) < 0.02 && Math.abs(a.source_end_s - e.source_end_s) < 0.02;
  for (const e of edits) {
    const i = p.captionEdits.findIndex(x => same(x, e));
    const original = i >= 0 ? p.captionEdits[i].original : e.original;        // the transcript's own text, never an earlier correction
    if (i >= 0) { p.captionEditHistory.push({ ...p.captionEdits[i], replacedAt: at }); p.captionEdits.splice(i, 1); }
    if (e.text === original) continue;                                         // back to the transcript: the correction is withdrawn
    if (p.captionEdits.length >= MAX_CAPTION_EDITS) throw new StudioError(400, 'caption_edits_invalid', 'יותר מדי תיקוני כתוביות בפרויקט');
    p.captionEdits.push({ id: `ce_${Math.round(e.source_start_s * 1000)}_${Math.round(e.source_end_s * 1000)}`, ...e, original, by, at });
  }
  p.captionEdits.sort((a, b2) => a.source_start_s - b2.source_start_s);
  for (const z of zooms) { p.zoomEdits = p.zoomEdits.filter(x => x.id !== z.id); p.zoomEdits.push({ ...z, by, at }); }

  let rule = null;
  if (note && body.note_scope === 'permanent') rule = addRule({ text: note, by, projectId: p.id });
  const opts = { ...(style ? { style_overrides: style } : {}), ...(note && body.note_scope === 'project' ? { change_request: note } : {}) };
  dropApproval(p, v, actor, 'revision_requested');
  hist(p, actor, 'revision_requested', { version: v.n, by, captionEdits: edits.length, zoomEdits: zooms.length, style: style ?? null,
    note: note || null, noteScope: note ? body.note_scope : null, ruleId: rule?.id ?? null });
  return queueChange(p, v, opts, note, actor, { hasEdits: edits.length > 0 || zooms.length > 0 || !!rule });
}

// ── Standing rules: feedback the owner marked as "כלל קבוע" — global, with history ──
const rulesFile = () => path.join(dir(), 'rules.json');
function rulesState() { try { return JSON.parse(fs.readFileSync(rulesFile(), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`dana rules are unreadable (${e.message})`); return { rules: [] }; } }
function saveRules(r) { fs.mkdirSync(dir(), { recursive: true }); const tmp = rulesFile() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(r, null, 1), 'utf8'); fs.renameSync(tmp, rulesFile()); }
const listRules = () => rulesState().rules;
const activeRules = () => listRules().filter(r => r.status === 'active').map(r => ({ id: r.id, text: r.text }));
function addRule({ text, by, projectId = null }) {
  const t = String(text || '').trim().slice(0, 500);
  if (t.length < 3) throw new StudioError(400, 'rule_invalid', 'כלל קבוע חייב לכלול טקסט');
  if (!by || !String(by).trim()) throw new StudioError(400, 'by_required', 'נדרש שם מי שמאשר/ת את הכלל');
  const r = rulesState();
  if (r.rules.filter(x => x.status === 'active').length >= MAX_ACTIVE_RULES) throw new StudioError(400, 'rules_full', `יש כבר ${MAX_ACTIVE_RULES} כללים קבועים פעילים — יש להסיר כלל לפני הוספת חדש`);
  const rule = { id: newId('rule'), text: t, status: 'active', by: String(by).trim().slice(0, 80), at: now(), projectId, retiredBy: null, retiredAt: null };
  r.rules.push(rule); saveRules(r); event('rule_added', { ruleId: rule.id, by: rule.by, projectId });
  return rule;
}
function retireRule(id, by) {
  const r = rulesState(), rule = r.rules.find(x => x.id === id);
  if (!rule) throw new StudioError(404, 'rule_not_found', 'הכלל לא נמצא');
  if (rule.status === 'active') { rule.status = 'retired'; rule.retiredBy = String(by || 'owner').slice(0, 80); rule.retiredAt = now(); saveRules(r); event('rule_retired', { ruleId: id, by: rule.retiredBy }); }
  return r.rules;
}

function homophonesOf(pkg) {
  const out = {};
  for (const i of pkg.issues ?? []) if (i.code === 'caption_differs_from_asr' && i.heard && i.shown) out[i.heard] = i.shown;
  return out;
}

function reject(projectId, { reason }, actor = 'owner') {
  const p = getProject(projectId), v = currentVersion(p);
  if (v) { dropApproval(p, v, actor, 'rejected'); v.status = 'rejected'; }
  p.status = 'rejected';
  hist(p, actor, 'rejected', { version: v?.n, reason: String(reason || '').slice(0, 500) });
  save();
  return view(p);
}

function setConsent(projectId, { status, note, by }, actor = 'owner') {
  const p = getProject(projectId);
  if (!['unknown', 'confirmed', 'denied'].includes(status)) throw new StudioError(400, 'consent_invalid', 'status must be unknown | confirmed | denied');
  if (status !== 'unknown' && (!by || !String(by).trim())) throw new StudioError(400, 'consent_by_required', 'נדרש שם מי שמתעד/ת את ההסכמה');
  p.consent = { status, note: note ? String(note).slice(0, 500) : null, by: by ? String(by).slice(0, 80) : null, at: now() };
  hist(p, actor, 'consent_recorded', { status, by: p.consent.by });
  save();
  return view(p);
}

function retry(projectId, actor = 'owner') {
  const p = getProject(projectId), v = currentVersion(p);
  if (!v || !['failed', 'waiting'].includes(v.status)) throw new StudioError(409, 'not_retryable', 'אין עריכה שנכשלה לנסות שוב');
  const prev = state().jobs[v.jobId];
  enqueueEdit(p, { adapter: prev?.options.adapter ?? undefined, style_overrides: prev?.options.style_overrides, decisions: prev?.options.decisions,
                   change_request: prev?.options.change_request }, actor);
  save();
  return view(p);
}

// ── Views ─────────────────────────────────────────────────────────────────────
function view(p) {
  const s = state(), v = currentVersion(p), job = v ? s.jobs[v.jobId] : null;
  const publisher = require('./dana_publisher');
  return {
    id: p.id, title: fixName(p.title), status: p.status, createdAt: p.createdAt, currentVersion: p.currentVersion,
    source: { sha256: p.source.sha256, bytes: p.source.bytes, originalName: fixName(p.source.originalName), ext: p.source.ext },
    consent: p.consent, rights: p.rights, pendingChange: p.pendingChange ?? null,
    adapter: projectAdapter(p),                                    // null = the worker's configuration decides
    captionEdits: p.captionEdits ?? [], zoomEdits: p.zoomEdits ?? [], styleOverrides: p.styleOverrides ?? {},
    job: job ? { id: job.id, status: job.status, stage: job.stage, note: job.note, attempts: job.attempts, maxAttempts: job.maxAttempts,
                 error: job.error ? { code: job.error.code, message: job.error.message, retryable: job.error.retryable } : null,
                 totalSeconds: job.totalSeconds ?? null } : null,
    version: v ? {
      n: v.n, status: v.status, createdAt: v.createdAt, changeRequest: v.changeRequest ?? null,
      fingerprint: fingerprint(v), approval: v.approval, approvalValid: approvalValid(v),
      caption: v.caption, destination: v.destination, scheduledAt: v.scheduledAt,
      scheduledLocal: require('./dana_publisher').toLocal(v.scheduledAt), scheduleProposed: !!v.scheduleProposed, timezone: 'Asia/Jerusalem',
      exceptions: v.exceptions, unresolved: unresolved(v),
      contentJudgement: v.package ? { mode: judgementMode(v.package), missing: judgementMissing(v), excepted: judgementExcepted(v), exceptionId: JUDGEMENT_EXCEPTION } : null,
      package: v.package ? { duration: v.package.duration, segment: v.package.segment, adapter: v.package.adapter, spokenText: v.package.spoken_text,
        cards: v.package.cards, cover: v.package.cover, checks: v.package.checks, issues: v.package.issues, style: v.package.style,
        considered: v.package.considered ?? [], revisionNote: v.package.revision_note ?? '', spelling: v.package.spelling ?? [],
        usage: v.package.judgement_usage ?? null, bundle: v.package.instruction_bundle ?? null, editorial: v.package.editorial ?? null,
        timings: v.package.timings_s, totalSeconds: v.package.total_s, pipelineVersion: v.package.pipeline_version,
        // present only when the worker sent them; never invented here
        plan: v.package.plan ?? null, judgementMode: judgementMode(v.package), zooms: v.package.zooms ?? null, transcript: v.package.transcript ?? null,
        rulesUsed: v.package.rules_used ?? null, captionStatus: v.package.caption?.status ?? null } : null,
      hasVideo: !!v.artifacts['final.mp4'], hasCover: !!v.artifacts['cover.jpg'],
    } : null,
    versions: p.versions.map(x => ({ n: x.n, status: x.status, createdAt: x.createdAt, approved: !!x.approval, changeRequest: x.changeRequest ?? null,
      hasVideo: !!x.artifacts?.['final.mp4'], hasCover: !!x.artifacts?.['cover.jpg'], duration: x.package?.duration ?? null,
      judgementMode: judgementMode(x.package), profile: x.package?.rules_used?.profile ?? null })),
    publication: { ...publisher.gate(p), record: p.publication },
    history: p.history.slice(-60),
  };
}
function list() {
  return Object.values(state().projects).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(p => { const x = view(p); return { id: x.id, title: x.title, status: x.status, createdAt: x.createdAt, currentVersion: x.currentVersion,
      job: x.job && { status: x.job.status, stage: x.job.stage, note: x.job.note }, unresolved: x.version?.unresolved.length ?? 0, consent: x.consent.status }; });
}

/** Startup: nothing is lost, nothing is duplicated. Expired leases go back to the queue. */
function reconcileOnStartup() { state(); return recover('server_restart'); }

module.exports = {
  StudioError, ARTIFACTS, registerUpload, getProject, currentVersion, view, list, workerStatus, workerHello, heartbeat, lease, leasedJob,
  progress, acceptArtifact, complete, fail, recover, reconcileOnStartup, fingerprint, unresolved, approvalValid, editPackage, recordException,
  approve, confirmReview, requestChanges, revise, reject, setConsent, retry, sourcePath, artifactPath, dir, save, state, hist, _resetForTests,
  listRules, activeRules, addRule, retireRule, fixName, projectAdapter, judgementMode, judgementMissing, STYLE_OVERRIDABLE,
};
