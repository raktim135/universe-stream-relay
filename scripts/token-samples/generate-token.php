<?php
// Standalone viewer-token generator (PHP 7.2+, no dependencies).
// Copy the relayViewerToken() function into the platform backend.
//
//   VIEWER_TOKEN_SECRET=... php generate-token.php [--ttl=7200] [--ip=1.2.3.4] [--table=99.0030] [--base=https://us.igames.cloud]
//
// Token: "<exp>.<base64url(HMAC-SHA256(secret, "<exp>"))>"
//    or, IP-bound: "<exp>.<base64url(ip)>.<base64url(HMAC-SHA256(secret, "<exp>.<ip>"))>"

function b64url(string $raw): string
{
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

function relayViewerToken(string $secret, int $ttlSeconds = 7200, string $ip = ''): string
{
    $exp = time() + $ttlSeconds;
    if ($ip === '') {
        return $exp . '.' . b64url(hash_hmac('sha256', (string) $exp, $secret, true));
    }
    return $exp . '.' . b64url($ip) . '.' . b64url(hash_hmac('sha256', $exp . '.' . $ip, $secret, true));
}

$opts = getopt('', ['ttl:', 'ip:', 'table:', 'base:', 'secret:']);
$secret = getenv('VIEWER_TOKEN_SECRET') ?: ($opts['secret'] ?? '');
if ($secret === '') {
    fwrite(STDERR, "Set VIEWER_TOKEN_SECRET (or pass --secret=...).\n");
    exit(1);
}
$ttl = (int) ($opts['ttl'] ?? 7200) ?: 7200;
$ip = $opts['ip'] ?? '';
$table = $opts['table'] ?? '99.0030';
$base = rtrim($opts['base'] ?? 'https://us.igames.cloud', '/');

$token = relayViewerToken($secret, $ttl, $ip);
echo "token:   $token\n";
echo 'expires: ' . gmdate('Y-m-d\TH:i:s\Z', time() + $ttl) . ($ip ? "  (only from $ip)" : '') . "\n";
echo "player:  $base/watch/$table?token=" . rawurlencode($token) . "\n";
