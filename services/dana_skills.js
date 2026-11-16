'use strict';

/**
 * dana_skills.js — the editing-skill library.
 *
 * A skill is a NAMED, VERSIONED set of editing rules that Dana can load into planning, rendering and review:
 *   purpose + suitable video types, rules (each tied to where it came from), profile parameters, review criteria.
 * It is built on what already exists: a reference's analysis and proposed profile (services/dana_references.js),
 * and the job's `profile` channel the worker already reads. Nothing here is a parallel system.
 *
 * Two ways to draft one:
 *   from analysis   deterministic: the owner picks aspects and numbers from analysed references; every rule keeps the
 *                   finding it came from (reference, aspect, example times) and how well founded it is.
 *   from a prompt   the owner's free text is structured by a tool-free model call on the editing computer
 *                   (leased like a reference analysis); it may be combined with reference rules, and contradictions
 *                   are listed with a proposed resolution.
 *
 * Fixed rules of the library:
 *   - a draft is never used by a project and never becomes a default; only an OWNER-approved version is;
 *   - a hypothesis is not an active rule until the owner adopts it as their own instruction;
 *   - a rule the editing worker cannot carry out is kept, marked "unsupported", and never counted as applied;
 *   - an approved version is immutable: an edit starts a new draft version; projects keep the version they used;
 *   - approving a skill approves an editing style. It is not an approval to publish anything.
 * Reference text and prompts are editing DATA. They grant nothing: no code is run from them, no secret is read.
 *
 * Durable state: DATA_DIR/dana/skills.json, and for every saved version the files
 *   DATA_DIR/dana/skills/<id>/v<N>/{SKILL.md, profile.json, criteria.json}   (the same shape as dana-worker/skill/dana-editing)
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const refs   = require('./dana_references');

const now  = () => new Date().toISOString();
const dir  = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'dana');
const file = () => path.join(dir(), 'skills.json');
const str  = (v, max) => String(v ?? '').trim().slice(0, max);
const leaseMs = () => (Number(process.env.DANA_LEASE_SECONDS) || 120) * 1000;
const MAX_SKILLS = 100, MAX_RULES = 40, MAX_ATTEMPTS = 3;

class SkillError extends Error { constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; } }

// ── What the editing worker can actually do, per area of a rule ───────────────
// A skill's NAME says nothing about this; every rule is classified by its area.
const DOMAINS = {
  structure:       { label: 'מבנה ומסר',           support: 'supported',   note: 'דנה בוחרת קטעים וסדר לפי ההוראה, רק ממה שנאמר בהקלטה' },
  opening:         { label: 'פתיחה',               support: 'supported',   note: 'בחירת משפט הפתיחה מתוך ההקלטה' },
  pace:            { label: 'קצב',                 support: 'supported',   note: 'בחירת קטעים וחלוקת כתוביות; אין שינוי מהירות' },
  pauses:          { label: 'הפסקות',              support: 'partial',     note: 'אפשר להשמיט קטעים; אין קיצור אוטומטי של שתיקות בתוך קטע' },
  cuts:            { label: 'חיתוכים',             support: 'supported',   note: 'חיתוך ישר בין מילים, עם מעבר קול קצר' },
  transitions:     { label: 'מעברים',              support: 'unsupported', note: 'העובד מבצע חיתוך ישר בלבד — אין דיזולב, החלקה או מעבר מעוצב' },
  zooms:           { label: 'זומים',               support: 'supported',   note: 'זום פנימה והחזקה על הפנים שנמדדו, בעוצמות שבפרמטרים' },
  captions:        { label: 'כתוביות',             support: 'supported',   note: 'גופן, גודל, מיקום, שורות, צבע; הנפשת כניסה בלבד' },
  emphasis:        { label: 'הדגשות',              support: 'supported',   note: 'צבע שני על מילות מפתח' },
  motion_graphics: { label: 'מואושן גרפיק',        support: 'partial',     note: 'כותרת פתיחה והדגשת משפט מפתח בלבד, מציטוט מדויק' },
  color:           { label: 'צבע',                 support: 'partial',     note: 'תיקון עדין לפי מדידה (חשיפה, קונטרסט, איזון לבן, רוויה); אין מראה / גרייד' },
  sound:           { label: 'סאונד',               support: 'partial',     note: 'ניקוי רעש עדין ונרמול עוצמה בלבד' },
  cover:           { label: 'קאבר',                support: 'partial',     note: 'ציטוט מדויק על פריים מהסרטון' },
  music:           { label: 'מוזיקה',              support: 'unsupported', note: 'העובד לא מוסיף מוזיקה' },
  sound_effects:   { label: 'אפקטים קוליים',       support: 'unsupported', note: 'העובד לא מוסיף אפקטים קוליים' },
  broll:           { label: 'צילומי השלמה',        support: 'unsupported', note: 'אין שילוב צילומי השלמה' },
  other:           { label: 'אחר',                 support: 'partial',     note: 'הוראה כללית: נמסרת לדנה כהנחיה, בלי בדיקה ייעודית' },
};
const BASES = ['measured', 'seen_in_stills', 'model_assessment', 'hypothesis', 'owner_instruction'];
const PARAM_LIMITS = {                                    // the same ranges the reference analysis may propose
  caption_size: [60, 130], caption_y_px: [300, 1500], caption_max_lines: [1, 2], max_words_per_line: [1, 5], max_chars_per_line: [6, 26],
  zoom_scale_light: [1.03, 1.2], zoom_scale_medium: [1.05, 1.35], zoom_scale_strong: [1.1, 1.5], zoom_min_gap_s: [2, 30], zoom_min_hold_s: [0.6, 6],
  min_on_screen_s: [0.3, 1.5], max_chars_per_s: [10, 26],
};
const PARAM_BOOLS = ['backing', 'highlight_enabled'];
const PARAM_ENUMS = { caption_animation: ['none', 'fade', 'rise'] };

// ── Store ─────────────────────────────────────────────────────────────────────
function read() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`dana skills state is unreadable (${e.message})`); return { skills: [] }; }
}
function write(s) { fs.mkdirSync(dir(), { recursive: true }); const tmp = file() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8'); fs.renameSync(tmp, file()); }
function find(s, id) { const k = s.skills.find(x => x.id === id); if (!k) throw new SkillError(404, 'skill_not_found', 'הסקיל לא נמצא'); return k; }
const latest = k => k.versions[k.versions.length - 1];
const approvedOf = k => [...k.versions].reverse().find(v => v.status === 'approved') ?? null;
const hist = (v, by, action, detail) => v.history.push({ at: now(), by: by ?? null, action, ...(detail ? { detail } : {}) });

function cleanParams(p) {
  const out = {};
  for (const [k, v] of Object.entries(p && typeof p === 'object' && !Array.isArray(p) ? p : {})) {
    if (PARAM_LIMITS[k] && typeof v === 'number' && Number.isFinite(v)) { const [lo, hi] = PARAM_LIMITS[k]; out[k] = Math.min(Math.max(v, lo), hi); if (Number.isInteger(lo) && Number.isInteger(hi) && hi - lo <= 4) out[k] = Math.round(out[k]); }
    else if (PARAM_BOOLS.includes(k) && typeof v === 'boolean') out[k] = v;
    else if (PARAM_ENUMS[k] && PARAM_ENUMS[k].includes(v)) out[k] = v;
  }
  return out;
}
/** A rule as stored. Support comes from its AREA (what the worker can do), never from the skill's name or the text's confidence. */
function makeRule(n, { text, domain, basis, source, executable, executable_note }) {
  const d = DOMAINS[domain] ? domain : 'other';
  const unsupported = DOMAINS[d].support === 'unsupported' || executable === false;
  const b = BASES.includes(basis) ? basis : 'hypothesis';
  return { id: `r${n}`, text: str(text, 400), domain: d, basis: b, source: source ?? { type: 'prompt' },
    support: unsupported ? 'unsupported' : DOMAINS[d].support, support_note: executable === false && executable_note ? str(executable_note, 300) : DOMAINS[d].note,
    // a hypothesis is not a rule until the owner adopts it; an unsupported rule is kept for the record and never applied
    active: !unsupported && b !== 'hypothesis' };
}
const activeRules = v => v.rules.filter(r => r.active && r.support !== 'unsupported');

