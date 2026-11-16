'use strict';
/**
 * Dana — more than one file in a project: several SOURCE videos (a compilation), an uploaded MUSIC track, an uploaded
 * NARRATION, and the mix settings. Part of the existing project / version / job mechanism (services/dana_studio.js keeps
 * the projects; this module only adds the media a project holds and what a job is told about it).
 *
 *   - every file is stored once, by content hash, next to the sources; nothing is ever overwritten or deleted here;
 *   - a source keeps its own name, size and the owner's marks: ranges that MUST be used and ranges that must NEVER be used;
 *   - an uploaded music file is NOT marked as licensed. The licence is recorded only by an explicit action of the owner;
 *   - a narration that was written for the video is a SCRIPT, never presented as a quotation of the people filmed;
 *   - changing the media or the mix never touches an existing version: it takes effect in the next version.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const studio = () => require('./dana_studio');
const now = () => new Date().toISOString();
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const Err = (status, code, message, extra) => new (studio().StudioError)(status, code, message, extra);

const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac' };
const PROJECT_TYPES = { interview: 'ראיון / עדות', montage: 'לקט אימונים', narrated: 'סרטון עם קריינות', mixed: 'שילוב' };
const MAX_SOURCES = 12;
// "volume_db" of the music = how many dB UNDER THE SPEECH it sits while somebody speaks (the worker measures the speech and
// sets the gain). Before 2026-11-16 it was a gain on the file, and music ended 23-30 dB under the speech: not heard.
const MUSIC_LEVEL = { default: -14, loudest: -6, quietest: -20 };
const BRIEF_DEFAULT = { goal: '', take: '', avoid: '', reference_id: null, min_sources: 0, demo: false };
const AUDIO_DEFAULT = { music: null, narration: null, original: { mode: 'keep', level_db: 0, mute_segments: [] }, cut_on_beat: false };

function hashFile(p) {
  return new Promise((resolve, reject) => { const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex'))); });
}
const extOf = name => (String(name || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const filePath = f => studio().sourcePath(f);                  // the same content-addressed store as the first source
/** All the source videos of a project, the first one included. Older projects have only `source`. */
function sourcesOf(p) {
  if (!Array.isArray(p.sources) || !p.sources.length) p.sources = [{ id: 'src1', ...p.source, marks: [] }];
  return p.sources;
}
function busy(p) { return Object.values(studio().state().jobs).some(j => j.projectId === p.id && j.status === 'leased'); }
function store(tmpPath, file) { const dest = filePath(file); if (!fs.existsSync(dest)) fs.renameSync(tmpPath, dest); else fs.rmSync(tmpPath, { force: true }); }

/** A job that is still waiting for the worker is told about the media as it is NOW (files added after the upload count). */
function refreshQueued(p) {
  for (const j of Object.values(studio().state().jobs)) if (j.projectId === p.id && j.status === 'queued') Object.assign(j.options, forJob(p));
}

async function addSource(projectId, { tmpPath, originalName, by }) {
  const S = studio(), p = S.getProject(projectId);
  const drop = e => { fs.rmSync(tmpPath, { force: true }); return e; };
  if (p.kind === 'review_only') throw drop(Err(409, 'review_only', 'לסרטון שהועלה לביקורת בלבד אי אפשר להוסיף מקורות'));
  if (busy(p)) throw drop(Err(409, 'job_in_progress', 'העריכה רצה כרגע — אפשר להוסיף קובץ כשהיא תסתיים'));
  const who = str(by, 80); if (!who) throw drop(Err(400, 'by_required', 'נדרש שם מי שמוסיף/ה את הקובץ'));
  const name = S.fixName ? S.fixName(originalName) : originalName, ext = extOf(name);
  if (!VIDEO_EXT.has(ext)) throw drop(Err(400, 'format_unsupported', `פורמט לא נתמך: .${ext || '?'}`));
  const bytes = fs.statSync(tmpPath).size;
  if (bytes < 1024) throw drop(Err(400, 'file_empty', 'הקובץ ריק'));
  const list = sourcesOf(p);
  if (list.length >= MAX_SOURCES) throw drop(Err(409, 'too_many_sources', `אפשר עד ${MAX_SOURCES} קובצי מקור בפרויקט`));
  const sha256 = await hashFile(tmpPath);
  if (list.some(s => s.sha256 === sha256)) { fs.rmSync(tmpPath, { force: true }); return { duplicate: true, project: S.view(p) }; }
  const src = { id: `src${Math.max(...list.map(s => Number(s.id.slice(3)) || 0)) + 1}`, sha256, ext, bytes, originalName: str(name, 200), uploadedAt: now(), by: who, marks: [] };
  store(tmpPath, src); list.push(src);
  S.hist(p, 'owner', 'source_added', { id: src.id, sha256, bytes, originalName: src.originalName, by: who });
  refreshQueued(p); S.save();
  return { duplicate: false, project: S.view(p) };
}

