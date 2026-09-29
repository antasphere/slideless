#!/usr/bin/env bash
# The federation drill (PRDCT-1370) — internal/federation.md "The federation
# drill". The FIRST automated test of the hub ↔ Slideless seam: it boots the
# two-instance harness (docker-compose.federation.yml + the drill overlay),
# runs both setups and a headless SSO login, and asserts on the HUB DATABASE
# — the only place the grant-family consequences are visible.
#
# What it proves (each leg = named assertions):
#
#   1. AUTH-3 — Slideless never hands a caller its provider grant: the
#      provider-grant routes answer 403 on the cloud edition.
#   2. CLOUD-2 — a hub that is SLOW BUT ALIVE (a delay hop past
#      Slideless's 5 s token timeout) commits a rotation Slideless never
#      hears about; the next Slideless demand PROBES (RFC 7662) instead of
#      re-presenting, marks its own grant dead, and the hub-side family —
#      the CLI grant shares it — is NOT torn down (rows before/after).
#   3. Per-client audiences (PRDCT-1376) — a second registry tool's
#      credential cannot mint a token audienced at Slideless's /mcp.
#   4. Post-rotation grace (PRDCT-1376/1370) — a token rotated out seconds
#      ago is re-armed on re-presentation (fresh pair, family intact, the
#      unused successor retired), and presenting that retired successor
#      tears the family down as reuse detection always did.
#   5. OIDC audit (PRDCT-1376) — the hub's audit log carries rows for the
#      authorize, token, revoke and consent surfaces the drill exercised.
#   6. Workspace creation (PRDCT-2443, Phase 3b) — the login's grant carries
#      orgs:create, POST /workspaces creates the organization AT THE HUB as
#      the user and projects it (owner, hubOrigin), the hub's audit row names
#      the tool client, an slk_ key is refused; and the deploy-order fact:
#      the hub refuses a sign-in that requests a scope it does not list.
#   7. The billing rail, phase 1 (PRDCT-2625 + PRDCT-2626, Phase 8b) — one
#      metered action per surface (the dashboard session, an slk_ key, an
#      OAuth bearer over MCP) lands in the hub's usage_events exactly once:
#      the projected organization, the hub user, the channel, the action and
#      the size, every figure a delta over a drained queue (the legs before
#      it meter too); every event the tool ever queued, posted again by hand
#      with the tool's own client-credentials token, answers duplicate for
#      every id; the owner reads the consumption per person on GET
#      /billing/usage, the hub's own count for the organization.
#   8. The billing rail, phase 2 (PRDCT-2663 + PRDCT-2664, Phase 8b's second
#      leg) — staff seeds the hub's price book from Slideless's own discovery
#      (a second seed inserts nothing); the organization holds the 5,000
#      sign-up grant; POST /usage/check with the machine token prices a 1 MiB
#      upload at 5 credits with the top-up link; a staff grant drives the
#      balance to zero and one action per surface answers 402
#      entitlement_denied carrying the top-up link (the MCP tool's text
#      included); the balance restored, the same action lands, the hub
#      prices it, its debit is on GET /billing/ledger and the balance moved;
#      the hub slow beyond the check's budget still lets the action land
#      (fail-open) with the posture on /metrics, healed by the next answer.
#   9. Deck pictures on the cloud edition (PRDCT-2785, Phase 8b, after the MCP
#      deck) — the deck an agent just pushed gets its still image from the
#      renderer: its thumbnail route answers 200 with a WebP within a minute.
#  10. The login reconcile (Phase 3) — the hub-origin memberships the login
#      projected are exactly the organizations the hub lists for the person,
#      no more, no fewer.
#  11. Decks in a hub-origin workspace, and the live reconcile (Phase 3c) —
#      the SSO session pushes a deck (asset, upload session, commit) into the
#      projected workspace; the list there holds exactly it and the person's
#      other workspace holds none; the slk_ key reads it and retitles it; a
#      local membership mutation is refused hub_managed with the hub's
#      manageUrl and leaves no row; an organization created AT THE HUB
#      reaches GET /me on the next demand past the TTL, with no new login.
#  12. The cloud closures of every non-hub credential entrance (Phase 4b) —
#      the tool's CLI OTP mint, the emailOTP session surface, the password
#      reset surface and the Google social provider are refused, and none of
#      them mails a code.
#  13. CLI connect (Phase 8) — the hub CLI login (a code read from Mailpit) →
#      POST /sso/tool-token → POST /sso/cli-connect → a user-scoped,
#      unpinned slk_ key (presentations:read + presentations:write) that
#      reads the session's retitled deck, pushes one of its own and is
#      refused GET /members; the exchange token is refused on replay; the
#      browser grant Phase 5 left dead is healed without a browser.
#  14. The free plan's refusal comes back (Phase 8b's third leg) — once the
#      staff overrides are deleted, the locked link mint answers 403
#      plan_required (deck.password) again after the plan cache turns over.
#  15. Logout (Phase 9) — DELETE /cli/auth/key revokes exactly the presenting
#      key (401 after, the other slk_ key still reads, a session refused the
#      route); POST /sso/logout ends the browser session; the hub-side CLI
#      logout cascades onto the offline grant, and the tool follows: the
#      remaining slk_ key answers 401 hub_grant_expired.
#
# Phase 3 of the billing rail (PRDCT-2718) is proven by the billing campaign,
# not by a leg here: scripts/billing-campaign.sh boots this same pair through
# this drill when it is not up, runs the 70 scenarios of scripts/billing-campaign/
# against the Stripe sandbox (STRIPE_SANDBOX_SECRET_KEY in the environment,
# `stripe listen` and test clocks) and writes campaign/run-<n>/results.json and
# report.md; its header says how to run it.
#
# The browser sign-in on this pair starts on http://slideless.localhost:<port>,
# never on http://localhost:<port> (PRDCT-2645): the hub sends the browser back
# to slideless.localhost, so the state cookie set on one host cannot be read
# on the other and a sign-in started on localhost ends on
# /login?error=state_mismatch. Browsers resolve *.localhost to the loopback on
# their own; curl and Node do not, which is why every curl below pins both
# names with --resolve. Not a defect of the sign-in: a driven browser opened
# on the wrong host. Reproduced on the pair on 23 September 2026 with a
# driven Chromium: started on localhost:6710 the flow ends on
# slideless.localhost:6710/login?error=state_mismatch; started on
# slideless.localhost:6710 it lands on the dashboard.
#
# A second artefact of the same hostnames: the hub's SSO hint cookie domain
# defaults to the issuer host minus its first label, here `localhost`, a
# domain browsers refuse for a cookie, so the dashboard on slideless.localhost
# never sees the hint and its hint-watch (single logout) signs a fresh browser
# session out within a second (POST /sso/logout in the app log). Production
# hostnames share a real parent (antasphere.com). A browser demo on this pair
# needs HUB_HINT_COOKIE_DOMAIN set to a shared parent the browser accepts, or
# the watch will sign the session out; the headless legs below never carry
# the hint and are untouched.
#
# Usage: ./scripts/federation-drill.sh
#   FEDERATION_HUB_DIR=<path>  hub checkout to build (default ../../../hub, see the compose file)
#   DRILL_SKIP_BUILD=1         reuse antasphere-hub:federation-dev + slideless:federation-dev
#                              + slideless-renderer:federation-dev (CI pre-builds)
#   DRILL_KEEP=1               leave the stack up after a PASS (inspect; `down -v` yourself)
#
# A second copy beside a busy machine's standing stacks (PRDCT-2443): every
# fixed value is an env variable the compose files read too, today's value
# as the default — unset, CI's run is byte-for-byte what it always was.
#   FEDERATION_PROJECT=slideless-federation         compose project name
#   FEDERATION_HUB_PORT=3300                        hub port (host = PORT = hostname port)
#   FEDERATION_SL_PORT=3310                         Slideless port (same rule)
#     Neither port may be on the Fetch standard's blocked-port list (6000,
#     6566, 6665-6669, 6697, 10080, ...): Node's fetch refuses every URL on
#     one with "bad port", and Slideless's own discovery call to the hub
#     dies before the SSO leg (found on the billing-pair run, hub on 6000).
#   FEDERATION_HOP_PORT=8474                        the delay hop's admin port
#   FEDERATION_MAIL_PORT=8030                       Mailpit UI host port
#   FEDERATION_SUBNET_PREFIX=172.30.250             the /24's first three octets
#   FEDERATION_HUB_IMAGE=antasphere-hub:federation-dev
#   FEDERATION_SL_IMAGE=slideless:federation-dev
#   FEDERATION_RENDERER_IMAGE=slideless-renderer:federation-dev
#
# Everything else is throwaway: the compose project's volumes go with
# `down -v` on exit, pass or fail.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=${FEDERATION_PROJECT:-slideless-federation}
HUB_PORT=${FEDERATION_HUB_PORT:-3300}
SL_PORT=${FEDERATION_SL_PORT:-3310}
HOP_PORT=${FEDERATION_HOP_PORT:-8474}
MAIL_PORT=${FEDERATION_MAIL_PORT:-8030}
HUB_IMAGE=${FEDERATION_HUB_IMAGE:-antasphere-hub:federation-dev}
SL_IMAGE=${FEDERATION_SL_IMAGE:-slideless:federation-dev}
RENDERER_IMAGE=${FEDERATION_RENDERER_IMAGE:-slideless-renderer:federation-dev}
HUB=http://hub.localhost:$HUB_PORT
SL=http://slideless.localhost:$SL_PORT
HOP=http://127.0.0.1:$HOP_PORT
# Mailpit's API: the hub's CLI sign-in code (Phase 8) is read from it.
MAIL=http://127.0.0.1:$MAIL_PORT
SL_CLIENT_ID=tool-slideless-cloud
SL_CLIENT_SECRET=federation-dev-client-secret-0001
SECOND_CLIENT_ID=tool-drill-second
SECOND_CLIENT_SECRET=federation-dev-client-secret-0002
SECOND_RESOURCE=http://second.localhost:3320/mcp
SECOND_REDIRECT=http://second.localhost:3320/callback
SL_RESOURCE=http://slideless.localhost:$SL_PORT/mcp
PASS_COUNT=0

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '    · %s\n' "$*"; }
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$*"
}
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  exit 1
}

for bin in docker jq curl openssl; do
  command -v "$bin" >/dev/null || fail "required tool missing: $bin"
done
for port in "$HUB_PORT" "$SL_PORT" "$HOP_PORT" "$MAIL_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
    fail "port $port already answers — refusing to run (the harness needs $HUB_PORT, $SL_PORT, $HOP_PORT and $MAIL_PORT)"
  fi
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/federation-drill.XXXXXX")"
# The claim credential Slideless's POST /setup requires (PRDCT-1347); the drill
# overlay hands it to the app container.
export FEDERATION_DRILL_SETUP_TOKEN="$(openssl rand -hex 16)"
HUB_JAR="$SCRATCH/hub.cookies"
SL_JAR="$SCRATCH/sl.cookies"

dc() {
  docker compose -p "$PROJECT" \
    -f "$REPO/docker-compose.federation.yml" -f "$REPO/docker-compose.federation.drill.yml" "$@"
}
# *.localhost resolves in browsers by RFC 6761 but not in every curl: pin both names.
CURL=(curl -sS --max-time 60 --resolve "hub.localhost:$HUB_PORT:127.0.0.1" --resolve "slideless.localhost:$SL_PORT:127.0.0.1")
hubdb() { dc exec -T hub-db psql -U antasphere -d antasphere -v ON_ERROR_STOP=1 -Atc "$1"; }
sldb() { dc exec -T db psql -U slideless -d slideless -v ON_ERROR_STOP=1 -Atc "$1"; }
applogs() { dc logs --no-log-prefix "$1" 2>/dev/null || true; }

wait_ready() { # service url timeout_s
  local i=0
  until "${CURL[@]}" -o /dev/null -f "$2" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge "$3" ] && {
      applogs "$1" | tail -30 >&2
      fail "$1 ($2) not ready after $3 s"
    }
    sleep 1
  done
  return 0
}

dump_logs() {
  for svc in hub app hubhop; do
    echo "── logs: $svc ──────────────────────────────────────────────" >&2
    applogs "$svc" | tail -40 >&2
  done
}

