# ADR 019 — User-scoped credentials & live hub federation

Status: accepted (2026-07-15). **Supersedes ADR 015 (SSO assertion
handoff), ADR 016 (hub gates), and the federation half of ADR 017**; ADR
014's multi-workspace RUNTIME (one-workspace Principal, `X-Workspace-Id`
selection, live membership re-check, `origin` discriminator, projection
machinery) survives as this model's substrate — what ADR 014 pinned at
mint time is what this ADR unpins. The counterpart hub decision is hub ADR
014 (user-scoped credentials); the two were designed as one boundary flip
and their affirmations are deliberately mirrored.

## Context

Two forces broke the previous federation design:

1. **The master-key drill.** The prior hub↔Slideless federation (now only
   on `archive/2026-07-14-master-key-federation` in both repos) showed a
   user's org list between logins by calling hub endpoints with a
   cross-tenant service key (`accounts:status`, passing a target-user id).
   A live adversarial drill proved an ordinary open-signup hub user could
   mint such a key from their own personal org and harvest another
   tenant's org list and email roster. The lesson is structural: **any
   credential that can read across tenants on behalf of an unauthenticated
   third party is a standing oracle**, whatever convention governs its
   minting. Even dev's narrower P4 gates (org-status + member-status reads
   under `HUB_SERVICE_KEY`) were cross-tenant surfaces of the same class.
2. **The propagation need.** Cloud Slideless must stay live-consistent
   with the hub — an org created at the hub appears here, a removal
   revokes, a suspension blocks — without waiting for the next login and
   without ANY cross-tenant credential.

The only shape that satisfies both is **as-the-user**: Slideless holds
each user's OWN hub grant and asks the hub what THAT USER may see. And an
as-the-user grant bound to one consent-time org dies when the user leaves
that org — so the credential model itself had to flip with it, both
editions, no carve-outs (a half-migrated auth boundary is where bugs
hide).

## Decision

**A credential — session, `slk_` API key, OAuth/MCP bearer — identifies a
USER. Every request resolves exactly ONE workspace, chosen per request by
one shared rule (`identity/resolve-membership.ts`: explicit
`X-Workspace-Id` fail-closed → the user's default → oldest active) and
authorized against that user's live memberships: local rows on oss,
live-hub-truth-reconciled rows on cloud.** The Principal still carries one
`workspaceId`; every scoping query, audit row, and idempotency key
survives unchanged. API keys keep an OPTIONAL workspace pin (least
privilege + the grandfathered binding of pre-flip keys — migration 0023,
never silently widened); OAuth consent means "act as you" (no workspace
binding, no picker); MCP tools take an optional `workspace` argument
mapped to the header at the in-process re-entry.

On **cloud**, org/membership truth lives ONLY at the hub and flows in
as-the-user:

- **The grant** (`identity/hub-grant.ts`): SSO requests `openid profile
email offline_access account:read`; Better Auth persists the tokens on
  the `account` row (encrypted — `encryptOAuthTokens: true`); refreshes
  present `resource=<hub>/mcp` (RFC 8707, the ONE `tokenResource` seam
  constant shared with the SSO code exchange) so the hub mints RS256 JWTs
  its own `/api/v1` accepts. Refresh is single-flighted in-process AND
  cross-replica (`pg_advisory_lock(7432004, hashtext(userId))` on a
  dedicated client, re-read-after-lock, watchdog) because the hub rotates
  refresh tokens with RFC 9700 reuse detection — a double-refresh is a
  grant-family-killing event, not a race.
- **The reader** (`identity/hub-user-client.ts`): `GET <hub>/api/v1/orgs`
  with the user's own token. Caller-scoped by construction — there is no
  target-user parameter anywhere; a cross-tenant read is structurally
  impossible on this path.
- **The reconciler** (`identity/hub-reconcile.ts`): one pass makes local
  projections match the user's full hub org list — project missing orgs,
  sync names/roles/`hub_status`/`is_default`, deactivate `origin='hub'`
  rows the hub no longer asserts (sweep first, so removal wins within a
  pass). Login runs the TTL-bypassing `forceReconcile` FAIL-CLOSED (a
  cloud login whose pass fails is revoked — reconcile IS the projection);
  the live gate (`identity/hub-live-gate.ts`, on the kept `principalGate`
  seam) runs the cached read-through (~10 s TTL, single-flight,
  retry-throttled) on every request into a projected workspace and judges
  the freshly reconciled LOCAL rows.
- **CLI connect** (`/sso/cli-connect`): the hub's H3 response carries a
  raw one-time offline grant (`hubRefreshToken`) alongside the 120 s
  exchange JWT; the endpoint stores it encrypted on the account row
  (`acquireFromConnect` — the same row a browser login writes), runs the
  SAME fail-closed reconcile, and mints a USER-scoped key. No org claims
  are read from the exchange token; no key is ever minted born-dead (no
  usable grant → `403 hub_grant_missing` with steering; zero usable
  memberships → `403 no_membership`).

**oss is byte-identical**: `hubConfig()` is null, none of the above is
constructed, and the credential-model change is edition-independent by
design (the uniform rule, against local rows).

### Failure postures (the gate's verdicts, in order)

| State                                                         | Answer                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| grant definitively dead (`invalid_grant` at the hub)          | **401 `hub_grant_expired`** immediately — no stale window            |
| no definitive pass within ~15 min AND the hub keeps failing   | **403 `hub_unavailable`** (fail closed after the stale window)       |
| hub-origin membership row inactive (this pass may have swept) | **401 `membership_revoked`**                                         |
| workspace `hub_status='suspended'`                            | **403 `account_suspended`** — EXCEPT `GET /me` (visible-but-blocked) |
| role delta on the reconciled row                              | applies to THIS request (a demoted admin loses admin surfaces now)   |

Transient hub errors inside the stale window serve local state — freshness
is the reconciler's job, ENFORCEMENT is the windowed verdict's. Only the
token endpoint's `invalid_grant` ever kills a grant; `invalid_client` (our
misconfiguration) and network/5xx are loud transients that never
mass-destroy grants.

