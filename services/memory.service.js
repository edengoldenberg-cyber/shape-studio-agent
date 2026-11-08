'use strict';

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const logger = require('../utils/logger');

const openai        = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PROFILES_PATH = path.join(__dirname, '../data/lead_profiles.json');

// ─── Persistence helpers ───────────────────────────────────────────────────────

function _loadAll() {
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); }
  catch { return {}; }
}

function _saveAll(map) {
  const tmp = PROFILES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, PROFILES_PATH);
}

// ─── Blank profile factory ─────────────────────────────────────────────────────

function _blank(phone) {
  const now = new Date().toISOString();
  return {
    phone,
    firstContact:  now,
    lastContact:   null,  // set at session END, not start — so daysSince stays accurate
    lastUpdated:   now,
    sessionCount:  0,
    language:      'he',   // 'he' | 'ar' | 'mixed'
    profile: {
      location:            null,
      fitnessGoal:         null,
      emotionalMotivation: null,
      fitnessHistory:      null,
      schedulePreference:  null,
      commitmentSignal:    null,
    },
    salesState: {
      stage:              'cold',  // 'cold' | 'warming' | 'hot' | 'callback_scheduled' | 'lost'
      callbackTime:       null,
      pricingSensitivity: 'none',  // 'none' | 'mild' | 'strong'
      objectionsRaised:   [],
      bestHook:           null,
    },
    sessionSummaries: [],
    reEngagementHook: null,
  };
}

// ─── Public read/write ─────────────────────────────────────────────────────────

function loadProfile(phone) {
  return _loadAll()[phone] ?? null;
}

function saveProfile(phone, updates) {
  const all      = _loadAll();
  const existing = all[phone] ?? _blank(phone);
  all[phone]     = { ...existing, ...updates, lastUpdated: new Date().toISOString() };
  _saveAll(all);
  return all[phone];
}

/**
 * Increment session count at the START of a new conversation (completedTurns === 0).
 * Does NOT touch lastContact — that is updated at session END so daysSince stays accurate.
 */
function touchSession(phone) {
  const all = _loadAll();
  const rec = all[phone] ?? _blank(phone);
  all[phone] = { ...rec, sessionCount: (rec.sessionCount ?? 0) + 1 };
  _saveAll(all);
}

/**
 * How many full days since the lead last completed a session.
 * Returns Infinity for brand-new leads (no lastContact yet).
 */
function daysSinceLastContact(phone) {
  const rec = loadProfile(phone);
  if (!rec?.lastContact) return Infinity;
  return Math.floor((Date.now() - new Date(rec.lastContact).getTime()) / 86_400_000);
}

// ─── Memory injection ──────────────────────────────────────────────────────────

/**
 * Build the [LEAD_PROFILE] block to prepend to the stage-context system prompt
 * for returning leads. Returns null for new leads or contacts < 3 days ago.
 *
 * @param {string} phone
 * @param {object} [qualData] - live in-session qualData (confirmed name, etc.)
 * @returns {string|null}
 */
function buildMemoryInjection(phone, qualData = {}) {
  const days    = daysSinceLastContact(phone);
  const profile = loadProfile(phone);
  if (!profile || days === Infinity || days < 3) return null;

  const p       = profile.profile   ?? {};
  const ss      = profile.salesState ?? {};
  const lastSum = (profile.sessionSummaries ?? []).at(-1) ?? null;

  const lines = [
    `---`,
    `[LEAD_PROFILE — RETURNING LEAD, ${days} days since last session]`,
    ``,
    qualData.confirmedName          ? `Confirmed name: ${qualData.confirmedName}` : null,
    p.location                      ? `Location: ${p.location}` : null,
    p.fitnessGoal                   ? `Primary goal: ${p.fitnessGoal}` : null,
    p.emotionalMotivation           ? `Deeper motivation: ${p.emotionalMotivation}` : null,
    p.fitnessHistory                ? `Fitness background: ${p.fitnessHistory}` : null,
    ss.pricingSensitivity && ss.pricingSensitivity !== 'none'
      ? `Pricing sensitivity: ${ss.pricingSensitivity}` : null,
    ss.objectionsRaised?.length
      ? `Past objections: ${ss.objectionsRaised.join(', ')}` : null,
    ss.stage ? `Sales stage reached: ${ss.stage}` : null,
    lastSum?.summary           ? `Last session summary: ${lastSum.summary}` : null,
    lastSum?.lastLeadMessage   ? `Last lead message: "${lastSum.lastLeadMessage}"` : null,
    profile.reEngagementHook   ? `Suggested hook: ${profile.reEngagementHook}` : null,
    ``,
    _reEngagementInstruction(days, p),
    `---`,
  ].filter(l => l !== null).join('\n');

  return lines;
}

function _reEngagementInstruction(days, p) {
  const goal = p.fitnessGoal ?? p.emotionalMotivation;

  if (days <= 14 && goal) {
    return [
      `RE-ENGAGEMENT RULE:`,
      `Reference ONE thing from their past naturally in your FIRST reply.`,
      `✓ Good: "היי! נזכרתי שדיברנו על ${goal} — עוד חשבת על זה?"`,
      `✗ Bad: "לפי הרשומות שלי..." / "מהשיחה האחרונה שלנו..."`,
      `Sound like a person who remembered — not a CRM printout.`,
    ].join('\n');
  }

  if (days <= 60 && goal) {
    return [
      `RE-ENGAGEMENT RULE:`,
      `Acknowledge that time has passed. Plant ONE memory anchor naturally.`,
      `✓ Good: "היי! זמן מה עבר. עוד רלוונטי בשבילך ${goal}?"`,
    ].join('\n');
  }

  return goal
    ? `RE-ENGAGEMENT RULE: Treat mostly as a new lead. If conversation warms up, you may reference "${goal}" naturally once.`
    : `RE-ENGAGEMENT RULE: Treat as a new lead — no strong past context to reference.`;
}

