'use strict';
/**
 * Dana — the owner's feedback loop on the server: worker-decided adapter, "הפק גרסה מתוקנת"
 * (caption corrections, style, zooms, note), standing rules, the content-judgement gate,
 * references, Hebrew file names. Isolated temp DATA_DIR, the worker is simulated over the real routes.
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

const TOKEN = 'test-worker-token-0123456789abcdef';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const W = (r) => r.set('Authorization', `Bearer ${TOKEN}`);

let app, studio, refs;
beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-feedback-'));
  process.env.DANA_WORKER_TOKEN = TOKEN;
  delete process.env.DANA_PUBLISHING_ENABLED; delete process.env.DANA_NOTIFY_REAL; delete process.env.DANA_PUBLISHER_MODE;
  jest.resetModules();
  studio = require('../services/dana_studio'); refs = require('../services/dana_references');
  const { workerRouter, panelRouter } = require('../routes/dana_studio_routes');
  app = express();
  app.use('/api/dana/worker', workerRouter);
  app.use('/api/dana/studio', panelRouter);
  studio.reconcileOnStartup();
});

const video = () => Buffer.concat([Buffer.from('fake-source-video-'), crypto.randomBytes(4096)]);
const upload = (name = 'clip.mp4', options) => {
  const r = request(app).post('/api/dana/studio/upload').attach('video', video(), name);
  return options ? r.field('options', JSON.stringify(options)) : r;
};
const lease = async () => (await W(request(app).post('/api/dana/worker/lease')).send({ workerId: 'w1', pipelineVersion: '1.1.0' })).body;
const get = async id => (await request(app).get(`/api/dana/studio/projects/${id}`)).body.project;

/** A package as the NEW worker sends it; `extra` overrides. `legacy` = a package from before these fields existed. */
function pkgFor(sourceSha, extra = {}, legacy = false) {
  const base = { pipeline_version: '1.0.0', status: 'success', source: { sha256: sourceSha, duration: 30 }, segment: { in_s: 0, out_s: 20, reason: 'test' },
    duration: 20, adapter: 'claude', style: { caption_size: 96, caption_y_px: 960, backing: false, highlight_enabled: true, font_family: 'Heebo' },
    spoken_text: 'שלום לכולם זה מבחן', cards: [{ i: 1, text: 'שלום לכולם', highlight: [], start: 0, dur: 1.2 }, { i: 2, text: 'זה מבחן', highlight: [], start: 1.2, dur: 1 }],
    cover: { text: 'שלום', frame_s: 1 }, caption: { text: 'טיוטה', cta: null, is_draft: true }, checks: [{ id: 'sync_lead', status: 'pass', summary: 's' }],
    failed_checks: [], issues: [], timings_s: {}, total_s: 10 };
  if (legacy) return { ...base, ...extra };
  return { ...base, judgement_mode: 'model',
    plan: { message: 'מסר', hook: 'פתיחה', rationale: 'נימוק', content_judgement: 'model', brief: ['שורה'],
            segments: [{ n: 1, source_in_s: 3, source_out_s: 23, tl_in_s: 0, tl_out_s: 20, role: 'hook', why: 'כי' }] },
    cards: [{ i: 1, text: 'שלום לכולם', highlight: [], start: 0, dur: 1.2, source_start_s: 3.0, source_end_s: 4.2 },
            { i: 2, text: 'זה מבחן', highlight: [], start: 1.2, dur: 1, source_start_s: 4.2, source_end_s: 5.2 }],
    zooms: [{ id: 'z@4.2', source_t_s: 4.2, tl_t_s: 1.2, scale: 1.15, ease_s: 0.4, hold_until_s: 20, reason: 'משפט מפתח', evidence: 'rms' }],
    transcript: { status: 'auto_unverified', doubts: [{ card: 2, tl_start_s: 1.2, tl_end_s: 2.2, source_start_s: 4.2, source_end_s: 5.2, word: 'מבחן', kind: 'low_confidence', note: 'prob 0.5' }], corrections_applied: [] },
    rules_used: { skill: { name: 'dana-editing', version: '1.0.0', sha256: 'a'.repeat(64) }, profile: { id: 'center-bold-v1', version: '1', sha256: 'b'.repeat(64) }, standing_rules: [], references: [] },
    ...extra };
}
async function finish(l, sourceSha, pkg) {
  const files = { 'final.mp4': crypto.randomBytes(3000), 'cover.jpg': crypto.randomBytes(500), 'package.json': Buffer.from(JSON.stringify(pkg ?? pkgFor(sourceSha))),
    'checks.json': Buffer.from('{"records":[]}'), 'captions.json': Buffer.from('[]') };
  for (const [name, buf] of Object.entries(files))
    expect((await W(request(app).put(`/api/dana/worker/jobs/${l.job.id}/artifacts/${name}`)).set('X-Lease-Token', l.leaseToken)
      .set('X-Content-SHA256', sha(buf)).set('Content-Type', 'application/octet-stream').send(buf)).status).toBe(200);
  return W(request(app).post(`/api/dana/worker/jobs/${l.job.id}/complete`)).set('X-Lease-Token', l.leaseToken).send({ status: 'success' });
}
async function ready(pkgExtra, { legacy = false, options } = {}) {
  const up = await upload(`clip-${crypto.randomBytes(3).toString('hex')}.mp4`, options); const l = await lease();
  expect((await finish(l, up.body.project.source.sha256, pkgFor(up.body.project.source.sha256, pkgExtra, legacy))).status).toBe(200);
  return { id: up.body.project.id, firstJob: l.job };
}

