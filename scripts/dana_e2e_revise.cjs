'use strict';
/**
 * dana_e2e_revise.cjs — LOCAL end-to-end proof of the real path: panel upload (no adapter named) →
 * worker → content plan by the model → edit → review → package, then the owner's "produce a corrected
 * version" (a caption correction by time, a style change, one zoom removed, a note) → version 2.
 * Nothing leaves this computer: preview server on 127.0.0.1, mocked notifications, no publishing.
 * The edits are made by a TEST actor and are labelled as such.
 *
 *   node scripts/dana_e2e_revise.cjs <source.mp4> [--name "<file name to upload as>"] [--keep]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };

(async () => {
  const src = path.resolve(process.argv[2]);
  const name = arg('--name') || path.basename(src);
  const keep = process.argv.includes('--keep');
  const port = 3100 + Math.floor(Math.random() * 400);
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: process.env.DANA_PREVIEW_DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-revise-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8')), server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', d => process.stdout.write('   [worker] ' + d.toString().replace(/\n(?=.)/g, '\n   [worker] ')));
  worker.stderr.on('data', d => process.stdout.write('   [worker!] ' + d));
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const wait = async (id, n, timeoutS = 1800) => {
    const t0 = Date.now(); let last = '';
    for (;;) {
      const { body } = await api('/projects/' + id); const p = body.project;
      const line = `v${p.currentVersion} ${p.status} · ${p.job?.status} · ${p.job?.note ?? ''}`;
      if (line !== last) { console.log(`   [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}`); last = line; }
      if (p.currentVersion === n && ['ready_for_review', 'failed', 'waiting'].includes(p.status) && !['queued', 'leased'].includes(p.job.status)) return p;
      if (Date.now() - t0 > timeoutS * 1000) throw new Error('timeout');
      await sleep(2000);
    }
  };
  const show = (label, p) => {
    const pk = p.version.package || {};
    console.log(`\n== ${label}: status=${p.status} version=${p.version.n} title="${p.title}" file="${p.source?.originalName}"`);
    console.log(`   judgement_mode=${pk.judgementMode ?? pk.judgement_mode} duration=${pk.duration}s parts=${(pk.plan?.segments || []).length} zooms=${(pk.zooms || []).map(z => `${z.id}@${z.tl_t_s}x${z.scale}`).join(', ') || 'none'}`);
    console.log(`   message: ${pk.plan?.message}`);
    console.log(`   style: ${JSON.stringify(pk.style)}  profile: ${pk.rules_used?.profile?.id ?? pk.rulesUsed?.profile?.id} skill: ${(pk.rules_used ?? pk.rulesUsed)?.skill?.version}`);
    console.log(`   cards: ${(pk.cards || []).length}  first: ${(pk.cards || []).slice(0, 3).map(c => c.text).join(' | ')}`);
    console.log(`   editorial: ${pk.editorial?.status} / ${pk.editorial?.stop_reason} revisions=${pk.editorial?.revisions}  checks not passed: ${JSON.stringify((pk.checks || []).filter(c => !["pass", "human_required", "info"].includes(c.status)).map(c => c.id + ":" + c.status))}`);
    console.log(`   doubts: ${(pk.transcript?.doubts || []).length}  corrections applied: ${JSON.stringify(pk.transcript?.corrections_applied || [])}`);
  };
  try {
    console.log(`== upload "${name}" (${(fs.statSync(src).size / 1048576).toFixed(0)}MB), no adapter named ==`);
    const fd = new FormData();
    fd.append('video', await fs.openAsBlob(src), name);
    const up = await api('/upload', { method: 'POST', body: fd });
    const id = up.body.project.id;
    console.log(`   HTTP ${up.status} project ${id} stored title "${up.body.project.title}" adapter=${JSON.stringify(up.body.project.adapter)}`);
    const p1 = await wait(id, 1);
    show('VERSION 1', p1);
    const pk = p1.version.package;
    if (p1.status !== 'ready_for_review' || !pk?.cards?.length) throw new Error('version 1 is not reviewable');
    const card = pk.cards[1];
    const zoom = (pk.zooms || [])[1] ?? (pk.zooms || [])[0];
    const body = {
      by: 'TEST',
      caption_edits: card.source_start_s != null ? [{ source_start_s: card.source_start_s, source_end_s: card.source_end_s, original: card.text, text: card.text.replace(/[,.]/g, '') + ' [בדיקה]' }] : [],
      style_overrides: { caption_size: 104 },
      zoom_edits: zoom ? [{ id: zoom.id, action: 'remove' }] : [],
      note: 'בדיקת מערכת: לשמור על אותו מסר ואותם חלקים', note_scope: 'project',
    };
    console.log(`\n== owner-style revision (TEST actor): edit card 2 "${card.text}", caption_size 104, remove zoom ${zoom?.id ?? '(none)'} ==`);
    const rv = await post(`/projects/${id}/revise`, body);
    console.log(`   revise HTTP ${rv.status} ${JSON.stringify(rv.body).slice(0, 200)}`);
    if (rv.status !== 200) throw new Error('revise was refused');
    const p2 = await wait(id, 2);
    show('VERSION 2', p2);
    const pk2 = p2.version.package;
    const ok = {
      'style applied (size 104)': pk2.style?.caption_size === 104,
      'correction applied': (pk2.transcript?.corrections_applied || []).length === 1 && (pk2.cards || []).some(c => c.text.includes('[בדיקה]')),
      'zoom removed': !zoom || !(pk2.zooms || []).some(z => z.id === zoom.id),
      'previous approval gone / new version current': p2.currentVersion === 2,
      'both versions playable': (await fetch(`${base}/api/dana/studio/projects/${id}/versions/1/video`, { headers: { Range: 'bytes=0-99' } })).status === 206
        && (await fetch(`${base}/api/dana/studio/projects/${id}/versions/2/video`, { headers: { Range: 'bytes=0-99' } })).status === 206,
    };
    console.log('\n== checks ==');
    for (const [k, v] of Object.entries(ok)) console.log(`   ${v ? 'PASS' : 'FAIL'}  ${k}`);
    console.log(`\n   review page: ${base}/dana-studio.html#${id}`);
    if (Object.values(ok).some(v => !v)) process.exitCode = 1;
    if (keep) { console.log('   (--keep) server left running; Ctrl+C to stop'); await new Promise(() => {}); }
  } catch (e) {
    console.error('[ERROR]', e.message); process.exitCode = 1;
  } finally {
    if (!keep) { spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); server.close(); fs.rmSync(cfgPath, { force: true }); }
  }
})();