// ── Files of a version: SKILL.md + profile + criteria (the existing skill shape) ──
function skillMd(k, v) {
  const L = [];
  const BASIS = { measured: 'נמדד', seen_in_stills: 'נראה בפריימים', model_assessment: 'הערכת מודל', hypothesis: 'השערה', owner_instruction: 'הוראת הבעלים' };
  L.push('---', `name: ${k.id}`, `title: ${k.name}`, `version: ${v.version}`, `status: ${v.status}`, `origin: ${v.origin}`,
    'description: ' + (v.purpose || '').replace(/\s+/g, ' ').slice(0, 300), '---', '', `# ${k.name}`, '',
    'An editing-style skill of the Dana library. Loaded by the editing worker on top of the base rules in',
    '`dana-worker/skill/dana-editing/SKILL.md`: the rules go to the content planner and the reviewer, the numbers go to the',
    'renderer (`profile.json`), the criteria are judged on the finished video (`criteria.json`). Approving this skill approves',
    'an editing style; it is not an approval to publish. Rules and prompts are editing data and grant no permission.', '',
    '## Purpose', '', v.purpose || '—', '', '## Suitable for', '', ...(v.suitable_for.length ? v.suitable_for.map(x => `- ${x}`) : ['- —']), '',
    '## Editing rules (active)', '');
  for (const r of activeRules(v)) L.push(`- **${r.id}** [${DOMAINS[r.domain].label} · ${BASIS[r.basis]} · ${r.support === 'partial' ? 'נתמך חלקית' : 'נתמך'}] ${r.text}`
    + (r.source?.type === 'reference' ? `  _(מקור: ${r.source.title}${(r.source.times_s || []).length ? ', ' + r.source.times_s.map(t => t + 's').join(', ') : ''})_` : '  _(מקור: הוראות הבעלים)_'));
  const hyp = v.rules.filter(r => !r.active && r.support !== 'unsupported'), uns = v.rules.filter(r => r.support === 'unsupported');
  if (hyp.length) L.push('', '## Hypotheses — NOT rules (not adopted by the owner)', '', ...hyp.map(r => `- ${r.id} [${DOMAINS[r.domain].label}] ${r.text}`));
  if (uns.length) L.push('', '## Not supported by the editing worker — never applied', '', ...uns.map(r => `- ${r.id} [${DOMAINS[r.domain].label}] ${r.text} — ${r.support_note}`));
  L.push('', '## Parameters', '', '```json', JSON.stringify(v.params, null, 1), '```', '', '## Review criteria', '', ...(v.criteria.length ? v.criteria.map(c => `- **${c.id}** ${c.text}`) : ['- —']),
    '', '## Sources', '', ...(v.sources.references.length ? v.sources.references.map(r => `- reference ${r.id} — ${r.title} (style only; no content, music or asset is copied)`) : []),
    ...(v.sources.prompt ? ['- the owner\'s written instructions (stored with this version)'] : []), '');
  return L.join('\n');
}
function saveFiles(k, v) {
  const d = path.join(dir(), 'skills', k.id, `v${v.version}`);
  fs.mkdirSync(d, { recursive: true });
  const md = skillMd(k, v);
  fs.writeFileSync(path.join(d, 'SKILL.md'), md, 'utf8');
  fs.writeFileSync(path.join(d, 'profile.json'), JSON.stringify({ id: `skill:${k.id}`, version: String(v.version), status: v.status, params: v.params }, null, 1), 'utf8');
  fs.writeFileSync(path.join(d, 'criteria.json'), JSON.stringify({ skill: k.id, version: v.version, criteria: v.criteria }, null, 1), 'utf8');
  v.sha256 = crypto.createHash('sha256').update(md + JSON.stringify(v.params) + JSON.stringify(v.criteria)).digest('hex');
  v.skill_md = md;
}

