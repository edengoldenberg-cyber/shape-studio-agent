'use strict';
/**
 * pricing.test.js — the approved price source and the guard that keeps every agent's reply inside it. ISOLATED.
 * The model's text is an input here: the point is what may be SENT, whatever the model wrote.
 */
const fs = require('fs');
const path = require('path');
const pricing = require('../utils/pricing');

const FILE = path.join(process.env.DATA_DIR, 'subscription_packages.json');
const save = pkg => fs.writeFileSync(FILE, JSON.stringify(pkg));
const clear = () => { try { fs.unlinkSync(FILE); } catch { /* nothing saved */ } };
beforeEach(clear);                                        // the isolated test directory may be seeded with a copy of the repo's file
afterEach(clear);

const MISSING = 'אין לי כאן מחיר מעודכן למנוי, ואני לא רוצה לתת לך מספר לא מדויק 🙏\nרוצה שנציג יחזור אליך עם המחירים המדויקים?';
const TRIAL_MODEL = 'הצעת ההיכרות שלנו היא 2 אימונים ב-60 ₪, ללא התחייבות.';

describe('the source', () => {
  test('nothing saved by the owner: the shipped default - the introductory offer only, every membership price unknown', () => {
    const p = pricing.load();
    expect(p._source).toBe('shipped_default');
    expect(pricing.trialOf(p)).toMatchObject({ price_ils: 60, entries: 2 });
    expect(pricing.pricedPackages(p)).toHaveLength(0);
    expect([...pricing.approvedAmounts(p)]).toEqual([60]);
  });
  test('what the owner saved wins, and a null price stays unknown', () => {
    save({ trial: { entries: 1, price_ils: 50 }, packages: [{ name: '8 כניסות', price_ils: 390 }, { name: 'ללא הגבלה', price_ils: null }] });
    const p = pricing.load();
    expect(p._source).toBe('owner_saved');
    expect([...pricing.approvedAmounts(p)].sort()).toEqual([390, 50]);
  });
});

describe('what is being asked', () => {
  test.each([
    ['כמה עולה מנוי לפילאטיס מכשירים?', 'membership'], ['מה המחיר של חבילה חודשית', 'membership'], ['כמה עולה כרטיסייה של 10 כניסות', 'membership'],
    ['כמה עולה שיעור ניסיון', 'trial'], ['מה המחיר של אימון היכרות?', 'trial'],
    ['כמה זה עולה?', 'general'], ['מה המחירים אצלכם', 'general'], ['כמה עולה מנוי ויש שיעור ניסיון?', 'general'],
    ['איפה אתם נמצאים?', null], ['יש לי מנוי ואני רוצה לבוא מחר', null],
  ])('%s → %s', (q, want) => expect(pricing.topic(q)).toBe(want));
});

