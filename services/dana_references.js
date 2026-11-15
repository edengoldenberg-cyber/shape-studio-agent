'use strict';

/**
 * dana_references.js — editing references the owner adds, their analysis, and approved editing profiles.
 *
 * Durable state in DATA_DIR/dana/:
 *   references.json             one record per reference (link or uploaded file + the owner's note + its analysis)
 *   references/files/<id>.<ext> the uploaded reference file, kept as received
 *   profiles.json               editing profiles the OWNER approved (every version kept); at most one is the default
 *
 * The flow:
 *   owner adds a file + note  → `awaiting_analysis`
 *   editing worker leases it  → `analysing`  (the worker has no network access: only an uploaded FILE can be analysed;
 *                                             a link-only reference is `link_only` and waits for a file)
 *   worker posts the analysis → `analysed`   (observations with example times + a PROPOSED profile — data, not a default)
 *   owner approves / rejects  → `approved` (a new profile version exists) / `rejected` (nothing changes)
 *
 * Nothing here invents an analysis, a profile or a rule, and nothing is approved automatically.
 * A reference is material to learn from; its content, music and assets are never copied into an edit.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PERMISSIONS = new Set(['unknown', 'own', 'licensed', 'inspiration_only']);
const FILE_EXT    = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp']);
const MAX_REFS    = 200;
const MAX_ATTEMPTS = 3;
const MAX_ANALYSIS_BYTES = 300 * 1024;

const now   = () => new Date().toISOString();
const dir   = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'dana');
const refsFile     = () => path.join(dir(), 'references.json');
const profilesFile = () => path.join(dir(), 'profiles.json');
const filesDir     = () => path.join(dir(), 'references', 'files');
const leaseMs      = () => (Number(process.env.DANA_LEASE_SECONDS) || 120) * 1000;

class RefError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

function read(file, empty) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`dana references state is unreadable (${e.message})`); return empty; }
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
const str = (v, max) => String(v ?? '').trim().slice(0, max);
function sha256File(p) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(p, 'r'), buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// ── References ────────────────────────────────────────────────────────────────
const refsState = () => read(refsFile(), { references: [] });
/** Status as it is NOW: a reference without a file cannot be analysed; an expired lease goes back to the queue. */
function settle(s) {
  let changed = false;
  for (const r of s.references) {
    if (!r.file && ['awaiting_analysis', 'analysing'].includes(r.status)) { r.status = 'link_only'; r.lease = null; changed = true; }
    if (r.status === 'analysing' && (!r.lease || Date.parse(r.lease.expiresAt) < Date.now())) {
      r.lease = null; changed = true;
      if ((r.attempts ?? 0) >= MAX_ATTEMPTS) { r.status = 'analysis_failed'; r.analysisError = { code: 'lease_expired', message: 'הניתוח לא הושלם אחרי 3 ניסיונות', at: now() }; }
      else r.status = 'awaiting_analysis';
    }
  }
  if (changed) write(refsFile(), s);
  return s;
}
const profileOf = (refId, all) => all.filter(p => p.source_reference === refId).sort((a, b) => Number(b.version) - Number(a.version))[0] ?? null;
function view(r, allProfiles = profiles()) {
  const { lease, ...rest } = r;                                    // the lease token never leaves the worker channel
  return { ...rest, file: r.file ? { name: r.file.name, bytes: r.file.bytes, ext: r.file.ext } : null,
           attempts: r.attempts ?? 0, analysisError: r.analysisError ?? null, profile: profileOf(r.id, allProfiles) };
}
function list() { const all = profiles(); return settle(refsState()).references.map(r => view(r, all)); }

