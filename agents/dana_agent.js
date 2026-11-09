require('dotenv').config();
const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { execFileSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const OpenAI         = require('openai');
const logger         = require('../utils/logger');
const store          = require('../utils/lead_store');
const videoSvc       = require('../services/video.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BUSINESS_CONTEXT = fs.readFileSync(
  path.join(__dirname, '../prompts/business_context.md'), 'utf8'
);
const DANA_PROMPT = BUSINESS_CONTEXT + '\n\n---\n\n' + fs.readFileSync(
  path.join(__dirname, '../prompts/dana_prompt.md'), 'utf8'
);

// ── Mosseri skill paths ────────────────────────────────────────────────────────
const SKILL_DIR     = path.join(__dirname, '../mosseri-skill-main/mosseri');
const RUBRIC_PATH   = path.join(SKILL_DIR, 'reference/rubric.md');
const DOCTRINE_PATH = path.join(SKILL_DIR, 'reference/doctrine.md');
const ESTIMATE_BIN  = path.join(SKILL_DIR, 'scripts/estimate.py');
const PYTHON_BIN    = process.env.PYTHON_BIN
  ?? 'C:\\Users\\owner\\AppData\\Local\\Programs\\Python\\Python310\\python.exe';

// Penalty weights mirrored from estimate.py (used in the JS fallback only)
const WEIGHTS  = { C1: 25, C2: 20, C3: 20, C4: 15, C5: 10, C6: 5, C7: 5 };
const PENALTIES = { wordmark: 15, aggregated: 15, reupload: 20, unpaid_promise: 10, ai_slick: 5 };
const HARD_FLAGS = new Set(['wordmark', 'aggregated', 'reupload']);

const STUDIO_CLASSES = [
  'Strength Training', 'Reformer Pilates', 'Pilates Barre',
  'ALL IN (פונקציונלי)', 'Concept Toning / Sculpt', 'Ashtanga Yoga', 'Kangoo Jumps',
];

let danaHistory = [];

// ── Doctrine citation lookup ───────────────────────────────────────────────────

let _citations = null;

/** Parse doctrine.md once and build a map: principleCode → { date, quote } */
function getCitations() {
  if (_citations) return _citations;
  _citations = {};
  try {
    const doctrine = fs.readFileSync(DOCTRINE_PATH, 'utf8');
    const citeRe = /\[(\d{2}\.\d{2}\.\d{4}) · [^\]]+\] "([^"]+)"/;
    for (const match of doctrine.matchAll(/- \*\*([A-Z]+-\d+)\./g)) {
      const code = match[1];
      const start = match.index;
      const nextP = doctrine.indexOf('\n- **', start + 10);
      const nextS = doctrine.indexOf('\n## ', start);
      const end   = [nextP, nextS].filter(n => n > 0).sort((a, b) => a - b)[0] ?? start + 600;
      const cite  = citeRe.exec(doctrine.slice(start, end));
      if (cite) _citations[code] = { date: cite[1], quote: cite[2] };
    }
    logger.debug('Doctrine citations loaded', { count: Object.keys(_citations).length });
  } catch (e) {
    logger.warn('Could not load doctrine citations', { error: e.message });
  }
  return _citations;
}

// ── Doctrine chapter extractor ─────────────────────────────────────────────────

// Format → chapter numbers to include (per SKILL.md "שלב 3").
const DOCTRINE_CHAPTERS_BY_FORMAT = {
  feed:     [1, 2, 3, 4, 5, 6, 16],
  trial:    [1, 2, 3, 4, 5, 6, 8, 16],
  carousel: [1, 4, 5, 6, 11, 16],
  story:    [4, 13, 16],
  caption:  [4, 5, 10, 16],
  cover:    [2, 5, 16],
};

let _doctrineText = null;
function _loadDoctrineText() {
  if (_doctrineText) return _doctrineText;
  try {
    _doctrineText = fs.readFileSync(DOCTRINE_PATH, 'utf8');
  } catch (e) {
    logger.warn('[dana] doctrine.md not found', { error: e.message });
    _doctrineText = '';
  }
  return _doctrineText;
}

/**
 * Extract the specified chapters from doctrine.md.
 * Returns the chapter text joined, with the doctrine preamble (first 17 lines) included.
 */
