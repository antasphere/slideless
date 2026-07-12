# Federation — the cloud edition and the Antasphere hub

How one Slideless codebase (and one Docker image) ships two editions:

- **`EDITION=oss`** (default) — the self-host edition. Single-tenant, local
  accounts, everything in this repo's other docs. It carries **zero hub
  surface at runtime**: no hub env is read, no SSO plugin is registered, no
  hub network calls exist.
- **`EDITION=cloud`** — the Antasphere-operated deployment at
  `slideless.antasphere.com`. Human login is delegated to the Antasphere hub
  (`account.antasphere.com`, the OIDC IdP for all Antasphere cloud tools);
  hub organizations project lazily into Slideless workspaces; entitlements
  come from hub account status. The instance stays its **own** OAuth 2.1
  authorization server for its `/mcp` resource — the hub never appears in
  the MCP dance.

The edition is pure **instance parametrization** — config, not build. The
binding point is `apps/server/src/platform/edition.ts` (`bindEditionSeams`),
called once from `boot.ts` where the platform registry is assembled: `oss`
binds the local defaults untouched; `cloud` rebinds the identity and
entitlement seams.

> **Phase status.** Phase 2 (env contract, edition binding seam, discovery,
> dev harness, R7 guard), **Phase 3 (the SSO entrance: "Sign in with
> Antasphere", JIT provisioning, lazy org projection — ADR 015)**, and
> **Phase 4 (the hub gates: org suspension + membership re-assertion —
> "The hub gates" below + ADR 016)** are built. The CLI cross-tool exchange
> is **Phase 5**.

## Environment contract

Full variable reference: [env-reference.md](env-reference.md). The cloud
block:

| Variable            | Meaning                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EDITION=cloud`     | Selects the cloud binding. The only other accepted value is `oss` (the default); anything else refuses to boot — a typo'd selector must never silently bind the wrong edition. |
| `HUB_ISSUER_URL`    | The hub OIDC issuer, `https://account.antasphere.com` in production. Discovery, JWKS, and the authorize/token endpoints all derive from it.                                    |
| `HUB_CLIENT_ID`     | This tool's OAuth client id from the hub `TOOL_REGISTRY` entry — `tool-slideless-cloud`.                                                                                       |
| `HUB_CLIENT_SECRET` | The matching client secret (confidential client; PKCE stays on regardless).                                                                                                    |
| `HUB_SERVICE_KEY`   | A hub API key (`ant_…`) holding the `accounts:status` scope — the EntitlementService credential (Phase 4; unread before then).                                                 |

Rules the boot enforces:

- **Fail-loud completeness**: `EDITION=cloud` with ANY of the four hub vars
  missing refuses to boot and prints one readable table naming every missing
  variable — never a partial boot that dies at the first hub call.
- **Derived resource URL**: this instance's own OAuth resource identifier is
  always `<PUBLIC_BASE_URL>/mcp` (`mcpResourceUrl` in
  `identity/better-auth.ts`). It is **never configured** — there is no env
  var for it, so it cannot drift from the origin that serves it.
- **On `EDITION=oss` none of the hub vars are required or read**
  (`hubConfig()` in `env.ts` returns `null` — the single switch every cloud
  seam hangs off). Formats are still validated when a var happens to be set:
  a typo fails the boot rather than lying dormant.

### The R7 edition-flip guard

Setup stamps the instance's edition into `instance_settings.edition`. A boot
whose env `EDITION` differs from the stamp **refuses to start**: flipping
editions under existing users and workspaces silently changes who can log in
and where workspace ownership is asserted. Cloud instances start from a
fresh database.

If a flip is truly intended, set `EDITION_CHANGE_ALLOWED=true` for **one
boot** — it re-stamps the new edition and proceeds; unset it again after.
Leaving it set disarms the guard (a future `EDITION` change would re-stamp
without refusing), so the boot logs a warning on every start where the flag
is set but no flip is pending. A fresh database (pre-setup) boots under any
edition with nothing to guard. The stamp is enforced whenever it is readable
— including while migrations are pending behind `AUTO_MIGRATE=false`; only a
database that predates the stamp column has nothing to compare until its
first migrated boot.

### D9 — the operator bootstrap

Setup mints the operator account with `emailVerified: true` (pinned by an
integration test). This is load-bearing on cloud: under hub-only login (D1,
Phase 3) the operator's only entrance is the hub trusted-link
(`accountLinking.trustedProviders: ['antasphere']` with
`requireLocalEmailVerified` kept on), and Better Auth refuses to link a
trusted provider onto an unverified local email — an unverified operator
would brick the instance at bootstrap. The hub's own setup does the same.

## Discovery

`GET /api/v1/instance` advertises the configured entrances so SPAs and CLIs
can render the right login (`auth.methods` is an **open enum** — ADR 003 —
clients must ignore entries they do not recognize):

- `oss`: today's methods, unchanged (`password`, `api-key`, `oauth`, plus
  `email-otp`/`google` when configured).