/** Ranges of ONE source that must be in the video, or must never be used. They are instructions of the owner, kept per file. */
function setMarks(projectId, sourceId, { marks, by }) {
  const S = studio(), p = S.getProject(projectId), src = sourcesOf(p).find(s => s.id === sourceId);
  if (!src) throw Err(404, 'source_not_found', 'קובץ המקור לא נמצא');
  const who = str(by, 80); if (!who) throw Err(400, 'by_required', 'נדרש שם');
  if (!Array.isArray(marks) || marks.length > 40) throw Err(400, 'marks_invalid', 'סימוני קטעים לא תקינים');
  const clean = marks.map(m => { const a = Number(m?.from_s), b = Number(m?.to_s);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b - a < 0.3 || b > 36000 || !['must', 'never'].includes(m?.kind)) throw Err(400, 'marks_invalid', 'כל סימון חייב התחלה, סוף (לפחות 0.3 שניות) וסוג: חייב להיכלל / לא להשתמש');
    return { from_s: Math.round(a * 100) / 100, to_s: Math.round(b * 100) / 100, kind: m.kind, note: str(m.note, 200) || null, by: who, at: now() }; }).sort((x, y) => x.from_s - y.from_s);
  for (let i = 1; i < clean.length; i++) if (clean[i].from_s < clean[i - 1].to_s && clean[i].kind !== clean[i - 1].kind) throw Err(400, 'marks_conflict', 'אותו קטע מסומן גם "חייב להיכלל" וגם "לא להשתמש"');
  src.marks = clean;
  S.hist(p, 'owner', 'source_marks_set', { id: src.id, must: clean.filter(m => m.kind === 'must').length, never: clean.filter(m => m.kind === 'never').length, by: who });
  refreshQueued(p); S.save();
  return S.view(p);
}

/** A source can be taken out of FUTURE versions. The file and every version made with it stay. The first source cannot be removed. */
function removeSource(projectId, sourceId, { by }) {
  const S = studio(), p = S.getProject(projectId), list = sourcesOf(p), src = list.find(s => s.id === sourceId);
  if (!src) throw Err(404, 'source_not_found', 'קובץ המקור לא נמצא');
  if (src.id === 'src1') throw Err(409, 'primary_source', 'הקובץ הראשון של הפרויקט אינו ניתן להסרה');
  if (busy(p)) throw Err(409, 'job_in_progress', 'העריכה רצה כרגע');
  const who = str(by, 80); if (!who) throw Err(400, 'by_required', 'נדרש שם');
  src.removedAt = now(); src.removedBy = who;
  S.hist(p, 'owner', 'source_removed_from_future_versions', { id: src.id, by: who });
  refreshQueued(p); S.save();
  return S.view(p);
}

