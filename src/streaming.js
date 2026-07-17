// Resolves the live-dealer video for a table.
//
// The brand casino backend returns the CDN creds; the actual playback is a WebRTC
// stream wrapped by the Universe player iframe. We hand the client a ready-to-embed
// iframe URL.
//
// IMPORTANT: the stream token is short-lived (it embeds an issue timestamp) and the
// media server only accepts a FRESH token at WebRTC connect time — a token even ~2min
// old is rejected. So we must NOT cache it; every /api/video call fetches a new token.
// Cost is tiny: the page fetches this once per viewer load (real-player-like traffic).

import { config } from './config.js';
import { getToken } from './auth.js';
import { apiHeaders } from './browser.js';

const PLAYER_BASE = 'https://player.universestudio.games/index.html';
// Tiny cache only to dedupe a burst of identical fetches (e.g. React StrictMode
// double-invoke) — small enough that every real viewer still gets a fresh token.
const cache = new Map(); // eventId -> { value, expMs }
const VIDEO_TTL_MS = 3 * 1000;

async function fetchStreamCreds(eventId) {
  const token = await getToken();
  const res = await fetch(
    `${config.brandCasinoBase}/casinoapp/exchange/users/streaming/casinoGameStreaming`,
    {
      method: 'POST',
      headers: { ...apiHeaders(config.brandCasinoBase), Authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId }),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.data?.url) {
    throw new Error(`streaming fetch failed (${res.status}) for ${eventId}`);
  }
  return json.data; // { url, streamingName, appName, sportId, token }
}

function buildIframeUrl(d) {
  const q = new URLSearchParams({
    appName: d.appName,
    streamingName: d.streamingName,
    url: d.url,
    token: d.token,
  });
  return `${PLAYER_BASE}?${q.toString()}`;
}

// Returns { iframeUrl, creds } for a table, cached ~45s.
export async function getVideo(eventId) {
  const hit = cache.get(eventId);
  if (hit && Date.now() < hit.expMs) return hit.value;

  const creds = await fetchStreamCreds(eventId);
  const value = { iframeUrl: buildIframeUrl(creds), creds };
  cache.set(eventId, { value, expMs: Date.now() + VIDEO_TTL_MS });
  return value;
}
