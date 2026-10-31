// Opens the one-time dealer watch page and talks to its player API.
//
// casinoGameWatchLink returns an HTML player URL. That URL works only for the
// site that is allowed to embed it, and the play token inside it is single-use,
// so this process consumes it and never hands the URL to our viewers.

import { config } from '../config.js';
import { getToken } from './auth.js';
import { USER_AGENT, apiHeaders } from './browser.js';

function playerHeaders(pageUrl) {
  const origin = new URL(pageUrl).origin;
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Origin: origin,
    Referer: pageUrl,
  };
}

export async function openWatch(eventId) {
  const base = config.brandCasinoBase;

  // Testing override: a watch URL obtained elsewhere (e.g. on a non-blocked IP
  // via `npm run watch-url`) and pasted into TABLE_WATCH_URLS. Skips the
  // casinoGameWatchLink call, which some IPs get 422 "viewer_ip_blocked" on.
  let pageUrl = config.relay.watchUrls.get(eventId);
  if (pageUrl) {
    console.log(`[watch] ${eventId} using TABLE_WATCH_URLS override`);
  } else {
    const token = await getToken();
    console.log(`[watch] ${eventId} requesting player link`);
    const res = await fetch(
      `${base}/casinoapp/exchange/users/streaming/casinoGameWatchLink`,
      {
        method: 'POST',
        headers: {
          ...apiHeaders(base),
          Authorization: `Bearer ${token}`,
          Referer: `${base}/`,
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ streamId: eventId, timestamp: Date.now() }),
        signal: AbortSignal.timeout(15000),
      }
    );
    const json = await res.json().catch(() => ({}));
    pageUrl = json?.data?.url;
    if (!res.ok || !pageUrl) {
      const reason = json?.meta?.message || json?.message || json?.error || '';
      throw new Error(`watch link failed (${res.status}) for ${eventId}${reason ? `: ${reason}` : ''}`);
    }
  }
  console.log(`[watch] ${eventId} fetching player page`);

  const page = await fetch(pageUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': USER_AGENT,
      Referer: `${base}/`,
      Origin: base,
    },
    signal: AbortSignal.timeout(15000),
  });
  const html = await page.text();
  const match = html.match(/<script[^>]*id="cfg"[^>]*>([\s\S]*?)<\/script>/i);
  if (!page.ok || !match) {
    throw new Error(`player page had no config (${page.status}) for ${eventId}`);
  }
  const cfg = JSON.parse(match[1]);
  if (!cfg.sid || !cfg.pingUrl) {
    throw new Error(`player config incomplete for ${eventId}`);
  }
  return { pageUrl, cfg };
}

export async function playerPost(pageUrl, pathOrUrl, body) {
  const url = new URL(pathOrUrl, pageUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: playerHeaders(pageUrl),
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// First ping learns the live websocket. The play token is requested on its own
// ping — combining it with init makes the media server answer "busy". The real
// player stays seated and retries for a long time, so we do the same.
export async function startSession(pageUrl, cfg, { waitMs = 90000 } = {}) {
  const base = {
    sid: cfg.sid,
    mode: 'connecting',
    quality: null,
    diag: [],
  };
  const init = await playerPost(pageUrl, cfg.pingUrl, {
    ...base,
    init: true,
    tz: 'Asia/Kolkata',
    tzo: -330,
  });
  const info = init.json || {};
  if (!info.ok || !info.wsUrl || !info.streamId) {
    const state = info.state || info.token_error || info.message || 'no session';
    throw new Error(`player is not live (${init.status}, ${state})`);
  }
  if (info.state && info.state !== 'live') {
    throw new Error(`player state is ${info.state}`);
  }

  const seated = setInterval(() => {
    playerPost(pageUrl, cfg.pingUrl, { ...base, init: false }).catch(() => {});
  }, (cfg.pingEvery || 10) * 1000);

  let playToken = '';
  let tokenError = '';
  const deadline = Date.now() + waitMs;
  let attempt = 0;
  try {
    while (!playToken && Date.now() < deadline) {
      if (attempt) {
        const wait = Math.min(1200 * (1.5 ** Math.min(attempt - 1, 6)), 12000);
        await sleep(wait);
      }
      attempt += 1;
      try {
        const got = await playerPost(pageUrl, cfg.pingUrl, { ...base, init: false, token: true });
        playToken = got.json?.token || '';
        tokenError = got.json?.token_error || '';
      } catch {
        tokenError = tokenError || 'timed out';
      }
      if (!playToken) {
        console.log(`[watch] play token not ready (${tokenError || 'empty'}), attempt ${attempt}`);
      }
    }
  } finally {
    clearInterval(seated);
  }
  if (!playToken) {
    throw new Error(tokenError ? `play token: ${tokenError}` : 'play token missing');
  }

  return { streamId: info.streamId, wsUrl: info.wsUrl, playToken };
}
