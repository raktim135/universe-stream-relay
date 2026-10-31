// Watches every viewer connection, keeps history and bandwidth, and runs the
// abuse rules.
//
// Rules always detect and report (dashboard, log, Telegram). Their action runs
// only when settings.autoMode and the rule's own switch are on.
//
//   rule                  action switch      action
//   too-many-connections  limitConnections   disconnect the IP's oldest connections
//   many-tables           blockManyEvents    block IP for blockMinutes, disconnect all
//   non-browser           blockNonBrowser    block IP for blockMinutes, disconnect all
//   long-session          kickLongSessions   disconnect that connection
//   foreign               blockForeign       reject / disconnect
//   datacenter            blockDatacenter    reject / disconnect
//
// Manual blocks are always enforced; allowlisted IPs are never touched.

import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings, actionEnabled } from '../settings.js';
import { listViewerSessions, kickSession } from '../mediamtx/api.js';
import { lookup } from './geoip.js';
import { isBlocked, blockIp, logAction } from './blocks.js';
import { alert } from './telegram.js';
import * as bandwidth from './bandwidth.js';

const TOOL_UA = /ffmpeg|lavf|gstreamer|libmpv|\bmpv\b|vlc|curl|wget|python|go-http-client|okhttp|java\/|node-fetch|axios|undici|\bnode\b|obs-studio|streamlink|yt-dlp|httpclient|aiohttp|postman|insomnia|headless/i;
const NOTIFY_COOLDOWN_MS = 30 * 60000;

const live = new Map();        // session id -> tracked session
const kickReasons = new Map(); // session id -> why we disconnected it
const notified = new Map();    // "rule:ip" -> last alert time
let findings = [];             // current suspects, rebuilt each poll
let apiDown = false;
let lastPoll = 0;

