'use strict';

/**
 * tomer_test_mode.js — who the NEW Tomer flow may serve and message.
 *
 * Configuration (deployment variables — they persist across restarts and deploys):
 *   TOMER_MODE                 'all' enables the new flow for every identified member.
 *                              ANYTHING ELSE (including unset) = 'test_only'  ← fail closed
 *   TOMER_TEST_ONLY_PHONES     comma-separated phones the new flow may serve in test_only mode
 *   TOMER_TEST_ROUTE_OVERRIDE  'true' → an allowlisted phone is routed to Tomer even though it
 *                              is not an Arbox member (e.g. a Barak test lead). Its lead record,
 *                              appointments and history are never read-modified by that route.
 *                              Remove the variable (or set 'false') → the phone goes back to its
 *                              normal routing with every stored record exactly as it was.
 *   TOMER_PROACTIVE_ENABLED    'true' AND TOMER_MODE=all → proactive member programs
 *                              (onboarding / retention / segment sends) may run. Otherwise locked.
 *
 * In test_only mode:
 *   • a member who is not on the allowlist is never handled by the new flow and can never
 *     receive a message from it — replies, retries, panel replies and workers all pass
 *     through the same check (server.js → Tomer send wrapper, and tomer_service itself);
 *   • every other phone keeps the routing production had before the new flow existed.
 *
 * Test identity: a route-overridden phone gets SYNTHETIC personal data (membership,
 * bookings, holds) from wrapGateway() below — labelled as such in every source field.
 * It is never looked up in, mapped to, or written to a real Arbox member. Studio-wide
 * reads (the class timetable) still come from the real Arbox.
 */

const digits = p => String(p ?? '').replace(/[^\d]/g, '');
const mode = () => (process.env.TOMER_MODE === 'all' ? 'all' : 'test_only');
const allowlist = () => new Set(String(process.env.TOMER_TEST_ONLY_PHONES ?? '').split(',').map(digits).filter(p => /^\d{9,15}$/.test(p)));

/** May the new Tomer flow handle a message from / send a message to this phone? */
function isAllowed(phone) { return mode() === 'all' || allowlist().has(digits(phone)); }

/** Is this phone routed to Tomer by the explicit test override (regardless of Arbox identity)? */
function routeOverride(phone) {
  return mode() === 'test_only' && process.env.TOMER_TEST_ROUTE_OVERRIDE === 'true' && allowlist().has(digits(phone));
}

const proactiveEnabled = () => mode() === 'all' && process.env.TOMER_PROACTIVE_ENABLED === 'true';

function status() {
  const list = [...allowlist()];
  return {
    mode: mode(), allowlist: list, routeOverrideEnabled: mode() === 'test_only' && process.env.TOMER_TEST_ROUTE_OVERRIDE === 'true',
    routeOverridePhones: list.filter(routeOverride), proactiveEnabled: proactiveEnabled(),
    managerPhone: digits(process.env.TOMER_MANAGER_PHONE) || null,
  };
}

// ── Synthetic test identity ───────────────────────────────────────────────────
const SYNTHETIC_SOURCE = 'נתון מדומה לבדיקה — לא Arbox';
const synId   = phone => `test-${digits(phone)}`;
const isSynId = id => /^test-\d{9,15}$/.test(String(id ?? ''));

/**
 * The gateway Tomer uses. Per-member calls for a synthetic identity are answered here
 * and NEVER reach Arbox; everything else is passed through unchanged.
 */
function wrapGateway(gw) {
  const meta = () => ({ fetchedAt: Date.now(), stale: false, source: SYNTHETIC_SOURCE, synthetic: true });
  const member = id => ({ userId: id, firstName: null, lastName: null, name: 'חבר/ת בדיקה (זהות מדומה)', phone: id.replace('test-', ''), role: 'test', active: true, gender: null, synthetic: true });
  return {
    ...gw,
    async resolveMember(phone) {
      if (routeOverride(phone)) return { status: 'found', member: member(synId(phone)), ...meta() };
      return gw.resolveMember(phone);
    },
    async getMemberById(userId) { return isSynId(userId) ? member(String(userId)) : gw.getMemberById(userId); },
    async getMemberships(userId) {
      if (!isSynId(userId)) return gw.getMemberships(userId);
      return { memberships: [{ membershipUserId: `${userId}-m1`, name: 'מנוי בדיקה (נתון מדומה)', type: 'plan', startDate: '2026-01-01', endDate: '2099-12-31', active: true, cancelled: false, debt: 0 }], ...meta() };
    },
    async getBookings(userId, opts) { return isSynId(userId) ? { bookings: [], ...meta() } : gw.getBookings(userId, opts); },
    async getCancellations(userId, opts) { return isSynId(userId) ? { cancellations: [], ...meta() } : gw.getCancellations(userId, opts); },
    async getHoldStatus(userId, opts) { return isSynId(userId) ? { onHold: false, matchedBy: null, rowFields: [], totalRows: 0, ...meta() } : gw.getHoldStatus(userId, opts); },
    writesEnabled: op => gw.writesEnabled(op),
    async executeWrite(op, args) {
      if (isSynId(args?.userId)) throw new Error('synthetic test identity: Arbox writes are impossible');
      return gw.executeWrite(op, args);
    },
  };
}

module.exports = { mode, allowlist, isAllowed, routeOverride, proactiveEnabled, status, wrapGateway, isSynId, synId, SYNTHETIC_SOURCE };
