// Daily traffic accounting, per table, in the stats timezone.
//
//   inbound   bytes received from the vendor (RTP header + payload, counted in the relay)
//   outbound  bytes MediaMTX sent to viewers (per-session counters, WebRTC + HLS)
//   viewer time, peak concurrent viewers, distinct viewer IPs
//   nic       whole-machine network-card totals (Linux /proc/net/dev), which also
//             include encryption/UDP/IP overhead, to compare with the host's bill
//
// Counts are buffered in memory and written on each monitor poll.

import fs from 'node:fs';
import { db, dayOf } from '../db.js';

const ALL = '*'; // row holding whole-service peak viewers

const pending = new Map(); // eventId -> { in, out, seconds }
const peaks = new Map();   // eventId -> peak seen this poll
const ips = new Set();
let nicLast = null;

function bucket(eventId) {
  let b = pending.get(eventId);
  if (!b) {
    b = { in: 0, out: 0, seconds: 0 };
    pending.set(eventId, b);
  }
  return b;
}

export function addInbound(eventId, bytes) {
  bucket(eventId).in += bytes;
}

export function addOutbound(eventId, bytes) {
  if (bytes > 0) bucket(eventId).out += bytes;
}

export function addViewerTime(eventId, seconds) {
  if (seconds > 0) bucket(eventId).seconds += seconds;
}

export function notePeak(eventId, viewers) {
  peaks.set(eventId, Math.max(peaks.get(eventId) || 0, viewers));
}

export function noteIp(ip) {
  ips.add(ip);
}

function readNic() {
  try {
    let rx = 0;
    let tx = 0;
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    return { rx, tx };
  } catch {
    return null; // not Linux
  }
}

const upsertStats = db.prepare(`
  INSERT INTO daily_stats (date, event_id, in_bytes, out_bytes, viewer_seconds, peak_viewers)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(date, event_id) DO UPDATE SET
    in_bytes = in_bytes + excluded.in_bytes,
    out_bytes = out_bytes + excluded.out_bytes,
    viewer_seconds = viewer_seconds + excluded.viewer_seconds,
    peak_viewers = MAX(peak_viewers, excluded.peak_viewers)
`);
const insertIp = db.prepare('INSERT OR IGNORE INTO daily_ips (date, ip) VALUES (?, ?)');
const upsertNic = db.prepare(`
  INSERT INTO nic_daily (date, rx_bytes, tx_bytes) VALUES (?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET rx_bytes = rx_bytes + excluded.rx_bytes, tx_bytes = tx_bytes + excluded.tx_bytes
`);

export function flush() {
  const date = dayOf();
  db.exec('BEGIN');
  try {
    const events = new Set([...pending.keys(), ...peaks.keys()]);
    for (const eventId of events) {
      const b = pending.get(eventId) || { in: 0, out: 0, seconds: 0 };
      upsertStats.run(date, eventId, b.in, b.out, Math.round(b.seconds), peaks.get(eventId) || 0);
    }
    for (const ip of ips) insertIp.run(date, ip);
    const nic = readNic();
    if (nic && nicLast && nic.rx >= nicLast.rx && nic.tx >= nicLast.tx) {
      upsertNic.run(date, nic.rx - nicLast.rx, nic.tx - nicLast.tx);
    }
    if (nic) nicLast = nic;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  pending.clear();
  peaks.clear();
  ips.clear();
}

const GB = 1024 ** 3;
const gb = (bytes) => Number((bytes / GB).toFixed(3));

// Daily report between two dates (inclusive), newest first.
export function report(from, to) {
  const rows = db.prepare(
    'SELECT * FROM daily_stats WHERE date BETWEEN ? AND ? ORDER BY date DESC, event_id',
  ).all(from, to);
  const ipsPerDay = new Map(db.prepare(
    'SELECT date, COUNT(*) AS n FROM daily_ips WHERE date BETWEEN ? AND ? GROUP BY date',
  ).all(from, to).map((r) => [r.date, r.n]));
  const nicPerDay = new Map(db.prepare(
    'SELECT * FROM nic_daily WHERE date BETWEEN ? AND ?',
  ).all(from, to).map((r) => [r.date, r]));

  const days = new Map();
  for (const r of rows) {
    let d = days.get(r.date);
    if (!d) {
      d = { date: r.date, inGB: 0, outGB: 0, viewerHours: 0, peakViewers: 0, uniqueIps: ipsPerDay.get(r.date) || 0, tables: [] };
      days.set(r.date, d);
    }
    if (r.event_id === ALL) {
      d.peakViewers = r.peak_viewers;
      continue;
    }
    d.inGB += r.in_bytes / GB;
    d.outGB += r.out_bytes / GB;
    d.viewerHours += r.viewer_seconds / 3600;
    d.tables.push({
      eventId: r.event_id,
      inGB: gb(r.in_bytes),
      outGB: gb(r.out_bytes),
      viewerHours: Number((r.viewer_seconds / 3600).toFixed(2)),
      peakViewers: r.peak_viewers,
    });
  }
  const out = [...days.values()].map((d) => {
    const nic = nicPerDay.get(d.date);
    return {
      ...d,
      inGB: Number(d.inGB.toFixed(3)),
      outGB: Number(d.outGB.toFixed(3)),
      viewerHours: Number(d.viewerHours.toFixed(2)),
      nicInGB: nic ? gb(nic.rx_bytes) : null,
      nicOutGB: nic ? gb(nic.tx_bytes) : null,
    };
  });
  const sum = (k) => Number(out.reduce((a, d) => a + (d[k] || 0), 0).toFixed(3));
  return {
    from,
    to,
    totals: { inGB: sum('inGB'), outGB: sum('outGB'), viewerHours: sum('viewerHours'), nicInGB: sum('nicInGB'), nicOutGB: sum('nicOutGB') },
    days: out,
  };
}

export { ALL as ALL_TABLES };
