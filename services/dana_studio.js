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
  'compare_frames.jpg':     { mime: 'image/jpeg',       required: false },   // before / after stills (same moments)
  'compare_clip.mp4':       { mime: 'video/mp4',        required: false },   // before / after clip, side by side
  'readable_compare.mp4':   { mime: 'video/mp4',        required: false },   // current captions (left) next to a readable alternative (right)
  // a story is also delivered card by card (cut from the reviewed final.mp4)
  'story_part_1.mp4': { mime: 'video/mp4', required: false }, 'story_part_2.mp4': { mime: 'video/mp4', required: false },
  'story_part_3.mp4': { mime: 'video/mp4', required: false }, 'story_part_4.mp4': { mime: 'video/mp4', required: false },
};
/** Where a video is meant to go. The target changes the plan and the render on the worker (dana_pipeline/target.py). */
const TARGETS = { reel: 'ריל', story: 'סטורי' };
/** A review-only job looks at a finished video the owner uploaded; it produces no new video (the source IS the video). */
const REVIEW_REQUIRED = ['package.json', 'checks.json', 'cover.jpg'];
const ADJUSTMENT_KINDS = { color: 'תיקון צבע', audio_cleanup: 'ניקוי סאונד', zooms: 'זומים', caption_animation: 'הנפשת כתוביות', graphics: 'מואושן גרפיק (מעל הצילום)',
  animation: 'קטעי אנימציה (מחליפים את הצילום)' };
const SOURCE_EXT       = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);
// Keys a project may override, with the range the worker accepts. Anything else is refused.
const STYLE_OVERRIDABLE = {
  caption_size: { type: 'number', min: 40, max: 140 }, caption_y_px: { type: 'number', min: 200, max: 1700 },
  caption_max_lines: { type: 'number', oneOf: [1, 2] }, highlight_enabled: { type: 'boolean' }, backing: { type: 'boolean' },
  cover_size: { type: 'number', min: 40, max: 220 }, cover_y_px: { type: 'number', min: 100, max: 1800 },
  caption_animation: { type: 'string', oneOf: ['none', 'fade', 'rise'] },
  caption_ink: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/ }, caption_highlight: { type: 'string', pattern: /^#[0-9a-fA-F]{6}$/ },
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

/** Which kinds of adjustment the owner switched off (false) or back on (true) for a project. Unknown kinds are refused. */
function sanitizeAdjustments(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new StudioError(400, 'adjustments_invalid', 'adjustments must be an object');
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (!ADJUSTMENT_KINDS[k] || typeof v !== 'boolean') throw new StudioError(400, 'adjustments_invalid', `סוג תיקון לא מוכר: ${k}`);
    out[k] = v;
  }
  return out;
}
/** A destination account must be one of the connected (verified) accounts, or empty. Nothing is typed in freely here. */
function sanitizeAccount(a) {
  const name = String(a ?? '').trim().replace(/^@/, '');
  if (!name) return null;
  const known = require('../utils/dana_brand').accounts().find(x => x.username === name);
  if (!known) throw new StudioError(400, 'account_unknown', 'החשבון הזה אינו ברשימת החשבונות המחוברים');
  return name;
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
      if (rule.pattern && !rule.pattern.test(v)) throw new StudioError(400, 'style_override_invalid', `${k} must be a colour like #FFFF00`);
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
  if (o.adjustments !== undefined) out.adjustments = sanitizeAdjustments(o.adjustments);
  if (o.kind !== undefined) {
    if (!['edit', 'review_only'].includes(o.kind)) throw new StudioError(400, 'kind_invalid', 'kind must be edit | review_only');
    out.kind = o.kind;
  }
  if (o.account !== undefined) out.account = sanitizeAccount(o.account);
  if (o.project_type !== undefined) {
    if (!require('./dana_media').PROJECT_TYPES[o.project_type]) throw new StudioError(400, 'project_type_invalid', 'סוג הפרויקט אינו מוכר');
    out.project_type = o.project_type;
  }
  if (o.more_files !== undefined) out.more_files = o.more_files === true;   // more source files follow: the edit waits for "start"
  if (o.segment_edits !== undefined) {
    if (!Array.isArray(o.segment_edits) || o.segment_edits.length > 20 || !o.segment_edits.every(e => e && Number.isInteger(e.n) && e.n > 0 && ['remove', 'replace'].includes(e.action)
        && (e.action === 'remove' || (typeof e.source_id === 'string' && /^src\d{1,3}$/.test(e.source_id) && Number.isFinite(Number(e.from_s)) && Number.isFinite(Number(e.to_s)) && Number(e.to_s) - Number(e.from_s) >= 0.5))))
      throw new StudioError(400, 'segment_edits_invalid', 'החלפת קטע חייבת מספר קטע ופעולה: הסרה, או החלפה עם קובץ מקור וזמני התחלה וסוף');
    out.segment_edits = o.segment_edits.map(e => e.action === 'remove' ? { n: e.n, action: 'remove' } : { n: e.n, action: 'replace', source_id: e.source_id, from_s: Number(e.from_s), to_s: Number(e.to_s) });
  }
  if (o.target !== undefined) {
    if (!['reel', 'story', 'both'].includes(o.target)) throw new StudioError(400, 'target_invalid', 'יעד חייב להיות ריל, סטורי או שתי גרסאות');
    out.target = o.target;
  }
  if (o.graphic_edits !== undefined) {
    if (!Array.isArray(o.graphic_edits) || o.graphic_edits.length > 20 || !o.graphic_edits.every(g => g && typeof g.id === 'string' && /^[\w@.:-]{1,60}$/.test(g.id) && g.action === 'remove'))
      throw new StudioError(400, 'graphic_edits_invalid', 'הסרת גרפיקה חייבת לכלול מזהה ופעולה remove');
    out.graphic_edits = o.graphic_edits.map(g => ({ id: g.id, action: 'remove' }));
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
  let opts0;
  try { opts0 = sanitizeOptions(options); } catch (e) { fs.rmSync(tmpPath, { force: true }); throw e; }
  const wanted = opts0.kind === 'review_only' ? ['reel'] : opts0.target === 'both' ? ['reel', 'story'] : [opts0.target ?? 'reel'];
  const same = Object.values(s.projects).filter(p => p.source.sha256 === sha256);
  const existing = same.find(p => wanted.includes(p.target ?? 'reel')) && wanted.every(t => same.some(p => (p.target ?? 'reel') === t)) ? same.find(p => (p.target ?? 'reel') === wanted[0]) : null;
  if (existing) {
    fs.rmSync(tmpPath, { force: true });
    hist(existing, actor, 'duplicate_upload', { originalName });
    save();
    return { duplicate: true, project: existing };
  }
  const opts = opts0;
  const source = { sha256, ext, bytes, originalName: String(originalName).slice(0, 200), uploadedAt: now() };
  const dest = sourcePath(source);
  if (!fs.existsSync(dest)) fs.renameSync(tmpPath, dest); else fs.rmSync(tmpPath, { force: true });
  // ONE source file, and a separate output (project) per target: each has its own versions, review and approval.
  const groupId = same[0]?.groupId ?? (wanted.length > 1 || same.length ? newId('grp') : null);
  if (groupId) for (const p of same) p.groupId = groupId;
  let first = null;
  for (const tg of wanted.filter(t => !same.some(p => (p.target ?? 'reel') === t))) {
  const project = {
    id: newId('prj'), title: String(originalName).replace(/\.[^.]+$/, '').slice(0, 120), createdAt: now(), target: tg, groupId,
    source, status: 'editing', adapter: opts.adapter ?? null, adapterExplicit: opts.adapter !== undefined,   // null → the worker's configuration decides
    kind: opts.kind ?? 'edit',                                         // 'review_only': a finished video uploaded for Dana's review; nothing is edited
    projectType: opts.project_type ?? 'interview', sources: [{ id: 'src1', ...source, marks: [] }], assets: [], audio: null,
    account: opts.account ?? null,                                     // destination account chosen for this project (null → the brand default)
    adjustments: opts.adjustments ?? {},                               // kinds of adjustment switched off / on for this project
    captionVerifications: [], polish: null,
    styleOverrides: opts.style_overrides ?? {}, excludeRanges: opts.exclude_ranges ?? [], captionEdits: [], zoomEdits: [],
    versions: [], currentVersion: 0,
    consent: { status: 'unknown', note: null, by: null, at: null },   // publication consent of the people in the footage
    rights: { music: 'none' },                                         // phase 1A: no music
    publication: null, history: [],
  };
  s.projects[project.id] = project;
  hist(project, actor, 'uploaded', { sha256, bytes, originalName: source.originalName, kind: project.kind, target: tg });
  if (project.kind === 'review_only') enqueueReview(project, actor); else enqueueEdit(project, opts, actor);
  first = first ?? project;
  }
  save();
  return { duplicate: false, project: first };
}

function enqueueEdit(project, options, actor) {
  const s = state();
  const open = Object.values(s.jobs).find(j => j.projectId === project.id && ['queued', 'leased'].includes(j.status));
  if (open) throw new StudioError(409, 'job_in_progress', 'כבר יש עריכה פעילה לפרויקט הזה');
  const n = (project.versions.at(-1)?.n ?? 0) + 1;
  const adapter = options.adapter ?? projectAdapter(project);
  const rules = activeRules();
  // library skills: a tested draft (explicit test only), else the project's choice / the approved default - one skill or a combination
  const sk = options.skill_payload ? { skill_set: [options.skill_payload] } : require('./dana_skills').forProject(project);
  // approved library skills outrank the older "default profile"; without any, the older default still applies
  const profile = sk?.skill_set ? null : require('./dana_references').defaultProfile();
  const lastReviewed = [...project.versions].reverse().find(x => x.package?.review_compact)?.package.review_compact ?? null;
  const adjustments = { ...(project.adjustments ?? {}), ...(options.adjustments ?? {}) };
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
               ...(Object.keys(adjustments).length ? { adjustments } : {}),
               // an improved version of the owner's own finished edit: the content is kept, only technical improvements are applied
               ...(project.polish ? { polish: project.polish } : {}), ...(options.apply_review ? { apply_review: true } : {}),
               ...(rules.length ? { rules } : {}), ...(profile ? { profile } : {}),
               ...(sk?.skill_set ? { skill_set: sk.skill_set } : {}), ...(sk?.candidates ? { skill_candidates: sk.candidates } : {}),
               target: project.target ?? 'reel',
               // every source in use with the owner's marks, the audio files with the mix settings, the kind of project
               ...require('./dana_media').forJob(project),
               ...((project.segmentEdits ?? []).length ? { segment_edits: project.segmentEdits } : {}),
               ...((project.graphicEdits ?? []).length ? { graphic_edits: project.graphicEdits } : {}),
               ...(project.animationScene === true ? { animation_scene: true } : {}),
               // the previous review of this output, so the next one can explain what changed and why
               ...(lastReviewed ? { previous_review: lastReviewed } : {}),
               // what the owner settled by listening: not asked again in the next version
               ...(Object.keys(project.hearing ?? {}).length ? { hearing_decisions: Object.entries(project.hearing).map(([key, d]) => ({ key, decision: d.decision })) } : {}) },
    skillTest: options.skill_test && sk?.skill_set ? { id: sk.skill_set[0].skill.id, version: sk.skill_set[0].skill.version } : null,
    stageLog: [], createdAt: now(), updatedAt: now(),
  };
  // more source files are still being uploaded: the worker does not take the job until the owner presses "start" (or 15 minutes pass)
  if (options.more_files) { job.notBefore = new Date(Date.now() + 15 * 60 * 1000).toISOString(); job.waitingForFiles = true; job.note = 'ממתין לקבצים נוספים — יתחיל כשתלחצ/י "התחל עריכה"'; }
  s.jobs[job.id] = job;
  project.versions.push({ n, jobId: job.id, createdAt: now(), status: 'editing', package: null, artifacts: {},
    caption: null, destination: null, scheduledAt: null, exceptions: [], approval: null, notifiedAt: null,
    changeRequest: options.change_request ?? null, kind: 'edit', appliedReview: !!options.apply_review || (!!project.polish && n > 1),
    skill: sk?.skill_set ? { id: sk.skill_set.map(c => c.skill.id).join('+'), name: sk.skill_set.map(c => c.skill.name).join(' + '), version: sk.skill_set.length === 1 ? sk.skill_set[0].skill.version : sk.skill_set.map(c => c.skill.version).join('+'),
      test: !!options.skill_test } : null, skillSuggest: !!sk?.candidates });
  project.currentVersion = n;
  project.status = 'editing';
  hist(project, actor, 'edit_queued', { jobId: job.id, version: n, adapter: job.options.adapter ?? 'worker_default' });
  return job;
}

