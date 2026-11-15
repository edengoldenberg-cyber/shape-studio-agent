'use strict';
/**
 * dana_e2e_phase3.cjs — LOCAL end-to-end proof, through the real server routes and the real worker:
 *   1. reference: upload a video + note → the worker analyses it → proposal → approval → default profile
 *   2. a new project is planned, rendered and reviewed WITH that approved profile (and says so)
 *   3. a revision with no note (caption correction, size, one zoom removed) changes ONLY those things
 *   4. a note marked "standing rule" becomes a versioned rule and is loaded by the NEXT project
 * Nothing leaves this computer: preview server on 127.0.0.1, mocked notifications, no publishing.
 * Every owner action here is made by a TEST actor and labelled as a test; nothing is approved for the owner.
 *
 *   node scripts/dana_e2e_phase3.cjs --reference <video> --raw <raw clip> --second <another clip>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  →  ' + detail : ''}`); };

(async () => {
  const [refFile, rawFile, secondFile] = [arg('--reference'), arg('--raw'), arg('--second')].map(f => path.resolve(f));
  const port = 3100 + Math.floor(Math.random() * 400);
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: process.env.DANA_PREVIEW_DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-p3-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8')), server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', d => process.stdout.write('   [worker] ' + d.toString().replace(/\n(?=.)/g, '\n   [worker] ')));
  worker.stderr.on('data', d => { const t = d.toString(); if (!/W0000|INFO: Created TensorFlow/.test(t)) process.stdout.write('   [worker!] ' + t); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const upload = async (file, name) => { const fd = new FormData(); fd.append('video', await fs.openAsBlob(file), name); return api('/upload', { method: 'POST', body: fd }); };
  const wait = async (id, n, timeoutS = 1800) => {
    const t0 = Date.now(); let last = '';
    for (;;) {
      const { body } = await api('/projects/' + id); const p = body.project;
      const line = `v${p.currentVersion} ${p.status} · ${p.job?.status}`;
      if (line !== last) { console.log(`   [${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line} · ${p.job?.note ?? ''}`); last = line; }
      if (p.currentVersion === n && ['ready_for_review', 'failed', 'waiting'].includes(p.status) && !['queued', 'leased'].includes(p.job.status)) return p;
      if (Date.now() - t0 > timeoutS * 1000) throw new Error('timeout');
      await sleep(2500);
    }
  };
  const segs = pk => JSON.stringify((pk.plan?.segments || []).map(s => [s.source_in_s, s.source_out_s]));
  const zoomMap = pk => Object.fromEntries((pk.zooms || []).map(z => [z.id, [z.tl_t_s, z.hold_until_s, z.scale]]));
  try {
    // ── 1. reference → analysis → proposal → approval ──
    console.log('\n== 1. reference: upload + note (TEST actor) ==');
    const fd = new FormData();
    fd.append('file', await fs.openAsBlob(refFile), 'reference-test.mp4');
    for (const [k, v] of Object.entries({ title: 'רפרנס בדיקה (הקליפ הערוך של הסטודיו)', usage_permission: 'own', origin: 'בדיקת מערכת מקומית',
      owner_note: '[בדיקת מערכת — לא הערה של הבעלים] כתוביות גדולות בשורה אחת במרכז', by: 'TEST' })) fd.append(k, v);
    const added = await api('/references', { method: 'POST', body: fd });
    const refId = (added.body.reference ?? (added.body.references || []).slice(-1)[0])?.id;
    console.log(`   HTTP ${added.status} reference ${refId}`);
    let ref; const t0 = Date.now();
    for (;;) {
      ref = ((await api('/references')).body.references || []).find(r => r.id === refId);
      if (['analysed', 'analysis_failed'].includes(ref?.status)) break;
      if (Date.now() - t0 > 600000) throw new Error('reference analysis timeout');
      await sleep(3000);
    }
    const an = ref.analysis || {};
    console.log(`   status=${ref.status} after ${((Date.now() - t0) / 1000).toFixed(0)}s · aspects=${(an.aspects || []).length} · proposed params=${JSON.stringify(an.proposed_profile?.params)}`);
    console.log(`   rules: ${JSON.stringify(an.proposed_profile?.rules)}`);
    check('reference was analysed by the worker', ref.status === 'analysed');
    check('every aspect has a basis label and sound is only a hypothesis', (an.aspects || []).length >= 5 && (an.aspects || []).every(a => ['measured', 'seen_in_stills', 'hypothesis'].includes(a.basis))
      && (an.aspects || []).filter(a => a.aspect === 'sound').every(a => a.basis === 'hypothesis'));
    check('example times exist and lie inside the reference', (an.aspects || []).some(a => a.example_times_s.length) && (an.aspects || []).every(a => a.example_times_s.every(t => t >= 0 && t <= an.measured.duration_s)));
    check('nothing is a default before approval', !(await api('/references')).body.default);
    const ap = await post(`/references/${refId}/approve-profile`, { by: 'TEST', make_default: true });
    const def = (await api('/references')).body.default;
    console.log(`   approve HTTP ${ap.status} → default profile ${def?.id} v${def?.version} from reference ${def?.source_reference}`);
    check('approval creates a versioned default profile that names its reference', ap.status === 200 && def?.source_reference === refId && def?.version === 1);
    const prm = def?.params || {};

    // ── 2. a new project uses the approved profile ──
    console.log('\n== 2. new project with the approved profile ==');
    const up = await upload(rawFile, 'הדגמה חומר גלם.mp4');
    const id = up.body.project.id;
    const p1 = await wait(id, 1);
    const k1 = p1.version.package;
    console.log(`   v1: mode=${k1.judgementMode} parts=${segs(k1)} zooms=${JSON.stringify(zoomMap(k1))} style=${JSON.stringify(k1.style)}`);
    console.log(`   rules_used: profile=${JSON.stringify(k1.rulesUsed?.profile && { id: k1.rulesUsed.profile.id, version: k1.rulesUsed.profile.version, status: k1.rulesUsed.profile.status })} references=${JSON.stringify(k1.rulesUsed?.references)} profile_rules=${(k1.rulesUsed?.profile_rules || []).length}`);
    check('package says which profile and reference it was edited by', k1.rulesUsed?.profile?.id === def.id && String(k1.rulesUsed?.profile?.version) === '1' && (k1.rulesUsed?.references || []).includes(refId));
    check('the profile numbers reached the render (caption size, lines)', (prm.caption_size == null || k1.style.caption_size === prm.caption_size) && (prm.caption_max_lines == null || k1.style.caption_max_lines === prm.caption_max_lines),
      `size ${k1.style.caption_size} lines ${k1.style.caption_max_lines}`);
    check('zoom strengths follow the profile', (k1.zooms || []).every(z => [prm.zoom_scale_light, prm.zoom_scale_medium, prm.zoom_scale_strong, 1.08, 1.15, 1.25].includes(z.scale)), JSON.stringify((k1.zooms || []).map(z => z.scale)));
    check('quality is reported in separate groups, not one score', !!k1.quality?.technical && !!k1.quality?.content_review && !!k1.quality?.owner_needed && Array.isArray(k1.quality?.not_verified));

    // ── 3. revision with no note: only what was asked changes ──
    console.log('\n== 3. revision without a note (TEST actor): one caption, size, one zoom ==');
    const card = k1.cards[1];
    const zs = k1.zooms || [];
    const drop = zs.length > 1 ? zs[zs.length - 1] : null;
    const newSize = Math.min(130, k1.style.caption_size + 8);
    const rv = await post(`/projects/${id}/revise`, { by: 'TEST',
      caption_edits: [{ source_start_s: card.source_start_s, source_end_s: card.source_end_s, original: card.text, text: card.text.replace(/[,.]/g, '') + ' ממש' }],
      style_overrides: { caption_size: newSize }, zoom_edits: drop ? [{ id: drop.id, action: 'remove' }] : [] });
    if (rv.status !== 200) throw new Error('revise refused: ' + JSON.stringify(rv.body).slice(0, 200));
    const p2 = await wait(id, 2);
    const k2 = p2.version.package;
    const z1 = zoomMap(k1), z2 = zoomMap(k2);
    console.log(`   v2: revision_mode=${k2.revisionMode} parts=${segs(k2)} zooms=${JSON.stringify(z2)} size=${k2.style?.caption_size}`);
    check('revision is locked to the previous plan (no re-planning)', k2.revisionMode === 'locked_to_previous_plan');
    check('same parts', segs(k1) === segs(k2));
    check('same message', k1.plan.message === k2.plan.message);
    check('the removed zoom is gone and every other zoom is identical', (!drop || !(drop.id in z2)) && Object.keys(z2).every(i => JSON.stringify(z1[i]) === JSON.stringify(z2[i])) && Object.keys(z2).length === Object.keys(z1).length - (drop ? 1 : 0));
    const w1 = k1.cards.map(c => c.text).join(' ').split(' '), w2 = k2.cards.map(c => c.text).join(' ').split(' ');
    check('only the corrected caption changed its words', w2.join(' ') === w1.join(' ').replace(card.text, card.text.replace(/[,.]/g, '') + ' ממש'), `${w1.length}→${w2.length} words`);
    check('size change applied', k2.style.caption_size === newSize);
    check('same publication caption and cover text', p1.version.caption?.text === p2.version.caption?.text && k1.cover.text === k2.cover.text);
    const ids1 = new Set((k1.editorial ? p1.version.unresolved ?? [] : []).map(String));
    check('the owner correction is kept and reported as information', (k2.transcript?.corrections_applied || []).length === 1 && k2.cards.some(c => c.text.includes('ממש')));
    check('the correction did not open new warnings', (p2.version.unresolved ?? []).length <= (p1.version.unresolved ?? []).length, `${(p1.version.unresolved ?? []).length} → ${(p2.version.unresolved ?? []).length}`);
    check('version 1 is still playable for comparison', (await fetch(`${base}/api/dana/studio/projects/${id}/versions/1/video`, { headers: { Range: 'bytes=0-99' } })).status === 206);

    // ── 4. standing rule → next project ──
    console.log('\n== 4. a note marked as a standing rule (TEST actor), then a NEW project ==');
    const ruleText = '[כלל בדיקה] לא לפתוח סרטון בהצגה עצמית בשם';
    const r3 = await post(`/projects/${id}/revise`, { by: 'TEST', note: ruleText, note_scope: 'permanent' });
    const rules = (await api('/rules')).body.rules || [];
    const rule = rules.find(r => r.text === ruleText);
    console.log(`   revise HTTP ${r3.status} · rule ${rule?.id} v${rule?.version} source=${JSON.stringify(rule?.source && { project: rule.source.project_id, version: rule.source.version_n, by: rule.source.by })}`);
    check('the note became ONE versioned rule with its source', !!rule && rule.version === 1 && rule.source?.project_id === id);
    const up2 = await upload(secondFile, 'פרויקט שני.mp4');
    const id2 = up2.body.project.id;
    const q = await wait(id2, 1);
    const kq = q.version.package;
    console.log(`   second project: mode=${kq?.judgementMode} standing_rules=${JSON.stringify(kq?.rulesUsed?.standing_rules)} profile=${kq?.rulesUsed?.profile?.id} hook="${kq?.plan?.hook}"`);
    check('the next project loaded the standing rule with its version', (kq?.rulesUsed?.standing_rules || []).some(r => (r.id ?? r) === rule.id && (r.version ?? 1) === 1));
    check('the next project also used the approved profile', kq?.rulesUsed?.profile?.id === def.id);

    console.log(`\n   review pages: ${base}/dana-studio.html#${id}   ${base}/dana-studio.html#${id2}`);
    console.log(`\n== ${results.filter(Boolean).length} passed, ${results.filter(x => !x).length} failed ==`);
    if (results.some(x => !x)) process.exitCode = 1;
  } catch (e) {
    console.error('[ERROR]', e.message); process.exitCode = 1;
  } finally {
    spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); server.close(); fs.rmSync(cfgPath, { force: true });
  }
})();
