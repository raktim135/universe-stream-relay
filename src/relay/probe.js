// Measures the source dealer stream of one provider session.
//
// Read-only: it watches the RTP packets the relay forwards and never changes
// them. Logs one line every PROBE_INTERVAL_MS and serves the same numbers at
// GET /api/stats/:eventId.
//
//   startupMs  ms from session start to watch link, play token, ICE, first video
//   video      codec, profile/level, resolution (from SPS), fps (from RTP
//              timestamps), bitrate, keyframe interval, packet loss/reorder
//   audio      codec, clock rate, channels, bitrate, packet duration

const H264_PROFILES = {
  66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10',
  122: 'High 4:2:2', 244: 'High 4:4:4',
};

// ---- H.264 SPS parsing (resolution / profile / level) ----

function unescapeRbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Buffer.from(out);
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3];
      if (byte === undefined) throw new Error('sps truncated');
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos += 1;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) zeros += 1;
    return zeros ? (2 ** zeros - 1 + this.u(zeros)) : 0;
  }
  se() {
    const v = this.ue();
    return v & 1 ? (v + 1) / 2 : -(v / 2);
  }
}

export function parseSps(nal) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profileIdc = r.u(8);
  r.u(8); // constraint flags
  const levelIdc = r.u(8);
  r.ue(); // sps id
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        let last = 8;
        let next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  const refFrames = r.ue();
  r.u(1);
  const wMbs = r.ue() + 1;
  const hMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let crop = [0, 0, 0, 0];
  if (r.u(1)) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const cropX = chroma === 0 ? 1 : 2;
  const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    profile: H264_PROFILES[profileIdc] || `profile ${profileIdc}`,
    level: (levelIdc / 10).toFixed(1),
    width: wMbs * 16 - (crop[0] + crop[1]) * cropX,
    height: (2 - frameMbsOnly) * hMapUnits * 16 - (crop[2] + crop[3]) * cropY,
    refFrames,
  };
}

// NAL types carried by one H.264 RTP payload (single NAL, STAP-A, or FU-A start).
function nalTypesInRtp(payload) {
  if (!payload?.length) return [];
  const type = payload[0] & 0x1f;
  if (type >= 1 && type <= 23) return [{ type, nal: payload }];
  if (type === 24) {
    const out = [];
    let off = 1;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (!size || off + size > payload.length) break;
      const nal = payload.subarray(off, off + size);
      out.push({ type: nal[0] & 0x1f, nal });
      off += size;
    }
    return out;
  }
  if ((type === 28 || type === 29) && payload.length > 1 && payload[1] & 0x80) {
    return [{ type: payload[1] & 0x1f, nal: null }];
  }
  return [];
}

// ---- small helpers ----

function stats(values) {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...values),
    avg: Math.round(sum / values.length),
    max: Math.max(...values),
    n: values.length,
  };
}

function kbps(bytes, ms) {
  return ms > 0 ? Math.round((bytes * 8) / ms) : 0;
}

// Tracks sequence numbers for one SSRC: loss, reorder, duplicates.
class SeqTracker {
  constructor() {
    this.base = null;
    this.highest = null; // extended
    this.received = 0;
    this.reordered = 0;
  }
  push(seq) {
    this.received += 1;
    if (this.base === null) {
      this.base = seq;
      this.highest = seq;
      return;
    }
    const last = this.highest & 0xffff;
    const delta = (seq - last) & 0xffff;
    if (delta === 0) return;
    if (delta < 0x8000) this.highest += delta;
    else this.reordered += 1;
  }
  summary() {
    if (this.base === null) return null;
    const expected = this.highest - this.base + 1;
    const lost = Math.max(0, expected - this.received);
    return {
      expected,
      received: this.received,
      lost,
      lossPct: expected ? Number(((lost / expected) * 100).toFixed(2)) : 0,
      reordered: this.reordered,
    };
  }
}

// Per-window counters for one media kind.
class MediaCounter {
  constructor(clockRate) {
    this.clockRate = clockRate;
    this.seq = new SeqTracker();
    this.totalBytes = 0;
    this.totalPackets = 0;
    this.resetWindow(Date.now());
  }
  resetWindow(now) {
    this.winStart = now;
    this.winBytes = 0;
    this.winPackets = 0;
    this.winTimestamps = new Set();
  }
  push(rtp) {
    const bytes = rtp.payload?.length || 0;
    this.totalBytes += bytes;
    this.totalPackets += 1;
    this.winBytes += bytes;
    this.winPackets += 1;
    this.winTimestamps.add(rtp.header.timestamp);
    this.seq.push(rtp.header.sequenceNumber);
  }
  window(now) {
    const ms = now - this.winStart;
    return {
      seconds: Number((ms / 1000).toFixed(1)),
      kbps: kbps(this.winBytes, ms),
      packetsPerSec: ms ? Math.round((this.winPackets * 1000) / ms) : 0,
      unitsPerSec: ms ? Number(((this.winTimestamps.size * 1000) / ms).toFixed(1)) : 0,
    };
  }
}

