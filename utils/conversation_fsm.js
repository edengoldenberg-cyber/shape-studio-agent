'use strict';

/**
 * conversation_fsm.js — Deterministic state machine for inbound message routing.
 *
 * Architectural contract:
 *   getState() is ALWAYS synchronous, ALWAYS pure, NEVER calls OpenAI or Arbox.
 *   It answers exactly one question: "what state is this conversation in RIGHT NOW?"
 *   The AI receives the answer; it does not compute it.
 *
 * State definitions:
 *
 *   MEMBER_SUPPORT    — phone confirmed in PhoneRegistry. NEVER routes to Barak.
 *   OPERATIONAL_HOLD  — operational/member-service intent detected regardless of identity.
 *   CRISIS            — emotional distress, medical, legal. Immediate human.
 *   PAYMENT           — payment confirmation. Ack + alert staff.
 *   SPAM              — voting campaigns, chain messages. Silently logged.
 *   STAFF             — internal staff message. Logged, no reply.
 *   REACTION          — emoji reaction event. Logged, no reply.
 *   AMBIGUOUS_HOLD    — cannot confirm cold-lead identity (Arbox down + no history).
 *   DISCOVERY_TURN_1  — confirmed cold lead, first contact.
 *   DISCOVERY_TURN_2  — confirmed cold lead, second exchange.
 *   DISCOVERY_TURN_3  — confirmed cold lead, deeper qualification.
 *   NAME_COLLECTION   — have location+goal, need first name before proposing call.
 *   CALL_PROPOSAL     — ready to propose the callback.
 *   CALL_CONFIRMED    — callback time captured. Conversation complete.
 *   ESCALATED         — human handoff triggered (frustration, loop, manual).
 *   INFORMATION_MODE  — call proposed but lead is still exploring.
 *
 * Usage:
 *   const { state, renderHint } = ConversationFSM.getState(context);
 *   // state  → routing target
 *   // renderHint → what the AI must render (narrow, specific, unambiguous)
 */

const { checkOperationalIntent } = require('./operational_interceptor');

// ── Shared pattern constants ──────────────────────────────────────────────────

const CRISIS_RE = [
  /\b(injury|injured|pain|hurt|pulled|sprained|fell|doctor|hospital|blood)\b/i,
  /\b(angry|furious|disgusted|scam|lawyer|lawsuit|complaint|awful|terrible)\b/i,
  /\bpost (about|this|it)\b/i,
  /\b(cancel\s*(my\s*)?(membership|subscription)|leaving|quitting|done with|refund|money back)\b/i,
  /(?:פציעה|נפלתי|בית חולים|רופא).*(?:כאב|בעיה)|(?:כאב).*(?:חמור|חד|נורא|אסור לי|רופא|בית חולים)/i,
  /\b(נפלתי|בית חולים)\b/i,
  /\b(כועס|עורך דין|תלונה|הונאה)\b/i,
  /\b(ביטול מנוי|עוזב|עוזבת|החזר כספי)\b/i,
];

const FRUSTRATION_RE = /תפסיק[יו]?|עצר[ו]?|מה זה בכלל|מה קורה פה|רובוט|בוט|מכונה|לא לאיים|מחריד|אל תשלח[יו]? יותר|לא רוצה לקבל הודעות|STOP\b|stop\b|אדם אמיתי|נציג אנושי|לא עונה לשאלה|לא מקשיב[ה]?|שטויות|להציק|אל תציק/i;

// ביט alone matches ביטלת, ביטוח, ביטויים — use lookahead/lookbehind to isolate the word
const PAYMENT_RE = /\bbit\b|(?<![א-ת])ביט(?![א-ת])|paybox|פייבוקס|העברה בנקאית|אישור תשלום|שלחתי תשלום|שלחתי העברה|העברתי|שלמתי|תשלום עבר|הועבר|\b\d{2,4}\s*₪|\b\d{2,4}\s*ש["״"]ח/i;

const SPAM_RE = /הצביע[וה]?|לצביע\b|הצבעה.*תחרות|תחרות.*הצבעה|קופון חינם|קבל.*חינם.*לחץ|click.*here.*win/i;