CLEANED=0
cleanup() {
  local status=$?
  [ "$CLEANED" = 1 ] && exit "$status"
  CLEANED=1
  [ "$status" != 0 ] && dump_logs
  if [ "$status" = 0 ] && [ "${DRILL_KEEP:-}" = "1" ]; then
    echo "  DRILL_KEEP=1: stack left up (project $PROJECT)"
  else
    say "Teardown"
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
  if [ "$status" = 0 ]; then
    printf '\n\033[32m✔ federation drill passed — %s assertions\033[0m\n' "$PASS_COUNT"
  else
    printf '\n\033[31m✘ federation drill FAILED (after %s passing assertions)\033[0m\n' "$PASS_COUNT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
# Family rows of (client, user) at the hub: "<total> <live> <retired-at-epoch>".
family() { # client_id user_id
  hubdb "SELECT count(*) || ' ' || count(*) FILTER (WHERE revoked IS NULL) || ' ' || count(*) FILTER (WHERE revoked = timestamp '1970-01-01 00:00:00') FROM oauth_refresh_token WHERE client_id = '$1' AND user_id = '$2'"
}

# ── Phase 0 — images ─────────────────────────────────────────────────────────
say "Phase 0 — images (hub from ${FEDERATION_HUB_DIR:-../../../hub}, Slideless from this repo)"
if [ "${DRILL_SKIP_BUILD:-}" = "1" ] \
  && docker image inspect "$HUB_IMAGE" >/dev/null 2>&1 \
  && docker image inspect "$SL_IMAGE" >/dev/null 2>&1 \
  && docker image inspect "$RENDERER_IMAGE" >/dev/null 2>&1; then
  note "DRILL_SKIP_BUILD=1 and the three images exist — reusing"
else
  dc build
fi

# ── Phase 1 — up ─────────────────────────────────────────────────────────────
say "Phase 1 — bring the two-instance stack up"
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --no-build
wait_ready hubhop "$HOP/version" 60
wait_ready hub "$HUB/healthz" 300
wait_ready app "$SL/healthz" 300
pass "hub, Slideless (cloud) and the delay hop are up"

# ── Phase 2 — setups ─────────────────────────────────────────────────────────
say "Phase 2 — both setups"
OWNER_EMAIL=drill-owner@drill.test
OWNER_PASSWORD="drill-owner-password-$(openssl rand -hex 6)"
hub_setup=$("${CURL[@]}" -X POST "$HUB/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Drill Hub\",\"owner\":{\"email\":\"$OWNER_EMAIL\",\"name\":\"Drill Owner\",\"password\":\"$OWNER_PASSWORD\"}}")
HUB_USER_ID=$(echo "$hub_setup" | jq -r '.ownerUserId // empty')
[ -n "$HUB_USER_ID" ] || fail "hub setup did not answer an ownerUserId: $hub_setup"
sl_setup=$("${CURL[@]}" -X POST "$SL/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Drill Slideless\",\"setupToken\":\"$FEDERATION_DRILL_SETUP_TOKEN\",\"owner\":{\"email\":\"sl-operator@drill.test\",\"name\":\"SL Operator\",\"password\":\"$OWNER_PASSWORD\"}}")
# ownerUserId first: a refusal body has no workspaceId either, so the null check
# alone passed on a 403 and the instance was never claimed.
echo "$sl_setup" | jq -e '(.ownerUserId // "") != "" and .workspaceId == null' >/dev/null || fail "Slideless cloud setup should mint no workspace: $sl_setup"
seeded=$(applogs hub | grep -c 'tool registry: client seeded' || true)
[ "$seeded" -ge 2 ] || fail "expected the hub to seed 2 registry clients, saw $seeded log lines"
pass "hub setup (owner $HUB_USER_ID), Slideless cloud setup (no workspace), two registry clients seeded"

# The hub owner's browser session.
"${CURL[@]}" -f -o /dev/null -c "$HUB_JAR" -X POST "$HUB/api/v1/auth/sign-in/email" \
  -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}"
me=$("${CURL[@]}" -b "$HUB_JAR" "$HUB/api/v1/me")
echo "$me" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' >/dev/null || fail "hub sign-in did not yield a session: $me"
pass "hub owner signed in (session cookie)"

# ── Phase 3 — headless SSO login at Slideless ────────────────────────────────
say "Phase 3 — headless 'Sign in with Antasphere' (registry tools skip the consent screen)"
initiate=$("${CURL[@]}" -c "$SL_JAR" -X POST "$SL/api/v1/auth/sign-in/oauth2" -H 'content-type: application/json' \
  -d '{"providerId":"antasphere","callbackURL":"/"}')
AUTHZ_URL=$(echo "$initiate" | jq -r '.url // empty')
[ -n "$AUTHZ_URL" ] || fail "Slideless did not answer an authorize URL: $initiate"
# The authorize hop runs on the hub owner's session; a registry client
# short-circuits straight to the code redirect.
location=$("${CURL[@]}" -b "$HUB_JAR" -o /dev/null -w '%{redirect_url}' "$AUTHZ_URL")
case "$location" in
  "$SL/api/v1/auth/oauth2/callback/antasphere?"*code=*) ;;
  *) fail "authorize did not redirect to the Slideless callback with a code: $location" ;;
esac
cb_status=$("${CURL[@]}" -b "$SL_JAR" -c "$SL_JAR" -o /dev/null -w '%{http_code}' "$location")
[ "$cb_status" = 302 ] || fail "Slideless callback answered $cb_status"
sl_me=$("${CURL[@]}" -b "$SL_JAR" "$SL/api/v1/me")
echo "$sl_me" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' >/dev/null || fail "no Slideless session after the callback: $sl_me"
SL_USER_ID=$(echo "$sl_me" | jq -r '.user.id')
grant_row=$(sldb "SELECT (refresh_token IS NOT NULL)::int FROM account WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'")
[ "$grant_row" = 1 ] || fail "Slideless holds no hub grant on the account row after login"
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 1 ] && [ "$fam_live" = 1 ] || fail "expected exactly one live refresh row at the hub after login, got total=$fam_total live=$fam_live"
pass "SSO login through the proxy hop: Slideless session + encrypted grant; hub family = 1 live row"
# The login reconcile (fail-closed, as the user): what the hub lists for the
# person is exactly what the login projected — one hub-origin membership per
# organization, no more, no fewer.
hub_org_ids=$("${CURL[@]}" -b "$HUB_JAR" "$HUB/api/v1/orgs" | jq -r '.orgs[].id' | LC_ALL=C sort | paste -sd, -)
[ -n "$hub_org_ids" ] || fail "the hub lists no organization for the owner — the login reconcile has nothing to prove"
projected_ids=$(sldb "SELECT w.central_account_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = '$SL_USER_ID' AND m.origin = 'hub' AND m.is_active" | LC_ALL=C sort | paste -sd, -)
[ "$projected_ids" = "$hub_org_ids" ] || fail "the login reconcile projected '$projected_ids', the hub lists '$hub_org_ids'"
pass "login reconcile: the hub-origin memberships project exactly the hub's organizations for the user ($hub_org_ids)"

# ── Phase 3b — workspace creation through the hub (PRDCT-2443) ──────────────
say "Phase 3b — a signed-in person creates a workspace: an organization at the hub, as them"
# The deploy-order fact first (CLAUDE.md: THE HUB DEPLOYS FIRST). The hub's
# authorize endpoint validates every requested scope against the CLIENT's
# registered scopes, so a Slideless that requests a scope the hub does not
# list for it fails the WHOLE sign-in — recorded here with a scope no hub
# knows, on the same client, the same session and the same redirect URI the
# real sign-in used. The redirect is read, never followed: Slideless sees
# nothing of it.
unknown_scope_authz="$HUB/api/v1/auth/oauth2/authorize?response_type=code&client_id=$SL_CLIENT_ID&redirect_uri=$(printf '%s' "$SL/api/v1/auth/oauth2/callback/antasphere" | jq -sRr @uri)&scope=openid%20drill%3Aunknown-scope&state=drill-unknown-scope"
unknown_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/unknown-scope.out" -w '%{http_code} %{redirect_url}' "$unknown_scope_authz")
note "authorize with an unknown scope: $unknown_status"
case "$unknown_status" in
  *invalid_scope*) ;;
  *) grep -q invalid_scope "$SCRATCH/unknown-scope.out" \
    || fail "the hub did not refuse an unknown requested scope with invalid_scope: $unknown_status $(head -c 400 "$SCRATCH/unknown-scope.out")" ;;
esac
pass "deploy order: a sign-in requesting a scope the hub does not list for the client is refused whole (invalid_scope)"

# What the hub granted this login, and what the registry row allows — the
# facts a failed creation is diagnosed against.
grant_scopes=$(hubdb "SELECT array_to_string(scopes, ' ') FROM oauth_refresh_token WHERE client_id = '$SL_CLIENT_ID' AND user_id = '$HUB_USER_ID' AND revoked IS NULL")
client_scopes=$(hubdb "SELECT array_to_string(scopes, ' ') FROM oauth_client WHERE client_id = '$SL_CLIENT_ID'")
note "hub grant scopes: $grant_scopes"
note "registry client scopes: $client_scopes"
case " $grant_scopes " in
  *" orgs:create "*) ;;
  *) fail "the login's grant carries no orgs:create at the hub (grant='$grant_scopes', client='$client_scopes')" ;;
esac
pass "the login's hub grant carries orgs:create"

me_before=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/me-before.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$me_before" = 200 ] && jq -e '.canCreateWorkspace == true' "$SCRATCH/me-before.json" >/dev/null \
  || fail "GET /me before creation: $me_before $(cat "$SCRATCH/me-before.json")"
ws_before=$(jq -r '.workspaces | length' "$SCRATCH/me-before.json")
pass "GET /me: canCreateWorkspace is true ($ws_before workspace(s) listed before)"

create_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/ws-create.json" -w '%{http_code}' -X POST "$SL/api/v1/workspaces" \
  -H "Origin: $SL" -H 'content-type: application/json' -d '{"name":"Drill Workspace"}')
if [ "$create_status" != 201 ]; then
  echo "    hub-side diagnosis — grant scopes: '$grant_scopes'; client scopes: '$client_scopes'" >&2
  echo "    hub access tokens for the client: $(hubdb "SELECT count(*) || ' rows, scopes: ' || string_agg(array_to_string(scopes, ' '), ' | ') FROM oauth_access_token WHERE client_id = '$SL_CLIENT_ID' AND user_id = '$HUB_USER_ID'")" >&2
  fail "POST /workspaces answered $create_status (expected 201): $(cat "$SCRATCH/ws-create.json")"
fi
WS_ID=$(jq -r '.workspace.id // empty' "$SCRATCH/ws-create.json")
[ -n "$WS_ID" ] || fail "201 without a workspace id: $(cat "$SCRATCH/ws-create.json")"
jq -e '.workspace.name == "Drill Workspace"' "$SCRATCH/ws-create.json" >/dev/null || fail "201 with the wrong name: $(cat "$SCRATCH/ws-create.json")"
pass "POST /workspaces {name: Drill Workspace} → 201, local workspace $WS_ID"

me_after=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/me-after.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$me_after" = 200 ] || fail "GET /me after creation answered $me_after: $(cat "$SCRATCH/me-after.json")"
jq -e --arg id "$WS_ID" '.workspaces[] | select(.id == $id) | (.hubOrigin == true and .role == "owner" and .name == "Drill Workspace")' \
  "$SCRATCH/me-after.json" >/dev/null || fail "GET /me does not list $WS_ID as a hub-origin workspace owned by the caller: $(jq -c '.workspaces' "$SCRATCH/me-after.json")"
[ "$(jq -r '.workspaces | length' "$SCRATCH/me-after.json")" = "$((ws_before + 1))" ] \
  || fail "GET /me lists $(jq -r '.workspaces | length' "$SCRATCH/me-after.json") workspaces, expected $((ws_before + 1))"
pass "GET /me lists the new workspace: hubOrigin true, role owner"

members_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/members.json" -w '%{http_code}' -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/members")
[ "$members_status" = 200 ] || fail "GET /members in the new workspace answered $members_status: $(cat "$SCRATCH/members.json")"
jq -e --arg u "$SL_USER_ID" '.members[] | select(.userId == $u) | (.role == "owner" and .isActive == true)' "$SCRATCH/members.json" >/dev/null \
  || fail "the caller is not the active owner of $WS_ID: $(jq -c '.members' "$SCRATCH/members.json")"
[ "$(jq -r '.members | length' "$SCRATCH/members.json")" = 1 ] || fail "expected exactly one member, got $(jq -c '.members' "$SCRATCH/members.json")"
pass "a workspace-scoped read (X-Workspace-Id: $WS_ID, GET /members) → 200, the caller its only member, owner"

