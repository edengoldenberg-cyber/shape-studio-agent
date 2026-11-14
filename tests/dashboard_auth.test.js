'use strict';
/**
 * dashboard_auth.test.js — middleware/auth.js on a minimal express app.
 *
 * Covers: fail-closed, login, session cookie flags, expiry, tampering, logout that
 * REVOKES the session (also across a restart), CSRF protection of state-changing
 * requests, login attempt limiting, the public list (provider webhooks, health, timetable
 * images), bearer tokens, and that AUTH_DISABLED is ignored in production.
 * Throw-away credentials only; nothing leaves the process.
 */
const express = require('express');
const request = require('supertest');

const PASSWORD = 'test-only-' + Math.random().toString(36).slice(2);
let auth, app;

function build() {
  jest.resetModules();
  auth = require('../middleware/auth');
  app = express();
  auth.mount(app, express);
  app.get('/', (_q, r) => r.send('<html>dashboard</html>'));
  app.get('/health', (_q, r) => r.json({ ok: true }));
  app.get('/api/tomer/cases', (_q, r) => r.json({ ok: true, cases: [] }));
  app.post('/api/tomer/cases/x/resolve', (_q, r) => r.json({ ok: true }));
  app.post('/api/green-api/webhook', (_q, r) => r.sendStatus(200));
  app.post('/api/webhooks/meta', (_q, r) => r.sendStatus(200));
  app.get('/api/admin/timetable-image', (_q, r) => r.send('img'));
  app.post('/api/admin/timetable-image', (_q, r) => r.json({ ok: true }));
}
const cookiesOf = res => Object.fromEntries((res.headers['set-cookie'] ?? []).map(c => [c.split('=')[0], c]));
const val = c => decodeURIComponent(c.split(';')[0].split('=').slice(1).join('='));
async function login(ip = '10.0.0.1') {
  const res = await request(app).post('/auth/login').set('X-Forwarded-For', ip).send({ password: PASSWORD });
  const c = cookiesOf(res);
  return { res, session: val(c.ss_session), csrf: val(c.ss_csrf), raw: c, cookie: `ss_session=${encodeURIComponent(val(c.ss_session))}` };
}

beforeEach(() => {
  process.env.AUTH_DISABLED = 'false';
  process.env.NODE_ENV = 'test';
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  delete process.env.SESSION_SECRET; delete process.env.DASHBOARD_API_TOKEN; delete process.env.SESSION_TTL_HOURS;
  build();
  auth._resetForTests();
});
afterAll(() => { process.env.AUTH_DISABLED = 'true'; process.env.NODE_ENV = 'test'; delete process.env.DASHBOARD_PASSWORD; });

