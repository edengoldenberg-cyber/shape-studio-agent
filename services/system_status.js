'use strict';

/**
 * system_status.js — one truthful status table for the whole system (Barak, Tomer, Dana, infrastructure).
 *
 * Every row is computed from the running configuration and the stored data at the moment of the request.
 * Nothing here is a constant "active": a capability that is switched off, restricted to a test phone, waiting
 * for the owner or failing says so, with what happens meanwhile and what is needed to open it.
 *
 * state:  live     works for real customers now
 *         limited  works with a stated restriction / an interim path (staff task instead of an automatic action)
 *         off      exists in the code, switched off
 *         blocked  cannot work until the owner supplies something (the row says what)
 *         fail     something is failing right now and needs attention
 *         unknown  the status itself could not be read (shown, never hidden)
 *
 * The module only READS. It never sends, never writes, never calls a write endpoint.
 */

const STATES = ['live', 'limited', 'off', 'blocked', 'fail', 'unknown'];
const HOUR = 3600e3;

const tail = p => (p ? `…${String(p).slice(-4)}` : '');
const ago = (ts, now) => {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return 'לא ידוע';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 2) return 'עכשיו';
  if (m < 90) return `לפני ${m} דקות`;
  if (m < 48 * 60) return `לפני ${Math.round(m / 60)} שעות`;
  return `לפני ${Math.round(m / 1440)} ימים`;
};
/** Number of entries in a knowledge object of unknown shape (array, or an object holding arrays). */
function countItems(o) {
  if (!o) return 0;
  if (Array.isArray(o)) return o.length;
  if (typeof o !== 'object') return 0;
  let n = 0;
  for (const v of Object.values(o)) if (Array.isArray(v)) n += v.length;
  return n;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); t.unref?.(); })]);

/**
 * @param {object} d  providers (all optional — a missing or throwing provider yields an 'unknown' row)
 * @returns {Promise<{generatedAt:string, rows:object[], counts:object, attention:number}>}
 */