- `cloud`: **hub-only human login (D1)** — `antasphere` + the machine
  methods (`api-key`, `oauth`); `password`/`email-otp`/`google` are absent,
  and `passwordReset`/`emailChange`/`twoFactor` report `false` (credentials,
  email, and MFA are the hub's to manage — D10 re-syncs email at every
  login). The login page therefore renders ONLY "Sign in with Antasphere".
  The local password machinery stays **wired but hidden**: the break-glass
  CLI remains the operator door, and blocking `/sign-in/email` would
  dead-end it (pinned by an edition integration test).

## The SSO entrance (Phase 3): flow, JIT, projection

One codepath, owned by `apps/server/src/identity/hub-sso.ts` (plus
`hub-jwt.ts` for token verification) and registered by
`identity/better-auth.ts` **only when `hubConfig()` is non-null** — an oss
boot instantiates none of it (`POST /sign-in/oauth2` is a 404 there).

```
Browser → /login → "Sign in with Antasphere"
  → POST /api/v1/auth/sign-in/oauth2 {providerId: antasphere}
  → hub /authorize (confidential client, PKCE, scope=openid profile email)
  → hub login (or live hub session) → hub CONSENT with org picker
    (the hub asserts exactly ONE org per login)
  → code → /api/v1/auth/oauth2/callback/antasphere
  → token exchange WITH resource=<PUBLIC_BASE_URL>/mcp (RFC 8707 — the
    switch that makes the hub mint the org-claim JWT; refresh re-mints drop
    it and go opaque, so org claims are read from the callback ONLY)
  → HubJwtVerifier: access token (iss=HUB_ISSUER_URL, aud=own resource URL,
    RS256, remote JWKS) + id_token (aud=HUB_CLIENT_ID), subjects cross-pinned
  → JIT: user created (emailVerified from the hub's verified claim) or
    linked (D9); org projected; membership asserted
  → ordinary local session cookie. The hub is out of the request path
    until the next login.
```

Per-login semantics (every SSO login, returning users included — ADR 015
has the full design, including the assertion handoff and its race analysis):

- **Lazy projection**: the asserted hub org becomes a workspace on first
  use — `workspaces.centralAccountId` = the hub org id, name from the H1
  `workspace_name` claim (or a self-healing placeholder when an older hub
  omits it). A **unique partial index** (migration 0021) + `ON CONFLICT`
  make concurrent first-logins land on one row.
- **Membership re-assertion (D11)**: role = the hub org role **verbatim**
  (owner/admin/member map 1:1; an unknown role refuses the login — local
  roles are never invented), `origin='hub'`, reactivated if deactivated.
  Hub role changes land at the next login; Phase 4's H2 re-assertion
  tightens propagation.
- **Email sync (D10)**: the local email follows the hub's verified email; a
  collision with another local user fails the login cleanly
  (`/login?error=sso_email_conflict`) instead of corrupting either account.
- **Fail closed**: any bad token (foreign iss/aud, expired, opaque,
  malformed claims) or failed per-login step means NO session — a cloud
  login without its projection never exists.

**The fourth signup switch.** The repo invariant "closed sign-up needs
three switches" gains a deliberate fourth on cloud: the `antasphere`
provider's `disableSignUp` stays **unset**, because hub SSO IS the
sanctioned account entrance (JIT). Local HTTP sign-up remains closed by the
original three switches; setting `disableSignUp` on this provider would
brick every first login.

### D9 — account linking

`accountLinking: { trustedProviders: ['antasphere'], requireLocalEmailVerified: true }`.
The hub's verified email assertion may link onto an EXISTING local account
with the same (verified) address — this is how the setup operator enters
under hub-only login, without duplicating. `requireLocalEmailVerified`
stays on so a parked unverified local account can never be taken over via
SSO. A guard in the after-hook additionally refuses to merge two DIFFERENT
hub identities onto one local user via a stale local email
(`/login?error=sso_identity_conflict`, link undone — ADR 015).

## The hub gates (Phase 4): suspension + membership re-assertion

The SSO entrance asserts hub truth **at login** — but tool sessions live 365
days and API keys/OAuth grants longer, so two things must hold *between*
logins: a hub org that gets **suspended** must stop working here quickly,
and a user **removed** from a hub org (or whose role changed) must lose/gain
the corresponding access without waiting for their next login. Phase 4 adds
two cached gates, both consuming the hub's `accounts:status` machine surface
with `HUB_SERVICE_KEY` (`identity/hub-status.ts`), both keyed strictly off
the workspace's `centralAccountId` — a workspace with **no projection** (the
operator's setup workspace, local/guest ones) never talks to the hub at all.