describe('fail closed and the public list', () => {
  test('no password configured → 503 for protected routes; login impossible; health still public', async () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect((await request(app).get('/api/tomer/cases')).status).toBe(503);
    expect((await request(app).get('/').set('Accept', 'text/html')).status).toBe(503);
    expect((await request(app).post('/auth/login').send({ password: '' })).status).toBe(503);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  test('without a session: API → 401, dashboard HTML → login page', async () => {
    expect((await request(app).get('/api/tomer/cases')).status).toBe(401);
    expect((await request(app).post('/api/tomer/cases/x/resolve').send({})).status).toBe(401);
    const html = await request(app).get('/').set('Accept', 'text/html');
    expect(html.status).toBe(302);
    expect(html.headers.location).toBe('/login.html');
  });

  test('provider webhooks and the timetable image stay reachable; writing the image does not', async () => {
    expect((await request(app).post('/api/green-api/webhook').send({})).status).toBe(200);
    expect((await request(app).post('/api/webhooks/meta').send({})).status).toBe(200);
    expect((await request(app).get('/api/admin/timetable-image')).status).toBe(200);
    expect((await request(app).post('/api/admin/timetable-image').send({})).status).toBe(401);
  });

  test('AUTH_DISABLED is ignored in production', async () => {
    process.env.AUTH_DISABLED = 'true'; process.env.NODE_ENV = 'production';
    expect((await request(app).get('/api/tomer/cases')).status).toBe(401);
    process.env.NODE_ENV = 'test';
    expect((await request(app).get('/api/tomer/cases')).status).toBe(200);
  });
});

describe('sessions', () => {
  test('login sets an HttpOnly session cookie and a script-readable CSRF cookie; the password is never echoed', async () => {
    const wrong = await request(app).post('/auth/login').send({ password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const { res, raw, cookie } = await login();
    expect(res.status).toBe(200);
    expect(raw.ss_session).toMatch(/HttpOnly/);
    expect(raw.ss_session).toMatch(/SameSite=Lax/);
    expect(raw.ss_session).toMatch(/Max-Age=604800/);                // 7 days by default
    expect(raw.ss_csrf).not.toMatch(/HttpOnly/);
    expect(raw.ss_csrf).toMatch(/SameSite=Strict/);
    expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toContain(PASSWORD);
    expect((await request(app).get('/api/tomer/cases').set('Cookie', cookie)).status).toBe(200);
    const st = await request(app).get('/auth/status').set('Cookie', cookie);
    expect(st.body).toMatchObject({ authenticated: true, configured: true });
    expect(new Date(st.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('cookies are Secure in production', async () => {
    process.env.NODE_ENV = 'production';
    const { raw } = await login();
    expect(raw.ss_session).toMatch(/; Secure/);
    process.env.NODE_ENV = 'test';
  });

  test('an expired or tampered session is rejected', async () => {
    const { session } = await login();
    expect(auth.validToken(session)).toBe(true);
    expect(auth.validToken(session, Date.now() + 8 * 24 * 3600 * 1000)).toBe(false);      // past its signed expiry
    const [v, exp, sid, sig] = session.split('.');
    const forged = [v, String(Number(exp) + 1000), sid, sig].join('.');                   // expiry extended, signature not
    expect((await request(app).get('/api/tomer/cases').set('Cookie', `ss_session=${forged}`)).status).toBe(401);
    expect((await request(app).get('/api/tomer/cases').set('Cookie', 'ss_session=v2.9999999999999.deadbeef.x')).status).toBe(401);
  });

  test('SESSION_TTL_HOURS shortens the session', async () => {
    process.env.SESSION_TTL_HOURS = '2';
    const { raw } = await login();
    expect(raw.ss_session).toMatch(/Max-Age=7200/);
  });

  test('logout revokes the session: the old cookie stops working, also after a restart', async () => {
    const { cookie } = await login();
    expect((await request(app).get('/api/tomer/cases').set('Cookie', cookie)).status).toBe(200);
    const out = await request(app).post('/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect(cookiesOf(out).ss_session).toMatch(/Max-Age=0/);
    expect((await request(app).get('/api/tomer/cases').set('Cookie', cookie)).status).toBe(401);   // a copied cookie is dead
    build();                                                                                      // process restart
    expect((await request(app).get('/api/tomer/cases').set('Cookie', cookie)).status).toBe(401);
    const again = await login();
    expect((await request(app).get('/api/tomer/cases').set('Cookie', again.cookie)).status).toBe(200);
  });

  test('changing the password ends every session', async () => {
    const { cookie } = await login();
    process.env.DASHBOARD_PASSWORD = PASSWORD + '-new';
    expect((await request(app).get('/api/tomer/cases').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('state-changing requests', () => {
  test('a cookie alone is not enough: the CSRF token is required and must belong to the session', async () => {
    const a = await login('10.0.0.1'), b = await login('10.0.0.2');
    const url = '/api/tomer/cases/x/resolve';
    expect((await request(app).post(url).set('Cookie', a.cookie).send({})).body.error).toBe('csrf_token_invalid');
    expect((await request(app).post(url).set('Cookie', a.cookie).set('X-CSRF-Token', b.csrf).send({})).status).toBe(403);
    expect((await request(app).post(url).set('Cookie', a.cookie).set('X-CSRF-Token', a.csrf).send({})).status).toBe(200);
    expect((await request(app).get('/api/tomer/cases').set('Cookie', a.cookie)).status).toBe(200);    // reads need no token
  });

  test('requests from another site are rejected even with a valid token', async () => {
    const a = await login();
    const url = '/api/tomer/cases/x/resolve';
    const base = () => request(app).post(url).set('Cookie', a.cookie).set('X-CSRF-Token', a.csrf).set('Host', 'panel.example.test');
    expect((await base().set('Origin', 'https://evil.example').send({})).body.error).toBe('cross_origin_rejected');
    expect((await base().set('Sec-Fetch-Site', 'cross-site').send({})).status).toBe(403);
    expect((await base().set('Origin', 'https://panel.example.test').set('Sec-Fetch-Site', 'same-origin').send({})).status).toBe(200);
  });

  test('a bearer token (scripts) works without a cookie or CSRF token; a wrong one does not', async () => {
    process.env.DASHBOARD_API_TOKEN = 'tok-' + Math.random().toString(36).slice(2);
    expect((await request(app).post('/api/tomer/cases/x/resolve').set('Authorization', `Bearer ${process.env.DASHBOARD_API_TOKEN}`).send({})).status).toBe(200);
    expect((await request(app).post('/api/tomer/cases/x/resolve').set('Authorization', 'Bearer wrong').send({})).status).toBe(401);
  });
});

describe('login attempt limiting', () => {
  const attempt = (pw, xff) => request(app).post('/auth/login').set('X-Forwarded-For', xff).send({ password: pw });

  test('5 failures lock that client for 15 minutes — even the right password is refused; other clients are not affected', async () => {
    for (let i = 0; i < 5; i++) expect((await attempt('wrong-' + i, '203.0.113.7')).status).toBe(401);
    expect((await attempt('wrong', '203.0.113.7')).status).toBe(429);
    expect((await attempt(PASSWORD, '203.0.113.7')).status).toBe(429);
    expect((await attempt(PASSWORD, '203.0.113.8')).status).toBe(200);
  });

  test('a client cannot dodge the limit by inventing X-Forwarded-For entries (the proxy-written last entry counts)', async () => {
    for (let i = 0; i < 5; i++) await attempt('wrong', `198.51.100.${i}, 203.0.113.9`);
    expect((await attempt(PASSWORD, '1.2.3.4, 203.0.113.9')).status).toBe(429);
  });

  test('a successful login clears the failure count', async () => {
    for (let i = 0; i < 4; i++) await attempt('wrong', '203.0.113.10');
    expect((await attempt(PASSWORD, '203.0.113.10')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await attempt('wrong', '203.0.113.10')).status).toBe(401);
    expect((await attempt(PASSWORD, '203.0.113.10')).status).toBe(200);
  });

  test('a non-string password is a failure, not an error', async () => {
    expect((await request(app).post('/auth/login').send({ password: { $ne: null } })).status).toBe(401);
    expect((await request(app).post('/auth/login').send({})).status).toBe(401);
  });
});
