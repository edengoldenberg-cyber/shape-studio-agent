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
 *   SESSION_SECRET       optional. Signing key for the session cookie (derived from the
 *                        password when unset, so changing the password ends all sessions).
 *   DASHBOARD_API_TOKEN  optional. `Authorization: Bearer <token>` for scripts.
 *   AUTH_DISABLED=true   turns authentication off — honoured ONLY outside production
 *                        (local development and automated tests).
 *
 * FAIL CLOSED: when no password is configured, protected routes answer 503 and nothing
 * is served — a missing variable can never silently expose the dashboard.
 *
 * No credential is logged, stored on disk, or sent to browser code. The cookie is
 * HttpOnly + SameSite=Lax (+ Secure in production) and contains only an expiry and an
 * HMAC signature.
 */

const crypto = require('crypto');

const COOKIE  = 'ss_session';
const TTL_MS  = 30 * 24 * 3600 * 1000;

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

const isDisabled = () => process.env.AUTH_DISABLED === 'true' && process.env.NODE_ENV !== 'production';
const password   = () => process.env.DASHBOARD_PASSWORD || null;
const secret     = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('shape-session:' + (password() ?? '')).digest('hex');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
}
const sign = exp => crypto.createHmac('sha256', secret()).update(String(exp)).digest('hex');
function issueToken(now = Date.now()) { const exp = now + TTL_MS; return `${exp}.${sign(exp)}`; }
function validToken(tok, now = Date.now()) {
  const [exp, sig] = String(tok ?? '').split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  return safeEqual(sig, sign(exp));
}
function readCookie(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function isAuthenticated(req) {
  if (isDisabled()) return true;
  if (!password()) return false;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer && process.env.DASHBOARD_API_TOKEN && safeEqual(bearer, process.env.DASHBOARD_API_TOKEN)) return true;
  return validToken(readCookie(req));
}

/** Cookie-authenticated state changes must come from this site (CSRF defence in depth). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // non-browser client or same-origin GET
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function middleware(req, res, next) {
  if (isPublic(req) || isDisabled()) return next();
  if (!password()) {
    return res.status(503).json({ ok: false, error: 'auth_not_configured', detail: 'DASHBOARD_PASSWORD is not set — the dashboard is locked.' });
  }
  if (isAuthenticated(req)) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers.authorization && !sameOrigin(req)) {
      return res.status(403).json({ ok: false, error: 'cross_origin_rejected' });
    }
    return next();
  }
  const wantsHtml = req.method === 'GET' && !req.path.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html');
  if (wantsHtml) return res.redirect(302, '/login.html');
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ── Login throttling: 5 failures → 15 minutes, per client address ─────────────
const _fails = new Map();
const clientKey = req => String(req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown').split(',')[0].trim();
function throttled(key, now = Date.now()) { const f = _fails.get(key); return !!(f && f.count >= 5 && f.until > now); }
function recordFail(key, now = Date.now()) {
  const f = _fails.get(key);
  const cur = f && f.until > now ? f : { count: 0, until: 0 };
  cur.count += 1; cur.until = now + 15 * 60 * 1000;
  _fails.set(key, cur);
  if (_fails.size > 2000) _fails.delete(_fails.keys().next().value);
}

function cookieHeader(value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function mount(app, express) {
  app.post('/auth/login', express.json({ limit: '4kb' }), (req, res) => {
    if (isDisabled()) return res.json({ ok: true, disabled: true });
    if (!password()) return res.status(503).json({ ok: false, error: 'auth_not_configured' });
    const key = clientKey(req);
    if (throttled(key)) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    if (!safeEqual(req.body?.password, password())) { recordFail(key); return res.status(401).json({ ok: false, error: 'wrong_password' }); }
    _fails.delete(key);
    res.setHeader('Set-Cookie', cookieHeader(issueToken(), Math.floor(TTL_MS / 1000)));
    return res.json({ ok: true });
  });
  app.post('/auth/logout', (_req, res) => { res.setHeader('Set-Cookie', cookieHeader('', 0)); res.json({ ok: true }); });
  app.get('/auth/status', (req, res) => res.json({ ok: true, authenticated: isAuthenticated(req), configured: isDisabled() || !!password() }));
  app.use(middleware);
}

module.exports = { mount, middleware, isPublic, isAuthenticated, issueToken, validToken, _resetForTests: () => _fails.clear() };
