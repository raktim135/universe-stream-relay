// SQLite store (Node's built-in node:sqlite, one file under DATA_DIR).
//
//   settings     runtime settings and app secrets that must survive restarts
//   sessions     viewer connections (live and ended), for history and abuse checks
//   actions      audit log: findings and what was done about them
//   blocks       blocked IPs (temporary or permanent)
//   daily_stats  per day + table: inbound/outbound bytes, viewer time, peak viewers
//   daily_ips    distinct viewer IPs per day
//   nic_daily    per day: network-card totals (Linux), to reconcile with the host
//
// Everything except settings and permanent blocks is kept RETENTION_DAYS.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'relay.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    ip          TEXT NOT NULL,
    event_id    TEXT,
    protocol    TEXT,
    user_agent  TEXT,
    country     TEXT,
    org         TEXT,
    started_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    ended_at    INTEGER,
    bytes_sent  INTEGER NOT NULL DEFAULT 0,
    end_reason  TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_ip ON sessions (ip);
  CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at);

  CREATE TABLE IF NOT EXISTS actions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    ip        TEXT,
    event_id  TEXT,
    rule      TEXT NOT NULL,
    action    TEXT NOT NULL,
    detail    TEXT
  );
  CREATE INDEX IF NOT EXISTS actions_ts ON actions (ts);

  CREATE TABLE IF NOT EXISTS blocks (
    ip          TEXT PRIMARY KEY,
    reason      TEXT,
    source      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    date            TEXT NOT NULL,
    event_id        TEXT NOT NULL,
    in_bytes        INTEGER NOT NULL DEFAULT 0,
    out_bytes       INTEGER NOT NULL DEFAULT 0,
    viewer_seconds  INTEGER NOT NULL DEFAULT 0,
    peak_viewers    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, event_id)
  );

  CREATE TABLE IF NOT EXISTS daily_ips (
    date  TEXT NOT NULL,
    ip    TEXT NOT NULL,
    PRIMARY KEY (date, ip)
  );

  CREATE TABLE IF NOT EXISTS nic_daily (
    date      TEXT PRIMARY KEY,
    rx_bytes  INTEGER NOT NULL DEFAULT 0,
    tx_bytes  INTEGER NOT NULL DEFAULT 0
  );
`);

// "YYYY-MM-DD" in the stats timezone.
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.monitor.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function dayOf(ms = Date.now()) {
  return dayFormat.format(new Date(ms));
}

export function purgeOld() {
  const cutoffMs = Date.now() - config.monitor.retentionDays * 86400000;
  const cutoffDay = dayOf(cutoffMs);
  db.prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoffMs);
  db.prepare('DELETE FROM actions WHERE ts < ?').run(cutoffMs);
  db.prepare('DELETE FROM daily_stats WHERE date < ?').run(cutoffDay);
  db.prepare('DELETE FROM daily_ips WHERE date < ?').run(cutoffDay);
  db.prepare('DELETE FROM nic_daily WHERE date < ?').run(cutoffDay);
  db.prepare('DELETE FROM blocks WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
}

// Sessions still marked live from a previous run ended when that process did.
db.prepare("UPDATE sessions SET ended_at = last_seen, end_reason = 'restart' WHERE ended_at IS NULL").run();
purgeOld();
setInterval(purgeOld, 3600000).unref();
