'use strict';
/**
 * lead_reconcile.test.js — stored lead records are brought back in line with the evidence, and a sync or a restart
 * cannot bring a wrong state back (utils/lead_reconcile.js, utils/conversion_detector.js).
 *
 * Production, 2026-11-17/18 (replayed with invented phones): the conversion detector marked every active Arbox row as
 * a member — a trial-lesson lead, a former member and the owner's staff row included — and an explicit refusal to
 * register lived only in the conversation history.
 */
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { reconcile } = require('../utils/lead_reconcile');

const NOW = new Date('2026-11-18T06:00:00Z');
const OLD = new Date('2026-11-09T13:53:00Z');
const P = n => `97258700${String(n).padStart(4, '0')}`;

function makeStore(leads) {
  const map = new Map(leads.map(l => [l.phone, { score: 4, history: [], meta: {}, lastActivity: OLD, ...l }]));
  const events = [];
  return { events, map,
    getAllLeads: () => [...map.values()], getLead: p => map.get(p) ?? null,
    upsertLead(p, patch) { const rec = { ...(map.get(p) ?? { phone: p }), ...patch, lastActivity: new Date() }; map.set(p, rec); return rec; },   // as the real store: stamps lastActivity
    logEvent: (type, phone, data) => events.push({ type, phone, data }) };
}
const id = (category, extra = {}) => ({ category, stale: false, shared: false, ambiguous: false, others: [], reason: null, ...extra });
const identityOf = table => ({ peek: p => table[p] ?? id('unknown', { reason: 'not_in_arbox' }) });
const convMeta = { convertedAt: '2026-11-17T07:15:06.488Z', convertedSource: 'conversion_detector' };

describe('classification: a member mark is kept only where the Arbox evidence supports it', () => {
  // 1 trial-lesson lead · 2 member · 3 owner (staff), human-owned · 4 former member, human-owned · 5 two Arbox rows · 6 Arbox unreadable · 7 not in Arbox · 8 ordinary lead
  const world = () => {
    const store = makeStore([
      { phone: P(1), status: 'converted_member', score: 8, meta: { ...convMeta, lastIntent: 'general' } },
      { phone: P(2), status: 'converted_member', score: 0, meta: { ...convMeta } },
      { phone: P(3), status: 'human_owns', meta: { ...convMeta, isConfirmedMember: true, previousStatus: 'cold', humanOwnsSince: '2026-11-15T04:36:03.863Z', humanOwnsReason: 'staff_manual_reply' } },
      { phone: P(4), status: 'human_owns', meta: { convertedAt: '2026-11-17T11:45:00Z', convertedSource: 'cron_15min', isConfirmedMember: true, previousStatus: 'converted_member', humanOwnsSince: '2026-11-17T09:00:00Z' } },
      { phone: P(5), status: 'converted_member', meta: { ...convMeta } },
      { phone: P(6), status: 'converted_member', meta: { ...convMeta } },
      { phone: P(7), status: 'converted_member', meta: { ...convMeta } },
      { phone: P(8), status: 'warm', score: 6, meta: {} },
    ]);
    const identity = identityOf({ [P(1)]: id('lead'), [P(2)]: id('member'), [P(3)]: id('staff'), [P(4)]: id('former_member'),
      [P(5)]: id('member', { others: ['lead'] }), [P(6)]: id('unavailable', { reason: 'no_directory' }), [P(8)]: id('unknown') });
    return { store, identity };
  };

  test('lead, staff and former member lose the mark; a member keeps it; unclear cases are left for review', () => {
    const { store, identity } = world();
    const out = reconcile({ store, identity, now: () => NOW });

    expect(store.getLead(P(1))).toMatchObject({ status: 'cold', meta: { classificationCorrected: { evidence: 'lead', was: 'status converted_member', markedBy: 'conversion_detector' }, outreachHold: { reason: 'classification_corrected' } } });
    expect(store.getLead(P(1)).meta).not.toHaveProperty('convertedAt');
    expect(store.getLead(P(2))).toMatchObject({ status: 'converted_member', meta: convMeta });                         // a real member: untouched
    expect(store.getLead(P(3))).toMatchObject({ status: 'human_owns', meta: { humanOwnsSince: '2026-11-15T04:36:03.863Z', humanOwnsReason: 'staff_manual_reply', previousStatus: 'cold', classificationCorrected: { evidence: 'staff' } } });
    expect(store.getLead(P(3)).meta).not.toHaveProperty('isConfirmedMember');
    expect(store.getLead(P(4))).toMatchObject({ status: 'human_owns', meta: { previousStatus: 'cold', humanOwnsSince: '2026-11-17T09:00:00Z', classificationCorrected: { evidence: 'former_member' } } });
    expect(store.getLead(P(5))).toMatchObject({ status: 'converted_member', meta: { classificationReview: { evidence: 'member', others: ['lead'] }, outreachHold: { reason: 'classification_review' } } });
    expect(store.getLead(P(5)).meta.classificationReview.reason).toMatch(/כמה שורות Arbox/);
    expect(store.getLead(P(6))).toMatchObject({ status: 'converted_member', meta: convMeta });                         // no evidence: nothing marked
    expect(store.getLead(P(6)).meta).not.toHaveProperty('classificationReview');
    expect(store.getLead(P(7)).meta.classificationReview.reason).toMatch(/אינו נמצא ב-Arbox/);
    expect(store.getLead(P(8))).toMatchObject({ status: 'warm', score: 6, meta: {} });                                 // an ordinary lead is not touched

    expect(out).toMatchObject({ checked: 8, deferred: 1 });
    expect(out.corrected.map(c => c.phone).sort()).toEqual([P(1), P(3), P(4)]);
    expect(out.review.map(c => c.phone).sort()).toEqual([P(5), P(7)]);
  });

  test('a correction is not activity: last-activity dates stay as they were, nothing is deleted', () => {
    const { store, identity } = world();
    reconcile({ store, identity, now: () => NOW });
    expect(store.getAllLeads()).toHaveLength(8);
    for (const l of store.getAllLeads()) expect([l.phone, l.lastActivity]).toEqual([l.phone, OLD]);
  });

  test('idempotent: a second run, a "sync" and a "restart" change nothing and bring nothing back', () => {
    const { store, identity } = world();
    reconcile({ store, identity, now: () => NOW });
    const snapshot = JSON.stringify(store.getAllLeads());
    const events = store.events.length;
    const out2 = reconcile({ store, identity, now: () => new Date(NOW.getTime() + 15 * 60000) });
    expect(JSON.stringify(store.getAllLeads())).toBe(snapshot);
    expect(store.events.length).toBe(events);
    expect(out2.corrected).toHaveLength(0);
  });

  test('when Arbox later shows a valid membership on one row, the review mark is lifted', () => {
    const { store } = world();
    reconcile({ store, identity: identityOf({ [P(5)]: id('member', { others: ['lead'] }) }), now: () => NOW });
    expect(store.getLead(P(5)).meta.classificationReview).toBeTruthy();
    reconcile({ store, identity: identityOf({ [P(5)]: id('member') }), now: () => NOW });
    expect(store.getLead(P(5)).meta).not.toHaveProperty('classificationReview');
    expect(store.getLead(P(5)).status).toBe('converted_member');
  });

  test('corrected and review-marked records are out of every automated outreach list (real lead store)', () => {
    jest.resetModules();
    const real = require('../utils/lead_store');
    for (const [p, meta, status] of [[P(21), { outreachHold: { reason: 'classification_corrected' } }, 'cold'], [P(22), { classificationReview: { reason: 'x' } }, 'cold'],
                                     [P(23), { qualData: { registrationDeclined: true } }, 'cold'], [P(24), {}, 'cold']]) real.upsertLead(p, { status, meta });
    for (const l of real.getAllLeads()) l.lastActivity = OLD;
    expect(real.getSendableLeads().map(l => l.phone)).toEqual([P(24)]);
    expect(real.getDormantLeads(3).map(l => l.phone)).toEqual([P(24)]);
  });
});

