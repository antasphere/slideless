# Verification evidence

How each exit criterion is proven. Automated proofs live in the test suites
and CI; the manual drills below are reproducible with the scripts named.

## Automated

- **Unit** (`pnpm --filter @slideless/server test`, `@slideless/dashboard test`):
  scope allowlist, key format + constant-time verify, content-address +
  traversal guard, Range parser, disposition policy, env schema, CSP hashes,
  pino redaction (the real `REDACT_PATHS`), `safeNext` open-redirect guard.
- **Integration** (`test:integration`, testcontainers `pgvector/pg17`, real
  routes via `app.request()` + a real listening server for the OAuth/MCP
  dance): migrator idempotency, setup + 410, live-membership revocation on
  all three credential paths, API keys, invitations, audit, files (local +
  MinIO), metrics, request-id correlation, usage pipeline, and the full
  OAuth dance driven by the official MCP SDK client. Workspace scoping
  (ADR 014): header default/switch/fail-closed, cross-workspace key + data
  isolation, consent-time OAuth binding with refresh persistence and the
  legacy fail-closed rules, the multi-owned-workspace deletion guard,
  break-glass explicit targeting, and the deck-specific surface — listings
  per active workspace, the two-workspace collaborator switcher path, and
  the ADR 013 privacy invariant under scoped principals
  (`workspace-scoping`, `oauth-workspace`, `workspace-decks`,
  `break-glass` suites).
- **Dashboard e2e** (`@slideless/dashboard test:e2e`): builds the real image,
  boots an isolated compose stack, walks setup → key → invite → accept →
  audit → deep-link → re-login → consent error state, and asserts the
  workspace switcher is ABSENT for a single-membership user (ADR 014).
- **Live federation (ADR 019)** (`test:integration`, FakeHub — a faithful
  in-process hub: caller-scoped `GET /orgs`, refresh rotation + RFC 9700
  reuse detection, the H3 exchange-JWT + `hubRefreshToken` pair, failure
  injection): the fail-closed login reconcile, the sweep's blast radius
  (`origin='hub'` rows only — the break-glass `origin='local'` lifeboat
  survives an EMPTY-list pass), grant single-flight/rotation/encryption
  round-trips, the live-gate verdict matrix (`hub_grant_expired` /
  `hub_unavailable` / `membership_revoked` / `account_suspended` with the
  GET /me exemption), unknown-workspace retry across all three credential
  kinds, `/sso/cli-connect` with `acquireFromConnect` (immediate key use,
  born-dead refusals), the orphan-purge discriminator + hard constraint,
  the zero-membership `/me` state, and oss-dark byte-identity (fetch-spy:
  ZERO outbound calls across boot + a request matrix — the airtight
  oss-never-touches-the-hub proof).
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, unit, build, format,
  drift check, and the integration suite.
- **Release gates** (`.github/workflows/release.yml`): an image e2e smoke
  (build → compose up → setup/login/key/audit → restart-persistence) and a
  Trivy HIGH/CRITICAL scan, both gating the multi-arch GHCR publish.

## Manual drills (reproducible)

### Load test — exit criterion 7 (`scripts/loadtest.sh`)

autocannon, 50 connections, 10s, against a single-VPS compose deployment
(`node:22-alpine`, one replica, local storage). Representative run:

| Route              | What it exercises                                              | Median latency | Throughput   |
| ------------------ | -------------------------------------------------------------- | -------------- | ------------ |
| `/healthz`         | liveness, no deps                                              | 4 ms           | ~10.7k req/s |
| `/api/v1/instance` | public discovery, one indexed read                             | 11 ms          | ~4.3k req/s  |
| `/api/v1/me`       | authenticated: session + one live membership check per request | 27 ms          | ~1.8k req/s  |

Zero non-2xx across all three. The authenticated path deliberately does the
live re-check the security model depends on (instant revocation), and still
sustains ~1.8k req/s on one small container — headroom is a bigger machine
or (Profile B) more replicas.

### Upgrade survives — exit criterion 5

Bring up an older image, seed an owner + API key, then pull a newer image
carrying an additive migration (migration `0003` was created for exactly
this) and `docker compose up -d`. Verified: the two pending migrations
applied exactly once under the advisory lock, `/readyz` flipped back to 200,
and the pre-upgrade API key still authenticated — data survived.

