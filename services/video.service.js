'use strict';

/**
 * video.service.js — FFmpeg + Whisper pipeline for Dana video analysis.
 *
 * Frame extraction: fluent-ffmpeg with @ffmpeg-installer/ffmpeg (bundled binary,
 * no system-level ffmpeg required, works on Railway).
 *
 * Audio transcription: OpenAI Whisper API (not local GPU Whisper — works on Railway).
 *
 * Limitations:
 *   - Frame analysis relies on sampled stills; motion, transitions, and sync
 *     between audio and visuals are inferred, not directly measured.
 *   - Timestamps in the report are approximate (derived from frame spacing).
 *   - On-screen text is read from frames by GPT-4o vision; small text may be missed.
 */

const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const ffmpegPath   = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg       = require('fluent-ffmpeg');
const OpenAI       = require('openai');
const logger       = require('../utils/logger');

ffmpeg.setFfmpegPath(ffmpegPath);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Max frames sent to GPT-4o vision. More = better coverage, higher token cost.
const MAX_FRAMES     = 20;
const FRAME_JPG_Q    = 2;    // 1=best, 31=worst. 2 gives good quality at reasonable size.
const AUDIO_SAMPLE_HZ = 16000;

/**
 * Get video metadata (duration, width, height) without extracting any files.
 * @param {string} videoPath
 * @returns {Promise<{ durationSec: number, width: number, height: number, fps: number }>}
 */
function getVideoMeta(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(new Error('ffprobe failed: ' + err.message));
      const vs = meta.streams?.find(s => s.codec_type === 'video') ?? {};
      const as = meta.streams?.find(s => s.codec_type === 'audio');
      const fps = vs.avg_frame_rate
        ? eval(vs.avg_frame_rate.replace('/', '/')) // "30/1" → 30
        : 30;
      resolve({
        durationSec: parseFloat(meta.format?.duration ?? '0'),
        width:        vs.width  ?? 0,
        height:       vs.height ?? 0,
        fps:          isFinite(fps) ? fps : 30,
        hasAudio:     !!as,
      });
    });
  });
}

/**
 * Extract up to MAX_FRAMES evenly-spaced JPEG frames from a video.
 * Returns array of { timestampSec, base64 } objects.
 *
 * @param {string} videoPath
 * @param {number} durationSec
 * @returns {Promise<Array<{ timestampSec: number, base64: string }>>}
 */
async function extractFrames(videoPath, durationSec) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dana-frames-'));

  try {
    // Choose interval so we get at most MAX_FRAMES frames
    const rawInterval = durationSec / MAX_FRAMES;
    const interval    = Math.max(rawInterval, 0.5); // never more than 2 fps for cost
    const frameCount  = Math.min(MAX_FRAMES, Math.floor(durationSec / interval));

    // Build a comma-separated list of exact timestamps
    const timestamps = Array.from({ length: frameCount }, (_, i) =>
      +(interval * i + interval * 0.5).toFixed(2)   // centre of each interval
    );

    // extract each frame individually for timestamp accuracy
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(videoPath);
      timestamps.forEach(ts => {
        cmd = cmd
          .output(path.join(tmpDir, `frame_${String(ts).replace('.', '_')}.jpg`))
          .seekInput(ts)
          .frames(1)
          .outputOptions(`-q:v ${FRAME_JPG_Q}`);
      });
      cmd.on('end', resolve).on('error', reject).run();
    });

    const frames = [];
    for (const ts of timestamps) {
      const fp = path.join(tmpDir, `frame_${String(ts).replace('.', '_')}.jpg`);
      if (!fs.existsSync(fp)) continue;
      const buf    = fs.readFileSync(fp);
      const base64 = buf.toString('base64');
      frames.push({ timestampSec: ts, base64 });
    }

    logger.info('[video-service] Frames extracted', { count: frames.length, durationSec });
    return frames;
  } finally {
    // Clean up temp files
    try {
      const files = fs.readdirSync(tmpDir);
      files.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
      fs.rmdirSync(tmpDir);
    } catch {}
  }
}

/**
 * Extract audio from video as a mono WAV, then transcribe with OpenAI Whisper API.
 * Returns the transcript string, or empty string if no audio track.
 *
 * @param {string} videoPath
 * @param {boolean} hasAudio
 * @returns {Promise<string>}
 */
async function transcribeAudio(videoPath, hasAudio) {
  if (!hasAudio) return '';

  const tmpAudio = path.join(os.tmpdir(), `dana-audio-${Date.now()}.mp3`);
  try {
    // Extract audio as mp3 (smaller than wav, Whisper API accepts it)
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioChannels(1)
        .audioFrequency(AUDIO_SAMPLE_HZ)
        .output(tmpAudio)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const fileSize = fs.statSync(tmpAudio).size;
    if (fileSize < 1000) return ''; // effectively silent

    const transcript = await openai.audio.transcriptions.create({
      file:     fs.createReadStream(tmpAudio),
      model:    'whisper-1',
      language: 'he',
      response_format: 'text',
    });

    logger.info('[video-service] Audio transcribed', { chars: transcript?.length ?? 0 });
    return typeof transcript === 'string' ? transcript.trim() : '';
  } catch (err) {
    logger.warn('[video-service] Audio transcription failed', { error: err.message });
    return '';
  } finally {
    try { fs.unlinkSync(tmpAudio); } catch {}
  }
}

/**
 * Save a video buffer to DATA_DIR/videos/{id}/video.{ext}
 * Returns the saved path.
 *
 * @param {string} id  — unique analysis id
 * @param {Buffer} buffer
 * @param {string} ext — without dot
 */
function saveVideoFile(id, buffer, ext) {
  const dataDir  = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
  const videoDir = path.join(dataDir, 'videos', id);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  const videoPath = path.join(videoDir, `video.${ext}`);
  fs.writeFileSync(videoPath, buffer);
  return videoPath;
}

/**
 * Save a JSON analysis report to DATA_DIR/videos/{id}/report.json
 */
function saveReport(id, report) {
  const dataDir  = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
  const videoDir = path.join(dataDir, 'videos', id);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  const reportPath = path.join(videoDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

/**
 * Load a saved analysis report.
 */
function loadReport(id) {
  const dataDir    = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
  const reportPath = path.join(dataDir, 'videos', id, 'report.json');
  if (!fs.existsSync(reportPath)) return null;
  try { return JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { return null; }
}

/**
 * List all saved analyses (most recent first).
 */
function listReports() {
  const dataDir   = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
  const videosDir = path.join(dataDir, 'videos');
  if (!fs.existsSync(videosDir)) return [];
  const ids = fs.readdirSync(videosDir).filter(d =>
    fs.existsSync(path.join(videosDir, d, 'report.json'))
  );
  return ids
    .map(id => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(videosDir, id, 'report.json'), 'utf8'));
        return { id, title: r.title, createdAt: r.createdAt, readiness: r.readiness,
                 verdict: r.verdict, format: r.format, goal: r.goal, version: r.version ?? 1,
                 previousVersionId: r.previousVersionId ?? null };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = {
  getVideoMeta,
  extractFrames,
  transcribeAudio,
  saveVideoFile,
  saveReport,
  loadReport,
  listReports,
};
