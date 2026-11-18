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
 */

const fs = require('fs');
const path = require('path');

const STATES = ['open', 'in_progress', 'snoozed', 'done', 'cancelled'];
const ACTION_HE = { done: 'בוצע', in_progress: 'בטיפול', snooze: 'נדחה למועד', cancel: 'בוטל', reopen: 'נפתח מחדש', source_closed: 'נסגר במערכת המקור', seen: 'נרשם' };
const MAX_DIGEST_ITEMS = 12, MAX_ATTEMPTS = 3, SLOT_WINDOW_MIN = 20;

// the owner reads these: never the internal type code
const TASK_HE = { freeze_request: 'בקשת הקפאת מנוי', cancel_request: 'בקשת ביטול מנוי', cancellation_request: 'בקשת ביטול מנוי', fixed_booking_request: 'בקשת שיבוץ קבוע', staff_followup: 'לחזור ללקוח/ה',
  complaint: 'תלונה', unsupported_action: 'בקשה שהסוכן אינו מבצע', billing_question: 'שאלת חיוב', class_change: 'שינוי רישום לשיעור', voice_message: 'הודעה קולית', other: 'משימה כללית' };

function createOwnerTasks(d) {
  const { cases, tomerStore, aptStore, logger = console, caseLabel = c => c.category, sendManager, managerPhone = () => null,
          isQuietHours = () => false, closeSource = null, baseUrl = () => null } = d;
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
    try { for (const c of cases.list({ open: true, limit: 500 })) out.push({ key: `case:${c.id}`, agent: 'tomer', kind: 'פנייה', title: caseLabel(c), who: c.memberName ?? tail(c.phone), createdAt: c.createdAt, dueAt: c.createdAt, link: `#tomer/case/${c.id}` }); }
    catch (err) { out.error = `cases: ${err.message}`; }
    try { for (const t of tomerStore.getOpenTasks()) if (!(t.missing && !t.alert)) out.push({   // a request still being clarified with the member is not the owner's yet
       key: `task:${t.id}`, agent: 'tomer', kind: 'משימה', title: t.title ?? TASK_HE[t.type] ?? 'משימה לצוות', who: t.memberName ?? tail(t.phone), createdAt: t.createdAt, dueAt: t.createdAt, link: '#tomer' }); }
    catch (err) { out.error = `${out.error ? out.error + '; ' : ''}tasks: ${err.message}`; }
    try {
      for (const a of aptStore.getAll()) {
        if (!aptStore.ACTIVE_STATUSES.has(a.status)) continue;
        const due = a.windowEndAt ? new Date(a.windowEndAt) : a.scheduledAt instanceof Date ? a.scheduledAt : a.scheduledAt ? new Date(a.scheduledAt) : null;
        out.push({ key: `apt:${a.id}`, agent: 'barak', kind: 'שיחה חוזרת', title: 'לחזור לליד בטלפון', who: a.leadName ?? tail(a.leadPhone), createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
          dueAt: due && !isNaN(due) ? due.toISOString() : null, link: '#barak' });
      }
    } catch (err) { out.error = `${out.error ? out.error + '; ' : ''}appointments: ${err.message}`; }
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
    return { items: src, error: src.error ?? null };
  }

  const view = (key, rec, t) => {
    const snap = rec.snapshot ?? {};
    const effective = rec.state === 'snoozed' && rec.snoozeUntil && Date.parse(rec.snoozeUntil) <= t ? 'open' : rec.state;
    return { key, agent: snap.agent, kind: snap.kind, title: snap.title, who: snap.who, link: snap.link, state: effective, storedState: rec.state, snoozeUntil: rec.snoozeUntil,
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

  /** The owner's explicit word on a task. */
  async function act(key, action, { by = 'עדן', note = null, until = null } = {}) {
    sync();
    const s = load(), rec = s.items[key], nowIso = now().toISOString();
    if (!rec) return { ok: false, error: 'not_found' };
    if (!['done', 'in_progress', 'snooze', 'cancel', 'reopen'].includes(action)) return { ok: false, error: 'bad_action' };
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
      .filter(x => ['open', 'in_progress'].includes(x.state) && !x.notYetDue && (!x.lastReminderAt || t - Date.parse(x.lastReminderAt) >= gap))
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

  return { collect, sync, list, act, due, setSettings, status, tick, preview, STATES, ACTION_HE, _reset() { state = null; } };
}

module.exports = { createOwnerTasks, STATES, ACTION_HE };
