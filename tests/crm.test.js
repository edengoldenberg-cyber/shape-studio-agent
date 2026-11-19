'use strict';
/**
 * services/crm.js — the sales CRM layer over the existing stores.
 * Uses a real LeadStore plus light stubs for the appointment / task stores, so the tests
 * prove the behaviour the owner asked for without a parallel database.
 */
const { LeadStore } = require('../utils/lead_store');
const { createCrm, nsn, phoneMatches } = require('../services/crm');

// Israel E.164 normaliser, good enough for tests: 05XXXXXXXX → 9725XXXXXXXX
function normalizePhone(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('972')) return d.length >= 12 ? d.slice(0, 12) : null;
  if (d.startsWith('0')) return d.length === 10 ? '972' + d.slice(1) : null;
  if (d.length === 9 && d.startsWith('5')) return '972' + d;
  return null;
}

function makeApt() {
  const apts = new Map();
  const ACTIVE = new Set(['callback_pending', 'confirmed']);
  return {
    _apts: apts, ACTIVE_STATUSES: ACTIVE,
    add(a) { const rec = { id: a.id ?? `apt_${apts.size + 1}`, status: 'callback_pending', createdAt: new Date(), scheduledAt: null, ...a }; apts.set(rec.id, rec); return rec; },
    getAll() { return [...apts.values()]; },
    getActiveCallback(phone) { const r = [...apts.values()].filter(a => a.leadPhone === phone && ACTIVE.has(a.status)).sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))[0]; return r ?? null; },
    cancel(id, { by, reason } = {}) { const a = apts.get(id); if (!a) return { ok: false, error: 'not_found' }; if (!ACTIVE.has(a.status)) return { ok: false, error: 'not_open', apt: a }; a.status = 'cancelled'; a.cancelledBy = by; a.cancelReason = reason; return { ok: true, unchanged: false, apt: a }; },
  };
}
function makeTasks() {
  const tasks = [];
  return {
    _tasks: tasks,
    createTask(t) { const rec = { id: `task_${tasks.length + 1}`, status: 'open', priority: 'normal', createdAt: new Date().toISOString(), ...t }; tasks.push(rec); return rec; },
    updateTask(id, u) { const t = tasks.find(x => x.id === id); if (!t) return null; Object.assign(t, u); return t; },
    getTasks({ phone } = {}) { return tasks.filter(t => !phone || t.phone === phone); },
  };
}
function build() {
  const store = new LeadStore();
  const aptStore = makeApt(), tomerStore = makeTasks();
  const inbox = { getThread: () => null };
  const persist = { saveLeads() {} };
  const logger = { info() {}, warn() {}, error() {} };
  const crm = createCrm({ store, aptStore, tomerStore, inbox, persist, logger, normalizePhone, isMember: () => false });
  return { store, aptStore, tomerStore, crm };
}

describe('crm — phone matching across formats', () => {
  test('nsn drops 972 and a leading 0', () => {
    expect(nsn('972526324276')).toBe('526324276');
    expect(nsn('0526324276')).toBe('526324276');
    expect(nsn('052-632-4276')).toBe('526324276');
  });
  test('a query finds a stored E.164 phone in 05 / 972 / spaced / fragment form', () => {
    const p = '972526324276';
    expect(phoneMatches('0526324276', p)).toBe(true);
    expect(phoneMatches('052-632-4276', p)).toBe(true);
    expect(phoneMatches('972526324276', p)).toBe(true);
    expect(phoneMatches('6324276', p)).toBe(true);           // a fragment
    expect(phoneMatches('052 6324', p)).toBe(true);
    expect(phoneMatches('0501111111', p)).toBe(false);
  });
});