**The `hub_grant_expired` recovery path**: every browser SSO login
re-writes the account row's tokens (Better Auth does this natively), so
one "Sign in with Antasphere" heals a dead grant — the dashboard maps the
401 to exactly that steering, and the shell's login bounce lands on the
SSO button. A headless CLI heals by re-running `antasphere login` +
connect (a fresh H3 grant). Nothing else can revive a grant, on purpose:
no backstop oracle, no new hub surface.

### Accepted bounds (documented, not bugs)

- **Guest suspension staleness — ACCEPTED.** Guests hold hub grants but
  their `/orgs` never includes the deck's org, so `workspaces.hub_status`
  refreshes only when a MEMBER's reconcile runs — a guest may keep deck
  access in a hub-suspended org until a member next touches Slideless.
  Every cheap fix leaks or borrows credentials: a public org-status probe
  is a suspension-state oracle, and using a member's stored grant would be
  acting on a credential its holder didn't present. Same accepted-bound
  class as ungated share-link viewing; suspension still cuts all MEMBERS
  within seconds.
- **The reconciler's freshness cache is in-memory per replica.** A replica
  restarted mid-outage has no definitive pass to serve, so its first
  request per user fails closed (`hub_unavailable`) rather than serving
  unverifiable state — the same posture the old Gate-1 D5 dials
  established. Per-replica convergence bounds: reconcile TTL ~10 s, stale
  window ~15 min.
- **Role syncs via reconcile projection upserts are UNAUDITED.** The old
  H2 gate's audited `member.update` channel is gone; the reconcile's
  projection upsert syncs role deltas silently (the login-projection
  precedent — deactivations DO audit, one `member.deactivate` row per
  flip). Accepted for now: the hub is the system of record for membership
  and carries its own trail; a role flip is re-derivable from hub state.
  Revisit if per-instance role history ever becomes an audit requirement.
- **The suspension write asymmetry hub-side is intended** (hub ADR 014): a
  sole-suspended-org hub user can still write to their OWN org's hub data
  by omitting the selector. Tool-side enforcement (this gate) is the
  suspension boundary that matters here, and it reads the synced
  `hub_status` column on every request.

