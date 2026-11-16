'use strict';
/**
 * dana_e2e_fresh.cjs — a testimony from footage Dana has NOT edited before, with uploaded music, through the page's own
 * HTTP API with the REAL worker. Local only; mocked notifications; publishing off.
 *
 *   node scripts/dana_e2e_fresh.cjs <new-raw.mp4> <music.(m4a|mp3|wav)>
 *
 *   1  new footage + music -> a reel: speech pipeline, captions verified on the voice, music mixed under the speech
 *   2  a doubt that needs listening is decided once and is not asked again in the next version
 *   3  graphics / animation are ALLOWED for the next plan; what Dana asked for, what was made and what was not is read as it is
 *   4  a change of the mix only -> a new version with the same cut and the same captions
 * PATH is reported separately from what the review says about each version. TEST ACTOR, DEMO music with no licence.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA || 'C:/Users/owner/dana-work/e2e-fresh';
const OUT = path.join(DATA, 'evidence');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress.log'), line + '\n'); };
function check(id, name, ok, detail) { results.push({ id, name, ok: !!ok, detail: detail ?? null }); log(`   ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 520) : ''}`); }
const save = (name, obj) => fs.writeFileSync(path.join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));

async function main() {
  const [RAW, MUSIC] = process.argv.slice(2).filter(a => !a.startsWith('--')).map(a => path.resolve(a));
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || 3198;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-fresh-${port}.json`);
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
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`); await sleep(3000); } };
  const vdir = (id, n) => path.join(DATA, 'dana', 'projects', id, `v${n}`);
  const pkgOf = (id, n) => JSON.parse(fs.readFileSync(path.join(vdir(id, n), 'package.json'), 'utf8'));
  const keepCopy = (id, n, name) => { try { fs.copyFileSync(path.join(vdir(id, n), 'final.mp4'), path.join(OUT, name)); } catch { /* reported by the checks */ } };
  const rec = (P, i) => (P.checks ?? []).find(c => c.id === i);
  const summary = { base, data: DATA, actor: ACTOR, material: `${path.basename(RAW)} — footage not edited by Dana before; DEMO music with no confirmed licence` };

  try {
    const st = (await api('/status')).body;
    check('0.1', 'publishing is off and notifications are mocked', st.publishingEnabled === false && st.notifications === 'mock');
    log('== 1: new footage + music -> a reel ==');
    const up = await form('/upload', { options: JSON.stringify({ project_type: 'mixed', more_files: true, target: 'reel' }) }, 'video', RAW);
    const id = up.body.project?.id;
    const mu = await form(`/projects/${id}/assets`, { by: ACTOR, kind: 'music' }, 'file', MUSIC), music = mu.body.asset;
    await send(`/projects/${id}/audio`, { by: ACTOR, music: { asset: music.id, start_s: 20, volume_db: -20, fade_in_s: 0.5, fade_out_s: 2 } }, 'PATCH');
    const go = await send(`/projects/${id}/start`, { by: ACTOR });
    check('1.1', 'new footage is uploaded with a music file and mix settings, then started', up.status === 201 && mu.status === 201 && go.status === 200, up.body.error ?? go.body.error);
    const r1 = await wait(id, 1800, 'testimony v1');
    const ok1 = !!r1.p.version?.package && r1.p.status !== 'failed';
    check('1.2', 'the testimony was produced', ok1, { status: r1.p.status, job: r1.p.job?.status, note: r1.p.job?.note, error: r1.p.job?.error, seconds: r1.seconds });
    if (!ok1) throw new Error('not produced');
    const P1 = pkgOf(id, 1); save('v1_package.json', P1); keepCopy(id, 1, 'testimony_v1.mp4');
    check('1.3', 'chosen by what is said: a plan with a message, parts and captions of the spoken words', P1.judgement_mode === 'model' && !!P1.plan?.message && (P1.cards ?? []).length > 5 && (P1.plan.segments ?? []).length >= 1,
      { message: P1.plan?.message, parts: (P1.plan?.segments ?? []).length, cards: (P1.cards ?? []).length, duration: P1.duration });
    const m1 = P1.mix ?? {};
    check('1.4', 'the music is mixed under the speech and measured: parameters stored; speech over music; loudness; no clipping', m1.applied === true && m1.params?.music?.volume_db === -20 && typeof m1.measured?.speech_over_music_db === 'number'
      && rec(P1, 'loudness')?.status === 'pass' && rec(P1, 'mix_clipping')?.status === 'pass', { measured: m1.measured, speech_over_music: rec(P1, 'mix_speech_over_music')?.summary, loudness: rec(P1, 'loudness')?.summary });
    check('1.5', 'the captions were verified on the voice, and the speech is checked again AFTER the mix', !!rec(P1, 'sync_lead') && !!rec(P1, 'speech_after_mix') && /לפני המיקס/.test(m1.sync_note ?? ''), { after_mix: rec(P1, 'speech_after_mix')?.summary, sync_lead: rec(P1, 'sync_lead')?.status });
    check('1.6', 'the licence of the uploaded music is not assumed: the package says publication is blocked', (P1.issues ?? []).some(i => i.code === 'music_license_not_confirmed'), m1.music_license);
    const f1 = P1.final_review ?? {};
    check('1.7', 'a final review of the delivered file, with sound criteria that were measured and one that needs listening', f1.on_delivered_file === true && (f1.not_checked ?? []).length >= 1 && ['ready_for_viewing', 'needs_owner', 'needs_fix'].includes(f1.verdict),
      { verdict: f1.verdict_text, rounds: f1.rounds, reasons: (f1.verdict_reasons ?? []).map(x => x.slice(0, 110)) });

    log('== 2: a doubt that needs listening ==');
    const hearing = (r1.p.version.unresolved ?? []).filter(u => u.hearing_key);
    let decided = null;
    if (hearing.length) {
      const it = hearing[0];
      const no = await send(`/projects/${id}/hearing`, { id: it.id, decision: 'ok', by: ACTOR });
      const yes = await send(`/projects/${id}/hearing`, { id: it.id, decision: 'ok', by: ACTOR, listened: true });
      decided = it;
      check('2.1', 'a hearing doubt carries a short clip to play (start and end) and is decided only after listening; TEST decision, recorded as such', no.body.error === 'listen_required' && yes.status === 200 && it.t0 != null && it.t1 > it.t0
        && !yes.body.project.version.unresolved.some(u => u.id === it.id), { item: it.original, clip_s: [it.t0, it.t1], key: it.hearing_key, open_before: hearing.length });
    } else check('2.1', 'a hearing doubt is decided after listening (no hearing doubt was raised on this footage — nothing to decide)', true, 'no hearing items in this version');

    log('== 3: allow graphics and an animation scene; plan again ==');
    await send(`/projects/${id}/settings`, { by: ACTOR, animation_scene: true }, 'PATCH');
    const rp = await send(`/projects/${id}/replan`, { by: ACTOR });
    check('3.1', 'planning again queues a new version; version 1 is kept', rp.status === 200 && rp.body.project.currentVersion === 2, rp.body.error);
    const r2 = await wait(id, 1800, 'testimony v2 (graphics allowed)');
    const P2 = pkgOf(id, 2); save('v2_package.json', P2); keepCopy(id, 2, 'testimony_v2_graphics_allowed.mp4');
    const gfx = P2.graphics ?? [], notUsed = P2.plan?.graphics_not_used ?? [];
    check('3.2', 'Dana\'s design brief: every element she asked for carries purpose, exact text and its source and class, timing, design, tool and how it is checked', gfx.every(g => g.reason && g.text && g.text_class && g.text_source && g.design && g.tool && g.check && g.tl_end_s > g.tl_start_s),
      gfx.map(g => `${g.kind}|${g.text_class}|${g.tl_start_s}-${g.tl_end_s}|${g.text}|${g.reason.slice(0, 60)}`));
    check('3.3', 'what was asked and NOT made is shown with the reason; what was made is measured in the final file', notUsed.every(g => g.why) && (gfx.filter(g => g.layer !== 'replaces_picture').length === 0 || rec(P2, 'graphics_rendered')?.status === 'pass')
      && (gfx.filter(g => g.layer === 'replaces_picture').length === 0 || rec(P2, 'animation_scene_rendered')?.status === 'pass'),
      { made: gfx.map(g => g.kind), not_made: notUsed.map(g => `${g.kind}: ${g.why}`), overlay: rec(P2, 'graphics_rendered')?.summary, scene: rec(P2, 'animation_scene_rendered')?.summary });
    if (decided) {
      const again = (P2.review_items ?? []).find(i => i.hearing_key === decided.hearing_key);
      check('2.2', 'the decision made by listening is not asked again in the next version (when the same doubt comes up it arrives settled)', !again || (again.owner_decision === 'ok' && !r2.p.version.unresolved.some(u => u.hearing_key === decided.hearing_key)),
        again ? { same_doubt: again.original, arrived: again.owner_decision, settled_checks: P2.final_review?.settled_by_owner } : 'the new plan did not raise the same doubt');
    }
    const f2 = P2.final_review ?? {};
    check('3.4', 'Dana\'s review of the result with the graphics: its own final review, and the change against version 1 explained criterion by criterion', f2.file_sha256 !== f1.file_sha256 && f2.changes !== undefined,
      { verdict: f2.verdict_text, graphics_category: (f2.categories ?? []).find(c => c.key === 'graphics'), changes: (f2.changes?.criteria ?? []).slice(0, 4).map(c => `${c.criterion.slice(0, 40)}: ${c.before}→${c.after}`) });

    log('== 4: change the mix only ==');
    const rv = await send(`/projects/${id}/revise`, { by: ACTOR, audio: { music: { asset: music.id, start_s: 60, volume_db: -26 } } });
    const r3 = await wait(id, 1500, 'testimony v3 (mix only)');
    const P3 = pkgOf(id, 3); save('v3_package.json', P3); keepCopy(id, 3, 'testimony_v3_mix_only.mp4');
    const cut = P => JSON.stringify((P.plan?.segments ?? []).map(s => [s.source_in_s, s.source_out_s])), txt = P => JSON.stringify((P.cards ?? []).map(c => c.text));
    check('4.1', 'only the mix changed: the same cut, the same captions, the same graphics; the new music settings are in', rv.status === 200 && cut(P3) === cut(P2) && txt(P3) === txt(P2)
      && JSON.stringify((P3.graphics ?? []).map(g => g.id)) === JSON.stringify(gfx.map(g => g.id)) && P3.mix?.params?.music?.volume_db === -26 && P3.mix?.params?.music?.start_s === 60,
      { same_cut: cut(P3) === cut(P2), same_captions: txt(P3) === txt(P2), music: P3.mix?.params?.music, seconds: r3.seconds });
    check('4.2', 'all three versions are kept, each with its own final review; nothing is approved', [1, 2, 3].every(n => fs.existsSync(path.join(vdir(id, n), 'final.mp4'))) && new Set([P1, P2, P3].map(p => p.final_review?.file_sha256)).size === 3 && r3.p.status !== 'approved');
    summary.versions = [P1, P2, P3].map((p, i) => ({ n: i + 1, seconds: p.total_s, duration: p.duration, verdict: p.final_review?.verdict_text, rounds: (p.editorial?.cycles ?? []).length, stop: p.editorial?.stop_reason, failed_checks: p.failed_checks, open_items: (p.review_items ?? []).filter(x => !x.owner_decision).length }));
  } catch (e) { check('X', 'the run completed', false, String(e && e.stack || e).slice(0, 600)); }
  finally {
    await stop();
    const fails = results.filter(r => !r.ok);
    save('results.json', { at: new Date().toISOString(), summary, results });
    log(`\nPATH: ${results.length - fails.length} passed, ${fails.length} failed of ${results.length}.`);
    for (const v of summary.versions ?? []) log(`PRODUCT v${v.n}: ${v.verdict} · ${v.duration}s video · ${v.rounds} review rounds (${v.stop}) · produced in ${v.seconds}s · failed checks ${JSON.stringify(v.failed_checks)} · ${v.open_items} open items`);
    log(`evidence: ${OUT}`);
    for (const f of fails) log(`   FAILED ${f.id} ${f.name}`);
    process.exitCode = fails.length ? 1 : 0;
    server.close(); setTimeout(() => process.exit(process.exitCode), 300);
  }
}
main();
