// Turns a raw `casino_odds` payload into a clean shape for the client.
//
// The socket carries only the DYNAMIC state (round, timer, status, drawn card,
// winners). The decimal PRICES for Lucky 7 are fixed per selection and defined in
// the game client, so we attach them here from a static map (by selectionId).

// Lucky 7 fixed prices, keyed by selectionId (from the live market definition).
const LUCKY7_PRICE = {
  // WINNER
  '58259208606': 2.0, // LOW CARD ( A to 6 )
  '58259808605': 2.0, // HIGH CARD ( 8 to K )
  // LUCKY ODD/EVEN
  '995566': 1.81, // ODD
  '665566': 2.14, // EVEN
  // LUCKY COLOR
  '58259733': 1.95, // RED
  '5825925225': 1.95, // BLACK
  // LUCKY CARD SUIT
  '58259772337': 3.75, // SPADES
  '58259432787': 3.75, // HEARTS
  '5825934266637': 3.75, // DIAMONDS
  '5825925827': 3.75, // CLUBS
  // LUCKY CARD A..K = 12.0 each
  '5825901': 12, '5825902': 12, '5825903': 12, '5825904': 12, '5825905': 12,
  '5825906': 12, '5825907': 12, '5825908': 12, '5825909': 12, '58259010': 12,
  '58259011': 12, '58259012': 12, '58259013': 12,
};

export function normalize(data) {
  if (!data) return null;

  const markets = (data.resultsArr || []).map((m) => {
    const runners = Object.entries(m.runnersName || {}).map(([selectionId, name]) => ({
      selectionId,
      name,
      price: LUCKY7_PRICE[selectionId] ?? null,
      result: (m.runners && m.runners[selectionId]) || '', // 'WINNER' | 'LOSER' | ''
    }));
    return {
      marketId: m.marketId,
      marketName: m.marketName,
      index: m.index,
      runners,
    };
  });

  return {
    eventId: data.eventId,
    roundId: data.roundId,
    eventName: data.eventName,
    status: data.status, // 'ONLINE' (betting open) | 'SUSPEND' (closed)
    seconds: data.leftSec ?? data.seconds ?? null,
    card: data.cardsArr?.card && data.cardsArr.card !== '0' ? data.cardsArr.card : null,
    isSettled: !!(data.cardsArr?.card && data.cardsArr.card !== '0'),
    markets,
    receivedAt: data.receivedAt,
  };
}
