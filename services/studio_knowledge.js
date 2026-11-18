'use strict';

/**
 * studio_knowledge.js — what the agents may say about instructors and class types, where it came from, and whether
 * it is confirmed; plus the ONE live check of free places in a class.
 *
 * Two kinds of information, kept apart:
 *   FIXED    instructors and class types (staff_directory.json, classes_knowledge.json under DATA_DIR) — written by the
 *            owner in the knowledge panel. A copy restored from history is marked `_restored` and is NOT current truth
 *            until the owner confirms it: only what the live Arbox schedule supports is given to the agents.
 *   LIVE     the schedule and the occupancy of a specific class — read from Arbox at the moment of the question.
 *            Nothing about free places is ever taken from the fixed information or from an old copy.
 *
 * Production, 2026-11-09 → 2026-11-18: `data/` was added to .railwayignore (video files blocked the upload), so the
 * three knowledge files stopped reaching the server. Nothing was deleted from the volume — the files had never been on
 * it. The agents ran without instructors and class descriptions, and the panel said "הסוכן עודכן בהצלחה" over failing checks.
 *
 * Reads Arbox only (GET). Writes only the two knowledge files, through barakAgent.reloadKnowledge.
 */

const fs = require('fs');
const path = require('path');

const HISTORIC_DIR  = path.join(__dirname, '../config/historic/2026-11-06');
const HISTORIC_FROM = 'עותק שנשמר במאגר הקוד ב-6–7.11.2026';
const LIVE_DAYS = 14, LIVE_FRESH_MS = 30 * 60 * 1000;

