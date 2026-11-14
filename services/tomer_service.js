'use strict';

/**
 * tomer_service.js — Tomer, the studio's digital assistant for EXISTING members.
 *
 * One entry point for every member message (text or media): handleMemberMessage().
 * Each message ends in exactly one of:
 *   • a verified answer   — built from data read from Arbox at reply time
 *   • one focused clarification
 *   • a durable service case, with ONE manager alert, and an honest status to the member
 *   • deliberate silence  — acknowledgements / small talk (logged with the reason)
 *
 * Tomer never states that something was cancelled, booked, paid, frozen or scheduled
 * unless Arbox shows it, and never says staff were notified — only that the request was
 * RECORDED, and only after the case is on disk.
 *
 * Three kinds of action are kept apart everywhere (messages, case, panel):
 *   • done by the MEMBER   — class booking / cancellation in the Arbox app; Tomer hands
 *                            over the class's own link and then VERIFIES from Arbox.
 *   • done by STAFF        — membership cancellation / freeze, billing, complaints …
 *                            Tomer opens a durable case and alerts the manager ONCE.
 *                            Staff report the outcome when they resolve the case.
 *   • verified by the SYSTEM — read-only Arbox checks (case.arboxCheck), stored
 *                            separately from what staff reported (case.resolution).
 * Tomer performs no Arbox write of any kind.
 */

const { classify, NO_REPLY } = require('./member_intent');
const { extractDayAndTime, ilDateString, ilParts, addDays, HE_WEEKDAY_NAMES } = require('../utils/callback_time');

const INTRO = 'אני תומר, העוזר הדיגיטלי של Shape Studio.';
const INTRO_GAP_MS = 7 * 24 * 3600 * 1000;       // a new service conversation = no Tomer message for a week
const ENRICH_WINDOW_MS = 24 * 3600 * 1000;       // an unclear follow-up joins a case touched in the last day

const MEMBERSHIP_STAFF = new Set(['membership_cancel', 'membership_freeze']);
const OUTCOMES = {
  done_in_arbox: 'הצוות ביצע ב-Arbox',
  declined:      'הבקשה לא אושרה',
  withdrawn:     'החבר/ה חזר/ה בו/ה',
  handled:       'טופל',
  no_action:     'לא נדרש טיפול',
  other:         'אחר',
};

const CATEGORY = {
  billing_dispute:   { label: 'בירור חיוב',               priority: 'high',   next: 'לבדוק את החיוב ולחזור לחבר/ה' },
  refund_request:    { label: 'בקשת זיכוי / החזר',        priority: 'high',   next: 'להחליט על זיכוי ולעדכן את החבר/ה' },
  billing_question:  { label: 'שאלת תשלום',               priority: 'normal', next: 'לענות לחבר/ה' },
  payment_issue:     { label: 'בעיית תשלום / אשראי',      priority: 'normal', next: 'לעדכן אמצעי תשלום מול החבר/ה' },
  payment_claim:     { label: 'דיווח על תשלום (לא אומת)', priority: 'normal', next: 'לאמת את התשלום ולעדכן ב-Arbox' },
  receipt_request:   { label: 'בקשת קבלה',                priority: 'normal', next: 'לשלוח קבלה' },
  membership_cancel: { label: 'בקשת ביטול מנוי',          priority: 'high',   next: 'ליצור קשר עם החבר/ה; ביטול מתבצע ב-Arbox על ידי הצוות בלבד' },
  membership_freeze: { label: 'בקשת הקפאת מנוי',          priority: 'normal', next: 'להחליט ולעדכן את החבר/ה; הקפאה מתבצעת ב-Arbox על ידי הצוות בלבד' },
  membership_renew:  { label: 'חידוש / שינוי מנוי',       priority: 'normal', next: 'ליצור קשר לגבי חידוש' },
  complaint:         { label: 'תלונה',                     priority: 'high',   next: 'ליצור קשר אישי עם החבר/ה' },
  injury:            { label: 'פציעה / מצב רפואי',        priority: 'high',   next: 'מענה מקצועי מהצוות' },
  staff_request:     { label: 'בקשה לדבר עם הצוות',       priority: 'normal', next: 'לחזור לחבר/ה' },
  app_problem:       { label: 'תקלה באפליקציה / ברישום',  priority: 'normal', next: 'לבדוק ולסייע ברישום' },
  regular_booking:   { label: 'שינוי שיבוץ קבוע',          priority: 'normal', next: 'לעדכן שיבוץ קבוע ב-Arbox' },
  missed_class:      { label: 'שיעור שהוחמץ',             priority: 'normal', next: 'להחליט לגבי חיוב ולעדכן' },
  media_message:     { label: 'הודעת מדיה שלא נקראה',     priority: 'normal', next: 'לפתוח את ההודעה בוואטסאפ' },
  general_request:   { label: 'פנייה כללית',              priority: 'normal', next: 'לענות לחבר/ה' },
  // opened from proactive member-care conversations
  member_feedback:   { label: 'משוב מליווי חברים',        priority: 'normal', next: 'ליצור קשר אישי ולהקשיב' },
  guest_pass:        { label: 'בקשה לאימון אורח',          priority: 'normal', next: 'לתאם אימון אורח ולעדכן את המימוש בפאנל' },
  data_review:       { label: 'בדיקת נתון ב-Arbox',        priority: 'normal', next: 'לבדוק נוכחות / רישום ב-Arbox ולעדכן את החבר/ה' },
};

const MEDIA_LABEL = { image: 'את התמונה', audio: 'את ההודעה הקולית', voice: 'את ההודעה הקולית', video: 'את הסרטון', document: 'את הקובץ', location: 'את המיקום', sticker: 'את המדבקה', contact: 'את איש הקשר' };
const MEDIA_CANT  = { image: 'לצפות בתמונות', audio: 'להאזין להודעות קוליות', voice: 'להאזין להודעות קוליות', video: 'לצפות בסרטונים', document: 'לפתוח קבצים', location: 'לפתוח מיקומים' };

// Statements Tomer must never make on its own authority (used on AI output only).
const CLAIM_RE = /ביטלתי|בוטל(?:ה)?(?![א-ת])|רשמתי אותך|נרשמת בהצלחה|שיבצתי|שריינתי|שמרתי לך|הקפאתי|הוקפא|זיכיתי|זוכית|החזרנו|התשלום (?:התקבל|אושר)|אישרתי|עדכנתי (?:את|ב)|יש מקום|נשאר(?:ו)? מקו|מקומות פנויים|יחזרו אליך (?:תוך|עד|היום|מחר)|תוך (?:שעה|יום|\d+)|עד (?:מחר|סוף היום)/;

const STUDIO_ADDRESS = 'דרך השדה 12, פרדס חנה-כרכור';

