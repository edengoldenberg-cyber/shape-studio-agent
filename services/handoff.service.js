'use strict';

require('dotenv').config();
const OpenAI = require('openai');
const logger = require('../utils/logger');
const { alertOwner } = require('./whatsapp.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Readiness Scorer ──────────────────────────────────────────────────────────

/**
 * Classify lead readiness as HIGH / MEDIUM / LOW without an LLM call.
 *
 * HIGH:   Gave a specific callback time; asked about start date / how to sign up;
 *         mentioned a personal deadline; asked logistical details (parking, duration).
 *
 * MEDIUM: Engaged positively but raised one objection; asked about price and continued;
 *         said "מעניין" or similar; took multiple turns to agree on callback.
 *
 * LOW:    Raised price objection multiple times; vague or reluctant throughout;
 *         explicitly said "just browsing / רק בודק".
 *
 * @param {Array}  history  - [{role, content}]
 * @param {object} qualData - final in-session qualData
 * @returns {{ level: 'HIGH'|'MEDIUM'|'LOW', evidence: string }}
 */
function scoreReadiness(history, qualData = {}) {
  const fullText = history.map(m => m.content).join(' ');

  // ── HIGH signals ────────────────────────────────────────────────────────────
  const highPatterns = [
    /להתחיל.*השבוע|השבוע.*להתחיל|מתי.*להצטרף|איך.*נרשמ|להצטרף/i,
    /לפני.*חתונה|לפני.*קיץ|לפני.*אירוע|לפני.*חג/i,
    /חניה|מה.*ללבוש|מה.*להביא|כמה.*זמן.*שיעור|מתי.*מתחיל/i,
  ];
  const highHits = highPatterns.filter(re => re.test(fullText)).length;

  // ── LOW signals ─────────────────────────────────────────────────────────────
  const lowPatterns = [
    qualData.pricingObjection,
    /רק בודק|רק שואל|רק מסתכל|just browsing/i.test(fullText),
    (!qualData.callTimeGiven && /לא בטוח|לא יודע|אולי|maybe/i.test(fullText)),
  ];
  const lowHits = lowPatterns.filter(Boolean).length;

  // ── Classify ────────────────────────────────────────────────────────────────
  if (qualData.callTimeGiven) {
    return { level: 'HIGH', evidence: 'קבע/ה זמן שיחה ספציפי' };
  }
  if (highHits >= 1) {
    return { level: 'HIGH', evidence: 'הראה/ה סימני מוכנות גבוהה (תאריך התחלה, שאלות לוגיסטיות)' };
  }
  if (lowHits >= 2) {
    return { level: 'LOW', evidence: 'ספקנות חזקה — התנגדות מחיר חוזרת או מעורבות מינימלית' };
  }
  if (qualData.pricingObjection && !qualData.callProposed) {
    return { level: 'LOW', evidence: 'התנגדות מחיר ללא הסכמה על שיחה' };
  }

  const engaged = !!(qualData.goal || qualData.fitnessInterest || qualData.callProposed);
  return {
    level:    engaged ? 'MEDIUM' : 'LOW',
    evidence: engaged ? 'עניין אמיתי עם היסוס קל — עוד לא סגור/ה' : 'מעורבות נמוכה, לא חלק מהפרטים',
  };
}

// ─── Brief Generator ───────────────────────────────────────────────────────────

/**
 * Generate a rich WhatsApp sales hand-off brief and send it to all admin phones.
 *
 * Always call fire-and-forget:
 *   generateHandoffBrief(...).catch(err => logger.warn(...))
 *
 * @param {string} phone
 * @param {string} name      - display name (or phone as fallback)
 * @param {Array}  history   - [{role, content}]
 * @param {object} qualData  - final in-session qualData
 * @returns {Promise<{ briefData: object, readiness: object }>}
 */
async function generateHandoffBrief(phone, name, history, qualData = {}) {
  const transcript = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? 'ליד' : 'בארק'}: ${m.content}`)
    .join('\n');

  const readiness      = scoreReadiness(history, qualData);
  const readinessEmoji = readiness.level === 'HIGH' ? '🔥' : readiness.level === 'MEDIUM' ? '🌡️' : '❄️';

  let briefData;
  try {
    const res = await openai.chat.completions.create({
      model:       process.env.OPENAI_BRIEF_MODEL ?? 'gpt-4o-mini',
      temperature: 0,
      max_tokens:  350,
      messages: [
        {
          role:    'system',
          content: [
            'אתה מכין briefing מכירתי בעברית לצוות סטודיו כושר.',
            'על בסיס השיחה, החזר JSON בלבד (ללא markdown, ללא הסברים):',
            '{',
            '  "location": "עיר/אזור או null",',
            '  "locationMinutes": "מרחק משוער מפרדס חנה בדקות נסיעה, מספר בלבד, או null",',
            '  "primaryGoal": "המטרה הספציפית — לא כושר כללי",',
            '  "deeperMotivation": "ה-WHY הרגשי מאחורי המטרה, או null",',
            '  "objectionsRaised": "ציין התנגדויות שהועלו, או null",',
            '  "bestOpeningLine": "משפט פתיחה ספציפי לשיחה עם הצוות — לכלול פרט אישי מהשיחה",',
            '  "thingToAvoid": "משהו ספציפי שלא לעשות על בסיס רגישות הליד, או null",',
            '  "directQuote": "הציטוט הרגשי העמוק ביותר מהשיחה — מילה במילה, או null"',
            '}',
          ].join('\n'),
        },
        { role: 'user', content: `שיחה:\n${transcript}` },
      ],
    });

    briefData = JSON.parse(res.choices[0].message.content.trim());
  } catch (err) {
    logger.warn('[handoff] Brief LLM failed — using fallback', { phone, error: err.message });
    briefData = {
      location:        qualData.location     ?? null,
      locationMinutes: null,
      primaryGoal:     qualData.goal         ?? qualData.fitnessInterest ?? null,
      deeperMotivation: null,
      objectionsRaised: qualData.pricingObjection ? 'מחיר' : null,
      bestOpeningLine:  qualData.goal
        ? `"ברק סיפר לי על ${qualData.goal} — בדיוק לזה אנחנו מתמחים."`
        : 'פתח/י בחמימות ושאל/י מה הביא אותם ליצור קשר.',
      thingToAvoid:    qualData.pricingObjection ? 'אל תפתח/י עם מחירים — בני ערך קודם' : null,
      directQuote:     null,
    };
  }

  const displayName = (name && name !== phone) ? name : 'לא צוין';
  const callTime    = qualData.callTimeGiven ?? 'לא נקבע';

  const locationLine = briefData.location
    ? `📍 מיקום: ${briefData.location}${briefData.locationMinutes ? ` (~${briefData.locationMinutes} דקות)` : ''}`
    : null;

  const briefLines = [
    `━━━━━━━━━━━━━━━━━━━━━`,
    `📋 ליד חדש — Shape Studio`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `👤 שם: ${displayName}`,
    locationLine,
    `📱 טלפון: ${phone}`,
    `📞 שיחה: ${callTime}`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    briefData.primaryGoal     ? `🎯 מטרה עיקרית:\n${briefData.primaryGoal}` : null,
    briefData.deeperMotivation ? `\n💡 המוטיבציה האמיתית:\n${briefData.deeperMotivation}` : null,
    `\n⚠️ התנגדויות: ${briefData.objectionsRaised ?? 'לא עלו'}`,
    `\n📊 רמת מוכנות: ${readinessEmoji} ${readiness.level}`,
    readiness.evidence,
    `━━━━━━━━━━━━━━━━━━━━━`,
    briefData.bestOpeningLine ? `📢 זווית סגירה מומלצת:\n${briefData.bestOpeningLine}` : null,
    briefData.thingToAvoid    ? `\n🚫 מה לא לעשות:\n${briefData.thingToAvoid}` : null,
    briefData.directQuote
      ? `\n━━━━━━━━━━━━━━━━━━━━━\n💬 ציטוט ישיר:\n"${briefData.directQuote}"`
      : null,
    `\n━━━━━━━━━━━━━━━━━━━━━`,
  ].filter(l => l !== null).join('\n');

  // The caller (reliableHandoffAlert) owns all notification sending through its
  // deduplicated gate. This function only generates content — no alertOwner call.
  logger.info('[handoff] Brief generated', { phone, readiness: readiness.level });

  return { briefData, readiness, briefLines };
}

module.exports = { scoreReadiness, generateHandoffBrief };
