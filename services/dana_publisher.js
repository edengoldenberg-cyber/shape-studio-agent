'use strict';

/**
 * dana_publisher.js — the publication SEAM. No live publishing exists in this phase.
 *
 * What is here:
 *   gate(project)                 why publication is / is not allowed right now
 *   createPublication / advance   a durable lifecycle  approved → scheduled → processing → published | failed | uncertain
 *   the Publisher interface       createContainer · getContainerStatus · publish · getPermalink
 *   MockPublisher                 scripted behaviour for lifecycle tests
 *
 * What is NOT here: any Meta call, token, account connection or permission. The
 * interface mirrors the container flow described in the audit, which is a HYPOTHESIS
 * until it is verified for the selected account, app, API version and login flow.
 *
 * Rules the lifecycle enforces whatever the provider turns out to be:
 *   • DANA_PUBLISHING_ENABLED must be exactly "true" (default: off).
 *   • The current version must hold a VALID approval (same fingerprint).
 *   • Publication consent must be recorded as confirmed.
 *   • Every transition is written to disk BEFORE the provider is called.
 *   • After a timeout / restart the status is READ first. An unknown outcome becomes
 *     "uncertain" and is never retried automatically (no duplicate posts).
 *   • "published" requires a media id AND a permalink.
 */

const enabled = () => process.env.DANA_PUBLISHING_ENABLED === 'true';

function gate(project) {
  const studio = require('./dana_studio');
  const v = studio.currentVersion(project);
  const blocked = [];
  if (!enabled()) blocked.push({ code: 'publishing_disabled', message: 'פרסום כבוי בשלב הזה (DANA_PUBLISHING_ENABLED)' });
  if (!v || !studio.approvalValid(v)) blocked.push({ code: 'not_approved', message: 'אין אישור תקף לגרסה הנוכחית' });
  if (project.consent?.status !== 'confirmed') blocked.push({ code: 'consent_missing', message: 'לא תועדה הסכמה לפרסום של המצולמים' });
  if (!v?.destination?.account) blocked.push({ code: 'destination_missing', message: 'חשבון היעד לא הוגדר' });
  if (!v?.scheduledAt) blocked.push({ code: 'schedule_missing', message: 'לא נקבע מועד פרסום' });
  return { allowed: blocked.length === 0, blocked };
}

function createPublication(project, actor = 'owner') {
  const studio = require('./dana_studio');
  const g = gate(project);
  if (!g.allowed) throw new studio.StudioError(409, 'publication_blocked', 'הפרסום חסום', { blocked: g.blocked });
  if (project.publication && !['failed', 'cancelled'].includes(project.publication.state)) throw new studio.StudioError(409, 'publication_exists', 'כבר קיימת רשומת פרסום לפרויקט');
  const v = studio.currentVersion(project);
  project.publication = { state: 'scheduled', version: v.n, fingerprint: v.approval.fingerprint, scheduledAt: v.scheduledAt,
    containerId: null, mediaId: null, permalink: null, attempts: 0, error: null, log: [{ at: new Date().toISOString(), state: 'scheduled' }] };
  studio.hist(project, actor, 'publication_scheduled', { version: v.n, scheduledAt: v.scheduledAt });
  studio.save();
  return project.publication;
}

function cancel(project, actor = 'owner') {
  const studio = require('./dana_studio'), pub = project.publication;
  if (!pub || pub.state !== 'scheduled') throw new studio.StudioError(409, 'not_cancellable', 'אפשר לבטל רק פרסום מתוזמן שעוד לא התחיל');
  move(project, 'cancelled', {}, actor);
  return pub;
}

function move(project, state, patch, actor = 'system') {
  const studio = require('./dana_studio');
  Object.assign(project.publication, patch, { state });
  project.publication.log.push({ at: new Date().toISOString(), state, ...(patch.error ? { error: patch.error } : {}) });
  studio.hist(project, actor, 'publication_' + state, { containerId: project.publication.containerId, mediaId: project.publication.mediaId });
  studio.save();                         // durable BEFORE the next provider call
}

/**
 * Advance one publication as far as it can go with the given publisher.
 * Safe to call again after a crash: it resumes from the stored state and reads the
 * provider's status before doing anything that could create a second post.
 */
async function advance(project, publisher, { now = Date.now() } = {}) {
  const studio = require('./dana_studio'), pub = project.publication;
  if (!pub) throw new studio.StudioError(409, 'no_publication', 'אין רשומת פרסום');
  if (['published', 'failed', 'cancelled', 'uncertain'].includes(pub.state)) return pub;

  // The approval must still be the one that was scheduled.
  const v = studio.currentVersion(project);
  if (!enabled() || !studio.approvalValid(v) || v.approval.fingerprint !== pub.fingerprint || project.consent?.status !== 'confirmed') {
    move(project, 'failed', { error: 'approval, consent or publishing switch changed after scheduling' });
    return pub;
  }
  if (pub.state === 'scheduled') {
    if (Date.parse(pub.scheduledAt) > now) return pub;
    move(project, 'processing', { attempts: pub.attempts + 1 });
  }
  try {
    if (!pub.containerId) {
      const { containerId } = await publisher.createContainer({ projectId: project.id, version: pub.version, caption: v.caption, destination: v.destination });
      move(project, 'processing', { containerId });
    }
    const status = await publisher.getContainerStatus(pub.containerId);       // READ before any publish call
    if (status === 'PUBLISHED' && !pub.mediaId) { move(project, 'uncertain', { error: 'container is published but the media id is unknown — verify manually' }); return pub; }
    if (status === 'ERROR' || status === 'EXPIRED') { move(project, 'failed', { error: `container ${status}` }); return pub; }
    if (status === 'IN_PROGRESS') return pub;
    if (!pub.mediaId) {
      move(project, 'processing', { publishRequestedAt: new Date().toISOString() });
      const { mediaId } = await publisher.publish(pub.containerId);
      move(project, 'processing', { mediaId });
    }
    const permalink = await publisher.getPermalink(pub.mediaId);
    if (!permalink) { move(project, 'uncertain', { error: 'published without a permalink — verify manually' }); return pub; }
    move(project, 'published', { permalink, publishedAt: new Date().toISOString() });
  } catch (e) {
    // After a publish request was sent, an error means "we do not know". Never retry blindly.
    if (pub.publishRequestedAt && !pub.mediaId) move(project, 'uncertain', { error: `publish outcome unknown: ${e.message}` });
    else if (e.retryable && pub.attempts < 3) move(project, 'processing', { error: e.message, attempts: pub.attempts + 1 });
    else move(project, 'failed', { error: e.message });
  }
  return pub;
}

/** Scripted publisher for lifecycle tests. `script` overrides any step with a function. */
class MockPublisher {
  constructor(script = {}) { this.script = script; this.calls = []; this.published = 0; }
  async createContainer(input) { this.calls.push('createContainer'); return this.script.createContainer ? this.script.createContainer(input) : { containerId: 'c_1' }; }
  async getContainerStatus(id) { this.calls.push('getContainerStatus'); return this.script.getContainerStatus ? this.script.getContainerStatus(id) : 'FINISHED'; }
  async publish(id) { this.calls.push('publish'); this.published++; return this.script.publish ? this.script.publish(id) : { mediaId: 'm_1' }; }
  async getPermalink(id) { this.calls.push('getPermalink'); return this.script.getPermalink ? this.script.getPermalink(id) : 'https://example.invalid/reel/m_1'; }
}

module.exports = { enabled, gate, createPublication, cancel, advance, MockPublisher };
