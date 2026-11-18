'use strict';
/**
 * sales_refusal.test.js — the rules behind "the lead decided not to register" (utils/sales_refusal.js), the fixed
 * "next step" rule of the lead agent, and the conversion detector.
 *
 * Production, 2026-11-17 (a historical conversation, replayed here with invented phones): after "אני בסוף החלטתי לא
 * להרשם" and a polite goodbye, "תודה רבה על הניסיון" was answered with an offer of a representative's call. The
 * offer was added by a rule in the code: the word "ניסיון" matched the "sales question" pattern.
 * The conversation through the real pipeline is in callback_lifecycle.test.js (section 12).
 */
const fs = require('fs');
const path = require('path');
const r = require('../utils/sales_refusal');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('what counts as an explicit refusal, a courtesy, a request to be called', () => {
  test('explicit refusals', () => {
    for (const t of ['אני בסוף החלטתי לא להרשם', 'החלטתי שלא להמשיך', 'לא מעוניינת תודה', 'זה כבר לא רלוונטי', 'מצאתי סטודיו אחר', 'ויתרתי',
                     'לא אירשם בסוף', 'בסוף לא מתאים לי', 'נרשמתי למקום אחר', 'אני לא רוצה להירשם', 'החלטתי בסוף שלא']) {
      expect([t, r.isRefusal(t)]).toEqual([t, true]);
    }
  });
  test('a question, a declined CALL, an unrelated "no" and a request to register are not a refusal to register', () => {
    for (const t of ['אם לא ארשם מה קורה?', 'לא מעוניינת בשיחה כרגע', 'כמה עולה מנוי?', 'אני רוצה להירשם', 'לא הבנתי', 'לא קיבלתי את המערכת',
                     'החלטתי לא לבוא היום, אפשר מחר?', 'בסוף כן רוצה להירשם', 'לא יכולה היום', 'תודה רבה על הניסיון']) {
      expect([t, r.isRefusal(t)]).toEqual([t, false]);
    }
  });
  test('courtesy only: thanks, a greeting, an emoji — and nothing that asks or requests', () => {
    for (const t of ['תודה רבה על הניסיון', 'תודה', '👍', 'תודה רבה 🙏', 'אוקיי תודה יום טוב', 'תודה על הכל', '❤️', 'סבבה תודה', 'תודה רבה לך', 'בהצלחה גם לכם'])
      expect([t, r.isCourtesy(t)]).toEqual([t, true]);
    for (const t of ['תודה, כמה עולה מנוי', 'תודה אבל אשמח שיחזרו אליי', 'מה הכתובת', 'תודה על הניסיון, יש שיעור מחר?', 'תודה, אני אחשוב על מנוי חודשי'])
      expect([t, r.isCourtesy(t)]).toEqual([t, false]);
  });
  test('an explicit request for a call or to register reopens; a negated one does not', () => {
    for (const t of ['אשמח שיחזרו אליי', 'אפשר שיחה עם נציג?', 'בסוף כן רוצה להירשם', 'התחרטתי', 'תחזרו אליי בבקשה', 'רוצה לקבוע שיעור'])
      expect([t, r.isCallRequest(t)]).toEqual([t, true]);
    for (const t of ['לא רוצה שיתקשרו אליי', 'תודה', 'כמה עולה', 'אל תתקשרו אליי', 'לא צריך שיחה'])
      expect([t, r.isCallRequest(t)]).toEqual([t, false]);
  });
});

describe('decide(): the sequence of a conversation', () => {
  const st = (declined, courtesyAnswered = false) => ({ declined, courtesyAnswered });
  test('refusal → courtesy → more courtesy → question → request', () => {
    const a = r.decide('אני בסוף החלטתי לא להרשם', st(false));
    expect(a).toMatchObject({ action: 'refusal', reply: r.REPLY_TO_REFUSAL, patch: { registrationDeclined: true, callbackDeclined: true, callProposed: false } });
    expect(r.decide('תודה רבה על הניסיון', st(true))).toMatchObject({ action: 'courtesy', reply: r.REPLY_TO_COURTESY, patch: { declineCourtesyAnswered: true } });
    expect(r.decide('🙏', st(true, true))).toEqual({ action: 'silent' });
    expect(r.decide('כמה עולה מנוי?', st(true, true))).toEqual({ action: 'question' });
    expect(r.decide('בסוף אשמח שיחזרו אליי', st(true, true))).toMatchObject({ action: 'reopen', patch: { registrationDeclined: false, callbackDeclined: false } });
  });
  test('without a refusal nothing changes for an ordinary lead', () => {
    for (const t of ['תודה רבה', 'כמה עולה מנוי?', 'אשמח שיחזרו אליי', '👍']) expect(r.decide(t, st(false))).toEqual({ action: 'none' });
  });
  test('the fixed replies carry no offer, no question and no slash form', () => {
    for (const t of [r.REPLY_TO_REFUSAL, r.REPLY_TO_COURTESY]) {
      expect(t).not.toMatch(/\?|נציג|שיחה|ניסיון|להירשם/);
      expect(r.hasSlashForm(t)).toBe(false);
      expect(r.stripOffers(t)).toBe(t);
    }
  });
});

