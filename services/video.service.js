'use strict';

/**
 * video.service.js — FFmpeg + Whisper pipeline for Dana video analysis.
 *
 * Frame extraction: fluent-ffmpeg with @ffmpeg-installer/ffmpeg (bundled binary).
 * Audio transcription: OpenAI Whisper API, verbose_json for word-level timestamps.
 *
 * ANALYSIS LIMITATIONS (reported to callers, never hidden):
 *   - Frame analysis = sampled stills. Motion, transitions, and audio-visual sync
 *     are inferred from still images + transcript, not directly measured.
 *   - Whisper transcript ≠ audio quality: balance, noise, and clarity are unverified
 *     unless explicit audio analysis tools are used.
 *   - Timestamps from Whisper are real (word-level). Frame timestamps are real (from ffmpeg
 *     seekInput). Neither implies frame-perfect accuracy in the report.
 *   - If ffprobe fails, durationSec is null — no fake default is used.
 */

const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const ffmpegPath     = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath    = require('@ffprobe-installer/ffprobe').path;
const ffmpeg         = require('fluent-ffmpeg');
const OpenAI         = require('openai');
const logger         = require('../utils/logger');

// Set both binaries explicitly — @ffmpeg-installer only bundles ffmpeg, not ffprobe.
// Without setFfprobePath, fluent-ffmpeg falls back to PATH which may not have ffprobe
// on Railway's container image.
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

logger.info('[video-service] ffmpeg + ffprobe paths set', {
  ffmpeg:  ffmpegPath,
  ffprobe: ffprobePath,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_FRAMES      = 20;
const FRAME_JPG_Q     = 2;        // 1=best, 31=worst
const AUDIO_SAMPLE_HZ = 16000;
const MAX_TRANSCRIPT_CHARS = 8000; // approx 15-min of dense Hebrew speech

// ── Video metadata ─────────────────────────────────────────────────────────────

/**
 * @returns {{ durationSec: number|null, width, height, fps, hasAudio, probeOk }}
 *   durationSec is null if ffprobe fails — callers MUST handle null, not substitute a default.
 */
function getVideoMeta(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) {
        logger.warn('[video-service] ffprobe failed', { error: err.message, videoPath });
        resolve({ durationSec: null, width: 0, height: 0, fps: null, hasAudio: null, probeOk: false });
        return;
      }
      const vs  = meta.streams?.find(s => s.codec_type === 'video') ?? {};
      const as  = meta.streams?.find(s => s.codec_type === 'audio');
      const fpsRaw = vs.avg_frame_rate ?? '';
      let fps = null;
      if (fpsRaw && fpsRaw.includes('/')) {
        const [n, d] = fpsRaw.split('/').map(Number);
        fps = d > 0 ? n / d : null;
      }
      const dur = parseFloat(meta.format?.duration);
      resolve({
        durationSec: isFinite(dur) && dur > 0 ? dur : null,
        width:       vs.width   ?? 0,
        height:      vs.height  ?? 0,
        fps:         fps && isFinite(fps) ? fps : null,
        hasAudio:    !!as,
        probeOk:     true,
      });
    });
  });
}

// ── Frame extraction ───────────────────────────────────────────────────────────

/**
 * Extract up to MAX_FRAMES evenly-spaced JPEG frames.
 * Returns array of { timestampSec: number, base64: string }.
 * timestampSec is the ACTUAL ffmpeg seekInput value — real, not calculated from order.
 *
 * @param {string} videoPath
 * @param {number} durationSec  — must be a known positive number; throws if 0 or null
 */
