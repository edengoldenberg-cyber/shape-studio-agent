'use strict';

/**
 * auth.js — dashboard / API authentication.
 *
 * Everything is protected except the explicit public list below (provider webhooks,
 * health, version, the calendar .ics link sent to staff, and the timetable images that
 * the WhatsApp provider downloads by URL).
 *
 * Configuration:
 *   DASHBOARD_PASSWORD   required. Shared staff password for the login page.
 *   SESSION_SECRET       optional. Signing key for sessions (derived from the password
 *                        when unset, so changing the password ends all sessions).
 *   SESSION_TTL_HOURS    optional. Session lifetime, default 168 (7 days), 1–720.
 *   DASHBOARD_API_TOKEN  optional. `Authorization: Bearer <token>` for scripts.
 *   AUTH_DISABLED=true   turns authentication off — honoured ONLY outside production
 *                        (local development and automated tests).
 *
 * FAIL CLOSED: when no password is configured, protected routes answer 503 and nothing
 * is served — a missing variable can never silently expose the dashboard.
 *
 * Sessions: a signed token (expiry + random session id) in an HttpOnly, SameSite=Lax
 * cookie (+ Secure in production). Logout REVOKES the session id server-side (persisted
 * in DATA_DIR/auth_sessions.json), so a copied cookie stops working — also after a
 * restart. Expired sessions are rejected by their signed expiry.
 *
 * State-changing requests (anything but GET/HEAD/OPTIONS) made with a session cookie
 * must also (1) come from this origin and (2) carry the session's CSRF token in the
 * `X-CSRF-Token` header. The token is readable by this site's own scripts only
 * (cookie `ss_csrf`, SameSite=Strict). Bearer-token requests are exempt (no cookie).
 *
 * Login attempts: 5 failures per client address → 15 minutes locked; every failure is
 * delayed, more so while failures are frequent overall.
 *
 * No credential is logged, stored on disk, or sent to browser code.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const COOKIE      = 'ss_session';
const CSRF_COOKIE = 'ss_csrf';
const ttlMs = () => { const h = Number(process.env.SESSION_TTL_HOURS); return (Number.isFinite(h) && h >= 1 && h <= 720 ? h : 168) * 3600 * 1000; };

const PUBLIC_EXACT = new Set(['/health', '/api/version', '/login.html', '/auth/login', '/auth/logout', '/auth/status', '/favicon.ico',
  '/api/admin/timetable-image', '/api/admin/timetable2-image', '/schedule.png']);
const PUBLIC_RE = [
  /(?:^|\/)webhooks?(?:\/|$)/,                          // provider webhooks (each has its own verification)
  /^\/api\/calendar\/appointment\/[^/]+\.ics$/,         // calendar link sent to staff
];
function isPublic(req) {
  const p = req.path;
  if (PUBLIC_EXACT.has(p)) return p.startsWith('/api/admin/') || p === '/schedule.png' ? req.method === 'GET' : true;
  return PUBLIC_RE.some(r => r.test(p));
}

// "Production" = NODE_ENV=production OR running on the hosting platform at all (the
// deployed service runs with NODE_ENV=development, so NODE_ENV alone cannot be trusted).
const isProd     = () => process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT_NAME || !!process.env.RAILWAY_PROJECT_ID;
const isDisabled = () => process.env.AUTH_DISABLED === 'true' && !isProd();
const password   = () => process.env.DASHBOARD_PASSWORD || null;
const secret     = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('shape-session:' + (password() ?? '')).digest('hex');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
}
const hmac = s => crypto.createHmac('sha256', secret()).update(String(s)).digest('hex');

// ── Revoked sessions (logout) — persisted so a restart does not revive them ───
const revFile = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'auth_sessions.json');
let _revoked = null;   // Map<sid, expMs>
function revoked() {
  if (_revoked) return _revoked;
  _revoked = new Map();
  try { for (const [sid, exp] of Object.entries(JSON.parse(fs.readFileSync(revFile(), 'utf8')).revoked ?? {})) _revoked.set(sid, Number(exp)); } catch { /* none yet */ }
  return _revoked;
}
function revoke(sid, exp, now = Date.now()) {
  const m = revoked();
  for (const [k, e] of m) if (e < now) m.delete(k);     // an expired token needs no revocation entry
  m.set(sid, exp);
  try {
    const tmp = revFile() + '.tmp';
    fs.mkdirSync(path.dirname(revFile()), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ revoked: Object.fromEntries(m) }), 'utf8');
    fs.renameSync(tmp, revFile());
  } catch { /* still revoked in memory for this process */ }
}

// ── Session tokens: v2.<expMs>.<sid>.<hmac> ──────────────────────────────────
function issueToken(now = Date.now()) {
  const exp = now + ttlMs(), sid = crypto.randomBytes(16).toString('hex');
  return `v2.${exp}.${sid}.${hmac(`${exp}.${sid}`)}`;
}
function parseToken(tok, now = Date.now()) {
  const [v, exp, sid, sig] = String(tok ?? '').split('.');
  if (v !== 'v2' || !/^\d+$/.test(exp ?? '') || !/^[0-9a-f]{32}$/.test(sid ?? '') || !sig) return null;
  if (Number(exp) < now) return null;
  if (!safeEqual(sig, hmac(`${exp}.${sid}`))) return null;
  if (revoked().has(sid)) return null;
  return { exp: Number(exp), sid };
}
const validToken = (tok, now) => !!parseToken(tok, now);
const csrfFor = sid => hmac('csrf:' + sid);