describe('adapter: the worker decides unless a job explicitly asks', () => {
  test('a panel upload sends NO adapter; an explicit one is kept', async () => {
    const up = await upload();
    expect(up.body.project.adapter).toBeNull();
    const l = await lease();
    expect('adapter' in l.job.options).toBe(false);
    await finish(l, up.body.project.source.sha256);
    const up2 = await upload('b.mp4', { adapter: 'claude' });
    expect(up2.body.project.adapter).toBe('claude');
    expect((await lease()).job.options.adapter).toBe('claude');
  });

  test('a project that stored the old silent default "heuristic" is treated as no request', async () => {
    const { id } = await ready();
    const p = studio.getProject(id); p.adapter = 'heuristic'; delete p.adapterExplicit; studio.save();   // as written by the previous server version
    expect((await get(id)).adapter).toBeNull();
    const r = await request(app).post(`/api/dana/studio/projects/${id}/request-changes`).send({ note: 'לפתוח במשפט אחר' });
    expect(r.body.project).toMatchObject({ status: 'editing', currentVersion: 2, pendingChange: null });   // not parked for an operator
    const l = await lease();
    expect('adapter' in l.job.options).toBe(false);
    expect(l.job.options).toMatchObject({ change_request: 'לפתוח במשפט אחר' });
    expect(l.job.options.previous.cards[0].text).toBe('שלום לכולם');
  });
});