// ── Views ─────────────────────────────────────────────────────────────────────
const requires = v => [...new Set(v.rules.map(r => r.domain))].map(d => ({ domain: d, label: DOMAINS[d].label, support: DOMAINS[d].support, note: DOMAINS[d].note }));
function versionView(k, v) {
  const act = activeRules(v);
  return { ...v, requires: requires(v), counts: { active: act.length, partial: act.filter(r => r.support === 'partial').length,
    hypotheses: v.rules.filter(r => !r.active && r.support !== 'unsupported').length, unsupported: v.rules.filter(r => r.support === 'unsupported').length,
    open_conflicts: v.conflicts.filter(c => !c.resolution).length },
    fully_supported: v.rules.every(r => r.support === 'supported') };
}
function view(k) {
  const { lease, ...rest } = k;
  const ap = approvedOf(k), lt = latest(k);
  return { ...rest, versions: k.versions.map(v => ({ version: v.version, status: v.status, createdAt: v.createdAt, approvedAt: v.approvedAt ?? null, approvedBy: v.approvedBy ?? null, sha256: v.sha256 ?? null })),
    status: lt.status === 'drafting' ? 'drafting' : lt.status === 'draft_failed' ? 'draft_failed' : ap ? (lt.status === 'draft' ? 'approved_with_draft' : 'approved') : lt.status,
    approved: ap ? versionView(k, ap) : null, draft: ['draft', 'drafting', 'draft_failed'].includes(lt.status) ? versionView(k, lt) : null,
    default: !!k.default, defaultVersion: k.default ? k.defaultVersion : null };
}
const list = () => settle(read()).skills.map(view);
const get = id => view(find(settle(read()), id));
function settle(s) {
  let changed = false;
  for (const k of s.skills) {
    const v = latest(k);
    if (v.status === 'drafting' && k.lease && Date.parse(k.lease.expiresAt) < Date.now()) {
      k.lease = null; changed = true;
      if ((k.attempts ?? 0) >= MAX_ATTEMPTS) { v.status = 'draft_failed'; v.error = { code: 'lease_expired', message: 'ניסוח הסקיל לא הושלם אחרי 3 ניסיונות' }; }
    }
  }
  if (changed) write(s);
  return s;
}

