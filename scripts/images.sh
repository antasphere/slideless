#!/usr/bin/env bash
# Deck pictures on a self-hosted install (PRDCT-2790): turn the optional
# renderer container on or off, or say where it stands.
#
#   ./scripts/images.sh on       check the sandbox, then turn pictures on and restart
#   ./scripts/images.sh off      turn pictures off and restart (cards show a plain block)
#   ./scripts/images.sh status   say whether pictures are on and the renderer is up
#
# `on` never turns pictures on where they cannot work: it pulls the renderer
# image and runs its self-check under the compose file's own settings (the
# seccomp profile deploy/seccomp-chromium.json). Only when Chromium starts
# SANDBOXED on this host does it write the three .env lines (COMPOSE_PROFILES
# gains `images`, SLIDELESS_RENDERER_URL, SLIDELESS_RENDERER_SECRET) and
# restart. Otherwise it leaves .env untouched, says why, and exits non-zero:
# 3 when the sandbox cannot start here, 4 when the image cannot be pulled,
# 1 for anything else. The renderer never runs Chromium unsandboxed.
#
# setup.sh runs `on --no-start` on a fresh install (the stack starts right
# after); SLIDELESS_IMAGES=off in its environment skips it.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/dr-lib.sh
. "$(pwd)/scripts/lib/dr-lib.sh"

ENV_FILE=.env
RENDERER_URL=http://renderer:3100

usage() {
  echo "usage: $0 on [--no-start] | off | status" >&2
  exit 2
}

# The comma list COMPOSE_PROFILES holds, with `images` added or removed.
profiles_with() {
  local current="$1" out="" p
  local IFS=,
  for p in $current; do
    [ -z "$p" ] || [ "$p" = images ] || out="${out:+$out,}$p"
  done
  echo "${out:+$out,}images"
}
profiles_without() {
  local current="$1" out="" p
  local IFS=,
  for p in $current; do
    [ -z "$p" ] || [ "$p" = images ] || out="${out:+$out,}$p"
  done
  echo "$out"
}
has_images_profile() {
  case ",$(dr_env_get "$ENV_FILE" COMPOSE_PROFILES)," in
    *,images,*) return 0 ;;
    *) return 1 ;;
  esac
}

cmd_on() {
  local start=1
  case "${1:-}" in
    '') ;;
    --no-start) start=0 ;;
    *) usage ;;
  esac

  # Keep a secret already there (an earlier `on`, or one set by hand), so the
  # app and a running renderer never disagree; mint one otherwise.
  local secret
  secret=$(dr_env_get "$ENV_FILE" SLIDELESS_RENDERER_SECRET)
  [ "${#secret}" -ge 16 ] || secret=$(openssl rand -hex 32)

  # The image the compose file names for the renderer (RENDERER_IMAGE or its default).
  local image
  image=$(docker compose --profile images config --images renderer) || image=""
  [ -n "$image" ] || dr_fail "could not read the renderer image from the compose file (compose's own error, if any, is above)"

  dr_info "pulling the renderer image (deck pictures)"
  if ! docker compose --profile images pull renderer; then
    dr_warn "the renderer image could not be pulled; trying a copy already on this host"
  fi
  # Never let the check below fall back to BUILDING the renderer: the checkout's compose
  # file carries a build section, and `compose run` builds a missing image from source
  # (minutes and a gigabyte on the host, then an unpublished build turned on).
  if ! docker image inspect "$image" > /dev/null 2>&1; then
    dr_warn "the renderer image ($image) could not be pulled and there is no copy on this host, so deck
  pictures stay off (the cards show a plain block). Nothing changed. Try again later with ./scripts/images.sh on"
    return 4
  fi

  dr_info "checking that the browser's sandbox starts on this host"
  local code=0
  docker compose --profile images run --rm --no-deps -T renderer node dist/selfcheck.js || code=$?
  case "$code" in
    0) ;;
    3)
      dr_warn "the browser that makes deck pictures cannot start its sandbox on this host, so pictures stay off
  (the cards show a plain block; everything else works). Nothing changed. The renderer never runs the
  browser unsandboxed: see \"Deck images\" in docs/self-hosting/install.md for what the host needs."
      return 3
      ;;
    *)
      dr_warn "the renderer's self-check failed (exit $code), so deck pictures stay off. Nothing changed.
  Its output is above; ./scripts/images.sh on tries again."
      return 1
      ;;
  esac

  dr_env_set "$ENV_FILE" SLIDELESS_RENDERER_SECRET "$secret"
  dr_env_set "$ENV_FILE" SLIDELESS_RENDERER_URL "$RENDERER_URL"
  dr_env_set "$ENV_FILE" COMPOSE_PROFILES "$(profiles_with "$(dr_env_get "$ENV_FILE" COMPOSE_PROFILES)")"
  dr_success "deck pictures on"

  if [ "$start" = 1 ]; then
    dr_info "restarting with the renderer"
    docker compose up -d --wait --wait-timeout 180
  fi
}

cmd_off() {
  [ $# -eq 0 ] || usage
  local rest
  rest=$(profiles_without "$(dr_env_get "$ENV_FILE" COMPOSE_PROFILES)")
  if [ -n "$rest" ]; then
    dr_env_set "$ENV_FILE" COMPOSE_PROFILES "$rest"
  else
    dr_env_unset "$ENV_FILE" COMPOSE_PROFILES
  fi
  # The URL goes, the secret stays: harmless without the URL, and a later
  # `on` reuses it.
  dr_env_unset "$ENV_FILE" SLIDELESS_RENDERER_URL
  dr_info "stopping the renderer and restarting the app without it"
  docker compose --profile images rm --stop --force renderer
  docker compose up -d --wait --wait-timeout 180
  dr_success "deck pictures off (the cards show a plain block)"
}

cmd_status() {
  [ $# -eq 0 ] || usage
  if has_images_profile && [ -n "$(dr_env_get "$ENV_FILE" SLIDELESS_RENDERER_URL)" ]; then
    echo "deck pictures: on"
    docker compose --profile images ps renderer
  else
    echo "deck pictures: off (turn them on with ./scripts/images.sh on)"
  fi
}

[ -f "$ENV_FILE" ] || dr_fail "no .env in $(pwd): run ./setup.sh first"
command -v docker > /dev/null || dr_fail "docker is required"

action="${1:-}"
[ $# -eq 0 ] || shift
case "$action" in
  on) cmd_on "$@" ;;
  off) cmd_off "$@" ;;
  status) cmd_status "$@" ;;
  *) usage ;;
esac
