#!/usr/bin/env bash
# Upgrade: pull newer images and restart. Data survives in the volumes;
# migrations apply automatically at boot under an advisory lock.
# Pin a version: set APP_IMAGE=ghcr.io/codika-io/codika-platform-template:X.Y.Z in .env first.
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ current version:"
curl -fsS http://localhost:3000/api/v1/instance 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/  \1/p' || echo "  (instance not reachable)"

docker compose pull
docker compose up -d --wait --wait-timeout 180

echo "✔ updated"
curl -fsS http://localhost:3000/readyz >/dev/null && echo "✔ ready" || echo "✖ not ready yet — check: docker compose logs app"
