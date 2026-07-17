// GeoDNS workaround. The provider host resolves only from India; on a box elsewhere
// DNS returns nothing but the servers accept the connection. socket.io's `lookup`
// option does not reach the ws transport, so we patch dns.lookup globally — this is
// what net/tls fall back to, so the ws connection uses our pinned IP while TLS SNI
// and the Host header stay the real hostname (exactly like `curl --resolve`).
//
// Import this module BEFORE anything opens the socket.

import dns from 'node:dns';
import { config } from './config.js';

let pinnedHost = '';
try { pinnedHost = new URL(config.socketUrl).hostname; } catch { /* ignore */ }

let ipIndex = 0;

export function rotatePinnedIp() {
  if (config.socketIps.length > 1) {
    ipIndex = (ipIndex + 1) % config.socketIps.length;
    console.warn(`[dnsPin] rotating pinned IP -> ${config.socketIps[ipIndex]}`);
  }
}

export function currentPinnedIp() {
  return config.socketIps[ipIndex % config.socketIps.length];
}

if (config.socketIps.length && pinnedHost) {
  const origLookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (hostname === pinnedHost) {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? {} : options || {};
      const ip = currentPinnedIp();
      const family = ip.includes(':') ? 6 : 4;
      if (opts.all) return cb(null, [{ address: ip, family }]);
      return cb(null, ip, family);
    }
    return origLookup.call(dns, hostname, options, callback);
  };
  console.log(`[dnsPin] ${pinnedHost} pinned -> ${config.socketIps.join(', ')}`);
}
