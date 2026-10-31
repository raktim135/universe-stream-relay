// PM2 process config: the Node relay and MediaMTX side by side on one server.
//   pm2 start ecosystem.config.cjs
//   pm2 logs universe-stream-relay
//
// The relay reads .env via `node --env-file`. MediaMTX reads mediamtx.yml;
// override keys with MTX_* env vars (e.g. the server's public IP below).

module.exports = {
  apps: [
    {
      name: 'universe-stream-relay',
      script: 'src/index.js',
      node_args: '--disable-warning=ExperimentalWarning --env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      max_memory_restart: '300M',
      kill_timeout: 3000,
      watch: false,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'mediamtx',
      script: process.env.MEDIAMTX_BIN || 'mediamtx',
      args: 'mediamtx.yml',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      env: {
        // MTX_WEBRTCADDITIONALHOSTS: '<server public ip>',
      },
    },
  ],
};