describe('a refusal that exists only in the stored history is recorded, with its original time and source', () => {
  const HIST = [{ role: 'user', content: 'היוש אשמח בערב' }, { role: 'assistant', content: 'היי! מה מעניין אותך?' },
    { role: 'user', content: 'אני בסוף החלטתי לא להרשם' }, { role: 'assistant', content: 'מבין לגמרי. שיהיה לך יום נפלא! 😊' },
    { role: 'user', content: 'תודה רבה על הניסיון' }, { role: 'assistant', content: 'בשמחה 😊' }];
  const inbox = { getThread: () => ({ messages: [{ direction: 'in', text: 'אני בסוף החלטתי לא להרשם', timestamp: '2026-11-17T08:15:49.000Z', id: 'AC0DD9' }, { direction: 'out', text: 'x', timestamp: '2026-11-17T08:15:53.000Z', id: '3EB051' }] }) };

  test('the production record: wrongly "member" + refusal in the history → a declined lead, on hold, nothing sent', () => {
    const store = makeStore([{ phone: P(1), status: 'converted_member', score: 8, history: HIST,
      meta: { ...convMeta, qualData: { callProposed: true }, qualProfile: { nextBestAction: 'המשך את הבוט — בירור נוסף נדרש', appointmentState: 'proposed' } } }]);
    const computeProfile = (_l, qd) => ({ appointmentState: qd.registrationDeclined ? 'declined' : 'x', nextBestAction: 'אין פעולה' });
    const out = reconcile({ store, identity: identityOf({ [P(1)]: id('lead') }), inbox, computeProfile, now: () => NOW });
    const l = store.getLead(P(1));
    expect(l).toMatchObject({ status: 'cold', score: 2, lastActivity: OLD });
    expect(l.meta.qualData).toMatchObject({ registrationDeclined: true, registrationDeclinedAt: '2026-11-17T08:15:49.000Z', registrationDeclinedText: 'אני בסוף החלטתי לא להרשם',
      registrationDeclinedSource: 'history', registrationDeclinedMessageId: 'AC0DD9', declineCourtesyAnswered: true, callbackDeclined: true, callProposed: false });
    expect(l.meta.qualProfile).toEqual({ appointmentState: 'declined', nextBestAction: 'אין פעולה' });
    expect(l.history).toEqual(HIST);                                                                                  // the history itself is not rewritten
    expect(out.refusals).toEqual([{ phone: P(1), at: '2026-11-17T08:15:49.000Z', text: 'אני בסוף החלטתי לא להרשם', openCallback: false }]);
    expect(Object.keys(store).filter(k => /send|notify|alert/i.test(k))).toEqual([]);                                 // the store handed in can send nothing
  });

  test('a refusal followed by an explicit request is not a refusal; a human-owned or opted-out record keeps its status', () => {
    const store = makeStore([
      { phone: P(1), status: 'warm', history: [{ role: 'user', content: 'לא מעוניינת' }, { role: 'user', content: 'בסוף כן רוצה להירשם' }] },
      { phone: P(2), status: 'human_owns', score: 6, history: [{ role: 'user', content: 'החלטתי שלא' }], meta: { humanOwnsSince: '2026-11-16T10:00:00Z' } },
      { phone: P(3), status: 'opted_out', history: [{ role: 'user', content: 'לא מעוניינת, תודה' }] },
      { phone: P(4), status: 'warm', history: [{ role: 'user', content: 'אם לא ארשם מה קורה?' }, { role: 'user', content: 'אחשוב על זה' }] },
    ]);
    reconcile({ store, identity: identityOf({}), now: () => NOW });
    expect(store.getLead(P(1)).meta.qualData?.registrationDeclined).toBeUndefined();
    expect(store.getLead(P(2))).toMatchObject({ status: 'human_owns', score: 2, meta: { humanOwnsSince: '2026-11-16T10:00:00Z', qualData: { registrationDeclined: true, registrationDeclinedAt: null, registrationDeclinedSource: 'history' } } });
    expect(store.getLead(P(3)).status).toBe('opted_out');
    expect(store.getLead(P(4)).meta.qualData?.registrationDeclined).toBeUndefined();
  });

  test('an open callback request next to a recorded refusal is flagged for the staff, not cancelled silently', () => {
    const store = makeStore([{ phone: P(1), status: 'callback_requested', history: [{ role: 'user', content: 'ויתרתי' }] }]);
    reconcile({ store, identity: identityOf({}), aptStore: { getActiveCallback: () => ({ id: 'apt_1' }) }, now: () => NOW });
    expect(store.getLead(P(1))).toMatchObject({ status: 'callback_requested', meta: { refusalReview: { aptId: 'apt_1' }, qualData: { registrationDeclined: true } } });
  });

  test('a reopened record is not declared declined again from its old history', () => {
    const store = makeStore([{ phone: P(1), status: 'warm', history: [{ role: 'user', content: 'לא מעוניינת' }], meta: { qualData: { registrationDeclined: false, registrationReopenedAt: '2026-11-18T05:00:00Z' } } }]);
    reconcile({ store, identity: identityOf({}), now: () => NOW });
    expect(store.getLead(P(1)).meta.qualData.registrationDeclined).toBe(false);
  });
});