### `no_link` is unreachable for hub-origin principals — by construction

The reconciler's `no_link` outcome ("this user holds no hub identity —
nothing to assert") is the one unconditional FAIL-OPEN branch: it must
exist for purely local users (operator, oss) but must never fire for a
principal whose membership came from the hub. The invariant that keeps it
unreachable: **an `origin='hub'` membership row implies a live
`antasphere` account row for its user.** Two mechanisms preserve it:

1. Both writers of `origin='hub'` rows (login reconcile, connect
   reconcile) run AFTER the account link exists in the same flow.
2. **The orphan-purge HARD CONSTRAINT** (`jobs/pgboss.ts`): the purge must
   never delete an `antasphere` account row while leaving an
   `origin='hub'` membership row behind. Held by construction — the only
   deletion is the WHOLE user via `internalAdapter.deleteUser` (account +
   membership rows cascade together), only ever for users the immediately
   preceding re-check proved to have ZERO membership rows; the purge
   collects zero-membership users with no LIVE session regardless of any
   provider link (the live session, not the link, distinguishes the legit
   zero-org dashboard user from a fail-closed-login strand — protecting on
   the link would accumulate dormant refresh families without bound), and
   the integration suite asserts no dangling hub-origin membership
   survives a run. Never replace the whole-user delete with a partial
   cleanup.

### The atomicity affirmation (mirrors hub ADR 014, deliberately)

The staged transition satisfies "no mixed credential models in prod"
because the SECURITY boundary — the hub's issuance gate going user-scoped
and `accounts:status` minting closing — flips atomically at the hub
deploy. The org-claim emission the hub retains through the deploy window
(and the H3 org claims Slideless now ignores) is COMPATIBILITY-ONLY data:
advisory claims derived from the caller's own live memberships, never an
authorization input on either side — Slideless's login path verifies the
id_token only, its connect path reads no org claims at all, and the hub's
verifier is claim-blind. It is not a second live authorization model. A
future reader must not mistake the compat window for a mixed-model seam.
Rollback caveat: after the hub's Phase-6 cleanup release, pre-flip
Slideless images can no longer log users in — from that point the hub and
Slideless roll back together or not at all.

## What this deletes and what survives

Deleted with this flip: `HUB_SERVICE_KEY` (env, compose, docs — the infra
glue secret goes at rollout step 4), `identity/hub-status.ts` +
`identity/hub-gate.ts` + `HubEntitlementService` (the P4 cached gates),
org claims on the login path, `assertConnectOrgClaims` + the connect
path's direct projection, the consent workspace picker + parked-selection
machinery, and the ADR 015/016 propagation apparatus.

Survives, unchanged: **P7 hub-managed membership** (local membership
mutations on projected workspaces answer `403 hub_managed`; the hub is
where membership is managed), **oss-zero-hub-surface** (ADR 017
non-negotiable #1, fetch-spy-pinned), **template-never-modified-from-here**
(non-negotiable #3; every chassis touch is a TEMPLATE-FEEDBACK entry), the
break-glass apparatus (claim-ownership on projected workspaces writes an
`origin='local'` row the sweep never touches — the operator lifeboat,
pinned by test), guests as tool-local rows (never hub-asserted), and ADR
013 deck-read privacy. ADR 017 non-negotiable #2 ("the hub is never a hard
round-trip in the tool's request path") is REPEALED — the reconcile is a
TTL-bounded, single-flighted, fail-degraded read in the identity path, and
that is the design, not a regression.

## Rejected alternatives

- **Keeping any master-key/service-key read-through** (even the narrower
  org-status polling): every variant is a cross-tenant oracle held by a
  tool — the drill's lesson.
- **A public suspension-status probe for guest freshness**: a
  suspension-state oracle (see accepted bounds).
- **Acting on a member's stored grant to refresh org status for guests**:
  borrowing a credential its holder didn't present.
- **Keeping workspace-bound credentials for MCP/DCR grants only**: the
  half-migrated boundary this program explicitly forbids (Romain's
  decision 4 — the uniformity IS the deliverable).
