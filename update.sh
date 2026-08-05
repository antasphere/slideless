#!/usr/bin/env bash
# Upgrade: pull newer images and restart. Data survives in the volumes;
# migrations apply automatically at boot under an advisory lock.
# Pin a version: set APP_IMAGE=ghcr.io/antasphere/slideless:X.Y.Z in .env first.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
# shellcheck source=scripts/lib/dr-lib.sh
. "$SCRIPT_DIR/scripts/lib/dr-lib.sh"

# Read the published port from .env instead of assuming 3000. A hardcoded
# port made this script probe the wrong endpoint on every instance with a
# custom APP_PORT and report a healthy upgrade as "not ready".
APP_PORT=$(dr_env_get .env APP_PORT)
APP_PORT="${APP_PORT:-3000}"
APP_BIND=$(dr_env_get .env APP_BIND)
case "${APP_BIND:-127.0.0.1}" in
  '' | 0.0.0.0 | '::' | localhost) PROBE_HOST=127.0.0.1 ;;
  *) PROBE_HOST="$APP_BIND" ;;
esac
BASE="http://${PROBE_HOST}:${APP_PORT}"

echo "▸ current version:"
curl -fsS "$BASE/api/v1/instance" 2> /dev/null | sed -n 's/.*"version":"\([^"]*\)".*/  \1/p' || echo "  (instance not reachable)"

docker compose pull
docker compose up -d --wait --wait-timeout 180

echo "✔ updated"
curl -fsS "$BASE/readyz" > /dev/null && echo "✔ ready" || echo "✖ not ready yet — check: docker compose logs app"
