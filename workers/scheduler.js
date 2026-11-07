'use strict';

/**
 * Autonomous background workers for Shape Studio multi-agent OS.
 *
 * Workers:
 *   Tomer        — retention scan every 4 hours (0,4,8,12,16,20:00 IL)
 *   Barak        — CRM ingestion check every hour
 *   Maya         — daily executive briefing logged at 08:00 IL
 *   EveningReport— end-of-day WhatsApp summary to Eden + Melanie at 20:00 IL
 */

const cron        = require('node-cron');
const logger      = require('../utils/logger');
const automations = require('../utils/automation_store');
const aptStore    = require('../utils/appointment_store');
const { sendDailySummaryToAdmins } = require('../services/notification.service');

// Business constants from business_context.md
const STUDIO_NAME   = 'Shape Studio';
const STUDIO_CITY   = 'פרדס חנה-כרכור';
const TRIAL_OFFER   = '2 אימונים ב-60 ש״ח';
const TRIAL_CLASSES = ['Reformer Pilates', 'Pilates Barre', 'Strength Training', 'Concept Toning'];

// ── Tomer: Automated Retention & Follow-up Loop (every 4 hours) ──────────────

function startTomerRetentionLoop(store) {
  cron.schedule('0 0,4,8,12,16,20 * * *', async () => {
    try { await runTomerScan(store); }
    catch (err) { logger.error('Worker[Tomer]: unhandled error', { error: err.message }); }
  }, { timezone: 'Asia/Jerusalem' });
  logger.info('Worker[Tomer]: retention loop scheduled — runs every 4h at 0,4,8,12,16,20:00 IL');
}

async function runTomerScan(store) {
  if (!automations.isWorkerEnabled('tomer-retention')) {
    logger.info('Worker[Tomer]: disabled — skipping scan');
    return { skipped: true };
  }
  automations.touchWorker('tomer-retention');
  const startedAt = Date.now();
  logger.info('Worker[Tomer]: retention scan starting');

  const dormant  = store.getDormantLeads(3);
  const inactive = store.getInactiveMembers(14);
  let queued = 0;

  // ── Lead re-engagement queue ──────────────────────────────────────────────
  for (const lead of dormant) {
    const touchNum = (lead.reEngagementCount ?? 0) + 1;
    if (touchNum > 3) continue;

    const days = Math.floor((Date.now() - new Date(lead.lastActivity).getTime()) / 86400000);
    const msg  = buildLeadMessage(lead, touchNum);

    store.logEvent('tomer_followup_queued', lead.phone, {
      agent:   'tomer',
      type:    'lead_reengagement',
      name:    lead.name,
      touch:   touchNum,
      silent:  days,
      preview: msg.slice(0, 100),
      status:  'queued',
    });
    queued++;
  }

  // ── Member retention queue ─────────────────────────────────────────────────
  for (const member of inactive) {
    if (member.status === 'churned') continue;

    const days = member.lastAttendance
      ? Math.floor((Date.now() - new Date(member.lastAttendance).getTime()) / 86400000)
      : 999;
    const msg  = buildMemberMessage(member, days);

    store.logEvent('tomer_member_check', member.phone ?? null, {
      agent:    'tomer',
      type:     'member_retention',
      name:     member.name,
      planType: member.planType,
      daysSince: days,
      status:   member.status,
      preview:  msg.slice(0, 100),
    });
    queued++;
  }

  const elapsed = Date.now() - startedAt;
  store.logEvent('tomer_scan_complete', null, {
    agent:           'tomer',
    dormantLeads:    dormant.length,
    inactiveMembers: inactive.length,
    actionsQueued:   queued,
    elapsedMs:       elapsed,
  });
  logger.info('Worker[Tomer]: scan complete', {
    dormantLeads: dormant.length, inactiveMembers: inactive.length, queued,
  });
}