function createTomerService(deps) {
  const {
    leadStore, persist, logger, gateway, cases, tomerStore, inbox,
    sendText, getAssets = () => ({}), getBackendBase = () => null,
    managerPhone = () => null,                  // () => the ONE phone that receives case alerts
    sendManager = async () => { throw new Error('manager channel not configured'); },   // async (phone, text) => provider result
    ai = null,                                  // async ({ system, user }) => string
    sendTimetable = async () => false,          // async (phone) => true when the timetable image was sent
    applyTakeover = () => {},                   // (phone, text) — staff took the conversation
    allowed = () => true,                       // (phone) => may the new flow handle / message this phone (test-only restriction)
    getCare = () => null,                       // () => member-care service (proactive conversations) or null
    now = () => new Date(),
  } = deps;

  const isOptedOut = phone => leadStore.getLead(phone)?.status === 'opted_out';

  // ── formatting ──────────────────────────────────────────────────────────────
  const local = p => (String(p).startsWith('972') ? '0' + String(p).slice(3) : String(p));
  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `יום ${HE_WEEKDAY_NAMES[wd]}, ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
  }
  const fmtClass = c => `${c.name} — ${fmtDate(c.date)} בשעה ${c.start}${c.instructor ? ` (${c.instructor})` : ''}`;
  function occText(c) {
    if (!c.occupancy) return null;
    const o = c.occupancy;
    if (o.spotsLeft <= 0) return `מלא (${o.registered}/${o.capacity})${o.standby ? `, ${o.standby} ברשימת המתנה` : ''}`;
    return `רשומים ${o.registered} מתוך ${o.capacity}`;
  }
  const G = (m, f, male, neutral) => (m?.gender === 'female' ? f : m?.gender === 'male' ? male : (neutral ?? `${male}/ה`));
  const today = () => ilDateString(now());
  const plus  = n => { const p = ilParts(now()); return ilDateString(addDays({ year: p.year, month: p.month, day: p.day }, n)); };

  // ── outbound ────────────────────────────────────────────────────────────────
  /** Send a Tomer message to a member and record who / why / from which data. */
  async function say(phone, body, meta = {}) {
    // The approved introduction opens a NEW service conversation only: the first Tomer
    // message to this member, or the first after a week without one.
    const ms = cases.getMember(phone);
    const introduce = !ms?.introAt || !ms?.lastTomerAt || now().getTime() - new Date(ms.lastTomerAt).getTime() > INTRO_GAP_MS;
    const text = introduce ? `${INTRO}\n${body}` : body;
    let idMessage = null, state = 'sent', error = null;
    if (!allowed(phone)) {
      // Defence in depth: the send wrapper refuses too. Nothing is sent, nothing recorded as sent.
      logger.warn('[tomer] message withheld — recipient is not enabled for the new flow', { tail: String(phone).slice(-4) });
      return { state: 'blocked', idMessage: null, error: 'recipient_not_allowed' };
    }
    {
      let res = null, err = null;
      try { res = await sendText(phone, text, meta.sendOpts ?? {}); } catch (e) { err = e; }
      if (res?.queued) state = 'queued';
      else if (res?.blocked) state = 'blocked';
      else {
        // accepted → 'sent'; refused → 'failed'; no usable answer → 'uncertain' (may have arrived; never repeated blindly)
        const out = classifySend(res, err);
        state = out.state === 'accepted' ? 'sent' : out.state;
        idMessage = out.idMessage ?? null; error = out.error ?? null;
        if (state !== 'sent') logger.error('[tomer] send not accepted', { phone, state, error });
      }
    }
    const record = { agent: 'tomer', handler: meta.handler ?? null, trigger: meta.trigger ?? null, caseId: meta.caseId ?? null, actionId: meta.actionId ?? null, dataSource: meta.dataSource ?? null, sendState: state, idMessage, error };
    try { inbox.pushOutbound({ phone, name: meta.name ?? null, text, agentId: 'tomer', meta: record }); } catch { /* inbox is a view, not the source of truth */ }
    tomerStore.appendAudit({ phone, memberName: meta.name ?? null, event: 'tomer_message', tomerAction: `${meta.handler ?? 'reply'} (${meta.trigger ?? '-'})`, replyPreview: text.slice(0, 160), owner: 'tomer', taskId: meta.caseId ?? null, sendState: state, idMessage, dataSource: meta.dataSource ?? null });
    if (state === 'sent' || state === 'queued') {
      tomerStore.appendMemberHistory(phone, 'assistant', text);
      // Best effort: losing this write can only cause one extra introduction later.
      try { const at = now().toISOString(); cases.patchMember(phone, { lastTomerAt: at, ...(introduce ? { introAt: at } : {}) }); } catch { /* ignore */ }
    }
    return { state, idMessage, error };
  }

  // ── manager notification (ONE alert per case, to ONE phone) ─────────────────
  const dmy = iso => String(iso ?? '').split('-').reverse().join('.');
  const caseLink = id => { const base = getBackendBase(); return base ? `${base}/#tomer/case/${id}` : null; };

  function notificationText(c) {
    const cat = CATEGORY[c.category] ?? CATEGORY.general_request;
    const lastMember = [...(c.context ?? [])].reverse().find(x => x.from === 'member')?.text ?? '';
    const req = c.request;
    const link = caseLink(c.id);
    return [
      `🔔 פנייה חדשה מחבר/ה — ${cat.label}`,
      `👤 ${c.memberName ?? 'חבר/ה (שם לא ידוע)'}`,
      `📱 ${local(c.phone)} · https://wa.me/${c.phone}`,
      `📝 "${lastMember.slice(0, 280)}"`,
      req?.from ? `🗓 תאריכים מבוקשים: ${dmy(req.from)} – ${dmy(req.to)}` : null,
      c.facts?.summary ? `📊 Arbox: ${c.facts.summary}` : (c.memberUserId ? null : '📊 Arbox: החבר/ה לא זוהה/תה בוודאות'),
      MEMBERSHIP_STAFF.has(c.category) ? '⚠️ לא בוצע שום שינוי ב-Arbox — הטיפול אצל הצוות.' : null,
      link ? `📋 ${link}` : `🆔 ${c.id} (לשונית תומר ← פניות)`,
    ].filter(Boolean).join('\n');
  }

  /**
   * What happened to an outbound provider request.
   *   accepted  — the provider returned a real message id (not proof of delivery)
   *   failed    — it certainly did not go out (refused connection, 4xx, blocked, no id)
   *   uncertain — the request left and no usable answer came back (timeout, reset, 5xx):
   *               it may have been delivered, so it is never repeated automatically.
   */
  function classifySend(res, err) {
    if (err) {
      const status = err.response?.status;
      if (status && status < 500) return { state: 'failed', error: `provider rejected the request (${status})` };
      if (!err.response && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL/.test(String(err.code ?? ''))) return { state: 'failed', error: `provider unreachable (${err.code})` };
      if (!err.response && !err.code && !/timeout|socket|network|aborted/i.test(String(err.message))) return { state: 'failed', error: String(err.message).slice(0, 200) };
      return { state: 'uncertain', error: status ? `provider error ${status}` : String(err.code ?? err.message).slice(0, 200) };
    }
    if (res?.notAllowed) return { state: 'failed', error: 'recipient is not on the Tomer allowlist' };
    if (res?.blocked || res?.testMode) return { state: 'failed', error: 'send blocked (TEST_MODE)' };
    if (res?.demo)   return { state: 'failed', error: 'send intercepted (demo mode)' };
    if (res?.queued) return { state: 'failed', error: 'send was queued, not sent' };
    if (res?.idMessage) return { state: 'accepted', idMessage: res.idMessage, error: null };
    return { state: 'failed', error: 'provider returned no message id' };
  }

  const _notifying = new Set();   // case ids with an alert in flight in this process
  async function notifyStaff(caseId, { force = false, by = 'system' } = {}) {
    const c = cases.get(caseId);
    if (!c || !c.notification?.required) return c;
    const st = c.notification.state;
    if (st === 'accepted') return c;                       // one alert per case
    if (st === 'uncertain' && !force) return c;            // may already have arrived: explicit staff decision only
    if (_notifying.has(caseId)) return c;
    _notifying.add(caseId);
    try {
      const phone = managerPhone();
      if (!phone) {
        return cases.update(caseId, {}, { type: 'staff_notification_failed', by, detail: 'no manager phone configured' },
          { notificationPatch: { state: 'failed', inFlightSince: null, lastError: 'no manager phone configured', at: now().toISOString() } });
      }
      // Durable marker BEFORE the request leaves: after a crash the alert is found
      // "in flight" and becomes 'uncertain' — it is never replayed on startup.
      cases.update(caseId, {}, null, { notificationPatch: { state: 'pending', inFlightSince: now().toISOString(), attempts: (c.notification.attempts ?? 0) + 1 } });
      let res = null, err = null;
      try { res = await sendManager(phone, notificationText(c)); } catch (e) { err = e; }
      const out = classifySend(res, err);
      try {
        return cases.update(caseId, {},
          { type: out.state === 'accepted' ? 'staff_notified' : out.state === 'uncertain' ? 'staff_notification_uncertain' : 'staff_notification_failed', by, detail: out.error ?? null },
          { notificationPatch: {
            state: out.state, inFlightSince: null, lastError: out.error ?? null, at: now().toISOString(),
            idMessage: out.idMessage ?? c.notification.idMessage ?? null,
            sentTo: out.state === 'accepted' ? [...new Set([...(c.notification.sentTo ?? []), phone])] : (c.notification.sentTo ?? []),
          } });
      } catch (werr) {
        // The outcome could not be saved: the case stays 'pending / in flight' on disk and
        // will read as 'uncertain' after a restart. Nothing is claimed.
        logger.error('[tomer] notification outcome not saved', { caseId, outcome: out.state, error: werr.message });
        return cases.get(caseId);
      }
    } finally { _notifying.delete(caseId); }
  }

  // ── member facts (read-only, with source + freshness) ───────────────────────
  async function loadFacts(member, { fresh = false } = {}) {
    if (!member) return null;
    try {
      if (fresh) gateway.clearCache(`memberships:${member.userId}`);
      const r = await gateway.getMemberships(member.userId);
      const active = r.memberships.filter(m => m.active && !m.cancelled);
      const debt = r.memberships.reduce((s, m) => s + (m.debt ?? 0), 0);
      return {
        memberships: r.memberships, activeMemberships: active, debt, source: r.source, stale: !!r.stale,
        fetchedAt: new Date(r.fetchedAt ?? now().getTime()).toISOString(),
        summary: (active.length ? active.map(m => `${m.name}${m.endDate ? ` (עד ${m.endDate})` : ' (ללא תאריך סיום)'}`).join(', ') : 'אין מנוי פעיל') + (debt > 0 ? ` · יתרת חוב ${debt} ₪` : ''),
      };
    } catch (err) { return { error: err.message, summary: 'נתוני המנוי לא נקראו (Arbox לא זמין)', fetchedAt: now().toISOString() }; }
  }

  /** Add a member message to an existing open case (same issue → same case). */
  function enrich(c, ctx, detail = null) {
    if (ctx.messageId && (c.context ?? []).some(x => x.messageId === ctx.messageId)) return c;   // redelivered message
    const patch = { unreadMember: true };
    if (c.status === 'awaiting_member') patch.status = c.owner && c.owner !== 'tomer' ? 'in_progress' : 'awaiting_staff';
    return cases.update(c.id, patch, { type: 'member_followup', by: 'member', detail },
      { contextEntry: { from: 'member', text: ctx.text, ...(ctx.messageId ? { messageId: ctx.messageId } : {}) } });
  }
  const recentOpenCase = phone => cases.list({ phone, open: true, limit: 50 })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .find(c => now().getTime() - new Date(c.updatedAt).getTime() < ENRICH_WINDOW_MS) ?? null;

  /**
   * Open a case, or add the message to the member's open case of the SAME category.
   * A different category is a different issue and gets its own case. The case is on
   * disk before anything is said to anyone; the manager is alerted once per case.
   */
  async function openCase(ctx, category, { summary, nextAction = null, notify = true, request = null } = {}) {
    const cat = CATEGORY[category] ?? CATEGORY.general_request;
    const existing = cases.findOpen(ctx.phone, category);
    if (existing) return { case: enrich(existing, ctx), isNew: false };
    const facts = await loadFacts(ctx.member);
    let c = cases.create({
      phone: ctx.phone, memberUserId: ctx.member?.userId ?? null, memberName: ctx.member?.name ?? ctx.name ?? null,
      category, summary: summary ?? cat.label, priority: cat.priority, nextAction: nextAction ?? cat.next,
      memberText: ctx.text, memberMessageId: ctx.messageId ?? null, facts, notificationRequired: notify, request,
    });
    if (notify) c = await notifyStaff(c.id);
    tomerStore.appendAudit({ phone: ctx.phone, memberName: c.memberName, event: 'case_opened', tomerAction: category, requestPreview: String(ctx.text ?? '').slice(0, 100), owner: 'tomer', taskId: c.id });
    return { case: c, isNew: true };
  }

  // ── class resolution ────────────────────────────────────────────────────────
  const NAME_HINTS = [
    [/מכשירים|רפורמר|reformer/i, /מכשירים|reformer/i], [/פאוור|power/i, /פאוור|power/i], [/בר(?![א-ת])|barre/i, /בר(?![א-ת])|barre/i],
    [/כ[ו]?ח(?![א-ת])|strength|סטרנג/i, /כח|כוח|strength/i], [/יוגה|yoga/i, /יוגה|yoga/i], [/קנגו|kangoo/i, /קנגו|kangoo/i],
    [/טונינג|toning|חיטוב|עיצוב/i, /toning|טונינג|חיטוב|עיצוב/i], [/all in|אול אין/i, /all in/i], [/פילאטיס|pilates/i, /פילאטיס|pilates/i],
  ];
  function filterClasses(classes, text, { day, hour }) {
    let out = classes;
    if (day) { const d = ilDateString(day); out = out.filter(c => c.date === d); }
    if (hour) {
      const hh = [hour.h, ...(hour.ambiguous && hour.h < 12 ? [hour.h + 12] : [])];
      const exact = out.filter(c => hh.includes(Number(c.start.slice(0, 2))) && (hour.min ? Number(c.start.slice(3, 5)) === hour.min : true));
      out = exact.length ? exact : out.filter(c => hh.includes(Number(c.start.slice(0, 2))));
    }
    const hint = NAME_HINTS.find(([q]) => q.test(text));
    if (hint) { const m = out.filter(c => hint[1].test(c.name)); if (m.length || hour || day) out = m; }
    const firstNames = [...new Set(classes.map(c => (c.instructor ?? '').split(/\s+/)[0]).filter(n => n.length >= 2))];
    const who = firstNames.find(n => new RegExp(`(?<![א-ת])${n}(?![א-ת])`).test(text));
    if (who) { const m = out.filter(c => (c.instructor ?? '').startsWith(who)); if (m.length) out = m; }
    return out;
  }
  const upcomingOnly = cls => { const p = ilParts(now()); const t = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; const d = today(); return cls.filter(c => c.date > d || (c.date === d && c.start > t)); };
  const sameClass = (b, c) => b.date === c.date && b.time === c.start && (b.className ?? '').trim() === (c.name ?? '').trim();

  async function resolveClass(ctx, { range = 7 } = {}) {
    const dt = extractDayAndTime(ctx.text, ctx.sentAt);
    if (dt.invalid) return { error: 'invalid_date' };
    const from = today(), to = plus(range);
    const data = await gateway.getClasses({ from, to });
    const pool = upcomingOnly(data.classes);
    const hasFilter = !!(dt.day || dt.hour || NAME_HINTS.some(([q]) => q.test(ctx.text)));
    const matches = hasFilter ? filterClasses(pool, ctx.text, dt) : [];
    return { dt, data, matches, hasFilter };
  }

  // ── handlers ────────────────────────────────────────────────────────────────
  const R = (route, extra = {}) => ({ route: 'tomer', outcome: route, ...extra });
  const arboxDown = ctx => say(ctx.phone, `אין לי כרגע גישה לנתונים מ-Arbox, אז אני לא ${G(ctx.member, 'רוצה', 'רוצה', 'רוצה')} לנחש. אפשר לנסות שוב בעוד כמה דקות, ואם זה דחוף — כתבו לי ואפתח פנייה לצוות.`, { handler: 'arbox_unavailable', trigger: ctx.category, name: ctx.name });

  async function hLocation(ctx) {
    const waze = getAssets()?.wazeUrl;
    await say(ctx.phone, waze ? `${STUDIO_ADDRESS} 🗺️\n${waze}` : STUDIO_ADDRESS, { handler: 'location', trigger: ctx.category, dataSource: 'studio_assets', name: ctx.name });
    return R('answered');
  }

  async function hSchedule(ctx) {
    const dt = extractDayAndTime(ctx.text, ctx.sentAt);
    if (!dt.day && /לוז|לו"ז|לו״ז|מערכת|לוח|שבועי|תמונה/.test(ctx.text) && await sendTimetable(ctx.phone)) {
      tomerStore.appendAudit({ phone: ctx.phone, event: 'tomer_message', tomerAction: 'timetable image', owner: 'tomer', dataSource: 'studio_assets' });
      return R('answered');
    }
    let data;
    try { data = await gateway.getClasses({ from: today(), to: plus(dt.day ? 7 : 2) }); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    let pool = upcomingOnly(data.classes);
    const tod = /בבוקר|שעות (?:ה)?בוקר|בוקר/.test(ctx.text) ? c => c.start < '12:00' : /צהריים/.test(ctx.text) ? c => c.start >= '11:30' && c.start < '16:00' : /בערב|ערב|אחה"צ|אחר הצהריים/.test(ctx.text) ? c => c.start >= '16:00' : null;
    pool = filterClasses(pool, ctx.text, { day: dt.day, hour: dt.hour });
    if (tod) pool = pool.filter(tod);
    if (!pool.length) {
      await say(ctx.phone, dt.day ? `לא מצאתי ב-Arbox שיעורים מתאימים ב${fmtDate(ilDateString(dt.day))}.` : `לא מצאתי ב-Arbox שיעורים מתאימים בימים הקרובים.`, { handler: 'schedule', trigger: ctx.category, dataSource: data.source, name: ctx.name });
      return R('answered');
    }
    const byDate = new Map();
    for (const c of pool.slice(0, 24)) byDate.set(c.date, [...(byDate.get(c.date) ?? []), c]);
    const blocks = [...byDate].map(([d, list]) => `${fmtDate(d)}:\n` + list.map(c => `• ${c.start} ${c.name}${c.instructor ? ` — ${c.instructor}` : ''}${occText(c) ? ` (${occText(c)})` : ''}`).join('\n'));
    const note = data.occupancyAvailable ? 'מספר הרשומים נכון לרגע זה לפי Arbox.' : 'אין לי כרגע נתוני תפוסה וביטולי שיעורים מ-Arbox — זו המערכת המתוכננת בלבד, בלי מידע על מקומות פנויים או על שיעור שבוטל.';
    await say(ctx.phone, `${blocks.join('\n\n')}\n\n${note}`, { handler: 'schedule', trigger: ctx.category, dataSource: data.source + (data.stale ? ' (stale)' : ''), name: ctx.name });
    return R('answered');
  }

  async function describeOne(ctx, c, { intro }) {
    const lines = [intro, fmtClass(c)];
    if (c.occupancy) lines.push(c.occupancy.spotsLeft > 0
      ? `נכון לרגע זה רשומים ${c.occupancy.registered} מתוך ${c.occupancy.capacity}.`
      : `נכון לרגע זה השיעור מלא (${c.occupancy.registered}/${c.occupancy.capacity})${c.occupancy.standby ? `, ו-${c.occupancy.standby} ברשימת המתנה` : ''}.`);
    else lines.push('אין לי כרגע נתוני תפוסה לשיעור הזה.');
    return lines;
  }

  async function hBook(ctx, { reschedule = false } = {}) {
    if (!ctx.member) { await say(ctx.phone, `לא הצלחתי לזהות אותך ב-Arbox לפי מספר הטלפון, אז אין לי אפשרות לבדוק רישומים. ההרשמה לשיעורים נעשית באפליקציית Arbox.`, { handler: 'book', trigger: ctx.category, name: ctx.name }); return R('answered'); }
    let rc;
    try { rc = await resolveClass(ctx); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    if (rc.error) { await say(ctx.phone, `התאריך שכתבת לא קיים בלוח השנה 🙂 לאיזה יום הכוונה?`, { handler: 'book', trigger: ctx.category, name: ctx.name }); return R('clarification'); }
    if (!rc.hasFilter || !rc.matches.length) {
      const dayTxt = rc.dt.day ? ` ב${fmtDate(ilDateString(rc.dt.day))}` : '';
      await say(ctx.phone, rc.hasFilter ? `לא מצאתי ב-Arbox שיעור שמתאים למה שכתבת${dayTxt}. לאיזה שיעור הכוונה — יום, שעה וסוג?` : `לאיזה שיעור הכוונה? כתבו לי יום, שעה וסוג השיעור.`, { handler: 'book', trigger: ctx.category, dataSource: rc.data.source, name: ctx.name });
      cases.setConv(ctx.phone, 'class_choice', { purpose: reschedule ? 'reschedule' : 'book', options: [] }, 30);
      return R('clarification');
    }
    if (rc.matches.length > 1) {
      const opts = rc.matches.slice(0, 6);
      await say(ctx.phone, `מצאתי כמה שיעורים מתאימים — לאיזה מהם?\n` + opts.map((c, i) => `${i + 1}. ${fmtClass(c)}`).join('\n'), { handler: 'book', trigger: ctx.category, dataSource: rc.data.source, name: ctx.name });
      cases.setConv(ctx.phone, 'class_choice', { purpose: reschedule ? 'reschedule' : 'book', options: opts.map(c => ({ scheduleId: c.scheduleId, date: c.date, start: c.start, name: c.name })) }, 30);
      return R('clarification');
    }
    return offerClass(ctx, rc.matches[0], { reschedule });
  }

  async function offerClass(ctx, c, { reschedule = false } = {}) {
    let booked = false;
    try { const b = await gateway.getBookings(ctx.member.userId, { from: c.date, to: c.date, fresh: true }); booked = b.bookings.some(x => sameClass(x, c)); } catch { /* shown as unknown below */ }
    if (booked) {
      await say(ctx.phone, `לפי Arbox ${G(ctx.member, 'את כבר רשומה', 'אתה כבר רשום', 'כבר קיים רישום שלך')} ✅\n${fmtClass(c)}`, { handler: 'book', trigger: ctx.category, dataSource: '/v3/reports/bookingsReport', name: ctx.name });
      cases.clearConv(ctx.phone);
      return R('answered');
    }
    const lines = await describeOne(ctx, c, { intro: reschedule ? 'אני לא יכול להעביר רישום בעצמי. הדרך הבטוחה היא קודם להירשם לשיעור החדש, ורק אחרי שהרישום נקלט — לבטל את הישן באפליקציה.' : 'אני לא יכול לבצע רישום במקומך דרך וואטסאפ, אבל הנה השיעור:' });
    if (c.registrationLink) lines.push(`להרשמה: ${c.registrationLink}`);
    else lines.push('ההרשמה נעשית באפליקציית Arbox.');
    lines.push(`אחרי ההרשמה כתבו לי "נרשמתי" ואוודא מול Arbox שהרישום נקלט.`);
    await say(ctx.phone, lines.join('\n'), { handler: 'book', trigger: ctx.category, dataSource: 'arbox schedule + occupancy', name: ctx.name });
    cases.setConv(ctx.phone, 'verify_booking', { scheduleId: c.scheduleId, date: c.date, start: c.start, name: c.name, reschedule }, 180);
    return R('self_service_offered');
  }

  async function hVerifyBooking(ctx, d) {
    let b;
    try { b = await gateway.getBookings(ctx.member.userId, { from: d.date, to: d.date, fresh: true }); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    const ok = b.bookings.some(x => sameClass(x, { date: d.date, start: d.start, name: d.name }));
    if (ok) {
      cases.clearConv(ctx.phone);
      await say(ctx.phone, `מאומת ✅ לפי Arbox ${G(ctx.member, 'את רשומה', 'אתה רשום', 'הרישום שלך קיים')}: ${d.name} — ${fmtDate(d.date)} בשעה ${d.start}.` + (d.reschedule ? `\nעכשיו אפשר לבטל את הרישום הישן באפליקציה; כתבו לי "ביטלתי" ואוודא גם אותו.` : ''), { handler: 'verify_booking', trigger: 'member_confirmation', dataSource: b.source, name: ctx.name });
      if (d.reschedule) cases.setConv(ctx.phone, 'verify_cancel', {}, 120);
      return R('verified');
    }
    await say(ctx.phone, `עדיין לא רואה ב-Arbox רישום שלך ל${d.name} ב${fmtDate(d.date)} בשעה ${d.start}. אם ניסית להירשם ולא הצליח — כתבו לי מה קרה ואפתח פנייה לצוות.`, { handler: 'verify_booking', trigger: 'member_confirmation', dataSource: b.source, name: ctx.name });
    return R('not_verified');
  }

  async function myUpcoming(ctx, days = 7) {
    const r = await gateway.getBookings(ctx.member.userId, { from: today(), to: plus(days), fresh: true });
    const p = ilParts(now()); const t = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    return { ...r, bookings: r.bookings.filter(b => b.date > today() || (b.date === today() && b.time > t)) };
  }

  async function hMyBookings(ctx) {
    if (!ctx.member) return hUnidentified(ctx);
    let r; try { r = await myUpcoming(ctx); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    await say(ctx.phone, r.bookings.length
      ? `לפי Arbox, הרישומים שלך לשבוע הקרוב:\n` + r.bookings.map(b => `• ${b.className} — ${fmtDate(b.date)} בשעה ${b.time}`).join('\n')
      : `לפי Arbox אין לך כרגע רישומים לשבוע הקרוב.`, { handler: 'my_bookings', trigger: ctx.category, dataSource: r.source, name: ctx.name });
    return R('answered');
  }

  async function hClassCancel(ctx) {
    if (!ctx.member) return hUnidentified(ctx);
    let r; try { r = await myUpcoming(ctx, 7); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    const dt = extractDayAndTime(ctx.text, ctx.sentAt);
    let mine = r.bookings;
    if (dt.day) mine = mine.filter(b => b.date === ilDateString(dt.day));
    else mine = mine.filter(b => b.date <= plus(1));
    if (!mine.length) {
      await say(ctx.phone, `בדקתי ב-Arbox ולא מצאתי רישום שלך ${dt.day ? `ב${fmtDate(ilDateString(dt.day))}` : 'להיום או למחר'}, כך שאין רישום לבטל.`, { handler: 'class_cancel', trigger: ctx.category, dataSource: r.source, name: ctx.name });
      return R('answered');
    }
    await say(ctx.phone, [
      mine.length === 1 ? `לפי Arbox ${G(ctx.member, 'את רשומה', 'אתה רשום', 'קיים רישום שלך')} ל:` : `לפי Arbox הרישומים שלך:`,
      ...mine.map(b => `• ${b.className} — ${fmtDate(b.date)} בשעה ${b.time}`),
      `אני לא יכול לבטל רישום דרך וואטסאפ — הביטול נעשה באפליקציית Arbox. הרישום עדיין קיים.`,
      `אחרי הביטול כתבו לי "ביטלתי" ואוודא מול Arbox שהוא נקלט.`,
    ].join('\n'), { handler: 'class_cancel', trigger: ctx.category, dataSource: r.source, name: ctx.name });
    cases.setConv(ctx.phone, 'verify_cancel', { expected: mine.map(b => ({ date: b.date, time: b.time, className: b.className })) }, 180);
    return R('self_service_offered');
  }

  async function hCancelledReport(ctx, expected = null) {
    if (!ctx.member) return hUnidentified(ctx);
    let still, canc;
    try {
      still = await myUpcoming(ctx, 7);
      canc  = await gateway.getCancellations(ctx.member.userId, { from: today(), to: plus(7) });
    } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    // A recorded cancellation of an UPCOMING class that is no longer booked. Matching is by
    // class identity (date + time + name), not by the cancellation timestamp, whose
    // timezone the API does not state.
    const same = (x, y) => x.date === y.date && x.time === y.time && (x.className ?? '') === (y.className ?? '');
    const pending = expected ? still.bookings.filter(b => expected.some(e => same(e, b))) : [];
    const recent = canc.cancellations
      .filter(c => !still.bookings.some(b => same(b, c)))
      .filter(c => !expected || expected.some(e => same(e, c)));
    if (recent.length && !pending.length) {
      cases.clearConv(ctx.phone);
      await say(ctx.phone, `מאומת ✅ לפי Arbox נרשם ביטול של:\n` + recent.slice(0, 4).map(c => `• ${c.className} — ${fmtDate(c.date)} בשעה ${c.time}`).join('\n'), { handler: 'verify_cancel', trigger: ctx.category, dataSource: canc.source, name: ctx.name });
      return R('verified');
    }
    const near = (pending.length ? pending : still.bookings.filter(b => b.date <= plus(1)));
    await say(ctx.phone, near.length
      ? `לא רואה ב-Arbox ביטול שנרשם לשיעורים הקרובים. לפי Arbox הרישום עדיין קיים:\n` + near.map(b => `• ${b.className} — ${fmtDate(b.date)} בשעה ${b.time}`).join('\n') + `\nאם ביטלת באפליקציה וזה לא נקלט — כתבו לי ואפתח פנייה לצוות.`
      : `לא רואה ב-Arbox ביטול שנרשם לשיעורים הקרובים, וגם לא רישום פתוח שלך להיום או למחר.`, { handler: 'verify_cancel', trigger: ctx.category, dataSource: canc.source, name: ctx.name });
    return R('not_verified');
  }

  async function hAvailability(ctx) {
    let rc; try { rc = await resolveClass(ctx); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    if (rc.error || !rc.matches.length) return hSchedule(ctx);
    const lines = [];
    for (const c of rc.matches.slice(0, 4)) lines.push(`• ${fmtClass(c)} — ${occText(c) ?? 'אין נתוני תפוסה כרגע'}`);
    await say(ctx.phone, `נכון לרגע זה לפי Arbox:\n${lines.join('\n')}`, { handler: 'availability', trigger: ctx.category, dataSource: rc.data.source, name: ctx.name });
    return R('answered');
  }

  async function hWaitlist(ctx) {
    let rc; try { rc = await resolveClass(ctx); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
    const c = rc.matches?.length === 1 ? rc.matches[0] : null;
    const lines = [];
    if (c) lines.push(`${fmtClass(c)} — ${occText(c) ?? 'אין נתוני תפוסה כרגע'}.`);
    lines.push(`הצטרפות לרשימת המתנה או יציאה ממנה נעשות באפליקציית Arbox — אין לי אפשרות לעשות זאת, וגם אין לי גישה למיקום שלך ברשימה.`);
    await say(ctx.phone, lines.join('\n'), { handler: 'waitlist', trigger: ctx.category, dataSource: c ? rc.data.source : null, name: ctx.name });
    return R('answered');
  }

  async function hMembershipInfo(ctx) {
    if (!ctx.member) return hUnidentified(ctx);
    const f = await loadFacts(ctx.member);
    if (!f || f.error) { await arboxDown(ctx); return R('arbox_unavailable'); }
    let sessions = null;
    try {
      const b = await gateway.getBookings(ctx.member.userId, { from: plus(-21), to: plus(7) });
      const withCount = b.bookings.filter(x => x.sessionsLeft !== null);
      if (withCount.length) sessions = withCount[withCount.length - 1].sessionsLeft;
    } catch { /* optional */ }
    const lines = [];
    if (!f.activeMemberships.length) lines.push(`לפי Arbox אין כרגע מנוי פעיל על שמך.`);
    else for (const m of f.activeMemberships.filter(x => x.type !== 'item')) lines.push(`${m.name}: ${m.endDate ? `בתוקף עד ${m.endDate.split('-').reverse().join('.')}` : 'פעיל, ללא תאריך סיום רשום'}.`);
    if (!lines.length) lines.push(`לפי Arbox יש על שמך רכישות פעילות, אבל לא מנוי תקופתי.`);
    if (/כניס|אימונ|שיעור|נשאר|נותר/.test(ctx.text)) lines.push(sessions !== null ? `כניסות שנותרו לפי הרישום האחרון ב-Arbox: ${sessions}.` : `מספר הכניסות שנותרו לא מופיע בנתונים שיש לי גישה אליהם.`);
    await say(ctx.phone, lines.join('\n'), { handler: 'membership_info', trigger: ctx.category, dataSource: f.source, name: ctx.name });
    return R('answered');
  }

  async function hUnidentified(ctx) {
    const { case: c, isNew } = await openCase(ctx, 'general_request', { summary: 'חבר/ה שלא זוהה/תה ב-Arbox ביקש/ה מידע אישי' });
    await say(ctx.phone, `לא הצלחתי לזהות אותך בוודאות ב-Arbox לפי מספר הטלפון, ולכן אני לא מציג נתונים אישיים. ${isNew ? 'רשמתי פנייה לצוות.' : 'הוספתי את ההודעה לפנייה שכבר רשומה אצל הצוות.'}`, { handler: 'unidentified', trigger: ctx.category, caseId: c.id, name: ctx.name });
    return R(isNew ? 'case_opened' : 'case_updated', { caseId: c.id });
  }

  // Dates for a freeze: two explicit dates in the text.
  const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'מרס', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const HE_MONTH_NUM = { ינואר: 1, פברואר: 2, מרץ: 3, מרס: 3, אפריל: 4, מאי: 5, יוני: 6, יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12 };
  function freezeDates(rawText, ref) {
    // "1 לינואר" / "15 בדצמבר 2026" → "1.1" / "15.12.2026"
    const text = String(rawText).replace(new RegExp('(\\d{1,2})\\s*(?:ב|ל)?-?(' + HE_MONTHS.join('|') + ')(?:\\s+(\\d{4}))?', 'g'),
      (_, d, mo, y) => d + '.' + HE_MONTH_NUM[mo] + (y ? '.' + y : ''));
    const re = /(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/g; const found = [];
    let m; const p = ilParts(ref);
    while ((m = re.exec(text))) {
      let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : p.year;
      const mo = +m[2], d = +m[1];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const chk = new Date(Date.UTC(y, mo - 1, d)); if (chk.getUTCMonth() !== mo - 1) continue;
      if (!m[3] && Date.UTC(y, mo - 1, d) < Date.UTC(p.year, p.month, p.day) - 45 * 86400000) y += 1;
      found.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return found.length >= 2 && found[1] >= found[0] ? { from: found[0], to: found[1] } : null;
  }

  // ── membership cancellation / freeze: STAFF-HANDLED ─────────────────────────
  // Tomer records the request and alerts the manager. Nothing is changed in Arbox by
  // the system; the member is told the request was recorded — never that it was done,
  // and never by when.
  async function membershipRequest(ctx, type, extra = {}) {
    const f = await loadFacts(ctx.member);
    const plans = (f?.activeMemberships ?? []).filter(m => m.type === 'plan' || m.type === 'session');
    return { type, userId: ctx.member?.userId ?? null, membershipUserId: plans.length === 1 ? plans[0].membershipUserId : null, from: null, to: null, ...extra };
  }

  async function hFreeze(ctx) {
    const dates = freezeDates(ctx.text, ctx.sentAt);
    const existing = cases.findOpen(ctx.phone, 'membership_freeze');
    const { case: c0, isNew } = await openCase(ctx, 'membership_freeze', {
      summary: `בקשת הקפאת מנוי${dates ? ` ${dmy(dates.from)} – ${dmy(dates.to)}` : ' (ללא תאריכים)'}`,
      request: existing ? null : await membershipRequest(ctx, 'membership_freeze', { from: dates?.from ?? null, to: dates?.to ?? null }),
    });
    let c = c0;
    if (!isNew) {
      if (dates && !c.request?.from) c = cases.update(c.id, { request: { ...(c.request ?? { type: 'membership_freeze' }), ...dates }, summary: `בקשת הקפאת מנוי ${dmy(dates.from)} – ${dmy(dates.to)}` }, { type: 'request_details_added', by: 'member', detail: `${dates.from} – ${dates.to}` });
      await say(ctx.phone, `בקשת ההקפאה שלך כבר רשומה אצל הצוות — הוספתי את ההודעה לפנייה. המנוי לא הוקפא בשלב זה.`, { handler: 'freeze', trigger: ctx.category, caseId: c.id, name: ctx.name });
      return R('case_updated', { caseId: c.id });
    }
    if (dates) {
      await say(ctx.phone, `קיבלתי את בקשת ההקפאה לתאריכים ${dmy(dates.from)} – ${dmy(dates.to)} ורשמתי אותה לטיפול הצוות.\nהמנוי לא הוקפא בשלב זה — הקפאה מתבצעת רק על ידי הצוות.`, { handler: 'freeze', trigger: ctx.category, caseId: c.id, name: ctx.name });
    } else {
      // Dates are optional detail: the case is already open; the member may add them.
      await say(ctx.phone, `קיבלתי את בקשת ההקפאה ורשמתי אותה לטיפול הצוות. המנוי לא הוקפא בשלב זה — הקפאה מתבצעת רק על ידי הצוות.\nאם כבר ידועים לך תאריכים, אפשר לכתוב לי אותם ואוסיף לפנייה.`, { handler: 'freeze', trigger: ctx.category, caseId: c.id, name: ctx.name });
      cases.setConv(ctx.phone, 'freeze_dates', { caseId: c.id }, 24 * 60);
    }
    return R('case_opened', { caseId: c.id });
  }

  async function hMembershipCancel(ctx) {
    const existing = cases.findOpen(ctx.phone, 'membership_cancel');
    const { case: c, isNew } = await openCase(ctx, 'membership_cancel', {
      summary: 'בקשת ביטול מנוי',
      request: existing ? null : await membershipRequest(ctx, 'membership_cancel'),
    });
    await say(ctx.phone, isNew
      ? `קיבלתי את בקשתך לבטל את המנוי ורשמתי אותה לטיפול הצוות.\nהמנוי לא בוטל בשלב זה — ביטול מתבצע רק על ידי הצוות.`
      : `בקשת ביטול המנוי שלך כבר רשומה אצל הצוות — הוספתי את ההודעה לפנייה. המנוי לא בוטל בשלב זה.`, { handler: 'membership_cancel', trigger: ctx.category, caseId: c.id, name: ctx.name });
    return R(isNew ? 'case_opened' : 'case_updated', { caseId: c.id });
  }

  // Every text below is sent only AFTER the case is on disk, and claims only that the
  // request was recorded — not that staff saw it, and not by when it will be handled.
  const CASE_REPLY = {
    billing_dispute:  `קיבלתי. אין לי אפשרות לבדוק או לשנות חיובים, אז רשמתי פנייה לצוות עם מה שכתבת. לא בוצע שום שינוי בחיוב בשלב זה.`,
    refund_request:   `קיבלתי את הבקשה. זיכוי או החזר הם החלטה של הצוות — רשמתי פנייה לטיפולם. לא בוצע זיכוי בשלב זה.`,
    billing_question: `קיבלתי. אין לי גישה לנתוני התשלום שלך — רשמתי את השאלה כפנייה לצוות.`,
    payment_issue:    `קיבלתי. עדכון אמצעי תשלום נעשה מול הצוות — רשמתי פנייה לטיפולם.`,
    payment_claim:    `קיבלתי את ההודעה על התשלום. אני לא יכול לאמת תשלומים — רשמתי אותה לבדיקת הצוות. זה עדיין לא אישור שהתשלום התקבל.`,
    receipt_request:  `קיבלתי. אין לי אפשרות להפיק קבלות — רשמתי פנייה לצוות.`,
    membership_renew: `קיבלתי. חידוש או שינוי מנוי נעשים מול הצוות — רשמתי פנייה לטיפולם. לא בוצע שינוי במנוי בשלב זה.`,
    complaint:        `מצטער לשמוע. רשמתי את הדברים כפי שכתבת כפנייה לצוות — זה נושא שהם צריכים לענות עליו, לא אני.`,
    injury:           `תודה על העדכון. אני עוזר דיגיטלי ולא יכול לתת הנחיה רפואית או הנחיית אימון בנושא כזה. רשמתי את ההודעה כפנייה לצוות המקצועי; עד שידברו איתך, לא כדאי להסתמך על תשובה ממני.`,
    staff_request:    `קיבלתי — רשמתי פנייה לצוות עם הבקשה ליצור איתך קשר. אם יש נושא או זמן שנוח לך, אפשר לכתוב לי ואוסיף לפנייה.`,
    app_problem:      `מצטער על התקלה. אין לי אפשרות לבצע את הפעולה במקומך באפליקציה — רשמתי פנייה לצוות עם מה שכתבת.`,
    regular_booking:  `קיבלתי. שיבוץ קבוע מנוהל על ידי הצוות — רשמתי פנייה לטיפולם. לא בוצע שינוי בשיבוץ בשלב זה.`,
    missed_class:     `קיבלתי. אין לי סמכות להחליט לגבי שיעור שהוחמץ — רשמתי פנייה לצוות.`,
    general_request:  `קיבלתי. אין לי מידע מאומת כדי לענות על זה בעצמי — רשמתי פנייה לצוות עם מה שכתבת.`,
  };
  const FOLLOWUP_REPLY = `הפנייה שלך בנושא כבר רשומה אצל הצוות — הוספתי את ההודעה אליה.`;

  async function hCase(ctx, category, opts = {}) {
    const { case: c, isNew } = await openCase(ctx, category, opts);
    await say(ctx.phone, isNew ? CASE_REPLY[category] : FOLLOWUP_REPLY, { handler: 'case', trigger: ctx.category, caseId: c.id, name: ctx.name });
    if (isNew && category === 'staff_request') cases.setConv(ctx.phone, 'callback_details', { caseId: c.id }, 45);
    return R(isNew ? 'case_opened' : 'case_updated', { caseId: c.id });
  }

  async function hMedia(ctx) {
    const kind = ctx.type;
    const existing = cases.findOpen(ctx.phone, 'media_message');
    const { case: c, isNew } = await openCase({ ...ctx, text: `[${kind}]${ctx.caption ? ' ' + ctx.caption : ''}` }, 'media_message', { summary: `התקבל/ה ${MEDIA_LABEL[kind]?.replace('את ', '') ?? 'הודעת מדיה'} — לא נקרא/ה על ידי הבוט` });
    if (existing && !isNew) return R('case_updated', { caseId: c.id });           // one explanation per open case
    await say(ctx.phone, `קיבלתי ${MEDIA_LABEL[kind] ?? 'את ההודעה'}. אין לי אפשרות ${MEDIA_CANT[kind] ?? 'לפתוח הודעות מהסוג הזה'}, ולכן זה לא נחשב אישור של שום דבר. רשמתי לצוות שיש הודעה לפתוח; אם זו בקשה, אפשר גם לכתוב לי אותה במילים.`, { handler: 'media', trigger: kind, caseId: c.id, name: ctx.name });
    return R('case_opened', { caseId: c.id });
  }

  async function hOptOut(ctx) {
    const cur = leadStore.getLead(ctx.phone) ?? {};
    leadStore.upsertLead(ctx.phone, { status: 'opted_out', meta: { ...(cur.meta ?? {}), optedOutAt: new Date().toISOString(), optedOutMsg: String(ctx.text).slice(0, 80), previousStatus: cur.status ?? 'converted_member', isConfirmedMember: true } });
    leadStore.logEvent('opted_out', ctx.phone, { via: 'tomer' });
    persist.saveLeads(leadStore);
    await say(ctx.phone, `הסרתי אותך מהודעות אוטומטיות — לא אשלח הודעות נוספות. הצוות עדיין רואה את מה שנכתב כאן.`, { handler: 'opt_out', trigger: ctx.category, name: ctx.name });
    return R('opted_out');
  }

  async function hGeneralQuestion(ctx) {
    if (!ai) return hCase(ctx, 'general_request');
    const a = getAssets() ?? {};
    const system = [
      'אתה תומר, העוזר הדיגיטלי של Shape Studio (סטודיו בפרדס חנה-כרכור). אתה עונה לחבר/ה קיים/ת בוואטסאפ.',
      'ענה אך ורק על סמך "עובדות מאומתות" למטה. אם התשובה לא נמצאת שם — החזר בדיוק את המילה NEED_STAFF ושום דבר אחר.',
      'אסור: להבטיח זמן תגובה, לטעון שפעולה בוצעה, לציין מקומות פנויים, מחירים, מדיניות ביטול/הקפאה/חיוב, או עצה רפואית.',
      'עברית טבעית וקצרה (1–3 משפטים), בלי Markdown, בלי קישורים שלא הופיעו בעובדות, לכל היותר אימוג׳י אחד.',
      '',
      'עובדות מאומתות:',
      `- כתובת: ${STUDIO_ADDRESS}`,
      a.wazeUrl ? `- קישור Waze: ${a.wazeUrl}` : null,
      '- הרשמה וביטול שיעורים נעשים על ידי החבר/ה באפליקציית Arbox; תומר לא יכול לבצע אותם.',
      '- הקפאה, ביטול וחידוש מנוי, זיכויים ושינויי חיוב דורשים את אישור הצוות.',
    ].filter(Boolean).join('\n');
    let out = null;
    try { out = (await ai({ system, user: ctx.text }))?.trim() ?? null; } catch (err) { logger.warn('[tomer] model unavailable', { error: err.message }); }
    const clean = out ? out.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2').trim() : null;
    if (!clean || /NEED_STAFF/.test(clean) || CLAIM_RE.test(clean) || clean.length > 500) {
      if (clean && CLAIM_RE.test(clean)) tomerStore.appendAudit({ phone: ctx.phone, event: 'tomer_guard_blocked', tomerAction: 'model output contained an unsupported claim', replyPreview: clean.slice(0, 160), owner: 'tomer' });
      return hCase(ctx, 'general_request');
    }
    await say(ctx.phone, clean, { handler: 'general_question', trigger: ctx.category, dataSource: 'model on verified facts', name: ctx.name });
    return R('answered');
  }

  async function hUnknown(ctx) {
    // A request that names no topic, while a case was touched in the last day: it is
    // about that case. It is added there and acknowledged — never dropped silently.
    const open = recentOpenCase(ctx.phone);
    if (open) {
      enrich(open, ctx);
      await say(ctx.phone, `הוספתי את ההודעה לפנייה שלך שרשומה אצל הצוות.`, { handler: 'case_followup', trigger: ctx.category, caseId: open.id, name: ctx.name });
      return R('case_updated', { caseId: open.id });
    }
    await say(ctx.phone, `קיבלתי 🙏 כדי שאטפל נכון — במה מדובר: שיעור, מנוי, תשלום או משהו אחר?`, { handler: 'clarify', trigger: ctx.category, name: ctx.name });
    cases.setConv(ctx.phone, 'topic', { original: ctx.text }, 60);
    return R('clarification');
  }

  // ── conversation state ──────────────────────────────────────────────────────
  const DONE_RE = /נרשמתי|עשיתי|בוצע|הצלחתי|נרשמנו|רשמתי את עצמי|זהו|סיימתי/;
  async function handleState(ctx, conv, cls) {
    const strong = !NO_REPLY.has(cls.category) && cls.category !== 'unknown_request' && cls.category !== 'general_question';
    switch (conv.awaiting) {
      case 'verify_booking':
        if (DONE_RE.test(ctx.text)) return hVerifyBooking(ctx, conv.data);
        return null;
      case 'verify_cancel':
        if (cls.category === 'class_cancelled_report' || /ביטלתי|בוטל|הורדתי/.test(ctx.text)) return hCancelledReport(ctx, conv.data.expected ?? null);
        return null;
      case 'class_choice': {
        if (strong && !['class_book', 'class_reschedule', 'schedule_query', 'availability'].includes(cls.category)) return null;
        const opts = conv.data.options ?? [];
        const n = ctx.text.match(/^\s*(\d)\s*$/)?.[1];
        let pick = n && opts[+n - 1] ? opts[+n - 1] : null;
        let data;
        try { data = await gateway.getClasses({ from: today(), to: plus(7) }); } catch { await arboxDown(ctx); return R('arbox_unavailable'); }
        const pool = upcomingOnly(data.classes);
        if (!pick) {
          const dt = extractDayAndTime(ctx.text, ctx.sentAt);
          const base = opts.length ? pool.filter(c => opts.some(o => o.scheduleId === c.scheduleId)) : pool;
          const m = filterClasses(base, ctx.text, dt);
          if (m.length === 1 && (opts.length || dt.day || dt.hour)) pick = m[0];
        }
        const c = pick ? pool.find(x => x.scheduleId === pick.scheduleId) : null;
        if (!c) return null;
        return offerClass({ ...ctx, category: 'class_book' }, c, { reschedule: conv.data.purpose === 'reschedule' });
      }
      case 'freeze_dates': {
        if (strong && cls.category !== 'membership_freeze') return null;
        const d = freezeDates(ctx.text, ctx.sentAt);
        const c = cases.get(conv.data.caseId);
        if (!c || !cases.isOpen(c)) { cases.clearConv(ctx.phone); return null; }
        if (!d) return null;
        enrich(c, ctx, 'dates supplied');
        cases.update(c.id, { request: { ...(c.request ?? { type: 'membership_freeze' }), ...d }, summary: `בקשת הקפאת מנוי ${dmy(d.from)} – ${dmy(d.to)}` }, { type: 'request_details_added', by: 'member', detail: `${d.from} – ${d.to}` });
        cases.clearConv(ctx.phone);
        await say(ctx.phone, `הוספתי לפנייה: ${dmy(d.from)} – ${dmy(d.to)}. הבקשה רשומה לטיפול הצוות; המנוי לא הוקפא בשלב זה.`, { handler: 'freeze', trigger: 'dates_supplied', caseId: c.id, name: ctx.name });
        return R('case_updated', { caseId: c.id });
      }
      case 'callback_details': {
        if (strong && cls.category !== 'staff_request') return null;
        if (cls.category === 'social') return null;
        const c = cases.get(conv.data.caseId);
        if (!c || !cases.isOpen(c)) { cases.clearConv(ctx.phone); return null; }
        enrich(c, ctx, 'contact details');
        cases.clearConv(ctx.phone);
        await say(ctx.phone, `הוספתי לפנייה.`, { handler: 'case_followup', trigger: 'callback_details', caseId: c.id, name: ctx.name });
        return R('case_updated', { caseId: c.id });
      }
      case 'topic': {
        cases.clearConv(ctx.phone);
        if (strong) return null;                               // the new message classifies on its own
        if (cls.category === 'social') return R('silent');
        const merged = classify(`${conv.data.original} ${ctx.text}`);
        const hint = /שיעור|אימון/.test(ctx.text) ? 'app_problem' : /מנוי/.test(ctx.text) ? 'general_request' : /תשלום|חיוב|כסף/.test(ctx.text) ? 'billing_question' : null;
        const cat = (!NO_REPLY.has(merged.category) && !['unknown_request', 'general_question'].includes(merged.category) && CATEGORY[merged.category]) ? merged.category : (hint ?? 'general_request');
        return hCase({ ...ctx, text: `${conv.data.original}\n${ctx.text}` }, cat);
      }
      default: return null;
    }
  }

  // ── entry point ─────────────────────────────────────────────────────────────
  async function handleMemberMessage(input) {
    // A provider message id that was already handled (webhook redelivery, also after a
    // restart) is never handled twice.
    if (!allowed(input.phone)) return R('not_enabled', { reason: 'phone is not enabled for the new Tomer flow' });
    const messageId = input.messageId ? String(input.messageId) : null;
    if (messageId && cases.hasSeen(messageId)) return R('duplicate', { reason: 'message id already handled' });
    const out = await _handle({ ...input, messageId });
    if (messageId) { try { cases.markSeen(messageId); } catch (err) { logger.warn('[tomer] could not record handled message id', { error: err.message }); } }
    return out;
  }

  async function _handle({ phone, text = '', type = 'text', caption = null, name = null, sentAt = null, messageId = null }) {
    const at = sentAt instanceof Date && !isNaN(sentAt.getTime()) && sentAt.getUTCFullYear() > 2020 && sentAt.getUTCFullYear() < 2100 ? sentAt : now();
    const res = await gateway.resolveMember(phone);
    const member = res.status === 'found' ? res.member : null;
    const ctx = { phone, text: String(text ?? '').trim(), type, caption, name: member?.firstName ?? name, member, memberLookup: res.status, sentAt: at, messageId };

    if (type !== 'text') {
      if (type === 'reaction' || type === 'sticker') return R('silent', { reason: type });
      ctx.category = 'media';
      return hMedia(ctx);
    }
    if (!ctx.text) return R('silent', { reason: 'empty' });
    tomerStore.appendMemberHistory(phone, 'user', ctx.text);

    const hasOpenCase = cases.list({ phone, open: true, limit: 1 }).length > 0;
    const cls = classify(ctx.text, { hasOpenCase });
    ctx.category = cls.category;

    const conv = cases.getConv(phone);
    if (conv && cls.category !== 'opt_out') {
      const handled = await handleState(ctx, conv, cls);
      if (handled) return { ...handled, category: cls.category, viaState: conv.awaiting };
    }

    // A reply to a proactive member-care message continues THAT conversation.
    const care = getCare();
    if (care) {
      const handled = await care.handleReply(ctx, cls, { say, openCase, R, schedule: c => hSchedule({ ...c, category: 'schedule_query' }) });
      if (handled) return { ...handled, category: cls.category, viaCare: true };
    }

    let out;
    switch (cls.category) {
      case 'social': case 'statement': {
        // Added detail about an open issue ("זה קרה אתמול בשיעור של 18:00") belongs on the case.
        const open = cls.category === 'statement' && ctx.text.length >= 8 ? recentOpenCase(phone) : null;
        if (open) enrich(open, ctx, 'statement');
        tomerStore.appendAudit({ phone, memberName: ctx.name, event: 'tomer_silent', requestPreview: ctx.text.slice(0, 100), tomerAction: `silent:${cls.category} (${cls.reason})${open ? ' → added to case' : ''}`, owner: 'tomer', taskId: open?.id ?? null });
        out = R('silent', { reason: cls.reason, ...(open ? { caseId: open.id } : {}) }); break;
      }
      case 'opt_out':                out = await hOptOut(ctx); break;
      case 'location':               out = await hLocation(ctx); break;
      case 'schedule_query':         out = await hSchedule(ctx); break;
      case 'availability':           out = await hAvailability(ctx); break;
      case 'waitlist':               out = await hWaitlist(ctx); break;
      case 'class_book':             out = await hBook(ctx); break;
      case 'class_reschedule':       out = await hBook(ctx, { reschedule: true }); break;
      case 'class_cancel':           out = await hClassCancel(ctx); break;
      case 'class_cancelled_report': out = await hCancelledReport(ctx); break;
      case 'class_missed':
        if (cls.hasRequest) out = await hCase(ctx, 'missed_class');
        else { tomerStore.appendAudit({ phone, memberName: ctx.name, event: 'tomer_silent', requestPreview: ctx.text.slice(0, 100), tomerAction: 'silent:missed class reported, nothing asked', owner: 'tomer' }); out = R('silent', { reason: 'missed class reported, nothing asked' }); }
        break;
      case 'my_bookings':            out = await hMyBookings(ctx); break;
      case 'membership_info':        out = await hMembershipInfo(ctx); break;
      case 'membership_freeze':      out = await hFreeze(ctx); break;
      case 'membership_cancel':      out = await hMembershipCancel(ctx); break;
      case 'general_question':       out = await hGeneralQuestion(ctx); break;
      case 'unknown_request':        out = await hUnknown(ctx); break;
      default:                       out = await hCase(ctx, CATEGORY[cls.category] ? cls.category : 'general_request');
    }
    return { ...out, category: cls.category, memberLookup: res.status };
  }

  // ── staff operations (panel) ────────────────────────────────────────────────
  // Every operation records who did it and clears the "member wrote again" marker.
  const who = by => String(by ?? '').trim().slice(0, 40) || 'צוות';
  const closedErr = c => (!c ? { ok: false, error: 'not_found' } : !cases.isOpen(c) ? { ok: false, error: 'case_closed' } : null);

  function assign(caseId, { to, by } = {}) {
    const c = cases.get(caseId); const e = closedErr(c); if (e) return e;
    const owner = String(to ?? '').trim().slice(0, 40);
    if (!owner) return { ok: false, error: 'owner_required' };
    if (c.owner === owner && c.status !== 'awaiting_staff') return { ok: true, unchanged: true, case: c };
    const u = cases.update(caseId, { owner, unreadMember: false, status: c.status === 'awaiting_staff' ? 'in_progress' : c.status },
      { type: 'assigned', by: who(by), detail: owner });
    return { ok: true, case: u };
  }

  function setStatus(caseId, { status, by } = {}) {
    const c = cases.get(caseId); const e = closedErr(c); if (e) return e;
    if (!['awaiting_staff', 'in_progress', 'awaiting_member'].includes(status)) return { ok: false, error: 'bad_status' };
    if (c.status === status) return { ok: true, unchanged: true, case: c };
    const u = cases.update(caseId, { status, unreadMember: false }, { type: 'status_changed', by: who(by), detail: `${c.status} → ${status}` });
    return { ok: true, case: u };
  }

  /**
   * A message from a staff member to the member, sent from the case. It is recorded as
   * STAFF (never as Tomer) and takes the conversation over: Tomer stops answering this
   * member until staff release the conversation.
   */
  async function staffReply(caseId, { text, by, awaitMember = false } = {}) {
    const c = cases.get(caseId); const e = closedErr(c); if (e) return e;
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, error: 'text_required' };
    if (isOptedOut(c.phone)) return { ok: false, error: 'member_opted_out' };
    if (!allowed(c.phone)) return { ok: false, error: 'recipient_not_allowed' };
    let res = null, err = null;
    try { res = await sendText(c.phone, body, { staff: true, bypassQuietHours: true }); } catch (x) { err = x; }
    const out = classifySend(res, err);
    if (out.state !== 'accepted') {
      try { cases.update(caseId, {}, { type: out.state === 'uncertain' ? 'staff_reply_uncertain' : 'staff_reply_failed', by: who(by), detail: out.error }); } catch { /* the error is returned below either way */ }
      return { ok: false, error: out.state === 'uncertain' ? 'send_uncertain' : 'send_failed', detail: out.error };
    }
    try { inbox.pushOutbound({ phone: c.phone, name: c.memberName, text: body, agentId: 'staff', meta: { agent: 'staff', handler: 'case_staff_reply', trigger: 'panel', caseId, by: who(by), sendState: 'sent', idMessage: out.idMessage } }); } catch { /* view only */ }
    tomerStore.appendAudit({ phone: c.phone, memberName: c.memberName, event: 'staff_message', tomerAction: 'case_staff_reply (panel)', replyPreview: body.slice(0, 160), owner: who(by), taskId: caseId, sendState: 'sent', idMessage: out.idMessage });
    applyTakeover(c.phone, body, { by: who(by), isMember: true });
    try { cases.clearConv(c.phone); } catch { /* Tomer is silenced by the takeover anyway */ }
    try {
      const u = cases.update(caseId, {
        owner: !c.owner || c.owner === 'tomer' ? who(by) : c.owner, unreadMember: false,
        status: awaitMember ? 'awaiting_member' : (c.status === 'awaiting_staff' ? 'in_progress' : c.status),
      }, { type: 'staff_reply', by: who(by), detail: 'provider accepted' }, { contextEntry: { from: 'staff', text: body, by: who(by) } });
      return { ok: true, case: u, idMessage: out.idMessage };
    } catch (werr) {
      logger.error('[tomer] staff reply sent but the case could not be updated', { caseId, error: werr.message });
      return { ok: true, case: cases.get(caseId), idMessage: out.idMessage, warning: 'sent_not_recorded' };
    }
  }

  // ── Arbox: read-only check (what ARBOX shows — separate from what staff reported) ──
  async function arboxCheckFor(c, facts) {
    if (!MEMBERSHIP_STAFF.has(c.category)) return null;
    const at = now().toISOString();
    const userId = c.memberUserId ?? c.request?.userId ?? null;
    if (!userId) return { at, verified: null, summary: 'החבר/ה לא זוהה/תה ב-Arbox — אין מה לבדוק', source: null, error: 'member not identified' };
    if (!facts || facts.error) return { at, verified: null, summary: 'Arbox לא זמין — לא ניתן לבדוק כרגע', source: null, error: facts?.error ?? 'unavailable' };
    if (c.category === 'membership_cancel') {
      const target = c.request?.membershipUserId ? facts.memberships.find(m => String(m.membershipUserId) === String(c.request.membershipUserId)) : null;
      const plansActive = facts.activeMemberships.filter(m => m.type === 'plan' || m.type === 'session');
      const done = target ? (target.cancelled || !target.active) : plansActive.length === 0;
      return { at, verified: done, source: facts.source, error: null,
        summary: done ? 'Arbox מציג: המנוי מבוטל / לא פעיל' : `Arbox מציג: מנוי פעיל (${(target ? [target] : plansActive).map(m => m.name).join(', ')})` };
    }
    try {
      const from = c.request?.from ?? today(), to = c.request?.to ?? plus(60);
      const r = await gateway.getHoldStatus(userId, { from, to, membershipUserId: c.request?.membershipUserId ?? null });
      return { at, verified: r.onHold ? true : false, source: r.source, error: null, window: { from, to },
        summary: r.onHold ? 'Arbox מציג: החבר/ה ברשימת ההקפאות' : 'Arbox לא מציג הקפאה לתקופה (מבנה דוח ההקפאות לא נצפה מעולם — ייתכן שהקפאה קיימת ולא זוהתה; לוודא במסך המנוי ב-Arbox)' };
    } catch (err) { return { at, verified: null, summary: 'דוח ההקפאות של Arbox לא נקרא', source: '/v3/reports/membersOnHoldReport', error: err.message }; }
  }

  /** Re-read the member's Arbox data for a case. Never writes to Arbox. */
  async function refreshArbox(caseId, { by } = {}) {
    const c = cases.get(caseId); if (!c) return { ok: false, error: 'not_found' };
    let member = c.memberUserId ? { userId: c.memberUserId } : null, lookup = null;
    if (!member) {
      const r = await gateway.resolveMember(c.phone);
      lookup = r.status;
      if (r.status === 'found') member = r.member;
    }
    const facts = member ? await loadFacts(member, { fresh: true })
      : { error: lookup === 'unavailable' ? 'Arbox unavailable' : null, fetchedAt: now().toISOString(),
          summary: lookup === 'unavailable' ? 'Arbox לא זמין' : lookup === 'ambiguous' ? 'יותר מחבר/ה אחד/ת על המספר הזה — לא ניתן לזהות' : 'החבר/ה לא נמצא/ה ב-Arbox לפי מספר הטלפון' };
    const base = { ...c, memberUserId: c.memberUserId ?? member?.userId ?? null };
    const arboxCheck = await arboxCheckFor(base, facts);
    const u = cases.update(caseId, { facts, memberUserId: base.memberUserId, ...(arboxCheck ? { arboxCheck } : {}) },
      { type: 'arbox_checked', by: who(by), detail: arboxCheck ? arboxCheck.summary : facts.summary });
    return { ok: true, case: u, arboxAvailable: !facts.error };
  }

  /**
   * Staff close the case and REPORT what was done (resolution.outcome + note). For a
   * membership request reported as done, Arbox is then read once and what it shows is
   * stored separately in case.arboxCheck — a staff report is never presented as an
   * Arbox-verified fact.
   */
  async function resolve(caseId, { note, outcome, by } = {}) {
    const c = cases.get(caseId); if (!c) return { ok: false, error: 'not_found' };
    if (!cases.isOpen(c)) return { ok: true, unchanged: true, case: c };
    const text = String(note ?? '').trim();
    if (text.length < 2) return { ok: false, error: 'note_required' };
    const membership = MEMBERSHIP_STAFF.has(c.category);
    const allowed = membership ? ['done_in_arbox', 'declined', 'withdrawn', 'other'] : ['handled', 'no_action', 'other'];
    const oc = outcome ?? (membership ? null : 'handled');
    if (!allowed.includes(oc)) return { ok: false, error: 'outcome_required', allowed };
    let u = cases.update(caseId, { status: 'resolved', nextAction: null, unreadMember: false,
      owner: !c.owner || c.owner === 'tomer' ? who(by) : c.owner,
      resolution: { outcome: oc, note: text.slice(0, 1000), by: who(by), at: now().toISOString() } },
      { type: 'resolved', by: who(by), detail: `${OUTCOMES[oc]}: ${text.slice(0, 200)}` });
    try { cases.clearConv(c.phone); } catch { /* ignore */ }
    if (membership && oc === 'done_in_arbox') {
      try { u = (await refreshArbox(caseId, { by: 'system' })).case ?? u; } catch (err) { logger.warn('[tomer] Arbox check after resolution failed', { caseId, error: err.message }); }
    }
    return { ok: true, case: u };
  }

  function reopen(caseId, { by } = {}) {
    const c = cases.get(caseId); if (!c) return { ok: false, error: 'not_found' };
    if (cases.isOpen(c)) return { ok: true, unchanged: true, case: c };
    const u = cases.update(caseId, { status: 'in_progress', resolution: null, nextAction: (CATEGORY[c.category] ?? CATEGORY.general_request).next },
      { type: 'reopened', by: who(by), detail: c.resolution ? `${OUTCOMES[c.resolution.outcome] ?? ''}: ${c.resolution.note ?? ''}`.slice(0, 200) : null });
    return { ok: true, case: u };
  }

  /**
   * Controlled retry of the manager alert.
   *   accepted  → nothing is sent (one alert per case).
   *   failed    → sent again.
   *   uncertain → sent again ONLY with force (the panel asks first: it may duplicate).
   */
  async function retryNotification(caseId, { force = false, by } = {}) {
    const c = cases.get(caseId); if (!c) return { ok: false, error: 'not_found' };
    if (!c.notification?.required) return { ok: false, error: 'not_required' };
    if (c.notification.state === 'accepted') return { ok: true, unchanged: true, case: c };
    if (c.notification.state === 'uncertain' && !force) return { ok: false, error: 'uncertain_needs_confirm' };
    if (_notifying.has(caseId)) return { ok: false, error: 'notification_in_flight' };
    const u = await notifyStaff(caseId, { force, by: who(by) });
    const st = u.notification.state;
    return st === 'accepted' ? { ok: true, case: u } : { ok: false, error: st === 'uncertain' ? 'notify_uncertain' : 'notify_failed', detail: u.notification.lastError, case: u };
  }

  function noteOnCase(caseId, type, by, detail = null) {
    try { return cases.update(caseId, {}, { type, by: who(by), detail }); } catch { return null; }
  }
  /** Conversation ownership changed (takeover / release) — recorded on the member's open cases. */
  function noteOwnership(phone, type, { by, detail = null } = {}) {
    for (const c of cases.list({ phone, open: true })) noteOnCase(c.id, type, by, detail);
  }

  /**
   * A member wrote while a human owns the conversation: Tomer stays silent, but the
   * message is added to the member's open case so the panel shows it.
   */
  function recordWhileHumanOwned({ phone, text, type = 'text', messageId = null }) {
    if (messageId && cases.hasSeen(String(messageId))) return null;
    const open = cases.list({ phone, open: true, limit: 50 }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    if (!open) return null;
    const c = enrich(open, { text: type === 'text' ? String(text ?? '') : `[${type}]`, messageId: messageId ? String(messageId) : null }, 'received while staff own the conversation');
    if (messageId) { try { cases.markSeen(String(messageId)); } catch { /* ignore */ } }
    return c;
  }

  /**
   * After a restart nothing is re-sent. An alert that was in flight when the process
   * died may or may not have arrived → 'uncertain'. An alert that never started →
   * 'failed'. Both are shown in the panel, where staff decide whether to send.
   */
  async function reconcileOnStartup() {
    const out = [];
    for (const c of cases.list({ limit: 100000 })) {
      const n = c.notification;
      if (!n?.required || n.state !== 'pending') continue;
      const state = n.inFlightSince ? 'uncertain' : 'failed';
      const lastError = n.inFlightSince ? 'process restarted while the alert was being sent' : 'the alert was not sent before the process restarted';
      cases.update(c.id, {}, { type: state === 'uncertain' ? 'staff_notification_uncertain' : 'staff_notification_failed', by: 'system', detail: lastError },
        { notificationPatch: { state, inFlightSince: null, lastError } });
      out.push({ caseId: c.id, state });
      logger.warn('[tomer] unfinished manager alert found after restart — not re-sent', { caseId: c.id, state });
    }
    return out;
  }

  return {
    handleMemberMessage, recordWhileHumanOwned, noteOwnership, say,
    cases, CATEGORY, OUTCOMES, caseLink,
    staff: { assign, setStatus, staffReply, resolve, reopen, retryNotification, refreshArbox },
    reconcileOnStartup,
  };
}

module.exports = { createTomerService, CATEGORY, OUTCOMES, CLAIM_RE, INTRO };
