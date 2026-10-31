// Admin area: login, dashboard page and the JSON API behind it.
//
//   GET  /admin                      dashboard (signed in)
//   GET  /admin/login, POST /admin/login, POST /admin/logout
//
//   GET  /admin/api/overview         live totals, tables, today's traffic, service status
//   GET  /admin/api/sessions         every live viewer connection
//   GET  /admin/api/ips              live connections grouped per IP
//   GET  /admin/api/findings         IPs currently matching a rule
//   GET  /admin/api/history?ip=      past connections (last RETENTION_DAYS)
//   GET  /admin/api/actions          audit log
//   GET  /admin/api/bandwidth?from=&to=   daily in/out GB per table
//   GET  /admin/api/stats/:eventId   relay state + source-stream measurements
//   POST /admin/api/sessions/:id/kick
//   GET  /admin/api/blocks, POST /admin/api/blocks {ip, minutes|null, reason}, DELETE /admin/api/blocks/:ip
//   GET  /admin/api/settings, PUT /admin/api/settings {partial}

import { randomBytes } from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { dayOf } from '../db.js';
import { getSettings, updateSettings } from '../settings.js';
import { relays } from '../relay/relayManager.js';
import * as monitor from '../monitor/monitor.js';
import { report as bandwidthReport } from '../monitor/bandwidth.js';
import { listBlocks, blockIp, unblockIp, recentActions, logAction } from '../monitor/blocks.js';
import { geoStatus } from '../monitor/geoip.js';
import { telegramEnabled } from '../monitor/telegram.js';
import { adminEnabled, login, logout, lockedOut, requirePage, requireApi } from './auth.js';
import { loginPage } from './loginPage.js';
import { dashboardPage } from './dashboardPage.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IP = /^[0-9a-fA-F.:]{3,45}$/;

function pageHeaders(res, nonce) {
  res.set({
    'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'`,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
}

function api() {
  const r = express.Router();
  r.use(requireApi, express.json({ limit: '64kb' }), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  r.get('/overview', (_req, res) => {
    const today = dayOf();
    const sessions = monitor.liveSessions();
    res.json({
      viewers: sessions.length,
      ips: new Set(sessions.map((s) => s.ip)).size,
      suspects: monitor.currentFindings().length,
      tables: relays.list(),
      today: bandwidthReport(today, today).days[0] || null,
      autoMode: getSettings().autoMode,
      services: {
        mediamtx: monitor.monitorStatus(),
        geoip: geoStatus(),
        telegram: telegramEnabled,
        production: config.production,
        viewerTokens: !!config.viewer.tokenSecret,
        tokenBindIp: config.viewer.bindIp,
      },
    });
  });

  r.get('/sessions', (_req, res) => res.json(monitor.liveSessions()));
  r.get('/ips', (_req, res) => res.json(monitor.liveIps()));
  r.get('/findings', (_req, res) => res.json(monitor.currentFindings()));
  r.get('/actions', (req, res) => res.json(recentActions(req.query.limit)));

  r.get('/history', (req, res) => {
    const ip = typeof req.query.ip === 'string' && IP.test(req.query.ip) ? req.query.ip : undefined;
    res.json(monitor.sessionHistory({ ip, limit: req.query.limit }));
  });

  r.get('/bandwidth', (req, res) => {
    const to = DAY.test(req.query.to) ? req.query.to : dayOf();
    const from = DAY.test(req.query.from)
      ? req.query.from
      : dayOf(Date.now() - (config.monitor.retentionDays - 1) * 86400000);
    res.json(bandwidthReport(from, to));
  });

  r.get('/stats/:eventId', (req, res) => {
    const status = relays.status(req.params.eventId);
    if (!status) return res.status(404).json({ error: 'table not active' });
    res.json({ ...status, source: relays.probe(req.params.eventId)?.snapshot() || null });
  });

  r.post('/sessions/:id/kick', (req, res) => {
    if (!monitor.kickById(req.params.id)) return res.status(404).json({ error: 'no such live session' });
    res.json({ ok: true });
  });

  r.get('/blocks', (_req, res) => res.json(listBlocks()));

  r.post('/blocks', async (req, res) => {
    const { ip, reason } = req.body || {};
    const minutes = req.body?.minutes == null || req.body.minutes === '' ? null : Number(req.body.minutes);
    if (!IP.test(String(ip || ''))) return res.status(400).json({ error: 'invalid IP' });
    if (minutes !== null && !(minutes > 0)) return res.status(400).json({ error: 'minutes must be positive or empty (permanent)' });
    blockIp(ip, { reason: reason || 'manual', source: 'admin', minutes });
    const kicked = await monitor.kickIp(ip, 'blocked by admin');
    logAction({ ip, rule: 'manual', action: 'blocked', detail: `${minutes ? `${minutes} min` : 'permanent'}${reason ? `: ${reason}` : ''}, ${kicked} disconnected` });
    res.json({ ok: true, kicked });
  });

  r.delete('/blocks/:ip', (req, res) => {
    if (!unblockIp(req.params.ip)) return res.status(404).json({ error: 'not blocked' });
    logAction({ ip: req.params.ip, rule: 'manual', action: 'unblocked' });
    res.json({ ok: true });
  });

  r.get('/settings', (_req, res) => res.json(getSettings()));

  r.put('/settings', (req, res) => {
    try {
      const next = updateSettings(req.body || {});
      logAction({ rule: 'settings', action: 'changed', detail: JSON.stringify(req.body).slice(0, 500) });
      res.json(next);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return r;
}

export function adminRouter() {
  const r = express.Router();
  if (!adminEnabled) {
    console.warn('[admin] ADMIN_PASSWORD not set: dashboard and admin API disabled');
    r.use((_req, res) => res.status(404).json({ error: 'admin disabled' }));
    return r;
  }

  r.get('/login', (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    pageHeaders(res, nonce);
    res.type('html').send(loginPage({ nonce }));
  });

  r.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const nonce = randomBytes(16).toString('base64');
    pageHeaders(res, nonce);
    if (lockedOut(req.ip)) {
      return res.status(429).type('html').send(loginPage({ nonce, error: 'Too many attempts. Try again in 15 minutes.' }));
    }
    if (!login(req, res, String(req.body?.username || ''), String(req.body?.password || ''))) {
      return res.status(401).type('html').send(loginPage({ nonce, error: 'Wrong username or password.' }));
    }
    res.redirect('/admin');
  });

  r.post('/logout', (_req, res) => {
    logout(res);
    res.redirect('/admin/login');
  });

  r.use('/api', api());

  r.get('/', requirePage, (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    pageHeaders(res, nonce);
    res.type('html').send(dashboardPage({ nonce, retentionDays: config.monitor.retentionDays }));
  });

  return r;
}