/** Dana's review of a finished video the owner uploaded. The source is the video; no edit is made. */
function enqueueReview(project, actor) {
  const s = state();
  const n = (project.versions.at(-1)?.n ?? 0) + 1;
  const job = { id: newId('job'), projectId: project.id, version: n, type: 'review', status: 'queued', attempts: 0, maxAttempts: MAX_ATTEMPTS, lease: null,
    notBefore: null, stage: 'queued', note: 'ממתין לעובד העריכה', error: null, uploaded: {}, options: {}, stageLog: [], createdAt: now(), updatedAt: now() };
  s.jobs[job.id] = job;
  project.versions.push({ n, jobId: job.id, createdAt: now(), status: 'editing', package: null, artifacts: {}, caption: null, destination: null,
    scheduledAt: null, exceptions: [], approval: null, notifiedAt: null, changeRequest: null, kind: 'review_only' });
  project.currentVersion = n; project.status = 'editing';
  hist(project, actor, 'review_queued', { jobId: job.id, version: n });
  return job;
}

// ── Worker: status, leases, recovery ──────────────────────────────────────────
function workerStatus() {
  const w = state().worker;
  const online = !!w && Date.now() - Date.parse(w.lastSeen) < WORKER_ALIVE_MS;
  const jobs = Object.values(state().jobs);
  return { online, state: online ? w.state : 'offline', lastSeen: w?.lastSeen ?? null, workerId: w?.workerId ?? null,
           pipelineVersion: w?.pipelineVersion ?? null, capabilities: w?.capabilities ?? null,
           queued: jobs.filter(j => j.status === 'queued').length, running: jobs.filter(j => j.status === 'leased').length };
}
function touchWorker(info) {
  const s = state();
  s.worker = { workerId: String(info.workerId || 'worker').slice(0, 60), state: info.state === 'busy' ? 'busy' : 'idle',
               pipelineVersion: String(info.pipelineVersion || s.worker?.pipelineVersion || '').slice(0, 20), lastSeen: now(),
               // what the worker found on its own machine at start (tools present, model enabled) — shown as is, never assumed
               capabilities: info.capabilities && typeof info.capabilities === 'object' && JSON.stringify(info.capabilities).length < 4000 ? info.capabilities : (s.worker?.capabilities ?? null) };
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
  j.leasedAt = now(); j.stageLog = [{ stage: 'starting', at: j.leasedAt }];
  j.lease = { token: crypto.randomBytes(24).toString('hex'), workerId: s.worker.workerId, expiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
  s.worker.state = 'busy';
  hist(p, 'worker', 'job_leased', { jobId: j.id, attempt: j.attempts });
  save();
  // The job is DECLARATIVE: what to edit and with which options. No commands.
  return { leaseToken: j.lease.token, job: { id: j.id, projectId: j.projectId, version: j.version, attempt: j.attempts, type: j.type ?? 'edit',
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
  (j.stageLog = j.stageLog ?? []).push({ stage: j.stage, at: j.updatedAt });        // measured: when each stage really started
  if (j.stageLog.length > 200) j.stageLog.splice(0, j.stageLog.length - 200);
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
  const required = j.type === 'review' ? REVIEW_REQUIRED : Object.entries(ARTIFACTS).filter(([, spec]) => spec.required).map(([name]) => name);
  for (const name of required) if (!j.uploaded[name]) throw new StudioError(409, 'artifact_missing', `artifact not uploaded: ${name}`);
  for (const a of body.artifacts ?? []) if (j.uploaded[a.name] && j.uploaded[a.name].sha256 !== a.sha256) throw new StudioError(409, 'artifact_mismatch', `artifact hash differs: ${a.name}`);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(artifactPath(p.id, v.n, 'package.json'), 'utf8')); }
  catch { throw new StudioError(422, 'package_invalid', 'package.json is not readable'); }
  if (pkg.source?.sha256 !== p.source.sha256) throw new StudioError(422, 'package_invalid', 'the package was built from a different source file');
  const brand = require('../utils/dana_brand').get();
  v.package = pkg; v.artifacts = { ...j.uploaded };
  // doubts the owner already settled by listening are carried into this version as settled (with who and when)
  for (const it of pkg.review_items ?? []) { const d = it.owner_decision === 'ok' ? (p.hearing ?? {})[it.hearing_key] : null;
    if (d && !(v.exceptions ?? []).some(e => e.id === it.id)) (v.exceptions = v.exceptions ?? []).push({ id: it.id, kind: it.kind ?? null, original: it.original, verdict: it.verdict ?? null,
      reason: `הוכרע בהאזנה בגרסה ${d.version}: תקין`, by: d.by, at: d.at, carried: true }); }
  if (j.type === 'review') {                         // a review: nothing to approve or publish; the uploaded file is the video
    v.status = 'reviewed'; v.videoIsSource = true;
    p.polish = pkg.polish_options && typeof pkg.polish_options === 'object'
      ? { burned_in_text: pkg.polish_options.burned_in_text !== false, add_captions: pkg.polish_options.add_captions === true } : { burned_in_text: true, add_captions: false };
    j.status = 'succeeded'; j.lease = null; j.stage = 'done'; j.note = 'הביקורת מוכנה'; j.updatedAt = now(); j.totalSeconds = pkg.total_s ?? null;
    if (p.currentVersion === v.n) p.status = 'reviewed';
    if (state().worker) state().worker.state = 'idle';
    hist(p, 'worker', 'review_ready', { version: v.n, totalSeconds: pkg.total_s });
    save();
    return view(p);
  }
  // Caption corrections Dana derived from the owner's free-text request are stored like the owner's own corrections
  // (so later versions keep them), marked as corrected on request — not as verified by ear.
  for (const e of pkg.request_interpretation?.caption_edits ?? []) {
    if (!num(e.source_start_s) || !num(e.source_end_s) || !e.text) continue;
    p.captionEdits = (p.captionEdits ?? []).filter(x => !(Math.abs(x.source_start_s - e.source_start_s) < 0.02 && Math.abs(x.source_end_s - e.source_end_s) < 0.02));
    p.captionEdits.push({ id: `ce_${Math.round(e.source_start_s * 1000)}_${Math.round(e.source_end_s * 1000)}`, source_start_s: e.source_start_s, source_end_s: e.source_end_s,
      original: String(e.original ?? '').slice(0, 200), text: String(e.text).slice(0, 80), by: 'דנה, לפי הבקשה שלך', at: v.createdAt, status: 'corrected', from: 'owner_request' });
  }
  // An automatic transcript is not an exact quote: a caption draft may not call it one unless the owner verified the text.
  if (pkg.caption?.text && pkg.transcript?.status !== 'owner_corrected')
    pkg.caption.text = String(pkg.caption.text).replace(/ציטוט מדויק מהסרטון/g, 'תמלול אוטומטי מהסרטון — לא אומת');
  v.caption = { text: String(pkg.caption?.text ?? ''), cta: pkg.caption?.cta ?? brand.cta_default.value ?? null, isDraft: true };
  if (pkg.skill_report?.skill) v.skill = { id: pkg.skill_report.skill.id, name: pkg.skill_report.skill.name, version: pkg.skill_report.skill.version, test: !!j.skillTest,
    chosenBy: pkg.skill_report.skill.chosen_by ?? null };
  if (j.skillTest) {
    const rep = pkg.skill_report?.rules ?? [];
    try { require('./dana_skills').recordSample(j.skillTest.id, j.skillTest.version, { projectId: p.id, projectTitle: fixName(p.title), versionN: v.n,
      applied: rep.filter(r => r.status === 'applied').length, not_followed: rep.filter(r => r.status === 'not_followed').length,
      not_applicable: rep.filter(r => r.status === 'not_applicable').length, not_checked: rep.filter(r => r.status === 'not_checked').length }); } catch { /* the package is still valid */ }
  }
  v.destination = { platform: 'instagram', format: 'reel', account: p.account ?? brand.instagram_account.value ?? null };
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

/**
 * Everything the worker needs to keep what the owner did NOT ask to change: the previous version's
 * cut, cards (with times), cover, caption, content plan, zooms and style — as data. Without a note
 * from the owner the worker locks the revision to this plan.
 */
const PREVIOUS_MAX_BYTES = 200 * 1024;
function previousOf(v) {
  const pk = v.package;
  const prev = {
    segment: pk.segment,
    cards: (pk.cards ?? []).map(c => ({ i: c.i, text: c.text, lines: c.lines, highlight: c.highlight ?? [], start: c.start, dur: c.dur,
                                         source_start_s: c.source_start_s, source_end_s: c.source_end_s })),
    cover: pk.cover, caption: { text: v.caption?.text ?? pk.caption.text, cta: v.caption?.cta ?? null },
    plan: pk.plan ?? null, zooms: pk.zooms ?? null, judgement_mode: judgementMode(pk), style: pk.style ?? null,
    graphics: pk.graphics ?? null,
    // the previous review's category levels (same rubric → the next package can show before / after)
    dana_review: pk.dana_review ? { rubric_version: pk.dana_review.rubric_version,
      categories: (pk.dana_review.categories ?? []).map(c => ({ key: c.key, label: c.label, level: c.level, met: c.met, decided: c.decided })) } : null,
    // kept for workers that read the short form
    ...(pk.plan?.content_judgement === 'model' ? { story_plan: {
      message: pk.plan.message, hook: pk.plan.hook,
      segments: (pk.plan.segments ?? []).map(x => ({ in_s: x.source_in_s, out_s: x.source_out_s, role: x.role })),
      zooms: (pk.zooms ?? []).map(z => ({ at_s: z.source_t_s, strength: z.strength, reason: z.reason })),
      cover_quote: pk.cover?.text ?? '' } } : {}),
  };
  const size = () => Buffer.byteLength(JSON.stringify(prev));
  if (size() > PREVIOUS_MAX_BYTES && prev.plan) {
    // long free text goes first; segments, zooms and cards are never dropped
    const { segments, message, hook, content_judgement, reordered } = prev.plan;
    for (const k of ['skill_text', 'basis', 'burned_in_text', 'zooms_not_used', 'left_out', 'brief', 'rationale']) {
      if (size() <= PREVIOUS_MAX_BYTES) break;
      if (k in prev.plan) { prev.plan = { ...prev.plan }; delete prev.plan[k]; }
    }
    if (size() > PREVIOUS_MAX_BYTES) prev.plan = { segments, message: String(message ?? '').slice(0, 300), hook: String(hook ?? '').slice(0, 200), content_judgement, reordered };
  }
  if (size() > PREVIOUS_MAX_BYTES) throw new StudioError(400, 'previous_too_large', 'הגרסה הקודמת גדולה מדי לשליחה כבסיס לתיקון');
  return prev;
}

/** Turn a change (note / style / decisions / stored edits) into the next version's job, or park it when nothing can act on it. */
function queueChange(p, v, opts, note, actor, { hasEdits = false } = {}) {
  if (opts.style_overrides) p.styleOverrides = { ...p.styleOverrides, ...opts.style_overrides };
  const adapter = opts.adapter ?? projectAdapter(p);
  // No explicit adapter (the worker's model path decides) or an explicit model adapter: send the request and the previous result.
  if (!opts.decisions && (adapter === 'claude' || adapter == null) && v.package) {
    if (adapter === 'claude') opts.adapter = 'claude';
    opts.previous = previousOf(v);
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
  const adjustments = body.adjustments !== undefined ? sanitizeAdjustments(body.adjustments) : null;
  const adjChanged = adjustments && Object.entries(adjustments).some(([k, val]) => (p.adjustments ?? {})[k] !== val && !(val === true && (p.adjustments ?? {})[k] === undefined));
  // a change of the mix (another music file, level, start point, original sound) or of ONE segment: the rest of the edit is kept
  const audioNew = body.audio !== undefined ? require('./dana_media').cleanAudio(p, body.audio) : null;
  const audioChanged = audioNew !== null && JSON.stringify(audioNew) !== JSON.stringify(p.audio ?? null);
  const segEdits = body.segment_edits !== undefined ? sanitizeOptions({ segment_edits: body.segment_edits }).segment_edits : [];
  const pending = pendingEdits(p, v).length;                           // corrections saved with "אמת ושמור תיקון" that are not in a rendered version yet
  if (!edits.length && !zooms.length && !style && !note && !adjChanged && !pending && !(Array.isArray(body.graphic_edits) && body.graphic_edits.length) && !audioChanged && !segEdits.length) throw new StudioError(400, 'nothing_to_revise', 'לא סומן שום תיקון');
  if (v.kind === 'review_only') throw new StudioError(409, 'review_only', 'זה סרטון שהועלה לביקורת בלבד — אפשר להפיק ממנו גרסה משופרת דרך "יישם שיפורים"');
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
  if (adjustments) p.adjustments = { ...(p.adjustments ?? {}), ...adjustments };
  if (audioChanged) p.audio = audioNew;
  for (const e of segEdits) { p.segmentEdits = (p.segmentEdits ?? []).filter(x => x.n !== e.n); p.segmentEdits.push({ ...e, by, at: now() }); }
  // remove ONE graphic or animation scene by its id; the rest of the edit is kept (locked revision)
  const gEdits = body.graphic_edits !== undefined ? sanitizeOptions({ graphic_edits: body.graphic_edits }).graphic_edits : [];
  for (const g of gEdits) { p.graphicEdits = (p.graphicEdits ?? []).filter(x => x.id !== g.id); p.graphicEdits.push({ ...g, by, at }); }

  let rule = null;
  if (note && body.note_scope === 'permanent') rule = addRule({ text: note, by, projectId: p.id, projectTitle: fixName(p.title), versionN: v.n });
  // change_request exists ONLY when the owner wrote a note (either scope). Without it the worker locks the revision to the previous plan.
  // A project-scope note is sent to this job and never becomes a rule; a permanent one is both a rule and this job's request.
  const opts = { ...(style ? { style_overrides: style } : {}), ...(note ? { change_request: note } : {}) };
  dropApproval(p, v, actor, 'revision_requested');
  hist(p, actor, 'revision_requested', { version: v.n, by, captionEdits: edits.length, zoomEdits: zooms.length, style: style ?? null,
    note: note || null, noteScope: note ? body.note_scope : null, ruleId: rule?.id ?? null, adjustments: adjustments ?? null, pendingCorrections: pending });
  return queueChange(p, v, opts, note, actor, { hasEdits: edits.length > 0 || zooms.length > 0 || !!rule || adjChanged || pending > 0 || gEdits.length > 0 || audioChanged || segEdits.length > 0 });
}

// ── Transcript: correct, listen, verify ───────────────────────────────────────
const sameSpan = (a, e) => Math.abs(a.source_start_s - e.source_start_s) < 0.02 && Math.abs(a.source_end_s - e.source_end_s) < 0.02;
/** Corrections that were saved after the current version was produced: they are not in any rendered video yet. */
function pendingEdits(p, v) {
  if (!v) return [];
  return (p.captionEdits ?? []).filter(e => e.at > v.createdAt);
}
/**
 * "אמת ושמור תיקון": the owner listened to one caption and either corrected its text or confirmed it as written.
 * The correction (with the transcript's original beside it) and the verification are stored on the PROJECT, so every
 * later version carries them and an automatic re-transcription never overwrites them. Verifying text is not an
 * approval to publish, and nothing is rendered here: the next version is produced when the owner asks for it.
 */
function verifyCaption(projectId, body = {}, actor = 'owner') {
  const p = getProject(projectId), v = currentVersion(p);
  if (!v?.package) throw new StudioError(409, 'not_reviewable', 'אין עדיין חבילה עם כתוביות');
  const by = String(body.by || '').trim().slice(0, 80);
  if (!by) throw new StudioError(400, 'by_required', 'נדרש שם מי שמאמת/ת');
  if (body.listened !== true) throw new StudioError(400, 'listen_required', 'אימות מלל נעשה אחרי האזנה לקטע — יש לסמן שהאזנת');
  const [e] = sanitizeCaptionEdits([{ source_start_s: body.source_start_s, source_end_s: body.source_end_s, original: body.original, text: body.text }]);
  const at = now();
  p.captionEdits = p.captionEdits ?? []; p.captionEditHistory = p.captionEditHistory ?? []; p.captionVerifications = p.captionVerifications ?? [];
  const i = p.captionEdits.findIndex(x => sameSpan(x, e));
  const original = i >= 0 ? p.captionEdits[i].original : e.original;           // always the transcript's own text
  p.captionVerifications = p.captionVerifications.filter(x => !sameSpan(x, e));
  let changed = false;
  if (e.text !== original) {
    if (i < 0 || p.captionEdits[i].text !== e.text) {
      if (i >= 0) { p.captionEditHistory.push({ ...p.captionEdits[i], replacedAt: at }); p.captionEdits.splice(i, 1); }
      if (p.captionEdits.length >= MAX_CAPTION_EDITS) throw new StudioError(400, 'caption_edits_invalid', 'יותר מדי תיקוני כתוביות בפרויקט');
      p.captionEdits.push({ id: `ce_${Math.round(e.source_start_s * 1000)}_${Math.round(e.source_end_s * 1000)}`, ...e, original, by, at, status: 'verified', verifiedBy: by, verifiedAt: at });
      changed = true;
    } else Object.assign(p.captionEdits[i], { status: 'verified', verifiedBy: by, verifiedAt: at });
    p.captionEdits.sort((a, b2) => a.source_start_s - b2.source_start_s);
  } else {
    if (i >= 0) { p.captionEditHistory.push({ ...p.captionEdits[i], replacedAt: at }); p.captionEdits.splice(i, 1); changed = true; }   // back to the transcript's text
    p.captionVerifications.push({ source_start_s: e.source_start_s, source_end_s: e.source_end_s, text: e.text, by, at });
  }
  if (changed) dropApproval(p, v, actor, 'caption_corrected');          // the approved video no longer shows the verified text
  hist(p, actor, 'caption_verified', { version: v.n, by, source_start_s: e.source_start_s, original, text: e.text, changed });
  save();
  return view(p);
}
/** Per-card state for the page: לא נבדק / תוקן / אומת על ידי הבעלים, the original text, and whether the video already shows it. */
function cardStates(p, v) {
  const pk = v?.package;
  if (!pk?.cards) return [];
  return pk.cards.map(c => {
    const span = num(c.source_start_s) && num(c.source_end_s) ? c : null;
    const e = span && (p.captionEdits ?? []).find(x => sameSpan(x, span));
    const ver = span && (p.captionVerifications ?? []).find(x => sameSpan(x, span));
    const status = e ? (e.status === 'verified' ? 'verified' : 'corrected') : ver ? 'verified' : 'unchecked';
    return { i: c.i, status, original: e ? e.original : null, saved: e ? e.text : null, by: (e ?? ver)?.by ?? null, at: (e ?? ver)?.at ?? null,
             inVideo: e ? e.text === c.text : true, from: e?.from ?? null };
  });
}

// ── Project settings: destination account and which kinds of adjustment are on ──
function setSettings(projectId, body = {}, actor = 'owner') {
  const p = getProject(projectId), v = currentVersion(p);
  if (body.account !== undefined) {
    p.account = sanitizeAccount(body.account);
    if (v?.destination && v.status !== 'editing') {
      const before = fingerprint(v);
      v.destination.account = p.account ?? require('../utils/dana_brand').get().instagram_account.value ?? null;
      if (fingerprint(v) !== before) dropApproval(p, v, actor, 'account_changed');
    }
  }
  if (body.adjustments !== undefined) p.adjustments = { ...(p.adjustments ?? {}), ...sanitizeAdjustments(body.adjustments) };   // applies from the next version
  // which library skill the NEXT version uses. Existing versions are never changed by this.
  if (body.skill !== undefined) p.skill = require('./dana_skills').selection(body.skill);
  if (body.animation_scene !== undefined) p.animationScene = body.animation_scene === true;
  hist(p, actor, 'settings_changed', { account: p.account ?? null, adjustments: p.adjustments ?? {} });
  save();
  return view(p);
}

// ── "יישם שיפורים והפק גרסה חדשה" ─────────────────────────────────────────────
/**
 * Dana applies, by herself, the improvements of her review that are inside the approved rules, and produces a new version.
 * For one of her own edits: the same plan, and the editor may act on the review's findings.
 * For a finished video the owner uploaded: the content is kept exactly; only technical improvements are applied.
 */
function applyReview(projectId, body = {}, actor = 'owner') {
  const p = getProject(projectId), v = currentVersion(p);
  if (!v?.package || v.status === 'editing') throw new StudioError(409, 'not_reviewable', 'אין ביקורת מוכנה בגרסה הנוכחית');
  const by = String(body.by || '').trim().slice(0, 80);
  if (!by) throw new StudioError(400, 'by_required', 'נדרש שם מי שמבקש/ת');
  const open = Object.values(state().jobs).find(j => j.projectId === p.id && ['queued', 'leased'].includes(j.status));
  if (open) throw new StudioError(409, 'job_in_progress', 'כבר יש עריכה פעילה לפרויקט הזה');
  const can = (v.package.dana_review?.improvements ?? []).filter(i => i.can_apply).length + (v.package.dana_can_apply ?? []).length;
  if (!can) throw new StudioError(409, 'nothing_to_apply', 'בביקורת הזו אין שיפור שדנה יכולה ליישם בעצמה — הנושאים הפתוחים דורשים החלטה שלך');
  dropApproval(p, v, actor, 'apply_review');
  hist(p, actor, 'apply_review_requested', { version: v.n, by, improvements: can });
  if (v.kind === 'review_only' || p.kind === 'review_only') {
    if (!p.polish) p.polish = { burned_in_text: true, add_captions: false };
    enqueueEdit(p, {}, actor);
  } else enqueueEdit(p, { apply_review: true, previous: previousOf(v) }, actor);
  save();
  return view(p);
}

// ── Library skills on a project ────────────────────────────────────────────────
function idleProject(projectId) {
  const p = getProject(projectId), v = currentVersion(p);
  if (!v || v.status === 'editing') throw new StudioError(409, 'not_reviewable', 'העריכה עדיין רצה');
  if (Object.values(state().jobs).some(j => j.projectId === p.id && ['queued', 'leased'].includes(j.status))) throw new StudioError(409, 'job_in_progress', 'כבר יש עריכה פעילה לפרויקט הזה');
  if (p.kind === 'review_only') throw new StudioError(409, 'review_only', 'סרטון שהועלה לביקורת בלבד נשמר כמו שהוא — סקיל עריכה חל על חומר גלם');
  return { p, v };
}
/**
 * Apply a library skill to a project that already has a version: a NEW version is planned, edited and reviewed by that
 * skill. The existing version stays as it is, and its approval is dropped because the output is about to change.
 */
function applySkill(projectId, body = {}, actor = 'owner') {
  const by = String(body.by || '').trim().slice(0, 80);
  if (!by) throw new StudioError(400, 'by_required', 'נדרש שם מי שמבקש/ת');
  const { p, v } = idleProject(projectId);
  if (body.skill !== undefined) p.skill = require('./dana_skills').selection(body.skill);
  if (body.animation_scene !== undefined) p.animationScene = body.animation_scene === true;
  const sk = require('./dana_skills').forProject(p);
  if (!sk) throw new StudioError(409, 'no_skill', 'לא נבחר סקיל מאושר לפרויקט ואין ברירת מחדל מאושרת');
  // A contradiction inside the chosen combination is shown BEFORE anything is produced. It is decided by the order the
  // owner gave the skills; the owner confirms that here.
  const hard = (sk.conflicts ?? []).filter(c => c.kind === 'parameter');
  if (hard.length && body.confirm_conflicts !== true)
    throw new StudioError(409, 'skill_conflicts', 'הסקילים שנבחרו סותרים זה את זה — יש לאשר את ההכרעה לפני ההפקה', { conflicts: sk.conflicts });
  dropApproval(p, v, actor, 'skill_applied');
  hist(p, actor, 'skill_applied', { version: v.n, by, skills: sk.skill_set ? sk.skill_set.map(c => ({ id: c.skill.id, version: c.skill.version })) : 'dana_suggests',
    conflicts_confirmed: hard.length });
  enqueueEdit(p, {}, actor);
  save();
  return view(p);
}
/** Try a DRAFT skill on one clip. The result is a new version of that project, marked as a skill test; nothing becomes a default. */
function testSkill(skillId, body = {}, actor = 'owner') {
  const by = String(body.by || '').trim().slice(0, 80);
  if (!by) throw new StudioError(400, 'by_required', 'נדרש שם מי שמבקש/ת');
  const payload = require('./dana_skills').testPayload(skillId);
  const { p, v } = idleProject(String(body.projectId ?? ''));
  dropApproval(p, v, actor, 'skill_test');
  if (body.animation_scene !== undefined) p.animationScene = body.animation_scene === true;
  hist(p, actor, 'skill_test_requested', { version: v.n, by, skill: { id: payload.skill.id, version: payload.skill.version } });
  enqueueEdit(p, { skill_payload: payload, skill_test: true }, actor);
  save();
  return view(p);
}

/**
 * What is stored and how much room is left. Nothing is deleted here except by the ONE stated rule below.
 * RULE: only leftovers of interrupted uploads (files in the upload temp folder, older than 24 hours) may be removed, and
 * only when the owner asks. Source files, audio files, references, skills and every version's outputs are never removed
 * automatically.
 */
function storage({ cleanup = false } = {}) {
  const root = dir(), size = d => { let n = 0, files = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true, recursive: true })) if (e.isFile()) { try { n += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; files++; } catch { /* gone */ } } } catch { /* no folder */ } return { bytes: n, files }; };
  const tmp = path.join(root, 'tmp'), old = [];
  try { for (const f of fs.readdirSync(tmp)) { const st = fs.statSync(path.join(tmp, f)); if (st.isFile() && Date.now() - st.mtimeMs > 24 * 3600 * 1000) old.push({ name: f, bytes: st.size }); } } catch { /* no tmp */ }
  let removed = 0;
  if (cleanup) for (const f of old) { try { fs.rmSync(path.join(tmp, f.name), { force: true }); removed++; } catch { /* in use */ } }
  let free = null, total = null;
  try { const s = fs.statfsSync(root); free = Number(s.bavail) * Number(s.bsize); total = Number(s.blocks) * Number(s.bsize); } catch { /* not supported */ }
  const limitMb = Number(process.env.DANA_UPLOAD_MAX_MB) > 0 ? Number(process.env.DANA_UPLOAD_MAX_MB) : 2048;
  return { uploadLimitMb: limitMb, freeBytes: free, totalBytes: total, lowSpace: free !== null && free < 5 * 1024 ** 3,
    used: { sources_and_audio: size(path.join(root, 'sources')), versions: size(path.join(root, 'projects')), references: size(path.join(root, 'references')), skills: size(path.join(root, 'skills')) },
    uploadLeftovers: { files: cleanup ? old.length - removed : old.length, bytes: old.reduce((n, f) => n + f.bytes, 0), removedNow: removed },
    worker: state().worker?.capabilities?.disk ?? null, workerKeepsJobFoldersDays: state().worker?.capabilities?.keep_job_dirs_days ?? null,
    policy: ['קובצי מקור, מוזיקה, קריינות, רפרנסים, סקילים וכל גרסה שהופקה — לא נמחקים אוטומטית, לעולם.',
      'שאריות של העלאות שנקטעו (מעל 24 שעות) נמחקות רק כשאת/ה מבקש/ת.',
      'במחשב העריכה: תיקיות עבודה זמניות של משימות נמחקות אחרי מספר הימים שמוצג; התוצרים עצמם נמצאים בשרת ואינם נמחקים משם.'] };
}

