#!/usr/bin/env node
// Standalone viewer-token generator (Node 16+, no dependencies).
// Copy it anywhere; the platform backend signs tokens exactly like this.
//
//   VIEWER_TOKEN_SECRET=... node generate-token.mjs [--ttl 7200] [--ip 1.2.3.4] [--table 99.0030] [--base https://us.igames.cloud]
//
// Token: "<exp>.<base64url(HMAC-SHA256(secret, "<exp>"))>"
//    or, IP-bound: "<exp>.<base64url(ip)>.<base64url(HMAC-SHA256(secret, "<exp>.<ip>"))>"

import { createHmac } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith('--') ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []),
);
const secret = process.env.VIEWER_TOKEN_SECRET || args.secret;
if (!secret) {
  console.error('Set VIEWER_TOKEN_SECRET (or pass --secret).');
  process.exit(1);
}
const ttl = Number(args.ttl) || 7200;
const ip = args.ip || '';
const table = args.table || '99.0030';
const base = (args.base || 'https://us.igames.cloud').replace(/\/+$/, '');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (payload) => createHmac('sha256', secret).update(payload).digest();

const exp = Math.floor(Date.now() / 1000) + ttl;
const token = ip ? `${exp}.${b64url(ip)}.${b64url(hmac(`${exp}.${ip}`))}` : `${exp}.${b64url(hmac(String(exp)))}`;

console.log(`token:   ${token}`);
console.log(`expires: ${new Date(exp * 1000).toISOString()}${ip ? `  (only from ${ip})` : ''}`);
console.log(`player:  ${base}/watch/${table}?token=${encodeURIComponent(token)}`);
