/**
 * Singleton lead store — shared by lead_agent, retention_agent, and manager_agent.
 *
 * Lead record shape:
 * {
 *   phone, name, score, status,        // core identity
 *   messageCount, firstSeen,           // engagement metrics
 *   lastActivity, introOfferSent,      // funnel state
 *   history,                           // last 20 conversation turns
 *   meta,                              // arbitrary per-lead flags
 * }
 *
 * Event types:
 *   message_in | message_out | intro_offer_sent | intro_redeemed
 *   crisis | score_update | re_engagement_sent | booking_confirmed | arbox_sync
 */

class LeadStore {
  constructor() {
    this._leads   = new Map();  // phone → LeadRecord
    this._members = new Map();  // memberId → MemberRecord
    this._events  = [];         // append-only log, capped at 500
  }

  // ── Lead CRUD ─────────────────────────────────────────────────────────────

  upsertLead(phone, updates) {
    const existing = this._leads.get(phone) ?? {
      phone,
      name:           null,
      score:          4,
      status:         'new',
      messageCount:   0,
      firstSeen:      new Date(),
      lastActivity:   new Date(),
      introOfferSent:     false,
      introOfferRedeemed: false,
      bookingConfirmed:   false,
      reEngagementCount:  0,
      lastReEngagementAt: null,
      arboxSynced:        false,
      arboxId:            null,
      history:            [],
      meta:               {},
    };
    const record = { ...existing, ...updates, lastActivity: new Date() };
    this._leads.set(phone, record);
    return record;
  }

  getLead(phone) {
    return this._leads.get(phone) ?? null;
  }

  getAllLeads() {
    return Array.from(this._leads.values());
  }

  deleteLead(phone) {
    this._leads.delete(phone);
  }

  /**
   * Reclassify a lead as a confirmed member WITHOUT deleting the record.
   * Preserves all conversation history, meta, name, and engagement metrics.
   * Sets status='converted_member' so all sales flows skip this record.
   *
   * Use this instead of deleteLead when the person has become (or was always)
   * a studio member. This preserves the conversation for audit and prevents
   * reappearance of the record on the next restart.
   */
  reclassifyAsConvertedMember(phone, { name = null, source = 'unknown' } = {}) {
    const existing = this._leads.get(phone);
    if (!existing) return null;
    // Never overwrite stop-statuses that reflect active ownership or communication
    // preferences. Membership identity and conversation ownership must not overwrite
    // each other during startup or reactive reclassification.
    //   opted_out:          communication preference — survives membership confirmation.
    //   human_owns:         staff is in an active conversation; don't silently change ownership.
    //   attribution_review: echo attribution unresolved; changing status would lose the hold.
    if (['opted_out', 'human_owns', 'attribution_review'].includes(existing.status)) {
      // Stamp the member fact in meta without changing the stop-status.
      const protected_ = {
        ...existing,
        name: name ?? existing.name,
        meta: {
          ...existing.meta,
          convertedAt:     new Date().toISOString(),
          convertedSource: source,
          isConfirmedMember: true,
        },
      };
      this._leads.set(phone, protected_);
      return protected_;
    }
    const updated = {
      ...existing,
      status: 'converted_member',
      score:  0,
      lastActivity: new Date(),
      name: name ?? existing.name,
      meta: {
        ...existing.meta,
        convertedAt:     new Date().toISOString(),
        convertedSource: source,
      },
    };
    this._leads.set(phone, updated);
    return updated;
  }

  // ── Event log ─────────────────────────────────────────────────────────────

  logEvent(type, phone, data = {}) {
    this._events.push({ ts: new Date(), type, phone, data });
    if (this._events.length > 500) this._events.shift();
  }

  getEvents({ type, phone, since, limit = 100 } = {}) {
    let ev = this._events;
    if (type)  ev = ev.filter(e => e.type === type);
    if (phone) ev = ev.filter(e => e.phone === phone);
    if (since) ev = ev.filter(e => e.ts >= since);
    return ev.slice(-limit);
  }

