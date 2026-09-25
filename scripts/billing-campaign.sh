#!/usr/bin/env bash
# The billing campaign (PRDCT-2718), the confidence campaign of phase 3 of the
# billing rail: a replayable suite on a real PAIR (the federation drill
# harness: the hub and cloud Slideless from both dev heads), driven by the
# Antasphere Cloud SANDBOX key, `stripe listen` and Stripe test clocks. It
# proves, with one row of evidence per scenario, that money moves the way the
# spec says on every surface: buying in two currencies and four tax situations,
# the card family, the webhooks replayed, disordered, delayed and forged, the
# pro plan over a test-clock month, auto-recharge under its lock and its cap,
# refunds and referrals, hundreds of organizations at once, and the whole loop
# across the two products. The scenarios live in scripts/billing-campaign/
# (one file per group, Node); this script is the runner around them.
#
# What it does, in order:
#   0. reads STRIPE_SANDBOX_SECRET_KEY from the environment (a test key, never
#      printed) and asks the Stripe CLI for the listen signing secret;
#   1. boots the pair through the federation drill when it is not up (the
#      drill's Phase 8 seeds the price book and the Drill Workspace: the
#      campaign's first data), with the Stripe variables and test clocks on;
#      a pair already up is used as it is;
#   2. recreates the hub container with the campaign's override (the Stripe
#      variables, STRIPE_TEST_CLOCKS on, the per-person organization cap
#      lifted for the load group) when its configuration differs;
#   3. starts `stripe listen` forwarding every sandbox event to the campaign's
#      relay (127.0.0.1:$CAMPAIGN_RELAY_PORT), which forwards to the hub;
#   4. runs the scenario groups (node scripts/billing-campaign/run.mjs),
#      which write campaign/run-<n>/results.json and report.md under
#      $CAMPAIGN_BUNDLE (the lane's workstream bundle) or $CAMPAIGN_OUT;
#   5. stops the forwarder; DRILL_KEEP=1 leaves the pair up, else `down -v` of
#      the pair THIS script booted; a pair that was up before the campaign is
#      left exactly as it was (its state is not the campaign's to remove).
# The exit code is the run's: non-zero on any red or unrun scenario.
#
# One operator per pair: the orchestrator keeps Drill Owner's hub password in
# $CAMPAIGN_OUT/.owner-password and resets it through the hub's mail when the
# kept one fails, so two CAMPAIGN_OUT folders on one pair make the password
# ping-pong until the hub's reset wall (five per address per ten minutes)
# answers 429 and the preflight stops. Share one CAMPAIGN_OUT per pair.
#
# Usage: STRIPE_SANDBOX_SECRET_KEY=sk_test_… ./scripts/billing-campaign.sh [run.mjs args]
#   FEDERATION_* as the drill (project, ports, images, hub dir, subnet)
#   CAMPAIGN_BUNDLE=<dir>     where campaign/run-<n>/ is written (default $CAMPAIGN_OUT)
#   CAMPAIGN_OUT=<dir>        the scratch folder (default /private/tmp/billing-campaign-<project>)
#   CAMPAIGN_RELAY_PORT=8732  the relay's port on the host
#   CAMPAIGN_LOAD_ORGS=120    the load group's organizations
#   CAMPAIGN_HEADED=1         a visible browser on Stripe's Checkout page
#   DRILL_KEEP=1              leave the pair up after the run
#   DRILL_SKIP_BUILD=1        reuse the images when the pair must be booted
#   --groups a,b --only <name> --run <n> are passed to run.mjs
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export FEDERATION_PROJECT="${FEDERATION_PROJECT:-slideless-federation}"
export FEDERATION_HUB_PORT="${FEDERATION_HUB_PORT:-3300}"
export FEDERATION_SL_PORT="${FEDERATION_SL_PORT:-3310}"
export FEDERATION_HOP_PORT="${FEDERATION_HOP_PORT:-8474}"
export FEDERATION_MAIL_PORT="${FEDERATION_MAIL_PORT:-8030}"
export FEDERATION_SUBNET_PREFIX="${FEDERATION_SUBNET_PREFIX:-172.30.250}"
export FEDERATION_HUB_IMAGE="${FEDERATION_HUB_IMAGE:-antasphere-hub:federation-dev}"
export FEDERATION_SL_IMAGE="${FEDERATION_SL_IMAGE:-slideless:federation-dev}"
export FEDERATION_HUB_DIR="${FEDERATION_HUB_DIR:-$REPO/../../../hub}"
export CAMPAIGN_OUT="${CAMPAIGN_OUT:-/private/tmp/billing-campaign-$FEDERATION_PROJECT}"
export CAMPAIGN_RELAY_PORT="${CAMPAIGN_RELAY_PORT:-8732}"
mkdir -p "$CAMPAIGN_OUT" && chmod 700 "$CAMPAIGN_OUT"
STRIPE_BIN="${STRIPE_BIN:-$(command -v stripe || echo /opt/homebrew/bin/stripe)}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }
for bin in docker jq curl node; do command -v "$bin" >/dev/null || fail "required tool missing: $bin"; done
[ -x "$STRIPE_BIN" ] || fail "the Stripe CLI is not installed (STRIPE_BIN=$STRIPE_BIN)"

