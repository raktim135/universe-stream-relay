// Turns a raw `casino_odds` payload into a clean, game-agnostic shape for clients.
//
// The socket carries the DYNAMIC state (round, timer, status, per-market winners) and
// the market/runner NAMES for whatever game the eventId is — so this is generic across
// all Universe games. Only the decimal PRICES are attached from the static map (prices.js).

import { priceFor } from './prices.js';

export function normalize(data) {
  if (!data) return null;

  const markets = (data.resultsArr || []).map((mk) => {
    const runners = Object.entries(mk.runnersName || {}).map(([selectionId, name]) => ({
      selectionId,
      name,
      price: priceFor(data.eventId, mk.marketName, name),
      result: (mk.runners && mk.runners[selectionId]) || '', // 'WINNER' | 'LOSER' | ''
    }));
    return { marketId: mk.marketId, marketName: mk.marketName, index: mk.index, runners };
  });

  // The WINNER market's winning runner (used for the banner + recent results). Generic.
  const winnerMarket = markets.find((m) => /^WINNER$/i.test(m.marketName));
  const winner = winnerMarket?.runners.find((r) => r.result === 'WINNER')?.name || null;
  // Settled = any market has a decided runner this round.
  const isSettled = markets.some((m) => m.runners.some((r) => r.result === 'WINNER' || r.result === 'LOSER'));

  return {
    eventId: data.eventId,
    roundId: data.roundId,
    eventName: data.eventName,
    status: data.status, // 'ONLINE' (betting open) | 'SUSPEND' (closed)
    seconds: data.leftSec ?? data.seconds ?? null,
    winner,
    isSettled,
    markets,
    receivedAt: data.receivedAt,
  };
}
