# ADR 014 — The workspace-scoped principal (multi-workspace runtime)

Status: accepted (2026-07-12); **the mint-time workspace BINDING half is
superseded by [ADR 019](019-user-scoped-live-federation.md)** (user-scoped
credentials: keys carry an optional pin instead of a mandatory binding,
OAuth consent binds no workspace, `/me` lists all memberships for every
credential kind). The multi-workspace RUNTIME this ADR built — the
one-workspace Principal, `X-Workspace-Id` selection, live membership
re-checks, the `origin` discriminator, the projection machinery, the
break-glass/deletion unwinding — survives as ADR 019's substrate.

> Adapted from the upstream codika-platform-template's ADR 012 (its
> multi-workspace runtime pass, commits `b9e2307..01bd1c6`), renumbered:
> Slideless's own ADR 012 is the viewer serving model. Slideless-specific
> additions — the `workspace_members.origin` discriminator, the projection
> exemption, and the deck-privacy interplay — are marked below.

## Context

Slideless was "multi-workspace schema, single-workspace runtime": every
domain table carried a `workspace_id`, but every credential path resolved
the user's FIRST membership (`LIMIT 1`, unordered), setup created THE
workspace, and break-glass / the orphan purge / account deletion assumed a
singleton. The upcoming cloud edition federates to the Antasphere hub and
projects hub orgs as separate Slideless workspaces — and cross-tenant
collaborators create multi-membership users on day one (a guest claimed
into two customer workspaces holds two memberships immediately). Every
existing self-host deployment, however, runs exactly one workspace and must
behave identically with zero client changes.

## Decision

**A Principal is scoped to exactly ONE workspace per request** — the
workspace named by the presented credential. Multi-workspace is about WHICH
workspace a request targets, never about a request spanning several.

- **Machine credentials bind at mint time.** API keys already carried their
  workspace on the row; CLI-auth keys bind the deterministic default (or an
  explicit `workspaceId` in the complete body). OAuth grants bind **at
  consent**: the oauth-provider plugin's `postLogin.consentReferenceId` seam
  stores the chosen workspace on the consent row (consents are per
  client+user+workspace), threads it through the authorization code, and
  persists it on the refresh-token row — refresh re-mints receive the SAME
  workspace forever. `customAccessTokenClaims` mints `workspace_id` from
  that stored choice, still requiring a live active membership of it at
  every issuance; JWT verification filters the per-request membership
  re-check by the claim. The consent page always names the workspace being
  granted; multi-membership users get a picker whose choice is parked via
  `POST /api/v1/oauth/consent-workspace` (session-only, verification-table
  row keyed to the session, 10-minute TTL, membership-verified at write AND
  at consumption).
- **Human sessions choose per request** with the `X-Workspace-Id` header,
  resolved in the identity layer (never per-route): header present → an
  ACTIVE membership of that workspace is required, else the request
  resolves to no principal (fail closed — a workspace that does not exist
  and one the user does not belong to are indistinguishable); header absent
  → the sole active membership, or the deterministic default (oldest active
  membership by `created_at`, then `id`). A machine request carrying a
  MISMATCHING header is rejected `403 workspace_mismatch` rather than
  silently served the credential's workspace.
- **`/me` grows additively**: `workspaces[]` (sessions list all active
  memberships, oldest first; machine credentials list ONLY their bound
  workspace — a workspace-scoped credential must not enumerate the user's
  others) and `activeWorkspaceId` (what this request resolved to).
- **Setup creates the FIRST workspace, not THE workspace**, through the
  registry-exposed `WorkspaceService` — the same transactional path the
  cloud edition's lazy org projection uses for later workspaces. There is
  deliberately NO workspace-creation HTTP endpoint (fail-closed posture).
