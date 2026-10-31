// Prints a viewer token for testing: npm run token [-- <ttl seconds> [ip]]
// In production our platform backend signs these the same way (see src/viewerToken.js).

import { signViewerToken } from '../src/viewerToken.js';

const secret = process.env.VIEWER_TOKEN_SECRET;
if (!secret) {
  console.error('VIEWER_TOKEN_SECRET is not set in .env');
  process.exit(1);
}
const [ttl, ip] = process.argv.slice(2);
console.log(signViewerToken(secret, { ttlSec: Number(ttl) || 2 * 3600, ip: ip || '' }));