async function extractFrames(videoPath, durationSec) {
  if (!durationSec || durationSec <= 0) {
    throw new Error('חילוץ פריימים נכשל: משך הסרטון אינו ידוע (ffprobe נכשל).');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dana-frames-'));
  try {
    const rawInterval = durationSec / MAX_FRAMES;
    const interval    = Math.max(rawInterval, 1.0); // ≥1 s to keep token count sane
    const count       = Math.min(MAX_FRAMES, Math.max(1, Math.floor(durationSec / interval)));

    // Timestamps are the exact seekInput values used — real, not approximated
    const timestamps = Array.from({ length: count }, (_, i) =>
      +(interval * i + interval * 0.5).toFixed(2)
    ).filter(ts => ts < durationSec);

    if (timestamps.length === 0) {
      throw new Error('לא ניתן לחלץ פריימים — הסרטון קצר מדי.');
    }

    // Extract each frame as an INDEPENDENT ffmpeg call.
    // Multi-output with seekInput per output is unreliable in fluent-ffmpeg
    // (outputs share one global input, seek position per output not supported
    // cleanly — causes "Error initializing output stream N" for N≥10).
    // Sequential calls are slower but correct and reliable.
    for (const ts of timestamps) {
      const safeName = ts.toFixed(3).replace('.', 'd');
      const outPath  = path.join(tmpDir, `f${safeName}.jpg`);
      await new Promise((resolve) => { // non-rejecting: a single frame failure is non-fatal
        ffmpeg(videoPath)
          .seekInput(ts)
          .frames(1)
          .output(outPath)
          .outputOptions(`-q:v ${FRAME_JPG_Q}`)
          .on('end', resolve)
          .on('error', (err) => {
            logger.warn('[video-service] Frame extraction failed for single timestamp', { ts, error: err.message });
            resolve(); // skip this frame, continue
          })
          .run();
      });
    }

    const frames = [];
    for (const ts of timestamps) {
      const safeName = ts.toFixed(3).replace('.', 'd');
      const fp = path.join(tmpDir, `f${safeName}.jpg`);
      if (!fs.existsSync(fp)) {
        logger.warn('[video-service] Frame file missing', { ts, fp });
        continue;
      }
      const buf = fs.readFileSync(fp);
      if (buf.length < 500) continue; // empty/corrupt JPEG
      frames.push({ timestampSec: ts, base64: buf.toString('base64') });
    }

    if (frames.length === 0) throw new Error('כל הפריימים שנחלצו ריקים או חסרים.');

    logger.info('[video-service] Frames extracted', {
      count: frames.length, durationSec,
      coverage: `${frames[0].timestampSec.toFixed(1)}s–${frames[frames.length-1].timestampSec.toFixed(1)}s`,
    });
    return frames;
  } finally {
    try {
      fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
      fs.rmdirSync(tmpDir);
    } catch {}
  }
}

// ── Audio transcription ────────────────────────────────────────────────────────

/**
 * Transcribe audio using Whisper API with verbose_json for word-level timestamps.
 *
 * Returns:
 *   { text, wordTimestamps: [{word, start, end}], coverage, truncated }
 *
 * What Whisper CAN tell us:  spoken words, timing, language.
 * What Whisper CANNOT tell us: audio quality, music balance, background noise,
 *   recording clarity, volume levels. Those require signal analysis tools.
 *
 * @param {string} videoPath
 * @param {boolean|null} hasAudio
 */
async function transcribeAudio(videoPath, hasAudio) {
  if (hasAudio === false) {
    return { text: '', wordTimestamps: [], coverage: 'no_audio_track', truncated: false };
  }

  const tmpAudio = path.join(os.tmpdir(), `dana-audio-${Date.now()}.mp3`);
  try {
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

    const fileSize = fs.existsSync(tmpAudio) ? fs.statSync(tmpAudio).size : 0;
    if (fileSize < 1000) {
      return { text: '', wordTimestamps: [], coverage: 'silent_or_extraction_failed', truncated: false };
    }

    // verbose_json returns segments+words with timestamps
    const result = await openai.audio.transcriptions.create({
      file:            fs.createReadStream(tmpAudio),
      model:           'whisper-1',
      language:        'he',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    const text  = result.text ?? '';
    const words = (result.words ?? []).map(w => ({
      word:  w.word,
      start: w.start,
      end:   w.end,
    }));

    const truncated = text.length > MAX_TRANSCRIPT_CHARS;
    const finalText = truncated ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text;

    const duration = result.duration ?? null;
    const lastWordEnd = words.length > 0 ? words[words.length - 1].end : null;

    logger.info('[video-service] Audio transcribed', {
      chars: finalText.length, words: words.length, truncated,
      whisper_duration: duration, last_word_end: lastWordEnd,
    });

    return {
      text:           finalText,
      wordTimestamps: words,
      coverage:       duration ? `0s–${duration.toFixed(1)}s (Whisper)` : 'coverage_unknown',
      truncated,
      whisperDuration: duration,
    };
  } catch (err) {
    logger.warn('[video-service] Audio transcription failed', { error: err.message });
    return { text: '', wordTimestamps: [], coverage: 'transcription_failed', truncated: false };
  } finally {
    try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio); } catch {}
  }
}

// ── Job store ──────────────────────────────────────────────────────────────────

const DATA_DIR_FN = () =>
  (process.env.DATA_DIR ?? require('path').join(__dirname, '../data')).replace(/\/$/, '');

/**
 * Save a video buffer to DATA_DIR/videos/{id}/video.{ext}.
 * Returns the absolute path.
 */
function saveVideoFile(id, buffer, ext) {
  const videoDir = path.join(DATA_DIR_FN(), 'videos', id);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  const videoPath = path.join(videoDir, `video.${ext}`);
  fs.writeFileSync(videoPath, buffer);
  return videoPath;
}

/**
 * Save a video from a file path (multer disk upload) to DATA_DIR.
 * Moves (or copies) the file so multer tmp is cleaned up.
 */
function saveVideoFromPath(id, srcPath, ext) {
  const videoDir = path.join(DATA_DIR_FN(), 'videos', id);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  const destPath = path.join(videoDir, `video.${ext}`);
  fs.copyFileSync(srcPath, destPath);
  try { fs.unlinkSync(srcPath); } catch {}
  return destPath;
}

/** Persist a job status record to DATA_DIR/videos/{id}/job.json */
function saveJob(id, job) {
  const videoDir = path.join(DATA_DIR_FN(), 'videos', id);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
}

/** Load a job status record. Returns null if not found. */
function loadJob(id) {
  const p = path.join(DATA_DIR_FN(), 'videos', id, 'job.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Save full analysis report JSON.
 *  Before overwriting an existing report.json, moves it to report.<timestamp>.bak.json
 *  so force-retry and re-analysis do not permanently destroy previous results.
 */
function saveReport(id, report) {
  const videoDir = path.join(DATA_DIR_FN(), 'videos', id);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  const rptPath = path.join(videoDir, 'report.json');
  if (fs.existsSync(rptPath)) {
    // Rotate: keep up to 5 backups named report.<iso-timestamp>.bak.json
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bak = path.join(videoDir, `report.${ts}.bak.json`);
    try { fs.copyFileSync(rptPath, bak); } catch {}
    // Prune: keep only the 5 newest .bak.json files to avoid unbounded growth
    try {
      const baks = fs.readdirSync(videoDir)
        .filter(f => f.endsWith('.bak.json'))
        .map(f => ({ f, mt: fs.statSync(path.join(videoDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
      baks.slice(5).forEach(({ f }) => { try { fs.unlinkSync(path.join(videoDir, f)); } catch {} });
    } catch {}
  }
  fs.writeFileSync(rptPath, JSON.stringify(report, null, 2), 'utf8');
}

/** Load a saved analysis report. Returns null if not found. */
function loadReport(id) {
  const p = path.join(DATA_DIR_FN(), 'videos', id, 'report.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** List all saved analyses (most recent first, up to 50). */
function listReports() {
  const videosDir = path.join(DATA_DIR_FN(), 'videos');
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
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
}

module.exports = {
  getVideoMeta,
  extractFrames,
  transcribeAudio,
  saveVideoFile,
  saveVideoFromPath,
  saveJob,
  loadJob,
  saveReport,
  loadReport,
  listReports,
  DATA_DIR_FN,
};
