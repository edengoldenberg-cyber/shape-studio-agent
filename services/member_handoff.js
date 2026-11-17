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
 * It performs NO Arbox write. There is no verified write contract for class bookings (services/arbox_gateway.js
 * has guarded contracts for membership hold / cancel only, both unverified and switched off), so moving a member
 * between classes is not something this system is permitted to do. That is the reason given to the staff.
 * If a booking write is ever verified and enabled, the order must be: book the new class, verify it by reading
 * back, and only then release the old one — so a failed move can never leave the member without her original place.
 */

const { classify } = require('./member_intent');
const { extractDayAndTime, ilDateString, ilParts, HE_WEEKDAY_NAMES } = require('../utils/callback_time');

const BLOCK_REASON = 'אין לתומר הרשאה לשנות רישום לשיעור ב-Arbox (אין פעולת כתיבה מאומתת לרישום שיעורים; ARBOX_WRITES כבוי). השינוי נעשה על ידי הצוות.';
const MAX_ALERT_ATTEMPTS = 3;
const FOLLOWUP_MS = 60 * 60 * 1000;
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
  const { gateway, tomerStore, alertOwner, sendText, logger, now = () => new Date() } = deps;
  const tail = p => String(p).slice(-4);
  const local = p => String(p).startsWith('972') ? '0' + String(p).slice(3) : String(p);
  const openTask = (phone, type) => tomerStore.getTasks({ phone, type }).find(t => !['resolved', 'closed', 'done'].includes(t.status)) ?? null;

  async function sendAlert(task, subject, body) {
    const prev = task.alert ?? { attempts: 0 };
    let state = 'failed', idMessage = null, error = null;
    try {
      const ar = await alertOwner(subject, body, { linkPreview: false });
      const ok = (ar?.results ?? []).find(r => r.idMessage);
      if (ok) { state = 'sent'; idMessage = ok.idMessage; }
      else error = (ar?.results ?? []).map(r => r.error).filter(Boolean).join('; ') || 'no recipient accepted the alert';
    } catch (err) { error = err.message; }
    const alert = { state, attempts: (prev.attempts ?? 0) + 1, lastAt: now().toISOString(), idMessage: idMessage ?? prev.idMessage ?? null, error, subject, body };
    tomerStore.updateTask(task.id, { alert });
    if (state === 'failed') logger.warn('[member-handoff] manager alert NOT accepted — kept as failed for retry', { taskId: task.id, tail: tail(task.phone), error });
    return alert;
  }

  /** Alerts the provider never accepted are sent again, at most MAX_ALERT_ATTEMPTS times in total, for open tasks only. */
  async function retryFailedAlerts() {
    let retried = 0, sent = 0;
    for (const t of tomerStore.getOpenTasks()) {
      const a = t.alert;
      if (!a || a.state !== 'failed' || (a.attempts ?? 0) >= MAX_ALERT_ATTEMPTS || !a.subject) continue;
      const r = await sendAlert(t, a.subject, a.body);
      retried++; if (r.state === 'sent') sent++;
    }
    return { retried, sent };
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
  async function readFacts(phone, text, ref) {
    const dt = extractDayAndTime(text, ref);
    const p = ilParts(ref);
    const day = dt.day ?? { year: p.year, month: p.month, day: p.day };
    const date = ilDateString(day);
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
  async function handleClassRequest({ phone, text, name = null, sentAt = null, pending = null }) {
    const ref = sentAt instanceof Date && !isNaN(sentAt) ? sentAt : now();
    let kind = detect(text);
    let existing = openTask(phone, 'class_change');
    // the answer to "לאיזו שעה לעבור?" — an hour, within the hour after the question
    if (!kind && existing?.missing && now().getTime() - new Date(existing.updatedAt).getTime() <= FOLLOWUP_MS && hoursIn(text).length) kind = existing.kind;
    if (!kind) return null;
    if (existing && existing.kind !== kind && !existing.missing) existing = null;

    const fullText = existing?.missing ? `${existing.memberMessage} ${text}` : text;
    const f = await readFacts(phone, fullText, ref);
    const rq = resolveRequest(kind, fullText, f);
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

    // ── ONE durable task ────────────────────────────────────────────────────
    const detail = [`בקשה: ${want}`, ...facts, rq.missing ? `חסר: ${rq.missing === 'target_time' ? 'שעת היעד — המתאמנ/ת נשאל/ה' : 'איזה שיעור — המתאמנ/ת נשאל/ה'}` : null,
      `למה זה אצל הצוות: ${BLOCK_REASON}`, `קריאות Arbox (קריאה בלבד): ${f.calls.join(' · ')}`].filter(Boolean).join('\n');
    let task, isNew = false;
    const wasMissing = existing?.missing ?? null;            // read before the task object is updated in place
    if (existing) task = tomerStore.updateTask(existing.id, { summary: `${KIND_HE[kind]} — ${want}`, detail, memberMessage: fullText, missing: rq.missing, kind, arboxCalls: f.calls });
    else {
      task = tomerStore.createTask({ type: 'class_change', phone, memberName: who, arboxId: f.member?.userId ?? null, summary: `${KIND_HE[kind]} — ${want}`, detail, memberMessage: text, priority: 'normal' });
      task = tomerStore.updateTask(task.id, { kind, missing: rq.missing, arboxCalls: f.calls });
      isNew = true;
    }

    // ── the manager: once when the task is opened, once more when a missing detail arrived ──
    let alert = task.alert ?? null;
    if (isNew || (wasMissing && !rq.missing)) {
      alert = await sendAlert(task, `${isNew ? '📌 תומר' : '🔁 תומר — עדכון'}: ${KIND_HE[kind]} — ${who}`,
        [`👤 ${who}`, `📱 ${local(phone)}`, `💬 "${String(fullText).slice(0, 200)}"`, ...detail.split('\n').slice(0, -1), `לא בוצע שום שינוי ב-Arbox.`, `מזהה פנייה: ${task.id}`, `💬 https://wa.me/${phone}`].join('\n'));
    }

    // ── the member: only what is true ───────────────────────────────────────
    let replyText;
    if (rq.missing === 'target_time') replyText = `קיבלתי 🙏 ${lines.join(' ')} לאיזו שעה ${kind === 'move' ? 'לעבור' : 'לרשום אותך'}?`.replace(/\s+/g, ' ');
    else if (rq.missing === 'which_class') replyText = `קיבלתי 🙏 ${lines.join(' ')} איזה שיעור לבטל? (יום ושעה)`.replace(/\s+/g, ' ');
    else replyText = [`קיבלתי את הבקשה: ${want}.`, ...lines,
      alert?.state === 'sent' ? `אין לי הרשאה לשנות רישום בעצמי, אז העברתי את הבקשה לצוות.` : `אין לי הרשאה לשנות רישום בעצמי, אז רשמתי את הבקשה לטיפול הצוות.`,
      kind === 'move' ? `הרישום הקיים שלך לא השתנה: הוא נשאר במקומו עד שהצוות יאשר לך כאן את המעבר.` : kind === 'cancel' ? `הרישום שלך לא בוטל עד שהצוות יאשר לך כאן.` : `עדיין לא נרשמת: הצוות יאשר לך כאן.`].join('\n');
    const sendState = await reply(phone, replyText, task, pending);
    logger.info('[member-handoff] class request recorded for the staff', { tail: tail(phone), kind, taskId: task.id, isNew, missing: rq.missing, alert: alert?.state ?? null, sendState, arbox: f.calls });
    return { handled: true, kind, taskId: task.id, isNew, missing: rq.missing, alert, replyText, sendState, facts: f, request: rq };
  }

  /**
   * A voice message / file from a member on the legacy route. The system does not transcribe audio, so the request
   * cannot be understood: a documented task is opened, the manager is alerted, and the member is told the truth and
   * invited to write. A second file while the task is open is added to it — no second alert, no second reply.
   */
  async function handleMedia({ phone, type, name = null, caption = null, pending = null }) {
    const voice = /audio|voice|ptt/i.test(String(type));
    const tType = voice ? 'voice_message' : 'media_message';
    const label = voice ? 'הודעה קולית' : `קובץ (${type})`;
    const existing = openTask(phone, tType);
    if (existing) {
      tomerStore.updateTask(existing.id, { detail: `${existing.detail}\n+ ${label} נוספ/ת ב-${now().toISOString()}${caption ? ` — "${String(caption).slice(0, 120)}"` : ''}`, received: (existing.received ?? 1) + 1 });
      return { handled: true, taskId: existing.id, isNew: false, alert: existing.alert ?? null, replyText: null, sendState: 'not_sent_already_answered' };
    }
    const who = name ?? local(phone);
    let task = tomerStore.createTask({ type: tType, phone, memberName: who, summary: `${label} ממתאמנ/ת — לא טופלה אוטומטית`, priority: 'normal', memberMessage: caption ?? `[${label}]`,
      detail: [voice ? 'ההודעה הקולית לא תומללה: אין במערכת תמלול של הקלטות, ולכן תוכן הבקשה אינו ידוע.' : 'הקובץ לא נקרא אוטומטית, ולכן תוכן הבקשה אינו ידוע.',
        caption ? `כיתוב: "${String(caption).slice(0, 200)}"` : null, 'נדרש: להאזין / לפתוח בוואטסאפ ולענות.'].filter(Boolean).join('\n') });
    task = tomerStore.updateTask(task.id, { received: 1, transcription: voice ? { attempted: false, reason: 'not_available' } : null });
    const alert = await sendAlert(task, `🎙️ תומר: ${label} — ${who}`, [`👤 ${who}`, `📱 ${local(phone)}`, ...task.detail.split('\n'), `המתאמנ/ת קיבל/ה הודעה שהפנייה נרשמה והוזמנ/ה לכתוב.`, `מזהה פנייה: ${task.id}`, `💬 https://wa.me/${phone}`].join('\n'));
    const passed = alert.state === 'sent' ? 'רשמתי פנייה והעברתי אותה לצוות' : 'רשמתי פנייה לטיפול הצוות';
    const replyText = voice ? `קיבלתי את ההודעה הקולית 🙏 אני לא מאזין להקלטות, אז ${passed}.\nאם נוח לך, אפשר לכתוב לי כאן בקצרה במה מדובר, וכך אוכל לעזור מהר יותר.`
      : `קיבלתי את הקובץ 🙏 ${passed}.\nאם יש בקשה שקשורה אליו, אפשר לכתוב לי אותה כאן.`;
    const sendState = await reply(phone, replyText, task, pending);
    logger.info('[member-handoff] media recorded for the staff', { tail: tail(phone), type, taskId: task.id, alert: alert.state, sendState });
    return { handled: true, taskId: task.id, isNew: true, alert, replyText, sendState };
  }

  return { handleClassRequest, handleMedia, retryFailedAlerts, detect, hoursIn, BLOCK_REASON };
}

module.exports = { createMemberHandoff, detect, hoursIn, BLOCK_REASON, MAX_ALERT_ATTEMPTS };