describe('crm — search across all records, not one page', () => {
  test('finds by name, by tag, and by phone in either format; filters by stage and view', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'מאיה לוי', status: 'new', meta: { crmState: 'active', tags: ['קמפיין'] } });
    store.upsertLead('972522222222', { name: 'דנה כהן', status: 'warm', meta: { crmState: 'active', salesStage: 'needs' } });
    store.upsertLead('972523333333', { name: 'חבר ישן', status: 'opted_out', meta: { crmState: 'active' } });
    expect(crm.search({ q: 'מאיה' }).total).toBe(1);
    expect(crm.search({ q: 'קמפיין' }).rows[0].name).toBe('מאיה לוי');
    expect(crm.search({ q: '0522222222' }).rows[0].name).toBe('דנה כהן');    // local format against stored 972
    expect(crm.search({ q: '2222' }).total).toBe(1);                          // fragment
    expect(crm.search({ stage: 'needs' }).total).toBe(1);
    const all = crm.search({});
    expect(all.total).toBe(3);                                                // opted-out still a record in the pipeline view
  });
  test('an archived or trashed lead is hidden by default and shown only in its own bin', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'פעיל', meta: { crmState: 'active' } });
    store.upsertLead('972522222222', { name: 'בארכיון', meta: { crmState: 'archived' } });
    store.upsertLead('972523333333', { name: 'בסל', meta: { crmState: 'trashed' } });
    expect(crm.search({}).total).toBe(1);
    expect(crm.search({ crmState: 'archive' }).rows.map(r => r.name)).toEqual(['בארכיון']);
    expect(crm.search({ crmState: 'trash' }).rows.map(r => r.name)).toEqual(['בסל']);
    expect(crm.search({ crmState: 'all' }).total).toBe(3);
  });
});

describe('crm — the funnel uses the central classification (the 13 vs 69 gap)', () => {
  function withKinds() {
    const store = new LeadStore();
    const aptStore = makeApt(), tomerStore = makeTasks();
    const kindOf = lead => ({ salesList: (lead.meta?._kind ?? 'lead') === 'lead' || (lead.meta?._kind) === 'trial' || (lead.meta?._kind) === 'former_member' || (lead.meta?._kind) === 'unclear', kind: lead.meta?._kind ?? 'lead' });
    const crm = createCrm({ store, aptStore, tomerStore, inbox: { getThread: () => null }, persist: { saveLeads() {} }, logger: { info() {}, warn() {}, error() {} }, normalizePhone, isMember: () => false, kindOf });
    return { store, crm };
  }
  test('members, staff and test records stay out of the active funnel and the stage counts', () => {
    const { store, crm } = withKinds();
    store.upsertLead('972521111111', { name: 'ליד אמיתי', meta: { crmState: 'active', _kind: 'lead' } });
    store.upsertLead('972522222222', { name: 'מתעניין', meta: { crmState: 'active', _kind: 'trial' } });
    store.upsertLead('972523333333', { name: 'מנוי', status: 'cold', meta: { crmState: 'active', _kind: 'member' } });
    store.upsertLead('972524444444', { name: 'צוות', meta: { crmState: 'active', _kind: 'staff' } });
    store.upsertLead('972525555555', { name: 'בדיקה', meta: { crmState: 'active', _kind: 'test' } });
    expect(crm.search({}).total).toBe(2);                                    // only the lead + the trial
    const counts = crm.stageCounts();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(2);
    // a member is not pulled into the funnel even by a name search
    expect(crm.search({ q: 'מנוי' }).total).toBe(0);
    // but the 'registered' view shows leads that became members (sales history kept)
    store.upsertLead('972526666666', { name: 'נרשם', status: 'converted_member', meta: { crmState: 'active', _kind: 'member', isConfirmedMember: true } });
    expect(crm.search({ view: 'registered' }).rows.some(r => r.name === 'נרשם')).toBe(true);
  });
});

describe('crm — restore lifts only the hold that the removal created', () => {
  test('a pre-existing hold (refusal) survives trash → restore; a trash-only hold is lifted', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'סירוב', meta: { crmState: 'active', outreachHold: true } });   // held for another reason
    crm.trash('972521111111', { by: 'עדן' });
    expect(store.getLead('972521111111').meta.outreachHoldSetByCrm).toBeFalsy();                               // trash did not claim it
    crm.restore('972521111111', { by: 'עדן' });
    expect(store.getLead('972521111111').meta.outreachHold).toBe(true);                                        // the refusal hold stays

    store.upsertLead('972522222222', { name: 'ליד', meta: { crmState: 'active' } });                          // no hold
    crm.trash('972522222222', { by: 'עדן' });
    expect(store.getLead('972522222222').meta.outreachHold).toBe(true);
    expect(store.getLead('972522222222').meta.outreachHoldSetByCrm).toBe(true);
    crm.restore('972522222222', { by: 'עדן' });
    expect(store.getLead('972522222222').meta.outreachHold).toBe(false);                                       // the trash hold is lifted
  });
});

