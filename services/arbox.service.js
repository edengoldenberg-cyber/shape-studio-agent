'use strict';

/**
 * Arbox CRM service — Shape Studio (location 19392)
 *
 * Base URL : https://arboxserver.arboxapp.com/api/public
 * Auth     : `apiKey` request header using the ARBOX_CLIENT_ID value.
 *             (The env var is named CLIENT_ID but it carries the `apiKey` credential.)
 *
 * Confirmed live endpoints (v3):
 *   GET  /v3/leads     — lead pipeline records
 *   POST /v3/leads     — create a new lead
 *   GET  /v3/users     — active members
 *   GET  /v3/schedule  — upcoming class schedule (requires from_date, to_date)
 *   GET  /v3/tasks     — tasks (requires from_date, to_date)
 *   GET  /v3/locations — location metadata
 */

require('dotenv').config();
const axios  = require('axios');
const logger = require('../utils/logger');

const LOC = () => process.env.ARBOX_LOCATION_ID ?? '19392';

const client = axios.create({
  baseURL: process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public',
  headers: {
    // ARBOX_CLIENT_ID is the actual API key value sent in the `apiKey` header
    'apiKey':        process.env.ARBOX_CLIENT_ID,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  },
  timeout: 12000,
});

client.interceptors.response.use(
  (res) => res,
  (err) => {
    logger.error('Arbox API error', {
      url:    err.config?.url,
      status: err.response?.status,
      data:   err.response?.data,
    });
    throw err;
  }
);

// ── Leads ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all leads for the studio.
 * Returns array of { user_id, first_name, last_name, phone, email,
 *                    lead_status, lead_source, created_time }
 */
async function getLeads({ limit = 100, status } = {}) {
  const params = { location_id: LOC(), limit: Math.min(limit, 200) };
  if (status) params.lead_status = status;
  const { data } = await client.get('/v3/leads', { params });
  return data?.data ?? [];
}

/**
 * Find a lead by phone number (local scan — Arbox has no phone-filter on leads).
 */
async function getLeadByPhone(phone) {
  try {
    const all = await getLeads({ limit: 200 });
    const norm = (phone ?? '').replace(/\s|\+/g, '');
    return all.find(l => (l.phone ?? '').replace(/\s|\+/g, '') === norm) ?? null;
  } catch {
    return null;
  }
}

/**
 * Create a new lead in Arbox.
 * Returns the created lead object from Arbox.
 */
async function createLead({ firstName, lastName, phone, email, source = 'WhatsApp' }) {
  const { data } = await client.post('/v3/leads', {
    location_id:  parseInt(LOC(), 10),
    first_name:   firstName,
    last_name:    lastName ?? '',
    phone,
    email:        email ?? '',
    lead_source:  source,
    lead_status:  'לא נוצר קשר',
  });
  return data;
}

// ── Members (users) ────────────────────────────────────────────────────────────

/**
 * Fetch active studio members.
 * Returns array of { user_id, first_name, last_name, phone, email,
 *                    active, membership_start_date, membership_end_date, user_role }
 */
async function getMembers({ limit = 100, activeOnly = true } = {}) {
  const params = { location_id: LOC(), limit: Math.min(limit, 200) };
  if (activeOnly) params.active = 1;
  const { data } = await client.get('/v3/users', { params });
  return data?.data ?? [];
}

/**
 * Find a member by phone number.
 */
async function getMemberByPhone(phone) {
  try {
    const all = await getMembers({ limit: 200 });
    const norm = (phone ?? '').replace(/\s|\+/g, '');
    return all.find(m => (m.phone ?? '').replace(/\s|\+/g, '') === norm) ?? null;
  } catch {
    return null;
  }
}

/**
 * Find a member by their stable Arbox user_id.
 * Returns null if not found or on Arbox error.
 */
