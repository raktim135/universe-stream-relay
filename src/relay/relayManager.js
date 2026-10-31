// Decides which tables are pulled from the provider: one pull per table, kept
// while it has viewers in MediaMTX (or is pre-warmed), released after
// RELAY_IDLE_MS without any.

import { TableRelay } from './tableRelay.js';
import { listPaths } from '../mediamtx/api.js';
import { config } from '../config.js';

const SWEEP_MS = 10000;

class RelayManager {
  constructor() {
    this.relays = new Map();     // eventId -> TableRelay
    this.lastWanted = new Map(); // eventId -> ms
    this.viewers = new Map();    // eventId -> reader count from last sweep
    this.apiDown = false;
  }

  start() {
    for (const eventId of config.relay.prewarm) this.want(eventId);
    setInterval(() => this.sweep(), SWEEP_MS).unref();
  }

  // Someone asked for this table (viewer auth, /api/video, prewarm).
  want(eventId) {
    this.lastWanted.set(eventId, Date.now());
    let relay = this.relays.get(eventId);
    if (!relay) {
      relay = new TableRelay(eventId);
      this.relays.set(eventId, relay);
      relay.start();
    }
    return relay;
  }

  async sweep() {
    let paths = new Map();
    try {
      paths = await listPaths();
      if (this.apiDown) console.log('[relay] MediaMTX API reachable again');
      this.apiDown = false;
    } catch (err) {
      if (!this.apiDown) console.warn(`[relay] MediaMTX API unreachable: ${err.message}`);
      this.apiDown = true;
    }

    const now = Date.now();
    for (const [eventId, relay] of this.relays) {
      const path = paths.get(eventId);
      const readers = path?.readers || 0;
      if (path?.ready && relay.state === 'live' && relay.sinceSec?.() > 10 && !path.tracks.includes('H264')) {
        relay.republish(`MediaMTX has no video track (${path.tracks.join(', ') || 'none'})`);
      }
      this.viewers.set(eventId, readers);
      if (readers > 0 || config.relay.prewarm.includes(eventId)) {
        this.lastWanted.set(eventId, now);
        continue;
      }
      if (now - (this.lastWanted.get(eventId) || 0) > config.relay.idleMs) {
        console.log(`[relay] ${eventId} no viewers, releasing the table`);
        relay.stop();
        this.relays.delete(eventId);
        this.viewers.delete(eventId);
      }
    }
  }

  status(eventId) {
    const relay = this.relays.get(eventId);
    if (!relay) return null;
    return { ...relay.status(), viewers: this.viewers.get(eventId) ?? 0 };
  }

  list() {
    return [...this.relays.keys()].map((id) => this.status(id));
  }

  probe(eventId) {
    return this.relays.get(eventId)?.probe || null;
  }

  stopAll() {
    for (const relay of this.relays.values()) relay.stop();
    this.relays.clear();
  }
}

export const relays = new RelayManager();
