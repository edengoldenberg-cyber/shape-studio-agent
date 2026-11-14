'use strict';

/**
 * contact_policy.js — ONE place that decides whether a proactive message may go to a
 * member right now. Every proactive sender (member-care programs, the panel's "run now",
 * test sends) asks here; the answer is also what the eligibility preview shows.
 *
 *   evaluate(input) → { decision: 'send' | 'defer' | 'block', reasons: [code, …] }
 *     block  — not allowed for this member / program at all (opt-out, freeze, no phone …)
 *     defer  — allowed in principle, not now (quiet window, cooldown, human owns the chat …)
 *              a deferred episode is kept and re-evaluated; it is never silently dropped
 *
 * The same checks run again immediately before a message is sent.
 */

const { ilParts } = require('../utils/callback_time');

const ATTENDANCE_FAMILY = new Set(['tuesday', 'absence7', 'absence14']);
const COOLDOWN_EXEMPT   = new Set(['welcome', 'payment_failed', 'birthday', 'expiry5']);   // date-bound or transactional
const PAUSE_APPLIES     = new Set(['tuesday', 'absence7', 'absence14', 'onboarding14', 'month1']);
const RECENT_CONV_EXEMPT = new Set(['welcome', 'birthday']);
const FREEZE_ALLOWS     = new Set(['birthday']);
// Absence-related outreach ("we have not seen you") is wrong for a frozen member, so it needs a
// KNOWN "not frozen". An unknown freeze status blocks these programs — it is never read as "not frozen".
const FREEZE_MUST_BE_KNOWN = new Set(['tuesday', 'absence7', 'absence14', 'onboarding14', 'month1']);

const REASON_HE = {
  proactive_locked:      'תוכניות יזומות נעולות (TOMER_PROACTIVE_ENABLED)',
  test_only:             'מצב בדיקה — המספר אינו ברשימת המורשים',
  no_phone:              'אין מספר טלפון תקין ב-Arbox',
  phone_shared:          'אותו טלפון רשום ליותר מחבר/ה פעיל/ה אחד/ת',
  opted_out:             'ביקש/ה לא לקבל הודעות',
  care_opt_out:          'ביקש/ה להפסיק הודעות יזומות',
  membership_inactive:   'אין מנוי פעיל',
  on_hold:               'המנוי בהקפאה',
  freeze_unknown:        'סטטוס ההקפאה לא אומת — הודעות נוכחות וליווי חסומות עד אימות המקור או בדיקת צוות',
  paused:                'השהיה פעילה (חופשה / היעדרות ידועה)',
  human_owns:            'הצוות מנהל את השיחה',
  open_case:             'יש פנייה פתוחה בטיפול הצוות',
  outside_window:        'מחוץ לשעות השליחה',
  recent_conversation:   'הייתה שיחה ביממה האחרונה',
  cooldown:              'נשלחה הודעה יזומה לאחרונה',
  attendance_cooldown:   'נשלחה לאחרונה הודעת נוכחות אחרת',
  one_message_per_run:   'הודעה אחרת בעדיפות גבוהה יותר נשלחת היום',
};

function inSendWindow(now, p) {
  const t = ilParts(now);
  if (t.weekday === 6 && !p.saturday) return false;
  if (t.hour < p.windowStart) return false;
  if (t.hour >= (t.weekday === 5 ? Math.min(p.fridayEnd, p.windowEnd) : p.windowEnd)) return false;
  return true;
}

/**
 * @param {object} i
 *   program, now (Date), policy (settings.policy)
 *   member: { phone, phoneShared, isActive, freeze: 'frozen' | 'not_frozen' | 'unknown' }
 *           (a missing `freeze` is 'unknown' — fail closed)
 *   state:  { proactiveOn, allowed, owner: 'tomer'|'human'|'opted_out'|…, careOptOut, pause,
 *             openCase, lastConversationAt (ms|null), lastProactiveAt (ms|null), lastAttendanceMsgAt (ms|null) }
 */
function evaluate({ program, now, policy, member, state }) {
  const block = [], defer = [];
  const t = now.getTime();
  if (!state.proactiveOn) block.push('proactive_locked');
  if (!member.phone) block.push('no_phone');
  else if (member.phoneShared) block.push('phone_shared');
  else if (!state.allowed) block.push('test_only');
  if (state.owner === 'opted_out') block.push('opted_out');
  if (state.careOptOut) block.push('care_opt_out');
  if (member.isActive === false) block.push('membership_inactive');
  const freeze = ['frozen', 'not_frozen'].includes(member.freeze) ? member.freeze : 'unknown';
  if (freeze === 'frozen' && !FREEZE_ALLOWS.has(program)) block.push('on_hold');
  if (freeze === 'unknown' && FREEZE_MUST_BE_KNOWN.has(program)) block.push('freeze_unknown');
  if (state.pause && PAUSE_APPLIES.has(program)) block.push('paused');

  if (state.owner === 'human' || state.owner === 'attribution_review') defer.push('human_owns');
  if (state.openCase) defer.push('open_case');
  if (!inSendWindow(now, policy)) defer.push('outside_window');
  if (!RECENT_CONV_EXEMPT.has(program) && state.lastConversationAt && t - state.lastConversationAt < policy.recentConversationHours * 3600000) defer.push('recent_conversation');
  if (!COOLDOWN_EXEMPT.has(program) && state.lastProactiveAt && t - state.lastProactiveAt < policy.cooldownHours * 3600000) defer.push('cooldown');
  if (ATTENDANCE_FAMILY.has(program) && state.lastAttendanceMsgAt && t - state.lastAttendanceMsgAt < policy.attendanceCooldownDays * 86400000) defer.push('attendance_cooldown');

  if (block.length) return { decision: 'block', reasons: [...block, ...defer] };
  if (defer.length) return { decision: 'defer', reasons: defer };
  return { decision: 'send', reasons: [] };
}

module.exports = { evaluate, inSendWindow, REASON_HE, ATTENDANCE_FAMILY, COOLDOWN_EXEMPT, PAUSE_APPLIES, FREEZE_MUST_BE_KNOWN };
