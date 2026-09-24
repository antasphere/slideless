#!/usr/bin/env bash
# The federation browser check (PRDCT-2694) — slideless-os
# knowledge/internal/federation.md "The federation dev harness". The drill
# (scripts/federation-drill.sh) drives the hub ↔ Slideless pair over curl, where
# no dashboard runs; this check drives it through a real Chromium, where the
# dashboard's hint-watch signs an Antasphere-only session out the moment the
# hub's SSO hint cookie is missing.
#
# The base harness's single-label names (hub.localhost, slideless.localhost)
# cannot share that cookie: the browser refuses Domain=localhost. So the check
# boots the pair with docker-compose.federation.seamless.yml, which re-homes
# both apps under one parent the browser accepts (hub.ant.localhost,
# slideless.ant.localhost, SSO_HINT_COOKIE_DOMAIN=.ant.localhost on the hub,
# HUB_HINT_COOKIE_DOMAIN=ant.localhost on Slideless). Browsers resolve any
# *.localhost to the loopback; curl below pins the names with --resolve.
#
# What it proves, in one browser step: a person opens cloud Slideless, clicks
# "Sign in with Antasphere", signs in at the hub, lands on the dashboard, the
# hint cookie is there, and the session is still signed in a few seconds later
# (no POST /api/v1/sso/logout, no bounce to /login).
#
# It is separate from the drill on purpose: the drill's legs are wired to the
# single-label names and to the delay hop the drill overlay pins hub.localhost
# to, and CI's drill must stay byte-identical. CI does not run this check.
#
# Usage: ./scripts/federation-browser-check.sh
#   FEDERATION_HUB_DIR, FEDERATION_PROJECT, FEDERATION_HUB_PORT, FEDERATION_SL_PORT,
#   FEDERATION_MAIL_PORT, FEDERATION_HUB_IMAGE, FEDERATION_SL_IMAGE
#                     as for the drill (see docker-compose.federation.yml); the
#                     project defaults to slideless-federation-browser here
#   BROWSER_SKIP_BUILD=1  reuse the two images instead of building them
#   BROWSER_KEEP=1        leave the stack up after a PASS (`down -v` yourself)
#   BROWSER_HEADED=1      show the browser window
# Needs docker, jq, curl, openssl, node and the dashboard's Playwright Chromium
# (`pnpm install`, then `pnpm --filter @slideless/dashboard exec playwright install chromium`).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export FEDERATION_PROJECT=${FEDERATION_PROJECT:-slideless-federation-browser}
HUB_PORT=${FEDERATION_HUB_PORT:-3300}
SL_PORT=${FEDERATION_SL_PORT:-3310}
HUB=http://hub.ant.localhost:$HUB_PORT
SL=http://slideless.ant.localhost:$SL_PORT

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  exit 1
}

for bin in docker jq curl openssl node; do
  command -v "$bin" >/dev/null || fail "required tool missing: $bin"
done
for port in "$HUB_PORT" "$SL_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
    fail "port $port already answers — refusing to run (the check needs $HUB_PORT and $SL_PORT)"
  fi
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/federation-browser.XXXXXX")"
SETUP_TOKEN="$(openssl rand -hex 16)"
# The claim credential both setups need, for this run only.
cat >"$SCRATCH/setup-token.yml" <<EOF
services:
  app:
    environment:
      - SETUP_TOKEN=$SETUP_TOKEN
  hub:
    environment:
      - SETUP_TOKEN=$SETUP_TOKEN
EOF

dc() {
  docker compose -p "$FEDERATION_PROJECT" \
    -f "$REPO/docker-compose.federation.yml" -f "$REPO/docker-compose.federation.seamless.yml" \
    -f "$SCRATCH/setup-token.yml" "$@"
}
CURL=(curl -sS --max-time 60 --resolve "hub.ant.localhost:$HUB_PORT:127.0.0.1" --resolve "slideless.ant.localhost:$SL_PORT:127.0.0.1")

CLEANED=0
cleanup() {
  local status=$?
  [ "$CLEANED" = 1 ] && exit "$status"
  CLEANED=1
  if [ "$status" != 0 ]; then
    for svc in hub app; do
      echo "── logs: $svc ──" >&2
      dc logs --no-log-prefix "$svc" 2>/dev/null | tail -30 >&2 || true
    done
  fi
  if [ "$status" = 0 ] && [ "${BROWSER_KEEP:-}" = "1" ]; then
    echo "  BROWSER_KEEP=1: stack left up (project $FEDERATION_PROJECT)"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
  if [ "$status" = 0 ]; then
    printf '\n\033[32m✔ federation browser check passed\033[0m\n'
  else
    printf '\n\033[31m✘ federation browser check FAILED\033[0m\n' >&2
  fi
  exit "$status"
}
trap cleanup EXIT

wait_ready() { # url timeout_s
  local i=0
  until "${CURL[@]}" -o /dev/null -f "$1" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge "$2" ] && fail "$1 not ready after $2 s"
    sleep 1
  done
}

say "Images and up"
if [ "${BROWSER_SKIP_BUILD:-}" = "1" ]; then
  dc up -d --no-build
else
  dc up -d --build
fi
wait_ready "$HUB/readyz" 180
wait_ready "$SL/readyz" 180

say "Both setups"
OWNER_EMAIL=browser-owner@browser.test
OWNER_PASSWORD="browser-owner-password-$(openssl rand -hex 6)"
"${CURL[@]}" -f -o /dev/null -X POST "$HUB/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Browser Hub\",\"setupToken\":\"$SETUP_TOKEN\",\"owner\":{\"email\":\"$OWNER_EMAIL\",\"name\":\"Browser Owner\",\"password\":\"$OWNER_PASSWORD\"}}" ||
  fail "hub setup refused"
"${CURL[@]}" -f -o /dev/null -X POST "$SL/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Browser Slideless\",\"setupToken\":\"$SETUP_TOKEN\",\"owner\":{\"email\":\"sl-operator@browser.test\",\"name\":\"SL Operator\",\"password\":\"$OWNER_PASSWORD\"}}" ||
  fail "Slideless setup refused"
"${CURL[@]}" "$SL/api/v1/instance" | jq -e '.auth.sso.hintCookieDomain == "ant.localhost"' >/dev/null ||
  fail "Slideless does not announce the ant.localhost hint domain"

say "The browser step: sign in with Antasphere and stay signed in"
SL_URL="$SL" OWNER_EMAIL="$OWNER_EMAIL" OWNER_PASSWORD="$OWNER_PASSWORD" \
  node "$REPO/scripts/lib/federation-browser.mjs"
if dc logs --no-log-prefix app 2>/dev/null | grep -q 'sso logout'; then
  fail "the Slideless log shows an sso logout during the browser step"
fi