// ---- the probe ----

export class StreamProbe {
  constructor(eventId, { intervalMs = 60000 } = {}) {
    this.eventId = eventId;
    this.startedAt = Date.now();
    this.marks = {};
    this.media = {};  // kind -> MediaCounter
    this.codecs = {}; // kind -> codec info
    this.sps = null;
    this.keyframes = []; // RTP timestamps of recent IDRs
    this.audioPacketMs = null;
    this.prevAudioTs = undefined;
    this.timer = intervalMs > 0 ? setInterval(() => this.log(), intervalMs) : null;
    this.timer?.unref();
  }

  setTrack(track) {
    const c = track.codec;
    this.codecs[track.kind] = c
      ? { mimeType: c.mimeType, clockRate: c.clockRate, channels: c.channels, parameters: c.parameters }
      : null;
    this.media[track.kind] = new MediaCounter(c?.clockRate || (track.kind === 'video' ? 90000 : 48000));
  }

  onRtp(kind, rtp) {
    const counter = this.media[kind];
    if (!counter) return;
    counter.push(rtp);
    if (kind === 'video') this.inspectVideo(rtp);
    else this.inspectAudio(rtp);
  }

  inspectVideo(rtp) {
    for (const { type, nal } of nalTypesInRtp(rtp.payload)) {
      if (type === 7 && nal && !this.sps) {
        try { this.sps = parseSps(nal); } catch { /* try the next one */ }
      }
      if (type === 5 && this.keyframes[this.keyframes.length - 1] !== rtp.header.timestamp) {
        this.keyframes.push(rtp.header.timestamp);
        if (this.keyframes.length > 50) this.keyframes.shift();
      }
    }
  }

  inspectAudio(rtp) {
    const ts = rtp.header.timestamp;
    if (this.prevAudioTs !== undefined) {
      const d = (ts - this.prevAudioTs) >>> 0;
      if (d > 0 && d < 48000) this.audioPacketMs = Math.round((d * 1000) / this.media.audio.clockRate);
    }
    this.prevAudioTs = ts;
  }

  keyframeIntervals() {
    const clock = this.media.video?.clockRate || 90000;
    const out = [];
    for (let i = 1; i < this.keyframes.length; i++) {
      out.push(Math.round((((this.keyframes[i] - this.keyframes[i - 1]) >>> 0) * 1000) / clock));
    }
    return stats(out);
  }

  snapshot() {
    const now = Date.now();
    const { video, audio } = this.media;
    return {
      eventId: this.eventId,
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      startupMs: this.marks,
      video: video && {
        codec: this.codecs.video,
        sps: this.sps,
        window: video.window(now),
        totalKB: Math.round(video.totalBytes / 1024),
        keyframeIntervalMs: this.keyframeIntervals(),
        loss: video.seq.summary(),
      },
      audio: audio && {
        codec: this.codecs.audio,
        window: audio.window(now),
        packetMs: this.audioPacketMs,
        loss: audio.seq.summary(),
      },
    };
  }

  log() {
    const s = this.snapshot();
    const { video: v, audio: a } = s;
    const parts = [`[probe] ${this.eventId}`];
    if (v) {
      const res = v.sps ? `${v.sps.width}x${v.sps.height} ${v.sps.profile}@${v.sps.level}` : 'res ?';
      const gop = v.keyframeIntervalMs ? `${v.keyframeIntervalMs.avg}ms` : '?';
      parts.push(`video ${res} ${v.window.unitsPerSec}fps ${v.window.kbps}kbps gop ${gop} loss ${v.loss?.lossPct ?? 0}%`);
    } else parts.push('video none');
    if (a) {
      const name = a.codec?.mimeType?.split('/')[1] || '?';
      parts.push(`audio ${name} ${a.window.kbps}kbps loss ${a.loss?.lossPct ?? 0}%`);
    } else parts.push('audio none');
    console.log(parts.join(' | '));
    for (const counter of Object.values(this.media)) counter.resetWindow(Date.now());
  }

  stop() {
    clearInterval(this.timer);
  }
}
