'use strict';

/**
 * member_handoff.js — a member asked for something that needs an ACTION, or sent a message the automatic flow
 * cannot read, on the route every member gets while the new Tomer service is in test-only mode.
 *
 * What happened before (production, 2026-11-16):
 *   • "נרשמתי לשש פילאטיס ואני רוצה לבוא ב 17:00" was answered by a free-text model with no access to the member's
 *     bookings ("אני רואה שנרשמת…" was not read from Arbox) and she was sent to the app. No task, no alert.
 *   • a voice message was answered "הצוות שלנו יחזור אליך בהקדם" — and nothing was created for the staff.
 *
 * What this module does, in this order, for such a message:
 *   1. reads the facts from Arbox, READ-ONLY (the member, her bookings that day, the class she asks for and its
 *      real occupancy) — every call and its outcome is kept on the task;
 *   2. creates ONE durable task for the staff (an open task of the same kind is updated, never duplicated);
 *   3. alerts the manager, and records whether the provider accepted the alert. A failed alert is kept as
 *      failed, shown with the task, and retried in a controlled way (retryFailedAlerts, three attempts);
 *   4. answers the member with exactly what is true: what was read from Arbox, that the request is with the
 *      staff, and that her existing registration is unchanged. It never says a change was made.
 *
 * ARBOX WRITES happen only through services/class_actions.js, and only when every lock there is open (switch,
 * named operation, verified contract, allowed phone). Even then NOTHING is written on the strength of the request
 * alone: the member is shown the exact action (class, date, hour) and must answer in TEXT ("כן") within 30 minutes.
 * A voice message can start a request (its transcript is read like a text) but can never confirm one.
 * A move books the new class, verifies it by reading back, and only then releases the old one — a failed move
 * never leaves the member without her original place. Whatever was not done AND verified becomes a staff task.
 *
 * VOICE MESSAGES (owner approval 2026-11-17): transcribed by the local editing worker through services/voice_intake.js.
 * While the transcript is awaited the task says so; when the worker is busy, offline or failed, the staff are alerted
 * and the member is asked to write — a recording never waits without a task and an alert whose send state is known.
 */

const { classify } = require('./member_intent');
const { extractDayAndTime, ilDateString, ilParts, HE_WEEKDAY_NAMES } = require('../utils/callback_time');

const BLOCK_REASON = 'אין לתומר הרשאה לשנות רישום לשיעור ב-Arbox (אין פעולת כתיבה מאומתת לרישום שיעורים; ARBOX_WRITES כבוי). השינוי נעשה על ידי הצוות.';
const MAX_ALERT_ATTEMPTS = 3;
const FOLLOWUP_MS = 60 * 60 * 1000;
const CONFIRM_MS = 30 * 60 * 1000;            // a written "כן" confirms the exact action shown, for this long
const CONFIRM_KEEP_MS = 6 * 60 * 60 * 1000;   // after that a late "כן" gets the question again, with fresh facts, for this long
const YES_RE = /^(?:כן+|כן כן|כן בבקשה|כן תודה|כן מאשרת?|מאשרת?|אני מאשרת?|מאושר|אשר|אשרי|בטח|ברור|יאללה|סבבה|נכון|בדיוק|אוקיי?|או קיי|ok|okay|yes)[\s.!,🙏👍✅❤️]*$/i;
const NO_RE = /^(?:לא+|לא תודה|לא צריך|לא לאשר|לא מאשרת?|ביטול|בטל|בטלי|תבטלי?|עזוב|עזבי|תשאיר|תשאירי|טעות|no)[\s.!,🙏]*$/i;
const NO_PERMISSION = new Set(['writes_disabled', 'not_in_test_audience']);
const VOICE_WHY = { off: 'התמלול האוטומטי כבוי', worker_offline: 'מחשב התמלול אינו מחובר כרגע', worker_busy: 'מחשב התמלול עסוק כרגע בעריכת סרטון; התמלול יצורף לפנייה כשיגיע',
  no_url: 'ספק הוואטסאפ לא מסר קישור להקלטה', unsupported_type: 'סוג קובץ השמע אינו נתמך', too_large: 'ההקלטה גדולה מדי לתמלול', download_failed: 'ההקלטה לא ירדה מספק הוואטסאפ',
  storage_failed: 'ההקלטה לא נשמרה בשרת', waited_too_long: 'התמלול לא הגיע בזמן', transcription_failed: 'התמלול נכשל', empty_transcript: 'בהקלטה לא זוהה דיבור', expired: 'ההקלטה נמחקה אחרי 24 שעות בלי שתומללה',
  delivery_failed: 'התמלול התקבל אך לא נקלט במערכת' };
const KIND_OF = { class_reschedule: 'move', class_book: 'book', class_cancel: 'cancel', regular_booking: 'regular' };
const KIND_HE = { move: 'מעבר לשיעור אחר', book: 'רישום לשיעור', cancel: 'ביטול רישום לשיעור', regular: 'שינוי שיבוץ קבוע' };
// "נרשמתי ל-18:00 ואני רוצה לבוא ב-17:00": registered for one class, wants another
const MOVE_RE = /(נרשמתי|רשומה?|שובצתי|משובצ(?:ת|ים)?|קבעתי|שיבצתי)[^.?!\n]{0,45}(רוצה|אפשר|מבקשת?|צריכה?|אשמח|מעדיפה?)[^.?!\n]{0,25}(לבוא|להגיע|לעבור|להחליף|לשנות|להעביר|במקום)/;
const HE_HOUR = { 'אחת עשרה': 11, 'שתים עשרה': 12, 'שתיים עשרה': 12, 'אחת': 1, 'שתיים': 2, 'שתים': 2, 'שלוש': 3, 'ארבע': 4, 'חמש': 5, 'שש': 6, 'שבע': 7, 'שמונה': 8, 'תשע': 9, 'עשר': 10 };

function detect(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (MOVE_RE.test(t)) return 'move';
  return KIND_OF[classify(t).category] ?? null;
}

