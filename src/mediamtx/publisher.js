// Publishes one table into MediaMTX over WHIP (WebRTC ingest on localhost).
//
// We write the provider's RTP packets into local tracks; werift rewrites SSRC
// and payload type, answers MediaMTX's NACKs from its send cache and keeps
// sequence numbers continuous when the upstream source changes.

import { RTCPeerConnection, MediaStreamTrack, useH264, useOPUS } from 'werift';
import { config } from '../config.js';

const GATHER_TIMEOUT_MS = 3000;

function basicAuth() {
  return `Basic ${Buffer.from(`relay:${config.internalSecret}`).toString('base64')}`;
}

function waitForGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

export class WhipPublisher {
  constructor(path) {
    this.path = path;
    this.pc = null;
    this.tracks = {};   // kind -> local MediaStreamTrack
    this.senders = {};  // kind -> RTCRtpSender
    this.sessionUrl = null;
    this.closed = false;
    this.onFailed = null;
    this.onKeyframeRequest = null;
  }

  async start() {
    const pc = new RTCPeerConnection({
      codecs: { video: [useH264()], audio: [useOPUS()] },
    });
    this.pc = pc;
    for (const kind of ['video', 'audio']) {
      const track = new MediaStreamTrack({ kind });
      const { sender } = pc.addTransceiver(track, { direction: 'sendonly' });
      this.tracks[kind] = track;
      this.senders[kind] = sender;
    }
    this.senders.video.onPictureLossIndication.subscribe(() => this.onKeyframeRequest?.());

    pc.connectionStateChange.subscribe((state) => {
      if ((state === 'failed' || state === 'closed') && !this.closed) {
        this.onFailed?.(new Error(`publisher ${state}`));
      }
    });

    await pc.setLocalDescription(await pc.createOffer());
    await waitForGathering(pc);

    const url = `${config.mediamtx.whipUrl}/${encodeURIComponent(this.path)}/whip`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: basicAuth() },
      body: pc.localDescription.sdp,
      signal: AbortSignal.timeout(10000),
    });
    if (res.status !== 201) {
      throw new Error(`MediaMTX refused publish (${res.status}): ${(await res.text()).trim()}`);
    }
    const location = res.headers.get('location');
    if (location) this.sessionUrl = new URL(location, url).toString();
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  }

  write(kind, rtp) {
    const track = this.tracks[kind];
    if (!track || this.closed) return;
    const packet = rtp.clone();
    packet.header.extensions = []; // upstream extension IDs mean nothing here
    track.writeRtp(packet);
  }

  // Called when a new upstream session takes over: keeps seq/timestamps
  // continuous so viewers see a short freeze instead of a broken stream.
  resetContinuity() {
    for (const sender of Object.values(this.senders)) sender.replaceRTP?.({});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionUrl) {
      fetch(this.sessionUrl, {
        method: 'DELETE',
        headers: { Authorization: basicAuth() },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    try { this.pc?.close(); } catch { /* already closed */ }
  }
}
