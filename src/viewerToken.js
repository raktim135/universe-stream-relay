// Viewer tokens, signed by our platform backend with VIEWER_TOKEN_SECRET.
//
//   "<exp>.<sig>"             sig = base64url(HMAC-SHA256(secret, "<exp>"))
//   "<exp>.<ip64>.<sig>"      ip64 = base64url(viewer IP), sig over "<exp>.<ip>"
//
// exp is unix seconds. With VIEWER_TOKEN_BIND_IP=true only the IP-bound form is
// accepted, and only from that IP, so a leaked token is useless elsewhere.

import { createHmac, timingSafeEqual } from 'node:crypto';

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signViewerToken(secret, { ttlSec = 2 * 3600, ip = '' } = {}) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  if (!ip) return `${exp}.${sign(secret, String(exp))}`;
  return `${exp}.${Buffer.from(ip).toString('base64url')}.${sign(secret, `${exp}.${ip}`)}`;
}

function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

// Returns true when the token is genuine, unexpired and (if required) issued for `ip`.
export function verifyViewerToken(secret, token, { ip = '', requireIp = false } = {}) {
  const parts = String(token || '').split('.');
  const exp = Number(parts[0]);
  if (!Number.isInteger(exp) || exp < Date.now() / 1000) return false;
  if (parts.length === 2) {
    return !requireIp && same(parts[1], sign(secret, String(exp)));
  }
  if (parts.length === 3) {
    const boundIp = Buffer.from(parts[1], 'base64url').toString();
    if (!same(parts[2], sign(secret, `${exp}.${boundIp}`))) return false;
    return !requireIp || normalizeIp(boundIp) === normalizeIp(ip);
  }
  return false;
}