/** All the files are in: the waiting edit may start now. */
function start(projectId, body = {}, actor = 'owner') {
  const p = getProject(projectId);
  const j = Object.values(state().jobs).find(x => x.projectId === p.id && x.status === 'queued' && x.waitingForFiles);
  if (!j) throw new StudioError(409, 'nothing_waiting', 'אין עריכה שממתינה לקבצים');
  Object.assign(j.options, require('./dana_media').forJob(p));
  j.notBefore = null; j.waitingForFiles = false; j.note = 'ממתין לעובד העריכה'; j.updatedAt = now();
  hist(p, actor, 'edit_started_with_sources', { sources: (j.options.sources ?? []).length || 1, by: String(body.by || '').slice(0, 80) || null });
  save();
  return view(p);
}
/** A new version from ALL the sources and the audio settings as they are now ("הפק גרסה חדשה מכל המקורות"). Planned again. */
function replan(projectId, body = {}, actor = 'owner') {
  const { p, v } = idleProject(projectId);
  const by = String(body.by || '').trim().slice(0, 80);
  if (!by) throw new StudioError(400, 'by_required', 'נדרש שם מי שמבקש/ת');
  if (body.project_type !== undefined) require('./dana_media').setType(p, body.project_type);
  dropApproval(p, v, actor, 'replanned');
  p.segmentEdits = [];
  hist(p, actor, 'replan_requested', { version: v.n, by, project_type: p.projectType ?? 'interview' });
  enqueueEdit(p, {}, actor);
  save();
  return view(p);
}

