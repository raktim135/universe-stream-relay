// Minimal MediaMTX control-API client (localhost only).

import { config } from '../config.js';

function headers() {
  return {
    Authorization: `Basic ${Buffer.from(`relay:${config.internalSecret}`).toString('base64')}`,
  };
}

async function call(path, { method = 'GET' } = {}) {
  const res = await fetch(`${config.mediamtx.apiUrl}${path}`, {
    method,
    headers: headers(),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`MediaMTX API ${res.status} for ${path}`);
  return method === 'GET' ? res.json() : null;
}

// Map of path name -> { ready, readers } for every path MediaMTX knows.
export async function listPaths() {
  const json = await call('/v3/paths/list?itemsPerPage=1000');
  const out = new Map();
  for (const item of json.items || []) {
    out.set(item.name, {
      ready: !!item.ready,
      readers: (item.readers || []).length,
      tracks: (item.tracks || []).map((t) => (typeof t === 'string' ? t : t.codec || '')),
    });
  }
  return out;
}

function ipOf(remoteAddr = '') {
  // "1.2.3.4:5678" or "[2001:db8::1]:5678"
  const m = /^\[?([^\]]+?)\]?:\d+$/.exec(remoteAddr);
  const ip = m ? m[1] : remoteAddr;
  return ip.replace(/^::ffff:/, '');
}

// Every viewer connection (WebRTC and HLS), normalized. Publishers are left out.
export async function listViewerSessions() {
  const [webrtc, hls] = await Promise.all([
    call('/v3/webrtcsessions/list?itemsPerPage=10000'),
    call('/v3/hlssessions/list?itemsPerPage=10000').catch(() => ({ items: [] })),
  ]);
  const out = [];
  for (const s of webrtc.items || []) {
    if (s.state !== 'read') continue;
    out.push({
      id: s.id,
      protocol: 'webrtc',
      ip: ipOf(s.remoteAddr),
      path: s.path,
      created: Date.parse(s.created) || Date.now(),
      bytesSent: s.outboundBytes ?? s.bytesSent ?? 0,
      packetsLost: s.outboundRTPPacketsReportedLost ?? s.rtpPacketsLost ?? 0,
      userAgent: s.userAgent || '',
      transport: /tcp/i.test(s.remoteCandidate || '') ? 'tcp' : 'udp',
      // still negotiating (or a failed attempt): not a real viewer yet
      established: s.peerConnectionEstablished !== false,
    });
  }
  for (const s of hls.items || []) {
    out.push({
      id: s.id,
      protocol: 'hls',
      ip: ipOf(s.remoteAddr),
      path: s.path,
      created: Date.parse(s.created) || Date.now(),
      bytesSent: s.outboundBytes ?? s.bytesSent ?? 0,
      packetsLost: 0,
      userAgent: s.userAgent || '',
      transport: 'http',
      established: true,
    });
  }
  return out;
}

export async function kickSession(session) {
  const kind = session.protocol === 'hls' ? 'hlssessions' : 'webrtcsessions';
  await call(`/v3/${kind}/kick/${encodeURIComponent(session.id)}`, { method: 'POST' });
}