describe('"הפק גרסה מתוקנת"', () => {
  test('caption corrections, style, zoom changes and a project note become the next job; the approval is dropped', async () => {
    const { id } = await ready(); const A = `/api/dana/studio/projects/${id}`;
    await request(app).post(A + '/approve').send({ fingerprint: (await get(id)).version.fingerprint, by: 'Eden' });
    expect((await get(id)).version.approvalValid).toBe(true);
    const r = await request(app).post(A + '/revise').send({ by: 'Eden',
      caption_edits: [{ source_start_s: 4.2, source_end_s: 5.2, original: 'זה מבחן', text: 'זה מבחן אמיתי' }],
      style_overrides: { caption_size: 110, caption_y_px: 900, caption_max_lines: 2 },
      zoom_edits: [{ id: 'z@4.2', action: 'set', scale: 1.25 }], note: 'לקצר את הסוף', note_scope: 'project' });
    expect(r.status).toBe(200);
    expect(r.body.project).toMatchObject({ status: 'editing', currentVersion: 2 });
    expect(r.body.project.versions[0]).toMatchObject({ n: 1, approved: false, hasVideo: true });          // version 1 kept, its approval gone
    expect(r.body.project.captionEdits).toHaveLength(1);
    expect(r.body.project.captionEdits[0]).toMatchObject({ original: 'זה מבחן', text: 'זה מבחן אמיתי', by: 'Eden', source_start_s: 4.2, source_end_s: 5.2 });
    const l = await lease();
    expect(l.job.version).toBe(2);
    expect('adapter' in l.job.options).toBe(false);
    expect(l.job.options).toMatchObject({ change_request: 'לקצר את הסוף', style_overrides: { caption_size: 110, caption_y_px: 900, caption_max_lines: 2 },
      zoom_edits: [{ id: 'z@4.2', action: 'set', scale: 1.25 }] });
    expect(l.job.options.caption_edits).toEqual([expect.objectContaining({ source_start_s: 4.2, source_end_s: 5.2, original: 'זה מבחן', text: 'זה מבחן אמיתי', by: 'Eden' })]);
    expect(l.job.options.rules).toBeUndefined();
    expect((await request(app).get(A + '/versions/1/video')).status).toBe(200);
    expect((await get(id)).history.some(h => h.action === 'approval_invalidated')).toBe(true);
  });

  test('corrections persist into later jobs; a second correction keeps the transcript original; returning to it withdraws the correction', async () => {
    const { id } = await ready(); const A = `/api/dana/studio/projects/${id}`;
    await request(app).post(A + '/revise').send({ by: 'Eden', caption_edits: [{ source_start_s: 4.2, source_end_s: 5.2, original: 'זה מבחן', text: 'זה ניסוי' }] });
    let l = await lease(); await finish(l, (await get(id)).source.sha256);
    await request(app).post(A + '/revise').send({ by: 'Eden', caption_edits: [{ source_start_s: 4.2, source_end_s: 5.2, original: 'זה ניסוי', text: 'זה ניסיון' }] });
    l = await lease();
    expect(l.job.options.caption_edits).toHaveLength(1);
    expect(l.job.options.caption_edits[0]).toMatchObject({ original: 'זה מבחן', text: 'זה ניסיון' });
    expect(studio.getProject(id).captionEditHistory).toHaveLength(1);                                  // the earlier correction is kept, separately
    await finish(l, (await get(id)).source.sha256);
    // a later plain change request still carries the stored correction
    await request(app).post(A + '/request-changes').send({ note: 'קאבר אחר' });
    l = await lease();
    expect(l.job.options.caption_edits[0].text).toBe('זה ניסיון');
    await finish(l, (await get(id)).source.sha256);
    await request(app).post(A + '/revise').send({ by: 'Eden', caption_edits: [{ source_start_s: 4.2, source_end_s: 5.2, original: 'x', text: 'זה מבחן' }], note: 'בדיקה', note_scope: 'project' });
    expect((await lease()).job.options.caption_edits).toBeUndefined();
  });

  test('refuses bad input and an empty request', async () => {
    const { id } = await ready(); const A = `/api/dana/studio/projects/${id}/revise`;
    const bad = async body => (await request(app).post(A).send({ by: 'Eden', ...body })).body.error;
    expect(await bad({})).toBe('nothing_to_revise');
    expect((await request(app).post(A).send({ note: 'x', note_scope: 'project' })).body.error).toBe('by_required');
    expect(await bad({ note: 'משהו' })).toBe('note_scope_required');
    expect(await bad({ caption_edits: [{ source_start_s: 5, source_end_s: 4, text: 'x' }] })).toBe('caption_edits_invalid');
    expect(await bad({ caption_edits: [{ source_start_s: 1, source_end_s: 2, text: 'שורה\nשנייה' }] })).toBe('caption_edits_invalid');
    expect(await bad({ caption_edits: [{ source_start_s: 1, source_end_s: 2, text: 'א'.repeat(81) }] })).toBe('caption_edits_invalid');
    expect(await bad({ zoom_edits: [{ id: 'z1', action: 'set', scale: 3 }] })).toBe('zoom_edits_invalid');
    expect(await bad({ zoom_edits: [{ id: 'z1', action: 'explode' }] })).toBe('zoom_edits_invalid');
    expect(await bad({ style_overrides: { caption_size: 400 } })).toBe('style_override_invalid');
    expect(await bad({ style_overrides: { caption_max_lines: 3 } })).toBe('style_override_invalid');
    expect(await bad({ style_overrides: { font_family: 'Comic' } })).toBe('style_override_invalid');
    expect((await get(id)).currentVersion).toBe(1);                                                    // nothing was queued
  });
});