/** Hours mentioned in a message, in order. `ambiguous` = written as 1–11 with no minutes ("לשש", "ב-5"). */
function hoursIn(text) {
  const t = String(text ?? '');
  const found = [];
  const digit = /(?:^|[\s(])(ב-?\s?|ל-?\s?|מ-?\s?|של\s+|בשעה\s+|לשעה\s+|משעה\s+)?(\d{1,2})(?::(\d{2}))?(?=$|[\s,.!?)])/g;
  let m;
  while ((m = digit.exec(t))) {
    const h = Number(m[2]), min = m[3] !== undefined ? Number(m[3]) : 0;
    if (h > 23 || min > 59 || (!m[1] && m[3] === undefined)) continue;          // a bare number is not an hour
    found.push({ at: m.index, h, min, ambiguous: m[3] === undefined && h >= 1 && h <= 11 });
  }
  const word = /(?:^|\s)(?:ב-?|ל-?|מ-?|בשעה\s+|לשעה\s+)(אחת עשרה|שתים עשרה|שתיים עשרה|אחת|שתיים|שתים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר)(?=$|[\s,.!?])/g;
  while ((m = word.exec(t))) found.push({ at: m.index, h: HE_HOUR[m[1]], min: 0, ambiguous: HE_HOUR[m[1]] <= 11 });
  return found.sort((a, b) => a.at - b.at);
}
const hhmm = (h, min = 0) => `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
const startsAt = (timeStr, h, min) => String(timeStr ?? '').slice(0, 5) === hhmm(h, min);
/** A written hour matched against real start times of that day ("שש" → 18:00 when that is what exists). */
function matchHour(hr, starts) {
  const cands = hr.ambiguous ? [hr.h + 12, hr.h] : [hr.h];
  for (const h of cands) { const s = starts.find(x => startsAt(x, h, hr.min)); if (s) return { h, min: hr.min, matched: true }; }
  return { h: hr.ambiguous && hr.h < 7 ? hr.h + 12 : hr.h, min: hr.min, matched: false };
}

function createMemberHandoff(deps) {
  const { gateway, tomerStore, alertOwner, sendText, logger, now = () => new Date(), classActions = null, voiceIntake = null, canAutoReply = () => true } = deps;
  const tail = p => String(p).slice(-4);
  const local = p => String(p).startsWith('972') ? '0' + String(p).slice(3) : String(p);
  const openTask = (phone, type) => tomerStore.getTasks({ phone, type }).find(t => !['resolved', 'closed', 'done'].includes(t.status)) ?? null;

  async function sendAlert(task, subject, body, slot = 'alert') {
    const prev = task[slot] ?? { attempts: 0 };
    let state = 'failed', idMessage = null, error = null;
    try {
      const ar = await alertOwner(subject, body, { linkPreview: false });
      const ok = (ar?.results ?? []).find(r => r.idMessage);
      if (ok) { state = 'sent'; idMessage = ok.idMessage; }
      else error = (ar?.results ?? []).map(r => r.error).filter(Boolean).join('; ') || 'no recipient accepted the alert';
    } catch (err) { error = err.message; }
    const alert = { state, attempts: (prev.attempts ?? 0) + 1, lastAt: now().toISOString(), idMessage: idMessage ?? prev.idMessage ?? null, error, subject, body };
    tomerStore.updateTask(task.id, { [slot]: alert });
    if (state === 'failed') logger.warn('[member-handoff] manager alert NOT accepted — kept as failed for retry', { taskId: task.id, tail: tail(task.phone), error });
    return alert;
  }

  /** Alerts the provider never accepted are sent again, at most MAX_ALERT_ATTEMPTS times in total, for open tasks only. */
  async function retryFailedAlerts() {
    let retried = 0, sent = 0;
    for (const t of tomerStore.getOpenTasks()) {
      for (const slot of ['alert', 'alertUpdate']) {
        const a = t[slot];
        if (!a || a.state !== 'failed' || (a.attempts ?? 0) >= MAX_ALERT_ATTEMPTS || !a.subject) continue;
        const r = await sendAlert(t, a.subject, a.body, slot);
        retried++; if (r.state === 'sent') sent++;
      }
    }
    const expired = await sweepConfirmations();
    return { retried, sent, expired };
  }

  /**
   * A member who was asked to confirm and did not answer: after 30 minutes the request goes to the staff (one alert,
   * nothing was sent to Arbox); after 6 hours the question itself is dropped. The member is not messaged.
   */
  async function sweepConfirmations() {
    let escalated = 0;
    for (const t of tomerStore.getOpenTasks()) {
      const pc = t.pendingConfirm;
      if (!pc) continue;
      const age = now().getTime() - new Date(pc.askedAt).getTime();
      if (age > CONFIRM_KEEP_MS) { tomerStore.updateTask(t.id, { pendingConfirm: null }); continue; }
      if (age > CONFIRM_MS && !pc.escalated) {
        tomerStore.updateTask(t.id, { pendingConfirm: { ...pc, escalated: true }, action: { state: 'not_confirmed_by_member', at: now().toISOString() },
          detail: `${t.detail}\nהמתאמנ/ת נשאל/ה לאישור בכתב ולא ענה/תה בתוך 30 דקות. לא נשלחה שום בקשה ל-Arbox.` });
        await sendAlert(t, `📌 תומר: ${KIND_HE[t.kind] ?? 'בקשת שיעור'} — ${t.memberName ?? local(t.phone)} (לא אישר/ה בכתב)`,
          [`👤 ${t.memberName ?? local(t.phone)}`, `📱 ${local(t.phone)}`, `💬 "${String(t.memberMessage ?? '').slice(0, 200)}"`, `הבקשה: ${pc.describe}`,
           `תומר ביקש אישור בכתב לפני שינוי ב-Arbox, ולא התקבלה תשובה בתוך 30 דקות.`, `לא בוצע שום שינוי ב-Arbox.`, `מזהה פנייה: ${t.id}`, `💬 https://wa.me/${t.phone}`].join('\n'));
        escalated++;
      }
    }
    return escalated;
  }

  async function reply(phone, text, task, pending) {
    if (pending?.has?.(phone)) { tomerStore.updateTask(task.id, { memberReply: { state: 'skipped_stale', text } }); return 'skipped_stale'; }
    let state = 'failed', idMessage = null, error = null;
    try {
      const r = await sendText(phone, text);
      if (r?.idMessage && !r.blocked) { state = 'sent'; idMessage = r.idMessage; }
      else if (r?.queued) state = 'queued';
      else error = r?.blocked ? 'blocked' : 'no provider id';
    } catch (err) { error = err.message; }
    tomerStore.updateTask(task.id, { memberReply: { state, idMessage, error, at: now().toISOString(), text } });
    tomerStore.appendAudit({ phone, memberName: task.memberName, event: 'member_handoff_reply', requestPreview: String(task.memberMessage ?? '').slice(0, 100),
      tomerAction: `handoff:${task.type}`, replyPreview: text.slice(0, 100), owner: 'tomer', taskId: task.id, sendState: state });
    return state;
  }

  /** The facts of one class request, read from Arbox. Nothing is written. */
  async function readFacts(phone, text, ref, fixedDate = null) {
    const dt = extractDayAndTime(text, ref);
    const p = ilParts(ref);
    const day = dt.day ?? { year: p.year, month: p.month, day: p.day };
    const date = fixedDate ?? ilDateString(day);
    const calls = [];
    const f = { date, dayGiven: !!dt.day, member: null, identity: null, bookings: null, classes: null, occupancyAvailable: null, calls };
    try {
      const r = await gateway.resolveMember(phone);
      f.identity = r.status; calls.push(`resolveMember → ${r.status}`);
      if (r.status === 'found') f.member = r.member;
    } catch (err) { f.identity = 'unavailable'; calls.push(`resolveMember → error: ${err.message}`); }
    if (f.member) {
      try { const r = await gateway.getBookings(f.member.userId, { from: date, to: date, fresh: true }); f.bookings = r.bookings; calls.push(`getBookings ${date} → ${r.bookings.length}`); }
      catch (err) { calls.push(`getBookings ${date} → error: ${err.message}`); }
    }
    try { const r = await gateway.getClasses({ from: date, to: date }); f.classes = r.classes; f.occupancyAvailable = r.occupancyAvailable; calls.push(`getClasses ${date} → ${r.classes.length}${r.occupancyAvailable ? '' : ' (occupancy unavailable)'}`); }
    catch (err) { calls.push(`getClasses ${date} → error: ${err.message}`); }
    return f;
  }

  /** Which class she is in, and which one she asks for — from the hours in the message and what Arbox shows. */
  function resolveRequest(kind, text, f) {
    const hrs = hoursIn(text);
    const bookStarts = (f.bookings ?? []).map(b => b.time), classStarts = (f.classes ?? []).map(c => c.start);
    let current = null, target = null;
    const asBooking = hrs.map(h => ({ h, m: matchHour(h, bookStarts) })).filter(x => x.m.matched);
    if (kind === 'move' || kind === 'cancel') {
      if (asBooking.length) current = { ...asBooking[0].m, booking: f.bookings.find(b => startsAt(b.time, asBooking[0].m.h, asBooking[0].m.min)) };
      else if ((f.bookings ?? []).length === 1 && kind === 'move') { const b = f.bookings[0]; current = { h: Number(b.time.slice(0, 2)), min: Number(b.time.slice(3, 5)), matched: true, booking: b }; }
      else if (hrs.length && kind === 'cancel') current = { ...matchHour(hrs[0], classStarts), booking: null };
      else if (hrs.length >= 2 && kind === 'move') current = { ...matchHour(hrs[0], classStarts), booking: null };
    }
    if (kind === 'move' || kind === 'book') {
      const rest = hrs.filter(h => !current || !(matchHour(h, bookStarts.length ? bookStarts : classStarts).h === current.h && h.min === current.min));
      const pick = kind === 'move' ? rest[rest.length - 1] : hrs[hrs.length - 1];
      if (pick) { const m = matchHour(pick, classStarts); target = { ...m, cls: (f.classes ?? []).find(c => startsAt(c.start, m.h, m.min)) ?? null }; }
    }
    return { current, target, missing: (kind === 'move' || kind === 'book') && !target ? 'target_time' : (kind === 'cancel' && !current && (f.bookings ?? []).length !== 1 ? 'which_class' : null) };
  }

  /** The request exactly as it was shown to the member when she was asked to confirm, matched against FRESH facts. */
  function fromPending(pc, f) {
    const hm = t => ({ h: Number(t.slice(0, 2)), min: Number(t.slice(3, 5)), matched: true });
    const current = pc.current ? { ...hm(pc.current.time), booking: (f.bookings ?? []).find(b => String(b.time).slice(0, 5) === pc.current.time) ?? null } : null;
    const target = pc.target ? { ...hm(pc.target.time), cls: (f.classes ?? []).find(c => String(c.scheduleId) === String(pc.target.scheduleId)) ?? null } : null;
    return { current, target, missing: null };
  }
  /** The day, always with its date ("היום, יום שלישי 17.11"), for a question the member must be able to verify. */
  function dayExact(f, ref) {
    const [y, mo, d] = f.date.split('-').map(Number);
    const wd = `יום ${HE_WEEKDAY_NAMES[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}`;
    return f.date === ilDateString(ilParts(ref)) ? `היום, ${wd}` : `ב${wd}`;
  }

  function dayText(f, ref) {
    const today = ilDateString(ilParts(ref));
    if (f.date === today) return 'היום';
    const [y, mo, d] = f.date.split('-').map(Number);
    return `ביום ${HE_WEEKDAY_NAMES[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}`;
  }

  /**
   * A text message from a member on the legacy route. Returns null when it is not a class action (the caller goes
   * on as before); otherwise { handled:true, kind, taskId, isNew, alert, replyText, sendState, facts }.
   */
  async function handleClassRequest({ phone, text, name = null, sentAt = null, pending = null, fromVoice = false }) {
    const ref = sentAt instanceof Date && !isNaN(sentAt) ? sentAt : now();
    let kind = detect(text);
    let existing = openTask(phone, 'class_change');
    // ── the member's written answer to "לאשר?" ──────────────────────────────
    let pc = existing?.pendingConfirm ?? null, confirmed = false, answeredPending = false;
    if (pc && kind) {                                    // a NEW request replaces the one that was waiting for a "כן"
      tomerStore.updateTask(existing.id, { pendingConfirm: null, action: { state: 'replaced_by_new_request', at: now().toISOString() } });
      tomerStore.resolveTask(existing.id, { resolutionNote: 'הוחלפה בבקשה חדשה של המתאמנ/ת לפני אישור — לא נשלחה בקשה ל-Arbox', resolvedBy: 'tomer' });
      existing = null; pc = null;
    }
    if (pc && !kind && !fromVoice) {
      const t = String(text ?? '').trim();
      if (NO_RE.test(t)) {
        tomerStore.updateTask(existing.id, { pendingConfirm: null, action: { state: 'declined_by_member', at: now().toISOString() } });
        tomerStore.resolveTask(existing.id, { resolutionNote: 'המתאמנ/ת ענה/תה שלא לבצע — לא נשלחה בקשה ל-Arbox', resolvedBy: 'tomer' });
        const txt = 'בסדר, לא שיניתי דבר. הרישום שלך נשאר כמו שהוא 🙏';
        const st = await reply(phone, txt, existing, pending);
        return { handled: true, kind: existing.kind, taskId: existing.id, isNew: false, missing: null, alert: null, replyText: txt, sendState: st, action: { state: 'declined_by_member' } };
      }
      if (YES_RE.test(t)) { kind = existing.kind; answeredPending = true; confirmed = now().getTime() - new Date(pc.askedAt).getTime() <= CONFIRM_MS; }
    }
    if (!answeredPending) pc = null;
    // the answer to "לאיזו שעה לעבור?" — an hour, within the hour after the question
    if (!kind && existing?.missing && now().getTime() - new Date(existing.updatedAt).getTime() <= FOLLOWUP_MS && hoursIn(text).length) kind = existing.kind;
    if (!kind) return null;
    if (existing && existing.kind !== kind && !existing.missing) existing = null;

    const fullText = pc ? existing.memberMessage : existing?.missing ? `${existing.memberMessage} ${text}` : text;
    const f = await readFacts(phone, fullText, ref, pc?.date ?? null);
    const rq = pc ? fromPending(pc, f) : resolveRequest(kind, fullText, f);
    const who = name ?? f.member?.name ?? local(phone);
    const dTxt = dayText(f, ref);

    // ── what is true, in words ──────────────────────────────────────────────
    const lines = [], facts = [];
    const cur = rq.current, tgt = rq.target;
    if (f.identity !== 'found') facts.push(`זיהוי ב-Arbox לפי טלפון: ${f.identity === 'ambiguous' ? 'לא חד-משמעי' : f.identity === 'unavailable' ? 'Arbox לא זמין' : 'לא נמצא/ה'}`);
    if (f.bookings === null) { facts.push('הרישומים של המתאמנ/ת לא נקראו מ-Arbox'); if (kind !== 'book') lines.push('לא הצלחתי לבדוק כרגע את הרישום שלך ב-Arbox.'); }
    else if (cur?.booking) { facts.push(`רישום קיים (Arbox): ${cur.booking.className ?? 'שיעור'} ${cur.booking.time.slice(0, 5)} ${f.date}`); lines.push(`בדקתי ב-Arbox: יש לך רישום ל${cur.booking.className ?? 'שיעור'} ב-${cur.booking.time.slice(0, 5)} ${dTxt}.`); }
    else if (kind !== 'book') { facts.push(`לא נמצא ב-Arbox רישום ${cur ? `ב-${hhmm(cur.h, cur.min)} ` : ''}${f.date}${f.bookings.length ? ` (רישומים באותו יום: ${f.bookings.map(b => b.time.slice(0, 5)).join(', ')})` : ''}`); lines.push(`בדקתי ב-Arbox ולא מצאתי רישום שלך ${cur ? `ב-${hhmm(cur.h, cur.min)} ` : ''}${dTxt}.`); }
    if (tgt) {
      const t = hhmm(tgt.h, tgt.min);
      if (f.classes === null) { facts.push(`מערכת השיעורים לא נקראה מ-Arbox; שעה מבוקשת ${t}`); lines.push(`את השיעור של ${t} לא הצלחתי לבדוק כרגע ב-Arbox.`); }
      else if (!tgt.cls) { facts.push(`לא נמצא ב-Arbox שיעור ב-${t} ${f.date}`); lines.push(`לא מצאתי ב-Arbox שיעור ב-${t} ${dTxt}.`); }
      else {
        const o = tgt.cls.occupancy;
        facts.push(`שיעור מבוקש (Arbox): ${tgt.cls.name} ${t} ${f.date} — ${o ? `${o.registered}/${o.capacity} רשומים, ${o.spotsLeft} פנויים${o.standby ? `, ${o.standby} בהמתנה` : ''}` : 'תפוסה לא ידועה'}`);
        lines.push(o ? (o.spotsLeft > 0 ? `ב-${t} יש ${tgt.cls.name}, ונכון לעכשיו יש בו ${o.spotsLeft === 1 ? 'מקום פנוי אחד' : `${o.spotsLeft} מקומות פנויים`}.` : `ב-${t} יש ${tgt.cls.name}, והוא מלא כרגע.`)
          : `ב-${t} יש ${tgt.cls.name}; את מספר המקומות הפנויים לא הצלחתי לבדוק.`);
      }
    }
    const want = kind === 'move' ? `מעבר ${cur ? `מ-${hhmm(cur.h, cur.min)} ` : ''}${tgt ? `ל-${hhmm(tgt.h, tgt.min)} ` : ''}${dTxt}` : kind === 'book' ? `רישום ${tgt ? `ל-${hhmm(tgt.h, tgt.min)} ` : ''}${dTxt}`
      : kind === 'cancel' ? `ביטול הרישום ${cur ? `של ${hhmm(cur.h, cur.min)} ` : ''}${dTxt}` : 'שינוי בשיבוץ הקבוע';

    // ── do it in Arbox, when this system is permitted to (services/class_actions.js; off unless explicitly enabled) ──
    // The staff task below is the fallback: it is opened whenever the change was not made AND verified.
    let action = null;
    if (classActions && !rq.missing && kind !== 'regular') {
      try {
        const pl = await classActions.plan({ kind, phone, member: f.member, date: f.date, bookings: f.bookings, classes: f.classes, current: cur, target: tgt });
        if (pl.ok && !confirmed) {
          // permitted, and every rule passed on fresh data: show the member the EXACT action and wait for a written "כן"
          const dEx = dayExact(f, ref);
          const describe = kind === 'move' ? `מעבר מ${cur.booking.className ?? 'שיעור'} ב-${hhmm(cur.h, cur.min)} ל${tgt.cls.name} ב-${hhmm(tgt.h, tgt.min)}, ${dEx}`
            : kind === 'book' ? `רישום ל${tgt.cls.name} ב-${hhmm(tgt.h, tgt.min)}, ${dEx}` : `ביטול הרישום ל${cur.booking.className ?? 'שיעור'} ב-${hhmm(cur.h, cur.min)}, ${dEx}`;
          const pend = { askedAt: now().toISOString(), date: f.date, kind, describe, late: !!pl.late, fromVoice: !!fromVoice,
            current: cur?.booking ? { time: hhmm(cur.h, cur.min), className: cur.booking.className ?? null } : null,
            target: tgt?.cls ? { time: hhmm(tgt.h, tgt.min), scheduleId: tgt.cls.scheduleId, name: tgt.cls.name } : null };
          const det = [`בקשה: ${want}`, ...facts, `ממתין לאישור בכתב של המתאמנ/ת לפעולה: ${describe}`, fromVoice ? 'מקור הבקשה: תמלול אוטומטי של הודעה קולית (לא אומת)' : null,
            `קריאות Arbox (קריאה בלבד): ${f.calls.join(' · ')}`].filter(Boolean).join('\n');
          let task, isNew = false;
          if (existing) task = tomerStore.updateTask(existing.id, { summary: `${KIND_HE[kind]} — ${want} (ממתין לאישור בכתב)`, detail: det, memberMessage: fullText, missing: null, kind, arboxCalls: f.calls, pendingConfirm: pend, action: { state: 'awaiting_member_confirmation', at: pend.askedAt } });
          else {
            task = tomerStore.createTask({ type: 'class_change', phone, memberName: who, arboxId: f.member?.userId ?? null, summary: `${KIND_HE[kind]} — ${want} (ממתין לאישור בכתב)`, detail: det, memberMessage: fullText, priority: 'normal' });
            task = tomerStore.updateTask(task.id, { kind, missing: null, arboxCalls: f.calls, pendingConfirm: pend, action: { state: 'awaiting_member_confirmation', at: pend.askedAt } });
            isNew = true;
          }
          const askText = [fromVoice ? 'מהתמלול של ההודעה הקולית הבנתי את הבקשה כך:' : (answeredPending ? 'עבר זמן מאז ששאלתי, אז בדקתי שוב ב-Arbox. רק לוודא לפני שאני משנה:' : 'רק לוודא לפני שאני משנה ב-Arbox:'),
            `${describe}.`, `לאשר? אפשר לענות "כן" ואבצע, או "לא" ולא אשנה דבר.`].join('\n');
          const st = await reply(phone, askText, task, pending);
          logger.info('[member-handoff] class action planned — waiting for the member\'s written confirmation', { tail: tail(phone), kind, taskId: task.id, late: !!pl.late, fromVoice: !!fromVoice, sendState: st });
          return { handled: true, kind, taskId: task.id, isNew, missing: null, alert: null, replyText: askText, sendState: st, facts: f, request: rq, action: { state: 'awaiting_member_confirmation' } };
        }
        action = { plan: pl, result: pl.ok ? await classActions.execute(pl) : null };
      } catch (err) {
        logger.error('[member-handoff] class action failed before any request — handing over to the staff', { tail: tail(phone), error: err.message });
        action = { plan: { ok: false, reason: 'error', text: `תקלה פנימית לפני שליחת בקשה ל-Arbox (${err.message})` }, result: null };
      }
    }
    const res = action?.result ?? null;
    const actionLines = res ? res.log.map(l => `Arbox ${l.op}: ${l.accepted ? 'התקבל' : `לא התקבל (${l.error?.message ?? ''})`}${l.verify ? ` · אימות בקריאה: ${l.verify.verified ? 'אושר' : 'לא אושר'}` : ''}`) : [];
    if (res?.ok) {
      // done and seen in Arbox: recorded as a closed task (no alert - nothing is waiting for the staff)
      const did = kind === 'move' ? `עברת מ-${hhmm(cur.h, cur.min)} ל-${hhmm(tgt.h, tgt.min)} ${dTxt}` : kind === 'book' ? `נרשמת ל${tgt.cls.name} ב-${hhmm(tgt.h, tgt.min)} ${dTxt}` : `הרישום שלך ל-${hhmm(cur.h, cur.min)} ${dTxt} בוטל`;
      const bal = res.balance ?? { check: 'unknown', note: 'יתרת הכניסות לא נבדקה' };
      const doneDetail = [`בקשה: ${want}`, ...facts, ...actionLines, `רישומים ויתרת כניסות (לפני/אחרי): ${bal.note}`, pc ? `אישור בכתב של המתאמנ/ת: "${String(text).slice(0, 40)}"` : null, `קריאות Arbox: ${f.calls.join(' · ')}`].filter(Boolean).join('\n');
      const actRec = { state: 'done', done: res.done, log: res.log, balance: bal, late: !!action.plan.late, confirmedAt: now().toISOString(), confirmedText: String(text).slice(0, 40) };
      let task;
      if (existing) task = tomerStore.updateTask(existing.id, { summary: `${KIND_HE[kind]} — ${want} (בוצע אוטומטית)`, detail: doneDetail, pendingConfirm: null, kind, missing: null, arboxCalls: f.calls, action: actRec });
      else {
        task = tomerStore.createTask({ type: 'class_change', phone, memberName: who, arboxId: f.member?.userId ?? null, summary: `${KIND_HE[kind]} — ${want} (בוצע אוטומטית)`, detail: doneDetail, memberMessage: fullText, priority: 'normal' });
        task = tomerStore.updateTask(task.id, { kind, missing: null, arboxCalls: f.calls, action: actRec });
      }
      let doneAlert = null;
      if (bal.check === 'ok') tomerStore.resolveTask(task.id, { resolutionNote: 'בוצע ואומת ב-Arbox על ידי תומר (רישומים ויתרת כניסות נבדקו)', resolvedBy: 'tomer' });
      else {
        // the change itself is verified; what is NOT verified is the member's balance. The staff are told exactly that.
        tomerStore.updateTask(task.id, { priority: 'high' });
        doneAlert = await sendAlert(task, `⚠️ תומר: ${KIND_HE[kind]} בוצע — לבדוק יתרת כניסות — ${who}`,
          [`👤 ${who}`, `📱 ${local(phone)}`, `בוצע ואומת ב-Arbox: ${did}.`, bal.check === 'mismatch' ? `⚠️ בדיקת הרישומים/היתרה מצאה חריגה: ${bal.note}` : `יתרת הכניסות לא אומתה: ${bal.note}`,
           `תומר לא שלח שום בקשה נוספת. נא לבדוק ב-Arbox שלא נגרעה כניסה כפולה.`, `מזהה פנייה: ${task.id}`, `💬 https://wa.me/${phone}`].join('\n'));
      }
      const doneText = [`בוצע ✅ ${did}.`, `אימתתי את זה עכשיו מול Arbox.`, bal.check === 'ok' ? null : `ביקשתי מהצוות לוודא את יתרת הכניסות שלך אחרי השינוי.`].filter(Boolean).join('\n');
      const sendStateDone = await reply(phone, doneText, task, pending);
      logger.info('[member-handoff] class change done and verified in Arbox', { tail: tail(phone), kind, taskId: task.id, done: res.done, balance: bal.check, sendState: sendStateDone });
      return { handled: true, kind, taskId: task.id, isNew: !existing, missing: null, alert: doneAlert, replyText: doneText, sendState: sendStateDone, facts: f, request: rq, action: { state: 'done', done: res.done, balance: bal.check } };
    }
    const whyStaff = res ? `הפעולה האוטומטית לא הושלמה (${res.failed.op}: ${res.failed.reason}). מצב: ${res.state === 'holds_both' ? 'רשומה לשני השיעורים' : res.state === 'unknown' ? 'לא ידוע — נדרש אימות ב-Arbox' : 'לא השתנה דבר'}`
      : action?.plan && !action.plan.ok && !NO_PERMISSION.has(action.plan.reason) ? `לא בוצע אוטומטית: ${action.plan.text}` : BLOCK_REASON;

    // ── ONE durable task ────────────────────────────────────────────────────
    const detail = [`בקשה: ${want}`, ...facts, ...actionLines, rq.missing ? `חסר: ${rq.missing === 'target_time' ? 'שעת היעד — המתאמנ/ת נשאל/ה' : 'איזה שיעור — המתאמנ/ת נשאל/ה'}` : null,
      `למה זה אצל הצוות: ${whyStaff}`, `קריאות Arbox (קריאה בלבד): ${f.calls.join(' · ')}`].filter(Boolean).join('\n');
    let task, isNew = false;
    const wasMissing = existing?.missing ?? null;            // read before the task object is updated in place
    if (existing) task = tomerStore.updateTask(existing.id, { summary: `${KIND_HE[kind]} — ${want}`, detail, memberMessage: fullText, missing: rq.missing, kind, arboxCalls: f.calls, pendingConfirm: null,
      ...(pc ? { action: { state: 'not_done_after_confirmation', at: now().toISOString() } } : {}) });
    else {
      task = tomerStore.createTask({ type: 'class_change', phone, memberName: who, arboxId: f.member?.userId ?? null, summary: `${KIND_HE[kind]} — ${want}`, detail, memberMessage: text, priority: 'normal' });
      task = tomerStore.updateTask(task.id, { kind, missing: rq.missing, arboxCalls: f.calls });
      isNew = true;
    }

    // ── the manager: once when the task is opened, once more when a missing detail arrived ──
    let alert = task.alert ?? null;
    if (isNew || (wasMissing && !rq.missing) || (pc && !task.alert)) {
      alert = await sendAlert(task, `${isNew ? '📌 תומר' : '🔁 תומר — עדכון'}: ${KIND_HE[kind]} — ${who}`,
        [`👤 ${who}`, `📱 ${local(phone)}`, `💬 "${String(fullText).slice(0, 200)}"`, ...detail.split('\n').slice(0, -1),
         res?.state === 'holds_both' ? `⚠️ הרישום החדש בוצע ב-Arbox; הרישום הקודם לא בוטל — נדרש ביטול ידני.` : res?.state === 'unknown' ? `⚠️ נשלחה בקשה ל-Arbox ותוצאתה לא אומתה — נא לבדוק ב-Arbox.` : `לא בוצע שום שינוי ב-Arbox.`,
         `מזהה פנייה: ${task.id}`, `💬 https://wa.me/${phone}`].join('\n'));
      if (res) tomerStore.updateTask(task.id, { priority: 'high', action: { state: res.state, done: res.done, failed: res.failed, log: res.log, balance: res.balance ?? null } });
    }

    // ── the member: only what is true ───────────────────────────────────────
    let replyText;
    if (rq.missing === 'target_time') replyText = `קיבלתי 🙏 ${lines.join(' ')} לאיזו שעה ${kind === 'move' ? 'לעבור' : 'לרשום אותך'}?`.replace(/\s+/g, ' ');
    else if (rq.missing === 'which_class') replyText = `קיבלתי 🙏 ${lines.join(' ')} איזה שיעור לבטל? (יום ושעה)`.replace(/\s+/g, ' ');
    else if (res?.state === 'holds_both') replyText = [`רשמתי אותך ל${tgt.cls.name} ב-${hhmm(tgt.h, tgt.min)} ${dTxt}, ואימתתי את זה מול Arbox ✅`,
      `את הרישום ל-${hhmm(cur.h, cur.min)} לא הצלחתי לבטל, אז כרגע יש לך רישום לשני השיעורים.`, alert?.state === 'sent' ? `העברתי לצוות כדי שיבטלו את ${hhmm(cur.h, cur.min)}.` : `רשמתי לצוות לבטל את ${hhmm(cur.h, cur.min)}.`].join('\n');
    else if (res?.state === 'unknown') replyText = [`קיבלתי את הבקשה: ${want}.`, `שלחתי אותה ל-Arbox, אבל לא הצלחתי לאמת שהיא בוצעה, ולכן אני לא אומר לך שזה נעשה.`,
      alert?.state === 'sent' ? `העברתי לצוות לבדיקה, ויעדכנו אותך כאן.` : `רשמתי לצוות לבדוק, ויעדכנו אותך כאן.`].join('\n');
    else replyText = [`קיבלתי את הבקשה: ${want}.`, ...lines,
      (res || (action?.plan && !action.plan.ok && !NO_PERMISSION.has(action.plan.reason)))
        ? `${res ? 'ניסיתי לבצע את זה ב-Arbox ולא הצלחתי' : `לא ביצעתי את זה בעצמי: ${action.plan.text}`} ${alert?.state === 'sent' ? 'העברתי את הבקשה לצוות.' : 'רשמתי את הבקשה לטיפול הצוות.'}`
        : alert?.state === 'sent' ? `אין לי הרשאה לשנות רישום בעצמי, אז העברתי את הבקשה לצוות.` : `אין לי הרשאה לשנות רישום בעצמי, אז רשמתי את הבקשה לטיפול הצוות.`,
      kind === 'move' ? `הרישום הקיים שלך לא השתנה: הוא נשאר במקומו עד שהצוות יאשר לך כאן את המעבר.` : kind === 'cancel' ? `הרישום שלך לא בוטל עד שהצוות יאשר לך כאן.` : `עדיין לא נרשמת: הצוות יאשר לך כאן.`].join('\n');
    const sendState = await reply(phone, replyText, task, pending);
    logger.info('[member-handoff] class request recorded for the staff', { tail: tail(phone), kind, taskId: task.id, isNew, missing: rq.missing, alert: alert?.state ?? null, sendState, arbox: f.calls });
    return { handled: true, kind, taskId: task.id, isNew, missing: rq.missing, alert, replyText, sendState, facts: f, request: rq };
  }

  /**
   * The staff are told about a voice message / file whose content this system does not know (or knows only from an
   * unverified transcript), and the member is told the truth and invited to write. Used when there is no transcript
   * to act on: the worker is off, busy, failed, or took too long.
   */
  async function escalateMedia(task, { voice, label, type, caption = null, why = null, pending = null, replyToMember = true }) {
    const who = task.memberName ?? local(task.phone);
    const alert = await sendAlert(task, `🎙️ תומר: ${label} — ${who}`, [`👤 ${who}`, `📱 ${local(task.phone)}`, ...String(task.detail ?? '').split('\n'),
      replyToMember ? `המתאמנ/ת קיבל/ה הודעה שהפנייה נרשמה והוזמנ/ה לכתוב.` : `לא נשלחה תשובה אוטומטית למתאמנ/ת.`, `מזהה פנייה: ${task.id}`, `💬 https://wa.me/${task.phone}`].join('\n'));
    if (!replyToMember) return { alert, replyText: null, sendState: 'not_sent' };
    const passed = alert.state === 'sent' ? 'רשמתי פנייה והעברתי אותה לצוות' : 'רשמתי פנייה לטיפול הצוות';
    const replyText = voice ? `קיבלתי את ההודעה הקולית 🙏 ${why === 'off' ? 'אני לא מאזין להקלטות' : 'לא הצלחתי להאזין לה כרגע'}, אז ${passed}.\nאם נוח לך, אפשר לכתוב לי כאן בקצרה במה מדובר, וכך אוכל לעזור מהר יותר.`
      : `קיבלתי את הקובץ 🙏 ${passed}.\nאם יש בקשה שקשורה אליו, אפשר לכתוב לי אותה כאן.`;
    const sendState = await reply(task.phone, replyText, task, pending);
    logger.info('[member-handoff] media recorded for the staff', { tail: tail(task.phone), type, taskId: task.id, alert: alert.state, sendState, why });
    return { alert, replyText, sendState };
  }

  /**
   * A voice message / file from a member. A file is never read automatically. A voice message is sent to the local
   * transcription worker when it is reachable (media = { messageId, mediaUrl, mimeType, receivedAt }); the task is
   * opened FIRST, so a recording never exists without one. Otherwise - and whenever the worker is busy editing - the
   * staff are alerted and the member is invited to write, at once.
   */
  async function handleMedia({ phone, type, name = null, caption = null, pending = null, media = null }) {
    const voice = /audio|voice|ptt/i.test(String(type));
    const tType = voice ? 'voice_message' : 'media_message';
    const label = voice ? 'הודעה קולית' : `קובץ (${type})`;
    const existing = openTask(phone, tType);
    if (existing && !(voice && voiceIntake)) {
      tomerStore.updateTask(existing.id, { detail: `${existing.detail}\n+ ${label} נוספ/ת ב-${now().toISOString()}${caption ? ` — "${String(caption).slice(0, 120)}"` : ''}`, received: (existing.received ?? 1) + 1 });
      return { handled: true, taskId: existing.id, isNew: false, alert: existing.alert ?? null, replyText: null, sendState: 'not_sent_already_answered' };
    }
    const who = name ?? local(phone);
    let task = existing, isNew = false;
    if (!task) {
      task = tomerStore.createTask({ type: tType, phone, memberName: who, summary: `${label} ממתאמנ/ת`, priority: 'normal', memberMessage: caption ?? `[${label}]`,
        detail: [voice ? 'הודעה קולית התקבלה.' : 'הקובץ לא נקרא אוטומטית, ולכן תוכן הבקשה אינו ידוע.', caption ? `כיתוב: "${String(caption).slice(0, 200)}"` : null].filter(Boolean).join('\n') });
      task = tomerStore.updateTask(task.id, { received: 1 });
      isNew = true;
    } else task = tomerStore.updateTask(task.id, { received: (task.received ?? 1) + 1, detail: `${task.detail}\n+ ${label} נוספת ב-${now().toISOString()}` });

    let q = { queued: false, reason: 'off' };
    if (voice && voiceIntake) {
      try { q = await voiceIntake.receive({ phone, messageId: media?.messageId ?? null, mediaUrl: media?.mediaUrl ?? null, mimeType: media?.mimeType ?? null, receivedAt: media?.receivedAt ?? null, taskId: task.id }); }
      catch (err) { logger.error('[member-handoff] voice intake failed', { tail: tail(phone), error: err.message }); q = { queued: false, reason: 'storage_failed' }; }
    }
    if (q.duplicate) return { handled: true, taskId: task.id, isNew: false, alert: task.alert ?? null, replyText: null, sendState: 'duplicate_message' };
    if (q.queued && q.availability === 'online') {
      // the worker is polling: the transcript is expected within seconds. Nothing is said to anyone yet; if it does
      // not arrive within the wait limit, voiceFallback() below alerts the staff and asks the member to write.
      tomerStore.updateTask(task.id, { summary: `${label} ממתאמנ/ת — ממתינה לתמלול`, transcription: { state: 'waiting', jobId: q.job.id, since: now().toISOString() } });
      logger.info('[member-handoff] voice message queued for transcription', { tail: tail(phone), taskId: task.id, jobId: q.job.id });
      return { handled: true, taskId: task.id, isNew, alert: null, replyText: null, sendState: 'waiting_transcription', jobId: q.job.id };
    }
    const reason = q.queued ? 'worker_busy' : q.reason;
    if (existing?.alert && !q.queued) {                       // a further recording on a task the staff already know about
      return { handled: true, taskId: task.id, isNew: false, alert: existing.alert, replyText: null, sendState: 'not_sent_already_answered' };
    }
    task = tomerStore.updateTask(task.id, { summary: `${label} ממתאמנ/ת — לא טופלה אוטומטית`,
      detail: [task.detail, voice ? `ההודעה הקולית לא תומללה: ${VOICE_WHY[reason] ?? reason}. תוכן הבקשה אינו ידוע.` : null, 'נדרש: להאזין / לפתוח בוואטסאפ ולענות.'].filter(Boolean).join('\n'),
      transcription: voice ? { state: q.queued ? 'waiting_after_handoff' : 'not_transcribed', reason, jobId: q.job?.id ?? null, at: now().toISOString() } : null });
    if (q.queued) await voiceIntake.markFallback(q.job.id, 'worker_busy_handled');   // marks the job; the alert below is the hand-over
    const out = await escalateMedia(task, { voice, label, type, caption, why: reason, pending });
    return { handled: true, taskId: task.id, isNew, ...out };
  }

  /** voice_intake → the transcript did not arrive in time, or the worker failed. Called once per recording. */
  async function voiceFallback(job, reason) {
    if (reason === 'worker_busy_handled') return;            // handleMedia already alerted and answered
    const task = tomerStore.getTasks({ phone: job.phone, type: 'voice_message' }).find(t => t.id === job.taskId);
    if (!task || ['resolved', 'closed', 'done'].includes(task.status)) return;
    const first = !task.alert;
    const t2 = tomerStore.updateTask(task.id, { summary: 'הודעה קולית ממתאמנ/ת — לא טופלה אוטומטית',
      detail: `${task.detail}\nההודעה הקולית לא תומללה: ${VOICE_WHY[reason] ?? reason}. תוכן הבקשה אינו ידוע.\nנדרש: להאזין בוואטסאפ ולענות.`,
      transcription: { state: reason === 'waited_too_long' ? 'waiting_after_handoff' : 'not_transcribed', reason, jobId: job.id, at: now().toISOString() } });
    if (first) await escalateMedia(t2, { voice: true, label: 'הודעה קולית', type: 'audio', why: reason, replyToMember: canAutoReply(job.phone) });
  }

  /**
   * voice_intake → a transcript arrived. It is DATA from an automatic, unverified transcription: it can route the
   * request and tell the staff what it is about; it can start a class request (the member then confirms the exact
   * action in TEXT); it can never confirm anything and nothing in it is treated as an instruction to this system.
   */
  async function handleTranscript(job) {
    const text = String(job.transcript?.text ?? '').trim();
    const task = tomerStore.getTasks({ phone: job.phone, type: 'voice_message' }).find(t => t.id === job.taskId);
    if (!task || !text) return { handled: false };
    const closed = ['resolved', 'closed', 'done'].includes(task.status);
    const tr = { state: 'done', text, unverified: true, language: job.transcript.language ?? null, seconds: job.transcript.duration_s ?? null, model: job.transcript.model ?? null, at: now().toISOString(), jobId: job.id };
    let t2 = tomerStore.updateTask(task.id, { transcription: tr, memberMessage: `[הודעה קולית] ${text.slice(0, 500)}`,
      detail: `${task.detail}\nתמלול אוטומטי (לא אומת): "${text.slice(0, 600)}"`, ...(closed ? {} : { summary: 'הודעה קולית ממתאמנ/ת — תומללה' }) });
    if (closed) return { handled: true, taskId: task.id, late: true };
    const who = t2.memberName ?? local(job.phone);
    const body = extra => [`👤 ${who}`, `📱 ${local(job.phone)}`, `🎙️ תמלול אוטומטי (לא אומת): "${text.slice(0, 500)}"`, ...extra, `מזהה פנייה: ${task.id}`, `💬 https://wa.me/${job.phone}`].join('\n');
    // the staff were already alerted (and the member already asked to write): the transcript is added for them, nothing else
    if (job.fallback || t2.alert) { await sendAlert(t2, `🎙️ תומר — התמלול הגיע: ${who}`, body(['התמלול צורף לפנייה שכבר נפתחה. לא נשלחה הודעה נוספת למתאמנ/ת.']), 'alertUpdate'); return { handled: true, taskId: task.id, late: true }; }
    if (!canAutoReply(job.phone)) { await sendAlert(t2, `🎙️ תומר: הודעה קולית — ${who}`, body(['השיחה בטיפול ידני: לא נשלחה תשובה אוטומטית.'])); return { handled: true, taskId: task.id, silent: true }; }
    // a class request spoken aloud: the same flow as a written one, except that it always ends in a written confirmation
    if (detect(text)) {
      const r = await handleClassRequest({ phone: job.phone, text, name: t2.memberName ?? null, fromVoice: true });
      if (r?.handled) {
        tomerStore.updateTask(task.id, { linkedTaskId: r.taskId });
        tomerStore.resolveTask(task.id, { resolutionNote: `תומללה וטופלה כבקשת שיעור (פנייה ${r.taskId})`, resolvedBy: 'tomer' });
        return { handled: true, taskId: task.id, classTaskId: r.taskId };
      }
    }
    const alert = await sendAlert(t2, `🎙️ תומר: הודעה קולית — ${who}`, body(['המתאמנ/ת קיבל/ה הודעה שהפנייה אצל הצוות.']));
    const replyText = `קיבלתי את ההודעה הקולית 🙏 ${alert.state === 'sent' ? 'העברתי אותה לצוות' : 'רשמתי אותה לטיפול הצוות'}, ויענו לך כאן.`;
    const sendState = await reply(job.phone, replyText, t2, null);
    logger.info('[member-handoff] voice transcript handed to the staff', { tail: tail(job.phone), taskId: task.id, alert: alert.state, sendState, chars: text.length });
    return { handled: true, taskId: task.id, alert, sendState };
  }

  /**
   * "The staff will get back to you" may be said ONLY after this: one durable task (an open one of the same type is
   * reused) and one manager alert whose send state is recorded on the task. -> { task, alert, sent, isNew }
   */
  async function recordFollowup({ phone, name = null, type = 'staff_followup', title, memberMessage = null }) {
    const who = name ?? local(phone);
    let task = openTask(phone, type), isNew = false;
    if (task) task = tomerStore.updateTask(task.id, { detail: `${task.detail}\n+ הודעה נוספת: "${String(memberMessage ?? '').slice(0, 200)}"`, received: (task.received ?? 1) + 1 });
    else {
      task = tomerStore.createTask({ type, phone, memberName: who, summary: `${title} — ${who}`, priority: 'normal', memberMessage,
        detail: [`בקשה: ${title}`, memberMessage ? `ההודעה: "${String(memberMessage).slice(0, 300)}"` : null, 'לא בוצע שום שינוי אוטומטי. הלקוח/ה קיבל/ה הודעה שהבקשה אצל הצוות.'].filter(Boolean).join('\n') });
      task = tomerStore.updateTask(task.id, { received: 1 });
      isNew = true;
    }
    const alert = isNew ? await sendAlert(task, `📌 ${title} — ${who}`, [`👤 ${who}`, `📱 ${local(phone)}`, ...String(task.detail).split('\n'), `מזהה פנייה: ${task.id}`, `💬 https://wa.me/${phone}`].join('\n')) : (task.alert ?? null);
    return { task, alert, sent: alert?.state === 'sent', isNew };
  }

  return { handleClassRequest, handleMedia, handleTranscript, voiceFallback, recordFollowup, retryFailedAlerts, sweepConfirmations, detect, hoursIn, BLOCK_REASON };
}

module.exports = { createMemberHandoff, detect, hoursIn, BLOCK_REASON, MAX_ALERT_ATTEMPTS };