const normName = s => String(s ?? '').replace(/\([^)]*\)/g, ' ').replace(/["'׳״.\-–]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
/** A class TYPE key that the fixed names ("Pilates Barre", "אימון כוח") and the Arbox session names ("פילאטיס בר", "אימון כח") share. */
function typeKey(...names) {
  const t = names.filter(Boolean).join(' ').toLowerCase();
  if (/מכשירים|reformer|רפורמר/.test(t)) return 'reformer';
  if (/(?<![א-ת])בר(?![א-ת])|barre/.test(t)) return 'barre';
  if (/(?<![א-ת])כו?ח(?![א-ת])|strength/.test(t)) return 'strength';
  if (/all\s*in|אול\s*אין/.test(t)) return 'allin';
  if (/חיטוב|toning|עיצוב/.test(t)) return 'toning';
  if (/יוגה|yoga/.test(t)) return 'yoga';
  if (/kango|קנגו|קאנגו/.test(t)) return 'kangoo';
  return normName(names[0]);
}

function createStudioKnowledge(d) {
  const { gateway, barakAgent, pricing, logger = console } = d;
  const now = d.now ?? (() => new Date());
  const dayIL = (offset = 0) => new Date(now().getTime() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  let live = null;                       // { at, ok, error, coaches: Map, types: Map, classes }

  /** Read the next two weeks of the Arbox schedule: who teaches, which class types exist, their capacity. */
  async function refreshLive({ force = false } = {}) {
    if (!force && live && now().getTime() - live.at < LIVE_FRESH_MS) return live;
    try {
      const r = await gateway.getClasses({ from: dayIL(0), to: dayIL(LIVE_DAYS - 1) });
      const coaches = new Map(), types = new Map();
      for (const c of r.classes ?? []) {
        if (c.instructor) { const k = normName(c.instructor); coaches.set(k, { name: c.instructor, count: (coaches.get(k)?.count ?? 0) + 1 }); }
        const k = typeKey(c.name), t = types.get(k) ?? { names: new Set(), count: 0, capacity: null };
        t.names.add(c.name); t.count++; if (Number.isFinite(c.capacity)) t.capacity = Math.max(t.capacity ?? 0, c.capacity);
        types.set(k, t);
      }
      live = { at: now().getTime(), ok: true, error: null, stale: !!r.stale, coaches, types, classCount: (r.classes ?? []).length };
    } catch (err) {
      // the last good copy is kept for display; it no longer counts as a current verification
      live = { ...(live ?? { coaches: new Map(), types: new Map(), classCount: 0 }), at: now().getTime(), ok: false, error: String(err.message).slice(0, 160) };
      logger.warn('[knowledge] the Arbox schedule could not be read for verification', { error: err.message });
    }
    applyFilter();
    return live;
  }

  const raw = () => barakAgent.getRawKnowledge();
  const pendingApproval = obj => !!obj?._restored && obj._restored.confirmed !== true;
  /** true = teaches in the live schedule · false = not in it · null = the schedule could not be read */
  const instructorVerified = s => (live?.ok ? live.coaches.has(normName(s.name_he)) : null);
  const typeLive = c => (live?.ok ? (live.types.get(typeKey(c.name_he, c.name_en)) ?? false) : null);
  const instructorUsable = s => !pendingApproval(raw().staff) || instructorVerified(s) === true;
  const classTypeUsable  = c => !pendingApproval(raw().classes) || !!typeLive(c);
  /** Capacity of a class type: from Arbox when the fixed information is still waiting for approval. */
  const capacityOf = c => { const t = typeLive(c); return pendingApproval(raw().classes) ? (t ? t.capacity : null) : (c.capacity ?? null); };

  function applyFilter() {
    try { barakAgent.setKnowledgeFilter?.({ instructor: instructorUsable, classType: classTypeUsable, capacityOf }); }
    catch (err) { logger.warn('[knowledge] the filter could not be applied', { error: err.message }); }
  }

  const fileInfo = name => {
    const f = path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), name);
    try { const s = fs.statSync(f); return { exists: true, savedAt: s.mtime.toISOString(), bytes: s.size }; } catch { return { exists: false, savedAt: null, bytes: 0 }; }
  };

  /** The whole picture for the panel: saved / given to the agents / verified against Arbox / waiting for the owner. */
  function status() {
    const k = raw();
    const staffAll = k.staff?.instructors ?? [], classAll = k.classes?.classes ?? [];
    const staffRows = staffAll.map(s => ({ name: s.name_he, verified: instructorVerified(s), usable: instructorUsable(s), inSchedule: live?.ok ? (live.coaches.get(normName(s.name_he))?.count ?? 0) : null }));
    const classRows = classAll.map(c => { const t = typeLive(c); return { name: c.name_he, verified: t === null ? null : !!t, usable: classTypeUsable(c), arboxNames: t ? [...t.names] : [], capacitySaved: c.capacity ?? null, capacityArbox: t ? t.capacity : null }; });
    const missingInFile = live?.ok ? [...live.coaches.values()].filter(c => !staffAll.some(s => normName(s.name_he) === normName(c.name))).map(c => c.name) : [];
    const pkg = pricing.load();
    const section = (rows, obj, file) => ({
      file: fileInfo(file), saved: rows.length, givenToAgents: rows.filter(r => r.usable).length,
      verified: rows.filter(r => r.verified === true).length, notInArbox: rows.filter(r => r.verified === false).map(r => r.name),
      restored: obj?._restored ?? null, pendingApproval: pendingApproval(obj), rows,
    });
    return {
      generatedAt: now().toISOString(),
      arbox: live ? { ok: live.ok, error: live.error, checkedAt: new Date(live.at).toISOString(), classesNext14Days: live.classCount, stale: !!live.stale } : { ok: null, error: null, checkedAt: null, classesNext14Days: null },
      staff: { ...section(staffRows, k.staff, 'staff_directory.json'), teachingButNotListed: missingInFile },
      classes: section(classRows, k.classes, 'classes_knowledge.json'),
      prices: { source: pkg._source, packages: pkg.packages.length, priced: pricing.pricedPackages(pkg).length, trial: pricing.trialOf(pkg)?.price_ils ?? null, file: fileInfo('subscription_packages.json') },
      historicAvailable: { staff: fs.existsSync(path.join(HISTORIC_DIR, 'staff_directory.json')), classes: fs.existsSync(path.join(HISTORIC_DIR, 'classes_knowledge.json')) },
    };
  }

  /**
   * Operational summary of one section in Hebrew: saved? given to the agents? verified? what is needed.
   * state: ok | partial | empty | unknown
   */
  function summary() {
    const s = status(), out = [];
    const one = (id, label, sec, noun) => {
      if (!sec.saved) return out.push({ id, label, state: 'empty', text: `לא שמור אף ${noun}. הסוכנים עונים בלי המידע הזה.`, action: s.historicAvailable[id] ? `אפשר לשחזר את הרשימה מ${HISTORIC_FROM} (כפתור "שחזר").` : `להזין ולשמור בלשונית.` });
      if (s.arbox.ok !== true) return out.push({ id, label, state: sec.pendingApproval ? 'partial' : 'unknown',
        text: `${sec.saved} שמורים. לא ניתן לאמת כרגע מול Arbox (${s.arbox.error ?? 'עדיין לא נבדק'})${sec.pendingApproval ? ' — ולכן רשימה משוחזרת שלא אושרה אינה נמסרת לסוכנים עד שהבדיקה תצליח' : ''}.`, action: 'לנסות שוב בעוד כמה דקות.' });
      if (sec.pendingApproval) {
        const held = sec.saved - sec.givenToAgents;
        return out.push({ id, label, state: held ? 'partial' : 'ok',
          text: `${sec.saved} שמורים (שוחזרו מ${sec.restored.from}, טרם אושרו). ${sec.givenToAgents} מופיעים בלוח השיעורים של Arbox ונמסרים לסוכנים${held ? `; ${held} אינם מופיעים בלוח ב-${LIVE_DAYS} הימים הקרובים ואינם נמסרים: ${sec.notInArbox.join(', ')}` : ''}.`,
          action: 'לעבור על הרשימה, לתקן מה שהשתנה וללחוץ "אישור הרשימה".' });
      }
      return out.push({ id, label, state: 'ok', text: `${sec.saved} שמורים ונמסרים לסוכנים${sec.notInArbox.length ? ` (${sec.notInArbox.length} אינם בלוח של Arbox כרגע: ${sec.notInArbox.join(', ')})` : ''}.`, action: null });
    };
    one('staff', 'מדריכים', s.staff, 'מדריך');
    one('classes', 'סוגי שיעורים', s.classes, 'סוג שיעור');
    if (s.staff.teachingButNotListed.length) out.push({ id: 'staff_missing', label: 'מדריכים בלוח שאינם ברשימה', state: 'partial', text: `מלמדים לפי Arbox ואינם ברשימת המדריכים: ${s.staff.teachingButNotListed.join(', ')}.`, action: 'להוסיף אותם בלשונית המדריכים אם רוצים שהסוכנים יספרו עליהם.' });
    out.push(s.prices.priced ? { id: 'prices', label: 'מחירי מנויים', state: s.prices.priced === s.prices.packages ? 'ok' : 'partial', text: `${s.prices.priced} מתוך ${s.prices.packages} חבילות עם מחיר מאושר.`, action: null }
      : { id: 'prices', label: 'מחירי מנויים', state: 'empty', text: `לא נשמר אף מחיר מנוי${s.prices.trial ? ` (רק הצעת ההיכרות: ${s.prices.trial} ₪)` : ''}. גם בעותק ההיסטורי לא היו מחירים — אין מה לשחזר. על שאלת מחיר הסוכן עונה שאין לו מחיר מעודכן.`, action: 'להזין מחירים בלשונית המנויים ולשמור.' });
    out.push(s.arbox.ok === true ? { id: 'arbox', label: 'חיבור ללוח השיעורים ב-Arbox', state: 'ok', text: `נקרא עכשיו: ${s.arbox.classesNext14Days} שיעורים ב-${LIVE_DAYS} הימים הקרובים. לוח השיעורים והתפוסה נקראים תמיד מ-Arbox, לא מהרשימות השמורות.`, action: null }
      : { id: 'arbox', label: 'חיבור ללוח השיעורים ב-Arbox', state: 'unknown', text: `לא ניתן לקרוא כרגע את לוח השיעורים מ-Arbox (${s.arbox.error ?? 'עדיין לא נבדק'}). הסוכנים אומרים שאינם יכולים לאמת, ואינם מציגים תפוסה.`, action: 'אם זה נמשך — לבדוק את מפתח ה-API של Arbox.' });
    const worst = out.some(r => r.state === 'empty' || r.state === 'unknown') ? 'partial' : out.some(r => r.state === 'partial') ? 'partial' : 'ok';
    return { state: worst, rows: out, generatedAt: s.generatedAt };
  }

  /**
   * Restore one section from the historic copy shipped with the code. Never over newer information: only when the
   * section is empty, or still holds exactly that historic copy. The result is marked as waiting for the owner.
   */
  function restoreHistoric(type, { by = 'system' } = {}) {
    const map = { staff: ['staff_directory.json', 'instructors', 'staffData'], classes: ['classes_knowledge.json', 'classes', 'classesData'] }[type];
    if (!map) return { ok: false, error: 'unknown_type' };
    let hist; try { hist = JSON.parse(fs.readFileSync(path.join(HISTORIC_DIR, map[0]), 'utf8')); } catch { return { ok: false, error: 'no_historic_copy' }; }
    const cur = raw()[type] ?? {};
    const strip = o => { const { _restored, ...rest } = o ?? {}; return JSON.stringify(rest); };
    const curList = cur[map[1]] ?? [];
    if (curList.length && strip(cur) !== strip(hist)) return { ok: false, error: 'newer_information_exists', saved: curList.length };
    if (cur._restored && strip(cur) === strip(hist)) return { ok: true, unchanged: true, count: curList.length };
    barakAgent.reloadKnowledge({ [map[2]]: { ...hist, _restored: { at: now().toISOString(), from: HISTORIC_FROM, by, confirmed: false } } });
    applyFilter();
    return { ok: true, restored: (hist[map[1]] ?? []).length };
  }

  /** The owner looked at a restored section and confirms it as it now stands. */
  function confirm(type, { by = 'owner' } = {}) {
    const map = { staff: 'staffData', classes: 'classesData' }[type];
    const cur = raw()[type];
    if (!map || !cur) return { ok: false, error: 'unknown_type' };
    if (!cur._restored) return { ok: true, unchanged: true };
    barakAgent.reloadKnowledge({ [map]: { ...cur, _restored: { ...cur._restored, confirmed: true, confirmedAt: now().toISOString(), confirmedBy: by } } });
    applyFilter();
    return { ok: true };
  }

  /** Facts about instructors and class types that an agent may state (verified or owner-confirmed only). */
  function facts() {
    const k = raw(), lines = [];
    const inst = (k.staff?.instructors ?? []).filter(instructorUsable);
    if (inst.length) lines.push(`- מדריכות ומדריכים בסטודיו: ${inst.map(s => s.name_he + (s.primary_classes?.length ? ` (${s.primary_classes.filter(x => /[א-ת]/.test(x)).join(', ') || s.primary_classes[0]})` : '')).join('; ')}`);
    const cls = (k.classes?.classes ?? []).filter(classTypeUsable);
    if (cls.length) lines.push(`- סוגי השיעורים בסטודיו: ${cls.map(c => `${c.name_he}${c.pitch ? ` — ${String(c.pitch).split(/[.—]/)[0].trim()}` : ''}`).join('; ')}`);
    return lines;
  }

  /**
   * Free places in ONE class, read from Arbox now. `match(classes)` picks the class(es) the question is about.
   * Returns { status: 'found' | 'ask' | 'none' | 'unavailable', classes?, missing?, source, checkedAt }.
   * 'unavailable' = Arbox or its occupancy report could not be read: the caller says it cannot verify — never
   * "full", "free" or a number.
   */
  async function availability({ from = dayIL(0), to = dayIL(7), pick }) {
    let r;
    try { r = await gateway.getClasses({ from, to, fresh: true }); }
    catch (err) { return { status: 'unavailable', reason: 'arbox_unreachable', error: String(err.message).slice(0, 120) }; }
    if (r.stale) return { status: 'unavailable', reason: 'stale_copy' };
    const sel = pick(r.classes ?? []);
    if (sel.missing?.length) return { status: 'ask', missing: sel.missing, options: sel.options ?? [] };
    if (!sel.classes?.length) return { status: 'none' };
    if (!r.occupancyAvailable || sel.classes.some(c => !c.occupancy)) return { status: 'unavailable', reason: 'no_occupancy_data', classes: sel.classes };
    return { status: 'found', classes: sel.classes, source: r.source, checkedAt: new Date(r.fetchedAt).toISOString() };
  }

  applyFilter();
  return { refreshLive, status, summary, restoreHistoric, confirm, facts, availability, instructorUsable, classTypeUsable, HISTORIC_FROM };
}

module.exports = { createStudioKnowledge, typeKey, normName };
