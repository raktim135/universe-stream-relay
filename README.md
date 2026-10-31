# universe-stream-relay

Relays **Universe** live-casino dealer video to our viewers with **sub-second latency**,
**original quality** (1080p H.264 + Opus audio, no re-encoding) and low server cost,
and watches every viewer connection for restreaming abuse.

```
 provider ──WebRTC──► Node app ──WHIP (localhost)──► MediaMTX ──WebRTC (WHEP)──► viewers
 (1 pull per table)   forwards packets untouched       fan-out   └──LL-HLS (fallback)──►
                      + monitor / admin dashboard
```

- **One provider pull per table**, however many viewers. Started on first demand,
  released `RELAY_IDLE_MS` after the last viewer leaves (or kept warm via `PREWARM_TABLES`).
- **No transcoding**: bandwidth per viewer equals the source (~0.8–1 Mbps at 1080p).
- **Survives provider drops**: reconnects and keeps publishing to the same MediaMTX path.
- **MediaMTX** (a separate Go binary on the same server) does the per-viewer WebRTC work
  and asks this app before serving anyone (auth hook).
- **Monitor**: live connections per IP, abuse rules with switchable auto-actions,
  Telegram alerts, daily in/out bandwidth in GB, 15 days of history, admin dashboard.

## Layout

```
src/
  index.js              entry: Node version check -> server.js
  server.js             HTTP server, relay manager, monitor, clean shutdown
  config.js             env config + production checks
  db.js                 SQLite store (node:sqlite) + retention
  settings.js           runtime settings (rules, limits, switches), persisted
  viewerToken.js        sign/verify viewer tokens (shared with our platform backend)
  provider/             everything that talks to the brand / Universe
    auth.js, browser.js, watchLink.js, playerSession.js
  mediamtx/
    publisher.js        WHIP publish of one table into MediaMTX
    api.js              MediaMTX control API (paths, viewer sessions, kick)
    authHook.js         MediaMTX HTTP auth hook (tokens + monitor checks)
  relay/
    tableRelay.js       provider session -> publisher, retry/resume
    relayManager.js     which tables run (demand, idle release, prewarm)
    probe.js            source-stream stats
  monitor/
    monitor.js          polls viewer sessions, rules, auto-actions, history
    bandwidth.js        daily traffic accounting
    blocks.js           block list + audit log
    geoip.js            country / network owner (DB-IP Lite, worker-thread import)
    telegram.js         alerts
  admin/
    auth.js             login, session cookie, API token, CSRF, lockout
    routes.js           /admin pages + /admin/api
    loginPage.js, dashboardPage.js
  http/
    app.js              public routes (/watch, /api/video, /health)
    watchPage.js        viewer player (WHEP, HLS fallback, pause when hidden)
mediamtx.yml            MediaMTX config
deploy/nginx.conf       nginx in front (HTTPS, real client IPs)
ecosystem.config.cjs    pm2: relay + MediaMTX
scripts/sign-viewer-token.js
```

## Run locally

