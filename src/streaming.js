// Resolves the live-dealer video for a table.
//
// The brand casino backend returns the CDN creds; the actual playback is a WebRTC
// stream wrapped by the Universe player iframe. We hand the client a ready-to-embed
// iframe URL. Creds carry a short-lived token, so we cache briefly and refresh.

import { config } from './config.js';
import { getToken } from './auth.js';

const PLAYER_BASE = 'https://player.universestudio.games/index.html';
const cache = new Map(); // eventId -> { url, expMs }

async function fetchStreamCreds(eventId) {
  const token = await getToken();
  const res = await fetch(
    `${config.brandCasinoBase}/casinoapp/exchange/users/streaming/casinoGameStreaming`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      },
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
  cache.set(eventId, { value, expMs: Date.now() + 45 * 1000 });
  return value;
}