# 0. the sandbox key: a TEST key from the environment, never printed.
: "${STRIPE_SANDBOX_SECRET_KEY:?set STRIPE_SANDBOX_SECRET_KEY, the sandbox sk_test_ key, which is never printed}"
case "$STRIPE_SANDBOX_SECRET_KEY" in sk_test_*) ;; *) fail "STRIPE_SANDBOX_SECRET_KEY is not a test key; the campaign never runs on anything else" ;; esac
export STRIPE_SECRET_KEY="$STRIPE_SANDBOX_SECRET_KEY"
export STRIPE_TEST_CLOCKS=true
say "The listen signing secret from the Stripe CLI"
# The key reaches the CLI through its environment, never on a command line `ps` can read.
STRIPE_WEBHOOK_SECRET="$(STRIPE_API_KEY="$STRIPE_SANDBOX_SECRET_KEY" "$STRIPE_BIN" listen --print-secret 2>/dev/null || true)"
case "$STRIPE_WEBHOOK_SECRET" in whsec_*) ;; *) fail "stripe listen --print-secret did not answer a signing secret" ;; esac
export STRIPE_WEBHOOK_SECRET
echo "    a whsec_ secret of ${#STRIPE_WEBHOOK_SECRET} characters"

dc() {
  FEDERATION_DRILL_SETUP_TOKEN="${FEDERATION_DRILL_SETUP_TOKEN:-claimed-already}" docker compose -p "$FEDERATION_PROJECT" \
    -f "$REPO/docker-compose.federation.yml" -f "$REPO/docker-compose.federation.drill.yml" -f "$CAMPAIGN_OUT/hub-campaign.yml" "$@"
}
answers() { curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$1/healthz"; }

# The hub's campaign override: the Stripe variables come through the harness's
# own lines; this file lifts the per-person organization cap (the load group
# makes hundreds of organizations through POST /orgs as one owner).
cat > "$CAMPAIGN_OUT/hub-campaign.yml" <<'YML'
services:
  hub:
    environment:
      - MAX_ORGS_PER_USER=0
YML

# 1. the pair: booted through the drill when it is not up.
BOOTED=""
if answers "$FEDERATION_HUB_PORT" && answers "$FEDERATION_SL_PORT"; then
  say "The pair is up on $FEDERATION_HUB_PORT / $FEDERATION_SL_PORT (project $FEDERATION_PROJECT), used as it is"
else
  say "The pair is not up: booting it through the federation drill (DRILL_KEEP=1, the Stripe variables set)"
  DRILL_KEEP=1 "$REPO/scripts/federation-drill.sh" || fail "the federation drill did not pass; the campaign does not run on a pair the drill refused"
  BOOTED=1
fi

# 2. the hub with the campaign's configuration (recreated only when it differs).
say "The hub container on the campaign's configuration"
dc up -d --no-build --no-deps hub >/dev/null 2>&1 || fail "docker compose up hub failed"
for i in $(seq 1 120); do answers "$FEDERATION_HUB_PORT" && break; sleep 1; done
answers "$FEDERATION_HUB_PORT" || fail "the hub does not answer after its recreate"
echo "    hub up on $FEDERATION_HUB_PORT"

# 3. the forwarder, to the relay the orchestrator opens.
say "stripe listen → the relay on 127.0.0.1:$CAMPAIGN_RELAY_PORT"
LISTEN_LOG="$CAMPAIGN_OUT/stripe-listen.log"
# The CLI's Ready line prints the signing secret: the log gets it redacted, and
# the file is made mode 600 before the CLI writes a byte.
(umask 077; rm -f "$LISTEN_LOG"; : > "$LISTEN_LOG")
STRIPE_API_KEY="$STRIPE_SANDBOX_SECRET_KEY" "$STRIPE_BIN" listen \
  --forward-to "http://127.0.0.1:$CAMPAIGN_RELAY_PORT/api/v1/webhooks/stripe" \
  --events checkout.session.completed,payment_intent.succeeded,payment_intent.payment_failed,invoice.paid,invoice.payment_failed,invoice.finalized,charge.refunded,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted \
  > >(awk '{ gsub(/whsec_[A-Za-z0-9]+/, "whsec_<redacted>"); print; fflush() }' >> "$LISTEN_LOG") 2>&1 &
LISTEN_PID=$!
cleanup() {
  local status=$?
  say "Teardown"
  kill "$LISTEN_PID" 2>/dev/null || true
  if [ "${DRILL_KEEP:-}" = "1" ]; then
    echo "    DRILL_KEEP=1: the pair stays up (project $FEDERATION_PROJECT)"
  elif [ "$BOOTED" = "1" ]; then
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    echo "    the pair is down (down -v)"
  else
    echo "    the pair was up before the campaign: left as it was (project $FEDERATION_PROJECT)"
  fi
  exit "$status"
}
trap cleanup EXIT
for i in $(seq 1 30); do grep -q 'Ready' "$LISTEN_LOG" 2>/dev/null && break; sleep 1; done
grep -q 'Ready' "$LISTEN_LOG" || fail "stripe listen did not become ready: $(tail -3 "$LISTEN_LOG")"
echo "    forwarding (pid $LISTEN_PID)"

# 4. the scenarios.
say "The scenarios"
node "$REPO/scripts/billing-campaign/run.mjs" "$@"