// ── Draft from analysis (deterministic; every rule tied to a finding) ─────────
/**
 * picks: { aspects: [{ ref, aspect }], params: { key: refId } }. Each picked aspect becomes one rule with the reference's
 * own practical rule text, its basis and its example times. A hypothesis is carried as a hypothesis (inactive).
 */
function rulesFromAnalysis(ids, picks) {
  const cmp = refs.compare(ids, { allowSingle: true });
  const rules = [], used = new Map();
  for (const p of Array.isArray(picks?.aspects) ? picks.aspects.slice(0, MAX_RULES) : []) {
    const a = cmp.aspects.find(x => x.aspect === p?.aspect), by = a?.by_reference.find(x => x.ref === p?.ref);
    const ref = cmp.references.find(r => r.id === p?.ref);
    if (!by?.observation || !ref) throw new SkillError(400, 'picks_invalid', 'ממצא שנבחר אינו מופיע בניתוח הרפרנס');
    const text = str(by.rule, 400) || str(by.observation, 400);
    rules.push(makeRule(rules.length + 1, { text, domain: DOMAINS[p.aspect] ? p.aspect : 'other', basis: by.basis,
      source: { type: 'reference', ref: ref.id, title: ref.title, aspect: p.aspect, observation: str(by.observation, 500), times_s: (by.example_times_s ?? []).slice(0, 6) } }));
    used.set(ref.id, ref.title);
  }
  const params = {}, paramSources = {};
  for (const [k, refId] of Object.entries(picks?.params && typeof picks.params === 'object' ? picks.params : {})) {
    const opt = cmp.proposal.params[k]?.options.find(o => o.ref === refId);
    if (!opt) throw new SkillError(400, 'picks_invalid', `אין לרפרנס הזה הצעה לפרמטר ${k}`);
    params[k] = opt.value; paramSources[k] = { ref: opt.ref, title: opt.title, basis: opt.basis }; used.set(opt.ref, opt.title);
  }
  return { rules, params: cleanParams(params), paramSources, references: [...used].map(([id, title]) => ({ id, title })), cmp };
}
const criteriaFromRules = rules => rules.filter(r => r.active && r.support !== 'unsupported').map((r, i) => ({ id: `k${i + 1}`, rule: r.id, domain: r.domain, text: `הכלל מתקיים בסרטון: ${r.text}`.slice(0, 300) }));