describe('stripOffers(): the one gate every reply passes after a refusal', () => {
  test('the production reply loses the offer and keeps the goodbye', () => {
    const prod = 'בשמחה 😊 אם תחליט/י לחזור בעתיד, אנחנו כאן בשבילך! המשך יום נפלא.\nרוצה שנציג יחזור אליך ויעזור לבחור את האימון המתאים?';
    expect(r.stripOffers(prod)).toBe('בשמחה 😊 אם תחליט/י לחזור בעתיד, אנחנו כאן בשבילך! המשך יום נפלא.');
  });
  test('offers from the price guard, the model and the callback texts are removed; the answer itself stays', () => {
    expect(r.stripOffers('אין לי כאן מחיר מעודכן למנוי, ואני לא רוצה לתת לך מספר לא מדויק 🙏\nרוצה שנציג יחזור אליך עם המחירים המדויקים?'))
      .toBe('אין לי כאן מחיר מעודכן למנוי, ואני לא רוצה לתת לך מספר לא מדויק 🙏');
    expect(r.stripOffers('מנוי חודשי עולה 400 ₪.\nרוצה שנציג יחזור אליך ויעזור לבחור את המסלול המתאים?')).toBe('מנוי חודשי עולה 400 ₪.');
    expect(r.stripOffers('יש חניה חופשית ליד הסטודיו 🙂 רוצה שנתאם לך שיעור ניסיון?')).toBe('יש חניה חופשית ליד הסטודיו 🙂');
    expect(r.stripOffers('הצעת ההיכרות שלנו: 2 אימונים ב-60 ₪, ללא התחייבות.')).toBe('הצעת ההיכרות שלנו: 2 אימונים ב-60 ₪, ללא התחייבות.');
    expect(r.stripOffers('אשמח שנציג יחזור אליך. מתי נוח לך?')).toBe('תודה 🙏');
    expect(r.stripOffers('מוזמנת להירשם לשיעור ניסיון!', 'x')).toBe('x');
  });
});

describe('neutral wording', () => {
  test('the three production sentences are sent without a slash and without a guessed gender', () => {
    const out = ['היי! מאיזה אזור את/ה ומה מחפשים?', 'הכל בסדר, קורה לכולנו 😊 איך אפשר לעזור לך היום? יש משהו מסוים שאת/ה מחפש/ת?',
                 'בשמחה 😊 אם תחליט/י לחזור בעתיד, אנחנו כאן בשבילך! המשך יום נפלא.'].map(r.neutralWording);
    for (const t of out) expect([t, r.hasSlashForm(t)]).toEqual([t, false]);
    expect(out[1]).toContain('יש משהו מסוים שמעניין אותך?');
    expect(out[2]).toContain('אם יתאים לחזור בעתיד');
  });
  test('text without a slash form is returned untouched (dates, links, "ו/או")', () => {
    for (const t of ['נתראה ב-17/11 בשעה 18:00', 'https://waze.com/ul/abc', 'מחיר: 60 ₪']) expect(r.neutralWording(t)).toBe(t);
  });
});

describe('the module only decides: no I/O, no Arbox', () => {
  test('it requires nothing and names no Arbox call', () => {
    const src = fs.readFileSync(path.join(__dirname, '../utils/sales_refusal.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/require\(/);
    expect(src).not.toMatch(/arbox/i);
  });
  test('the pipeline step that handles a refusal does not reach Arbox either', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const a = server.indexOf('async function handleSalesRefusal('), b = server.indexOf('async function handleLeadCallbackFlow(');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    // the function itself, without comment lines
    const body = server.slice(a, server.indexOf('\n}\n', a)).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(body).not.toMatch(/arbox|executeWrite|classActions|memberHandoff/i);
  });
});

describe('conversion detector: an Arbox lead or staff row is not "converted to a member"', () => {
  test('only a client / an aggregator converts (production: a trial-lesson lead and the owner were marked as members)', async () => {
    jest.resetModules();
    jest.doMock('../services/arbox.service', () => ({ getAllUsers: jest.fn(() => Promise.resolve([
      { phone: '0587000001', active: 1, user_role: 'lead',        user_id: 1, first_name: 'ליד',   last_name: 'ניסיון' },
      { phone: '0587000002', active: 1, user_role: 'staffMember', user_id: 2, first_name: 'איש',   last_name: 'צוות' },
      { phone: '0587000003', active: 1, user_role: 'client',      user_id: 3, first_name: 'מתאמנת', last_name: 'פעילה' },
      { phone: '0587000004', active: 0, user_role: 'aggregatorMember', user_id: 4, first_name: 'חברת', last_name: 'מועדון' },
    ])) }));
    const { detectAndMarkConversions } = require('../utils/conversion_detector');
    const converted = [];
    const store = { getAllLeads: () => ['972587000001', '972587000002', '972587000003', '972587000004', '972587000005'].map(phone => ({ phone, status: 'warm', meta: {}, history: [] })),
                    reclassifyAsConvertedMember: p => converted.push(p), logEvent: jest.fn(), getLead: () => null, upsertLead: jest.fn() };
    const memberCache = { markConfirmed: jest.fn() };
    const norm = p => { const d = String(p).replace(/\D/g, ''); return d.startsWith('972') ? d : '972' + d.replace(/^0/, ''); };
    await detectAndMarkConversions(store, memberCache, norm, jest.fn());
    expect(converted.sort()).toEqual(['972587000003', '972587000004']);
  });
});