// ─── Session summary generation ────────────────────────────────────────────────

/**
 * Generate a 2-sentence Hebrew summary of the session using OpenAI mini,
 * then upsert it into the lead's persistent profile file.
 *
 * Always call fire-and-forget:
 *   generateAndSaveSessionSummary(...).catch(err => logger.warn(...))
 *
 * @param {string} phone
 * @param {Array}  history  - [{role, content}]
 * @param {object} qualData - final in-session qualData from lead_store
 */
async function generateAndSaveSessionSummary(phone, history, qualData = {}) {
  if (!history?.length) return;

  const transcript = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? 'Lead' : 'Barak'}: ${m.content}`)
    .join('\n');

  const lastLeadMsg = history.filter(m => m.role === 'user').at(-1)?.content?.slice(0, 200) ?? null;

  let summary;
  try {
    const res = await openai.chat.completions.create({
      model:       process.env.OPENAI_BRIEF_MODEL ?? 'gpt-4o-mini',
      temperature: 0,
      max_tokens:  120,
      messages: [
        {
          role:    'system',
          content: 'סכם שיחה זו עם ליד ב-2 משפטים. כלול: מטרת הכושר, התנגדויות שהועלו, מיקום, ומצב החלטה. בעברית בלבד. פלט: הסיכום בלבד.',
        },
        { role: 'user', content: `שיחה:\n${transcript}` },
      ],
    });
    summary = res.choices[0].message.content.trim();
  } catch (err) {
    logger.warn('[memory] Summary generation failed — using heuristic', { phone, error: err.message });
    summary = _heuristicSummary(qualData);
  }

  const rec        = loadProfile(phone) ?? _blank(phone);
  const objections = [];
  if (qualData.pricingObjection) objections.push('price');
  if (qualData.locationCheckNeeded && qualData.locationViable !== true) objections.push('distance');

  const priceSens = qualData.pricingObjection ? 'strong'
    : qualData.pricingAsked                   ? 'mild'
    : rec.salesState.pricingSensitivity;

  saveProfile(phone, {
    lastContact: new Date().toISOString(),   // update at session END
    language: qualData.dialect === 'arabic_script' ? 'ar'
            : qualData.dialect === 'arabic_hebrew'  ? 'mixed'
            : rec.language,
    profile: {
      ...rec.profile,
      location:          qualData.location         ?? rec.profile.location,
      fitnessGoal:       qualData.goal             ?? qualData.fitnessInterest ?? rec.profile.fitnessGoal,
      fitnessHistory:    qualData.workoutStyle      ?? rec.profile.fitnessHistory,
    },
    salesState: {
      ...rec.salesState,
      stage:              _inferStage(qualData),
      callbackTime:       qualData.callTimeGiven   ?? rec.salesState.callbackTime,
      pricingSensitivity: priceSens,
      objectionsRaised:   [...new Set([...(rec.salesState.objectionsRaised ?? []), ...objections])],
    },
    sessionSummaries: [
      ...(rec.sessionSummaries ?? []).slice(-4),  // keep last 5
      {
        date:            new Date().toISOString(),
        summary,
        sentiment:       _inferSentiment(qualData),
        lastLeadMessage: lastLeadMsg,
      },
    ],
    reEngagementHook: _buildHook(qualData, rec),
  });

  logger.info('[memory] Session summary saved', { phone, preview: summary?.slice(0, 70) });
}

function _heuristicSummary(qd) {
  const parts = [];
  if (qd.goal ?? qd.fitnessInterest) parts.push(`ציין/ה ${qd.goal ?? qd.fitnessInterest}`);
  if (qd.pricingObjection)           parts.push('העלה/ה שאלת מחיר');
  if (qd.callTimeGiven)              parts.push(`קבע/ה שיחה: ${qd.callTimeGiven}`);
  else                               parts.push('לא סיכמ/ה שיחה');
  return parts.join('. ') || 'שיחה קצרה.';
}

function _inferSentiment(qd) {
  if (qd.callTimeGiven)            return 'positive';
  if (qd.locationViable === false) return 'closed';
  if (qd.pricingObjection)         return 'cautious';
  return 'neutral';
}

function _inferStage(qd) {
  if (qd.callTimeGiven)              return 'callback_scheduled';
  if (qd.callProposed)               return 'hot';
  if (qd.goal || qd.fitnessInterest) return 'warming';
  return 'cold';
}

function _buildHook(qd, rec) {
  const goal = qd.goal ?? qd.fitnessInterest ?? rec.profile?.fitnessGoal;
  return goal ? `פעם אחרונה דיברנו על ${goal}` : rec.reEngagementHook;
}

module.exports = {
  loadProfile,
  saveProfile,
  touchSession,
  daysSinceLastContact,
  buildMemoryInjection,
  generateAndSaveSessionSummary,
};
