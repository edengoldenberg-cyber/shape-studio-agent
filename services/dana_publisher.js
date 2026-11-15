'use strict';

/**
 * dana_publisher.js — scheduling, publication, verification and metrics. DRY-RUN ONLY.
 *
 * No real provider is connected. The only publisher that can run is "mock": an HTTP client
 * that talks to a local stand-in API (scripts/dana_mock_social_api.cjs) on 127.0.0.1, or the
 * in-process MockPublisher used by unit tests. The container flow it speaks (create container →
 * read status → publish → read media) mirrors what the audit described for Instagram, which is
 * a HYPOTHESIS until verified for the chosen account, app, API version and login flow.
 *
 * Gates (all must be open; default: closed):
 *   DANA_PUBLISHING_ENABLED=true · DANA_PUBLISHER_MODE=mock · not globally paused ·
 *   valid owner approval of the exact package · publication consent recorded ·
 *   destination account · schedule.
 * Dana's own editorial acceptance is NOT one of them and never authorises publication.
 *
 * Lifecycle:   scheduled → processing → published | failed | uncertain   (+ cancelled)
 *   • every transition is written to disk BEFORE the provider is called;
 *   • after a restart the stored state is resumed and the provider's status is READ first;
 *   • once a publish request has been sent, an error means "unknown": the state becomes
 *     "uncertain" and is never retried blindly — reconcile() looks for the post instead;
 *   • "published" requires a media id AND a permalink, and the published caption is compared
 *     with the approved one;
 *   • expired credentials fail the attempt before anything is published and can be resumed.
 */

const TZ = 'Asia/Jerusalem';
const enabled = () => process.env.DANA_PUBLISHING_ENABLED === 'true';
const mode    = () => process.env.DANA_PUBLISHER_MODE || null;
const studio  = () => require('./dana_studio');

