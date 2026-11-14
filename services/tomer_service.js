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
 * unless Arbox shows it. The wording used for each state is fixed here:
 *   request saved · awaiting clarification · awaiting staff approval · executing ·
 *   verified completed · failed / uncertain · staff intervention required.
 *
 * Arbox has no API to book or cancel a member's class, or to join a waitlist. For those
 * Tomer resolves the exact class, shows its real occupancy, hands over the class's own
 * registration link, and afterwards VERIFIES from Arbox that the member's action landed.
 */

const { classify, NO_REPLY } = require('./member_intent');
const { extractDayAndTime, ilDateString, ilParts, addDays, HE_WEEKDAY_NAMES } = require('../utils/callback_time');
const { createActionEngine, OPS } = require('./member_actions');

const CATEGORY = {
  billing_dispute:   { label: 'בירור חיוב',               priority: 'high',   next: 'לבדוק את החיוב ולחזור לחבר/ה' },
  refund_request:    { label: 'בקשת זיכוי / החזר',        priority: 'high',   next: 'להחליט על זיכוי ולעדכן את החבר/ה' },
  billing_question:  { label: 'שאלת תשלום',               priority: 'normal', next: 'לענות לחבר/ה' },
  payment_issue:     { label: 'בעיית תשלום / אשראי',      priority: 'normal', next: 'לעדכן אמצעי תשלום מול החבר/ה' },
  payment_claim:     { label: 'דיווח על תשלום (לא אומת)', priority: 'normal', next: 'לאמת את התשלום ולעדכן ב-Arbox' },
  receipt_request:   { label: 'בקשת קבלה',                priority: 'normal', next: 'לשלוח קבלה' },
  membership_cancel: { label: 'בקשת ביטול מנוי',          priority: 'high',   next: 'לאשר או לדחות בפאנל' },
  membership_freeze: { label: 'בקשת הקפאת מנוי',          priority: 'normal', next: 'לאשר או לדחות בפאנל' },
  membership_renew:  { label: 'חידוש / שינוי מנוי',       priority: 'normal', next: 'ליצור קשר לגבי חידוש' },
  complaint:         { label: 'תלונה',                     priority: 'high',   next: 'ליצור קשר אישי עם החבר/ה' },
  injury:            { label: 'פציעה / מצב רפואי',        priority: 'high',   next: 'מענה מקצועי מהצוות' },
  staff_request:     { label: 'בקשה לדבר עם הצוות',       priority: 'normal', next: 'לחזור לחבר/ה' },
  app_problem:       { label: 'תקלה באפליקציה / ברישום',  priority: 'normal', next: 'לבדוק ולסייע ברישום' },
  regular_booking:   { label: 'שינוי שיבוץ קבוע',          priority: 'normal', next: 'לעדכן שיבוץ קבוע ב-Arbox' },
  missed_class:      { label: 'שיעור שהוחמץ',             priority: 'normal', next: 'להחליט לגבי חיוב ולעדכן' },
  media_message:     { label: 'הודעת מדיה שלא נקראה',     priority: 'normal', next: 'לפתוח את ההודעה בוואטסאפ' },
  general_request:   { label: 'פנייה כללית',              priority: 'normal', next: 'לענות לחבר/ה' },
};

const MEDIA_LABEL = { image: 'את התמונה', audio: 'את ההודעה הקולית', voice: 'את ההודעה הקולית', video: 'את הסרטון', document: 'את הקובץ', location: 'את המיקום', sticker: 'את המדבקה', contact: 'את איש הקשר' };
const MEDIA_CANT  = { image: 'לצפות בתמונות', audio: 'להאזין להודעות קוליות', voice: 'להאזין להודעות קוליות', video: 'לצפות בסרטונים', document: 'לפתוח קבצים', location: 'לפתוח מיקומים' };

// Statements Tomer must never make on its own authority (used on AI output only).
const CLAIM_RE = /ביטלתי|בוטל(?:ה)?(?![א-ת])|רשמתי אותך|נרשמת בהצלחה|שיבצתי|שריינתי|שמרתי לך|הקפאתי|הוקפא|זיכיתי|זוכית|החזרנו|התשלום (?:התקבל|אושר)|אישרתי|עדכנתי (?:את|ב)|יש מקום|נשאר(?:ו)? מקו|מקומות פנויים|יחזרו אליך (?:תוך|עד|היום|מחר)|תוך (?:שעה|יום|\d+)|עד (?:מחר|סוף היום)/;