describe('feedback scope: this project vs a standing rule', () => {
  test('a permanent note becomes a global rule sent with every job of every project; a project note does not', async () => {
    const a = await ready(), b = await ready();
    await request(app).post(`/api/dana/studio/projects/${a.id}/revise`).send({ by: 'Eden', note: 'בלי אימוג׳י בכתוביות', note_scope: 'permanent' });
    const la = await lease();
    expect(la.job.projectId).toBe(a.id);
    expect(la.job.options.rules).toEqual([{ id: expect.stringMatching(/^rule_/), text: 'בלי אימוג׳י בכתוביות', version: 1 }]);
    expect(la.job.options.change_request).toBe('בלי אימוג׳י בכתוביות');       // the owner wrote a note: this revision acts on it too
    await finish(la, (await get(a.id)).source.sha256);
    const rules = (await request(app).get('/api/dana/studio/rules')).body.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ status: 'active', by: 'Eden', projectId: a.id, version: 1,
      source: { project_id: a.id, project_title: expect.any(String), version_n: 1, by: 'Eden', at: expect.any(String) } });
    // another project, a project-only note: the rule travels, the note stays local
    await request(app).post(`/api/dana/studio/projects/${b.id}/revise`).send({ by: 'Eden', note: 'רק כאן: לקצר', note_scope: 'project' });
    const lb = await lease();
    expect(lb.job.options).toMatchObject({ change_request: 'רק כאן: לקצר', rules: [{ text: 'בלי אימוג׳י בכתוביות' }] });
    await finish(lb, (await get(b.id)).source.sha256);
    expect((await request(app).get('/api/dana/studio/rules')).body.rules).toHaveLength(1);
    // a new upload gets the rule too
    const up = await upload('new.mp4');
    const ln = await lease();
    expect(ln.job.options.rules).toHaveLength(1);
    await finish(ln, up.body.project.source.sha256);
    // retiring the rule stops it, and keeps the record
    const retired = (await request(app).post(`/api/dana/studio/rules/${rules[0].id}/retire`).send({ by: 'Eden' })).body.rules;
    expect(retired[0]).toMatchObject({ status: 'retired', retiredBy: 'Eden' });
    await request(app).post(`/api/dana/studio/projects/${a.id}/request-changes`).send({ note: 'עוד שינוי' });
    expect((await lease()).job.options.rules).toBeUndefined();
    expect((await request(app).post('/api/dana/studio/rules/nope/retire').send({})).status).toBe(404);
  });
});

describe('content judgement gate', () => {
  test('a technical-only package cannot be approved without an explicit recorded exception', async () => {
    for (const extra of [{ judgement_mode: 'fallback_heuristic', adapter: 'heuristic', plan: null }, { plan: { message: '', hook: '', rationale: '', content_judgement: 'none', segments: [], brief: [] } }]) {
      const { id } = await ready(extra); const A = `/api/dana/studio/projects/${id}`;
      let p = await get(id);
      expect(p.version.contentJudgement).toMatchObject({ missing: true, excepted: false });
      let r = await request(app).post(A + '/approve').send({ fingerprint: p.version.fingerprint, by: 'Eden' });
      expect(r.status).toBe(409); expect(r.body.error).toBe('content_judgement_missing');
      expect((await request(app).post(A + '/exceptions').send({ id: 'content_judgement_missing', reason: 'קצר', by: 'Eden' })).body.error).toBe('exception_reason_required');
      expect((await request(app).post(A + '/exceptions').send({ id: 'content_judgement_missing', reason: 'צפיתי בעצמי והתוכן מתאים לי', by: 'Eden' })).status).toBe(200);
      p = await get(id);
      expect(p.version.contentJudgement).toMatchObject({ missing: true, excepted: true });
      r = await request(app).post(A + '/approve').send({ fingerprint: p.version.fingerprint, by: 'Eden' });
      expect(r.status).toBe(200); expect(r.body.project.status).toBe('approved');
    }
  });

  test('an OLD package that only says adapter=heuristic is gated too; a model package is not, and the exception does not apply to it', async () => {
    const old = await ready({ adapter: 'heuristic' }, { legacy: true });
    let p = await get(old.id);
    expect(p.version.contentJudgement).toMatchObject({ mode: 'fallback_heuristic', missing: true });
    expect((await request(app).post(`/api/dana/studio/projects/${old.id}/approve`).send({ fingerprint: p.version.fingerprint, by: 'Eden' })).body.error).toBe('content_judgement_missing');
    const ok = await ready();
    p = await get(ok.id);
    expect(p.version.contentJudgement).toMatchObject({ mode: 'model', missing: false });
    expect((await request(app).post(`/api/dana/studio/projects/${ok.id}/exceptions`).send({ id: 'content_judgement_missing', reason: 'לא רלוונטי בכלל כאן', by: 'Eden' })).body.error).toBe('exception_not_applicable');
    expect((await request(app).post(`/api/dana/studio/projects/${ok.id}/approve`).send({ fingerprint: p.version.fingerprint, by: 'Eden' })).status).toBe(200);
  });
});