# The hub side, read AS THE USER through the hub session: the organization
# is theirs, and its genesis audit row names the tool client as the channel.
hub_orgs=$("${CURL[@]}" -b "$HUB_JAR" "$HUB/api/v1/orgs")
HUB_ORG_ID=$(echo "$hub_orgs" | jq -r '[.orgs[] | select(.name == "Drill Workspace" and .role == "owner")][0].id // empty')
[ -n "$HUB_ORG_ID" ] || fail "the hub does not list 'Drill Workspace' owned by the user: $hub_orgs"
projected=$(sldb "SELECT central_account_id FROM workspaces WHERE id = '$WS_ID'")
[ "$projected" = "$HUB_ORG_ID" ] || fail "the local workspace projects hub org '$projected', the hub says '$HUB_ORG_ID'"
pass "the hub lists the organization ($HUB_ORG_ID) for the user as owner, and the local workspace projects exactly it"
read -r audit_via audit_client audit_tool <<<"$(hubdb "SELECT actor_via || ' ' || coalesce(metadata->>'oauthClientId', '-') || ' ' || coalesce(metadata->>'viaTool', '-') FROM audit_log WHERE action = 'workspace.create' AND workspace_id = '$HUB_ORG_ID'")"
[ "$audit_via" = oauth ] && [ "$audit_client" = "$SL_CLIENT_ID" ] && [ "$audit_tool" = true ] \
  || fail "the hub's workspace.create row for $HUB_ORG_ID does not name the tool client: actor_via='$audit_via' oauthClientId='$audit_client' viaTool='$audit_tool'"
pass "the hub's audit log: workspace.create for $HUB_ORG_ID, actor_via oauth, oauthClientId $SL_CLIENT_ID"

# A machine credential never creates a workspace: an slk_ key minted in the
# new workspace by its owner is refused (POST /workspaces is unlisted in the
# fail-closed allowlist).
key_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/key.json" -w '%{http_code}' -X POST "$SL/api/v1/api-keys" \
  -H "Origin: $SL" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' \
  -d '{"name":"drill key","scopes":["presentations:read","presentations:write"]}')
[ "$key_status" = 201 ] || fail "minting an API key in the new workspace answered $key_status: $(cat "$SCRATCH/key.json")"
SLK=$(jq -r '.key' "$SCRATCH/key.json")
case "$SLK" in slk_*) ;; *) fail "the minted key does not carry the slk_ prefix" ;; esac
key_create=$("${CURL[@]}" -o "$SCRATCH/key-create.json" -w '%{http_code}' -X POST "$SL/api/v1/workspaces" \
  -H "Authorization: Bearer $SLK" -H 'content-type: application/json' -d '{"name":"Key Workspace"}')
[ "$key_create" = 403 ] || fail "POST /workspaces with an slk_ key answered $key_create (expected 403): $(cat "$SCRATCH/key-create.json")"
! grep -q '"workspace"' "$SCRATCH/key-create.json" || fail "the 403 carries a workspace: $(cat "$SCRATCH/key-create.json")"
pass "POST /workspaces with an slk_ key → 403 ($(jq -r '.error.code' "$SCRATCH/key-create.json"))"