async function addAsset(projectId, { tmpPath, originalName, kind, by }) {
  const S = studio(), p = S.getProject(projectId);
  const drop = e => { fs.rmSync(tmpPath, { force: true }); return e; };
  if (!['music', 'narration'].includes(kind)) throw drop(Err(400, 'asset_kind_invalid', 'סוג הקובץ חייב להיות מוזיקה או קריינות'));
  const who = str(by, 80); if (!who) throw drop(Err(400, 'by_required', 'נדרש שם מי שמעלה את הקובץ'));
  const name = S.fixName ? S.fixName(originalName) : originalName, ext = extOf(name);
  if (!AUDIO_EXT.has(ext)) throw drop(Err(400, 'format_unsupported', `פורמט אודיו לא נתמך: .${ext || '?'} (נתמכים: ${[...AUDIO_EXT].join(', ')})`));
  const bytes = fs.statSync(tmpPath).size;
  if (bytes < 1024) throw drop(Err(400, 'file_empty', 'הקובץ ריק'));
  const sha256 = await hashFile(tmpPath);
  p.assets = p.assets ?? [];
  let a = p.assets.find(x => x.sha256 === sha256 && x.kind === kind);
  if (a) { fs.rmSync(tmpPath, { force: true }); return { duplicate: true, asset: a, project: S.view(p) }; }
  a = { id: `${kind === 'music' ? 'mus' : 'nar'}_${crypto.randomBytes(5).toString('hex')}`, kind, sha256, ext, bytes, originalName: str(name, 200), uploadedAt: now(), by: who,
    // a file the owner uploaded is NOT assumed to be licensed; a narration is not assumed to be a quotation
    ...(kind === 'music' ? { license: { status: 'not_confirmed', source: null, note: null, by: null, at: null } } : { script: { is_script: null, text: null } }) };
  store(tmpPath, a); p.assets.push(a);
  S.hist(p, 'owner', 'asset_added', { id: a.id, kind, sha256, bytes, originalName: a.originalName, by: who });
  S.save();
  return { duplicate: false, asset: a, project: S.view(p) };
}

/** Where a music file came from and under what licence — recorded only when the owner says so. Never set automatically. */
function setLicense(projectId, assetId, { status, source, note, by }) {
  const S = studio(), p = S.getProject(projectId), a = (p.assets ?? []).find(x => x.id === assetId && x.kind === 'music');
  if (!a) throw Err(404, 'asset_not_found', 'קובץ המוזיקה לא נמצא');
  const who = str(by, 80); if (!who) throw Err(400, 'by_required', 'נדרש שם המאשר/ת');
  if (!['owner_confirmed', 'not_confirmed'].includes(status)) throw Err(400, 'license_status_invalid', 'מצב הרישיון חייב להיות "אושר על ידי הבעלים" או "לא אושר"');
  if (status === 'owner_confirmed' && str(source, 300).length < 3) throw Err(400, 'license_source_required', 'כדי לאשר רישיון נדרש מקור הרצועה (מאיפה היא ואיזה רישיון)');
  a.license = { status, source: str(source, 300) || null, note: str(note, 500) || null, by: who, at: now() };
  S.hist(p, 'owner', 'music_license_recorded', { id: a.id, status, by: who });
  refreshQueued(p); S.save();
  return S.view(p);
}

/** Is the narration a script that was written for the video (not the words of the people filmed)? Recorded by the owner. */
function setNarrationInfo(projectId, assetId, { is_script, text, by }) {
  const S = studio(), p = S.getProject(projectId), a = (p.assets ?? []).find(x => x.id === assetId && x.kind === 'narration');
  if (!a) throw Err(404, 'asset_not_found', 'קובץ הקריינות לא נמצא');
  const who = str(by, 80); if (!who) throw Err(400, 'by_required', 'נדרש שם');
  a.script = { is_script: is_script === true ? true : is_script === false ? false : null, text: str(text, 4000) || null, by: who, at: now() };
  S.hist(p, 'owner', 'narration_info_set', { id: a.id, is_script: a.script.is_script, by: who });
  refreshQueued(p); S.save();
  return S.view(p);
}

