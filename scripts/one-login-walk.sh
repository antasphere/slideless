#!/usr/bin/env bash
# The one-login walk (PRDCT-2958): every CLI of the Antasphere family, from an
# empty config home, on ONE pair built from the merged heads — the hub, cloud
# Slideless, and the hackathon as a second registry tool, RESTRICTED. Terminal
# only (the browser legs are the walk of PRDCT-2947, on the record); each of
# the eight steps of the task is one function asserting on `--json` output and
# exit codes; one PASS line per step; the first red exits non-zero.
#
# What it proves, in the task's order (the hackathon steps first: 1, 2, 5, 7,
# then 3, 4, 6, 8):
#
#   1. `antasphere login`, then `slideless list` with no URL flag: signed in,
#      the default organization's decks.
#   2. A second clean home: `slideless login` alone ends signed in, the
#      workspace named (PRDCT-2446).
#   5. The hackathon (restricted): the connect refused before the staff grant
#      with the hub's own sentence, exit 3, no row on the tool; `hackathon
#      login` connected after the grant; `hackathon connect` naming the roster
#      place; TOOL_RESTRICTED refusing workspace creation.
#   7. `antasphere logout --all` leaves no live key on the hub nor on either
#      tool (GET /api-keys read back with a session on each instance).
#   3. `--org` by name and by hub id on both CLIs; `antasphere org use` moves
#      what Slideless lands in; a pinned key refused with the pin named.
#   4. A self-hosted Slideless stack beside the pair: a second profile named
#      for its host, `slideless use` switching, the cloud key never sent to it.
#   6. A revoked tool key recovers once; a membership removed at the hub fails
#      the next command with a sentence.
#   8. The account CLI walked is the PUBLISHED package (npm), never a worktree
#      build: asserted on the binary's path and version before anything else.
#
# The pair: docker-compose.federation.yml (this repo) plus an overlay OUTSIDE
# the tree that adds the hackathon (its build context is a hackathon worktree
# on this machine; the workstream bundle of PRDCT-2958 carries the recipe as
# walk/hackathon.yml). The self-hosted stack of step 4 is docker-compose.yml +
# docker-compose.dev.yml on the same Slideless image, its own compose project.
#
# Usage: WALK_OVERLAY=<hackathon overlay> WALK_HUB_DIR=<hub worktree> \
#        WALK_HK_DIR=<hackathon worktree> ./scripts/one-login-walk.sh
#   WALK_ANT_BIN     the account CLI, installed from npm (default /private/tmp/ol-e/npm/node_modules/.bin/antasphere)
#   WALK_SL_BIN      the Slideless CLI (default packages/cli/dist/bin.js of this tree)
#   WALK_HK_BIN      the hackathon CLI (default $WALK_HK_DIR/packages/cli/dist/bin.js)
#   WALK_HOMES       where the config homes go (default /private/tmp/ol-e/homes), one folder per run
#   WALK_SKIP_BUILD=1  reuse the three images when they exist
#   WALK_KEEP=1        leave both stacks up after a PASS (`down -v` yourself)
#   The band (lane E's defaults): WALK_PROJECT=ol-e-pair WALK_HUB_PORT=8101 WALK_SL_PORT=8110
#   WALK_HK_PORT=8120 WALK_MAIL_PORT=8890 WALK_SUBNET_PREFIX=10.244.0 WALK_SELF_PROJECT=sl-ol-e
#   WALK_SELF_PORT=3250 WALK_SELF_MAIL_PORT=8250; the images WALK_HUB_IMAGE=antasphere-hub:ol-e
#   WALK_SL_IMAGE=slideless:ol-e WALK_HK_IMAGE=hackathon:ol-e.
#   Neither port may be on the Fetch standard's blocked-port list (see federation-drill.sh).
#
# Everything the walk makes is throwaway: both compose projects' volumes go
# with `down -v` on exit, pass or fail, and every config home is under a
# folder of its own per run.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=${WALK_PROJECT:-ol-e-pair}
HUB_PORT=${WALK_HUB_PORT:-8101}
SL_PORT=${WALK_SL_PORT:-8110}
HK_PORT=${WALK_HK_PORT:-8120}
MAIL_PORT=${WALK_MAIL_PORT:-8890}
SUBNET_PREFIX=${WALK_SUBNET_PREFIX:-10.244.0}
SELF_PROJECT=${WALK_SELF_PROJECT:-sl-ol-e}
SELF_PORT=${WALK_SELF_PORT:-3250}
SELF_MAIL_PORT=${WALK_SELF_MAIL_PORT:-8250}
HUB_IMAGE=${WALK_HUB_IMAGE:-antasphere-hub:ol-e}
SL_IMAGE=${WALK_SL_IMAGE:-slideless:ol-e}
HK_IMAGE=${WALK_HK_IMAGE:-hackathon:ol-e}
OVERLAY=${WALK_OVERLAY:?the hackathon overlay (walk/hackathon.yml of the PRDCT-2958 bundle)}
HUB_DIR=${WALK_HUB_DIR:?the hub worktree to build}
HK_DIR=${WALK_HK_DIR:?the hackathon worktree to build}
ANT_BIN=${WALK_ANT_BIN:-/private/tmp/ol-e/npm/node_modules/.bin/antasphere}
SL_BIN=${WALK_SL_BIN:-$REPO/packages/cli/dist/bin.js}
HK_BIN=${WALK_HK_BIN:-$HK_DIR/packages/cli/dist/bin.js}
HOMES=${WALK_HOMES:-/private/tmp/ol-e/homes}

HUB=http://hub.localhost:$HUB_PORT
SL=http://slideless.localhost:$SL_PORT
HK=http://hackathon.localhost:$HK_PORT
SELF=http://localhost:$SELF_PORT
MAIL=http://127.0.0.1:$MAIL_PORT
SELF_MAIL=http://127.0.0.1:$SELF_MAIL_PORT
OWNER_EMAIL=owner@ol-e.test
MEMBER_EMAIL=member@ol-e.test
PASS_COUNT=0
STEP=""

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '    · %s\n' "$*"; }
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$*"
}
fail() {
  printf '  \033[31mFAIL\033[0m %s%s\n' "${STEP:+$STEP: }" "$*" >&2
  exit 1
}

for bin in docker jq curl openssl node; do
  command -v "$bin" >/dev/null || fail "required tool missing: $bin"
done
[ -x "$ANT_BIN" ] || fail "the account CLI is not at $ANT_BIN (npm i --prefix /private/tmp/ol-e/npm @antasphere/cli@<version>)"
[ -f "$SL_BIN" ] || fail "the Slideless CLI is not built at $SL_BIN (pnpm turbo build --filter=@antasphere/slideless...)"
[ -f "$HK_BIN" ] || fail "the hackathon CLI is not built at $HK_BIN"
[ -f "$OVERLAY" ] || fail "no overlay at $OVERLAY"
for port in "$HUB_PORT" "$SL_PORT" "$HK_PORT" "$MAIL_PORT" "$SELF_PORT" "$SELF_MAIL_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
    fail "port $port already answers — refusing to run"
  fi
done

RUN_ID="$(date +%Y%m%d-%H%M%S)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/one-login-walk.XXXXXX")"
RUN_HOMES="$HOMES/$RUN_ID"
mkdir -p "$RUN_HOMES"
export OL_E_SETUP_TOKEN="$(openssl rand -hex 16)"
SELF_SETUP_TOKEN="$(openssl rand -hex 16)"
SELF_PG_PASSWORD="$(openssl rand -hex 8)"
OWNER_PASSWORD="owner-password-$(openssl rand -hex 6)"
MEMBER_PASSWORD="member-password-$(openssl rand -hex 6)"
HUB_JAR="$SCRATCH/hub.cookies"
SL_JAR="$SCRATCH/sl.cookies"
HK_JAR="$SCRATCH/hk.cookies"

