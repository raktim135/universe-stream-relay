// MediaMTX HTTP auth hook (authMethod: http). MediaMTX POSTs every publish,
// read and API request here; 2xx allows it.
//
//   publish / api / metrics -> only this app (user "relay" + per-boot secret)
//   read                    -> viewers: valid viewer token (when configured),
//                              then block list / country / hosting / connection
//                              limit checks (src/monitor/monitor.js). An allowed
//                              read also tells the relay someone wants that table.

import { config } from '../config.js';
import { verifyViewerToken } from '../viewerToken.js';
import { checkViewer } from '../monitor/monitor.js';

// Universe event ids look like "99.0030". Anything else never starts a pull.
export const TABLE_ID = /^\d{1,4}\.\d{1,6}$/;

function queryToken(query) {
  try {
    return new URLSearchParams(query || '').get('token') || '';
  } catch {
    return '';
  }
}

export function authHook({ onRead }) {
  return async (req, res) => {
    const b = req.body || {};
    const internal = b.user === 'relay' && b.password === config.internalSecret;

    switch (b.action) {
      case 'publish':
      case 'api':
      case 'metrics':
        return res.status(internal ? 200 : 401).end();

      case 'read': {
        if (!TABLE_ID.test(b.path || '')) return res.status(404).end();
        if (internal) return res.status(200).end();
        const ip = String(b.ip || '').replace(/^::ffff:/, '');
        if (config.viewer.tokenSecret) {
          const token = b.token || b.password || queryToken(b.query);
          if (!verifyViewerToken(config.viewer.tokenSecret, token, { ip, requireIp: config.viewer.bindIp })) {
            return res.status(401).end();
          }
        }
        const rejected = await checkViewer(ip, b.path, b.protocol);
        if (rejected) return res.status(403).end();
        onRead(b.path);
        return res.status(200).end();
      }

      default:
        return res.status(403).end();
    }
  };
}
