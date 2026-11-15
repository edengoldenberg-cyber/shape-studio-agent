'use strict';

/**
 * dana_references.js — editing references the owner adds, and the approved editing profile.
 *
 * Durable state in DATA_DIR/dana/:
 *   references.json            one record per reference (link or uploaded file + the owner's note)
 *   references/files/<id>.<ext> the uploaded reference file, kept as received
 *   profiles.json              editing profiles the OWNER approved; at most one is the default
 *
 * What this does NOT do: analyse a reference or propose a profile from it. Every reference stays
 * `awaiting_analysis` until that exists — nothing here invents an analysis, a profile or a rule.
 * A reference is material to learn from; its content, music and assets are never copied into an edit.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PERMISSIONS = new Set(['unknown', 'own', 'licensed', 'inspiration_only']);
const FILE_EXT    = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'jpg', 'jpeg', 'png', 'webp']);
const MAX_REFS    = 200;

const now   = () => new Date().toISOString();
const dir   = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'dana');
const refsFile     = () => path.join(dir(), 'references.json');
const profilesFile = () => path.join(dir(), 'profiles.json');
const filesDir     = () => path.join(dir(), 'references', 'files');

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

// ── References ────────────────────────────────────────────────────────────────
const view = r => ({ ...r, file: r.file ? { name: r.file.name, bytes: r.file.bytes, ext: r.file.ext } : null });
const list = () => read(refsFile(), { references: [] }).references.map(view);

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
    const s = read(refsFile(), { references: [] });
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
      fs.renameSync(file.tmpPath, path.join(filesDir(), `${id}.${ext}`));
      stored = { name: name.slice(0, 200), ext, bytes };
    }
    const ref = {
      id, title: t, source_url: url || null, file: stored,
      origin: str(origin, 200) || null,                 // who made it / where it was found
      usage_permission: perm,                           // what is KNOWN about the right to use it
      content_type: str(content_type, 120) || null, fits_message: str(fits_message, 300) || null,
      owner_note: str(owner_note, 2000) || null,        // what the owner liked
      status: 'awaiting_analysis', analysis: null, proposed_profile: null,
      addedBy: str(by, 80), addedAt: now(),
    };
    s.references.push(ref); write(refsFile(), s);
    return view(ref);
  } catch (e) { cleanup(); throw e; }
}

function get(id) {
  const r = read(refsFile(), { references: [] }).references.find(x => x.id === id);
  if (!r) throw new RefError(404, 'reference_not_found', 'הרפרנס לא נמצא');
  return r;
}
function filePath(id) {
  const r = get(id);
  if (!r.file) throw new RefError(404, 'reference_file_missing', 'לרפרנס הזה אין קובץ');
  return { path: path.join(filesDir(), `${r.id}.${r.file.ext}`), ext: r.file.ext, name: r.file.name };
}
function remove(id) {
  const s = read(refsFile(), { references: [] }), r = s.references.find(x => x.id === id);
  if (!r) throw new RefError(404, 'reference_not_found', 'הרפרנס לא נמצא');
  if (r.file) fs.rmSync(path.join(filesDir(), `${r.id}.${r.file.ext}`), { force: true });
  s.references = s.references.filter(x => x.id !== id); write(refsFile(), s);
  return s.references.map(view);
}

// ── Profiles: only what the owner approved ────────────────────────────────────
const profiles = () => read(profilesFile(), { profiles: [] }).profiles;
function defaultProfile() {
  const p = profiles().find(x => x.default);
  return p ? { id: p.id, version: p.version, params: p.params } : null;
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
  const rec = { id, version: String(used.version ?? ''), sha256: used.sha256 ?? null, params: pkg.style, default: true,
                approvedBy: str(by, 80), approvedAt: now(), fromProject: projectId ?? null, fromVersion: versionN ?? null };
  s.profiles = s.profiles.filter(p => !(p.id === id && p.version === rec.version));
  s.profiles.push(rec); write(profilesFile(), s);
  return s.profiles;
}
function clearDefaultProfile() {
  const s = read(profilesFile(), { profiles: [] });
  for (const p of s.profiles) p.default = false;
  write(profilesFile(), s);
  return s.profiles;
}

module.exports = { RefError, PERMISSIONS, FILE_EXT, list, add, get, remove, filePath, profiles, defaultProfile, approveProfile, clearDefaultProfile };
