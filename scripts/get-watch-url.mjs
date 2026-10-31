// Prints a fresh watch page URL for a table, from a non-blocked network.
//
//   npm run watch-url -- 99.0030
//
// Run this where the brand is NOT IP-blocked (e.g. your laptop), copy the URL
// into the server's TABLE_WATCH_URLS, and restart the relay. The URL is
// short-lived, so paste it and start the test promptly.

import { getToken } from '../src/provider/auth.js';
import { apiHeaders } from '../src/provider/browser.js';
import { config } from '../src/config.js';

const eventId = process.argv[2] || '99.0030';
const base = config.brandCasinoBase;
const token = await getToken();

const res = await fetch(`${base}/casinoapp/exchange/users/streaming/casinoGameWatchLink`, {
  method: 'POST',
  headers: { ...apiHeaders(base), Authorization: `Bearer ${token}`, Referer: `${base}/`, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ streamId: eventId, timestamp: Date.now() }),
  signal: AbortSignal.timeout(15000),
});
const json = await res.json().catch(() => ({}));
const url = json?.data?.url;
if (!res.ok || !url) {
  console.error(`failed (${res.status}): ${json?.meta?.message || JSON.stringify(json)}`);
  process.exit(1);
}
console.log(`\nTABLE_WATCH_URLS=${eventId}=${url}\n`);