function buildLeadMessage(lead, touchNum) {
  const name    = (lead.name ?? '').split(' ')[0] || 'שלום';
  const cls     = TRIAL_CLASSES[touchNum % TRIAL_CLASSES.length];
  const msgs    = {
    1: `${name}, שלום! 😊 Shape Studio ב${STUDIO_CITY} שומרים לך מקום. הגיע הזמן לנסות ${cls}? ${TRIAL_OFFER} — בלי התחייבות. 💪`,
    2: `${name}, שבוע עבר! עדיין רוצים לראות אותך. אולי ${cls} מתאים יותר? ספרי לנו ונמצא לך זמן. 🧘‍♀️`,
    3: `${name}, לא רוצים להעיק — אבל ${STUDIO_NAME} ב${STUDIO_CITY} תמיד מוזמנת. ${TRIAL_OFFER} עדיין תקפה. 🙏`,
  };
  return msgs[touchNum] ?? msgs[1];
}

function buildMemberMessage(member, daysSince) {
  const name = (member.name ?? '').split(' ')[0] || 'שלום';
  const plan = member.planType ?? 'האימונים שלך';
  return `${name}, חסרת לנו ב${STUDIO_NAME}! לא ראינו אותך ${daysSince} ימים ב-${plan}. מה קורה? מחכים לך 🌟`;
}

// ── Barak: Lead Ingestion & CRM Sync Worker (hourly) ─────────────────────────

function startBarakIngestionWorker(store) {
  cron.schedule('0 * * * *', async () => {
    try { await runBarakIngestion(store); }
    catch (err) { logger.error('Worker[Barak]: unhandled error', { error: err.message }); }
  }, { timezone: 'Asia/Jerusalem' });
  logger.info('Worker[Barak]: CRM ingestion worker scheduled — runs every hour');
}

async function runBarakIngestion(store) {
  if (!automations.isWorkerEnabled('barak-ingestion')) {
    logger.info('Worker[Barak]: disabled — skipping ingestion');
    return { skipped: true };
  }
  automations.touchWorker('barak-ingestion');
  logger.info('Worker[Barak]: CRM ingestion check starting');

  const all       = store.getAllLeads();
  const PHONE_RE  = /^972[0-9]{8,10}$/;
  const nameIndex = new Map(); // normalized name → first phone seen

  let invalid = 0, duplicates = 0, pendingSync = 0, highScore = 0;

  for (const lead of all) {
    // Phone validation
    const phone = (lead.phone ?? '').replace(/\s/g, '');
    if (!PHONE_RE.test(phone)) {
      store.logEvent('barak_phone_invalid', lead.phone, {
        agent: 'barak', name: lead.name, phone: lead.phone,
        issue: 'מספר טלפון לא תקין — לא עומד בפורמט 972XXXXXXXXX',
      });
      invalid++;
      continue;
    }

    // Duplicate detection by name
    const normName = (lead.name ?? '').trim().toLowerCase();
    if (normName && nameIndex.has(normName)) {
      store.logEvent('barak_duplicate_flag', lead.phone, {
        agent:         'barak',
        name:          lead.name,
        existingPhone: nameIndex.get(normName),
        issue:         'שם כפול זוהה — לבדוק אם אותו לקוח',
      });
      duplicates++;
    } else if (normName) {
      nameIndex.set(normName, lead.phone);
    }

    // Pending Arbox sync
    if (!lead.arboxSynced && lead.status !== 'crisis') {
      pendingSync++;
    }

    // High-value leads not yet offered trial
    if (lead.score >= 8 && !lead.introOfferSent) {
      store.logEvent('barak_high_value_pending', lead.phone, {
        agent: 'barak', name: lead.name, score: lead.score,
        issue: 'ליד חם ללא הצעת היכרות — לטפל בדחיפות',
      });
      highScore++;
    }
  }

  store.logEvent('barak_ingestion_complete', null, {
    agent:       'barak',
    total:       all.length,
    invalid,
    duplicates,
    pendingSync,
    highValuePending: highScore,
  });
  logger.info('Worker[Barak]: ingestion check complete', {
    total: all.length, invalid, duplicates, pendingSync, highValuePending: highScore,
  });
}

// ── Maya: Daily Executive Briefing (08:00 IL) ────────────────────────────────