const TIME_RE = /\b(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{1,2}:\d{2}\b|\b(בוקר|ערב|צהריים|אחה"צ|אחרי עבודה)\b|\b\d{1,2}\s*(am|pm)\b/i;

function _isCrisis(text) {
  return CRISIS_RE.some(p => p.test(text));
}

function _isPayment(msg) {
  const text = (msg.mediaCaption ?? msg.text ?? '').trim();
  if ((msg.type === 'image') && (!text || text === '[תמונה]')) return true;
  return PAYMENT_RE.test(text);
}

// ── Ambiguity detector ────────────────────────────────────────────────────────
// Messages that are too fragmented to classify confidently.
// When matched AND identity is unconfirmed → AMBIGUOUS_HOLD (safe response, no sales).

const FRAGMENT_RE = /^.{1,4}$|^[^א-ת\w]{1,}$|^\d{1,3}$/u;

function _isFragmented(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length <= 3) return true;
  if (FRAGMENT_RE.test(t)) return true;
  // Hebrew words only if they form no recognizable intent pattern
  const hebrewWords = (t.match(/[א-ת]+/g) ?? []).filter(w => w.length >= 2);
  if (hebrewWords.length === 0 && /[א-ת]/.test(t) === false) return true;
  return false;
}

// ── Main FSM ──────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {boolean}  ctx.isMember           — from PhoneRegistry.isMember()
 * @param {boolean}  ctx.isStaff            — from server.isStaffPhone()
 * @param {object}   ctx.msg                — parsed WhatsApp message
 * @param {object}   ctx.qualData           — lead qualification state from lead_store (meta.qualData)
 * @param {number}   ctx.completedTurns     — user messages with AI replies in history
 * @param {number}   ctx.msgCount           — total inbound messages from this phone (lead_store.messageCount)
 * @param {boolean}  ctx.arboxLookupFailed
 * @param {boolean}  ctx.hasRecentLeadHistory — lead activity within 7 days
 *
 * @returns {{ state: string, renderHint: object }}
 */
function getState(ctx) {
  const { isMember, isStaff, msg, qualData = {}, completedTurns = 0,
          msgCount = 0, arboxLookupFailed = false, hasRecentLeadHistory = false } = ctx;
  const text = msg?.text ?? '';

  // ── Infrastructure bypasses (no reply) ───────────────────────────────────────
  if (msg?.isReaction || msg?.type === 'reaction') return _state('REACTION', {});
  if (isStaff)                                     return _state('STAFF', {});

  // ── Safety gates (ordered: most critical first) ────────────────────────────
  if (isMember)                return _state('MEMBER_SUPPORT', { memberName: msg?.name });
  if (_isCrisis(text))         return _state('CRISIS', {});
  if (_isPayment(msg))         return _state('PAYMENT', { senderName: msg?.name });
  if (SPAM_RE.test(text))      return _state('SPAM', {});
  if (FRUSTRATION_RE.test(text)) return _state('ESCALATED', { reason: 'frustration' });

  // ── Operational intent — fires even for confirmed cold leads ─────────────────
  // A lead who was a prospect 6 months ago and is now a member will hit MEMBER_SUPPORT
  // above. But a lead who signed up between cache cycles may send operational messages.
  const opCheck = checkOperationalIntent(text);
  if (opCheck.blocked) return _state('OPERATIONAL_HOLD', {
    intent: opCheck.intent,
    holdResponse: opCheck.holdResponse,
  });

  // ── Loop guard (before fragment check) ───────────────────────────────────────
  // completedTurns counts user messages that received AI replies.
  // msgCount counts ALL inbound messages from this phone.
  // If 4+ messages arrived but no turns completed, the bot is stuck → escalate.
  // Must run BEFORE the fragment check: a short "שלום" (4 chars) with 4 prior
  // messages would otherwise go to AMBIGUOUS_HOLD instead of ESCALATED.
  if (completedTurns === 0 && msgCount >= 4) {
    return _state('ESCALATED', { reason: 'anti_loop' });
  }

  // ── Identity ambiguity — Arbox down AND no recent confirmed history ───────────
  if (arboxLookupFailed && !hasRecentLeadHistory) {
    return _state('AMBIGUOUS_HOLD', {});
  }

  // ── Fragmented message with no prior context ─────────────────────────────────
  // "אני אבאב", "?", "היי", a single emoji, etc.
  // For first contact, these warrant a warm open question, not qualification.
  if (completedTurns === 0 && _isFragmented(text)) {
    return _state('AMBIGUOUS_HOLD', { reason: 'fragmented_first_message' });
  }

  // ── Normal sales funnel ───────────────────────────────────────────────────────
  if (qualData.callTimeGiven) return _state('CALL_CONFIRMED', { callTime: qualData.callTimeGiven });

  // Callback time arrived on THIS message
  if (qualData.callProposed && !qualData.callTimeGiven && TIME_RE.test(text)) {
    return _state('CALL_CONFIRMED', { callTime: text.slice(0, 80), capturedThisTurn: true });
  }

  if (qualData.callProposed) return _state('INFORMATION_MODE', _buildKnownFacts(qualData));

  if (completedTurns >= 3 && qualData.nameAsked) {
    return _state('CALL_PROPOSAL', _buildKnownFacts(qualData));
  }

  if (completedTurns >= 3 && !qualData.nameAsked) {
    return _state('NAME_COLLECTION', _buildKnownFacts(qualData));
  }

  if (completedTurns === 2) return _state('DISCOVERY_TURN_3', _buildKnownFacts(qualData));
  if (completedTurns === 1) return _state('DISCOVERY_TURN_2', _buildKnownFacts(qualData));

  return _state('DISCOVERY_TURN_1', _buildKnownFacts(qualData));
}

function _state(state, renderHint) {
  return { state, renderHint };
}

function _buildKnownFacts(qualData) {
  const facts = {};
  if (qualData.location)       facts.location       = qualData.location;
  if (qualData.locationViable) facts.locationViable = qualData.locationViable;
  if (qualData.fitnessInterest)facts.fitnessInterest = qualData.fitnessInterest;
  if (qualData.goal)           facts.goal           = qualData.goal;
  if (qualData.workoutStyle)   facts.workoutStyle   = qualData.workoutStyle;
  if (qualData.confirmedName)  facts.confirmedName  = qualData.confirmedName;
  if (qualData.pricingObjection) facts.pricingObjection = true;
  return facts;
}

module.exports = { getState };