Requires **Node 22.13+** (built-in SQLite) and MediaMTX (`brew install mediamtx`, or a
binary from https://github.com/bluenviron/mediamtx/releases).

```bash
cp .env.example .env      # fill BRAND_USERNAME / BRAND_PASSWORD, set ADMIN_PASSWORD
npm install
npm run mediamtx          # terminal 1
npm run dev               # terminal 2
```

- Player: http://localhost:4010/watch/99.0030
- Dashboard: http://localhost:4010/admin

The first start downloads the DB-IP Lite IP database (~12 MB) in the background.

## Public endpoints

| | |
|---|---|
| `GET /watch/:eventId` | Player page to embed in an `<iframe>` (`?token=`, `?mode=hls` to force HLS) |
| `GET /api/video/:eventId` | `{ playUrl, whepUrl, hlsUrl }`, also starts opening the table |
| `GET /health` | `{ ok: true }` for uptime checks |

Universe tables: 99.0030 Lucky 7 · 99.0018 Dragon Tiger · 99.0025 Andar Bahar ·
99.0010 20-20 Teen Patti · 99.0001 Baccarat · 99.0022 32 Cards · 99.0007 Poker

## Admin dashboard and API

`/admin` needs a login (`ADMIN_USERNAME` / `ADMIN_PASSWORD`). Scripts can call
`/admin/api/*` with `Authorization: Bearer <ADMIN_API_TOKEN>`. Without `ADMIN_PASSWORD`
the whole admin area is disabled.

| Endpoint | |
|---|---|
| `GET /admin/api/overview` | viewers, IPs, suspects, tables, today's traffic, service status |
| `GET /admin/api/sessions` | every live connection: IP, country/network, table, protocol, duration, bytes, kbps, loss, client |
| `GET /admin/api/ips` | live connections grouped per IP (connections, tables, longest, bytes) |
| `GET /admin/api/findings` | IPs currently matching a rule |
| `GET /admin/api/history?ip=` | past connections (last `RETENTION_DAYS`) |
| `GET /admin/api/actions` | audit log (detections, kicks, blocks, setting changes) |
| `GET /admin/api/bandwidth?from=&to=` | daily in/out GB per table, viewer hours, peak viewers, unique IPs |
| `GET /admin/api/stats/:eventId` | relay state + source-stream stats |
| `POST /admin/api/sessions/:id/kick` | disconnect one connection |
| `GET/POST /admin/api/blocks`, `DELETE /admin/api/blocks/:ip` | block list (`minutes` empty = permanent) |
| `GET/PUT /admin/api/settings` | rules, limits, switches, lists |

### Rules and auto-actions

Every rule always **detects and reports** (dashboard, log, Telegram). Its action runs only
when the **master switch** (`autoMode`) and **its own switch** are both on. All of this is
editable in the dashboard and survives restarts (stored in `DATA_DIR/relay.db`).

| Rule | Detects | Action (switch) |
|---|---|---|
| Too many connections | IP over `maxConnectionsPerIp` | disconnect its oldest connections (`limitConnections`, on) |
| Many tables | IP on more than `maxEventsPerIp` tables at once | block IP (`blockManyEvents`, off) |
| Non-browser client | ffmpeg, GStreamer, curl, scripts… | block IP (`blockNonBrowser`, on) |
| Very long session | connection over `maxSessionHours` | disconnect it (`kickLongSessions`, off) |
| Foreign IP | country not in `allowedCountries` (IN) | reject (`blockForeign`, off) |
| Hosting IP | cloud / datacenter network | reject (`blockDatacenter`, off) |

Auto-blocks last `blockMinutes` (60). Manual blocks can be permanent and are always
enforced. Allowlisted IPs are never touched. Note that Indian mobile carriers put many
users behind one IP, so keep `maxConnectionsPerIp` generous.

### Telegram alerts

Set `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_CHAT_ID`. Without both, alerts
are skipped. Each finding alerts at most once per 30 min per IP; every auto-action alerts.

## Viewer tokens

The platform backend signs a token per viewer with `VIEWER_TOKEN_SECRET` and puts it on the
player URL (`/watch/99.0030?token=...`):

```js
import { createHmac } from 'node:crypto';
const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('base64url');
const exp = Math.floor(Date.now() / 1000) + 2 * 3600;            // short-lived: 2 h
const token = `${exp}.${sign(String(exp))}`;                       // any IP
// IP-bound (VIEWER_TOKEN_BIND_IP=true): only works from the viewer's IP
const bound = `${exp}.${Buffer.from(ip).toString('base64url')}.${sign(`${exp}.${ip}`)}`;
```

`npm run token [-- <ttl seconds> [ip]]` prints one for testing.

## Production

**Protection in production** (`NODE_ENV=production`). The app refuses to start unless these are set:
- `VIEWER_TOKEN_SECRET` (32+ chars): without a valid token MediaMTX serves nothing, so the
  raw WebRTC/HLS URLs are useless to restreamers. Keep tokens short-lived (1–2 h). Turn on
  `VIEWER_TOKEN_BIND_IP` if your platform can sign with the viewer's IP.
- `ADMIN_PASSWORD` (12+ chars): admin cookies are `Secure`, `HttpOnly`, `SameSite=Strict`.
- Public `MEDIAMTX_PUBLIC_*` URLs.

Embedding of `/watch` is limited to the sites in **Settings → allowed embed domains**
(own site only while the list is empty). Dev mode (`NODE_ENV` unset) has the same
features but only warns, allows any embedder, and runs with open access if no token
secret is set.

**Deploy:**
```bash
# Node 22.13+ and MediaMTX installed
pm2 delete universe-casino-scraping     # old process name, once
pm2 start ecosystem.config.cjs          # starts universe-stream-relay + mediamtx
```
- nginx: see [deploy/nginx.conf](deploy/nginx.conf) (HTTPS, real client IPs, `/internal`
  blocked, login rate limit). The app and MediaMTX trust `X-Forwarded-For` from 127.0.0.1 only.
- Firewall: open 80/443 and UDP **and** TCP `8189` (WebRTC media). Keep 4010, 8888, 8889,
  9997, 9998 closed to the outside (nginx reaches them locally).
- Set `MTX_WEBRTCADDITIONALHOSTS=<server public ip>` for MediaMTX (`ecosystem.config.cjs`).
- If `PORT` changes, update `authHTTPAddress` in `mediamtx.yml` (or set `MTX_AUTHHTTPADDRESS`).
- Capacity: ~1 Mbps per viewer; a 1 Gbps port serves roughly 700–800 viewers.

## Data

`DATA_DIR` (default `data/`, git-ignored) holds `relay.db` (settings, sessions, actions,
blocks, daily bandwidth) and `geoip.db` (IP database, refreshed monthly). History is kept
`RETENTION_DAYS` (15). Back up `relay.db` if you want to keep settings across servers.

IP data by [DB-IP](https://db-ip.com), CC BY 4.0. This is a mirroring tool for internal
use. Keep `.env` out of git.
