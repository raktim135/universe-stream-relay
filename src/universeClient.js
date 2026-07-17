// Connects to the Universe provider socket and keeps the latest live state per table.
//
// Protocol (reverse-engineered from the brand casino app):
//   - socket.io v4, base wss://casino.unityexch.com, path "/universecasino",
//     websocket transport, connect auth { token: <brand JWT>, uType: "usr" }.
//   - subscribe to a table:  socket.emit("SCSN", [eventId])
//   - live data arrives on:  socket.on("casino_odds", { eventId, data })
//     data = { roundId, eventName, seconds/leftSec, status ("ONLINE"|"SUSPEND"),
//              cardsArr.card, resultsArr[ WINNER, LUCKY ODD/EVEN, LUCKY COLOR,
//              LUCKY CARD SUIT, LUCKY CARD ] with runners + runnersName }

import { EventEmitter } from 'node:events';
import dns from 'node:dns';
import { io } from 'socket.io-client';
import { config } from './config.js';
import { getToken, invalidateToken } from './auth.js';

const PROVIDER_HOST = (() => {
  try { return new URL(config.socketUrl).hostname; } catch { return ''; }
})();

export class UniverseClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.state = new Map(); // eventId -> latest data object
    this.connected = false;
    this.ipIndex = 0; // which pinned IP we're currently using (GeoDNS workaround)
  }

  // Custom DNS resolver: force the provider host to a pinned IP (GeoDNS is fenced
  // to India). Everything else resolves normally.
  makeLookup() {
    if (!config.socketIps.length) return undefined;
    const self = this;
    return (hostname, options, cb) => {
      if (hostname === PROVIDER_HOST) {
        const ip = config.socketIps[self.ipIndex % config.socketIps.length];
        const family = ip.includes(':') ? 6 : 4;
        if (options && options.all) return cb(null, [{ address: ip, family }]);
        return cb(null, ip, family);
      }
      return dns.lookup(hostname, options, cb);
    };
  }

  latest(eventId) {
    return this.state.get(eventId) || null;
  }

  all() {
    return Object.fromEntries(this.state);
  }

  start() {
    // Base host; socket.io appends `path` (/universecasino) itself.
    const base = config.socketUrl.replace(/\/$/, '');
    const lookup = this.makeLookup();
    if (config.socketIps.length) {
      console.log(`[universe] pinning ${PROVIDER_HOST} -> ${config.socketIps.join(', ')} (GeoDNS workaround)`);
    }

    this.socket = io(base, {
      path: config.socketPath,
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 3000,
      // Node ws sends no Origin; the provider WAF expects a browser-like origin.
      extraHeaders: {
        Origin: config.brandCasinoBase,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      },
      // Force the provider host to a pinned IP (GeoDNS is fenced to India). The ws
      // transport forwards this lookup to the underlying https request.
      ...(lookup ? { lookup, transportOptions: { websocket: { lookup } } } : {}),
      // Async auth: fetch a fresh token on every (re)connection.
      auth: (cb) => {
        getToken()
          .then((token) => cb({ token, uType: 'usr' }))
          .catch((err) => {
            console.error('[universe] token error:', err.message);
            cb({ token: '', uType: 'usr' });
          });
      },
    });

    this.socket.on('connect', () => {
      this.connected = true;
      console.log(`[universe] connected (${this.socket.id}); subscribing ${config.tables.length} table(s)`);
      this.subscribeAll();
      this.emit('status', { connected: true });
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      console.warn('[universe] disconnected:', reason);
      this.emit('status', { connected: false, reason });
    });

    this.socket.on('connect_error', (err) => {
      // AUTH_REQUIRED / invalid token -> drop cached token so next attempt re-logs in.
      console.error('[universe] connect_error:', err.message);
      if (/auth/i.test(err.message)) invalidateToken();
      // Transport-level failure (e.g. a stale pinned IP) -> rotate to the next IP.
      else if (config.socketIps.length > 1 && /websocket|timeout|ECONN|network/i.test(err.message)) {
        this.ipIndex = (this.ipIndex + 1) % config.socketIps.length;
        console.warn(`[universe] rotating pinned IP -> ${config.socketIps[this.ipIndex]}`);
      }
    });

    // The live feed. Both events carry the same shape.
    const onData = (payload) => this.handle(payload);
    this.socket.on('casino_odds', onData);
    this.socket.on('message', onData);
  }

  subscribeAll() {
    for (const eventId of config.tables) {
      this.socket.emit('SCSN', [eventId]);
    }
  }

  handle(payload) {
    // payload = { eventId, data: {...} }
    // `casino_odds` carries the full state (eventId is inside data); `message`
    // carries partial updates (eventId only on the wrapper). Merge both into the
    // per-table state so a partial update augments rather than wipes the snapshot.
    const eventId = payload?.eventId || payload?.data?.eventId;
    const data = payload?.data || payload;
    if (!eventId || !data || typeof data !== 'object') return;

    const merged = {
      ...(this.state.get(eventId) || {}),
      ...data,
      eventId, // always carry the resolved id (partial payloads omit it)
      receivedAt: Date.now(),
    };
    this.state.set(eventId, merged);
    this.emit('update', { eventId, data: merged });
  }
}

export const universe = new UniverseClient();
