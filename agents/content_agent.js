require('dotenv').config();
const OpenAI = require('openai');
const logger = require('../utils/logger');
const { alertOwner } = require('../services/whatsapp.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STUDIO_CLASSES = [
  'Strength Training',
  'Reformer Pilates',
  'Pilates Barre',
  'ALL IN (functional / CrossFit-inspired)',
  'Concept Toning / Sculpt',
  'Ashtanga Yoga',
  'Kangoo Jumps',
];

const CONTENT_SYSTEM = `
You are a social media content strategist for Shape Studio, a premium boutique fitness studio in Pardes Hanna-Karkur, Israel.
Target audience: adults 30–60, predominantly women, who want real transformation in a luxurious, supportive community.
Brand tone: energetic, professional, warm, luxurious. Moderate emojis.
Platform: Instagram (Reels + Stories).
Language: Hebrew. Keep it natural and conversational — not robotic.
`.trim();

/**
 * Generate a bi-weekly content pack: 1 story idea, 1 reel idea, 1 caption.
 * Sends the result to the studio owner via WhatsApp.
 */
async function generateAndSendContentPack() {
  const focusClass = pickRandom(STUDIO_CLASSES);
  logger.info('Generating content pack', { focusClass });

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages: [
        { role: 'system', content: CONTENT_SYSTEM },
        {
          role: 'user',
          content:
            `Create a bi-weekly Instagram content pack for Shape Studio focused on: *${focusClass}*.\n\n` +
            `Return EXACTLY this structure (in Hebrew):\n\n` +
            `📸 STORY IDEA:\n[behind-the-scenes or member-spotlight concept — 2–3 sentences]\n\n` +
            `🎬 REEL IDEA:\n[trending format applied to the class — include hook line, structure, and CTA]\n\n` +
            `✍️ CAPTION SUGGESTION:\n[Instagram caption, 3–5 lines, matching brand tone, with relevant hashtags]`,
        },
      ],
      temperature: 0.85,
      max_tokens: 600,
    });

    const pack = completion.choices[0].message.content.trim();
    const message =
      `🗓️ *תוכן דו-שבועי — Shape Studio*\n` +
      `*פוקוס:* ${focusClass}\n\n` +
      `${pack}\n\n` +
      `_אלה רעיונות בלבד — אתה מחליטה מה מפרסמים 😊_`;

    await alertOwner('תוכן דו-שבועי מוכן', message);
    logger.info('Content pack sent to owner');
  } catch (err) {
    logger.error('Content agent generation failed', { error: err.message });
  }
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

module.exports = { generateAndSendContentPack };