describe('crm — create, dedupe, edit, stage independence', () => {
  test('a manual lead is created with no contact, and a second create on the same number is refused as a duplicate', () => {
    const { store, crm } = build();
    const r = crm.createLead({ phone: '0521234567', name: 'ליד ידני', interest: 'כוח', source: 'המלצה', by: 'עדן' });
    expect(r.ok).toBe(true);
    const lead = store.getLead('972521234567');
    expect(lead.status).toBe('new');                                         // 'new' = not contacted; nothing was sent
    expect(lead.meta.crmCreatedManually).toBe(true);
    expect(lead.meta.source).toBe('המלצה');
    const dup = crm.createLead({ phone: '052-123-4567', name: 'שוב' });
    expect(dup).toMatchObject({ ok: false, error: 'duplicate' });
    expect(dup.existing.phone).toBe('972521234567');
  });
  test('confirmed name is separate from the WhatsApp display name', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'שם מהוואטסאפ', meta: { crmState: 'active' } });
    crm.updateLead('972521111111', { confirmedName: 'שם מאומת' }, { by: 'עדן' });
    const c = crm.card('972521111111');
    expect(c.waName).toBe('שם מהוואטסאפ');
    expect(c.confirmedName).toBe('שם מאומת');
    expect(c.name).toBe('שם מאומת');                                          // display prefers the confirmed name
  });
  test('changing the sales stage never changes conversation ownership and sends nothing', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'בטיפול ידני', status: 'human_owns', meta: { crmState: 'active', humanOwnsReason: 'staff_manual_reply' } });
    const r = crm.setStage('972521111111', 'call_scheduled', { by: 'עדן' });
    expect(r.ok).toBe(true);
    expect(store.getLead('972521111111').status).toBe('human_owns');         // ownership untouched
    expect(crm.stageOf(store.getLead('972521111111'))).toBe('call_scheduled');
    expect(crm.setStage('972521111111', 'not_a_stage').error).toBe('invalid_stage');
  });
});

describe('crm — archive, trash, restore, permanent delete', () => {
  test('trash stops the lead’s open callback and sales tasks, hides it, and is reversible without reviving them', () => {
    const { store, aptStore, tomerStore, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', status: 'callback_requested', meta: { crmState: 'active' } });
    aptStore.add({ leadPhone: '972521111111', status: 'confirmed' });
    tomerStore.createTask({ type: 'sales_followup', phone: '972521111111', summary: 'לחזור' });
    const t = crm.trash('972521111111', { by: 'עדן' });
    expect(t.ok).toBe(true);
    expect(t.stopped.cancelledCallbacks).toBe(1);
    expect(t.stopped.cancelledTasks).toBe(1);
    expect(aptStore.getActiveCallback('972521111111')).toBeNull();           // reminders can no longer fire
    expect(crm.search({}).total).toBe(0);                                    // hidden from the active pipeline
    expect(crm.search({ crmState: 'trash' }).total).toBe(1);
    const r = crm.restore('972521111111', { by: 'עדן' });
    expect(r.ok).toBe(true);
    expect(crm.search({}).total).toBe(1);                                    // back in the pipeline
    expect(aptStore.getActiveCallback('972521111111')).toBeNull();           // but the cancelled callback is NOT revived
    expect(tomerStore.getTasks({ phone: '972521111111' })[0].status).toBe('cancelled');
  });
  test('archive parks a lead out of the active lists but leaves a scheduled callback alone', () => {
    const { store, aptStore, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', meta: { crmState: 'active' } });
    aptStore.add({ leadPhone: '972521111111', status: 'confirmed' });
    crm.archive('972521111111', { by: 'עדן' });
    expect(crm.search({}).total).toBe(0);
    expect(crm.search({ crmState: 'archive' }).total).toBe(1);
    expect(aptStore.getActiveCallback('972521111111')).not.toBeNull();       // the scheduled call stands
    expect(store.getLead('972521111111').meta.outreachHold).toBe(true);      // no proactive outreach
  });
  test('permanent delete needs the recycle bin and admin confirmation, and never hard-deletes a refusal', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'רגיל', meta: { crmState: 'active' } });
    expect(crm.permanentDelete('972521111111', { adminConfirmed: true }).error).toBe('not_in_trash');
    crm.trash('972521111111', { by: 'עדן' });
    expect(crm.permanentDelete('972521111111', { adminConfirmed: false }).error).toBe('confirmation_required');
    expect(crm.permanentDelete('972521111111', { adminConfirmed: true }).ok).toBe(true);
    expect(store.getLead('972521111111')).toBeNull();

    store.upsertLead('972522222222', { name: 'סירוב', status: 'opted_out', meta: { crmState: 'active', optedOutAt: '2026-11-01' } });
    crm.trash('972522222222', { by: 'עדן' });
    const refused = crm.permanentDelete('972522222222', { adminConfirmed: true });
    expect(refused).toMatchObject({ ok: false, error: 'refusal_protected' });
    expect(store.getLead('972522222222')).not.toBeNull();                    // the refusal record survives
  });
});

