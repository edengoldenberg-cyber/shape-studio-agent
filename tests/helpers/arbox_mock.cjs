'use strict';
/**
 * arbox_mock.cjs — a local HTTP stand-in for the Arbox public API (loopback only).
 *
 * Mirrors the routes and field names observed on the real API with GET-only probes.
 * The write routes implement the ASSUMED contract (unverified against Arbox) so the
 * action engine's durability / verification logic can be exercised; they prove nothing
 * about the real request format.
 *
 * State is plain data on `mock.state`; failure modes on `mock.mode`.
 */
const http = require('http');

function createArboxMock() {
  const state = {
    users: [], memberships: [], schedule: [], bookings: [], cancellations: [], holds: [], membershipTypes: [], transactions: [],
  };
  const mode = {
    down: false,            // every request → 503
    hang: false,            // every GET never answers (client timeout)
    occupancyDown: false,   // classesSummaryReport → 500
    write: 'success',       // 'success' | 'reject' | 'timeout_after_apply' | 'timeout_no_apply' | 'accept_no_apply' | 'error500_no_apply'
  };
  const log = [];           // { method, path, query, body }

  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const between = (d, a, b) => (!a || d >= a) && (!b || d <= b);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/public/, '');
    const q = Object.fromEntries(url.searchParams);
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
      log.push({ method: req.method, path: p, query: q, body });
      // one-shot hook: mutate state right AFTER a studio-wide report was answered (simulates a change between snapshot and send)
      const hk = !q.user_id && mode.after && mode.after[p];
      if (hk) { delete mode.after[p]; res.on('finish', () => hk(state)); }
      if (mode.down) return send(res, 503, { error: { message: 'unavailable' } });
      if (req.method === 'GET' && mode.hang) return; // never answers

      if (req.method === 'GET') {
        if (p === '/v3/users' && mode.usersDown) return send(res, 500, { error: { message: 'users failed' } });
        if (p === '/v3/users/memberships' && mode.membershipsDown) return send(res, 500, { error: { message: 'memberships failed' } });
        if (p === '/v3/users/memberships' && !q.user_id && q.page) {          // studio-wide read: paged like the real API
          const page = Number(q.page), limit = Number(q.limit ?? 200);
          return send(res, 200, { data: state.memberships.slice((page - 1) * limit, page * limit), extra: { pagination: { next_page_url: page * limit < state.memberships.length ? 'next' : null } } });
        }
        if (p === '/v3/users') {
          const page = Number(q.page ?? 1), limit = Number(q.limit ?? 200);
          const slice = state.users.slice((page - 1) * limit, page * limit);
          return send(res, 200, { data: slice, extra: { pagination: { next_page_url: page * limit < state.users.length ? 'next' : null } } });
        }
        if (p === '/v3/users/memberships') return send(res, 200, { data: state.memberships.filter(m => !q.user_id || String(m.user_id) === String(q.user_id)) });
        if (p === '/v3/schedule') return send(res, 200, { data: state.schedule.filter(c => between(c.date, q.from_date, q.to_date)).map(({ registration_count, standby_members, status, ...c }) => c), extra: { pagination: { next_page_url: null } } });
        if (p === '/v3/reports/classesSummaryReport') {
          if (mode.occupancyDown) return send(res, 500, { error: { message: 'report failed' } });
          return send(res, 200, { data: state.schedule.filter(c => between(c.date, q.fromDate, q.toDate)).map(c => ({ schedule_id: c.schedule_id, date: c.date, start_time: c.start_time, registration_count: c.registration_count ?? 0, standby_members: c.standby_members ?? 0, status: c.status ?? 'active', service_type: 'class' })) });
        }
        // The real report honours ?user_id; cancellation report IGNORES it (returns all rows).
        if (p === '/v3/reports/bookingsReport' && mode.bookingsDown) return send(res, 500, { error: { message: 'report failed' } });
        if (p === '/v3/reports/bookingsReport' && q.fromDate && q.toDate && (new Date(q.toDate) - new Date(q.fromDate)) / 86400000 > 31) return send(res, 400, { error: { message: { toDate: ['The date range should not exceed 31 days.'] } } });
        if (p === '/v3/reports/bookingsReport') return send(res, 200, { data: state.bookings.filter(b => between(b.date, q.fromDate, q.toDate) && (!q.user_id || String(b.user_id) === String(q.user_id))) });
        if (p === '/v3/reports/bookingCancellationReport') return send(res, 200, { data: state.cancellations.filter(c => between(c.date, q.fromDate, q.toDate)) });
        if (p === '/v3/reports/membersOnHoldReport' && mode.holdsDown) return send(res, 500, { error: { message: 'report failed' } });
        // As measured on the real Arbox (2026-11-18): the report returns the holds whose END date is inside the range, and
        // refuses a range longer than 31 days. Rows without the real field names (older tests) are returned for any range.
        if (p === '/v3/reports/membersOnHoldReport' && q.fromDate && q.toDate && (new Date(q.toDate) - new Date(q.fromDate)) / 86400000 > 31) return send(res, 400, { error: { message: { toDate: ['The date range should not exceed 31 days.'] } } });
        if (p === '/v3/reports/membersOnHoldReport') return send(res, 200, { data: state.holds.filter(h => !h.end_suspend_time || between(h.end_suspend_time, q.fromDate, q.toDate)), extra: { pagination: { next_page_url: null } } });
        if (p === '/v3/membershipTypes') return send(res, 200, { data: state.membershipTypes, extra: { pagination: { next_page_url: null } } });
        if (p === '/v3/reports/transactionsReport') {
          if (mode.billingDown) return send(res, 500, { error: { message: 'report failed' } });
          return send(res, 200, { data: state.transactions.filter(t => between(t.transaction_date, q.fromDate, q.toDate)), extra: { pagination: { next_page_url: null } } });
        }
        return send(res, 404, { error: { message: 'not found' } });
      }

      if (req.method === 'POST' && (p === '/v3/users/memberships/hold' || p === '/v3/users/memberships/cancel')) {
        const apply = () => {
          if (p.endsWith('/hold')) state.holds.push({ user_id: body.user_id, membership_user_id: body.membership_user_id, start_date: body.start_date, end_date: body.end_date });
          else { const m = state.memberships.find(x => String(x.membership_user_id) === String(body.membership_user_id)); if (m) { m.cancelled = 1; m.active = 0; } }
        };
        switch (mode.write) {
          case 'reject':              return send(res, 422, { error: { message: 'membership cannot be changed' } });
          case 'timeout_after_apply': apply(); return;            // applied, but the client never hears back
          case 'timeout_no_apply':    return;                     // lost
          case 'accept_no_apply':     return send(res, 200, { data: { ok: true } });
          case 'error500_no_apply':   return send(res, 500, { error: { message: 'server error' } });
          default:                    apply(); return send(res, 200, { data: { ok: true } });
        }
      }
      // Booking / cancelling ONE class for a member. Modelled on the real answers seen on 2026-11-18 (owner-approved
      // verification): bookSession → 200 { booking_id: <schedule id>, date, start_time, … }, cancelUserBooking → 200
      // { message: 'successfully cancelled user booking' }; a refusal is a 4xx, a server fault a 500 that changes nothing.
      if (req.method === 'POST' && (p === '/v3/schedule/bookSession' || p === '/v3/schedule/cancelUserBooking')) {
        const cls = state.schedule.find(c => String(c.schedule_id) === String(body.schedule_id));
        const mine = b => String(b.user_id) === String(body.user_id) && cls && b.date === cls.date && b.time === cls.start_time && b.class_name === cls.session_name;
        const book = p.endsWith('/bookSession');
        const apply = () => {
          if (!cls) return false;
          if (book) {
            if (state.bookings.some(mine)) return false;
            const m = state.memberships.find(x => String(x.user_id) === String(body.user_id));
            state.bookings.push({ user_id: Number(body.user_id), date: cls.date, time: cls.start_time, class_name: cls.session_name, staff_member: cls.staff_member?.name ?? null, check_in: 'No', sessions_left: null, membership_type_name: m?.membership_type_name ?? null });
            cls.registration_count = (cls.registration_count ?? 0) + 1;
          } else {
            const i = state.bookings.findIndex(mine); if (i < 0) return false;
            state.bookings.splice(i, 1);
            state.cancellations.push({ user_id: Number(body.user_id), schedule_id: String(cls.schedule_id), date: cls.date, start_time: `${cls.date} ${cls.start_time}`, class_name: cls.session_name, cancelled_time: new Date().toISOString() });
            cls.registration_count = Math.max(0, (cls.registration_count ?? 1) - 1);
          }
          return true;
        };
        const okBody = () => (book ? { statusCode: 200, data: { booking_id: Number(body.schedule_id), schedule_id: null, date: cls?.date ?? null, start_time: cls?.start_time ?? null, end_time: cls?.end_time ?? null }, extra: [] } : { statusCode: 200, data: { message: 'successfully cancelled user booking' }, extra: [] });
        switch (mode.write) {
          case 'reject':              return send(res, 422, { error: { message: book ? 'user cannot be booked to this session' : 'booking cannot be cancelled' } });
          case 'timeout_after_apply': apply(); return;
          case 'timeout_no_apply':    return;
          case 'accept_no_apply':     return send(res, 200, okBody());
          case 'error500_no_apply':   return send(res, 500, { statusCode: 500, error: { name: 'INTERNAL SERVER ERROR', code: 500, message: 'An unexpected server error occurred.' }, data: null });
          default:                    return apply() ? send(res, 200, okBody()) : send(res, 422, { error: { message: 'not applicable' } });
        }
      }
      return send(res, 405, { error: { message: 'method not allowed' } });
    });
  });

  return {
    state, mode, log,
    writes: () => log.filter(l => l.method !== 'GET'),
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/api/public`))),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    reset() {
      for (const k of Object.keys(state)) state[k].length = 0;
      Object.assign(mode, { down: false, hang: false, occupancyDown: false, write: 'success', bookingsDown: false, billingDown: false, holdsDown: false, usersDown: false, membershipsDown: false, after: null });
      log.length = 0;
    },
  };
}

module.exports = { createArboxMock };