# ── Phase 3c — decks in the hub-origin workspace, and the live reconcile ─────
say "Phase 3c — Slideless's own resource (decks) in the projected workspace, and the live reconcile"
# A deck is pushed the way the CLI pushes one (scripts/hostinger-smoke.mjs does
# the same three calls): the asset, an upload session, the commit with a
# one-line manifest. Metered: the asset (files.upload, bytes) and the commit
# (presentations.commit, one call); the upload session is not.
deck_push() { # label title curl-auth-args → pushes a one-file deck in the drill workspace; prints the new presentation id
  local label=$1 title=$2; shift 2
  local html="$SCRATCH/deck-$label.html"
  printf '<!doctype html><html><head><title>%s</title></head><body><h1>%s</h1></body></html>' "$title" "$label" >"$html"
  local sha size status session_id
  sha=$(openssl dgst -sha256 "$html" | sed 's/.*= //')
  size=$(wc -c <"$html" | tr -d ' ')
  status=$("${CURL[@]}" "$@" -o "$SCRATCH/deck-$label-asset.json" -w '%{http_code}' -X POST "$SL/api/v1/presentations/assets" \
    -H "X-Workspace-Id: $WS_ID" -F "file=@$html;type=text/html;filename=index.html" -F "sha256=$sha")
  [ "$status" = 201 ] || fail "deck push ($label): the asset upload answered $status: $(cat "$SCRATCH/deck-$label-asset.json")"
  status=$("${CURL[@]}" "$@" -o "$SCRATCH/deck-$label-session.json" -w '%{http_code}' -X POST "$SL/api/v1/presentations/uploads" \
    -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' -d '{}')
  [ "$status" = 201 ] || fail "deck push ($label): POST /presentations/uploads answered $status: $(cat "$SCRATCH/deck-$label-session.json")"
  session_id=$(jq -r '.uploadSession.id // empty' "$SCRATCH/deck-$label-session.json")
  [ -n "$session_id" ] || fail "deck push ($label): 201 without an upload session id: $(cat "$SCRATCH/deck-$label-session.json")"
  jq -nc --arg title "$title" --arg sha "$sha" --argjson size "$size" \
    '{title: $title, entryPath: "index.html", manifest: [{path: "index.html", sha256: $sha, sizeBytes: $size, contentType: "text/html"}]}' \
    >"$SCRATCH/deck-$label-commit-body.json"
  status=$("${CURL[@]}" "$@" -o "$SCRATCH/deck-$label-commit.json" -w '%{http_code}' -X POST "$SL/api/v1/presentations/uploads/$session_id/commit" \
    -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' -d @"$SCRATCH/deck-$label-commit-body.json")
  [ "$status" = 201 ] || fail "deck push ($label): the commit answered $status: $(cat "$SCRATCH/deck-$label-commit.json")"
  jq -e --arg t "$title" '(.presentation.id // "") != "" and .presentation.title == $t and .presentation.currentVersion == 1' \
    "$SCRATCH/deck-$label-commit.json" >/dev/null || fail "deck push ($label): the commit's answer is not the deck at version 1: $(cat "$SCRATCH/deck-$label-commit.json")"
  jq -r '.presentation.id' "$SCRATCH/deck-$label-commit.json"
}
DECK_ID=$(deck_push session "Drill session deck" -b "$SL_JAR" -H "Origin: $SL")
pass "the SSO session pushes a deck into the hub-origin workspace: asset, upload session, commit → 201 ($DECK_ID)"
list_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/decks-ws.json" -w '%{http_code}' -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations")
[ "$list_status" = 200 ] && jq -e --arg id "$DECK_ID" '[.presentations[].id] == [$id]' "$SCRATCH/decks-ws.json" >/dev/null \
  || fail "GET /presentations does not list exactly the pushed deck: $list_status $(cat "$SCRATCH/decks-ws.json")"
# Tenancy: the person's OTHER hub-origin workspace (the hub's genesis
# organization, projected at login) holds no deck.
OTHER_WS_ID=$(jq -r --arg id "$WS_ID" '[.workspaces[] | select(.id != $id)][0].id // empty' "$SCRATCH/me-after.json")
[ -n "$OTHER_WS_ID" ] || fail "GET /me lists no second workspace to read the deck from"
other_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/decks-other.json" -w '%{http_code}' -H "X-Workspace-Id: $OTHER_WS_ID" "$SL/api/v1/presentations")
[ "$other_status" = 200 ] && jq -e '.presentations == []' "$SCRATCH/decks-other.json" >/dev/null \
  || fail "the deck leaked into workspace $OTHER_WS_ID: $other_status $(cat "$SCRATCH/decks-other.json")"
pass "GET /presentations lists it back in $WS_ID and nothing in the person's other workspace ($OTHER_WS_ID)"
# The slk_ key minted above carries presentations:read + presentations:write:
# the scope allowlist opens the deck tree to it.
DECK_TITLE="Drill session deck, retitled by the slk_ key"
key_read=$("${CURL[@]}" -o "$SCRATCH/key-deck.json" -w '%{http_code}' -H "Authorization: Bearer $SLK" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations/$DECK_ID")
[ "$key_read" = 200 ] && jq -e --arg id "$DECK_ID" '.id == $id and .title == "Drill session deck"' "$SCRATCH/key-deck.json" >/dev/null \
  || fail "GET /presentations/$DECK_ID with the slk_ key answered $key_read: $(cat "$SCRATCH/key-deck.json")"
key_patch=$("${CURL[@]}" -o "$SCRATCH/key-patch.json" -w '%{http_code}' -X PATCH "$SL/api/v1/presentations/$DECK_ID" \
  -H "Authorization: Bearer $SLK" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' \
  -d "$(jq -nc --arg t "$DECK_TITLE" '{title: $t}')")
[ "$key_patch" = 200 ] && jq -e --arg id "$DECK_ID" --arg t "$DECK_TITLE" '.id == $id and .title == $t' "$SCRATCH/key-patch.json" >/dev/null \
  || fail "PATCH /presentations/$DECK_ID with the slk_ key answered $key_patch: $(cat "$SCRATCH/key-patch.json")"
pass "the slk_ key (presentations:read, presentations:write) reads the deck and retitles it"

# P7: the projected workspace's roster is the hub's. A local membership
# mutation is refused with the pointer; the read stays.
invite_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/invite.json" -w '%{http_code}' -X POST "$SL/api/v1/invitations" \
  -H "Origin: $SL" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' -d '{"email":"invitee@drill.test","role":"member"}')
[ "$invite_status" = 403 ] && jq -e --arg hub "$HUB" '.error.code == "hub_managed" and (.error.details.manageUrl | startswith($hub))' "$SCRATCH/invite.json" >/dev/null \
  || fail "POST /invitations in a hub-origin workspace answered $invite_status (expected 403 hub_managed + manageUrl at the hub): $(cat "$SCRATCH/invite.json")"
[ "$(sldb "SELECT count(*) FROM invitations WHERE workspace_id = '$WS_ID'")" = 0 ] || fail "the refused invitation left a row"
pass "POST /invitations in the hub-origin workspace → 403 hub_managed, manageUrl $(jq -r '.error.details.manageUrl' "$SCRATCH/invite.json"), no row"

# The live reconcile (ADR 019): an organization created AT THE HUB, outside
# Slideless, reaches the person's workspace list on the next demand past the
# ~10 s reconcile TTL — read as the user with the stored grant, no new login.
hub_org_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/hub-org.json" -w '%{http_code}' -X POST "$HUB/api/v1/orgs" \
  -H "Origin: $HUB" -H 'content-type: application/json' -d '{"name":"Hub-side Org"}')
[ "$hub_org_status" = 201 ] || fail "POST /orgs at the hub (session) answered $hub_org_status: $(cat "$SCRATCH/hub-org.json")"
[ "$(sldb "SELECT count(*) FROM workspaces WHERE name = 'Hub-side Org'")" = 0 ] || fail "'Hub-side Org' exists locally before any reconcile"
sleep 11
"${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/me-live.json" "$SL/api/v1/me"
jq -e '[.workspaces[] | select(.name == "Hub-side Org" and .hubOrigin == true and .role == "owner")] | length == 1' "$SCRATCH/me-live.json" >/dev/null \
  || fail "the live reconcile did not project 'Hub-side Org': $(jq -c '.workspaces // .' "$SCRATCH/me-live.json")"
[ "$(jq -r '.workspaces | length' "$SCRATCH/me-live.json")" = "$((ws_before + 2))" ] \
  || fail "GET /me lists $(jq -r '.workspaces | length' "$SCRATCH/me-live.json") workspaces, expected $((ws_before + 2))"
pass "live reconcile: an organization created at the hub is projected on the next demand past the TTL (hubOrigin, owner) — same session, no login"

# ── Phase 4 — AUTH-3: the provider grant is never handed out ────────────────
say "Phase 4 — AUTH-3: the provider-grant routes are closed on cloud"
for path in get-access-token refresh-token; do
  # PRDCT-1812: Better Auth's origin guard (origin trust, PRDCT-1377/1378)
  # runs BEFORE the provider-grant hook and answers MISSING_OR_NULL_ORIGIN to a
  # cookie-bearing POST without an Origin. Send the instance's own origin so
  # the request reaches the closure this leg exists to test.
  code=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/pg.json" -w '%{http_code}' -X POST "$SL/api/v1/auth/$path" \
    -H "Origin: $SL" -H 'content-type: application/json' -d '{"providerId":"antasphere"}')
  [ "$code" = 403 ] || fail "/auth/$path answered $code (expected 403)"
  grep -q provider_grant_forbidden "$SCRATCH/pg.json" || fail "/auth/$path 403 lacks provider_grant_forbidden"
  ! grep -qE 'accessToken|refreshToken|access_token' "$SCRATCH/pg.json" || fail "/auth/$path leaked token material"
done
pass "/auth/get-access-token and /auth/refresh-token answer 403 provider_grant_forbidden with no token material"

# ── Phase 4b — D1/P8: no non-hub credential entrance on cloud ────────────────
say "Phase 4b — every local credential entrance but the break-glass door is closed on cloud"
closed() { # label expected_status expected_marker path json_body
  local code
  code=$("${CURL[@]}" -o "$SCRATCH/closed.json" -w '%{http_code}' -X POST "$SL/api/v1$4" \
    -H "Origin: $SL" -H 'content-type: application/json' -d "$5")
  [ "$code" = "$2" ] || fail "$1: POST $4 answered $code (expected $2): $(head -c 300 "$SCRATCH/closed.json")"
  grep -q "$3" "$SCRATCH/closed.json" || fail "$1: POST $4 answered $2 without '$3': $(head -c 300 "$SCRATCH/closed.json")"
  ! grep -qE '"(token|key|url)"' "$SCRATCH/closed.json" || fail "$1: the refusal carries a credential or a redirect: $(head -c 300 "$SCRATCH/closed.json")"
}
otp_body="{\"email\":\"$OWNER_EMAIL\",\"otp\":\"000000\"}"
closed "CLI OTP mint, request leg" 403 cli_otp_disabled /cli/auth/request "{\"email\":\"$OWNER_EMAIL\"}"
closed "CLI OTP mint, complete leg" 403 cli_otp_disabled /cli/auth/complete "$otp_body"
pass "the tool's own CLI OTP mint answers 403 cli_otp_disabled on both legs (the cloud CLI door is /sso/cli-connect)"
closed "emailOTP sign-in" 403 otp_signin_disabled /auth/sign-in/email-otp "$otp_body"
closed "emailOTP send leg" 403 otp_signin_disabled /auth/email-otp/send-verification-otp "{\"email\":\"$OWNER_EMAIL\",\"type\":\"sign-in\"}"
closed "emailOTP verify-email" 403 otp_signin_disabled /auth/email-otp/verify-email "$otp_body"
pass "the emailOTP session surface answers 403 otp_signin_disabled (sign-in, send, verify-email)"
closed "password reset request" 403 'Password reset is disabled' /auth/request-password-reset "{\"email\":\"$OWNER_EMAIL\"}"
closed "password reset" 403 'Password reset is disabled' /auth/reset-password '{"newPassword":"drill-new-password-0001","token":"drill"}'
closed "emailOTP password reset" 403 'Password reset is disabled' /auth/email-otp/reset-password "{\"email\":\"$OWNER_EMAIL\",\"otp\":\"000000\",\"password\":\"drill-new-password-0001\"}"
pass "the password-reset surface answers 403 (request, reset, the emailOTP reset)"
closed "Google social sign-in" 404 PROVIDER_NOT_FOUND /auth/sign-in/social '{"provider":"google","callbackURL":"/"}'
pass "the Google social provider is not registered on cloud (404 PROVIDER_NOT_FOUND)"
mails=$("${CURL[@]}" "$MAIL/api/v1/search?query=$(printf 'to:%s' "$OWNER_EMAIL" | jq -sRr @uri)" | jq -r '.messages | length')
[ "$mails" = 0 ] || fail "a refused entrance still mailed the owner ($mails message(s) in Mailpit)"
pass "none of the refused entrances mailed a code (Mailpit holds nothing for $OWNER_EMAIL)"

# ── Phase 5 — CLOUD-2: the slow-but-alive hub ────────────────────────────────
say "Phase 5 — CLOUD-2: a refresh that times out AFTER the hub rotated"
# Expire the stored access token and clear the in-process cache (a restart),
# so the next authenticated request must refresh through the hop.
sldb "UPDATE account SET access_token_expires_at = now() - interval '1 hour' WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'" >/dev/null
dc restart app >/dev/null 2>&1
wait_ready app "$SL/healthz" 300
# Latency past Slideless's 5 s token timeout — the request still completes at the hub.
"${CURL[@]}" -f -o /dev/null -X POST "$HOP/latency" -H 'content-type: application/json' -d '{"ms":7000}'
t0=$(date +%s)
slow_status=$("${CURL[@]}" --max-time 40 -b "$SL_JAR" -o "$SCRATCH/slow.json" -w '%{http_code}' "$SL/api/v1/me")
elapsed=$(( $(date +%s) - t0 ))
note "GET /me during the slow window: $slow_status after ${elapsed}s"
"${CURL[@]}" -f -o /dev/null -X DELETE "$HOP/latency"
# Give the hub's side of the aborted request time to commit its rotation.
sleep 3
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 2 ] && [ "$fam_live" = 1 ] || fail "expected the hub to have rotated (2 rows, 1 live), got total=$fam_total live=$fam_live"
pass "the hub committed the rotation Slideless never heard about: family = 2 rows, 1 live"
presented=$(sldb "SELECT count(*) FROM hub_grant_presentations p JOIN account a ON a.id = p.account_id WHERE a.user_id = '$SL_USER_ID' AND p.refresh_token = a.refresh_token")
[ "$presented" = 1 ] || fail "Slideless holds no unanswered-presentation record for the token it presented (count=$presented)"
pass "Slideless recorded the presentation as unanswered (hub_grant_presentations)"
# The next demand: after the reconcile TTL, Slideless must PROBE, not re-present.
sleep 12
after_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/after.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$after_status" = 401 ] || fail "expected 401 hub_grant_expired after the probe, got $after_status: $(cat "$SCRATCH/after.json")"
grep -q hub_grant_expired "$SCRATCH/after.json" || fail "401 without hub_grant_expired: $(cat "$SCRATCH/after.json")"
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 2 ] && [ "$fam_live" = 1 ] || fail "the family was TORN DOWN at the hub (total=$fam_total live=$fam_live) — Slideless re-presented the rotated-out token"
dead=$(sldb "SELECT (refresh_token IS NULL)::int FROM account WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'")
[ "$dead" = 1 ] || fail "Slideless did not mark its grant dead"
probes=$(hubdb "SELECT count(*) FROM audit_log WHERE action = 'oidc.token' AND metadata->>'grantType' = 'refresh_token' AND resource_id = '$SL_CLIENT_ID'")
[ "$probes" = 1 ] || fail "expected exactly ONE refresh presentation in the hub's audit log for $SL_CLIENT_ID, saw $probes"
pass "the next demand PROBED: Slideless answers 401 hub_grant_expired, its grant is dead, and the hub family is intact (2 rows, 1 live, exactly one presentation audited)"

# ── Phase 6 — hub-side legs on the second registry tool ─────────────────────
say "Phase 6 — per-client audiences + post-rotation grace (second registry tool, own family)"
verifier=$(openssl rand -hex 32)
challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | b64url)
authz="$HUB/api/v1/auth/oauth2/authorize?response_type=code&client_id=$SECOND_CLIENT_ID&redirect_uri=$SECOND_REDIRECT&scope=openid%20offline_access%20account%3Aread&code_challenge=$challenge&code_challenge_method=S256&state=drill&resource=$SECOND_RESOURCE"
location=$("${CURL[@]}" -b "$HUB_JAR" -o /dev/null -w '%{redirect_url}' "$authz")
code=$(printf '%s' "$location" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$code" ] || fail "no code for the second tool: $location"
token() { # extra form fields...
  "${CURL[@]}" -o "$SCRATCH/token.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" \
    -u "$SECOND_CLIENT_ID:$SECOND_CLIENT_SECRET" -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "$@"
}
status=$(token "grant_type=authorization_code" --data-urlencode "code=$code" --data-urlencode "redirect_uri=$SECOND_REDIRECT" \
  --data-urlencode "code_verifier=$verifier" --data-urlencode "resource=$SL_RESOURCE")
[ "$status" = 400 ] && grep -q invalid_target "$SCRATCH/token.json" || fail "second tool minted (or was not refused with invalid_target) for Slideless's audience: $status $(cat "$SCRATCH/token.json")"
pass "per-client audiences: the second tool's code exchange for Slideless's /mcp answers 400 invalid_target"
status=$(token "grant_type=authorization_code" --data-urlencode "code=$code" --data-urlencode "redirect_uri=$SECOND_REDIRECT" \
  --data-urlencode "code_verifier=$verifier" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "second tool's own-audience exchange failed: $status $(cat "$SCRATCH/token.json")"
T0=$(jq -r '.refresh_token' "$SCRATCH/token.json")
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SL_RESOURCE")
[ "$status" = 400 ] && grep -q invalid_target "$SCRATCH/token.json" || fail "refresh into a foreign audience was not refused: $status"
pass "per-client audiences: the refresh grant is scoped the same way (400 invalid_target, token untouched)"
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "own-audience refresh failed: $status"
T1=$(jq -r '.refresh_token' "$SCRATCH/token.json")
read -r total live retired <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"
[ "$total" = 2 ] && [ "$live" = 1 ] || fail "after one rotation expected 2 rows / 1 live, got $total / $live"
# The timed-out client re-presents T0 seconds later.
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "post-rotation grace did not re-arm T0: $status $(cat "$SCRATCH/token.json")"
T2=$(jq -r '.refresh_token' "$SCRATCH/token.json")
read -r total live retired <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"
[ "$total" = 3 ] && [ "$live" = 1 ] && [ "$retired" = 1 ] || fail "after the grace expected 3 rows / 1 live / 1 retired-at-epoch, got $total / $live / $retired"
pass "post-rotation grace: T0 re-presented within the window → fresh pair; family = 3 rows, 1 live, the unused successor retired at the epoch"
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T2" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "the graced pair does not work: $status"
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T1" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 400 ] && grep -q invalid_grant "$SCRATCH/token.json" || fail "the retired successor was not refused: $status"
read -r total live retired <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"
[ "$total" = 0 ] || fail "presenting the retired successor should tear the family down; $total rows remain"
pass "the retired successor (a chase signature) tears the family down: 0 rows"
# The Slideless family was never touched by any of this.
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 2 ] && [ "$fam_live" = 1 ] || fail "the Slideless family changed during the second tool's legs (total=$fam_total live=$fam_live)"
pass "the Slideless user's family is untouched by the second tool's legs"

# ── Phase 7 — OIDC audit rows ────────────────────────────────────────────────
say "Phase 7 — the hub audited what the drill exercised"
for action in oidc.authorize oidc.token; do
  n=$(hubdb "SELECT count(*) FROM audit_log WHERE action = '$action' AND workspace_id IS NULL")
  [ "$n" -ge 1 ] || fail "no instance-attributed audit row for $action"
done
n=$(hubdb "SELECT count(*) FROM audit_log WHERE action = 'oidc.token' AND metadata->>'outcome' = 'error:invalid_target'")
[ "$n" -ge 2 ] || fail "expected ≥2 audited invalid_target refusals, saw $n"
n=$(hubdb "SELECT count(*) FROM audit_log WHERE action = 'oidc.token' AND (metadata->>'rotationGrace')::boolean")
[ "$n" = 1 ] || fail "expected exactly one audited rotation grace, saw $n"
pass "audit rows: oidc.authorize + oidc.token present, instance-attributed; the refusals and the grace are on the record"

# ── Phase 8 — CLI connect: one hub login, the tool's key without a second sign-in ──
say "Phase 8 — CLI connect (antasphere login → POST /sso/tool-token → POST /sso/cli-connect)"
# Rows of the CLI offline-grant family of (client, user) at the hub — the
# hub's own discriminator (platform/offline-grants.ts): the root the exchange
# stamped with the minting key, plus its session-less rotations without openid.
offline_family() { # client_id user_id
  hubdb "SELECT count(*) FROM oauth_refresh_token WHERE client_id = '$1' AND user_id = '$2' AND (api_key_id IS NOT NULL OR (session_id IS NULL AND 'offline_access' = ANY(scopes) AND NOT 'openid' = ANY(scopes)))"
}
# What `antasphere login` does, headless: the hub mails a code, the code buys
# the person's ACCOUNT key (sso:exchange). The code is read from Mailpit.
otp_req=$("${CURL[@]}" -o "$SCRATCH/otp-req.json" -w '%{http_code}' -X POST "$HUB/api/v1/cli/auth/request" \
  -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\"}")
[ "$otp_req" = 200 ] || fail "the hub's POST /cli/auth/request answered $otp_req: $(cat "$SCRATCH/otp-req.json")"
OTP=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  OTP=$("${CURL[@]}" "$MAIL/api/v1/search?query=$(printf 'to:%s' "$OWNER_EMAIL" | jq -sRr @uri)" \
    | jq -r '.messages[0].Subject // ""' | sed -n 's/^\([0-9]\{4,10\}\) .*/\1/p')
  [ -n "$OTP" ] && break
  sleep 1
done
[ -n "$OTP" ] || fail "no sign-in code for $OWNER_EMAIL reached Mailpit ($MAIL)"
hubkey_status=$("${CURL[@]}" -o "$SCRATCH/hub-key.json" -w '%{http_code}' -X POST "$HUB/api/v1/cli/auth/complete" \
  -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"otp\":\"$OTP\",\"keyName\":\"drill cli\"}")
[ "$hubkey_status" = 201 ] || fail "the hub's POST /cli/auth/complete answered $hubkey_status: $(jq -c '.error // .' "$SCRATCH/hub-key.json")"
HUB_KEY=$(jq -r '.key' "$SCRATCH/hub-key.json")
jq -e '.apiKey.scopes | index("sso:exchange")' "$SCRATCH/hub-key.json" >/dev/null || fail "the hub CLI key carries no sso:exchange: $(jq -c '.apiKey.scopes' "$SCRATCH/hub-key.json")"
pass "hub CLI login (emailed code from Mailpit) → an account key carrying sso:exchange"

tt_status=$("${CURL[@]}" -o "$SCRATCH/tool-token.json" -w '%{http_code}' -X POST "$HUB/api/v1/sso/tool-token" \
  -H "Authorization: Bearer $HUB_KEY" -H 'content-type: application/json' -d "{\"resource\":\"$SL_RESOURCE\"}")
[ "$tt_status" = 200 ] || fail "POST /sso/tool-token answered $tt_status: $(jq -c '.error // .' "$SCRATCH/tool-token.json")"
jq -e '(.token | length > 0) and (.hubRefreshToken | length > 0)' "$SCRATCH/tool-token.json" >/dev/null || fail "the exchange answered no token pair"
[ "$(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")" = 1 ] || fail "expected one offline-grant row at the hub after the exchange, got $(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")"
pass "POST /sso/tool-token (resource $SL_RESOURCE) → a 120 s exchange token + the offline grant (one row at the hub)"

# The browser session is still the one Phase 5 left: its grant is dead.
"${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/pre-connect.json" "$SL/api/v1/me"
grep -q hub_grant_expired "$SCRATCH/pre-connect.json" || fail "expected the browser session to still answer hub_grant_expired before the connect: $(cat "$SCRATCH/pre-connect.json")"
jq '{token, hubRefreshToken}' "$SCRATCH/tool-token.json" >"$SCRATCH/connect-body.json"
connect_status=$("${CURL[@]}" -o "$SCRATCH/connect.json" -w '%{http_code}' -X POST "$SL/api/v1/sso/cli-connect" \
  -H 'content-type: application/json' -d @"$SCRATCH/connect-body.json")
[ "$connect_status" = 201 ] || fail "POST /sso/cli-connect answered $connect_status: $(jq -c '.error // .' "$SCRATCH/connect.json")"
CLI_KEY=$(jq -r '.key' "$SCRATCH/connect.json")
CLI_KEY_ID=$(jq -r '.apiKey.id' "$SCRATCH/connect.json")
case "$CLI_KEY" in slk_*) ;; *) fail "the connect minted no slk_ key" ;; esac
jq -e --arg e "$OWNER_EMAIL" --arg u "$SL_USER_ID" \
  '.user.email == $e and .user.id == $u and .apiKey.workspaceId == null and .workspaceId == null and (.apiKey.scopes | sort) == ["presentations:read", "presentations:write"]' \
  "$SCRATCH/connect.json" >/dev/null || fail "the connect's key is not the SAME user's unpinned presentations key: $(jq -c '{user, apiKey}' "$SCRATCH/connect.json")"