async function build(d = {}) {
  const env = d.env ?? process.env;
  const now = d.now ? d.now() : Date.now();
  const rows = [];
  const add = (group, id, label, fn) => {
    try {
      const r = fn();
      if (r) rows.push({ group, id, label, state: r.state, detail: r.detail ?? '', action: r.action ?? null, ...(r.items ? { items: r.items } : {}) });
    } catch (err) {
      rows.push({ group, id, label, state: 'unknown', detail: `לא ניתן לקרוא את המצב (${String(err.message).slice(0, 80)})`, action: null });
    }
  };
  const addAsync = async (group, id, label, fn) => {
    try {
      const r = await fn();
      if (r) rows.push({ group, id, label, state: r.state, detail: r.detail ?? '', action: r.action ?? null });
    } catch (err) {
      rows.push({ group, id, label, state: 'unknown', detail: `לא ניתן לקרוא את המצב (${String(err.message).slice(0, 80)})`, action: null });
    }
  };

  const autoReply = env.WHATSAPP_AUTO_REPLY === 'true';
  const voice = (() => { try { return d.voiceIntake?.status() ?? null; } catch { return null; } })();
  const danaWorker = (() => { try { return d.danaStudio?.workerStatus() ?? null; } catch { return null; } })();

  // ── System ────────────────────────────────────────────────────────────────
  await addAsync('system', 'whatsapp', 'חיבור WhatsApp (Green API)', async () => {
    const g = d.greenState ? await d.greenState() : null;
    if (!g) return { state: 'unknown', detail: 'מצב החיבור לא נבדק' };
    if (g.state === 'authorized') return { state: 'live', detail: `מחובר · נבדק ${ago(g.at, now)}` };
    return { state: 'fail', detail: `מצב החיבור: ${g.state ?? 'אין תשובה'} · נבדק ${ago(g.at, now)}. הודעות אינן נשלחות ואינן מתקבלות.`,
             action: 'לפתוח את Green API ולחבר מחדש את הטלפון של הסטודיו (סריקת QR).' };
  });
  add('system', 'auto_reply', 'מענה אוטומטי', () => autoReply
    ? { state: 'live', detail: 'הסוכנים עונים להודעות נכנסות.' }
    : { state: 'off', detail: 'WHATSAPP_AUTO_REPLY אינו פעיל: שום סוכן אינו עונה.', action: 'להפעיל את WHATSAPP_AUTO_REPLY.' });
  await addAsync('system', 'arbox_read', 'קריאת נתונים מ-Arbox', async () => {
    if (!d.arboxGateway) return { state: 'unknown', detail: 'לא נבדק' };
    try {
      const r = await withTimeout(d.arboxGateway.getAllUsers(), d.arboxTimeoutMs ?? 6000);
      if (r.stale) return { state: 'limited', detail: `Arbox לא ענה; מוצג עותק מ${ago(r.fetchedAt, now)}. זיהוי מתאמנים נשען על העותק.` };
      return { state: 'live', detail: `נקרא ${ago(r.fetchedAt, now)} · ${r.users?.length ?? 0} רשומות` };
    } catch (err) {
      return { state: 'fail', detail: `Arbox אינו עונה (${String(err.message).slice(0, 60)}). מי שאינו מזוהה כמתאמן מוכר מועבר להמתנה ולצוות.`,
               action: 'אם זה נמשך: לבדוק את מפתח ה-API ב-Arbox.' };
    }
  });
  add('system', 'editing_pc', 'מחשב העריכה (עובד מקומי)', () => {
    if (!danaWorker) return { state: 'unknown', detail: 'לא נבדק' };
    const voiceSeen = voice?.availability?.lastSeenAt ? Date.parse(voice.availability.lastSeenAt) : 0;
    const seen = Math.max(danaWorker.lastSeen ? Date.parse(danaWorker.lastSeen) : 0, voiceSeen || 0);
    const online = danaWorker.online || voice?.availability?.state === 'online';
    if (online) return { state: 'live', detail: `מחובר · גרסת עריכה ${danaWorker.pipelineVersion ?? '?'} · ${danaWorker.state === 'busy' ? 'עסוק בעבודה' : 'פנוי'}` };
    return { state: 'fail', detail: `לא מחובר · נראה לאחרונה ${seen ? ago(seen, now) : 'אף פעם'}. עריכות של דנה ממתינות בתור; הודעות קוליות עוברות לצוות בלי תמלול.`,
             action: 'להדליק / להעיר את מחשב העריכה. העובד עולה לבד בכניסה ל-Windows; כשהמחשב ישן הוא אינו זמין.' };
  });
  add('system', 'quiet_hours', 'שעות שקט', () => ({ state: 'live',
    detail: `הודעות יזומות אינן נשלחות בין ${env.QUIET_HOUR_START ?? '22'}:00 ל-${String(env.QUIET_HOUR_END ?? '8').padStart(2, '0')}:00; שחרור בבוקר ב-${env.QUIET_HOUR_MORNING_RELEASE ?? '08:30'}.` }));
  add('system', 'owner_tasks', 'משימות שמחכות לאישור ביצוע שלך, ותזכורות אליך', () => {
    if (!d.ownerTasks?.list) return { state: 'unknown', detail: 'לא נקרא' };
    const l = d.ownerTasks.list(), r = l.reminders;
    const base = `${l.counts.open} משימות פתוחות (${l.counts.snoozed} נדחו, ${l.counts.inProgress} בטיפול). משימה נסגרת רק ב"בוצע" שלך או בסגירה מאומתת במערכת המקור.`;
    if (l.sourceError) return { state: 'fail', detail: `${base} חלק מהמקורות לא נקראו: ${l.sourceError}.`, action: 'לרענן; אם זה חוזר — לבדוק את הלוגים.' };
    if (r.state === 'needs_settings') return { state: 'blocked', detail: `${base} ${r.text}`, action: 'לקבוע שעות שליחה ותדירות בפאנל תומר → "תורים לעדן".' };
    if (r.state === 'failed') return { state: 'fail', detail: `${base} ${r.text}`, action: 'לבדוק את חיבור ה-WhatsApp.' };
    if (r.state === 'off') return { state: 'off', detail: `${base} ${r.text}`, action: 'להפעיל בפאנל תומר → "תורים לעדן".' };
    return { state: 'live', detail: `${base} ${r.text}` };
  });
  add('system', 'recent_failures', 'תקלות ב-24 השעות האחרונות', () => {
    const evs = d.store?.getEvents ? d.store.getEvents({ since: new Date(now - 24 * HOUR), limit: 500 }) : null;
    if (!evs) return { state: 'unknown', detail: 'יומן האירועים לא נקרא' };
    const bad = evs.filter(e => /fail|error/i.test(String(e.type)));
    if (!bad.length) return { state: 'live', detail: 'לא נרשמה תקלה.' };
    const by = {}; for (const e of bad) by[e.type] = (by[e.type] || 0) + 1;
    return { state: 'fail', detail: `${bad.length} אירועי תקלה: ${Object.entries(by).map(([k, n]) => `${k} ×${n}`).join(', ').slice(0, 200)}`,
             action: 'לפתוח את רשימת האירועים למטה ולבדוק את הפניות המסומנות.' };
  });

  // ── Barak (leads) ─────────────────────────────────────────────────────────
  add('barak', 'barak_reply', 'מענה ללידים', () => {
    if (!autoReply) return { state: 'off', detail: 'המענה האוטומטי כבוי.' };
    const leads = d.store?.getAllLeads ? d.store.getAllLeads() : [];
    const human = leads.filter(l => l.status === 'human_owns').length;
    return { state: 'live', detail: `ברק עונה ללידים חדשים. ${human} שיחות בטיפול ידני (ברק שותק בהן עד שחרור בפאנל).` };
  });
  add('barak', 'barak_records', 'רשומות לידים: סירובים, סיווג ובירור', () => {
    const leads = d.store?.getAllLeads ? d.store.getAllLeads() : null;
    if (!leads) return { state: 'unknown', detail: 'רשומות הלידים לא נקראו' };
    const declined = leads.filter(l => l.meta?.qualData?.registrationDeclined === true);
    const noCall = leads.filter(l => l.meta?.qualData?.doNotCall === true);
    const corrected = leads.filter(l => l.meta?.classificationCorrected);
    const review = leads.filter(l => l.meta?.classificationReview || l.meta?.refusalReview);
    const base = `${declined.length} סירובים מפורשים להרשמה (בלי הצעות ובלי מעקב אוטומטי) · ${noCall.length} בקשות לא להתקשר · ${corrected.length} רשומות שסיווגן תוקן לפי Arbox.`;
    if (review.length) {
      return { state: 'blocked', detail: `${base} ${review.length} רשומות ממתינות לבירור ואינן מקבלות מעקב יזום: ${review.map(l => `${tail(l.phone)} (${l.meta.classificationReview?.reason ?? l.meta.refusalReview?.reason})`).join('; ').slice(0, 400)}`,
               action: 'לבדוק ב-Arbox את הרשומות האלה: כשנשארת שורה אחת עם מנוי בתוקף (או שהשורה הכפולה מוסרת) הסימון יורד לבד.' };
    }
    return { state: 'live', detail: base };
  });
  add('barak', 'barak_prices', 'מחירים', () => {
    const pkg = d.pricing.load();
    const priced = d.pricing.pricedPackages(pkg).length, total = pkg.packages.length, trial = d.pricing.trialOf(pkg);
    if (pkg._source === 'owner_saved' && priced > 0) {
      return { state: priced === total ? 'live' : 'limited',
               detail: `${priced} מתוך ${total} חבילות עם מחיר מאושר${trial ? ` · הצעת היכרות ${trial.price_ils} ₪` : ' · אין הצעת היכרות מאושרת'}. על חבילה בלי מחיר ברק עונה שאין לו מחיר מעודכן ומציע נציג.` };
    }
    return { state: 'blocked',
             detail: `לא נשמרו מחירי מנויים${trial ? ` (ידועה רק הצעת ההיכרות: ${trial.price_ils} ₪)` : ''}. על שאלת מחיר מנוי ברק עונה "אין לי מחיר מעודכן" ומציע שיחה עם נציג — הוא אינו ממציא מחיר.`,
             action: 'להזין מחירי מנויים בלשונית "ידע סוכן" ולשמור.' };
  });
  add('barak', 'barak_knowledge', 'ידע על מדריכים וסוגי שיעורים (ברק ותומר)', () => {
    if (d.studioKnowledge?.summary) {
      const sm = d.studioKnowledge.summary();
      const rows = sm.rows.filter(r => r.id === 'staff' || r.id === 'classes' || r.id === 'staff_missing' || r.id === 'arbox');
      const worst = rows.some(r => r.state === 'empty') ? 'blocked' : rows.some(r => r.state === 'partial' || r.state === 'unknown') ? 'limited' : 'live';
      return { state: worst, detail: rows.map(r => `${r.label}: ${r.text}`).join(' '), action: rows.map(r => r.action).filter(Boolean)[0] ?? null };
    }
    const k = d.barakAgent.getRawKnowledge();
    const staff = countItems(k.staff), classes = countItems(k.classes);
    if (staff && classes) return { state: 'live', detail: `${staff} אנשי צוות · ${classes} שיעורים שמורים.` };
    return { state: 'blocked', detail: `${staff ? `${staff} אנשי צוות` : 'רשימת המדריכים ריקה'} · ${classes ? `${classes} שיעורים` : 'תיאורי השיעורים ריקים'}. ברק עונה בלי המידע הזה ומפנה לנציג כשנשאל.`,
             action: 'למלא ולשמור מדריכים ושיעורים בלשונית "ידע סוכן".' };
  });
  add('barak', 'barak_callback', 'תיאום שיחה, סיכום ללקוח והתראה למנהל', () => {
    const mgr = String(env.NOTIFY_PHONES ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!mgr.length) return { state: 'fail', detail: 'לא הוגדר מספר מנהל להתראות (NOTIFY_PHONES).', action: 'להגדיר NOTIFY_PHONES.' };
    const pend = d.aptStore?.getCallbackPending ? d.aptStore.getCallbackPending() : [];
    const late = pend.filter(a => a.scheduledAt && new Date(a.scheduledAt).getTime() < now);
    const base = `בקשת חזרה נשמרת עם שעה מפורשת או עם טווח שעות ("מחר בין 14:00 ל-16:00") או כאילוץ זמינות ("אחרי 16:00", "עד 12:00") — שעה אינה מומצאת, ושעות פעילות אינן מובטחות ללקוח; הלקוח מקבל סיכום אחד והמנהל (${mgr.map(tail).join(', ')}) התראה אחת.`;
    if (late.length) return { state: 'limited', detail: `${base} ${late.length} בקשות חזרה שמועדן עבר ועדיין פתוחות.`, action: 'לסגור בפאנל ברק (בוצעה / אין מענה / בוטלה).' };
    return { state: 'live', detail: `${base} ${pend.length} בקשות ממתינות.` };
  });
  add('barak', 'barak_reminders', 'תזכורת לפני שיחה (ללקוח ולמנהל)', () => {
    const w = d.appointmentWorker.workerStatus();
    const list = w.leadAllowlist ?? (Array.isArray(w.allowlist) ? w.allowlist : null);
    const on = w.pendingAndProspectRemindersEnabled ?? /^enabled/.test(String(w.callbackPendingReminder));
    if (!on) return { state: 'off', detail: 'תזכורות לפני שיחה כבויות (CALLBACK_PENDING_REMINDER_ENABLED).', action: 'החלטה שלך אם להפעיל.' };
    if (list && list.length) {
      return { state: 'limited', detail: `${w.newRequestsSince ? 'מוכן לפתיחה לבקשות חדשות בלבד; כרגע ' : ''}מוגבל למספר בדיקה בלבד (${list.map(tail).join(', ')}): ליד אמיתי שקבע שיחה אינו מקבל תזכורת, וגם המנהל לא. הסיכום בזמן הקביעה כן נשלח.`,
               action: 'לאשר הסרה של הגבלת הבדיקה (CALLBACK_PENDING_REMINDER_PHONES) כדי שתזכורות יישלחו לכל הלידים.' };
    }
    if (w.newRequestsSince === 'unreadable') return { state: 'fail', detail: 'CALLBACK_REMINDER_SINCE אינו תאריך קריא: שום תזכורת אינה נשלחת.', action: 'לתקן את הערך.' };
    const since = w.newRequestsSince ? ` רק לבקשות שנוצרו או שמועדן שונה מאז ${new Date(w.newRequestsSince).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}; בקשות ישנות יותר אינן מקבלות תזכורת.` : '';
    return { state: 'live', detail: `תזכורת נשלחת לכל ליד שקבע שיחה ולמנהל, ${w.reminderMinutes ?? 30} דקות לפני מועד השיחה (בטווח שעות — לפני תחילת הטווח).${since} בשיחה שבטיפול ידני הלקוח מקבל תזכורת רק אם אישרת אותה בפאנל; המנהל מקבל תמיד.` };
  });

  // ── Tomer (members) ───────────────────────────────────────────────────────
  add('tomer', 'tomer_route', 'המסלול שמקבלים מתאמנים', () => {
    const t = d.tomerTest.status();
    const sw = env.TOMER_SERVICE_ENABLED !== 'false';
    if (!sw) return { state: 'fail', detail: 'שירות תומר החדש כבוי (מתג חירום): מתאמנים מקבלים את המסלול הישן.', action: 'למחוק את TOMER_SERVICE_ENABLED=false.' };
    if (t.mode === 'all') {
      const leftover = env.TOMER_TEST_ROUTE_OVERRIDE === 'true';
      return { state: 'live', detail: `כל המתאמנים הפעילים (לפי Arbox) מקבלים את שירות תומר החדש.${leftover ? ' נשארה הגדרת עקיפת ניתוב של בדיקה (אינה פעילה במצב הזה).' : ''}` };
    }
    return { state: 'limited', detail: `מצב בדיקה: רק ${t.allowlist?.length ?? 0} מספרי בדיקה מקבלים את השירות החדש; מתאמנים אמיתיים מקבלים את המסלול הישן.`,
             action: 'החלטה שלך: TOMER_MODE=all.' };
  });
  add('tomer', 'tomer_duplicates', 'טלפונים עם יותר משורה אחת ב-Arbox (זהות לבירור)', () => {
    const list = d.identity?.severalRows ? d.identity.severalRows() : null;
    if (!list) return { state: 'unknown', detail: 'ספריית הזהויות לא נקראה' };
    if (!list.length) return { state: 'live', detail: 'אין טלפון עם יותר משורה פעילה אחת ב-Arbox.' };
    const ROLE = { client: 'לקוח', lead: 'ליד', aggregatorMember: 'חבר מועדון', staffMember: 'צוות' };
    const CAT = { member: 'מנוי בתוקף', aggregator: 'חבר מועדון', former_member: 'מנוי לשעבר', lead: 'בלי מנוי', staff: 'צוות', unverified: 'מנוי לא אומת' };
    return { state: 'blocked',
      detail: `${list.length} טלפונים רשומים ב-Arbox על יותר משורה פעילה אחת. מי שכותב ממספר כזה מקבל מידע כללי בלבד: פרטי מנוי אינם מוצגים, ובקשה לרישום, ביטול, מעבר או הקפאה עוברת לצוות לבירור — איש אינו נבחר אוטומטית.`,
      action: 'להכריע ב-Arbox לכל טלפון: אם זו אותה לקוחה שנרשמה פעמיים — לאחד או להפוך את השורה המיותרת ללא פעילה; אם אלה שני אנשים — לעדכן לאחד מהם טלפון אחר. המערכת אינה מוחקת ואינה מאחדת.',
      items: list.map(x => ({ phoneTail: tail(x.phone), rows: x.rows.map(r => ({ name: r.name ?? '(ללא שם)', userId: String(r.userId), role: ROLE[r.role] ?? r.role, status: CAT[r.category] ?? r.category ?? '' })) })) };
  });
  add('tomer', 'tomer_manager', 'התראות שירות למנהל', () => {
    const p = env.TOMER_MANAGER_PHONE;
    const open = d.serviceCases?.list ? d.serviceCases.list({ open: true, limit: 500 }) : [];
    const failed = open.filter(c => ['failed', 'uncertain'].includes(c.notification?.state));
    if (!p) return { state: 'fail', detail: 'לא הוגדר מספר מנהל לתומר.', action: 'להגדיר TOMER_MANAGER_PHONE.' };
    if (failed.length) return { state: 'fail', detail: `${failed.length} פניות פתוחות שההתראה עליהן לא אושרה כנשלחה.`, action: 'לפתוח את הפניות בפאנל תומר וללחוץ "שליחה חוזרת".' };
    return { state: 'live', detail: `התראה אחת לכל פנייה אל ${tail(p)}. ${open.length} פניות פתוחות.` };
  });
  add('tomer', 'tomer_tasks', 'משימות צוות פתוחות', () => {
    const open = d.tomerStore?.getOpenTasks ? d.tomerStore.getOpenTasks() : [];
    const old = open.filter(t => now - new Date(t.createdAt).getTime() > 48 * HOUR);
    if (!open.length) return { state: 'live', detail: 'אין משימה פתוחה.' };
    if (old.length) return { state: 'limited', detail: `${open.length} משימות פתוחות, ${old.length} מהן מעל יומיים. מתאמנת שביקשה מחכה לטיפול ידני.`, action: 'לטפל ב-Arbox ולסגור את המשימה בפאנל תומר.' };
    return { state: 'live', detail: `${open.length} משימות פתוחות, כולן מהיומיים האחרונים.` };
  });
  add('tomer', 'tomer_class_writes', 'רישום / ביטול / מעבר שיעור ב-Arbox', () => {
    const ws = d.arboxGateway.writeStatus();
    const ops = Array.isArray(ws) ? ws : Object.entries(ws).map(([op, v]) => ({ op, ...v }));
    const sw = env.ARBOX_WRITES_ENABLED === 'true';
    const verified = ops.filter(o => o.contractVerified).map(o => o.op);
    const interim = 'פתרון ביניים: תומר בודק את הנתונים ב-Arbox, פותח משימה אחת לצוות ושולח למנהל התראה אחת; למתאמנת נאמר שהבקשה הועברה לצוות — לא שבוצעה.';
    if (sw && verified.length) {
      const aud = env.ARBOX_WRITE_AUDIENCE === 'all' ? 'כל המתאמנים' : 'מספרי בדיקה בלבד';
      return { state: env.ARBOX_WRITE_AUDIENCE === 'all' ? 'live' : 'limited', detail: `כתיבה פעילה לפעולות: ${verified.join(', ')} · קהל: ${aud}. כל פעולה דורשת "כן" בכתב מהמתאמנת.` };
    }
    return { state: 'blocked', detail: `כתיבה ל-Arbox כבויה: אף פעולה לא אומתה מול Arbox על פרופיל בדיקה. ${interim}`,
             action: 'ליצור ב-Arbox לקוח בדיקה (טלפון מספר הבדיקה, מנוי פעיל) ולאשר שני שיעורים לבדיקה.' };
  });
  add('tomer', 'tomer_freeze', 'הקפאה / ביטול מנוי', () => ({ state: 'limited',
    detail: 'בטיפול הצוות בלבד (החלטת בעלים): נפתחת פנייה, המנהל מקבל התראה אחת, ולמתאמנת נאמר שהבקשה נרשמה. אין שינוי אוטומטי ב-Arbox.' }));
  add('tomer', 'tomer_proactive', 'ליווי יזום (ברוכה הבאה, היעדרות, יום הולדת…)', () => {
    const o = d.memberCare?.overview ? d.memberCare.overview() : null;
    if (!o) return { state: 'unknown', detail: 'לא נקרא' };
    const on = (o.programs ?? []).filter(p => p.enabled);
    if (o.proactiveOn && on.length) return { state: 'live', detail: `${on.length} תוכניות פעילות: ${on.map(p => p.label).join(', ')}.` };
    const why = [];
    if (!o.proactiveOn) why.push('המתג הכללי כבוי');
    if (!o.policyApproval?.approved) why.push('מדיניות הפנייה לא אושרה');
    if (!on.length) why.push('אף תוכנית לא הופעלה');
    return { state: 'off', detail: `כבוי: ${why.join(' · ')}. שום הודעה יזומה אינה נשלחת למתאמנים.`, action: 'החלטה שלך: אישור המדיניות בלשונית "ליווי חברים", ואז הפעלת תוכניות.' };
  });

  // ── Voice (both agents) ───────────────────────────────────────────────────
  add('system', 'voice', 'תמלול הודעות קוליות (לידים ומתאמנים)', () => {
    if (!voice) return { state: 'unknown', detail: 'לא נקרא' };
    const av = voice.availability?.state;
    const interim = 'הודעה קולית שלא תומללה עוברת לצוות עם התראה, והשולח מקבל תשובה שהצוות יחזור אליו.';
    if (av === 'off') return { state: 'off', detail: `תמלול כבוי. ${interim}` };
    const extra = `${voice.waiting ? ` · ${voice.waiting} ממתינות` : ''}${voice.failed ? ` · ${voice.failed} נכשלו` : ''}`;
    if (av === 'offline') return { state: 'fail', detail: `מחשב העריכה לא מחובר, לכן אין תמלול כרגע${extra}. ${interim}`, action: 'להדליק / להעיר את מחשב העריכה.' };
    return { state: 'live', detail: `תמלול מקומי במחשב העריכה${av === 'busy' ? ' (עסוק בעריכה — ייתכן עיכוב)' : ''}${extra}. ההקלטה נמחקת אחרי התמלול ולכל היותר אחרי 24 שעות. ${interim}` };
  });

  // ── Dana (content) ────────────────────────────────────────────────────────
  add('dana', 'dana_editing', 'העלאה ועריכה', () => {
    if (!danaWorker) return { state: 'unknown', detail: 'לא נקרא' };
    const s = d.danaStudio.summary ? d.danaStudio.summary() : null;
    const q = `${danaWorker.queued} בתור · ${danaWorker.running} בעבודה${s ? ` · ${s.awaitingReview} מחכים לבדיקה שלך` : ''}`;
    if (!danaWorker.online) return { state: 'fail', detail: `אפשר להעלות, אבל העריכה לא תתחיל: מחשב העריכה לא מחובר. ${q}.`, action: 'להדליק / להעיר את מחשב העריכה.' };
    return { state: 'live', detail: `העלאה, עריכה, ביקורת ודירוג פועלים דרך מחשב העריכה. ${q}.`, action: s?.awaitingReview ? 'לצפות ולאשר / לבקש תיקון בסטודיו של דנה.' : null };
  });
  add('dana', 'dana_references', 'רפרנסים', () => {
    const n = d.danaReferences?.count ? d.danaReferences.count() : null;
    if (n === null) return { state: 'unknown', detail: 'לא נקרא' };
    if (n > 0) return { state: 'live', detail: `${n} רפרנסים שמורים.` };
    return { state: 'blocked', detail: 'לא הועלה אף רפרנס: דנה עורכת ומדרגת לפי הכללים הקבועים בלבד, בלי השוואה לסגנון שבחרת.', action: 'להעלות רפרנסים בסטודיו של דנה.' };
  });
  add('dana', 'dana_publish', 'פרסום לאינסטגרם', () => {
    const on = env.DANA_PUBLISHING_ENABLED === 'true';
    if (on && env.DANA_PUBLISHER_MODE === 'instagram') return { state: 'live', detail: 'פרסום אמיתי פעיל — רק אחרי אישור שלך לכל פריט.' };
    if (on) return { state: 'limited', detail: `פרסום במצב ${env.DANA_PUBLISHER_MODE || 'לא מוגדר'}: שום דבר אינו עולה לאינסטגרם.` };
    return { state: 'off', detail: 'פרסום כבוי בהוראתך. סרטון מאושר נשאר להורדה בסטודיו ואינו עולה לאינסטגרם.', action: 'החלטה שלך אם ומתי להפעיל.' };
  });
  add('dana', 'dana_notify', 'התראות של דנה ב-WhatsApp', () => {
    const s = d.danaNotify.status();
    if (s.mode === 'real') return { state: 'live', detail: `התראה נשלחת אל ${tail(s.recipientTail)} כשגרסה מוכנה לבדיקה.` };
    return { state: 'off', detail: `כבוי בהוראתך: ההתראות נרשמות בלבד ואינן נשלחות${s.pending ? ` (${s.pending} גרסאות מחכות לבדיקה)` : ''}. צריך להיכנס לסטודיו כדי לראות מה מוכן.`, action: 'החלטה שלך אם להפעיל.' };
  });

  const counts = Object.fromEntries(STATES.map(s => [s, rows.filter(r => r.state === s).length]));
  return { generatedAt: new Date(now).toISOString(), rows, counts, attention: counts.fail + counts.unknown };
}

module.exports = { build, STATES, countItems };
