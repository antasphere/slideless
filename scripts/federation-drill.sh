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
#   7. The billing rail, phase 1 (PRDCT-2625 + PRDCT-2626, Phase 8) — one
#      metered action per surface (the dashboard session, an slk_ key, an
#      OAuth bearer over MCP) lands in the hub's usage_events exactly once:
#      the projected organization, the hub user, the channel, the action and
#      the size; the same batch posted again by hand with the tool's own
#      client-credentials token answers duplicate for every id; the owner
#      reads the consumption per person on GET /billing/usage.
#   8. The billing rail, phase 2 (PRDCT-2663 + PRDCT-2664, Phase 8's second
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
#   DRILL_SKIP_BUILD=1         reuse antasphere-hub:federation-dev + slideless:federation-dev (CI pre-builds)
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
#
# Everything else is throwaway: the compose project's volumes go with
# `down -v` on exit, pass or fail.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=${FEDERATION_PROJECT:-slideless-federation}
HUB_PORT=${FEDERATION_HUB_PORT:-3300}
SL_PORT=${FEDERATION_SL_PORT:-3310}
HOP_PORT=${FEDERATION_HOP_PORT:-8474}
HUB_IMAGE=${FEDERATION_HUB_IMAGE:-antasphere-hub:federation-dev}
SL_IMAGE=${FEDERATION_SL_IMAGE:-slideless:federation-dev}
HUB=http://hub.localhost:$HUB_PORT
SL=http://slideless.localhost:$SL_PORT
HOP=http://127.0.0.1:$HOP_PORT
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
for port in "$HUB_PORT" "$SL_PORT" "$HOP_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
    fail "port $port already answers — refusing to run (the harness needs $HUB_PORT, $SL_PORT and $HOP_PORT)"
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
  && docker image inspect "$SL_IMAGE" >/dev/null 2>&1; then
  note "DRILL_SKIP_BUILD=1 and both images exist — reusing"
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

# ── Phase 8 — the billing rail, phase 1 (PRDCT-2625 + PRDCT-2626) ──────────
say "Phase 8 — one metered action per surface lands in the hub's usage_events, exactly once"
# The drill's Phase 5 left the person's Slideless grant dead on purpose
# (hub_grant_expired); a browser re-login heals it, so sign in again through
# the hub session that is still alive. Same dance as Phase 3.
initiate=$("${CURL[@]}" -c "$SL_JAR" -X POST "$SL/api/v1/auth/sign-in/oauth2" -H 'content-type: application/json' \
  -d '{"providerId":"antasphere","callbackURL":"/"}')
AUTHZ_URL=$(echo "$initiate" | jq -r '.url // empty')
[ -n "$AUTHZ_URL" ] || fail "re-login: Slideless did not answer an authorize URL: $initiate"
location=$("${CURL[@]}" -b "$HUB_JAR" -o /dev/null -w '%{redirect_url}' "$AUTHZ_URL")
cb_status=$("${CURL[@]}" -b "$SL_JAR" -c "$SL_JAR" -o /dev/null -w '%{http_code}' "$location")
[ "$cb_status" = 302 ] || fail "re-login: Slideless callback answered $cb_status"
"${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/me8.json" -f "$SL/api/v1/me" || fail "re-login: no Slideless session"
jq -e --arg id "$WS_ID" '.workspaces[] | select(.id == $id)' "$SCRATCH/me8.json" >/dev/null \
  || fail "re-login: the drill workspace $WS_ID is not listed"
pass "the person is signed in again after Phase 5 (a browser re-login heals hub_grant_expired)"

before_rows=$(hubdb "SELECT count(*) FROM usage_events")
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

# What the gate queued, verbatim (the poster drains this queue to the hub).
queued=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events'")
[ "$queued" -ge 4 ] || fail "expected at least 4 queued usage events (3 uploads + 1 commit), the queue holds $queued"
for i in $(seq 1 60); do
  pending=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state NOT IN ('completed', 'failed', 'cancelled')")
  [ "$pending" = 0 ] && break
  sleep 1
done
[ "$pending" = 0 ] || fail "the usage queue did not drain in 60 s ($pending pending); is the poster reaching the hub?"
failed=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state = 'failed'")
[ "$failed" = 0 ] || fail "$failed usage job(s) FAILED at the poster: $(applogs app | grep -i 'usage poster' | tail -3)"
pass "the poster drained the queue to the hub ($queued events, none failed)"

