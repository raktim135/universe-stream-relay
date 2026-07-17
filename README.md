# universe-casino-scraping

Scrapes **Universe** live-casino games (Lucky 7, etc.) and re-broadcasts their
**odds / round state / winner** and **live video** to our own clients.

## How it works

```
 Universe provider socket                 this service                     our clients
 wss://casino.unityexch.com  ──casino_odds──►  UniverseClient  ──state──►  Socket.IO + REST
   (socket.io, brand JWT)                        (latest per table)          (Next test page)
 casino.<brand>/casinoapp     ──video creds──►  streaming.js   ──iframeUrl─►  <iframe> player
```

1. **Auth** (`src/auth.js`) — logs into a brand that carries the Universe games
   (dream444 for this test) via `POST /app/users/userLogin`, gets a JWT. The same
   JWT authenticates both the provider socket and the brand casino REST APIs.
   Auto-refreshes ~3 min before the ~5h expiry.
2. **Odds/round/winner** (`src/universeClient.js`) — socket.io to
   `wss://casino.unityexch.com/universecasino` (path `/universecasino`, websocket,
   connect auth `{token, uType:"usr"}`). Subscribe with `emit("SCSN", [eventId])`;
   live data arrives on the `casino_odds` event. Latest state kept per table.
3. **Video** (`src/streaming.js`) — `POST /casinoapp/exchange/users/streaming/casinoGameStreaming`
   returns CDN creds; we build the Universe player iframe URL (WebRTC under the hood).
4. **Re-broadcast** (`src/server.js`) — Socket.IO pushes normalized `state` to clients;
   REST endpoints for snapshot/video.

## Run

```bash
cp .env.example .env      # fill BRAND_USERNAME / BRAND_PASSWORD (test creds already in example)
npm install
npm start                 # http://localhost:4010
```

### Endpoints
- `GET /health`
- `GET /api/tables`
- `GET /api/state/:eventId`  (e.g. `99.0030` = Lucky 7) — normalized odds/round/winner
- `GET /api/video/:eventId`  — `{ iframeUrl, creds }`
- Socket.IO: connect and listen for `state` (per-update) and `status`.

## Normalized `state` shape

```json
{
  "eventId": "99.0030",
  "roundId": "9301707112526",
  "eventName": "LUCKY 7 - A",
  "status": "ONLINE",          // ONLINE = betting open, SUSPEND = closed
  "seconds": 17,               // countdown
  "card": "SQ_",               // drawn card, null until revealed
  "isSettled": true,
  "markets": [
    { "marketName": "WINNER", "runners": [
      { "selectionId": "58259208606", "name": "LOW CARD ( A to 6 )", "price": 2.0, "result": "LOSER" },
      { "selectionId": "58259808605", "name": "HIGH CARD ( 8 to K )", "price": 2.0, "result": "WINNER" }
    ]}
    // ... LUCKY ODD/EVEN, LUCKY COLOR, LUCKY CARD SUIT, LUCKY CARD
  ]
}
```

## Notes
- Lucky 7 decimal prices are fixed per selection and defined client-side; the socket
  only carries dynamic state. Prices live in `src/normalize.js` (`LUCKY7_PRICE`).
- Video transport is WebRTC via the Universe player iframe. Embedding the iframe just
  re-shows their player; self-hosting/recording the WebRTC stream is a separate effort.
- This is a scraping/mirroring tool for internal use. Keep `.env` (brand creds) out of git.
