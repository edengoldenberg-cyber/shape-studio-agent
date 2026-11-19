'use strict';

/**
 * services/crm.js — the operational sales CRM layer.
 *
 * This is a VIEW and a set of OPERATIONS over the stores that already exist. It never
 * creates a parallel database of leads, tasks or callbacks:
 *   • leads, their history, ownership and meta      → utils/lead_store.js (persisted)
 *   • callbacks / "call scheduled"                  → utils/appointment_store.js
 *   • tasks (one shared board + reminders)          → utils/tomer_store.js  (read by owner_tasks)
 *   • message threads                               → the whatsapp inbox
 *   • member vs. lead classification                → utils/contact_kind.js
 *
 * The sales STAGE is a dimension of its own, independent of the lead's conversation
 * ownership (`status`: human_owns / opted_out / converted_member / automation states),
 * of the assignee, and of the tasks. Changing a stage never releases human ownership and
 * never sends a message.
 *
 * crmState (meta.crmState) is the record's place in the sales workflow:
 *   'active'   — in the working pipeline (default)
 *   'archived' — parked out of day-to-day work, kept; no proactive outreach; a genuinely
 *                scheduled callback is left alone
 *   'trashed'  — in the recycle bin: hidden from lists/search/metrics, future sales actions
 *                (callbacks, sales follow-up tasks, scheduled messages) stopped and recorded,
 *                history kept, restorable. Restoring does NOT revive the stopped actions.
 * Neither archive, trash nor delete is a "not interested" mark, and none of them touches a
 * Tomer service task or an Arbox membership.
 */

// ── Sales stages (exactly the owner's vocabulary, in order) ────────────────────────────
const SALES_STAGES = [
  { id: 'new',             he: 'חדש' },
  { id: 'needs',           he: 'בירור צרכים' },
  { id: 'arranging_call',  he: 'תיאום שיחה' },
  { id: 'call_scheduled',  he: 'שיחה נקבעה' },
  { id: 'trial_scheduled', he: 'ניסיון נקבע' },
  { id: 'trial_attended',  he: 'הגיע לניסיון' },
  { id: 'registered',      he: 'נרשם' },
  { id: 'lost',            he: 'לא נסגר' },
];
const STAGE_IDS = new Set(SALES_STAGES.map(s => s.id));
const STAGE_HE = Object.fromEntries(SALES_STAGES.map(s => [s.id, s.he]));

const SAVED_VIEWS = [
  { id: 'today',          he: 'לטיפול היום' },
  { id: 'overdue',        he: 'באיחור' },
  { id: 'waiting_client', he: 'ממתינים ללקוח' },
  { id: 'no_next_action', he: 'ללא פעולה הבאה' },
  { id: 'trials_soon',    he: 'ניסיונות קרובים' },
  { id: 'no_show',        he: 'לא הגיעו' },
  { id: 'registered',     he: 'נרשמו' },
];

const CRM_TASK_TYPE = 'sales_followup';   // lead-scoped sales task, lives in tomer_store, shown on the one board