- **The singletons are unwound honestly.** Break-glass owner-claims take an
  explicit target workspace once the instance has several (400
  `workspace_required` instead of guessing); reset-2fa is user-level and
  needs none. `audit_log.workspace_id` is nullable (migration 0018):
  NULL = instance-attributed, used by the orphan purge (orphans belong to
  no workspace) and the 2FA reset; credential events land one row per
  ACTIVE membership workspace. Account deletion enforces the last-owner
  guard for EVERY owned workspace, with the per-workspace advisory locks
  acquired in deterministic (sorted) order so concurrent co-owner deletes
  cannot deadlock; the admin `DELETE /members/{id}` refuses (409) when the
  target belongs to other workspaces — an account delete erases the user
  everywhere, and an admin's authority ends at their own workspace
  (deactivation is the in-workspace tool; self-service GDPR erasure is the
  account holder's).

### Slideless-specific: membership origin (G2)

`workspace_members.origin` (`'local' | 'hub' | 'guest'`, default `'local'`,
migration 0018) records who a membership row's source of truth is:
`local` rows are this instance's (setup, invitations, admin surfaces);
`hub` rows will be written ONLY by the cloud edition's SSO JIT projection
and re-asserted against the hub; `guest` rows are minted by the
collaborator claim path — an external party invited to ONE deck whose
membership exists only because principal resolution requires one. In this
phase the column is pure data (no capability change): it exists so the
future hub re-assertion can tell hub-truth rows from local/guest rows it
must never deactivate, and so guest capability limits can key on it later.

### Slideless-specific: the projection exemption (D11)

The last-owner invariant ("a workspace must keep ≥1 active owner") applies
ONLY to workspaces this instance owns (`central_account_id IS NULL`). A
projected (hub-origin) workspace asserts ownership hub-side; its local
membership rows are a projection that re-syncs at every SSO login, so a
zero-local-owner state there is legal and recoverable. Both layers stand
aside for projections: the app-level guard (deletion service) and the 0009
trigger (redefined in migration 0019). Inert today — no workspace has a
`central_account_id` until the cloud edition creates the first projection.

### Slideless-specific: deck privacy is orthogonal (ADR 013)

Workspace scoping changes WHICH workspace a request targets; ADR 013
decides what a principal may read INSIDE it. Workspace membership alone is
still never a deck read grant, whatever header the request carries; failed
deck reads still answer 404, never 403; the deck list's WHERE scope stays
owner/collab for plain members and workspace-wide for admins — evaluated
against the ACTIVE workspace. A collaborator claimed into two customer
workspaces reaches each deck through its own workspace context (the
dashboard switcher / the `X-Workspace-Id` header), never across.

**The parked selection is deliberately NOT single-use.** The
verification-table row a consent-workspace POST parks is read — never
deleted — on consumption, because the plugin's `consentReferenceId`
callback runs more than once per approval (on the consent POST and again on
the authorize re-run inside it). Its lifecycle is: ~10-minute TTL, the
dashboard re-parks before EVERY approval (each POST replaces the previous
row), and consumption re-verifies a live active membership — a stale or
foreign selection throws `access_denied` and can never bind a different
workspace. The accepted availability edge: a user whose selected membership
is revoked within the TTL window is consent-blocked (403) until the row
expires or a new selection replaces it. Do not "fix" this by deleting the
row on first read — that breaks the second callback invocation within the
same approval.

**Legacy grants fail closed, never guess.** Tokens/grants minted before
binding existed carry no workspace: the sole active membership is the
honest fallback; a multi-workspace user's unbound grant or claimless token
is refused (re-authorization records a bound consent). One consequence to
know: a pre-upgrade consent row has no workspace either, so the first
authorize after upgrade re-prompts consent once — access through existing
refresh tokens keeps working throughout.

## Rejected: multi-workspace tokens

A token listing several workspaces (or an unscoped "all my workspaces"
token) was rejected. It reintroduces the confused deputy — every resource
check would need a second, client-supplied input to pick the workspace, and
any bug in that plumbing crosses tenants; it breaks the chassis's
context-from-credential invariant (the credential IS the authorization
context, headers are never trusted for scope); and it makes revocation and
audit attribution ambiguous. Choosing per credential keeps every existing
scoping query (`WHERE workspace_id = principal.workspaceId`) correct
unchanged.

## Consequences

- Single-workspace instances behave identically (modulo additive `/me`
  fields and the one-time OAuth re-consent above): one membership resolves
  the same with or without ordering, the switcher never renders, no header
  is ever sent.
- The dashboard is multi-workspace capable: a sidebar switcher (hidden for
  single-membership users) persists the choice and reloads; a stale
  persisted workspace self-heals at bootstrap.
- The cloud edition gets workspaces through `registry.workspaces.create()`
  and its requests are scoped by construction — no per-route workspace
  plumbing.
- On a silent OAuth re-authorize, an existing consent for the DEFAULT
  workspace wins without interaction; clients that need a different
  workspace force the picker with `prompt=consent`.
