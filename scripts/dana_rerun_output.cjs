'use strict';
/**
 * dana_rerun_output.cjs — produce ONE new version of ONE existing output with the real worker, through the same call the
 * page makes ("החל את הסקיל והפק גרסה חדשה"), and print what the package says. The earlier versions are kept.
 * Local only: preview server on 127.0.0.1, mocked notifications, publishing off. The request is made by a TEST ACTOR.
 *
 *   DANA_PREVIEW_DATA=<dir> node scripts/dana_rerun_output.cjs <projectId | reel | story>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress-rerun.log'), line + '\n'); };

async function main() {
  if (!DATA) throw new Error('set DANA_PREVIEW_DATA');
  const want = process.argv[2];
  const port = Number(process.env.PORT) || 3196;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-rerun-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const st of [worker.stdout, worker.stderr]) st.on('data', d => fs.appendFileSync(path.join(DATA, 'worker-rerun.log'), d));
  const awake = spawn('powershell', ['-NoProfile', '-Command', "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; while (1) { [W.P]::SetThreadExecutionState(2147483649) | Out-Null; Start-Sleep 30 }"], { stdio: 'ignore' });
  const stop = () => new Promise(r => { spawn('taskkill', ['/PID', String(awake.pid), '/T', '/F']); if (worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  let code = 0;
  try {
    const list = (await api('/projects')).body.projects;
    const pr = list.find(p => p.id === want) || list.find(p => p.groupId && p.target === want);
    if (!pr) throw new Error('project not found: ' + want);
    const st = (await api('/status')).body;
    if (st.publishingEnabled !== false) throw new Error('publishing must be off');
    const before = (await api('/projects/' + pr.id)).body.project.currentVersion;
    const r = await api(`/projects/${pr.id}/apply-skill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: ACTOR, confirm_conflicts: true }) });
    if (r.status !== 200) throw new Error('apply-skill refused: ' + JSON.stringify(r.body).slice(0, 300));
    const t0 = Date.now(); let last = '', p;
    for (;;) { p = (await api('/projects/' + pr.id)).body.project; const line = `${p.status} · ${p.job?.status} · ${p.job?.note}`;
      if (line !== last) { log(`   ${pr.targetLabel} v${before + 1} [${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
      if (!['queued', 'leased'].includes(p.job?.status)) break;
      if (Date.now() - t0 > 1500e3) throw new Error('timeout'); await sleep(3000); }
    const n = p.currentVersion, P = JSON.parse(fs.readFileSync(path.join(DATA, 'dana', 'projects', pr.id, `v${n}`, 'package.json'), 'utf8'));
    const out = path.join(DATA, 'evidence'); fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(DATA, 'dana', 'projects', pr.id, `v${n}`, 'final.mp4'), path.join(out, `${pr.target}_v${n}.mp4`));
    fs.writeFileSync(path.join(out, `${pr.target}_v${n}_package.json`), JSON.stringify(P, null, 1));
    const sc = (P.graphics ?? []).filter(g => g.layer === 'replaces_picture'), ed = P.editorial ?? {};
    log(JSON.stringify({ version: n, kept_versions: p.versions.map(v => v.n), seconds: P.total_s, rounds: (ed.cycles ?? []).length, stop: ed.stop_reason, verdict: P.final_review?.verdict_text,
      failed_checks: P.failed_checks, scene: sc.map(g => `${g.tl_start_s}-${g.tl_end_s} ${g.text}`), not_drawn_in_scene: (P.cards ?? []).filter(c => c.in_scene).map(c => c.text),
      drawn_during_scene: (P.cards ?? []).filter(c => !c.in_scene && sc.some(g => c.start < g.tl_end_s - 0.05 && c.start + c.dur > g.tl_start_s + 0.05)).map(c => `${c.start} ${c.text}`),
      overlays: (P.graphics ?? []).filter(g => g.layer !== 'replaces_picture').map(g => g.text), mandatory_violations: P.final_review?.mandatory_violations,
      cut_at_scene: (P.issues ?? []).find(i => i.code === 'cards_cut_at_scene')?.message, caption_fit: ed.caption_fit, rules_in_force: ed.rules_in_force, status: p.status }, null, 1));
  } catch (e) { log('FAILED ' + (e && e.stack || e)); code = 1; }
  finally { await stop(); server.close(); setTimeout(() => process.exit(code), 300); }
}
main();