pass "POST /sso/cli-connect → 201: a user-scoped slk_ key (no workspace pin; presentations:read + presentations:write, never data:export) for the same local user as the browser login"
audit_via=$(sldb "SELECT metadata->>'via' || ' ' || (metadata->>'grantChannel') FROM audit_log WHERE action = 'apikey.create' AND resource_id = '$CLI_KEY_ID'")
[ "$audit_via" = "sso_cli_connect h3_exchange" ] || fail "the connect's apikey.create audit row reads '$audit_via'"
pass "the tool's audit log: apikey.create via sso_cli_connect, grant channel h3_exchange"

replay_status=$("${CURL[@]}" -o "$SCRATCH/connect-replay.json" -w '%{http_code}' -X POST "$SL/api/v1/sso/cli-connect" \
  -H 'content-type: application/json' -d @"$SCRATCH/connect-body.json")
[ "$replay_status" = 401 ] && jq -e '.error.code == "invalid_token" and (has("key") | not)' "$SCRATCH/connect-replay.json" >/dev/null \
  || fail "the replayed exchange token answered $replay_status: $(cat "$SCRATCH/connect-replay.json")"
[ "$(sldb "SELECT count(*) FROM api_keys WHERE created_by = '$SL_USER_ID' AND name LIKE 'Antasphere CLI %'")" = 1 ] || fail "the replay minted a second CLI key"
pass "the same exchange token a second time → 401 invalid_token, no second key (the jti is one-time-use)"

# The key works in the workspace the request names, on the tool's resource:
# it reads the deck the session pushed (with the slk_ key's title) and pushes one.
cli_read=$("${CURL[@]}" -o "$SCRATCH/cli-decks.json" -w '%{http_code}' -H "Authorization: Bearer $CLI_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations")
[ "$cli_read" = 200 ] && jq -e --arg id "$DECK_ID" --arg t "$DECK_TITLE" '[.presentations[].id] == [$id] and .presentations[0].title == $t' "$SCRATCH/cli-decks.json" >/dev/null \
  || fail "GET /presentations with the CLI key answered $cli_read: $(cat "$SCRATCH/cli-decks.json")"
CLI_DECK_ID=$(deck_push cli "Drill CLI deck" -H "Authorization: Bearer $CLI_KEY")
cli_members=$("${CURL[@]}" -o "$SCRATCH/cli-members.json" -w '%{http_code}' -H "Authorization: Bearer $CLI_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/members")
[ "$cli_members" = 403 ] || fail "GET /members with the CLI key answered $cli_members (expected 403: outside the key's scopes' allowlist)"
pass "the CLI key reads the session's deck in $WS_ID (X-Workspace-Id), pushes one ($CLI_DECK_ID), and is refused outside the deck tree (GET /members → 403 $(jq -r '.error.code' "$SCRATCH/cli-members.json"))"

# The connect stored the exchange's offline grant on the account row: the
# browser session Phase 5 left dead is healed without a browser.
healed=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/healed.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$healed" = 200 ] && jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' "$SCRATCH/healed.json" >/dev/null \
  || fail "the browser session after the connect answered $healed: $(cat "$SCRATCH/healed.json")"
jq -e --arg id "$WS_ID" '.workspaces[] | select(.id == $id)' "$SCRATCH/healed.json" >/dev/null \
  || fail "the healed session does not list the drill workspace $WS_ID: $(jq -c '.workspaces' "$SCRATCH/healed.json")"
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
note "hub rows for ($SL_CLIENT_ID, user) after the connect: total=$fam_total live=$fam_live, of which offline family=$(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")"
pass "the connect's grant replaced the dead one: the browser session answers 200 again and lists the drill workspace"

# ── Phase 8b — the billing rail, phase 1 (PRDCT-2625 + PRDCT-2626) ─────────
say "Phase 8b — one metered action per surface lands in the hub's usage_events, exactly once"
# The legs before this one metered decks already (Phase 3c: one push by the
# session; Phase 8: one by the CLI key, an asset and a commit each) and their
# events may still be in flight: the baseline below is taken on a drained
# queue, and every figure is a DELTA over it.
drain_usage() { # label → waits up to 60 s for the usage queue to empty
  local i pending=0
  for i in $(seq 1 60); do
    pending=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state NOT IN ('completed', 'failed', 'cancelled')")
    [ "$pending" = 0 ] && return 0
    sleep 1
  done
  fail "the usage queue did not drain in 60 s $1 ($pending pending); is the poster reaching the hub?"
}
hub_events() { hubdb "SELECT count(*) FROM usage_events"; }

drain_usage "before the first leg's baseline"
jobs_before=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events'")
before_rows=$(hub_events)
leg_start=$(sldb "SELECT now()")
metered() { # label file-content → uploads one asset in the drill workspace with the given curl auth args; prints sizeBytes
  local label=$1 content=$2; shift 2
  printf '%s' "$content" > "$SCRATCH/asset-$label.txt"
  local sha; sha=$(openssl dgst -sha256 "$SCRATCH/asset-$label.txt" | sed 's/.*= //')
  local status
  status=$("${CURL[@]}" "$@" -o "$SCRATCH/asset-$label.json" -w '%{http_code}' -X POST "$SL/api/v1/presentations/assets" \
    -H "X-Workspace-Id: $WS_ID" -F "file=@$SCRATCH/asset-$label.txt;type=text/plain" -F "sha256=$sha")
  [ "$status" = 201 ] || fail "asset upload ($label) answered $status: $(cat "$SCRATCH/asset-$label.json")"
  jq -r '.sizeBytes' "$SCRATCH/asset-$label.json"
}
# 1. the dashboard: the browser session.
SESSION_BYTES=$(metered session "drill: uploaded from the dashboard session" -b "$SL_JAR" -H "Origin: $SL")
# 2. the CLI: the slk_ key Phase 3b minted in the drill workspace.
KEY_BYTES=$(metered api_key "drill: uploaded with an slk_ key, the CLI's credential" -H "Authorization: Bearer $SLK")
# 3. an agent: an OAuth bearer from Slideless's OWN authorization server
#    (dynamic registration + PKCE + consent, the MCP connector's dance), then
#    the MCP endpoint itself creates a deck (one upload + one commit).
mcp_redirect='http://127.0.0.1:19999/callback'
register=$("${CURL[@]}" -X POST "$SL/api/v1/auth/oauth2/register" -H 'content-type: application/json' \
  -d "{\"client_name\":\"drill-mcp\",\"redirect_uris\":[\"$mcp_redirect\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"]}")
MCP_CLIENT=$(echo "$register" | jq -r '.client_id // empty')
[ -n "$MCP_CLIENT" ] || fail "dynamic registration at Slideless failed: $register"
mcp_verifier=$(openssl rand -hex 32)
mcp_challenge=$(printf '%s' "$mcp_verifier" | openssl dgst -sha256 -binary | b64url)
mcp_scope=$("${CURL[@]}" "$SL/.well-known/oauth-authorization-server" | jq -r '.scopes_supported | join(" ")')
mcp_authz="$SL/api/v1/auth/oauth2/authorize?response_type=code&client_id=$MCP_CLIENT&redirect_uri=$(printf '%s' "$mcp_redirect" | jq -sRr @uri)&scope=$(printf '%s' "$mcp_scope" | jq -sRr @uri)&state=drill-mcp&code_challenge=$mcp_challenge&code_challenge_method=S256&resource=$(printf '%s' "$SL/mcp" | jq -sRr @uri)"
consent_url=$("${CURL[@]}" -b "$SL_JAR" -o /dev/null -w '%{redirect_url}' "$mcp_authz")
case "$consent_url" in
  *"/oauth/consent?"*)
    consent=$("${CURL[@]}" -b "$SL_JAR" -X POST "$SL/api/v1/auth/oauth2/consent" -H 'content-type: application/json' -H "Origin: $SL" \
      -d "{\"accept\":true,\"oauth_query\":\"${consent_url#*consent?}\"}")
    code_url=$(echo "$consent" | jq -r '.url // .redirect_uri // empty') ;;
  *) code_url=$consent_url ;;
