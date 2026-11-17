'use strict';

/**
 * voice_intake.js — a member's WhatsApp voice message is transcribed by the LOCAL editing worker (Whisper on the
 * editing PC), never by an outside provider. Approved by the owner on 2026-11-17.
 *
 * Life of one recording:
 *   1. receive()   the audio is downloaded from the WhatsApp provider to DATA_DIR/voice/<id>.<ext> and a job is queued.
 *                  Nothing is downloaded when the feature is off or the worker is not reachable.
 *   2. lease()     the editing worker (same scoped token as the Dana worker API, and only these three routes) takes it,
 *                  downloads the bytes, transcribes, and deletes its local copy.
 *   3. submit()    the transcript is stored on the job, the SERVER COPY OF THE AUDIO IS DELETED, and onTranscript() is
 *                  called. The text is removed from the job once it was delivered (it lives on the staff task).
 *   4. tick()      a job that waited longer than VOICE_WAIT_MS, or whose worker failed, is handed to the staff
 *                  (onFallback) exactly once. Every audio file is deleted at the latest 24 hours after it was received,
 *                  transcribed or not; files in the folder that belong to no job (a crash in the middle of a download)
 *                  are deleted too. recover() does the same at start, so a crash or a restart cannot leave a recording.
 *
 * The original WhatsApp message is never touched. The download URL, the transcript and the phone number are never
 * logged; a job is referred to by its id. There is no dashboard route that serves audio.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const KEEP_MS = 24 * 60 * 60 * 1000;          // hard limit for a server copy of the audio, from the moment it was received
const JOB_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // the job RECORD (no audio, no text) is kept for a month, for the panel
const MAX_BYTES = 16 * 1024 * 1024;
const LEASE_MS = 4 * 60 * 1000;
const ONLINE_MS = 75 * 1000;
const MAX_ATTEMPTS = 2;
const SAFE_ID = /^[A-Za-z0-9_-]{4,80}$/;
const EXT_BY_MIME = { 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/amr': 'amr' };

const dataDir = () => (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, '');
const hash = s => crypto.createHash('sha256').update(String(s ?? '')).digest();

function createVoiceIntake({ logger, now = () => Date.now(), download = null, danaWorkerStatus = () => null, onTranscript = async () => {}, onFallback = async () => {} }) {
  const dir = () => path.join(dataDir(), 'voice');
  const jobsFile = () => path.join(dir(), 'jobs.json');
  const waitMs = () => Number(process.env.VOICE_WAIT_MS) || 120 * 1000;
  let _state = null;                                   // { jobs: {id: job}, workerSeenAt }
  let _delivering = new Set();

  function load() {
    if (_state) return _state;
    try { _state = JSON.parse(fs.readFileSync(jobsFile(), 'utf8')); } catch { _state = { jobs: {}, workerSeenAt: null }; }
    if (!_state.jobs || typeof _state.jobs !== 'object') _state = { jobs: {}, workerSeenAt: null };
    return _state;
  }
  function save() {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = jobsFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_state));
    fs.renameSync(tmp, jobsFile());
  }
  const audioPath = j => path.join(dir(), `${j.id}.${j.ext}`);
  function dropAudio(j, why) {
    if (j.audioDeletedAt) return;
    try { fs.unlinkSync(audioPath(j)); } catch (err) { if (err.code !== 'ENOENT') { logger.error('[voice] the audio file could not be deleted — will be tried again', { id: j.id, code: err.code }); return; } }
    j.audioDeletedAt = new Date(now()).toISOString(); j.audioDeletedWhy = why;
  }

  const enabled = () => process.env.VOICE_TRANSCRIPTION_ENABLED === 'true' && String(process.env.DANA_WORKER_TOKEN ?? '').length >= 24;

  /** Can a recording be transcribed now? online = the worker asked for voice work in the last minute; busy = it is alive but editing. */
  function availability() {
    const s = load();
    if (!enabled()) return { state: 'off', enabled: false, lastSeenAt: s.workerSeenAt };
    if (s.workerSeenAt && now() - Date.parse(s.workerSeenAt) < ONLINE_MS) return { state: 'online', enabled: true, lastSeenAt: s.workerSeenAt };
    let dana = null; try { dana = danaWorkerStatus(); } catch { /* shown as offline */ }
    return { state: dana?.online ? 'busy' : 'offline', enabled: true, lastSeenAt: s.workerSeenAt };
  }

  async function defaultDownload(url) {
    const axios = require('axios');
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES, validateStatus: s => s === 200 });
    return Buffer.from(r.data);
  }

  /**
   * A voice message arrived. -> { queued:true, job, availability } | { queued:false, reason }
   * reason: 'off' | 'worker_offline' | 'no_url' | 'unsupported_type' | 'too_large' | 'download_failed' | 'storage_failed'
   * The same WhatsApp message id is never queued twice.
   */
  async function receive({ phone, messageId = null, mediaUrl = null, mimeType = null, receivedAt = null, taskId = null }) {
    const s = load();
    if (messageId) { const dup = Object.values(s.jobs).find(j => j.messageId === messageId); if (dup) return { queued: dup.state === 'queued' || dup.state === 'leased', job: dup, duplicate: true, availability: availability().state }; }
    const av = availability();
    if (av.state === 'off') return { queued: false, reason: 'off' };
    if (av.state === 'offline') return { queued: false, reason: 'worker_offline' };
    if (!/^https:\/\//i.test(String(mediaUrl ?? ''))) return { queued: false, reason: 'no_url' };
    const ext = EXT_BY_MIME[String(mimeType ?? 'audio/ogg').split(';')[0].trim().toLowerCase()];
    if (!ext) return { queued: false, reason: 'unsupported_type' };
    let buf;
    try { buf = await (download ?? defaultDownload)(mediaUrl); }
    catch (err) { logger.warn('[voice] the recording could not be downloaded from the provider', { code: err.code ?? null, status: err.response?.status ?? null }); return { queued: false, reason: 'download_failed' }; }
    if (!Buffer.isBuffer(buf) || !buf.length) return { queued: false, reason: 'download_failed' };
    if (buf.length > MAX_BYTES) return { queued: false, reason: 'too_large' };
    const id = `v${new Date(now()).toISOString().slice(0, 10).replace(/-/g, '')}_${crypto.randomBytes(6).toString('hex')}`;
    const job = { id, phone: String(phone), taskId, messageId, ext, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      receivedAt: new Date(receivedAt && !isNaN(new Date(receivedAt)) ? Math.min(new Date(receivedAt).getTime(), now()) : now()).toISOString(), queuedAt: new Date(now()).toISOString(),
      state: 'queued', attempts: 0, leaseHash: null, leasedAt: null, transcript: null, fallback: null, error: null, audioDeletedAt: null };
    try {
      fs.mkdirSync(dir(), { recursive: true });
      const part = audioPath(job) + '.part';
      fs.writeFileSync(part, buf, { mode: 0o600 });
      fs.renameSync(part, audioPath(job));
      s.jobs[id] = job; save();
    } catch (err) {
      try { fs.unlinkSync(audioPath(job)); } catch { /* nothing was written */ }
      delete s.jobs[id];
      logger.error('[voice] the recording could not be stored', { code: err.code ?? err.message });
      return { queued: false, reason: 'storage_failed' };
    }
    logger.info('[voice] recording queued for local transcription', { id, bytes: job.bytes, worker: av.state });
    return { queued: true, job, availability: av.state };
  }

  function setTask(id, taskId) { const j = load().jobs[id]; if (j) { j.taskId = taskId; save(); } }

  /** Hand a job to the staff, once. The job may still be transcribed later (the text is then added to the staff task). */
  async function fallback(j, reason) {
    if (j.fallback) return false;
    j.fallback = { at: new Date(now()).toISOString(), reason }; save();
    try { await onFallback({ ...j }, reason); }
    catch (err) { logger.error('[voice] the hand-over to the staff failed', { id: j.id, error: err.message }); j.fallback.error = String(err.message).slice(0, 200); save(); }
    return true;
  }
  async function markFallback(id, reason) { const j = load().jobs[id]; return j ? fallback(j, reason) : false; }

  // ── the worker ──────────────────────────────────────────────────────────────
  function lease() {
    const s = load();
    s.workerSeenAt = new Date(now()).toISOString();
    const j = Object.values(s.jobs).filter(x => x.state === 'queued' && !x.audioDeletedAt).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))[0];
    if (!j) { save(); return null; }
    const token = crypto.randomBytes(24).toString('hex');
    j.state = 'leased'; j.attempts++; j.leasedAt = s.workerSeenAt; j.leaseHash = hash(token).toString('hex');
    save();
    return { job: { id: j.id, ext: j.ext, sha256: j.sha256, bytes: j.bytes, receivedAt: j.receivedAt }, leaseToken: token };
  }
  function leased(id, token) {
    const j = SAFE_ID.test(String(id)) ? load().jobs[id] : null;
    if (!j || j.state !== 'leased' || !token || !j.leaseHash) return null;
    return crypto.timingSafeEqual(hash(token), Buffer.from(j.leaseHash, 'hex')) ? j : null;
  }
  function audioFile(id, token) { const j = leased(id, token); return j && !j.audioDeletedAt && fs.existsSync(audioPath(j)) ? { file: audioPath(j), job: j } : null; }

  async function deliver(j) {
    if (_delivering.has(j.id) || !j.transcript?.text) return;
    _delivering.add(j.id);
    try {
      await onTranscript({ ...j, transcript: { ...j.transcript } });
      j.transcript = { ...j.transcript, chars: j.transcript.text.length, text: undefined, deliveredAt: new Date(now()).toISOString() };
      save();
    } catch (err) {
      j.deliveryErrors = (j.deliveryErrors ?? 0) + 1;
      logger.error('[voice] the transcript could not be handed to the member flow', { id: j.id, tries: j.deliveryErrors, error: err.message });
      if (j.deliveryErrors >= 3) { j.transcript = { ...j.transcript, text: undefined, undelivered: true }; await fallback(j, 'delivery_failed'); }
      save();
    } finally { _delivering.delete(j.id); }
  }

  /** The worker's answer. -> 'transcribed' | 'failed' | null (unknown job / wrong lease) */
  async function submit(id, token, body) {
    const j = leased(id, token);
    if (!j) return null;
    const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim().slice(0, 4000) : '';
    if (body?.status === 'transcribed' && text) {
      j.state = 'transcribed'; j.leaseHash = null;
      j.transcript = { text, language: String(body.language ?? '').slice(0, 8) || null, duration_s: Number.isFinite(body.duration_s) ? Math.round(body.duration_s * 10) / 10 : null,
        model: String(body.model ?? '').slice(0, 40) || null, avg_logprob: Number.isFinite(body.avg_logprob) ? body.avg_logprob : null, at: new Date(now()).toISOString() };
      dropAudio(j, 'transcribed'); save();
      logger.info('[voice] transcribed', { id: j.id, seconds: j.transcript.duration_s, waitedMs: now() - Date.parse(j.queuedAt), audioDeleted: !!j.audioDeletedAt });
      await deliver(j);
      return 'transcribed';
    }
    const code = body?.status === 'transcribed' ? 'empty_transcript' : String(body?.error?.code ?? 'transcription_failed').slice(0, 60);
    j.leaseHash = null; j.error = { code, at: new Date(now()).toISOString() };
    const final = ['empty_transcript', 'voice_no_speech', 'voice_invalid'].includes(code);          // trying again cannot help
    if (!final && j.attempts < MAX_ATTEMPTS && !j.audioDeletedAt) { j.state = 'queued'; save(); return 'failed'; }
    j.state = 'failed'; dropAudio(j, 'failed'); save();
    logger.warn('[voice] transcription failed — handed to the staff', { id: j.id, code });
    await fallback(j, code === 'empty_transcript' || code === 'voice_no_speech' ? 'empty_transcript' : 'transcription_failed');
    return 'failed';
  }

  // ── time: waits, leases, the 24-hour limit, leftovers ───────────────────────
  async function tick() {
    const s = load(), t = now();
    let changed = false;
    for (const j of Object.values(s.jobs)) {
      if (j.state === 'leased' && t - Date.parse(j.leasedAt) > LEASE_MS) {                 // the worker took it and never answered
        j.leaseHash = null; changed = true;
        if (j.attempts < MAX_ATTEMPTS && !j.audioDeletedAt) j.state = 'queued';
        else { j.state = 'failed'; j.error = { code: 'worker_did_not_answer', at: new Date(t).toISOString() }; dropAudio(j, 'failed'); await fallback(j, 'transcription_failed'); }
      }
      if ((j.state === 'queued' || j.state === 'leased') && !j.fallback && t - Date.parse(j.queuedAt) > waitMs()) { await fallback(j, 'waited_too_long'); changed = true; }
      if (!j.audioDeletedAt && t - Date.parse(j.receivedAt) > KEEP_MS) {                    // the hard limit, whatever the state
        dropAudio(j, 'older_than_24h'); changed = true;
        if (j.state === 'queued' || j.state === 'leased') { j.state = 'expired'; j.leaseHash = null; await fallback(j, 'expired'); }
      }
      if (j.state === 'transcribed' && j.transcript?.text) { await deliver(j); changed = true; }   // a delivery interrupted by a crash
      if (j.audioDeletedAt && t - Date.parse(j.receivedAt) > JOB_KEEP_MS) { delete s.jobs[j.id]; changed = true; }
    }
    // anything in the folder that is not the audio of a live job: an interrupted download, a file whose job is gone
    try {
      const keep = new Set(['jobs.json', ...Object.values(s.jobs).filter(j => !j.audioDeletedAt).map(j => `${j.id}.${j.ext}`)]);
      for (const f of fs.readdirSync(dir())) {
        if (keep.has(f)) continue;
        if (f === 'jobs.json.tmp') continue;
        try { fs.unlinkSync(path.join(dir(), f)); logger.warn('[voice] a leftover file was deleted', { kind: f.endsWith('.part') ? 'interrupted download' : 'orphan' }); } catch { /* next tick */ }
      }
    } catch { /* the folder does not exist yet */ }
    if (changed) save();
  }
  /** At start: a job that was leased when the server stopped goes back to the queue; then the usual sweep. */
  async function recover() {
    const s = load();
    for (const j of Object.values(s.jobs)) if (j.state === 'leased') { j.state = j.audioDeletedAt ? 'failed' : 'queued'; j.leaseHash = null; }
    save();
    await tick();
  }

  /** For the panel: no audio, no text, no phone. */
  function status() {
    const s = load(), js = Object.values(s.jobs);
    const by = st => js.filter(j => j.state === st).length;
    return { availability: availability(), waitSeconds: Math.round(waitMs() / 1000), keepHours: 24,
      waiting: by('queued') + by('leased'), transcribed: by('transcribed'), failed: by('failed') + by('expired'),
      audioOnServer: js.filter(j => !j.audioDeletedAt).length, oldestAudioAt: js.filter(j => !j.audioDeletedAt).map(j => j.receivedAt).sort()[0] ?? null };
  }
  const jobView = id => { const j = load().jobs[id]; return j ? { id: j.id, state: j.state, receivedAt: j.receivedAt, fallback: j.fallback, error: j.error?.code ?? null, audioDeletedAt: j.audioDeletedAt, attempts: j.attempts } : null; };

  /** /api/voice/worker/* — mounted BEFORE the dashboard auth, with the editing worker's own scoped token. */
  function router() {
    const r = express.Router();
    r.use((req, res, next) => {
      const expected = process.env.DANA_WORKER_TOKEN;
      if (!expected || expected.length < 24) return res.status(503).json({ ok: false, error: 'worker_api_not_configured' });
      const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      if (!given || !crypto.timingSafeEqual(hash(given), hash(expected))) { logger.warn('[voice] unauthorized worker request', { path: req.path }); return res.status(401).json({ ok: false, error: 'unauthorized' }); }
      if (!enabled()) return res.status(404).json({ ok: false, error: 'not_found' });          // off = the routes do not exist for the worker
      next();
    });
    const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => { logger.error('[voice] worker route failed', { path: req.path, error: err.message }); if (!res.headersSent) res.status(500).json({ ok: false, error: 'internal' }); });
    r.post('/lease', express.json({ limit: '4kb' }), wrap((_req, res) => { const l = lease(); return l ? res.json(l) : res.status(204).end(); }));
    r.get('/jobs/:id/audio', wrap((req, res) => {
      const a = audioFile(req.params.id, req.headers['x-lease-token']);
      if (!a) return res.status(404).json({ ok: false, error: 'not_found' });
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(a.job.bytes), 'Cache-Control': 'no-store' });
      fs.createReadStream(a.file).pipe(res);
    }));
    r.post('/jobs/:id/result', express.json({ limit: '64kb' }), wrap(async (req, res) => {
      const out = await submit(req.params.id, req.headers['x-lease-token'], req.body ?? {});
      return out ? res.json({ ok: true, state: out }) : res.status(409).json({ ok: false, error: 'lease_lost' });
    }));
    r.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
    return r;
  }

  return { receive, setTask, markFallback, lease, audioFile, submit, tick, recover, status, jobView, availability, enabled, router,
    // tests only: the provider download is replaced by a local function (impossible outside NODE_ENV=test)
    _setDownload: fn => { if (process.env.NODE_ENV === 'test') download = fn; }, _reset: () => { _state = null; } };
}

module.exports = { createVoiceIntake, KEEP_MS, MAX_BYTES };
