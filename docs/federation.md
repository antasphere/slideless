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
> Antasphere", JIT provisioning, lazy org projection — ADR 015)**,
> **Phase 4 (the hub gates: org suspension + membership re-assertion —
> "The hub gates" below + ADR 016)**, **Phase 5 (the CLI cross-tool
> exchange)**, **Phase 6 (guest capability limits + the SSO-first claim)**,
> and **Phase 7 (hub-managed membership: the local membership-mutation
> gate + the `/me` adaptation signals — "Hub-managed membership" below)**
> are built.

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
  The local password SIGN-IN stays **wired but hidden**: the break-glass
  CLI remains the operator door, and blocking `/sign-in/email` would
  dead-end it (pinned by an edition integration test).

  The password RESET surface, by contrast, is **closed outright on cloud**
  (the P8 close, ADR 017): `/request-password-reset`, `/reset-password`
  (POST and the tokened GET callback), and the emailOTP reset routes
  (`/email-otp/request-password-reset`, `/email-otp/reset-password`, the
  deprecated `/forget-password/email-otp`) all answer 403 — refused in the
  Better Auth before-hook (`identity/better-auth.ts`), with
  `sendResetPassword` never wired on cloud as defense in depth. Rationale:
  a hub-JIT user has no credential account; an open reset surface would let
  mailbox control SET a local password and mint `/sign-in/email` sessions
  that skip the per-login SSO re-sync (P4's re-assertion still gates every
  such session — this is posture, not an open hole). The admin
  `/members/{id}/reset-link` mint refuses too (403
  `password_reset_disabled` on cloud-LOCAL workspaces; hub-origin ones
  already die at the P7 gate) — otherwise it would mint links that dead-end
  on the refused `/reset-password`. Break-glass is unaffected: it needs
  `/sign-in/email` + the setup password, never a reset. An operator who
  forgets the setup password recovers via hub SSO (D9 links the verified
  hub identity) or, with the hub gone too, DB surgery — the accepted D1
  trade. On `oss` the entire reset surface is unchanged.

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

## CLI cross-tool connect (Phase 5): `POST /api/v1/sso/cli-connect`

One hub login serves every tool CLI (the gcloud model, D4): `antasphere
login` mints a hub `ant_` key once; when the `slideless` CLI needs a
credential for a cloud instance, cli-core asks the hub's H3 endpoint
(`POST {hub}/api/v1/sso/tool-token`, scope `sso:exchange`) for a
**short-lived exchange JWT** and presents it here. The endpoint —
`api/sso-connect.ts`, registered ONLY on `EDITION=cloud` (an oss instance
answers 404; the path never exists there) — is **public** (tier 2, listed
in `PUBLIC_API_PATHS`): the hub JWT is the only credential, so verification
is the entire security story.

**The exchange token (pinned contract with H3)**: a 120 s RS256 JWT signed
by the hub's OIDC key — `iss` = the hub issuer, `aud` = THIS instance's
resource URL (`<PUBLIC_BASE_URL>/mcp`), `sub` = hub user id, the
`membershipAccessClaims` org payload (`workspace_id`, `role`, `email`,
`workspace_name`), a discriminator `purpose: 'sso-connect'`, and a unique
`jti`.

**Verification chain** (`HubSsoService.verifyConnectToken`, every link
fail-closed, one uniform 401 for every rejection):

1. hub-JWKS signature + hard `iss`/`aud` pinning + RS256 allowlist + expiry
   (`HubJwtVerifier` — the same trust anchor as the SSO login). A token for
   another tool fails `aud`; anything this instance minted itself (MCP
   access tokens) fails `iss`.
2. `exp`, `purpose === 'sso-connect'`, and `jti` are REQUIRED — a flow-(a)
   hub access token carries no `purpose` and dies despite matching iss/aud.
3. **jti one-time-use**: consuming a token INSERTs its jti into the
   `sso_connect_jtis` table (migration 0022); the primary-key conflict IS
   the replay signal — Postgres-backed, so multi-replica safe. Claim-first:
   the jti burns BEFORE provisioning, so a replay (even concurrent) can
   never mint a second key; a transient provisioning failure costs one
   fresh hub exchange.

