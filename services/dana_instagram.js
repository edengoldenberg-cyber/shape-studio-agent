'use strict';

/**
 * dana_instagram.js — the REAL Instagram publisher and insights reader. DISABLED BY DEFAULT.
 *
 * It implements the same interface as the mock publisher (dana_publisher.js) on top of the
 * Instagram Platform content-publishing flow:
 *     POST /<ig-user-id>/media                 create a REELS container
 *     (resumable upload of the file, or the provider fetches a URL)
 *     GET  /<container-id>?fields=status_code  wait for FINISHED
 *     POST /<ig-user-id>/media_publish         publish
 *     GET  /<media-id>?fields=permalink,…      verify
 *     GET  /<media-id>/insights                metrics
 * The contract and its sources are recorded in docs/DANA_INSTAGRAM_CONTRACT.md. It has been
 * checked against the official documentation and against a local contract fake; it has NOT been
 * exercised against a real account. The first live call is part of the owner-approved sequence.
 *
 * It can only be constructed when ALL of these are set (names only — values never appear in code,
 * logs, prompts or commits):
 *   DANA_PUBLISHER_MODE=instagram
 *   DANA_INSTAGRAM_LIVE=true          explicit second switch
 *   DANA_IG_LOGIN=facebook|instagram  which login flow issued the token (decides host and upload path)
 *   DANA_IG_API_VERSION=vNN.N         pinned; never "latest"
 *   DANA_IG_USER_ID                   the Instagram professional account id
 *   DANA_IG_ACCESS_TOKEN              a token with content-publish and insights permissions
 * The Meta lead-ads token (META_PAGE_ACCESS_TOKEN) is never read here.
 *
 * Secrets: the token is sent only in the Authorization header (never in a URL), and every error
 * message is scrubbed before it is stored or logged.
 */

const fs   = require('fs');
const path = require('path');

const HOSTS = { facebook: 'https://graph.facebook.com', instagram: 'https://graph.instagram.com' };
const RUPLOAD = 'https://rupload.facebook.com';
const REEL_METRICS = ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
const REQUIRED = ['DANA_IG_LOGIN', 'DANA_IG_API_VERSION', 'DANA_IG_USER_ID', 'DANA_IG_ACCESS_TOKEN'];

function config(env = process.env, { requireLive = true } = {}) {
  const missing = REQUIRED.filter(k => !env[k]);
  const problems = [];
  if (requireLive && env.DANA_INSTAGRAM_LIVE !== 'true') problems.push('DANA_INSTAGRAM_LIVE is not "true"');
  if (missing.length) problems.push('missing: ' + missing.join(', '));
  if (env.DANA_IG_LOGIN && !HOSTS[env.DANA_IG_LOGIN]) problems.push('DANA_IG_LOGIN must be facebook or instagram');
  if (env.DANA_IG_API_VERSION && !/^v\d{2}\.\d$/.test(env.DANA_IG_API_VERSION)) problems.push('DANA_IG_API_VERSION must look like v24.0');
  if (env.DANA_IG_USER_ID && !/^\d{5,25}$/.test(env.DANA_IG_USER_ID)) problems.push('DANA_IG_USER_ID must be numeric');
  return { ok: problems.length === 0, problems, login: env.DANA_IG_LOGIN, version: env.DANA_IG_API_VERSION, userId: env.DANA_IG_USER_ID,
           coverMode: env.DANA_IG_COVER_MODE === 'signed_url' ? 'signed_url' : 'thumb_offset' };
}
/** What is configured — names and shapes only, never a value of a secret. */
function status(env = process.env) {
  const c = config(env);
  return { ready: c.ok, problems: c.problems, credentialsConfigured: config(env, { requireLive: false }).ok, login: c.login ?? null, apiVersion: c.version ?? null, userIdConfigured: !!c.userId,
           tokenConfigured: !!env.DANA_IG_ACCESS_TOKEN, coverMode: c.coverMode, verifiedAgainstRealAccount: false };
}