/**
 * "שמעתי — תקין" / "שמעתי — לא תקין" on ONE doubt that only listening can settle. The decision belongs to the place in the
 * recording, so the next version does not ask again. "Not correct" does not fix anything by itself: the item stays open
 * and the owner corrects the words in the transcript step.
 */
function decideHearing(projectId, body = {}, actor = 'owner') {
  const { p, v } = reviewable(projectId);
  const by = String(body.by || '').trim().slice(0, 80);
  if (!by) throw new StudioError(400, 'by_required', 'נדרש שם מי שהאזין/ה');
  if (body.listened !== true) throw new StudioError(400, 'listen_required', 'ההכרעה נעשית אחרי האזנה לקטע — יש להשמיע אותו קודם');
  if (!['ok', 'wrong'].includes(body.decision)) throw new StudioError(400, 'decision_invalid', 'ההכרעה חייבת להיות "תקין" או "לא תקין"');
  const it = unresolved(v).find(u => u.id === String(body.id));
  if (!it) throw new StudioError(400, 'exception_not_applicable', 'אין פריט פתוח עם המזהה הזה');
  if (!it.hearing_key) throw new StudioError(409, 'not_a_hearing_item', 'הפריט הזה אינו ספק שמיעה');
  const at = now();
  p.hearing = p.hearing ?? {};
  p.hearing[it.hearing_key] = { decision: body.decision, by, at, version: v.n, kind: it.kind, text: it.text ?? null, original: it.original ?? null };
  if (body.decision === 'ok') v.exceptions.push({ id: it.id, kind: it.kind ?? null, original: it.original, verdict: it.verdict ?? null, reason: 'הוכרע בהאזנה: תקין', by, at, hearing: true });
  hist(p, actor, 'hearing_decided', { version: v.n, id: it.id, key: it.hearing_key, decision: body.decision, by });
  save();
  return view(p);
}