function cleanAudio(p, body) {
  const assets = p.assets ?? [], cur = { ...AUDIO_DEFAULT, ...(p.audio ?? {}) }, out = { ...cur };
  if (body.music !== undefined) {
    if (body.music === null) out.music = null;
    else { const a = assets.find(x => x.id === body.music?.asset && x.kind === 'music');
      if (!a) throw Err(400, 'asset_not_found', 'קובץ המוזיקה שנבחר לא נמצא בפרויקט');
      out.music = { asset: a.id, start_s: num(body.music.start_s, 0, 3600, 0), volume_db: num(body.music.volume_db, MUSIC_LEVEL.quietest, MUSIC_LEVEL.loudest, MUSIC_LEVEL.default), fade_in_s: num(body.music.fade_in_s, 0, 10, 0.5),
        fade_out_s: num(body.music.fade_out_s, 0, 10, 1.5), duck: body.music.duck !== false, duck_db: num(body.music.duck_db, 3, 24, 10) }; }
  }
  if (body.narration !== undefined) {
    if (body.narration === null) out.narration = null;
    else { const a = assets.find(x => x.id === body.narration?.asset && x.kind === 'narration');
      if (!a) throw Err(400, 'asset_not_found', 'קובץ הקריינות שנבחר לא נמצא בפרויקט');
      out.narration = { asset: a.id, start_s: num(body.narration.start_s, 0, 600, 0), volume_db: num(body.narration.volume_db, -12, 6, 0) }; }
  }
  if (body.original !== undefined) {
    if (!['keep', 'mute'].includes(body.original?.mode)) throw Err(400, 'original_mode_invalid', 'הסאונד המקורי: "לשמור" או "להשתיק"');
    const ms = Array.isArray(body.original.mute_segments) ? [...new Set(body.original.mute_segments.map(Number).filter(n => Number.isInteger(n) && n > 0 && n < 100))].sort((a, b) => a - b) : [];
    out.original = { mode: body.original.mode, level_db: num(body.original.level_db, -30, 6, 0), mute_segments: ms };
  }
  if (body.cut_on_beat !== undefined) out.cut_on_beat = body.cut_on_beat === true;
  return out;
}
/** The mix for the NEXT version: which music / narration, from where, how loud, fades, ducking, and the original sound. */
function setAudio(projectId, body = {}) {
  const S = studio(), p = S.getProject(projectId);
  const who = str(body.by, 80); if (!who) throw Err(400, 'by_required', 'נדרש שם');
  if (busy(p)) throw Err(409, 'job_in_progress', 'העריכה רצה כרגע — השינוי יישמר כשתסתיים');
  p.audio = cleanAudio(p, body);
  S.hist(p, 'owner', 'audio_settings_changed', { by: who, music: p.audio.music?.asset ?? null, narration: p.audio.narration?.asset ?? null, original: p.audio.original.mode });
  refreshQueued(p); S.save();
  return S.view(p);
}

/**
 * The owner's direction for the edit: what the video is for, a reference with what to take from it and what not to, and -
 * for a compilation - how many different source files must appear. Nothing here is a style the owner approved for other
 * projects; it belongs to this project and travels with its next jobs.
 */
function setBrief(projectId, body = {}) {
  const S = studio(), p = S.getProject(projectId);
  const who = str(body.by, 80); if (!who) throw Err(400, 'by_required', 'נדרש שם');
  if (busy(p)) throw Err(409, 'job_in_progress', 'העריכה רצה כרגע — השינוי יישמר כשתסתיים');
  const cur = { ...BRIEF_DEFAULT, ...(p.brief ?? {}) }, active = sourcesOf(p).filter(s => !s.removedAt).length;
  const out = { ...cur };
  for (const k of ['goal', 'take', 'avoid']) if (body[k] !== undefined) out[k] = str(body[k], 600);
  if (body.reference_id !== undefined) {
    if (body.reference_id === null || body.reference_id === '') out.reference_id = null;
    else { let r = null; try { r = require('./dana_references').get(String(body.reference_id)); } catch { r = null; }
      if (!r) throw Err(400, 'reference_not_found', 'הרפרנס שנבחר לא נמצא');
      out.reference_id = r.id; }
  }
  if (body.min_sources !== undefined) {
    const n = Math.round(num(body.min_sources, 0, MAX_SOURCES, 0));
    if (n > active) throw Err(400, 'min_sources_too_high', `ביקשת לפחות ${n} מקורות, ובפרויקט יש ${active}. מוסיפים קבצים או מקטינים את הדרישה`);
    out.min_sources = n >= 2 ? n : 0;
  }
  if (body.demo !== undefined) out.demo = body.demo === true;
  p.brief = { ...out, by: who, at: new Date().toISOString() };
  S.hist(p, 'owner', 'brief_set', { by: who, goal: !!out.goal, reference: out.reference_id, min_sources: out.min_sources, demo: out.demo });
  refreshQueued(p); S.save();
  return S.view(p);
}
function briefForJob(p) {
  const b = { ...BRIEF_DEFAULT, ...(p.brief ?? {}) };
  if (!b.goal && !b.take && !b.avoid && !b.reference_id && !b.min_sources && !b.demo) return null;
  let reference = null;
  if (b.reference_id) { try { const r = require('./dana_references').get(b.reference_id);
    reference = { id: r.id, title: r.title, owner_note: r.owner_note ?? '', summary: r.analysis?.summary ?? '', analysed: !!r.analysis }; } catch { reference = null; } }
  return { goal: b.goal, take: b.take, avoid: b.avoid, min_sources: b.min_sources, demo: b.demo, reference };
}
function briefView(p) {
  const b = { ...BRIEF_DEFAULT, ...(p.brief ?? {}) };
  let reference = null;
  if (b.reference_id) { try { const r = require('./dana_references').get(b.reference_id); reference = { id: r.id, title: r.title, analysed: !!r.analysis }; } catch { reference = { id: b.reference_id, title: null, missing: true }; } }
  return { ...b, reference };
}