describe('package fields: shown when the worker sent them, never invented', () => {
  test('new fields pass through; an old package renders with nulls', async () => {
    const n = await get((await ready()).id);
    expect(n.version.package).toMatchObject({ judgementMode: 'model', plan: { message: 'מסר', segments: [{ source_in_s: 3 }] }, zooms: [{ id: 'z@4.2' }],
      transcript: { status: 'auto_unverified' }, rulesUsed: { profile: { id: 'center-bold-v1' } } });
    expect(n.version.package.cards[0]).toMatchObject({ source_start_s: 3.0, source_end_s: 4.2 });
    const o = await get((await ready({ adapter: 'scripted' }, { legacy: true })).id);
    expect(o.version.package).toMatchObject({ plan: null, zooms: null, transcript: null, rulesUsed: null, judgementMode: 'scripted' });
    expect(o.version.contentJudgement.missing).toBe(false);
    expect(o.versions[0]).toMatchObject({ n: 1, hasVideo: true, hasCover: true, profile: null });
  });
});

describe('Hebrew file names', () => {
  test('a name that arrives as latin1 bytes is stored and shown as Hebrew', async () => {
    const mangled = Buffer.from('סרטון לקוחה.mp4', 'utf8').toString('latin1');
    expect(studio.fixName(mangled)).toBe('סרטון לקוחה.mp4');
    expect(studio.fixName('סרטון.mp4')).toBe('סרטון.mp4');            // already correct
    expect(studio.fixName('café.mp4')).toBe('café.mp4');              // real latin1, not UTF-8 bytes
    expect(studio.fixName('clip.mp4')).toBe('clip.mp4');
    const tmp = path.join(process.env.DATA_DIR, 'up.bin'); fs.writeFileSync(tmp, video());
    const { project } = await studio.registerUpload({ tmpPath: tmp, originalName: mangled });
    expect(project.title).toBe('סרטון לקוחה'); expect(project.source.originalName).toBe('סרטון לקוחה.mp4');
    // a project stored by the previous server version is repaired when shown, without rewriting it
    project.title = Buffer.from('ריל ראשון', 'utf8').toString('latin1'); studio.save();
    expect((await get(project.id)).title).toBe('ריל ראשון');
    expect((await request(app).get('/api/dana/studio/projects')).body.projects[0].title).toBe('ריל ראשון');
    expect(studio.getProject(project.id).title).not.toBe('ריל ראשון');
  });

  test('a Hebrew file name through the real upload route', async () => {
    const up = await upload('לימור.mp4');
    expect(up.status).toBe(201);
    expect(up.body.project.title).toBe('לימור');
  });
});

