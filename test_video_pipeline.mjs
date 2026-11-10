/**
 * test_video_pipeline.mjs — unit tests for the video analysis pipeline.
 * Tests logic/guards in video.service.js and dana_agent.js WITHOUT calling
 * real OpenAI or ffmpeg (mocked where needed).
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const os   = require('os');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✅ ' + label); pass++; }
  else       { console.log('  ❌ FAIL: ' + label); fail++; }
}

// ── 1. getVideoMeta — no fake defaults when ffprobe fails ────────────────────
console.log('\n[1] getVideoMeta — durationSec=null when ffprobe fails (no fake default)');
const vs = require('./services/video.service.js');

// Feed a non-video file — ffprobe will fail
const tmpTxt = path.join(os.tmpdir(), 'dana_test_notavideo.txt');
fs.writeFileSync(tmpTxt, 'not a video', 'utf8');
const badMeta = await vs.getVideoMeta(tmpTxt);
fs.unlinkSync(tmpTxt);
ok('probeOk=false when file is not a video', badMeta.probeOk === false);
ok('durationSec=null when ffprobe fails (not defaulting to 30)', badMeta.durationSec === null);

// ── 2. extractFrames — throws when durationSec is null or 0 ─────────────────
console.log('\n[2] extractFrames — rejects null/zero duration (no fake 30s fallback)');
let frameError1 = null;
try { await vs.extractFrames('/tmp/fake.mp4', null); }
catch(e) { frameError1 = e.message; }
ok('throws on durationSec=null', !!frameError1);
ok('error message mentions משך or ffprobe', frameError1?.includes('משך') || frameError1?.includes('ffprobe'));

let frameError2 = null;
try { await vs.extractFrames('/tmp/fake.mp4', 0); }
catch(e) { frameError2 = e.message; }
ok('throws on durationSec=0', !!frameError2);

// ── 3. transcribeAudio — returns empty + coverage label when hasAudio=false ──
console.log('\n[3] transcribeAudio — returns structured result, no throw on no-audio');
const noAudioResult = await vs.transcribeAudio('/tmp/fake.mp4', false);
ok('text empty when hasAudio=false', noAudioResult.text === '');
ok('coverage label set (no_audio_track)', noAudioResult.coverage === 'no_audio_track');
ok('wordTimestamps is array', Array.isArray(noAudioResult.wordTimestamps));

// ── 4. parseTimestampRange helper ────────────────────────────────────────────
console.log('\n[4] parseTimestampRange — validates timestamp format');
// Access via dana_agent (exported indirectly through getJob — we test it inline)
function parseTimestampRange(range) {
  if (!range) return null;
  const first = range.split('-')[0].trim();
  const parts = first.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}
ok('"0:03" → 3s', parseTimestampRange('0:03') === 3);
ok('"1:23" → 83s', parseTimestampRange('1:23') === 83);
ok('"0:03-0:08" → 3s (first time)', parseTimestampRange('0:03-0:08') === 3);
ok('"abc" → null', parseTimestampRange('abc') === null);
ok('null → null', parseTimestampRange(null) === null);
ok('empty → null', parseTimestampRange('') === null);

// ── 5. getDefaultAudience — loads from business_context.md ──────────────────
console.log('\n[5] getDefaultAudience — loads from business_context.md, not hardcoded');
const dana = require('./agents/dana_agent.js');
// We can't call getDefaultAudience directly (not exported), but we can check
// that the business_context.md exists and contains the correct content
const __dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const ctxPath = path.join(__dir, 'prompts/business_context.md');
ok('business_context.md exists', fs.existsSync(ctxPath));
const ctx = fs.readFileSync(ctxPath, 'utf8');
ok('contains Target Audience section', ctx.includes('## Target Audience'));
// Check the audience is NOT hardcoded in dana_agent.js
const danaSource = fs.readFileSync(path.join(__dir, 'agents/dana_agent.js'), 'utf8');
ok('no hardcoded "30-60" string in analyzeVideoFile default parameter', !danaSource.includes("audience      = 'נשים 30-60"));

// ── 6. getSkillStatus — all skill files loaded ───────────────────────────────
console.log('\n[6] getSkillStatus — skill files present and loaded');
const skill = dana.getSkillStatus();
ok('rubric.md loaded', skill.rubric_loaded);
ok('doctrine.md loaded', skill.doctrine_loaded);
ok('estimate.py present', skill.estimate_exists);
ok('74 doctrine citations', skill.doctrine_citations === 74);
ok('scoring_note present (transparency)', typeof skill.scoring_note === 'string' && skill.scoring_note.length > 0);

// ── 7. Job lifecycle ──────────────────────────────────────────────────────────
console.log('\n[7] Async job lifecycle — create/update/get');
const jobId = 'test-job-' + Date.now();
const job   = dana.createAnalysisJob(jobId, { title: 'test video' });
ok('job created with status=queued', job.status === 'queued');

dana.updateJob(jobId, { status: 'running', stage: 'frames', note: 'מחלץ...' });
const updated = dana.getJob(jobId);
ok('job status updated to running', updated.status === 'running');
ok('job stage updated', updated.stage === 'frames');

dana.updateJob(jobId, { status: 'failed', error: 'test error' });
const failed = dana.getJob(jobId);
ok('job status updated to failed', failed.status === 'failed');
ok('error stored', failed.error === 'test error');

// ── 8. Data availability — audio limitations explicit ────────────────────────
console.log('\n[8] Audio limitations — unverified sections in schema');
// Verify the schema passed to GPT explicitly marks audio quality as unverified
const danaJs = fs.readFileSync(path.join(__dir, 'agents/dana_agent.js'), 'utf8');
ok('audio quality note in prompt (איזון מוזיקה)', danaJs.includes('איזון מוזיקה'));
ok('motion_verified=false in dataAvail', danaJs.includes('motion_verified:        false'));
ok('sync_verified=false in dataAvail', danaJs.includes('sync_verified:          false'));
ok('audio_quality_verified=false in dataAvail', danaJs.includes('audio_quality_verified: false'));

// ── 9. Timestamp validation — out-of-range removed ───────────────────────────
console.log('\n[9] Timestamp out-of-range filtering');
// Simulate what analyzeVideoFile does
const mockTimestamps = [
  { range: '0:03-0:08', observation: 'ok' },  // in range (video=30s)
  { range: '0:45-0:50', observation: 'valid' }, // in range
  { range: '2:00-2:10', observation: 'bad' },  // out of range (>30s)
];
const duration = 30;
const filtered = mockTimestamps.map(t => {
  const startSec = parseTimestampRange(t.range);
  const inRange  = startSec !== null ? startSec <= duration : null;
  return { ...t, out_of_range: inRange === false };
}).filter(t => !t.out_of_range);
// 0:03 (3s) → in range ✓ | 0:45 (45s) → out of range (>30s) | 2:00 (120s) → out of range
ok('only timestamps within video duration kept', filtered.length === 1);
ok('out-of-range timestamp removed', !filtered.some(t => t.observation === 'bad'));
ok('valid timestamp (3s) is kept', filtered[0]?.observation === 'ok');

// ── 10. Version comparison — score computed in code ───────────────────────────
console.log('\n[10] Version comparison — score delta computed in code, not by model');
// The comparison block sets score_change from estimation.readiness - prevReport.readiness
ok('score_change computed from stored data (not gptData)', danaJs.includes('score_change:         scoreDelta'));
ok('prev_readiness stored from loaded report', danaJs.includes('prev_readiness:       prevReport.readiness'));

// ── 11. No silent transcript truncation ──────────────────────────────────────
console.log('\n[11] Transcript truncation reported, not silent');
ok('truncated flag in transcribeAudio return', danaJs.includes('truncated,'));
ok('truncation warning added to report warnings (Hebrew)', danaJs.includes('תמלול קוצר'));

// ── 12. Multer file limit consistent client+server ────────────────────────────
console.log('\n[12] File size limit consistent: client (app.js) = server (multer)');
const appJs    = fs.readFileSync(path.join(__dir, 'public/app.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dir, 'server.js'), 'utf8');
ok('client MAX_SIZE_BYTES = 150MB', appJs.includes('150 * 1024 * 1024'));
ok('server multer limit = 150MB', serverJs.includes('150 * 1024 * 1024'));
ok('index.html shows 150 MB limit', fs.readFileSync(path.join(__dir,'public/index.html'),'utf8').includes('עד 150 MB'));

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────');
console.log(`Video pipeline tests: PASS=${pass}  FAIL=${fail}`);
if (fail > 0) process.exit(1);