// ── Time: everything shown to the owner is Asia/Jerusalem ─────────────────────
function tzParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
}
/** "YYYY-MM-DDTHH:MM" as wall-clock time in Israel → Date */
function fromLocal(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = want;
  for (let i = 0; i < 3; i++) { const p = tzParts(new Date(guess)); guess += want - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm); }
  return new Date(guess);
}
function toLocal(iso) {
  if (!iso) return null;
  const p = tzParts(new Date(iso)), z = n => String(n).padStart(2, '0');
  return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.hh)}:${z(p.mm)}`;
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function calendar() {
  const s = studio(), out = [];
  for (const p of Object.values(s.state().projects)) {
    const v = s.currentVersion(p);
    if (!v?.scheduledAt && !p.publication) continue;
    out.push({ projectId: p.id, title: p.title, version: v?.n ?? null, scheduledAt: p.publication?.scheduledAt ?? v?.scheduledAt ?? null,
      scheduledLocal: toLocal(p.publication?.scheduledAt ?? v?.scheduledAt), timezone: TZ,
      state: p.publication?.state ?? (s.approvalValid(v) ? 'approved_not_scheduled' : 'proposed'),
      permalink: p.publication?.permalink ?? null });
  }
  return out.sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
}
/**
 * A proposed time for a new package: the next day at 12:00 Israel time, at least 24 hours
 * after anything already on the calendar. This is a neutral default so that a package always
 * carries a concrete time to approve — it is NOT a "best time to post" recommendation.
 */
function proposeTime(now = Date.now()) {
  const busy = calendar().filter(c => c.scheduledAt && !['cancelled', 'failed'].includes(c.state)).map(c => Date.parse(c.scheduledAt));
  let t = now;
  for (let i = 0; i < 60; i++) {
    const p = tzParts(new Date(t + 24 * 3600e3)), z = n => String(n).padStart(2, '0');
    const slot = fromLocal(`${p.y}-${z(p.m)}-${z(p.d)}T12:00`).getTime();
    if (slot > now && !busy.some(b => Math.abs(b - slot) < 24 * 3600e3)) return new Date(slot).toISOString();
    t += 24 * 3600e3;
  }
  return new Date(now + 48 * 3600e3).toISOString();
}

// ── Global pause ──────────────────────────────────────────────────────────────
const paused = () => !!studio().state().settings?.publishingPaused;
function setPaused(value, actor = 'owner') {
  const s = studio().state();
  s.settings = { ...(s.settings ?? {}), publishingPaused: !!value, pausedAt: value ? new Date().toISOString() : null, pausedBy: value ? actor : null };
  studio().save();
  return s.settings;
}

// ── Gate ──────────────────────────────────────────────────────────────────────
function gate(project) {
  const s = studio(), v = s.currentVersion(project), blocked = [];
  if (!enabled()) blocked.push({ code: 'publishing_disabled', message: 'פרסום כבוי בשלב הזה (DANA_PUBLISHING_ENABLED)' });
  else if (mode() === 'instagram') {
    const ig = require('./dana_instagram').status();
    if (!ig.ready) blocked.push({ code: 'publisher_not_configured', message: 'חיבור אינסטגרם לא הושלם: ' + ig.problems.join('; ') });
  }
  else if (mode() !== 'mock') blocked.push({ code: 'publisher_not_configured', message: 'לא מחובר ספק פרסום (DANA_PUBLISHER_MODE).' });
  if (paused()) blocked.push({ code: 'publishing_paused', message: 'כל הפרסומים מושהים (השהיה כללית)' });
  if (!v || !s.approvalValid(v)) blocked.push({ code: 'not_approved', message: 'אין אישור תקף של הבעלים לגרסה הנוכחית' });
  if (project.consent?.status !== 'confirmed') blocked.push({ code: 'consent_missing', message: 'לא תועדה הסכמה לפרסום של המצולמים' });
  if (!v?.destination?.account) blocked.push({ code: 'destination_missing', message: 'חשבון היעד לא הוגדר' });
  if (!v?.scheduledAt) blocked.push({ code: 'schedule_missing', message: 'לא נקבע מועד פרסום' });
  // Through the API the cover is a frame of the video (thumb_offset). The designed cover with text would need a
  // public image URL, which is not offered; the page says so instead of promising a cover that will not be used.
  const coverNote = mode() === 'instagram' ? `בפרסום דרך ה-API הקאבר יהיה הפריים בשנייה ${v?.package?.cover?.frame_s ?? 0} של הסרטון, בלי שכבת הטקסט. קאבר מעוצב עם טקסט מוחלף ידנית באפליקציה אחרי הפרסום.` : null;
  return { allowed: blocked.length === 0, blocked, mode: enabled() ? mode() : null, paused: paused(), coverNote };
}

function createPublication(project, actor = 'owner') {
  const s = studio(), g = gate(project);
  if (!g.allowed) throw new s.StudioError(409, 'publication_blocked', 'הפרסום חסום', { blocked: g.blocked });
  if (project.publication && !['failed', 'cancelled'].includes(project.publication.state)) throw new s.StudioError(409, 'publication_exists', 'כבר קיימת רשומת פרסום לפרויקט');
  const v = s.currentVersion(project);
  project.publication = { id: `pub_${Date.now().toString(36)}${require('crypto').randomBytes(3).toString('hex')}`, mode: mode(), state: 'scheduled',
    version: v.n, fingerprint: v.approval.fingerprint, scheduledAt: v.scheduledAt, containerId: null, mediaId: null, permalink: null,
    attempts: 0, error: null, verification: null, metrics: [], log: [{ at: new Date().toISOString(), state: 'scheduled' }] };
  s.hist(project, actor, 'publication_scheduled', { version: v.n, scheduledAt: v.scheduledAt, mode: mode() });
  s.save();
  return project.publication;
}

function cancel(project, actor = 'owner') {
  const s = studio(), pub = project.publication;
  if (!pub || pub.state !== 'scheduled') throw new s.StudioError(409, 'not_cancellable', 'אפשר לבטל רק פרסום מתוזמן שעוד לא התחיל');
  move(project, 'cancelled', {}, actor);
  return pub;
}

function move(project, state, patch, actor = 'system') {
  const s = studio();
  Object.assign(project.publication, patch, { state });
  project.publication.log.push({ at: new Date().toISOString(), state, ...(patch.error ? { error: patch.error } : {}) });
  s.hist(project, actor, 'publication_' + state, { containerId: project.publication.containerId, mediaId: project.publication.mediaId, error: patch.error });
  s.save();                              // durable BEFORE the next provider call
}

async function finish(project, publisher) {
  const s = studio(), pub = project.publication, v = s.currentVersion(project);
  const media = publisher.getMedia ? await publisher.getMedia(pub.mediaId) : { permalink: await publisher.getPermalink(pub.mediaId) };
  if (!media?.permalink) { move(project, 'uncertain', { error: 'published without a permalink — verify manually' }); return pub; }
  const captionMatches = media.caption === undefined ? null : media.caption === [v.caption.text, v.caption.cta].filter(Boolean).join('\n\n');
  move(project, 'published', { permalink: media.permalink, publishedAt: pub.publishedAt ?? new Date().toISOString(), error: null,
    verification: { mediaId: pub.mediaId, permalink: media.permalink, captionMatches, verifiedAt: new Date().toISOString(), via: pub.reconciled ? 'reconciliation' : 'publish_response' } });
  return pub;
}

/**
 * Advance one publication as far as it can go. Safe to call again after a crash: it resumes
 * from the stored state and reads the provider's status before anything that could post twice.
 */
async function advance(project, publisher, { now = Date.now() } = {}) {
  const s = studio(), pub = project.publication;
  if (!pub) throw new s.StudioError(409, 'no_publication', 'אין רשומת פרסום');
  if (['published', 'failed', 'cancelled', 'uncertain'].includes(pub.state)) return pub;

  // The approval must still be the one that was scheduled, and every gate still open.
  const v = s.currentVersion(project);
  if (!enabled() || !s.approvalValid(v) || v.approval.fingerprint !== pub.fingerprint || project.consent?.status !== 'confirmed') {
    move(project, 'failed', { error: 'approval, consent or publishing switch changed after scheduling', errorCode: 'gate_closed' });
    return pub;
  }
  if (paused() && !pub.publishRequestedAt) return pub;                 // global pause: nothing new goes out
  if (pub.state === 'scheduled') {
    if (Date.parse(pub.scheduledAt) > now) return pub;
    move(project, 'processing', { attempts: pub.attempts + 1 });
  }
  try {
    // A real provider: before anything is created, the token must belong to the account the owner approved.
    if (publisher.whoAmI && !pub.accountVerified) {
      const me = await publisher.whoAmI();
      const want = String(v.destination.account || '').replace(/^@/, '').toLowerCase();
      if (!me.matchesConfiguredId || !me.username || me.username.toLowerCase() !== want) {
        move(project, 'failed', { error: `החשבון המחובר (@${me.username ?? '?'}) אינו חשבון היעד שאושר (@${want}) — לא נשלח דבר`, errorCode: 'destination_mismatch', resumable: true });
        return pub;
      }
      move(project, 'processing', { accountVerified: { id: me.id, username: me.username, at: new Date().toISOString() } });
    }
    if (!pub.containerId) {
      const { containerId } = await publisher.createContainer({ projectId: project.id, version: pub.version, clientRef: pub.id,
        caption: [v.caption.text, v.caption.cta].filter(Boolean).join('\n\n'), destination: v.destination, coverFrameS: v.package?.cover?.frame_s,
        videoSha256: v.artifacts['final.mp4']?.sha256, coverSha256: v.artifacts['cover.jpg']?.sha256 });
      move(project, 'processing', { containerId });
    }
    const status = await publisher.getContainerStatus(pub.containerId);       // READ before any publish call
    if (status === 'PUBLISHED' && !pub.mediaId) { move(project, 'uncertain', { error: 'the provider says published but the media id is unknown' }); return pub; }
    if (status === 'ERROR' || status === 'EXPIRED') { move(project, 'failed', { error: `container ${status}`, errorCode: 'container_' + status.toLowerCase() }); return pub; }
    if (status === 'IN_PROGRESS') return pub;
    if (!pub.mediaId) {
      move(project, 'processing', { publishRequestedAt: new Date().toISOString() });
      const { mediaId } = await publisher.publish(pub.containerId);
      move(project, 'processing', { mediaId, publishedAt: new Date().toISOString() });
    }
    return await finish(project, publisher);
  } catch (e) {
    // After a publish request was sent, an error means "we do not know". Never retry blindly.
    if (pub.publishRequestedAt && !pub.mediaId) move(project, 'uncertain', { error: `publish outcome unknown: ${e.message}`, errorCode: e.code ?? 'unknown' });
    else if (pub.mediaId) move(project, 'uncertain', { error: `published (media ${pub.mediaId}) but verification failed: ${e.message}`, errorCode: e.code ?? 'verify_failed' });
    else if (e.code === 'auth_expired') move(project, 'failed', { error: 'פג תוקף ההרשאה מול ספק הפרסום — יש לחדש ואז להמשיך', errorCode: 'auth_expired', resumable: true });
    else if (e.retryable && pub.attempts < 3) move(project, 'processing', { error: e.message, attempts: pub.attempts + 1 });
    else move(project, 'failed', { error: e.message, errorCode: e.code ?? 'provider_error', resumable: true });
  }
  return pub;
}

/** A failed attempt that never sent a publish request can be resumed (e.g. after renewing credentials). */
function resume(project, actor = 'owner') {
  const s = studio(), pub = project.publication;
  if (!pub || pub.state !== 'failed' || !pub.resumable || pub.publishRequestedAt) throw new s.StudioError(409, 'not_resumable', 'אי אפשר להמשיך את הפרסום הזה');
  move(project, 'processing', { error: null, errorCode: null, resumable: false, attempts: pub.attempts + 1 }, actor);
  return pub;
}

/**
 * "uncertain" → look for the post instead of publishing again.
 *   provider says the container is not published  → safe to continue (nothing went out);
 *   exactly one post carries our reference         → published, verified by reconciliation;
 *   anything else                                  → stays uncertain for the owner.
 */
async function reconcile(project, publisher) {
  const s = studio(), pub = project.publication;
  if (!pub || pub.state !== 'uncertain') throw new s.StudioError(409, 'not_uncertain', 'אין פרסום במצב לא-ודאי');
  try {
    if (pub.mediaId) { pub.reconciled = true; return await finish(project, publisher); }
    const status = await publisher.getContainerStatus(pub.containerId);
    const v = s.currentVersion(project);
    const found = publisher.findByRef ? await publisher.findByRef(pub.id, { caption: [v.caption.text, v.caption.cta].filter(Boolean).join('\n\n'), since: pub.publishRequestedAt }) : [];
    if (found.length === 1) { pub.reconciled = true; move(project, 'processing', { mediaId: found[0].id, publishedAt: found[0].timestamp ?? new Date().toISOString() }); return await finish(project, publisher); }
    if (found.length === 0 && status === 'FINISHED') { move(project, 'processing', { publishRequestedAt: null, error: null, note: 'provider reports the container unpublished — safe to continue' }); return pub; }
    move(project, 'uncertain', { error: `reconciliation inconclusive (container ${status}, ${found.length} matching posts) — check the account manually` });
  } catch (e) { move(project, 'uncertain', { error: `reconciliation failed: ${e.message}` }); }
  return pub;
}

// ── Metrics ───────────────────────────────────────────────────────────────────
const metricOffsetsH = () => (process.env.DANA_METRICS_OFFSETS_H || '48,168').split(',').map(Number).filter(n => n > 0);
async function collectMetrics(project, publisher, { now = Date.now() } = {}) {
  const s = studio(), pub = project.publication;
  if (!pub || pub.state !== 'published' || !publisher.getInsights) return [];
  const added = [];
  for (const h of metricOffsetsH()) {
    if (pub.metrics.some(m => m.offsetHours === h) || now < Date.parse(pub.publishedAt) + h * 3600e3) continue;
    const r = await publisher.getInsights(pub.mediaId);
    if (!r || String(r.media_id) !== String(pub.mediaId)) {             // never attach numbers to the wrong post
      s.hist(project, 'system', 'metrics_rejected', { offsetHours: h, expected: pub.mediaId, got: r?.media_id ?? null });
      continue;
    }
    const m = { offsetHours: h, collectedAt: new Date(now).toISOString(), mediaId: pub.mediaId, source: pub.mode === 'mock' ? 'MOCK' : 'instagram',
                values: r.values ?? {}, note: pub.mode === 'mock' ? 'נתוני דמה לבדיקת החיבור — לא ביצועים אמיתיים' : null };
    pub.metrics.push(m); added.push(m);
    s.hist(project, 'system', 'metrics_collected', { offsetHours: h, mediaId: pub.mediaId, source: m.source });
  }
  if (added.length) s.save();
  return added;
}

/** One scheduler pass over everything on the calendar. */
async function tick(publisher, { now = Date.now() } = {}) {
  const s = studio(), report = [];
  for (const p of Object.values(s.state().projects)) {
    if (!p.publication) continue;
    const before = p.publication.state;
    if (['scheduled', 'processing'].includes(before)) await advance(p, publisher, { now });
    if (p.publication.state === 'published') await collectMetrics(p, publisher, { now }).catch(() => {});
    report.push({ projectId: p.id, before, after: p.publication.state });
  }
  return report;
}

// ── Publishers ────────────────────────────────────────────────────────────────
/** HTTP client for the container flow. Loopback only: a real provider is not connected in this phase. */
class HttpPublisher {
  constructor({ base = process.env.DANA_PUBLISH_API_BASE, token = process.env.DANA_PUBLISH_API_TOKEN, account = 'test-account',
                timeoutMs = Number(process.env.DANA_PUBLISH_TIMEOUT_MS) || 8000 } = {}) {
    const host = (() => { try { return new URL(base).hostname; } catch { return null; } })();
    if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('HttpPublisher: only a local mock API is allowed in this phase (no real provider is verified)');
    Object.assign(this, { base: base.replace(/\/$/, ''), token, account, timeoutMs });
  }
  async call(method, path, body) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(this.base + path, { method, signal: ctl.signal, headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) throw Object.assign(new Error('credentials rejected (401)'), { code: 'auth_expired' });
      if (!r.ok) throw Object.assign(new Error(`provider error ${r.status}: ${j.error ?? ''}`), { code: 'provider_' + r.status, retryable: r.status >= 500 });
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error(`timeout after ${this.timeoutMs}ms`), { code: 'timeout', retryable: true });
      throw e;
    } finally { clearTimeout(timer); }
  }
  async createContainer(x) { const j = await this.call('POST', `/${this.account}/media`, { caption: x.caption, client_ref: x.clientRef, video_sha256: x.videoSha256, cover_sha256: x.coverSha256, media_type: 'REELS' }); return { containerId: j.id }; }
  async getContainerStatus(id) { return (await this.call('GET', `/containers/${id}`)).status_code; }
  async publish(id) { return { mediaId: (await this.call('POST', `/${this.account}/media_publish`, { creation_id: id })).id }; }
  async getMedia(id) { return this.call('GET', `/media/${id}`); }
  async findByRef(ref) { return ((await this.call('GET', `/${this.account}/media`)).data ?? []).filter(m => m.client_ref === ref); }
  async getInsights(id) { return this.call('GET', `/media/${id}/insights`); }
}

/** Scripted in-process publisher for unit tests. `script` overrides any step with a function. */
class MockPublisher {
  constructor(script = {}) { this.script = script; this.calls = []; this.published = 0; }
  async createContainer(input) { this.calls.push('createContainer'); return this.script.createContainer ? this.script.createContainer(input) : { containerId: 'c_1' }; }
  async getContainerStatus(id) { this.calls.push('getContainerStatus'); return this.script.getContainerStatus ? this.script.getContainerStatus(id) : 'FINISHED'; }
  async publish(id) { this.calls.push('publish'); this.published++; return this.script.publish ? this.script.publish(id) : { mediaId: 'm_1' }; }
  async getPermalink(id) { this.calls.push('getPermalink'); return this.script.getPermalink ? this.script.getPermalink(id) : 'https://example.invalid/reel/m_1'; }
}

function configuredPublisher() {
  const s = studio();
  if (enabled() && mode() === 'mock') return new HttpPublisher();
  if (enabled() && mode() === 'instagram') {
    const ig = require('./dana_instagram');
    if (!ig.status().ready) throw new s.StudioError(409, 'publisher_not_configured', 'חיבור אינסטגרם לא הושלם', { problems: ig.status().problems });
    return new ig.InstagramPublisher({ files: (projectId, n, name) => s.artifactPath(projectId, n, name) });
  }
  throw new s.StudioError(409, 'publisher_not_configured', 'אין ספק פרסום פעיל');
}

/**
 * The production scheduler: one pass a minute, only when publishing is switched on with a real
 * provider. Never starts under test or in mock mode (dry runs call tick explicitly). A pass that
 * is still running is not overlapped, and an error in one pass does not stop the next.
 */
let _timer = null, _busy = false;
function startScheduler() {
  if (_timer || process.env.TEST_NO_BIND === 'true' || !enabled() || mode() !== 'instagram') return false;
  _timer = setInterval(async () => {
    if (_busy) return; _busy = true;
    try { await tick(configuredPublisher()); }
    catch (e) { try { require('../utils/logger').error('[dana-publisher] scheduler pass failed', { error: e.message }); } catch { /* */ } }
    finally { _busy = false; }
  }, 60 * 1000);
  _timer.unref?.();
  return true;
}

module.exports = { startScheduler, TZ, enabled, mode, gate, createPublication, cancel, advance, resume, reconcile, collectMetrics, tick, calendar, proposeTime,
  paused, setPaused, fromLocal, toLocal, HttpPublisher, MockPublisher, configuredPublisher };
