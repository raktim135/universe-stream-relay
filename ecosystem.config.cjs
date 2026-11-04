// PM2 process config: the Node relay and MediaMTX side by side on one server.
//   pm2 start ecosystem.config.cjs
//   pm2 logs universe-stream-relay
//
// The relay reads .env via `node --env-file`. MediaMTX reads mediamtx.yml.
// pm2 does not search PATH: a bare script name is taken from this directory,
// so the MediaMTX script must be the absolute binary. Set
// MTX_WEBRTCADDITIONALHOSTS to the server's public IPv4 before `pm2 start`.

const mediamtxEnv = {
  // Must match PORT in .env. This server listens on 4020.
  MTX_AUTHHTTPADDRESS: process.env.MTX_AUTHHTTPADDRESS || 'http://127.0.0.1:4020/internal/mediamtx/auth',
};
if (process.env.MTX_WEBRTCADDITIONALHOSTS) {
  mediamtxEnv.MTX_WEBRTCADDITIONALHOSTS = process.env.MTX_WEBRTCADDITIONALHOSTS;
}

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
      script: process.env.MEDIAMTX_BIN || '/usr/local/bin/mediamtx',
      args: 'mediamtx.yml',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      env: mediamtxEnv,
    },
  ],
};
