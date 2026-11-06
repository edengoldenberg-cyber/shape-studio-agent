require('dotenv').config();
const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { execFileSync } = require('child_process');
const OpenAI         = require('openai');
const logger         = require('../utils/logger');
const store          = require('../utils/lead_store');

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

module.exports = { chat, generateContentPack, generateAdCopy, analyzeVideo, clearHistory };
