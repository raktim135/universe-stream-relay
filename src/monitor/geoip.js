// Country and network owner (ASN) for an IP, from DB-IP Lite (CC BY 4.0,
// https://db-ip.com). Downloaded monthly into its own SQLite file
// (DATA_DIR/geoip.db) so lookups are indexed and memory stays small.
//
// Until the first download finishes, lookups return null and the
// country / hosting rules simply do not fire. The import (~1.2M rows) runs in
// a worker thread: done on the main thread it stalls live video forwarding.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// The worker only needs the data dir; it must not load config.js (env checks).
const FILE = path.join(isMainThread ? (await import('../config.js')).config.dataDir : workerData.dataDir, 'geoip.db');
const REFRESH_CHECK_MS = 24 * 3600000;

// Network owners that are cloud / hosting providers (where restream servers run).
const HOSTING = new RegExp([
  'amazon', '\\baws\\b', 'google', 'microsoft', 'azure', 'digitalocean', 'hetzner', '\\bovh',
  'linode', 'akamai', 'vultr', 'choopa', 'alibaba', 'tencent', 'oracle', 'contabo', 'scaleway',
  'leaseweb', '\\bm247\\b', 'datacamp', 'hostinger', 'godaddy', 'ionos', 'cloudflare', 'fastly',
  'psychz', 'quadranet', 'colocrossing', 'hostwinds', 'kamatera', 'upcloud', 'e2e networks',
  'netactuate', 'cherry servers', 'zenlayer', 'g-core', 'gcore', 'servers\\.com', 'hosting',
  'data ?cent(er|re)', '\\bvps\\b', 'cloud', 'server',
].join('|'), 'i');

let geo = null;
const cache = new Map();

function open() {
  if (!fs.existsSync(FILE)) return;
  try {
    const db = new DatabaseSync(FILE, { readOnly: true });
    geo = {
      db,
      month: db.prepare("SELECT value FROM meta WHERE key = 'month'").get()?.value || '',
      country: db.prepare('SELECT end, cc FROM country WHERE start <= ? ORDER BY start DESC LIMIT 1'),
      asn: db.prepare('SELECT end, asn, org FROM asn WHERE start <= ? ORDER BY start DESC LIMIT 1'),
    };
    cache.clear();
  } catch (err) {
    console.warn(`[geoip] cannot open ${FILE}: ${err.message}`);
    geo = null;
  }
}

// IPv4 and IPv6 as 16 bytes (IPv4 mapped into ::ffff:0:0/96), so ranges of
// both families compare correctly as BLOBs.
export function ipToBytes(ip) {
  const out = Buffer.alloc(16);
  let s = String(ip).trim();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4 && !s.includes(':')) {
    out[10] = 0xff;
    out[11] = 0xff;
    for (let i = 0; i < 4; i++) out[12 + i] = Number(v4[i + 1]);
    return out;
  }
  if (v4) {
    // ::ffff:1.2.3.4 style tail
    const n = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + `${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`;
  }
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

export function lookup(ip) {
  if (!geo || !ip) return null;
  if (cache.has(ip)) return cache.get(ip);
  const key = ipToBytes(ip);
  let result = null;
  if (key) {
    const c = geo.country.get(key);
    const a = geo.asn.get(key);
    // "ZZ" = private / reserved range (LAN, loopback): unknown, not foreign
    const country = c && Buffer.compare(Buffer.from(c.end), key) >= 0 && c.cc !== 'ZZ' ? c.cc : null;
    const owner = a && Buffer.compare(Buffer.from(a.end), key) >= 0 ? a : null;
    result = {
      country,
      asn: owner?.asn ?? null,
      org: owner?.org ?? null,
      hosting: !!owner?.org && HOSTING.test(owner.org),
    };
  }
  if (cache.size > 50000) cache.clear();
  cache.set(ip, result);
  return result;
}

// ---- download / import ----

function months() {
  const now = new Date();
  const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [fmt(now), fmt(prev)];
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function importCsv(db, url, insert, toRow) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const lines = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let n = 0;
  db.exec('BEGIN');
  for await (const line of lines) {
    if (!line) continue;
    const f = parseCsvLine(line);
    const start = ipToBytes(f[0]);
    const end = ipToBytes(f[1]);
    if (!start || !end) continue;
    insert.run(start, end, ...toRow(f));
    if (++n % 50000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
  }
  db.exec('COMMIT');
  return n;
}

async function download(month) {
  const tmp = `${FILE}.tmp`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE country (start BLOB PRIMARY KEY, end BLOB NOT NULL, cc TEXT) WITHOUT ROWID;
      CREATE TABLE asn (start BLOB PRIMARY KEY, end BLOB NOT NULL, asn INTEGER, org TEXT) WITHOUT ROWID;
    `);
    const base = 'https://download.db-ip.com/free';
    const countries = await importCsv(
      db, `${base}/dbip-country-lite-${month}.csv.gz`,
      db.prepare('INSERT OR REPLACE INTO country VALUES (?, ?, ?)'),
      (f) => [f[2]],
    );
    const owners = await importCsv(
      db, `${base}/dbip-asn-lite-${month}.csv.gz`,
      db.prepare('INSERT OR REPLACE INTO asn VALUES (?, ?, ?, ?)'),
      (f) => [Number(f[2]) || null, f[3] || null],
    );
    db.prepare("INSERT INTO meta VALUES ('month', ?)").run(month);
    db.close();
    return { countries, owners };
  } catch (err) {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Worker side: download + import one month into FILE.tmp, report back.
if (!isMainThread && workerData?.geoipMonth) {
  download(workerData.geoipMonth)
    .then((r) => parentPort.postMessage({ ok: true, ...r }))
    .catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
}

function downloadInWorker(month, dataDir) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { geoipMonth: month, dataDir } });
    worker.once('message', (m) => (m.ok ? resolve(m) : reject(new Error(m.error))));
    worker.once('error', reject);
    worker.once('exit', (code) => code && reject(new Error(`worker exited ${code}`)));
  });
}

let refreshing = false;
async function refresh(dataDir) {
  if (refreshing) return;
  refreshing = true;
  try {
    for (const month of months()) {
      if (geo?.month >= month) return; // already have this or newer
      try {
        const r = await downloadInWorker(month, dataDir);
        geo?.db.close();
        fs.renameSync(`${FILE}.tmp`, FILE);
        open();
        console.log(`[geoip] DB-IP Lite ${month} loaded (${r.countries} country ranges, ${r.owners} network ranges)`);
        return;
      } catch (err) {
        if (!/404/.test(err.message)) console.warn(`[geoip] download ${month} failed: ${err.message}`);
      }
    }
  } finally {
    refreshing = false;
  }
}

export async function startGeoip() {
  const { config } = await import('../config.js');
  if (!config.monitor.geoip) return;
  open();
  if (geo) console.log(`[geoip] using DB-IP Lite ${geo.month}`);
  else console.log('[geoip] downloading DB-IP Lite (first run, ~12 MB)...');
  refresh(config.dataDir);
  setInterval(() => refresh(config.dataDir), REFRESH_CHECK_MS).unref();
}

export function geoStatus() {
  return { enabled: !!geo || refreshing, month: geo?.month || null, attribution: 'IP data by DB-IP (db-ip.com), CC BY 4.0' };
}