  // ── Aggregate queries (used by manager_agent) ─────────────────────────────

  /**
   * All leads in the sales/funnel view.
   * Excludes confirmed members and opted-out contacts.
   * human_owns / call_scheduled / escalated still appear in the funnel
   * view (staff need to see them) but are skipped by getSendableLeads().
   */
  getActiveLeads() {
    return this.getAllLeads().filter(l =>
      l.status !== 'converted_member' && l.status !== 'opted_out'
    );
  }

  /**
   * Leads eligible for automated outreach (Tomer worker, Barak follow-ups).
   * Never touches human_owns, call_scheduled, opted_out, escalated, crisis.
   * Use everywhere an automated message would fire without human review.
   */
  getSendableLeads() {
    // callback_requested: lead expressed time in AI flow, team was alerted, but no aptStore entry yet.
    // call_scheduled: aptStore appointment exists — confirmed by real scheduling mechanism.
    // Both must be excluded from automated re-engagement.
    const SKIP = new Set(['converted_member', 'opted_out', 'human_owns',
                          'call_scheduled', 'callback_requested', 'escalated', 'crisis']);
    return this.getAllLeads().filter(l => !SKIP.has(l.status));
  }

  getHotLeads()   { return this.getActiveLeads().filter(l => l.score >= 8); }
  getWarmLeads()  { return this.getActiveLeads().filter(l => l.score >= 5 && l.score < 8); }
  getColdLeads()  { return this.getActiveLeads().filter(l => l.score < 5); }
  getCrisisLeads(){ return this.getActiveLeads().filter(l => l.status === 'crisis'); }

  getDailyStats() {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const todayLeads  = this.getAllLeads().filter(l => l.firstSeen >= dayStart);
    const todayEvents = this.getEvents({ since: dayStart, limit: 200 });

    return {
      newLeadsToday:    todayLeads.length,
      messagesIn:       todayEvents.filter(e => e.type === 'message_in').length,
      messagesOut:      todayEvents.filter(e => e.type === 'message_out').length,
      introOffersSent:   todayEvents.filter(e => e.type === 'intro_offer_sent').length,
      introsRedeemed:    todayEvents.filter(e => e.type === 'intro_redeemed').length,
      bookingsToday:     todayEvents.filter(e => e.type === 'booking_confirmed').length,
      reEngagedToday:    todayEvents.filter(e => e.type === 're_engagement_sent').length,
      arboxSyncsToday:   todayEvents.filter(e => e.type === 'arbox_sync').length,
      crisesToday:       todayEvents.filter(e => e.type === 'crisis').length,
      hotLeadsTotal:     this.getHotLeads().length,
      warmLeadsTotal:    this.getWarmLeads().length,
      coldLeadsTotal:    this.getColdLeads().length,
      crisisActive:      this.getCrisisLeads().length,
      totalLeads:        this._leads.size,
      unsyncedLeads:     this.getAllLeads().filter(l => !l.arboxSynced).length,
      ...this.getMemberStats(),
    };
  }

  /**
   * Leads dormant for at least minDays that are eligible for automated re-engagement.
   * Uses getSendableLeads() — never re-contacts human_owns, call_scheduled, opted_out.
   */
  getDormantLeads(minDays = 3) {
    const cutoff = new Date(Date.now() - minDays * 86400000);
    return this.getSendableLeads()
      .filter(l => l.lastActivity && new Date(l.lastActivity) < cutoff)
      .sort((a, b) => new Date(a.lastActivity) - new Date(b.lastActivity));
  }