async function getMemberById(arboxId) {
  try {
    const all = await getMembers({ limit: 200 });
    return all.find(m => String(m.user_id) === String(arboxId)) ?? null;
  } catch {
    return null;
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────

/**
 * Fetch upcoming class schedule for the next N days.
 * Returns array of { schedule_id, date, start_time, end_time,
 *                    session_name, max_participants, staff_member }
 */
async function getUpcomingClasses({ days = 7, classType, limit = 20 } = {}) {
  const from = new Date().toISOString().split('T')[0];
  const to   = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
  const params = { location_id: LOC(), from_date: from, to_date: to, limit };
  if (classType) params.session_name = classType;
  const { data } = await client.get('/v3/schedule', { params });
  return data?.data ?? [];
}

// ── Location ──────────────────────────────────────────────────────────────────

/** Returns Shape Studio location metadata. */
async function getLocation() {
  const { data } = await client.get('/v3/locations', {
    params: { location_id: LOC() },
  });
  return data?.data?.[0] ?? null;
}

// ── Precise membership classification (Arbox reports-v5 aligned) ─────────────

/**
 * Classify all users into Arbox operational report categories.
 *
 * Derived from confirmed API fields: user_role, active (0|1), membership_end_date.
 *
 * Categories:
 *   activeClients     — role=client, active=1, no end date OR end date ≥ today
 *   expiringSoon      — role=client, active=1, end date within daysWarning days
 *   expired           — role=client, membership_end_date < today
 *   deactivated       — role=client, active=0, no end date (manually cancelled in Arbox UI)
 *   aggregators       — role=aggregatorMember, active=1 (ClassPass, Gympass, etc.)
 *   aggregatorsInact  — role=aggregatorMember, active=0
 *   leads             — role=lead (includes trial-interested leads — API cannot sub-classify)
 *   leadsWithPhone    — role=lead with valid non-test phone numbers
 *   staff             — role=staffMember
 *
 * NOT AVAILABLE in Arbox Public API v3:
 *   - frozen/blocked (הקפאות / חסימות) — visible only in Arbox admin panel
 *   - per-class check-in records
 *   - trial workout completion status within leads
 */
async function classifyMemberships({ daysWarning = 30, recentDays = 90, limit = 500 } = {}) {
  const all          = await getAllUsers({ limit });
  const now          = new Date();
  const warn         = new Date(now.getTime() + daysWarning * 86400000);
  const recentCutoff = new Date(now.getTime() - recentDays * 86400000);

  const enrich = (u, status, daysLeft = null) => ({
    ...u,
    _status:   status,
    _daysLeft: daysLeft,
    _name:     `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
    _phone:    u.phone ?? null,
  });

  const activeClients    = [];
  const expiringSoon     = [];
  const recentlyExpired  = [];
  const archivedExpired  = [];
  const deactivated      = [];
  const aggregators      = [];
  const aggregatorsInact = [];
  const leads            = [];
  const leadsWithPhone   = [];
  const staffList        = [];

  for (const u of all) {
    const end      = u.membership_end_date ? new Date(u.membership_end_date) : null;
    const isActive = u.active === 1;

    if (u.user_role === 'client') {
      if (isActive) {
        // active=1 is the definitive source of truth — this IS a current member.
        // membership_end_date may be a stale plan record from a previous subscription.
        if (end && end >= now && end <= warn) {
          // Genuinely expiring soon: active AND real upcoming end date
          const daysLeft = Math.ceil((end - now) / 86400000);
          expiringSoon.push(enrich(u, 'expiringSoon', daysLeft));
          activeClients.push(enrich(u, 'expiringSoon', daysLeft));
        } else {
          // Active — open-ended or stale end_date, both are current members
          activeClients.push(enrich(u, 'active'));
        }
      } else {
        // active=0 — classify churn recency
        if (!end) {
          // No end_date + inactive = manually cancelled/deactivated in Arbox UI
          deactivated.push(enrich(u, 'deactivated'));
        } else {
          const daysAgo = Math.floor((now - end) / 86400000);
          if (end >= recentCutoff) {
            // Recently churned (within recentDays) — actionable win-back targets
            recentlyExpired.push(enrich(u, 'recentlyExpired', -daysAgo));
          } else {
            // Older churn — historical archive, not operationally actionable
            archivedExpired.push(enrich(u, 'archivedExpired', -daysAgo));
          }
        }
      }
    } else if (u.user_role === 'aggregatorMember') {
      (isActive ? aggregators : aggregatorsInact).push(
        enrich(u, isActive ? 'aggregator' : 'deactivated')
      );
    } else if (u.user_role === 'lead') {
      const enriched = enrich(u, 'lead');
      leads.push(enriched);
      if (u.phone && !u.phone.includes('test') && !u.phone.includes('dummy')) {
        leadsWithPhone.push(enriched);
      }
    } else if (u.user_role === 'staffMember') {
      staffList.push(enrich(u, isActive ? 'staff_active' : 'staff_inactive'));
    }
  }

  const staffActive = staffList.filter(u => u._status === 'staff_active').length;

  return {
    summary: {
      totalUsers:        all.length,
      activeClients:     activeClients.length,        // 148 — role=client, active=1 (includes expiringSoon)
      totalActive:       activeClients.length,        // alias kept for backward compat
      activeMemberships: activeClients.length + staffActive, // 161 — clients + staff (excludes ClassPass/Gympass aggregators and leads)
      expiringSoon:      expiringSoon.length,
      recentlyExpired:   recentlyExpired.length,      // actionable win-back (≤90d)
      archivedExpired:   archivedExpired.length,      // historical (>90d)
      deactivated:       deactivated.length,
      aggregators:       aggregators.length,
      aggregatorsInact:  aggregatorsInact.length,
      leads:             leads.length,
      leadsWithPhone:    leadsWithPhone.length,
      staff:             staffActive,
      staffInactive:     staffList.filter(u => u._status !== 'staff_active').length,
    },
    activeClients,
    expiringSoon,
    recentlyExpired,
    archivedExpired,
    deactivated,
    aggregators,
    aggregatorsInact,
    leads,
    leadsWithPhone,
    staff: staffList,
    config: { daysWarning, recentDays },
    apiLimitations: {
      frozen:     'הקפאות/חסימות אינן זמינות ב-Arbox Public API v3 — יש לבדוק בממשק Arbox',
      trial:      'לא ניתן להפריד לידים שסיימו שיעור ניסיון מלידים קרים — כל role=lead כלול יחדיו',
      checkin:    'רשומות כניסה לשיעורים אינן זמינות ב-API הציבורי',
      activeFlag: 'active=1 הוא המדד הקובע. membership_end_date ישן אינו מעיד על נשירה אם active=1.',
    },
  };
}

// ── Legacy getDetailedMembers (kept for backward compat with server.js) ────────

async function getDetailedMembers({ daysWarning = 30, limit = 500 } = {}) {
  const c = await classifyMemberships({ daysWarning, limit });
  return {
    total:             c.summary.totalActive + c.summary.recentlyExpired + c.summary.deactivated,
    activeCount:       c.summary.totalActive,
    expiringSoonCount: c.summary.expiringSoon,
    expiredCount:      c.summary.recentlyExpired,
    archivedCount:     c.summary.archivedExpired,
    deactivatedCount:  c.summary.deactivated,
    active:            c.activeClients,
    expiringSoon:      c.expiringSoon,
    expired:           c.recentlyExpired,
    archived:          c.archivedExpired,
    deactivated:       c.deactivated,
  };
}

/**
 * Fetch ALL users via paginated requests — used internally for membership analysis.
 * Arbox paginates at the given page_size; this walks every page until exhausted.
 */
async function getAllUsers({ limit: pageSize = 200 } = {}) {
  const all  = [];
  let   page = 1;
  // Arbox v3 rejects limit >= 500 — cap at 200 regardless of what callers request.
  const effectivePageSize = Math.min(pageSize, 200);
  while (true) {
    const { data } = await client.get('/v3/users', {
      params: { location_id: LOC(), limit: effectivePageSize, page },
    });
    const batch = data?.data ?? [];
    all.push(...batch);
    const nextUrl = data?.extra?.pagination?.next_page_url;
    if (!nextUrl || batch.length === 0) break;
    page++;
    if (page > 20) break; // safety cap — 20 pages × 200 = 4000 users max
  }
  return all;
}

// ── Active membership plans (from /v3/users/memberships) ──────────────────────

/**
 * Fetch all active membership plan records paginated.
 * Returns unique user counts for active memberships and expiring-soon.
 * This is the authoritative source for "מנויים פעילים" and "עומדים להסתיים".
 */
async function getMembershipStats({ daysWarning = 30 } = {}) {
  const now  = new Date();
  const warn = new Date(now.getTime() + daysWarning * 86400000);
  const all  = [];
  let page   = 1;
  try {
    while (true) {
      const { data } = await client.get('/v3/users/memberships', {
        params: { location_id: LOC(), limit: 200, page },
      });
      const batch = data?.data ?? [];
      all.push(...batch);
      if (!data?.extra?.pagination?.next_page_url || batch.length === 0) break;
      page++;
      if (page > 15) break;
    }
  } catch {
    return null; // non-fatal — callers fall back to users-endpoint counts
  }
  const active       = all.filter(m => m.active === 1 && !m.cancelled);
  const notExpired   = active.filter(m => !m.end_time || new Date(m.end_time) >= now);
  const expiringRecs = active.filter(m => m.end_time && new Date(m.end_time) >= now && new Date(m.end_time) <= warn);
  return {
    totalRecords:      all.length,
    activeRecords:     active.length,
    uniqueUsersActive: new Set(notExpired.map(m => m.user_id)).size,
    uniqueUsersExpiring: new Set(expiringRecs.map(m => m.user_id)).size,
    expiringRecords:   expiringRecs.length,
  };
}

// ── Staff directory ────────────────────────────────────────────────────────────

/**
 * Returns studio staff and instructors (user_role = staffMember).
 */
async function getStaff({ limit = 100 } = {}) {
  const all = await getAllUsers({ limit: 500 });
  return all.filter(u => u.user_role === 'staffMember');
}

// ── Attendance & no-shows (derived from schedule + at-risk member data) ───────

/**
 * Build an attendance report:
 *  - today's classes from Arbox schedule
 *  - members who haven't appeared in classes for 14+ days (local member store)
 *
 * Note: Arbox public API v3 does not expose per-class check-in records.
 * Attendance risk is derived from lastAttendance in the local member store.
 */
async function getAttendanceReport(store) {
  const today    = new Date().toISOString().split('T')[0];
  const todayCls = [];

  try {
    const sched = await getUpcomingClasses({ days: 1, limit: 30 });
    todayCls.push(...sched.filter(c => c.date === today));
  } catch { /* ignore */ }

  const cutoff7  = new Date(Date.now() - 7 * 86400000);   // Arbox "היעדרויות" window
  const cutoff30 = new Date(Date.now() - 30 * 86400000);

  const localMembers = store ? store.getAllMembers() : [];
  const atRisk = localMembers.filter(m => {
    if (m.status === 'churned') return false;
    if (!m.lastAttendance) return true;
    return new Date(m.lastAttendance) < cutoff7;   // 7-day window matches Arbox "היעדרויות"
  });

  const churned = localMembers.filter(m => m.status === 'churned');

  return {
    date:  today,
    todayClasses: todayCls.map(c => ({
      id: c.schedule_id, name: c.session_name,
      start: c.start_time, end: c.end_time,
      maxParticipants: c.max_participants,
      staff: c.staff_member?.name ?? '—',
      registrationLink: c.registration_link ?? null,
    })),
    atRisk14d:  atRisk.map(m => ({
      name: m.name, planType: m.planType, status: m.status,
      lastAttendance: m.lastAttendance,
      daysSince: m.lastAttendance
        ? Math.floor((Date.now() - new Date(m.lastAttendance)) / 86400000)
        : null,
    })),
    churned30d: churned.map(m => ({
      name: m.name, planType: m.planType, lastAttendance: m.lastAttendance,
    })),
    note: 'Per-class check-in records are not available in Arbox public API v3. At-risk data is from local member tracking.',
  };
}

// ── Retention health ──────────────────────────────────────────────────────────

/**
 * Compute retention health metrics from live Arbox data.
 */
async function getRetentionHealth(store) {
  const classified = await classifyMemberships({ limit: 500 }).catch(() => null);
  if (!classified) return { error: 'Failed to fetch Arbox data' };

  const s = classified.summary;
  const localMembers = store ? store.getAllMembers() : [];
  const localAtRisk  = localMembers.filter(m => m.status === 'at_risk').length;
  const localChurned = localMembers.filter(m => m.status === 'churned').length;

  // Retention rate uses active=1 as the ground truth
  const totalManaged   = s.totalActive + s.recentlyExpired + s.deactivated;
  const churnRate      = totalManaged > 0 ? Math.round(((s.recentlyExpired + s.deactivated) / totalManaged) * 100) : 0;
  const retentionRate  = 100 - churnRate;

  const recommendations = [];
  if (s.expiringSoon > 0)
    recommendations.push(`⚠️ ${s.expiringSoon} מנויים יפוגו בקרוב — לחדש מיידית`);
  if (s.recentlyExpired > 0)
    recommendations.push(`📉 ${s.recentlyExpired} פגו ב-90 יום האחרונים — מומלץ קמפיין חזרה דרך תומר`);
  if (s.archivedExpired > 0)
    recommendations.push(`🗄️ ${s.archivedExpired} בארכיון היסטורי (פגו >90 יום) — לא דורש פעולה מיידית`);
  if (s.deactivated > 0)
    recommendations.push(`🚫 ${s.deactivated} לקוחות בוטלו ללא תאריך סיום — לבדוק בממשק Arbox`);
  if (localAtRisk > 0)
    recommendations.push(`🏋️ ${localAtRisk} חברות בסיכון נשירה — לשלוח הודעת שימור (תומר)`);
  if (s.leadsWithPhone > 20)
    recommendations.push(`🎯 ${s.leadsWithPhone} לידים עם טלפון — לסנן חמים ולהקצות לתומר`);
  if (s.aggregators > 50)
    recommendations.push(`🤝 ${s.aggregators} Aggregator פעילים — לבדוק המרה למנוי ישיר`);
  if (recommendations.length === 0)
    recommendations.push('✅ אין התראות דחופות — מצב שימור יציב');

  return {
    summary: {
      totalUsers:        s.totalUsers,
      clients:           s.activeClients,    // 148 — alias used by renderRetentionKPIs
      activeClients:     s.activeClients,    // 148 — role=client, active=1
      activeMemberships: s.activeMemberships, // 161 — all active across roles
      expiringSoon:      s.expiringSoon,
      expiringClients:   s.expiringSoon,     // alias for renderRetentionKPIs
      recentlyExpired:   s.recentlyExpired,
      expiredClients:    s.recentlyExpired,  // alias for renderRetentionKPIs
      archivedExpired:   s.archivedExpired,
      deactivated:       s.deactivated,
      aggregators:       s.aggregators,
      leads:             s.leads,
      leadsWithPhone:    s.leadsWithPhone,
      staff:             s.staff,
      localAtRisk,
      localChurned,
      churnRate:         `${churnRate}%`,
      retentionRate:     `${retentionRate}%`,
      arboxLeads:        s.leads,
    },
    expiringClients: classified.expiringSoon.slice(0, 10).map(c => ({
      name: c._name, phone: c._phone,
      endDate: c.membership_end_date, daysLeft: c._daysLeft,
    })),
    expiredClients: classified.recentlyExpired.slice(0, 10).map(c => ({
      name: c._name, phone: c._phone,
      endDate: c.membership_end_date, daysAgo: Math.abs(c._daysLeft),
    })),
    deactivatedClients: classified.deactivated.slice(0, 5).map(c => ({
      name: c._name, phone: c._phone, created: c.created_time,
    })),
    recommendations,
    apiLimitations: classified.apiLimitations,
  };
}

// ── Legacy compatibility shims (called by barak_agent.js) ────────────────────

/** @deprecated Use getLeadByPhone + createLead instead. */
async function createMember({ firstName, lastName, phone, email }) {
  return createLead({ firstName, lastName, phone, email });
}

/** @deprecated Members are now at /v3/users — use getMemberByPhone. */
async function getMembershipStatus(userId) {
  const all = await getMembers({ limit: 500 });
  const m   = all.find(u => u.user_id === userId);
  if (!m) return null;
  return {
    status: m.active ? 'active' : 'inactive',
    start:  m.membership_start_date,
    end:    m.membership_end_date,
  };
}

/** @deprecated Use getUpcomingClasses. */
async function getRecentCheckIns(memberId) {
  logger.warn('getRecentCheckIns: check-in history not available in Arbox public API v3');
  return [];
}

/** @deprecated Use getUpcomingClasses + a separate booking flow. */
async function bookTrialClass(memberId, classId) {
  logger.warn('bookTrialClass: booking endpoint not yet available — contact Arbox support for /v3/bookings access');
  return { ok: false, reason: 'booking endpoint not available in current API plan' };
}

// ── Connection probe ──────────────────────────────────────────────────────────

/**
 * Probe Arbox with a lightweight read-only call.
 * Returns { ok, status, latencyMs, location?, error? }.
 */
async function testConnection() {
  const start = Date.now();
  try {
    const res = await client.get('/v3/locations', {
      params: { location_id: LOC() },
    });
    const loc = res.data?.data?.[0];
    return {
      ok:          true,
      status:      res.status,
      latencyMs:   Date.now() - start,
      location:    loc ? { id: loc.location_id, name: loc.location_name, address: loc.address } : null,
    };
  } catch (err) {
    return {
      ok:        false,
      status:    err.response?.status ?? null,
      latencyMs: Date.now() - start,
      error:     err.response?.data?.error?.message ?? err.message,
    };
  }
}

module.exports = {
  // Leads
  getLeads,
  getLeadByPhone,
  createLead,
  // Members
  getMembers,
  getAllUsers,
  getMemberByPhone,
  getMemberById,
  getMembershipStatus,
  // Detailed membership analytics
  classifyMemberships,
  getDetailedMembers,
  getMembershipStats,
  getStaff,
  getAttendanceReport,
  getRetentionHealth,
  // Schedule
  getUpcomingClasses,
  // Location
  getLocation,
  // Connection
  testConnection,
  // Legacy shims
  createMember,
  getRecentCheckIns,
  bookTrialClass,
};