### Graceful drain — exit criterion 6

Start a rate-limited 50MB download, send `SIGTERM` 3s in. Verified: the app
logged `shutdown: draining`, let the in-flight transfer finish, and the
downloaded bytes were identical to the source (52,428,800 bytes, curl exit
0); shutdown completed cleanly after the transfer. `stop_grace_period` in
compose is set above the in-app grace window so the orchestrator waits.

### MCP connector dance — exit criterion 13 (`apps/server/scripts/verify-mcp-dance.mts`)

Against a running instance: 401 challenge → RFC 9728 resource metadata →
dynamic client registration → login → consent → PKCE token exchange →
official MCP SDK client `initialize` + `get_me`. Verified end-to-end; the
same flow is also asserted in `test/integration/oauth-mcp.test.ts`.

### The live federation drill — ADR 019 exit gate (scripted; run before ANY deploy)

Both images from HEAD on the federation harness
(`docker-compose.federation.yml`), a real browser for the SSO legs, `curl`
for the rest. Every step lists its expected evidence; a deviation anywhere
is a NO-GO. Shell setup used throughout:

```bash
cd <slideless repo>   # the compose file lives here; hub builds from the sibling checkout
export FED="docker compose -f docker-compose.federation.yml"
export HUB=http://localhost:3300 SL=http://localhost:3310
hubdb() { $FED exec -T hub-db psql -U antasphere -d antasphere -Atc "$1"; }
sldb()  { $FED exec -T db     psql -U slideless  -d slideless  -Atc "$1"; }
```

**0 — Bring-up + fixtures.**

```bash
$FED up -d --build
curl -fsS $HUB/healthz && curl -fsS $SL/healthz
```

- Browser: run both setup wizards once (`http://hub.localhost:3300`,
  `http://slideless.localhost:3310`). Expected: the hub logs
  `tool registry: client seeded` for `tool-slideless-cloud`; the Slideless
  setup response carries `workspaceId: null` (cloud mints no workspace).
- Browser at the hub: sign up **U1** (`u1@drill.test`), create org
  **"Drill Org"**. Sign up **U2** (`u2@drill.test`) — an ordinary
  open-signup user, the adversary — with their own org **"Adversary Org"**.