/**
 * What exactly was reviewed, and is that review still about what is on screen? Built from what the worker recorded
 * (`review_provenance`) and from what happened on the server since.
 */
function reviewInfo(p, v, cur) {
  const pk = v?.package;
  if (!pk?.dana_review) return null;
  const prov = pk.review_provenance ?? null, rows = (pk.dana_review.categories ?? []).flatMap(c => c.criteria ?? []);
  const count = (basis, statuses) => rows.filter(r => r.basis === basis && statuses.includes(r.status)).length;
  const fileSha = v.videoIsSource ? p.source.sha256 : v.artifacts?.['final.mp4']?.sha256 ?? null;
  const stale = [];
  if (cur && v.n !== cur.n) stale.push(`זו הביקורת של גרסה ${v.n}. הגרסה הנוכחית היא ${cur.n}${cur.package ? '' : ' (עדיין בעבודה)'} — הדירוג כאן אינו שלה.`);
  if (cur && v.n === cur.n && pendingEdits(p, v).length) stale.push(`${pendingEdits(p, v).length} תיקוני מלל נשמרו אחרי הביקורת ועדיין לא בסרטון.`);
  if (v.caption && pk.caption && v.caption.isDraft === false && v.caption.text !== pk.caption.text) stale.push('קפשן הפוסט נערך אחרי הביקורת.');
  if (prov?.final_sha256 && fileSha && prov.final_sha256 !== fileSha) stale.push('קובץ הווידאו השמור שונה מהקובץ שנבדק.');
  return {
    versionN: v.n, reviewedAt: prov?.reviewed_at ?? null, packageReadyAt: (p.history.find(h => h.action === 'package_ready' && h.detail?.version === v.n) ?? p.history.find(h => h.action === 'review_ready' && h.detail?.version === v.n))?.at ?? null,
    onFinalFile: prov ? prov.on_delivered_file === true && (!fileSha || !prov.final_sha256 || prov.final_sha256 === fileSha) : null,
    finalSha256: fileSha, rounds: prov?.review_rounds ?? null, basis: prov?.basis ?? pk.dana_review.perception ?? null,
    counts: { measured: count('measured', ['met', 'not_met']), frames: count('frames', ['met', 'not_met']), model: count('model', ['met', 'not_met']),
              not_checked: rows.filter(r => r.status === 'not_checked').length },
    notChecked: rows.filter(r => r.status === 'not_checked').map(r => ({ criterion: r.criterion, why: r.basis === 'human' ? 'דורש צפייה או האזנה שלך' : r.note })),
    rubricVersion: pk.dana_review.rubric_version, editingSkill: pk.rules_used?.skill ? { name: pk.rules_used.skill.name, version: pk.rules_used.skill.version } : null,
    librarySkill: pk.skill_report?.skill ?? null, profile: pk.rules_used?.profile ? { id: pk.rules_used.profile.id, version: pk.rules_used.profile.version, status: pk.rules_used.profile.status } : null,
    references: pk.rules_used?.references ?? [], stale, upToDate: stale.length === 0,
    note: 'הדירוג הוא מידע לבעלים. הוא אינו אישור פרסום ואינו מבטיח ביצועים באינסטגרם; הערכת מודל יכולה להשתנות בין הרצות.',
  };
}

