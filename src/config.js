// Central config, read from environment (loaded via `node --env-file=.env`).
//
// Secrets and infrastructure live here. Rules, limits and auto-action switches
// are runtime settings (src/settings.js): editable in the dashboard, persisted,
// with the env values below only as their first-boot defaults.

import path from 'node:path';
import { randomBytes } from 'node:crypto';

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name, fallback = false) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

// "99.0030=https://host/w/xxx 99.0018=https://host/w/yyy" -> Map (URLs have no spaces).
function watchUrls() {
  const out = new Map();
  for (const entry of (process.env.TABLE_WATCH_URLS || '').split(/\s+/).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq > 0) out.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return out;
}

const production = process.env.NODE_ENV === 'production';

export const config = {
  production,
  port: Number(process.env.PORT || 4010),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // nginx runs on the same box: trust X-Forwarded-For from loopback only.
  trustProxy: process.env.TRUST_PROXY || 'loopback',
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),

  // Brand login (to obtain a JWT that the brand casino streaming API accepts)
  brandLoginUrl: req('BRAND_LOGIN_URL', 'https://dream444.win/app/users/userLogin'),
  brandCasinoBase: req('BRAND_CASINO_BASE', 'https://casino.dream444.win'),
  brandUsername: req('BRAND_USERNAME'),
  brandPassword: req('BRAND_PASSWORD'),

  // Optional pre-supplied token (skips auto-login until it expires)
  presetToken: process.env.UNIVERSE_TOKEN || '',

  mediamtx: {
    // Where this app reaches MediaMTX (same box).
    apiUrl: trimSlash(process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997'),
    whipUrl: trimSlash(process.env.MEDIAMTX_WHIP_URL || 'http://127.0.0.1:8889'),
    // Where viewers' browsers reach MediaMTX (public URLs in production).
    publicWebrtcUrl: trimSlash(process.env.MEDIAMTX_PUBLIC_WEBRTC_URL || 'http://localhost:8889'),
    publicHlsUrl: trimSlash(process.env.MEDIAMTX_PUBLIC_HLS_URL || 'http://localhost:8888'),
  },

  relay: {
    // Release a table this long after its last viewer leaves.
    idleMs: Number(process.env.RELAY_IDLE_MS || 30000),
    // Tables kept live even with no viewers, so the first viewer joins instantly.
    prewarm: list('PREWARM_TABLES'),
    // Testing: eventId -> pre-obtained watch page URL (see TABLE_WATCH_URLS in
    // .env.example). Space-separated "eventId=url" pairs. Bypasses the brand's
    // casinoGameWatchLink call for those tables.
    watchUrls: watchUrls(),
  },

  viewer: {
    // Shared with our platform backend, which signs viewer tokens.
    // Required in production; empty in dev = open access.
    tokenSecret: process.env.VIEWER_TOKEN_SECRET || '',
    // Tokens must carry the viewer's IP and are only valid from it.
    bindIp: bool('VIEWER_TOKEN_BIND_IP', false),
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    // Empty = dashboard and admin API disabled.
    password: process.env.ADMIN_PASSWORD || '',
    // Optional Bearer token for scripts calling /admin/api without logging in.
    apiToken: process.env.ADMIN_API_TOKEN || '',
    sessionHours: Number(process.env.ADMIN_SESSION_HOURS || 12),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  monitor: {
    pollMs: Number(process.env.MONITOR_POLL_MS || 5000),
    retentionDays: Number(process.env.RETENTION_DAYS || 15),
    // Day boundaries for the bandwidth report.
    timezone: process.env.STATS_TIMEZONE || 'Asia/Kolkata',
    // Country / hosting-provider lookups from DB-IP Lite (downloaded monthly).
    geoip: bool('GEOIP_ENABLED', true),
  },

  // First-boot defaults for runtime settings (the dashboard can change them later).
  defaults: {
    allowedEmbedDomains: list('ALLOWED_EMBED_DOMAINS'),
    maxConnectionsPerIp: Number(process.env.MAX_CONNECTIONS_PER_IP || 4),
  },

  // Lets MediaMTX tell our own publish/API calls apart from viewers. New every boot.
  internalSecret: randomBytes(24).toString('hex'),

  // Source-stream measurements (src/relay/probe.js). 0 turns the log off.
  probeIntervalMs: Number(process.env.PROBE_INTERVAL_MS ?? 60000),
};

// Production refuses to start half-protected; dev only warns.
export function checkConfig() {
  const problems = [];
  if (config.viewer.tokenSecret.length < 32) {
    problems.push('VIEWER_TOKEN_SECRET must be set (32+ chars): without it anyone can pull the stream');
  }
  if (config.admin.password.length < 12) {
    problems.push('ADMIN_PASSWORD must be set (12+ chars): it protects the dashboard and admin API');
  }
  if (/localhost|127\.0\.0\.1/.test(config.mediamtx.publicWebrtcUrl)) {
    problems.push('MEDIAMTX_PUBLIC_WEBRTC_URL / MEDIAMTX_PUBLIC_HLS_URL still point at localhost');
  }
  if (!config.production) {
    for (const p of problems) console.warn(`[config] dev: ${p}`);
    return;
  }
  if (problems.length) {
    for (const p of problems) console.error(`[config] ${p}`);
    throw new Error('refusing to start in production with the problems above');
  }
}
