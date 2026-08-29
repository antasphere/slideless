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
> Antasphere", JIT provisioning)**, **the LIVE user-scoped federation
> ("Live reconcile + grant" below — ADR 019, replacing the retired
> service-key hub gates)**, **Phase 5 (the CLI cross-tool exchange + the
> H3 grant channel)**, **Phase 6 (guest capability limits + the SSO-first
> claim)**, and **Phase 7 (hub-managed membership: the local
> membership-mutation gate + the `/me` adaptation signals — "Hub-managed
> membership" below)** are built.

## Environment contract

Full variable reference: [env-reference.md](../docs/reference/env-reference.md).
The cloud block:

| Variable            | Meaning                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EDITION=cloud`     | Selects the cloud binding. The only other accepted value is `oss` (the default); anything else refuses to boot — a typo'd selector must never silently bind the wrong edition. |
| `HUB_ISSUER_URL`    | The hub OIDC issuer, `https://account.antasphere.com` in production. Discovery, JWKS, and the authorize/token endpoints all derive from it.                                    |
| `HUB_CLIENT_ID`     | This tool's OAuth client id from the hub `TOOL_REGISTRY` entry — `tool-slideless-cloud`.                                                                                       |
| `HUB_CLIENT_SECRET` | The matching client secret (confidential client; PKCE stays on regardless).                                                                                                    |

> There is deliberately **no service key**. Everything Slideless reads from
> the hub between logins is read AS THE USER with that user's own grant
> (ADR 019) — the retired `HUB_SERVICE_KEY`/`accounts:status` apparatus was
> a cross-tenant surface and is gone from the env contract, the compose
> files, and the code.

Rules the boot enforces:

- **Fail-loud completeness**: `EDITION=cloud` with ANY of the three hub vars
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

  The OTP MINTING entrances, once wired-but-hidden, are now **closed
  outright on cloud** (the charter call ADR 017 §7 had recorded as
  KNOWN-OPEN — taken 2026-07-13, for audit completeness: every cloud
  credential, human session AND CLI key, must trace through the hub so its
  audit log is the complete access record). The emailOTP session surface —
  `/sign-in/email-otp` (the unconditional session mint),
  `/email-otp/verify-email` (mints only under
  `autoSignInAfterVerification`, unset here; closed as config insurance),
  and `/email-otp/send-verification-otp` (the mail leg — every redemption
  route is closed, so codes would only be dead letters) — answers 403
  `otp_signin_disabled` in the same Better Auth before-hook as the reset
  closure (`isOtpSignInPath`, `identity/better-auth.ts`, enumerated against
  pinned 1.6.15). The tool's own CLI OTP key mint (`POST
/cli/auth/request`, `POST /cli/auth/complete`) answers 403
  `cli_otp_disabled` steering to `antasphere login` (`api/cli-auth.ts`) —
  cloud CLI keys are minted via the hub exchange (P5, `/sso/cli-connect`,
  which is UNAFFECTED). `DELETE /cli/auth/key` — the logout SELF-revoke, a
  key killing exactly itself — deliberately stays open on both editions
  (revocation narrows access) and is machine-allowed under
  `presentations:write` in the scope allowlist. Both closures were
  hub-gated per request by the P4 re-assertion already — posture, not a
  hole.

  The **Google social provider** is the third non-SSO session entrance and
  closes the same way: `socialProviders.google` is registered ONLY when NOT
  cloud (`!hubSso` in `identity/better-auth.ts`), so a cloud instance with
  `GOOGLE_CLIENT_ID`/`SECRET` set leaves `/sign-in/social` (+
  `/oauth2/callback/google`) unregistered — 404 `PROVIDER_NOT_FOUND`,
  minting nothing. Gating on the edition rather than "operator didn't set
  the var" makes the audit guarantee hold by construction (defense in depth
  against misconfiguration). The rule: **no non-SSO session entrance on
  cloud except the deliberate break-glass `/sign-in/email`.** On `oss` the
  OTP login, the CLI mint, AND Google social are unchanged.

  The password RESET surface is likewise **closed outright on cloud**
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

## The SSO entrance (Phase 3, reshaped by ADR 019): flow, JIT, the grant

One codepath, owned by `apps/server/src/identity/hub-sso.ts` (plus
`hub-jwt.ts` for token verification) and registered by
`identity/better-auth.ts` **only when `hubConfig()` is non-null** — an oss
boot instantiates none of it (`POST /sign-in/oauth2` is a 404 there).

```
Browser → /login → "Sign in with Antasphere"
  → POST /api/v1/auth/sign-in/oauth2 {providerId: antasphere}
  → hub /authorize (confidential client, PKCE,
    scope=openid profile email offline_access account:read)
  → hub login (or live hub session) → code, CONSENT-FREE for registry
    (first-party) clients — skipConsent, see "The hub registry entry";
    DCR/MCP third-party clients still get the full consent page
  → /api/v1/auth/oauth2/callback/antasphere
  → token exchange WITH resource=<HUB_ISSUER_URL>/mcp (RFC 8707, the
    `tokenResource` seam constant): the access token is HUB-audienced — a
    bearer for the hub's own /api/v1, never claim-bearing for Slideless
  → identity from the ID TOKEN ONLY (iss=HUB_ISSUER_URL,
    aud=HUB_CLIENT_ID, RS256, remote JWKS)
  → JIT: user created (emailVerified from the hub's verified claim) or
    linked (D9); Better Auth persists the GRANT (access + refresh token,
    encrypted) on the account row
  → the FAIL-CLOSED login reconcile: one forced as-the-user
    `GET <hub>/orgs` with the callback access token projects ALL the
    user's orgs (reconcile IS the projection — a pass that does not
    definitively succeed revokes the session:
    /login?error=sso_projection_failed)
  → ordinary local session cookie. Between logins the user's own grant
    keeps org truth live (the reconcile below).
```

Per-login semantics (every SSO login, returning users included — ADR 019
has the full design):

- **Projection via reconcile**: every org on the user's hub list becomes /
  updates a workspace — `workspaces.centralAccountId` = the hub org id,
  name synced, a **unique partial index** (migration 0021) + `ON CONFLICT`
  making concurrent first-logins land on one row. Orgs the hub no longer
  asserts are swept in the same pass.
- **Roles verbatim (D11)**: role = the hub org role **verbatim**
  (owner/admin/member map 1:1; an unknown role is kept-alive but never
  synced — local roles are never invented), `origin='hub'`, reactivated if
  the hub asserts it again.
- **Email sync (D10)**: the local email follows the hub's verified email; a
  collision with another local user fails the login cleanly
  (`/login?error=sso_email_conflict`) instead of corrupting either account.
- **Fail closed**: any bad id_token (foreign iss/aud, expired, malformed
  claims) or failed per-login step — the reconcile pass included — means
  NO session: a cloud login without its projection never exists.
- **Self-healing grant**: every returning login re-writes the account
  row's tokens, so one browser SSO heals a dead grant
  (`hub_grant_expired` recovery).

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

## Live reconcile + grant (ADR 019): between-logins truth, as the user

The SSO entrance asserts hub truth **at login** — but tool sessions live
365 days and API keys/OAuth grants longer, so between logins three things
must stay true: an org **created/renamed/removed** at the hub is
reflected here, a user **removed** from a hub org (or whose role changed)
loses/gains the matching access, and a **suspended** org stops working —
all without any cross-tenant credential. The mechanism is the user's OWN
grant:

- **The grant** (`identity/hub-grant.ts`): the `offline_access
account:read` refresh token from SSO login, persisted ENCRYPTED on the
  `account` row (`encryptOAuthTokens: true`). Refreshes present
  `resource=<hub>/mcp` so the hub mints RS256 JWTs its own `/api/v1`
  accepts, and are single-flighted in-process AND cross-replica
  (`pg_advisory_lock(7432004, hashtext(userId))` on a dedicated client,
  re-read-after-lock, ~10 s watchdog) — the hub rotates refresh tokens
  with RFC 9700 reuse detection, so an unserialized double-refresh would
  tear the user's whole grant family down. Failure taxonomy: the token
  endpoint's `invalid_grant` is the ONLY thing that marks a grant dead
  (tokens nulled on the row; a browser re-login heals); `invalid_client`
  (our misconfiguration) and network/5xx are loud transients that never
  kill grants.
- **Ambiguous refresh outcomes probe, never re-present (PRDCT-1370)**:
  the hub rotates BEFORE it answers and cannot roll back, so a refresh
  whose answer never arrived (the 5 s client timeout, a lost response, a
  5xx after the commit) leaves Slideless holding a token the hub may
  already have rotated out — and presenting it again IS the reuse
  teardown above, reachable with no attacker, only a hub that is slow but
  alive (and it kills the user's CLI grant too, same client id). So every
  presentation is recorded first (`hub_grant_presentations`: the account
  row + the ciphertext presented) and cleared only once the hub's answer
  is known. A surviving record makes the next refresh PROBE the token
  through the hub's RFC 7662 `/oauth2/introspect`
  (`token_type_hint=refresh_token`; read-only — the pinned plugin answers
  `active:false` for a rotated-out token without touching the family)
  and present it only if the hub still calls it active; `active:false`
  marks the grant dead WITHOUT presenting (the family lives on; a browser
  re-login heals this user); a failed probe is transient and keeps the
  record. `invalid_client` clears the record: the hub validates the
  client before it rotates, so that token was not consumed. The record is
  inert by construction after a browser re-login (different ciphertext).
  Counter outcomes: `probe_live`, `probe_dead`, `probe_transient`.
- **The reader** (`identity/hub-user-client.ts`): `GET <hub>/api/v1/orgs`
  with the user's token — the hub's caller-scoped list (`status` +
  `isDefault` included). There is NO target-user parameter anywhere: a
  cross-tenant read is structurally impossible on this path. A 401/403
  gets exactly one forced-refresh retry; everything not a definitive 200
  list is one loud, fail-open `inconclusive`.
- **The reconciler** (`identity/hub-reconcile.ts`): one pass makes local
  projections match the list — deactivation sweep FIRST (removal wins
  within a pass; one audited `member.deactivate` per flip), then
  project/upsert every entry (names, roles verbatim, org-level
  `workspaces.hub_status`, the user's `workspace_members.is_default`).
  Per-user TTL cache (~10 s) + single-flight + failure re-probe throttle;
  the cache is in-memory PER REPLICA (a replica restarted mid-outage
  fails closed for its first request per user — deliberate).

**Where enforcement runs.** `authContext` — the single credential resolver
every `/api/v1` request passes through — runs the post-resolution
`principalGate` (the seam ADR 016 placed; the gate is new). The cloud
binding supplies `identity/hub-live-gate.ts` (wired by `bindEditionSeams`);
oss wires nothing. Sessions, API keys, and OAuth bearers all pass the same
gate — MCP tool calls included (they re-enter `/api/v1` in-process). On
every request into a PROJECTED workspace by a hub-origin principal the
gate runs the cached reconcile and judges the freshly reconciled LOCAL
rows:

| State                                                            | Verdict                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| grant definitively dead                                          | **401 `hub_grant_expired`** immediately (no stale window) — re-auth heals it |
| no definitive pass in ~15 min AND the hub keeps failing          | **403 `hub_unavailable`** (fail closed after the stale window)               |
| hub-origin membership row inactive (this pass may have swept it) | **401 `membership_revoked`**                                                 |
| workspace `hub_status='suspended'`                               | **403 `account_suspended`** — EXCEPT `GET /me` (visible-but-blocked)         |
| role delta on the reconciled row                                 | applies to THIS request (a demoted hub admin loses admin surfaces now)       |

Guest and local-origin rows in a projected workspace skip hub enforcement
(their rows are the tool's own business) EXCEPT org-level suspension,
which reads the locally materialized `workspaces.hub_status` column —
never a hub round-trip on a borrowed grant. **Accepted bound**: a guest's
own `/orgs` never includes the deck's org, so that column refreshes only
when a MEMBER's reconcile runs — a guest may keep deck access in a
hub-suspended org until a member next touches Slideless (ADR 019 has the
full rationale; suspension still cuts all MEMBERS within seconds).

**Propagation bounds**: org create/rename/remove, role changes, and
suspension all land within the reconcile TTL (~10 s) per replica; a
removal also ends sessions/keys/bearers instantly at the next resolution
(the live-membership re-check). During a hub outage, last-known state
serves for up to ~15 min, then requests fail closed until the hub
recovers — recovery is automatic, nothing is corrupted.

**Unknown-workspace retry**: a request naming a workspace the local rows
do not grant runs ONE cached reconcile and one re-lookup (the
`onWorkspaceMiss` hook, all three credential kinds) — a hub org granted
seconds ago resolves on first use; a garbage selector stays a fail-closed
401 and cannot hammer the hub (it rides the reconciler's TTL + throttle).

Counters `hub_reconcile_passes_total` + `hub_grant_refreshes_total`
surface pass/refresh outcomes on `/metrics`. Known bounds, on purpose:
anonymous share-link viewing (`/v/{secret}`) is not gated — it is not an
authenticated workspace surface; revoke share tokens to cut it. The MCP
transport handshake itself is not gated either; every MCP tool call is,
since it re-enters `/api/v1`.

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

**The exchange pair (pinned contract with H3)**: a 120 s RS256 JWT signed
by the hub's OIDC key — `iss` = the hub issuer, `aud` = THIS instance's
resource URL (`<PUBLIC_BASE_URL>/mcp`), `sub` = hub user id, `email`, a
discriminator `purpose: 'sso-connect'`, and a unique `jti` — PLUS
`hubRefreshToken`: a raw one-time offline-grant refresh token
(`offline_access account:read`, 365 d) the H3 response mints alongside.
The CLI forwards both. The JWT's transitional org claims (kept by the hub
through its compat window) are deliberately NEVER read — org truth comes
from the connect-time reconcile. Redeeming `hubRefreshToken` requires the
TOOL CLIENT's own credentials at the hub token endpoint (confidential
client), so a leaked body alone buys nothing.

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
the D9 trusted link (verified local emails only), the D10 email sync —
then the H3 grant is stored ENCRYPTED on the account row
(`HubGrantService.acquireFromConnect`, the same row a browser login
writes) and the SAME fail-closed reconcile as a browser login projects
the user's orgs as-the-user. Only a definitive pass mints: a USER-scoped
`slk_` key (`workspaceId: null` — the org is a per-request parameter),
scopes `presentations:read presentations:write` (never `data:export`),
named "Antasphere CLI `<date>`", audited, returned once. **Never a
born-dead key**: no grant carried and none stored → `403
hub_grant_missing` with steering (re-run `antasphere login` with a
current CLI, or one browser SSO); a dead grant → the same refusal; zero
usable memberships after the pass → `403 no_membership`; a transient hub
failure → 500, re-exchange. Day-to-day CLI calls are then the ordinary
local API-key path, kept live by the stored grant exactly like a browser
user's; `slideless logout` is the tool's own key revocation
(`DELETE /cli/auth/key` — the presenting key revokes exactly ITSELF,
machine-allowed under `presentations:write`; the one `/cli/auth` route
open to machines, and open on both editions).

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

## The seamless session layer (SL-1…SL-6): silent connect, single logout, the hint, onboarding

The "one concept of being logged in" layer on top of ADR 019: a live hub
session means every tool is already connected; logout anywhere ends the
whole thing. Tool sessions are invisible, short-lived PROJECTIONS of the
hub anchor — never a second thing the user manages. Everything below is
discovery-gated (`instance.auth.sso` presence + the `antasphere` method),
never edition-sniffed; on oss none of it exists on the wire or in behavior.

### The hint cookie (cross-repo contract; NEVER a security input)

`ant_sso_hint` (value `1`, `Domain=` the shared parent — issuer host minus
its first label — `Path=/`, `SameSite=Lax`, `Secure` on https, NOT
HttpOnly, ~365 d). The HUB sets it on every session-minting response and
re-asserts it on live `GET /get-session` (healing tool-side clears); it is
cleared on hub sign-out and `/oauth2/end-session`. TOOLS read it
client-side as a hint and clear it (a) on single logout and (b) when a
silent attempt answers the login_required family (a stale hint). Discovery
advertises the tool's view as
`instance.auth.sso = {hintCookieName, hintCookieDomain}`
(`HUB_HINT_COOKIE_NAME` / `HUB_HINT_COOKIE_DOMAIN`, cloud-validated in
env.ts) — absent on oss.
Security posture: the hint only decides whether a silent `prompt=none`
bounce is WORTH ATTEMPTING. Forging it buys one harmless redirect (the hub
session check is the real gate); deleting it buys a login page. Nothing
authorizes off it, on either side.

### The silent auto-connect lattice (SL-3, dashboard)

`$lib/sso.ts` (pure, unit-pinned) gates the zero-click connect; the guard
lives in the LOGIN PAGE only — the (app) guard already funnels
unauthenticated visitors to `/login?next=…` with the destination intact,
and /setup, /invite, /collab, /oauth/consent stay untouched by
construction. Gates, in order: **A** posture (`auth.sso` present AND
methods include `antasphere`), **B** hint cookie present, **C** no
`?error=` / `?signed_out=` param, **D** no fresh per-tab attempt marker
(`sessionStorage["sso.attempt"]`, ~2 min TTL, written BEFORE navigating,
cleared by a signed-in bootstrap), **E** no live session. When they all
pass, the page renders the branded connecting interstitial (it owns the
screen on every visible leg; the app-shell splash covers the callback
return) and fires `signIn.oauth2({providerId:'antasphere', callbackURL:
safeNext(next), errorCallbackURL:'/login', additionalData:{prompt:'none'}})`
— the server whitelist (`identity/hub-sso.ts`) forwards ONLY the literal
`prompt=none` pair, and the cloud-gated `onAPIError.errorURL` lands AS
errors on `/login?error=…`. Every known redirect cycle is bounded: an AS
silent-failure (login_required / interaction_required /
account_selection_required / consent_required) → gate C + the stale hint
is CLEARED, no error banner; the after-hook's fail-closed
`sso_projection_failed` → gate C (banner stays — that one is real); a
logout landing (`?signed_out=1`, quiet notice) → gate C with no hint left
anyway; anything unforeseen → gate D's one-attempt-per-tab-per-TTL.

### Return-to-origin (decision 7)

Ordinary logins (interactive AND silent) land on the exact deep link via
`callbackURL=safeNext(next)` in the OAuth state. Journeys that OUTLIVE the
~10-min state row — signup → email verification → hub `/verified`
"Continue to Slideless" CTA → tool ROOT — ride
`localStorage["sso.pendingNext"]` (~1 h TTL): written on EVERY tool→hub
redirect (a root write never clobbers a fresh deeper value — the CTA
re-entry dances again from `/`), consumed EXACTLY ONCE by the root layout
after a signed-in bootstrap, navigating only from the app root (so an
/invite or /collab landing is never hijacked). `safeNext` applies on write
AND on consume; the value is cleared on consume, expiry, and logout.

### Single logout (SL-2 server + SL-4 client) and the hint-watch

`POST /api/v1/sso/logout` (cloud-mounted only; sessions only — unlisted in
the machine scope allowlist; zero-membership sessions included) responds
having ALREADY revoked the local session (Set-Cookie forwarded) and
cleared the hint; its `{url}` is the hub `end-session` leg the browser
then visits, or null (degrade: straight to `/login?signed_out=1`). The
client (`session.ts signOutToLogin`) is edition-adaptive off discovery:
oss is byte-identical to the pre-SSO behavior; cloud does the POST, a
belt-and-braces client-side hint clear, then `location.assign`. ANY
failure degrades to local signout + hint clear + the signed-out landing —
the two never fail together, so the insta-relogin trap is closed twice
over (`?signed_out=1` is lattice gate C; the cleared hint is gate B).
Building the hub leg (`identity/hub-logout.ts`) leans on two pinned 1.6.15
facts — re-verify on ANY bump: the stored id_token is PLAINTEXT on the
account row (`encryptOAuthTokens` covers access/refresh only; the read is
encrypted-tolerant anyway), and the hub's end-session HARD-FAILS a
sid-less `id_token_hint`, so pre-flip tokens degrade to local-only signout
here instead of bouncing the user through a hub error (rollout caveat: one
re-login stores a sid-bearing token).

Convergence for OPEN tabs is the hint-watch (`$lib/hint-watch.ts`, wired
in the root layout): on bootstrap + visibilitychange→visible (throttled
≥30 s), a signed-in tab signs itself out iff `auth.sso` is present AND
`me.via === 'session'` AND `me.ssoOnly === true` AND the hint cookie is
absent. `ssoOnly` (cloud+session-only `/me` field) is true iff the user
holds an `antasphere` account row and NO credential account — a
break-glass-capable operator is NEVER ssoOnly, so the watch cannot sign
out an operator; on oss the field (and the posture gate) make it inert.
Cloud tool sessions are 30 d FIXED (SL-5) so every tool re-derives from
the sliding hub anchor; the anchor is what actually expires people.

### First-run onboarding (SL-6): tool-local, retry-safe

`/me` gains cloud+session-only `firstRunPending` — true iff NO
`user_onboarding` row with a dismissal exists (`NOT EXISTS (dismissed_at
IS NOT NULL)`), so a transiently-lost first-login insert still shows the
welcome next time and ONLY an explicit `POST /me/onboarding/dismiss` (or
the deploy backfill for pre-existing users) hides it. The dashboard's
WelcomeBanner is the seam (content is a placeholder for the content
pass). The hub's `tool_first_login` id_token claim is ADVISORY ONLY —
ecosystem analytics live in the hub's `user_tool_usage` table; no tool
behavior may hang on the claim flipping exactly once.

## The hub registry entry (what the HUB operator configures)

The hub seeds first-party tool clients from its `TOOL_REGISTRY` env var
(inline JSON) or `TOOL_REGISTRY_FILE` (path, wins over inline) at every boot
— idempotent upsert, and the seeded client ids are pinned so the hub's
client-management API refuses to mutate them. Each entry's `resourceUrl`
joins the hub's token-audience allowlist (`validAudiences`). Registry
clients are FIRST-PARTY: consent is skipped for them (`skipConsent: true` —
a tool account IS an Antasphere account, so there is nothing to consent to;
user-scoped grants carry no org, so no picker either), they enable
RP-initiated logout (`enableEndSession: true`, which puts `sid` in their
id_tokens), and their `postLogoutRedirectUris` pin the tool's
`/login?signed_out=1` landing EXACTLY. DCR/MCP third-party clients keep the
full consent dance — the skip is registry-only, keyed on the forge-proof
`metadata.tool` marker.

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
    "postLogoutRedirectUris": ["https://slideless.antasphere.com/login?signed_out=1"],
    "launchUrl": "https://slideless.antasphere.com/",
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
account:read/account:write) — `data:export` is never a client scope, and
there is no service key: every hub read is as-the-user (ADR 019).

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
- **Secrets are dev-only literals** in the compose file. No service key
  exists to mint or wire: the live federation reads the hub as each
  signed-in user (their own grant), so the two client credentials are the
  entire glue.
- The hub builds from a sibling checkout
  (`FEDERATION_HUB_DIR`, default `../../../hub` — the workspace's
  `labs/products/antasphere/hub` as seen from
  `labs/products/antasphere/tools/slideless/<checkout>`; a worktree of the
  hub is pointed at with the variable).
- **The federation drill** ([`scripts/federation-drill.sh`](../scripts/federation-drill.sh),
  PRDCT-1370) is the harness's automated use: it boots this stack plus the
  [`docker-compose.federation.drill.yml`](../docker-compose.federation.drill.yml)
  overlay (a delay hop between Slideless and the hub, run from the Slideless
  image itself, so the hub can be made slow-but-alive on demand), runs both setups and a headless SSO
  login (registry tools skip the hub's consent screen, so the whole dance
  is `curl`), and asserts on the HUB's database — the only place the
  grant-family consequences are visible. CI runs it on both repos
  (`federation-drill` jobs); locally: `./scripts/federation-drill.sh`.

## What the later phases plug into this

| Phase                       | Builds on this scaffolding                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3 — SSO entrance           | **Built** — the section above: `identity/hub-sso.ts` + `hub-jwt.ts`, conditional `genericOAuth` registration, `HubSsoIdentityProvider` (D1) in `edition.ts`, migration 0021.                                                               |
| Live federation (ADR 019)   | **Built** — "Live reconcile + grant" above: `identity/hub-grant.ts` + `hub-user-client.ts` + `hub-reconcile.ts` + `hub-live-gate.ts` on the `principalGate` hook in `authContext`; the retired P4 service-key gates are deleted.           |
| P5 — CLI cross-tool         | **Built (tool side)** — "CLI cross-tool connect" above: `api/sso-connect.ts` + `HubSsoService.verifyConnectToken/provisionConnect` + `acquireFromConnect`, jti ledger migration 0022; hub H3 `/sso/tool-token` + cli-core wiring hub-side. |
| P6 — guests                 | **Built** — "Guests" above: `origin='guest'` capability boundary (`requireNonGuest`), SSO-first claim on cloud, role lock.                                                                                                                 |
| P7 — hub-managed membership | **Built** — "Hub-managed membership" above: `middleware/hub-managed.ts` gate on `/members` + `/invitations` mutations, `/me` adaptation fields (`hubOrigin`, `origin`, `hubManageUrl`), dashboard link-out. No migration; MCP unchanged.   |

## Related decisions

- [ADR 003 — OIDC client login deferral](decisions/003-oidc-client-deferral.md):
  reserved exactly this seam (delegated login = config-level relying party;
  `auth.methods` open enum; JIT as an explicit opt-in).
- [ADR 019 — user-scoped credentials & live hub federation](decisions/019-user-scoped-live-federation.md):
  THE capstone — the as-the-user grant/reconcile model, the failure
  postures, the accepted bounds, the no_link/purge hard constraint, and
  the atomicity affirmation mirrored with hub ADR 014.
- [ADR 014 — workspace-scoped principal](decisions/014-workspace-scoped-principal.md):
  the multi-workspace RUNTIME the projections land on
  (`workspaces.centralAccountId`, membership `origin` discriminator); its
  mint-time binding half is superseded by ADR 019.
- [ADR 015 — hub SSO assertion handoff](decisions/015-hub-sso-assertion-handoff.md)
  and [ADR 016 — hub gates placement + postures](decisions/016-hub-gates-placement-and-postures.md):
  superseded by ADR 019 — kept for the login-scope handoff pattern, the
  race analysis, and the principalGate placement rationale.
- The program-level design lives in the Codika workspace:
  `workspace/knowledge/initiatives/agent-tools-platform/slideless-cloud-binding-plan.md`
  (Slideless-specific) and `cloud-edition-binding-patterns.md` (the
  tool-agnostic module the template inherits).
