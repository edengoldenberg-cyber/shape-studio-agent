require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const logger = require('../utils/logger');
const store  = require('../utils/lead_store');
const { sendText } = require('../services/whatsapp.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BUSINESS_CONTEXT = fs.readFileSync(
  path.join(__dirname, '../prompts/business_context.md'), 'utf8'
);
const TOMER_PROMPT = BUSINESS_CONTEXT + '\n\n---\n\n' + fs.readFileSync(
  path.join(__dirname, '../prompts/tomer_prompt.md'), 'utf8'
);

let tomerHistory = [];

// ── Chat interface ─────────────────────────────────────────────────────────────

async function chat(userMessage) {
  const context = buildContext();
  tomerHistory.push({ role: 'user', content: userMessage });

  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:    [
        { role: 'system', content: TOMER_PROMPT },
        { role: 'system', content: context },
        ...tomerHistory,
      ],
      temperature: 0.6,
      max_tokens:  500,
    });
    reply = completion.choices[0].message.content.trim();
  } catch (err) {
    logger.error('OpenAI error in tomer_agent', { error: err.message });
    reply = 'שגיאה טכנית. בדוק את מפתח ה-OPENAI_API_KEY.';
  }

  tomerHistory.push({ role: 'assistant', content: reply });
  tomerHistory = tomerHistory.slice(-30);
  return reply;
}

// ── Daily re-engagement checks ────────────────────────────────────────────────

/**
 * Run Tomer's daily re-engagement pass over all leads in the store.
 * Sends WhatsApp messages to leads who are dormant or have unredeemed intro offers.
 * Returns a summary object.
 */
async function runDailyChecks() {
  const leads  = store.getAllLeads();
  const result = { reEngaged: 0, introFollowUps: 0, skipped: 0, errors: 0 };

  for (const lead of leads) {
    try {
      if (lead.status === 'crisis')             { result.skipped++; continue; }
      if (!lead.phone)                          { result.skipped++; continue; }

      const dormantDays    = daysSince(lead.lastActivity);
      const lastEngDays    = daysSince(lead.lastReEngagementAt);
      const firstName      = (lead.name ?? '').split(' ')[0] || 'שלום';

      // ── Re-engagement sequence ───────────────────────────────────────────
      if (lead.status !== 'hot') {
        if (dormantDays >= 3 && lead.reEngagementCount === 0) {
          await sendReEngagement(lead.phone, firstName, 1);
          bumpReEngagement(lead.phone);
          result.reEngaged++;
          continue;
        }
        if (dormantDays >= 7 && lead.reEngagementCount === 1 && lastEngDays >= 3) {
          await sendReEngagement(lead.phone, firstName, 2);
          bumpReEngagement(lead.phone);
          result.reEngaged++;
          continue;
        }
        if (dormantDays >= 14 && lead.reEngagementCount === 2 && lastEngDays >= 5) {
          await sendReEngagement(lead.phone, firstName, 3);
          bumpReEngagement(lead.phone);
          result.reEngaged++;
          continue;
        }
      }

      // ── Intro offer follow-up (sent but not redeemed after 2 days) ───────
      if (lead.introOfferSent && !lead.introOfferRedeemed && dormantDays >= 2 && lead.reEngagementCount === 0) {
        await sendIntroFollowUp(lead.phone, firstName);
        bumpReEngagement(lead.phone);
        result.introFollowUps++;
        continue;
      }

      result.skipped++;
    } catch (err) {
      logger.error('Tomer daily check error', { phone: lead.phone, error: err.message });
      result.errors++;
    }
  }

  logger.info('Tomer daily checks complete', result);
  return result;
}

// ── Message senders ───────────────────────────────────────────────────────────

async function sendReEngagement(phone, firstName, touchNumber) {
  const messages = {
    1: `${firstName}, שלום! 😊 קצת שקט מצידך — רציתי לבדוק שהכל בסדר. אנחנו פה ב-Shape Studio עם מקום בשיעורים. הגיע הזמן לנסות? 💪`,
    2: `${firstName}, שבוע עבר! אנחנו עדיין פה ועדיין רוצים לראות אותך. אולי שיעור אחר יתאים יותר? ספרי לי מה מעניין אותך ואני אמצא לך זמן. 🧘‍♀️`,
    3: `${firstName}, לא רוצה להעיק — אבל לא אוכל לא לשאול 🙂 אם עדיין מתלבטת, אשמח לענות על שאלות. ואם שינית כיוון — אין בעיה. תמיד מוזמנת. 🙏`,
  };
  await sendText(phone, messages[touchNumber] ?? messages[1]);
  store.logEvent('re_engagement_sent', phone, { touchNumber });
  logger.info('Re-engagement sent', { phone, touchNumber });
}

async function sendIntroFollowUp(phone, firstName) {
  const msg = `${firstName}, שלחנו לך לאחרונה הצעת היכרות מיוחדת — 2 אימונים ב-60 ש״ח. עדיין תקפה! רוצה לקבוע? 🎯`;
  await sendText(phone, msg);
  store.logEvent('re_engagement_sent', phone, { type: 'intro_followup' });
  logger.info('Intro offer follow-up sent', { phone });
}

function bumpReEngagement(phone) {
  const lead = store.getLead(phone);
  store.upsertLead(phone, {
    reEngagementCount:  (lead?.reEngagementCount ?? 0) + 1,
    lastReEngagementAt: new Date(),
  });
}

// ── Context builder for chat ──────────────────────────────────────────────────

function buildContext() {
  const all        = store.getAllLeads();
  const now        = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const stats      = store.getDailyStats();

  const dormant = all.filter(l =>
    l.status !== 'crisis' &&
    daysSince(l.lastActivity) >= 3
  ).sort((a, b) => daysSince(b.lastActivity) - daysSince(a.lastActivity));

  const introNotRedeemed = all.filter(l =>
    l.introOfferSent && !l.introOfferRedeemed
  );

  const fmtLead = (l) => {
    const d    = Math.floor(daysSince(l.lastActivity));
    const reng = l.reEngagementCount > 0 ? ` | re-eng: ${l.reEngagementCount}` : '';
    const intr = l.introOfferSent ? ' | intro-sent' : '';
    return `  • ${l.name ?? l.phone} | score ${l.score}/10 | silent ${d}d${reng}${intr}`;
  };

  return [
    `## תור השימור של תומר — ${now}`,
    '',
    `### לידים רדומים (3+ ימים ללא פעילות) — ${dormant.length}`,
    ...dormant.map(fmtLead),
    '',
    `### הצעת היכרות שנשלחה ולא נוצלה — ${introNotRedeemed.length}`,
    ...introNotRedeemed.map(l => `  • ${l.name ?? l.phone} | score ${l.score}/10 | re-eng: ${l.reEngagementCount}`),
    '',
    '### סטטיסטיקות היום',
    `  - לידים שנוצרו: ${stats.reEngagedToday}`,
    `  - הצעות שנשלחו: ${stats.introOffersSent}`,
    `  - סה"כ לידים רדומים: ${dormant.length}`,
  ].join('\n');
}

// ── Utils ──────────────────────────────────────────────────────────────────────

function daysSince(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / 86400000;
}

function clearHistory() { tomerHistory = []; }

module.exports = { chat, runDailyChecks, clearHistory };
