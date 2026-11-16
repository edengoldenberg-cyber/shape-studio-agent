'use strict';
/**
 * dana_e2e_track.cjs — ONE full track through the page's own HTTP API with the REAL worker:
 *   upload -> target and skills -> edit -> Dana's FRESH review of the delivered file -> rating and recommendations ->
 *   a caption correction by the owner -> "apply the improvements" -> a new version with its own fresh review -> no repeated round.
 * Local only: preview on 127.0.0.1, mocked notifications, publishing off. Requests are made by a marked TEST ACTOR.
 *
 *   DANA_PREVIEW_DATA=<empty dir with a skill library> node scripts/dana_e2e_track.cjs <raw.mp4>
 *
 * PATH (did the track work) is reported apart from QUALITY (what the mandatory checks say about each produced file).
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress-track.log'), line + '\n'); };
function check(id, name, ok, detail) { results.push({ id, name, ok: !!ok, detail: detail ?? null }); log(`   ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''}`); }
const shaFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function main() {
  if (!DATA) throw new Error('set DANA_PREVIEW_DATA');
  const RAW = path.resolve(process.argv[2]);
  const OUT = path.join(DATA, 'evidence'); fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || 3197;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-track-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const st of [worker.stdout, worker.stderr]) st.on('data', d => fs.appendFileSync(path.join(DATA, 'worker-track.log'), d));
  const awake = spawn('powershell', ['-NoProfile', '-Command', "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; while (1) { [W.P]::SetThreadExecutionState(2147483649) | Out-Null; Start-Sleep 30 }"], { stdio: 'ignore' });
  const stop = () => new Promise(r => { spawn('taskkill', ['/PID', String(awake.pid), '/T', '/F']); if (worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const send = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const project = async (id, n) => (await api(`/projects/${id}${n ? `?version=${n}` : ''}`)).body.project;
  const wait = async (id, timeoutS, label) => { const t0 = Date.now(); let last = '';
    for (;;) { const p = await project(id); const line = `${p.status} · ${p.job?.status} · ${p.job?.note}`;
      if (line !== last) { log(`   ${label} [${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
      if (!['queued', 'leased'].includes(p.job?.status)) return { p, seconds: Math.round((Date.now() - t0) / 1000) };
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`); await sleep(3000); } };
  const vdir = (id, n) => path.join(DATA, 'dana', 'projects', id, `v${n}`);
  const pkgOf = (id, n) => JSON.parse(fs.readFileSync(path.join(vdir(id, n), 'package.json'), 'utf8'));
  /** What a delivered version says about itself: is the review fresh, is it about exactly this file, what did the mandatory checks find. */
  const reviewChecks = async (tag, id, n) => {
    const P = pkgOf(id, n), f = P.final_review ?? {}, s = f.score ?? {}, file = shaFile(path.join(vdir(id, n), 'final.mp4')), p = await project(id, n);
    fs.writeFileSync(path.join(OUT, `v${n}_package.json`), JSON.stringify(P, null, 1));
    fs.copyFileSync(path.join(vdir(id, n), 'final.mp4'), path.join(OUT, `track_v${n}.mp4`));
    check(`${tag}.1`, `v${n}: Dana's review is a FRESH review, made on exactly the delivered file`, f.source?.kind === 'fresh_review' && f.on_delivered_file === true && f.file_sha256 === file && P.review_provenance?.final_sha256 === file && p.review.finalSha256 === file && p.review.upToDate === true,
      { source: f.source?.kind, file: file.slice(0, 12), reviewed: String(f.file_sha256).slice(0, 12) });
    check(`${tag}.2`, `v${n}: the review names the criteria, the skills that were chosen and the references`, f.rubric_version === P.dana_review?.rubric_version && (f.skills ?? []).some(k => k.role === 'סקיל הביקורת') && Array.isArray(f.references)
      && (!p.versions.find(x => x.n === n).skill || (f.skills ?? []).some(k => /סקיל מהספרייה/.test(k.role))), { rubric: f.rubric_version, skills: (f.skills ?? []).map(k => `${k.name} ${k.version}`), references: (f.references ?? []).length, library: p.versions.find(x => x.n === n).skill?.name ?? null });
    const k = s.kinds ?? {};
    check(`${tag}.3`, `v${n}: technical checks and the editorial assessment (opening, message, pace, captions, design) are reported apart`, k.technical?.decided > 10 && k.editorial?.decided > 5 && (k.editorial.topics ?? []).length === 5 && (k.editorial.topics ?? []).filter(t => t.decided).length >= 4,
      { technical: `${k.technical?.met}/${k.technical?.decided}`, editorial: `${k.editorial?.met}/${k.editorial?.decided}`, topics: (k.editorial?.topics ?? []).map(t => `${t.label} ${t.met}/${t.decided}`), waiting_for_owner: k.owner });
    const all = f.all_improvements ?? [];
    check(`${tag}.4`, `v${n}: every recommendation has a fixed id bound to this file, a reason, a proposed change, and a time or "the whole video"`,
      all.every(x => x.finding === `${x.id}@${file.slice(0, 12)}` && x.action && (x.where === 'time' ? typeof x.time_s === 'number' : x.where === 'whole_video') && (x.why !== undefined)),
      { count: all.length, with_time: all.filter(x => x.where === 'time').length, top: (f.top_improvements ?? []).map(x => `${x.time_s ?? 'כל הסרטון'} | ${x.title.slice(0, 60)} | ${x.who}`) });
    check(`${tag}.5`, `v${n}: the mark follows the evidence, and what needs the owner's ears or eyes is said`, ['sufficient', 'provisional', 'insufficient'].includes(s.evidence?.state) && (s.overall === null) === (s.evidence.state === 'insufficient') && s.coverage?.human_only >= 1,
      { mark: s.range ? `${s.range.low}-${s.range.high}` : s.overall, evidence: s.evidence?.label, coverage: `${s.coverage?.decided}/${s.coverage?.applicable}`, listening: s.uncertain?.count, watching: s.coverage?.human_only });
    log(`   QUALITY v${n}: readiness "${f.plain?.status}" · proven failures ${s.blocking?.count}: ${JSON.stringify(s.blocking?.items)} · doubts for the owner's ears ${s.uncertain?.count}: ${JSON.stringify(s.uncertain?.items)}`);
    log(`   NEXT v${n}: Dana can ${JSON.stringify((f.next_steps?.dana ?? []).map(x => x.id))} · owner ${f.next_steps?.owner?.length} · asked from the owner ${JSON.stringify((f.next_steps?.blockers ?? []).map(x => x.kind + ': ' + x.title.slice(0, 50)))}`);
    return { P, f, s, file, p };
  };
  const summary = { base, data: DATA, actor: ACTOR, material: path.basename(RAW) };
  try {
    const st = (await api('/status')).body;
    check('0.1', 'publishing is off and notifications are mocked', st.publishingEnabled === false && st.notifications === 'mock');
    const lib = (await api('/skills')).body.skills ?? [];
    log(`== 1: upload, target "reel", the approved default skills (${lib.filter(k => k.default).map(k => k.name).join(' + ') || 'none in the library'}) ==`);
    const fd = new FormData(); fd.append('options', JSON.stringify({ target: 'reel' })); fd.append('video', await fs.openAsBlob(RAW), path.basename(RAW));
    const up = await api('/upload', { method: 'POST', body: fd }), id = up.body.project?.id;
    check('1.1', 'the upload is accepted with its target and queued for the worker', up.status === 201 && up.body.project?.target === 'reel', up.body.error ?? { id, target: up.body.project?.target });
    const r1 = await wait(id, 2400, 'v1');
    const ok1 = !!r1.p.version?.package && r1.p.status !== 'failed';
    check('1.2', 'the edit was produced by the real worker', ok1, { status: r1.p.status, job: r1.p.job?.status, note: r1.p.job?.note, error: r1.p.job?.error, seconds: r1.seconds });
    if (!ok1) throw new Error('not produced');
    check('1.3', 'the chosen skills travelled to the edit', lib.some(k => k.default) ? !!r1.p.versions[0].skill : true, r1.p.versions[0].skill ?? 'no library skill: the basic editing rules');
    log('== 2: Dana\'s fresh review, rating and recommendations ==');
    const a = await reviewChecks('2', id, 1);
    summary.v1 = { mark: a.s.range ?? a.s.overall, readiness: a.f.plain?.status, proven: a.s.blocking?.items, listening: a.s.uncertain?.items, dana_can: (a.f.next_steps?.dana ?? []).map(x => x.id) };

    log('== 3: the owner corrects one caption, then "apply the improvements" ==');
    const card = a.P.cards.find(c => c.text && c.source_end_s > c.source_start_s), fixed = /[.!?]$/.test(card.text) ? card.text.replace(/[.!?]+$/, '') : card.text + '.';
    const ce = await send(`/projects/${id}/captions/verify`, { by: ACTOR, listened: true, source_start_s: card.source_start_s, source_end_s: card.source_end_s, original: card.text, text: fixed });
    check('3.1', 'a caption correction is stored through the existing "listen, correct, verify"', ce.status === 200 && (ce.body.project?.kept?.captionEdits ?? 0) >= 1, ce.body.error ?? { card: card.i, before: card.text, after: fixed });
    const can = (a.f.next_steps?.dana ?? []).length;
    const ap = await send(`/projects/${id}/apply-review`, { by: ACTOR, ...(can ? {} : { note: 'אין שיפור אוטומטי: להפיק שוב עם תיקון הכתובית שנשמר, בלי לשנות את החיתוך.' }) });
    check('3.2', can ? `"apply" queues a new version for the ${can} supported improvements only` : '"apply" has nothing supported to do; the owner\'s written request queues the version', ap.status === 200, ap.body.error ?? ap.body.message);
    const r2 = await wait(id, 2400, 'v2');
    const ok2 = r2.p.currentVersion === 2 && !!r2.p.version?.package && r2.p.status !== 'failed';
    check('3.3', 'the new version was produced; the earlier one is kept', ok2 && fs.existsSync(path.join(vdir(id, 1), 'final.mp4')), { status: r2.p.status, job: r2.p.job?.status, error: r2.p.job?.error, seconds: r2.seconds });
    if (!ok2) throw new Error('v2 not produced');
    const b = await reviewChecks('4', id, 2);
    const ai = b.p.version.appliedImprovements;
    check('4.6', 'the new version records what it was asked to fix, with the ids of the findings and the file they were found on, and what was left to the owner',
      ai && ai.fromVersion === 1 && ai.fromFile === a.file && ai.items.length === can && ai.items.every(x => x.finding.endsWith('@' + a.file.slice(0, 12))) && Array.isArray(ai.leftForOwner), ai && { items: ai.items.map(x => x.finding), left: ai.leftForOwner.length, kept: ai.kept });
    const c2 = b.P.cards.find(c => Math.abs(c.source_start_s - card.source_start_s) < 0.03 && Math.abs(c.source_end_s - card.source_end_s) < 0.03);
    check('4.7', 'the owner\'s caption correction is in the new video (when that part is still in the cut)', c2 ? c2.text === fixed : true, c2 ? { now: c2.text } : 'the corrected part is not in the new cut; the correction stays stored for later versions');
    check('4.8', 'the two versions are two files with two reviews; the earlier review is marked as not about the current version', b.file !== a.file && (await project(id, 1)).review.upToDate === false && b.p.review.upToDate === true);
    const fixedIds = (a.f.next_steps?.dana ?? []).map(x => x.id).filter(x => !(b.f.next_steps?.dana ?? []).some(y => y.id === x));
    log(`   PROGRESS: asked ${JSON.stringify((a.f.next_steps?.dana ?? []).map(x => x.id))} · no longer listed ${JSON.stringify(fixedIds)} · mark ${JSON.stringify(a.s.range ?? a.s.overall)} -> ${JSON.stringify(b.s.range ?? b.s.overall)}`);
    summary.v2 = { mark: b.s.range ?? b.s.overall, readiness: b.f.plain?.status, proven: b.s.blocking?.items, listening: b.s.uncertain?.items, dana_can: (b.f.next_steps?.dana ?? []).map(x => x.id), fixed: fixedIds };

    log('== 5: no repeated round without progress ==');
    const again = await send(`/projects/${id}/apply-review`, { by: ACTOR });
    const left = (b.f.next_steps?.dana ?? []).filter(x => !ai.items.some(y => y.id === x.id));
    check('5.1', left.length ? 'only improvements that were not tried yet are sent in another round' : 'another identical round is refused: what is left was tried already or needs the owner',
      left.length ? again.status === 200 : again.status === 409 && ['no_progress', 'nothing_to_apply'].includes(again.body.error), { status: again.status, error: again.body.error, message: again.body.message });
    if (again.status === 200) { const r3 = await wait(id, 2400, 'v3'); await reviewChecks('6', id, 3); summary.v3 = r3.p.status; }
    summary.versions = (await project(id)).versions.map(v => ({ n: v.n, status: v.status }));
  } catch (e) { check('X', 'the run completed', false, String(e && e.stack || e)); }
  finally { await stop(); server.close(); fs.rmSync(cfgPath, { force: true }); }
  const failed = results.filter(r => !r.ok);
  fs.writeFileSync(path.join(DATA, 'evidence', 'results-track.json'), JSON.stringify({ summary, results }, null, 1));
  log(`PATH: ${results.length - failed.length} passed, ${failed.length} failed of ${results.length}.`);
  log(`SUMMARY ${JSON.stringify(summary)}`);
  log('Nobody watched or listened. A passed path does not say the video is good.');
  setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
}
main();