function extractDoctrineChapters(format) {
  const doctrine = _loadDoctrineText();
  if (!doctrine) return '';

  const chapterNums = DOCTRINE_CHAPTERS_BY_FORMAT[format] ?? DOCTRINE_CHAPTERS_BY_FORMAT.feed;

  // Split into chapters at "## N." headings
  const sections = doctrine.split(/(?=^## \d+\.)/m);

  // Always keep the preamble (section before first ##-numbered chapter)
  const preamble = sections[0] ?? '';

  const wanted = new Set(chapterNums);
  const extracted = sections.filter(sec => {
    const m = sec.match(/^## (\d+)\./m);
    return m && wanted.has(Number(m[1]));
  });

  return (preamble.trim() + '\n\n' + extracted.join('\n')).trim();
}

// ── Score validator ────────────────────────────────────────────────────────────

const SCORE_KEYS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];

/**
 * Strict validator: mosseri_scores must be JavaScript integers (typeof 'number',
 * Number.isInteger) in [0, 5]. No Math.round, no string parsing, no boolean coercion.
 *
 * Rejects: 4.7 (float), true (boolean), "3" (string), "3abc" (string),
 *          null (null), undefined (missing), 85 (out of range), -1 (out of range).
 * Accepts: 0, 1, 2, 3, 4, 5 (exact integer values).
 *
 * Returns { valid: bool, errors: string[], fixed: object }.
 * fixed[k] is the validated integer or null if validation failed for that key.
 * scoreScaleValid=true should only be set when valid===true.
 */
function validateMosseriScores(scores) {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    return { valid: false, errors: ['mosseri_scores is missing or not a plain object'], fixed: {} };
  }
  const errors = [];
  const fixed  = {};

  for (const k of SCORE_KEYS) {
    const raw = scores[k];
    // 1. Must be a JavaScript number (not string, boolean, null, undefined)
    if (typeof raw !== 'number') {
      errors.push(`${k}: expected integer 0-5, got ${raw === null ? 'null' : raw === undefined ? 'missing' : typeof raw + '(' + JSON.stringify(raw) + ')'}`);
      fixed[k] = null;
      continue;
    }
    // 2. Must be an exact integer — rejects 4.7, NaN, Infinity
    if (!Number.isInteger(raw)) {
      errors.push(`${k}: expected integer, got float ${raw} — no rounding permitted`);
      fixed[k] = null;
      continue;
    }
    // 3. Must be in rubric range [0, 5]
    if (raw < 0 || raw > 5) {
      errors.push(`${k}: out of range [0,5] (got ${raw}) — model used wrong scale`);
      fixed[k] = null;
      continue;
    }
    fixed[k] = raw;
  }

  return { valid: errors.length === 0, errors, fixed };
}

// ── Chapter-code extractor ─────────────────────────────────────────────────────

/**
 * Extract the Set of principleCode values (e.g. 'HOOK-1', 'RANK-3') that appear
 * in the specified chapter numbers of doctrine.md.
 * Used to verify that a fix's principleCode comes from a chapter the model received.
 */
function getChapterCodes(doctrineText, chapterNums) {
  if (!doctrineText) return new Set();
  const wanted  = new Set(chapterNums);
  const sections = doctrineText.split(/(?=^## \d+\.)/m);
  const codes    = new Set();
  for (const sec of sections) {
    const m = sec.match(/^## (\d+)\./m);
    if (!m || !wanted.has(Number(m[1]))) continue;
    for (const match of sec.matchAll(/\*\*([A-Z]+-\d+)\./g)) {
      codes.add(match[1]);
    }
  }
  return codes;
}

/**
 * Validate principleCode values in a fixes array.
 * Two independent checks:
 *   inGlobalMap   — code exists anywhere in doctrine (proves it's real, not hallucinated)
 *   inSentChapters — code is in the chapters that were actually sent to the model
 *
 * codeValid = inGlobalMap && inSentChapters (both must pass for a fully valid fix).
 * These are stored separately so callers can distinguish the two failure modes.
 */
function validateFixCodes(fixes, citeMap, sentChapterCodes) {
  if (!Array.isArray(fixes)) return [];
  return fixes.map(fix => {
    const code = fix.principleCode;
    if (!code) {
      return { ...fix, codeValid: false, inGlobalMap: false, inSentChapters: false,
               codeError: 'principleCode missing' };
    }
    const inGlobalMap    = !!citeMap[code];
    const inSentChapters = sentChapterCodes ? sentChapterCodes.has(code) : null; // null = not checked
    const codeValid      = inGlobalMap && (inSentChapters !== false);
    const codeError      = !inGlobalMap
      ? `"${code}" not found in doctrine (hallucinated code)`
      : inSentChapters === false
        ? `"${code}" exists in doctrine but was NOT in the chapters sent to the model`
        : null;
    return { ...fix, codeValid, inGlobalMap, inSentChapters, codeError };
  });
}

// ── Stale-report marker ────────────────────────────────────────────────────────

/**
 * Scan all saved reports and mark those produced before the scale fix
 * (any report where any mosseri_score > 5).
 * Does NOT modify scores — just sets scoreScaleInvalid: true.
 * Returns a summary: { scanned, marked, alreadyMarked }.
 */
function markStaleReports() {
  const videoSvcLocal = require('../services/video.service');
  const videosDir = path.join(videoSvcLocal.DATA_DIR_FN(), 'videos');
  if (!fs.existsSync(videosDir)) return { scanned: 0, marked: 0, alreadyMarked: 0 };

  let scanned = 0, marked = 0, alreadyMarked = 0;

  for (const id of fs.readdirSync(videosDir)) {
    const reportPath = path.join(videosDir, id, 'report.json');
    if (!fs.existsSync(reportPath)) continue;
    scanned++;
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      if (report.scoreScaleInvalid === true || report.staleSchemaAnchored === true) { alreadyMarked++; continue; }

      const scores = report.mosseri_scores ?? {};
      const ANCHOR = { C1: 3, C2: 2, C3: 3, C4: 3, C5: 2, C6: 4, C7: 4 };
      const hasInvalidScale   = Object.values(scores).some(v => typeof v === 'number' && v > 5);
      const hasSchemaAnchor   = Object.entries(ANCHOR).every(([k, v]) => scores[k] === v);

      if (!hasInvalidScale && !hasSchemaAnchor) continue;

      if (hasInvalidScale) {
        report.scoreScaleInvalid = true;
        report.scoreScaleNote    = 'ציונים C1-C7 בדוח זה הוחזרו בסקאלה 0-100 במקום 0-5. הציון לא תקף. ניתן לנתח מחדש.';
      }
      if (hasSchemaAnchor && !hasInvalidScale) {
        report.staleSchemaAnchored = true;
        report.staleSchemaNote     = 'ציוני C1-C7 זהים לדוגמת ה-schema (schema-anchoring שתוקן ב-commit 354b17a). הדוח לא תקף.';
      }
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
      marked++;
      logger.warn('[dana] Stale report marked', { id, scores });
    } catch (e) {
      logger.warn('[dana] Could not check report', { id, error: e.message });
    }
  }

  logger.info('[dana] Stale-report scan complete', { scanned, marked, alreadyMarked });
  return { scanned, marked, alreadyMarked };
}

// ── Chat interface ─────────────────────────────────────────────────────────────

async function chat(userMessage) {
  const context = buildContext();
  danaHistory.push({ role: 'user', content: userMessage });

  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:    [
        { role: 'system', content: DANA_PROMPT },
        { role: 'system', content: context },
        ...danaHistory,
      ],
      temperature: 0.85,
      max_tokens:  700,
    });
    reply = completion.choices[0].message.content.trim();
  } catch (err) {
    logger.error('OpenAI error in dana_agent', { error: err.message });
    reply = 'שגיאה טכנית. בדוק את מפתח ה-OPENAI_API_KEY.';
  }

  danaHistory.push({ role: 'assistant', content: reply });
  danaHistory = danaHistory.slice(-30);
  return reply;
}

// ── Video analysis (Mosseri framework) ───────────────────────────────────────

/**
 * Analyse Instagram content using the Mosseri readiness framework.
 *
 * @param {object} opts
 * @param {string} opts.description  - free-text description of the video
 * @param {string} [opts.transcript] - spoken transcript / script
 * @param {string} [opts.format]     - feed | trial | carousel | story | caption | cover
 * @param {string} [opts.goal]       - awareness | conversion | retention
 * @param {string} [opts.title]      - short name for the review header
 * @returns {{ review, readiness, verdict, scores, flags, strengths }}
 */