const insertSession = db.prepare(`
  INSERT OR IGNORE INTO sessions (id, ip, event_id, protocol, user_agent, country, org, started_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const touchSession = db.prepare('UPDATE sessions SET last_seen = ?, bytes_sent = ? WHERE id = ?');
const endSession = db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?');

function allowlisted(ip) {
  return ip === '127.0.0.1' || ip === '::1' || getSettings().ipAllowlist.includes(ip);
}

function describe(ip) {
  const g = lookup(ip);
  return g ? [g.country, g.org].filter(Boolean).join(', ') : '';
}

// Report a finding once per cooldown (log + Telegram); the dashboard shows it live.
function report(rule, ip, detail, eventId = null) {
  const key = `${rule}:${ip}`;
  const last = notified.get(key) || 0;
  if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
  notified.set(key, Date.now());
  logAction({ ip, eventId, rule, action: 'detected', detail });
  alert(`Suspicious viewer: ${rule}`, [['IP', ip], ['Network', describe(ip)], ['Table', eventId], ['Detail', detail], ['Action', 'none (report only)']]);
}

async function kick(session, reason) {
  kickReasons.set(session.id, reason);
  try {
    await kickSession(session);
  } catch (err) {
    console.warn(`[monitor] kick ${session.id} failed: ${err.message}`);
  }
}

async function act(rule, ip, detail, action, sessions, { block = false, eventId = null } = {}) {
  const { blockMinutes } = getSettings().limits;
  if (block) blockIp(ip, { reason: `${rule}: ${detail}`, source: 'auto', minutes: blockMinutes });
  for (const s of sessions) await kick(s, rule);
  const label = block ? `blocked ${blockMinutes} min, ${sessions.length} disconnected` : action;
  logAction({ ip, eventId, rule, action: block ? 'blocked' : 'kicked', detail: `${detail} -> ${label}` });
  alert(`Auto action: ${rule}`, [['IP', ip], ['Network', describe(ip)], ['Table', eventId], ['Detail', detail], ['Action', label]]);
}

// ---- checks at connect time (from the MediaMTX auth hook) ----

// Returns null to allow, or a reason string to reject.
export async function checkViewer(ip, eventId, protocol) {
  if (!ip || allowlisted(ip)) return null;
  const block = isBlocked(ip);
  if (block) return `blocked (${block.reason || block.source})`;

  const s = getSettings();
  const geo = lookup(ip);
  if (geo?.country && !s.allowedCountries.includes(geo.country)) {
    if (actionEnabled('blockForeign')) {
      report('foreign', ip, `country ${geo.country} rejected`, eventId);
      return `country ${geo.country}`;
    }
  }
  if (geo?.hosting && actionEnabled('blockDatacenter')) {
    report('datacenter', ip, `hosting network ${geo.org} rejected`, eventId);
    return `hosting network ${geo.org}`;
  }

  // WebRTC only: HLS asks the auth hook per request, the poll covers it.
  if (protocol === 'webrtc' && actionEnabled('limitConnections')) {
    const max = s.limits.maxConnectionsPerIp;
    try {
      const mine = (await listViewerSessions())
        .filter((x) => x.ip === ip && x.protocol === 'webrtc' && x.established && !kickReasons.has(x.id))
        .sort((a, b) => a.created - b.created);
      if (mine.length >= max) {
        const oldest = mine.slice(0, mine.length - max + 1);
        await act('too-many-connections', ip, `${mine.length + 1} connections (limit ${max})`,
          `disconnected ${oldest.length} oldest`, oldest, { eventId });
      }
    } catch { /* MediaMTX busy; the poll will catch it */ }
  }
  return null;
}

// ---- periodic poll ----

async function evaluate(all) {
  // Only real viewers, and not ones we are already disconnecting.
  const sessions = all.filter((x) => x.established && !kickReasons.has(x.id));
  const s = getSettings();
  const { maxConnectionsPerIp, maxEventsPerIp, maxSessionHours } = s.limits;
  const byIp = new Map();
  for (const x of sessions) {
    if (!byIp.has(x.ip)) byIp.set(x.ip, []);
    byIp.get(x.ip).push(x);
  }

  const next = [];
  for (const [ip, list] of byIp) {
    if (allowlisted(ip)) continue;
    const geo = lookup(ip);
    const rules = [];
    // acted = its action ran, so it is already logged and alerted as an action
    const flag = (rule, detail, acted = false) => rules.push({ rule, detail, acted });
    list.sort((a, b) => a.created - b.created);

    if (isBlocked(ip)) {
      await act('blocked-ip', ip, 'still connected while blocked', 'disconnected', list);
      continue;
    }

    if (list.length > maxConnectionsPerIp) {
      const detail = `${list.length} connections (limit ${maxConnectionsPerIp})`;
      flag('too-many-connections', detail, actionEnabled('limitConnections'));
      if (actionEnabled('limitConnections')) {
        const oldest = list.slice(0, list.length - maxConnectionsPerIp);
        await act('too-many-connections', ip, detail, `disconnected ${oldest.length} oldest`, oldest);
      }
    }

    const tables = [...new Set(list.map((x) => x.path))];
    if (tables.length > maxEventsPerIp) {
      const detail = `${tables.length} tables at once (limit ${maxEventsPerIp}): ${tables.join(', ')}`;
      flag('many-tables', detail);
      if (actionEnabled('blockManyEvents')) {
        await act('many-tables', ip, detail, '', list, { block: true });
        continue;
      }
    }

    const tool = list.find((x) => TOOL_UA.test(x.userAgent));
    if (tool) {
      const detail = `non-browser client "${tool.userAgent.slice(0, 80)}"`;
      flag('non-browser', detail);
      if (actionEnabled('blockNonBrowser')) {
        await act('non-browser', ip, detail, '', list, { block: true, eventId: tool.path });
        continue;
      }
    }

    for (const x of list) {
      const hours = (Date.now() - x.created) / 3600000;
      if (hours > maxSessionHours) {
        const detail = `connected ${hours.toFixed(1)} h on ${x.path} (limit ${maxSessionHours} h)`;
        flag('long-session', detail, actionEnabled('kickLongSessions'));
        if (actionEnabled('kickLongSessions')) await act('long-session', ip, detail, 'disconnected', [x], { eventId: x.path });
      }
    }

    if (geo?.country && !s.allowedCountries.includes(geo.country)) {
      flag('foreign', `country ${geo.country}`, actionEnabled('blockForeign'));
      if (actionEnabled('blockForeign')) await act('foreign', ip, `country ${geo.country}`, 'disconnected', list);
    }
    if (geo?.hosting) {
      flag('datacenter', `hosting network ${geo.org}`, actionEnabled('blockDatacenter'));
      if (actionEnabled('blockDatacenter')) await act('datacenter', ip, `hosting network ${geo.org}`, 'disconnected', list);
    }

    for (const r of rules) if (!r.acted) report(r.rule, ip, r.detail, list[0].path);
    if (rules.length) {
      next.push({
        ip, country: geo?.country || null, org: geo?.org || null, connections: list.length, tables,
        rules: rules.map(({ rule, detail, acted }) => ({ rule, detail, acted })),
      });
    }
  }
  findings = next;
}

async function poll() {
  let sessions;
  try {
    sessions = await listViewerSessions();
    if (apiDown) console.log('[monitor] MediaMTX API reachable again');
    apiDown = false;
  } catch (err) {
    if (!apiDown) console.warn(`[monitor] MediaMTX API unreachable: ${err.message}`);
    apiDown = true;
    return;
  }
  const now = Date.now();
  lastPoll = now;
  const seen = new Set();
  const perTable = new Map();

  db.exec('BEGIN');
  try {
    for (const s of sessions) {
      seen.add(s.id);
      perTable.set(s.path, (perTable.get(s.path) || 0) + 1);
      bandwidth.noteIp(s.ip);
      let t = live.get(s.id);
      if (!t) {
        const geo = lookup(s.ip);
        insertSession.run(s.id, s.ip, s.path, s.protocol, s.userAgent, geo?.country || null, geo?.org || null, s.created, now);
        t = { lastBytes: 0, lastAt: Math.max(s.created, now - config.monitor.pollMs) };
        live.set(s.id, t);
      }
      const delta = s.bytesSent >= t.lastBytes ? s.bytesSent - t.lastBytes : s.bytesSent;
      bandwidth.addOutbound(s.path, delta);
      bandwidth.addViewerTime(s.path, (now - t.lastAt) / 1000);
      s.kbps = now > t.lastAt ? Math.round((delta * 8) / (now - t.lastAt)) : 0;
      t.lastBytes = s.bytesSent;
      t.lastAt = now;
      t.snapshot = s;
      touchSession.run(now, s.bytesSent, s.id);
    }
    for (const [id] of live) {
      if (seen.has(id)) continue;
      endSession.run(now, kickReasons.get(id) || 'left', id);
      live.delete(id);
      kickReasons.delete(id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.warn(`[monitor] poll write failed: ${err.message}`);
  }

  for (const [eventId, n] of perTable) bandwidth.notePeak(eventId, n);
  bandwidth.notePeak(bandwidth.ALL_TABLES, sessions.length);
  bandwidth.flush();
  await evaluate(sessions);
}

export function startMonitor() {
  const loop = async () => {
    try { await poll(); } catch (err) { console.warn(`[monitor] poll failed: ${err.message}`); }
    setTimeout(loop, config.monitor.pollMs).unref();
  };
  loop();
}

// ---- read side for the admin API ----

export function liveSessions() {
  const now = Date.now();
  return [...live.values()].map(({ snapshot: s }) => {
    const geo = lookup(s.ip);
    return {
      id: s.id,
      ip: s.ip,
      country: geo?.country || null,
      org: geo?.org || null,
      hosting: !!geo?.hosting,
      eventId: s.path,
      protocol: s.protocol,
      transport: s.transport,
      userAgent: s.userAgent,
      since: new Date(s.created).toISOString(),
      durationSec: Math.round((now - s.created) / 1000),
      bytesSent: s.bytesSent,
      kbps: s.kbps || 0,
      packetsLost: s.packetsLost,
    };
  }).sort((a, b) => b.durationSec - a.durationSec);
}

export function liveIps() {
  const byIp = new Map();
  for (const s of liveSessions()) {
    let g = byIp.get(s.ip);
    if (!g) {
      g = { ip: s.ip, country: s.country, org: s.org, hosting: s.hosting, connections: 0, tables: new Set(), longestSec: 0, bytesSent: 0, kbps: 0, userAgents: new Set() };
      byIp.set(s.ip, g);
    }
    g.connections += 1;
    g.tables.add(s.eventId);
    g.longestSec = Math.max(g.longestSec, s.durationSec);
    g.bytesSent += s.bytesSent;
    g.kbps += s.kbps;
    if (s.userAgent) g.userAgents.add(s.userAgent);
  }
  return [...byIp.values()]
    .map((g) => ({ ...g, tables: [...g.tables], userAgents: [...g.userAgents], blocked: !!isBlocked(g.ip) }))
    .sort((a, b) => b.connections - a.connections || b.longestSec - a.longestSec);
}

export function currentFindings() {
  return findings;
}

export function kickById(id, reason = 'admin') {
  const t = live.get(id);
  if (!t) return false;
  kick(t.snapshot, reason);
  logAction({ ip: t.snapshot.ip, eventId: t.snapshot.path, rule: 'manual', action: 'kicked', detail: `session ${id}` });
  return true;
}

export async function kickIp(ip, reason) {
  const list = [...live.values()].map((t) => t.snapshot).filter((s) => s.ip === ip);
  for (const s of list) await kick(s, reason);
  return list.length;
}

export function monitorStatus() {
  return { apiDown, lastPoll: lastPoll ? new Date(lastPoll).toISOString() : null, viewers: live.size };
}

export function sessionHistory({ ip, limit = 200 } = {}) {
  const n = Math.min(Number(limit) || 200, 2000);
  return ip
    ? db.prepare('SELECT * FROM sessions WHERE ip = ? ORDER BY started_at DESC LIMIT ?').all(ip, n)
    : db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(n);
}
