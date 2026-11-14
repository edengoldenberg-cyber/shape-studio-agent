#!/usr/bin/env node
/** Fourth READ-ONLY pass: OPTIONS/GET only. Booking sub-routes and registered webhooks (event names + hosts only). */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const axios = require('axios');
const LOC = process.env.ARBOX_LOCATION_ID ?? '19392';
const BASE = process.env.ARBOX_BASE_URL ?? 'https://arboxserver.arboxapp.com/api/public';
if (/localhost|127\.0\.0\.1/.test(BASE)) { console.error('BASE points at a mock'); process.exit(2); }
const http = axios.create({ baseURL: BASE, headers: { apiKey: process.env.ARBOX_CLIENT_ID, Accept: 'application/json' }, timeout: 25000, validateStatus: () => true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const opt = async p => { await sleep(250); return http.request({ method: 'OPTIONS', url: p, params: { location_id: LOC } }); };
const get = async (p, params = {}) => { await sleep(250); return http.get(p, { params: { location_id: LOC, ...params } }); };
(async () => {
  const words = ['', 'trial', 'checkIn', 'checkin', 'cancel', 'create', 'add', 'register', 'insert', 'new', 'store', 'book', 'member', 'user', 'client', 'lead', 'standby', 'standBy', 'waitlist', 'waitingList', 'late', 'lateCancel', 'remove', 'delete', 'update', 'uncheckIn', 'checkOut', 'approve', 'regular', 'regulars', 'recurring', 'series', 'workshop', 'appointment', 'session', 'class', 'group', 'membership', 'restore', 'move', 'swap', 'transfer', 'status', 'list', 'all'];
  console.log('── /v3/schedule/booking/* (OPTIONS) ──');
  for (const w of words) {
    const p = '/v3/schedule/booking' + (w ? '/' + w : '');
    const r = await opt(p);
    const allow = r.headers.allow ?? '-';
    if (r.status !== 404 && allow !== '-') console.log(`  ${p.padEnd(40)} ${r.status} allow=${allow}`);
  }
  console.log('── other prefixes (OPTIONS) ──');
  for (const p of ['/v3/schedule/booking', '/v3/schedule/standby', '/v3/schedule/standBy', '/v3/schedule/waitingList', '/v3/schedule/checkIn', '/v3/leads/updateStatus', '/v3/leads/lost', '/v3/leads/convert', '/v3/users/memberships/hold/cancel', '/v3/users/memberships/unhold', '/v3/users/memberships/hold/remove', '/v3/users/memberships/hold/delete', '/v3/users/memberships/hold/update']) {
    const r = await opt(p); console.log(`  ${p.padEnd(40)} ${r.status} allow=${r.headers.allow ?? '-'}`);
  }
  const g = await get('/v3/schedule/booking/trial', { limit: 2 });
  console.log('\nGET /v3/schedule/booking/trial', g.status, 'top-level keys:', Object.keys(g.data ?? {}), 'data type:', Array.isArray(g.data?.data) ? 'array×' + g.data.data.length : typeof g.data?.data, g.data?.data?.[0] ? 'fields: ' + Object.keys(g.data.data[0]).join(',') : '');
  const wh = await get('/v3/webhooks');
  console.log('\nregistered Arbox webhooks:');
  for (const w of wh.data?.data ?? []) { let host = '?'; try { host = new URL(w.url).host; } catch {} console.log(`  type=${w.type} event=${w.event} host=${host}`); }
})().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
