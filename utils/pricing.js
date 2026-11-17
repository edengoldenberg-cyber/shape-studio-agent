'use strict';

/**
 * pricing.js — the ONLY source of prices an agent may state, and the guard that keeps a reply inside it.
 *
 * Source, in this order:
 *   1. DATA_DIR/subscription_packages.json   what the owner saved from the knowledge panel (persistent volume)
 *   2. config/approved_prices.default.json   shipped with the code: the introductory offer only; every membership
 *                                            price is null = NOT KNOWN
 * A price that is null is unknown. It is never guessed, never taken from the model, and a question about a
 * MEMBERSHIP is never answered with the price of the introductory offer (production, 2026-11-17: "כמה עולה מנוי"
 * was answered "2 אימונים ב-60 ₪" - an answer about a trial).
 */

const fs = require('fs');
const path = require('path');

const dataFile = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'subscription_packages.json');
const DEFAULT_FILE = path.join(__dirname, '../config/approved_prices.default.json');

function load() {
  for (const [file, source] of [[dataFile(), 'owner_saved'], [DEFAULT_FILE, 'shipped_default']]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg && typeof pkg === 'object') return { ...pkg, packages: Array.isArray(pkg.packages) ? pkg.packages : [], _source: source };
    } catch { /* next source */ }
  }
  return { trial: null, packages: [], _source: 'none' };
}
const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const trialOf = pkg => (pkg.trial && num(pkg.trial.price_ils) ? pkg.trial : null);
const pricedPackages = pkg => pkg.packages.filter(p => num(p.price_ils));

const PRICE_ASK = /כמה\s+(?:זה\s+|זה\s+יוצא\s+)?(?:עול(?:ה|ים|ות)|יוצא|משלמים)|מחיר|מחירון|עלות|תעריף|כמה\s+כסף|מה\s+העלויות/u;
const MEMBERSHIP = /מנוי|מנויים|חודשי|לחודש|חבילה|חבילות|כרטיסי|כניסות/u;
const TRIAL = /ניסיון|היכרות|להתנסות|שיעור\s+אחד|אימון\s+אחד|חד[- ]פעמי/u;

/** What a message asks the price of: 'membership' | 'trial' | 'general' | null (not a price question). */
function topic(text) {
  const t = String(text ?? '');
  if (!PRICE_ASK.test(t)) return null;
  const m = MEMBERSHIP.test(t), tr = TRIAL.test(t);
  return m && !tr ? 'membership' : tr && !m ? 'trial' : 'general';
}