const scrub = (text, token) => String(text ?? '').split(token || '\u0000').join('[token]').replace(/access_token=[^&\s"]+/g, 'access_token=[token]').slice(0, 400);

class InstagramPublisher {
  /**
   * @param files  (projectId, version, name) → absolute path of a stored artifact
   * @param publicUrl  optional (projectId, version, name) → short-lived signed URL (only when the login flow needs a URL)
   */
  constructor({ env = process.env, files, publicUrl = null, base = null, uploadBase = null, timeoutMs = Number(env.DANA_PUBLISH_TIMEOUT_MS) || 30000, fetchImpl = fetch, readOnly = false } = {}) {
    // readOnly: a connection check that may run while every publishing switch is still off. It can only
    // issue the two GET requests of whoAmI() and publishingLimit(); every write method refuses.
    const c = config(env, { requireLive: !readOnly });
    this.readOnly = readOnly;
    if (!c.ok) throw Object.assign(new Error('Instagram publisher is not configured: ' + c.problems.join('; ')), { code: 'publisher_not_configured' });
    Object.assign(this, { c, token: env.DANA_IG_ACCESS_TOKEN, files, publicUrl, timeoutMs, fetch: fetchImpl,
      base: `${base ?? HOSTS[c.login]}/${c.version}`, uploadBase: `${uploadBase ?? RUPLOAD}/ig-api-upload/${c.version}` });
  }

  async call(method, url, { params, headers, body } = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    const u = new URL(url);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    try {
      const r = await this.fetch(u, { method, signal: ctl.signal, body, headers: { Authorization: `Bearer ${this.token}`, ...(headers ?? {}) } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const e = j.error ?? {};
        const code = [190, 102].includes(e.code) || r.status === 401 ? 'auth_expired'
          : [4, 17, 32, 613, 341, 80002].includes(e.code) || r.status === 429 ? 'rate_limited'
          : e.code === 9 && e.error_subcode === 2207042 ? 'publishing_limit_reached'
          : e.code === 10 || (e.code >= 200 && e.code <= 299) ? 'permission_missing'
          : `provider_${e.code ?? r.status}`;
        throw Object.assign(new Error(scrub(`${e.message ?? 'provider error'} (code ${e.code ?? r.status}${e.error_subcode ? '/' + e.error_subcode : ''})`, this.token)),
          { code, retryable: code === 'rate_limited' || r.status >= 500, providerCode: e.code ?? null, subcode: e.error_subcode ?? null, trace: e.fbtrace_id ?? null });
      }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error(`timeout after ${this.timeoutMs}ms`), { code: 'timeout', retryable: true });
      if (e.code) throw e;
      throw Object.assign(new Error(scrub(e.message, this.token)), { code: 'network', retryable: true });
    } finally { clearTimeout(timer); }
  }

  /** Read-only: who the token belongs to. Used before the first publication and by the status page. */
  async whoAmI() {
    const fields = this.c.login === 'instagram' ? 'user_id,username,account_type' : 'id,username';
    const raw = await this.call('GET', `${this.base}/${this.c.login === 'instagram' ? 'me' : this.c.userId}`, { params: { fields } });
    const j = Array.isArray(raw.data) ? (raw.data[0] ?? {}) : raw;            // the Instagram Login sample wraps the object in data[]
    return { id: String(j.user_id ?? j.id ?? ''), username: j.username ?? null, accountType: j.account_type ?? null, matchesConfiguredId: String(j.user_id ?? j.id ?? '') === this.c.userId };
  }
  async publishingLimit() {
    const j = await this.call('GET', `${this.base}/${this.c.userId}/content_publishing_limit`, { params: { fields: 'quota_usage,config' } });
    const d = j.data?.[0] ?? {};
    return { used: d.quota_usage ?? null, total: d.config?.quota_total ?? null };
  }

  async createContainer(x) {
    if (this.readOnly) throw Object.assign(new Error('read-only connection check: nothing may be created'), { code: 'read_only' });
    const video = this.files(x.projectId, x.version, 'final.mp4');
    const params = { media_type: 'REELS', caption: x.caption, share_to_feed: true };
    if (this.c.coverMode === 'signed_url' && this.publicUrl) params.cover_url = this.publicUrl(x.projectId, x.version, 'cover.jpg');
    else if (Number.isFinite(x.coverFrameS)) params.thumb_offset = Math.round(x.coverFrameS * 1000);
    if (this.c.login === 'facebook') {
      // Resumable upload: the file goes straight from this server to the provider; no public URL exists.
      const { id, uri } = await this.call('POST', `${this.base}/${this.c.userId}/media`, { params: { ...params, upload_type: 'resumable' } });
      const size = fs.statSync(video).size;
      if (size > 300 * 1024 * 1024) throw Object.assign(new Error('the video is larger than the documented 300 MB limit for Reels'), { code: 'video_too_large' });
      const target = uri && new URL(uri).origin === new URL(this.uploadBase).origin ? uri : `${this.uploadBase}/${id}`;   // never follow a URI to another host
      const up = await this.call('POST', target, { headers: { Authorization: `OAuth ${this.token}`, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' },
        body: fs.readFileSync(video) });
      if (up.success !== true) throw Object.assign(new Error(scrub('the provider did not confirm the upload: ' + (up.debug_info?.message ?? up.message ?? 'no success flag'), this.token)),
        { code: 'upload_rejected', retryable: !!up.debug_info?.retriable });
      return { containerId: String(id) };
    }
    // Instagram Login: the provider fetches the file from a URL. Only a short-lived signed URL of the approved file is offered.
    if (!this.publicUrl) throw Object.assign(new Error('this login flow needs a signed media URL, which is not enabled'), { code: 'signed_url_disabled' });
    const { id } = await this.call('POST', `${this.base}/${this.c.userId}/media`, { params: { ...params, video_url: this.publicUrl(x.projectId, x.version, 'final.mp4') } });
    return { containerId: String(id) };
  }
  async getContainerStatus(id) {
    const j = await this.call('GET', `${this.base}/${id}`, { params: { fields: 'status_code,status' } });
    this.lastStatusDetail = j.status ?? null;
    return j.status_code;
  }
  async publish(containerId) {
    if (this.readOnly) throw Object.assign(new Error('read-only connection check: nothing may be published'), { code: 'read_only' });
    const j = await this.call('POST', `${this.base}/${this.c.userId}/media_publish`, { params: { creation_id: containerId } });
    return { mediaId: String(j.id) };
  }
  async getMedia(id) {
    const j = await this.call('GET', `${this.base}/${id}`, { params: { fields: 'id,permalink,caption,timestamp,media_product_type' } });
    return { id: String(j.id), permalink: j.permalink ?? null, caption: j.caption, timestamp: j.timestamp ?? null, product: j.media_product_type ?? null };
  }
  /**
   * The real API has no client reference. After an unknown publish outcome the only way to look for the
   * post is the account's recent media: same caption, created after the request. This is an inference,
   * and the caller treats anything but exactly one match as "still uncertain".
   */
  async findByRef(_ref, { caption, since } = {}) {
    const j = await this.call('GET', `${this.base}/${this.c.userId}/media`, { params: { fields: 'id,caption,timestamp,permalink,media_product_type', limit: 10 } });
    return (j.data ?? []).filter(m => m.caption === caption && (!since || Date.parse(m.timestamp) >= Date.parse(since) - 60e3)).map(m => ({ id: String(m.id), timestamp: m.timestamp, inferred: true }));
  }
  async getInsights(id) {
    const j = await this.call('GET', `${this.base}/${id}/insights`, { params: { metric: REEL_METRICS.join(',') } });
    const values = {};
    for (const m of j.data ?? []) values[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? null;
    return { media_id: String(id), values };
  }
}

module.exports = { InstagramPublisher, config, status, REEL_METRICS, HOSTS, scrub };
