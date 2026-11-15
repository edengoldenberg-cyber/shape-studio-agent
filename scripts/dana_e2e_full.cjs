'use strict';
/**
 * dana_e2e_full.cjs — the complete connected workflow on a DISPOSABLE local test project.
 *
 *   node scripts/dana_e2e_full.cjs <source.mp4> [--exclude a-b,c-d] [--no-inject]
 *
 * Real:   upload, durable job, Dana's plan, the editing worker (GPU), Dana's review of the result,
 *         automatic revisions, the review package, approval binding.
 * MOCK:   the notification (recorded, not sent), the publisher (local stand-in API), the metrics.
 * TEST:   a labelled injected defect, a labelled test approver, a labelled test consent.
 * Nothing leaves this computer except the model calls made by the worker.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const TEST = 'TEST ACTOR (automated, not the owner)';
const step = (n, t) => console.log(`\n── ${String(n).padStart(2)}. ${t}`);
let failures = 0;
const check = (ok, text) => { console.log(`      ${ok ? 'OK  ' : 'FAIL'} ${text}`); if (!ok) failures++; };

async function main() {
  const src = path.resolve(process.argv[2]);
  const exclude = (arg('--exclude') || '').split(',').filter(Boolean).map(r => r.split('-').map(Number));
  const inject = !process.argv.includes('--no-inject');
  const dataDir = process.env.DANA_PREVIEW_DATA || 'C:/Users/owner/dana-work/e2e-full';
  const port = 3100 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const token = crypto.randomBytes(24).toString('hex');
  const mock = await require('./dana_mock_social_api.cjs').start({ port: 0 });
  const env = { ...process.env, DANA_PREVIEW_DATA: dataDir, PORT: String(port), DANA_WORKER_TOKEN: token, DANA_MOCK_PUBLISH_BASE: mock.base,
    DANA_MOCK_PUBLISH_TOKEN: mock.token, DANA_PUBLISH_TIMEOUT_MS: '1500', DANA_METRICS_OFFSETS_H: '48,168' };
  let server;
  const startServer = () => new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(__dirname, 'dana_studio_preview.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', d => { if (String(d).includes('Dana studio preview')) resolve(); });
    server.stderr.on('data', d => process.stdout.write('   [server!] ' + d));
    server.once('exit', c => reject(new Error('server exited ' + c)));
  });
  const kill = proc => new Promise(r => { if (!proc || proc.exitCode !== null) return r(); proc.removeAllListeners('exit'); proc.once('exit', r); spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']); });
  await startServer();
  const cfgPath = path.join(os.tmpdir(), `dana-worker-e2e-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(ROOT, 'dana-worker', 'worker.config.json'), 'utf8')), server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(ROOT, 'dana-worker', 'worker.py'), '--config', cfgPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stderr.on('data', d => process.stdout.write('   [worker!] ' + d));
  const api = async (p, method = 'GET', body) => { const r = await fetch(base + '/api/dana/studio' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const proj = async id => (await api('/projects/' + id)).body.project;
  const mockState = async () => (await fetch(mock.base + '/__state')).json();
  const control = body => fetch(mock.base + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    step(1, 'Upload creates a durable job');
    const fd = new FormData();
    fd.append('video', await fs.openAsBlob(src), path.basename(src));
    fd.append('options', JSON.stringify({ adapter: 'claude', exclude_ranges: exclude, ...(inject ? { test_inject: 'unverified_price_and_paraphrased_cover' } : {}) }));
    const t0 = Date.now();
    const up = await (await fetch(base + '/api/dana/studio/upload', { method: 'POST', body: fd })).json();
    const id = up.project.id;
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'dana', 'studio.json'), 'utf8'));
    check(!!onDisk.jobs[up.project.job.id] && !!onDisk.projects[id], `project ${id} and job ${up.project.job.id} are on disk (status ${onDisk.jobs[up.project.job.id].status})`);

    step(2, 'Dana plans → the editing worker drafts → Dana reviews the result → revisions (watch the stages)');
    let last = '', p;
    for (;;) {
      p = await proj(id); const line = `${p.status} · ${p.job?.note}`;
      if (line !== last) { console.log(`      [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}`); last = line; }
      if (['ready_for_review', 'failed', 'waiting'].includes(p.status) && !['queued', 'leased'].includes(p.job.status)) break;
      if (Date.now() - t0 > 2400e3) throw new Error('timeout');
      await sleep(2000);
    }
    if (!p.version.package) { console.log(`      NO PACKAGE: ${p.job.error?.code} ${p.job.error?.message}`); failures++; return; }
    const ed = p.version.package.editorial, v = p.version, k = v.package;
    const full = await (await fetch(`${base}/api/dana/studio/projects/${id}/versions/${v.n}/editorial`)).json();
    console.log(`      plan: objective="${ed.objective}"`);
    console.log(`            message="${k.segment.complete_thought}"`);
    console.log(`            source ${k.segment.in_s}–${k.segment.out_s}s (${k.duration}s) · spoken: ${full.plan.exact_spoken_text.slice(0, 140)}…`);
    console.log(`            brief: ${ed.brief.join(' | ')}`);
    console.log(`            verified facts: ${ed.verified_facts.join(' | ') || '—'} · missing: ${ed.missing_information.join(', ')}`);
    check(!!ed.objective && ed.brief.length > 0, 'plan and edit brief exist (step 2)');
    check(v.hasVideo && k.cards.length > 0, `the worker produced a draft: ${k.cards.length} cards, edit time ${k.totalSeconds}s (step 3)`);
    console.log(`      reviewer perceives: ${ed.perception.sees} · cannot: ${ed.perception.cannot[0]}`);
    for (const c of full.cycles) {
      console.log(`      cycle ${c.cycle}: ${c.findings.length} findings (${c.findings.filter(f => f.severity === 'blocking').length} blocking), sent to editor ${c.sent_to_editor.length}, frames at ${JSON.stringify(c.reviewer_frames_s)}, ${c.reused_render ? 'text-only change' : 'full render ' + c.edit_seconds + 's'}`);
      for (const f of c.findings.slice(0, 8)) console.log(`         [${f.severity}/${f.fix}/${f.source}] ${f.problem.slice(0, 110)}`);
      for (const x of c.verification_of_previous) console.log(`         verify ${x.id}: ${x.status} (${x.verified_by})${x.editor_said ? ' — editor: ' + x.editor_said.slice(0, 70) : ''}`);
      console.log(`         caption: ${c.caption}\n         cover:   ${c.cover_text}`);
    }
    check(full.cycles[0].reviewer_frames_s?.length > 0, 'Dana reviewed actual output: frames from the rendered file + transcription of its audio (step 4)');
    if (inject) {
      const c0 = full.cycles[0], c1 = full.cycles[1];
      check(!!ed.test_injection && /TEST INJECTION/.test(ed.test_injection.label), 'the injected defect is labelled as a test injection');
      check(c0.findings.some(f => f.key === 'issue:unverified_number') && c0.findings.some(f => f.key === 'issue:cover_not_quote'), 'cycle 0 detected the injected price and the paraphrased cover (step 5)');
      check(!!c1 && c1.verification_of_previous.filter(x => ['issue:unverified_number', 'issue:cover_not_quote'].some(key => c0.findings.find(f => f.id === x.id)?.key === key)).every(x => x.status === 'fixed'),
        'the editor corrected both and the re-measurement confirms it (step 5)');
      check(!/₪/.test(v.caption.text) && !k.issues.some(i => i.code === 'cover_text_not_a_quotation'), `final caption has no price; cover "${k.cover.text}" is a quotation`);
    }
    console.log(`      editorial status: ${ed.status} (${ed.stop_reason}), ${ed.revisions} revisions · budget ${ed.budget.cost_usd_reported}$ reported / ${ed.budget.seconds}s`);
    check(['ready_for_owner_review', 'stopped_with_issues'].includes(ed.status), `package reached "${ed.status}" (step 6)`);
    console.log(`      owner review items (${v.unresolved.length}): ${v.unresolved.map(u => `${u.id}[${u.verdict}]`).join(', ') || 'none'}`);
    for (const c of k.usage?.calls ?? []) console.log(`      model call ${c.call} (${c.role}): ${c.elapsed_s}s · ${c.models_used} · out ${c.usage.output_tokens} tok · images ${c.images} · reported $${c.cost_usd_reported} (${c.cost_basis}) · api key source ${c.api_key_source}`);

    step(7, 'Mocked "ready for review" notification, once');
    const notes = fs.readFileSync(path.join(dataDir, 'dana', 'notifications.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(n => n.projectId === id);
    check(notes.length === 1 && notes[0].mode === 'mock' && notes[0].to === '(mock — not sent)', `1 notification recorded, mode=${notes[0]?.mode}, to=${notes[0]?.to}`);
    console.log('      ' + notes[0].text.replace(/\n/g, '\n      '));

    step(8, `Approval by "${TEST}"`);
    const A = `/projects/${id}`;
    let r = await api(A + '/publish', 'POST', {});
    check(r.status === 409 && r.body.blocked.some(b => b.code === 'consent_missing') && r.body.blocked.some(b => b.code === 'not_approved'), `before approval and consent, publication is blocked: ${r.body.blocked.map(b => b.code).join(', ')}`);
    await api(A + '/package', 'PATCH', { account: 'test-account' });
    p = await proj(id);
    if (p.version.unresolved.length) await api(A + '/review-confirm', 'POST', { ids: p.version.unresolved.map(u => u.id), by: TEST, watched: true, note: 'TEST confirmation for engineering verification — NOT an owner review' });
    r = await api(A + '/approve', 'POST', { fingerprint: (await proj(id)).version.fingerprint, by: TEST });
    check(r.status === 200 && r.body.project.version.approvalValid, `approved, fingerprint ${r.body.project.version.fingerprint.slice(0, 12)}… scheduled ${r.body.project.version.scheduledLocal} (Asia/Jerusalem, proposed=${r.body.project.version.scheduleProposed})`);

    step(9, 'A subsequent change invalidates the approval');
    const fp1 = r.body.project.version.fingerprint;
    r = await api(A + '/package', 'PATCH', { caption: r.body.project.version.caption.text + ' (עריכת בדיקה)' });
    check(r.body.project.version.approval === null && r.body.project.status === 'ready_for_review' && r.body.project.version.fingerprint !== fp1, 'caption edited → approval removed, status back to ready_for_review, fingerprint changed');
    r = await api(A + '/publish', 'POST', {});
    check(r.status === 409 && r.body.blocked.some(b => b.code === 'not_approved'), 'publication refused without a valid approval');

    step(10, 'Re-approval, labelled TEST consent, scheduling → MOCK publication');
    await api(A + '/consent', 'POST', { status: 'confirmed', by: TEST, note: 'TEST ONLY — no real consent was obtained; valid for the mock publisher in this disposable project only' });
    r = await api(A + '/approve', 'POST', { fingerprint: (await proj(id)).version.fingerprint, by: TEST });
    r = await api(A + '/publish', 'POST', {});
    check(r.status === 200 && r.body.project.publication.record.state === 'scheduled' && r.body.project.publication.record.mode === 'mock', `scheduled for ${r.body.project.version.scheduledLocal} Israel time, mode=mock`);
    const due = Date.parse(r.body.project.version.scheduledAt) + 60e3;
    r = await api('/publisher/tick', 'POST', {});
    check((await mockState()).containers.length === 0, 'a tick before the scheduled time sends nothing');

    step(11, 'Restart and timeout must not duplicate the publication');
    await control({ containerPolls: 2, next: { publish: 'publish_then_timeout' } });
    await api('/publisher/tick', 'POST', { now: new Date(due).toISOString() });
    p = await proj(id);
    check(p.publication.record.state === 'processing' && !!p.publication.record.containerId, `container created (${p.publication.record.containerId}), provider still processing`);
    await kill(server); await startServer();
    p = await proj(id);
    check(p.publication.record.state === 'processing' && !!p.publication.record.containerId, 'server process RESTARTED: publication state and container id survived on disk');
    for (let i = 0; i < 3; i++) await api('/publisher/tick', 'POST', { now: new Date(due).toISOString() });
    p = await proj(id);
    let ms = await mockState();
    check(p.publication.record.state === 'uncertain', `publish request timed out → state "${p.publication.record.state}" (the mock DID create the post; Dana cannot know)`);
    check(ms.calls.filter(c => c.endsWith('/media_publish')).length === 1 && ms.media.length === 1, `further ticks did not publish again: ${ms.calls.filter(c => c.endsWith('/media_publish')).length} publish call, ${ms.media.length} post on the mock`);
    r = await api(A + '/publish/reconcile', 'POST', {});
    p = r.body.project; ms = await mockState();
    check(p.publication.record.state === 'published' && p.publication.record.mediaId === ms.media[0].id && p.publication.record.verification.via === 'reconciliation' && ms.media.length === 1 && ms.containers.length === 1,
      `reconciliation found the single post: media ${p.publication.record.mediaId}, permalink ${p.publication.record.permalink}, caption matches=${p.publication.record.verification.captionMatches} — 1 container, 1 post (MOCK)`);

    step(12, 'Mock metrics attached to the correct publication');
    const pubAt = Date.parse(p.publication.record.publishedAt);
    await api('/publisher/tick', 'POST', { now: new Date(pubAt + 49 * 3600e3).toISOString() });
    await api('/publisher/tick', 'POST', { now: new Date(pubAt + 8 * 24 * 3600e3).toISOString() });
    p = await proj(id);
    const m = p.publication.record.metrics;
    check(m.length === 2 && m.every(x => x.mediaId === p.publication.record.mediaId && x.source === 'MOCK'), `metrics at ${m.map(x => x.offsetHours + 'h').join(', ')} for media ${p.publication.record.mediaId}, source=MOCK: ${JSON.stringify(m[0]?.values)}`);
    const cal = (await api('/calendar')).body;
    console.log(`      calendar: ${cal.items.map(i => `${i.title} · ${i.scheduledLocal} ${cal.timezone} · ${i.state}`).join(' | ')}`);

    console.log(`\n   wall time: ${((Date.now() - t0) / 1000).toFixed(0)}s · review page (start the preview on ${dataDir}): /dana-studio.html#${id}`);
    console.log(`   RESULT: ${failures === 0 ? 'all steps passed' : failures + ' step(s) FAILED'}  — publication and metrics above are MOCK; approver and consent are TEST`);
  } finally {
    await kill(worker); await kill(server); mock.server.close();
    setTimeout(() => process.exit(failures ? 1 : 0), 300);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
