'use strict';

/**
 * Pure lead-ownership helpers — no IO, no logger, no server globals.
 * Both the HTTP handlers in server.js and the test suite use these so the
 * release algorithm is never duplicated.
 */

const AUTOMATION_STATES = new Set([
  'new', 'cold', 'warm', 'hot', 'call_scheduled', 'callback_requested',
]);

/**
 * Determine which status to restore after human ownership is released.
 * Does NOT mutate the store — returns the target status string.
 *
 * Priority (matches the server.js release endpoint):
 *   1. optedOutAt / previousStatus=opted_out       → opted_out
 *   2. isConfirmedMember / isMember() / converted_member → converted_member
 *   3. previousStatus if in AUTOMATION_STATES       → previousStatus
 *   4. fallback                                     → cold
 *
 * @param {object} meta - lead.meta object
 * @param {function} [isMember] - optional phone→boolean check (phoneRegistry.isMember)
 * @param {string} [phone] - passed to isMember when provided
 */
function computeReleaseStatus(meta, isMember, phone) {
  if (meta.optedOutAt || meta.previousStatus === 'opted_out') return 'opted_out';
  if (meta.isConfirmedMember || (isMember && isMember(phone)) || meta.previousStatus === 'converted_member') {
    return 'converted_member';
  }
  return AUTOMATION_STATES.has(meta.previousStatus) ? meta.previousStatus : 'cold';
}

/**
 * Release human ownership on a lead.
 * Clears all humanOwns* fields, sets humanReleasedAt, restores the
 * appropriate automation status.
 *
 * Returns { status, automationResumed } or null if the lead does not exist.
 * Caller is responsible for persist.saveLeads(), logger, broadcastSse, etc.
 */
function releaseOwnership(store, phone, { isMember } = {}) {
  const existing = store.getLead(phone);
  if (!existing) return null;

  // Idempotent: only act when ownership is actually held.
  // Calling release on an already-released lead must NOT change the current
  // status or metadata — the lead's real state takes priority over fallback logic.
  if (existing.status !== 'human_owns') {
    return { status: existing.status, automationResumed: false, unchanged: true };
  }

  const meta   = existing.meta ?? {};
  const status = computeReleaseStatus(meta, isMember, phone);
  const clear  = {
    humanOwnsReason: null,
    humanOwnsSince:  null,
    humanOwnsBy:     null,
    humanReleasedAt: new Date().toISOString(),
    previousStatus:  null,
  };
  store.upsertLead(phone, { status, meta: Object.assign({}, meta, clear) });
  return { status, automationResumed: status !== 'opted_out' && status !== 'converted_member' };
}

module.exports = { releaseOwnership, computeReleaseStatus };
