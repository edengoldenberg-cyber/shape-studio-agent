'use strict';

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const OpenAI = require('openai');
const logger = require('../utils/logger');
const store  = require('../utils/lead_store');
const arbox  = require('../services/arbox.service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const BUSINESS_CONTEXT = fs.readFileSync(
  path.join(__dirname, '../prompts/business_context.md'), 'utf8'
);
const BARAK_PROMPT = BUSINESS_CONTEXT + '\n\n---\n\n' + fs.readFileSync(
  path.join(__dirname, '../prompts/barak_prompt.md'), 'utf8'
);

let barakHistory = [];

// ── Live Arbox tools ──────────────────────────────────────────────────────────

/**
 * Look up a client in Arbox by phone number or name fragment.
 * Searches both /v3/users (members) and /v3/leads simultaneously.
 */
async function lookupClient(phoneOrName) {
  const query = (phoneOrName ?? '').trim();
  if (!query) return { error: 'שם או טלפון נדרש' };

  const normQuery = query.replace(/\s|\+/g, '').toLowerCase();
  const isPhone   = /^[0-9+\s\-]{7,}$/.test(query);

  const [members, leads] = await Promise.all([
    arbox.getMembers({ limit: 500 }).catch(() => []),
    arbox.getLeads({ limit: 500 }).catch(() => []),
  ]);

  const matchPhone = (p) => (p ?? '').replace(/\s|\+/g, '').includes(normQuery);
  const matchName  = (fn, ln) =>
    [(fn ?? ''), (ln ?? ''), `${fn ?? ''} ${ln ?? ''}`]
      .some(s => s.toLowerCase().includes(normQuery));

  const filterFn = isPhone
    ? (r) => matchPhone(r.phone)
    : (r) => matchName(r.first_name, r.last_name);

  const foundMembers = members.filter(filterFn).map(m => ({
    type: 'member', user_id: m.user_id,
    name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
    phone: m.phone, active: m.active,
    memberSince: m.membership_start_date,
    memberEnd:   m.membership_end_date,
    role: m.user_role,
  }));

  const foundLeads = leads.filter(filterFn).map(l => ({
    type: 'lead', user_id: l.user_id,
    name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(),
    phone: l.phone, leadStatus: l.lead_status,
    leadSource: l.lead_source, createdTime: l.created_time,
  }));

  const results = [...foundMembers, ...foundLeads];
  logger.info('Barak lookupClient', { query, found: results.length });
  store.logEvent('barak_lookup', null, { agent: 'barak', query, found: results.length });
  return { query, results, total: results.length };
}

// ── Hebrew day-of-week resolver ───────────────────────────────────────────────
// Maps Hebrew day names to the nearest future date with that weekday.
// Sunday = 0 (Israel week starts Sunday).

const HE_DAY_MAP = {
  'ראשון':  0, 'sunday':    0,
  'שני':    1, 'monday':    1,
  'שלישי':  2, 'tuesday':   2,
  'רביעי':  3, 'wednesday': 3,
  'חמישי':  4, 'thursday':  4,
  'שישי':   5, 'friday':    5,
  'שבת':    6, 'saturday':  6,
};

function resolveTargetDate(query) {
  if (!query) return new Date().toISOString().split('T')[0];

  // If it's already a YYYY-MM-DD date string, return it directly
  if (/^\d{4}-\d{2}-\d{2}$/.test(query)) return query;

  const lc = query.toLowerCase();
  for (const [token, weekday] of Object.entries(HE_DAY_MAP)) {
    if (lc.includes(token)) {
      const today  = new Date();
      const diff   = (weekday - today.getDay() + 7) % 7 || 7; // always future
      const target = new Date(today);
      target.setDate(today.getDate() + diff);
      return target.toISOString().split('T')[0];
    }
  }

  // "היום" / "today" — stay on today
  if (lc.includes('היום') || lc.includes('today')) {
    return new Date().toISOString().split('T')[0];
  }

  return new Date().toISOString().split('T')[0];
}

/**
 * Pull a day's class schedule from Arbox.
 * @param {string} [dateOrQuery] - ISO date, Hebrew day name, or free text containing a day name.
 *   Omit for today.
 */
