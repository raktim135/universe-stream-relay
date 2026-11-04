// HTTP API for our clients, MediaMTX's auth hook and the admin area.
//
//   GET  /health                  -> { ok } (for uptime checks; details are in /admin)
//   POST /api/watch-link          -> { url } for one table, locked to one IP
//   GET  /api/video/:eventId      -> { playUrl, whepUrl, hlsUrl } and starts the table
//   GET  /watch/:eventId          -> ready-made player page (iframe it)
//   POST /internal/mediamtx/auth  -> MediaMTX auth hook (localhost only)
//   /admin                        -> dashboard + admin API (login required, see admin/routes.js)
//
// With viewer tokens configured, pass the token as ?token= on /api/video and /watch.

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { relays } from '../relay/relayManager.js';
import { authHook, TABLE_ID } from '../mediamtx/authHook.js';
import { signViewerToken, verifyViewerToken } from '../viewerToken.js';
import { adminRouter } from '../admin/routes.js';
import { watchPage } from './watchPage.js';

// The socket peer, not X-Forwarded-For: nginx must never reach /internal.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function viewerToken(req) {
  return typeof req.query.token === 'string' ? req.query.token : '';
}

function viewerAllowed(req) {
  const { tokenSecret, bindIp } = config.viewer;
  if (!tokenSecret) return true;
  return verifyViewerToken(tokenSecret, viewerToken(req), { ip: req.ip, requireIp: bindIp });
}

function streamUrls(eventId, token) {
  const id = encodeURIComponent(eventId);
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return {
    playUrl: `/watch/${id}${q}`,
    whepUrl: `${config.mediamtx.publicWebrtcUrl}/${id}/whep`,
    hlsUrl: `${config.mediamtx.publicHlsUrl}/${id}/index.m3u8`,
  };
}

// Which sites may iframe /watch. "example.com" also covers its subdomains.
function frameAncestors() {
  const domains = getSettings().allowedEmbedDomains;
  if (!domains.length) return config.production ? "'self'" : null; // dev: anyone
  const sources = domains.flatMap((d) => (d.startsWith('*.') ? [`https://${d}`] : [`https://${d}`, `https://*.${d}`]));
  if (!config.production) sources.push('http://localhost:*', 'http://127.0.0.1:*');
  return ["'self'", ...sources].join(' ');
}

// A cross-site iframe whose site is not in the embed list. A direct visit is allowed.
function embedDenied(req) {
  const dest = (req.get('sec-fetch-dest') || '').toLowerCase();
  if (dest !== 'iframe' && dest !== 'frame' && dest !== 'embed' && dest !== 'object') return false;
  const referer = req.get('referer') || '';
  if (!referer) return false;
  let host = '';
  try { host = new URL(referer).hostname.toLowerCase(); } catch { return true; }
  const self = String(req.hostname || '').toLowerCase();
  if (host === self || (self && host.endsWith('.' + self))) return false;
  const domains = getSettings().allowedEmbedDomains.map((d) => d.toLowerCase().replace(/^\*\./, ''));
  if (!domains.length) return config.production;
  return !domains.some((d) => host === d || host.endsWith('.' + d));
}

function watchOrigin() {
  if (config.watchLink.publicBase) return config.watchLink.publicBase;
  const origin = new URL(config.mediamtx.publicWebrtcUrl).origin;
  if (/localhost|127\.0\.0\.1/.test(origin)) return `http://localhost:${config.port}`;
  return origin;
}

// An address nginx will never see from a real viewer. Private and loopback
// links would not play, so they are refused here.
function isPublicIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return false;
    return true;
  }
  return false;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.post(
    '/internal/mediamtx/auth',
    (req, res, next) => (LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] ? next() : res.status(403).end()),
    express.json({ limit: '16kb' }),
    authHook({ onRead: (eventId) => relays.want(eventId) }),
  );

  // Admin is same-origin only: mounted before the public CORS policy.
  app.use('/admin', adminRouter());

  app.use(cors({ origin: config.corsOrigin }));
  app.use('/img', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../img'), { maxAge: '1h' }));

  // Reject anything that is not a Universe table id before it can start a pull.
  app.param('eventId', (req, res, next, eventId) => {
    if (!TABLE_ID.test(eventId)) return res.status(404).json({ error: 'unknown table' });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // The other app sends a table and the viewer's public IP. We return the
  // watch URL. The key is not the viewer token secret.
  app.post('/api/watch-link', express.json({ limit: '4kb' }), (req, res) => {
    const key = config.watchLink.apiKey;
    if (key.length < 16) return res.status(404).json({ error: 'watch links are disabled' });
    const presented = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const a = createHash('sha256').update(key).digest();
    const b = createHash('sha256').update(presented).digest();
    if (!presented || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
    if (!config.viewer.tokenSecret) return res.status(503).json({ error: 'viewer tokens are not configured' });
    if (!config.viewer.bindIp) return res.status(503).json({ error: 'set VIEWER_TOKEN_BIND_IP=true' });

    const eventId = String(req.body?.eventId || '').trim();
    const ip = String(req.body?.ip || '').trim().replace(/^::ffff:/, '');
    const ttl = Number(req.body?.ttl) || 7200;
    if (!TABLE_ID.test(eventId)) return res.status(400).json({ error: 'unknown table' });
    if (!isPublicIp(ip)) return res.status(400).json({ error: 'ip must be a public address' });
    if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86400) {
      return res.status(400).json({ error: 'ttl must be between 60 and 86400 seconds' });
    }

    const token = signViewerToken(config.viewer.tokenSecret, { ttlSec: ttl, ip });
    const exp = Number(token.split('.')[0]);
    const url = `${watchOrigin()}/watch/${encodeURIComponent(eventId)}?token=${encodeURIComponent(token)}`;
    console.log(`[watch-link] ${eventId} for ${ip} until ${new Date(exp * 1000).toISOString()}`);
    res.json({ url, expires: new Date(exp * 1000).toISOString(), ip, eventId });
  });

  app.get('/api/video/:eventId', (req, res) => {
    if (!viewerAllowed(req)) return res.status(401).json({ error: 'invalid viewer token' });
    relays.want(req.params.eventId);
    res.json(streamUrls(req.params.eventId, viewerToken(req)));
  });

  app.get('/watch/:eventId', (req, res) => {
    const { eventId } = req.params;
    const token = viewerToken(req);
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    if (!viewerAllowed(req) || embedDenied(req)) {
      return res.status(403).type('html').send(watchPage({ eventId, denied: true }));
    }
    relays.want(eventId); // start opening while the page loads
    const ancestors = frameAncestors();
    if (ancestors) res.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
    const { whepUrl, hlsUrl } = streamUrls(eventId, token);
    const mode = req.query.mode === 'hls' ? 'hls' : 'webrtc';
    res.type('html').send(watchPage({ eventId, whepUrl, hlsUrl, token, mode }));
  });

  return app;
}