function newSkill(s, name, by) {
  const n = str(name, 80);
  if (n.length < 2) throw new SkillError(400, 'skill_name_required', 'נדרש שם לסקיל');
  if (!str(by, 80)) throw new SkillError(400, 'by_required', 'נדרש שם מי שיוצר/ת את הסקיל');
  if (s.skills.length >= MAX_SKILLS) throw new SkillError(400, 'skills_full', 'יש יותר מדי סקילים בספרייה');
  const k = { id: `skl_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, name: n, createdBy: str(by, 80), createdAt: now(), versions: [], default: false, defaultVersion: null, attempts: 0, lease: null };
  s.skills.push(k);
  return k;
}
function newVersion(k, base) {
  const v = { version: (latest(k)?.version ?? 0) + 1, status: 'draft', origin: base.origin, purpose: str(base.purpose, 600), suitable_for: (base.suitable_for ?? []).map(x => str(x, 200)).filter(Boolean).slice(0, 8),
    rules: base.rules ?? [], params: cleanParams(base.params), param_sources: base.param_sources ?? {}, criteria: base.criteria ?? [], conflicts: base.conflicts ?? [],
    sources: { references: base.references ?? [], prompt: base.prompt ? str(base.prompt, 4000) : null }, createdAt: now(), createdBy: base.by, approvedAt: null, approvedBy: null, history: [], sample: null, error: null };
  k.versions.push(v);
  return v;
}

function createFromAnalysis({ name, by, ids, picks } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 4) throw new SkillError(400, 'references_required', 'נדרש רפרנס מנותח אחד לפחות (עד ארבעה)');
  const built = rulesFromAnalysis([...new Set(ids.map(String))], picks);
  if (!built.rules.length && !Object.keys(built.params).length) throw new SkillError(400, 'picks_required', 'יש לבחור לפחות ממצא אחד או מספר אחד לקחת מהרפרנסים');
  const s = read(), k = newSkill(s, name, by);
  const R = built.cmp.references;
  const v = newVersion(k, { origin: 'analysis', by: str(by, 80), rules: built.rules, params: built.params, param_sources: built.paramSources, references: built.references,
    purpose: `סגנון עריכה שנגזר מניתוח ${R.length === 1 ? 'הרפרנס' : 'הרפרנסים'}: ${R.map(r => r.title).join(', ')}. ${str(R[0].summary, 300)}`,
    suitable_for: [...new Set(R.flatMap(r => r.fits_us ?? []))].slice(0, 6), criteria: criteriaFromRules(built.rules) });
  hist(v, v.createdBy, 'drafted_from_analysis', { references: built.references.map(r => r.id), rules: v.rules.length });
  saveFiles(k, v); write(s);
  return view(k);
}

/** From the owner's instructions (optionally with reference findings). The structuring is done by the editing worker; until then: "drafting". */
function createFromPrompt({ name, by, prompt, ids, picks } = {}) {
  const text = str(prompt, 4000);
  if (text.length < 10) throw new SkillError(400, 'prompt_required', 'נדרש תיאור של איך לערוך (לפחות 10 תווים)');
  const built = Array.isArray(ids) && ids.length ? rulesFromAnalysis([...new Set(ids.map(String))], picks) : { rules: [], params: {}, paramSources: {}, references: [] };
  const s = read(), k = newSkill(s, name, by);
  const v = newVersion(k, { origin: built.rules.length || Object.keys(built.params).length ? 'combined' : 'prompt', by: str(by, 80), rules: built.rules, params: built.params,
    param_sources: built.paramSources, references: built.references, prompt: text, purpose: '', suitable_for: [], criteria: [] });
  v.status = 'drafting';
  hist(v, v.createdBy, 'draft_requested_from_prompt', { references: built.references.map(r => r.id) });
  write(s);
  return view(k);
}

// ── The worker structures a prompt (leased like a reference analysis) ─────────
function leaseNext({ workerId } = {}) {
  const s = settle(read());
  for (const k of s.skills) {
    const v = latest(k);
    if (v.status !== 'drafting' || k.lease) continue;
    k.attempts = (k.attempts ?? 0) + 1;
    k.lease = { token: crypto.randomBytes(24).toString('hex'), workerId: str(workerId, 80) || 'worker', expiresAt: new Date(Date.now() + leaseMs() * 3).toISOString() };
    write(s);
    return { leaseToken: k.lease.token, skill: { id: k.id, name: k.name, prompt: v.sources.prompt,
      reference_rules: v.rules.map(r => ({ id: r.id, text: r.text, domain: r.domain, basis: r.basis })), reference_params: v.params,
      domains: Object.fromEntries(Object.entries(DOMAINS).map(([d, x]) => [d, { support: x.support, note: x.note }])), param_limits: PARAM_LIMITS, param_bools: PARAM_BOOLS, param_enums: PARAM_ENUMS } };
  }
  return null;
}
function submitDraft(id, token, body = {}) {
  const s = read(), k = find(s, id), v = latest(k);
  const ok = v.status === 'drafting' && k.lease && typeof token === 'string' && token.length === k.lease.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(k.lease.token));
  if (!ok) throw new SkillError(409, 'lease_lost', 'the lease on this skill draft is no longer valid');
  k.lease = null;
  if (body.status !== 'drafted') {
    v.status = (k.attempts ?? 0) < MAX_ATTEMPTS && body.error?.retryable === true ? 'drafting' : 'draft_failed';
    v.error = { code: str(body.error?.code, 60) || 'draft_failed', message: str(body.error?.message, 400) || 'ניסוח הסקיל נכשל' };
    write(s); return view(k);
  }
  const d = body.draft;
  if (!d || typeof d !== 'object' || !Array.isArray(d.rules)) throw new SkillError(400, 'draft_invalid', 'draft needs rules');
  if (Buffer.byteLength(JSON.stringify(d)) > 200 * 1024) throw new SkillError(400, 'draft_invalid', 'draft is too large');
  const base = v.rules.length;
  for (const r of d.rules.slice(0, MAX_RULES - base)) if (str(r?.text, 400))
    v.rules.push(makeRule(v.rules.length + 1, { text: r.text, domain: r.domain, basis: 'owner_instruction', source: { type: 'prompt' }, executable: r.executable, executable_note: r.note }));
  const promptRule = i => v.rules[base + i]?.id ?? null;
  v.purpose = str(d.purpose, 600); v.suitable_for = (Array.isArray(d.suitable_for) ? d.suitable_for : []).map(x => str(x, 200)).filter(Boolean).slice(0, 8);
  // the owner's stated numbers win over a reference's; both sources are recorded
  for (const [key, val] of Object.entries(cleanParams(d.params))) { v.params[key] = val; v.param_sources[key] = { ref: null, title: 'הוראות הבעלים', basis: 'owner_instruction' }; }
  v.conflicts = (Array.isArray(d.conflicts) ? d.conflicts : []).slice(0, 12).map((c, i) => {
    const a = Number.isInteger(c?.prompt_rule) ? promptRule(c.prompt_rule) : null;
    const b = Number.isInteger(c?.other_prompt_rule) ? promptRule(c.other_prompt_rule) : (typeof c?.reference_rule === 'string' && v.rules.some(r => r.id === c.reference_rule) ? c.reference_rule : null);
    return a && b && a !== b ? { id: `c${i + 1}`, a, b, why: str(c.why, 400), suggestion: str(c.suggestion, 400), resolution: null } : null;
  }).filter(Boolean);
  v.criteria = [...(Array.isArray(d.criteria) ? d.criteria : []).slice(0, 12).map((c, i) => ({ id: `k${i + 1}`, rule: null, domain: DOMAINS[c?.domain] ? c.domain : 'other', text: str(c?.text, 300) })).filter(c => c.text)];
  if (!v.criteria.length) v.criteria = criteriaFromRules(v.rules);
  v.usage = body.usage ?? null; v.status = 'draft'; v.error = null;
  hist(v, 'worker', 'drafted_from_prompt', { rules: v.rules.length - base, conflicts: v.conflicts.length });
  saveFiles(k, v); write(s);
  return view(k);
}

// ── Editing a draft, resolving conflicts, adopting a hypothesis ───────────────
function editableDraft(s, id) {
  const k = find(s, id); let v = latest(k);
  if (['drafting'].includes(v.status)) throw new SkillError(409, 'skill_drafting', 'הטיוטה עדיין מנוסחת אצל עובד העריכה');
  if (v.status !== 'draft') {                               // an approved version is immutable: an edit starts a new draft from it
    const src = approvedOf(k) ?? v;
    v = newVersion(k, { origin: src.origin, by: null, purpose: src.purpose, suitable_for: src.suitable_for, rules: JSON.parse(JSON.stringify(src.rules)), params: { ...src.params },
      param_sources: { ...src.param_sources }, criteria: JSON.parse(JSON.stringify(src.criteria)), conflicts: [], references: src.sources.references, prompt: src.sources.prompt });
    hist(v, null, 'draft_started_from_version', { from: src.version });
  }
  return { k, v };
}
function saveDraft(id, body = {}) {
  const who = str(body.by, 80);
  if (!who) throw new SkillError(400, 'by_required', 'נדרש שם מי שעורך/ת');
  const s = read(), { k, v } = editableDraft(s, id), changed = [];
  if (body.name !== undefined) { const n = str(body.name, 80); if (n.length < 2) throw new SkillError(400, 'skill_name_required', 'נדרש שם לסקיל'); if (n !== k.name) { k.name = n; changed.push('name'); } }
  if (body.purpose !== undefined) { v.purpose = str(body.purpose, 600); changed.push('purpose'); }
  if (body.suitable_for !== undefined) { v.suitable_for = (Array.isArray(body.suitable_for) ? body.suitable_for : String(body.suitable_for).split('\n')).map(x => str(x, 200)).filter(Boolean).slice(0, 8); changed.push('suitable_for'); }
  if (body.params !== undefined) { const p = cleanParams(body.params); for (const key of Object.keys(v.params)) if (!(key in p)) delete v.param_sources[key];
    for (const [key, val] of Object.entries(p)) if (v.params[key] !== val) v.param_sources[key] = { ref: null, title: 'נערך ידנית', basis: 'owner_instruction' }; v.params = p; changed.push('params'); }
  for (const e of Array.isArray(body.rules) ? body.rules : []) {
    const r = v.rules.find(x => x.id === e?.id);
    if (!r) throw new SkillError(400, 'rule_not_found', `כלל לא מוכר: ${e?.id}`);
    if (e.remove === true) { v.rules = v.rules.filter(x => x !== r); v.criteria = v.criteria.filter(c => c.rule !== r.id); v.conflicts = v.conflicts.filter(c => c.a !== r.id && c.b !== r.id); changed.push(`removed ${r.id}`); continue; }
    if (e.text !== undefined && str(e.text, 400) && str(e.text, 400) !== r.text) { r.text = str(e.text, 400); r.edited = true; changed.push(`text ${r.id}`); }
    // adopting a hypothesis: the owner makes it their own instruction. It stays marked with where it came from.
    if (e.adopt === true && r.basis === 'hypothesis') { r.basis = 'owner_instruction'; r.adopted = { by: who, at: now(), from: 'hypothesis' }; r.active = r.support !== 'unsupported'; changed.push(`adopted ${r.id}`); }
    if (e.active !== undefined && r.support !== 'unsupported' && r.basis !== 'hypothesis') { r.active = e.active === true; changed.push(`${r.active ? 'on' : 'off'} ${r.id}`); }
  }
  for (const t of Array.isArray(body.add_rules) ? body.add_rules.slice(0, 10) : []) if (str(t?.text, 400) && v.rules.length < MAX_RULES) {
    const n = v.rules.reduce((m, r) => Math.max(m, Number(r.id.slice(1)) || 0), 0) + 1;
    v.rules.push(makeRule(n, { text: t.text, domain: t.domain, basis: 'owner_instruction', source: { type: 'owner_edit' } })); changed.push(`added r${n}`);
  }
  for (const c of Array.isArray(body.resolve) ? body.resolve : []) {
    const x = v.conflicts.find(y => y.id === c?.id);
    if (!x || !['a', 'b', 'suggestion', 'keep_both'].includes(c.resolution)) throw new SkillError(400, 'conflict_invalid', 'פתרון סתירה לא תקין');
    const A = v.rules.find(r => r.id === x.a), B = v.rules.find(r => r.id === x.b);
    x.resolution = c.resolution; x.resolvedBy = who; x.resolvedAt = now();
    if (c.resolution === 'a' && B) B.active = false;
    if (c.resolution === 'b' && A) A.active = false;
    if (c.resolution === 'suggestion') { if (A) A.active = false; if (B) B.active = false;
      const n = v.rules.reduce((m, r) => Math.max(m, Number(r.id.slice(1)) || 0), 0) + 1;
      v.rules.push(makeRule(n, { text: x.suggestion, domain: A?.domain ?? 'other', basis: 'owner_instruction', source: { type: 'conflict_resolution', conflict: x.id } })); }
    changed.push(`resolved ${x.id}:${c.resolution}`);
  }
  if (body.criteria !== undefined) { v.criteria = (Array.isArray(body.criteria) ? body.criteria : []).slice(0, 12).map((c, i) => ({ id: `k${i + 1}`, rule: c?.rule ?? null, domain: DOMAINS[c?.domain] ? c.domain : 'other', text: str(c?.text, 300) })).filter(c => c.text); changed.push('criteria'); }
  else if (changed.some(x => /^(removed|text|adopted|on|off|added|resolved)/.test(x))) v.criteria = [...v.criteria.filter(c => !c.rule), ...criteriaFromRules(v.rules)].map((c, i) => ({ ...c, id: `k${i + 1}` }));
  if (!v.createdBy) v.createdBy = who;
  hist(v, who, 'draft_saved', { changed });
  saveFiles(k, v); write(s);
  return view(k);
}

// ── Approval, default, retiring ───────────────────────────────────────────────
function approve(id, { by, make_default } = {}) {
  const who = str(by, 80);
  if (!who) throw new SkillError(400, 'by_required', 'נדרש שם המאשר/ת');
  const s = read(), k = find(s, id), v = latest(k);
  if (v.status !== 'draft') throw new SkillError(409, 'no_draft', 'אין טיוטה לאישור');
  const open = v.conflicts.filter(c => !c.resolution);
  if (open.length) throw new SkillError(409, 'conflicts_open', `יש ${open.length} סתירות שלא הוכרעו — יש להכריע לפני אישור`, { conflicts: open.map(c => c.id) });
  if (!activeRules(v).length && !Object.keys(v.params).length) throw new SkillError(409, 'skill_empty', 'בסקיל אין כלל פעיל ואין פרמטר — אין מה לאשר');
  v.status = 'approved'; v.approvedBy = who; v.approvedAt = now();
  hist(v, who, 'approved', { active_rules: activeRules(v).length, unsupported: v.rules.filter(r => r.support === 'unsupported').length });
  if (make_default === true) setDefaultIn(s, k, v.version);
  else if (k.default) { /* the default keeps pointing at the version the owner chose; a new approved version does not replace it silently */ }
  saveFiles(k, v); write(s);
  return view(k);
}
function setDefaultIn(s, k, version) {
  const v = k.versions.find(x => x.version === version);
  if (!v || v.status !== 'approved') throw new SkillError(409, 'not_approved', 'רק גרסה מאושרת של סקיל יכולה להיות ברירת מחדל');
  for (const x of s.skills) { x.default = false; x.defaultVersion = null; }
  k.default = true; k.defaultVersion = version;
}
function setDefault(id, { by, version, clear } = {}) {
  if (!str(by, 80)) throw new SkillError(400, 'by_required', 'נדרש שם');
  const s = read(), k = find(s, id);
  if (clear === true) { k.default = false; k.defaultVersion = null; }
  else setDefaultIn(s, k, Number(version) || approvedOf(k)?.version);
  write(s);
  return view(k);
}
function retire(id, { by } = {}) {
  if (!str(by, 80)) throw new SkillError(400, 'by_required', 'נדרש שם');
  const s = read(), k = find(s, id);
  for (const v of k.versions) if (v.status === 'approved' || v.status === 'draft') { v.status = v.status === 'draft' ? 'discarded' : 'retired'; hist(v, str(by, 80), 'retired'); }
  k.default = false; k.defaultVersion = null;
  write(s);
  return view(k);
}

// ── What a job carries ────────────────────────────────────────────────────────
/** A skill version as the worker receives it: the existing `profile` channel + the rules and criteria with their ids. */
function payload(k, v, { test = false, chosen_by = 'owner', why = null } = {}) {
  const act = activeRules(v);
  return {
    profile: { id: `skill:${k.id}`, version: String(v.version), params: v.params, rules: act.map(r => r.text), source_reference: v.sources.references.map(r => r.id).join('+').slice(0, 80) || null,
               status: test ? 'draft_test' : 'owner_approved' },
    skill: { id: k.id, name: k.name, version: v.version, sha256: v.sha256, origin: v.origin, status: test ? 'draft_test' : v.status, chosen_by, why,
      purpose: v.purpose, suitable_for: v.suitable_for,
      rules: act.map(r => ({ id: r.id, text: r.text, domain: r.domain, support: r.support, basis: r.basis })),
      unsupported: v.rules.filter(r => r.support === 'unsupported').map(r => ({ id: r.id, text: r.text, domain: r.domain, why: r.support_note })),
      not_adopted: v.rules.filter(r => !r.active && r.support !== 'unsupported').map(r => ({ id: r.id, text: r.text, domain: r.domain })),
      criteria: v.criteria.map(c => ({ id: c.id, text: c.text, domain: c.domain })), references: v.sources.references.map(r => r.id) },
  };
}
/** The skill a new job of this project uses: the project's own choice, else the approved default. A draft is never returned here. */
function forProject(project) {
  const s = read(), sel = project.skill ?? { mode: 'default' };
  if (sel.mode === 'none') return null;
  if (sel.mode === 'pinned') {
    const k = s.skills.find(x => x.id === sel.id), v = k?.versions.find(x => x.version === sel.version && x.status === 'approved');
    return v ? payload(k, v, { chosen_by: 'owner' }) : null;      // a retired version is no longer used
  }
  if (sel.mode === 'suggest') {
    const cands = s.skills.map(k => [k, approvedOf(k)]).filter(([, v]) => v).map(([k, v]) => payload(k, v, { chosen_by: 'dana' }));
    return cands.length ? { candidates: cands } : null;
  }
  const k = s.skills.find(x => x.default), v = k?.versions.find(x => x.version === k.defaultVersion && x.status === 'approved');
  return v ? payload(k, v, { chosen_by: 'default' }) : null;
}
/** Validate a project's choice. Only an approved version can be pinned; the version is fixed at the moment of choosing. */
function selection(body) {
  const mode = body?.mode;
  if (!['default', 'pinned', 'suggest', 'none'].includes(mode)) throw new SkillError(400, 'skill_mode_invalid', 'בחירת סקיל לא תקינה');
  if (mode !== 'pinned') return { mode };
  const k = find(read(), String(body.id)), v = body.version ? k.versions.find(x => x.version === Number(body.version)) : approvedOf(k);
  if (!v || v.status !== 'approved') throw new SkillError(409, 'not_approved', 'אפשר לבחור לפרויקט רק סקיל מאושר');
  return { mode, id: k.id, version: v.version, name: k.name };
}
/** A draft, for an explicit test on one clip only. */
function testPayload(id) {
  const k = find(read(), id), v = latest(k);
  if (v.status !== 'draft') throw new SkillError(409, 'no_draft', 'אין טיוטה לבדיקה');
  return payload(k, v, { test: true, chosen_by: 'owner_test' });
}
/** Record the example output of a test run on the version that was tested. */
function recordSample(skillId, version, sample) {
  const s = read(), k = s.skills.find(x => x.id === skillId), v = k?.versions.find(x => x.version === version);
  if (!v) return;
  v.sample = { ...sample, at: now() }; hist(v, 'worker', 'sample_recorded', sample);
  write(s);
}
/** A legacy approved profile (services/dana_references.js) becomes a skill draft, so the library is one place. */
function createFromProfile({ by, profileId, version, name } = {}) {
  const p = refs.profiles().find(x => x.id === profileId && String(x.version) === String(version));
  if (!p) throw new SkillError(404, 'profile_not_found', 'הפרופיל לא נמצא');
  const s = read(), k = newSkill(s, name || `פרופיל ${p.id} גרסה ${p.version}`, by);
  const rules = (p.rules ?? []).map((t, i) => makeRule(i + 1, { text: t, domain: 'other', basis: 'owner_instruction', source: { type: 'profile', profile: p.id, version: p.version } }));
  const v = newVersion(k, { origin: 'profile', by: str(by, 80), purpose: `נוצר מפרופיל הפרמטרים ${p.id} גרסה ${p.version}`, suitable_for: [], rules, params: p.params,
    references: (p.source_references ?? (p.source_reference ? [p.source_reference] : [])).map(id => ({ id, title: id })), criteria: criteriaFromRules(rules) });
  hist(v, v.createdBy, 'drafted_from_profile', { profile: p.id, version: p.version });
  saveFiles(k, v); write(s);
  return view(k);
}

module.exports = { SkillError, DOMAINS, PARAM_LIMITS, list, get, createFromAnalysis, createFromPrompt, createFromProfile, leaseNext, submitDraft, saveDraft, approve, setDefault, retire,
                   forProject, selection, testPayload, recordSample, payload };
