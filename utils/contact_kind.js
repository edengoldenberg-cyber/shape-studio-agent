'use strict';

/**
 * contact_kind.js — what a stored conversation record IS. A WhatsApp message is not a sales lead.
 *
 * The lead store holds a record for every phone the system had to remember something about: a prospect who talks to
 * Barak, but also a member the staff answered by hand, the owner's own number, a former member, and numbers used in
 * a test run. Production, 2026-11-18: of 29 records shown as "leads", 19 were a test batch, 1 was the owner and 2 were
 * former members; 36 members had lead records carrying a sales score.
 *
 * The kind is decided from evidence, never from a contact name or from the mere existence of a record:
 *   member / aggregator   a valid membership today, or a club (aggregator) row — the identity resolver, i.e. Arbox
 *   staff                 an active staff row in Arbox
 *   former_member         a client row whose memberships have all ended
 *   trial                 an Arbox row with role "lead" (came to / signed for a trial, or was entered as a lead there)
 *   lead                  not in Arbox, and there is a sales conversation (talked to Barak, asked for a call, a Meta lead)
 *   contact               not in Arbox, the record exists only because the staff wrote to this number by hand
 *   test                  part of a batch of simulated messages (no real WhatsApp message id, created together)
 *   unclear               Arbox could not be read, or several Arbox rows of different kinds share the phone
 * Only lead / trial / former_member / unclear belong in the list of sales leads.
 *
 * Pure: reads what it is given, writes nothing.
 */

const LABEL = { member: 'מנוי', aggregator: 'חבר מועדון', staff: 'צוות', former_member: 'מנוי לשעבר', trial: 'ליד ב-Arbox (ניסיון / התעניינות)',
  lead: 'ליד', contact: 'שיחה בלבד — לא ליד', test: 'רשומת בדיקה', unclear: 'לבירור' };
const IN_SALES_LIST = new Set(['lead', 'trial', 'former_member', 'unclear']);
const REAL_WA_ID = /^[0-9A-F]{16,}$/i;                         // ids WhatsApp gives a message; the pipeline's own records are "wa-…"
const TEST_BATCH_MIN = 5, TEST_BATCH_WINDOW_MS = 60 * 60 * 1000;

const validIsraeliMobile = p => /^9725\d{8}$/.test(String(p));
// a real inbound message: one synced from WhatsApp's history (its own id), or one the pipeline received with a provider id
// (ids of the test endpoint start with "sim-")
const realInbound = thread => (thread?.messages ?? []).some(m => m.direction === 'in' && (REAL_WA_ID.test(String(m.id ?? '')) || (m.waId && !/^sim-/.test(String(m.waId)))));

/**
 * Records that came from a test run. The evidence must be strong — a wave of real leads must never be hidden:
 *   not in Arbox, AND no real WhatsApp message ever arrived from the number, AND
 *   either the number is not a possible Israeli mobile at all,
 *   or at least TEST_BATCH_MIN such records were first seen within one hour AND the number is consecutive with another
 *   one of them (real people who write in the same hour do not have consecutive phone numbers).
 * Returns a Set of phones.
 */
function testBatch(leads, { peek, getThread }) {
  const cand = leads.filter(l => {
    const id = peek(l.phone);
    return id?.category === 'unknown' && !id.stale && !realInbound(getThread(l.phone));
  });
  const out = new Set(cand.filter(l => !validIsraeliMobile(l.phone)).map(l => l.phone));
  const times = cand.map(l => ({ phone: l.phone, t: new Date(l.firstSeen).getTime() })).filter(x => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  const near = (a, b) => a !== b && a.length === b.length && a.slice(0, -2) === b.slice(0, -2) && Math.abs(Number(a.slice(-2)) - Number(b.slice(-2))) <= 9;
  for (let i = 0; i < times.length; i++) {
    const group = times.filter(x => x.t >= times[i].t && x.t - times[i].t <= TEST_BATCH_WINDOW_MS);
    if (group.length < TEST_BATCH_MIN) continue;
    for (const g of group) if (group.some(o => near(String(g.phone), String(o.phone)))) out.add(g.phone);
  }
  return out;
}

/**
 * @param {object} lead
 * @param {object} ctx  { id: identity.peek(phone), thread, hasAppointment, isTest }
 * @returns {{ kind, label, salesList, reason }}
 */
function kindOf(lead, { id, thread = null, hasAppointment = false, isTest = false } = {}) {
  const make = (kind, reason) => ({ kind, label: LABEL[kind], salesList: IN_SALES_LIST.has(kind), reason });
  const cat = id?.category ?? 'unavailable';
  const mixed = (id?.others ?? []).length > 0 || id?.ambiguous === true;
  if (cat === 'unavailable') return make('unclear', 'Arbox לא נקרא — אין ראיה לסיווג');
  if (cat === 'member' || cat === 'aggregator') return { ...make(cat, mixed ? `מנוי בתוקף ב-Arbox; על הטלפון יש גם שורה נוספת (${(id.others ?? []).join(', ')})` : 'מנוי בתוקף ב-Arbox'), mixed };
  if (cat === 'staff') return make('staff', 'שורת צוות פעילה ב-Arbox');
  if (cat === 'former_member') return make('former_member', 'לקוח ב-Arbox שכל המנויים שלו הסתיימו');
  if (cat === 'lead') return make('trial', id.reason === 'client_row_without_membership' ? 'שורת לקוח ב-Arbox בלי מנוי' : id.reason === 'membership_not_started_yet' ? 'מנוי שעדיין לא התחיל' : 'שורת ליד ב-Arbox');
  if (cat !== 'unknown') return make('unclear', `סיווג לא צפוי: ${cat}`);
  if (isTest) return make('test', 'חלק מקבוצת הודעות מדומות: אין הודעת WhatsApp אמיתית מהמספר');
  const meta = lead.meta ?? {};
  const talkedToBot = (lead.history ?? []).some(m => m.role === 'user');
  const sales = talkedToBot || hasAppointment || /meta|form|campaign/i.test(String(meta.source ?? '')) || !!meta.awaitingCallbackTime || meta.humanOwnsReason === 'frustration' || (lead.messageCount ?? 0) > 0
    || ['warm', 'hot', 'cold', 'callback_requested', 'call_scheduled', 'call_completed', 'call_cancelled', 'call_no_answer', 'opted_out', 'escalated', 'crisis'].includes(lead.status)
    || meta.qualData?.registrationDeclined !== undefined;
  if (!sales && ['staff_manual_reply', 'prior_manual_conversation', 'manual', 'tomer_panel'].includes(meta.humanOwnsReason)) return make('contact', 'הרשומה נוצרה רק כי הצוות כתב למספר הזה; אין שיחת מכירה');
  return make('lead', 'אינו ב-Arbox, ויש שיחת מכירה');
}

/** Kind of every record. Returns Map(phone → kind object). */
function classifyAll(leads, { peek, getThread = () => null, hasAppointment = () => false }) {
  const tests = testBatch(leads, { peek, getThread });
  return new Map(leads.map(l => [l.phone, kindOf(l, { id: peek(l.phone), thread: getThread(l.phone), hasAppointment: hasAppointment(l.phone), isTest: tests.has(l.phone) })]));
}

module.exports = { kindOf, classifyAll, testBatch, LABEL, IN_SALES_LIST };
