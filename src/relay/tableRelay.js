// One table: provider WebRTC session -> MediaMTX publisher, packets untouched.
//
// The publisher outlives provider sessions. When the provider drops us we
// reconnect with backoff and keep writing into the same MediaMTX path, so
// viewers see a short freeze instead of losing their connection.

import { PlayerSession } from '../provider/playerSession.js';
import { WhipPublisher } from '../mediamtx/publisher.js';
import { StreamProbe } from './probe.js';
import { addInbound } from '../monitor/bandwidth.js';
import { config } from '../config.js';

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;
const KEYFRAME_REQUEST_GAP_MS = 1000;

export class TableRelay {
  constructor(eventId) {
    this.eventId = eventId;
    this.state = 'starting'; // starting | live | retrying | stopped
    this.since = Date.now();
    this.failures = 0;
    this.lastError = null;
    this.player = null;
    this.forwarding = null; // the player whose packets reach the publisher
    this.publisher = null;
    this.probe = null;
    this.videoUpstream = null; // { receiver, ssrc } for keyframe requests
    this.lastKeyframeRequest = 0;
    this.retryTimer = null;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.since = Date.now();
  }

  start() {
    console.log(`[relay] ${this.eventId} starting`);
    this.connect();
  }

  connect() {
    if (this.state === 'stopped') return;
    const player = new PlayerSession(this.eventId);
    const probe = new StreamProbe(this.eventId, { intervalMs: config.probeIntervalMs });
    probe.marks = player.marks; // same object, fills in as the session progresses
    this.player = player;
    this.probe = probe;

    player.on('track', ({ kind, track, receiver }) => {
      probe.setTrack(track);
      if (kind === 'video') this.videoUpstream = { receiver, ssrc: track.ssrc };
      track.onReceiveRtp.subscribe((rtp) => {
        probe.onRtp(kind, rtp);
        addInbound(this.eventId, rtp.header.serializeSize + rtp.payload.length);
        if (this.forwarding === player) this.publisher?.write(kind, rtp);
      });
    });

    player.on('live', () => {
      this.attach(player).catch((err) => player.close(err));
    });

    player.on('closed', (err) => {
      probe.stop();
      if (this.player === player) this.player = null;
      if (this.forwarding === player) this.forwarding = null;
      if (this.state === 'stopped') return;
      this.lastError = err?.message || 'provider session ended';
      this.scheduleRetry();
    });

    player.start();
  }

  // Point the publisher at this player (creating the publisher if needed).
  async attach(player) {
    let reused = true;
    if (!this.publisher || this.publisher.closed) {
      reused = false;
      const publisher = new WhipPublisher(this.eventId);
      publisher.onKeyframeRequest = () => this.requestKeyframe();
      publisher.onFailed = (err) => this.onPublisherFailed(publisher, err);
      this.publisher = publisher;
      await publisher.start();
    }
    if (player.closed || this.state === 'stopped') return;
    if (reused) this.publisher.resetContinuity();
    this.forwarding = player;
    this.failures = 0;
    this.lastError = null;
    this.setState('live');
    console.log(`[relay] ${this.eventId} live${reused ? ' (resumed)' : ''}`);
  }

  onPublisherFailed(publisher, err) {
    if (this.publisher !== publisher) return;
    console.warn(`[relay] ${this.eventId} ${err.message}; republishing`);
    publisher.close();
    this.publisher = null;
    this.forwarding = null;
    if (this.player && !this.player.closed) {
      this.attach(this.player).catch((e) => this.player?.close(e));
    }
  }

  // MediaMTX registered the stream without one of its tracks (e.g. video
  // arrived after its track-gather window): publish again.
  republish(reason) {
    if (!this.publisher || this.state !== 'live') return;
    this.onPublisherFailed(this.publisher, new Error(reason));
  }

  // MediaMTX asks for a keyframe (new viewer, loss); pass it to the provider.
  requestKeyframe() {
    const now = Date.now();
    const up = this.videoUpstream;
    if (!up?.receiver || !up.ssrc || now - this.lastKeyframeRequest < KEYFRAME_REQUEST_GAP_MS) return;
    this.lastKeyframeRequest = now;
    up.receiver.sendRtcpPLI(up.ssrc).catch(() => {});
  }

  scheduleRetry() {
    this.failures += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    this.setState('retrying');
    console.warn(`[relay] ${this.eventId} retrying in ${delay / 1000}s (${this.lastError})`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  stop() {
    if (this.state === 'stopped') return;
    this.setState('stopped');
    clearTimeout(this.retryTimer);
    this.player?.close();
    this.publisher?.close();
    this.probe?.stop();
    console.log(`[relay] ${this.eventId} stopped`);
  }

  sinceSec() {
    return (Date.now() - this.since) / 1000;
  }

  status() {
    return {
      eventId: this.eventId,
      state: this.state,
      sinceSec: Math.round((Date.now() - this.since) / 1000),
      failures: this.failures,
      lastError: this.lastError,
    };
  }
}