/** Every amount written with a currency in a text: "60 ₪", "₪60", "350 ש״ח", "שקלים". */
function amountsIn(text) {
  const out = [];
  const t = String(text ?? '');
  for (const m of t.matchAll(/(\d{1,3}(?:[,.]\d{3})*|\d+)(?:\.\d+)?\s*(?:₪|ש["״']ח|שקל(?:ים)?|שח)/gu)) out.push(Number(m[1].replace(/[,.]/g, '')));
  for (const m of t.matchAll(/₪\s*(\d{1,3}(?:[,.]\d{3})*|\d+)/gu)) out.push(Number(m[1].replace(/[,.]/g, '')));
  return out;
}
function approvedAmounts(pkg = load()) {
  return new Set([trialOf(pkg)?.price_ils, ...pricedPackages(pkg).map(p => p.price_ils)].filter(Boolean));
}

const REP_OFFER = 'רוצה שנציג יחזור אליך עם המחירים המדויקים?';

// ── which package is the question about? ──────────────────────────────────────
const CLASS_TYPES = [
  ['reformer', /פילאטיס\s+מכשירים|רפורמר|reformer|מכשירים/iu], ['barre', /בר\b|barre|באר/iu], ['strength', /כוח|חיזוק/u], ['yoga', /יוגה|אשטנגה|yoga/iu],
  ['kangoo', /קנגו|kangoo/iu], ['toning', /טונינג|toning/iu], ['all_in', /all\s*in|אול\s*אין/iu], ['mat', /פילאטיס\s+מזרן|מזרן/u],
];
const WEEKLY = [[/פעם\s+בשבוע|פעם\s+אחת\s+בשבוע/u, 1], [/פעמיים\s+בשבוע/u, 2], [/שלוש\s+פעמים\s+בשבוע|3\s+פעמים\s+בשבוע/u, 3], [/ארבע\s+פעמים\s+בשבוע|4\s+פעמים\s+בשבוע/u, 4]];

/** What the question pins down: class type, number of entries, unlimited, no commitment. Only what was actually said. */
function wanted(text) {
  const t = String(text ?? '');
  const w = { classType: null, entries: null, unlimited: /ללא\s+הגבלה|בלי\s+הגבלה|חופשי|אנלימיטד|unlimited/iu.test(t), noCommitment: /(?:בלי|ללא)\s+התחייבות/u.test(t) };
  for (const [key, re] of CLASS_TYPES) if (re.test(t)) { w.classType = key; break; }
  const m = /(\d{1,2})\s*(?:כניסות|אימונים|שיעורים)(?:\s+(?:ב|ל)חודש)?/u.exec(t);
  if (m) w.entries = Number(m[1]);
  else for (const [re, perWeek] of WEEKLY) if (re.test(t)) { w.entries = perWeek * 4; break; }
  return w;
}
/**
 * Does an approved package fit what was asked? A package covers a class type when it lists none (the studio's
 * memberships give access to every class) or lists that type in `class_types`.
 */
function fits(pkg, w) {
  if (w.classType && Array.isArray(pkg.class_types) && pkg.class_types.length && !pkg.class_types.includes(w.classType)) return false;
  if (w.unlimited && pkg.entries_per_month !== null && pkg.entries_per_month !== undefined) return false;
  if (w.entries !== null && pkg.entries_per_month !== w.entries) return false;
  if (w.noCommitment && Number(pkg.commitment_months) > 1) return false;
  return true;
}
const termsOf = p => [Number(p.commitment_months) > 1 ? `התחייבות ל-${p.commitment_months} חודשים` : null].filter(Boolean);
const line = p => `${p.name} — ${p.price_ils} ₪ לחודש${termsOf(p).length ? ` (${termsOf(p).join(', ')})` : ''}`;

/**
 * The answer to a membership-price question, from the approved packages only, matched to WHAT WAS ASKED:
 *   one approved package fits            → that package, with its terms
 *   several fit                          → the approved options are shown (the lead chooses; no guess)
 *   packages fit but none has a price,
 *   or nothing approved fits the request → "I do not have an up-to-date price" + a representative
 * The introductory offer is never used in place of a membership price.
 */
function membershipAnswer(pkg, { callbackArranged = false } = {}, userText = '') {
  const w = wanted(userText);
  const candidates = pkg.packages.filter(p => fits(p, w)), priced = candidates.filter(p => num(p.price_ils));
  const offer = callbackArranged ? 'הנציג יעבור איתך על המסלולים בשיחה שקבענו.' : 'רוצה שנציג יחזור אליך ויעזור לבחור את המסלול המתאים?';
  if (priced.length === 1) return `${line(priced[0])}.\n${offer}`;
  if (priced.length > 1) return [`יש כמה מסלולים שמתאימים:`, ...priced.slice(0, 5).map(p => `• ${line(p)}`), callbackArranged ? offer : 'איזה מהם מעניין אותך?'].join('\n');
  const what = candidates.length || !(w.classType || w.entries !== null || w.unlimited || w.noCommitment) ? 'למנוי' : 'למסלול שביקשת';
  return callbackArranged ? `אין לי כאן מחיר מעודכן ${what}, ואני לא רוצה לתת לך מספר לא מדויק 🙏\nהנציג ייתן לך את המחירים המדויקים בשיחה שקבענו.`
    : `אין לי כאן מחיר מעודכן ${what}, ואני לא רוצה לתת לך מספר לא מדויק 🙏\n${REP_OFFER}`;
}
function trialAnswer(pkg, { callbackArranged = false } = {}) {
  const tr = trialOf(pkg);
  if (tr) return `הצעת ההיכרות שלנו: ${tr.entries ? `${tr.entries} אימונים ב-` : ''}${tr.price_ils} ₪${tr.commitment === false ? ', ללא התחייבות' : ''}.`;
  return callbackArranged ? `אין לי כאן מחיר מעודכן לשיעור ניסיון 🙏 הנציג ייתן לך אותו בשיחה שקבענו.` : `אין לי כאן מחיר מעודכן לשיעור ניסיון, ואני לא רוצה לתת לך מספר לא מדויק 🙏\n${REP_OFFER}`;
}

/**
 * Keep a reply inside the approved prices. -> { reply, changed, reason, topic }
 *   membership question → answered from the approved membership prices, or "I do not have it" + a representative.
 *                         The introductory offer is not used as the answer.
 *   trial question      → must state the approved trial price (or say it is not known).
 *   any reply           → an amount that is not an approved price is never sent.
 */
function guard(userText, reply, opts = {}) {
  const pkg = load(), tp = topic(userText), r = String(reply ?? '');
  if (tp === 'membership') {
    // never the model's wording: a figure that merely appears in the price list may belong to a different package than
    // the one asked about. The answer is built from the approved packages that FIT the question.
    const w = wanted(userText), fit = pkg.packages.filter(p => fits(p, w)).filter(p => num(p.price_ils));
    return { reply: membershipAnswer(pkg, opts, userText), changed: true, reason: fit.length === 1 ? 'membership_price_exact_package' : fit.length ? 'membership_options_shown' : 'membership_price_unknown', topic: tp };
  }
  const ok = approvedAmounts(pkg), bad = amountsIn(r).filter(a => !ok.has(a));
  if (tp === 'trial') {
    const tr = trialOf(pkg);
    if (!tr || bad.length || !amountsIn(r).includes(tr.price_ils)) return { reply: trialAnswer(pkg, opts), changed: true, reason: tr ? 'trial_price_from_approved_source' : 'trial_price_unknown', topic: tp };
    return { reply: r, changed: false, reason: null, topic: tp };
  }
  if (bad.length && tp === null) {
    // not a price question: only the sentences that carry an unapproved figure are dropped; the answer itself stays
    // sentences end at . ! ? followed by a space, or at a line break - "17.11" and "18:00" are not sentence ends
    const kept = r.split(/(?<=[.!?…])(?=\s)|(?<=\n)/u).filter(sn => !amountsIn(sn).some(a => !ok.has(a))).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { reply: kept || membershipAnswer(pkg, opts), changed: true, reason: 'unapproved_amount_removed', topic: tp };
  }
  if (bad.length) {
    const fix = tp === 'general' ? [trialOf(pkg) ? trialAnswer(pkg, opts) : null, membershipAnswer(pkg, opts, userText)].filter(Boolean).join('\n') : membershipAnswer(pkg, opts, userText);
    return { reply: fix, changed: true, reason: 'unapproved_amount_removed', topic: tp };
  }
  return { reply: r, changed: false, reason: null, topic: tp };
}

module.exports = { load, topic, wanted, fits, amountsIn, approvedAmounts, guard, membershipAnswer, trialAnswer, pricedPackages, trialOf };