# The compose environment of the pair, read by the base file and the overlay.
export FEDERATION_PROJECT="$PROJECT" FEDERATION_HUB_PORT="$HUB_PORT" FEDERATION_SL_PORT="$SL_PORT"
export FEDERATION_MAIL_PORT="$MAIL_PORT" FEDERATION_HUB_DIR="$HUB_DIR"
export FEDERATION_HUB_IMAGE="$HUB_IMAGE" FEDERATION_SL_IMAGE="$SL_IMAGE"
export OL_E_HK_DIR="$HK_DIR" OL_E_HK_IMAGE="$HK_IMAGE" OL_E_HK_PORT="$HK_PORT"
export OL_E_SUBNET_PREFIX="$SUBNET_PREFIX" OL_E_OWNER_EMAIL="$OWNER_EMAIL"
PAIR_SERVICES=(hub hub-db app db mailpit hackathon hackathon-db)

dc() { docker compose -p "$PROJECT" -f "$REPO/docker-compose.federation.yml" -f "$OVERLAY" "$@"; }
# The self-hosted stack: the shipped compose file on the same image, Mailpit beside it.
dself() {
  APP_IMAGE="$SL_IMAGE" APP_PORT="$SELF_PORT" MAILPIT_UI_PORT="$SELF_MAIL_PORT" \
    POSTGRES_PASSWORD="$SELF_PG_PASSWORD" SETUP_TOKEN="$SELF_SETUP_TOKEN" PUBLIC_BASE_URL="$SELF" \
    docker compose -p "$SELF_PROJECT" -f "$REPO/docker-compose.yml" -f "$REPO/docker-compose.dev.yml" "$@"
}
# *.localhost resolves in browsers by RFC 6761 but not in every curl: pin the three names.
CURL=(curl -sS --max-time 60 --resolve "hub.localhost:$HUB_PORT:127.0.0.1" --resolve "slideless.localhost:$SL_PORT:127.0.0.1" --resolve "hackathon.localhost:$HK_PORT:127.0.0.1")
hubdb() { dc exec -T hub-db psql -U antasphere -d antasphere -v ON_ERROR_STOP=1 -Atc "$1"; }
sldb() { dc exec -T db psql -U slideless -d slideless -v ON_ERROR_STOP=1 -Atc "$1"; }
hkdb() { dc exec -T hackathon-db psql -U app -d app -v ON_ERROR_STOP=1 -Atc "$1"; }
selfdb() { dself exec -T db psql -U slideless -d slideless -v ON_ERROR_STOP=1 -Atc "$1"; }
applogs() { dc logs --no-log-prefix "$1" 2>/dev/null || true; }

wait_ready() { # name url timeout_s
  local i=0
  until "${CURL[@]}" -o /dev/null -f "$2" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge "$3" ] && fail "$1 ($2) not ready after $3 s"
    sleep 1
  done
  return 0
}

CLEANED=0
cleanup() {
  local status=$?
  [ "$CLEANED" = 1 ] && exit "$status"
  CLEANED=1
  if [ "$status" != 0 ]; then
    for svc in hub app hackathon; do
      echo "── logs: $svc ──────────────────────────────────────────────" >&2
      applogs "$svc" | tail -30 >&2
    done
  fi
  if [ "$status" = 0 ] && [ "${WALK_KEEP:-}" = "1" ]; then
    echo "  WALK_KEEP=1: both stacks left up (projects $PROJECT and $SELF_PROJECT)"
  else
    say "Teardown"
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    dself down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
  if [ "$status" = 0 ]; then
    printf '\n\033[32m✔ one-login walk passed — %s assertions, config homes under %s\033[0m\n' "$PASS_COUNT" "$RUN_HOMES"
  else
    printf '\n\033[31m✘ one-login walk FAILED (after %s passing assertions), config homes under %s\033[0m\n' "$PASS_COUNT" "$RUN_HOMES" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

# ── The CLIs ─────────────────────────────────────────────────────────────────
# One config home per scenario: `home <name>` makes a fresh one and selects it.
HOME_DIR=""
home() {
  HOME_DIR="$RUN_HOMES/$1"
  mkdir -p "$HOME_DIR"
  note "config home: $HOME_DIR (fresh)"
}
# The environment of one run: the config home, the three URLs (the variables
# stand for the cloud URL on a pair), no colour, nothing of the operator's own.
# SL_NO_URL=1 leaves SLIDELESS_URL unset: the active PROFILE then decides
# (what `slideless use` is for), as on a machine with no variable set.
SL_NO_URL=""
cli_env() {
  if [ -n "$SL_NO_URL" ]; then
    env -i PATH="$PATH" HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR" NO_COLOR=1 \
      ANTASPHERE_URL="$HUB" HACKATHON_URL="$HK" "$@"
  else
    env -i PATH="$PATH" HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR" NO_COLOR=1 \
      ANTASPHERE_URL="$HUB" SLIDELESS_URL="${SL_URL_OVERRIDE:-$SL}" HACKATHON_URL="$HK" "$@"
  fi
}
# run <label> <cmd...>: runs a CLI, keeps stdout in $OUT, stderr in $ERR, the
# code in $RC, and prints the command with its output as a terminal shows it.
OUT=""; ERR=""; RC=0
run() {
  local label=$1; shift
  printf '    $ %s\n' "$label"
  set +e
  cli_env "$@" >"$SCRATCH/out" 2>"$SCRATCH/err" </dev/null
  RC=$?
  set +e
  OUT=$(cat "$SCRATCH/out"); ERR=$(cat "$SCRATCH/err")
  sed 's/^/      /' "$SCRATCH/out"
  sed 's/^/      ! /' "$SCRATCH/err"
  [ "$RC" != 0 ] && printf '      (exit %s)\n' "$RC"
  return 0
}
ant() { run "antasphere $*" "$ANT_BIN" "$@"; }
# The hub organization a tool answer (whoami/login --json) landed in: the
# active workspace's centralAccountId, read off the workspaces rows.
me_org() { jq -r '. as $m | ([$m.workspaces[]? | select(.id == $m.workspace.id) | .centralAccountId] | .[0]) // ""'; }
sl() { run "slideless $*" node "$SL_BIN" "$@"; }
hk() { run "hackathon $*" node "$HK_BIN" "$@"; }

# The sign-in code, read from a Mailpit: the newest message to the address,
# once one more than `before` is there (the subject starts with the code).
mail_count() { "${CURL[@]}" "$1/api/v1/search?query=$(printf 'to:%s' "$2" | jq -sRr @uri)" | jq -r '.messages_count // (.messages | length)'; }
mail_otp() { # mailpit email before
  local i n
  for i in $(seq 1 40); do
    n=$(mail_count "$1" "$2")
    if [ "$n" -gt "$3" ]; then
      "${CURL[@]}" "$1/api/v1/search?query=$(printf 'to:%s' "$2" | jq -sRr @uri)" \
        | jq -r '.messages[0].Subject // ""' | sed -n 's/^\([0-9]\{4,10\}\) .*/\1/p'
      return
    fi
    sleep 1
  done
}
# run_login <mailpit> <email> <label> <cmd...>: a login that asks the code on
# the terminal, answered from Mailpit. The command is spawned with its stdin on
# a pipe; the feeder waits for the mail the command's first leg sends, then
# writes the code. Same capture as `run`.
run_login() {
  local mailpit=$1 email=$2 label=$3; shift 3
  local before
  before=$(mail_count "$mailpit" "$email")
  printf '    $ %s\n' "$label"
  set +e
  (mail_otp "$mailpit" "$email" "$before") | cli_env "$@" >"$SCRATCH/out" 2>"$SCRATCH/err"
  RC=${PIPESTATUS[1]}
  OUT=$(cat "$SCRATCH/out"); ERR=$(cat "$SCRATCH/err")
  sed 's/^/      /' "$SCRATCH/out"
  sed 's/^/      ! /' "$SCRATCH/err"
  [ "$RC" != 0 ] && printf '      (exit %s)\n' "$RC"
  return 0
}
ant_login() { run_login "$MAIL" "$1" "antasphere login --email $1 --json" "$ANT_BIN" login --email "$1" --json; }
sl_login() { run_login "$MAIL" "$1" "slideless login --email $1 --json" node "$SL_BIN" login --email "$1" --json; }
hk_login() { run_login "$MAIL" "$1" "hackathon login --email $1 --json" node "$HK_BIN" login --email "$1" --json; }

# Live keys of a person on an instance: what the dashboard's GET /api-keys
# lists as not revoked, read with a session (never with a key, which would
# itself be one). `sl_session`/`hk_session` sign a browser session in
# headlessly through the hub (the federation drill's Phase 3), on the owner's
# hub session.
sso_session() { # tool_base jar
  local initiate authz location cb
  initiate=$("${CURL[@]}" -c "$2" -X POST "$1/api/v1/auth/sign-in/oauth2" -H 'content-type: application/json' -d '{"providerId":"antasphere","callbackURL":"/"}')
  authz=$(echo "$initiate" | jq -r '.url // empty')
  [ -n "$authz" ] || fail "$1 answered no authorize URL: $initiate"
  location=$("${CURL[@]}" -b "$HUB_JAR" -o /dev/null -w '%{redirect_url}' "$authz")
  case "$location" in "$1/api/v1/auth/oauth2/callback/antasphere?"*code=*) ;; *) fail "authorize at the hub did not redirect to $1 with a code: $location" ;; esac
  cb=$("${CURL[@]}" -b "$2" -c "$2" -o /dev/null -w '%{http_code}' "$location")
  [ "$cb" = 302 ] || fail "$1 callback answered $cb"
}
live_keys_json() { # base jar → the caller's not-revoked keys as JSON rows (GET /api-keys is creator-scoped on the three instances)
  "${CURL[@]}" -b "$2" "$1/api/v1/api-keys?limit=100" | jq -c '[.apiKeys[] | select(.revokedAt == null)]'
}