const STUDIO_ADDRESS = 'דרך השדה 12, פרדס חנה-כרכור';

function createTomerService(deps) {
  const {
    leadStore, persist, logger, gateway, cases, tomerStore, inbox,
    sendText, alertOwner, getAssets = () => ({}), getBackendBase = () => null,
    ai = null,                                  // async ({ system, user }) => string
    sendTimetable = async () => false,          // async (phone) => true when the timetable image was sent
    applyTakeover = () => {},                   // (phone, text) — staff took the conversation
    now = () => new Date(),
  } = deps;

  const isHumanOwned = phone => leadStore.getLead(phone)?.status === 'human_owns';
  const isOptedOut   = phone => leadStore.getLead(phone)?.status === 'opted_out';

  const actions = createActionEngine({ cases, gateway, logger, isHumanOwned, onOutcome: (c, outcome) => _onActionOutcome(c, outcome) });

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
  async function say(phone, text, meta = {}) {
    let idMessage = null, state = 'sent', error = null;
    try {
      const r = await sendText(phone, text);
      if (r?.queued) state = 'queued';
      else if (r?.blocked) state = 'blocked';
      else idMessage = r?.idMessage ?? null;
      if (state === 'sent' && !idMessage) state = 'no_provider_id';
    } catch (err) { state = 'failed'; error = err.message; logger.error('[tomer] send failed', { phone, error: err.message }); }
    const record = { agent: 'tomer', handler: meta.handler ?? null, trigger: meta.trigger ?? null, caseId: meta.caseId ?? null, actionId: meta.actionId ?? null, dataSource: meta.dataSource ?? null, sendState: state, idMessage, error };
    try { inbox.pushOutbound({ phone, name: meta.name ?? null, text, agentId: 'tomer', meta: record }); } catch { /* inbox is a view, not the source of truth */ }
    tomerStore.appendAudit({ phone, memberName: meta.name ?? null, event: 'tomer_message', tomerAction: `${meta.handler ?? 'reply'} (${meta.trigger ?? '-'})`, replyPreview: text.slice(0, 160), owner: 'tomer', taskId: meta.caseId ?? null, sendState: state, idMessage, dataSource: meta.dataSource ?? null });
    if (state === 'sent' || state === 'queued') {
      tomerStore.appendMemberHistory(phone, 'assistant', text);
    }
    return { state, idMessage, error };
  }

  // ── staff notification (once per case) ──────────────────────────────────────
  async function notifyStaff(caseId) {
    const c = cases.get(caseId);
    if (!c || !c.notification?.required || c.notification.state === 'accepted') return c;
    const cat = CATEGORY[c.category] ?? CATEGORY.general_request;
    const base = getBackendBase();
    const lastMember = [...(c.context ?? [])].reverse().find(x => x.from === 'member')?.text ?? '';
    const facts = c.facts?.summary ? `📊 Arbox: ${c.facts.summary}` : (c.memberUserId ? null : '📊 Arbox: החבר/ה לא זוהה/תה בוודאות');
    const body = [
      `👤 ${c.memberName ?? 'חבר/ה'}`,
      `📱 ${local(c.phone)}`,
      `📝 "${lastMember.slice(0, 300)}"`,
      facts,
      c.action ? `⚙️ פעולה מוצעת: ${OPS[c.action.op]?.label ?? c.action.op}${c.action.args?.from ? ` (${c.action.args.from} – ${c.action.args.to})` : ''} — דורש אישור בפאנל` : null,
      `➡️ נדרש: ${c.nextAction ?? cat.next}`,
      `🆔 ${c.id}`,
      `💬 https://wa.me/${c.phone}`,
      base ? `📋 ${base}/#tomer` : null,
    ].filter(Boolean).join('\n');
    let res, error = null;
    try { res = await alertOwner(`🔔 פנייה חדשה — ${cat.label}`, body, { linkPreview: false }); }
    catch (err) { error = err.message; }
    const results  = res?.results ?? [];
    const accepted = results.filter(r => r.idMessage).map(r => r.phone);
    const failed   = results.some(r => !r.skipped && !r.idMessage) || (!results.length);
    return cases.update(caseId, {
      notification: {
        ...c.notification,
        state: accepted.length && !failed ? 'accepted' : 'failed',   // 'accepted' = provider accepted; NOT proof of delivery
        sentTo: [...new Set([...(c.notification.sentTo ?? []), ...accepted])],
        idMessage: results.find(r => r.idMessage)?.idMessage ?? c.notification.idMessage ?? null,
        attempts: (c.notification.attempts ?? 0) + 1,
        lastError: error ?? results.find(r => r.error)?.error ?? (results.length ? null : 'no recipients configured'),
        at: new Date().toISOString(),
      },
    }, { type: accepted.length && !failed ? 'staff_notified' : 'staff_notification_failed', by: 'system', detail: error ?? null });
  }

  // ── member facts ────────────────────────────────────────────────────────────
  async function loadFacts(member) {
    if (!member) return null;
    try {
      const r = await gateway.getMemberships(member.userId);
      const active = r.memberships.filter(m => m.active && !m.cancelled);
      const debt = r.memberships.reduce((s, m) => s + (m.debt ?? 0), 0);
      return {
        memberships: r.memberships, activeMemberships: active, debt, source: r.source, fetchedAt: r.fetchedAt,
        summary: (active.length ? active.map(m => `${m.name}${m.endDate ? ` (עד ${m.endDate})` : ' (ללא תאריך סיום)'}`).join(', ') : 'אין מנוי פעיל') + (debt > 0 ? ` · יתרת חוב ${debt} ₪` : ''),
      };
    } catch (err) { return { error: err.message, summary: 'נתוני המנוי לא נקראו (Arbox לא זמין)' }; }
  }

  /** Open a case (or append to the member's open case of the same category) and alert staff once. */
  async function openCase(ctx, category, { summary, memberNoticeNeeded = true, action = null, nextAction = null, status = 'awaiting_staff', notify = true } = {}) {
    const cat = CATEGORY[category] ?? CATEGORY.general_request;
    const existing = cases.findOpen(ctx.phone, category);
    if (existing) {
      const c = cases.update(existing.id, {}, { type: 'member_followup', by: 'member', detail: null }, { contextEntry: { from: 'member', text: ctx.text } });
      return { case: c, isNew: false };
    }
    const facts = await loadFacts(ctx.member);
    let c = cases.create({
      phone: ctx.phone, memberUserId: ctx.member?.userId ?? null, memberName: ctx.member?.name ?? ctx.name ?? null,
      category, summary: summary ?? cat.label, status, priority: cat.priority, nextAction: nextAction ?? cat.next,
      memberText: ctx.text, facts, notificationRequired: notify,
    });
    if (action) c = actions.propose(c.id, action);
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
    await say(ctx.phone, `לא הצלחתי לזהות אותך בוודאות ב-Arbox לפי מספר הטלפון, ולכן אני לא מציג נתונים אישיים. פתחתי פנייה לצוות.`, { handler: 'unidentified', trigger: ctx.category, name: ctx.name });
    await openCase(ctx, 'general_request', { summary: 'חבר/ה שלא זוהה/תה ב-Arbox ביקש/ה מידע אישי' });
    return R('case_opened');
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

  async function hFreeze(ctx) {
    const dates = freezeDates(ctx.text, ctx.sentAt);
    const f = await loadFacts(ctx.member);
    const plans = (f?.activeMemberships ?? []).filter(m => m.type === 'plan' || m.type === 'session');
    const args = { userId: ctx.member?.userId ?? null, membershipUserId: plans.length === 1 ? plans[0].membershipUserId : null, from: dates?.from ?? null, to: dates?.to ?? null };
    const { case: c, isNew } = await openCase(ctx, 'membership_freeze', {
      summary: `בקשת הקפאת מנוי${dates ? ` ${dates.from} – ${dates.to}` : ' (תאריכים חסרים)'}`,
      action: { op: 'membership_hold', args },
    });
    if (!isNew) {
      if (dates && c.action && !c.action.args?.from) actions.setArgs(c.id, dates);
      await say(ctx.phone, `בקשת ההקפאה שלך כבר פתוחה אצל הצוות — הוספתי את ההודעה לפנייה.`, { handler: 'freeze', trigger: ctx.category, caseId: c.id, name: ctx.name });
      return R('case_updated', { caseId: c.id });
    }
    if (dates) {
      await say(ctx.phone, `קיבלתי את בקשת ההקפאה לתאריכים ${dates.from.split('-').reverse().join('.')} – ${dates.to.split('-').reverse().join('.')}.\nהקפאת מנוי דורשת אישור של הצוות — פתחתי פנייה והעברתי אליהם. המנוי לא הוקפא בשלב זה; אעדכן כאן כשתהיה החלטה.`, { handler: 'freeze', trigger: ctx.category, caseId: c.id, name: ctx.name });
    } else {
      await say(ctx.phone, `קיבלתי את בקשת ההקפאה ופתחתי פנייה לצוות (הקפאה דורשת את אישורם; המנוי לא הוקפא בשלב זה).\nמאיזה תאריך ועד איזה תאריך?`, { handler: 'freeze', trigger: ctx.category, caseId: c.id, name: ctx.name });
      cases.setConv(ctx.phone, 'freeze_dates', { caseId: c.id }, 24 * 60);
    }
    return R('case_opened', { caseId: c.id });
  }

  async function hMembershipCancel(ctx) {
    const f = await loadFacts(ctx.member);
    const plans = (f?.activeMemberships ?? []).filter(m => m.type === 'plan' || m.type === 'session');
    const { case: c, isNew } = await openCase(ctx, 'membership_cancel', {
      summary: 'בקשת ביטול מנוי',
      action: { op: 'membership_cancel', args: { userId: ctx.member?.userId ?? null, membershipUserId: plans.length === 1 ? plans[0].membershipUserId : null } },
    });
    await say(ctx.phone, isNew
      ? `קיבלתי את הבקשה לבטל את המנוי. ביטול מנוי דורש אישור וטיפול של הצוות — פתחתי פנייה והעברתי אליהם.\nהמנוי לא בוטל בשלב זה; אעדכן כאן כשתהיה החלטה.`
      : `בקשת ביטול המנוי שלך כבר פתוחה אצל הצוות — הוספתי את ההודעה לפנייה. המנוי לא בוטל בשלב זה.`, { handler: 'membership_cancel', trigger: ctx.category, caseId: c.id, name: ctx.name });
    return R(isNew ? 'case_opened' : 'case_updated', { caseId: c.id });
  }

  const CASE_REPLY = {
    billing_dispute:  `קיבלתי. אין לי אפשרות לבדוק או לשנות חיובים — פתחתי פנייה לצוות עם מה שכתבת. לא בוצע שום שינוי בחיוב בשלב זה.`,
    refund_request:   `קיבלתי את הבקשה. זיכוי או החזר הם החלטה של הצוות — פתחתי פנייה והעברתי אליהם. לא בוצע זיכוי בשלב זה.`,
    billing_question: `קיבלתי. אין לי גישה לנתוני התשלום שלך — פתחתי פנייה לצוות עם השאלה.`,
    payment_issue:    `קיבלתי. עדכון אמצעי תשלום נעשה מול הצוות — פתחתי פנייה והעברתי אליהם.`,
    payment_claim:    `קיבלתי את ההודעה על התשלום. אני לא יכול לאמת תשלומים — העברתי לצוות לבדיקה. זה עדיין לא אישור שהתשלום התקבל.`,
    receipt_request:  `קיבלתי. אין לי אפשרות להפיק קבלות — פתחתי פנייה לצוות.`,
    membership_renew: `קיבלתי. חידוש או שינוי מנוי נעשים מול הצוות — פתחתי פנייה והעברתי אליהם. לא בוצע שינוי במנוי בשלב זה.`,
    complaint:        `מצטער לשמוע. רשמתי את הדברים כפי שכתבת והעברתי אותם לצוות — זה נושא שהם צריכים לענות עליו, לא אני.`,
    injury:           `תודה על העדכון. אני עוזר דיגיטלי ולא יכול לתת הנחיה רפואית או הנחיית אימון בנושא כזה. העברתי את ההודעה לצוות המקצועי; עד שידברו איתך, לא כדאי להסתמך על תשובה ממני.`,
    staff_request:    `קיבלתי — פתחתי פנייה לצוות כדי שיחזרו אליך. אם יש נושא או זמן שנוח לך, כתבו לי ואוסיף לפנייה.`,
    app_problem:      `מצטער על התקלה. אין לי אפשרות לבצע את הפעולה במקומך באפליקציה — פתחתי פנייה לצוות עם מה שכתבת.`,
    regular_booking:  `קיבלתי. שיבוץ קבוע מנוהל על ידי הצוות — פתחתי פנייה והעברתי אליהם. לא בוצע שינוי בשיבוץ בשלב זה.`,
    missed_class:     `קיבלתי. אין לי סמכות להחליט לגבי שיעור שהוחמץ — פתחתי פנייה לצוות.`,
    general_request:  `קיבלתי. אין לי מידע מאומת כדי לענות על זה בעצמי — פתחתי פנייה לצוות עם מה שכתבת.`,
  };
  const FOLLOWUP_REPLY = `הפנייה שלך בנושא כבר פתוחה אצל הצוות — הוספתי את ההודעה אליה.`;

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
    await say(ctx.phone, `קיבלתי ${MEDIA_LABEL[kind] ?? 'את ההודעה'}. אני תומר, העוזר הדיגיטלי של הסטודיו, ואין לי אפשרות ${MEDIA_CANT[kind] ?? 'לפתוח הודעות מהסוג הזה'} — כך שזה לא נחשב אישור של שום דבר. סימנתי לצוות שיש הודעה לפתוח; אם זו בקשה, אפשר גם לכתוב לי אותה במילים.`, { handler: 'media', trigger: kind, caseId: c.id, name: ctx.name });
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
    const open = cases.list({ phone: ctx.phone, open: true, limit: 5 })[0];
    if (open && now().getTime() - new Date(open.updatedAt).getTime() < 6 * 3600 * 1000) {
      cases.update(open.id, {}, { type: 'member_followup', by: 'member' }, { contextEntry: { from: 'member', text: ctx.text } });
      return R('case_updated', { caseId: open.id, silent: true });
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
        actions.setArgs(c.id, d);
        cases.update(c.id, { summary: `בקשת הקפאת מנוי ${d.from} – ${d.to}` }, { type: 'member_followup', by: 'member', detail: 'dates supplied' }, { contextEntry: { from: 'member', text: ctx.text } });
        cases.clearConv(ctx.phone);
        await say(ctx.phone, `רשמתי בפנייה: ${d.from.split('-').reverse().join('.')} – ${d.to.split('-').reverse().join('.')}. הבקשה ממתינה לאישור הצוות; המנוי לא הוקפא בשלב זה.`, { handler: 'freeze', trigger: 'dates_supplied', caseId: c.id, name: ctx.name });
        return R('case_updated', { caseId: c.id });
      }
      case 'callback_details': {
        if (strong && cls.category !== 'staff_request') return null;
        if (cls.category === 'social') return null;
        const c = cases.get(conv.data.caseId);
        if (!c || !cases.isOpen(c)) { cases.clearConv(ctx.phone); return null; }
        cases.update(c.id, {}, { type: 'member_followup', by: 'member' }, { contextEntry: { from: 'member', text: ctx.text } });
        return R('case_updated', { caseId: c.id, silent: true });
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
  async function handleMemberMessage({ phone, text = '', type = 'text', caption = null, name = null, sentAt = null }) {
    const at = sentAt instanceof Date && !isNaN(sentAt.getTime()) && sentAt.getUTCFullYear() > 2020 && sentAt.getUTCFullYear() < 2100 ? sentAt : now();
    const res = await gateway.resolveMember(phone);
    const member = res.status === 'found' ? res.member : null;
    const ctx = { phone, text: String(text ?? '').trim(), type, caption, name: member?.firstName ?? name, member, memberLookup: res.status, sentAt: at };

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

    let out;
    switch (cls.category) {
      case 'social': case 'statement':
        tomerStore.appendAudit({ phone, memberName: ctx.name, event: 'tomer_silent', requestPreview: ctx.text.slice(0, 100), tomerAction: `silent:${cls.category} (${cls.reason})`, owner: 'tomer' });
        out = R('silent', { reason: cls.reason }); break;
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

  // ── action outcomes → member + case ─────────────────────────────────────────
  async function memberNotice(c, text, meta) {
    if (isOptedOut(c.phone) || isHumanOwned(c.phone)) {
      const reason = isOptedOut(c.phone) ? 'opted_out' : 'human_owns';
      cases.update(c.id, { memberNotice: { state: 'withheld', reason, text, at: new Date().toISOString() } }, { type: 'member_notice_withheld', by: 'system', detail: reason });
      return { state: 'withheld', reason };
    }
    const r = await say(c.phone, text, { ...meta, caseId: c.id, name: c.memberName });
    cases.update(c.id, { memberNotice: { state: r.state, idMessage: r.idMessage, text, at: new Date().toISOString() } }, { type: 'member_notified', by: 'tomer', detail: r.state }, { contextEntry: { from: 'tomer', text } });
    return r;
  }

  async function _onActionOutcome(c, outcome) {
    const a = c.action; const label = OPS[a.op]?.label ?? a.op;
    const d = s => (s ?? '').split('-').reverse().join('.');
    if (outcome === 'verified') {
      const text = a.op === 'membership_hold'
        ? `עדכון: הקפאת המנוי אושרה ונרשמה ב-Arbox ✅ לתאריכים ${d(a.args.from)} – ${d(a.args.to)}.`
        : `עדכון: ביטול המנוי אושר ונרשם ב-Arbox ✅.`;
      await memberNotice(c, text, { handler: 'action_outcome', trigger: 'verified', actionId: a.id, dataSource: a.verification?.evidence?.source ?? null });
    } else if (outcome === 'rejected') {
      const note = a.approval?.note ? `\nהערת הצוות: ${a.approval.note}` : '';
      await memberNotice(c, `עדכון: בקשת ${label} לא אושרה על ידי הצוות.${note}`, { handler: 'action_outcome', trigger: 'rejected', actionId: a.id });
    }
    // 'failed' / 'uncertain' are staff matters: the member was told the request awaits the
    // team, and is told nothing more until the outcome is known.
  }

  // ── staff operations (panel) ────────────────────────────────────────────────
  function assign(caseId, { to, by = 'staff' }) {
    const c = cases.get(caseId); if (!c) return null;
    return cases.update(caseId, { owner: to || by }, { type: 'assigned', by, detail: to || by });
  }
  async function staffReply(caseId, { text, by = 'staff' }) {
    const c = cases.get(caseId); if (!c) return { ok: false, error: 'not_found' };
    if (!text?.trim()) return { ok: false, error: 'text_required' };
    let idMessage = null;
    try { const r = await sendText(c.phone, text.trim(), { bypassQuietHours: true }); idMessage = r?.idMessage ?? null; }
    catch (err) { return { ok: false, error: err.message }; }
    try { inbox.pushOutbound({ phone: c.phone, name: c.memberName, text: text.trim(), agentId: 'staff', meta: { agent: 'staff', handler: 'case_staff_reply', trigger: 'panel', caseId, by, idMessage } }); } catch { /* view only */ }
    applyTakeover(c.phone, text.trim());
    const u = cases.update(caseId, { owner: by }, { type: 'staff_reply', by, detail: idMessage ? 'provider accepted' : 'no provider id' }, { contextEntry: { from: 'staff', text: text.trim() } });
    return { ok: true, case: u, idMessage };
  }
  async function resolve(caseId, { note = null, by = 'staff' } = {}) {
    const c = cases.get(caseId); if (!c) return { ok: false, error: 'not_found' };
    if (c.status === 'resolved') return { ok: true, unchanged: true, case: c };
    if (c.action && ['executing'].includes(c.action.state)) return { ok: false, error: 'action_in_flight' };
    const u = cases.update(caseId, { status: 'resolved', nextAction: null, resolution: { note, by, at: new Date().toISOString() } }, { type: 'resolved', by, detail: note });
    return { ok: true, case: u };
  }
  async function retryNotification(caseId) {
    const c = cases.get(caseId); if (!c) return { ok: false, error: 'not_found' };
    if (c.notification?.state === 'accepted') return { ok: true, unchanged: true, case: c };
    if (!c.notification?.required) return { ok: false, error: 'not_required' };
    const u = await notifyStaff(caseId);
    return { ok: u.notification.state === 'accepted', case: u };
  }

  return {
    handleMemberMessage,
    cases, actions, CATEGORY,
    staff: { assign, staffReply, resolve, retryNotification,
      approve: (id, o) => actions.decide(id, { ...o, decision: 'approved' }),
      reject:  (id, o) => actions.decide(id, { ...o, decision: 'rejected' }),
      markExecuted: (id, o) => actions.markExecutedManually(id, o),
      executeNow:   (id, o) => actions.executeNow(id, o),
      recheck:      (id, o) => actions.recheck(id, o) },
    reconcileOnStartup: () => actions.reconcileOnStartup(),
  };
}

module.exports = { createTomerService, CATEGORY, CLAIM_RE };