describe('the Arbox sync cannot mark a lead, a trial participant, a former member or staff as a member', () => {
  const run = async (identity) => {
    jest.resetModules();
    jest.doMock('../services/arbox.service', () => ({ getAllUsers: jest.fn(() => Promise.resolve([
      { phone: '0587000001', active: 1, user_role: 'lead',        user_id: 1 }, { phone: '0587000002', active: 1, user_role: 'staffMember', user_id: 2 },
      { phone: '0587000003', active: 1, user_role: 'client',      user_id: 3 }, { phone: '0587000004', active: 1, user_role: 'client',      user_id: 4 },
      { phone: '0587000005', active: 0, user_role: 'aggregatorMember', user_id: 5 },
    ])) }));
    const { detectAndMarkConversions } = require('../utils/conversion_detector');
    const converted = [];
    const store = { getAllLeads: () => [1, 2, 3, 4, 5, 6].map(n => ({ phone: `97258700000${n}`, status: 'warm', meta: {}, history: [] })),
                    reclassifyAsConvertedMember: p => converted.push(p), logEvent: jest.fn(), getLead: () => null, upsertLead: jest.fn() };
    const norm = p => { const d = String(p).replace(/\D/g, ''); return d.startsWith('972') ? d : '972' + d.replace(/^0/, ''); };
    await detectAndMarkConversions(store, { markConfirmed: jest.fn() }, norm, jest.fn(), identity);
    return converted.sort();
  };
  test('with the identity resolver: only a valid membership or an aggregator converts — an active client row without one does not', async () => {
    const identity = identityOf({ '972587000001': id('lead'), '972587000002': id('staff'), '972587000003': id('member'), '972587000004': id('former_member'), '972587000005': id('aggregator') });
    expect(await run(identity)).toEqual(['972587000003', '972587000005']);
  });
  test('Arbox unreadable or an old copy: nobody is converted in that run', async () => {
    expect(await run(identityOf({ '972587000003': id('unavailable') }))).toEqual([]);
    expect(await run(identityOf({ '972587000003': id('member', { stale: true }) }))).toEqual([]);
  });
});