// ── Progress: measured stage times; the percentage is a labelled estimate ────
const PHASES = [['transcribe', 'תמלול'], ['analyse', 'ניתוח'], ['plan', 'תכנון'], ['edit', 'עריכה'], ['review', 'ביקורת'], ['fixes', 'תיקונים'], ['ready', 'מוכן לצפייה']];
const STAGE_PHASE = { starting: 'transcribe', download: 'transcribe', source: 'transcribe', transcribe_source: 'transcribe',
  transcribe_check: 'analyse', interpret: 'analyse', measure: 'analyse',
  plan: 'plan', assemble: 'plan', render_base: 'edit', measure_picture: 'edit', align: 'edit', render_cards: 'edit', graphics: 'edit',
  composite: 'edit', verify: 'edit', checks: 'edit', cover: 'edit', compare: 'edit', review: 'review', revise: 'fixes', upload: 'ready', done: 'ready' };
// used only when no earlier edit exists to learn from; marked as a rough estimate
const DEFAULT_STAGE_S = { source: 2, transcribe_source: 40, transcribe_check: 40, interpret: 15, plan: 40, assemble: 16, render_base: 16, measure_picture: 8,
  align: 7, render_cards: 30, graphics: 25, composite: 14, verify: 4, checks: 37, cover: 2, compare: 10, review: 12, upload: 10 };
/** Typical seconds per stage, from the timings the worker measured in earlier finished edits (median). */
function typicalStageSeconds() {
  const all = {};
  let n = 0;
  for (const p of Object.values(state().projects)) for (const v of p.versions) {
    const t = v.package?.timings_s;
    if (!t || typeof t !== 'object') continue;
    n++;
    for (const [k, sec] of Object.entries(t)) if (num(sec)) (all[k] = all[k] ?? []).push(sec);
  }
  const med = {};
  for (const [k, list] of Object.entries(all)) { list.sort((a, b) => a - b); med[k] = list[Math.floor(list.length / 2)]; }
  return { typical: { ...DEFAULT_STAGE_S, ...med }, samples: n };
}
function progressOf(p, v, job) {
  if (!job) return null;
  const done = ['succeeded', 'review_required'].includes(job.status);
  const log = job.stageLog ?? [], nowMs = Date.now();
  const cur = job.stage, curBase = String(cur ?? '').replace(/_\d+$/, '');
  const phase = done ? 'ready' : job.status === 'queued' ? null : (log.some(x => x.stage === 'revise') && STAGE_PHASE[curBase] === 'edit' ? 'fixes' : STAGE_PHASE[curBase] ?? 'edit');
  const idx = PHASES.findIndex(([k]) => k === phase);
  const out = {
    phase, phases: PHASES.map(([key, label], i) => ({ key, label, state: done || (idx >= 0 && i < idx) ? 'done' : i === idx ? 'current' : 'todo' })),
    stage: cur, note: job.note, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts,
    startedAt: job.leasedAt ?? null, lastUpdateAt: job.updatedAt, elapsedS: job.leasedAt && !done ? Math.round((nowMs - Date.parse(job.leasedAt)) / 1000) : job.totalSeconds ?? null,
    sinceUpdateS: Math.round((nowMs - Date.parse(job.updatedAt)) / 1000),
    percent: null, percentBasis: null, percentNote: null,
  };
  if (done) { out.percent = 100; out.percentBasis = 'measured'; out.percentNote = 'החבילה זמינה לצפייה'; return out; }
  if (job.status !== 'leased' || !log.length) return out;
  // A correction round repeats edit stages an unknown number of times: there is no honest percentage for it.
  if (phase === 'fixes') { out.percentNote = 'סבב תיקונים: אין מדידה לאחוז בשלב הזה'; out.stageElapsedS = Math.round((nowMs - Date.parse(log[log.length - 1].at)) / 1000); return out; }
  const { typical, samples } = typicalStageSeconds();
  // what the worker has reported so far is measured; what is left is estimated from earlier edits
  const expected = job.type === 'review' ? ['source', 'transcribe_source', 'measure_picture', 'review', 'upload']
    : ['source', 'transcribe_source', 'transcribe_check', 'plan', 'render_base', 'measure_picture', 'align', 'render_cards', 'composite', 'verify', 'checks', 'cover', 'compare', 'review', 'upload'];
  const total = expected.reduce((t, k) => t + (typical[k] ?? 10), 0);
  const seen = new Set(log.map(x => x.stage.replace(/_\d+$/, '')));
  const stageStart = Date.parse(log[log.length - 1].at);
  const base = cur.replace(/_\d+$/, '');
  let spent = 0;
  for (const k of expected) if (seen.has(k) && k !== base) spent += typical[k] ?? 10;
  spent += Math.min((nowMs - stageStart) / 1000, (typical[base] ?? 10) * 0.95);
  out.percent = Math.max(1, Math.min(99, Math.round(100 * spent / total)));
  out.percentBasis = 'estimated';
  out.percentNote = samples ? `משוער: לפי משך כל שלב ב-${samples} עריכות קודמות שנמדדו. השלב והזמנים עצמם נמדדים.` : 'משוער גס: אין עדיין עריכות קודמות ללמוד מהן. השלב והזמנים עצמם נמדדים.';
  out.stageElapsedS = Math.round((nowMs - stageStart) / 1000);
  return out;
}