esac
mcp_code=$(printf '%s' "$code_url" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$mcp_code" ] || fail "no authorization code for the MCP client: $consent_url"
"${CURL[@]}" -o "$SCRATCH/mcp-token.json" -f -X POST "$SL/api/v1/auth/oauth2/token" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code --data-urlencode "code=$mcp_code" --data-urlencode "redirect_uri=$mcp_redirect" \
  --data-urlencode "client_id=$MCP_CLIENT" --data-urlencode "code_verifier=$mcp_verifier" --data-urlencode "resource=$SL/mcp" \
  || fail "the MCP client's token exchange failed"
MCP_BEARER=$(jq -r '.access_token' "$SCRATCH/mcp-token.json")
mcp_html='<!doctype html><html><head><title>Drill MCP deck</title></head><body><h1>Drill</h1></body></html>'
mcp_call=$(jq -nc --arg ws "$WS_ID" --arg html "$mcp_html" \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"slideless_upload_html_presentation",arguments:{workspace:$ws,title:"Drill MCP deck",html:$html}}}')
mcp_answer=$("${CURL[@]}" -X POST "$SL/mcp" -H "Authorization: Bearer $MCP_BEARER" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$mcp_call")
echo "$mcp_answer" | jq -e '.result.isError != true and (.result.content[0].text | test("\"presentation\""))' >/dev/null \
  || fail "the MCP deck creation failed: $(echo "$mcp_answer" | head -c 400)"
MCP_BYTES=$(printf '%s' "$mcp_html" | wc -c | tr -d ' ')
pass "one metered action per surface: the dashboard session ($SESSION_BYTES bytes), the slk_ key ($KEY_BYTES bytes), an OAuth bearer over MCP ($MCP_BYTES bytes + one commit)"

# ── Leg 9 — the deck's picture on the cloud edition (PRDCT-2785) ─────────────
# The deck the agent just pushed is handed to the renderer by the cloud edition;
# its still image comes back through the one-time key, and the dashboard's read
# route serves it. A renderer that never turned ready (its boot self-check exits 3
# when Chromium's sandbox cannot start) leaves the route on thumbnail_pending.
MCP_DECK=$(echo "$mcp_answer" | jq -r '.result.content[0].text | fromjson | .presentation.id // empty')
[ -n "$MCP_DECK" ] || fail "the MCP answer names no presentation id: $(echo "$mcp_answer" | head -c 300)"
thumb_status=""
for i in $(seq 1 60); do
  thumb_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/thumb.webp" -w '%{http_code}' \
    -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations/$MCP_DECK/versions/1/thumbnail")
  [ "$thumb_status" = 200 ] && break
  sleep 1
done
[ "$thumb_status" = 200 ] || fail "the deck's picture never came (last answer $thumb_status): $(applogs renderer | tail -5)"
[ "$(head -c 4 "$SCRATCH/thumb.webp")" = RIFF ] && [ "$(dd if="$SCRATCH/thumb.webp" bs=1 skip=8 count=4 2>/dev/null)" = WEBP ] \
  || fail "the thumbnail route answered 200 with something that is not a WebP"
pass "the agent's deck got its picture on the cloud edition: a $(wc -c < "$SCRATCH/thumb.webp" | tr -d ' ')-byte WebP after ${i} s"

# What the gate queued in this leg, exactly: 3 uploads + 1 commit (the poster
# drains this queue to the hub).
jobs_after=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events'")
[ "$((jobs_after - jobs_before))" = 4 ] || fail "expected exactly 4 new usage jobs (3 uploads + 1 commit), the queue grew by $((jobs_after - jobs_before))"
drain_usage "after the first leg's actions"
failed=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state = 'failed'")
[ "$failed" = 0 ] || fail "$failed usage job(s) FAILED at the poster: $(applogs app | grep -i 'usage poster' | tail -3)"
pass "the poster drained the queue to the hub (4 new events, none failed)"

# The hub's side: every event of this leg landed, attributed to the projected
# organization, the hub user, the right channel, the right action and size.
landed=$(hub_events)
[ "$landed" = "$((before_rows + 4))" ] \
  || fail "the hub holds $landed events, expected $((before_rows + 4)); the poster's log: $(applogs app | grep -i 'usage poster' | tail -3 | cut -c1-300); the hub's: $(hubdb "SELECT metadata::text FROM audit_log WHERE action = 'usage.ingest' ORDER BY created_at DESC LIMIT 2")"
LEG_IDS=$(sldb "SELECT string_agg(quote_literal(data->>'id'), ',') FROM pgboss.job WHERE name = 'usage-events' AND created_on >= '$leg_start'")
[ -n "$LEG_IDS" ] || fail "no usage job of this leg in the queue"
TOOL_SLUG=$(hubdb "SELECT metadata->'tool'->>'slug' FROM oauth_client WHERE client_id = '$SL_CLIENT_ID'")
row() { hubdb "SELECT count(*) FROM usage_events WHERE id IN ($LEG_IDS) AND via = '$1' AND action_key = '$2' AND quantity = $3 AND user_id = '$HUB_USER_ID' AND tool_slug = '$TOOL_SLUG' AND workspace_id = '$WS_ID'"; }
[ "$(row session files.upload "$SESSION_BYTES")" = 1 ] || fail "no session row for files.upload of $SESSION_BYTES bytes by $HUB_USER_ID"
[ "$(row api_key files.upload "$KEY_BYTES")" = 1 ] || fail "no api_key row for files.upload of $KEY_BYTES bytes by $HUB_USER_ID"
[ "$(row oauth files.upload "$MCP_BYTES")" = 1 ] || fail "no oauth row for files.upload of $MCP_BYTES bytes by $HUB_USER_ID"
[ "$(row oauth presentations.commit 1)" = 1 ] || fail "no oauth row for presentations.commit by $HUB_USER_ID"
pass "usage_events: session / api_key / oauth, files.upload $SESSION_BYTES / $KEY_BYTES / $MCP_BYTES bytes + presentations.commit 1 call, user $HUB_USER_ID, workspace $WS_ID, the registry slug $TOOL_SLUG"

# At-least-once from the tool, exactly once at the hub: every event the tool
# ever queued, posted again by hand with its own machine token, answers duplicate.
machine=$("${CURL[@]}" -o "$SCRATCH/machine.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" \
  -u "$SL_CLIENT_ID:$SL_CLIENT_SECRET" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials --data-urlencode scope=usage:write --data-urlencode "resource=$HUB/mcp")
[ "$machine" = 200 ] || fail "the tool's client_credentials mint answered $machine: $(cat "$SCRATCH/machine.json")"
MACHINE_TOKEN=$(jq -r '.access_token' "$SCRATCH/machine.json")
sldb "SELECT json_agg(data)::text FROM pgboss.job WHERE name = 'usage-events'" | jq '{events: .}' >"$SCRATCH/replay-events.json"
all_jobs=$(jq -r '.events | length' "$SCRATCH/replay-events.json")
"${CURL[@]}" -o "$SCRATCH/replay-answer.json" -f -X POST "$HUB/api/v1/usage/events" -H "Authorization: Bearer $MACHINE_TOKEN" \
  -H 'content-type: application/json' -d @"$SCRATCH/replay-events.json" || fail "the hand replay of the batch failed: $(cat "$SCRATCH/replay-answer.json")"
jq -e --argjson n "$all_jobs" '.duplicate == $n and .accepted == 0 and .rejected == 0' "$SCRATCH/replay-answer.json" >/dev/null \
  || fail "the replay should answer duplicate for all $all_jobs: $(cat "$SCRATCH/replay-answer.json")"
[ "$(hub_events)" = "$landed" ] || fail "the replay wrote rows"
pass "every queued event posted again with the tool's machine token: $all_jobs duplicate, 0 accepted, no new row"

# The organization's owner reads the consumption per person.
org_events=$(hubdb "SELECT count(*) FROM usage_events WHERE account_id = (SELECT central_account_id FROM workspaces WHERE id = '$HUB_ORG_ID')")
usage=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/billing-usage.json" -w '%{http_code}' -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/usage")
[ "$usage" = 200 ] || fail "GET /billing/usage as the owner answered $usage: $(cat "$SCRATCH/billing-usage.json")"
jq -e --arg u "$HUB_USER_ID" --argjson n "$org_events" '.byUser | length == 1 and .[0].userId == $u and .[0].events == $n' "$SCRATCH/billing-usage.json" >/dev/null \
  || fail "the per-person view does not show $org_events events for $HUB_USER_ID: $(jq -c '.byUser' "$SCRATCH/billing-usage.json")"
pass "GET /billing/usage as the owner: one person, $HUB_USER_ID, $org_events events (the hub's count for the organization's account)"

# ── Phase 8b, second leg — the billing rail, phase 2 (PRDCT-2663 + PRDCT-2664) ──
say "Phase 8b — phase 2: the hub prices, the chassis asks before an action and refuses on the balance, the debit lands"
SL_METRICS_TOKEN=federation-dev-metrics-token-0001 # the drill overlay's
idem() { printf 'Idempotency-Key: drill-%s' "$(openssl rand -hex 8)"; }
metrics() { "${CURL[@]}" -f -H "Authorization: Bearer $SL_METRICS_TOKEN" "$SL/metrics"; }

# Staff seeds the price book and the plan entitlements from Slideless's own
# discovery. The hub owner is on SUPERADMIN_EMAILS in the drill overlay, and
# the price book was EMPTY until now, as on production (BILLING_SEED_TOOLS_AT_BOOT
# off): the first leg's events were priced 0 and debited nothing.
seed_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/seed.json" -w '%{http_code}' -X POST "$HUB/api/v1/admin/billing/prices/seed" \
  -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d '{"toolSlug":"slideless-cloud"}')
if [ "$seed_status" = 404 ]; then
  # A hub without phase 2 (hub 0.10.0 and before) has no price book: the
  # chassis fails open on its 404 and meters as phase 1 did. The leg needs
  # the hub of PRDCT-2663; the hub deploys first, and this run says so.
  note "the hub answers 404 on POST /admin/billing/prices/seed: no phase 2 on this hub — the second leg is skipped"
  pass "second leg skipped: this hub carries no price book (deploy the hub of PRDCT-2663 first)"
else
[ "$seed_status" = 200 ] || fail "POST /admin/billing/prices/seed as the hub owner (staff) answered $seed_status: $(cat "$SCRATCH/seed.json")"
jq -e '.tools[] | select(.toolSlug == "slideless-cloud") | .ok == true' "$SCRATCH/seed.json" >/dev/null \
  || fail "the seed did not read Slideless's discovery: $(cat "$SCRATCH/seed.json")"
prices_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/prices.json" -w '%{http_code}' "$HUB/api/v1/admin/billing/prices?toolSlug=slideless-cloud")
[ "$prices_status" = 200 ] || fail "GET /admin/billing/prices answered $prices_status: $(cat "$SCRATCH/prices.json")"
jq -e '[.prices[] | select(.actionKey == "files.upload")] | length == 1 and .[0].creditsPerUnit == 5 and .[0].per == 1048576' "$SCRATCH/prices.json" >/dev/null \
  || fail "the price book does not carry files.upload at 5 credits per 1,048,576 bytes: $(jq -c '.prices' "$SCRATCH/prices.json")"
n_prices=$(jq -r '.prices | length' "$SCRATCH/prices.json")
[ "$n_prices" -ge 5 ] || fail "expected at least the five declared prices, the book holds $n_prices"
seed2=$("${CURL[@]}" -b "$HUB_JAR" -X POST "$HUB/api/v1/admin/billing/prices/seed" -H "Origin: $HUB" -H "$(idem)" \
  -H 'content-type: application/json' -d '{"toolSlug":"slideless-cloud"}')
echo "$seed2" | jq -e '.inserted == 0' >/dev/null || fail "a second seed inserted rows: $seed2"
pass "staff seeded the price book from Slideless's discovery ($n_prices prices; files.upload 5 credits per 1,048,576 bytes); a second seed inserted nothing"

# The organization's account holds the sign-up grant.
acct=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/account.json" -w '%{http_code}' -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/account")
[ "$acct" = 200 ] || fail "GET /billing/account as the owner answered $acct: $(cat "$SCRATCH/account.json")"
ACCOUNT_ID=$(jq -r '.accountId // empty' "$SCRATCH/account.json")
[ -n "$ACCOUNT_ID" ] && jq -e '.balance == 5000 and .plan == "free"' "$SCRATCH/account.json" >/dev/null \
  || fail "the account should hold the 5,000 sign-up grant on the free plan: $(cat "$SCRATCH/account.json")"
pass "GET /billing/account: account $ACCOUNT_ID, balance 5000 (the sign-up grant), plan free"

# The check by hand, with the tool's machine token: priced, allowed, the top-up link on the answer.
check=$("${CURL[@]}" -o "$SCRATCH/check.json" -w '%{http_code}' -X POST "$HUB/api/v1/usage/check" -H "Authorization: Bearer $MACHINE_TOKEN" \
  -H 'content-type: application/json' -d "{\"accountRef\":\"$HUB_ORG_ID\",\"actionKey\":\"files.upload\",\"quantity\":1048576}")
[ "$check" = 200 ] || fail "POST /usage/check answered $check: $(cat "$SCRATCH/check.json")"
jq -e --arg top "$HUB/billing/top-up?org=$HUB_ORG_ID" \
  '.allowed == true and .credits == 5 and .balance == 5000 and .priced == true and .reason == null and (.topUpUrl | startswith($top))' "$SCRATCH/check.json" >/dev/null \
  || fail "the check's answer is not the contract's: $(cat "$SCRATCH/check.json")"