async function checkSchedule(dateOrQuery) {
  const targetDate = resolveTargetDate(dateOrQuery ?? null);

  try {
    // Fetch 14 days so any day-of-week query within 2 weeks is covered
    const classes  = await arbox.getUpcomingClasses({ days: 14, limit: 100 });
    const filtered = classes.filter(c => c.date === targetDate);

    // Apply canonical capacity limits (Reformer = 8, all others = 10)
    const withCapacity = filtered.map(c => {
      const isReformer = /reformer/i.test(c.session_name ?? '');
      return {
        id:              c.schedule_id,
        name:            c.session_name,
        start:           c.start_time,
        end:             c.end_time,
        maxParticipants: isReformer ? 8 : 10,
        staff:           c.staff_member?.name ?? '—',
        date:            c.date,
      };
    });

    store.logEvent('barak_schedule_check', null, {
      agent: 'barak', date: targetDate, classCount: withCapacity.length,
    });
    return { date: targetDate, classes: withCapacity, total: withCapacity.length };
  } catch (err) {
    return { date: targetDate, error: err.message, classes: [] };
  }
}

/**
 * Pull all leads from Arbox and upsert them into the local lead_store.
 * Returns a summary of what was imported/updated.
 */
async function syncLeadsFromArbox() {
  try {
    const arboxLeads = await arbox.getLeads({ limit: 200 });
    let imported = 0, updated = 0, skipped = 0;

    for (const al of arboxLeads) {
      const phone = (al.phone ?? '').replace(/\s|\+/g, '');
      if (!phone || phone.includes('test') || phone.length < 8) { skipped++; continue; }

      const norm = phone.startsWith('972') ? phone : '972' + phone.replace(/^0/, '');
      const existing = store.getLead(norm);
      const name = `${al.first_name ?? ''} ${al.last_name ?? ''}`.trim() || null;

      store.upsertLead(norm, {
        name:        name ?? existing?.name,
        arboxSynced: true,
        arboxId:     String(al.user_id),
        meta: { ...(existing?.meta ?? {}), arboxLeadStatus: al.lead_status, arboxSource: al.lead_source },
      });
      existing ? updated++ : imported++;
    }

    const summary = { arboxTotal: arboxLeads.length, imported, updated, skipped };
    store.logEvent('barak_leads_synced', null, { agent: 'barak', ...summary });
    logger.info('Barak syncLeadsFromArbox complete', summary);
    return summary;
  } catch (err) {
    logger.error('Barak syncLeadsFromArbox error', { error: err.message });
    return { error: err.message };
  }
}

// ── Context builder (async — fetches live Arbox data) ─────────────────────────

