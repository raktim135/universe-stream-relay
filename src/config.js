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
  socketUrl: req('UNIVERSE_SOCKET_URL', 'wss://casino.unityexch.com/universecasino'),
  socketPath: process.env.UNIVERSE_SOCKET_PATH || '/socket.io',

  // Tables to scrape
  tables: (process.env.TABLES || '99.0030')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  corsOrigin: process.env.CORS_ORIGIN || '*',
};
