require('dotenv').config();
const cron    = require('node-cron');
const logger  = require('../utils/logger');
const { sendText, alertOwner } = require('../services/whatsapp.service');
const arbox   = require('../services/arbox.service');

// Milestone definitions: key = days after first class
const MILESTONES = [
  { days: 1,  key: 'day1',   buildMessage: day1Message },
  { days: 7,  key: 'week1',  buildMessage: week1Message },
  { days: 14, key: 'week2',  buildMessage: week2Message },
  { days: 30, key: 'month1', buildMessage: month1Message },
];

const ABSENT_THRESHOLD_SESSIONS = 3;  // fewer than 3 check-ins in 14 days
const WIN_BACK_WAIT_HOURS        = 72; // hours before escalating non-response

/**
 * Run the full retention pass for all active members.
 * Called by the cron job in server.js every morning.
 */
async function runDailyRetentionPass(members) {
  for (const member of members) {
    try {
      await processMember(member);
    } catch (err) {
      logger.error('Retention pass failed for member', { memberId: member.id, error: err.message });
    }
  }
}

async function processMember(member) {
  const { id, phone, first_name, first_class_date, retention_flags = {} } = member;
  if (!first_class_date || !phone) return;

  const daysSinceFirst = daysDiff(new Date(first_class_date), new Date());

  // 1. Milestone check-ins
  for (const m of MILESTONES) {
    if (daysSinceFirst === m.days && !retention_flags[m.key]) {
      const message = m.buildMessage(first_name);
      await sendText(phone, message);
      logger.info('Retention milestone sent', { memberId: id, milestone: m.key });
      // Mark as sent in Arbox / your DB (stub — implement persistence as needed)
      member.retention_flags[m.key] = true;
    }
  }

  // 2. Absence detection (check-ins in last 14 days)
  const recentCheckIns = await arbox.getRecentCheckIns(id, 14);
  if (recentCheckIns.length < ABSENT_THRESHOLD_SESSIONS) {
    if (!retention_flags.winBackSent) {
      await sendText(phone, winBackMessage(first_name));
      logger.info('Win-back message sent', { memberId: id, checkIns: recentCheckIns.length });
      member.retention_flags.winBackSent = true;
      member.retention_flags.winBackSentAt = new Date().toISOString();
    } else if (retention_flags.winBackSentAt) {
      // Check if 72h elapsed with no response
      const hoursSinceWinBack = hoursDiff(new Date(retention_flags.winBackSentAt), new Date());
      if (hoursSinceWinBack >= WIN_BACK_WAIT_HOURS && !retention_flags.winBackEscalated) {
        await alertOwner(
          '👋 Member Needs Personal Touch',
          `*Member:* ${first_name}\n*Phone:* ${phone}\n*Check-ins (14d):* ${recentCheckIns.length}\nWin-back message sent ${Math.round(hoursSinceWinBack)}h ago with no response. Please reach out personally.`
        );
        member.retention_flags.winBackEscalated = true;
        logger.info('Win-back escalated to owner', { memberId: id });
      }
    }
  } else {
    // They're back — reset win-back flags
    member.retention_flags.winBackSent      = false;
    member.retention_flags.winBackSentAt    = null;
    member.retention_flags.winBackEscalated = false;
  }
}

// ─── No-show confirmation scheduler ──────────────────────────────────────────

/**
 * Schedule confirmation reminders for a booked class.
 * classTime: Date object of the class start time.
 */
async function scheduleClassReminders(phone, firstName, className, classTime) {
  const minus24h  = new Date(classTime.getTime() - 24 * 60 * 60 * 1000);
  const minus2h   = new Date(classTime.getTime() -  2 * 60 * 60 * 1000);
  const now       = Date.now();

  if (minus24h.getTime() > now) {
    setTimeout(async () => {
      await sendText(phone, reminder24h(firstName, className, classTime));
    }, minus24h.getTime() - now);
  }

  if (minus2h.getTime() > now) {
    setTimeout(async () => {
      await sendText(phone, reminder2h(firstName, className, classTime));
    }, minus2h.getTime() - now);
  }

  logger.info('Class reminders scheduled', { phone, className, classTime });
}

// ─── Message builders ─────────────────────────────────────────────────────────

function day1Message(name) {
  return `Hey ${name}! 🌟 How are you feeling after your first workout at Shape Studio? We'd love to hear about it — what did you think?`;
}

function week1Message(name) {
  return `${name}, one week in! 💪 You should be proud — getting started is the hardest part. How are you feeling? Any class you're especially loving so far?`;
}

function week2Message(name) {
  return `${name}, you've been with us for two weeks and we're already noticing it 🙌 Any classes you want to explore next? We'd love to help you mix it up if you're ready to try something new.`;
}

function month1Message(name) {
  return (
    `${name}, one month at Shape Studio — that's a real milestone and we're genuinely proud of you! 🎉\n\n` +
    `You've built a habit. Now let's talk about taking it further. Our team would love to connect and see how we can support your next chapter here. ` +
    `Want to chat about what's next? 💫`
  );
}

function winBackMessage(name) {
  return `We've been missing you, ${name}! 🌟 Life gets busy — that's totally okay. Is everything alright? We'd love to have you back whenever you're ready. Want me to find a time that works this week?`;
}

function reminder24h(name, className, classTime) {
  const timeStr = classTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  return (
    `Hi ${name}! Just a friendly reminder — you're booked for *${className}* tomorrow at *${timeStr}* at Shape Studio 🙌\n\n` +
    `Reply ✅ to confirm or let me know if something came up. See you there!`
  );
}

function reminder2h(name, className, classTime) {
  const timeStr = classTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  return `${name}, today's the day! 💪 ${className} starts at *${timeStr}*. We're excited to have you — see you soon at Shape Studio!`;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function daysDiff(a, b) {
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function hoursDiff(a, b) {
  return (b - a) / (1000 * 60 * 60);
}

module.exports = { runDailyRetentionPass, scheduleClassReminders };
