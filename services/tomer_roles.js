'use strict';

/**
 * tomer_roles.js — what Tomer does today, role by role, computed from the running system (not written by hand):
 * what is implemented, for whom it is switched on, what was verified live, what is blocked and what is missing.
 * Plus two read-only views that feed the work board:
 *   proposals()  who each retention program WOULD address right now. A proposal is not a task and sends nothing:
 *                a program that is off or blocked is shown as such, with the reason.
 *   external()   members of the studio who come through an outside club / provider: listed separately, with what
 *                is available for them and what waits for the owner's decision. They are never dropped silently.
 *
 * A screen that shows a group, or an isolated test, is not proof of a whole route. `live` therefore states only what
 * was seen working in production, with its date; everything else says "לא אומת חי".
 */

const STATE_HE = { active: 'פעיל', partial: 'פעיל חלקית', ready_off: 'מוכן אך כבוי', blocked: 'חסום', missing: 'חסר' };

function createTomerRoles(d) {
  const { gateway, memberCare, ownerTasks, identity, logger = console } = d;
  const now = d.now ?? (() => new Date());
  const digits = s => String(s ?? '').replace(/\D/g, '');
  const testPhones = () => String(process.env.ARBOX_WRITE_TEST_PHONES ?? '').split(',').map(digits).filter(Boolean);
  const mask = p => (p ? `•••${String(p).slice(-3)}` : '');

  function facts() {
    let ws = {}; try { ws = gateway.writeStatus(); } catch { /* shown as off */ }
    let ov = null; try { ov = memberCare.overview(); } catch (err) { logger.warn('[roles] care overview failed', { error: err.message }); }
    const prog = id => ov?.programs?.find(p => p.id === id) ?? null;
    const on = id => !!prog(id)?.enabled;
    const blocks = id => (prog(id)?.blocks ?? []).map(b => b.text ?? String(b));
    let rem = null; try { rem = ownerTasks.status(); } catch { /* shown below */ }
    return { ws, ov, prog, on, blocks, rem, all: process.env.ARBOX_WRITE_AUDIENCE === 'all', testN: testPhones().length, proactive: !!ov?.proactiveOn, policyOk: !!ov?.policyApproval?.approved };
  }

  /** The retention program behind a role: its state and why. */
  function careState(f, ids) {
    const rows = ids.map(id => ({ id, label: f.prog(id)?.label ?? id, on: f.on(id), blocks: f.blocks(id) }));
    const anyOn = rows.some(r => r.on) && f.proactive;
    const why = [...new Set([...(f.proactive ? [] : ['מתג ההודעות היזומות של תומר כבוי']), ...rows.flatMap(r => r.blocks)])];
    return { rows, anyOn, why };
  }

  function roles() {
    const f = facts(), ex = k => f.ws[k]?.executable === true;
    const audience = f.all ? 'כל המנויים' : f.testN ? `מספר הבדיקה בלבד (${f.testN})` : 'אף אחד';
    const care = ids => careState(f, ids);
    const careRow = (id, label, ids, implemented, missing) => {
      const c = care(ids);
      return { id, label, state: c.anyOn ? 'active' : c.why.length && !c.why.every(w => /מתג/.test(w)) ? 'blocked' : 'ready_off', implemented,
        activeFor: c.anyOn ? `פעיל: ${c.rows.filter(r => r.on).map(r => r.label).join(', ')}` : 'כבוי — לא נשלחת שום הודעה יזומה', live: 'לא אומת חי (לא נשלחה הודעה יזומה ללקוח)',
        blocked: c.why.join(' · ') || null, missing };
    };
    const rows = [
      { id: 'class_book_cancel', label: 'רישום וביטול שיעור', state: ex('class_book') && ex('class_cancel') ? (f.all ? 'active' : 'partial') : 'ready_off',
        implemented: 'זיהוי הבקשה, קריאת השיעור / המנוי / הרישומים מ-Arbox, שאלה רק על פרט חסר, אישור בכתב, ביצוע ואימות בקריאה חוזרת. כשהביצוע אינו מורשה — משימה אחת לצוות.',
        activeFor: ex('class_book') ? `ביצוע ב-Arbox: ${audience}. כל שאר המנויים: הבקשה מועברת לצוות ונאמר "עדיין לא נרשמת".` : 'כל המנויים: העברה לצוות בלבד.',
        live: 'רישום אמיתי דרך WhatsApp אומת (18.11.2026). רישום, מעבר וביטול אומתו בבקשות API ישירות (18.11.2026). ביטול דרך WhatsApp — לא אומת חי.',
        blocked: f.all ? null : 'פתיחה לכלל המנויים דורשת החלטה שלך.', missing: null },
      { id: 'class_move', label: 'מעבר בין שיעורים', state: ex('class_book') && ex('class_cancel') ? 'partial' : 'ready_off',
        implemented: 'רישום לשיעור החדש, אימות, ורק אז ביטול הישן — הלקוח/ה לעולם לא נשאר/ת בלי מקום.',
        activeFor: ex('class_book') ? `מעבר מחוץ לחלון הביטול: ${audience}. מעבר בתוך חלון הביטול: כבוי לכולם.` : 'כל המנויים: העברה לצוות בלבד.',
        live: 'מעבר אומת בבקשות API ישירות (18.11.2026). דרך WhatsApp — לא אומת חי.',
        blocked: ex('class_move_late') ? null : 'מעבר בתוך חלון הביטול מאושר עסקית אך לא נבדק מול Arbox, ולכן כבוי.', missing: 'מעבר בין ימים שונים ("רשומה להיום, רוצה לעבור למחר") מזהה את הרישום הקיים רק באותו יום — מגיע לצוות.' },
      { id: 'freeze', label: 'הקפאת מנוי', state: 'partial',
        implemented: 'זיהוי הבקשה, בירור תאריכים, פתיחת פנייה אחת לצוות עם הפרטים, התראה אליך, ומעקב עד סגירה. תומר אינו מקפיא בעצמו.',
        activeFor: 'כל המנויים: פנייה לצוות.', live: 'בקשות הקפאה אמיתיות נרשמו כמשימות פתוחות (12.11 ו-16.11.2026).',
        blocked: ex('membership_hold') ? null : 'ביצוע ההקפאה ב-Arbox לא אומת ולא אושר — כבוי.', missing: 'מדיניות הקפאה (מי זכאי/ת, משך מינימלי ומקסימלי, עלות) — החלטה שלך.' },
      { id: 'membership_cancel', label: 'ביטול מנוי', state: 'partial',
        implemented: 'זיהוי הבקשה (נפרד מביטול שיעור), פתיחת פנייה לצוות והתראה אליך. תומר אינו מבטל מנוי ואינו מנסה לשכנע.',
        activeFor: 'כל המנויים: פנייה לצוות.', live: 'לא אומת חי.', blocked: ex('membership_cancel') ? null : 'ביצוע ביטול ב-Arbox לא אומת ולא אושר — כבוי.', missing: 'מדיניות ביטול ושיחת שימור לפני ביטול — החלטה שלך.' },
      careRow('absence', 'נעדרים וירידה בתדירות', ['absence7', 'absence14', 'tuesday'],
        'זיהוי מנתוני הנוכחות של Arbox (לוח החברים: נעדרים, ירידה בהגעה). שלוש תוכניות פנייה מוכנות: יום שלישי בלי אימון השבוע, 7 ימים, 14 ימים — עם בדיקה חוזרת מול Arbox לפני כל שליחה וביטול כשהלקוח/ה חזר/ה.',
        'ספי ההיעדרות, נוסחי ההודעות ואישור מדיניות הקשר — החלטה שלך. "ירידה בתדירות" מזוהה בלוח בלבד; אין לה תוכנית פנייה.'),
      careRow('first_month', 'ליווי בחודש הראשון', ['welcome', 'onboarding14', 'month1'],
        'זיהוי מנויים חדשים מ-Arbox (לוח החברים: חודש ראשון, חדש שלא הגיע). שלוש תוכניות מוכנות: ברוכים הבאים, בדיקה אחרי שבועיים, סיכום חודש ראשון.',
        'נוסחים, קישור לקבוצת הוואטסאפ, ותנאי אימוני האורח בסוף החודש הראשון — החלטה שלך.'),
      careRow('renewal', 'מנויים לקראת סיום וחידוש', ['expiry5'],
        'זיהוי מנוי לא-מתחדש לפני סיומו (לוח החברים: עומד להסתיים, הסתיים לאחרונה). תוכנית פנייה אחת מוכנה (5 ימים לפני הסיום), עם ביטול אוטומטי אם המנוי חודש.',
        'כמה ימים לפני הסיום לפנות, נוסח, ומה קורה אחרי שהמנוי הסתיים בלי חידוש (אין מעקב חידוש אחרי הסיום) — החלטה שלך.'),
      careRow('birthday', 'ימי הולדת והודעות עידוד', ['birthday'],
        'תוכנית יום הולדת מוכנה (לפי תאריך הלידה ב-Arbox, עם סינון תאריכים לא סבירים).',
        'נוסח הברכה. "הודעות עידוד" שאינן קשורות להיעדרות או ליום הולדת — לא הוגדרו ואינן ממומשות.'),
      { id: 'service', label: 'שאלות שירות', state: 'active',
        implemented: 'כתובת והגעה, לוח שיעורים, מי מעביר/ה שיעור, מקום פנוי בשיעור מסוים (קריאה טרייה), הרישומים שלי, פרטי המנוי שלי — מ-Arbox וממידע עסקי מאושר. שאלה שאין לה מקור מאושר נפתחת כפנייה לצוות.',
        activeFor: 'כל המנויים שזוהו ב-Arbox (כולל חברי מועדון חיצוני).', live: 'שיחות אמיתיות עם לקוח הבדיקה (18.11.2026): הצעת שיעורים לפי שעה, רישום. שאלת מדריך ושאלת זמינות בתוך בקשה — תוקנו ולא אומתו חי מאז.',
        blocked: null, missing: 'מחירי מנויים, מדיניות ביטול/הקפאה ושעות חזרה טלפונית — אין מקור מאושר, ולכן תומר אינו עונה עליהם.' },
      { id: 'handoff', label: 'העברה אליך ומעקב עד סגירה', state: f.rem?.state === 'on' ? 'active' : 'partial',
        implemented: 'כל פנייה, משימה ושיחה חוזרת מופיעות בלוח אחד עם סטטוס, אחראי, מועד, מה בוצע ותנאי סגירה. נסגרות רק באישור שלך או בתוצאה מאומתת. תזכורת מרוכזת אחת אליך.',
        activeFor: 'הלוח והתראות על בקשה בשלה / בירור שנתקע / כשל: פעילים. תזכורות חוזרות אליך: ' + (f.rem?.state === 'on' ? 'פעילות.' : 'כבויות.'),
        live: 'התראות אליך התקבלו אצל ספק השליחה (18.11.2026). תזכורת מרוכזת — לא נשלחה מעולם.', blocked: f.rem?.state === 'on' ? null : f.rem?.text ?? 'לא הוגדרו שעות ותדירות.', missing: 'שעות ותדירות לתזכורות — החלטה שלך.' },
      { id: 'external', label: 'חברי מועדון חיצוני', state: 'partial',
        implemented: 'מזוהים ב-Arbox כחברי מועדון ומנותבים לתומר; מקבלים אותן תשובות שירות. מוצגים בפאנל ברשימה נפרדת.',
        activeFor: 'שירות בשיחה: פעיל. קבוצות המעקב (נעדרים, חודש ראשון, סיום מנוי) ותוכניות השימור: אינם כלולים.', live: 'לא אומת חי.',
        blocked: null, missing: 'האם לכלול אותם במעקב ההגעה ובתוכניות השימור, ואילו פעולות (רישום / ביטול) מותרות להם — החלטה שלך.' },
    ];
    return { ok: true, generatedAt: now().toISOString(), states: STATE_HE, rows: rows.map(r => ({ ...r, stateLabel: STATE_HE[r.state] })),
      switches: { proactive: f.proactive, policyApproved: f.policyOk, classWrites: ex('class_book') && ex('class_cancel'), writeAudience: audience, lateMove: ex('class_move_late'), freeze: ex('membership_hold'), membershipCancel: ex('membership_cancel'), ownerReminders: f.rem?.state ?? null } };
  }

  /** Who each retention program would address now. Read-only: nothing is created and nothing is sent. */
  async function proposals() {
    const f = facts(), out = [];
    for (const id of memberCare.PRIORITY) {
      try {
        const p = await memberCare.preview(id);
        if (!p.ok) { out.push({ id, label: memberCare.PROGRAMS[id].label, state: 'not_loaded', error: p.error ?? 'לא נטען' }); continue; }
        const dataBlocked = p.dataBlocked ? (Array.isArray(p.dataBlocked) ? p.dataBlocked.join(', ') : String(p.dataBlocked)) : null;
        const blocks = [...(f.proactive ? [] : ['מתג ההודעות היזומות של תומר כבוי']), ...(p.blocks ?? []).map(b => b.text ?? String(b)), ...(dataBlocked ? [`נתון חסר מ-Arbox: ${dataBlocked}`] : [])];
        const willSend = p.enabled && f.proactive && !blocks.length;
        out.push({ id, label: p.label, state: dataBlocked ? 'not_loaded' : willSend ? 'approved_active' : p.enabled ? 'approved_blocked' : 'proposal',
          stateLabel: dataBlocked ? 'לא נטען' : willSend ? 'מאושרת ופעילה' : p.enabled ? 'מאושרת אך חסומה' : 'הצעה לבדיקה — כבויה, שום הודעה לא תישלח',
          blocks, candidates: p.included.length, totalActive: p.totalMembers, today: p.today, baseline: p.baseline ?? null,
          rule: `${p.label}: מי שעומד/ת היום בתנאי התוכנית לפי נתוני Arbox, אחרי סינון מדיניות הקשר.`, source: 'Arbox — מנויים, נוכחות, רישומים',
          sample: p.included.slice(0, 8).map(x => ({ userId: x.userId, name: x.name, phone: mask(x.phone), decision: x.decision, why: (x.reasons ?? []).map(r => r.text).join(', ') || null })),
          excluded: (p.excludedCounts ?? []).slice(0, 5) });
      } catch (err) { out.push({ id, label: memberCare.PROGRAMS[id]?.label ?? id, state: 'not_loaded', stateLabel: 'לא נטען', error: String(err.message).slice(0, 160) }); }
    }
    return { ok: true, generatedAt: now().toISOString(), proactiveOn: f.proactive, policyApproved: f.policyOk, programs: out,
      note: 'אלה מועמדים בלבד. שום הודעה אינה מתוזמנת ואינה נשלחת עד שתאשר את מדיניות הקשר, את התוכנית ואת הנוסח. הפעלת תוכנית אינה שולחת צבר היסטורי: היא פועלת רק על אירועים מרגע ההפעלה.' };
  }

  /** Members who come through an outside club / provider (Arbox role "aggregatorMember"). */
  function external() {
    try {
      const list = identity.phonesIn(['aggregator']);
      const at = (() => { try { const s = identity.summary(); return s?.at ? new Date(s.at).toISOString() : null; } catch { return null; } })();
      return { ok: true, count: list.length, fetchedAt: at, source: 'Arbox — רשימת הלקוחות (שורות מסוג חבר מועדון) ורשימת המנויים',
        rule: 'שורת לקוח ב-Arbox מסוג "חבר מועדון" (דרך גורם חיצוני) עם מנוי בתוקף.',
        members: list.map(x => ({ name: x.name ?? '—', phone: mask(x.phone) })).sort((a, b) => a.name.localeCompare(b.name, 'he')),
        available: ['מזוהים כשכותבים לסטודיו ומנותבים לתומר', 'מקבלים תשובות שירות (כתובת, לוח שיעורים, מקום פנוי, מי מעביר/ה)', 'בקשות רישום / ביטול שיעור מועברות לצוות'],
        notAvailable: ['אינם נכללים בקבוצות המעקב (נעדרים, חודש ראשון, סיום מנוי)', 'אינם מועמדים לתוכניות השימור', 'אין להם כרטיס לקוח בלוח החברים'],
        decisions: ['האם לעקוב אחרי ההגעה שלהם ולכלול אותם בקבוצות המעקב?', 'האם מותר לפנות אליהם ביוזמה (שימור), ובאילו תוכניות?', 'האם תומר רשאי לרשום / לבטל להם שיעורים, או שזה נעשה רק דרך הגורם החיצוני?'] };
    } catch (err) { return { ok: false, state: 'not_loaded', error: String(err.message).slice(0, 160) }; }
  }

  return { roles, proposals, external, STATE_HE };
}

module.exports = { createTomerRoles, STATE_HE };