**Where they run.** `authContext` — the single credential resolver every
`/api/v1` request passes through — runs an optional post-resolution
`principalGate` (ADR 016). The cloud binding supplies it
(`identity/hub-gate.ts`, wired by `bindEditionSeams`); oss wires nothing.
Because the hook sits in the resolver rather than inside any one identity
path, sessions, API keys, and OAuth bearers all pass the same gate — MCP
tool calls included (they re-enter `/api/v1` in-process). The same
suspension check also backs the `EntitlementService` seam
(`HubEntitlementService` wraps the local caps), so metered actions carry the
denial reason as defense in depth.

### Gate 1 — org suspension (decision D5)

`GET {hub}/api/v1/accounts/{centralAccountId}/status` → `{status, kind}`,
cached **per org, 60 s TTL**. Answers and postures:

| Hub answer | Verdict |
| --- | --- |
| `status: "active"` | allow (cached 60 s) |
| `status: "suspended"` | **403 `account_suspended`** with the reason, enforced as soon as fetched |
| `404` (org deleted/unknown) | **403 `account_suspended`** — same definitive deny |
| network / timeout / 5xx / 401 / 403 | serve the **last known value stale up to 15 min** (from the last success), then **fail closed**: 403 `hub_unavailable` |

The hot path never blocks on the hub once a value is cached: an expired
entry is served stale while a single-flight refresh runs (enforcement bound
≈ TTL + one round-trip), and during an outage re-probes are throttled
(~15 s), so a down hub costs at most one timeout per org per window. A cold
cache with an unreachable hub fails closed immediately. Counters
(`hub_status_fetches_total`, `hub_status_degraded_total`) surface degraded
serving on `/metrics`; the dashboard maps both denial codes to a localized
(en/fr) full-page notice at `/suspended` and to toast copy mid-session.

### Gate 2 — membership re-assertion (decisions D3/D11, hub delta H2)

`GET {hub}/api/v1/accounts/{centralAccountId}/members/{hubUserId}/status` →
`{active, role?}` (`hubUserId` = the SSO `sub` from the user's `antasphere`
account link), re-asserted on a **per-(user, workspace) cache, ~5 min TTL**,
for **`origin='hub'` membership rows ONLY** — `local`/`guest` rows are the
tool's own business and are never re-asserted nor touched.

- **`200 {active:false}` is the ONLY deactivation signal** (it covers
  removed members, deactivated members, and deleted orgs alike). The gate
  deactivates the local row (update keyed to `origin='hub'`), audits it
  (`member.deactivate`, reason `hub_reassertion`, actor `system`), and
  answers **401 `membership_revoked`**. The existing live-membership
  re-check then locks the user out of sessions, API keys, and OAuth bearers
  everywhere, instantly. Reactivation happens only at the next successful
  SSO login (the projection upsert) — which the hub grants only to live
  members.
- **`200 {active:true, role}`**: a role delta syncs onto the local row and
  applies to the very request that observed it (a demoted hub admin loses
  admin surfaces on that request; a promoted member gains them).
- **Everything else is inconclusive, fail open**: 401/403 (broken or
  rotated service key — logged loudly, never a deactivation), 404 (a hub
  without H2), 5xx, timeouts, malformed bodies. The row is kept and the
  check retries at the next cache expiry.

**Propagation bounds**: suspension ≤ ~60 s; removal/role change ≤ ~5 min —
per replica (the caches are in-process; each replica converges within its
own window).

**Known bounds, on purpose**: anonymous share-link viewing (`/v/{secret}`)
is not gated — it is not an authenticated workspace surface; revoke share
tokens to cut it. The MCP transport handshake itself is not gated either;
every MCP tool call is, since it re-enters `/api/v1`.

## The hub registry entry (what the HUB operator configures)

The hub seeds first-party tool clients from its `TOOL_REGISTRY` env var
(inline JSON) or `TOOL_REGISTRY_FILE` (path, wins over inline) at every boot
— idempotent upsert, and the seeded client ids are pinned so the hub's
client-management API refuses to mutate them. Each entry's `resourceUrl`
joins the hub's token-audience allowlist (`validAudiences`), and consent is
**never skipped** (`skipConsent: false` — the consent page hosts the hub's
org picker).

Production entry for Slideless cloud (origin per D7 —
`slideless.antasphere.com`, fixed before the entry is minted because grants
and redirect URIs die with it):

```json
[
  {
    "slug": "slideless-cloud",
    "name": "Slideless",
    "resourceUrl": "https://slideless.antasphere.com/mcp",
    "redirectUris": ["https://slideless.antasphere.com/api/v1/auth/oauth2/callback/antasphere"],
    "clientId": "tool-slideless-cloud",
    "clientSecret": "<from the secret store — presence makes it a confidential client>"
  }
]
```