function startMayaDailyBriefing(store) {
  cron.schedule('0 8 * * *', async () => {
    try { await runMayaBriefing(store); }
    catch (err) { logger.error('Worker[Maya]: unhandled error', { error: err.message }); }
  }, { timezone: 'Asia/Jerusalem' });
  logger.info('Worker[Maya]: daily briefing scheduled — runs daily at 08:00 IL');
}

async function runMayaBriefing(store) {
  if (!automations.isWorkerEnabled('maya-briefing')) {
    logger.info('Worker[Maya]: disabled — skipping briefing');
    return { skipped: true };
  }
  automations.touchWorker('maya-briefing');
  logger.info('Worker[Maya]: compiling daily executive briefing');

  const stats    = store.getDailyStats();
  const health   = store.getSystemHealth();
  const members  = store.getMemberStats();
  const hot      = store.getHotLeads();
  const dormant  = store.getDormantLeads(3);
  const inactive = store.getInactiveMembers(14);

  const convRate = stats.introOffersSent > 0
    ? Math.round(((stats.introsRedeemed ?? 0) / stats.introOffersSent) * 100)
    : 0;

  const alerts = [];
  if (health.crisisActive > 0)
    alerts.push(`🚨 ${health.crisisActive} לידים במשבר — מחכים לטיפול אנושי`);
  if (dormant.length > 5)
    alerts.push(`⚠️ ${dormant.length} לידים רדומים — מומלץ להריץ Tomer`);
  if (inactive.length > 3)
    alerts.push(`📉 ${inactive.length} חברות לא הגיעו 14+ ימים`);
  if (convRate < 20 && stats.introOffersSent > 0)
    alerts.push(`📊 שיעור המרה נמוך: ${convRate}% — לבדוק פייפליין`);
  if (hot.length > 0)
    alerts.push(`🔥 ${hot.length} לידים חמים ממתינים לסגירה`);

  const headline =
    `סיכום יומי ${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}: ` +
    `${stats.totalLeads} לידים | ${members.atRisk ?? 0} חברות בסיכון | ` +
    `ציון ממוצע ${health.avgScore} | המרה ${convRate}%`;

  store.logEvent('maya_daily_briefing', null, {
    agent:    'maya',
    headline,
    pipeline: {
      total: stats.totalLeads, hot: stats.hotLeadsTotal,
      warm:  stats.warmLeadsTotal, cold: stats.coldLeadsTotal,
    },
    funnel: {
      newToday: stats.newLeadsToday, introSent: stats.introOffersSent,
      redeemed: stats.introsRedeemed ?? 0, bookings: stats.bookingsToday, convRate,
    },
    members: { total: members.total, active: members.active, atRisk: members.atRisk, churned: members.churned },
    alerts,
    urgentLeads: hot.slice(0, 3).map(l => ({
      name: l.name, score: l.score,
      offer: l.introOfferSent ? 'נשלחה' : 'לא נשלחה',
    })),
    avgScore: health.avgScore,
  });

  logger.info('Worker[Maya]: daily briefing logged', { headline });
}

// ── Evening Report: end-of-day WhatsApp summary to Eden + Melanie (20:00 IL) ──

function startEveningReport(store) {
  cron.schedule('0 20 * * *', async () => {
    try { await runEveningReport(store); }
    catch (err) { logger.error('Worker[EveningReport]: unhandled error', { error: err.message }); }
  }, { timezone: 'Asia/Jerusalem' });
  logger.info('Worker[EveningReport]: daily WhatsApp summary scheduled — runs at 20:00 IL');
}

