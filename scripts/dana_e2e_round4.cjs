'use strict';
/**
 * dana_e2e_round4.cjs — acceptance of round 4, through the page's own HTTP API with the REAL worker.
 * Local only: preview server on 127.0.0.1, mocked notifications, publishing off.
 *
 *   node scripts/dana_e2e_round4.cjs <raw-clip.mp4> <new-example-video.mp4> [--keep]
 *
 * Needs a data folder (DANA_PREVIEW_DATA) that already holds at least one ANALYSED reference (its analysis is reused).
 *
 *   a  brief + a NEW example video → analysis (once) → skill draft → TEST approval → used on another clip
 *   b  that skill + a saved reference analysis → comparison of rules → a new version; the old one is kept
 *   c  a combination of skills → footage, an overlay graphic and an animation scene, in the plan and in the video
 *   d  the same source → a reel output and a story output
 *   e  a separate final review for every output, by skill versions, with evidence and limits
 *
 * Every approval here is made by a TEST ACTOR. No skill, style or video is approved in the owner's name.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA || 'C:/Users/owner/dana-work/e2e-round4';
const OUT = path.join(DATA, 'evidence');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress.log'), line + '\n'); };
function check(id, name, ok, detail) { results.push({ id, name, ok: !!ok, detail: detail ?? null }); log(`   ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 460) : ''}`); }
const save = (name, obj) => fs.writeFileSync(path.join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));

async function main() {
  const [clip, example] = process.argv.slice(2).filter(a => !a.startsWith('--')).map(a => path.resolve(a));
  if (!clip || !example) throw new Error('usage: dana_e2e_round4.cjs <raw-clip.mp4> <new-example-video.mp4>');
  const keep = process.argv.includes('--keep');
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || 3195;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-e2e-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const st of [worker.stdout, worker.stderr]) st.on('data', d => fs.appendFileSync(path.join(DATA, 'worker.log'), d));
  const stopWorker = () => new Promise(r => { if (worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const send = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const project = async id => (await api('/projects/' + id)).body.project;
  const skill = async id => (await api('/skills/' + id)).body.skill;
  const wait = async (id, timeoutS, label) => { const t0 = Date.now(); let last = '';
    for (;;) { const p = await project(id); const line = `${p.status} · ${p.job?.status} · ${p.job?.note}`;
      if (line !== last) { log(`   ${label} [${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
      if (!['queued', 'leased'].includes(p.job?.status)) return { p, seconds: Math.round((Date.now() - t0) / 1000) };
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`); await sleep(3000); } };
  const waitSkill = async (id, timeoutS, label) => { const t0 = Date.now(); let last = '';
    for (;;) { const k = await skill(id); if (k.status !== last) { log(`   ${label} [${Math.round((Date.now() - t0) / 1000)}s] ${k.status}`); last = k.status; }
      if (!['drafting', 'waiting_analysis'].includes(k.status)) return k;
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`); await sleep(3000); } };
  const vdir = (id, n) => path.join(DATA, 'dana', 'projects', id, `v${n}`);
  const pkgOf = (id, n) => JSON.parse(fs.readFileSync(path.join(vdir(id, n), 'package.json'), 'utf8'));
  const copy = (id, n, art, name) => { try { fs.copyFileSync(path.join(vdir(id, n), art), path.join(OUT, name)); return true; } catch { return false; } };
  const probe = f => { const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', f], { encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return null; } };
  const summary = { base, data: DATA, actor: ACTOR };
  const done = p => !!p.version?.package && !['queued', 'leased', 'failed'].includes(p.job?.status) && p.status !== 'failed';
  // the machine must not go to sleep in the middle of a run (it did once); held only while this script runs
  const awake = spawn('powershell', ['-NoProfile', '-Command', "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; while (1) { [W.P]::SetThreadExecutionState(2147483649) | Out-Null; Start-Sleep 30 }"], { stdio: 'ignore' });

  try {
    const st = (await api('/status')).body;
    check('0.1', 'publishing is off and notifications are mocked', st.publishingEnabled === false && st.notifications === 'mock');
    await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 30000) { const w = (await api('/status')).body.worker; if (w.online && w.capabilities) return; await sleep(1000); } })();
    const caps = (await api('/status')).body.worker.capabilities;
    check('0.2', 'the worker reports what it can really do on this machine', !!caps && typeof caps.hyperframes === 'boolean', caps);
    const saved = (await api('/references')).body.references.filter(r => r.analysis);
    if (!saved.length) throw new Error('the data folder needs an analysed reference');

    // ── A: brief + a NEW example video → analysis → draft → TEST approval ──
    log('== A: a skill from a brief together with an example video ==');
    const fd = new FormData(); fd.append('file', await fs.openAsBlob(example), path.basename(example));
    fd.append('title', 'בדיקה: סרטון דוגמה חדש'); fd.append('owner_note', 'הפתיחה והכתוביות'); fd.append('usage_permission', 'inspiration_only'); fd.append('by', ACTOR);
    const upRef = await api('/references', { method: 'POST', body: fd }), newRef = upRef.body.reference?.id;
    const BRIEF = { by: ACTOR, name: 'בדיקה: עדות אישית (הוראות + סרטון דוגמה)', goal: 'עדות של מתאמנת שמרגישה אישית ולא פרסומית',
      prompt: 'לפתוח ישר במשפט החזק של הדוברת, בלי הקדמות. לשמור על קצב רגוע ולחתוך שתיקות ארוכות. הכתוביות קריאות וגדולות.',
      must: ['כתוביות בשורה אחת בלבד', 'בלי מוזיקת רקע'], open: ['איפה לשים זום', 'איזה משפט להדגיש'], avoid: 'לא לקחת מהסרטון את המוזיקה, הלוגו או הטקסטים שלו',
      ids: [newRef], take: { [newRef]: 'את צורת הפתיחה ואת סגנון הכתוביות' } };
    const made = await send('/skills/from-prompt', BRIEF), A = made.body.skill?.id;
    check('A.1', 'a brief with a NEW example video: the draft waits for the analysis of that video (it is analysed once)', made.status === 201 && made.body.skill.status === 'waiting_analysis', made.body.skill?.status ?? made.body);
    let kA = await waitSkill(A, 900, 'skill A (analysis + draft)');
    const refNow = (await api('/references')).body.references.find(r => r.id === newRef);
    check('A.2', 'the example video was analysed and the draft was written by the worker from the brief and the analysis', kA.status === 'draft' && !!refNow.analysis, { status: kA.status, error: kA.draft?.error, aspects: refNow.analysis?.aspects?.length });
    const d = kA.draft, src = t => d.rules.filter(r => r.source.type === t);
    save('A_draft.json', d);
    check('A.3', 'every rule has a source: my instruction / a finding of the reference with its time / a suggestion of Dana', d.rules.length >= 3 && d.rules.every(r => ['prompt', 'reference', 'dana'].includes(r.source.type)) && src('prompt').length >= 2,
      { owner: src('prompt').length, reference: src('reference').length, dana: src('dana').length });
    check('A.4', 'a reference rule is tied to the stored finding (aspect, observation, times); its basis is the analysis basis, not the model\'s word', src('reference').every(r => r.source.ref === newRef && r.source.aspect && r.source.observation && ['measured', 'seen_in_stills', 'model_assessment', 'hypothesis'].includes(r.basis)),
      src('reference').slice(0, 4).map(r => ({ aspect: r.source.aspect, basis: r.basis, times: r.source.times_s, active: r.active })));
    check('A.5', 'a suggestion of Dana and a hypothesis are NOT active rules until adopted', d.rules.filter(r => ['dana_suggestion', 'hypothesis'].includes(r.basis)).every(r => !r.active), d.rules.map(r => `${r.domain}:${r.basis}:${r.active ? 'on' : 'off'}`));
    const must = d.rules.filter(r => r.mandatory);
    check('A.6', 'the mandatory instructions are kept as written and marked mandatory', must.length >= 1 && must.every(r => r.source.type === 'prompt'), must.map(r => r.text));
    check('A.7', 'conflicts between an instruction and the example are shown; an explicit instruction wins, openly', d.conflicts.every(c => c.resolution || !c.auto) && d.conflicts.filter(c => c.auto).every(c => c.resolvedBy === 'owner_instruction_wins'),
      { conflicts: d.conflicts.map(c => ({ why: c.why, resolution: c.resolution, auto: !!c.auto })), uncertain: d.uncertain, coverage_gaps: d.coverage_gaps });
    check('A.8', 'uncertainty and missing coverage are stated before approval (lists exist; "music" is marked unsupported if it became a rule)', Array.isArray(d.uncertain) && Array.isArray(d.coverage_gaps) && d.rules.filter(r => r.domain === 'music').every(r => !r.active),
      { uncertain: d.uncertain.length, coverage_gaps: d.coverage_gaps.length, unsupported: d.rules.filter(r => r.support === 'unsupported').map(r => r.text) });
    // open conflicts (not involving an owner instruction) are decided by the TEST actor so the flow can continue; it is recorded
    const open = d.conflicts.filter(c => !c.resolution);
    if (open.length) await send(`/skills/${A}`, { by: ACTOR, resolve: open.map(c => ({ id: c.id, resolution: 'a' })) }, 'PUT');
    const apA = await send(`/skills/${A}/approve`, { by: ACTOR });
    check('A.9', 'TEST approval (not the owner): version 1 approved, saved as SKILL.md + profile.json + criteria.json', apA.body.skill?.status === 'approved' && apA.body.skill.approved.approvedBy === ACTOR
      && ['SKILL.md', 'profile.json', 'criteria.json'].every(f => fs.existsSync(path.join(DATA, 'dana', 'skills', A, 'v1', f))), { by: apA.body.skill?.approved?.approvedBy, error: apA.body.error, open: open.length });
    save('A_SKILL_v1.md', apA.body.skill?.approved?.skill_md ?? '');
    const a1 = apA.body.skill.approved;

    // ── a second skill: motion graphics + an animation scene (brief only) ──
    log('== G: a graphics / animation skill from a brief only ==');
    const g0 = await send('/skills/from-prompt', { by: ACTOR, name: 'בדיקה: גרפיקה ואנימציה', goal: 'להדגיש את המשפט המרכזי בצורה ויזואלית',
      prompt: 'כותרת פתיחה מונפשת מעל הצילום בתחילת הסרטון. קטע אנימציה אחד במסך מלא של המשפט המרכזי שהדוברת אומרת, שמחליף את הצילום לכמה שניות בזמן שהקול ממשיך.',
      must: ['קטע אנימציה אחד במסך מלא על המשפט המרכזי', 'כותרת פתיחה מונפשת מעל הצילום'] }), G = g0.body.skill?.id;
    check('G.1', 'a brief alone (no video) goes straight to drafting', g0.body.skill?.status === 'drafting', g0.body.skill?.status ?? g0.body);
    const kG = await waitSkill(G, 400, 'skill G (draft)');
    const dg = kG.draft, og = dg.conflicts.filter(c => !c.resolution);
    if (og.length) await send(`/skills/${G}`, { by: ACTOR, resolve: og.map(c => ({ id: c.id, resolution: 'a' })) }, 'PUT');
    const anim = dg.rules.filter(r => r.domain === 'animation'), mg = dg.rules.filter(r => r.domain === 'motion_graphics');
    check('G.2', 'the animation scene and the overlay graphic are two different areas of the skill; the scene is marked as partly supported (typography only)', anim.length >= 1 && mg.length >= 1 && anim.every(r => r.support !== 'unsupported'),
      dg.rules.map(r => `${r.domain}:${r.support}:${r.active ? 'on' : 'off'} ${r.text.slice(0, 50)}`));
    const apG = await send(`/skills/${G}/approve`, { by: ACTOR });
    check('G.3', 'TEST approval of the graphics skill', apG.body.skill?.status === 'approved', apG.body.error ?? apG.body.skill?.kinds);

    // ── C + D: the combination as the default, one source, two outputs ─────
    log('== C + D: the combination on one source → a reel and a story ==');
    let ds = await send('/skills/default-set', { by: ACTOR, ids: [A, G] });
    const setConf = ds.body.conflicts ?? [];
    if (ds.body.error === 'skill_conflicts') ds = await send('/skills/default-set', { by: ACTOR, ids: [A, G], confirm_conflicts: true });
    const defs = (await api('/skills')).body.skills.filter(k => k.default).sort((x, y) => x.defaultOrder - y.defaultOrder);
    check('C.1', 'the combination is the approved default, in priority order; a contradiction between the skills is shown before use', defs.map(k => k.id).join() === [A, G].join(), { order: defs.map(k => k.name), conflicts: setConf.map(c => `${c.kind}:${c.key}`) });
    const fu = new FormData(); fu.append('video', await fs.openAsBlob(clip), path.basename(clip)); fu.append('options', JSON.stringify({ target: 'both' }));
    const up = await api('/upload', { method: 'POST', body: fu });
    const both = (await api('/projects')).body.projects.filter(p => p.groupId), reelP = both.find(p => p.target === 'reel'), storyP = both.find(p => p.target === 'story');
    check('D.1', '"שתי גרסאות": one source file, two separate outputs (a reel project and a story project)', up.status < 300 && !!reelP && !!storyP && reelP.id !== storyP.id, both.map(p => `${p.targetLabel}:${p.id}`));
    const r1 = await wait(reelP.id, 1500, 'reel v1');
    const s1 = await wait(storyP.id, 1500, 'story v1');
    summary.reel = { id: reelP.id, seconds: r1.seconds, status: r1.p.status }; summary.story = { id: storyP.id, seconds: s1.seconds, status: s1.p.status };
    check('C.2', 'the reel was produced', !!r1.p.version?.package && done(r1.p), { status: r1.p.status, job: r1.p.job?.status, note: r1.p.job?.note, error: r1.p.job?.error });
    check('D.2', 'the story was produced', !!s1.p.version?.package && done(s1.p), { status: s1.p.status, job: s1.p.job?.status, note: s1.p.job?.note, error: s1.p.job?.error });
    const R = pkgOf(reelP.id, 1), S = pkgOf(storyP.id, 1);
    copy(reelP.id, 1, 'final.mp4', 'reel_v1.mp4'); copy(storyP.id, 1, 'final.mp4', 'story_v1.mp4'); copy(reelP.id, 1, 'cover.jpg', 'reel_v1_cover.jpg');
    save('reel_v1_package.json', R); save('story_v1_package.json', S);

    // C: the skills in the plan and in the video
    const used = R.skill_report?.skill?.skills ?? [];
    check('C.3', 'the package stores the skills, their versions and every rule with what happened to it', used.map(k => k.id).join() === [A, G].join() && used.every(k => k.version === 1) && (R.skill_report.rules ?? []).length > 0,
      { skills: used.map(k => `${k.name} v${k.version}`), summary: R.skill_report?.summary });
    check('C.4', 'ONE edit plan: every rule is reported under the skill it belongs to', new Set((R.skill_report.rules ?? []).map(r => r.skill)).size === 2, (R.skill_report.rules ?? []).map(r => `${r.skill.slice(0, 18)}|${r.status}|${r.text.slice(0, 40)}`));
    const gfx = R.graphics ?? [], over = gfx.filter(g => g.layer === 'over_picture'), scenes = gfx.filter(g => g.layer === 'replaces_picture');
    check('C.5', 'in the plan: a graphic OVER the footage and an animation scene that REPLACES it are separate items, each an exact quote', over.length >= 1 && scenes.length >= 1 && gfx.every(g => g.quote_is_exact),
      gfx.map(g => `${g.kind}|${g.layer}|${g.tl_start_s}-${g.tl_end_s}|${g.text}`));
    const recs = R.checks ?? [], rec = id => recs.find(c => c.id === id);
    check('C.6', 'in the video: measured on the final file — the overlay is rendered, and during the scene the picture is the scene and not the footage', rec('graphics_rendered')?.status === 'pass' && rec('animation_scene_rendered')?.status === 'pass',
      { overlay: rec('graphics_rendered')?.summary, scene: rec('animation_scene_rendered')?.summary });
    const tl = R.timeline, kinds = (tl?.spans ?? []).map(x => x.picture);
    check('C.7', 'the timeline: every stretch has picture, responsible skill, length, text, sound, assets and transition; footage and scene alternate', kinds.includes('footage') && kinds.includes('animation_scene')
      && tl.spans.every(x => x.skill && x.audio && x.assets && x.transition_in && typeof x.seconds === 'number') && Math.abs(tl.spans.reduce((n, x) => n + x.seconds, 0) - R.duration) < 0.2,
      (tl?.spans ?? []).map(x => `${x.t0}-${x.t1} ${x.picture} [${x.skill}]`));
    save('reel_v1_timeline.json', tl ?? {});
    if (scenes[0]) { const t = ((scenes[0].tl_start_s + scenes[0].tl_end_s) / 2).toFixed(2);
      spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', t, '-i', path.join(OUT, 'reel_v1.mp4'), '-frames:v', '1', path.join(OUT, 'reel_v1_scene_frame.jpg')]);
      if (over[0]) spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', ((over[0].tl_start_s + over[0].tl_end_s) / 2).toFixed(2), '-i', path.join(OUT, 'reel_v1.mp4'), '-frames:v', '1', path.join(OUT, 'reel_v1_overlay_frame.jpg')]); }
    check('C.8', 'what is NOT supported is said: an illustrative animation is listed as missing, the scene as typography only', /טיפוגרפיה/.test(JSON.stringify(R.adjustments?.animation ?? {})), R.adjustments?.animation);

    // D: what the target really changed
    const sd = (S.plan?.segments ?? []).map(g => +(g.tl_out_s - g.tl_in_s).toFixed(1));
    check('D.3', 'structure and length differ: the story is up to 4 cards of at most 15 s; the reel is one continuous video', S.target?.key === 'story' && R.target?.key === 'reel' && sd.length >= 1 && sd.length <= 4 && sd.every(x => x <= 15.3) && S.duration <= 60.5,
      { story_cards_s: sd, story_total_s: S.duration, reel_parts: (R.plan?.segments ?? []).length, reel_total_s: R.duration });
    check('D.4', 'safe zone differs and is recorded in each package', JSON.stringify(S.target?.safe_zone) !== JSON.stringify(R.target?.safe_zone), { story: S.target?.safe_zone, reel: R.target?.safe_zone });
    check('D.5', 'cover and caption differ: the reel has a cover text and a post caption draft; the story has neither', S.target?.cover_text === false && S.target?.post_caption === false && R.target?.cover_text === true,
      { story_cover_text: S.cover?.text ?? null, story_caption: S.caption?.text ?? null, reel_cover_text: R.cover?.text ?? null });
    const parts = s1.p.version.storyParts ?? [];
    const pd = parts.map(n => Number(probe(path.join(vdir(storyP.id, 1), n))?.format?.duration ?? 0));
    parts.forEach((n, i) => copy(storyP.id, 1, n, `story_v1_part_${i + 1}.mp4`));
    check('D.6', 'the story is also delivered as a separate file per card, cut from the reviewed final file', parts.length === sd.length && pd.every((x, i) => Math.abs(x - sd[i]) < 0.6), { files: parts, seconds: pd });
    check('D.7', 'producing is not publishing: story publishing is stated as not tested, nothing was approved or published', /לא נבדק/.test(S.target?.publish ?? '') && s1.p.status !== 'approved' && r1.p.status !== 'approved' && (await api('/status')).body.publishingEnabled === false, S.target?.publish);
    check('D.8', 'each output has its own versions: the two projects share only the source', r1.p.siblings?.[0]?.id === storyP.id && s1.p.siblings?.[0]?.id === reelP.id && r1.p.source.sha256 === s1.p.source.sha256);

    // ── E: a separate final review per output ──────────────────────────────
    log('== E: the final review of each output ==');
    for (const [tag, P, id] of [['reel', R, reelP.id], ['story', S, storyP.id]]) {
      const f = P.final_review ?? {}; save(`${tag}_v1_final_review.json`, f);
      check(`E.${tag}.1`, `${tag}: a final review of the delivered file of this version (sha, time, rounds)`, f.on_delivered_file === true && f.file_sha256 === P.review_provenance?.final_sha256 && !!f.reviewed_at && f.target === tag,
        { verdict: f.verdict, text: f.verdict_text, rounds: f.rounds, at: f.reviewed_at });
      check(`E.${tag}.2`, `${tag}: by the review skill and each library skill, with versions`, (f.skills ?? []).some(k => k.name === 'dana-review') && [A, G].every(x => (f.skills ?? []).some(k => k.id === x && k.version === 1)), (f.skills ?? []).map(k => `${k.name} v${k.version} (${k.role})`));
      const c = f.coverage ?? {};
      check(`E.${tag}.3`, `${tag}: the summary counts only what was checked, by kind of evidence; human-only criteria carry no mark`, c.decided + c.not_checked + c.not_applicable === c.criteria && (c.human_only ?? []).length >= 1 && (f.not_checked ?? []).length >= 1,
        { criteria: c.criteria, decided: c.decided, measured: c.measured, frames: c.frames, model: c.model, human_only: (c.human_only ?? []).length });
      check(`E.${tag}.4`, `${tag}: what worked / what needs improvement (with evidence) / what was not checked / limits`, Array.isArray(f.worked) && f.worked.length > 0 && Array.isArray(f.needs_improvement) && f.needs_improvement.every(x => x.criterion && x.basis) && (f.limits ?? []).length > 0,
        { worked: f.worked?.length, needs: (f.needs_improvement ?? []).slice(0, 3).map(x => `${x.category}: ${x.criterion.slice(0, 50)} [${x.basis}] ${isFinite(x.time_s) ? x.time_s + 's' : ''}`), not_checked: f.not_checked?.length });
      check(`E.${tag}.5`, `${tag}: the verdict is a statement about checks and open items, never a score, and never an approval`, ['ready_for_viewing', 'needs_owner', 'needs_fix'].includes(f.verdict) && /לא לפי הדירוג לבדו/.test(f.verdict_basis ?? '') && (await project(id)).status !== 'approved', f.verdict_reasons);
      check(`E.${tag}.6`, `${tag}: compliance with the skill rules is reported`, !!f.skill_compliance?.summary, f.skill_compliance?.summary);
    }

    // ── C.9: remove ONE thing; the rest stays; the previous review no longer stands ──
    log('== C.9: remove only the animation scene from the reel ==');
    if (scenes[0]) {
      const rv = await send(`/projects/${reelP.id}/revise`, { by: ACTOR, graphic_edits: [{ id: scenes[0].id, action: 'remove' }] });
      const mid = rv.body.project;
      check('C.9', 'removing one item queues a new version; the previous version stays on screen and its review is marked as not current', rv.status === 200 && mid.currentVersion === 2 && mid.shown?.n === 1 && mid.review?.upToDate === false, mid?.review?.stale ?? rv.body);
      const r2 = await wait(reelP.id, 1200, 'reel v2');
      const R2 = pkgOf(reelP.id, 2); copy(reelP.id, 2, 'final.mp4', 'reel_v2_without_scene.mp4'); save('reel_v2_package.json', R2); save('reel_v2_final_review.json', R2.final_review ?? {});
      const seg = P => JSON.stringify((P.plan?.segments ?? []).map(g => [g.source_in_s, g.source_out_s])), txt = P => JSON.stringify((P.cards ?? []).map(c => c.text));
      check('C.10', 'only that item changed: the scene is gone; the cut, the captions and the overlay graphic are the same', (R2.graphics ?? []).every(g => g.layer !== 'replaces_picture') && seg(R2) === seg(R) && txt(R2) === txt(R)
        && JSON.stringify((R2.graphics ?? []).map(g => g.id)) === JSON.stringify(over.map(g => g.id)), { graphics: (R2.graphics ?? []).map(g => g.id), same_cut: seg(R2) === seg(R), same_captions: txt(R2) === txt(R), seconds: r2.seconds });
      check('C.11', 'version 1 is kept, nothing is approved, and the new file has its own final review that explains what changed against version 1', fs.existsSync(path.join(vdir(reelP.id, 1), 'final.mp4')) && r2.p.status !== 'approved'
        && R2.final_review?.file_sha256 !== R.final_review?.file_sha256 && R2.final_review?.changes !== undefined, { changes: R2.final_review?.changes?.criteria?.map(c => `${c.criterion.slice(0, 40)}: ${c.before}→${c.after} [${c.basis}]`), note: R2.final_review?.changes?.note });
      summary.reel.v2_seconds = r2.seconds;
    } else check('C.9', 'removing one item (skipped: no animation scene was produced)', false);

    // ── B: upgrade skill A with a SAVED reference analysis ─────────────────
    log('== B: upgrade the skill with a saved reference ==');
    const ref0 = saved[0], leasesBefore = (await api('/references')).body.references.find(r => r.id === ref0.id)?.analysedAt ?? null;
    const u = await send(`/skills/${A}/upgrade`, { by: ACTOR, ids: [ref0.id], prompt: 'לשפר רק את סגנון הכתוביות וההדגשות לפי הרפרנס הזה. לא לשנות את כללי הפתיחה והקצב.' });
    check('B.1', '"שדרג סקיל באמצעות רפרנס": a draft of the next version is requested; the saved analysis is reused (not analysed again)', u.status === 201 && u.body.skill.status === 'drafting' && u.body.skill.defaultVersion === 1, u.body.skill?.status ?? u.body);
    const kU = await waitSkill(A, 400, 'skill A upgrade'), dv = kU.draft, diff = dv?.upgrade?.diff;
    save('B_upgrade_diff.json', diff ?? {});
    check('B.2', 'the comparison: what was kept, added, changed (and why)', kU.status === 'approved_with_draft' && !!diff && diff.kept.length >= 1 && (diff.added.length + diff.changed.length + diff.params.length) >= 1
      && [...diff.added, ...diff.changed, ...diff.params].every(x => x.why), diff && { summary: diff.summary, kept: diff.kept.length, added: diff.added.map(x => x.text), changed: diff.changed.map(x => `${x.before} → ${x.after}`), removed: diff.removed.length, params: diff.params, ignored: diff.ignored });
    check('B.3', 'a targeted change, not a replacement: the untouched rules are carried over word for word; mandatory instructions are still there', diff && diff.large_change === false && diff.kept.every(x => a1.rules.find(r => r.id === x.id)?.text === x.text)
      && a1.rules.filter(r => r.mandatory).every(r => dv.rules.some(x => x.id === r.id)), { large_change: diff?.large_change });
    check('B.4', 'until approval nothing changes: version 1 is still the approved default, and the analysis of the reference was not redone', kU.approved.version === 1 && kU.defaultVersion === 1
      && ((await api('/references')).body.references.find(r => r.id === ref0.id)?.analysedAt ?? null) === leasesBefore);
    // testable on another clip: the story output, as a marked TEST version
    const tt = await send(`/skills/${A}/test`, { by: ACTOR, projectId: storyP.id });
    if (tt.status === 200 || tt.status === 201) {
      const s2 = await wait(storyP.id, 1500, 'story v2 (test of the upgrade draft)'), S2 = pkgOf(storyP.id, 2);
      copy(storyP.id, 2, 'final.mp4', 'story_v2_test_of_upgrade.mp4'); save('story_v2_final_review.json', S2.final_review ?? {});
      const ts = S2.skill_report?.skill?.skills ?? [S2.skill_report?.skill].filter(Boolean);
      check('B.5', 'the upgrade DRAFT can be tested on another clip: a marked test version, reviewed by version 2 of the skill; still not the default', done(s2.p) && ts.some(k => k.id === A && k.version === 2)
        && (await skill(A)).defaultVersion === 1, { skills: ts.map(k => `${k.name} v${k.version} ${k.status}`), verdict: S2.final_review?.verdict, seconds: s2.seconds });
      summary.story.v2_seconds = s2.seconds;
    } else check('B.5', 'the upgrade DRAFT can be tested on another clip', false, tt.body);
    const od = (await skill(A)).draft.conflicts.filter(c => !c.resolution);
    if (od.length) await send(`/skills/${A}`, { by: ACTOR, resolve: od.map(c => ({ id: c.id, resolution: 'a' })) }, 'PUT');
    const ap2 = await send(`/skills/${A}/approve`, { by: ACTOR }), k2 = ap2.body.skill;
    check('B.6', 'TEST approval activates version 2 for future edits; version 1 is kept (files and record)', k2?.status === 'approved' && k2.defaultVersion === 2 && k2.versions.map(v => `${v.version}:${v.status}`).join() === '1:approved,2:approved'
      && fs.existsSync(path.join(DATA, 'dana', 'skills', A, 'v1', 'SKILL.md')) && fs.existsSync(path.join(DATA, 'dana', 'skills', A, 'v2', 'SKILL.md')), k2 ? { default: k2.defaultVersion, versions: k2.versions.map(v => `${v.version}:${v.status}`) } : ap2.body);
    save('A_SKILL_v2.md', k2?.approved?.skill_md ?? '');
    const R1again = pkgOf(reelP.id, 1);
    check('B.7', 'existing projects keep what they were made with: the reel versions still record version 1 of the skill', (R1again.skill_report.skill.skills ?? []).find(k => k.id === A)?.version === 1);
    summary.skills = { A, G, upgraded_from_reference: ref0.title, example_video: path.basename(example) };
  } catch (e) { check('X', 'the run completed', false, String(e && e.stack || e).slice(0, 600)); }
  finally {
    await stopWorker(); spawn('taskkill', ['/PID', String(awake.pid), '/T', '/F']);
    const fails = results.filter(r => !r.ok);
    save('results.json', { at: new Date().toISOString(), summary, results });
    log(`\n${results.filter(r => r.ok).length} passed, ${fails.length} failed of ${results.length}. evidence: ${OUT}`);
    for (const f of fails) log(`   FAILED ${f.id} ${f.name}`);
    process.exitCode = fails.length ? 1 : 0;
    if (keep) log(`preview server left running on ${base} (worker stopped)`); else { server.close(); setTimeout(() => process.exit(process.exitCode), 300); }
  }
}
main();