async function buildContext() {
  const all      = store.getAllLeads();
  const unsynced = all.filter(l => !l.arboxSynced && l.status !== 'crisis').sort((a,b) => b.score - a.score);
  const stats    = store.getDailyStats();
  const now      = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

  // Fetch live Arbox data in parallel (graceful failures)
  // Schedule: fetch 14 days so day-of-week queries ("ביום שלישי") are always answerable
  const [classified, allClasses, staffList, retention] = await Promise.all([
    arbox.classifyMemberships({ limit: 500 }).catch(() => null),
    arbox.getUpcomingClasses({ days: 14, limit: 200 }).catch(() => []),
    arbox.getStaff().catch(() => []),
    arbox.getRetentionHealth(store).catch(() => null),
  ]);

  // Group classes by date and apply canonical capacity limits
  const classesByDate = {};
  for (const c of allClasses) {
    const isReformer = /reformer/i.test(c.session_name ?? '');
    const entry = {
      name:  c.session_name,
      start: c.start_time,
      end:   c.end_time,
      staff: c.staff_member?.name ?? '—',
      maxParticipants: isReformer ? 8 : 10,
    };
    (classesByDate[c.date] = classesByDate[c.date] ?? []).push(entry);
  }

  const todayStr      = new Date().toISOString().split('T')[0];
  const todayClasses  = { classes: classesByDate[todayStr] ?? [], total: (classesByDate[todayStr] ?? []).length };
  const detail = classified?.summary ?? null;
  const lastVal = getLastValidation();

  const lines = [
    `## ברק — לוח CRM בזמן אמת | ${now}`,
    '',
    '### Arbox Location 19392 — מנויים ולקוחות',
  ];

  if (detail) {
    lines.push(
      `  • לקוחות פעילים: ${detail.activeClients} | מנויים פעילים (כולל אגרגטורים): ${detail.activeMemberships ?? detail.totalActive} | פגים תוך 30ד: ${detail.expiringSoon}`,
      `  • פגו לאחרונה (≤90ד): ${detail.recentlyExpired} | ארכיון (>90ד): ${detail.archivedExpired} | בוטלו: ${detail.deactivated}`,
      `  • Aggregator פעיל: ${detail.aggregators} | לידים ב-Arbox: ${detail.leads} (${detail.leadsWithPhone} עם טלפון)`,
    );
    if (classified?.expiringSoon?.length > 0) {
      lines.push('  ⚠ פגים בקרוב — טריגר שימור מיידי:');
      classified.expiringSoon.slice(0, 3).forEach(m =>
        lines.push(`    → ${m._name} | ${m._phone ?? '—'} | פג: ${m.membership_end_date} (${m._daysLeft} ימים)`)
      );
    }
  }

  if (lastVal) {
    lines.push('', `### בדיקת תקינות נתונים — ציון: ${lastVal.integrityScore}/100 (${lastVal.verdict})`);
    const s = lastVal.summary;
    lines.push(
      `  • טלפונים לא תקינים: ${s.invalidPhones} | כפולים: ${s.duplicatePhones}`,
      `  • רשומות רפאים: ${s.ghostSyncRecords} | אי-התאמת סטטוס: ${s.statusMismatches}`,
    );
    if (lastVal.integrityScore < 90) {
      lines.push('  ⚠ יש לתקן את הממצאים לפני סנכרון נוסף');
    }
  }

  lines.push('');
  lines.push(`### צוות הסטודיו — ${staffList.length} חברי צוות`);
  staffList.slice(0, 5).forEach(s =>
    lines.push(`  • ${s.first_name} ${s.last_name ?? ''} | ${s.phone ?? '—'}`)
  );

  lines.push('');
  lines.push('### שיעורים היום');
  if (todayClasses.total > 0) {
    todayClasses.classes.forEach(c =>
      lines.push(`  • ${c.start}–${c.end} | ${c.name} | מדריך: ${c.staff} | מקסימום: ${c.maxParticipants}`)
    );
  } else {
    lines.push('  אין שיעורים היום');
  }

  // Full week schedule — allows Barak AI to answer "מי מדריך ביום שלישי בערב?" accurately
  const HE_DAYS_DISPLAY = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const sortedDates = Object.keys(classesByDate).sort().filter(d => d >= todayStr).slice(0, 7);
  if (sortedDates.length > 1) {
    lines.push('', '### לוח שיעורים שבועי (14 ימים קדימה)');
    for (const date of sortedDates) {
      if (date === todayStr) continue; // already shown above
      const d       = new Date(date);
      const heDay   = HE_DAYS_DISPLAY[d.getDay()];
      const display = `${heDay} ${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })}`;
      lines.push(`  📅 ${display}`);
      (classesByDate[date] ?? []).forEach(c =>
        lines.push(`    • ${c.start}–${c.end} | ${c.name} | מדריך: ${c.staff} | מקס: ${c.maxParticipants}`)
      );
    }
  }

  if (retention) {
    lines.push('', '### מדדי שימור');
    lines.push(`  • שיעור שימור: ${retention.summary.retentionRate} | נשירה: ${retention.summary.churnRate}`);
    retention.recommendations.forEach(r => lines.push(`  ${r}`));
  }

  lines.push('', '### סנכרון לידים מקומיים');
  lines.push(`  • סה"כ: ${all.length} | ממתין לסנכרון: ${unsynced.length}`);
  unsynced.slice(0, 3).forEach(l => lines.push(`  ⚠ ${l.name ?? l.phone} | ציון ${l.score}/10`));

  return lines.join('\n');
}

// ── Chat interface ─────────────────────────────────────────────────────────────

async function chat(userMessage) {
  const context = await buildContext();
  barakHistory.push({ role: 'user', content: userMessage });

  let reply;
  try {
    const completion = await openai.chat.completions.create({
      model:       process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages:    [
        { role: 'system', content: BARAK_PROMPT },
        { role: 'system', content: context },
        ...barakHistory,
      ],
      temperature: 0.2,
      max_tokens:  600,
    });
    reply = completion.choices[0].message.content.trim();
  } catch (err) {
    logger.error('OpenAI error in barak_agent', { error: err.message });
    reply = 'שגיאה טכנית. בדוק את מפתח ה-OPENAI_API_KEY.';
  }

  barakHistory.push({ role: 'assistant', content: reply });
  barakHistory = barakHistory.slice(-30);
  return reply;
}

// ── Data Validation & Integrity Audit ────────────────────────────────────────

