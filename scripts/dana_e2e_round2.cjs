'use strict';
/**
 * dana_e2e_round2.cjs — the five owner-path checks of round 2, through the SAME HTTP API the page uses, with the REAL
 * worker and pipeline. Local only: preview server on 127.0.0.1, mocked notifications, publishing off.
 *
 *   node scripts/dana_e2e_round2.cjs <raw.mp4> <edited.mp4> <reference1.mp4> <reference2.mp4> [--keep] [--only=b,a,e,c,d]
 *
 *   b  two references → analysis and comparison → combined profile approved → used and recorded in a project
 *   a  one word corrected → verified → rendered → the corrected word is in the video
 *   e  a targeted free-text request → only that area changes
 *   c  an edited video → Dana's review → "apply improvements" → a new version with a comparison
 *   d  colour + motion graphics → real before / after material
 *
 * Every approval here is made by a TEST ACTOR in an isolated data folder. Nothing is approved in the owner's name,
 * and the notes on the references are test notes, not the owner's taste.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA || 'C:/Users/owner/dana-work/e2e-round2';
const OUT = path.join(DATA, 'evidence');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress.log'), line + '\n'); };
function check(id, name, ok, detail) { results.push({ id, name, ok: !!ok, detail: detail ?? null }); log(`   ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''}`); }

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const [raw, edited, ref1, ref2] = args.map(a => path.resolve(a));
  const only = (process.argv.find(a => a.startsWith('--only=')) || '--only=b,a,e,c,d').slice(7).split(',');
  const keep = process.argv.includes('--keep');
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || 3190;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-e2e-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', d => fs.appendFileSync(path.join(DATA, 'worker.log'), d));
  worker.stderr.on('data', d => fs.appendFileSync(path.join(DATA, 'worker.log'), d));
  const stopWorker = () => new Promise(r => { if (worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });

  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const upload = async (file, options) => { const fd = new FormData(); fd.append('video', await fs.openAsBlob(file), path.basename(file)); fd.append('options', JSON.stringify(options || {})); return api('/upload', { method: 'POST', body: fd }); };
  const project = async id => (await api('/projects/' + id)).body.project;
  const wait = async (id, timeoutS, label) => {
    const t0 = Date.now(); let last = '', phases = new Set(), percents = [];
    for (;;) {
      const p = await project(id); const pr = p.progress || {};
      if (pr.phase) phases.add(pr.phase); if (typeof pr.percent === 'number') percents.push(pr.percent);
      const line = `${p.status} · ${p.job?.status} · ${pr.phase ?? '-'} · ${pr.percent ?? '-'}%${pr.percentBasis === 'estimated' ? '~' : ''} · ${p.job?.note}`;
      if (line !== last) { log(`   ${label} [${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`); last = line; }
      if (!['queued', 'leased'].includes(p.job?.status)) return { p, phases: [...phases], percents, seconds: Math.round((Date.now() - t0) / 1000) };
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`);
      await sleep(2000);
    }
  };
  const frame = (id, n, t, name) => { const f = path.join(OUT, name);
    try { execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', path.join(DATA, 'dana', 'projects', id, `v${n}`, 'final.mp4'), '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', f]); return f; } catch (e) { return null; } };
  const copy = (id, n, art, name) => { try { fs.copyFileSync(path.join(DATA, 'dana', 'projects', id, `v${n}`, art), path.join(OUT, name)); return true; } catch { return false; } };
  const st = (await api('/status')).body;
  check('0.1', 'publishing is off and notifications are mocked', st.publishingEnabled === false && st.notifications === 'mock', { publishingEnabled: st.publishingEnabled, notifications: st.notifications });
  check('0.2', 'pilates_barre_power is listed as a connected, verified account', (st.accounts || []).some(a => a.username === 'pilates_barre_power' && a.verifiedAt));
  const summary = { base, data: DATA };

  try {
    // ── B: two references → comparison → combined profile ───────────────────
    if (only.includes('b')) {
      log('== B: two references ==');
      const ids = [];
      for (const [f, note] of [[ref1, '[הערת בדיקה, לא של הבעלים] קצב החיתוכים והכתוביות'], [ref2, '[הערת בדיקה, לא של הבעלים] הפתיחה והזומים']]) {
        const fd = new FormData(); fd.append('file', await fs.openAsBlob(f), path.basename(f));
        fd.append('title', 'בדיקה: ' + path.basename(f, path.extname(f))); fd.append('owner_note', note); fd.append('usage_permission', 'inspiration_only'); fd.append('by', ACTOR);
        const r = await api('/references', { method: 'POST', body: fd }); ids.push(r.body.reference?.id);
      }
      check('B.1', 'two reference files uploaded together, each with its own note', ids.every(Boolean), ids);
      const t0 = Date.now(); let refs;
      for (;;) { refs = (await api('/references')).body.references.filter(r => ids.includes(r.id));
        if (refs.every(r => !['awaiting_analysis', 'analysing'].includes(r.status))) break;
        if (Date.now() - t0 > 900e3) throw new Error('timeout waiting for the reference analyses'); await sleep(4000); }
      log(`   analyses finished in ${Math.round((Date.now() - t0) / 1000)}s: ${refs.map(r => r.status).join(', ')}`);
      check('B.2', 'both references were analysed', refs.every(r => r.status === 'analysed'), refs.map(r => r.analysisError?.message || r.status));
      const a = refs[0].analysis || {};
      const aspects = new Set((a.aspects || []).map(x => x.aspect));
      check('B.3', 'the analysis covers structure, cuts, zooms, captions, graphics, colour and sound', ['structure', 'cuts', 'zooms', 'captions', 'color', 'sound'].every(k => aspects.has(k)), [...aspects]);
      check('B.4', 'every aspect is labelled measured / seen in stills / model assessment / hypothesis', (a.aspects || []).every(x => ['measured', 'seen_in_stills', 'model_assessment', 'hypothesis'].includes(x.basis)),
        (a.aspects || []).map(x => `${x.aspect}:${x.basis}`));
      check('B.5', 'coverage and limits are stated (frames sampled, what was not done)', !!a.coverage && Array.isArray(a.coverage.not_done) && a.coverage.not_done.length > 0, a.coverage);
      check('B.6', 'colour and sound were measured along the whole reference', !!a.measured?.picture && !!a.measured?.sound, { picture: a.measured?.picture, sound: a.measured?.sound });
      const cmp = await post('/references/compare', { ids });
      const prop = cmp.body.comparison?.proposal;
      check('B.7', 'comparison of the two references with a proposed combined profile', cmp.status === 200 && Object.keys(prop?.params || {}).length > 0, Object.fromEntries(Object.entries(prop?.params || {}).map(([k, v]) => [k, v.options.map(o => o.value)])));
      const picks = {}; let n = 0;
      for (const [k, v] of Object.entries(prop?.params || {})) { const o = v.options.find(x => x.ref === v.suggested) || v.options[n++ % v.options.length]; picks[k] = o.ref; }
      const rules = (prop?.rules || []).slice(0, 3).map(r => ({ ref: r.ref, index: r.index }));
      const before = (await api('/status')).body.defaultProfile;
      check('B.8', 'nothing became a default before an approval', before === null, before);
      const ap = await post('/profiles/combined', { by: ACTOR, ids, picks, rules, make_default: true });
      check('B.9', 'combined profile approved (TEST ACTOR), versioned, with the source of every number', ap.status === 201 && ap.body.profile?.id === 'combined' && ap.body.profile?.version >= 1 && Object.keys(ap.body.profile?.param_sources || {}).length > 0,
        { version: ap.body.profile?.version, sources: ap.body.profile?.source_references, by: ap.body.profile?.approved_by });
      summary.references = ids; summary.profile = ap.body.profile;
      fs.writeFileSync(path.join(OUT, 'B_reference_analyses.json'), JSON.stringify(refs.map(r => ({ title: r.title, analysis: r.analysis, proposed_profile: r.proposed_profile })), null, 1));
      fs.writeFileSync(path.join(OUT, 'B_comparison.json'), JSON.stringify(cmp.body.comparison, null, 1));
    }

    // ── A: raw upload → package; then one corrected word ────────────────────
    let rawId = null, v1 = null;
    if (only.includes('a') || only.includes('e')) {
      log('== A: raw footage → edit ==');
      const up = await upload(raw, { kind: 'edit', account: 'pilates_barre_power' });
      rawId = up.body.project.id;
      check('A.1', 'raw footage uploaded; the project carries the chosen account', [200, 201].includes(up.status) && up.body.project.account === 'pilates_barre_power', { http: up.status, duplicate: up.body.duplicate });
      const w = await wait(rawId, 1500, 'raw v1'); v1 = w.p;
      check('A.2', 'package ready for viewing', v1.status === 'ready_for_review' && v1.version.hasVideo, { status: v1.status, error: v1.job?.error, seconds: w.seconds });
      check('A.3', 'progress went through the named phases; the estimate was labelled; 100% only at the end',
        ['transcribe', 'plan', 'edit', 'review'].every(k => w.phases.includes(k)) && w.percents.slice(0, -1).every(x => x < 100) && v1.progress.percent === 100, { phases: w.phases, last: v1.progress.percent });
      const pk = v1.version.package;
      if (only.includes('b')) check('B.10', 'the project was edited with the approved combined profile, and the package records it and its references',
        pk.rulesUsed?.profile?.id === 'combined' && pk.rulesUsed.profile.status === 'owner_approved' && (pk.rulesUsed.references || []).length > 0, pk.rulesUsed?.profile && { profile: pk.rulesUsed.profile, references: pk.rulesUsed.references });
      check('D.1', 'the adjustments are recorded with their measurements and can each be switched off', !!pk.adjustments?.color?.measured_before && !!pk.adjustments?.audio_cleanup && Object.keys(v1.adjustmentKinds).length === 5,
        { color: pk.adjustments?.color?.applied, audio: pk.adjustments?.audio_cleanup?.applied, animation: pk.adjustments?.caption_animation?.style, graphics: pk.adjustments?.graphics });
      check('D.2', 'before / after stills and clip exist for this version', v1.version.hasCompare && v1.version.hasCompareClip, pk.compare);
      copy(rawId, 1, 'compare_frames.jpg', 'A_v1_before_after.jpg'); copy(rawId, 1, 'compare_clip.mp4', 'A_v1_before_after_clip.mp4');
      if ((pk.graphics || []).length) {
        const g = pk.graphics[0];
        check('D.3', 'a motion graphic (HyperFrames) is in the finished video: exact quote, with a role, checked on the file',
          g.quote_is_exact && !!g.reason && pk.checks.some(c => c.id === 'graphics_rendered' && c.status === 'pass'), { text: g.text, role: g.reason, engine: pk.adjustments.graphics.engine });
        frame(rawId, 1, (g.tl_start_s + g.tl_end_s) / 2, 'D_v1_graphic_frame.jpg');
      } else check('D.3', 'a motion graphic is in the finished video', false, { note: 'the plan added no graphic in this run', not_used: pk.plan?.graphics_not_used });
      check('C.0', "Dana's review by category with a fixed rubric version is in the package", pk.danaReview?.categories?.length === 12 && !!pk.danaReview.rubric_version,
        pk.danaReview?.categories?.map(c => `${c.label}:${c.level} ${c.met}/${c.decided}`));
      summary.raw = { id: rawId, v1: { duration: pk.duration, seconds: w.seconds, checks_failed: pk.checks.filter(c => ['fail', 'review'].includes(c.status)).map(c => c.id) } };
    }
    if (only.includes('a') && v1?.version?.package) {
      log('== A: correct one word → verify → render ==');
      const pk = v1.version.package, c = pk.cards.find(x => x.text.split(' ').length >= 2 && typeof x.source_start_s === 'number');
      const words = c.text.split(' '); const oldWord = words[words.length - 1]; const newWord = oldWord.replace(/[,.]$/, '') + 'ת';   // a visible, labelled TEST change of one word
      const newText = [...words.slice(0, -1), newWord].join(' ');
      const noListen = await post(`/projects/${rawId}/captions/verify`, { source_start_s: c.source_start_s, source_end_s: c.source_end_s, original: c.text, text: newText, by: ACTOR });
      check('A.4', 'a correction cannot be verified without listening to the excerpt', noListen.status === 400 && noListen.body.error === 'listen_required', noListen.body.error);
      const vr = await post(`/projects/${rawId}/captions/verify`, { source_start_s: c.source_start_s, source_end_s: c.source_end_s, original: c.text, text: newText, by: ACTOR, listened: true });
      const stt = vr.body.project?.cardStates?.find(s => s.i === c.i);
      check('A.5', '"אמת ושמור תיקון": state is verified, before/after kept, not yet in the video, nothing rendered', vr.status === 200 && stt?.status === 'verified' && stt.original === c.text && stt.saved === newText && stt.inVideo === false
        && vr.body.project.currentVersion === 1 && vr.body.project.pendingCorrections === 1, stt);
      check('A.6', 'verifying text is not an approval to publish', vr.body.project.status !== 'approved' && vr.body.project.publication.allowed === false);
      const rv = await post(`/projects/${rawId}/revise`, { by: ACTOR });
      check('A.7', 'a new version is queued from the saved correction', rv.status === 200 && rv.body.project.currentVersion === 2, rv.body.message);
      const w2 = await wait(rawId, 1200, 'raw v2'); const p2 = w2.p, k2 = p2.version.package;
      const c2 = k2.cards.find(x => Math.abs(x.source_start_s - c.source_start_s) < 0.05);
      check('A.8', 'the corrected word is in the caption of the rendered version', p2.status === 'ready_for_review' && c2?.text === newText, { before: c.text, after: c2?.text });
      check('A.9', 'the card with the corrected word is on screen in the finished file (pixel check passed)', k2.checks.some(x => x.id === 'cards_in_motion' && x.status === 'pass'), k2.checks.find(x => x.id === 'cards_in_motion')?.summary);
      check('A.10', 'an automatic re-transcription did not overwrite the correction (kept; shown as information)', (k2.transcript?.corrections_applied || []).some(x => x.text === newText) && p2.cardStates.find(s => s.i === c2.i)?.inVideo === true,
        k2.issues.filter(i => i.code === 'owner_correction_kept').map(i => i.message));
      check('A.11', 'the original automatic transcript is still kept', fs.existsSync(path.join(DATA, 'dana', 'projects', rawId, 'v2', 'transcript_source.json')) && !JSON.stringify(JSON.parse(fs.readFileSync(path.join(DATA, 'dana', 'projects', rawId, 'v2', 'transcript_source.json'), 'utf8')).words.map(x => x.word)).includes(newWord));
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const others = k2.cards.filter(x => x !== c2).map(x => x.text), others1 = pk.cards.filter(x => x !== c).map(x => x.text);
      check('E.1', 'targeted correction: every other caption, the parts, the zooms, the cover, the graphics and the post caption are unchanged',
        k2.revisionMode === 'locked_to_previous_plan' && same(others, others1) && same(k2.plan.segments.map(s => [s.source_in_s, s.source_out_s]), pk.plan.segments.map(s => [s.source_in_s, s.source_out_s]))
        && same(k2.zooms.map(z => [z.id, z.scale]), pk.zooms.map(z => [z.id, z.scale])) && k2.cover.text === (pk.cover.text.includes(oldWord) ? k2.cover.text : pk.cover.text)
        && same((k2.graphics || []).map(g => g.kind), (pk.graphics || []).map(g => g.kind)),
        { mode: k2.revisionMode, cards: others.length, zooms: k2.zooms.length, derived: k2.derivedTextUpdates });
      frame(rawId, 1, c.start + c.dur / 2, 'A_card_before_v1.jpg'); frame(rawId, 2, c2.start + c2.dur / 2, 'A_card_after_v2.jpg');
      summary.raw.correction = { card: c.i, before: c.text, after: newText, t_s: c.start };
      v1 = p2;
    }

    // ── E: a targeted free-text request ─────────────────────────────────────
    if (only.includes('e') && v1?.version?.package) {
      log('== E: targeted free-text request ==');
      const pk = v1.version.package, n0 = v1.currentVersion;
      const rv = await post(`/projects/${rawId}/revise`, { by: ACTOR, note: 'תקטיני קצת את הכתוביות, ובלי זומים בכלל. את כל השאר להשאיר כמו שהוא.', note_scope: 'project' });
      check('E.2', 'a free-text request is accepted as a project-only correction (not a standing rule)', rv.status === 200 && (await api('/rules')).body.rules.filter(r => r.status === 'active').length === 0, rv.body.message);
      const w3 = await wait(rawId, 1200, `raw v${n0 + 1}`); const p3 = w3.p, k3 = p3.version.package, ri = k3.requestInterpretation;
      check('E.3', 'the request was read as caption style + zooms only, with no re-plan', p3.status === 'ready_for_review' && ri?.mode === 'targeted' && !ri.needs_replan && ri.domains.every(d => ['caption_style', 'zooms'].includes(d)), ri && { domains: ri.domains, explanation: ri.explanation });
      check('E.4', 'what was asked changed: smaller captions, no zooms', k3.style.caption_size < pk.style.caption_size && k3.zooms.length === 0, { size: [pk.style.caption_size, k3.style.caption_size], zooms: [pk.zooms.length, k3.zooms.length] });
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      check('E.5', 'what was not asked did not change: parts, message, caption words, cover text, post caption, graphics, earlier correction',
        same(k3.plan.segments.map(s => [s.source_in_s, s.source_out_s]), pk.plan.segments.map(s => [s.source_in_s, s.source_out_s])) && k3.plan.message === pk.plan.message
        && same(k3.cards.map(c => c.text).join(' '), pk.cards.map(c => c.text).join(' ')) && k3.cover.text === pk.cover.text && p3.version.caption.text === v1.version.caption.text
        && same((k3.graphics || []).map(g => g.text), (pk.graphics || []).map(g => g.text)),
        { segments: k3.plan.segments.length, cover: k3.cover.text, graphics: (k3.graphics || []).map(g => g.text) });
      check('E.6', 'the earlier version is kept for comparison and the approval state was reset', p3.versions.length === n0 + 1 && p3.versions.every(x => x.hasVideo) && !p3.version.approval);
      frame(rawId, n0 + 1, 3, 'E_after_request.jpg');
      summary.raw.request = { version: n0 + 1, interpretation: ri };
    }

    // ── C / D: an edited video → review → apply improvements ────────────────
    for (const [key, file, label] of [['c', edited, 'C'], ['d', ref1, 'D']]) {
      if (!only.includes(key)) continue;
      log(`== ${label}: edited video → Dana's review → apply improvements ==`);
      const up = await upload(file, { kind: 'review_only' });
      const id = up.body.project.id;
      check(`${label}.1`, 'an edited video is submitted for review only', [200, 201].includes(up.status) && up.body.project.kind === 'review_only', { duplicate: up.body.duplicate });
      const w = await wait(id, 900, `${label} review`); const p = w.p, pk = p.version?.package;
      check(`${label}.2`, "Dana's review is ready; the uploaded file itself is the video (nothing was edited)", p.status === 'reviewed' && p.version.hasVideo && p.version.kind === 'review_only', { status: p.status, error: p.job?.error, seconds: w.seconds });
      if (!pk) continue;
      const rv = pk.danaReview;
      check(`${label}.3`, 'rating by category from fixed criteria; unchecked items are marked not checked, with no invented mark',
        rv?.categories?.length === 12 && rv.categories.every(c => c.decided > 0 || c.level === 'לא נבדק') && rv.categories.flatMap(c => c.criteria).some(c => c.status === 'not_checked'),
        rv?.categories?.map(c => `${c.label}:${c.level} ${c.met}/${c.decided}(${c.not_checked} לא נבדקו)`));
      check(`${label}.4`, 'improvements are ordered by importance and split into technical defect / creative preference', (rv?.improvements || []).every((x, i, a) => !i || a[i - 1].importance <= x.importance), (rv?.improvements || []).map(x => `${x.importance}:${x.kind}:${x.can_apply ? 'דנה' : 'בעלים'}`));
      check(`${label}.5`, 'burned-in captions were looked for, and Dana does not promise to fix them', pk.burnedInText?.present !== undefined, { burned: pk.burnedInText?.present, can_apply: (pk.danaCanApply || []).map(x => x.id) });
      fs.writeFileSync(path.join(OUT, `${label}_review_v1.json`), JSON.stringify({ review: rv, can_apply: pk.danaCanApply, measured: pk.measured, burned: pk.burnedInText }, null, 1));
      const ap = await post(`/projects/${id}/apply-review`, { by: ACTOR });
      if (ap.status !== 200) { check(`${label}.6`, '"יישם שיפורים והפק גרסה חדשה" produces a new version', ap.body.error === 'nothing_to_apply' ? null : false, ap.body.message); results[results.length - 1].note = 'no improvement Dana can apply to this file'; continue; }
      const w2 = await wait(id, 1200, `${label} v2`); const p2 = w2.p, k2 = p2.version.package;
      check(`${label}.6`, '"יישם שיפורים והפק גרסה חדשה" produced version 2', p2.status === 'ready_for_review' && p2.currentVersion === 2 && p2.version.hasVideo, { status: p2.status, error: p2.job?.error, seconds: w2.seconds });
      if (!k2) continue;
      check(`${label}.7`, "the owner's edit was kept: one part, the whole file, no zoom, no new graphic; no second caption layer over burned captions",
        k2.revisionMode === 'polish' && k2.plan.segments.length === 1 && k2.zooms.length === 0 && (k2.graphics || []).length === 0 && (pk.burnedInText.present ? k2.style.captions_enabled === false : true),
        { mode: k2.revisionMode, duration: [pk.duration, k2.duration], captions_layer: k2.style.captions_enabled });
      check(`${label}.8`, 'both versions are kept and can be compared, with the same review rubric', p2.versions.length === 2 && p2.versions.every(x => x.hasVideo) && k2.danaReview?.rubric_version === rv.rubric_version,
        k2.danaReview?.categories?.map(c => `${c.label}:${c.level}`));
      check(`${label}.9`, 'before / after stills and clip exist', p2.version.hasCompare && p2.version.hasCompareClip, k2.compare);
      const col = k2.adjustments.color, aud = k2.adjustments.audio_cleanup;
      log(`   colour: applied=${col.applied} ${JSON.stringify(col.params)} · ${col.skin_guard} | sound: applied=${aud.applied} ${JSON.stringify(aud.params)} · ${aud.speech_guard}`);
      if (label === 'D') check('D.4', 'a real colour correction was applied from the measurement, with skin tone inside its limits', col.applied === true && Object.keys(col.params).length > 0 && /גוון עור/.test(col.skin_guard || ''),
        { params: col.params, decisions: col.decisions, skin: col.skin_guard, before: col.measured_before?.face, after: col.measured_after?.face });
      copy(id, 2, 'compare_frames.jpg', `${label}_v2_before_after.jpg`); copy(id, 2, 'compare_clip.mp4', `${label}_v2_before_after_clip.mp4`);
      fs.writeFileSync(path.join(OUT, `${label}_v2_adjustments.json`), JSON.stringify({ adjustments: k2.adjustments, review: k2.danaReview.categories.map(c => ({ label: c.label, level: c.level, met: c.met, decided: c.decided })) }, null, 1));
      summary[label] = { id, color: { applied: col.applied, params: col.params }, sound: { applied: aud.applied, params: aud.params } };
    }
  } catch (e) { check('X', 'the run finished without an exception', false, e.message); }
  finally {
    await stopWorker();
    const fails = results.filter(r => r.ok === false);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 1));
    log(`\n${results.filter(r => r.ok).length} passed, ${fails.length} failed of ${results.length}. evidence: ${OUT}`);
    for (const f of fails) log(`   FAILED ${f.id} ${f.name}`);
    process.exitCode = fails.length ? 1 : 0;
    if (keep) log(`preview server left running on ${base} (worker stopped)`);
    else { server.close(); setTimeout(() => process.exit(process.exitCode), 300); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