# The hub's side: every event landed, attributed to the projected
# organization, the hub user, the right channel, the right action and size.
landed=$(hubdb "SELECT count(*) FROM usage_events WHERE account_id = (SELECT central_account_id FROM workspaces WHERE id = '$HUB_ORG_ID')")
[ "$landed" = "$((before_rows + queued))" ] \
  || fail "the hub holds $landed events for the organization, expected $((before_rows + queued)); the poster's log: $(applogs app | grep -i 'usage poster' | tail -3 | cut -c1-300); the hub's: $(hubdb "SELECT metadata::text FROM audit_log WHERE action = 'usage.ingest' ORDER BY created_at DESC LIMIT 2")"
row() { hubdb "SELECT count(*) FROM usage_events WHERE via = '$1' AND action_key = '$2' AND quantity = $3 AND user_id = '$HUB_USER_ID' AND tool_slug = '$(hubdb "SELECT metadata->'tool'->>'slug' FROM oauth_client WHERE client_id = '$SL_CLIENT_ID'")' AND workspace_id = '$WS_ID'"; }
[ "$(row session files.upload "$SESSION_BYTES")" = 1 ] || fail "no session row for files.upload of $SESSION_BYTES bytes by $HUB_USER_ID"
[ "$(row api_key files.upload "$KEY_BYTES")" = 1 ] || fail "no api_key row for files.upload of $KEY_BYTES bytes by $HUB_USER_ID"
[ "$(row oauth files.upload "$MCP_BYTES")" = 1 ] || fail "no oauth row for files.upload of $MCP_BYTES bytes by $HUB_USER_ID"
[ "$(row oauth presentations.commit 1)" = 1 ] || fail "no oauth row for presentations.commit by $HUB_USER_ID"
pass "usage_events: session / api_key / oauth, files.upload $SESSION_BYTES / $KEY_BYTES / $MCP_BYTES bytes + presentations.commit 1 call, user $HUB_USER_ID, the org's account, the registry slug"

# At-least-once from the tool, exactly once at the hub: the same batch again,
# by hand, with the tool's own machine token, answers duplicate for every id.
machine=$("${CURL[@]}" -o "$SCRATCH/machine.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" \
  -u "$SL_CLIENT_ID:$SL_CLIENT_SECRET" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials --data-urlencode scope=usage:write --data-urlencode "resource=$HUB/mcp")
[ "$machine" = 200 ] || fail "the tool's client_credentials mint answered $machine: $(cat "$SCRATCH/machine.json")"
MACHINE_TOKEN=$(jq -r '.access_token' "$SCRATCH/machine.json")
sldb "SELECT json_agg(data)::text FROM pgboss.job WHERE name = 'usage-events'" | jq '{events: .}' > "$SCRATCH/replay.json"
"${CURL[@]}" -o "$SCRATCH/replay-answer.json" -f -X POST "$HUB/api/v1/usage/events" -H "Authorization: Bearer $MACHINE_TOKEN" \
  -H 'content-type: application/json' -d @"$SCRATCH/replay.json" || fail "the hand replay of the batch failed: $(cat "$SCRATCH/replay-answer.json")"
jq -e --argjson n "$queued" '.duplicate == $n and .accepted == 0 and .rejected == 0' "$SCRATCH/replay-answer.json" >/dev/null \
  || fail "the replay should answer duplicate for all $queued: $(cat "$SCRATCH/replay-answer.json")"
[ "$(hubdb "SELECT count(*) FROM usage_events")" = "$landed" ] || fail "the replay wrote rows"
pass "the same batch posted again with the tool's machine token: $queued duplicate, 0 accepted, no new row"

# The organization's owner reads the consumption per person.
usage=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/billing-usage.json" -w '%{http_code}' -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/usage")
[ "$usage" = 200 ] || fail "GET /billing/usage as the owner answered $usage: $(cat "$SCRATCH/billing-usage.json")"
jq -e --arg u "$HUB_USER_ID" --argjson n "$queued" '.byUser | length == 1 and .[0].userId == $u and .[0].events == $n' "$SCRATCH/billing-usage.json" >/dev/null \
  || fail "the per-person view does not show $queued events for $HUB_USER_ID: $(jq -c '.byUser' "$SCRATCH/billing-usage.json")"
pass "GET /billing/usage as the owner: one person, $HUB_USER_ID, $queued events"

# ── Phase 8, second leg — the billing rail, phase 2 (PRDCT-2663 + PRDCT-2664) ──
say "Phase 8 — phase 2: the hub prices, the chassis asks before an action and refuses on the balance, the debit lands"
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

# ── Phase 8, third leg — the billing rail, phase 3: free is limited (PRDCT-2702) ──
say "Phase 8 — phase 3: the free workspace is refused what pro unlocks, at Slideless's door and at the hub's"
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
fi # the second leg
