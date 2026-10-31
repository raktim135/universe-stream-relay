// Obtains and caches a brand JWT.
//
// The provider socket (wss://casino.unityexch.com/universecasino) and the brand
// casino REST APIs both accept the same brand-issued JWT. It expires in ~5h, so
// we auto-login with the test creds and refresh a few minutes before expiry.

import { config } from './config.js';
import { apiHeaders } from './browser.js';

let cached = { token: '', expMs: 0 };

// Decode the exp claim from a JWT without verifying (we don't hold the secret).
function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function login() {
  // The site lowercases usernames, and its WAF rejects requests without a
  // browser-like User-Agent (returns 504/blocked otherwise).
  const origin = new URL(config.brandLoginUrl).origin;
  const res = await fetch(config.brandLoginUrl, {
    method: 'POST',
    headers: apiHeaders(origin),
    body: JSON.stringify({
      userName: String(config.brandUsername).toLowerCase(),
      password: config.brandPassword,
      // ipInfo is echoed by the site; a minimal object is accepted.
      ipInfo: { status: 'success' },
    }),
  });

  const json = await res.json().catch(() => ({}));
  const token = json?.data?.accessToken;
  if (!res.ok || !token) {
    throw new Error(`Brand login failed (${res.status}): ${json?.meta?.message || 'no token'}`);
  }
  return token;
}

// Returns a valid token, logging in / refreshing as needed.
export async function getToken() {
  const now = Date.now();

  if (cached.token && now < cached.expMs - 3 * 60 * 1000) {
    return cached.token; // still good (>3 min headroom)
  }

  // First call: honour a preset token if provided and not near expiry.
  if (!cached.token && config.presetToken) {
    const exp = jwtExpMs(config.presetToken);
    if (exp - now > 3 * 60 * 1000) {
      cached = { token: config.presetToken, expMs: exp };
      return cached.token;
    }
  }

  const token = await login();
  cached = { token, expMs: jwtExpMs(token) || now + 60 * 60 * 1000 };
  console.log(`[auth] logged in as ${config.brandUsername}; token valid until ${new Date(cached.expMs).toISOString()}`);
  return cached.token;
}

export function invalidateToken() {
  cached = { token: '', expMs: 0 };
}
