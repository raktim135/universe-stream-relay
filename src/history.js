// Recent-results history for a table. The brand casino backend returns the last ~10
// settled rounds (winner + cards) — the same list the real game shows immediately on
// load — so clients don't have to start empty and observe rounds one by one.

import { config } from './config.js';
import { getToken } from './auth.js';
import { apiHeaders } from './browser.js';

const cache = new Map(); // eventId -> { value, expMs }
const TTL_MS = 8 * 1000; // brief cache; a new round lands ~every 30s

function winnerOfRound(round) {
  const wm = (round.results || []).find((m) => /^WINNER$/i.test(m.marketName));
  if (!wm) return null;
  const win = (wm.runners || []).find((r) => r.result === 'WINNER');
  return win ? (wm.runnersName?.[win.selectionId] || null) : null; // null = tie/no winner
}

export async function getHistory(eventId) {
  const hit = cache.get(eventId);
  if (hit && Date.now() < hit.expMs) return hit.value;

  const token = await getToken();
  const res = await fetch(`${config.brandCasinoBase}/casinoapp/users/casino/casinoEventResults`, {
    method: 'POST',
    headers: { ...apiHeaders(config.brandCasinoBase), Authorization: `Bearer ${token}` },
    body: JSON.stringify({ eventId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(json?.data)) throw new Error(`history fetch failed (${res.status}) for ${eventId}`);

  // Newest first (as returned). Give clients {roundId, winner}.
  const rounds = json.data.map((r) => ({ roundId: r.roundId, winner: winnerOfRound(r) }));
  cache.set(eventId, { value: rounds, expMs: Date.now() + TTL_MS });
  return rounds;
}
