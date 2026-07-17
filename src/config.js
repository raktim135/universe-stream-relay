// Central config, read from environment (loaded via `node --env-file=.env`).

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 4010),

  // Brand login (to obtain a JWT that the provider socket + casino APIs accept)
  brandLoginUrl: req('BRAND_LOGIN_URL', 'https://dream444.win/app/users/userLogin'),
  brandCasinoBase: req('BRAND_CASINO_BASE', 'https://casino.dream444.win'),
  brandUsername: req('BRAND_USERNAME'),
  brandPassword: req('BRAND_PASSWORD'),

  // Optional pre-supplied token (skips auto-login until it expires)
  presetToken: process.env.UNIVERSE_TOKEN || '',

  // Provider socket
  socketUrl: req('UNIVERSE_SOCKET_URL', 'wss://casino.unityexch.com'),
  socketPath: process.env.UNIVERSE_SOCKET_PATH || '/universecasino',
  // The provider domain uses GeoDNS — it resolves only from India. On a box in
  // another region the servers still accept the connection, only DNS is fenced, so
  // pin the IP(s) here (comma-separated for failover). Empty = normal DNS.
  socketIps: (process.env.UNIVERSE_SOCKET_IP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Tables to scrape. Each entry is "eventId" or "eventId:Display Name".
  // e.g. TABLES=99.0030:Lucky 7,99.0018:Dragon Tiger
  games: (process.env.TABLES || '99.0030:Lucky 7')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [eventId, ...rest] = s.split(':');
      return { eventId: eventId.trim(), name: (rest.join(':').trim() || eventId.trim()) };
    }),

  // Convenience: just the eventIds.
  get tables() {
    return this.games.map((g) => g.eventId);
  },

  corsOrigin: process.env.CORS_ORIGIN || '*',
};
