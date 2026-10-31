// Universe stream relay.
//
//   provider (WebRTC) ──► this app ──WHIP──► MediaMTX ──WebRTC/LL-HLS──► viewers
//
// One provider pull per table, packets forwarded untouched. MediaMTX does the
// fan-out to viewers and asks this app (auth hook) before serving anyone; the
// monitor watches every viewer connection for abuse and accounts bandwidth.

import http from 'node:http';
import { config, checkConfig } from './config.js';
import { createApp } from './http/app.js';
import { relays } from './relay/relayManager.js';
import { startMonitor } from './monitor/monitor.js';
import { startGeoip } from './monitor/geoip.js';
import { telegramEnabled } from './monitor/telegram.js';

checkConfig();

const server = http.createServer(createApp());

server.listen(config.port, () => {
  console.log(`[server] universe stream relay on http://localhost:${config.port} (${config.production ? 'production' : 'dev'})`);
  console.log(`[server] viewers reach MediaMTX at ${config.mediamtx.publicWebrtcUrl} (WebRTC), ${config.mediamtx.publicHlsUrl} (HLS)`);
  console.log(`[server] admin dashboard: http://localhost:${config.port}/admin${config.admin.password ? '' : ' (disabled: set ADMIN_PASSWORD)'}`);
  if (!telegramEnabled) console.log('[server] Telegram alerts off (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)');
  relays.start();
  startGeoip();
  startMonitor();
});

// Release provider sessions cleanly so the brand account is not left seated.
function shutdown(signal) {
  console.log(`[server] ${signal}, releasing tables`);
  relays.stopAll();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
