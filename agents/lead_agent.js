require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const OpenAI  = require('openai');
const logger  = require('../utils/logger');
const store   = require('../utils/lead_store');
const { sendText, alertOwner } = require('../services/whatsapp.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/system_prompt.md'),
  'utf8'
);

// In-memory sessions Map replaced by shared lead_store singleton (see utils/lead_store.js)

// Crisis detection — any match halts automation and alerts the owner
const CRISIS_PATTERNS = [
  // Physical
  /\b(injury|injured|pain|hurt|pulled|sprained|fell|doctor|hospital|blood)\b/i,
  // Emotional / angry
  /\b(angry|furious|disgusted|scam|lawyer|lawsuit|complaint|awful|terrible)\b/i,
  /\bpost (about|this|it)\b/i,
  // Churn
  /\b(cancel\s*(my\s*)?(membership|subscription)|leaving|quitting|done with|refund|money back)\b/i,
  // Distress
  /\b(help me|emergency|I can't|struggling|upset)\b/i,
];


/**
 * Main entry point — handle an inbound WhatsApp message for lead qualification.
 */
async function handleInbound({ from, name, text }) {
  // Log the inbound message
  store.logEvent('message_in', from, { name, preview: text.slice(0, 80) });
  store.upsertLead(from, {
    name: name ?? store.getLead(from)?.name,
    messageCount: (store.getLead(from)?.messageCount ?? 0) + 1,
  });

  // 1. Crisis check — always runs first
  const crisis = detectCrisis(text);
  if (crisis) {
    logger.warn('Crisis keyword detected', { from, category: crisis });
    store.upsertLead(from, { status: 'crisis' });
    store.logEvent('crisis', from, { category: crisis, message: text.slice(0, 120) });
    await sendText(from, crisisAcknowledgement(name));
    await alertOwner(
      `⚠️ Crisis / Escalation Required`,
      `*Contact:* ${name ?? from}\n*Phone:* ${from}\n*Category:* ${crisis}\n*Message:* "${text}"`
    );
    clearSession(from);
    return;
  }

  // 2. Build or retrieve conversation history
  const history    = getHistory(from);
  const msgCount   = store.getLead(from)?.messageCount ?? 0;

  if (history.length === 0 && name) {
    // First message — give the AI the lead's name and behavioral constraints
    history.push({
      role: 'system',
      content:
        `Lead name: ${name}. Phone: ${from}.\n` +
        `STRICT RULES for this conversation:\n` +
        `1. Never start a message with the person's name. Use it at most once every 4-5 messages — only mid-sentence, never as an opener.\n` +
        `2. This is message #${msgCount + 1} in the thread. The name count so far: 0. Enforce the 1-per-5 limit.\n` +
        `3. Answer questions directly. Do not pivot to the trial offer until at least 2 exchanges have happened.\n` +
        `4. If the user asks about pricing twice, give a bracket (350–400 NIS/month) and do not repeat the trial offer.`,
    });
  } else if (msgCount > 0 && msgCount % 5 === 0) {
    // Every 5 messages remind the AI of the name constraint so it doesn't drift
    history.push({
      role: 'system',
      content: `Reminder: you are on message #${msgCount + 1}. Do not start the next reply with the person's name.`,
    });
  }

  history.push({ role: 'user', content: text });

  // 3. Generate AI reply
  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
      ],
      temperature: 0.7,
      max_tokens: 300,
    });
    reply = completion.choices[0].message.content.trim();
    history.push({ role: 'assistant', content: reply });
    saveHistory(from, history);
  } catch (err) {
    logger.error('OpenAI error in lead_agent', { error: err.message });
    reply = `שלום! נתקלנו בתקלה טכנית קטנה. הצוות שלנו יחזור אליך בהקדם 🙏`;
  }

  // 4. Score the lead silently (logged, not sent)
  const score  = scoreLeadFromHistory(history);
  const status = score >= 8 ? 'hot' : score >= 5 ? 'warm' : 'cold';
  store.upsertLead(from, { score, status });
  store.logEvent('score_update', from, { score, status });
  logger.info('Lead score', { from, score });

  // 5. Send reply
  await sendText(from, reply);
  store.logEvent('message_out', from, { preview: reply.slice(0, 80) });

  // 6. If hot lead and we haven't pushed the intro offer yet — inject it
  if (score >= 8 && !sessionMeta(from).introOfferSent) {
    await sendIntroOffer(from, name);
    setSessionMeta(from, 'introOfferSent', true);
    store.upsertLead(from, { introOfferSent: true });
    store.logEvent('intro_offer_sent', from, {});
  }
}

/**
 * Heuristic lead scorer — runs over the full conversation history.
 * Returns 1–10. Internal only, never exposed to the lead.
 */
function scoreLeadFromHistory(history) {
  const fullText = history.map((m) => m.content).join(' ').toLowerCase();
  let score = 4; // baseline

  // Positive signals
  if (/\b(want to start|ready to|sign up|join|membership|register)\b/.test(fullText)) score += 3;
  if (/\b(trial|intro|try it|check it out|visit)\b/.test(fullText)) score += 2;
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|evening|after work|weekend)\b/.test(fullText)) score += 1;
  if (/\b(goal|lose weight|get fit|build strength|tone|pilates|yoga|cardio)\b/.test(fullText)) score += 1;
  if (history.filter((m) => m.role === 'user').length >= 3) score += 1; // engaged in multi-turn

  // Negative signals
  if (/\bprice\b.*\?/.test(fullText) && history.filter((m) => m.role === 'user').length <= 1) score -= 2;
  if (/\bjust (checking|looking|browsing)\b/.test(fullText)) score -= 2;

  return Math.max(1, Math.min(10, score));
}

async function sendIntroOffer(to, name) {
  const firstName = name?.split(' ')[0] ?? 'שלום';
  const message =
    `${firstName}, אם תרצה/י לנסות — יש לנו הצעת היכרות למצטרפים חדשים.\n\n` +
    `*2 אימונים לבחירה ב-60 ש״ח.* בלי התחייבות, פשוט תרגיש/י מה המקום נותן ותחליט/י.\n\n` +
    `מעניין אותך? 💪`;
  await sendText(to, message);
}

function detectCrisis(text) {
  for (const pattern of CRISIS_PATTERNS) {
    if (pattern.test(text)) return pattern.source.includes('cancel') ? 'churn' :
                                   pattern.source.includes('angry') ? 'emotional' :
                                   pattern.source.includes('injury') ? 'physical' : 'distress';
  }
  return null;
}

function crisisAcknowledgement(name) {
  const firstName = name?.split(' ')[0] ?? 'there';
  return (
    `${firstName}, I hear you and this matters to us deeply. ` +
    `I want to make sure you get direct support right away — ` +
    `our team is being notified now and will reach out to you personally very shortly. ` +
    `Thank you for telling us 🙏`
  );
}

// Session helpers — backed by the shared lead_store singleton
function getHistory(phone) {
  const lead = store.getLead(phone);
  if (!lead) store.upsertLead(phone, {});
  return store.getLead(phone).history;
}
function saveHistory(phone, history) {
  store.upsertLead(phone, { history: history.slice(-20) });
}
function sessionMeta(phone) {
  const lead = store.getLead(phone);
  if (!lead) store.upsertLead(phone, {});
  return store.getLead(phone).meta;
}
function setSessionMeta(phone, key, value) {
  const lead = store.getLead(phone);
  const meta = { ...(lead?.meta ?? {}), [key]: value };
  store.upsertLead(phone, { meta });
}
function clearSession(phone) {
  store.deleteLead(phone);
}

module.exports = { handleInbound, clearSession };
