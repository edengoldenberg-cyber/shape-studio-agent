'use strict';
/**
 * dana_e2e_feedback.cjs — the owner's acceptance feedback of 2026-11-16, checked through the page's own HTTP API with the
 * REAL worker, on projects that ALREADY EXIST in a data folder (earlier versions are kept; nothing is rendered twice).
 * Local only: preview server on 127.0.0.1, mocked notifications, publishing off. Every request is made by a TEST ACTOR.
 *
 *   DANA_PREVIEW_DATA=<dir with a testimony project>   node scripts/dana_e2e_feedback.cjs interview
 *   DANA_PREVIEW_DATA=<dir with a compilation project> node scripts/dana_e2e_feedback.cjs montage
 *
 * interview  the final review is visible data -> "apply Dana's improvements" with the owner's feedback -> a sharpened version
 *            with a before / after of the cut, music that is HEARD, and its own up-to-date final review
 * montage    a direction for the edit and a required number of sources -> met, or blocked with the reason; music heard;
 *            a narration caption corrected from the panel -> in the video -> kept in the version after it
 *
 * PATH (did every step do what it should) is reported apart from PRODUCT (what Dana's final review says about the result).
 * Nobody watches or listens here. A passed path does not say the video is good.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = process.env.DANA_PYTHON || 'C:/Users/owner/AppData/Local/Programs/Python/Python310/python.exe';
const WORKER_DIR = path.join(__dirname, '..', 'dana-worker');
const ACTOR = 'שחקן בדיקה (Claude) — לא הבעלים';
const DATA = process.env.DANA_PREVIEW_DATA;
const MODE = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let OUT;
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(DATA, 'progress-feedback.log'), line + '\n'); };
function check(id, name, ok, detail) { results.push({ id, name, ok: !!ok, detail: detail ?? null }); log(`   ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700) : ''}`); }

async function main() {
  if (!DATA || !['interview', 'montage'].includes(MODE)) throw new Error('usage: DANA_PREVIEW_DATA=<dir> node scripts/dana_e2e_feedback.cjs interview|montage');
  OUT = path.join(DATA, 'evidence'); fs.mkdirSync(OUT, { recursive: true });
  const port = Number(process.env.PORT) || 3199;
  const { server, token } = await require('./dana_studio_preview.cjs').start({ port, dataDir: DATA });
  const base = `http://127.0.0.1:${port}`;
  const cfgPath = path.join(os.tmpdir(), `dana-worker-feedback-${port}.json`);
  const cfg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'worker.config.json'), 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, server_url: base, poll_seconds: 2 }));
  const wlog = fs.openSync(path.join(DATA, 'worker-feedback.log'), 'a');
  const worker = spawn(PY, ['-X', 'utf8', path.join(WORKER_DIR, 'worker.py'), '--config', cfgPath], { env: { ...process.env, DANA_WORKER_TOKEN: token }, stdio: ['ignore', wlog, wlog] });
  const stop = () => new Promise(r => { if (worker.exitCode !== null) return r(); worker.once('exit', r); spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F']); });
  const api = async (p, init) => { const r = await fetch(base + '/api/dana/studio' + p, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const send = (p, body, method = 'POST') => api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const project = async id => (await api('/projects/' + id)).body.project;
  const wait = async (id, timeoutS, label) => { const t0 = Date.now(); let last = '';
    for (;;) { const p = await project(id); const line = `${p.status} · ${p.job?.status} · ${p.job?.note}`;
      if (line !== last) { log(`   ${label} [${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
      if (!['queued', 'leased'].includes(p.job?.status)) return { p, seconds: Math.round((Date.now() - t0) / 1000) };
      if (Date.now() - t0 > timeoutS * 1000) throw new Error(`timeout (${timeoutS}s) waiting for ${label}`); await sleep(3000); } };
  const vdir = (id, n) => path.join(DATA, 'dana', 'projects', id, `v${n}`);
  const pkgOf = (id, n) => JSON.parse(fs.readFileSync(path.join(vdir(id, n), 'package.json'), 'utf8'));
  const keep = (id, n, name) => { try { fs.copyFileSync(path.join(vdir(id, n), 'final.mp4'), path.join(OUT, name)); fs.writeFileSync(path.join(OUT, `v${n}_package.json`), JSON.stringify(pkgOf(id, n), null, 1)); } catch { /* reported by the checks */ } };
  const rec = (P, i) => (P.checks ?? []).find(c => c.id === i);
  const parts = P => (P.plan?.segments ?? []).map(s => s.source_id ? `${s.source_id}:${s.file_in_s}-${s.file_out_s}` : `${s.source_in_s}-${s.source_out_s}`);
  const product = [];
  const describe = (label, P) => product.push({ label, verdict: P.final_review?.plain?.status ?? P.final_review?.verdict_text, works: P.final_review?.plain?.works, weak: P.final_review?.plain?.weak,
    top: (P.final_review?.top_improvements ?? []).map(t => `${t.title} → ${t.action} [${t.who_label}]`), failed_checks: P.failed_checks, seconds: P.total_s, duration: P.duration });
  /** the card the page draws: status, three improvements at most, each with what to do and who can; the review belongs to the file that is shown */
  const reviewShown = async (id, n, P) => { const p = await project(id), f = p.version.package.finalReview ?? {};
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(vdir(id, n), 'final.mp4'))).digest('hex');
    return { ok: p.version.n === n && !!f.plain?.status && Array.isArray(f.top_improvements) && f.top_improvements.length <= 3 && f.top_improvements.every(t => t.title && t.action && t.who_label)
      && f.file_sha256 === sha && p.review?.upToDate === true && (f.categories ?? []).length >= 6 && (f.not_checked ?? []).length > 0 && (f.skills ?? []).some(s => s.name === 'dana-review'),
      detail: { status: f.plain?.status, top: (f.top_improvements ?? []).map(t => `${t.category}: ${t.title.slice(0, 60)} [${t.who}]`), categories: (f.categories ?? []).map(c => `${c.label}:${c.level}`).join(' '),
                not_checked: (f.not_checked ?? []).length, up_to_date: p.review?.upToDate, same_file: f.file_sha256 === sha } }; };

  try {
    const st = (await api('/status')).body;
    check('0.1', 'publishing is off and notifications are mocked', st.publishingEnabled === false && st.notifications === 'mock');
    const list = (await api('/projects')).body.projects, id = list[0].id;
    let p = await project(id);
    if (['queued', 'leased'].includes(p.job?.status)) throw new Error('a job is already active in this data folder - nothing was started');
    const n0 = p.currentVersion, P0 = pkgOf(id, n0);

    if (MODE === 'interview') {
      log(`== interview: project ${id}, starting from version ${n0} ==`);
      check('I.1', 'the current version carries Dana\'s final review, tied to its file', !!P0.final_review?.file_sha256 && !!P0.dana_review, { verdict: P0.final_review?.verdict_text });
      // the mix setting that made the music vanish (26 dB under a gain on the file) is set to the default: 14 dB under the SPEECH
      const au = await send(`/projects/${id}/audio`, { by: ACTOR, music: { asset: p.media.audio.music.asset, start_s: p.media.audio.music.start_s, volume_db: -14, fade_in_s: 0.5, fade_out_s: 1.5 } }, 'PATCH');
      check('I.2', 'the music level is stored as "how far under the speech", inside the audible range', au.body.project?.media?.audio?.music?.volume_db === -14 && (await send(`/projects/${id}/audio`, { by: ACTOR, music: { asset: p.media.audio.music.asset, start_s: p.media.audio.music.start_s, volume_db: -35 } }, 'PATCH')).body.project.media.audio.music.volume_db === -20
        && (await send(`/projects/${id}/audio`, { by: ACTOR, music: { asset: p.media.audio.music.asset, start_s: p.media.audio.music.start_s, volume_db: -14, fade_in_s: 0.5, fade_out_s: 1.5 } }, 'PATCH')).status === 200);
      const note = 'הכתוביות נראות נכונות, אבל הראיון צריך יותר חידוד: מסר אחד, פתיחה מעניינת מתוך החומר, פחות הקדמות, חזרות ומילות מילוי, וסיום שסוגר את המסר.';
      // --no-note: a second round - only Dana's own improvements of the current review, without new words from the owner
      const ap = await send(`/projects/${id}/apply-review`, process.argv.includes('--no-note') ? { by: ACTOR } : { by: ACTOR, note });
      check('I.3', '"apply Dana\'s improvements" with the owner\'s feedback queues a new version; the current one is kept', ap.status === 200 && ap.body.project.currentVersion === n0 + 1, ap.body.error);
      const r = await wait(id, 1500, `testimony v${n0 + 1} (sharpened)`);
      const P = pkgOf(id, n0 + 1); keep(id, n0 + 1, `testimony_v${n0 + 1}_sharpened.mp4`);
      const d = P.plan?.changes_vs_previous;
      check('I.4', 'the cut was planned again for the request (not a locked copy), and the request is recorded', P.revision_mode === 'replanned' && /חידוד|יישום שיפורי הביקורת הסופית של דנה/.test(r.p.versions.at(-1).changeRequest ?? ''), { mode: P.revision_mode, note: P.plan?.revision_note, request: (r.p.versions.at(-1).changeRequest ?? '').slice(0, 300) });
      check('I.5', 'before / after of the cut: what was taken out, what came in, the opening and the two lengths - with reasons', !!d && typeof d.before_s === 'number' && typeof d.after_s === 'number' && Array.isArray(d.removed) && Array.isArray(d.added),
        d && { before_s: d.before_s, after_s: d.after_s, same_cut: d.same_cut, opening_changed: d.opening_changed, opening_before: d.opening_before, opening_after: d.opening_after, removed: d.removed.map(x => `${x.seconds}s "${x.text.slice(0, 40)}" (${x.why.slice(0, 50)})`), added: d.added.map(x => `${x.seconds}s "${x.text.slice(0, 40)}"`), moved: d.moved.length });
      check('I.6', 'the request changed the cut (a version identical to the previous one would not be a sharpening)', !!d && d.same_cut === false, d && { removed_s: d.removed_s, added_s: d.added_s, opening_changed: d.opening_changed });
      const m = P.mix?.measured ?? {};
      check('I.7', 'the music is HEARD: in the final file, 8-22 dB under the measured speech, no clipping, and the check says so', rec(P, 'mix_music_audible')?.status === 'pass' && m.speech_over_music_db >= 8 && m.speech_over_music_db <= 22 && m.clipped_samples <= 20
        && P.mix.params.music.level === 'relative_to_speech', { asked_under_speech: P.mix?.params?.music?.under_speech_db_asked, measured_under_speech: m.speech_over_music_db, between_speech_db: m.music_between_speech_db, first_second_db: m.music_first_second_db, clipped: m.clipped_samples, loudness: rec(P, 'loudness')?.summary, was_in_v_before: P0.mix?.measured?.speech_over_music_db });
      const sh = await reviewShown(id, n0 + 1, P);
      check('I.8', 'the new version has its OWN final review, up to date and about the file that is shown: status, categories, at most three improvements with what to do and who can, and what was not checked', sh.ok, sh.detail);
      const rows = (P.dana_review?.categories ?? []).flatMap(c => c.criteria);
      check('I.9', 'filler words and audible music are criteria of the review (measured)', rows.some(x => x.id === 'P3' && x.basis === 'measured' && x.status !== 'not_checked') && rows.some(x => x.id === 'A4' && x.status === 'met'),
        { P3: rows.find(x => x.id === 'P3')?.note, A4: rows.find(x => x.id === 'A4')?.note });
      const after = await project(id);
      check('I.10', 'every earlier version is kept and nothing is approved', JSON.stringify(after.versions.map(v => v.n)) === JSON.stringify(Array.from({ length: n0 + 1 }, (_, i) => i + 1)) && after.status !== 'approved' && fs.existsSync(path.join(vdir(id, n0), 'final.mp4')));
      describe(`testimony v${n0} (before)`, P0); describe(`testimony v${n0 + 1} (sharpened)`, P);
      log(`   SPOKEN before: ${P0.spoken_text}`); log(`   SPOKEN after:  ${P.spoken_text}`);
    }

    if (MODE === 'montage') {
      log(`== compilation: project ${id}, starting from version ${n0} ==`);
      // --captions-only: the direction part already ran on this data; continue from the current version without planning again
      let P = P0, base = n0;
      if (!process.argv.includes('--captions-only')) {
      const nsrc = p.media.sources.filter(s => !s.removed).length;
      expectStatus((await send(`/projects/${id}/brief`, { by: ACTOR, min_sources: nsrc + 1 }, 'PATCH')), 400, 'M.1a', 'asking for more sources than were uploaded is refused, not ignored');
      const br = await send(`/projects/${id}/brief`, { by: ACTOR, demo: true, min_sources: nsrc, goal: '' }, 'PATCH');
      check('M.1', 'the direction is stored: no goal and no reference (so the direction will be Dana\'s proposal), all the sources required, marked as an infrastructure demo', br.status === 200 && br.body.project.media.brief.min_sources === nsrc && br.body.project.media.brief.demo === true, br.body.error);
      await send(`/projects/${id}/audio`, { by: ACTOR, music: { asset: p.media.audio.music.asset, start_s: p.media.audio.music.start_s, volume_db: -14, fade_in_s: 0.4, fade_out_s: 1.5 } }, 'PATCH');
      const rp = await send(`/projects/${id}/replan`, { by: ACTOR });
      check('M.2', 'planning again by the direction queues a new version', rp.status === 200 && rp.body.project.currentVersion === n0 + 1, rp.body.error);
      await wait(id, 900, `compilation v${n0 + 1} (direction + required sources)`);
      P = pkgOf(id, n0 + 1); base = n0 + 1; keep(id, n0 + 1, `compilation_v${n0 + 1}_direction.mp4`);
      const div = rec(P, 'sources_diversity'), blocker = (P.issues ?? []).find(i => i.code === 'sources_requirement_not_met');
      const usedN = new Set(P.plan.segments.map(s => s.source_id)).size;
      check('M.3', 'the required number of sources is MET, or the version is BLOCKED with the reason - never quietly fewer', !!div && ((div.status === 'pass' && usedN >= nsrc && !blocker) || (div.status === 'fail' && !!blocker && P.final_review.verdict === 'needs_fix' && P.final_review.top_improvements[0]?.who === 'owner')),
        { required: nsrc, used: usedN, check: div?.summary, blocked: !!blocker, verdict: P.final_review?.plain?.status });
      check('M.4', 'the compilation has a line: a message, a direction, a role for every part, why it opens and why it ends this way', !!P.plan.message && !!P.plan.direction && !!P.plan.opening_why && !!P.plan.closing_why && P.plan.segments.every(s => s.plan_role),
        { message: P.plan.message, direction: P.plan.direction, roles: P.plan.segments.map(s => `${s.n}:${s.plan_role}`).join(' '), closing_why: P.plan.closing_why });
      check('M.5', 'without a goal or a reference the direction is shown as DANA\'S PROPOSAL, and the demo is not presented as a training compilation', P.plan.direction_source === 'dana_proposal' && P.final_review.direction?.source === 'dana_proposal'
        && (P.issues ?? []).some(i => i.code === 'direction_is_proposal') && (P.issues ?? []).some(i => i.code === 'infrastructure_demo') && /תשתית/.test(P.final_review.plain?.note ?? ''),
        { fit: P.plan.material_fit, note: P.final_review.plain?.note });
      const m = P.mix?.measured ?? {};
      check('M.6', 'the music is HEARD under the narration: 8-22 dB under the measured speech, and the check says so', rec(P, 'mix_music_audible')?.status === 'pass' && m.speech_over_music_db >= 8 && m.speech_over_music_db <= 22,
        { measured_under_speech: m.speech_over_music_db, between_speech_db: m.music_between_speech_db, was: P0.mix?.measured?.speech_over_music_db, clipped: m.clipped_samples });
      const sh = await reviewShown(id, n0 + 1, P); check('M.7', 'the final review of the compilation is up to date and about the shown file, with improvements (the list is no longer empty by construction)', sh.ok, sh.detail);

      }
      log('== a narration caption is corrected from the panel ==');
      p = await project(id);
      // a correction that is true to what is said: punctuation only (a trailing comma removed, or a full stop added to the longest caption)
      const usable = p.version.package.cards.filter(c => c.source_start_s >= 0 && c.source_end_s > c.source_start_s);
      const card = usable.find(c => /[,.]$/.test(c.text)) ?? [...usable].sort((a, b) => b.text.length - a.text.length)[0], fixed = /[,.]$/.test(card.text) ? card.text.replace(/[,.]+$/, '') : card.text + '.';
      const noListen = await send(`/projects/${id}/captions/verify`, { source_start_s: card.source_start_s, source_end_s: card.source_end_s, original: card.text, text: fixed, by: ACTOR });
      const vf = await send(`/projects/${id}/captions/verify`, { source_start_s: card.source_start_s, source_end_s: card.source_end_s, original: card.text, text: fixed, by: ACTOR, listened: true });
      check('M.8', 'the existing "listen, correct, verify" mechanism accepts a correction of a NARRATION caption (and refuses one made without listening)', noListen.status >= 400 && vf.status === 200 && vf.body.project.pendingCorrections === 1,
        { card: card.i, before: card.text, after: fixed, refused_without_listening: noListen.body.error, verify_status: vf.status, verify_error: vf.body.error, pending: vf.body.project?.pendingCorrections });
      const rv = await send(`/projects/${id}/revise`, { by: ACTOR });
      check('M.9', 'producing the version with the correction is a new version', rv.status === 200 && rv.body.project.currentVersion === base + 1, rv.body.error);
      await wait(id, 900, `compilation v${base + 1} (caption corrected)`);
      const P2 = pkgOf(id, base + 1); keep(id, base + 1, `compilation_v${base + 1}_caption_corrected.mp4`);
      const p2 = await project(id), st2 = (p2.cardStates ?? []).find(s => s.saved === fixed);
      check('M.10', 'the correction is IN THE VIDEO: the card shows the corrected text, the transcript records it, the page marks it "in the video"; the cut did not change', P2.cards.some(c => c.text === fixed) && !P2.cards.some(c => c.text === card.text)
        && P2.transcript?.corrections_applied?.length === 1 && st2?.inVideo === true && JSON.stringify(parts(P2)) === JSON.stringify(parts(P)) && rec(P2, 'safe_zone')?.status === 'pass',
        { cards: P2.cards.map(c => c.text).join(' | ').slice(0, 300), applied: P2.transcript?.corrections_applied, state: st2 && { status: st2.status, inVideo: st2.inVideo }, same_cut: JSON.stringify(parts(P2)) === JSON.stringify(parts(P)) });
      log('== the music is changed without touching the picture; the correction must still be there ==');
      const rm = await send(`/projects/${id}/revise`, { by: ACTOR, audio: { music: { asset: p2.media.audio.music.asset, start_s: p2.media.audio.music.start_s, volume_db: -10 } } });
      check('M.11', 'changing the music level queues a new version', rm.status === 200 && rm.body.project.currentVersion === base + 2, rm.body.error);
      await wait(id, 900, `compilation v${base + 2} (music level only)`);
      const P3 = pkgOf(id, base + 2); keep(id, base + 2, `compilation_v${base + 2}_music_level.mp4`);
      check('M.12', 'the correction is KEPT in the next version, the picture is the same cut, and only the music moved (to the level that was asked)', P3.cards.some(c => c.text === fixed) && !P3.cards.some(c => c.text === card.text)
        && JSON.stringify(parts(P3)) === JSON.stringify(parts(P2)) && Math.abs(P3.mix.measured.speech_over_music_db - 10) <= 1.5 && rec(P3, 'mix_music_audible')?.status === 'pass',
        { under_speech_before: P2.mix.measured.speech_over_music_db, under_speech_now: P3.mix.measured.speech_over_music_db, correction_kept: P3.cards.some(c => c.text === fixed) });
      const after = await project(id);
      check('M.13', 'every earlier version is kept and nothing is approved', after.versions.length === base + 2 && after.status !== 'approved' && fs.existsSync(path.join(vdir(id, n0), 'final.mp4')));
      describe(`compilation v${base} (direction)`, P); describe(`compilation v${base + 2} (corrected caption, music level)`, P3);
    }
  } catch (e) { check('X', 'the run completed', false, String(e && e.stack || e).slice(0, 700)); }
  finally {
    await stop();
    const fails = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(OUT, `results-feedback-${MODE}.json`), JSON.stringify({ at: new Date().toISOString(), actor: ACTOR, mode: MODE, results, product }, null, 1));
    log(`\nPATH: ${results.length - fails.length} passed, ${fails.length} failed of ${results.length}.`);
    for (const v of product) { log(`PRODUCT ${v.label}: ${v.verdict} · ${v.duration}s · failed checks ${JSON.stringify(v.failed_checks)}`); log(`    ${v.works ?? ''} ${v.weak ?? ''}`); for (const t of v.top) log(`    • ${t}`); }
    log('Nobody watched or listened. A passed path does not say the video is good.');
    for (const f of fails) log(`   FAILED ${f.id} ${f.name}`);
    process.exitCode = fails.length ? 1 : 0;
    server.close(); setTimeout(() => process.exit(process.exitCode), 300);
  }
  function expectStatus(r, status, cid, name) { check(cid, name, r.status === status, { status: r.status, error: r.body.error, message: r.body.message }); }
}
main().catch(e => { console.error(e); process.exit(1); });
