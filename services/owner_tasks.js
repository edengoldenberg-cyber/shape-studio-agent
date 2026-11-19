'use strict';

/**
 * owner_tasks.js — the owner's open tasks from Barak and Tomer, his explicit confirmation of each, and ONE reminder
 * message to him about what is still open.
 *
 * Owner rules (2026-11-18):
 *   • sending an alert, opening the case or reading the message does not complete a task
 *   • a task is closed only by the owner's explicit confirmation ("בוצע"), or by a verified result in the system that
 *     owns it (the case was resolved, the staff task was resolved, the callback got an outcome)
 *   • "בוצע", "בטיפול", "דחה למועד", "בוטל" and reopening — each kept in the task's history
 *   • reminders respect the due time, a snooze and the quiet hours; they are consolidated into one message, never a
 *     burst; a failed send stays visible and is retried in a controlled way
 *   • the approval is for reminders to the OWNER. Nothing here is ever sent to a customer.
 * The times of day and the frequency are the owner's to set: until they are set, no reminder is sent.
 *
 * Tasks come from three places and are not copied — the source stays the record:
 *   Tomer service cases (open) · Tomer staff tasks (open) · Barak callback requests (open, due from their time)
 * This module stores only the owner's own state per task and the reminder log (DATA_DIR/owner_tasks.json).
 *
 * THE WORK BOARD (2026-11-18): the same records are Tomer's one board of work. Every open case, staff task, class
 * request, callback and retention message that is waiting appears once, with: who it waits for (the owner, the
 * member, an outside system), why it was opened and from what, who is on it, when it is due, what was done so far
 * (an alert accepted by the provider is not a delivery, a sent message is not a done task), what happens next and
 * what closes it. Status, the person on it and the due time are three separate things. "Overdue" is said only
 * where a time exists: a callback's time, a postponement that has passed. There is no invented deadline.
 */

const fs = require('fs');
const path = require('path');

const STATES = ['open', 'in_progress', 'snoozed', 'done', 'cancelled'];
const BOARD_HE = { planned: 'מתוכנן', todo: 'ממתין לביצוע', in_progress: 'בטיפול', waiting_owner: 'ממתין לעדן', waiting_member: 'ממתין ללקוח/ה', waiting_external: 'ממתין למערכת חיצונית',
  blocked: 'חסום / נכשל', done: 'בוצע', cancelled: 'בוטל' };
const STUCK_MEMBER_MS = 30 * 60 * 1000;      // the same 30 minutes after which an unanswered question is reported to the manager
const CASE_EVENT_HE = { opened: 'הפנייה נפתחה', staff_notified: 'ההתראה לצוות התקבלה אצל ספק השליחה (אין אישור מסירה למכשיר)', notification_failed: 'ההתראה לצוות לא נשלחה', member_message: 'הלקוח/ה כתב/ה שוב',
  staff_reply: 'הצוות ענה ללקוח/ה', assigned: 'שויך לטיפול', status_changed: 'הסטטוס שונה', resolved: 'נסגר', reopened: 'נפתח מחדש', request_details_added: 'נוספו פרטים לבקשה', arbox_checked: 'נבדק מול Arbox' };
const ACTION_HE = { done: 'בוצע', in_progress: 'בטיפול', snooze: 'נדחה למועד', cancel: 'בוטל', reopen: 'נפתח מחדש', source_closed: 'נסגר במערכת המקור', seen: 'נרשם', assign: 'שויך' };
const MAX_DIGEST_ITEMS = 12, MAX_ATTEMPTS = 3, SLOT_WINDOW_MIN = 20;

// the owner reads these: never the internal type code
const TASK_HE = { freeze_request: 'בקשת הקפאת מנוי', cancel_request: 'בקשת ביטול מנוי', cancellation_request: 'בקשת ביטול מנוי', fixed_booking_request: 'בקשת שיבוץ קבוע', staff_followup: 'לחזור ללקוח/ה',
  complaint: 'תלונה', unsupported_action: 'בקשה שהסוכן אינו מבצע', billing_question: 'שאלת חיוב', class_change: 'שינוי רישום לשיעור', voice_message: 'הודעה קולית', other: 'משימה כללית' };

