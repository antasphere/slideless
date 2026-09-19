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
