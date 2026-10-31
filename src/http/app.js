// HTTP API for our clients, MediaMTX's auth hook and the admin area.
//
//   GET  /health                  -> { ok } (for uptime checks; details are in /admin)
//   GET  /api/video/:eventId      -> { playUrl, whepUrl, hlsUrl } and starts the table
//   GET  /watch/:eventId          -> ready-made player page (iframe it)
//   POST /internal/mediamtx/auth  -> MediaMTX auth hook (localhost only)
//   /admin                        -> dashboard + admin API (login required, see admin/routes.js)
//
// With viewer tokens configured, pass the token as ?token= on /api/video and /watch.

import express from 'express';
import cors from 'cors';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { relays } from '../relay/relayManager.js';
import { authHook, TABLE_ID } from '../mediamtx/authHook.js';
import { verifyViewerToken } from '../viewerToken.js';
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

  // Reject anything that is not a Universe table id before it can start a pull.
  app.param('eventId', (req, res, next, eventId) => {
    if (!TABLE_ID.test(eventId)) return res.status(404).json({ error: 'unknown table' });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/video/:eventId', (req, res) => {
    if (!viewerAllowed(req)) return res.status(401).json({ error: 'invalid viewer token' });
    relays.want(req.params.eventId);
    res.json(streamUrls(req.params.eventId, viewerToken(req)));
  });

  app.get('/watch/:eventId', (req, res) => {
    const { eventId } = req.params;
    const token = viewerToken(req);
    if (viewerAllowed(req)) relays.want(eventId); // start opening while the page loads
    const ancestors = frameAncestors();
    if (ancestors) res.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    const { whepUrl, hlsUrl } = streamUrls(eventId, token);
    const mode = req.query.mode === 'hls' ? 'hls' : 'webrtc';
    res.type('html').send(watchPage({ eventId, whepUrl, hlsUrl, token, mode }));
  });

  return app;
}