async function runEveningReport(store) {
  if (!automations.isWorkerEnabled('evening-report')) {
    logger.info('Worker[EveningReport]: disabled — skipping');
    return { skipped: true };
  }
  automations.touchWorker('evening-report');
  logger.info('Worker[EveningReport]: compiling end-of-day report');

  try {
    const stats  = store.getDailyStats();
    const health = store.getSystemHealth();
    const members = store.getMemberStats();

    // ── Today section ─────────────────────────────────────────────────────────
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const allApts  = aptStore.getAll();
    const aptsToday      = allApts.filter(a => new Date(a.createdAt) >= today);
    const aptsCompleted  = aptsToday.filter(a => a.status === 'completed').length;
    const aptsNoShow     = aptsToday.filter(a => a.status === 'no_show').length;
    const aptsCreated    = aptsToday.length;

    // ── Pending section ───────────────────────────────────────────────────────
    const aptsConfirmed    = allApts.filter(a => a.status === 'confirmed').length;
    const dormantLeads     = store.getDormantLeads(3).length;
    const inactiveMembers  = store.getInactiveMembers(14).length;
    const callbacksPending = store.getAllLeads().filter(l => l.meta?.awaitingCallbackTime).length;

    const convRate = stats.introOffersSent > 0
      ? Math.round(((stats.introsRedeemed ?? 0) / stats.introOffersSent) * 100)
      : 0;

    const dateHe = new Date().toLocaleDateString('he-IL', {
      timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long',
    });

    // ── Build WhatsApp message ────────────────────────────────────────────────
    const lines = [
      `📊 *סיכום יומי — Shape Studio*`,
      `${dateHe}`,
      ``,
      `✅ *בוצע היום:*`,
      `• ${stats.newLeadsToday ?? 0} לידים חדשים נקלטו`,
      `• ${stats.messagesIn    ?? 0} הודעות WhatsApp נכנסות`,
      `• ${aptsCreated} שיחות ייעוץ נקבעו`,
      aptsCompleted > 0 ? `• ${aptsCompleted} שיחות הושלמו` : null,
      aptsNoShow    > 0 ? `• ${aptsNoShow} שיחות שלא נוצלו (no-show)` : null,
      stats.bookingsToday > 0 ? `• ${stats.bookingsToday} ניסיונות הוזמנו` : null,
      ``,
      `⏳ *ממתין לטיפול:*`,
      callbacksPending > 0 ? `• ${callbacksPending} בקשות שיחה ממתינות לאישור זמן` : null,
      aptsConfirmed    > 0 ? `• ${aptsConfirmed} פגישות מאושרות שטרם הושלמו` : null,
      dormantLeads     > 0 ? `• ${dormantLeads} לידים ללא מענה (3+ ימים)` : null,
      inactiveMembers  > 0 ? `• ${inactiveMembers} חברות לא הגיעו 14+ ימים` : null,
      health.crisisActive > 0 ? `• 🚨 ${health.crisisActive} לידים במשבר — נדרש טיפול אנושי` : null,
      ``,
      `📈 *מצב כללי:*`,
      `• ${stats.totalLeads ?? 0} לידים סה"כ | ${stats.hotLeadsTotal ?? 0} חמים`,
      `• המרה: ${convRate}% | ציון ממוצע: ${health.avgScore ?? 0}`,
      members.total > 0 ? `• ${members.active ?? 0} חברות פעילות | ${members.atRisk ?? 0} בסיכון` : null,
    ].filter(l => l !== null).join('\n');

    await sendDailySummaryToAdmins(lines);

    store.logEvent('evening_report_sent', null, {
      agent: 'scheduler', newLeads: stats.newLeadsToday, apts: aptsCreated,
      pending: callbacksPending + aptsConfirmed,
    });
    logger.info('Worker[EveningReport]: report sent', { aptsCreated, dormantLeads, callbacksPending });
    return { ok: true, aptsCreated, dormantLeads, callbacksPending };
  } catch (err) {
    logger.error('Worker[EveningReport]: failed', { error: err.message });
    return { ok: false, error: err.message };
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initWorkers(store) {
  startTomerRetentionLoop(store);
  startBarakIngestionWorker(store);
  startMayaDailyBriefing(store);
  startEveningReport(store);

  // Appointment reminders + no-show detection (every 15 min)
  const { initAppointmentWorker } = require('./appointment_worker');
  initAppointmentWorker(store);

  logger.info('Workers: all 5 autonomous workers initialized and running');

  // Run Barak ingestion immediately on boot for instant health check
  setImmediate(() => runBarakIngestion(store));
}

module.exports = {
  initWorkers,
  runTomerScan,
  runBarakIngestion,
  runMayaBriefing,
  runEveningReport,
};