/** Normalize Israeli phone to 05X format for cross-reference. */
function normalizeIsraeliPhone(phone) {
  if (!phone) return null;
  const raw = String(phone).replace(/[\s\-\.\(\)]/g, '');
  if (raw.startsWith('+972')) return '0' + raw.slice(4);
  if (raw.startsWith('972'))  return '0' + raw.slice(3);
  if (raw.startsWith('0'))    return raw;
  return null;
}

/** Validate Israeli mobile/landline format. */
function isValidIsraeliPhone(phone) {
  const n = normalizeIsraeliPhone(phone);
  return n ? /^0[5-9][0-9]{8}$|^0[2-4,7-8][0-9]{7}$/.test(n) : false;
}

/**
 * Cross-validate local lead_store against live Arbox data.
 * Catches: invalid phones, duplicate phones, ghost synced records,
 *          status mismatches (locally hot but expired in Arbox).
 * Returns a structured integrity audit with a 0-100 score.
 */
let _lastValidation = null;

async function runDataValidation() {
  const [arboxUsers, localLeads] = await Promise.all([
    arbox.getAllUsers({ limit: 500 }).catch(() => []),
    Promise.resolve(store.getAllLeads()),
  ]);

  // Build Arbox lookup by normalized phone
  const arboxByNorm = {};
  for (const u of arboxUsers) {
    const n = normalizeIsraeliPhone(u.phone);
    if (n) arboxByNorm[n] = u;
  }
  const arboxNormSet = new Set(Object.keys(arboxByNorm));

  const issues   = [];
  const seen     = new Map(); // norm phone → first lead name
  let invalidPh  = 0, dupPh = 0, ghosts = 0, statusMis = 0, testRecords = 0;

  for (const lead of localLeads) {
    const norm = normalizeIsraeliPhone(lead.phone);

    // Test / junk records
    if (lead.phone?.includes('test') || lead.phone?.includes('dummy')) {
      testRecords++;
      issues.push({ type: 'test_record', name: lead.name, phone: lead.phone, severity: 'low' });
      continue;
    }

    // Invalid phone format
    if (!isValidIsraeliPhone(lead.phone)) {
      invalidPh++;
      issues.push({ type: 'invalid_phone', name: lead.name, phone: lead.phone ?? '—', severity: 'high' });
    }

    // Duplicate phone in local store
    if (norm) {
      if (seen.has(norm)) {
        dupPh++;
        issues.push({ type: 'duplicate_phone', name: lead.name, phone: lead.phone, duplicateOf: seen.get(norm), severity: 'medium' });
      } else {
        seen.set(norm, lead.name);
      }
    }

    // Ghost record: marked as arboxSynced locally but phone not in Arbox at all
    if (lead.arboxSynced && norm && !arboxNormSet.has(norm)) {
      ghosts++;
      issues.push({ type: 'ghost_sync', name: lead.name, phone: lead.phone, arboxId: lead.arboxId, severity: 'medium',
        note: 'מסומן כמסונכרן ב-Arbox אך הטלפון לא קיים ב-Arbox' });
    }

    // Status mismatch: local shows hot/active, but Arbox shows expired membership
    if (norm && arboxByNorm[norm]) {
      const arboxU = arboxByNorm[norm];
      const endDate = arboxU.membership_end_date ? new Date(arboxU.membership_end_date) : null;
      const isArboxExpired = endDate && endDate < new Date();
      if (isArboxExpired && (lead.score >= 8 || lead.status === 'hot')) {
        statusMis++;
        issues.push({ type: 'status_mismatch', name: lead.name, phone: lead.phone,
          localStatus: lead.status, localScore: lead.score,
          arboxRole: arboxU.user_role, arboxEndDate: arboxU.membership_end_date,
          severity: 'high',
          note: 'ליד מסומן כחם מקומית אך המנוי פג ב-Arbox' });
      }
    }
  }

  const total = localLeads.length || 1;
  // Weighted integrity score
  const score = Math.max(0, Math.round(
    100
    - (invalidPh  / total) * 25
    - (dupPh      / total) * 20
    - (ghosts     / total) * 30
    - (statusMis  / total) * 25
  ));

  const verdict = score >= 90 ? 'תקין' : score >= 70 ? 'טעון בדיקה' : 'יש בעיות';

  const result = {
    integrityScore: score,
    verdict,
    summary: {
      totalChecked: localLeads.length,
      arboxUsers:   arboxUsers.length,
      invalidPhones: invalidPh,
      duplicatePhones: dupPh,
      ghostSyncRecords: ghosts,
      statusMismatches: statusMis,
      testRecords,
      totalIssues: issues.length,
    },
    issues: issues.slice(0, 30), // cap at 30 for UI
    checkedAt: new Date(),
  };

  _lastValidation = result;
  store.logEvent('barak_data_validation', null, {
    agent: 'barak', integrityScore: score, totalIssues: issues.length,
    invalidPhones: invalidPh, duplicates: dupPh, ghosts, statusMismatches: statusMis,
  });
  logger.info('Barak data validation complete', { score, issues: issues.length, verdict });
  return result;
}