describe('crm — call logging and outcomes (§7)', () => {
  test('a logged call is recorded with its outcome; registered is a STAFF report, not Arbox verification', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', meta: { crmState: 'active' } });
    const r = crm.logCall('972521111111', { outcome: 'registered', note: 'סגר מנוי', by: 'עדן' });
    expect(r.ok).toBe(true);
    const c = crm.card('972521111111');
    expect(c.stage).toBe('registered');
    expect(c.registration).toMatchObject({ registered: true, verified: false, source: 'staff_report' });   // NOT Arbox-verified
    expect(c.calls).toHaveLength(1);
    expect(crm.logCall('972521111111', { outcome: 'nonsense' }).error).toBe('invalid_outcome');
  });
  test('not interested → lost with a reason; it is not an opt-out and sends nothing', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', status: 'warm', meta: { crmState: 'active' } });
    crm.logCall('972521111111', { outcome: 'not_interested', note: 'מחיר גבוה', by: 'עדן' });
    const c = crm.card('972521111111');
    expect(c.stage).toBe('lost');
    expect(c.lostReason).toBe('מחיר גבוה');
    expect(store.getLead('972521111111').status).toBe('warm');          // ownership/communication status unchanged (not opt-out)
  });
  test('a follow-up date after "no answer" creates a follow-up task (no send)', () => {
    const { store, tomerStore, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', meta: { crmState: 'active' } });
    crm.logCall('972521111111', { outcome: 'no_answer', followUpAt: '2026-11-20T08:00:00Z', by: 'עדן' });
    const t = tomerStore.getTasks({ phone: '972521111111' });
    expect(t).toHaveLength(1);
    expect(t[0].type).toBe('sales_followup');
    expect(t[0].dueAt).toBe('2026-11-20T08:00:00Z');
  });
});