- Browser at Slideless: U1 → "Sign in with Antasphere" → consent ("act as
  you" — expected: NO org picker anywhere) → lands in Drill Org.

```bash
export W1=$(sldb "SELECT w.id FROM workspaces w WHERE w.name='Drill Org'")
export SL_COOKIE='<U1 slideless session cookie from devtools>'
export HUB_COOKIE_U1='<U1 hub session cookie>' HUB_COOKIE_U2='<U2 hub session cookie>'
```

**A — Org lifecycle propagates live (create / rename / remove).**

```bash
# create at the hub → visible on Slideless within the reconcile TTL (~10 s)
curl -fsS -X POST $HUB/api/v1/orgs -H "cookie: $HUB_COOKIE_U1" \
  -H 'content-type: application/json' -d '{"name":"Second Org"}'
sleep 11; curl -fsS $SL/api/v1/me -H "cookie: $SL_COOKIE" | jq '.workspaces[].name'
# rename at the hub (X-Workspace-Id = the new org id from the create response)
curl -fsS -X PATCH $HUB/api/v1/workspace -H "cookie: $HUB_COOKIE_U1" \
  -H "x-workspace-id: <second-org-id>" -H 'content-type: application/json' \
  -d '{"name":"Second Org GmbH"}'
sleep 11; curl -fsS $SL/api/v1/me -H "cookie: $SL_COOKIE" | jq '.workspaces[].name'
```

Expected: "Second Org" appears after the create (no re-login), the rename
shows after the TTL; the dashboard switcher shows both entries badged
"Antasphere", the default entry marked off the `default` flag. Then remove:
delete "Second Org GmbH" at the hub (or remove U1's membership) —
expected: within the TTL the entry disappears from `/me`, a request naming
its workspace id answers **401** (`membership_revoked` on the observing
request, plain 401 after), and the dashboard lands on the remaining org —
never a lockout; audit shows ONE `member.deactivate` row (reason
`hub_reconcile`). A user whose LAST org is removed lands on
`/no-organization` (zero state), not `/login`.

**B — Suspension: visible but blocked, /me alive.**

```bash
hubdb "UPDATE workspaces SET status='suspended' WHERE name='Drill Org'"
sleep 11
curl -s -o /dev/null -w '%{http_code}\n' $SL/api/v1/presentations \
  -H "cookie: $SL_COOKIE" -H "x-workspace-id: $W1"        # expect 403
curl -fsS $SL/api/v1/me -H "cookie: $SL_COOKIE" | jq '.workspaces[] | {name, suspended}'
```

Expected: workspace requests answer **403 `account_suspended`**; `GET /me`
stays **200** with `suspended: true` on the entry (the exemption); the
dashboard shows the entry disabled + badged "Suspended" instead of
stranding the shell. Unsuspend (`status='active'`) → next TTL restores
access.

**C — Hub outage: stale window → `hub_unavailable` → recovery.**

```bash
$FED stop hub
curl -s -o /dev/null -w '%{http_code}\n' $SL/api/v1/me -H "cookie: $SL_COOKIE"   # expect 200 (stale-served)
# The per-replica bound (ADR 019): a replica restarted mid-outage has no
# definitive pass to serve — its first request fails closed immediately.
$FED restart app; sleep 5
curl -s $SL/api/v1/presentations -H "cookie: $SL_COOKIE" -H "x-workspace-id: $W1" | jq .error.code
#   expect "hub_unavailable"  (the full-window variant: leave the hub down
#   >15 min WITHOUT restarting and observe the same flip — optional, slow)
$FED start hub; sleep 15
curl -s -o /dev/null -w '%{http_code}\n' $SL/api/v1/presentations \
  -H "cookie: $SL_COOKIE" -H "x-workspace-id: $W1"                                # expect 200 — recovery, nothing corrupted
sldb "SELECT count(*) FROM workspace_members WHERE is_active=false"               # unchanged vs before the outage
```

**D — Grant revocation: `hub_grant_expired` → browser re-login heals.**

```bash
hubdb "DELETE FROM oauth_refresh_token WHERE client_id='tool-slideless-cloud'
       AND user_id=(SELECT id FROM \"user\" WHERE email='u1@drill.test')"
$FED restart app   # clears the in-memory access-token cache so the next read must refresh
sleep 5
curl -s $SL/api/v1/presentations -H "cookie: $SL_COOKIE" -H "x-workspace-id: $W1" | jq .error.code
```

Expected: **401 `hub_grant_expired`** (immediate — no stale window; the
refresh answered `invalid_grant` and the row's tokens were nulled). The
dashboard maps it to re-auth steering. Browser: U1 signs in with
Antasphere again — expected: the login re-seeds the grant (account row
tokens repopulate) and the SAME requests answer 200. If U1 also holds an
`slk_` key, it resumes working after the re-login too (the key rides the
user's grant).

**E — CLI connect: the H3 grant channel.**

```bash
# From the hub side: mint an ant_ key for U1 (hub dashboard), then:
curl -fsS -X POST $HUB/api/v1/sso/tool-token -H "authorization: Bearer <ant_key>" \
  -H 'content-type: application/json' -d "{\"resource\":\"http://slideless.localhost:3310/mcp\"}" \
  | tee /tmp/h3.json | jq '{expiresAt, hubRefreshToken: (.hubRefreshToken|length)}'
curl -fsS -X POST $SL/api/v1/sso/cli-connect -H 'content-type: application/json' \
  -d "{\"token\":$(jq .token /tmp/h3.json),\"hubRefreshToken\":$(jq .hubRefreshToken /tmp/h3.json)}" \
  | jq '{workspaceId, apiKey: {workspaceId: .apiKey.workspaceId}, key: (.key|startswith("slk_"))}'
export SLK=<the returned key>
curl -fsS $SL/api/v1/me -H "authorization: Bearer $SLK" | jq '{activeWorkspaceId, via, workspaces: [.workspaces[].name]}'
```

Expected: the connect answers 201 with `workspaceId: null` +
`apiKey.workspaceId: null` (user-scoped); the key works IMMEDIATELY (no
browser SSO first) and lists ALL of U1's orgs; a repeat POST with the same
`token` answers 401 (jti burned); a connect with the `hubRefreshToken`
field omitted for a FRESH hub user answers **403 `hub_grant_missing`**
with steering and mints nothing.

**F — OSS-dark: zero hub calls.**

```bash
$FED stop app   # keep the hub running so any stray call WOULD be visible in its log
docker compose up -d   # the plain oss stack (port 3100), HUB_* vars deliberately exported into the env
curl -fsS http://localhost:3100/api/v1/instance | jq '.edition, .auth.methods'
# exercise: setup, password login, key mint, deck upload …
docker compose logs app | grep -ci hub          # expect 0 hub-shaped log lines
$FED logs hub --since 10m | grep -c "GET /api/v1/orgs"   # unchanged by anything oss did
```

Expected: `edition: "oss"`, no `antasphere` method, the full local flow
works, and the hub receives NOTHING from the oss instance. (The airtight
proof is automated: the fetch-spy edition test pins ZERO outbound fetches
across an oss boot + request matrix.)

**G — THE ADVERSARIAL PROBE: U2 reads nothing of U1.**

U2 is an ordinary hub user with their own org and their own Slideless
session; assume they somehow know `W1` (U1's workspace id) — ids are not
secrets in this model. Every probe must come back empty-handed:

```bash
export SL_COOKIE_U2='<U2 slideless session cookie (browser SSO as U2)>'
# 1. session + forced X-Workspace-Id → fail-closed 401, indistinguishable from a phantom id
curl -s -o /dev/null -w '%{http_code}\n' $SL/api/v1/me -H "cookie: $SL_COOKIE_U2" -H "x-workspace-id: $W1"      # 401
curl -s -o /dev/null -w '%{http_code}\n' $SL/api/v1/members -H "cookie: $SL_COOKIE_U2" -H "x-workspace-id: $W1" # 401
curl -s -o /dev/null -w '%{http_code}\n' $SL/api/v1/me -H "cookie: $SL_COOKIE_U2" \
  -H "x-workspace-id: 99999999-9999-4999-8999-999999999999"                                                     # 401 (same)
# 2. U2's own /me lists ONLY their orgs — no bleed-through
curl -fsS $SL/api/v1/me -H "cookie: $SL_COOKIE_U2" | jq '[.workspaces[].name]'    # ["Adversary Org"] only
# 3. U2's own slk_ key (mint in their dashboard), same probes
curl -s -o /dev/null -w '%{http_code}\n' $SL/api/v1/presentations \
  -H "authorization: Bearer <U2 slk_>" -H "x-workspace-id: $W1"                   # 401
# 4. MCP workspace-argument probing (the tool argument maps to the same selector)
curl -s -X POST $SL/mcp -H "authorization: Bearer <U2 slk_>" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"slideless_whoami\",\"arguments\":{\"workspace\":\"$W1\"}}}"
#   expect an error result (the in-process re-entry answers 401), NEVER U1 data
# 5. hub-side: PATCH default-org to U1's HUB org as U2 → 403
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH $HUB/api/v1/me/default-org \
  -H "cookie: $HUB_COOKIE_U2" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$(hubdb "SELECT id FROM workspaces WHERE name='Drill Org'")\"}"   # 403
# 6. the H3 offline grant is unredeemable without the tool client secret
curl -s -X POST $HUB/api/v1/auth/oauth2/token -H 'content-type: application/x-www-form-urlencoded' \
  -d "grant_type=refresh_token&refresh_token=$(jq -r .hubRefreshToken /tmp/h3.json)&client_id=tool-slideless-cloud" \
  | jq .error   # "invalid_client" — the raw grant alone buys nothing
```

Expected: every U1-directed probe is a fail-closed 401/403 with no
distinguishing detail (a foreign workspace and a phantom one answer
identically), U2 sees no U1 org name or member email on ANY path, and the
captured `hubRefreshToken` is inert without `HUB_CLIENT_SECRET`.

**Teardown.**

```bash
$FED down -v && docker compose down -v
```
