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
import { io } from 'socket.io-client';
import { config } from './config.js';
import { getToken, invalidateToken } from './auth.js';
import { rotatePinnedIp } from './dnsPin.js';

export class UniverseClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.state = new Map(); // eventId -> latest data object
    this.connected = false;
  }

  latest(eventId) {
    return this.state.get(eventId) || null;
  }

  all() {
    return Object.fromEntries(this.state);
  }

  start() {
    // Base host; socket.io appends `path` (/universecasino) itself. The provider
    // host is pinned at the DNS layer in dnsPin.js (imported by server.js).
    const base = config.socketUrl.replace(/\/$/, '');

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
      // socket.io does NOT auto-reconnect on a server-initiated disconnect (e.g. the
      // provider kicks us when the token is invalidated by another login, or on their
      // restart). Re-login and reconnect manually so the feed self-heals.
      if (reason === 'io server disconnect') {
        invalidateToken();
        setTimeout(() => {
          if (!this.connected) {
            console.log('[universe] manual reconnect after server disconnect');
            this.socket.connect();
          }
        }, 2000);
      }
    });

    this.socket.on('connect_error', (err) => {
      // AUTH_REQUIRED / invalid token -> drop cached token so next attempt re-logs in.
      console.error('[universe] connect_error:', err.message);
      if (/auth/i.test(err.message)) invalidateToken();
      // Transport-level failure (e.g. a stale pinned IP) -> rotate to the next IP.
      else if (/websocket|timeout|ECONN|network/i.test(err.message)) {
        rotatePinnedIp();
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