describe('references and the approved profile', () => {
  const R = '/api/dana/studio/references';
  test('add (link or file) with the owner note, list, serve, delete — a file waits for the worker, a link alone cannot be analysed', async () => {
    expect((await request(app).post(R).field('title', 'x').field('by', 'Eden')).body.error).toBe('reference_source_required');
    expect((await request(app).post(R).field('source_url', 'https://example.com/r').field('by', 'Eden')).body.error).toBe('reference_title_required');
    expect((await request(app).post(R).field('title', 'x').field('source_url', 'javascript:alert(1)').field('by', 'Eden')).body.error).toBe('reference_url_invalid');
    expect((await request(app).post(R).field('title', 'x').field('source_url', 'https://example.com/r').field('usage_permission', 'stolen').field('by', 'Eden')).body.error).toBe('reference_permission_invalid');
    const a = await request(app).post(R).field('title', 'ריל עם פתיחה חזקה').field('source_url', 'https://example.com/reel/1').field('origin', 'חשבון אחר')
      .field('usage_permission', 'inspiration_only').field('content_type', 'עדות מתאמנת').field('fits_message', 'התגברות על חשש').field('owner_note', 'אהבתי את הקצב בפתיחה').field('by', 'Eden');
    expect(a.status).toBe(201);
    expect(a.body.reference).toMatchObject({ status: 'link_only', analysis: null, proposed_profile: null, usage_permission: 'inspiration_only', owner_note: 'אהבתי את הקצב בפתיחה', file: null });
    expect(a.body.analysis).toMatchObject({ active: true });
    const b = await request(app).post(R).field('title', 'קובץ').field('by', 'Eden').attach('file', crypto.randomBytes(2000), 'ref.mp4');
    expect(b.status).toBe(201);
    expect(b.body.reference).toMatchObject({ status: 'awaiting_analysis', usage_permission: 'unknown', file: { name: 'ref.mp4', ext: 'mp4', bytes: 2000 } });
    expect((await request(app).post(R).field('title', 'קובץ').field('by', 'Eden').attach('file', crypto.randomBytes(2000), 'ref.exe')).body.error).toBe('reference_format_unsupported');
    let list = (await request(app).get(R)).body.references;
    expect(list.map(r => r.title)).toEqual(['ריל עם פתיחה חזקה', 'קובץ']);
    expect((await request(app).get(`${R}/${b.body.reference.id}/file`)).status).toBe(200);
    expect((await request(app).get(`${R}/${a.body.reference.id}/file`)).status).toBe(404);
    list = (await request(app).delete(`${R}/${b.body.reference.id}`)).body.references;
    expect(list).toHaveLength(1);
    expect(fs.existsSync(path.join(process.env.DATA_DIR, 'dana', 'references', 'files', `${b.body.reference.id}.mp4`))).toBe(false);
    expect((await request(app).delete(`${R}/nope`)).status).toBe(404);
  });

  test('only a profile a version was actually edited with can be approved; the approved default is sent with later jobs', async () => {
    const { id } = await ready(); const P = '/api/dana/studio/profiles';
    expect((await request(app).get(P)).body).toMatchObject({ profiles: [], default: null });
    expect((await request(app).post(`${P}/made-up/approve`).send({ projectId: id, by: 'Eden' })).body.error).toBe('profile_not_in_package');
    expect((await request(app).post(`${P}/center-bold-v1/approve`).send({ projectId: id })).body.error).toBe('by_required');
    const ok = await request(app).post(`${P}/center-bold-v1/approve`).send({ projectId: id, by: 'Eden' });
    expect(ok.body.default).toMatchObject({ id: 'center-bold-v1', version: '1', params: { caption_size: 96, caption_y_px: 960 } });
    const up = await upload('next.mp4');
    const l = await lease();
    expect(l.job.options.profile).toMatchObject({ id: 'center-bold-v1', version: '1', params: { caption_size: 96 } });
    await finish(l, up.body.project.source.sha256);
    expect((await request(app).post(`${P}/clear-default`).send({})).body.default).toBeNull();
    await request(app).post(`/api/dana/studio/projects/${id}/request-changes`).send({ note: 'שינוי' });
    const l2 = await lease();
    expect(l2.job.options.profile).toBeUndefined();
    await finish(l2, (await get(id)).source.sha256);
    const legacy = await ready({ adapter: 'scripted' }, { legacy: true });
    expect((await request(app).post(`${P}/center-bold-v1/approve`).send({ projectId: legacy.id, by: 'Eden' })).body.error).toBe('profile_not_in_package');
  });
});
