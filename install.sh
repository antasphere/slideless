#!/usr/bin/env bash
# One-line VPS installer:
#   curl -fsSL https://raw.githubusercontent.com/antasphere/slideless/prod/install.sh | \
#     sudo bash -s -- --domain slideless.example.com
#
# Steps: prereqs (git, docker) → clone/update → setup.sh → UFW (22, 80, 443,
# and 3000 only when no domain/proxy is used). TLS: see docs/self-hosting/reverse-proxy.md.
set -euo pipefail

info() { printf '\033[0;34m▸ %s\033[0m\n' "$*"; }
success() { printf '\033[0;32m✔ %s\033[0m\n' "$*"; }
fail() { printf '\033[0;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

REPO_URL="https://github.com/antasphere/slideless.git"
INSTALL_DIR="/opt/slideless"
DOMAIN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    *) fail "unknown flag: $1" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -ne 0 ] && fail "run as root (sudo)"

# 1. Prereqs
if ! command -v git >/dev/null; then
  info "installing git"
  (command -v apt-get >/dev/null && apt-get update -qq && apt-get install -y -qq git) ||
    (command -v yum >/dev/null && yum install -y -q git) || fail "install git manually"
fi
if ! command -v docker >/dev/null; then
  info "installing docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker 2>/dev/null || true
fi
docker info >/dev/null || fail "docker daemon not running"

# 2. Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  info "updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "cloning to $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
chmod +x "$INSTALL_DIR"/setup.sh "$INSTALL_DIR"/update.sh "$INSTALL_DIR"/scripts/*.sh

# 3. Setup (secrets + stack)
if [ -n "$DOMAIN" ]; then
  PUBLIC_BASE_URL="https://$DOMAIN" bash "$INSTALL_DIR/setup.sh"
else
  bash "$INSTALL_DIR/setup.sh"
fi

# 4. Firewall (Linux + ufw only). 22 FIRST — enabling ufw without it locks
# you out of the server permanently.
if command -v ufw >/dev/null || command -v apt-get >/dev/null; then
  command -v ufw >/dev/null || apt-get install -y -qq ufw
  info "configuring ufw"
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  if [ -z "$DOMAIN" ]; then
    ufw allow 3000/tcp >/dev/null
    info "port 3000 open (no domain given). Put Caddy in front for TLS: docs/self-hosting/reverse-proxy.md"
  fi
  ufw --force enable >/dev/null
  success "firewall active"
fi

success "install complete"
if [ -n "$DOMAIN" ]; then
  echo "Next: configure the reverse proxy for https://$DOMAIN (docs/self-hosting/reverse-proxy.md),"
  echo "set TRUST_PROXY=true in $INSTALL_DIR/.env, then open https://$DOMAIN to finish setup."
else
  echo "Next: open http://<server-ip>:3000 to finish setup (token in $INSTALL_DIR/.env)."
fi
