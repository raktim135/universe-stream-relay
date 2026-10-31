// Pulls one table's dealer stream from the provider over WebRTC.
//
// The provider watch URL is one-time and origin-locked, so this process opens
// it, answers the media server's offer and receives the H.264 + Opus tracks.
// Packets are handed on untouched (see relay/tableRelay.js); nothing here
// decodes or re-encodes.

import { EventEmitter } from 'node:events';
import { RTCPeerConnection, useH264, useOPUS } from 'werift';
import { openWatch, playerPost, startSession } from './watchLink.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const CONNECT_TIMEOUT_MS = 35000;

// Events:
//   track  ({ kind, track, receiver })  a remote track, once per kind
//   live   ()                           first video packet arrived
//   closed (error | null)               session over; never fires twice
export class PlayerSession extends EventEmitter {
  constructor(eventId) {
    super();
    this.eventId = eventId;
    this.closed = false;
    this.marks = {};
    this.startedAt = Date.now();
    this.pc = null;
    this.ws = null;
    this.ping = null;
    this.watch = null;
  }

  mark(name) {
    if (this.marks[name] === undefined) this.marks[name] = Date.now() - this.startedAt;
  }

  async start() {
    try {
      const watch = await openWatch(this.eventId);
      if (this.closed) return;
      this.watch = watch;
      this.mark('watchLink');
      const session = await startSession(watch.pageUrl, watch.cfg, { waitMs: 90000 });
      if (this.closed) return;
      this.mark('playToken');
      console.log(`[player] ${this.eventId} live as ${session.streamId}`);
      await this.connect(watch, session);
    } catch (err) {
      this.close(err);
    }
  }

  connect(watch, session) {
    const { cfg, pageUrl } = watch;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for video')), CONNECT_TIMEOUT_MS);
      const settle = (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        codecs: {
          video: [useH264({ parameters: 'packetization-mode=1;level-asymmetry-allowed=1' })],
          audio: [useOPUS()],
        },
      });
      this.pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      const ws = new WebSocket(session.wsUrl);
      this.ws = ws;
      const send = (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      };

      pc.onIceCandidate.subscribe((cand) => {
        if (!cand?.candidate) return;
        send({
          command: 'takeCandidate',
          streamId: session.streamId,
          label: cand.sdpMLineIndex,
          id: cand.sdpMid,
          candidate: cand.candidate,
        });
      });

      pc.connectionStateChange.subscribe((state) => {
        if (state === 'connected') this.mark('iceConnected');
        if (state === 'failed') {
          settle(new Error('webrtc connection failed'));
          this.close(new Error('webrtc connection failed'));
        }
      });

      pc.onTrack.subscribe((track) => {
        if (track.kind !== 'video' && track.kind !== 'audio') return;
        const receiver = pc.getReceivers().find((r) => r.tracks.includes(track));
        this.emit('track', { kind: track.kind, track, receiver });
        if (track.kind === 'video') {
          const { unSubscribe } = track.onReceiveRtp.subscribe(() => {
            unSubscribe();
            this.mark('firstVideo');
            console.log(`[player] ${this.eventId} video flowing`);
            this.emit('live');
            settle();
          });
        }
      });

      ws.addEventListener('open', () => {
        send({
          command: 'play',
          streamId: session.streamId,
          token: session.playToken,
          room: '',
          trackList: [],
          subscriberId: '',
          subscriberCode: '',
          viewerInfo: '',
          role: '',
          userPublishId: '',
        });
      });

      const iceQueue = [];
      let remoteSet = false;
      ws.addEventListener('message', async (ev) => {
        let msg;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (msg.command === 'takeConfiguration' && msg.sdp) {
          try {
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
            remoteSet = true;
            while (iceQueue.length) {
              try { await pc.addIceCandidate(iceQueue.shift()); } catch { /* late candidate */ }
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send({ command: 'takeConfiguration', streamId: session.streamId, type: 'answer', sdp: answer.sdp });
          } catch (err) {
            settle(err);
          }
          return;
        }
        if (msg.command === 'takeCandidate' && msg.candidate) {
          const cand = { candidate: msg.candidate, sdpMid: msg.id, sdpMLineIndex: msg.label };
          if (!remoteSet) iceQueue.push(cand);
          else {
            try { await pc.addIceCandidate(cand); } catch { /* ignore */ }
          }
          return;
        }
        if (msg.command === 'error') {
          const err = new Error(msg.definition || msg.message || 'player rejected the session');
          settle(err);
          this.close(err);
        }
      });

      ws.addEventListener('error', () => settle(new Error('player socket error')));
      ws.addEventListener('close', () => {
        settle(new Error('player socket closed before video'));
        this.close(new Error('player socket closed'));
      });

      // The provider drops sessions that stop pinging.
      this.ping = setInterval(() => {
        playerPost(pageUrl, cfg.pingUrl, {
          sid: cfg.sid,
          mode: 'webrtc',
          init: false,
          quality: null,
          diag: [],
        }).catch(() => {});
      }, (cfg.pingEvery || 10) * 1000);
    });
  }

  close(err = null) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    const watch = this.watch;
    if (watch?.cfg?.byeUrl) {
      playerPost(watch.pageUrl, watch.cfg.byeUrl, { sid: watch.cfg.sid }).catch(() => {});
    }
    try { this.ws?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    if (err) console.warn(`[player] ${this.eventId} ${err.message}`);
    this.emit('closed', err);
  }
}
