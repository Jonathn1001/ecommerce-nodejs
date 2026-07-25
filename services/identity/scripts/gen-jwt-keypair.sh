#!/usr/bin/env bash
# Generates the RS256 keypair Phase 6 runs on. Identity keeps the private half; the gateway
# gets only the public half. Run once, paste the output into the (gitignored) per-service env
# files: JWT_PRIVATE_KEY for identity, JWT_PUBLIC_KEY for the gateway.
#
#   ./services/identity/scripts/gen-jwt-keypair.sh
#
# Newlines are escaped to \n so each PEM survives as a single env-file line.
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/private.pem" 2>/dev/null
openssl rsa -in "$tmp/private.pem" -pubout -out "$tmp/public.pem" 2>/dev/null

escape() { awk 'BEGIN{ORS="\\n"} {print}' "$1"; }

echo "# --- services/identity/.env ---"
echo "JWT_PRIVATE_KEY=\"$(escape "$tmp/private.pem")\""
echo
echo "# --- services/gateway/.env ---"
echo "JWT_PUBLIC_KEY=\"$(escape "$tmp/public.pem")\""