async function analyzeVideo({
  description  = '',
  transcript   = '',
  format       = 'feed',
  goal         = 'awareness',
  title        = 'תוכן אינסטגרם',
} = {}) {
  // ── 1. Load rubric ─────────────────────────────────────────────────────────
  let rubric = '';
  try {
    rubric = fs.readFileSync(RUBRIC_PATH, 'utf8');
  } catch (e) {
    logger.warn('rubric.md not found — using embedded summary', { error: e.message });
    rubric = EMBEDDED_RUBRIC_SUMMARY;
  }

  // ── 2. Score with OpenAI ───────────────────────────────────────────────────
  const contentBlock = [
    description && `**תיאור הפריט:** ${description}`,
    transcript  && `**תמליל / תסריט:**\n${transcript}`,
    `**פורמט:** ${format}`,
    `**מטרה עסקית:** ${goal}`,
    `**הקשר:** Shape Studio — סטודיו כושר בוטיק בפרדס חנה-כרכור, קהל נשים 30-60`,
  ].filter(Boolean).join('\n\n');

  const scoringPrompt = `
אתה מנקד תוכן אינסטגרם לפי מחוון מוסרי. נקד כמו **זר מוחלט** שגולל ולא מכיר את היוצר.

${rubric}

---
## הפריט לניקוד
${contentBlock}
---

החזר **אך ורק JSON תקין**, ללא טקסט מחוץ לו, בדיוק בצורה הבאה:
{
  "scores":  { "C1":0, "C2":0, "C3":0, "C4":0, "C5":0, "C6":0, "C7":0 },
  "flags":   [],
  "reasonings": { "C1":"משפט אחד", "C2":"...", "C3":"...", "C4":"...", "C5":"...", "C6":"...", "C7":"..." },
  "strengths": ["מה שעובד — עם ראיה קצרה", "..."],
  "fixes": [
    {
      "principleCode": "HOOK-1",
      "name": "שם התיקון",
      "currentText": "הטקסט הנוכחי בפריט (ציטוט קצר)",
      "suggestedRewrite": "השכתוב המוכן לשימוש, בקול של היוצר",
      "explanation": "משפט הסבר אחד"
    }
  ],
  "whatMosseriPrinciple": "HOOK-1"
}

כללים:
- ציון כל קריטריון: מספר שלם 0-5 בלבד
- flags: רק מתוך: wordmark | aggregated | reupload | unpaid_promise | ai_slick
- עד 3 fixes, מסודרים לפי השפעה צפויה (קריטריון עם משקל גבוה ופער גדול מ-5 — ראשון)
- suggestedRewrite חייב להיות מוכן לשימוש ישיר, לא הוראות כלליות
- כל הטקסטים בעברית טבעית
`.trim();

  let scoring;
  try {
    const completion = await openai.chat.completions.create({
      model:           process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:        [
        { role: 'system', content: 'You score Instagram content. Reply with valid JSON only — no prose outside it.' },
        { role: 'user',   content: scoringPrompt },
      ],
      temperature:     0.2,
      max_tokens:      1600,
      response_format: { type: 'json_object' },
    });
    scoring = JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    logger.error('OpenAI scoring error in analyzeVideo', { error: err.message });
    throw new Error('שגיאה בניקוד הפריט: ' + err.message);
  }

  // ── 3. Run estimate.py ─────────────────────────────────────────────────────
  const estimation = runEstimate(scoring.scores, scoring.flags ?? [], format);

  // ── 4. Build review text ───────────────────────────────────────────────────
  const review = buildReview({ title, scoring, estimation });

  logger.info('Dana video analysis complete', {
    title,
    readiness: estimation.readiness,
    verdict:   estimation.verdict,
  });
  store.logEvent('video_analysis', null, {
    title,
    format,
    readiness: estimation.readiness,
  });

  // Enrich each fix with its dated citation from doctrine.md
  const citeMap = getCitations();
  const fixes = (scoring.fixes ?? []).map(fix => ({
    ...fix,
    citation: citeMap[fix.principleCode] ?? null,
  }));

  return {
    review,
    readiness:       estimation.readiness,
    verdict:         estimation.verdict,
    share_direction: estimation.share_direction ?? null,
    accuracy:        estimation.accuracy ?? null,
    scores:          scoring.scores,
    flags:           scoring.flags ?? [],
    strengths:       scoring.strengths ?? [],
    reasonings:      scoring.reasonings ?? {},
    fixes,
  };
}

// ── estimate.py runner (with pure-JS fallback) ────────────────────────────────

