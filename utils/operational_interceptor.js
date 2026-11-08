'use strict';

/**
 * operational_interceptor.js — Gate 2 of the inbound message firewall.
 *
 * Detects operational, member-service, or cancellation intent BEFORE any
 * sales logic runs. If triggered, callers must immediately:
 *   1. Send holdResponse to the user
 *   2. Alert staff (alertOwner)
 *   3. Return early — never enter Barak's qualification funnel
 *
 * Design contract:
 *   • Deterministic regex only — no AI call, cannot fail or time out.
 *   • Biased toward false positives (safe: routes to staff) over false negatives
 *     (catastrophic: paying member receives a cold sales pitch).
 *   • A "hard block" fires on any single rule with weight >= HARD_BLOCK.
 *   • Patterns are intentionally accusatory/possessive/imperative — they signal
 *     an EXISTING relationship with the studio, not a new enquiry.
 */

const HARD_BLOCK = 8; // weight threshold for automatic block

const RULES = [

  // ── ACCUSATORY: second-person "you cancelled" ────────────────────────────────
  // Only a member of OUR studio accuses US of cancelling THEIR class.
  // These patterns are the strongest possible member signal — weight 10.
  {
    weight: 10,
    intent: 'accuse_cancellation',
    patterns: [
      /ביטלת\s+לי/,                              // "ביטלת לי"
      /ביטלת\s+את(\s+ה)?אימון/,                  // "ביטלת את האימון"
      /ביטלו\s+לי/,                              // "ביטלו לי"
      /ביטלו\s+את(\s+ה)?אימון/,                  // "ביטלו את האימון"
      /איך\s+(ביטלת|ביטלו|בוטל)/,               // "איך ביטלת"
      /למה\s+(ביטלת|ביטלו|בוטל)/,               // "למה ביטלו"
      /מי\s+(ביטל|ביטלה)\s+/,                   // "מי ביטל את"
      /לא\s+ביקשתי\s+(ביטול|שינוי|זה)/,         // "לא ביקשתי ביטול"
      /לא\s+אישרתי\s+(ביטול|שינוי|זה)/,         // "לא אישרתי שינוי"
    ],
  },

  // ── POSSESSIVE: "my class", "my slot", "my membership" ──────────────────────
  // Signals an existing account at our studio.
  // Note: "המנוי שלי בחדר הכושר האחר" is explicitly excluded so a lead
  // describing a COMPETITOR membership doesn't false-positive.
  {
    weight: 9,
    intent: 'member_possessive',
    patterns: [
      /ה?אימון\s+שלי/,                           // "האימון שלי"
      /ה?שיבוץ\s+שלי/,                           // "השיבוץ שלי"
      /ה?מקום\s+שלי\s+ב/,                        // "המקום שלי ב..."
      /ה?רישום\s+שלי\s+ל/,                       // "הרישום שלי ל..."
      /יש\s+לי\s+שיבוץ/,                         // "יש לי שיבוץ"
      /יש\s+לי\s+מקום\s+ב/,                      // "יש לי מקום ב..."
      // "המנוי שלי" but NOT if followed by a competitor reference
      /ה?מנוי\s+שלי(?!\s+ב(?:חדר|מכון|ג'ים|סטודיו\s+אחר))/,
    ],
  },

  // ── ABSENCE NOTIFICATION: telling US they won't attend their own class ────────
  // Cold leads ask "is there a class?" — members TELL us "I won't be there."
  // Pattern requires a specific day name or studio-reference after the absence phrase.
  {
    weight: 9,
    intent: 'member_absence',
    patterns: [
      // "לא אהיה ב[day]"
      /לא\s+אה?יה?\s+ב(יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/,
      // "לא אהיה באימון / בסטודיו / אצלכם"
      /לא\s+אה?יה?\s+(ב?אימון|ב?שיעור|ב?סטודיו|אצלכם)\b/,
      // "לא אבוא לאימון" / "לא אבוא ב[day]"
      /לא\s+אב[ואא]?\s+ל?אימון/,
      /לא\s+אב[ואא]?\s+ב(יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/,
      // "לא אגיע לאימון" / "לא אגיע ב[day]"
      /לא\s+אגיע\s+(ל?אימון|ב(יום|שבוע))/,
      // Vacation — only blocks when combined with a time reference (they're notifying us)
      /(?:בחופשה|בטיול|לא\s+בישראל|בחו["ה]ל)\s+(?:ב|ה)?(?:שבוע|יום|חודש)/,
    ],
  },

  // ── MEMBERSHIP OPERATIONS ─────────────────────────────────────────────────────
  // Renew, freeze, cancel, billing questions — all require an existing account.
  {
    weight: 9,
    intent: 'membership_ops',
    patterns: [
      /(?:לחדש|חידוש)\s+ה?מנוי/,                // "לחדש את המנוי"
      /(?:להקפיא|הקפאת)\s+ה?מנוי/,              // "להקפיא את המנוי"
      /(?:לבטל|ביטול)\s+ה?מנוי/,                // "לבטל את המנוי"
      /(?:מתי\s+נגמר|מתי\s+פג|כמה\s+נשאר)\s+(?:ה?מנוי|ה?חבילה)/,
      /(?:חיוב|תשלום)\s+(?:שלי|(?:ב|של\s+ה?)מנוי|כפול|שגוי)/,
    ],
  },

  // ── COMPLAINT ABOUT STUDIO ACTION ────────────────────────────────────────────
  {
    weight: 9,
    intent: 'complaint',
    patterns: [
      /(?:טעות|שגיאה)\s+(?:ב|עם)\s+(?:שיבוץ|אימון|מנוי|חיוב|חשבון)/,
      /(?:בעיה|בעייה)\s+(?:עם|ב)\s+(?:שיבוץ|אימון|מנוי)/,
      /לא\s+קיבלתי\s+(?:אישור|מקום|שיבוץ)\s/,  // "לא קיבלתי אישור"
    ],
  },

  // ── INJURY/HEALTH (requires explicit cannot-come signal to avoid blocking leads) ─
  // Requires both a health reason AND an explicit absence signal in the same message.
  {
    weight: 8,
    intent: 'health',
    patterns: [
      /(?:נפצעתי|נחבלתי|נפגעתי)\b/,
      /(?:חולה|לא\s+בסדר)\s+ו(?:לא|?כן)?\s+(?:אוכל|אגיע|אב[ואא]?)\s+/,
    ],
  },
];

/**
 * Scan `text` for operational / member-service intent.
 *
 * @param {string} text - raw inbound message text
 * @returns {{ blocked: boolean, intent?: string, holdResponse?: string, weight?: number }}
 */
function checkOperationalIntent(text) {
  if (!text) return { blocked: false };

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        if (rule.weight >= HARD_BLOCK) {
          return {
            blocked:      true,
            intent:       rule.intent,
            weight:       rule.weight,
            holdResponse: _buildHoldResponse(rule.intent),
          };
        }
      }
    }
  }

  return { blocked: false };
}

function _buildHoldResponse(intent) {
  const map = {
    accuse_cancellation: 'קיבלתי! מעביר את זה מיד לצוות הסטודיו לטיפול 🙏',
    member_possessive:   'קיבלתי, מעביר לצוות שיטפל בזה עכשיו ✔️',
    member_absence:      'הבנתי! מעביר לצוות לעדכון 🙏',
    membership_ops:      'קיבלתי, מעביר לצוות שיבדוק את המנוי שלך עכשיו ✔️',
    complaint:           'מבין, מעביר לטיפול אישי עכשיו — הצוות יחזור אליך בהקדם 🙏',
    health:              'מקווה שתרגיש/י טוב! מעביר לצוות לתיאום 🙏',
  };
  return map[intent] ?? 'קיבלתי! מעביר לצוות הסטודיו לטיפול 🙏';
}

module.exports = { checkOperationalIntent };
