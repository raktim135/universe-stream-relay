// Static price resolver. The provider socket carries every game's markets + runner
// names + results, but NOT the decimal prices (those are fixed client-side). We map
// them here. Resolution order: per-game exact runner name -> shared name -> single
// card rank -> odds ratio parsed from the market name ("1:4") -> null.
//
// Prices read from the live ref games (dream444). Add a game by adding its overrides.

// Shared across games, keyed by (uppercased) runner name.
const SHARED = {
  RED: 1.95, BLACK: 1.95,
  SPADES: 3.75, HEARTS: 3.75, DIAMONDS: 3.75, CLUBS: 3.75,
};

// Per-game overrides, keyed by eventId then uppercased runner name.
const PER_GAME = {
  // LUCKY 7
  '99.0030': {
    'LOW CARD ( A TO 6 )': 2, 'HIGH CARD ( 8 TO K )': 2,
    ODD: 1.81, EVEN: 2.14,
  },
  // DRAGON TIGER
  '99.0018': {
    DRAGON: 2, TIGER: 2, TIE: 11,
    'DRAGON ODD': 2, 'DRAGON EVEN': 2, 'TIGER ODD': 2, 'TIGER EVEN': 2,
  },
  // ANDAR BAHAR
  '99.0025': {
    '1ST BET A': 2, '1ST BET B': 2, '2ND BET A': 2, '2ND BET B': 2,
    'SIDE BET A': 12, 'SIDE BET B': 12, ODD: 1.83, EVEN: 2.12,
  },
  // 20-20 TEEN PATTI (WINNER only; the side markets carry their odds in the market name)
  '99.0010': { 'PLAYER A': 1.98, 'PLAYER B': 1.98 },
};

const RANKS = new Set(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);

export function priceFor(eventId, marketName, runnerName) {
  const rn = String(runnerName || '').trim().toUpperCase();
  const g = PER_GAME[eventId];
  if (g && g[rn] != null) return g[rn];
  if (SHARED[rn] != null) return SHARED[rn];
  if (RANKS.has(rn)) return 12; // single card rank (LUCKY CARD / DRAGON CARD / etc.)
  // Odds ratio baked into the market name, e.g. "PAIR ( DUBBLE ) 1:4" -> 4
  const m = String(marketName || '').match(/1:\s*([\d.]+)/);
  if (m) return Number(m[1]);
  return null;
}
