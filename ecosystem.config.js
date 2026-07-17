// PM2 process config for the server.
//   pm2 start ecosystem.config.js
//   pm2 logs universe-casino-scraping
//
// Reads env from .env via `node --env-file`. Keep .env on the server (not in git).

module.exports = {
  apps: [
    {
      name: 'universe-casino-scraping',
      script: 'src/server.js',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      max_memory_restart: '300M',
      watch: false,
      env: { NODE_ENV: 'production' },
    },
  ],
}
