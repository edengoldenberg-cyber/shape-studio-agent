'use strict';
/**
 * dana_e2e_local.cjs — controlled LOCAL end-to-end runs with the REAL worker and pipeline.
 * Nothing leaves this computer: preview server on 127.0.0.1, mocked notifications, no publishing.
 *
 *   node scripts/dana_e2e_local.cjs dryrun  <source.mp4> [decisions.json]   upload → worker → edit → package
 *   node scripts/dana_e2e_local.cjs corrupt                                 unreadable source → failed render (actionable)
 *   node scripts/dana_e2e_local.cjs offline <source.mp4> [decisions.json]   upload with no worker; worker killed mid-job; recovery
 *   add --keep to leave the preview server running afterwards
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = f => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });

async function main() {
  const [mode, srcArg, decArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const keep = process.argv.includes('--keep');
  if (!['dryrun', 'corrupt', 'offline'].includes(mode)) { console.error('usage: dryrun <source> [decisions] | corrupt | offline <source> [decisions]'); process.exit(2); }
  const port = 3100 + Math.floor(Math.random() * 400);
  process.env.DANA_LEASE_SECONDS = mode === 'offline' ? '45' : '120';
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: process.env.DANA_PREVIEW_DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-e2e-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));

  let worker = null;
  const startWorker = () => {
    worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    worker.stdout.on('data', d => process.stdout.write('   [worker] ' + d.toString().replace(/\n(?=.)/g, '\n   [worker] ')));
    worker.stderr.on('data', d => process.stdout.write('   [worker!] ' + d));
  };
  const stopWorker = () => new Promise(r => { if (!worker || worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const upload = async (file, name, options) => {
    const fd = new FormData();
    fd.append('video', await fs.openAsBlob(file), name);
    if (options) fd.append('options', JSON.stringify(options));
    return api('/upload', { method: 'POST', body: fd });
  };
  const wait = async (id, until, timeoutS = 1500) => {
    const t0 = Date.now(); let last = '';
    for (;;) {
      const { body } = await api('/projects/' + id); const p = body.project; const line = `${p.status} · ${p.job?.status} · ${p.job?.stage} · ${p.job?.note}`;
      if (line !== last) { console.log(`   [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}  (worker ${body.worker.online ? body.worker.state : 'OFFLINE'})`); last = line; }
      if (until(p, body.worker)) return p;
      if (Date.now() - t0 > timeoutS * 1000) throw new Error('timeout waiting for ' + id);
      await sleep(1500);
    }
  };
  const summary = p => {
    const v = p.version;
    console.log(`\n   RESULT  status=${p.status}  version=${v.n}  job=${p.job.status}  attempts=${p.job.attempts}  edit time=${p.job.totalSeconds ?? '-'}s`);
    for (const c of v.package?.checks ?? []) console.log(`     ${c.status.padEnd(15)} ${c.id.padEnd(18)} ${c.summary.slice(0, 150)}`);
    console.log(`     unresolved (block approval): ${v.unresolved.map(u => u.id).join(', ') || 'none'}`);
    console.log(`     publication: ${p.publication.allowed ? 'allowed' : 'BLOCKED — ' + p.publication.blocked.map(b => b.code).join(', ')}`);
  };

  try {
    if (mode === 'corrupt') {
      const bad = path.join(os.tmpdir(), `dana-corrupt-${port}.mp4`);
      fs.writeFileSync(bad, Buffer.concat([Buffer.from('this is not a video file '), crypto.randomBytes(20000)]));
      startWorker();
      const up = await upload(bad, 'corrupt.mp4');
      console.log(`\n== failed render: unreadable source uploaded (HTTP ${up.status}) ==`);
      const p = await wait(up.body.project.id, x => ['failed', 'ready_for_review'].includes(x.status), 180);
      console.log(`\n   RESULT  status=${p.status}  error=${p.job.error?.code}: ${p.job.error?.message}  attempts=${p.job.attempts}  hasVideo=${p.version.hasVideo}`);
      if (p.status !== 'failed') process.exitCode = 1;
    } else {
      const src = path.resolve(srcArg);
      const before = await sha(src);
      const options = decArg ? { decisions: JSON.parse(fs.readFileSync(decArg, 'utf8')) } : undefined;
      if (options) delete options.decisions.notes;
      if (mode === 'dryrun') startWorker();
      console.log(`\n== ${mode}: uploading ${path.basename(src)} (${(fs.statSync(src).size / 1048576).toFixed(0)}MB) ==`);
      const t0 = Date.now();
      const up = await upload(src, path.basename(src), options);
      const id = up.body.project.id;
      console.log(`   upload HTTP ${up.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s · duplicate=${up.body.duplicate} · project ${id} · sha ${up.body.project.source.sha256.slice(0, 12)}…`);
      const dup = await upload(src, 'same-file-again.mp4');
      console.log(`   second upload of the same file → HTTP ${dup.status} duplicate=${dup.body.duplicate} same project=${dup.body.project.id === id}`);
      if (mode === 'offline') {
        console.log('\n== worker offline: no worker is running ==');
        await sleep(4000);
        await wait(id, (p, w) => p.job.status === 'queued' && !w.online, 20);
        console.log('== worker starts ==');
        startWorker();
        await wait(id, p => p.job.status === 'leased' && /render|composite|verify|transcribe/.test(p.job.stage || ''), 900);
        console.log('== worker KILLED in the middle of the job ==');
        await stopWorker();
        await wait(id, (p, w) => !w.online, 60);
        console.log('== worker restarts ==');
        startWorker();
      }
      const p = await wait(id, x => ['ready_for_review', 'failed', 'waiting'].includes(x.status) && !['queued', 'leased'].includes(x.job.status));
      summary(p);
      console.log(`     source hash on disk before/after: ${before === await sha(src) ? 'UNCHANGED' : 'CHANGED!'} (${before.slice(0, 12)}…)`);
      const head = await fetch(`${base}/api/dana/studio/projects/${id}/versions/${p.version.n}/video`, { headers: { Range: 'bytes=0-1023' } });
      console.log(`     video Range request → HTTP ${head.status} ${head.headers.get('content-range')}`);
      console.log(`     total wall time upload→package: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      console.log(`     review page: ${base}/dana-studio.html#${id}`);
      if (p.status !== 'ready_for_review') process.exitCode = 1;
    }
  } finally {
    await stopWorker();
    if (keep) console.log(`\npreview server left running on ${base} — Ctrl+C to stop`);
    else { server.close(); setTimeout(() => process.exit(process.exitCode || 0), 300); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
