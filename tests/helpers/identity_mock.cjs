'use strict';
/**
 * identity_mock.cjs — stand-in for services/identity_resolver.js in suites whose subject is
 * NOT identity (callback lifecycle, phone takeover …) and that run with Arbox unreachable.
 *
 * Usage:  jest.mock('../services/identity_resolver', () => require('./helpers/identity_mock.cjs'));
 *
 * The answer follows the suite's own member_cache / phone_registry mocks: a phone they call
 * a member is `member`, everything else is `unknown` (→ Barak), exactly the world those
 * suites were written for. The real resolver is covered by tests/identity_resolver.test.js.
 */
function answer(phone) {
  let member = false;
  try { member = !!require('../../utils/member_cache').isConfirmed(phone); } catch { /* not mocked */ }
  if (!member) { try { member = !!require('../../utils/phone_registry').isMember(phone); } catch { /* not mocked */ } }
  return { category: member ? 'member' : 'unknown', phone, stale: false, shared: false, ambiguous: false, others: [], userIds: [], name: null, reason: null };
}
const resolver = {
  resolve: async phone => answer(phone),
  peek: phone => answer(phone),
  refresh: async () => ({ membershipsFresh: true, counts: {} }),
  load: () => false,
  phonesIn: () => [],
  summary: () => ({ counts: {}, membershipsFresh: true }),
  ready: true,
};
module.exports = { shared: () => resolver, createIdentityResolver: () => resolver };