# ── Phase 0 — the published account CLI (step 8) ────────────────────────────
say "Step 8 — the account CLI walked is the published package"
STEP="step 8"
case "$ANT_BIN" in
  */node_modules/.bin/antasphere) ;;
  *) fail "the account CLI must be an npm install, not a worktree build: $ANT_BIN" ;;
esac
ANT_PKG="$(dirname "$ANT_BIN")/../@antasphere/cli/package.json"
[ -f "$ANT_PKG" ] || fail "no @antasphere/cli package beside $ANT_BIN"
ANT_VERSION=$(jq -r .version "$ANT_PKG")
# The published package bundles cli-core (no dependencies field): the bundle names the version it was built from.
ANT_CORE=$(jq -r '.dependencies["@antasphere/cli-core"] // ""' "$ANT_PKG")
[ -n "$ANT_CORE" ] || ANT_CORE=$(grep -oh 'cli-core@[0-9][0-9.]*' "$(dirname "$ANT_PKG")"/dist/*.js 2>/dev/null | sort -u | head -1 | sed 's/cli-core@//')
home step8
ant --version
[ "$RC" = 0 ] && [ "$OUT" = "$ANT_VERSION" ] || fail "antasphere --version printed '$OUT', the package is $ANT_VERSION"
case "$ANT_CORE" in ^0.5.*|0.5.*|\~0.5.*) ;; *) fail "@antasphere/cli $ANT_VERSION carries cli-core '$ANT_CORE', not 0.5" ;; esac
pass "step 8: @antasphere/cli $ANT_VERSION from npm (cli-core $ANT_CORE), the binary at $ANT_BIN"
SL_VERSION=$(jq -r .version "$REPO/packages/cli/package.json")
HK_VERSION=$(jq -r .version "$HK_DIR/packages/cli/package.json")
sl --version; [ "$OUT" = "$SL_VERSION" ] || fail "slideless --version printed '$OUT', the tree is $SL_VERSION"
hk --version; [ "$OUT" = "$HK_VERSION" ] || fail "hackathon --version printed '$OUT', the tree is $HK_VERSION"
note "slideless $SL_VERSION from $(git -C "$REPO" rev-parse --short HEAD), hackathon $HK_VERSION from $(git -C "$HK_DIR" rev-parse --short HEAD), hub from $(git -C "$HUB_DIR" rev-parse --short HEAD)"

# ── Phase 1 — images and the pair ────────────────────────────────────────────
say "Phase 1 — images (hub from $HUB_DIR, Slideless from this repo, hackathon from $HK_DIR)"
STEP="boot"
if [ "${WALK_SKIP_BUILD:-}" = "1" ] \
  && docker image inspect "$HUB_IMAGE" >/dev/null 2>&1 \
  && docker image inspect "$SL_IMAGE" >/dev/null 2>&1 \
  && docker image inspect "$HK_IMAGE" >/dev/null 2>&1; then
  note "WALK_SKIP_BUILD=1 and the three images exist — reusing"
else
  dc build hub app hackathon || fail "image build failed"
fi

say "Phase 1 — the pair up: hub, cloud Slideless, the hackathon (restricted), one Mailpit"
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --no-build "${PAIR_SERVICES[@]}" || fail "compose up failed"
wait_ready hub "$HUB/healthz" 300
wait_ready app "$SL/healthz" 300
wait_ready hackathon "$HK/healthz" 300
pass "hub, Slideless (cloud) and the hackathon (cloud, TOOL_RESTRICTED) are up"

say "Phase 2 — the setups, the owner's hub session, the second organization"
hub_setup=$("${CURL[@]}" -X POST "$HUB/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Lane E Hub\",\"owner\":{\"email\":\"$OWNER_EMAIL\",\"name\":\"Lane E Owner\",\"password\":\"$OWNER_PASSWORD\"}}")
HUB_USER_ID=$(echo "$hub_setup" | jq -r '.ownerUserId // empty')
[ -n "$HUB_USER_ID" ] || fail "hub setup did not answer an ownerUserId: $hub_setup"
sl_setup=$("${CURL[@]}" -X POST "$SL/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Lane E Slideless\",\"setupToken\":\"$OL_E_SETUP_TOKEN\",\"owner\":{\"email\":\"sl-operator@ol-e.test\",\"name\":\"SL Operator\",\"password\":\"$OWNER_PASSWORD\"}}")
echo "$sl_setup" | jq -e '(.ownerUserId // "") != "" and .workspaceId == null' >/dev/null || fail "Slideless cloud setup should mint no workspace: $sl_setup"
hk_setup=$("${CURL[@]}" -X POST "$HK/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Lane E Hackathon\",\"setupToken\":\"$OL_E_SETUP_TOKEN\",\"owner\":{\"email\":\"hk-operator@ol-e.test\",\"name\":\"HK Operator\",\"password\":\"$OWNER_PASSWORD\"}}")
echo "$hk_setup" | jq -e '(.ownerUserId // "") != "" and .workspaceId == null' >/dev/null || fail "hackathon cloud setup should mint no workspace: $hk_setup"
seeded=$(applogs hub | grep -c 'tool registry: client seeded' || true)
[ "$seeded" -ge 2 ] || fail "expected the hub to seed 2 registry clients, saw $seeded log lines"
hk_disc=$("${CURL[@]}" "$HK/api/v1/instance")
echo "$hk_disc" | jq -e '.restricted == true and (.auth.methods | index("antasphere"))' >/dev/null || fail "the hackathon's discovery does not advertise restricted: true with the antasphere method: $hk_disc"
"${CURL[@]}" -f -o /dev/null -c "$HUB_JAR" -X POST "$HUB/api/v1/auth/sign-in/email" \
  -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" || fail "the hub owner's sign-in failed"
orgs=$("${CURL[@]}" -b "$HUB_JAR" "$HUB/api/v1/orgs")
ORG_A_ID=$(echo "$orgs" | jq -r '.orgs[0].id')
ORG_A_NAME=$(echo "$orgs" | jq -r '.orgs[0].name')
[ -n "$ORG_A_ID" ] && [ "$ORG_A_ID" != null ] || fail "the hub lists no organization for the owner: $orgs"
org_b=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/org-b.json" -w '%{http_code}' -X POST "$HUB/api/v1/orgs" -H "Origin: $HUB" -H 'content-type: application/json' -d '{"name":"Second Org"}')
[ "$org_b" = 201 ] || fail "POST /orgs (the second organization) answered $org_b: $(cat "$SCRATCH/org-b.json")"
ORG_B_ID=$(jq -r '.org.id' "$SCRATCH/org-b.json")
[ -n "$ORG_B_ID" ] && [ "$ORG_B_ID" != null ] || fail "the second organization has no id: $(cat "$SCRATCH/org-b.json")"
# The member: invited into Second Org at the hub, the account made by the acceptance (no personal organization).
inv=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/inv.json" -w '%{http_code}' -X POST "$HUB/api/v1/invitations" -H "Origin: $HUB" -H "X-Workspace-Id: $ORG_B_ID" -H 'content-type: application/json' \
  -d "{\"email\":\"$MEMBER_EMAIL\",\"role\":\"member\"}")
[ "$inv" = 201 ] || fail "the hub invitation answered $inv: $(cat "$SCRATCH/inv.json")"
INV_TOKEN=$(jq -r '.acceptUrl | split("/") | last' "$SCRATCH/inv.json")
[ -n "$INV_TOKEN" ] && [ "$INV_TOKEN" != null ] || fail "the invitation carries no token: $(cat "$SCRATCH/inv.json")"
acc=$("${CURL[@]}" -o "$SCRATCH/acc.json" -w '%{http_code}' -X POST "$HUB/api/v1/invitations/accept" -H "Origin: $HUB" -H 'content-type: application/json' \
  -d "{\"token\":\"$INV_TOKEN\",\"name\":\"Lane E Member\",\"password\":\"$MEMBER_PASSWORD\"}")
[ "$acc" = 200 ] || fail "accepting the invitation answered $acc: $(cat "$SCRATCH/acc.json")"
MEMBER_HUB_ID=$(jq -r .userId "$SCRATCH/acc.json")
pass "three setups; the owner ($OWNER_EMAIL) is staff, owns $ORG_A_NAME ($ORG_A_ID, the default) and Second Org ($ORG_B_ID), where $MEMBER_EMAIL is a member; the hackathon advertises restricted: true"

# A deck folder for the pushes.
DECK_DIR="$SCRATCH/deck"; mkdir -p "$DECK_DIR"
printf '<!doctype html><html><body><h1>Lane E deck</h1></body></html>\n' >"$DECK_DIR/index.html"

# ── Step 1 — antasphere login, then slideless list with no URL flag ──────────
say "Step 1 — antasphere login, then slideless list with no URL flag"
STEP="step 1"
home step1
ant_login "$OWNER_EMAIL"
[ "$RC" = 0 ] || fail "antasphere login exited $RC: $ERR"
echo "$OUT" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e and (.keyId | length > 0)' >/dev/null || fail "antasphere login's JSON: $OUT"
ANT_PROFILE=$(echo "$OUT" | jq -r .profile)
[ "$ANT_PROFILE" = "hub.localhost:$HUB_PORT" ] || fail "the hub profile is named '$ANT_PROFILE', not for its host hub.localhost:$HUB_PORT"
[ ! -e "$HOME_DIR/antasphere/tools/slideless.json" ] || fail "the hub login wrote a Slideless file"
sl list --json
[ "$RC" = 0 ] || fail "slideless list with no URL flag exited $RC: $ERR"
echo "$OUT" | jq -e '.presentations | type == "array"' >/dev/null || fail "slideless list's JSON: $OUT"
echo "$ERR" | grep -q "via Antasphere" || fail "the first slideless command should say it connected via Antasphere on stderr: $ERR"
SL_KEYS_1=$(sldb "SELECT count(*) FROM api_keys WHERE revoked_at IS NULL AND name LIKE 'Antasphere CLI %'")
[ "$SL_KEYS_1" = 1 ] || fail "expected one Slideless key minted by the exchange, found $SL_KEYS_1"
sl push "$DECK_DIR" --title "Lane E deck" --no-open --json
[ "$RC" = 0 ] || fail "slideless push exited $RC: $ERR"
DECK_ID=$(echo "$OUT" | jq -r '.presentation.id')
[ -n "$DECK_ID" ] && [ "$DECK_ID" != null ] || fail "push answered no deck id: $OUT"
[ -z "$ERR" ] || note "push's stderr: $ERR"
sl whoami --json
[ "$RC" = 0 ] || fail "slideless whoami exited $RC: $ERR"
[ "$(echo "$OUT" | jq -r .user.email)" = "$OWNER_EMAIL" ] && [ "$(echo "$OUT" | me_org)" = "$ORG_A_ID" ] \
  || fail "whoami does not land in the default organization $ORG_A_ID: $OUT"
[ "$(sldb "SELECT count(*) FROM api_keys WHERE revoked_at IS NULL AND name LIKE 'Antasphere CLI %'")" = 1 ] || fail "the second and third commands minted another key"
sl list --json
echo "$OUT" | jq -e --arg id "$DECK_ID" '[.presentations[].id] == [$id]' >/dev/null || fail "the list in the default organization should hold exactly the pushed deck: $OUT"
SL_PROFILE=$(jq -r '.activeProfile' "$HOME_DIR/antasphere/tools/slideless.json")
[ "$SL_PROFILE" = "slideless.localhost:$SL_PORT" ] || fail "the Slideless profile is '$SL_PROFILE', not named for its host"
jq -e --arg h "hub.localhost:$HUB_PORT" '.profiles[.activeProfile].connectKeys[$h].apiKey | startswith("slk_")' "$HOME_DIR/antasphere/tools/slideless.json" >/dev/null || fail "the cached key is not on the profile under the hub profile's name"
pass "step 1: antasphere login (profile $ANT_PROFILE) then slideless list, push and whoami with no URL flag: one exchange, one slk_ key, the deck in $ORG_A_NAME; profile $SL_PROFILE"

# ── Step 2 — a second clean home: slideless login alone ──────────────────────
say "Step 2 — a second clean home: slideless login alone ends signed in, the workspace named"
STEP="step 2"
home step2
sl_login "$OWNER_EMAIL"
[ "$RC" = 0 ] || fail "slideless login exited $RC: $ERR"
echo "$OUT" | jq -e --arg e "$OWNER_EMAIL" '.via == "antasphere" and .user.email == $e and (.workspace.name | length > 0)' >/dev/null \
  && [ "$(echo "$OUT" | me_org)" = "$ORG_A_ID" ] \
  || fail "slideless login's JSON does not name the workspace of the default organization: $OUT"
WS_A_NAME=$(echo "$OUT" | jq -r .workspace.name)
[ "$(echo "$OUT" | jq -r .hubProfile)" = "hub.localhost:$HUB_PORT" ] || fail "the hub profile the login wrote is '$(echo "$OUT" | jq -r .hubProfile)'"
jq -e --arg e "$OWNER_EMAIL" '.profiles["hub.localhost:'"$HUB_PORT"'"].apiKey | startswith("ant_")' "$HOME_DIR/antasphere/config.json" >/dev/null || fail "slideless login did not store the hub key as antasphere login does: $(jq -c '.profiles | map_values(.apiKey |= (.[0:6] + "…"))' "$HOME_DIR/antasphere/config.json")"
ant whoami --json
[ "$RC" = 0 ] || fail "antasphere whoami after slideless login exited $RC: $ERR (the two logins should be one)"
echo "$OUT" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' >/dev/null || fail "antasphere whoami: $OUT"
sl list --json
[ "$RC" = 0 ] && [ -z "$ERR" ] || fail "the second command should be served from the cache with nothing on stderr: rc=$RC err=$ERR"
pass "step 2: slideless login alone: the hub's code inline, then the exchange, signed in as $OWNER_EMAIL in $WS_A_NAME; antasphere whoami works on the same login"

# ── Step 5 — the hackathon: refused before the grant, connected after ────────
say "Step 5 — the hackathon (restricted): refused before the staff grant, connected after, the roster place"
STEP="step 5"
home step5
# The same person on a second terminal of the machine that ran step 2: the
# Antasphere login is carried over (one sign-in code per person saved; the hub
# allows an account five codes per ten minutes).
mkdir -p "$HOME_DIR/antasphere" && cp "$RUN_HOMES/step2/antasphere/config.json" "$HOME_DIR/antasphere/config.json"
ant tools --json
[ "$RC" = 0 ] || fail "antasphere tools exited $RC: $ERR"
echo "$OUT" | jq -e '(.tools | map(select(.slug == "hackathon-cloud")) | .[0]) as $t | $t.restricted == true and $t.granted == [] and $t.connected == null' >/dev/null \
  || fail "antasphere tools should show the hackathon restricted, open in no organization, not connected: $OUT"
echo "$OUT" | jq -e '(.tools | map(select(.slug == "slideless-cloud")) | .[0]) as $t | $t.restricted == false and ($t.granted | length) == 2' >/dev/null \
  || fail "antasphere tools should show Slideless open in the owner's two organizations: $OUT"
HK_USERS_0=$(hkdb "SELECT count(*) FROM \"user\"")
hk connect --json
[ "$RC" = 3 ] || fail "hackathon connect before the grant exited $RC, expected 3 (a refusal): out=$OUT err=$ERR"
echo "$ERR" | grep -q "no access to" || fail "the refusal should carry the hub's own sentence: $ERR"
echo "$ERR" | grep -qi "not allowed to do that\|check the key" && fail "the refusal reads as a bad key: $ERR"
HK_USERS_1=$(hkdb "SELECT count(*) FROM \"user\"")
[ "$HK_USERS_1" = "$HK_USERS_0" ] || fail "the refused connect left a user row on the hackathon ($HK_USERS_0 → $HK_USERS_1)"
[ "$(hkdb "SELECT count(*) FROM api_keys")" = 0 ] || fail "the refused connect left a key on the hackathon"
[ ! -e "$HOME_DIR/antasphere/tools/hackathon.json" ] || jq -e '[.profiles[]?.connectKeys // {} | length] | add == 0' "$HOME_DIR/antasphere/tools/hackathon.json" >/dev/null || fail "the refused connect cached a key on the machine"
HK_REFUSAL=$(echo "$ERR" | head -1)
pass "step 5a: before the grant, hackathon connect is refused with the hub's sentence, exit 3, no row on the tool: $HK_REFUSAL"

grant=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/grant.json" -w '%{http_code}' -X POST "$HUB/api/v1/admin/tool-access/set" -H "Origin: $HUB" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$ORG_A_ID\",\"slug\":\"hackathon-cloud\",\"granted\":true}")
[ "$grant" = 200 ] || fail "the staff grant answered $grant: $(cat "$SCRATCH/grant.json")"
note "staff granted hackathon-cloud to $ORG_A_NAME: $(jq -c . "$SCRATCH/grant.json")"
ant tools --json
echo "$OUT" | jq -e --arg a "$ORG_A_ID" '(.tools | map(select(.slug == "hackathon-cloud")) | .[0]) as $t | ($t.granted | map(.id // .)) == [$a]' >/dev/null \
  || fail "after the grant, antasphere tools should list the hackathon open in $ORG_A_NAME alone: $OUT"
hk_login "$OWNER_EMAIL"
[ "$RC" = 0 ] || fail "hackathon login after the grant exited $RC: $ERR"
echo "$OUT" | jq -e --arg e "$OWNER_EMAIL" '.via == "antasphere" and .user.email == $e' >/dev/null && [ "$(echo "$OUT" | me_org)" = "$ORG_A_ID" ] \
  || fail "hackathon login should land in the granted organization: $OUT"
[ "$(hkdb "SELECT count(*) FROM workspaces WHERE central_account_id = '$ORG_A_ID'")" = 1 ] || fail "the granted organization is not projected as a hackathon workspace"
[ "$(hkdb "SELECT count(*) FROM workspaces WHERE central_account_id = '$ORG_B_ID'")" = 0 ] || fail "the ungranted organization was projected on the hackathon"
hk connect --json
[ "$RC" = 3 ] || fail "hackathon connect with no event exited $RC, expected 3: $OUT $ERR"
echo "$ERR" | grep -q "event_not_configured" || fail "connect with no event should say event_not_configured: $ERR"
# The organizer configures the event and the roster: the owner is organizer, the member a participant.
NOW_S=$(date -u +%s)
iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
hk event configure --expected-version 0 --name "Lane E Event" --timezone Europe/Brussels \
  --starts-at "$(iso $((NOW_S - 3600)))" --build-ends-at "$(iso $((NOW_S + 7200)))" \
  --vote-opens-at "$(iso $((NOW_S + 7200 + 1800)))" --vote-closes-at "$(iso $((NOW_S + 14400)))" --json
[ "$RC" = 0 ] || fail "event configure exited $RC: $ERR"
printf '{"participants":[{"email":"%s","name":"Lane E Owner","role":"organizer"},{"email":"%s","name":"Lane E Member","role":"participant","team":"Team Walk"}]}\n' "$OWNER_EMAIL" "$MEMBER_EMAIL" >"$SCRATCH/roster.json"
hk event roster import --file "$SCRATCH/roster.json" --json
[ "$RC" = 0 ] || fail "roster import exited $RC: $ERR"
hk connect --json
[ "$RC" = 0 ] || fail "hackathon connect after the roster exited $RC: $ERR"
echo "$OUT" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e and .eligibility.role == "organizer" and .event.name == "Lane E Event"' >/dev/null \
  || fail "connect should name the owner's roster place (organizer of Lane E Event): $OUT"
hk connect
[ "$RC" = 0 ] || fail "hackathon connect (text) exited $RC: $ERR"
echo "$OUT" | grep -q "organizer" || fail "connect's text should name the roster place: $OUT"
# Workspace creation is a session's act (never a key's): the owner's browser
# session on the hackathon, signed in headlessly through the hub, is refused.
sso_session "$HK" "$HK_JAR"
rogue=$("${CURL[@]}" -b "$HK_JAR" -o "$SCRATCH/rogue.json" -w '%{http_code}' -X POST "$HK/api/v1/workspaces" -H "Origin: $HK" -H 'content-type: application/json' -d '{"name":"Rogue Event"}')
[ "$rogue" = 403 ] && jq -e '.error.code == "restricted_tool"' "$SCRATCH/rogue.json" >/dev/null || fail "POST /workspaces on the restricted hackathon answered $rogue (expected 403 restricted_tool): $(cat "$SCRATCH/rogue.json")"
"${CURL[@]}" -b "$HK_JAR" "$HK/api/v1/me" | jq -e '.canCreateWorkspace == false' >/dev/null || fail "/me on the restricted hackathon should say canCreateWorkspace false"
[ "$(hkdb "SELECT count(*) FROM workspaces")" = 1 ] || fail "the refused creation left a workspace"
[ "$(hkdb "SELECT count(*) FROM api_keys WHERE revoked_at IS NULL")" = 1 ] || fail "expected exactly one live hackathon key after login, connect ×3 and the refusals"
ant tools --json
echo "$OUT" | jq -e --arg e "$OWNER_EMAIL" '(.tools | map(select(.slug == "hackathon-cloud")) | .[0]).connected.email == $e and (.tools | map(select(.slug == "slideless-cloud")) | .[0]).connected == null' >/dev/null \
  || fail "antasphere tools should now show the hackathon connected on this machine and Slideless not: $OUT"
pass "step 5b: after the grant, hackathon login lands in $ORG_A_NAME (the ungranted organization is not projected), connect names the roster place (organizer of Lane E Event), workspace creation is refused (TOOL_RESTRICTED), antasphere tools shows it connected"

# A participant who signed in with the wrong address switches from the tool CLI (PRDCT-3032).
say "Step 5c — the wrong Antasphere account, then the right one, from the hackathon CLI alone"
STEP="step 5c"
home step5c
hk_login "$MEMBER_EMAIL"
[ "$RC" = 3 ] || fail "hackathon login as the member (no organization opens the hackathon to them) should be refused with exit 3: rc=$RC $OUT $ERR"
echo "$ERR" | grep -q "no access to" || fail "the refusal should be the hub's sentence: $ERR"
[ "$(jq -r '.profiles[.activeProfile].email' "$HOME_DIR/antasphere/config.json")" = "$MEMBER_EMAIL" ] || fail "the hub login of the member should be stored although the hackathon refused"
hk_login "$OWNER_EMAIL"
[ "$RC" = 0 ] || fail "hackathon login --email $OWNER_EMAIL on a machine signed in as the member should sign the owner in afresh: rc=$RC $ERR"
echo "$ERR" | grep -q "Replacing the Antasphere login $MEMBER_EMAIL with $OWNER_EMAIL" || fail "the switch should be said: $ERR"
echo "$OUT" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' >/dev/null || fail "the login should end as the owner: $OUT"
[ "$(jq -r '.profiles[.activeProfile].email' "$HOME_DIR/antasphere/config.json")" = "$OWNER_EMAIL" ] || fail "the hub profile should now be the owner's"
sl whoami --json
[ "$RC" = 0 ] && [ "$(echo "$OUT" | jq -r .user.email)" = "$OWNER_EMAIL" ] || fail "Slideless on the same machine should follow the new login: rc=$RC $OUT $ERR"
# The other way round: a Slideless key cached for the owner, the hub login switched to the member with the account CLI.
ant_login "$MEMBER_EMAIL"
[ "$RC" = 0 ] || fail "antasphere login as the member exited $RC: $ERR"
sl whoami --json
[ "$RC" = 0 ] && [ "$(echo "$OUT" | jq -r .user.email)" = "$MEMBER_EMAIL" ] || fail "after antasphere login as the member, Slideless must act as the member, never serve the owner's cached key: rc=$RC $OUT $ERR"
echo "$ERR" | grep -q "cached for $OWNER_EMAIL is retired" || fail "the retired key should be said: $ERR"
[ "$(sldb "SELECT count(*) FROM api_keys k JOIN \"user\" u ON u.id = k.created_by WHERE u.email = '$OWNER_EMAIL' AND k.revoked_at IS NULL AND k.name LIKE 'Antasphere CLI %'")" -le 3 ] || note "owner's live exchange keys: $(sldb "SELECT count(*) FROM api_keys k JOIN \"user\" u ON u.id = k.created_by WHERE u.email = '$OWNER_EMAIL' AND k.revoked_at IS NULL")"
pass "step 5c: hackathon login --email switches the Antasphere login from the member to the owner and ends connected; the account CLI switching it back retires the cached Slideless key and re-exchanges as the member"

say "Step 5d — logout from a tool CLI that holds nothing of its own"
STEP="step 5d"
home step5d
ant_login "$OWNER_EMAIL"
[ "$RC" = 0 ] || fail "antasphere login exited $RC: $ERR"
hk logout
[ "$RC" = 1 ] || fail "hackathon logout with no hackathon profile should exit 1 with a sentence: rc=$RC $OUT $ERR"
echo "$ERR" | grep -q "Nothing of Antasphere Hackathon's to sign out of" && echo "$ERR" | grep -q "hackathon logout --all" || fail "the sentence should name --all and antasphere logout: $ERR"
HUB_KEY_5D=$(jq -r '.profiles[.activeProfile].apiKey' "$HOME_DIR/antasphere/config.json")
hk logout --all
[ "$RC" = 0 ] || fail "hackathon logout --all exited $RC: $ERR"
echo "$OUT" | grep -q "revoked and forgotten" || fail "logout --all should say the Antasphere login is revoked and forgotten: $OUT"
[ "$(jq -r '.profiles | length' "$HOME_DIR/antasphere/config.json")" = 0 ] || fail "the hub profile should be gone"
hub_after_5d=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HUB_KEY_5D" "$HUB/api/v1/me")
[ "$hub_after_5d" = 401 ] || fail "the hub key should be revoked, /me answered $hub_after_5d"
ant whoami --json
[ "$RC" != 0 ] || fail "antasphere whoami after hackathon logout --all should not be signed in: $OUT"
pass "step 5d: hackathon logout on a machine with only an Antasphere login names the two commands that end it; --all revokes the hub key and clears the profile"

# ── Step 7 — antasphere logout --all leaves no live key anywhere ─────────────
say "Step 7 — antasphere logout --all leaves no live key on the hub nor on either tool"
STEP="step 7"
# Back on the machine of step 5 (steps 5c and 5d used homes of their own),
# with Slideless connected too.
HOME_DIR="$RUN_HOMES/step5"
note "config home: $HOME_DIR (step 5's)"
sl whoami --json
[ "$RC" = 0 ] || fail "slideless whoami exited $RC: $ERR"
sso_session "$SL" "$SL_JAR"
# The keys THIS home holds, read before the logout forgets them (the other
# homes of this run stand for other machines: their keys must survive).
MY_HUB_KEY=$(jq -r '.profiles[.activeProfile].apiKey' "$HOME_DIR/antasphere/config.json")
MY_SL_KEYS=$(jq -r '[.profiles[].connectKeys // {} | .[].apiKey] | .[]' "$HOME_DIR/antasphere/tools/slideless.json")
MY_HK_KEYS=$(jq -r '[.profiles[].connectKeys // {} | .[].apiKey] | .[]' "$HOME_DIR/antasphere/tools/hackathon.json")
[ -n "$MY_HUB_KEY" ] && [ -n "$MY_SL_KEYS" ] && [ -n "$MY_HK_KEYS" ] || fail "this home should hold a hub key and one key per tool before the logout"
# `mine <rows> <keys...>`: the ids of the listed keys that one of the stored keys begins with (<prefix>_<keyId>…).
mine() { local rows=$1; shift; echo "$rows" | jq -c --argjson keys "$(printf '%s\n' "$@" | jq -R . | jq -s .)" '[.[] | . as $k | select(any($keys[]; sub("^[a-z]+_"; "") | startswith($k.keyId))) | .id]'; }
before_hub=$(live_keys_json "$HUB" "$HUB_JAR"); before_sl=$(live_keys_json "$SL" "$SL_JAR"); before_hk=$(live_keys_json "$HK" "$HK_JAR")
mine_hub=$(mine "$before_hub" "$MY_HUB_KEY"); mine_sl=$(mine "$before_sl" $MY_SL_KEYS); mine_hk=$(mine "$before_hk" $MY_HK_KEYS)
note "live keys before: hub $(echo "$before_hub" | jq length) (this home's: $(echo "$mine_hub" | jq length)), Slideless $(echo "$before_sl" | jq length) (this home's: $(echo "$mine_sl" | jq length)), hackathon $(echo "$before_hk" | jq length) (this home's: $(echo "$mine_hk" | jq length))"
[ "$(echo "$mine_hub" | jq length)" = 1 ] && [ "$(echo "$mine_sl" | jq length)" -ge 1 ] && [ "$(echo "$mine_hk" | jq length)" -ge 1 ] || fail "each instance should list the key this home holds as live before the logout"
ant logout --all --json
[ "$RC" = 0 ] || fail "antasphere logout --all exited $RC: $ERR"
echo "$OUT" | jq -e '.revoked == true and .profileCleared == true and (.tools | length) == 2 and all(.tools[]; .outcome == "revoked")' >/dev/null \
  || fail "logout --all should revoke the hub key and both tool keys: $OUT"
after_hub=$(live_keys_json "$HUB" "$HUB_JAR"); after_sl=$(live_keys_json "$SL" "$SL_JAR"); after_hk=$(live_keys_json "$HK" "$HK_JAR")
gone() { # before mine after → the ids of `mine` still live after must be none, and nothing else may have gone
  local still others_before others_after
  still=$(echo "$3" | jq --argjson m "$2" '[.[] | select(.id as $i | $m | index($i) != null)] | length')
  others_before=$(echo "$1" | jq --argjson m "$2" '[.[] | select(.id as $i | $m | index($i) == null)] | length')
  others_after=$(echo "$3" | jq length)
  [ "$still" = 0 ] && [ "$others_before" = "$others_after" ]
}
gone "$before_hub" "$mine_hub" "$after_hub" || fail "on the hub: this home's key should be gone and the other homes' keys kept; before $before_hub, after $after_hub"
gone "$before_sl" "$mine_sl" "$after_sl" || fail "on Slideless: this home's key should be gone and the other homes' keys kept; before $before_sl, after $after_sl"
gone "$before_hk" "$mine_hk" "$after_hk" || fail "on the hackathon: this home's key should be gone and the other homes' keys kept; before $before_hk, after $after_hk"
note "live keys after: hub $(echo "$after_hub" | jq length), Slideless $(echo "$after_sl" | jq length), hackathon $(echo "$after_hk" | jq length): the other homes' logins, untouched"
[ "$(hubdb "SELECT count(*) FROM oauth_refresh_token WHERE user_id = '$HUB_USER_ID' AND revoked IS NULL AND api_key_id = '$(echo "$mine_hub" | jq -r '.[0]')'")" = 0 ] || fail "the hub kept a live offline grant of the revoked key"
jq -e '(.profiles | to_entries | all(.value.apiKey == null))' "$HOME_DIR/antasphere/config.json" >/dev/null || fail "the hub profile still holds a key"
jq -e '[.profiles[]?.connectKeys // {} | length] | add == 0' "$HOME_DIR/antasphere/tools/slideless.json" >/dev/null || fail "the Slideless file still holds a cached key"
jq -e '[.profiles[]?.connectKeys // {} | length] | add == 0' "$HOME_DIR/antasphere/tools/hackathon.json" >/dev/null || fail "the hackathon file still holds a cached key"
sl list --json
[ "$RC" != 0 ] || fail "slideless list after logout --all should not be signed in: $OUT"
echo "$ERR" | grep -qi "antasphere login" || fail "the error after logout --all should point at antasphere login: $ERR"
pass "step 7: antasphere logout --all revoked this login's hub key and both tool keys: GET /api-keys on the hub, Slideless and the hackathon lists none of them live and every other login's keys untouched; the next slideless command asks for antasphere login"

# ── Step 3 — --org on both CLIs, org use, the pinned key ─────────────────────
say "Step 3 — --org by name and by hub id on both CLIs; antasphere org use; a pinned key refused with the pin named"
STEP="step 3"
home step3
ant_login "$OWNER_EMAIL"
[ "$RC" = 0 ] || fail "antasphere login exited $RC: $ERR"
ant whoami --json
[ "$(echo "$OUT" | jq -r .workspace.id)" = "$ORG_A_ID" ] || fail "antasphere whoami should act on the default organization $ORG_A_ID: $OUT"
ant whoami --org "Second Org" --json
[ "$RC" = 0 ] || fail "antasphere whoami --org by name exited $RC: $ERR"
[ "$(echo "$OUT" | jq -r .workspace.id)" = "$ORG_B_ID" ] || fail "antasphere --org by name should act on $ORG_B_ID: $OUT"
ant whoami --org "$ORG_B_ID" --json
[ "$RC" = 0 ] || fail "antasphere whoami --org by id exited $RC: $ERR"
[ "$(echo "$OUT" | jq -r .workspace.id)" = "$ORG_B_ID" ] || fail "antasphere --org by id should act on $ORG_B_ID: $OUT"
sl list --org "Second Org" --json
[ "$RC" = 0 ] || fail "slideless list --org by name exited $RC: $ERR"
echo "$OUT" | jq -e '.presentations == []' >/dev/null || fail "Second Org should hold no deck: $OUT"
sl whoami --org "$ORG_B_ID" --json
[ "$RC" = 0 ] || fail "slideless whoami --org by id exited $RC: $ERR"
[ "$(echo "$OUT" | me_org)" = "$ORG_B_ID" ] || fail "slideless --org by id should land in $ORG_B_ID: $OUT"
sl list --org "$ORG_A_ID" --json
echo "$OUT" | jq -e --arg id "$DECK_ID" '[.presentations[].id] == [$id]' >/dev/null || fail "--org by id on $ORG_A_NAME should list the deck: $OUT"
SL_ORG="$ORG_B_ID" run "SLIDELESS_ORG=<Second Org id> slideless whoami --json" env SLIDELESS_ORG="$ORG_B_ID" node "$SL_BIN" whoami --json
[ "$(echo "$OUT" | me_org)" = "$ORG_B_ID" ] || fail "SLIDELESS_ORG should select the organization: $OUT"
sl list --org "Nope" --json
[ "$RC" != 0 ] || fail "--org Nope should be refused"
echo "$ERR" | grep -q "not one of your" || fail "the refusal of an unknown --org should list yours: $ERR"
sl list --org "$ORG_B_ID" --workspace "$ORG_A_NAME" --json
[ "$RC" != 0 ] && echo "$ERR" | grep -q "not both" || fail "--org with --workspace should be a usage error: $ERR"
# antasphere org use moves the server-side default: Slideless lands there with no flag.
ant org use "Second Org" --json
[ "$RC" = 0 ] || fail "antasphere org use exited $RC: $ERR"
# The tool follows the hub's default on its next reconcile pass: its per-user
# cache is 10 s (hub-reconcile.ts reconcileTtlMs), so a command within those
# seconds still lands in the old organization (finding F1 of the walk). The
# command that RUNS the pass lands in the new default (F2, fixed: the live
# gate resolves the default again after its pass).
sleep 11
sl whoami --json
[ "$(echo "$OUT" | me_org)" = "$ORG_B_ID" ] || fail "after org use, the first slideless command past the cache should land in Second Org with no flag: $OUT"
hk_login "$OWNER_EMAIL"
[ "$RC" = 0 ] || fail "hackathon login exited $RC: $ERR"
[ "$(echo "$OUT" | me_org)" = "$ORG_A_ID" ] || fail "the hackathon, granted in $ORG_A_NAME only, should land there although the default is Second Org: $OUT"
ant org use "$ORG_A_ID" --json
[ "$RC" = 0 ] || fail "antasphere org use by id exited $RC: $ERR"
sleep 11
sl whoami --json
[ "$(echo "$OUT" | me_org)" = "$ORG_A_ID" ] || fail "after org use back, slideless should land in $ORG_A_NAME: $OUT"
# A pinned key: minted by the dashboard session in workspace A, refused under --org B with the pin named.
WS_A_ID=$(sldb "SELECT id FROM workspaces WHERE central_account_id = '$ORG_A_ID'")
pin=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/pin.json" -w '%{http_code}' -X POST "$SL/api/v1/api-keys" -H "Origin: $SL" -H "X-Workspace-Id: $WS_A_ID" -H 'content-type: application/json' \
  -d "{\"name\":\"pinned walk key\",\"scopes\":[\"presentations:read\"],\"workspaceId\":\"$WS_A_ID\"}")
[ "$pin" = 201 ] || fail "minting the pinned key answered $pin: $(cat "$SCRATCH/pin.json")"
PINNED=$(jq -r .key "$SCRATCH/pin.json")
sl list --api-key "$PINNED" --json
[ "$RC" = 0 ] && echo "$OUT" | jq -e --arg id "$DECK_ID" '[.presentations[].id] == [$id]' >/dev/null || fail "the pinned key should list its own workspace: rc=$RC $OUT $ERR"
sl list --api-key "$PINNED" --org "Second Org" --json
[ "$RC" != 0 ] || fail "a pinned key under --org of another organization should be refused: $OUT"
echo "$ERR" | grep -q "pinned to the workspace" && echo "$ERR" | grep -q "the --org flag" || fail "the refusal should name the pin and the flag: $ERR"
pass "step 3: --org by name and by id on both CLIs, SLIDELESS_ORG, the unknown and the double selection refused; org use moves what Slideless lands in and the hackathon stays where it is granted; the pinned key is refused with its pin named"

# ── Step 4 — a self-hosted Slideless beside the pair ─────────────────────────
say "Step 4 — a self-hosted Slideless stack beside the pair: a second profile, slideless use, the cloud key never sent to it"
STEP="step 4"
dself down -v --remove-orphans >/dev/null 2>&1 || true
dself up -d --no-build app db mailpit || fail "the self-hosted stack did not come up"
wait_ready self "$SELF/healthz" 300
self_setup=$("${CURL[@]}" -X POST "$SELF/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Self-hosted\",\"setupToken\":\"$SELF_SETUP_TOKEN\",\"owner\":{\"email\":\"$OWNER_EMAIL\",\"name\":\"Self Owner\",\"password\":\"$OWNER_PASSWORD\"}}")
echo "$self_setup" | jq -e '(.workspaceId // "") != ""' >/dev/null || fail "the self-hosted setup minted no workspace: $self_setup"
"${CURL[@]}" "$SELF/api/v1/instance" | jq -e '.edition == "oss" and (.auth.methods | index("antasphere") | not)' >/dev/null || fail "the self-hosted instance should be oss without the antasphere method"
# Same home as step 3: the cloud profile is the active one. From here the
# variable is unset: the active profile decides, as on a real machine.
SL_NO_URL=1
run_login "$SELF_MAIL" "$OWNER_EMAIL" "slideless login --api-url $SELF --email $OWNER_EMAIL --json" node "$SL_BIN" login --api-url "$SELF" --email "$OWNER_EMAIL" --json
[ "$RC" = 0 ] || fail "slideless login on the self-hosted instance exited $RC: $ERR"
echo "$OUT" | jq -e --arg p "localhost:$SELF_PORT" '.via == "otp" and .profile == $p and .workspace.name == "Self-hosted"' >/dev/null || fail "the self-hosted login should make the profile localhost:$SELF_PORT over the instance's code: $OUT"
sl profiles --json
echo "$OUT" | jq -e --arg p "localhost:$SELF_PORT" --arg c "slideless.localhost:$SL_PORT" '.activeProfile == $p and (.profiles | has($c)) and .profiles[$p].credential != "none"' >/dev/null || fail "profiles should hold both instances with the self-hosted one active: $OUT"
sl whoami --json
echo "$OUT" | jq -e --arg p "localhost:$SELF_PORT" '.profile == $p and .workspace.name == "Self-hosted" and .credentialSource == "profile"' >/dev/null || fail "whoami on the active self-hosted profile: $OUT"
sl use "slideless.localhost:$SL_PORT" --json
[ "$RC" = 0 ] || fail "slideless use exited $RC: $ERR"
sl whoami --json
[ "$(echo "$OUT" | me_org)" = "$ORG_A_ID" ] || fail "after use, whoami should be on the cloud profile in $ORG_A_NAME: $OUT"
sl use "localhost:$SELF_PORT" --json
sl list --json
[ "$RC" = 0 ] && echo "$OUT" | jq -e '.presentations == []' >/dev/null || fail "the self-hosted instance holds no deck: rc=$RC $OUT"
# The cloud profile's key under a URL naming the self-hosted instance: never sent there.
SL_NO_URL="" SL_URL_OVERRIDE="$SELF" sl list --profile "slideless.localhost:$SL_PORT" --json
[ "$RC" != 0 ] || fail "a cloud profile under SLIDELESS_URL naming the self-hosted instance should be refused, not served: $OUT"
[ "$(selfdb "SELECT count(*) FROM api_keys")" = 1 ] || fail "the self-hosted instance holds $(selfdb "SELECT count(*) FROM api_keys") keys, expected the OTP key alone"
self_401=$(dself logs --no-log-prefix app 2>/dev/null | grep -c '"status":401' || true)
[ "$self_401" = 0 ] || fail "the self-hosted app saw $self_401 request(s) answered 401: a key of another instance was presented"
pass "step 4: the self-hosted instance is profile localhost:$SELF_PORT over its own code, slideless use switches between the two, the cloud key never reached it (1 key on its table, 0 requests answered 401)"

# ── Step 6 — a revoked key recovers once; a removed membership fails with a sentence ──
say "Step 6 — a revoked tool key recovers once; a membership removed at the hub fails the next command with a sentence"
STEP="step 6"
sl use "slideless.localhost:$SL_PORT" --json
sldb "UPDATE api_keys SET revoked_at = now() WHERE revoked_at IS NULL AND name LIKE 'Antasphere CLI %'" >/dev/null
sl list --json
[ "$RC" = 0 ] || fail "the command after the revocation should recover: rc=$RC $ERR"
echo "$ERR" | grep -q "cached key was refused" || fail "the recovery should be said on stderr: $ERR"
echo "$OUT" | jq -e --arg id "$DECK_ID" '[.presentations[].id] == [$id]' >/dev/null || fail "the replayed command should answer: $OUT"
sl list --json
[ "$RC" = 0 ] && [ -z "$ERR" ] || fail "the second command should be served from the new cache: rc=$RC err=$ERR"
[ "$(sldb "SELECT count(*) FROM api_keys WHERE revoked_at IS NULL AND name LIKE 'Antasphere CLI %'")" = 1 ] || fail "expected exactly one live exchange key after the recovery"
pass "step 6a: every exchange key revoked on the instance, the next command evicts, re-exchanges once and replays; the one after is served from the cache"
# The member (made in Phase 2) signs in on both CLIs, then is removed at the hub.
home step6-member
SL_NO_URL=""
ant_login "$MEMBER_EMAIL"
[ "$RC" = 0 ] || fail "the member's antasphere login exited $RC: $ERR"
sl whoami --json
[ "$RC" = 0 ] || fail "the member's slideless whoami exited $RC: $ERR"
echo "$OUT" | jq -e --arg b "$ORG_B_ID" '[.workspaces[].centralAccountId] | index($b) != null' >/dev/null || fail "the member should see Second Org on Slideless: $OUT"
sl list --org "Second Org" --json
[ "$RC" = 0 ] || fail "the member's list in Second Org exited $RC: $ERR"
hk connect --json
[ "$RC" = 3 ] || fail "the member, in no granted organization, should be refused the hackathon (exit 3): rc=$RC $OUT $ERR"
# Removed at the hub: the owner deactivates the membership.
mem_id=$("${CURL[@]}" -b "$HUB_JAR" -H "X-Workspace-Id: $ORG_B_ID" "$HUB/api/v1/members?limit=100" | jq -r --arg u "$MEMBER_HUB_ID" '.members[] | select(.userId == $u) | .id')
[ -n "$mem_id" ] && [ "$mem_id" != null ] || fail "the member's row is not on the hub's roster of Second Org"
rm_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/rm.json" -w '%{http_code}' -X PATCH "$HUB/api/v1/members/$mem_id" -H "Origin: $HUB" -H "X-Workspace-Id: $ORG_B_ID" -H 'content-type: application/json' -d '{"isActive":false}')
[ "$rm_status" = 200 ] || fail "deactivating the member at the hub answered $rm_status: $(cat "$SCRATCH/rm.json")"
sleep 11 # the tool's reconcile cache (10 s)
sl list --org "Second Org" --json
[ "$RC" != 0 ] || fail "after the removal at the hub, the member's command in Second Org should fail: $OUT"
[ -n "$ERR" ] || fail "the failure should carry a sentence"
echo "$ERR" | grep -q "at " && fail "the failure reads as a stack trace: $ERR"
REMOVED_SENTENCE=$(echo "$ERR" | head -2 | tr '\n' ' ')
pass "step 6b: the member removed at the hub fails the next Slideless command in that organization with a sentence, exit $RC: $REMOVED_SENTENCE"

STEP=""
say "Every step passed"