function runEstimate(scores, flags, format) {
  const tmpPath = path.join(os.tmpdir(), `mosseri_${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ c: scores, flags, format }), 'utf8');
    const raw = execFileSync(PYTHON_BIN, [ESTIMATE_BIN, tmpPath, '--lang', 'he'], {
      encoding: 'utf8',
      env:      { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout:  12000,
    });
    const result = JSON.parse(raw);
    // estimate.py has personal-baseline strings even when calibrated=false.
    // Without a real baseline.json, replace those with rubric-only phrasing.
    if (!result.calibrated && result.share_direction) {
      result.share_direction = result.share_direction
        .replace('מעל הרגיל שלך', 'גבוה לפי המחוון')
        .replace('בערך ברגיל שלך', 'בינוני לפי המחוון')
        .replace('שיתוף חלש', 'שיתוף נמוך לפי המחוון');
      result.baseline_missing = true;
    }
    return result;
  } catch (err) {
    logger.warn('estimate.py unavailable — using JS fallback', { error: err.message });
    return jsFallbackEstimate(scores, flags, format);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function jsFallbackEstimate(scores, flags, format) {
  let r = Object.entries(WEIGHTS).reduce(
    (sum, [k, w]) => sum + w * Math.max(0, Math.min(5, scores[k] ?? 0)) / 5, 0
  );
  (flags ?? []).forEach(f => { r -= PENALTIES[f] ?? 0; });
  r = Math.max(0, Math.min(100, Math.round(r * 10) / 10));

  const hasHard = (flags ?? []).some(f => HARD_FLAGS.has(f));
  const vKey = hasHard || r < 50 ? 'shelve' : r >= 75 && !flags?.length ? 'publish' : 'fix';
  const verdicts = { publish: 'לפרסם', fix: 'לתקן קודם', shelve: 'לגנוז' };

  const CALIBRATED = new Set(['feed', 'trial']);
  if (!CALIBRATED.has(format)) {
    return {
      readiness:   r,
      verdict:     verdicts[vKey],
      verdict_key: vKey,
      note:        'אין הערכת שיתוף לפורמט הזה. רק ציון ותיקונים.',
      accuracy:    'דיוק: ציון לפי מחוון מוסרי בלבד. ללא כיול חשבון אישי.',
    };
  }
  // No personal baseline — do not say "מעל הרגיל שלך" (implies personal data we don't have)
  const shareDir = r >= 78 ? 'הציון מצביע על פוטנציאל שיתוף גבוה לפי המחוון'
                 : r >= 60 ? 'הציון מצביע על פוטנציאל שיתוף בינוני לפי המחוון'
                 :           'הציון מצביע על פוטנציאל שיתוף נמוך. זה התיקון הראשון.';
  return {
    readiness:       r,
    verdict:         verdicts[vKey],
    verdict_key:     vKey,
    share_direction: shareDir,
    reach_note:      'אי אפשר לנבא חשיפה מהציון. בבדיקה עיוורת הציון לא ניבא חשיפה בכלל.',
    accuracy:        'דיוק: בבדיקה עיוורת על 16 רילס (יוצר אחד), הציון לא ניבא חשיפה (מתאם 0.00) ' +
                     'אבל היה קשור לשיעור שיתוף (ספירמן ~0.5). מדגם קטן — כיוון השיתוף הוא רמז, לא תחזית. ' +
                     'ללא כיול אישי, ה-"רגיל שלך" לא ידוע.',
    baseline_missing: true,
  };
}

// ── Review text builder ────────────────────────────────────────────────────────

function buildReview({ title, scoring, estimation }) {
  const cites  = getCitations();
  const vKey   = estimation.verdict_key
    ?? (estimation.verdict === 'לפרסם' ? 'publish'
       : estimation.verdict === 'לגנוז' ? 'shelve' : 'fix');
  const emoji  = vKey === 'publish' ? '✅' : vKey === 'shelve' ? '🚫' : '⚠️';

  const lines = [`🎬 ביקורת לפי מוסרי: ${title}`, ''];

  // Verdict + scores
  lines.push(`פסק דין: ${emoji} ${estimation.verdict}`);
  lines.push(`ציון מוכנות: ${estimation.readiness}/100`);
  if (estimation.share_direction) lines.push(`שיתוף: ${estimation.share_direction}`);
  lines.push(`חשיפה: ${estimation.reach_note ?? estimation.note ?? ''}`);
  if (estimation.trial_note) lines.push(`טריאל: ${estimation.trial_note}`);
  lines.push(estimation.accuracy ?? '');
  lines.push('');

  // Strengths
  const strengths = (scoring.strengths ?? []).slice(0, 3);
  if (strengths.length > 0) {
    lines.push('מה עובד');
    strengths.forEach(s => lines.push(`• ${s}`));
    lines.push('');
  }

  // Fixes
  const fixes = (scoring.fixes ?? []).slice(0, 3);
  if (fixes.length > 0) {
    lines.push(`${fixes.length === 3 ? '3' : fixes.length} התיקונים הכי חשובים`);
    fixes.forEach((fix, i) => {
      const cite    = cites[fix.principleCode];
      const citeStr = cite ? ` (מוסרי, ${cite.date}: "${cite.quote}")` : '';
      lines.push(`\n${i + 1}. ${fix.name}`);
      lines.push(`עכשיו: "${fix.currentText}"`);
      lines.push(`במקום: "${fix.suggestedRewrite}"`);
      lines.push(`למה: ${fix.explanation}${citeStr}`);
    });
    lines.push('');
  }

  // Risk flags
  lines.push('דגלי סיכון');
  const flags = scoring.flags ?? [];
  if (flags.length === 0) {
    lines.push('• אין דגלים');
  } else {
    flags.forEach(f => lines.push(`• ${translateFlag(f)}`));
  }
  lines.push('');

  // What Mosseri would say
  const principleCode = scoring.whatMosseriPrinciple ?? fixes[0]?.principleCode;
  const mCite = principleCode && cites[principleCode];
  lines.push('מה מוסרי היה אומר');
  lines.push(mCite
    ? `מוסרי, ${mCite.date}: "${mCite.quote}"`
    : 'לפי הדוקטרינה, הוא היה שואל: האם יש כאן סיבה קונקרטית שזר יעצור ב-3 השניות הראשונות?'
  );

  return lines.join('\n');
}

function translateFlag(flag) {
  return ({
    wordmark:        'wordmark — סימן מים של אפליקציה אחרת. פותר: להסיר לפני העלאה. (−15 נק׳)',
    aggregated:      'aggregated — רוב הסרטון הוא קטע של מישהו אחר. פותר: להוסיף פרשנות משמעותית. (−15 נק׳)',
    reupload:        'reupload — תוכן שכבר עלה. פותר: להשתמש בטריאל, לא בהעלאה חוזרת. (−20 נק׳)',
    unpaid_promise:  'unpaid_promise — ההוק מבטיח משהו שהסרטון לא מממש. פותר: לקיים את ההבטחה. (−10 נק׳)',
    ai_slick:        'ai_slick — מראה AI חלק מדי, בלי רגע אנושי. פותר: להוסיף הוכחה אנושית. (−5 נק׳)',
  })[flag] ?? flag;
}

// Minimal embedded rubric summary — used only when rubric.md is missing
const EMBEDDED_RUBRIC_SUMMARY = `
## מחוון ביקורת (סיכום)
C1 הוק (25): 5=הוק קונקרטי+כתוב, 3=הבטחה כללית, 1=ברכה/הקשר, 0=אין הוק
C2 שליחות (20): 5=נמען+סיבה ברורים, 3=קהל רחב, 1=עדכון אישי, 0=מביך לשלוח
C3 ערך לזר (20): 5=צעדים מיידיים/גילוי, 3=מעניין בלי "מה עושים", 1=BTS/אישי, 0=פרסומת
C4 מבנה (15): 5=כל קטע מוסיף+פירעון קרוב לסוף, 3=שטוח, 1=אין התקדמות, 0=לא מגיע לנקודה
C5 מקוריות (10): 5=הוכחה בגוף ראשון, 3=הסבר שכולם יכולים לחזור עליו, 0=העלאה מחדש של אחר
C6 קריאות (5): 5=כתוביות+הוק בפריים 1+אזור בטוח, 1=ללא כתוביות, 0=אין טקסט ואין דיבור
C7 נושא (5): 5=נושא אחד ברור, 1=שני נושאים+
`.trim();

// ── Content pack generation ───────────────────────────────────────────────────

async function generateContentPack(focusClass) {
  const cls = focusClass ?? pickRandom(STUDIO_CLASSES);
  logger.info('Dana generating content pack', { focusClass: cls });

  const prompt =
    `צרי חבילת תוכן דו-שבועית לאינסטגרם עבור Shape Studio, עם פוקוס על: **${cls}**.\n\n` +
    `החזירי בדיוק את המבנה הזה:\n\n` +
    `📸 **רעיון לסטורי:**\n[תיאור קצר — 2-3 משפטים]\n\n` +
    `🎬 **רעיון לריל:**\n[שורת הוק | מבנה ויזואלי | סגנון מוזיקה | CTA]\n\n` +
    `✍️ **קפשן לפוסט פיד:**\n[3-5 שורות + 6-8 האשטאגים רלוונטיים]\n\n` +
    `כל הטקסטים בעברית טבעית ולפי קול המותג של Shape Studio.`;

  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:    [
        { role: 'system', content: DANA_PROMPT },
        { role: 'user',   content: prompt },
      ],
      temperature: 0.85,
      max_tokens:  700,
    });
    const pack = completion.choices[0].message.content.trim();
    store.logEvent('content_pack_generated', null, { focusClass: cls });
    logger.info('Dana content pack generated', { focusClass: cls });
    return { focusClass: cls, pack };
  } catch (err) {
    logger.error('Dana content pack error', { error: err.message });
    throw err;
  }
}

async function generateAdCopy({ format = '4:5', objective = 'conversion', className } = {}) {
  const cls = className ?? pickRandom(STUDIO_CLASSES);
  logger.info('Dana generating ad copy', { format, objective, className: cls });

  const formatGuide = {
    '4:5':   'פוסט פיד — טקסט ראשי עד 125 תווים, כותרת חזקה',
    '9:16':  'ריל/סטורי — שורת הוק אחת חזקה, עובד גם ללא שמע',
    'story': 'סטורי — 1-2 שורות, CTA ב-swipe-up',
    'feed':  'פוסט פיד — 3-4 שורות, מסתיים בשאלה לקהל',
  };
  const objectiveGuide = {
    awareness:  'מודעות — תדמית ומותג, לא מכירה',
    conversion: 'המרה — לחיצה לקבוע ניסיון, הצעת 60 ש״ח ל-2 אימונים',
    retention:  'שימור — בניית קהילה וגאווה בחברים',
  };

  const prompt =
    `כתבי קופי לפרסומת לאינסטגרם עבור Shape Studio.\n\n` +
    `שיעור: **${cls}**\n` +
    `פורמט: ${format} — ${formatGuide[format] ?? format}\n` +
    `מטרה: ${objectiveGuide[objective] ?? objective}\n\n` +
    `החזירי:\n1. **טקסט ראשי**\n2. **כותרת**\n3. **תיאור** (אופציונלי)\n4. **CTA**\n5. **טיפ ויזואלי**\n\nבעברית.`;

  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:    [{ role: 'system', content: DANA_PROMPT }, { role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens:  500,
    });
    const copy = completion.choices[0].message.content.trim();
    store.logEvent('ad_copy_generated', null, { format, objective, className: cls });
    return { format, objective, className: cls, copy };
  } catch (err) {
    logger.error('Dana ad copy error', { error: err.message });
    throw err;
  }
}

// ── Context builder for chat ──────────────────────────────────────────────────

function buildContext() {
  const stats    = store.getDailyStats();
  const now      = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const lastPack = store.getEvents({ type: 'content_pack_generated', limit: 1 })[0];
  const lastAnalysis = store.getEvents({ type: 'video_analysis', limit: 1 })[0];

  return [
    `## הקשר תוכן של דנה — ${now}`,
    '',
    '### שיעורי Shape Studio',
    STUDIO_CLASSES.map(c => `  • ${c}`).join('\n'),
    '',
    '### קהל יעד',
    '  נשים גילאי 30-60 | פרדס חנה-כרכור | מחפשות תוצאות אמיתיות בסביבה פרמיום',
    '',
    '### תוכן אחרון שנוצר',
    lastPack    ? `  חבילה: ${timeSince(lastPack.ts)}, פוקוס: ${lastPack.data?.focusClass ?? '?'}` : '  חבילה: עדיין לא נוצרה',
    lastAnalysis? `  ניתוח וידאו: ${timeSince(lastAnalysis.ts)}, "${lastAnalysis.data?.title}", ציון ${lastAnalysis.data?.readiness}` : '  ניתוח וידאו: לא בוצע',
    '',
    '### כלי ניתוח',
    '  מסגרת מוסרי — 74 עקרונות של ראש אינסטגרם. שלחי תוכן לניתוח עם /api/dana/analyze-video',
    '',
    '### תובנות מהפייפליין',
    `  • ${stats.totalLeads} לידים | ${stats.hotLeadsTotal} חמים`,
  ].join('\n');
}

