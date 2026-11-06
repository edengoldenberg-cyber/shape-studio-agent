require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const logger = require('../utils/logger');
const store  = require('../utils/lead_store');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BUSINESS_CONTEXT = fs.readFileSync(
  path.join(__dirname, '../prompts/business_context.md'), 'utf8'
);
const MANAGER_PROMPT = BUSINESS_CONTEXT + '\n\n---\n\n' + fs.readFileSync(
  path.join(__dirname, '../prompts/manager_prompt.md'), 'utf8'
);

// Conversation history for the manager session (single operator, not per-lead)
let managerHistory = [];

/**
 * Send a message to Maya and get an operational response.
 * Injects a live pipeline snapshot before every call so Maya always has fresh data.
 */
async function chat(userMessage) {
  const snapshot = buildSnapshot();

  managerHistory.push({ role: 'user', content: userMessage });

  const messages = [
    { role: 'system',  content: MANAGER_PROMPT },
    { role: 'system',  content: snapshot },       // live data — injected every turn
    ...managerHistory,
  ];

  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages,
      temperature: 0.4,    // lower than lead agent — Maya should be precise, not creative
      max_tokens:  500,
    });
    reply = completion.choices[0].message.content.trim();
  } catch (err) {
    logger.error('OpenAI error in manager_agent', { error: err.message });
    reply = 'Technical issue connecting to AI — check your OPENAI_API_KEY.';
  }

  managerHistory.push({ role: 'assistant', content: reply });
  managerHistory = managerHistory.slice(-30); // keep last 30 turns

  return reply;
}

/**
 * Build a structured plain-text snapshot of current pipeline state.
 * Injected as a system message so Maya has fresh data on every response.
 */
function buildSnapshot() {
  const stats  = store.getDailyStats();
  const health = store.getSystemHealth();
  const hot    = store.getHotLeads();
  const warm   = store.getWarmLeads();
  const cold   = store.getColdLeads();
  const crisis = store.getCrisisLeads();

  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

  const fmtLead = (l) => {
    const age    = timeSince(l.lastActivity);
    const offer  = l.introOfferSent ? ' [intro offer sent]' : '';
    return `  • ${l.name ?? l.phone} | score ${l.score}/10${offer} | last active ${age}`;
  };

  const lines = [
    `## Live Pipeline Snapshot — ${now}`,
    '',
    '### Daily Stats',
    `- New leads today: ${stats.newLeadsToday}`,
    `- Messages in: ${stats.messagesIn} | out: ${stats.messagesOut}`,
    `- Intro offers sent today: ${stats.introOffersSent}`,
    `- Crises today: ${stats.crisesToday}`,
    `- Total leads in system: ${stats.totalLeads}`,
    '',
    `### Pipeline Breakdown`,
    `- 🔥 Hot (8–10): ${stats.hotLeadsTotal} leads`,
    ...hot.map(fmtLead),
    `- 🌡 Warm (5–7): ${stats.warmLeadsTotal} leads`,
    ...warm.map(fmtLead),
    `- ❄️ Cold (1–4): ${stats.coldLeadsTotal} leads`,
    ...cold.map(fmtLead),
  ];

  if (crisis.length > 0) {
    lines.push('', `### 🚨 Active Crisis Leads (${crisis.length})`);
    for (const l of crisis) {
      const age = timeSince(l.lastActivity);
      lines.push(`  • ${l.name ?? l.phone} | last active ${age} | AWAITING HUMAN FOLLOW-UP`);
    }
  }

  lines.push(
    '',
    '### System Health',
    `- Status: ${health.status}`,
    `- Average lead score: ${health.avgScore}/10`,
    `- Last event: ${health.lastEventAt ? timeSince(health.lastEventAt) + ' ago' : 'none'}`,
  );

  return lines.join('\n');
}

function timeSince(date) {
  if (!date) return 'unknown';
  const secs = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400)return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** Clear the manager conversation history (used by /clear in test_manager.js). */
function clearHistory() {
  managerHistory = [];
}

module.exports = { chat, clearHistory };
