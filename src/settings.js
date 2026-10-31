// Runtime settings: abuse rules, limits and auto-action switches.
//
// Defaults come from code (+ a few env seeds); anything changed in the
// dashboard is saved in SQLite and wins from then on, across restarts.
// An action runs only when the master `autoMode` AND its own switch are on;
// with either off, its rule still detects and reports.

import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

const DEFAULTS = {
  autoMode: true,
  actions: {
    limitConnections: true,  // IP over maxConnectionsPerIp -> disconnect its oldest connection
    blockManyEvents: false,  // IP watching more than maxEventsPerIp tables -> block
    kickLongSessions: false, // connection longer than maxSessionHours -> disconnect (players reconnect with a fresh token)
    blockNonBrowser: true,   // restreaming tools (ffmpeg, GStreamer, curl...) -> block
    blockForeign: false,     // IP outside allowedCountries -> reject
    blockDatacenter: false,  // cloud / hosting provider IP -> reject
  },
  limits: {
    maxConnectionsPerIp: config.defaults.maxConnectionsPerIp,
    maxEventsPerIp: 3,
    maxSessionHours: 6,
    blockMinutes: 60,
  },
  allowedCountries: ['IN'],
  // Sites allowed to embed /watch in an iframe (e.g. "example.com" also allows its subdomains).
  allowedEmbedDomains: config.defaults.allowedEmbedDomains,
  // IPs never flagged, limited or blocked (office, our own servers).
  ipAllowlist: [],
};

const ACTION_KEYS = Object.keys(DEFAULTS.actions);
const LIMIT_KEYS = Object.keys(DEFAULTS.limits);

const getRow = db.prepare('SELECT value FROM settings WHERE key = ?');
const putRow = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

function load() {
  const row = getRow.get('rules');
  const saved = row ? JSON.parse(row.value) : {};
  return {
    ...DEFAULTS,
    ...saved,
    actions: { ...DEFAULTS.actions, ...saved.actions },
    limits: { ...DEFAULTS.limits, ...saved.limits },
  };
}

let current = load();

export function getSettings() {
  return current;
}

// An automatic action is live only with the master switch on too.
export function actionEnabled(name) {
  return current.autoMode && !!current.actions[name];
}

function cleanList(value, re) {
  if (!Array.isArray(value)) throw new Error('expected a list');
  return [...new Set(value.map((v) => String(v).trim().toLowerCase()).filter(Boolean))].map((v) => {
    if (!re.test(v)) throw new Error(`invalid entry: ${v}`);
    return v;
  });
}

// Merge a partial update, validate, persist.
export function updateSettings(patch) {
  const next = structuredClone(current);
  if ('autoMode' in patch) next.autoMode = !!patch.autoMode;
  for (const [k, v] of Object.entries(patch.actions || {})) {
    if (!ACTION_KEYS.includes(k)) throw new Error(`unknown action: ${k}`);
    next.actions[k] = !!v;
  }
  for (const [k, v] of Object.entries(patch.limits || {})) {
    if (!LIMIT_KEYS.includes(k)) throw new Error(`unknown limit: ${k}`);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 100000) throw new Error(`${k} must be a positive number`);
    next.limits[k] = Math.round(n);
  }
  if ('allowedCountries' in patch) {
    next.allowedCountries = cleanList(patch.allowedCountries, /^[a-z]{2}$/).map((c) => c.toUpperCase());
  }
  if ('allowedEmbedDomains' in patch) {
    next.allowedEmbedDomains = cleanList(patch.allowedEmbedDomains, /^(\*\.)?[a-z0-9.-]+(:\d+)?$/);
  }
  if ('ipAllowlist' in patch) {
    next.ipAllowlist = cleanList(patch.ipAllowlist, /^[0-9a-f.:]+$/);
  }
  putRow.run('rules', JSON.stringify(next));
  current = next;
  return current;
}

// A random secret generated once and kept across restarts (e.g. cookie signing).
export function persistentSecret(name) {
  const key = `secret:${name}`;
  const row = getRow.get(key);
  if (row) return row.value;
  const value = randomBytes(32).toString('hex');
  putRow.run(key, value);
  return value;
}