function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
  }
  return null;
}
function bearerOk(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  return !!(bearer && process.env.DASHBOARD_API_TOKEN && safeEqual(bearer, process.env.DASHBOARD_API_TOKEN));
}
const session = req => (password() ? parseToken(readCookie(req)) : null);
function isAuthenticated(req) {
  if (isDisabled()) return true;
  if (!password()) return false;
  return bearerOk(req) || !!session(req);
}

/** A cookie-authenticated state change must come from this site. */
function sameOrigin(req) {
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;                       // non-browser client; the CSRF token is still required
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function middleware(req, res, next) {
  if (isPublic(req) || isDisabled()) return next();
  if (!password()) {
    return res.status(503).json({ ok: false, error: 'auth_not_configured', detail: 'DASHBOARD_PASSWORD is not set — the dashboard is locked.' });
  }
  if (bearerOk(req)) return next();
  const s = session(req);
  if (s) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'cross_origin_rejected' });
      if (!safeEqual(req.headers['x-csrf-token'], csrfFor(s.sid))) return res.status(403).json({ ok: false, error: 'csrf_token_invalid' });
    }
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    return next();
  }
  const wantsHtml = req.method === 'GET' && !req.path.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html');
  if (wantsHtml) return res.redirect(302, '/login.html');
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ── Login throttling ─────────────────────────────────────────────────────────
// Per client address: 5 failures → locked for 15 minutes. The address is the LAST
// X-Forwarded-For entry (the one written by the platform proxy; earlier entries are
// supplied by the client and cannot be trusted), else the socket address.
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 5;
const _fails = new Map();
let _recent = [];                                  // timestamps of recent failures, all clients
function clientKey(req) {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : String(req.socket?.remoteAddress ?? req.ip ?? 'unknown');
}
function throttled(key, now = Date.now()) { const f = _fails.get(key); return !!(f && f.count >= MAX_FAILS && f.until > now); }
function recordFail(key, now = Date.now()) {
  const f = _fails.get(key);
  const cur = f && f.until > now ? f : { count: 0, until: 0 };
  cur.count += 1; cur.until = now + WINDOW_MS;
  _fails.set(key, cur);
  if (_fails.size > 2000) _fails.delete(_fails.keys().next().value);
  _recent = _recent.filter(t => t > now - WINDOW_MS); _recent.push(now);
}
const failDelayMs = () => (process.env.NODE_ENV === 'test' ? 0 : _recent.length > 20 ? 1500 : 400);

function cookieHeader(name, value, maxAgeSec, { httpOnly = true, sameSite = 'Lax' } = {}) {
  const secure = isProd() ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; ${httpOnly ? 'HttpOnly; ' : ''}SameSite=${sameSite}; Max-Age=${maxAgeSec}${secure}`;
}

function mount(app, express) {
  app.post('/auth/login', express.json({ limit: '4kb' }), async (req, res) => {
    if (isDisabled()) return res.json({ ok: true, disabled: true });
    if (!password()) return res.status(503).json({ ok: false, error: 'auth_not_configured' });
    const key = clientKey(req);
    if (throttled(key)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    if (typeof req.body?.password !== 'string' || !safeEqual(req.body.password, password())) {
      recordFail(key);
      const d = failDelayMs(); if (d) await new Promise(r => setTimeout(r, d));
      return res.status(401).json({ ok: false, error: 'wrong_password' });
    }
    _fails.delete(key);
    const tok = issueToken(); const { sid } = parseToken(tok); const age = Math.floor(ttlMs() / 1000);
    res.setHeader('Set-Cookie', [cookieHeader(COOKIE, tok, age), cookieHeader(CSRF_COOKIE, csrfFor(sid), age, { httpOnly: false, sameSite: 'Strict' })]);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true });
  });
  app.post('/auth/logout', (req, res) => {
    const s = session(req);
    if (s) revoke(s.sid, s.exp);
    res.setHeader('Set-Cookie', [cookieHeader(COOKIE, '', 0), cookieHeader(CSRF_COOKIE, '', 0, { httpOnly: false, sameSite: 'Strict' })]);
    res.json({ ok: true });
  });
  app.get('/auth/status', (req, res) => {
    const s = isDisabled() ? null : session(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, authenticated: isAuthenticated(req), configured: isDisabled() || !!password(), authDisabled: isDisabled(),
      expiresAt: s ? new Date(s.exp).toISOString() : null });
  });
  app.use(middleware);
}

module.exports = { mount, middleware, isPublic, isAuthenticated, issueToken, validToken, parseToken, csrfFor,
  COOKIE, CSRF_COOKIE, _resetForTests: () => { _fails.clear(); _recent = []; _revoked = null; } };
