#!/usr/bin/env bash
# Small load test (exit criterion 7) against a running compose deployment.
# Seeds an owner + API key, then drives autocannon at the health, public API,
# and authenticated (one live DB membership check per request) surfaces.
#   ./scripts/loadtest.sh [base-url]   (default http://localhost:3000)
set -euo pipefail

BASE="${1:-http://localhost:3000}"
EMAIL="loadtest@local.test"
PASS="loadtest-password-123456"

echo "▸ ensuring an owner + API key exist on $BASE"
curl -s -X POST "$BASE/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Loadtest\",\"owner\":{\"email\":\"$EMAIL\",\"name\":\"LT\",\"password\":\"$PASS\"}}" \
  >/dev/null || true
COOKIE=$(mktemp)
curl -s -c "$COOKIE" -X POST "$BASE/api/v1/auth/sign-in/email" -H 'content-type: application/json' \
  -H "origin: $BASE" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null
KEY=$(curl -s -b "$COOKIE" -X POST "$BASE/api/v1/api-keys" -H 'content-type: application/json' \
  -d '{"name":"loadtest","scopes":["data:read"]}' | grep -o '"key":"[^"]*"' | cut -d'"' -f4)
rm -f "$COOKIE"

run() { echo; echo "=== $1"; npx -y autocannon -c 50 -d 10 "${@:2}"; }

run "/healthz (liveness, no deps)" "$BASE/healthz"
run "/api/v1/instance (public discovery)" "$BASE/api/v1/instance"
run "/api/v1/me (authenticated: session→membership check per request)" \
  -H "authorization=Bearer $KEY" "$BASE/api/v1/me"
