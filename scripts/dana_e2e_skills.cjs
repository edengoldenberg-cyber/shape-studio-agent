'use strict';
/**
 * dana_e2e_skills.cjs — acceptance of the editing-skill library, through the page's own HTTP API with the REAL worker.
 * Local only: preview server on 127.0.0.1, mocked notifications, publishing off.
 *
 *   node scripts/dana_e2e_skills.cjs <second-raw-clip.mp4> [--only=a,b] [--keep]
 *
 * Needs a data folder (DANA_PREVIEW_DATA) that already holds: at least one ANALYSED reference and one finished raw-footage
 * project (as left by scripts/dana_e2e_round2.cjs).
 *
 *   a  reference analysis → skill draft → TEST approval → another clip edited by it → reviewed by the same skill
 *   b  written instructions → skill draft → TEST approval + default → used automatically by a different project
 * and: a draft never becomes a default, and a new skill version does not change an existing project.
 *
 * Every approval here is made by a TEST ACTOR. No skill or style is approved in the owner's name.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA || 'C:/Users/owner/dana-work/e2e-round3';
const OUT = path.join(DATA, 'evidence-skills');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress-skills.log'), line + '\n'); };
function check(id, name, ok, detail) { results.push({ id, name, ok: !!ok, detail: detail ?? null }); log(`   ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 420) : ''}`); }

async function main() {
  const [clipB] = process.argv.slice(2).filter(a => !a.startsWith('--')).map(a => path.resolve(a));
  const only = (process.argv.find(a => a.startsWith('--only=')) || '--only=a,b').slice(7).split(',');
  const keep = process.argv.includes('--keep');
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || 3194;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-e2e-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const st of [worker.stdout, worker.stderr]) st.on('data', d => fs.appendFileSync(path.join(DATA, 'worker-skills.log'), d));
  const stopWorker = () => new Promise(r => { if (worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const send = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const project = async id => (await api('/projects/' + id)).body.project;
  const wait = async (id, timeoutS, label) => { const t0 = Date.now(); let last = '';
    for (;;) { const p = await project(id); const line = `${p.status} · ${p.job?.status} · ${p.job?.note}`;
      if (line !== last) { log(`   ${label} [${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
      if (!['queued', 'leased'].includes(p.job?.status)) return { p, seconds: Math.round((Date.now() - t0) / 1000) };
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`); await sleep(2500); } };
  const jobDir = jobId => path.join(cfg.paths.work_root, 'jobs', `${jobId}_a1`);
  const promptOf = (jobId, name) => { try { return fs.readFileSync(path.join(jobDir(jobId), name), 'utf8'); } catch { return ''; } };
  const copy = (id, n, art, name) => { try { fs.copyFileSync(path.join(DATA, 'dana', 'projects', id, `v${n}`, art), path.join(OUT, name)); return true; } catch { return false; } };
  const summary = { base, data: DATA };

  try {
    const st = (await api('/status')).body;
    check('0.1', 'publishing is off and notifications are mocked', st.publishingEnabled === false && st.notifications === 'mock');
    await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 30000) { const w = (await api('/status')).body.worker; if (w.online && w.capabilities) return; await sleep(1000); } })();
    const caps = (await api('/status')).body.worker.capabilities;
    check('0.2', 'the worker reports what it can really do on this machine', !!caps && typeof caps.hyperframes === 'boolean' && !!caps.content_model, caps);
    const refs = (await api('/references')).body.references.filter(r => r.analysis);
    const raw = (await api('/projects')).body.projects.find(p => p.kind !== 'review_only' && p.status === 'ready_for_review');
    if (!refs.length || !raw) throw new Error('the data folder needs an analysed reference and a finished raw-footage project');
    const rawBefore = await project(raw.id);

    // ── A: reference analysis → skill → another clip ────────────────────────
    if (only.includes('a')) {
      log('== A: skill from analysis ==');
      const ref = refs[0], cmp = (await send('/references/compare', { ids: [ref.id], single: true })).body.comparison;
      const aspects = cmp.aspects.flatMap(a => a.by_reference.filter(x => x.observation).map(x => ({ ref: x.ref, aspect: a.aspect })));   // everything, hypotheses and unsupported areas included
      const params = Object.fromEntries(Object.entries(cmp.proposal.params).map(([k, v]) => [k, v.options[0].ref]));
      const made = await send('/skills/from-analysis', { by: ACTOR, name: 'בדיקה: סקיל מניתוח הרפרנס', ids: [ref.id], picks: { aspects, params } });
      const sid = made.body.skill?.id, d = made.body.skill?.draft;
      check('A.1', '"צור סקיל מהניתוח": a draft with a readable structure (purpose, suitable videos, rules, parameters, review criteria)', made.status === 201 && d && d.purpose && d.rules.length > 3 && Object.keys(d.params).length > 0 && d.criteria.length > 0,
        d && { rules: d.rules.length, params: d.params, criteria: d.criteria.length, counts: d.counts });
      check('A.2', 'every rule is tied to a finding of the reference (aspect, observation, example times)', d.rules.every(r => r.source.type === 'reference' && r.source.ref === ref.id && r.source.aspect && r.source.observation),
        d.rules.slice(0, 3).map(r => ({ aspect: r.source.aspect, times: r.source.times_s, basis: r.basis })));
      const hyp = d.rules.filter(r => r.basis === 'hypothesis'), uns = d.rules.filter(r => r.support === 'unsupported');
      check('A.3', 'measurement / stills / model assessment / hypothesis are kept apart, and a hypothesis is NOT an active rule', [...new Set(d.rules.map(r => r.basis))].length >= 3 && hyp.length > 0 && hyp.every(r => !r.active), d.rules.map(r => `${r.domain}:${r.basis}:${r.active ? 'on' : 'off'}`));
      check('A.4', 'a rule the worker cannot carry out is marked unsupported and is never active', uns.length > 0 && uns.every(r => !r.active) && d.fully_supported === false, uns.map(r => `${r.domain}: ${r.support_note}`));
      check('A.5', 'the skill is saved in the existing skill shape: SKILL.md, profile.json, criteria.json', ['SKILL.md', 'profile.json', 'criteria.json'].every(f => fs.existsSync(path.join(DATA, 'dana', 'skills', sid, 'v1', f))));
      check('A.6', 'a draft cannot be made the default and cannot be chosen for a project', (await send(`/skills/${sid}/default`, { by: ACTOR })).body.error === 'not_approved'
        && (await send(`/projects/${raw.id}/settings`, { skill: { mode: 'pinned', id: sid } }, 'PATCH')).body.error === 'not_approved' && (await api('/skills')).body.skills.every(k => !k.default));
      const ap = await send(`/skills/${sid}/approve`, { by: ACTOR });
      check('A.7', 'TEST approval (not the owner): approved, versioned, with history; not a default', ap.body.skill?.status === 'approved' && ap.body.skill.default === false && ap.body.skill.approved.approvedBy === ACTOR, { version: ap.body.skill?.approved?.version, by: ap.body.skill?.approved?.approvedBy });
      const s1 = ap.body.skill.approved;
      // another clip: the raw-footage project (not the reference)
      const r = await send(`/projects/${raw.id}/apply-skill`, { by: ACTOR, skill: { mode: 'pinned', id: sid } });
      check('A.8', 'applying the skill to another clip queues a NEW version; the existing one is kept and its approval is dropped', r.status === 200 && r.body.project.currentVersion === rawBefore.currentVersion + 1 && r.body.project.shown.n === rawBefore.currentVersion,
        { current: r.body.project?.currentVersion, shown: r.body.project?.shown?.n });
      check('A.9', 'while the new version is produced, the previous version and its review stay on screen (marked as not current)', r.body.project.version.package.danaReview && r.body.project.review.upToDate === false, r.body.project.review?.stale);
      const w = await wait(raw.id, 1500, 'raw + analysis skill'); const p = w.p, pk = p.version.package, rep = pk?.skillReport;
      check('A.10', 'the clip was edited: package ready', p.status === 'ready_for_review' && p.shown.isCurrent, { status: p.status, error: p.job?.error, seconds: w.seconds });
      if (rep) {
        const story = promptOf(p.job.id, 'claude_prompt_story_a1.txt'), rv = fs.readdirSync(jobDir(p.job.id)).filter(f => /^claude_prompt_review\d+\.txt$/.test(f)).map(f => promptOf(p.job.id, f)).join('\n');
        const act = s1.rules.filter(x => x.active);
        check('A.11', 'PLANNING: the active rules of the skill were in the content planner\'s input; inactive ones were not', act.every(x => story.includes(x.text)) && s1.rules.filter(x => !x.active).every(x => !story.includes(x.text)), { active: act.length, in_prompt: act.filter(x => story.includes(x.text)).length });
        check('A.12', 'RENDERING: the skill\'s parameters are the style the video was rendered with', rep.params.length > 0 && rep.params.filter(x => !x.applied).every(x => x.note), rep.params.map(x => `${x.key}: skill ${x.skill} / used ${x.used}`));
        check('A.13', 'REVIEW: the reviewer was asked about the skill and judged every active rule and criterion', rv.includes('<editing_skill>') && rep.rules.filter(x => x.status !== 'unsupported').every(x => ['applied', 'not_followed', 'not_applicable', 'not_checked'].includes(x.status)) && rep.criteria.length === s1.criteria.length,
          rep.summary);
        check('A.14', 'the package records the skill version and, rule by rule, applied / not followed / not applicable / unsupported', pk.rulesUsed.library_skill?.id === sid && pk.rulesUsed.library_skill.version === 1 && rep.rules.some(x => x.status === 'unsupported') && rep.summary.fully_applied === false,
          rep.rules.map(x => `${x.id}:${x.status}`));
        check('A.15', 'the review of the new version says which version and file it belongs to, and is up to date', p.review.versionN === p.currentVersion && p.review.onFinalFile === true && p.review.upToDate === true && p.review.librarySkill?.id === sid, { version: p.review.versionN, onFinalFile: p.review.onFinalFile, at: p.review.reviewedAt });
        fs.writeFileSync(path.join(OUT, 'A_skill_report.json'), JSON.stringify({ skill: ap.body.skill.approved, report: rep, review: p.review }, null, 1));
        fs.writeFileSync(path.join(OUT, 'A_SKILL.md'), s1.skill_md);
        copy(raw.id, p.currentVersion, 'final.mp4', 'A_clip_edited_by_analysis_skill.mp4'); copy(raw.id, p.currentVersion, 'compare_clip.mp4', 'A_before_after_clip.mp4');
      }
      // a new version of the skill does not change the project
      const edited = await send(`/skills/${sid}`, { by: ACTOR, add_rules: [{ text: 'כלל בדיקה שנוסף בגרסה 2', domain: 'other' }] }, 'PUT');
      await send(`/skills/${sid}/approve`, { by: ACTOR });
      const after = await project(raw.id), k2 = (await api(`/skills/${sid}`)).body.skill;
      check('A.16', 'a new approved version of the skill changes neither the existing project version nor the version the project is pinned to',
        k2.versions.map(v => v.version).join() === '1,2' && after.skill.version === 1 && after.currentVersion === p.currentVersion && after.version.package.skillReport?.skill.version === 1 && edited.status === 200,
        { skillVersions: k2.versions.map(v => `${v.version}:${v.status}`), projectPinned: after.skill.version, packageSkill: after.version.package.skillReport?.skill.version });
      summary.a = { skill: sid, project: raw.id, version: p.currentVersion, report: rep?.summary };
    }

    // ── B: written instructions → skill → a different project, automatically ─
    if (only.includes('b')) {
      log('== B: skill from instructions ==');
      const prompt = 'לפתוח במשפט הכי חזק של הדוברת, לא בהצגה עצמית. כתוביות בשורה אחת בגודל 84, בלי הדגשות צבע. בלי זומים בכלל ובלי מואושן גרפיק. להוסיף מוזיקת רקע שקטה. וגם: הדגשות צבע צהובות על מילות המפתח.';
      const made = await send('/skills/from-prompt', { by: ACTOR, name: 'בדיקה: עדות נקייה', prompt });
      const sid = made.body.skill?.id;
      check('B.1', '"צור סקיל מהוראות": the instructions are saved under a name and sent to the worker for drafting', made.status === 201 && made.body.skill.status === 'drafting');
      const t0 = Date.now(); let k;
      for (;;) { k = (await api(`/skills/${sid}`)).body.skill; if (k.status !== 'drafting') break; if (Date.now() - t0 > 600e3) throw new Error('timeout waiting for the skill draft'); await sleep(3000); }
      const d = k.draft;
      check('B.2', 'a readable draft came back and stays a DRAFT (nothing was approved automatically)', k.status === 'draft' && d && d.purpose && d.rules.length >= 4 && d.criteria.length > 0 && !k.default, d && { seconds: Math.round((Date.now() - t0) / 1000), purpose: d.purpose, rules: d.rules.map(r => `${r.domain}:${r.support}`), params: d.params });
      if (!d) throw new Error('no draft: ' + JSON.stringify(k.draft?.error || k.status));
      check('B.3', 'the instruction the worker cannot carry out (music) is marked unsupported; the skill is not shown as fully supported', d.rules.some(r => r.support === 'unsupported' && /מוזיק/.test(r.text)) && d.fully_supported === false, d.rules.filter(r => r.support === 'unsupported').map(r => `${r.text} — ${r.support_note}`));
      check('B.4', 'numbers stated in the instructions became parameters', d.params.caption_size === 84 && d.params.caption_max_lines === 1, d.params);
      check('B.5', 'the contradiction inside the instructions (no highlights / yellow highlights) is listed with a proposed resolution', d.conflicts.length >= 1 && d.conflicts.every(c => c.why && c.suggestion), d.conflicts.map(c => ({ why: c.why, suggestion: c.suggestion })));
      if (d.conflicts.length) {
        check('B.6', 'the skill cannot be approved while a contradiction is open', (await send(`/skills/${sid}/approve`, { by: ACTOR })).body.error === 'conflicts_open');
        // TEST ACTOR's choice: keep the first instruction of each pair (no colour highlights)
        const noHl = c => { const A = d.rules.find(r => r.id === c.a), B = d.rules.find(r => r.id === c.b); return /בלי הדגש/.test(A.text) ? 'a' : /בלי הדגש/.test(B.text) ? 'b' : 'a'; };
        await send(`/skills/${sid}`, { by: ACTOR, resolve: d.conflicts.map(c => ({ id: c.id, resolution: noHl(c) })), params: { ...d.params, highlight_enabled: false } }, 'PUT');
      }
      const ap = await send(`/skills/${sid}/approve`, { by: ACTOR, make_default: true });
      const s1 = ap.body.skill?.approved;
      check('B.7', 'TEST approval and default (TEST ACTOR, not the owner)', ap.body.skill?.status === 'approved' && ap.body.skill.default === true && s1.approvedBy === ACTOR, { rules: s1?.rules.filter(r => r.active).map(r => r.text), params: s1?.params });
      // a DIFFERENT project: a new clip, with no skill chosen → the approved default is used automatically
      const fd = new FormData(); fd.append('video', await fs.openAsBlob(clipB), path.basename(clipB)); fd.append('options', JSON.stringify({ kind: 'edit' }));
      const up = await api('/upload', { method: 'POST', body: fd });
      const id = up.body.project.id;
      check('B.8', 'a different project is created without choosing a skill', [200, 201].includes(up.status) && up.body.project.skill.mode === 'default' && id !== raw.id, { duplicate: up.body.duplicate });
      const w = await wait(id, 1800, 'clip B + prompt skill'); const p = w.p, pk = p.version?.package, rep = pk?.skillReport;
      check('B.9', 'it was edited with the approved default skill automatically, and the package records its version', p.status === 'ready_for_review' && rep?.skill.id === sid && rep.skill.chosen_by === 'default' && pk.rulesUsed.library_skill.version === s1.version,
        { status: p.status, error: p.job?.error, seconds: w.seconds, skill: rep?.skill });
      if (rep) {
        check('B.10', 'the rules are IN THE VIDEO, not only in the file: no zooms, no motion graphics, one-line captions of size 84, no highlights', pk.zooms.length === 0 && (pk.graphics || []).length === 0 && pk.style.caption_size === 84 && pk.style.caption_max_lines === 1
          && pk.cards.every(c => (c.lines || [c.text]).length === 1) && pk.cards.every(c => !(c.highlight || []).length),
          { zooms: pk.zooms.length, graphics: (pk.graphics || []).length, size: pk.style.caption_size, lines: pk.style.caption_max_lines, maxLines: Math.max(...pk.cards.map(c => (c.lines || [c.text]).length)), highlighted: pk.cards.filter(c => (c.highlight || []).length).length });
        check('B.11', 'the review judged the video by the same skill; the unsupported rule is reported as unsupported, never as applied', rep.criteria.length === s1.criteria.length && rep.rules.some(x => x.status === 'unsupported' && /מוזיק/.test(x.text)) && rep.summary.fully_applied === false, { summary: rep.summary, criteria: rep.criteria.map(c => `${c.id}:${c.met}`) });
        check('B.12', 'the automatic checks that keep captions readable still ran with the skill\'s numbers', pk.checks.some(c => c.id === 'safe_zone') && pk.checks.some(c => c.id === 'cards_in_motion' && c.status === 'pass'), pk.checks.filter(c => ['fail', 'review'].includes(c.status)).map(c => c.id));
        fs.writeFileSync(path.join(OUT, 'B_skill_report.json'), JSON.stringify({ skill: s1, report: rep, review: p.review }, null, 1));
        fs.writeFileSync(path.join(OUT, 'B_SKILL.md'), s1.skill_md);
        copy(id, 1, 'final.mp4', 'B_clip_edited_by_prompt_skill.mp4'); copy(id, 1, 'compare_clip.mp4', 'B_before_after_clip.mp4'); copy(id, 1, 'cover.jpg', 'B_cover.jpg');
      }
      const rawNow = await project(raw.id);
      check('B.13', 'making a skill the default did not touch the existing project', rawNow.currentVersion === (summary.a ? summary.a.version : rawBefore.currentVersion) && rawNow.status !== 'editing', { version: rawNow.currentVersion, status: rawNow.status });
      summary.b = { skill: sid, project: id, report: rep?.summary };
    }
  } catch (e) { check('X', 'the run finished without an exception', false, e.message); }
  finally {
    await stopWorker();
    const fails = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 1));
    log(`\n${results.filter(r => r.ok).length} passed, ${fails.length} failed of ${results.length}. evidence: ${OUT}`);
    for (const f of fails) log(`   FAILED ${f.id} ${f.name}`);
    process.exitCode = fails.length ? 1 : 0;
    if (keep) log(`preview server left running on ${base} (worker stopped)`); else { server.close(); setTimeout(() => process.exit(process.exitCode), 300); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