pass "POST /usage/check with the machine token: a 1 MiB upload is 5 credits, allowed, balance 5000, the top-up link names the organization"

# Staff drives the balance to zero: a negative manual grant, the reason on the ledger.
grant=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/grant.json" -w '%{http_code}' -X POST "$HUB/api/v1/admin/billing/accounts/$ACCOUNT_ID/grant" \
  -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d '{"credits":-5000,"reason":"drill: exhaust the balance"}')
[ "$grant" = 201 ] && jq -e '.balance == 0' "$SCRATCH/grant.json" >/dev/null || fail "the negative grant answered $grant: $(cat "$SCRATCH/grant.json")"
pass "staff grant of -5000 with a reason: balance 0"

# One action per surface refused 402 with the top-up link. The chassis
# caches an ALLOWED answer for 30 s and serves it to any smaller or equal
# quantity of the same action, so these uploads are LARGER than the first
# leg's (2 KiB against a few dozen bytes): a larger quantity asks the hub.
BIG=$(head -c 2048 /dev/zero | tr '\0' 'x')
refused() { # label content curl-auth-args → asserts 402 entitlement_denied with the details
  local label=$1 content=$2; shift 2
  printf '%s' "$content" > "$SCRATCH/refused-$label.txt"
  local sha; sha=$(openssl dgst -sha256 "$SCRATCH/refused-$label.txt" | sed 's/.*= //')
  local status
  status=$("${CURL[@]}" "$@" -o "$SCRATCH/refused-$label.json" -w '%{http_code}' -X POST "$SL/api/v1/presentations/assets" \
    -H "X-Workspace-Id: $WS_ID" -F "file=@$SCRATCH/refused-$label.txt;type=text/plain" -F "sha256=$sha")
  [ "$status" = 402 ] || fail "asset upload ($label) with an empty balance answered $status, expected 402: $(cat "$SCRATCH/refused-$label.json")"
  jq -e --arg top "$HUB/billing/top-up?org=$HUB_ORG_ID" \
    '.error.code == "entitlement_denied" and .error.details.credits == 5 and .error.details.balance == 0 and (.error.details.topUpUrl | startswith($top))' \
    "$SCRATCH/refused-$label.json" >/dev/null || fail "the 402 ($label) does not carry the details: $(cat "$SCRATCH/refused-$label.json")"
}
refused session "$BIG" -b "$SL_JAR" -H "Origin: $SL"
refused api_key "$BIG" -H "Authorization: Bearer $SLK"
mcp_big=$(jq -nc --arg ws "$WS_ID" --arg html "<!doctype html><html><head><title>Drill refused</title></head><body>$BIG</body></html>" \
  '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"slideless_upload_html_presentation",arguments:{workspace:$ws,title:"Drill refused deck",html:$html}}}')
mcp_refused=$("${CURL[@]}" -X POST "$SL/mcp" -H "Authorization: Bearer $MCP_BEARER" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$mcp_big")
# The gate's own message carries the link ("top up at <url>"); the MCP text adds
# no second sentence (verifier round 1), so the link is there exactly once.
echo "$mcp_refused" | jq -e --arg top "top up at $HUB/billing/top-up?org=$HUB_ORG_ID" \
  '.result.isError == true and (.result.content[0].text | (test("entitlement_denied") and contains($top)))' >/dev/null \
  || fail "the MCP tool result does not carry the refusal and the top-up link: $(echo "$mcp_refused" | head -c 500)"
pass "with the balance at 0, one action per surface answers 402 entitlement_denied with the top-up link: the dashboard session, the slk_ key, the MCP tool's text"
before_refused=$(hubdb "SELECT count(*) FROM usage_events")

# The balance restored: a denial is cached five seconds, so the same action
# lands after the hold, the hub prices it, and its debit is on the ledger.
grant=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/grant2.json" -w '%{http_code}' -X POST "$HUB/api/v1/admin/billing/accounts/$ACCOUNT_ID/grant" \
  -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d '{"credits":5000,"reason":"drill: restore the balance"}')
[ "$grant" = 201 ] && jq -e '.balance == 5000' "$SCRATCH/grant2.json" >/dev/null || fail "the restoring grant answered $grant: $(cat "$SCRATCH/grant2.json")"
sleep 6
LANDED_BYTES=$(metered landed "$BIG" -b "$SL_JAR" -H "Origin: $SL")
for i in $(seq 1 60); do
  pending=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state NOT IN ('completed', 'failed', 'cancelled')")
  [ "$pending" = 0 ] && break
  sleep 1
done
[ "$pending" = 0 ] || fail "the usage queue did not drain after the restored upload ($pending pending)"
LANDED_EVENT=$(sldb "SELECT data->>'id' FROM pgboss.job WHERE name = 'usage-events' AND (data->>'quantity')::int = $LANDED_BYTES AND data->>'via' = 'session' ORDER BY created_on DESC LIMIT 1")
[ -n "$LANDED_EVENT" ] || fail "no queued event of $LANDED_BYTES bytes via session"
[ "$(hubdb "SELECT count(*) FROM usage_events")" = "$((before_refused + 1))" ] \
  || fail "the refused actions must write no event and the landed one exactly one (before $before_refused, now $(hubdb "SELECT count(*) FROM usage_events"))"
[ "$(hubdb "SELECT credits FROM usage_events WHERE id = '$LANDED_EVENT'")" = 5 ] || fail "the landed event was not priced 5 credits at the hub"
ledger=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/ledger.json" -w '%{http_code}' -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/ledger?kind=debit")
[ "$ledger" = 200 ] || fail "GET /billing/ledger answered $ledger: $(cat "$SCRATCH/ledger.json")"
jq -e --arg id "$LANDED_EVENT" '[.entries[] | select(.sourceRef == $id)] | length == 1 and .[0].amount == -5 and .[0].kind == "debit"' "$SCRATCH/ledger.json" >/dev/null \
  || fail "the ledger holds no debit of 5 for event $LANDED_EVENT: $(jq -c '.entries' "$SCRATCH/ledger.json")"
"${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/account2.json" -f -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/account" || fail "GET /billing/account failed after the debit"
jq -e '.balance == 4995' "$SCRATCH/account2.json" >/dev/null || fail "the balance should read 4995 after one 5-credit debit: $(cat "$SCRATCH/account2.json")"
pass "balance restored: the same upload lands ($LANDED_BYTES bytes, event $LANDED_EVENT), priced 5 credits at the hub, its debit on GET /billing/ledger, the balance 4995; the refusals wrote nothing"

# The hub slow beyond the check's budget: the action still lands (fail-open),
# the posture reads 1 on /metrics, and a check the hub answers heals it.
"${CURL[@]}" -f -o /dev/null -X POST "$HOP/latency" -H 'content-type: application/json' -d '{"ms":7000}' || fail "could not set the hop's latency"
BIGGER=$(head -c 3072 /dev/zero | tr '\0' 'y')
SLOW_BYTES=$(metered slow "$BIGGER" -b "$SL_JAR" -H "Origin: $SL")
"${CURL[@]}" -f -o /dev/null -X DELETE "$HOP/latency" || fail "could not clear the hop's latency"
metrics | grep -q '^usage_check_posture 1' || fail "usage_check_posture should read 1 (failing open) after a check the hub did not answer in time: $(metrics | grep usage_check)"
metrics | grep -Eq '^usage_check_total\{outcome="fail_open"\} [1-9]' || fail "no fail_open outcome counted: $(metrics | grep usage_check_total)"
# The check leaves the hub alone for five seconds after a failed call
# (every request in that window takes the outage's verdict at once), so the
# healing check is asked once the hold has passed.
sleep 6
HEALED_BYTES=$(metered healed "${BIGGER}z" -b "$SL_JAR" -H "Origin: $SL")
metrics | grep -q '^usage_check_posture 0' || fail "usage_check_posture should read 0 once the hub answers again: $(metrics | grep usage_check_posture)"
pass "hub slow beyond the check's budget: the upload ($SLOW_BYTES bytes) still lands, usage_check_posture 1 on /metrics; the next answered check ($HEALED_BYTES bytes) heals it to 0"

# ── Phase 8b, third leg — the billing rail, phase 3: free is limited (PRDCT-2702) ──
say "Phase 8b — phase 3: the free workspace is refused what pro unlocks, at Slideless's door and at the hub's"
# The plan entitlements were seeded from Slideless's discovery with the price
# book above (workspace.members 3, links.perDeck 10, deck.password off on
# free), so the Drill Workspace is a free workspace with every limit declared.
"${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/decks.json" -f -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations" || fail "GET /presentations as the owner failed"
DECK_ID=$(jq -r '.presentations[0].id // empty' "$SCRATCH/decks.json")
[ -n "$DECK_ID" ] || fail "no deck in the drill workspace to mint a link on: $(cat "$SCRATCH/decks.json")"
locked() { # label curl-auth-args → mints a link WITH a password on the deck; prints the status, the body in $SCRATCH/locked-<label>.json
  local label=$1; shift
  "${CURL[@]}" "$@" -o "$SCRATCH/locked-$label.json" -w '%{http_code}' -X POST "$SL/api/v1/presentations/$DECK_ID/tokens" \
    -H "X-Workspace-Id: $WS_ID" -H "$(idem)" -H 'content-type: application/json' -d '{"name":"drill locked","password":"drill-pass-1"}'
}
plan_refused() { # file key → asserts a 403 plan_required body on the key, free → pro, with the hub's upgrade page carrying both
  local file=$1 key=$2
  jq -e --arg key "$key" --arg up "$HUB/billing/upgrade?org=$HUB_ORG_ID" \
    '.error.code == "plan_required" and .error.details.key == $key and .error.details.plan == "free" and .error.details.requiredPlan == "pro"
     and (.error.details.upgradeUrl | startswith($up)) and (.error.details.upgradeUrl | contains("key=" + $key)) and (.error.details.upgradeUrl | contains("requiredPlan=pro"))' \
    "$file" >/dev/null || fail "not a 403 plan_required on $key with the upgrade link: $(cat "$file")"
}
# A password on a share link is pro: the free workspace is refused at the mint, on the three surfaces, and nothing is charged.
# The legs before this one end on metered actions whose events the poster may
# still be delivering: drain the usage queue before the baseline, or a late
# event of the previous leg reads as one the refusals wrote.
for i in $(seq 1 60); do
  pending=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state NOT IN ('completed', 'failed', 'cancelled')")
  [ "$pending" = 0 ] && break
  sleep 1
done
[ "$pending" = 0 ] || fail "the usage queue did not drain before the phase 3 leg ($pending pending)"
before_locked=$(hubdb "SELECT count(*) FROM usage_events")
status=$(locked session -b "$SL_JAR" -H "Origin: $SL")
[ "$status" = 403 ] || fail "a locked link on the free plan (session) answered $status, expected 403: $(cat "$SCRATCH/locked-session.json")"
plan_refused "$SCRATCH/locked-session.json" deck.password
status=$(locked api_key -H "Authorization: Bearer $SLK")
[ "$status" = 403 ] || fail "a locked link on the free plan (slk_ key) answered $status, expected 403: $(cat "$SCRATCH/locked-api_key.json")"
plan_refused "$SCRATCH/locked-api_key.json" deck.password
mcp_locked=$(jq -nc --arg ws "$WS_ID" --arg id "$DECK_ID" \
  '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"slideless_add_share_token",arguments:{workspace:$ws,presentationId:$id,name:"drill locked",password:"drill-pass-1"}}}')
