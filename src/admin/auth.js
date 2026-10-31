// Admin authentication for the dashboard and /admin/api.
//
//   - Login with ADMIN_USERNAME / ADMIN_PASSWORD -> signed, HttpOnly,
//     SameSite=Strict cookie (Secure in production), ADMIN_SESSION_HOURS long.
//     The signing key mixes in the password, so changing it logs everyone out.
//   - Or `Authorization: Bearer <ADMIN_API_TOKEN>` for scripts.
//   - 5 failed logins per IP per 15 min -> locked out for the rest of the window.
//   - Cookie-authenticated writes must send `X-Requested-With: relay-admin`
//     (cannot be forged cross-site without a CORS preflight we never allow).
//   - No ADMIN_PASSWORD -> the whole admin area answers 404.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { persistentSecret } from '../settings.js';

const COOKIE = 'relay_admin';
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60000;
const failures = new Map(); // ip -> { count, resetAt }

export const adminEnabled = !!config.admin.password;

function key() {
  return createHmac('sha256', persistentSecret('admin-cookie')).update(config.admin.password).digest();
}

function sign(payload) {
  return createHmac('sha256', key()).update(payload).digest('base64url');
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function validCookie(req) {
  const [exp, sig] = (cookies(req)[COOKIE] || '').split('.');
  return Number(exp) > Date.now() && !!sig && same(sig, sign(`${config.admin.username}.${exp}`));
}

function validBearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!(config.admin.apiToken && m && same(m[1], config.admin.apiToken));
}

export function lockedOut(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.resetAt < Date.now()) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILS;
}

// Returns true and sets the cookie on success.
export function login(req, res, username, password) {
  const ok = same(username, config.admin.username) && same(password, config.admin.password);
  if (!ok) {
    const f = failures.get(req.ip) || { count: 0, resetAt: Date.now() + WINDOW_MS };
    f.count += 1;
    failures.set(req.ip, f);
    console.warn(`[admin] failed login from ${req.ip} (${f.count}/${MAX_FAILS})`);
    return false;
  }
  failures.delete(req.ip);
  const exp = Date.now() + config.admin.sessionHours * 3600000;
  res.cookie(COOKIE, `${exp}.${sign(`${config.admin.username}.${exp}`)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.production,
    path: '/admin',
    maxAge: config.admin.sessionHours * 3600000,
  });
  console.log(`[admin] login from ${req.ip}`);
  return true;
}

export function logout(res) {
  res.clearCookie(COOKIE, { path: '/admin' });
}

// For the HTML pages: redirect to the login page when not signed in.
export function requirePage(req, res, next) {
  if (validCookie(req)) return next();
  res.redirect('/admin/login');
}

// For /admin/api.
export function requireApi(req, res, next) {
  if (validBearer(req)) return next();
  if (!validCookie(req)) return res.status(401).json({ error: 'not signed in' });
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'relay-admin') {
    return res.status(403).json({ error: 'missing X-Requested-With header' });
  }
  next();
}
