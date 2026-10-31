// Blocked IPs (auto or manual, temporary or permanent) and the audit log.

import { db } from '../db.js';

const insertBlock = db.prepare(`
  INSERT INTO blocks (ip, reason, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, source = excluded.source,
    created_at = excluded.created_at, expires_at = excluded.expires_at
`);
const deleteBlock = db.prepare('DELETE FROM blocks WHERE ip = ?');
const selectBlock = db.prepare('SELECT * FROM blocks WHERE ip = ?');
const selectBlocks = db.prepare(
  'SELECT * FROM blocks WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC',
);
const insertAction = db.prepare(
  'INSERT INTO actions (ts, ip, event_id, rule, action, detail) VALUES (?, ?, ?, ?, ?, ?)',
);
const selectActions = db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?');

export function isBlocked(ip) {
  const row = selectBlock.get(ip);
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) {
    deleteBlock.run(ip);
    return null;
  }
  return row;
}

// minutes = null -> permanent
export function blockIp(ip, { reason, source, minutes }) {
  const now = Date.now();
  insertBlock.run(ip, reason || null, source, now, minutes ? now + minutes * 60000 : null);
}

export function unblockIp(ip) {
  return deleteBlock.run(ip).changes > 0;
}

export function listBlocks() {
  return selectBlocks.all(Date.now());
}

export function logAction({ ip = null, eventId = null, rule, action, detail = null }) {
  insertAction.run(Date.now(), ip, eventId, rule, action, detail);
  console.log(`[monitor] ${action}: ${rule}${ip ? ` ${ip}` : ''}${detail ? ` (${detail})` : ''}`);
}

export function recentActions(limit = 200) {
  return selectActions.all(Math.min(Number(limit) || 200, 1000));
}
