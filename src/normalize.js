// Turns a raw `casino_odds` payload into a clean, game-agnostic shape for clients.
//
// Two arrays in the payload matter:
//   - `marketArr`  -> LIVE per-runner odds (`price.back[].price`), volume (`.size`),
//                     per-runner status, and market min/max limits. This is the real
//                     odds feed — nothing is hardcoded.
//   - `resultsArr` -> the settled WINNER/LOSER per runner for the current round.
// We merge them: price/size/status from marketArr, result from resultsArr.

// Drawn cards are in `cardsArr`, whose shape differs per game:
//   Lucky 7:      { card: "SQ_" }
//   Dragon Tiger: { DRAGON: { card_1: "S7_" }, TIGER: { card_1: "0" } }
//   Andar Bahar:  { ANDAR_CARDS: ["S7_"], BAHAR_CARDS: [] }
//   Teen Patti:   { PLAYER_A: { card_1, card_2, card_3 }, PLAYER_B: {...} }
// A card code is "<suit><rank>_" (S/H/D/C + A/2..10/J/Q/K); "0" = not dealt yet.
// We walk the structure generically and return a flat list of dealt cards.
function extractCards(cardsArr) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (v && v !== '0' && /^[SHDC]/i.test(v)) out.push(parseCard(v));
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.values(v).forEach(walk); }
  };
  walk(cardsArr);
  return out;
}
function parseCard(code) {
  const suit = code[0].toUpperCase();
  const rank = code.slice(1).replace(/_/g, '');
  const symbol = { S: '♠', H: '♥', D: '♦', C: '♣' }[suit] || '';
  return { rank, suit: symbol, red: suit === 'H' || suit === 'D', code };
}

export function normalize(data) {
  if (!data) return null;

  // result lookup: marketId -> { selectionId: 'WINNER'|'LOSER'|'' }
  const resultByMarket = {};
  for (const rm of data.resultsArr || []) resultByMarket[rm.marketId] = rm.runners || {};

  const markets = (data.marketArr || []).map((mk) => {
    const results = resultByMarket[mk.marketId] || {};
    const names = mk.runnersName || {};
    const runners = (mk.runners || []).map((r) => {
      const back = r.price?.back?.[0] || {};
      return {
        selectionId: r.selectionId,
        name: names[r.selectionId] || String(r.selectionId),
        price: back.price ?? null, // live odds from the feed
        size: back.size ?? null,   // live volume from the feed
        status: r.status || null,  // per-runner OPEN / SUSPEND
        result: results[r.selectionId] || '', // 'WINNER' | 'LOSER' | ''
      };
    });
    return {
      marketId: mk.marketId,
      marketName: mk.marketName,
      index: mk.index,
      min: mk.min ?? null,
      max: mk.max ?? null,
      runners,
    };
  });

  // The WINNER market's winning runner (used for the banner + recent results). Generic.
  const winnerMarket = markets.find((m) => /^WINNER$/i.test(m.marketName));
  const winner = winnerMarket?.runners.find((r) => r.result === 'WINNER')?.name || null;
  const isSettled = markets.some((m) => m.runners.some((r) => r.result === 'WINNER' || r.result === 'LOSER'));

  return {
    eventId: data.eventId,
    roundId: data.roundId,
    eventName: data.eventName,
    status: data.status, // 'ONLINE' (betting open) | 'SUSPEND' (closed)
    seconds: data.leftSec ?? data.seconds ?? null,
    winner,
    isSettled,
    cards: extractCards(data.cardsArr), // dealt cards this round (empty during betting)
    markets,
    receivedAt: data.receivedAt,
  };
}