mcp_locked_answer=$("${CURL[@]}" -X POST "$SL/mcp" -H "Authorization: Bearer $MCP_BEARER" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$mcp_locked")
echo "$mcp_locked_answer" | jq -e --arg up "Upgrade: $HUB/billing/upgrade?org=$HUB_ORG_ID" \
  '.result.isError == true and (.result.content[0].text | (test("plan_required") and contains($up) and contains("key=deck.password")))' >/dev/null \
  || fail "the MCP tool result does not carry the plan refusal and the upgrade link: $(echo "$mcp_locked_answer" | head -c 500)"
# The plan answers before the credit check and before the handler: no event is queued, none lands.
[ "$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND data->>'actionKey' = 'share_tokens.create'")" = 0 ] \
  || fail "a refused locked mint queued a share_tokens.create event"
[ "$(hubdb "SELECT count(*) FROM usage_events")" = "$before_locked" ] || fail "the three refusals wrote usage_events at the hub (before $before_locked, now $(hubdb "SELECT count(*) FROM usage_events"))"
pass "a share link with a password on the free plan: 403 plan_required (deck.password, free → pro) with the hub's upgrade page on the dashboard session, the slk_ key and the MCP tool's text; nothing queued, nothing landed"

# The hub's own door: the member cap on the Drill Workspace (one member, Drill Owner).
hub_invite() { # email label → POST /invitations at the hub as the owner; prints the status, the body in $SCRATCH/hub-invite-<label>.json
  local email=$1 label=$2
  "${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/hub-invite-$label.json" -w '%{http_code}' -X POST "$HUB/api/v1/invitations" \
    -H "Origin: $HUB" -H "X-Workspace-Id: $HUB_ORG_ID" -H "$(idem)" -H 'content-type: application/json' -d "{\"email\":\"$email\",\"role\":\"member\"}"
}
status=$(hub_invite drill-m2@drill.test m2); [ "$status" = 201 ] || fail "the second seat's invitation answered $status: $(cat "$SCRATCH/hub-invite-m2.json")"
status=$(hub_invite drill-m3@drill.test m3); [ "$status" = 201 ] || fail "the third seat's invitation answered $status: $(cat "$SCRATCH/hub-invite-m3.json")"
status=$(hub_invite drill-m4@drill.test m4); [ "$status" = 403 ] || fail "the fourth seat's invitation answered $status, expected 403: $(cat "$SCRATCH/hub-invite-m4.json")"
plan_refused "$SCRATCH/hub-invite-m4.json" workspace.members
jq -e '.error.details.upgradeUrl | contains("tool=slideless-cloud")' "$SCRATCH/hub-invite-m4.json" >/dev/null \
  || fail "the hub's upgrade page does not name the tool whose cap bound the account: $(cat "$SCRATCH/hub-invite-m4.json")"
pass "at the hub, two invitations seat the free workspace at its cap of 3 (one member, two open invitations); the fourth answers 403 plan_required (workspace.members, free → pro) with the upgrade page naming slideless-cloud"

# Staff lifts the account above free: an override of the cap to unlimited
# and of the password feature to on, the way an enterprise deal is served.
override() { # body → PUT /admin/billing/entitlements as staff; prints the row id
  local body=$1
  local st
  st=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/override.json" -w '%{http_code}' -X PUT "$HUB/api/v1/admin/billing/entitlements" \
    -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d "$body")
  [ "$st" = 201 ] || fail "PUT /admin/billing/entitlements answered $st: $(cat "$SCRATCH/override.json")"
  jq -r '.id' "$SCRATCH/override.json"
}
CAP_OVERRIDE=$(override "{\"toolSlug\":\"slideless-cloud\",\"accountId\":\"$ACCOUNT_ID\",\"key\":\"workspace.members\",\"kind\":\"limit\",\"value\":null}")
PASSWORD_OVERRIDE=$(override "{\"toolSlug\":\"slideless-cloud\",\"accountId\":\"$ACCOUNT_ID\",\"key\":\"deck.password\",\"kind\":\"feature\",\"value\":true}")
status=$(hub_invite drill-m4@drill.test m4b); [ "$status" = 201 ] || fail "with the cap lifted, the fourth seat's invitation answered $status: $(cat "$SCRATCH/hub-invite-m4b.json")"
pass "staff override of workspace.members to unlimited for the account: the fourth invitation passes at the hub"
# Slideless serves an account's plan from a thirty-second cache and refreshes it
# behind the request once stale, so the lifted account is felt on the mint
# after the window; every refused attempt costs nothing (the plan answers
# before the credit check), the one that lands costs the link's 20 credits.
status=0
for i in $(seq 1 20); do
  status=$(locked lifted -b "$SL_JAR" -H "Origin: $SL")
  [ "$status" = 201 ] && break
  [ "$status" = 403 ] || fail "the locked mint on the lifted account answered $status: $(cat "$SCRATCH/locked-lifted.json")"
  sleep 3
done
[ "$status" = 201 ] || fail "the locked mint still answers 403 a minute after the override: $(cat "$SCRATCH/locked-lifted.json")"
jq -e '.shareToken.hasPassword == true' "$SCRATCH/locked-lifted.json" >/dev/null || fail "the minted link does not carry its password: $(cat "$SCRATCH/locked-lifted.json")"
# The one mint that landed is the one event: queued as share_tokens.create, drained to the hub, priced 20.
for i in $(seq 1 60); do
  pending=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state NOT IN ('completed', 'failed', 'cancelled')")
  [ "$pending" = 0 ] && break
  sleep 1
done
[ "$pending" = 0 ] || fail "the usage queue did not drain after the locked mint ($pending pending)"
LOCKED_EVENT=$(sldb "SELECT data->>'id' FROM pgboss.job WHERE name = 'usage-events' AND data->>'actionKey' = 'share_tokens.create' ORDER BY created_on DESC LIMIT 1")
[ -n "$LOCKED_EVENT" ] || fail "no queued share_tokens.create event for the locked mint"
[ "$(hubdb "SELECT count(*) FROM usage_events")" = "$((before_locked + 1))" ] \
  || fail "the locked mint must land exactly one event (before $before_locked, now $(hubdb "SELECT count(*) FROM usage_events"))"
[ "$(hubdb "SELECT credits FROM usage_events WHERE id = '$LOCKED_EVENT'")" = 20 ] || fail "the locked mint was not priced 20 credits at the hub"
pass "the account lifted by staff mints the locked link on Slideless (201, hasPassword true) once its plan cache has turned over; one event landed for it (priced 20), none for the three refusals"
# The overrides removed: the account is back on free (the invitations it already holds stay).
for id in "$CAP_OVERRIDE" "$PASSWORD_OVERRIDE"; do
  "${CURL[@]}" -b "$HUB_JAR" -o /dev/null -f -X DELETE "$HUB/api/v1/admin/billing/entitlements/$id" -H "Origin: $HUB" -H "$(idem)" \
    || fail "DELETE /admin/billing/entitlements/$id failed"
done
pass "the two overrides removed: the account is on free again"
# Felt again once the plan cache turns over: the locked mint is refused as
# before. Every attempt that still lands adds a link to the deck, and the free
# plan's links.perDeck (10) is judged AFTER the feature, so the attempts are
# spaced five seconds apart, not three: the cache turns over in about
# thirty, well before the deck's links could reach the count cap and answer
# the same 403 on the wrong key.
status=0
for i in $(seq 1 20); do
  status=$(locked relocked -b "$SL_JAR" -H "Origin: $SL")
  [ "$status" = 403 ] && break
  [ "$status" = 201 ] || fail "the locked mint after the overrides were removed answered $status: $(cat "$SCRATCH/locked-relocked.json")"
  sleep 5
done
[ "$status" = 403 ] || fail "a hundred seconds after the overrides were removed the locked mint still lands"
plan_refused "$SCRATCH/locked-relocked.json" deck.password
pass "the two overrides removed: the locked mint is refused again (403 plan_required, deck.password) once the plan cache has turned over (the links minted meanwhile stay)"
fi # the second leg

# ── Phase 9 — logout ─────────────────────────────────────────────────────────
say "Phase 9 — logout: the CLI key revokes itself, the browser session ends, the hub logout takes the grant"
sess_revoke=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/sess-revoke.json" -w '%{http_code}' -X DELETE "$SL/api/v1/cli/auth/key" -H "Origin: $SL")
[ "$sess_revoke" = 403 ] || fail "DELETE /cli/auth/key with a SESSION answered $sess_revoke (expected 403): $(cat "$SCRATCH/sess-revoke.json")"
revoke_status=$("${CURL[@]}" -o "$SCRATCH/revoke.json" -w '%{http_code}' -X DELETE "$SL/api/v1/cli/auth/key" -H "Authorization: Bearer $CLI_KEY")
[ "$revoke_status" = 200 ] && jq -e --arg id "$CLI_KEY_ID" '.revoked == true and .id == $id' "$SCRATCH/revoke.json" >/dev/null \
  || fail "DELETE /cli/auth/key with the CLI key answered $revoke_status: $(cat "$SCRATCH/revoke.json")"
after_revoke=$("${CURL[@]}" -o "$SCRATCH/after-revoke.json" -w '%{http_code}' -H "Authorization: Bearer $CLI_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations")
[ "$after_revoke" = 401 ] || fail "the revoked CLI key still answers $after_revoke on GET /presentations: $(cat "$SCRATCH/after-revoke.json")"
! grep -q '"presentations"' "$SCRATCH/after-revoke.json" || fail "the 401 carries presentations"
pass "CLI logout: DELETE /cli/auth/key (the presenting key) → 200 revoked; the same key on GET /presentations → 401 ($(jq -r '.error.code' "$SCRATCH/after-revoke.json")); a session is refused the route (403)"
other_key=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SLK" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations")
[ "$other_key" = 200 ] || fail "the self-revoke reached another key of the same user: GET /presentations with the dashboard key answered $other_key"
[ "$(sldb "SELECT count(*) FROM api_keys WHERE created_by = '$SL_USER_ID' AND revoked_at IS NOT NULL")" = 1 ] || fail "expected exactly one revoked key"
pass "the self-revoke killed exactly itself: the user's other slk_ key still reads /presentations"

# The browser: POST /sso/logout revokes the local session server-side and
# hands back the hub's end-session URL (null when the hub leg cannot be built).
logout_status=$("${CURL[@]}" -b "$SL_JAR" -c "$SL_JAR" -o "$SCRATCH/logout.json" -w '%{http_code}' -X POST "$SL/api/v1/sso/logout" \
  -H "Origin: $SL" -H 'content-type: application/json' -d '{}')
[ "$logout_status" = 200 ] && jq -e 'has("url")' "$SCRATCH/logout.json" >/dev/null || fail "POST /sso/logout answered $logout_status: $(cat "$SCRATCH/logout.json")"
note "hub end-session URL: $(jq -r '.url // "null"' "$SCRATCH/logout.json" | cut -c1-120)"
gone=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/gone.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$gone" = 401 ] || fail "GET /me after the logout answered $gone: $(cat "$SCRATCH/gone.json")"
[ "$(sldb "SELECT count(*) FROM session WHERE user_id = '$SL_USER_ID'")" = 0 ] || fail "the logout left a session row"
key_logout=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$SL/api/v1/sso/logout" -H "Authorization: Bearer $SLK" -H 'content-type: application/json' -d '{}')
[ "$key_logout" = 403 ] || fail "POST /sso/logout with an slk_ key answered $key_logout (expected 403: a credential never ends its user's sessions)"
pass "browser logout: POST /sso/logout → 200, the session row is gone, GET /me → 401; an slk_ key is refused the route (403)"

# `antasphere logout` at the hub: the account key revokes itself and the hub
# cascades onto the offline grant that key minted (PRDCT-1387). The tool's
# stored grant is then dead. The hub-audienced ACCESS token the tool already
# holds is a JWT the hub verifies statelessly, so it lives out its own TTL;
# the drill ends that TTL the way Phase 5 does (expire the stored token,
# restart to drop the in-process cache) and the next demand must refresh.
hub_logout=$("${CURL[@]}" -o "$SCRATCH/hub-logout.json" -w '%{http_code}' -X DELETE "$HUB/api/v1/cli/auth/key" -H "Authorization: Bearer $HUB_KEY")
[ "$hub_logout" = 200 ] || fail "the hub's DELETE /cli/auth/key answered $hub_logout: $(cat "$SCRATCH/hub-logout.json")"
hub_after=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HUB_KEY" "$HUB/api/v1/me")
[ "$hub_after" = 401 ] || fail "the revoked hub key still answers $hub_after"
[ "$(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")" = 0 ] || fail "the hub logout left $(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID") offline-grant row(s) for $SL_CLIENT_ID"
pass "hub CLI logout: the account key → 401, and the offline grant it minted for $SL_CLIENT_ID is gone (0 rows)"
sldb "UPDATE account SET access_token_expires_at = now() - interval '1 hour' WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'" >/dev/null
dc restart app >/dev/null 2>&1
wait_ready app "$SL/healthz" 300
dead_status=$("${CURL[@]}" -o "$SCRATCH/dead.json" -w '%{http_code}' -H "Authorization: Bearer $SLK" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/presentations")
[ "$dead_status" = 401 ] && grep -q hub_grant_expired "$SCRATCH/dead.json" \
  || fail "after the hub logout, the user's remaining key answered $dead_status (expected 401 hub_grant_expired): $(cat "$SCRATCH/dead.json")"
! grep -q '"presentations"' "$SCRATCH/dead.json" || fail "the 401 carries presentations"
dead=$(sldb "SELECT (refresh_token IS NULL)::int FROM account WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'")
[ "$dead" = 1 ] || fail "Slideless did not mark the logged-out grant dead"
pass "the tool follows: once its hub access token is spent the refresh is refused, the grant is marked dead, and the user's remaining slk_ key answers 401 hub_grant_expired"
