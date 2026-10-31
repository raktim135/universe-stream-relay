#!/usr/bin/env bash
# Standalone viewer-token generator (bash + openssl only).
#
#   VIEWER_TOKEN_SECRET=... ./generate-token.sh [ttl_seconds] [table] [base_url]
#
# Token: "<exp>.<base64url(HMAC-SHA256(secret, "<exp>"))>"  (IP-bound tokens: use the Node or PHP sample)

set -euo pipefail

secret="${VIEWER_TOKEN_SECRET:?Set VIEWER_TOKEN_SECRET}"
ttl="${1:-7200}"
table="${2:-99.0030}"
base="${3:-https://us.igames.cloud}"

exp=$(( $(date +%s) + ttl ))
sig=$(printf '%s' "$exp" | openssl dgst -sha256 -hmac "$secret" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
token="$exp.$sig"

echo "token:   $token"
echo "expires: $(date -u -r "$exp" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$exp" +%Y-%m-%dT%H:%M:%SZ)"
echo "player:  ${base%/}/watch/$table?token=$token"
