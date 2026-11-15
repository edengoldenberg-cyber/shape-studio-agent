'use strict';
/**
 * dana_e2e_select.cjs — controlled LOCAL run of the creative workflow with the Claude adapter.
 * Preview server on 127.0.0.1, real worker, mocked notifications, publishing off.
 *
 *   node scripts/dana_e2e_select.cjs <source.mp4> --exclude 225.24-251.28,286.07-305.2 --change "<owner note>"
 *
 * Steps: upload (adapter=claude, excluded ranges) → package v1 → [automated test approval,
 * labelled as a test, to prove invalidation] → free-text change request → package v2,
 * produced automatically → v2 has no approval and waits for the real owner.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const TEST_ACTOR = 'E2E-TEST (automated, not the owner)';

async function main() {
  const src = path.resolve(process.argv[2]);
  const exclude = (arg('--exclude') || '').split(',').filter(Boolean).map(r => r.split('-').map(Number));
  const change = arg('--change');
  const port = 3100 + Math.floor(Math.random() * 400);
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: process.env.DANA_PREVIEW_DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-e2e-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8')), server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', d => process.stdout.write('   [worker] ' + d.toString().replace(/\n(?=.)/g, '\n   [worker] ')));
  worker.stderr.on('data', d => process.stdout.write('   [worker!] ' + d));
  const api = async (p, method = 'GET', body) => { const r = await fetch(base + '/api/dana/studio' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const wait = async (id, n) => {
    const t0 = Date.now(); let last = '';
    for (;;) {
      const p = (await api('/projects/' + id)).body.project; const line = `v${p.currentVersion} ${p.status} · ${p.job?.status} · ${p.job?.note}`;
      if (line !== last) { console.log(`   [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}`); last = line; }
      if (p.currentVersion === n && ['ready_for_review', 'failed', 'waiting'].includes(p.status) && !['queued', 'leased'].includes(p.job.status)) return p;
      if (Date.now() - t0 > 1800e3) throw new Error('timeout');
      await sleep(1500);
    }
  };
  const show = p => {
    const v = p.version, k = v.package;
    if (!k) { console.log(`   NO PACKAGE: ${p.job.error?.code} ${p.job.error?.message}`); return; }
    console.log(`\n   ── VERSION ${v.n} · ${k.adapter} · segment ${k.segment.in_s}–${k.segment.out_s}s (${k.duration}s) · edit ${k.totalSeconds}s`);
    if (k.revisionNote) console.log(`   revision note: ${k.revisionNote}`);
    console.log(`   reason: ${k.segment.reason}\n   complete thought: ${k.segment.complete_thought}\n   audience: ${k.segment.audience_relevance}`);
    for (const c of k.considered) console.log(`   considered ${c.in_s}–${c.out_s}: ${c.why_not}`);
    console.log(`   spoken (exact): ${k.spokenText}`);
    console.log(`   cards: ${k.cards.map(c => c.highlight.length ? `[${c.text}*]` : `[${c.text}]`).join(' ')}`);
    console.log(`   cover: "${k.cover.text}" @${k.cover.frame_s}s\n   caption: ${v.caption.text.replace(/\n/g, ' / ')}\n   cta: ${v.caption.cta}`);
    for (const c of k.checks) console.log(`     ${c.status.padEnd(15)} ${c.id.padEnd(20)} ${c.summary.slice(0, 140)}`);
    for (const u of v.unresolved) console.log(`     REVIEW ${u.id} [${u.kind}/${u.verdict}] ${u.t0}–${u.t1}s ${u.original}`);
    for (const i of k.issues) console.log(`     note ${i.severity} ${i.code}: ${i.message.slice(0, 150)}`);
    for (const c of k.usage?.calls ?? []) console.log(`     claude call ${c.call}: ${c.elapsed_s}s · models ${c.models_used} · in ${c.usage.input_tokens}+${c.usage.cache_creation_input_tokens}+${c.usage.cache_read_input_tokens} out ${c.usage.output_tokens} tokens · reported cost $${c.cost_usd_reported} (basis ${c.cost_basis}) · api key source ${c.api_key_source} · key in env ${c.api_key_in_env}`);
    console.log(`     fingerprint ${v.fingerprint.slice(0, 16)}…  approval ${v.approval ? 'present' : 'none'}  publication ${p.publication.allowed ? 'allowed' : 'BLOCKED'}`);
  };

  try {
    const fd = new FormData();
    fd.append('video', await fs.openAsBlob(src), path.basename(src));
    fd.append('options', JSON.stringify({ adapter: 'claude', exclude_ranges: exclude }));
    const t0 = Date.now();
    const up = await (await fetch(base + '/api/dana/studio/upload', { method: 'POST', body: fd })).json();
    const id = up.project.id;
    console.log(`\n== upload: project ${id}, adapter=claude, excluded ${JSON.stringify(exclude)} ==`);
    let p = await wait(id, 1); show(p);
    if (!p.version.package) { process.exitCode = 1; return; }
    console.log(`   wall time upload→package v1: ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    if (change) {
      console.log(`\n== TEST approval of v1 by "${TEST_ACTOR}" (to prove that a change invalidates it) ==`);
      if (p.version.unresolved.length) await api(`/projects/${id}/review-confirm`, 'POST', { ids: p.version.unresolved.map(u => u.id), by: TEST_ACTOR, watched: true, note: 'automated test confirmation — NOT an owner review' });
      const a = await api(`/projects/${id}/approve`, 'POST', { fingerprint: (await api('/projects/' + id)).body.project.version.fingerprint, by: TEST_ACTOR });
      console.log(`   approve → HTTP ${a.status}, approvalValid=${a.body.project?.version.approvalValid}, status=${a.body.project?.status}`);
      const fp1 = a.body.project.version.fingerprint;
      console.log(`\n== owner change request (free text): "${change}" ==`);
      const t1 = Date.now();
      const rc = await api(`/projects/${id}/request-changes`, 'POST', { note: change });
      console.log(`   request-changes → HTTP ${rc.status}, status=${rc.body.project.status}, currentVersion=${rc.body.project.currentVersion}`);
      p = await wait(id, 2); show(p);
      console.log(`   wall time change request→package v2: ${((Date.now() - t1) / 1000).toFixed(0)}s`);
      const v1 = p.versions.find(x => x.n === 1);
      console.log(`\n   INVALIDATION: v1 approved=${v1.approved} · v2 approval=${p.version.approval ? 'present' : 'none'} · fingerprint changed=${p.version.fingerprint !== fp1} · history: ${p.history.filter(h => ['approved', 'approval_invalidated', 'changes_requested'].includes(h.action)).map(h => h.action).join(' → ')}`);
    }
    console.log(`\n   review page: ${base}/dana-studio.html#${id}`);
  } finally {
    await new Promise(r => { worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
    server.close(); setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