  getSystemHealth() {
    const all = this.getAllLeads();
    const avgScore = all.length
      ? Math.round(all.reduce((s, l) => s + l.score, 0) / all.length * 10) / 10
      : 0;

    return {
      status:      'online',
      totalLeads:  all.length,
      avgScore,
      hotLeads:    this.getHotLeads().length,
      crisisActive:this.getCrisisLeads().length,
      lastEventAt: this._events.at(-1)?.ts ?? null,
    };
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  // ── Member store (active/at-risk studio members) ──────────────────────────

  upsertMember(memberId, updates) {
    const existing = this._members.get(memberId) ?? {
      memberId,
      name:            null,
      phone:           null,
      planType:        null,
      memberSince:     new Date(),
      lastAttendance:  null,
      attendanceMonth: 0,
      status:          'active',
      arboxId:         null,
    };
    const record = { ...existing, ...updates };
    this._members.set(memberId, record);
    return record;
  }

  getMember(memberId)  { return this._members.get(memberId) ?? null; }
  getAllMembers()       { return Array.from(this._members.values()); }

  /** Members whose last attendance is older than minDays (or who have never attended). */
  getInactiveMembers(minDays = 14) {
    const cutoff = new Date(Date.now() - minDays * 86400000);
    return this.getAllMembers().filter(m => {
      if (m.status === 'churned') return false;
      if (!m.lastAttendance) return true;
      return new Date(m.lastAttendance) < cutoff;
    }).sort((a, b) => {
      const aT = a.lastAttendance ? new Date(a.lastAttendance).getTime() : 0;
      const bT = b.lastAttendance ? new Date(b.lastAttendance).getTime() : 0;
      return aT - bT; // oldest first
    });
  }

  getMemberStats() {
    const all     = this.getAllMembers();
    const active  = all.filter(m => m.status === 'active').length;
    const atRisk  = all.filter(m => m.status === 'at_risk').length;
    const churned = all.filter(m => m.status === 'churned').length;
    return { total: all.length, active, atRisk, churned };
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  clear() {
    this._leads.clear();
    this._members.clear();
    this._events.length = 0;
  }

  // ── Seed helpers (used by test_manager.js /seed command) ─────────────────

  seedDemoData() {
    const now     = Date.now();
    const minsAgo = (m) => new Date(now - m * 60000);
    const daysAgo = (d) => new Date(now - d * 86400000);

    const leads = [
      // Hot — synced to Arbox, intro offer sent but not redeemed yet
      {
        phone: '972501111001', name: 'מאיה לוי', score: 9, status: 'hot',
        messageCount: 4, introOfferSent: true, introOfferRedeemed: false,
        bookingConfirmed: false, reEngagementCount: 0, lastReEngagementAt: null,
        arboxSynced: true, arboxId: 'ARB-1001',
        firstSeen: minsAgo(90), lastActivity: minsAgo(12),
        history: [], meta: { introOfferSent: true },
      },
      // Hot — not yet synced, no intro offer sent
      {
        phone: '972501111002', name: 'רונית כהן', score: 8, status: 'hot',
        messageCount: 3, introOfferSent: false, introOfferRedeemed: false,
        bookingConfirmed: false, reEngagementCount: 0, lastReEngagementAt: null,
        arboxSynced: false, arboxId: null,
        firstSeen: minsAgo(45), lastActivity: minsAgo(5),
        history: [], meta: {},
      },
      // Warm — intro sent, not redeemed, silent 3 days → Tomer territory
      {
        phone: '972501111003', name: 'תמר ביטון', score: 6, status: 'warm',
        messageCount: 2, introOfferSent: true, introOfferRedeemed: false,
        bookingConfirmed: false, reEngagementCount: 1, lastReEngagementAt: daysAgo(3),
        arboxSynced: false, arboxId: null,
        firstSeen: daysAgo(5), lastActivity: daysAgo(3),
        history: [], meta: {},
      },
      // Warm — went silent 4 days, 0 re-engagements sent → due for first touch
      {
        phone: '972501111004', name: 'שירה אברהם', score: 5, status: 'warm',
        messageCount: 2, introOfferSent: false, introOfferRedeemed: false,
        bookingConfirmed: false, reEngagementCount: 0, lastReEngagementAt: null,
        arboxSynced: false, arboxId: null,
        firstSeen: daysAgo(6), lastActivity: daysAgo(4),
        history: [], meta: {},
      },
      // Cold — went silent 8 days, already had 1 re-engagement → due for second touch
      {
        phone: '972501111005', name: 'גלית מזרחי', score: 2, status: 'cold',
        messageCount: 1, introOfferSent: false, introOfferRedeemed: false,
        bookingConfirmed: false, reEngagementCount: 1, lastReEngagementAt: daysAgo(5),
        arboxSynced: false, arboxId: null,
        firstSeen: daysAgo(9), lastActivity: daysAgo(8),
        history: [], meta: {},
      },
      // Crisis — halted, awaiting human
      {
        phone: '972501111006', name: 'נועה שפירו', score: 1, status: 'crisis',
        messageCount: 3, introOfferSent: false, introOfferRedeemed: false,
        bookingConfirmed: false, reEngagementCount: 0, lastReEngagementAt: null,
        arboxSynced: false, arboxId: null,
        firstSeen: minsAgo(30), lastActivity: minsAgo(8),
        history: [], meta: {},
      },
    ];

    for (const l of leads) {
      this._leads.set(l.phone, { ...l });
      for (let i = 0; i < l.messageCount; i++) {
        this.logEvent('message_in',  l.phone, { name: l.name });
        this.logEvent('message_out', l.phone, {});
      }
      if (l.introOfferSent)               this.logEvent('intro_offer_sent',  l.phone, {});
      if (l.reEngagementCount > 0)        this.logEvent('re_engagement_sent', l.phone, { count: l.reEngagementCount });
      if (l.arboxSynced)                  this.logEvent('arbox_sync',         l.phone, { arboxId: l.arboxId });
      if (l.status === 'crisis')          this.logEvent('crisis',             l.phone, { category: 'distress' });
    }

    // ── Demo studio members ────────────────────────────────────────────────
    const members = [
      { memberId: 'M-001', name: 'דנה ישראלי',   phone: '972501200001', planType: 'Reformer Pilates', memberSince: daysAgo(180), lastAttendance: daysAgo(2),  attendanceMonth: 8,  status: 'active',  arboxId: 'ARB-M001' },
      { memberId: 'M-002', name: 'ליאת שמואל',   phone: '972501200002', planType: 'Strength Training', memberSince: daysAgo(90),  lastAttendance: daysAgo(5),  attendanceMonth: 5,  status: 'active',  arboxId: 'ARB-M002' },
      { memberId: 'M-003', name: 'אורה גולדברג',  phone: '972501200003', planType: 'Pilates Barre',    memberSince: daysAgo(260), lastAttendance: daysAgo(18), attendanceMonth: 1,  status: 'at_risk', arboxId: 'ARB-M003' },
      { memberId: 'M-004', name: 'רחל פרידמן',   phone: '972501200004', planType: 'Reformer Pilates', memberSince: daysAgo(45),  lastAttendance: daysAgo(22), attendanceMonth: 0,  status: 'at_risk', arboxId: 'ARB-M004' },
      { memberId: 'M-005', name: 'יעל כץ',        phone: '972501200005', planType: 'Concept Toning',   memberSince: daysAgo(120), lastAttendance: daysAgo(35), attendanceMonth: 0,  status: 'at_risk', arboxId: 'ARB-M005' },
      { memberId: 'M-006', name: 'נילי אוחיון',   phone: '972501200006', planType: 'ALL IN',           memberSince: daysAgo(300), lastAttendance: daysAgo(60), attendanceMonth: 0,  status: 'churned', arboxId: 'ARB-M006' },
      { memberId: 'M-007', name: 'שרית לוינסון',  phone: '972501200007', planType: 'Ashtanga Yoga',    memberSince: daysAgo(210), lastAttendance: daysAgo(1),  attendanceMonth: 10, status: 'active',  arboxId: 'ARB-M007' },
      { memberId: 'M-008', name: 'חגית מרקוס',    phone: '972501200008', planType: 'Strength Training', memberSince: daysAgo(60), lastAttendance: daysAgo(14), attendanceMonth: 2,  status: 'at_risk', arboxId: 'ARB-M008' },
    ];
    for (const m of members) {
      this._members.set(m.memberId, { ...m });
    }

    return leads.length;
  }
}

module.exports = new LeadStore();