**On success** the user is JIT-provisioned through the SAME
`HubSsoService` path as a browser SSO login — the internal adapter's
`createOAuthUser` (the `user.created` hook and collaborator sweep fire),
the D9 trusted link (verified local emails only), the D10 email sync, and
the lazy projection + `origin='hub'` membership upsert — then an ordinary
`slk_` key is minted, bound to the ONE projected workspace, scopes
`presentations:read presentations:write` (never `data:export`), named
"Antasphere CLI <date>", audited like `/cli/auth/complete`, returned once.
Day-to-day CLI calls are then the ordinary local API-key path — the hub is
out of the loop until the next exchange; `slideless logout` is the tool's
own key revocation.

## Guests (Phase 6): capability limits + the SSO-first claim

An external party invited to ONE deck (a per-deck collaborator, ADR 013)
becomes a `workspace_members` row because principal resolution requires a
membership — stamped **`origin='guest'`**. Phase 6 makes that origin a
**capability boundary (decision D2, BOTH editions — a deliberate change to
shipped self-host behavior)**:

- **What a guest keeps**: everything their grant opens on THAT deck — read
  (404-not-403 privacy unchanged; `canReadDeck` keys on the grant, never
  the membership), version pushes + asset staging, share tokens,
  annotations — with a session, their own API key, or an MCP token alike
  (every credential path reads `origin` live from the membership row into
  the `Principal`).
- **What a guest is refused** (`requireNonGuest`, 403 `guest_forbidden`):
  deck **creation** in the host workspace (`/presentations/uploads` +
  commit), the generic **`/files`** surface (reads included — it spans
  every workspace blob with no per-deck authorization, a deck-content
  bypass for an outsider), the **member roster**, and the **workspace
  export** (in front of the admin gate, defense in depth). On cloud the
  same guest creates decks freely in their OWN projected workspace — the
  capability keys on the origin of the membership backing the request's
  workspace.
- **The role is locked**: a guest row cannot be promoted
  (`guest_role_locked`) — origin is an axis nothing upgrades (the hub
  never re-asserts guest rows, SSO never touches them), so a "guest admin"
  half-state cannot exist. Deactivating/reactivating a guest stays an
  admin act. To empower the person, invite them as a real member.

**The cloud claim flow (SSO-first).** On `EDITION=cloud` the claim
endpoint's account-creation branch is CLOSED (409 `sso_required` — keyed on
the same `hubSso` presence switch as every cloud seam, so oss keeps the
exact local-password behavior and provably carries no hub surface here).
The claim page (`/collab/{token}`) routes a new invitee through **"Sign in
with Antasphere"** — the SAME Phase 3 entrance as any cloud login (JIT +
the deliberate fourth signup switch), opening no new signup hole — and
completes the claim signed-in (the hub-verified email must equal the grant
email). **No hub org membership is created anywhere in this path**: the
guest ends with their own projected workspace (`origin='hub'`) plus the
`guest` row in the deck's workspace, which stays unprojected.

**The cross-request sweep (G1 residual, closed here).** The JIT login's
`user.created` sweep flips the pending grant to ACTIVE before the claim
POST arrives (same shape: a sibling grant swept at signup). The pending-only
public lookup deliberately stays blind to active grants — widening it would
leak deck metadata for used tokens — so the CLAIM path alone resolves an
active grant **for its owner's session only**
(`findActiveByClaimTokenFor`) and still runs the membership-insert block
(the sweep flips grants but never mints memberships). To everyone else a
used token stays indistinguishable from an invalid one; the dashboard
claim page retries the claim once when a "dead" lookup meets a live
session before showing the dead screen.

## Hub-managed membership (Phase 7): local mutation surfaces on projected workspaces

A hub-origin workspace (`workspaces.centralAccountId IS NOT NULL`) takes its
membership from the hub: invites, roles, and removals happen at
`account.antasphere.com` and flow in via SSO login (Phase 3) and the H2
re-assertion (Phase 4). Slideless still ships the self-host era's full local
`/members` + `/invitations` management — on cloud, a local mutation of a
PROJECTED org's membership would create divergence the next login or
re-assertion fights. Phase 7 closes that:

- **Every local membership MUTATION on a hub-origin workspace answers
  `403 hub_managed`** with `details.manageUrl` → the hub (the `HUB_ISSUER_URL`
  origin): invitation create/accept/revoke, member role-change /
  deactivate / reactivate / delete, reset-link, change-email-link. 403, not
  410: the member rows demonstrably exist (reads serve them) — what is
  denied is the operation's LOCAL authority, for every caller, regardless
  of role (`middleware/hub-managed.ts` has the full rationale).
- **Reads stay**: `GET /members` serves the projected roster (it is real
  and useful), `GET /invitations` lists.
- **The gate keys on `principal.accountRef`** — populated by every
  credential resolver from a live join on the request workspace's
  `centralAccountId` (the same signal as the Phase 4 gates) — and is
  method-keyed, mounted once on the whole `/members` and `/invitations`
  subtrees (collection roots included), so any future mutation under those
  surfaces is refused by default. The public invitation
  accept/lookup segments are principal-less; the accept handler checks the
  INVITATION's workspace instead (defense in depth — the create gate means
  no such invitation can exist through the API).
- **Cloud-LOCAL workspaces are untouched**: the operator's own setup
  workspace and every deck workspace holding guests have
  `centralAccountId NULL` — local management (and the public invitation
  accept) works there exactly as on oss. The boundary is the workspace's
  projection, never the edition alone. **oss is byte-identical**: the gate
  is wired only behind the `hubConfig` presence switch.
- **Guests on a projected workspace**: the membership PATCH surface being
  hub-managed includes guest rows — cutting a guest there goes through the
  sanctioned per-deck collaborator surface (uninvite/revoke, ADR 013),
  which cuts content access immediately and stays open on ALL workspaces.
- **Machine credentials** never reached these surfaces anyway: `/members`
  and `/invitations` are deliberately unlisted in the fail-closed scope
  allowlist (`middleware/scopes.ts`) — keys/tokens get
  `403 endpoint_not_allowed` before this gate is even consulted.
- **The dashboard adapts off `/me`, never edition-sniffing**: `GET /me` now
  carries `workspace.hubOrigin` (+ a per-entry `hubOrigin` on
  `workspaces[]`, booleans — the raw hub org id is never exposed), the
  caller's membership `origin` (`local|hub|guest`), and `hubManageUrl` (the
  link-out target; null on oss and on local workspaces). On hub-origin
  workspaces the member/invitation management affordances disappear behind
  a "Manage at Antasphere" link (the roster stays read-only visible);
  guests additionally lose the guest-forbidden affordances (members/files
  nav, deck creation) and the deck page skips its roster fetch.
- **MCP needs no changes**: the instance stays its own OAuth 2.1 AS for
  `/mcp`, tokens are minted and verified locally, and every tool call
  re-enters `/api/v1` in-process — the scope allowlist, the guest gate, and
  this gate all apply unchanged. No MCP tool touches `/members` or
  `/invitations`; the per-deck collaborator tools are the sanctioned pair.

The last-owner guard never fights this: projected workspaces are exempt
(D11) — ownership is asserted hub-side, local membership mutation is
disabled here, and the projection re-asserts on next login, so no ownerless
limbo exists.

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
| P5 — CLI cross-tool | **Built (tool side)** — "CLI cross-tool connect" above: `api/sso-connect.ts` + `HubSsoService.verifyConnectToken/provisionConnect`, jti ledger migration 0022; hub H3 `/sso/tool-token` + cli-core wiring land hub-side. |
| P6 — guests         | **Built** — "Guests" above: `origin='guest'` capability boundary (`requireNonGuest`), SSO-first claim on cloud, role lock. |
| P7 — hub-managed membership | **Built** — "Hub-managed membership" above: `middleware/hub-managed.ts` gate on `/members` + `/invitations` mutations, `/me` adaptation fields (`hubOrigin`, `origin`, `hubManageUrl`), dashboard link-out. No migration; MCP unchanged. |

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