function getLastValidation() { return _lastValidation; }

// ── Legacy CRM operations (unchanged) ─────────────────────────────────────────

async function syncLeadToArbox(phone) {
  if (!arboxConfigured()) return { error: 'Arbox not configured' };
  const lead = store.getLead(phone);
  if (!lead) return { error: `Lead not found: ${phone}` };
  if (lead.status === 'crisis') return { error: 'Cannot sync crisis lead' };
  if (lead.arboxSynced) return { skipped: true, arboxId: lead.arboxId, reason: 'already synced' };

  try {
    let member = await arbox.getMemberByPhone(phone);
    if (!member) {
      const parts = (lead.name ?? '').split(' ');
      member = await arbox.createLead({
        firstName: parts[0] ?? 'לא ידוע',
        lastName:  parts.slice(1).join(' ') || '',
        phone,
        source: 'WhatsApp',
      });
    }
    const arboxId = member?.data?.user_id ?? member?.user_id ?? null;
    store.upsertLead(phone, { arboxSynced: true, arboxId: String(arboxId) });
    store.logEvent('arbox_sync', phone, { arboxId, name: lead.name });
    return { synced: true, arboxId, name: lead.name };
  } catch (err) {
    logger.error('Arbox sync error', { phone, error: err.message });
    return { error: err.message };
  }
}

async function syncAllUnsynced() {
  if (!arboxConfigured()) return { error: 'Arbox not configured', configured: false };
  const pending = store.getAllLeads()
    .filter(l => !l.arboxSynced && l.status !== 'crisis')
    .sort((a, b) => b.score - a.score);
  const results = { synced: 0, skipped: 0, errors: [], total: pending.length };
  for (const lead of pending) {
    const r = await syncLeadToArbox(lead.phone);
    if (r.synced) results.synced++;
    else if (r.skipped) results.skipped++;
    else results.errors.push({ phone: lead.phone, name: lead.name, error: r.error });
  }
  logger.info('Arbox bulk sync complete', results);
  return results;
}

async function registerTrialBooking(phone, classId) {
  if (!arboxConfigured()) return { error: 'Arbox not configured' };
  const lead = store.getLead(phone);
  if (!lead) return { error: `Lead not found: ${phone}` };
  if (!lead.arboxSynced || !lead.arboxId) return { error: 'Lead not synced to Arbox yet' };
  try {
    const booking = await arbox.bookTrialClass(lead.arboxId, classId);
    store.upsertLead(phone, { bookingConfirmed: true });
    store.logEvent('booking_confirmed', phone, { classId, arboxId: lead.arboxId });
    return { booked: true, booking, name: lead.name };
  } catch (err) {
    return { error: err.message };
  }
}

async function getAvailableSlots(classType, limit = 5) {
  if (!arboxConfigured()) return { error: 'Arbox not configured' };
  try {
    const classes = await arbox.getUpcomingClasses({ classType, limit });
    return { classes };
  } catch (err) {
    return { error: err.message };
  }
}

async function probeConnection() {
  if (!arboxConfigured()) return { ok: false, reason: 'credentials not set' };
  const result = await arbox.testConnection();
  store.logEvent('barak_arbox_probe', null, { agent: 'barak', ...result });
  return result;
}

function arboxConfigured() {
  const key = process.env.ARBOX_API_KEY;
  const cid = process.env.ARBOX_CLIENT_ID;
  return !!(key && key !== 'REPLACE_ME' && cid && cid !== 'REPLACE_ME');
}

function clearHistory() { barakHistory = []; }

module.exports = {
  chat,
  syncLeadToArbox,
  syncAllUnsynced,
  registerTrialBooking,
  getAvailableSlots,
  probeConnection,
  lookupClient,
  checkSchedule,
  syncLeadsFromArbox,
  runDataValidation,
  getLastValidation,
  clearHistory,
};
