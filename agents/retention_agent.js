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
  return `${name}, איך היה? 🌟 אשמח לשמוע מה חשבת על האימון הראשון — מה הרגשת?`;
}

function week1Message(name) {
  return `${name}, שבוע ראשון מאחורינו! 💪 איך את/ה מרגיש/ה? יש שיעור שכבר אהבת במיוחד?`;
}

function week2Message(name) {
  return `${name}, שבועיים בסטודיו — ממש שמחים לראות אותך פה 🙌 יש שיעור שהייתי רוצה לנסות בקרוב?`;
}

function month1Message(name) {
  return (
    `${name}, חודש בShape Studio — זה אבן דרך אמיתית, כל הכבוד! 🎉\n\n` +
    `בנית שגרה, וזה הכי חשוב. אשמח לשמוע מה עובד לך ואיך נוכל לתמוך בך בהמשך. ` +
    `מה הצעד הבא שהיית רוצה לעשות? 💫`
  );
}

function winBackMessage(name) {
  return `${name}, חסרת לנו! 🌟 הבנו שהתעסוקה גוברת לפעמים — זה בסדר גמור. הכל בסדר? נשמח לראות אותך חוזר/ת כשנוח לך. רוצה שאמצא זמן מתאים השבוע?`;
}

function reminder24h(name, className, classTime) {
  const timeStr = classTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  return (
    `${name}, תזכורת ידידותית — מחר יש לך *${className}* בשעה *${timeStr}* בShape Studio 🙌\n\n` +
    `ענה/י ✅ לאישור, או שלח/י הודעה אם משהו השתנה. מחכים לך!`
  );
}

function reminder2h(name, className, classTime) {
  const timeStr = classTime.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  return `${name}, היום זה היום! 💪 *${className}* מתחיל בשעה *${timeStr}*. מחכים לך בסטודיו!`;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function daysDiff(a, b) {
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function hoursDiff(a, b) {
  return (b - a) / (1000 * 60 * 60);
}

module.exports = { runDailyRetentionPass, scheduleClassReminders };