describe('crm — trials and conversion (§9)', () => {
  test('staff planning and staff-reported attendance are labelled, and an Arbox member is verified', () => {
    const { store, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', meta: { crmState: 'active' } });
    crm.trial('972521111111', { action: 'schedule', at: '2026-11-21T06:30:00Z', by: 'עדן' });
    expect(crm.card('972521111111').stage).toBe('trial_scheduled');
    crm.trial('972521111111', { action: 'attended', by: 'עדן' });
    const c = crm.card('972521111111');
    expect(c.stage).toBe('trial_attended');
    expect(c.trialInfo.attendedSource).toBe('staff_report');            // not an Arbox attendance check
    // a confirmed Arbox member reads as verified registration
    store.upsertLead('972522222222', { name: 'מנוי', status: 'converted_member', meta: { crmState: 'active', isConfirmedMember: true, convertedAt: '2026-11-10' } });
    expect(crm.registrationOf(store.getLead('972522222222'))).toMatchObject({ registered: true, verified: true, source: 'arbox' });
  });
});

describe('crm — my day today (§1) and reports (§10)', () => {
  function withInbox(threads) {
    const store = new LeadStore(), aptStore = makeApt(), tomerStore = makeTasks();
    const inbox = { getThread: p => threads[p] ?? null };
    const crm = createCrm({ store, aptStore, tomerStore, inbox, getThread: p => threads[p] ?? null, persist: { saveLeads() {} }, logger: { info() {}, warn() {}, error() {} }, normalizePhone, isMember: () => false });
    return { store, aptStore, tomerStore, crm };
  }
  test('today groups scheduled calls, due tasks, staff-owned and unanswered leads', () => {
    const now = new Date();
    const threads = { '972524444444': { messages: [{ direction: 'in', timestamp: now.toISOString(), text: 'שלום?' }] } };
    const { store, aptStore, tomerStore, crm } = withInbox(threads);
    store.upsertLead('972521111111', { name: 'שיחה היום', meta: { crmState: 'active' } });
    aptStore.add({ leadPhone: '972521111111', status: 'confirmed', scheduledAt: now });
    store.upsertLead('972522222222', { name: 'משימה היום', meta: { crmState: 'active' } });
    const tk = tomerStore.createTask({ type: 'sales_followup', phone: '972522222222', summary: 'לחזור' }); tomerStore.updateTask(tk.id, { dueAt: now.toISOString() });
    store.upsertLead('972523333333', { name: 'ממתין לצוות', status: 'human_owns', meta: { crmState: 'active' } });
    store.upsertLead('972524444444', { name: 'ללא מענה', meta: { crmState: 'active' } });
    const d = crm.today();
    expect(d.counts.scheduledCalls).toBe(1);
    expect(d.counts.tasksDue).toBe(1);
    expect(d.counts.waitingStaff).toBe(1);
    expect(d.counts.unanswered).toBe(1);
  });
  test('reports separate Arbox-verified registrations from staff reports, and never invent a source', () => {
    const store = new LeadStore(), aptStore = makeApt(), tomerStore = makeTasks();
    const kindOf = lead => { const k = lead.meta?.isConfirmedMember ? 'member' : (lead.meta?._kind ?? 'lead'); return { kind: k, salesList: ['lead', 'trial', 'former_member', 'unclear'].includes(k) }; };
    const crm = createCrm({ store, aptStore, tomerStore, inbox: { getThread: () => null }, persist: { saveLeads() {} }, logger: { info() {}, warn() {}, error() {} }, normalizePhone, isMember: () => false, kindOf });
    store.upsertLead('972521111111', { name: 'פנייה', firstSeen: new Date('2026-11-10'), meta: { crmState: 'active', source: 'פייסבוק' } });
    store.upsertLead('972522222222', { name: 'בלי מקור', firstSeen: new Date('2026-11-11'), meta: { crmState: 'active' } });
    store.upsertLead('972523333333', { name: 'נרשם צוות', firstSeen: new Date('2026-11-12'), meta: { crmState: 'active', source: 'אתר', registeredSource: 'staff_report', registeredAt: '2026-11-12', salesStage: 'registered' } });
    store.upsertLead('972524444444', { name: 'נרשם Arbox', status: 'converted_member', meta: { crmState: 'active', isConfirmedMember: true, convertedAt: '2026-11-12' } });
    const rep = crm.reports({ from: '2026-11-01', to: '2026-11-30' });
    const m = Object.fromEntries(rep.metrics.map(x => [x.id, x]));
    expect(m.inquiries.value).toBe(3);                                    // the Arbox member is not a sales-list inquiry
    expect(m.inquiries.breakdown['ללא מקור']).toBe(1);
    expect(m.inquiries.breakdown['פייסבוק']).toBe(1);
    expect(m.registered_staff.value).toBe(1);
    expect(m.registered_arbox.value).toBe(1);
    expect(m.inquiries.definition).toMatch(/firstSeen/);
  });
});

describe('crm — tasks live on the shared store, and the timeline merges real sources', () => {
  test('a lead task is created in the task store with the sales type', () => {
    const { store, tomerStore, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', meta: { crmState: 'active' } });
    const r = crm.createLeadTask('972521111111', { summary: 'להתקשר מחר', dueAt: '2026-11-20T08:00:00Z', by: 'עדן' });
    expect(r.ok).toBe(true);
    const t = tomerStore.getTasks({ phone: '972521111111' })[0];
    expect(t.type).toBe('sales_followup');
    expect(t.summary).toBe('להתקשר מחר');
    expect(crm.card('972521111111').tasks).toHaveLength(1);
  });
  test('resolving a task is an explicit action and only works on a sales task', () => {
    const { store, tomerStore, crm } = build();
    store.upsertLead('972521111111', { name: 'ליד', meta: { crmState: 'active' } });
    const sales = tomerStore.createTask({ type: 'sales_followup', phone: '972521111111', summary: 'לחזור' });
    const member = tomerStore.createTask({ type: 'freeze_request', phone: '972521111111', summary: 'הקפאה' });
    expect(crm.updateLeadTask(sales.id, { status: 'resolved', outcome: 'נרשם' }).ok).toBe(true);
    expect(tomerStore.getTasks({})[0].status).toBe('resolved');
    expect(crm.updateLeadTask(member.id, { status: 'resolved' })).toMatchObject({ ok: false, error: 'not_a_sales_task' });
  });
});