// ── phone helpers ──────────────────────────────────────────────────────────────────────
const onlyDigits = p => String(p ?? '').replace(/\D/g, '');
/** National significant number: drop a 972 country code or a single leading 0. */
function nsn(p) {
  let d = onlyDigits(p);
  if (d.startsWith('972')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return d;
}
/** A query (any of 05x / 972 / spaced / dashed / a fragment) against a stored E.164 phone. */
function phoneMatches(query, phone) {
  const q = onlyDigits(query);
  if (!q) return false;
  const full = onlyDigits(phone), leadNsn = nsn(phone), qNsn = nsn(query);
  return full.includes(q) || leadNsn.includes(q) || (qNsn && leadNsn.includes(qNsn));
}

function createCrm({
  store, aptStore, tomerStore, inbox, persist, logger,
  normalizePhone, isMember = () => false, kindOf = null, classify = null, getThread = null,
  broadcast = () => {}, now = () => new Date(),
}) {
  const log = logger ?? { info() {}, warn() {}, error() {} };
  const iso = d => (d instanceof Date ? d.toISOString() : (d ?? null));
  const toTime = d => { const t = Date.parse(d); return Number.isFinite(t) ? t : null; };

  // ── crmState ────────────────────────────────────────────────────────────────────────
  const crmStateOf = lead => lead?.meta?.crmState ?? 'active';
  const isActiveState = lead => crmStateOf(lead) === 'active';

  // ── central classification (the SAME one the system uses) ─────────────────────────────
  // A sales lead only. Members, aggregators, staff numbers, test batches and non-sales
  // "contact" records are classified by utils/contact_kind and kept OUT of the funnel, its
  // counts and its reports. `classify()` returns the batch-aware Map(phone→{kind,label,salesList})
  // exactly as the old screen used it — it alone can flag a test batch (per-lead kindOf cannot).
  // Each public method computes the map ONCE and passes it down. With nothing injected (unit
  // tests) everything is treated as a sales lead.
  function classMap() { if (!classify) return null; try { return classify(); } catch (e) { log.warn('[crm] classify failed', { error: e.message }); return null; } }
  function kindInfo(lead, map) { const k = map ? map.get(lead.phone) : null; if (k) return k; if (!kindOf) return null; try { return kindOf(lead); } catch { return null; } }
  function salesOf(lead, map) { const k = kindInfo(lead, map); return k ? k.salesList === true : true; }

  // ── ownership of the conversation (barak / staff), independent of stage and assignee ──
  function ownerOf(lead) {
    const st = lead?.status;
    if (st === 'human_owns') return 'staff';
    if (st === 'opted_out') return 'opted_out';
    if (st === 'converted_member' || lead?.meta?.isConfirmedMember) return 'member';
    return 'barak';
  }

  // ── the open callback appointment for a lead (if any) ─────────────────────────────────
  const openCallback = phone => { try { return aptStore.getActiveCallback(phone); } catch { return null; } };
  const latestCallback = phone => {
    try { return aptStore.getAll().filter(a => a.leadPhone === phone)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null; } catch { return null; }
  };

  // ── open sales tasks for a lead (from the shared task store) ───────────────────────────
  const salesTasks = phone => {
    try { return tomerStore.getTasks({ phone }).filter(t => t.type === CRM_TASK_TYPE); } catch { return []; }
  };
  const openSalesTasks = phone => salesTasks(phone).filter(t => t.status === 'open' || t.status === 'eden_assigned');

  // ── derive a DEFAULT stage from real signals (an explicit meta.salesStage always wins) ─
  function deriveStage(lead) {
    const m = lead.meta ?? {}, qd = m.qualData ?? {};
    if (ownerOf(lead) === 'member') return 'registered';                 // Arbox-confirmed member = registered (verified)
    if (m.trialAttendedAt) return 'trial_attended';
    if (m.trialScheduledAt) return 'trial_scheduled';
    const apt = openCallback(lead.phone);
    if (apt && apt.status === 'confirmed') return 'call_scheduled';
    if (apt || m.awaitingCallbackTime || m.pendingCallbackConfirm || lead.status === 'callback_requested' || lead.status === 'call_scheduled') return 'call_scheduled';
    if (qd.callProposed || m.leadBrief) return 'arranging_call';
    if (qd.registrationDeclined || lead.status === 'call_cancelled') return 'lost';
    if (qd.fitnessInterest || m.interest || (lead.messageCount ?? 0) > 1) return 'needs';
    return 'new';
  }
  const stageOf = lead => (STAGE_IDS.has(lead?.meta?.salesStage) ? lead.meta.salesStage : deriveStage(lead));
  const stageSetManually = lead => STAGE_IDS.has(lead?.meta?.salesStage);

  // ── next action (the owner-visible "פעולה הבאה") ──────────────────────────────────────
  function nextActionOf(lead) {
    const m = lead.meta ?? {};
    if (m.nextAction?.text) return { text: m.nextAction.text, dueAt: m.nextAction.dueAt ?? null, source: 'manual' };
    const apt = openCallback(lead.phone);
    if (apt) return { text: 'להתקשר ולרשום את תוצאת השיחה', dueAt: iso(apt.scheduledAt) ?? null, source: 'callback' };
    const t = openSalesTasks(lead.phone)[0];
    if (t) return { text: t.summary ?? 'משימת מעקב', dueAt: t.dueAt ?? null, source: 'task' };
    if (m.awaitingCallbackTime) return { text: 'ממתין שהליד ימסור מועד לשיחה', dueAt: null, source: 'waiting' };
    return null;
  }

  // ── source / interest / tags / names — facts, kept apart from AI estimates ─────────────
  const sourceOf = lead => lead.meta?.source ?? lead.meta?.leadSource ?? null;            // never invented
  const interestOf = lead => lead.meta?.interest ?? lead.meta?.qualData?.fitnessInterest ?? lead.meta?.leadBrief?.workoutStyle ?? null;
  const confirmedNameOf = lead => lead.meta?.confirmedName ?? lead.meta?.qualData?.confirmedName ?? null;
  const displayNameOf = lead => confirmedNameOf(lead) ?? lead.name ?? null;
  const tagsOf = lead => Array.isArray(lead.meta?.tags) ? lead.meta.tags : [];

  // ── enrich one lead into a list row ───────────────────────────────────────────────────
  function row(lead, map = null) {
    const stage = stageOf(lead), na = nextActionOf(lead), apt = openCallback(lead.phone);
    const kind = kindInfo(lead, map);
    return {
      phone: lead.phone,
      name: displayNameOf(lead),
      waName: lead.name ?? null,
      confirmedName: confirmedNameOf(lead),
      stage, stageHe: STAGE_HE[stage], stageSetManually: stageSetManually(lead),
      crmState: crmStateOf(lead),
      owner: ownerOf(lead), status: lead.status,
      assignee: lead.meta?.assignee ?? null,
      source: sourceOf(lead), interest: interestOf(lead),
      tags: tagsOf(lead),
      score: lead.score ?? null,
      messageCount: lead.messageCount ?? 0,
      firstSeen: iso(lead.firstSeen), lastActivity: iso(lead.lastActivity),
      nextAction: na,
      callbackAt: apt ? iso(apt.scheduledAt) : null,
      callbackStatus: apt ? apt.status : null,
      openTasks: openSalesTasks(lead.phone).length,
      kind: kind?.kind ?? null, kindLabel: kind?.label ?? null,
      createdManually: !!lead.meta?.crmCreatedManually,
    };
  }

  // ── saved-view predicates ─────────────────────────────────────────────────────────────
  function matchesView(lead, view, t) {
    const stage = stageOf(lead), na = nextActionOf(lead), m = lead.meta ?? {};
    const dayStart = new Date(t); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(t); dayEnd.setHours(23, 59, 59, 999);
    const naDue = na?.dueAt ? toTime(na.dueAt) : null;
    switch (view) {
      case 'today':
        return (naDue != null && naDue <= dayEnd.getTime()) || openSalesTasks(lead.phone).length > 0 ||
          (openCallback(lead.phone)?.scheduledAt && toTime(iso(openCallback(lead.phone).scheduledAt)) <= dayEnd.getTime());
      case 'overdue':
        return naDue != null && naDue < dayStart.getTime();
      case 'waiting_client':
        return !!m.awaitingCallbackTime || !!m.pendingCallbackConfirm || (stage === 'arranging_call' && !openCallback(lead.phone));
      case 'no_next_action':
        return !na && !['registered', 'lost'].includes(stage);
      case 'trials_soon':
        return stage === 'trial_scheduled' && m.trialScheduledAt && toTime(m.trialScheduledAt) >= t;
      case 'no_show':
        return stage === 'trial_scheduled' && m.trialScheduledAt && toTime(m.trialScheduledAt) < t;
      case 'registered':
        return stage === 'registered';
      default: return true;
    }
  }

  // ── search across ALL records ─────────────────────────────────────────────────────────
  function search({ q = '', stage = null, assignee = null, source = null, interest = null,
    owner = null, tag = null, hasTask = null, activitySince = null, view = null,
    crmState = 'active', sort = 'recent', limit = 500 } = {}) {
    const t = now().getTime();
    const qTrim = String(q ?? '').trim();
    const map = classMap();
    const all = store.getAllLeads();
    let rows = all.filter(lead => {
      // crmState gate: 'active' default hides archived+trashed; 'trash' shows only trashed; 'archive' only archived; 'all' everything
      const cs = crmStateOf(lead);
      if (crmState === 'active' && cs !== 'active') return false;
      if (crmState === 'trash' && cs !== 'trashed') return false;
      if (crmState === 'archive' && cs !== 'archived') return false;
      // the CRM funnel is sales leads only (same classification the system uses). Members / staff /
      // test / non-sales contacts never enter the active pipeline, its counts or its reports. The
      // 'registered' view is the exception: it shows leads that became members (sales history kept).
      if (crmState === 'active' && view !== 'registered' && !salesOf(lead, map)) return false;
      if (qTrim) {
        const hay = [displayNameOf(lead), lead.name, ...(tagsOf(lead))].filter(Boolean).join(' ').toLowerCase();
        const textHit = hay.includes(qTrim.toLowerCase());
        const phoneHit = /\d/.test(qTrim) && phoneMatches(qTrim, lead.phone);
        if (!textHit && !phoneHit) return false;
      }
      if (stage && stageOf(lead) !== stage) return false;
      if (owner && ownerOf(lead) !== owner) return false;
      if (assignee && (lead.meta?.assignee ?? null) !== assignee) return false;
      if (source && sourceOf(lead) !== source) return false;
      if (interest && interestOf(lead) !== interest) return false;
      if (tag && !tagsOf(lead).includes(tag)) return false;
      if (hasTask === true && openSalesTasks(lead.phone).length === 0) return false;
      if (hasTask === false && openSalesTasks(lead.phone).length > 0) return false;
      if (activitySince) { const la = toTime(iso(lead.lastActivity)); if (la == null || la < toTime(activitySince)) return false; }
      if (view && !matchesView(lead, view, t)) return false;
      return true;
    }).map(l => row(l, map));

    const stageOrder = Object.fromEntries(SALES_STAGES.map((s, i) => [s.id, i]));
    const cmp = {
      recent:   (a, b) => (toTime(b.lastActivity) ?? 0) - (toTime(a.lastActivity) ?? 0),
      newest:   (a, b) => (toTime(b.firstSeen) ?? 0) - (toTime(a.firstSeen) ?? 0),
      due:      (a, b) => (toTime(a.nextAction?.dueAt) ?? Infinity) - (toTime(b.nextAction?.dueAt) ?? Infinity),
      priority: (a, b) => (b.score ?? 0) - (a.score ?? 0) || (stageOrder[b.stage] - stageOrder[a.stage]),
      stage:    (a, b) => (stageOrder[a.stage] - stageOrder[b.stage]) || ((toTime(b.lastActivity) ?? 0) - (toTime(a.lastActivity) ?? 0)),
    }[sort] ?? null;
    if (cmp) rows.sort(cmp);
    const total = rows.length;
    const byStage = {}; for (const r of rows) byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
    return { ok: true, rows: rows.slice(0, limit), total, byStage };
  }

  // counts for the whole active pipeline, per stage — for the board columns / badges
  function stageCounts() {
    const out = Object.fromEntries(SALES_STAGES.map(s => [s.id, 0]));
    const map = classMap();
    for (const lead of store.getAllLeads()) { if (crmStateOf(lead) === 'active' && salesOf(lead, map)) out[stageOf(lead)]++; }
    return out;
  }

  // ── the full lead card ────────────────────────────────────────────────────────────────
  function timelineOf(phone) {
    const items = [];
    try { for (const e of store.getEvents({ phone, limit: 200 })) items.push({ at: iso(e.ts), kind: 'event', type: e.type, data: e.data ?? {} }); } catch {}
    const th = getThread ? getThread(phone) : null;
    for (const msg of (th?.messages ?? [])) items.push({ at: iso(msg.timestamp), kind: 'message', dir: msg.direction, agent: msg.agentId ?? msg.meta?.agent ?? null, len: String(msg.text ?? '').length, text: msg.text ?? '' });
    try { for (const a of aptStore.getAll().filter(x => x.leadPhone === phone)) items.push({ at: iso(a.createdAt), kind: 'callback', status: a.status, scheduledAt: iso(a.scheduledAt), rawTime: a.rawTime ?? null }); } catch {}
    for (const tk of salesTasks(phone)) items.push({ at: tk.createdAt, kind: 'task', status: tk.status, summary: tk.summary, outcome: tk.resolutionNote ?? null, assignedTo: tk.assignedTo ?? null });
    return items.filter(x => x.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  function card(phone) {
    const lead = store.getLead(phone);
    if (!lead) return null;
    const m = lead.meta ?? {};
    return {
      ...row(lead),
      firstSeen: iso(lead.firstSeen), lastActivity: iso(lead.lastActivity),
      objections: Array.isArray(m.objections) ? m.objections : [],
      notes: Array.isArray(m.notes) ? m.notes : [],
      calls: (Array.isArray(m.calls) ? m.calls : []).slice(-20),
      registration: registrationOf(lead),
      trialInfo: { scheduledAt: m.trialScheduledAt ?? null, scheduledBy: m.trialScheduledBy ?? null, attendedAt: m.trialAttendedAt ?? null, attendedSource: m.trialAttendedSource ?? null },
      lostReason: m.lostReason ?? null,
      summary: m.leadBrief ? { text: m.qualProfile?.qualificationReason ?? null, goal: m.leadBrief?.goal ?? null, source: 'AI', at: m.briefGeneratedAt ?? null } : null,
      qualProfile: m.qualProfile ?? null,          // AI estimate — labelled as such in the UI
      arbox: { synced: !!lead.arboxSynced, id: lead.arboxId ?? null },
      humanOwns: lead.status === 'human_owns' ? { since: m.humanOwnsSince ?? null, by: m.humanOwnsBy ?? null, reason: m.humanOwnsReason ?? null } : null,
      optedOut: lead.status === 'opted_out' ? { at: m.optedOutAt ?? null } : null,
      registrationDeclined: !!m.qualData?.registrationDeclined,
      callback: (() => { const a = openCallback(phone) ?? latestCallback(phone); return a ? { id: a.id, status: a.status, scheduledAt: iso(a.scheduledAt), rawTime: a.rawTime ?? null } : null; })(),
      tasks: salesTasks(phone).map(t => ({ id: t.id, status: t.status, summary: t.summary, dueAt: t.dueAt ?? null, assignedTo: t.assignedTo ?? null, outcome: t.resolutionNote ?? null, createdAt: t.createdAt })),
      timeline: timelineOf(phone),
      trashedAt: m.trashedAt ?? null, archivedAt: m.archivedAt ?? null,
    };
  }

  // ── mutations (none of these ever sends a message) ────────────────────────────────────
  function save() { try { persist.saveLeads(store); } catch (e) { log.warn('[crm] save failed', { error: e.message }); } }
  function patchMeta(phone, patch) { const l = store.getLead(phone); if (!l) return null; const r = store.upsertLead(phone, { meta: { ...(l.meta ?? {}), ...patch } }); save(); return r; }

  function createLead({ phone, name = null, interest = null, source = null, tags = [], assignee = null, confirmedName = null, by = 'צוות', note = null }) {
    const norm = normalizePhone(phone);
    if (!norm) return { ok: false, error: 'invalid_phone' };
    const existing = store.getLead(norm);
    if (existing) return { ok: false, error: 'duplicate', existing: { phone: norm, name: displayNameOf(existing), crmState: crmStateOf(existing), stage: stageOf(existing) } };
    const meta = { crmState: 'active', crmCreatedManually: true, crmCreatedAt: iso(now()), crmCreatedBy: by, source: source ?? 'ידני', tags: Array.isArray(tags) ? tags.filter(Boolean) : [] };
    if (interest) meta.interest = interest;
    if (confirmedName) meta.confirmedName = confirmedName;
    if (assignee) meta.assignee = assignee;
    if (note) meta.notes = [{ text: String(note).slice(0, 2000), at: iso(now()), by }];
    store.upsertLead(norm, { name: name ?? null, status: 'new', score: 4, meta });     // status 'new', NOT contacted — no message is ever sent here
    store.logEvent('crm_lead_created', norm, { by, source: meta.source });
    save(); broadcast('crm_lead', { phone: norm });
    log.info('[crm] lead created manually', { by });
    return { ok: true, phone: norm, card: card(norm) };
  }

  const EDITABLE = new Set(['interest', 'source', 'confirmedName', 'assignee']);
  function updateLead(phone, fields = {}, { by = 'צוות' } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    const patch = {};
    for (const [k, v] of Object.entries(fields)) { if (EDITABLE.has(k)) patch[k] = (v === '' ? null : v); }
    if ('tags' in fields && Array.isArray(fields.tags)) patch.tags = fields.tags.filter(Boolean).map(s => String(s).slice(0, 40)).slice(0, 20);
    if ('nextAction' in fields) patch.nextAction = fields.nextAction && fields.nextAction.text ? { text: String(fields.nextAction.text).slice(0, 300), dueAt: fields.nextAction.dueAt ?? null, setBy: by, setAt: iso(now()) } : null;
    if ('objections' in fields && Array.isArray(fields.objections)) patch.objections = fields.objections.filter(Boolean).map(s => String(s).slice(0, 200)).slice(0, 20);
    if (!Object.keys(patch).length) return { ok: true, phone, card: card(phone), unchanged: true };
    patchMeta(phone, patch);
    store.logEvent('crm_lead_edited', phone, { by, fields: Object.keys(patch) });
    broadcast('crm_lead', { phone });
    return { ok: true, phone, card: card(phone) };
  }

  function setStage(phone, stage, { by = 'צוות' } = {}) {
    if (!STAGE_IDS.has(stage)) return { ok: false, error: 'invalid_stage' };
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    const from = stageOf(lead);
    // stage is independent: it does NOT change `status` (ownership / automation) and sends nothing
    patchMeta(phone, { salesStage: stage, salesStageSetAt: iso(now()), salesStageSetBy: by });
    store.logEvent('crm_stage_changed', phone, { from, to: stage, by });
    broadcast('crm_lead', { phone });
    return { ok: true, phone, from, to: stage, card: card(phone) };
  }

  function addNote(phone, text, { by = 'צוות' } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    const t = String(text ?? '').trim(); if (!t) return { ok: false, error: 'empty' };
    const notes = [...(Array.isArray(lead.meta?.notes) ? lead.meta.notes : []), { text: t.slice(0, 2000), at: iso(now()), by }];
    patchMeta(phone, { notes });
    store.logEvent('crm_note_added', phone, { by });
    broadcast('crm_lead', { phone });
    return { ok: true, phone, card: card(phone) };
  }

  // ── archive / trash / restore ─────────────────────────────────────────────────────────
  function openCallbackIdsFor(phone) {
    try { return aptStore.getAll().filter(a => a.leadPhone === phone && aptStore.ACTIVE_STATUSES.has(a.status)).map(a => a.id); } catch { return []; }
  }
  function impact(phone) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    return { ok: true, phone, name: displayNameOf(lead), crmState: crmStateOf(lead),
      openCallbacks: openCallbackIdsFor(phone).length, openSalesTasks: openSalesTasks(phone).length,
      optedOut: lead.status === 'opted_out', registrationDeclined: !!lead.meta?.qualData?.registrationDeclined };
  }

  /** Stop the lead's future SALES actions (callbacks + sales tasks). Member-service tasks are untouched. */
  function stopFutureSalesActions(phone, reason) {
    let cancelledCallbacks = 0, cancelledTasks = 0;
    for (const id of openCallbackIdsFor(phone)) { try { const r = aptStore.cancel(id, { by: 'system', reason }); if (r.ok && !r.unchanged) cancelledCallbacks++; } catch (e) { log.warn('[crm] callback cancel failed', { error: e.message }); } }
    for (const t of openSalesTasks(phone)) { try { tomerStore.updateTask(t.id, { status: 'cancelled', resolutionNote: reason, resolvedAt: iso(now()) }); cancelledTasks++; } catch (e) { log.warn('[crm] task cancel failed', { error: e.message }); } }
    return { cancelledCallbacks, cancelledTasks };
  }

  // Only the hold that THIS removal creates is ours to clear later. A pre-existing hold (a refusal,
  // an identity review, any other block) is left exactly as it is, and restore never lifts it.
  const holdPatch = lead => (lead.meta?.outreachHold ? {} : { outreachHold: true, outreachHoldSetByCrm: true });

  function trash(phone, { by = 'צוות' } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    const stopped = stopFutureSalesActions(phone, 'lead_trashed');
    patchMeta(phone, { crmState: 'trashed', trashedAt: iso(now()), trashedBy: by, archivedAt: null, ...holdPatch(lead) });
    store.logEvent('crm_lead_trashed', phone, { by, ...stopped });
    broadcast('crm_lead', { phone });
    log.info('[crm] lead trashed', { by, ...stopped });
    return { ok: true, phone, stopped };
  }

  function archive(phone, { by = 'צוות' } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    // parked out of day-to-day work: no proactive outreach, but a genuinely scheduled callback is left alone
    patchMeta(phone, { crmState: 'archived', archivedAt: iso(now()), archivedBy: by, ...holdPatch(lead) });
    store.logEvent('crm_lead_archived', phone, { by });
    broadcast('crm_lead', { phone });
    return { ok: true, phone };
  }

  function restore(phone, { by = 'צוות' } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    const was = crmStateOf(lead);
    if (was === 'active') return { ok: true, phone, unchanged: true };
    // restoring does NOT revive the callbacks / reminders / messages that trashing stopped, and sends nothing.
    // It lifts ONLY the hold that the archive/trash itself placed — never a refusal or another block.
    const m = lead.meta ?? {};
    const liftHold = m.outreachHoldSetByCrm ? { outreachHold: false, outreachHoldSetByCrm: null } : {};
    patchMeta(phone, { crmState: 'active', trashedAt: null, archivedAt: null, ...liftHold, restoredAt: iso(now()), restoredBy: by });
    store.logEvent('crm_lead_restored', phone, { by, from: was });
    broadcast('crm_lead', { phone });
    return { ok: true, phone, from: was };
  }

  /**
   * Permanent delete — recycle bin only, caller must prove admin + explicit confirmation.
   * A refusal (opted_out / declined registration) is NOT hard-deleted: deleting it could let a
   * future inbound restart unwanted outreach. It stays (suggest archive). A Tomer service task or
   * an Arbox membership is never touched here.
   */
  function permanentDelete(phone, { by = 'מנהל', adminConfirmed = false } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    if (crmStateOf(lead) !== 'trashed') return { ok: false, error: 'not_in_trash' };
    if (!adminConfirmed) return { ok: false, error: 'confirmation_required' };
    if (lead.status === 'opted_out' || lead.meta?.qualData?.registrationDeclined) {
      return { ok: false, error: 'refusal_protected', message: 'רשומת סירוב אינה נמחקת לצמיתות — כדי שלא יתחדשו פניות. אפשר להשאירה בארכיון.' };
    }
    store.deleteLead(phone);
    store.logEvent('crm_lead_deleted', phone, { by });     // the event log is capped; the deletion itself is the record
    save(); broadcast('crm_lead', { phone, deleted: true });
    log.info('[crm] lead permanently deleted', { by });
    return { ok: true, phone, deleted: true };
  }

  // ── lead-scoped sales task (lives in tomer_store, shown on the one board + reminders) ──
  function createLeadTask(phone, { summary, dueAt = null, assignedTo = null, by = 'צוות', priority = 'normal' }) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    if (!String(summary ?? '').trim()) return { ok: false, error: 'empty' };
    const t = tomerStore.createTask({ type: CRM_TASK_TYPE, phone, memberName: displayNameOf(lead), summary: String(summary).slice(0, 300), priority });
    const patch = { createdBy: by, title: 'מעקב מכירה' };
    if (dueAt) patch.dueAt = dueAt;
    if (assignedTo) { patch.assignedTo = assignedTo; patch.status = 'eden_assigned'; }
    tomerStore.updateTask(t.id, patch);
    store.logEvent('crm_task_created', phone, { by, taskId: t.id });
    broadcast('crm_lead', { phone });
    return { ok: true, phone, taskId: t.id };
  }

  /** Update a CRM sales task — explicit staff action (viewing the card never does this). Only sales tasks. */
  function updateLeadTask(taskId, { status = null, outcome = null, assignedTo = null, dueAt = null, by = 'צוות' } = {}) {
    const all = (() => { try { return tomerStore.getTasks({}); } catch { return []; } })();
    const t = all.find(x => x.id === taskId);
    if (!t) return { ok: false, error: 'not_found' };
    if (t.type !== CRM_TASK_TYPE) return { ok: false, error: 'not_a_sales_task' };   // a member-service task is Tomer's, not the CRM's
    const patch = {};
    if (status && ['open', 'eden_assigned', 'in_progress', 'resolved', 'cancelled'].includes(status)) { patch.status = status; if (status === 'resolved') patch.resolvedAt = iso(now()); }
    if (outcome != null) patch.resolutionNote = String(outcome).slice(0, 300);
    if (assignedTo !== null) patch.assignedTo = assignedTo || null;
    if (dueAt !== null) patch.dueAt = dueAt || null;
    if (!Object.keys(patch).length) return { ok: true, taskId, unchanged: true };
    tomerStore.updateTask(taskId, patch);
    store.logEvent('crm_task_updated', t.phone, { by, taskId, fields: Object.keys(patch) });
    broadcast('crm_lead', { phone: t.phone });
    return { ok: true, taskId, phone: t.phone };
  }

  // ── call logging + outcomes (§7) ──────────────────────────────────────────────────────
  // A dialled number is NOT proof a call happened; logging the outcome is a separate, explicit act.
  const CALL_OUTCOMES = {
    answered:           { he: 'ענה/תה', stage: null },
    no_answer:          { he: 'לא ענה/תה', stage: null },
    call_back_requested:{ he: 'ביקש/ה לחזור', stage: 'arranging_call' },
    undecided:          { he: 'מתלבט/ת', stage: null },
    trial_scheduled:    { he: 'נקבע ניסיון', stage: 'trial_scheduled' },
    registered:         { he: 'נרשם/ה', stage: 'registered' },
    not_interested:     { he: 'לא מעוניין/ת', stage: 'lost' },
  };
  function logCall(phone, { outcome, note = null, followUpAt = null, by = 'צוות' } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    const o = CALL_OUTCOMES[outcome]; if (!o) return { ok: false, error: 'invalid_outcome' };
    const m = lead.meta ?? {}, at = iso(now());
    const calls = [...(Array.isArray(m.calls) ? m.calls : []), { at, outcome, note: note ? String(note).slice(0, 500) : null, by, followUpAt: followUpAt ?? null }];
    const patch = { calls };
    // staff report — never confused with Arbox verification (§9)
    if (outcome === 'registered') { patch.salesStage = 'registered'; patch.registeredSource = m.registeredSource === 'arbox' ? 'arbox' : 'staff_report'; patch.registeredAt = m.registeredAt ?? at; }
    else if (outcome === 'not_interested') { patch.salesStage = 'lost'; patch.lostReason = note ? String(note).slice(0, 120) : 'לא מעוניין/ת'; patch.lostAt = at; }
    else if (outcome === 'trial_scheduled') { patch.salesStage = 'trial_scheduled'; patch.trialScheduledAt = followUpAt ?? m.trialScheduledAt ?? null; patch.trialScheduledBy = by; patch.trialSource = 'staff_plan'; }
    else if (o.stage && !stageSetManually(lead)) patch.salesStage = o.stage;
    if (followUpAt && outcome !== 'trial_scheduled') patch.nextAction = { text: `מעקב אחרי שיחה (${o.he})`, dueAt: followUpAt, setBy: by, setAt: at };
    patchMeta(phone, patch);
    store.logEvent('crm_call_logged', phone, { by, outcome });
    // after "no answer" / "undecided" a follow-up task is OFFERED (created only when a date was given); never a send
    if (followUpAt && ['no_answer', 'undecided', 'call_back_requested'].includes(outcome)) {
      try { const t = tomerStore.createTask({ type: CRM_TASK_TYPE, phone, memberName: displayNameOf(lead), summary: `מעקב: ${o.he}${note ? ' — ' + note : ''}`, priority: 'normal' }); tomerStore.updateTask(t.id, { dueAt: followUpAt, createdBy: by, title: 'מעקב מכירה' }); } catch (e) { log.warn('[crm] follow-up task failed', { error: e.message }); }
    }
    broadcast('crm_lead', { phone });
    return { ok: true, phone, card: card(phone) };
  }

  // ── trials & conversion (§9) ──────────────────────────────────────────────────────────
  function trial(phone, { action, at = null, note = null, by = 'צוות' } = {}) {
    const lead = store.getLead(phone); if (!lead) return { ok: false, error: 'not_found' };
    const stamp = iso(now());
    if (action === 'schedule') { patchMeta(phone, { trialScheduledAt: at ?? null, trialScheduledBy: by, trialSource: 'staff_plan', salesStage: 'trial_scheduled', trialNote: note ? String(note).slice(0, 300) : null }); store.logEvent('crm_trial_scheduled', phone, { by, at }); }
    else if (action === 'attended') { patchMeta(phone, { trialAttendedAt: at ?? stamp, trialAttendedBy: by, trialAttendedSource: 'staff_report', salesStage: 'trial_attended' }); store.logEvent('crm_trial_attended', phone, { by }); }
    else return { ok: false, error: 'invalid_action' };
    broadcast('crm_lead', { phone });
    return { ok: true, phone, card: card(phone) };
  }

  // Is this lead a registered member, and is it VERIFIED by Arbox or only a staff report?
  function registrationOf(lead) {
    const m = lead.meta ?? {};
    const arboxVerified = lead.status === 'converted_member' || m.isConfirmedMember === true || ownerOf(lead) === 'member';
    if (arboxVerified) return { registered: true, verified: true, source: 'arbox', at: m.convertedAt ?? null };
    if (m.registeredSource === 'staff_report' || stageOf(lead) === 'registered') return { registered: true, verified: false, source: 'staff_report', at: m.registeredAt ?? null };
    return { registered: false, verified: false, source: null, at: null };
  }

  // ── "my day today" (§1) ───────────────────────────────────────────────────────────────
  function lastInbound(phone) { const th = getThread ? getThread(phone) : null; const ms = th?.messages ?? []; for (let i = ms.length - 1; i >= 0; i--) if (ms[i].direction === 'in') return ms[i]; return null; }
  function awaitingReply(phone) { const th = getThread ? getThread(phone) : null; const ms = th?.messages ?? []; let lastIn = null, lastOut = null; for (const x of ms) { const t = Date.parse(x.timestamp); if (!Number.isFinite(t)) continue; if (x.direction === 'in') lastIn = t; else if (x.direction === 'out') lastOut = t; } return lastIn != null && (lastOut == null || lastIn > lastOut); }
  function today() {
    const t = now().getTime(), dayEnd = new Date(t); dayEnd.setHours(23, 59, 59, 999);
    const map = classMap();
    const active = store.getAllLeads().filter(l => crmStateOf(l) === 'active' && salesOf(l, map));
    const scheduledCalls = [], tasksDue = [], waitingStaff = [], unanswered = [];
    for (const l of active) {
      const apt = openCallback(l.phone);
      if (apt && apt.scheduledAt && Date.parse(iso(apt.scheduledAt)) <= dayEnd.getTime()) scheduledCalls.push(row(l, map));
      const tks = openSalesTasks(l.phone).filter(tk => !tk.dueAt || Date.parse(tk.dueAt) <= dayEnd.getTime());
      if (tks.length) tasksDue.push({ ...row(l, map), dueTasks: tks.length, overdueTasks: tks.filter(tk => tk.dueAt && Date.parse(tk.dueAt) < new Date(t).setHours(0, 0, 0, 0)).length });
      if (ownerOf(l) === 'staff') waitingStaff.push(row(l, map));
      if (awaitingReply(l.phone)) unanswered.push(row(l, map));
    }
    const cmpDue = (a, b) => (toTime(a.nextAction?.dueAt) ?? Infinity) - (toTime(b.nextAction?.dueAt) ?? Infinity);
    scheduledCalls.sort((a, b) => (toTime(a.callbackAt) ?? 0) - (toTime(b.callbackAt) ?? 0));
    return {
      counts: { scheduledCalls: scheduledCalls.length, tasksDue: tasksDue.length, waitingStaff: waitingStaff.length, unanswered: unanswered.length },
      groups: { scheduledCalls, tasksDue: tasksDue.sort(cmpDue), waitingStaff, unanswered },
    };
  }

  // ── sales reports (§10) — durable per-lead facts, kept apart from the active lists ──────
  function reports({ from = null, to = null } = {}) {
    const f = from ? Date.parse(from) : -Infinity, tt = to ? Date.parse(to) : Infinity;
    const inRange = iso => { const x = Date.parse(iso); return Number.isFinite(x) && x >= f && x <= tt; };
    const map = classMap();
    const leads = store.getAllLeads();
    const salesLeads = leads.filter(l => salesOf(l, map));
    const bySource = {};                                  // source is never invented; a missing one is "ללא מקור"
    const bump = (obj, key, k = 1) => { obj[key] = (obj[key] ?? 0) + k; };
    const inquiries = saleLeadsInquiries();
    function saleLeadsInquiries() { let n = 0; for (const l of salesLeads) if (inRange(iso(l.firstSeen))) { n++; bump(bySource, sourceOf(l) ?? 'ללא מקור'); } return n; }
    let callsTotal = 0; const callsByOutcome = {};
    for (const l of leads) for (const c of (l.meta?.calls ?? [])) if (inRange(c.at)) { callsTotal++; bump(callsByOutcome, c.outcome); }
    const trialsScheduled = salesLeads.filter(l => l.meta?.trialScheduledAt && inRange(l.meta.trialScheduledAt)).length;
    const trialsAttendedStaff = salesLeads.filter(l => l.meta?.trialAttendedAt && inRange(l.meta.trialAttendedAt)).length;
    const unbounded = f === -Infinity && tt === Infinity;   // existing members with no recorded conversion date are not attributed to a specific period
    const regArbox = leads.filter(l => { const r = registrationOf(l); return r.registered && r.verified && (r.at ? inRange(r.at) : unbounded); }).length;
    const regStaff = salesLeads.filter(l => l.meta?.registeredSource === 'staff_report' && inRange(l.meta.registeredAt ?? iso(l.lastActivity))).length;
    const lost = salesLeads.filter(l => stageOf(l) === 'lost' && (l.meta?.lostAt ? inRange(l.meta.lostAt) : true));
    const lostReasons = {}; for (const l of lost) bump(lostReasons, l.meta?.lostReason ?? 'לא צוין');
    return {
      ok: true, period: { from: from ?? null, to: to ?? null },
      metrics: [
        { id: 'inquiries', he: 'פניות (לידים חדשים)', value: inquiries, definition: 'לידים שסווגו כליד מכירה ושנקלטו לראשונה בטווח (לפי firstSeen).', breakdown: bySource },
        { id: 'calls', he: 'שיחות שתועדו', value: callsTotal, definition: 'שיחות שהצוות תיעד ידנית בטווח. חיוג שלא תועד אינו נספר.', breakdown: Object.fromEntries(Object.entries(callsByOutcome).map(([k, v]) => [CALL_OUTCOMES[k]?.he ?? k, v])) },
        { id: 'trials_scheduled', he: 'ניסיונות שנקבעו', value: trialsScheduled, definition: 'לידים שנקבע להם מועד ניסיון בטווח (תכנון ידני של הצוות).' },
        { id: 'trials_attended', he: 'הגיעו לניסיון (דיווח צוות)', value: trialsAttendedStaff, definition: 'סומנו כמי שהגיעו לניסיון בטווח. דיווח צוות — לא אומת מול נוכחות ב-Arbox.' },
        { id: 'registered_arbox', he: 'נרשמו — אומת ב-Arbox', value: regArbox, definition: 'מנויים מאומתים ב-Arbox שתאריך רישום ההמרה שלהם (convertedAt — מתי המערכת זיהתה אותם כמנויים, לא בהכרח מועד ההצטרפות ב-Arbox) נופל בטווח. מנוי ללא תאריך מתועד נספר רק בדוח כולל ללא טווח.' },
        { id: 'registered_staff', he: 'נרשמו — דיווח צוות בלבד', value: regStaff, definition: 'סומנו כנרשמו על ידי הצוות אך עדיין לא אומתו ב-Arbox.' },
        { id: 'lost', he: 'לא נסגרו', value: lost.length, definition: 'לידים בשלב "לא נסגר" בטווח, לפי סיבה.', breakdown: lostReasons },
      ],
      note: 'הדוח מחושב מעובדות שמורות לכל ליד (firstSeen, שיחות, מועדי ניסיון, מקור ההרשמה), בנפרד מהרשימות הפעילות. מקור קמפיין לא מומצא — חסר מוצג כ"ללא מקור".',
    };
  }

  return {
    SALES_STAGES, SAVED_VIEWS, STAGE_HE, CRM_TASK_TYPE, CALL_OUTCOMES,
    registrationOf, logCall, trial, today, reports,
    nsn, phoneMatches, crmStateOf, ownerOf, stageOf,
    search, stageCounts, card, row, timelineOf,
    createLead, updateLead, setStage, addNote, createLeadTask, updateLeadTask,
    impact, trash, archive, restore, permanentDelete,
  };
}

module.exports = { createCrm, SALES_STAGES, SAVED_VIEWS, STAGE_HE, nsn, phoneMatches };