/** Add a reference: a link OR an uploaded file, with where it came from, what is known about the right to use it, and what the owner liked. */
function add({ title, source_url, file, origin, usage_permission, content_type, fits_message, owner_note, by, fixName = x => x } = {}) {
  const cleanup = () => { if (file?.tmpPath) fs.rmSync(file.tmpPath, { force: true }); };
  try {
    const t = str(title, 120);
    if (!t) throw new RefError(400, 'reference_title_required', 'נדרש שם לרפרנס');
    const url = str(source_url, 500);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new RefError(400, 'reference_url_invalid', 'הקישור חייב להתחיל ב-http:// או https://');
    if (!url && !file) throw new RefError(400, 'reference_source_required', 'נדרש קישור או קובץ');
    const perm = usage_permission ? String(usage_permission) : 'unknown';
    if (!PERMISSIONS.has(perm)) throw new RefError(400, 'reference_permission_invalid', 'הרשאת שימוש לא מוכרת');
    if (!str(by, 80)) throw new RefError(400, 'by_required', 'נדרש שם מי שמוסיף/ה את הרפרנס');
    const s = refsState();
    if (s.references.length >= MAX_REFS) throw new RefError(400, 'references_full', 'יש יותר מדי רפרנסים — יש למחוק ישנים');
    const id = `ref_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    let stored = null;
    if (file) {
      const name = fixName(String(file.originalName ?? ''));
      const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      if (!FILE_EXT.has(ext)) throw new RefError(400, 'reference_format_unsupported', `פורמט לא נתמך לרפרנס: .${ext || '?'}`);
      const bytes = fs.statSync(file.tmpPath).size;
      if (bytes < 100) throw new RefError(400, 'file_empty', 'הקובץ ריק');
      fs.mkdirSync(filesDir(), { recursive: true });
      const dest = path.join(filesDir(), `${id}.${ext}`);
      fs.renameSync(file.tmpPath, dest);
      stored = { name: name.slice(0, 200), ext, bytes, sha256: sha256File(dest) };
    }
    const ref = {
      id, title: t, source_url: url || null, file: stored,
      origin: str(origin, 200) || null,                 // who made it / where it was found
      usage_permission: perm,                           // what is KNOWN about the right to use it
      content_type: str(content_type, 120) || null, fits_message: str(fits_message, 300) || null,
      owner_note: str(owner_note, 2000) || null,        // what the owner liked
      status: stored ? 'awaiting_analysis' : 'link_only',   // the worker cannot fetch links: a link alone waits for a file
      analysis: null, proposed_profile: null, attempts: 0, lease: null, analysisError: null, decision: null,
      addedBy: str(by, 80), addedAt: now(),
    };
    s.references.push(ref); write(refsFile(), s);
    return view(ref);
  } catch (e) { cleanup(); throw e; }
}

function find(s, id) {
  const r = s.references.find(x => x.id === id);
  if (!r) throw new RefError(404, 'reference_not_found', 'הרפרנס לא נמצא');
  return r;
}
const get = id => find(refsState(), id);
function filePath(id) {
  const r = get(id);
  if (!r.file) throw new RefError(404, 'reference_file_missing', 'לרפרנס הזה אין קובץ');
  return { path: path.join(filesDir(), `${r.id}.${r.file.ext}`), ext: r.file.ext, name: r.file.name };
}
function remove(id) {
  const s = refsState(), r = find(s, id);
  if (r.file) fs.rmSync(path.join(filesDir(), `${r.id}.${r.file.ext}`), { force: true });
  s.references = s.references.filter(x => x.id !== id); write(refsFile(), s);
  return list();
}

// ── Analysis by the editing worker (leased like an edit job) ──────────────────
/** Hand the oldest waiting reference to the worker, or null. */
function leaseNext({ workerId } = {}) {
  const s = settle(refsState());
  for (const r of s.references) {
    if (r.status !== 'awaiting_analysis' || !r.file) continue;
    if ((r.attempts ?? 0) >= MAX_ATTEMPTS) { r.status = 'analysis_failed'; r.analysisError = { code: 'attempts_exhausted', message: 'הניתוח נכשל 3 פעמים', at: now() }; continue; }
    if (!r.file.sha256) r.file.sha256 = sha256File(path.join(filesDir(), `${r.id}.${r.file.ext}`));
    r.attempts = (r.attempts ?? 0) + 1;
    r.status = 'analysing';
    r.lease = { token: crypto.randomBytes(24).toString('hex'), workerId: str(workerId, 80) || 'worker', expiresAt: new Date(Date.now() + leaseMs()).toISOString(), at: now() };
    write(refsFile(), s);
    return { reference: { id: r.id, sha256: r.file.sha256, ext: r.file.ext, bytes: r.file.bytes, title: r.title, owner_note: r.owner_note,
                          content_type: r.content_type, fits_message: r.fits_message, usage_permission: r.usage_permission, origin: r.origin },
             leaseToken: r.lease.token };
  }
  write(refsFile(), s);
  return null;
}
function leased(s, id, token) {
  const r = find(s, id);
  const ok = r.status === 'analysing' && r.lease && typeof token === 'string' && token.length === r.lease.token.length
    && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.lease.token)) && Date.parse(r.lease.expiresAt) >= Date.now();
  if (!ok) throw new RefError(409, 'lease_lost', 'the lease on this reference is no longer valid');
  return r;
}
/** The file for the worker that holds the lease (also extends the lease while it downloads). */
function leasedFile(id, token) {
  const s = refsState(), r = leased(s, id, token);
  r.lease.expiresAt = new Date(Date.now() + leaseMs()).toISOString();
  write(refsFile(), s);
  return { path: path.join(filesDir(), `${r.id}.${r.file.ext}`), sha256: r.file.sha256 };
}
/** The worker's result. `analysed` stores the analysis and its PROPOSED profile as data; nothing is approved here. */
function submitAnalysis(id, token, body = {}) {
  const s = refsState(), r = leased(s, id, token);
  if (body.status === 'analysed') {
    const a = body.analysis;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new RefError(400, 'analysis_invalid', 'analysis must be an object');
    if (Buffer.byteLength(JSON.stringify(a)) > MAX_ANALYSIS_BYTES) throw new RefError(400, 'analysis_invalid', 'analysis is too large');
    const pp = a.proposed_profile;
    if (pp != null && (typeof pp !== 'object' || Array.isArray(pp) || typeof pp.params !== 'object' || pp.params === null || Array.isArray(pp.params)))
      throw new RefError(400, 'analysis_invalid', 'proposed_profile needs a params object');
    r.analysis = a; r.proposed_profile = pp ?? null; r.status = 'analysed'; r.analysisError = null; r.analysedAt = now(); r.decision = null;
  } else if (body.status === 'failed') {
    const err = { code: str(body.error?.code, 60) || 'analysis_failed', message: str(body.error?.message, 400) || 'הניתוח נכשל', at: now() };
    r.analysisError = err;
    // a failure the worker calls retryable goes back to the queue while attempts remain; anything else is final
    r.status = body.error?.retryable === true && (r.attempts ?? 0) < MAX_ATTEMPTS ? 'awaiting_analysis' : 'analysis_failed';
  } else throw new RefError(400, 'analysis_invalid', "status must be 'analysed' or 'failed'");
  r.lease = null;
  write(refsFile(), s);
  return view(r);
}
/** The owner asks for the analysis again (for example after changing the note). */
function reanalyse(id) {
  const s = settle(refsState()), r = find(s, id);
  if (!r.file) throw new RefError(409, 'reference_file_missing', 'דנה לא יכולה להוריד קישורים — כדי לנתח צריך להעלות את הקובץ עצמו');
  if (r.status === 'analysing') throw new RefError(409, 'analysis_in_progress', 'הניתוח כבר רץ');
  r.status = 'awaiting_analysis'; r.attempts = 0; r.lease = null; r.analysisError = null;
  write(refsFile(), s);
  return view(r);
}

// ── Profiles: only what the owner approved ────────────────────────────────────
const profiles = () => read(profilesFile(), { profiles: [] }).profiles;
/** What every new job is edited by. Only an approved profile can be here. */
function defaultProfile() {
  const p = profiles().find(x => x.default);
  return p ? { id: p.id, version: p.version, params: p.params, rules: Array.isArray(p.rules) ? p.rules : [], source_reference: p.source_reference ?? null } : null;
}
/**
 * Approve the profile a finished package was edited with as the default for future projects.
 * The id, version and parameters are taken from that package (what the worker actually used) —
 * never typed in and never guessed.
 */
function approveProfile(id, { package: pkg, projectId, versionN, by } = {}) {
  if (!str(by, 80)) throw new RefError(400, 'by_required', 'נדרש שם המאשר/ת');
  const used = pkg?.rules_used?.profile;
  if (!used?.id || used.id !== id) throw new RefError(409, 'profile_not_in_package', 'הפרופיל הזה לא שימש בגרסה שנבחרה — אפשר לאשר רק פרופיל שסרטון נערך לפיו בפועל');
  if (!pkg.style || typeof pkg.style !== 'object') throw new RefError(409, 'profile_params_missing', 'החבילה לא כוללת את פרמטרי הסגנון שבהם נערכה');
  const s = read(profilesFile(), { profiles: [] });
  for (const p of s.profiles) p.default = false;
  const rec = { id, version: String(used.version ?? ''), sha256: used.sha256 ?? null, params: pkg.style, rules: Array.isArray(used.rules) ? used.rules : [],
                source_reference: used.source_reference ?? null, default: true,
                approvedBy: str(by, 80), approvedAt: now(), approved_by: str(by, 80), approved_at: now(), fromProject: projectId ?? null, fromVersion: versionN ?? null };
  s.profiles = s.profiles.filter(p => !(p.id === id && String(p.version) === rec.version));
  s.profiles.push(rec); write(profilesFile(), s);
  return s.profiles;
}
function clearDefaultProfile() {
  const s = read(profilesFile(), { profiles: [] });
  for (const p of s.profiles) p.default = false;
  write(profilesFile(), s);
  return s.profiles;
}
/**
 * The owner approves the profile Dana PROPOSED from a reference — optionally with adjusted numbers.
 * Every approval is a new version of profile `ref-<refId>`; earlier versions stay in the store.
 * It becomes the default for future projects only when the owner says so.
 */
function approveReferenceProfile(id, { by, make_default, params } = {}) {
  const who = str(by, 80);
  if (!who) throw new RefError(400, 'by_required', 'נדרש שם המאשר/ת');
  const s = settle(refsState()), r = find(s, id);
  const pp = r.proposed_profile;
  if (!['analysed', 'approved', 'rejected'].includes(r.status) || !pp?.params) throw new RefError(409, 'no_proposed_profile', 'אין עדיין הצעת פרופיל מהרפרנס הזה');
  const merged = { ...pp.params };
  if (params !== undefined) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new RefError(400, 'profile_params_invalid', 'params must be an object');
    for (const [k, v] of Object.entries(params)) {                      // only the numbers Dana proposed can be adjusted; nothing new is added
      if (!(k in pp.params)) throw new RefError(400, 'profile_params_invalid', `פרמטר לא מוכר: ${k}`);
      if (typeof v !== typeof pp.params[k] || (typeof v === 'number' && !Number.isFinite(v)) || (typeof v === 'string' && v.length > 300))
        throw new RefError(400, 'profile_params_invalid', `ערך לא תקין לפרמטר ${k}`);
      merged[k] = v;
    }
  }
  const ps = read(profilesFile(), { profiles: [] }), pid = `ref-${r.id}`;
  const version = ps.profiles.filter(p => p.id === pid).reduce((m, p) => Math.max(m, Number(p.version) || 0), 0) + 1;
  const at = now();
  const rec = { id: pid, version, params: merged, rules: (Array.isArray(pp.rules) ? pp.rules : []).map(x => str(x, 400)).filter(Boolean).slice(0, 20),
                source_reference: r.id, approved_by: who, approved_at: at, approvedBy: who, approvedAt: at,
                adjusted: Object.keys(params ?? {}).filter(k => params[k] !== pp.params[k]), default: false };
  if (make_default === true) { for (const p of ps.profiles) p.default = false; rec.default = true; }
  ps.profiles.push(rec); write(profilesFile(), ps);
  r.status = 'approved'; r.decision = { action: 'approved', by: who, at, profile: { id: pid, version }, made_default: rec.default };
  write(refsFile(), s);
  return { reference: view(r, ps.profiles), profile: rec };
}
/** The owner rejects the proposal. Nothing becomes a default; profiles approved earlier are not touched. */
function rejectReferenceProfile(id, { by, reason } = {}) {
  const who = str(by, 80);
  if (!who) throw new RefError(400, 'by_required', 'נדרש שם הדוחה');
  const s = settle(refsState()), r = find(s, id);
  if (!['analysed', 'approved', 'rejected'].includes(r.status) || !r.analysis) throw new RefError(409, 'no_proposed_profile', 'אין עדיין ניתוח לרפרנס הזה');
  r.status = 'rejected'; r.decision = { action: 'rejected', by: who, at: now(), reason: str(reason, 500) || null };
  write(refsFile(), s);
  return view(r);
}

module.exports = { RefError, PERMISSIONS, FILE_EXT, MAX_ATTEMPTS, list, add, get, remove, filePath, leaseNext, leasedFile, submitAnalysis, reanalyse,
                   profiles, defaultProfile, approveProfile, clearDefaultProfile, approveReferenceProfile, rejectReferenceProfile };
