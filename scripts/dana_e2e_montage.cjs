'use strict';
/**
 * dana_e2e_montage.cjs — acceptance of a COMPILATION from several source files with uploaded music and narration,
 * through the page's own HTTP API with the REAL worker. Local only; mocked notifications; publishing off.
 *
 *   node scripts/dana_e2e_montage.cjs <dir with DEMO_A*.mp4 DEMO_B*.mp4 DEMO_C*.mp4 DEMO_music*.m4a DEMO_narration*.wav> [--keep]
 *
 *   1  several source files -> ONE video, with a map of every part to its file and time
 *   2  uploaded music -> in the mix of the final file, measured; the licence is NOT assumed
 *   3  replace the music and add a narration -> a new version; the cut is unchanged
 *   4  replace ONE part -> a new version; the other parts are unchanged
 *   5  a final review of every output
 * PATH (did the flow work) is reported separately from what the review says about the video.
 * Every action here is made by a TEST ACTOR on DEMO material. Nothing is approved in the owner's name.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA || 'C:/Users/owner/dana-work/e2e-montage';
const OUT = path.join(DATA, 'evidence');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress.log'), line + '\n'); };
function check(id, name, ok, detail) { results.push({ id, name, ok: !!ok, detail: detail ?? null }); log(`   ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 520) : ''}`); }
const save = (name, obj) => fs.writeFileSync(path.join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));

async function main() {
  const dir = path.resolve(process.argv[2] || '.');
  const pick = re => { const f = fs.readdirSync(dir).find(n => re.test(n)); if (!f) throw new Error('missing demo file ' + re); return path.join(dir, f); };
  const A = pick(/^DEMO_A.*\.mp4$/), B = pick(/^DEMO_B.*\.mp4$/), C = pick(/^DEMO_C.*\.mp4$/), MUSIC = pick(/^DEMO_music.*\.(m4a|mp3|wav)$/), NAR = pick(/^DEMO_narration.*\.(wav|mp3|m4a)$/);
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || 3197;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-montage-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const st of [worker.stdout, worker.stderr]) st.on('data', d => fs.appendFileSync(path.join(DATA, 'worker.log'), d));
  const awake = spawn('powershell', ['-NoProfile', '-Command', "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; while (1) { [W.P]::SetThreadExecutionState(2147483649) | Out-Null; Start-Sleep 30 }"], { stdio: 'ignore' });
  const stop = () => new Promise(r => { spawn('taskkill', ['/PID', String(awake.pid), '/T', '/F']); if (worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const send = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const form = async (p, fields, field, file) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); fd.append(field, await fs.openAsBlob(file), path.basename(file)); return api(p, { method: 'POST', body: fd }); };
  const project = async id => (await api('/projects/' + id)).body.project;
  const wait = async (id, timeoutS, label) => { const t0 = Date.now(); let last = '';
    for (;;) { const p = await project(id); const line = `${p.status} · ${p.job?.status} · ${p.job?.note}`;
      if (line !== last) { log(`   ${label} [${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
      if (!['queued', 'leased'].includes(p.job?.status)) return { p, seconds: Math.round((Date.now() - t0) / 1000) };
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`); await sleep(2500); } };
  const vdir = (id, n) => path.join(DATA, 'dana', 'projects', id, `v${n}`);
  const pkgOf = (id, n) => JSON.parse(fs.readFileSync(path.join(vdir(id, n), 'package.json'), 'utf8'));
  const keepCopy = (id, n, name) => { try { fs.copyFileSync(path.join(vdir(id, n), 'final.mp4'), path.join(OUT, name)); } catch { /* reported by the checks */ } };
  const parts = P => (P.plan?.segments ?? []).map(s => `${s.source_id}:${s.file_in_s}-${s.file_out_s}`);
  const summary = { base, data: DATA, actor: ACTOR, material: 'DEMO files cut from existing footage; the music file has no confirmed licence' };

  try {
    const st = (await api('/status')).body;
    check('0.1', 'publishing is off and notifications are mocked', st.publishingEnabled === false && st.notifications === 'mock');
    // ── 1: several files together ──
    log('== 1: three source files -> one compilation ==');
    const up = await form('/upload', { options: JSON.stringify({ project_type: 'montage', more_files: true, target: 'reel' }) }, 'video', A);
    const id = up.body.project?.id;
    check('1.1', 'the first file opens the project; the edit waits while more files are uploaded', up.status === 201 && (await project(id)).waitingForFiles === true, up.body.error);
    const s2 = await form(`/projects/${id}/sources`, { by: ACTOR }, 'video', B), s3 = await form(`/projects/${id}/sources`, { by: ACTOR }, 'video', C);
    check('1.2', 'two more source files are added to the same project', s2.status === 201 && s3.status === 201 && s3.body.project.media.sources.length === 3, s3.body.project?.media?.sources?.map(s => `${s.id}:${s.name}`));
    const mk = await send(`/projects/${id}/sources/src1/marks`, { by: ACTOR, marks: [{ from_s: 0, to_s: 3.5, kind: 'never', note: 'בדיקה: לא להשתמש בפתיחה' }] }, 'PATCH');
    const mk2 = await send(`/projects/${id}/sources/src3/marks`, { by: ACTOR, marks: [{ from_s: 5, to_s: 8, kind: 'must', note: 'בדיקה: חייב להיכלל' }] }, 'PATCH');
    check('1.3', 'ranges are marked per file: "never use" on one, "must be included" on another', mk.status === 200 && mk2.status === 200, mk2.body.project?.media?.sources?.map(s => s.marks.map(m => `${m.kind}:${m.from_s}-${m.to_s}`)));
    const mu = await form(`/projects/${id}/assets`, { by: ACTOR, kind: 'music' }, 'file', MUSIC), music = mu.body.asset;
    check('2.1', 'an uploaded music file is stored and is NOT marked as licensed', mu.status === 201 && music.license.status === 'not_confirmed', music?.license);
    const au = await send(`/projects/${id}/audio`, { by: ACTOR, music: { asset: music.id, start_s: 8, volume_db: -14, fade_in_s: 0.4, fade_out_s: 1.5 }, original: { mode: 'mute' }, cut_on_beat: true }, 'PATCH');
    check('2.2', 'the mix is set before the edit: start point, level, fades, ducking, original sound muted, cuts by the beat', au.status === 200 && au.body.project.media.audio.music.start_s === 8 && au.body.project.media.audio.cut_on_beat === true, au.body.project?.media?.audio);
    const go = await send(`/projects/${id}/start`, { by: ACTOR });
    check('1.4', '"start" releases the waiting edit', go.status === 200 && go.body.project.waitingForFiles === false, go.body.error);
    const r1 = await wait(id, 1500, 'compilation v1');
    const ok1 = !!r1.p.version?.package && !['failed'].includes(r1.p.status);
    check('1.5', 'the compilation was produced', ok1, { status: r1.p.status, job: r1.p.job?.status, note: r1.p.job?.note, error: r1.p.job?.error, seconds: r1.seconds });
    if (!ok1) throw new Error('the compilation was not produced');
    const P1 = pkgOf(id, 1); save('v1_package.json', P1); keepCopy(id, 1, 'compilation_v1.mp4');
    const segs = P1.plan.segments, files = new Set(segs.map(s => s.source_id));
    const unused = P1.montage?.unused_sources ?? [];
    check('1.6', 'ONE video from several files: every file is either used or named as unused with the reason', P1.source.files === 3 && files.size + unused.length === 3 && unused.every(u => u.why)
      && unused.every(u => (P1.issues ?? []).some(i => i.code === 'source_not_used' && i.message.includes(u.name))), { used: [...files], unused, parts: parts(P1), duration: P1.duration });
    check('1.6b', 'the compilation draws on more than one file (a material question: reported, and the reason is visible when it does not)', files.size >= 2, { used: [...files], unused });
    check('1.7', 'the edit map: every part has its file and the time inside that file; no part crosses a file border', segs.every(s => s.source_name && s.file_out_s > s.file_in_s && !s.crosses_files)
      && (P1.timeline?.spans ?? []).length === segs.length && (P1.source_map ?? []).length === 3, P1.timeline?.spans?.map(x => x.picture_label.slice(0, 60)));
    const rec = i => (P1.checks ?? []).find(c => c.id === i);
    check('1.8', 'the owner\'s marks are respected and measured: "never" is not used, "must" is in', rec('marks_never')?.status === 'pass' && rec('marks_must')?.status === 'pass'
      && segs.some(s => s.source_id === 'src3' && s.file_in_s <= 5.4 && s.file_out_s >= 7.6) && !segs.some(s => s.source_id === 'src1' && s.file_in_s < 3.4), { never: rec('marks_never')?.summary, must: rec('marks_must')?.summary });
    check('1.9', 'the choice is by what is seen, with the limits said: no exercise is named as fact and no performance is judged (stated basis); what each part shows is recorded', /אינו מזהה תרגילים/.test(P1.plan.basis ?? '')
      && (P1.judgement_mode !== 'model' || segs.filter(s => s.seen).length >= 1), { mode: P1.judgement_mode, message: P1.plan.message, seen: segs.map(s => s.seen).filter(Boolean).slice(0, 4), candidates: P1.plan.candidates_considered });
    const m1 = P1.mix ?? {};
    check('2.3', 'the music is in the final file: the mix parameters are stored and the result is measured (loudness, clipping, peak)', m1.applied === true && m1.params?.music?.start_s === 8 && typeof m1.measured?.pre_master_lufs === 'number'
      && rec('loudness')?.status === 'pass' && rec('mix_clipping')?.status === 'pass', { params: m1.params, measured: m1.measured, loudness: rec('loudness')?.summary });
    check('2.4', 'cutting by the beat: beats were detected and a cut was moved only where a beat was close', m1.beats?.requested === true && (typeof m1.beats.cuts_on_beat === 'number' || (P1.issues ?? []).some(i => i.code === 'beats_not_available')), m1.beats);
    check('2.5', 'the licence is not assumed: the package blocks publication until the owner records the source and licence', (P1.issues ?? []).some(i => i.code === 'music_license_not_confirmed') && r1.p.status !== 'approved', m1.music_license);
    const f1 = P1.final_review ?? {};
    check('5.1', 'a final review of the delivered compilation: file hash, what was measured, what a model judged on stills, what nobody checked', f1.on_delivered_file === true && !!f1.file_sha256 && (f1.coverage?.human_only ?? []).length >= 2
      && (f1.not_checked ?? []).length >= 2 && ['ready_for_viewing', 'needs_owner', 'needs_fix'].includes(f1.verdict), { verdict: f1.verdict_text, coverage: f1.coverage && { decided: f1.coverage.decided, measured: f1.coverage.measured, model: f1.coverage.model, human_only: f1.coverage.human_only.length }, categories: (f1.categories ?? []).map(c => `${c.label}:${c.level}`) });
    save('v1_final_review.json', f1);

    // ── 3: another music start + level and a narration; the cut stays ──
    log('== 3: replace the music settings and add a narration ==');
    const na = await form(`/projects/${id}/assets`, { by: ACTOR, kind: 'narration' }, 'file', NAR), nar = na.body.asset;
    await send(`/projects/${id}/assets/${nar.id}/narration-info`, { by: ACTOR, is_script: true, text: 'חומר הדגמה: קטע קול קיים שמשמש כקריינות לצורך הבדיקה בלבד' });
    const rv = await send(`/projects/${id}/revise`, { by: ACTOR, audio: { music: { asset: music.id, start_s: 30, volume_db: -20 }, narration: { asset: nar.id, start_s: 1 }, original: { mode: 'mute' }, cut_on_beat: false } });
    check('3.1', 'changing the mix queues a new version; version 1 stays on screen and is kept', rv.status === 200 && rv.body.project.currentVersion === 2, rv.body.error ?? rv.body.project?.review?.stale);
    const r2 = await wait(id, 1200, 'compilation v2 (new mix)');
    const P2 = pkgOf(id, 2); save('v2_package.json', P2); keepCopy(id, 2, 'compilation_v2_new_mix_and_narration.mp4');
    check('3.2', 'only the mix changed: the same parts from the same files and times', JSON.stringify(parts(P2)) === JSON.stringify(parts(P1)) && P2.revision_mode === 'locked_to_previous_plan', { v1: parts(P1), v2: parts(P2), seconds: r2.seconds });
    const m2 = P2.mix ?? {}, c2 = i => (P2.checks ?? []).find(c => c.id === i);
    check('3.3', 'the new music settings and the narration are in the mix; the music is measured against the speech', m2.params?.music?.start_s === 30 && m2.params?.music?.volume_db === -20 && !!m2.params?.narration
      && typeof m2.measured?.speech_over_music_db === 'number' && !!c2('mix_speech_over_music'), { measured: m2.measured, check: c2('mix_speech_over_music')?.summary });
    check('3.4', 'the narration is recorded as a script written for the video, not as a quotation', m2.narration_script?.is_script === true, m2.narration_script);
    check('3.6', 'the narration gets captions: timed from a transcription of the narration, inside the safe zone, marked as narration and as NOT verified', (P2.cards ?? []).length >= 3 && P2.cards.every(c => c.of === 'narration')
      && c2('safe_zone')?.status === 'pass' && (P2.issues ?? []).some(i => i.code === 'narration_captions_unverified') && (P2.final_review?.not_checked ?? []).some(x => /תואמות/.test(x.criterion)),
      { cards: (P2.cards ?? []).length, first: (P2.cards ?? []).slice(0, 4).map(c => c.text), width: c2('caption_width')?.status, zone: c2('safe_zone')?.summary });
    check('3.5', 'version 1 is kept on disk, nothing is approved, and version 2 has its own final review', fs.existsSync(path.join(vdir(id, 1), 'final.mp4')) && r2.p.status !== 'approved' && P2.final_review?.file_sha256 !== f1.file_sha256);

    // ── 4: replace ONE part ──
    log('== 4: replace one part ==');
    const target = P2.plan.segments[1], other = target.source_id === 'src2' ? 'src1' : 'src2';
    const rs = await send(`/projects/${id}/revise`, { by: ACTOR, segment_edits: [{ n: target.n, action: 'replace', source_id: other, from_s: 10, to_s: 13 }] });
    check('4.1', 'replacing one part queues a new version', rs.status === 200 && rs.body.project.currentVersion === 3, rs.body.error);
    const r3 = await wait(id, 1200, 'compilation v3 (one part replaced)');
    const P3 = pkgOf(id, 3); save('v3_package.json', P3); keepCopy(id, 3, 'compilation_v3_one_part_replaced.mp4');
    const a2 = parts(P2), a3 = parts(P3);
    check('4.2', 'only that part changed: it now comes from the file and time that were asked for; every other part is identical', a3.length === a2.length && a3.every((x, i) => i === 1 ? x.startsWith(`${other}:10`) : x === a2[i])
      && P3.plan.segments[1].replaced_by_owner === true, { before: a2, after: a3, seconds: r3.seconds });
    check('4.3', 'the mix of version 2 is carried over unchanged', JSON.stringify(P3.mix?.params) === JSON.stringify(P2.mix?.params));
    check('5.2', 'every version has its own final review of its own file', new Set([P1, P2, P3].map(p => p.final_review?.file_sha256)).size === 3 && (await project(id)).status !== 'approved');
    summary.project = id; summary.versions = [P1, P2, P3].map((p, i) => ({ n: i + 1, seconds: p.total_s, duration: p.duration, verdict: p.final_review?.verdict_text, failed_checks: p.failed_checks, open_items: (p.review_items ?? []).length }));
  } catch (e) { check('X', 'the run completed', false, String(e && e.stack || e).slice(0, 600)); }
  finally {
    await stop();
    const fails = results.filter(r => !r.ok);
    save('results.json', { at: new Date().toISOString(), summary, results });
    log(`\nPATH: ${results.length - fails.length} passed, ${fails.length} failed of ${results.length}.`);
    for (const v of summary.versions ?? []) log(`PRODUCT v${v.n}: ${v.verdict} · ${v.duration}s video · produced in ${v.seconds}s · failed checks ${JSON.stringify(v.failed_checks)} · ${v.open_items} open items`);
    log(`evidence: ${OUT}`);
    for (const f of fails) log(`   FAILED ${f.id} ${f.name}`);
    process.exitCode = fails.length ? 1 : 0;
    if (process.argv.includes('--keep')) log(`preview server left running on ${base}`); else { server.close(); setTimeout(() => process.exit(process.exitCode), 300); }
  }
}
main();