// ── Utils ──────────────────────────────────────────────────────────────────────

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function timeSince(date) {
  if (!date) return 'לא ידוע';
  const h = Math.floor((Date.now() - new Date(date).getTime()) / 3600000);
  return h < 24 ? `לפני ${h} שעות` : `לפני ${Math.floor(h / 24)} ימים`;
}

function clearHistory() { danaHistory = []; }

// ── Default audience from business context (Fix 7) ───────────────────────────
// Loaded once from business_context.md so it stays current with studio settings.
// Can be overridden per-request; never hardcoded in code.
function getDefaultAudience() {
  try {
    const ctx = fs.readFileSync(path.join(__dirname, '../prompts/business_context.md'), 'utf8');
    const m   = ctx.match(/## Target Audience\n([\s\S]*?)(?:\n## |\n---)/);
    if (m) return m[1].replace(/\*\*/g, '').replace(/^-\s*/gm, '').trim().split('\n')[0].trim();
  } catch {}
  return 'לקוחות Shape Studio, שרון'; // minimal fallback, no hardcoded demographics
}

// ── Skill connection status (Fix 5) ──────────────────────────────────────────
function getSkillStatus() {
  const rubricOk   = fs.existsSync(RUBRIC_PATH);
  const doctrineOk = fs.existsSync(DOCTRINE_PATH);
  const estimateOk = fs.existsSync(ESTIMATE_BIN);
  const citations  = doctrineOk ? Object.keys(getCitations()).length : 0;
  return {
    rubric_path:    RUBRIC_PATH,
    rubric_loaded:  rubricOk,
    doctrine_path:  DOCTRINE_PATH,
    doctrine_loaded: doctrineOk,
    doctrine_citations: citations,
    estimate_path:  ESTIMATE_BIN,
    estimate_exists: estimateOk,
    python_bin:     PYTHON_BIN,
    scoring_note:   'ציון C1-C7 מחושב על-ידי estimate.py (או fallback JS). ' +
                    'אין קשר לאלגוריתם ה-ranking של אינסטגרם; הציון מייצג את מחוון מוסרי הציבורי בלבד.',
  };
}

// ── Video-file analysis (actual video upload pipeline) ────────────────────────

/**
 * Analyse a video file saved to DATA_DIR (after multer upload).
 *
 * @param {object} opts
 * @param {string} opts.videoPath    — absolute path to saved video file
 * @param {string} opts.id           — pre-assigned analysis ID (created by createAnalysisJob)
 * @param {string} [opts.ext]
 * @param {string} [opts.title]
 * @param {string} [opts.goal]
 * @param {string} [opts.format]
 * @param {string} [opts.audience]   — defaults to getDefaultAudience()
 * @param {string} [opts.organic_or_paid]
 * @param {string} [opts.message]
 * @param {string} [opts.focus_notes]
 * @param {string} [opts.previousVersionId]
 * @param {function} [opts.onProgress]  — (stage, note) callback for job status updates
 */
async function analyzeVideoFile({
  videoPath,
  id,
  ext             = 'mp4',
  title           = 'סרטון ללא כותרת',
  goal            = 'leads',
  format          = 'feed',
  audience        = '',       // empty = load from business context
  organic_or_paid = 'organic',
  message         = '',
  focus_notes     = '',
  previousVersionId = null,
  onProgress      = null,
} = {}) {
  const effectiveAudience = audience?.trim() || getDefaultAudience();

  // Load rubric for 0-5 scoring — without this the model defaults to 0-100 scale,
  // which estimate.py clamps to 5 for every criterion, producing readiness=100 always.
  let rubricText = '';
  try {
    rubricText = fs.readFileSync(RUBRIC_PATH, 'utf8');
  } catch (e) {
    logger.warn('[dana] rubric.md not found — scoring may use wrong scale', { error: e.message });
  }

  // Extract the doctrine chapters relevant to this format.
  // For a reel in feed: chapters 1 (RANK), 2 (HOOK), 3 (WATCH), 4 (SEND), 5 (TEXT), 6 (ORIG), 16 (myths).
  const effectiveFormat  = organic_or_paid === 'paid' ? 'feed' : (format || 'feed');
  const sentChapterNums  = DOCTRINE_CHAPTERS_BY_FORMAT[effectiveFormat] ?? DOCTRINE_CHAPTERS_BY_FORMAT.feed;
  const doctrineChapters = extractDoctrineChapters(effectiveFormat);
  // Build the set of principle codes that are in the chapters sent to this model call.
  // Used in validateFixCodes to separate "code exists globally" from "code was sent".
  const sentChapterCodes = getChapterCodes(_loadDoctrineText(), sentChapterNums);

  const progress = (stage, note) => {
    logger.info('[dana] Analysis progress', { id, stage, note });
    if (onProgress) onProgress(stage, note);
  };

  progress('meta', 'קורא מטא-דאטה...');
  logger.info('[dana] analyzeVideoFile started', { id, title, format, goal });

  // ── 1. Get metadata — required; fail if ffprobe broken ───────────────────
  const meta = await videoSvc.getVideoMeta(videoPath);
  logger.info('[dana] Video meta', { id, ...meta });

  if (!meta.probeOk) {
    throw new Error(
      'לא ניתן לקרוא את פרטי הסרטון (ffprobe נכשל). ' +
      'ודא שהקובץ תקין ופורמטו נתמך (mp4/mov/webm).'
    );
  }
  if (!meta.durationSec) {
    throw new Error('משך הסרטון לא זוהה — לא ניתן לחלץ פריימים ולקבוע כיסוי.');
  }
  if (meta.durationSec > 900) {
    throw new Error(`הסרטון ארוך מדי (${Math.round(meta.durationSec / 60)} דקות). הגבלה: 15 דקות.`);
  }

  // ── 2. Extract frames with real timestamps ───────────────────────────────
  progress('frames', 'מחלץ פריימים...');
  let frames = [];
  let frameError = null;
  try {
    frames = await videoSvc.extractFrames(videoPath, meta.durationSec);
  } catch (err) {
    frameError = err.message;
    logger.warn('[dana] Frame extraction failed', { id, error: err.message });
  }

  // ── 3. Transcribe audio (Whisper verbose_json for real word timestamps) ──
  progress('audio', 'מתמלל שמע...');
  let audioResult = { text: '', wordTimestamps: [], coverage: 'not_attempted', truncated: false };
  let audioError  = null;
  try {
    audioResult = await videoSvc.transcribeAudio(videoPath, meta.hasAudio);
  } catch (err) {
    audioError = err.message;
    logger.warn('[dana] Transcription failed', { id, error: err.message });
  }

  const hasFrames     = frames.length > 0;
  const hasTranscript = audioResult.text.length > 0;

  // ── 3a. Gate: refuse to generate a report with no data ───────────────────
  if (!hasFrames && !hasTranscript) {
    throw new Error(
      'הניתוח נעצר: לא הצלחנו לחלץ פריימים ולא להפיק תמלול מהסרטון. ' +
      (frameError ? `שגיאת פריימים: ${frameError}. ` : '') +
      (audioError ? `שגיאת שמע: ${audioError}.` : '')
    );
  }

  // ── 4. Load previous version for comparison ───────────────────────────────
  const prevReport = previousVersionId ? videoSvc.loadReport(previousVersionId) : null;

  // ── 5. Build analysis input ───────────────────────────────────────────────
  progress('analyze', 'דנה מנתחת...');

  // Data availability summary — explicit, used in prompt and stored in report
  const dataAvail = {
    frames_extracted:     frames.length,
    frames_total_planned: Math.min(20, Math.floor(meta.durationSec)),
    frame_first_sec:      hasFrames ? frames[0].timestampSec      : null,
    frame_last_sec:       hasFrames ? frames[frames.length-1].timestampSec : null,
    has_transcript:       hasTranscript,
    transcript_chars:     audioResult.text.length,
    transcript_truncated: audioResult.truncated,
    transcript_coverage:  audioResult.coverage,
    whisper_duration:     audioResult.whisperDuration ?? null,
    audio_quality_verified: false, // Whisper cannot verify audio quality/balance/noise
    motion_verified:        false, // sampled frames cannot verify continuous motion
    sync_verified:          false, // audio-visual sync not directly measurable
    video_duration_sec:   meta.durationSec,
    ffprobe_ok:           meta.probeOk,
  };

  // Build Whisper word-timestamp context for the prompt (real timestamps, labeled)
  let whisperContext = '';
  if (audioResult.wordTimestamps?.length > 0) {
    const lines = audioResult.wordTimestamps
      .slice(0, 150) // cap at 150 words to fit token budget
      .map(w => `[${w.start.toFixed(1)}s] ${w.word}`)
      .join(' ');
    whisperContext = `\n\n**תמלול מתוזמן (Whisper):**\n${lines}`;
    if (audioResult.truncated) {
      whisperContext += `\n_(תמלול קוצר ב-${audioResult.text.length} תווים מתוך ${meta.durationSec.toFixed(0)}s)_`;
    }
  } else if (hasTranscript) {
    whisperContext = `\n\n**תמלול דיבור (ללא חותמות זמן):**\n${audioResult.text}`;
  }

  const contextBlock = [
    `**כותרת:** ${title}`,
    `**מטרה:** ${goal}`,
    `**פורמט:** ${format}`,
    `**קהל יעד:** ${effectiveAudience}`,
    `**פרסום:** ${organic_or_paid}`,
    message      && `**מסר ו-CTA:** ${message}`,
    focus_notes  && `**דגשים לבדיקה:** ${focus_notes}`,
    `**משך:** ${meta.durationSec.toFixed(1)} שניות`,
    meta.width && meta.height ? `**רזולוציה:** ${meta.width}×${meta.height}` : '',
    `**פריימים שנחלצו:** ${frames.length} (טווח: ${dataAvail.frame_first_sec?.toFixed(1) ?? '—'}s–${dataAvail.frame_last_sec?.toFixed(1) ?? '—'}s)`,
    whisperContext,
  ].filter(Boolean).join('\n');

  const prevBlock = prevReport ? [
    '---',
    '## ביקורת גרסה קודמת (הקשר בלבד)',
    `ציון קודם: ${prevReport.readiness}/100 | פסק דין: ${prevReport.verdict}`,
    `מטרה קודמת: ${prevReport.goal} | בסיס ההשוואה מוגבל אם המטרה השתנתה.`,
    `חוזקות שזוהו: ${(prevReport.report_strengths ?? prevReport.strengths ?? []).slice(0,2).join('; ')}`,
    `בעיות שזוהו: ${(prevReport.report_problems ?? []).slice(0,2).join('; ')}`,
    '---',
  ].join('\n') : '';

  // Audio quality note — explicit in prompt
  const audioLimitNote = `
⚠️ מה CANNOT להעריך מתמלול בלבד (יסומן unverified=true):
  - איזון מוזיקה מול קריינות
  - רעשי רקע וניקיון ההקלטה
  - סנכרון אודיו-ויזואל
  - עוצמת קול ודינמיקה

⚠️ מה CANNOT להעריך מפריימים מדגמיים:
  - קצב חיתוכים רציף
  - תנועה ואנימציות בין פריימים
  - סנכרון מדויק בין שמע לתמונה`;

  const skillRules = [
    '## חוקים קשיחים של מסגרת מוסרי',
    '1. **שפה:** עברית כברירת מחדל.',
    '2. **כל תיקון נשען על עיקרון מהדוקטרינה עם principleCode תקין** (כגון HOOK-1, RANK-3, TEXT-1, SEND-1). תיקון בלי עיגון לא נכנס.',
    '3. **מספרים רק מ-estimate.py.** לא מעגלים, לא "מרגישים". (הציון מחושב אוטומטית — אל תכניסי readiness בעצמך.)',
    '4. **סתירה בין הדוקטרינה לנתוני הסרטון נאמרת בקול** — "הדוקטרינה אומרת X; בסרטון רואים Y".',
    '5. **לא דורסים החלטות של היוצר** — מעירים, לא כופים שכתוב.',
    '6. **השכתוב בקול של היוצר**, לא בקול גנרי.',
    '7. **ביקורת בלבד** — לא מפרסמות, לא מתזמנות.',
    '8. **מנקדים כמו זר מוחלט** — לפי המחוון, לפני שקוראים ההקשר העסקי. ההקשר (Shape Studio) נכנס רק בתיקונים.',
    '9. **אין הבטחת מספר צפיות.** הציון לא ניבא חשיפה בבדיקה עיוורת.',
  ].join('\n');

  const systemMsg = [
    `אתה דנה, מנהלת התוכן הדיגיטלי של Shape Studio.`,
    `אתה מנתחת סרטוני אינסטגרם לפני פרסום — ביקורת מקצועית, כנה, מנומקת.`,
    '',
    DANA_PROMPT,
    '',
    skillRules,
    '',
    audioLimitNote,
    '',
    rubricText ? `## מחוון ניקוד מוסרי C1–C7\n\n${rubricText}` : '',
    '',
    doctrineChapters ? `## דוקטרינת מוסרי — עקרונות רלוונטיים לפורמט זה\n\n${doctrineChapters}` : '',
    '',
    '## כללי חובה לפלט JSON',
    '- אל תמציאי נתונים שאינם בסרטון (מחירים, עדויות, ציטוטים).',
    '- unverified=true → score=null. אסור ציון אפס כסימן "לא עובד".',
    '- חותמות זמן חייבות להסתמך על timestamp של פריים שנשלח או timestamp מ-Whisper בלבד.',
    '- ציונים מבוססים רק על מה שנראה/נשמע — לא הנחות.',
    '- אל תציגי את הסקיל ככלי "רשמי" של אינסטגרם — זה ניתוח לפי עקרונות ציבוריים של אדם מוסרי.',
    '- **mosseri_scores: כל ערך חייב להיות מספר שלם 0–5 בלבד לפי המחוון.** ערך > 5 הוא שגיאת סכמה.',
    '- **mosseri_fixes: principleCode חייב להיות מהדוקטרינה שקיבלת (HOOK-1, RANK-5, TEXT-1, SEND-3, ORIG-4, WATCH-1 וכד׳).**',
    '- fixType="rewrite" → חייב currentText (ציטוט מהסרטון) + suggestedRewrite (שכתוב מוכן).',
    '- fixType="visual" או "structural" → חייב action (מה לעשות) + evidence (ראיה מהסרטון, timestamp). אין currentText.',
    '- אין להמציא currentText אם אין ציטוט ממשי מהסרטון.',
  ].join('\n');

  // Schema specification — field names and types ONLY, no example values.
  // Using prose description instead of JSON.stringify avoids model anchoring on numeric examples.
  const schemaSpec = [
    '## סכמת פלט — שמות שדות וטיפוסים. אל תכניסי ערכים מקבילים לאלה שרשומים כאן.',
    '',
    'כל התוכן חייב להגיע מהסרטון הספציפי הזה — פריימים שנשלחו, Whisper, וראיה חזותית.',
    '',
    'שדות ראשיים:',
    '  perceived_message: string(1-2 משפטים מה הסרטון אומר)',
    '  message_lands: boolean',
    '  recommendation: אחת מ: "מוכן לפרסום" | "דורש תיקונים קלים" | "דורש עריכה משמעותית"',
    '  strengths: array of string (חוזקות מהסרטון עם ראיה)',
    '  problems:  array of string (בעיות עם הסבר)',
    '',
    'sections — אובייקט עם המפתחות: hook, message, content, editing, captions, audio, visuals, cta, platform',
    '  כל מפתח: { finding: string, score: integer 0-5 | null, unverified: boolean }',
    '  editing:  score=null, unverified=true (פריימים לא מוכיחים קצב חיתוכים)',
    '  audio:    score=null, unverified=true, speech_text: תמלול מ-Whisper',
    '',
    'timestamps: array of { range: "M:SS-M:SS", observation: string, works: string,',
    '  problem: string, suggestion: string, anchor: "frame"|"whisper", approximate: boolean }',
    '  — רק timestamps מפריים שנשלחו בפועל או מ-Whisper. אין להמציא זמנים.',
    '',
    'mosseri_scores: { C1: integer, C2: integer, C3: integer, C4: integer, C5: integer, C6: integer, C7: integer }',
    '  — כל ערך: מספר שלם 0-5 בלבד, לפי המחוון שקיבלת לסרטון זה. לא ברירת מחדל.',
    '  — ציון שונה לכל קריטריון לפי מה שנראה/נשמע בפועל.',
    '',
    'mosseri_flags: array (ריק אם אין) — ערכים אפשריים: "wordmark"|"aggregated"|"reupload"|"unpaid_promise"|"ai_slick"',
    'mosseri_reasonings: { C1..C7: string — משפט אחד עם ראיה ספציפית מהסרטון הזה }',
    'mosseri_strengths: array of string',
    '',
    'mosseri_fixes: array, עד 3 תיקונים, מסודרים לפי (משקל קריטריון × פער מ-5) בסרטון הזה:',
    '  כל fix חייב:',
    '    principleCode: string — קוד מהפרקים שקיבלת (לא קוד שלא הופיע בדוקטרינה שנשלחה)',
    '    fixType: "rewrite" | "visual" | "structural"',
    '    name: string',
    '    explanation: string',
    '  rewrite בלבד: currentText (ציטוט מילולי מדויק מהתמלול), suggestedRewrite (מוכן לשימוש)',
    '  visual/structural בלבד: action (ספציפי לסרטון), evidence (timestamp מפריים שנשלחו)',
    '  currentText=null עבור visual/structural. אין להמציא ציטוטים.',
    '',
    'improvements_must: array | improvements_recommended: array | improvements_experiments: array',
    'hook_alternatives: array of 3 strings',
    'cta_options: array of 2 strings',
    'edit_plan: array of { order: integer, segment: string, duration: "M:SS-M:SS" }',
    'analysis_limitations: array of string',
  ].join('\n');

  const userMsg = [
    `נתחי את הסרטון הבא לפני פרסום.`,
    `פריימים מחולקים לאורך ${meta.durationSec.toFixed(1)}s — כל פריים מסומן בזמן שחולץ בפועל.`,
    '',
    contextBlock,
    prevBlock,
    '',
    schemaSpec,
    '',
    'החזירי JSON תקין בלבד (ללא טקסט מחוץ ל-JSON) עם כל השדות שמפורטים למעלה.',
  ].join('\n');

  // Build GPT-4o vision content: text + labeled frames
  const frameMessages = frames.map((f, i) => [
    // Label each frame with its real timestamp before the image
    { type: 'text', text: `[פריים ${i+1}: ${f.timestampSec.toFixed(1)}s]` },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' } },
  ]).flat();

  const userContent = hasFrames
    ? [{ type: 'text', text: userMsg }, ...frameMessages]
    : userMsg;

  let gptData;
  try {
    const completion = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages:        [{ role: 'system', content: systemMsg }, { role: 'user', content: userContent }],
      temperature:     0.2,
      max_tokens:      4000,
      response_format: { type: 'json_object' },
    });
    gptData = JSON.parse(completion.choices[0].message.content);
    logger.info('[dana] GPT-4o analysis complete', { id });
  } catch (err) {
    logger.error('[dana] GPT-4o analysis failed', { id, error: err.message });
    throw new Error('ניתוח GPT-4o נכשל: ' + err.message);
  }

  // ── Validate mosseri_scores scale (must be integers 0-5) ─────────────────
  const scoreValidation = validateMosseriScores(gptData.mosseri_scores);
  if (!scoreValidation.valid) {
    logger.error('[dana] mosseri_scores scale violation', {
      id,
      errors:    scoreValidation.errors,
      raw_scores: gptData.mosseri_scores,
    });
    throw new Error(
      'ציוני מוסרי בסקאלה שגויה: ' + scoreValidation.errors.join('; ') +
      '. המודל החזיר ערכים מחוץ לטווח 0-5. נסה שוב.'
    );
  }
  // Use the validated (rounded) scores from here on
  const validatedScores = scoreValidation.fixed;

  // ── Validate principleCode in fixes — two independent checks ────────────
  // Check 1 (inGlobalMap):   code exists anywhere in the full doctrine.md (not hallucinated).
  // Check 2 (inSentChapters): code is from the chapters that were sent to the model in this call.
  // codeValid = both pass. These are stored separately in the fix for transparency.
  const citeMapForValidation = getCitations();
  const rawFixes       = gptData.mosseri_fixes ?? [];
  const validatedFixes = validateFixCodes(rawFixes, citeMapForValidation, sentChapterCodes);
  const invalidCodes   = validatedFixes.filter(f => !f.codeValid).map(f => ({
    code:            f.principleCode ?? '(none)',
    inGlobalMap:     f.inGlobalMap,
    inSentChapters:  f.inSentChapters,
    error:           f.codeError,
  }));
  if (invalidCodes.length > 0) {
    logger.warn('[dana] mosseri_fixes principleCode issues', { id, issues: invalidCodes });
    // Keep all fixes — codeValid:false and separate flags make each failure visible.
  }

  // ── Mosseri scoring ───────────────────────────────────────────────────────
  progress('scoring', 'מחשב ציון מוסרי...');
  const mosseriScores = validatedScores;
  const mosseriFlags  = gptData.mosseri_flags  ?? [];
  const mosseriFormat = ['feed','trial'].includes(format) ? format : 'other';
  const estimation    = runEstimate(mosseriScores, mosseriFlags, mosseriFormat);

  // ── Category scores — exclude unverified (Fix 2 + Fix 6) ─────────────────
  const sections = gptData.sections ?? {};
  const categoryScores = {};
  for (const [k, sec] of Object.entries(sections)) {
    categoryScores[k] = sec?.unverified ? null : (sec?.score ?? null);
  }

  // ── Timestamps: validate against known video duration (Fix 1) ────────────
  const rawTimestamps = gptData.timestamps ?? [];
  const durationSec   = meta.durationSec;
  const timestamps = rawTimestamps.map(t => {
    // Check if range start is within actual video duration
    const startSec = parseTimestampRange(t.range);
    const inRange  = startSec !== null ? startSec <= durationSec : null;
    return {
      ...t,
      approximate: t.anchor === 'frame' ? false : !hasFrames,
      out_of_range: inRange === false,
    };
  }).filter(t => !t.out_of_range); // remove hallucinated timestamps beyond video

  // ── Mosseri fixes + citations (using already-validated fixes) ───────────
  const citeMap = getCitations();
  const fixes = validatedFixes.map(fix => ({
    ...fix,
    citation: (fix.codeValid && fix.principleCode) ? (citeMap[fix.principleCode] ?? null) : null,
  }));

  // ── Version comparison — computed in code, not by model (Fix 6) ──────────
  let comparison = null;
  if (prevReport && gptData.comparison) {
    const scoreDelta = estimation.readiness - (prevReport.readiness ?? 0);
    const goalChanged = prevReport.goal && prevReport.goal !== goal;
    comparison = {
      ...gptData.comparison,
      score_change:         scoreDelta,         // always from stored data
      goal_changed:         goalChanged,
      comparison_note:      goalChanged
        ? `⚠️ מטרת הסרטון השתנתה (${prevReport.goal} → ${goal}). ההשוואה מוגבלת.`
        : null,
      prev_readiness:       prevReport.readiness ?? null,
      current_readiness:    estimation.readiness,
    };
  }

  // ── Warnings (data quality, not hidden) ────────────────────────────────────
  const warnings = [
    frameError   && `חילוץ פריימים נכשל: ${frameError}`,
    audioError   && `תמלול שמע נכשל: ${audioError}`,
    audioResult.truncated && `תמלול קוצר — ${audioResult.text.length} תווים מכסים חלק מהסרטון.`,
    !hasTranscript && hasFrames && 'ניתוח מבוסס ויזואל בלבד — שמע לא זמין.',
    !hasFrames && hasTranscript && 'ניתוח מבוסס שמע בלבד — פריימים לא זמינים.',
    ...(gptData.analysis_limitations ?? []),
  ].filter(Boolean);

  // ── Skill status (Fix 5) ─────────────────────────────────────────────────
  const skillStatus = getSkillStatus();

  // ── Assemble report ────────────────────────────────────────────────────────
  const prevVersion = prevReport?.version ?? 0;
  const report = {
    id,
    title,
    createdAt:          new Date().toISOString(),
    version:            previousVersionId ? prevVersion + 1 : 1,
    previousVersionId:  previousVersionId ?? null,
    format,
    goal,
    audience:           effectiveAudience,
    organic_or_paid,
    message,
    focus_notes,

    // Mosseri framework output
    readiness:          estimation.readiness,
    verdict:            estimation.verdict,
    share_direction:    estimation.share_direction ?? null,
    accuracy:           estimation.accuracy        ?? null,
    baseline_missing:   estimation.baseline_missing ?? true,
    scoreScaleValid:    true,         // set here because validateMosseriScores passed (throws otherwise)
    sentDoctrineChapters: sentChapterNums, // which doctrine chapters were in this analysis
    mosseri_scores:     mosseriScores,
    mosseri_flags:      mosseriFlags,
    flags:              mosseriFlags,
    strengths:          gptData.mosseri_strengths ?? [],
    fixes,
    reasonings:         gptData.mosseri_reasonings ?? {},

    // Detailed review
    perceived_message:  gptData.perceived_message ?? '',
    message_lands:      gptData.message_lands     ?? null,
    recommendation:     gptData.recommendation    ?? '',
    report_strengths:   gptData.strengths  ?? [],
    report_problems:    gptData.problems   ?? [],
    sections,
    category_scores:    categoryScores,
    timestamps,
    improvements_must:        gptData.improvements_must        ?? [],
    improvements_recommended: gptData.improvements_recommended ?? [],
    improvements_experiments: gptData.improvements_experiments ?? [],
    hook_alternatives:        gptData.hook_alternatives        ?? [],
    cta_options:              gptData.cta_options              ?? [],
    edit_plan:                gptData.edit_plan                ?? [],
    comparison,

    // Analysis metadata
    videoMeta:        { durationSec: meta.durationSec, width: meta.width, height: meta.height, fps: meta.fps },
    dataAvailability: dataAvail,
    skillStatus,
    frameCount:       frames.length,
    transcript:       audioResult.text.slice(0, 2000),
    warnings,
  };

  videoSvc.saveReport(id, report);
  store.logEvent('video_analysis', null, { id, title, format, goal, readiness: estimation.readiness, verdict: estimation.verdict, version: report.version });
  logger.info('[dana] analyzeVideoFile complete', { id, readiness: estimation.readiness, verdict: estimation.verdict, warnings: warnings.length });

  return report;
}