function setType(p, type) {
  if (type === undefined) return;
  if (!PROJECT_TYPES[type]) throw Err(400, 'project_type_invalid', 'סוג הפרויקט אינו מוכר');
  p.projectType = type;
}

/** What a job is told: every source in use with its marks, the audio files with the mix settings, and the kind of project. */
function forJob(p) {
  const active = sourcesOf(p).filter(s => !s.removedAt), assets = p.assets ?? [], au = { ...AUDIO_DEFAULT, ...(p.audio ?? {}) };
  const file = id => { const a = assets.find(x => x.id === id); return a ? { id: a.id, sha256: a.sha256, ext: a.ext, name: a.originalName } : null; };
  const music = au.music && file(au.music.asset) ? { ...au.music, file: file(au.music.asset), license: assets.find(x => x.id === au.music.asset).license } : null;
  const nar = au.narration && file(au.narration.asset) ? { ...au.narration, file: file(au.narration.asset), script: assets.find(x => x.id === au.narration.asset).script } : null;
  const out = { project_type: p.projectType ?? 'interview' };
  const brief = briefForJob(p); if (brief) out.brief = brief;
  if (active.length > 1 || active.some(s => s.marks?.length)) out.sources = active.map(s => ({ id: s.id, sha256: s.sha256, ext: s.ext, name: s.originalName, marks: s.marks ?? [] }));
  if (music || nar || au.original.mode !== 'keep' || au.original.mute_segments.length || au.cut_on_beat) out.audio = { music, narration: nar, original: au.original, cut_on_beat: au.cut_on_beat };
  return out;
}
/** Any file of the project the worker may download for a job: a source or an audio file, by hash. */
function fileFor(p, sha) {
  return sourcesOf(p).find(s => s.sha256 === sha) ?? (p.assets ?? []).find(a => a.sha256 === sha) ?? null;
}

function view(p) {
  const au = { ...AUDIO_DEFAULT, ...(p.audio ?? {}) };
  return { projectType: p.projectType ?? 'interview', projectTypes: PROJECT_TYPES,
    sources: sourcesOf(p).map(s => ({ id: s.id, name: s.originalName, bytes: s.bytes, ext: s.ext, addedAt: s.uploadedAt, marks: s.marks ?? [], removed: !!s.removedAt, primary: s.id === 'src1' })),
    assets: (p.assets ?? []).map(a => ({ id: a.id, kind: a.kind, name: a.originalName, bytes: a.bytes, ext: a.ext, uploadedAt: a.uploadedAt, by: a.by, license: a.license ?? null, script: a.script ?? null })),
    audio: au, brief: briefView(p), musicLevel: MUSIC_LEVEL };
}

module.exports = { VIDEO_EXT, AUDIO_EXT, AUDIO_MIME, PROJECT_TYPES, MAX_SOURCES, sourcesOf, addSource, setMarks, removeSource, addAsset, setLicense, setNarrationInfo, setAudio, cleanAudio, setType, setBrief, MUSIC_LEVEL,
                   forJob, fileFor, filePath, view };
