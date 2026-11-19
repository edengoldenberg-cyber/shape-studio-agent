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
