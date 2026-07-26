#!/usr/bin/env bash
# One-line VPS installer:
#   curl -fsSL https://raw.githubusercontent.com/antasphere/slideless/prod/install.sh | \
#     sudo bash -s -- --domain slideless.example.com
#
# Steps: prereqs (git, docker) → clone/update → setup.sh → UFW (22, 80, 443).
# TLS: see docs/self-hosting/reverse-proxy.md.
#
# WITHOUT --domain the app is published on the loopback interface only and the
# app port is NOT opened in the firewall. Reach the dashboard through an SSH
# tunnel; do not complete the first-boot wizard over plaintext across the
# network. `--expose-port` overrides that deliberately (see below).
set -euo pipefail

info() { printf '\033[0;34m▸ %s\033[0m\n' "$*"; }
success() { printf '\033[0;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m! %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[0;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

REPO_URL="https://github.com/antasphere/slideless.git"
INSTALL_DIR="/opt/slideless"
DOMAIN=""
APP_PORT="${APP_PORT:-3000}"
EXPOSE_PORT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --port) APP_PORT="$2"; shift 2 ;;
    # Publish the app port on 0.0.0.0 and open it in the firewall. Plaintext
    # HTTP to the whole internet — only for a trusted private network.
    --expose-port) EXPOSE_PORT=1; shift ;;
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
#
# APP_BIND decides whether docker publishes the port on the loopback interface
# or on every interface. It is NOT a firewall decision: docker publishes ports
# with DNAT rules that are evaluated before ufw's INPUT chain, so a 0.0.0.0
# bind is reachable from the internet even with ufw denying the port. The bind
# address is the only control that actually holds.
if [ -n "$DOMAIN" ]; then
  APP_PORT="$APP_PORT" APP_BIND=127.0.0.1 PUBLIC_BASE_URL="https://$DOMAIN" \
    bash "$INSTALL_DIR/setup.sh"
elif [ "$EXPOSE_PORT" = 1 ]; then
  warn "--expose-port: the dashboard and the first-boot wizard will be served over"
  warn "plaintext HTTP on every interface. Credentials cross the network in the clear."
  # `hostname -I` is Linux-only and prints nothing on a host with no
  # non-loopback address. Left unguarded that produced PUBLIC_BASE_URL
  # "http://:$APP_PORT", which fails the server's env schema — the stack would
  # come up and crash-loop with no explanation. Fail here instead.
  HOST_IP="${HOST_IP:-$(hostname -I 2> /dev/null | awk '{print $1}')}"
  [ -n "$HOST_IP" ] ||
    fail "--expose-port needs the address this host is reached on and \`hostname -I\` returned nothing.
  Re-run with HOST_IP=<address> --expose-port, or better, with --domain <host> behind TLS."
  APP_PORT="$APP_PORT" APP_BIND=0.0.0.0 ALLOW_INSECURE_SETUP=true \
    PUBLIC_BASE_URL="http://$HOST_IP:$APP_PORT" \
    bash "$INSTALL_DIR/setup.sh"
else
  APP_PORT="$APP_PORT" APP_BIND=127.0.0.1 PUBLIC_BASE_URL="http://localhost:$APP_PORT" \
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
  if [ "$EXPOSE_PORT" = 1 ]; then
    ufw allow "$APP_PORT"/tcp >/dev/null
    warn "port $APP_PORT open to the world (--expose-port). Put Caddy in front for TLS: docs/self-hosting/reverse-proxy.md"
  fi
  ufw --force enable >/dev/null
  success "firewall active"
fi

success "install complete"
if [ -n "$DOMAIN" ]; then
  echo "Next: configure the reverse proxy for https://$DOMAIN (docs/self-hosting/reverse-proxy.md),"
  echo "set TRUST_PROXY=true in $INSTALL_DIR/.env, then open https://$DOMAIN to finish setup."
elif [ "$EXPOSE_PORT" = 1 ]; then
  echo "Next: open http://<server-ip>:$APP_PORT to finish setup (token in $INSTALL_DIR/.env)."
  echo "Move to TLS as soon as you can: docs/self-hosting/reverse-proxy.md."
else
  echo "The app is published on 127.0.0.1:$APP_PORT only — nothing is exposed to the network."
  echo "Finish setup through an SSH tunnel from your machine:"
  echo
  echo "    ssh -N -L $APP_PORT:127.0.0.1:$APP_PORT <user>@<server-ip>"
  echo "    open http://localhost:$APP_PORT        # setup token: $INSTALL_DIR/.env"
  echo
  echo "For a public instance, re-run with --domain <host> and put TLS in front"
  echo "(docs/self-hosting/reverse-proxy.md), or --expose-port to accept plaintext on a private network."
fi