// ── Timestamp parser helper ────────────────────────────────────────────────────
// Parses "1:23" or "0:03-0:08" → first time in seconds. Returns null if unparseable.
function parseTimestampRange(range) {
  if (!range) return null;
  const first = range.split('-')[0].trim();
  const parts = first.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

// ── Async job management (Fix 4) ──────────────────────────────────────────────

const _activeJobs = new Map(); // in-process job registry (augments DATA_DIR persistence)

function createAnalysisJob(id, metadata = {}) {
  const job = {
    id,
    status: 'queued',
    stage:  'queued',
    note:   'ממתין להתחלה...',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    result: null,
    ...metadata,
  };
  _activeJobs.set(id, job);
  videoSvc.saveJob(id, { ...job, result: null }); // don't persist large result in job.json
  return job;
}

function updateJob(id, patch) {
  const existing = _activeJobs.get(id) ?? videoSvc.loadJob(id) ?? { id };
  const updated  = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  _activeJobs.set(id, updated);
  // Persist without full result (result is in report.json)
  const { result: _r, ...slim } = updated;
  videoSvc.saveJob(id, slim);
  return updated;
}

function getJob(id) {
  // In-process first (fastest); fall back to disk for jobs that survived restart
  const mem = _activeJobs.get(id);
  if (mem && mem.status !== 'queued') return mem;
  const disk = videoSvc.loadJob(id);
  if (disk) {
    // If completed on disk, load report
    if (disk.status === 'completed') {
      const result = videoSvc.loadReport(id);
      return { ...disk, result };
    }
    return disk;
  }
  return null;
}

module.exports = {
  chat, generateContentPack, generateAdCopy, analyzeVideo, analyzeVideoFile,
  clearHistory,
  getVideoHistory:  () => videoSvc.listReports(),
  getVideoReport:   (id) => videoSvc.loadReport(id),
  createAnalysisJob,
  updateJob,
  getJob,
  getSkillStatus,
  markStaleReports,
  // Exported for testing
  validateMosseriScores,
};