function createOwnerTasks(d) {
  const { cases, tomerStore, aptStore, logger = console, caseLabel = c => c.category, sendManager, managerPhone = () => null,
          isQuietHours = () => false, closeSource = null, baseUrl = () => null, care = null, classWritesFor = () => false } = d;
  const now = d.now ?? (() => new Date());
  const file = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'owner_tasks.json');
  let state = null;
  const load = () => {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { state = {}; }
    state.items = state.items ?? {}; state.digests = state.digests ?? [];
    state.settings = { enabled: false, times: [], weekdays: [0, 1, 2, 3, 4, 5], minGapHours: 20, ...(state.settings ?? {}) };
    return state;
  };
  const save = () => { fs.mkdirSync(path.dirname(file()), { recursive: true }); const tmp = file() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8'); fs.renameSync(tmp, file()); };
  const il = t => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(t);
    const g = k => p.find(x => x.type === k)?.value; return { ymd: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) }; };
  const tail = p => (p ? `…${String(p).slice(-4)}` : '');
  const waitHe = ms => { const h = Math.floor(ms / 3600e3); return h < 1 ? 'פחות משעה' : h < 48 ? `${h} שעות` : `${Math.floor(h / 24)} ימים`; };

  /** What is open in the three sources right now. */
  function collect() {
    const out = [];
    out.sources = { cases: { ok: true }, tasks: { ok: true }, callbacks: { ok: true }, care: { ok: !!care, error: care ? null : 'לא מחובר' } };
    const cut = (s, n = 110) => (s ? String(s).replace(/\s+/g, ' ').slice(0, n) : null);
    try { for (const c of cases.list({ open: true, limit: 500 })) out.push({ key: `case:${c.id}`, agent: 'tomer', kind: 'פנייה', type: c.category ?? null, title: caseLabel(c), who: c.memberName ?? tail(c.phone), userId: c.memberUserId ?? null,
      createdAt: c.createdAt, dueAt: c.createdAt, link: `#tomer/case/${c.id}`, reason: cut(c.summary), source: 'הודעת WhatsApp של הלקוח/ה לתומר', assignee: c.owner && c.owner !== 'tomer' ? c.owner : 'עדן',
      wait: c.status === 'awaiting_member' ? 'member' : 'owner', blocked: c.notification?.state === 'failed' ? 'ההתראה לצוות על הפנייה לא נשלחה' : null,
      trail: (c.events ?? []).slice(-8).map(e => ({ at: e.at ?? null, text: `${CASE_EVENT_HE[e.type] ?? e.type}${e.by && e.by !== 'tomer' ? ` (${e.by})` : ''}` })),
      next: cut(c.nextAction) ?? (c.status === 'awaiting_member' ? 'ממתין לתשובת הלקוח/ה' : 'לטפל ולסמן בוצע'), closeRule: 'נסגרת כשאתה או הצוות מסמנים שטופל, עם התוצאה. קריאת הפנייה או שליחת התראה אינן סגירה.' }); }
    catch (err) { out.error = `cases: ${err.message}`; out.sources.cases = { ok: false, error: err.message }; }
    try { for (const t of tomerStore.getOpenTasks()) {
      // a request still being clarified with the member, or waiting for her written "כן", waits for HER: it is on the
      // board, and it is not the owner's to do (and not in his reminders) until it is ripe
      const act = t.action?.state ?? null, cc = t.type === 'class_change';
      const wait = (t.missing && !t.alert) || t.pendingConfirm ? 'member' : act === 'unknown' ? 'external' : 'owner';
      const trail = [{ at: t.createdAt, text: 'המשימה נפתחה' }];
      if (t.memberReply?.at) trail.push({ at: t.memberReply.at, text: t.memberReply.state === 'sent' ? 'תשובה ללקוח/ה התקבלה אצל ספק השליחה (אין אישור מסירה למכשיר)' : `תשובה ללקוח/ה לא נשלחה (${t.memberReply.state})` });
      if (t.alert?.lastAt) trail.push({ at: t.alert.lastAt, text: t.alert.state === 'sent' ? 'ההתראה אליך התקבלה אצל ספק השליחה (אין אישור מסירה למכשיר)' : `ההתראה אליך לא נשלחה (ניסיון ${t.alert.attempts ?? 1})` });
      if (t.clarifyEscalated) trail.push({ at: t.clarifyEscalated, text: 'הלקוח/ה לא ענה/תה על שאלת ההבהרה בתוך 30 דקות' });
      if (act === 'done') trail.push({ at: t.action.confirmedAt ?? t.updatedAt, text: 'הפעולה בוצעה ב-Arbox ואומתה בקריאה חוזרת' });
      out.push({ key: `task:${t.id}`, agent: 'tomer', kind: cc ? 'בקשת שיעור' : 'משימה', type: t.type ?? null, title: t.title ?? (cc && t.summary ? cut(t.summary, 80) : TASK_HE[t.type]) ?? 'משימה לצוות', who: t.memberName ?? tail(t.phone), userId: t.arboxId ?? null,
        createdAt: t.createdAt, dueAt: t.createdAt, link: '#tomer', reason: cut(t.summary), source: t.memberMessage ? `הודעת הלקוח/ה: "${cut(t.memberMessage, 70)}"` : 'נפתחה בפאנל', assignee: t.assignedTo ?? (wait === 'member' ? 'תומר' : 'עדן'), wait,
        blocked: act === 'unknown' ? 'נשלחה בקשה ל-Arbox ותוצאתה לא אומתה — נדרשת בדיקה ב-Arbox' : act === 'holds_both' ? 'הלקוח/ה רשום/ה לשני השיעורים — נדרש ביטול ידני של אחד' : t.alert?.state === 'failed' ? 'ההתראה אליך לא נשלחה' : null,
        trail, next: t.missing && !t.alert ? 'הלקוח/ה נשאל/ה על הפרט החסר — ממתין לתשובה (אחרי 30 דקות בלי תשובה תישלח אליך התראה)' : t.pendingConfirm ? 'ממתין לאישור בכתב ("כן") של הלקוח/ה לפעולה שהוצגה לו/לה' : cc ? 'לבצע ב-Arbox ולסמן בוצע' : 'לטפל ולסמן בוצע',
        closeRule: cc ? (classWritesFor(t.phone) ? 'נסגרת לבד כשתומר ביצע את הפעולה ב-Arbox ואימת אותה בקריאה חוזרת; אחרת — כשאתה מסמן בוצע.' : 'נסגרת כשאתה מסמן בוצע אחרי ביצוע ב-Arbox. תומר אינו מורשה לבצע אותה בעצמו.') : 'נסגרת כשאתה מסמן בוצע.' });
    } }
    catch (err) { out.error = `${out.error ? out.error + '; ' : ''}tasks: ${err.message}`; out.sources.tasks = { ok: false, error: err.message }; }
    try {
      for (const a of aptStore.getAll()) {
        if (!aptStore.ACTIVE_STATUSES.has(a.status)) continue;
        const due = a.windowEndAt ? new Date(a.windowEndAt) : a.scheduledAt instanceof Date ? a.scheduledAt : a.scheduledAt ? new Date(a.scheduledAt) : null;
        const created = a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt;
        out.push({ key: `apt:${a.id}`, agent: 'barak', kind: 'שיחה חוזרת', type: 'callback', title: 'לחזור לליד בטלפון', who: a.leadName ?? tail(a.leadPhone), userId: null, createdAt: created,
          dueAt: due && !isNaN(due) ? due.toISOString() : null, hasDue: !!(due && !isNaN(due)), link: '#barak', reason: 'ליד ביקש שיחזרו אליו', source: 'שיחת מכירה עם ברק', assignee: 'עדן', wait: 'owner', blocked: null,
          trail: [{ at: created, text: 'הבקשה נרשמה' }], next: 'להתקשר במועד ולרשום את תוצאת השיחה', closeRule: 'נסגרת כשנרשמה תוצאת השיחה, או כשאתה מסמן בוצע.' });
      }
    } catch (err) { out.error = `${out.error ? out.error + '; ' : ''}appointments: ${err.message}`; out.sources.callbacks = { ok: false, error: err.message }; }
    // Retention messages that exist as a record (a program was switched on and found someone). A candidate that a
    // switched-off program WOULD find is a proposal, shown elsewhere - it is not a task and nothing will be sent for it.
    if (care) {
      try {
        for (const e of care.openEpisodes()) {
          const bad = ['blocked', 'failed', 'uncertain'].includes(e.status);
          out.push({ key: `care:${e.key}`, agent: 'tomer', kind: 'הודעת שימור', type: `care_${e.program}`, title: care.label(e.program), who: e.name ?? e.memberName ?? tail(e.phone), userId: e.userId ?? null, createdAt: e.createdAt, dueAt: e.sendAt ?? e.createdAt, hasDue: !!e.sendAt,
            link: '#tomer', reason: `תוכנית "${care.label(e.program)}" מצאה שהלקוח/ה עומד/ת בתנאים`, source: 'נתוני Arbox (מנויים ונוכחות)', assignee: 'תומר', wait: e.status === 'sent' ? 'member' : null,
            blocked: bad ? (e.status === 'uncertain' ? 'לא ידוע אם ההודעה נשלחה — לא תישלח שוב אוטומטית' : `ההודעה לא נשלחה: ${(e.reasons ?? []).map(c => (care.reason ? care.reason(c) : c)).join(' · ') || e.status}`) : null,
            trail: (e.history ?? []).slice(-6).map(h => ({ at: h.at, text: `${h.type}${h.detail ? ` — ${cut(h.detail, 60)}` : ''}` })), next: e.status === 'sent' ? 'ההודעה נשלחה; ממתין לתשובת הלקוח/ה' : 'שליחת ההודעה במועד שנקבע, אחרי בדיקה חוזרת מול Arbox',
            closeRule: 'נסגרת כשההודעה נשלחה והשיחה הסתיימה, או כשהלקוח/ה כבר אינו/ה עומד/ת בתנאים (חזר/ה להתאמן, חידש/ה).' });
        }
      } catch (err) { out.error = `${out.error ? out.error + '; ' : ''}care: ${err.message}`; out.sources.care = { ok: false, error: err.message }; }
    }
    return out;
  }

  /** Bring the owner's records in line with the sources: new tasks appear, tasks closed at the source are done. */
  function sync() {
    const s = load(), nowIso = now().toISOString(), src = collect(), keys = new Set(src.map(x => x.key));
    let changed = false;
    for (const it of src) {
      if (!s.items[it.key]) { s.items[it.key] = { state: 'open', firstSeenAt: nowIso, snoozeUntil: null, lastReminderAt: null, reminderCount: 0, history: [], snapshot: it }; changed = true; }
      else { s.items[it.key].snapshot = it;
        // the source reopened it (a case reopened in the panel, a callback moved to a new time)
        if (['done', 'cancelled'].includes(s.items[it.key].state) && s.items[it.key].closedBy === 'source') { s.items[it.key].state = 'open'; s.items[it.key].closedBy = null; s.items[it.key].history.push({ at: nowIso, by: 'מערכת', action: 'reopen', note: 'נפתח מחדש במערכת המקור' }); changed = true; } }
    }
    if (!src.error) for (const [key, rec] of Object.entries(s.items)) {
      if (keys.has(key) || ['done', 'cancelled'].includes(rec.state)) continue;
      rec.state = 'done'; rec.closedBy = 'source'; rec.closedAt = nowIso; rec.snoozeUntil = null;
      rec.history.push({ at: nowIso, by: 'מערכת', action: 'source_closed', note: 'הפנייה / המשימה / השיחה נסגרה במערכת המקור' }); changed = true;
    }
    if (changed) save();
    return { items: src, error: src.error ?? null, sources: src.sources };
  }

  const view = (key, rec, t) => {
    const snap = rec.snapshot ?? {};
    const effective = rec.state === 'snoozed' && rec.snoozeUntil && Date.parse(rec.snoozeUntil) <= t ? 'open' : rec.state;
    const closed = ['done', 'cancelled'].includes(effective);
    const explicitDue = rec.snoozeUntil ?? (snap.hasDue ? snap.dueAt : null);          // a time someone set: a postponement, a callback's time, a scheduled message
    const planned = !closed && (effective === 'snoozed' || (!!snap.dueAt && Date.parse(snap.dueAt) > t));
    const board = closed ? effective : snap.blocked ? 'blocked' : planned ? 'planned' : effective === 'in_progress' ? 'in_progress'
      : snap.wait === 'member' ? 'waiting_member' : snap.wait === 'external' ? 'waiting_external' : snap.wait === 'owner' ? 'waiting_owner' : 'todo';
    const lastSnooze = (rec.history ?? []).filter(h => h.action === 'snooze').at(-1) ?? null;
    return { board, boardLabel: BOARD_HE[board], overdue: !closed && !planned && !!explicitDue && Date.parse(explicitDue) <= t, dueSetAt: explicitDue ?? null,
      type: snap.type ?? null, userId: snap.userId ?? null, reason: snap.reason ?? null, source: snap.source ?? null, assignee: rec.assignee ?? snap.assignee ?? null, wait: snap.wait ?? null, blocked: snap.blocked ?? null,
      trail: snap.trail ?? [], next: closed ? null : (effective === 'snoozed' ? `נדחה: יחזור לטיפול ב-${String(rec.snoozeUntil).slice(0, 16).replace('T', ' ')} (UTC)` : snap.next ?? null), closeRule: snap.closeRule ?? null,
      snoozeReason: effective === 'snoozed' ? lastSnooze?.note ?? null : null, closedAt: rec.closedAt ?? null,
      key, agent: snap.agent, kind: snap.kind, title: snap.title, who: snap.who, link: snap.link, state: effective, storedState: rec.state, snoozeUntil: rec.snoozeUntil,
      createdAt: snap.createdAt ?? rec.firstSeenAt, dueAt: snap.dueAt ?? null, waitingMs: Math.max(0, t - Date.parse(snap.createdAt ?? rec.firstSeenAt)), waiting: waitHe(Math.max(0, t - Date.parse(snap.createdAt ?? rec.firstSeenAt))),
      notYetDue: !!snap.dueAt && Date.parse(snap.dueAt) > t, lastReminderAt: rec.lastReminderAt, reminderCount: rec.reminderCount ?? 0, closedBy: rec.closedBy ?? null, history: rec.history ?? [] };
  };

  /** Everything for the panel. */
  function list({ includeClosed = false } = {}) {
    const sy = sync(), s = load(), t = now().getTime();
    const all = Object.entries(s.items).map(([k, r]) => view(k, r, t));
    const open = all.filter(x => !['done', 'cancelled'].includes(x.state)).sort((a, b) => b.waitingMs - a.waitingMs);
    const closed = includeClosed ? all.filter(x => ['done', 'cancelled'].includes(x.state)).sort((a, b) => String(b.history.at(-1)?.at ?? '').localeCompare(String(a.history.at(-1)?.at ?? ''))).slice(0, 50) : [];
    const last = s.digests.at(-1) ?? null;
    return { ok: true, generatedAt: now().toISOString(), sourceError: sy.error, open, closed, settings: s.settings, reminders: status(), lastDigest: last,
      counts: { open: open.length, snoozed: open.filter(x => x.state === 'snoozed').length, inProgress: open.filter(x => x.state === 'in_progress').length, dueNow: due(t).length } };
  }

  /** When the next reminder would go out (null when reminders are off or no time is set). */
  function nextReminderAt(t = now().getTime()) {
    const s = load();
    if (!s.settings.enabled || !s.settings.times.length) return null;
    for (let dOff = 0; dOff < 8; dOff++) {
      const day = new Date(t + dOff * 86400000), p = il(day);
      if (!s.settings.weekdays.includes(p.wd)) continue;
      for (const hm of s.settings.times) { if (dOff === 0 && hm <= il(new Date(t)).hm) continue; return `${p.ymd} ${hm}`; }
    }
    return null;
  }

  /**
   * The one board. `today` holds KEYS into `items` / `recentDone`, so a counter and its list cannot disagree.
   * A source that could not be read is named in `sources` - its tasks are then unknown, not zero.
   */
  function board() {
    const sy = sync(), s = load(), t = now().getTime();
    const all = Object.entries(s.items).map(([k, r]) => view(k, r, t));
    const rank = { blocked: 0, waiting_owner: 1, in_progress: 2, todo: 3, waiting_external: 4, waiting_member: 5, planned: 6 };
    const items = all.filter(x => !['done', 'cancelled'].includes(x.state)).sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || (rank[a.board] - rank[b.board]) || (b.waitingMs - a.waitingMs));
    const recentDone = all.filter(x => ['done', 'cancelled'].includes(x.state) && x.closedAt && t - Date.parse(x.closedAt) <= 7 * 86400000).sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, 40);
    const keys = f => items.filter(f).map(x => x.key);
    const today = {
      needsOwner: keys(x => x.board === 'waiting_owner' || x.board === 'blocked' || (x.board === 'in_progress' && x.assignee !== 'תומר')),
      tomerCan:   keys(x => x.board === 'todo' || x.board === 'waiting_member'),
      overdue:    keys(x => x.overdue),
      stuck:      keys(x => x.board === 'blocked' || x.board === 'waiting_external' || (x.board === 'waiting_member' && x.waitingMs > STUCK_MEMBER_MS)),
      planned:    keys(x => x.board === 'planned'),
      recentDone: recentDone.map(x => x.key),
    };
    const byStatus = {}; for (const x of items) byStatus[x.board] = (byStatus[x.board] ?? 0) + 1;
    const last = s.digests.at(-1) ?? null;
    return { ok: true, generatedAt: now().toISOString(), sources: sy.sources ?? null, sourceError: sy.error, items, recentDone, today,
      counts: { open: items.length, byStatus, ...Object.fromEntries(Object.entries(today).map(([k, v]) => [k, v.length])) }, statuses: BOARD_HE,
      recentDigests: s.digests.slice(-12).reverse().map(g => ({ at: g.at, slot: g.slot ?? null, state: g.state, count: (g.keys ?? []).length, attempts: g.attempts ?? null, error: g.error ?? null })),
      recipient: (() => { const p = managerPhone(); return p ? (String(p).length >= 7 ? String(p).slice(0, 5) + '•••' + String(p).slice(-3) : p) : null; })(),
      settings: s.settings, reminders: { ...status(), lastAt: last?.at ?? null, lastState: last?.state ?? null, nextAt: nextReminderAt(t) }, lastDigest: last };
  }

  /** The owner's explicit word on a task. */
  async function act(key, action, { by = 'עדן', note = null, until = null, to = null } = {}) {
    sync();
    const s = load(), rec = s.items[key], nowIso = now().toISOString();
    if (!rec) return { ok: false, error: 'not_found' };
    if (!['done', 'in_progress', 'snooze', 'cancel', 'reopen', 'assign'].includes(action)) return { ok: false, error: 'bad_action' };
    if (action === 'assign') {                                // who is on it - the status and the due time are not touched
      const who = String(to ?? '').trim().slice(0, 40);
      if (!who) return { ok: false, error: 'assignee_required' };
      rec.assignee = who; rec.history.push({ at: nowIso, by: String(by).slice(0, 40), action: 'assign', note: `אחראי/ת: ${who}${note ? ` — ${String(note).slice(0, 200)}` : ''}`, until: null });
      save();
      return { ok: true, task: view(key, rec, now().getTime()) };
    }
    if (action === 'snooze') {
      const u = until ? new Date(until) : null;
      if (!u || isNaN(u) || u.getTime() <= now().getTime()) return { ok: false, error: 'snooze_needs_future_time' };
      rec.state = 'snoozed'; rec.snoozeUntil = u.toISOString();
    } else if (action === 'reopen') { rec.state = 'open'; rec.snoozeUntil = null; rec.closedBy = null; rec.closedAt = null; }
    else if (action === 'in_progress') { rec.state = 'in_progress'; rec.snoozeUntil = null; }
    else { rec.state = action === 'done' ? 'done' : 'cancelled'; rec.snoozeUntil = null; rec.closedBy = 'owner'; rec.closedAt = nowIso; }
    const entry = { at: nowIso, by: String(by).slice(0, 40), action, note: note ? String(note).slice(0, 300) : null, until: action === 'snooze' ? rec.snoozeUntil : null };
    // "בוצע" / "בוטל" are also recorded where the task lives, so the panels agree. A failure there does not undo the owner's word.
    if ((action === 'done' || action === 'cancel') && closeSource) {
      try { const r = await closeSource(key, action, { by: entry.by, note: entry.note }); entry.source = r?.ok === false ? `לא נסגר במקור: ${r.error ?? 'סירוב'}` : 'נסגר גם במקור'; }
      catch (err) { entry.source = `לא נסגר במקור: ${String(err.message).slice(0, 120)}`; logger.warn('[owner-tasks] the source could not be closed', { key, error: err.message }); }
    }
    rec.history.push(entry);
    save();
    return { ok: true, task: view(key, rec, now().getTime()) };
  }

  /** Tasks a reminder may mention now: open or in progress, past their due time, not snoozed, not reminded too recently. */
  function due(t = now().getTime()) {
    const s = load(), gap = (s.settings.minGapHours ?? 20) * 3600e3;
    return Object.entries(s.items).map(([k, r]) => view(k, r, t))
      .filter(x => ['open', 'in_progress'].includes(x.state) && !x.notYetDue && x.wait !== 'member' && x.agent && x.kind !== 'הודעת שימור' && (!x.lastReminderAt || t - Date.parse(x.lastReminderAt) >= gap))
      .sort((a, b) => b.waitingMs - a.waitingMs);
  }

  function setSettings(patch = {}, { by = 'עדן' } = {}) {
    const s = load();
    const times = patch.times === undefined ? s.settings.times : [...new Set((patch.times ?? []).map(x => String(x).trim()).filter(x => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)))].sort();
    const weekdays = patch.weekdays === undefined ? s.settings.weekdays : [...new Set((patch.weekdays ?? []).map(Number).filter(n => n >= 0 && n <= 6))].sort();
    const enabled = patch.enabled === undefined ? s.settings.enabled : patch.enabled === true;
    if (enabled && !times.length) return { ok: false, error: 'times_required' };
    const minGapHours = patch.minGapHours === undefined ? s.settings.minGapHours : Math.min(168, Math.max(1, Number(patch.minGapHours) || 20));
    const wasOff = !s.settings.enabled;
    s.settings = { ...s.settings, enabled, times, weekdays, minGapHours, updatedAt: now().toISOString(), updatedBy: String(by).slice(0, 40), ...(enabled && wasOff ? { activatedAt: now().toISOString() } : {}) };
    save();
    return { ok: true, settings: s.settings, reminders: status() };
  }

  function status() {
    const s = load(), last = s.digests.at(-1) ?? null;
    if (!s.settings.times.length) return { state: 'needs_settings', text: 'לא הוגדרו שעות שליחה ותדירות. שום תזכורת אינה נשלחת עד שיוגדרו.' };
    if (!s.settings.enabled) return { state: 'off', text: `הוגדרו שעות (${s.settings.times.join(', ')}), התזכורות כבויות.` };
    if (!managerPhone()) return { state: 'failed', text: 'לא הוגדר מספר מנהל לקבלת התזכורות.' };
    if (last?.state === 'failed') return { state: 'failed', text: `התזכורת האחרונה (${last.at.slice(0, 16).replace('T', ' ')}) לא נשלחה: ${last.error}. ניסיון ${last.attempts} מתוך ${MAX_ATTEMPTS}.` };
    return { state: 'on', text: `תזכורת מרוכזת אחת בשעות ${s.settings.times.join(', ')}; אותה משימה לא תוזכר יותר מפעם ב-${s.settings.minGapHours} שעות.` };
  }

  function buildMessage(items, t) {
    const lines = items.slice(0, MAX_DIGEST_ITEMS).map((x, i) => `${i + 1}. ${x.agent === 'barak' ? 'ברק' : 'תומר'} · ${x.kind}: ${x.title}${x.who ? ` — ${x.who}` : ''} · ממתין ${x.waiting}${x.state === 'in_progress' ? ' · בטיפול' : ''}`);
    const more = items.length > MAX_DIGEST_ITEMS ? `\nועוד ${items.length - MAX_DIGEST_ITEMS} משימות בפאנל.` : '';
    const link = baseUrl() ? `\n\nלאישור ביצוע, דחייה או ביטול: ${baseUrl()}/#tomer` : '';
    return `📋 תזכורת: ${items.length} משימות מחכות לאישור ביצוע שלך\n${lines.join('\n')}${more}${link}`;
  }

  /**
   * Called every few minutes. Sends at most ONE consolidated message per configured time slot, only for tasks that are
   * due, outside the quiet hours. A failed send is recorded and retried in the same slot window (≤ MAX_ATTEMPTS).
   */
  async function tick() {
    const s = load(), t = now().getTime(), p = il(now());
    sync();
    if (!s.settings.enabled || !s.settings.times.length) return { sent: false, reason: 'off' };
    if (!s.settings.weekdays.includes(p.wd)) return { sent: false, reason: 'not_today' };
    if (isQuietHours()) return { sent: false, reason: 'quiet_hours' };
    const toMin = hm => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), nowMin = toMin(p.hm);
    const slot = s.settings.times.find(hm => nowMin >= toMin(hm) && nowMin < toMin(hm) + SLOT_WINDOW_MIN);
    if (!slot) return { sent: false, reason: 'not_a_send_time' };
    const slotKey = `${p.ymd} ${slot}`;
    const prior = s.digests.filter(g => g.slot === slotKey);
    if (prior.some(g => g.state === 'sent' || g.state === 'nothing_due')) return { sent: false, reason: 'slot_done' };
    if (prior.length >= MAX_ATTEMPTS) return { sent: false, reason: 'attempts_exhausted' };
    const items = due(t);
    if (!items.length) { s.digests.push({ at: now().toISOString(), slot: slotKey, state: 'nothing_due', keys: [] }); save(); return { sent: false, reason: 'nothing_due' }; }
    const phone = managerPhone();
    const rec = { at: now().toISOString(), slot: slotKey, state: 'failed', keys: items.map(x => x.key), attempts: prior.length + 1, error: null, idMessage: null };
    if (!phone) rec.error = 'לא הוגדר מספר מנהל';
    else {
      try { const r = await sendManager(phone, buildMessage(items, t)); if (r?.idMessage) { rec.state = 'sent'; rec.idMessage = r.idMessage; } else rec.error = r?.queued ? 'ההודעה נכנסה לתור ולא נשלחה' : 'הספק לא החזיר מזהה הודעה'; }
      catch (err) { rec.error = String(err.message).slice(0, 160); }
    }
    if (rec.state === 'sent') for (const x of items) { const it = s.items[x.key]; it.lastReminderAt = rec.at; it.reminderCount = (it.reminderCount ?? 0) + 1; }
    s.digests.push(rec); if (s.digests.length > 200) s.digests.splice(0, s.digests.length - 200);
    save();
    if (rec.state !== 'sent') logger.warn('[owner-tasks] the reminder was not sent', { slot: slotKey, attempt: rec.attempts, error: rec.error });
    return { sent: rec.state === 'sent', count: items.length, error: rec.error };
  }

  /** What the first reminder would contain if reminders were switched on now (nothing is sent). */
  const preview = () => { sync(); const items = due(); return { count: items.length, text: items.length ? buildMessage(items, now().getTime()) : null }; };

  return { collect, sync, list, board, act, due, setSettings, status, tick, preview, nextReminderAt, STATES, ACTION_HE, BOARD_HE, _reset() { state = null; } };
}

module.exports = { createOwnerTasks, STATES, ACTION_HE };