The redirect URI is better-auth's `genericOAuth` callback for
`providerId: 'antasphere'` (registered in Phase 3). The Slideless deployment
then sets `HUB_CLIENT_ID`/`HUB_CLIENT_SECRET` to the same pair, and
`HUB_ISSUER_URL=https://account.antasphere.com`. The hub grants tool clients
its fixed `TOOL_CLIENT_SCOPES` (openid/profile/email/offline_access/
account:read/account:write) — `data:export` and `accounts:status` are never
client scopes; `accounts:status` rides the separate `HUB_SERVICE_KEY`.

## The federation dev harness

[`docker-compose.federation.yml`](../docker-compose.federation.yml) brings
up a **local hub + a local Slideless cloud instance**, pre-wired with the
dev twin of the registry entry, so the Phase 3+ SSO work has a live
two-instance loop:

```bash
docker compose -f docker-compose.federation.yml up -d --build
curl -fsS http://localhost:3300/healthz   # hub
curl -fsS http://localhost:3310/healthz   # slideless (EDITION=cloud)
docker compose -f docker-compose.federation.yml down -v
```

- **Ports**: hub `:3300`, Slideless `:3310`, shared Mailpit UI `:8030` —
  disjoint from the standing dev stacks (template `:3000`, Slideless
  self-host `:3100`/`:8026`, hub `:3200`/`:8028`).
- **URLs**: each app's `PUBLIC_BASE_URL` is a `*.localhost` name
  (`http://hub.localhost:3300`, `http://slideless.localhost:3310`) that
  resolves to 127.0.0.1 in browsers (RFC 6761) **and** to the right
  container on the compose network (service alias), with the app listening
  on the same port inside and out — so the OIDC issuer string, the
  server-side JWKS fetch, and the browser redirects all agree. Plain `curl`
  from the host: use `localhost:3300`/`localhost:3310`.
- **Bootstrap**: run each instance's setup wizard once (hub at
  `http://hub.localhost:3300`, Slideless at
  `http://slideless.localhost:3310`). The hub logs
  `tool registry: client seeded` for `tool-slideless-cloud` at boot.
- **Secrets are dev-only literals** in the compose file. The Slideless
  `HUB_SERVICE_KEY` (the hub-gate credential, Phase 4) defaults to a
  placeholder: mint a real key on the local hub (`POST /api/v1/api-keys`
  with `scopes: ["accounts:status"]` as any hub member) and restart the app
  with `FEDERATION_HUB_SERVICE_KEY=<ant_…>`; until then the gates fail
  closed for projected workspaces after the stale window.
- The hub builds from a sibling checkout
  (`FEDERATION_HUB_DIR`, default `../../../../platform/hub`).

## What the later phases plug into this

| Phase               | Builds on this scaffolding                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3 — SSO entrance   | **Built** — the section above: `identity/hub-sso.ts` + `hub-jwt.ts`, conditional `genericOAuth` registration, `HubSsoIdentityProvider` (D1) in `edition.ts`, migration 0021. |
| P4 — hub gates      | **Built** — "The hub gates" above: `identity/hub-status.ts` + `hub-gate.ts`, the `principalGate` hook in `authContext` (ADR 016), `HubEntitlementService`, the `/suspended` notice. |
| P5 — CLI cross-tool | `POST /api/v1/sso/cli-connect` verifying hub-minted 120s JWTs; hub H3 `/sso/tool-token`.                                                                                     |

## Related decisions

- [ADR 003 — OIDC client login deferral](decisions/003-oidc-client-deferral.md):
  reserved exactly this seam (delegated login = config-level relying party;
  `auth.methods` open enum; JIT as an explicit opt-in).
- [ADR 014 — workspace-scoped principal](decisions/014-workspace-scoped-principal.md):
  the multi-workspace runtime the org projection lands on
  (`workspaces.centralAccountId`, membership `origin` discriminator).
- [ADR 015 — hub SSO assertion handoff](decisions/015-hub-sso-assertion-handoff.md):
  how the verified org assertion crosses from token verification to the
  per-login projection hook, and why it is request-scoped (race analysis).
- [ADR 016 — hub gates placement + postures](decisions/016-hub-gates-placement-and-postures.md):
  why the suspension gate + membership re-assertion run as a post-resolution
  hook in `authContext` (all three credential kinds, one seam), and the
  deliberately asymmetric failure postures (fail-closed-after-grace for org
  status, definitive-answer-only for deactivation).
- The program-level design lives in the Codika workspace:
  `workspace/knowledge/initiatives/agent-tools-platform/slideless-cloud-binding-plan.md`
  (Slideless-specific) and `cloud-edition-binding-patterns.md` (the
  tool-agnostic module the template inherits).