describe('the guard', () => {
  test('a membership question is NOT answered with the introductory offer; with no approved price it says so and offers a representative', () => {
    const g = pricing.guard('כמה עולה מנוי לפילאטיס מכשירים?', TRIAL_MODEL);
    expect(g).toMatchObject({ changed: true, reason: 'membership_price_unknown', reply: MISSING });
    expect(g.reply).not.toMatch(/60|היכרות|ניסיון/);
  });
  test('a membership price the model made up is not sent', () => {
    expect(pricing.guard('כמה עולה מנוי חודשי?', 'המנוי החודשי עולה 450 ₪').reply).toBe(MISSING);
    expect(pricing.guard('כמה עולה מנוי חודשי?', 'המנוי עולה ₪450 לחודש').reply).toBe(MISSING);
    expect(pricing.guard('כמה עולה מנוי חודשי?', 'בערך 450 שקלים').reply).toBe(MISSING);
  });
  const SAVED = { trial: { entries: 2, price_ils: 60 }, packages: [
    { name: '8 כניסות לחודש', entries_per_month: 8, price_ils: 390, commitment_months: 1 },
    { name: '12 כניסות לחודש', entries_per_month: 12, price_ils: 490, commitment_months: 1 },
    { name: '8 כניסות לחודש בהתחייבות לשנה', entries_per_month: 8, price_ils: 340, commitment_months: 12 },
    { name: 'ללא הגבלה', entries_per_month: null, price_ils: null, commitment_months: 1 },
    { name: 'יוגה בלבד — 4 כניסות', entries_per_month: 4, price_ils: 200, commitment_months: 1, class_types: ['yoga'] }] };

  test('the answer is matched to the package that was asked about - not to any figure that is on the list', () => {
    save(SAVED);
    // 12 entries: one approved package fits
    expect(pricing.guard('כמה עולה מנוי של 12 כניסות?', '8 כניסות לחודש עולות 390 ₪').reply).toBe('12 כניסות לחודש — 490 ₪ לחודש.\nרוצה שנציג יחזור אליך ויעזור לבחור את המסלול המתאים?');
    // "390" IS an approved figure, but it is the price of another package: the model's sentence is not sent
    expect(pricing.guard('כמה עולה מנוי של 12 כניסות?', 'המנוי עולה 390 ₪').reply).not.toMatch(/390/);
    // twice a week = 8 a month; without a commitment only one of the two 8-entry packages fits, and its terms are not hidden
    expect(pricing.guard('כמה עולה מנוי לפעמיים בשבוע בלי התחייבות?', '').reply).toMatch(/^8 כניסות לחודש — 390 ₪ לחודש\./);
    expect(pricing.guard('כמה עולה מנוי של 8 כניסות?', '').reply).toBe('יש כמה מסלולים שמתאימים:\n• 8 כניסות לחודש — 390 ₪ לחודש\n• 8 כניסות לחודש בהתחייבות לשנה — 340 ₪ לחודש (התחייבות ל-12 חודשים)\nאיזה מהם מעניין אותך?');
  });
  test('class type: a package limited to another class is not offered; a general membership covers every class', () => {
    save(SAVED);
    const r = pricing.guard('כמה עולה מנוי לפילאטיס מכשירים?', '').reply;
    expect(r).toMatch(/^יש כמה מסלולים שמתאימים:/);
    expect(r).toMatch(/8 כניסות לחודש — 390/);
    expect(r).not.toMatch(/יוגה/);                                           // the yoga-only package is not a Reformer price
    expect(pricing.guard('כמה עולה מנוי יוגה של 4 כניסות?', '').reply).toMatch(/^יוגה בלבד — 4 כניסות — 200 ₪ לחודש\./);
  });
  test('no approved price for what was asked: it says so and offers a representative - never the trial, never a near miss', () => {
    save(SAVED);
    for (const q of ['כמה עולה מנוי ללא הגבלה?', 'כמה עולה מנוי של 16 כניסות?', 'כמה עולה כרטיסייה של 10 כניסות']) {
      const r = pricing.guard(q, 'הצעת ההיכרות שלנו היא 2 אימונים ב-60 ₪').reply;
      expect(r).toMatch(/^אין לי כאן מחיר מעודכן (למנוי|למסלול שביקשת), ואני לא רוצה לתת לך מספר לא מדויק 🙏\nרוצה שנציג יחזור אליך עם המחירים המדויקים\?$/);
      expect(r).not.toMatch(/60|390|490|340|היכרות|ניסיון/);
    }
  });
  test('what the question pins down is read only from what was said', () => {
    expect(pricing.wanted('כמה עולה מנוי?')).toEqual({ classType: null, entries: null, unlimited: false, noCommitment: false });
    expect(pricing.wanted('כמה עולה מנוי לפילאטיס מכשירים שלוש פעמים בשבוע')).toMatchObject({ classType: 'reformer', entries: 12 });
    expect(pricing.wanted('מנוי חופשי בלי התחייבות')).toMatchObject({ unlimited: true, noCommitment: true });
  });
  test('a trial question gets the approved trial price: the model\'s own wording when it is right, the approved figure when it is not', () => {
    expect(pricing.guard('כמה עולה שיעור ניסיון', TRIAL_MODEL)).toMatchObject({ changed: false, reply: TRIAL_MODEL });
    expect(pricing.guard('כמה עולה שיעור ניסיון', 'שיעור ניסיון עולה 50 ₪').reply).toBe('הצעת ההיכרות שלנו: 2 אימונים ב-60 ₪, ללא התחייבות.');
    expect(pricing.guard('כמה עולה שיעור ניסיון', 'נשמח לראות אותך!').reply).toBe('הצעת ההיכרות שלנו: 2 אימונים ב-60 ₪, ללא התחייבות.');
    save({ trial: null, packages: [] });
    expect(pricing.guard('כמה עולה שיעור ניסיון', TRIAL_MODEL).reply).toMatch(/אין לי כאן מחיר מעודכן לשיעור ניסיון/);
  });
  test('a general price question: approved figures pass; an invented one is replaced by what is known and what is not', () => {
    expect(pricing.guard('כמה זה עולה?', 'הצעת ההיכרות — 2 אימונים ב-60 ₪. לחבילות חודשיות הצוות ישמח לפרט.').changed).toBe(false);
    const g = pricing.guard('כמה זה עולה?', 'זה עולה 300 שקלים לחודש');
    expect(g.reply).toMatch(/^הצעת ההיכרות שלנו: 2 אימונים ב-60 ₪/);
    expect(g.reply).toMatch(/אין לי כאן מחיר מעודכן למנוי/);
    expect(g.reply).not.toMatch(/300/);
  });
  test('not a price question: the answer stays, only a sentence with an unapproved figure is dropped', () => {
    expect(pricing.guard('איפה אתם נמצאים?', 'דרך השדה 12, פרדס חנה.')).toMatchObject({ changed: false });
    expect(pricing.guard('מה שעות הפעילות', 'אנחנו פתוחים מ-7 עד 21. המנוי עולה 299 ש"ח לחודש. נשמח לראות אותך!').reply).toBe('אנחנו פתוחים מ-7 עד 21. נשמח לראות אותך!');
  });
  test('dropping a sentence with a wrong price keeps the valid answer to the other part of the message', () => {
    const q = 'איפה אתם נמצאים ומתי יש שיעור מחר?';
    const model = 'אנחנו בדרך השדה 12, פרדס חנה-כרכור.\nמחר, 18.11, יש פילאטיס מכשירים ב-17:00 וב-18:00. שיעור בודד עולה 80 ₪. יש 3 מקומות פנויים ב-17:00!';
    expect(pricing.guard(q, model).reply).toBe('אנחנו בדרך השדה 12, פרדס חנה-כרכור.\nמחר, 18.11, יש פילאטיס מכשירים ב-17:00 וב-18:00. יש 3 מקומות פנויים ב-17:00!');
    // a date with a dot is not a sentence end: nothing is cut in the middle
    expect(pricing.guard(q, 'השיעור ב-17.11 בשעה 18:00 מתאים. המחיר 95 ₪. נתראה!').reply).toBe('השיעור ב-17.11 בשעה 18:00 מתאים. נתראה!');
  });
  test('numbers that are not prices are never filtered: hours, dates, counts, addresses, phone numbers', () => {
    for (const r of ['השיעור ב-18:00, ביום שלישי 17.11.2026.', 'נשארו 3 מקומות ב-17:00 ו-5 ב-19:30.', 'יש לך 8 כניסות בחודש ונשארו 2.', 'אנחנו בדרך השדה 12, קומה 2. טלפון 04-6000000.',
      'השיעור נמשך 55 דקות, ומתחילים 10 דקות לפני.', 'בין 14:00 ל-16:00 ב-18.11']) {
      expect(pricing.amountsIn(r)).toEqual([]);
      expect(pricing.guard('מתי יש שיעור?', r)).toMatchObject({ changed: false, reply: r });
    }
    expect(pricing.amountsIn('2 אימונים ב-60 ₪')).toEqual([60]);            // the count is not an amount; the price is
    expect(pricing.guard('מתי יש שיעור?', 'מחר ב-18:00. הצעת ההיכרות: 2 אימונים ב-60 ₪.').changed).toBe(false);   // an approved price is left alone
  });
  test('when a callback is already arranged the representative is not offered again', () => {
    const g = pricing.guard('כמה עולה מנוי?', TRIAL_MODEL, { callbackArranged: true });
    expect(g.reply).toMatch(/הנציג ייתן לך את המחירים המדויקים בשיחה שקבענו/);
    expect(g.reply).not.toMatch(/רוצה שנציג/);
  });
});