/** What the owner should do next, as one key the page turns into the main button. */
function nextAction(p, v, job) {
  if (!v) return { key: 'upload', label: 'להעלות חומר גלם' };
  if (job && ['queued', 'leased'].includes(job.status)) return { key: 'wait', label: workerStatus().online ? 'דנה עובדת — אין מה לעשות כרגע' : 'עובד העריכה לא מחובר — העריכה ממתינה בתור' };
  if (['failed', 'waiting'].includes(v.status)) return { key: 'retry', label: 'לנסות שוב (בלי עבודה כפולה: התמלול נשמר)' };
  if (v.kind === 'review_only') return { key: 'apply_review', label: 'לקרוא את הביקורת של דנה, ואז "יישם שיפורים והפק גרסה חדשה"' };
  if (pendingEdits(p, v).length) return { key: 'render_corrections', label: `להפיק גרסה עם ${pendingEdits(p, v).length} תיקוני המלל ששמרת` };
  if (v.status === 'approved' && approvalValid(v)) return { key: 'approved', label: 'הגרסה מאושרת. פרסום הוא שלב נפרד וכבוי כרגע.' };
  if (judgementMissing(v) && !judgementExcepted(v)) return { key: 'revise', label: 'עריכה טכנית בלבד — להפיק גרסה מתוקנת' };
  if (unresolved(v).length) return { key: 'review_items', label: `לבדוק ${unresolved(v).length} פריטים פתוחים (צפייה והאזנה)` };
  return { key: 'watch_approve', label: 'לצפות בסרטון ולאשר את הגרסה, או לבקש תיקון' };
}

// ── Standing rules: feedback the owner marked as "כלל קבוע" — global, with history ──
const rulesFile = () => path.join(dir(), 'rules.json');
function rulesState() { try { return JSON.parse(fs.readFileSync(rulesFile(), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`dana rules are unreadable (${e.message})`); return { rules: [] }; } }
function saveRules(r) { fs.mkdirSync(dir(), { recursive: true }); const tmp = rulesFile() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(r, null, 1), 'utf8'); fs.renameSync(tmp, rulesFile()); }
/** Rules written before versions existed are read as version 1 with the source they recorded. */
const normRule = r => ({ ...r, version: r.version ?? 1, history: r.history ?? [],
  source: r.source ?? { project_id: r.projectId ?? null, project_title: null, version_n: null, by: r.by ?? null, at: r.at ?? null } });
const listRules = () => rulesState().rules.map(normRule);
/** What travels with every job: the active rules only, each with the version that is in force. */
const activeRules = () => listRules().filter(r => r.status === 'active').map(r => ({ id: r.id, text: r.text, version: r.version }));
function addRule({ text, by, projectId = null, projectTitle = null, versionN = null }) {
  const t = String(text || '').trim().slice(0, 500);
  if (t.length < 3) throw new StudioError(400, 'rule_invalid', 'כלל קבוע חייב לכלול טקסט');
  if (!by || !String(by).trim()) throw new StudioError(400, 'by_required', 'נדרש שם מי שמאשר/ת את הכלל');
  const r = rulesState();
  if (r.rules.filter(x => x.status === 'active').length >= MAX_ACTIVE_RULES) throw new StudioError(400, 'rules_full', `יש כבר ${MAX_ACTIVE_RULES} כללים קבועים פעילים — יש להסיר כלל לפני הוספת חדש`);
  const who = String(by).trim().slice(0, 80), at = now();
  const rule = { id: newId('rule'), text: t, version: 1, status: 'active', by: who, at, projectId,
                 source: { project_id: projectId, project_title: projectTitle ? String(projectTitle).slice(0, 200) : null, version_n: versionN, by: who, at },
                 history: [{ version: 1, text: t, by: who, at, action: 'created' }], retiredBy: null, retiredAt: null };
  r.rules.push(rule); saveRules(r); event('rule_added', { ruleId: rule.id, by: rule.by, projectId });
  return rule;
}
/** The owner rewords a standing rule: a new version of the same rule; the earlier wording stays in its history. */
function editRule(id, { text, by } = {}) {
  const t = String(text || '').trim().slice(0, 500), who = String(by || '').trim().slice(0, 80);
  if (t.length < 3) throw new StudioError(400, 'rule_invalid', 'כלל קבוע חייב לכלול טקסט');
  if (!who) throw new StudioError(400, 'by_required', 'נדרש שם מי שמעדכן/ת את הכלל');
  const r = rulesState(), i = r.rules.findIndex(x => x.id === id);
  if (i < 0) throw new StudioError(404, 'rule_not_found', 'הכלל לא נמצא');
  const rule = normRule(r.rules[i]);
  if (rule.status !== 'active') throw new StudioError(409, 'rule_retired', 'הכלל הוסר — אי אפשר לערוך אותו');
  if (t !== rule.text) {
    if (!rule.history.length) rule.history.push({ version: rule.version, text: rule.text, by: rule.by ?? null, at: rule.at ?? null, action: 'created' });
    rule.version += 1; rule.text = t;
    rule.history.push({ version: rule.version, text: t, by: who, at: now(), action: 'edited' });
    r.rules[i] = rule; saveRules(r); event('rule_edited', { ruleId: id, by: who, version: rule.version });
  }
  return r.rules.map(normRule);
}
function retireRule(id, by) {
  const r = rulesState(), rule = r.rules.find(x => x.id === id);
  if (!rule) throw new StudioError(404, 'rule_not_found', 'הכלל לא נמצא');
  if (rule.status === 'active') { rule.status = 'retired'; rule.retiredBy = String(by || 'owner').slice(0, 80); rule.retiredAt = now(); saveRules(r); event('rule_retired', { ruleId: id, by: rule.retiredBy }); }
  return r.rules.map(normRule);
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
  if (prev?.type === 'review') { enqueueReview(p, actor); save(); return view(p); }
  enqueueEdit(p, { apply_review: prev?.options.apply_review, adapter: prev?.options.adapter ?? undefined, style_overrides: prev?.options.style_overrides, decisions: prev?.options.decisions,
                   change_request: prev?.options.change_request, previous: prev?.options.previous }, actor);   // a retried revision keeps its basis
  save();
  return view(p);
}

