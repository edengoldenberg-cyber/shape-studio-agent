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
      // Slice to the next principle or section heading
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
    return JSON.parse(raw);
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
      readiness: r,
      verdict:   verdicts[vKey],
      verdict_key: vKey,
      note:      'אין הערכת חשיפה או שיתוף לפורמט הזה. רק ציון ותיקונים.',
      accuracy:  'דיוק: חישוב JS פנימי (estimate.py לא זמין). הציון נכון, כיוון השיתוף לא מחושב.',
    };
  }
  return {
    readiness:     r,
    verdict:       verdicts[vKey],
    verdict_key:   vKey,
    share_direction: r >= 78 ? 'הציון מצביע על שיתוף מעל הרגיל שלך'
                   : r >= 60 ? 'הציון מצביע על שיתוף בערך ברגיל שלך'
                   :           'הציון מצביע על שיתוף חלש. זה התיקון הראשון',
    reach_note:    'אי אפשר לנבא חשיפה מהציון. בבדיקה העיוורת הציון לא ניבא חשיפה בכלל.',
    accuracy:      'דיוק: בבדיקה עיוורת על 16 רילס של יוצר אחד, הציון לא ניבא חשיפה (מתאם 0.00), ' +
                   'אבל היה קשור לשיעור השיתוף (מתאם ספירמן בערך 0.5). מדגם קטן של חשבון אחד, ' +
                   'ולכן כיוון השיתוף הוא רמז ולא תחזית, וחשיפה לא מנובאת בכלל.',
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

// ── Video-file analysis (actual video upload pipeline) ────────────────────────

/**
 * Analyse an actual video file using Dana's Mosseri framework.
 *
 * Pipeline:
 *   1. Save video to DATA_DIR/videos/{id}/
 *   2. Extract up to 20 evenly-spaced frames with ffmpeg
 *   3. Transcribe audio with Whisper API (not local GPU)
 *   4. Send frames + transcript to GPT-4o vision for structured analysis
 *   5. Run Mosseri C1-C7 scoring via existing analyzeVideo()
 *   6. Build comprehensive report (initial decision + 8 professional sections +
 *      timestamped notes + scores + improvement suggestions)
 *   7. Save report JSON to DATA_DIR and return
 *
 * @param {object} opts
 * @param {Buffer} opts.videoBuffer
 * @param {string} opts.ext          — file extension without dot
 * @param {string} [opts.title]
 * @param {string} [opts.goal]       — leads | awareness | trust | community | other
 * @param {string} [opts.format]     — feed | trial | story | carousel
 * @param {string} [opts.audience]
 * @param {string} [opts.organic_or_paid]
 * @param {string} [opts.message]    — intended message / CTA
 * @param {string} [opts.focus_notes]
 * @param {string} [opts.previousVersionId] — for comparison analysis
 * @returns {Promise<object>} analysis report
 */
async function analyzeVideoFile({
  videoBuffer,
  ext           = 'mp4',
  title         = 'סרטון ללא כותרת',
  goal          = 'leads',
  format        = 'feed',
  audience      = 'נשים 30-60, אזור פרדס חנה-כרכור',
  organic_or_paid = 'organic',
  message       = '',
  focus_notes   = '',
  previousVersionId = null,
} = {}) {
  const id = uuidv4();
  logger.info('[dana] analyzeVideoFile started', { id, title, format, goal });

  // ── 1. Save video ─────────────────────────────────────────────────────────
  const videoPath = videoSvc.saveVideoFile(id, videoBuffer, ext);
  logger.info('[dana] Video saved', { id, path: videoPath, sizeKb: Math.round(videoBuffer.length / 1024) });

  // ── 2. Get metadata ───────────────────────────────────────────────────────
  let meta = { durationSec: 0, width: 0, height: 0, fps: 30, hasAudio: true };
  try {
    meta = await videoSvc.getVideoMeta(videoPath);
    logger.info('[dana] Video meta', { id, ...meta });
  } catch (err) {
    logger.warn('[dana] ffprobe failed — continuing with defaults', { error: err.message });
  }

  // Reject video exceeding 15 minutes (UI limit is 200 MB / 15 min)
  if (meta.durationSec > 900) {
    throw new Error(`הסרטון ארוך מדי (${Math.round(meta.durationSec / 60)} דקות). הגבלה: 15 דקות.`);
  }

  // ── 3. Extract frames ─────────────────────────────────────────────────────
  let frames = [];
  const frameWarnings = [];
  try {
    frames = await videoSvc.extractFrames(videoPath, meta.durationSec || 30);
  } catch (err) {
    logger.warn('[dana] Frame extraction failed — will analyse without frames', { error: err.message });
    frameWarnings.push('חילוץ פריימים נכשל — הניתוח מבוסס על שמע ותיאור בלבד.');
  }

  // ── 4. Transcribe audio ───────────────────────────────────────────────────
  let transcript = '';
  const audioWarnings = [];
  try {
    transcript = await videoSvc.transcribeAudio(videoPath, meta.hasAudio);
  } catch (err) {
    logger.warn('[dana] Transcription failed', { error: err.message });
    audioWarnings.push('תמלול שמע נכשל — הניתוח מבוסס על תמונה בלבד.');
  }

  // ── 5. Load previous version for comparison ───────────────────────────────
  let prevReport = null;
  if (previousVersionId) {
    prevReport = videoSvc.loadReport(previousVersionId);
  }

  // ── 6. GPT-4o full analysis ────────────────────────────────────────────────
  const contextBlock = [
    `**כותרת:** ${title}`,
    `**מטרה:** ${goal}`,
    `**פורמט:** ${format}`,
    `**קהל יעד:** ${audience}`,
    `**פרסום:** ${organic_or_paid}`,
    message      && `**מסר ו-CTA:** ${message}`,
    focus_notes  && `**דגשים לבדיקה:** ${focus_notes}`,
    `**משך:** ${meta.durationSec ? Math.round(meta.durationSec) + ' שניות' : 'לא ידוע'}`,
    `**רזולוציה:** ${meta.width && meta.height ? `${meta.width}×${meta.height}` : 'לא ידוע'}`,
    transcript   && `\n**תמלול דיבור:**\n${transcript.slice(0, 4000)}`,
  ].filter(Boolean).join('\n');

  const prevBlock = prevReport ? `
---
## ביקורת גרסה קודמת (להשוואה)
ציון קודם: ${prevReport.readiness}/100 | פסק דין: ${prevReport.verdict}
חוזקות שזוהו: ${(prevReport.strengths ?? []).join('; ')}
תיקונים שהוצעו: ${(prevReport.fixes ?? []).map(f => f.name).join('; ')}
` : '';

  // Build frame content for vision API
  const frameContent = frames.map(f => ({
    type:      'image_url',
    image_url: { url: `data:image/jpeg;base64,${f.base64}`, detail: 'low' },
  }));

  const hasFrames   = frames.length > 0;
  const hasTranscript = transcript.length > 0;
  const dataNote = !hasFrames && !hasTranscript
    ? '\n⚠️ לא עלה חומר ויזואלי ואודיו — ניתוח מוגבל.'
    : !hasFrames ? '\n⚠️ ללא פריימים — ניתוח מבוסס שמע בלבד.'
    : !hasTranscript ? '\n⚠️ ללא תמלול — ניתוח מבוסס ויזואלי בלבד.'
    : '';

  const systemMsg = `אתה דנה, מנהלת התוכן הדיגיטלי של Shape Studio.
אתה מנתחת סרטוני אינסטגרם לפני פרסום ומייצרת ביקורת מקצועית ואמינה.

${DANA_PROMPT}

כלל עמוד עמוד:
- אל תמציאי נתונים שאינם בסרטון (מחירים, עדויות, ציטוטים).
- אל תציגי "לא נבדק" כציון אפס — סמני קטגוריה שלא ניתן לבדוק כ"לא נבדק".
- ציונים מבוססים רק על חומר שנראה/נשמע — לא על הנחות.
- הגבלות ניתוח: ${dataNote || 'ניתוח מלא (פריימים + שמע)'}`;

  const userMsg = [
    `נתחי את הסרטון הבא לפני פרסום. הפריימים מחולקים לאורך הסרטון.${dataNote}`,
    '',
    contextBlock,
    prevBlock,
    '',
    'החזירי JSON תקין בלבד (ללא טקסט מחוץ ל-JSON) במבנה הבא:',
    JSON.stringify({
      perceived_message: 'מה דנה מבינה שהסרטון מנסה להעביר (1-2 משפטים)',
      message_lands: true,
      recommendation: 'מוכן לפרסום | דורש תיקונים קלים | דורש עריכה משמעותית',
      strengths: ['חוזקה 1 עם ראיה', 'חוזקה 2', 'חוזקה 3'],
      problems: ['בעיה 1 עם הסבר', 'בעיה 2', 'בעיה 3'],
      sections: {
        hook:     { finding: 'ממצא', score: 0, max: 10 },
        message:  { finding: '', score: 0, max: 10 },
        content:  { finding: '', score: 0, max: 10 },
        editing:  { finding: '', score: 0, max: 10 },
        captions: { finding: '', score: 0, max: 10 },
        audio:    { finding: '', score: 0, max: 10, unverified: false },
        visuals:  { finding: '', score: 0, max: 10 },
        cta:      { finding: '', score: 0, max: 10 },
        platform: { finding: '', score: 0, max: 10 },
      },
      timestamps: [
        { range: '0:00-0:03', observation: '', works: '', problem: '', suggestion: '' },
      ],
      mosseri_scores: { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, C6: 0, C7: 0 },
      mosseri_flags: [],
      mosseri_reasonings: { C1: '', C2: '', C3: '', C4: '', C5: '', C6: '', C7: '' },
      mosseri_strengths: [],
      mosseri_fixes: [],
      improvements_must: ['חובה לפני פרסום — מה ולמה'],
      improvements_recommended: ['שיפור מומלץ'],
      improvements_experiments: ['ניסוי לגרסה נוספת'],
      hook_alternatives: ['הוק חלופי 1', 'הוק חלופי 2', 'הוק חלופי 3'],
      cta_options: ['CTA אפשרות 1', 'CTA אפשרות 2'],
      edit_plan: [{ order: 1, segment: 'תיאור קטע', duration: '0:00-0:00' }],
      analysis_limitations: [],
      comparison: prevReport ? {
        improved: ['מה השתפר'],
        still_needs_work: ['מה עדיין דורש עבודה'],
        new_issues: ['בעיות שנוספו'],
        score_change: 0,
      } : null,
    }, null, 2),
  ].join('\n');

  let gptData;
  try {
    const messages = [
      { role: 'system', content: systemMsg },
      {
        role:    'user',
        content: hasFrames
          ? [{ type: 'text', text: userMsg }, ...frameContent]
          : userMsg,
      },
    ];

    const completion = await openai.chat.completions.create({
      model:           'gpt-4o',
      messages,
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

  // ── 7. Mosseri scoring (runs estimate.py) ─────────────────────────────────
  const mosseriScores = gptData.mosseri_scores ?? {};
  const mosseriFlags  = gptData.mosseri_flags  ?? [];
  const mosseriFormat = format === 'feed' ? 'feed' : format === 'trial' ? 'trial' : format;
  const estimation    = runEstimate(mosseriScores, mosseriFlags, mosseriFormat);

  // ── 8. Build category scores (1-100 scale) ────────────────────────────────
  const sections = gptData.sections ?? {};
  const categoryScores = {
    hook:     sections.hook?.score     ?? null,
    message:  sections.message?.score  ?? null,
    content:  sections.content?.score  ?? null,
    editing:  sections.editing?.score  ?? null,
    captions: sections.captions?.score ?? null,
    audio:    sections.audio?.unverified ? null : (sections.audio?.score ?? null),
    visuals:  sections.visuals?.score  ?? null,
    cta:      sections.cta?.score      ?? null,
    platform: sections.platform?.score ?? null,
  };

  // ── 9. Enrich Mosseri fixes with doctrine citations ───────────────────────
  const citeMap = getCitations();
  const fixes = (gptData.mosseri_fixes ?? []).map(fix => ({
    ...fix,
    citation: fix.principleCode ? (citeMap[fix.principleCode] ?? null) : null,
  }));

  // ── 10. Build timestamps list (verify against duration) ──────────────────
  const timestamps = (gptData.timestamps ?? []).map(t => ({
    ...t,
    approximate: !hasFrames,
  }));

  // ── 11. Assemble report ───────────────────────────────────────────────────
  const warnings = [...frameWarnings, ...audioWarnings, ...(gptData.analysis_limitations ?? [])];

  const report = {
    id,
    title,
    createdAt:        new Date().toISOString(),
    version:          previousVersionId ? ((videoSvc.loadReport(previousVersionId)?.version ?? 1) + 1) : 1,
    previousVersionId: previousVersionId ?? null,
    format,
    goal,
    audience,
    organic_or_paid,
    message,
    focus_notes,

    // Mosseri framework
    readiness:        estimation.readiness,
    verdict:          estimation.verdict,
    share_direction:  estimation.share_direction ?? null,
    accuracy:         estimation.accuracy ?? null,
    mosseri_scores:   mosseriScores,
    mosseri_flags:    mosseriFlags,
    flags:            mosseriFlags,
    strengths:        gptData.mosseri_strengths ?? gptData.strengths ?? [],
    fixes,
    reasonings:       gptData.mosseri_reasonings ?? {},

    // Detailed review
    perceived_message: gptData.perceived_message ?? '',
    message_lands:     gptData.message_lands ?? null,
    recommendation:    gptData.recommendation ?? '',
    report_strengths:  gptData.strengths ?? [],
    report_problems:   gptData.problems   ?? [],
    sections,
    category_scores:   categoryScores,
    timestamps,
    improvements_must:         gptData.improvements_must         ?? [],
    improvements_recommended:  gptData.improvements_recommended  ?? [],
    improvements_experiments:  gptData.improvements_experiments  ?? [],
    hook_alternatives:         gptData.hook_alternatives         ?? [],
    cta_options:               gptData.cta_options               ?? [],
    edit_plan:                 gptData.edit_plan                 ?? [],

    // Version comparison
    comparison: gptData.comparison ?? null,

    // Meta
    videoMeta:  { durationSec: meta.durationSec, width: meta.width, height: meta.height },
    frameCount: frames.length,
    hasTranscript: transcript.length > 0,
    transcript: transcript.slice(0, 2000),
    warnings,
  };

  // ── 12. Persist ───────────────────────────────────────────────────────────
  videoSvc.saveReport(id, report);

  store.logEvent('video_analysis', null, {
    id,
    title,
    format,
    goal,
    readiness: estimation.readiness,
    verdict:   estimation.verdict,
    version:   report.version,
  });

  logger.info('[dana] analyzeVideoFile complete', {
    id,
    readiness: estimation.readiness,
    verdict:   estimation.verdict,
    warnings:  warnings.length,
  });

  return report;
}

module.exports = { chat, generateContentPack, generateAdCopy, analyzeVideo, analyzeVideoFile, clearHistory,
  getVideoHistory: () => videoSvc.listReports(),
  getVideoReport:  (id) => videoSvc.loadReport(id),
};