// ── Views ─────────────────────────────────────────────────────────────────────
function view(p, viewN) {
  const s = state(), cur = currentVersion(p), job = cur ? s.jobs[cur.jobId] : null;
  // The version on screen: the one asked for; else the current one; and while the current one is still being made,
  // the last finished version stays visible (its review and transcript must not vanish because a new version was queued).
  const v = (viewN != null && p.versions.find(x => x.n === Number(viewN))) || (cur?.package ? cur : [...p.versions].reverse().find(x => x.package) ?? cur);
  const publisher = require('./dana_publisher');
  return {
    id: p.id, title: fixName(p.title), status: p.status, createdAt: p.createdAt, currentVersion: p.currentVersion,
    source: { sha256: p.source.sha256, bytes: p.source.bytes, originalName: fixName(p.source.originalName), ext: p.source.ext },
    kind: p.kind ?? 'edit', account: p.account ?? null, adjustments: p.adjustments ?? {}, adjustmentKinds: ADJUSTMENT_KINDS,
    media: require('./dana_media').view(p), segmentEdits: p.segmentEdits ?? [],
    waitingForFiles: Object.values(s.jobs).some(j => j.projectId === p.id && j.status === 'queued' && j.waitingForFiles),
    target: p.target ?? 'reel', targetLabel: TARGETS[p.target ?? 'reel'], animationScene: p.animationScene === true, graphicEdits: p.graphicEdits ?? [],
    // the other outputs made from the SAME source file (a reel and a story are separate outputs with their own versions and reviews)
    siblings: p.groupId ? Object.values(s.projects).filter(x => x.groupId === p.groupId && x.id !== p.id).map(x => ({ id: x.id, target: x.target ?? 'reel', targetLabel: TARGETS[x.target ?? 'reel'], status: x.status, currentVersion: x.currentVersion })) : [],
    skillConflicts: (() => { try { return require('./dana_skills').forProject(p)?.conflicts ?? []; } catch { return []; } })(),
    progress: progressOf(p, cur, job), nextAction: nextAction(p, cur, job),
    pendingCorrections: pendingEdits(p, cur).length, cardStates: cardStates(p, v),
    shown: v ? { n: v.n, isCurrent: v.n === p.currentVersion, currentN: p.currentVersion, currentStatus: cur?.status ?? null, currentHasPackage: !!cur?.package } : null,
    review: reviewInfo(p, v, cur), skill: p.skill ?? { mode: 'default' },
    consent: p.consent, rights: p.rights, pendingChange: p.pendingChange ?? null,
    adapter: projectAdapter(p),                                    // null = the worker's configuration decides
    captionEdits: p.captionEdits ?? [], zoomEdits: p.zoomEdits ?? [], styleOverrides: p.styleOverrides ?? {},
    job: job ? { id: job.id, status: job.status, stage: job.stage, note: job.note, attempts: job.attempts, maxAttempts: job.maxAttempts,
                 error: job.error ? { code: job.error.code, message: job.error.message, retryable: job.error.retryable } : null,
                 totalSeconds: job.totalSeconds ?? null } : null,
    version: v ? {
      n: v.n, status: v.status, createdAt: v.createdAt, changeRequest: v.changeRequest ?? null, kind: v.kind ?? 'edit',
      hasCompare: !!v.artifacts['compare_frames.jpg'], hasCompareClip: !!v.artifacts['compare_clip.mp4'],
      storyParts: Object.keys(v.artifacts ?? {}).filter(n => /^story_part_\d\.mp4$/.test(n)).sort(),
      fingerprint: fingerprint(v), approval: v.approval, approvalValid: approvalValid(v),
      caption: v.caption, destination: v.destination, scheduledAt: v.scheduledAt,
      scheduledLocal: require('./dana_publisher').toLocal(v.scheduledAt), scheduleProposed: !!v.scheduleProposed, timezone: 'Asia/Jerusalem',
      exceptions: v.exceptions, unresolved: unresolved(v),
      contentJudgement: v.package ? { mode: judgementMode(v.package), missing: judgementMissing(v), excepted: judgementExcepted(v), exceptionId: JUDGEMENT_EXCEPTION } : null,
      package: v.package ? { duration: v.package.duration, segment: v.package.segment ?? null, adapter: v.package.adapter, spokenText: v.package.spoken_text ?? v.package.transcript?.text ?? '',
        cards: v.package.cards ?? [], cover: v.package.cover ?? null, checks: v.package.checks ?? [], issues: v.package.issues ?? [], style: v.package.style,
        graphics: v.package.graphics ?? null, adjustments: v.package.adjustments ?? null, compare: v.package.compare ?? null,
        danaReview: v.package.dana_review ?? null, reviewVsPrevious: v.package.review_vs_previous ?? null,
        requestInterpretation: v.package.request_interpretation ?? null, derivedTextUpdates: v.package.derived_text_updates ?? [],
        measured: v.package.measured ?? null, burnedInText: v.package.burned_in_text ?? v.package.plan?.burned_in_text ?? null,
        danaCanApply: v.package.dana_can_apply ?? null, graphicsSeen: v.package.graphics_seen ?? null, note: v.package.note ?? null,
        tools: v.package.tools ?? null, skillReport: v.package.skill_report ?? null, reviewProvenance: v.package.review_provenance ?? null,
        readability: v.package.readability ?? null, sourceMap: v.package.source_map ?? null, mix: v.package.mix ?? null, montage: v.package.montage ?? null, finalReview: v.package.final_review ?? null, timeline: v.package.timeline ?? null, target: v.package.target ?? null, outputs: v.package.outputs ?? null,
        skillChoice: v.package.skill_choice ?? null,
        considered: v.package.considered ?? [], revisionNote: v.package.revision_note ?? '', spelling: v.package.spelling ?? [],
        usage: v.package.judgement_usage ?? null, bundle: v.package.instruction_bundle ?? null, editorial: v.package.editorial ?? null,
        timings: v.package.timings_s, totalSeconds: v.package.total_s, pipelineVersion: v.package.pipeline_version,
        // present only when the worker sent them; never invented here
        plan: v.package.plan ?? null, judgementMode: judgementMode(v.package), zooms: v.package.zooms ?? null, transcript: v.package.transcript ?? null,
        rulesUsed: v.package.rules_used ?? null, captionStatus: v.package.caption?.status ?? null,
        quality: v.package.quality ?? null, revisionMode: v.package.revision_mode ?? null } : null,
      hasVideo: !!v.artifacts['final.mp4'] || !!v.videoIsSource, hasCover: !!v.artifacts['cover.jpg'],
    } : null,
    versions: p.versions.map(x => ({ n: x.n, status: x.status, createdAt: x.createdAt, approved: !!x.approval, changeRequest: x.changeRequest ?? null,
      hasVideo: !!x.artifacts?.['final.mp4'] || !!x.videoIsSource, hasCover: !!x.artifacts?.['cover.jpg'], duration: x.package?.duration ?? null,
      kind: x.kind ?? 'edit', appliedReview: !!x.appliedReview, hasCompare: !!x.artifacts?.['compare_frames.jpg'], hasPackage: !!x.package, skill: x.skill ?? null,
      reviewLevels: (x.package?.dana_review?.categories ?? []).map(c => ({ key: c.key, label: c.label, level: c.level, met: c.met, decided: c.decided })),
      judgementMode: judgementMode(x.package), profile: x.package?.rules_used?.profile ?? null, revisionMode: x.package?.revision_mode ?? null })),
    publication: { ...publisher.gate(p), record: p.publication },
    history: p.history.slice(-60),
  };
}
function list() {
  return Object.values(state().projects).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(p => { const x = view(p); return { id: x.id, title: x.title, status: x.status, createdAt: x.createdAt, currentVersion: x.currentVersion, kind: x.kind,
      target: x.target, targetLabel: x.targetLabel, groupId: p.groupId ?? null,
      progress: x.progress && { phase: x.progress.phase, percent: x.progress.percent, percentBasis: x.progress.percentBasis }, nextAction: x.nextAction,
      job: x.job && { status: x.job.status, stage: x.job.stage, note: x.job.note }, unresolved: x.version?.unresolved.length ?? 0, consent: x.consent.status }; });
}

/** Startup: nothing is lost, nothing is duplicated. Expired leases go back to the queue. */
function reconcileOnStartup() { state(); return recover('server_restart'); }

module.exports = {
  StudioError, ARTIFACTS, registerUpload, getProject, currentVersion, view, list, workerStatus, workerHello, heartbeat, lease, leasedJob,
  progress, acceptArtifact, complete, fail, recover, reconcileOnStartup, fingerprint, unresolved, approvalValid, editPackage, recordException,
  approve, confirmReview, requestChanges, revise, reject, setConsent, retry, sourcePath, artifactPath, dir, save, state, hist, _resetForTests,
  listRules, activeRules, addRule, editRule, retireRule, previousOf, fixName, projectAdapter, judgementMode, judgementMissing, STYLE_OVERRIDABLE,
  verifyCaption, setSettings, applyReview, progressOf, nextAction, cardStates, pendingEdits, ADJUSTMENT_KINDS, PHASES,
  applySkill, testSkill, reviewInfo, TARGETS, decideHearing, start, replan, fixName, storage,
};
