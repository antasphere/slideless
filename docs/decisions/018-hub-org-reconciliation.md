# ADR 018 — Live hub-org reconciliation: read-through on login and `/me` (H4)

Status: accepted (2026-07-14)

## Context

On the cloud edition, orgs and memberships are defined ONLY at the hub
(`account.antasphere.com`) — but the shipped binding reflected them lazily:
a hub org projected into a Slideless workspace only when a login ASSERTED
it (one org per login, the hub's consent org picker), and the P4 gates only
re-checked orgs that were already projected. Consequence: an org created at
the hub after a user's first login could never appear in Slideless — the
consent flow pins the previously chosen org for returning users, so no
later login asserts the new one. The product requirement is stronger than
fixing that bug: **hub truth must be visible at page-reload time** — create
an org at the hub, reload any Slideless page, it is there; remove, rename,
suspend, same bound.

The hub gained a machine READ endpoint for exactly this (hub delta **H4**,
a sibling of the H2 member-status endpoint, same `accounts:status` service
key): `GET /api/v1/accounts/users/{hubUserId}/memberships` →
`{ memberships: [{ workspaceId, name, role, status, kind }] }` — the user's
ACTIVE memberships, suspended orgs included (with `status: 'suspended'`).

## Decision

**READ-THROUGH reconciliation** (`identity/hub-reconcile.ts`,
`HubOrgReconciler`), fed by `HubStatusClient.userMemberships()`:

- **`/me` runs the cached `reconcile(localUserId)`** for SESSION principals
  — every dashboard load reconciles. Per-user TTL cache (**15 s**,
  `userOrgsTtlMs`) + single-flight + failure-only retry throttle
  (`retryMs`) + the shared `pruneOversized` bound. The pass on an expired
  cache IS awaited (reload-time freshness is the point) but bounded by a
  tight fetch timeout (**1.5 s**, `userOrgsTimeoutMs`). Machine credentials
  never reconcile — they are bound to ONE workspace and must not fan out a
  user's org list.
- **Every SSO login runs the TTL-bypassing `forceReconcile()`** as
  `assertLogin` step 4 — a login materializes ALL the user's orgs, not just
  the asserted one. `/sso/cli-connect` inherits it via `provisionConnect`;
  the minted key still binds only the asserted org.
- **One pass**: resolve the hub sub from the `antasphere` account link (no
  link = a purely local user, definitively nothing to reconcile) → fetch
  the H4 list → on a **definitive 200 ONLY**: deactivation sweep FIRST (one
  conditional UPDATE: rows `origin='hub' AND is_active=true` whose
  workspace is a projection with `central_account_id` off the keep-set,
  RETURNING; one `member.deactivate` audit row per flip, actor `system`,
  reason **`hub_reconcile`**), then per-entry project/upsert through the
  same `projectOrgMembership` primitive the login uses (extracted from
  `hub-sso.ts` — both writers produce byte-identical rows).
- **A severable third consumer**: the deep-link retry in
  `HubSsoIdentityProvider.resolve` — a session naming a workspace the local
  join cannot see runs one CACHED reconcile and one local re-resolve, so
  "invited at the hub, clicks a deep link" works without a re-login.

### The fail-open-freshness vs fail-closed-security split

Reconciliation is a FRESHNESS feature, so its failure posture is the
opposite of the login assertion's:

- The login's single-org projection (step 3) stays **fail closed** —
  unchanged contract, a cloud login without its asserted projection never
  exists.
- The reconciler **fails OPEN on every hub error**: H4 is a REQUIRED hub
  surface (hub ≥ v0.2.0 deploys first — **no legacy dual-mode, no 'absent'
  mapping**), so every non-200 (401/403 from a broken key or a stale hub's
  scope allowlist, 404 from a stale hub, 5xx, timeout, malformed body) is
  one loud transient error: local state serves, NOTHING is deactivated,
  the pass retries next window. Only a definitive 200 list ever mutates
  state. Security keeps living where it already is: the fail-closed login
  assertion, the D5 org suspension gate, and the H2 membership
  re-assertion.
- **Login ordering + keep-set**: step 4 runs AFTER step 3 and unions the
  asserted org id into the sweep's keep-set — a list outage (or a list
  transiently omitting the org the login just asserted) can neither fail
  the login nor undo the row step 3 just wrote.

### Semantics locked with the list

- **Suspended orgs are visible but blocked**: listed entries with
  `status: 'suspended'` stay projected/kept — the D5 org gate (its own
  definitive fetch) is what refuses their requests.
- **Unknown role in one entry**: keep-alive (the org stays on the keep-set)
  but no projection/role-sync from that entry, loud log — an unknown role
  must never read as absence, and local roles are never invented (D11).
- **UUID-invalid entry**: dropped loudly (it can neither be projected nor
  protected); the rest of the list still applies.
- **Reconcile role-upserts are not audited** — matching the login
  projection precedent; the H2 gate remains the audited role-delta path.
  Deactivations ARE audited, under the distinct reason `hub_reconcile` so
  the H2 gate's `hub_reassertion` trail stays separable.
- **The sweep's blast radius is structural**: `origin='hub'` rows in
  PROJECTED workspaces only — guest/local rows and hub-origin residue in
  non-projected workspaces are out of scope by the WHERE clause, not by
  convention.

## Rejected alternatives

- **Hub webhooks** — a new push channel with delivery, retry, ordering,
  and auth surface to build and operate on both sides; the freshness
  requirement is "at reload time", which a read-through meets with one
  ~20 ms intra-region call per user per 15 s worst case.
- **Background sync jobs** — periodic full sweeps put the hub in a batch
  path, add a scheduler surface, and are LESS fresh at reload time than
  read-through (a reload between runs still shows stale orgs).
- **Widening the token contract to an org-array claim** — breaks the hub's
  ADR 012 "no multi-workspace tokens" invariant and only helps at login,
  not at reload.
- **A per-login org chooser** (unpinning the hub consent selection) —
  explicitly rejected by the product owner: silent SSO, no chooser; and it
  still would not make org changes visible mid-session.

## Consequences

- Create an org at the hub → reload any Slideless page → it is there
  (bounded by the 15 s TTL; immediate after a fresh login). Removal,
  rename, role change, suspension reflect the same way.
- `/me` for sessions carries up to one 1.5 s hub wait per user per TTL
  window in the worst case (cache expired + hub slow); steady state is a
  cache hit. Counters: `hub_reconcile_passes_total{outcome}` +
  `hub_status_fetches_total{endpoint="user_memberships"}`.
- Slideless ≥ this version REQUIRES hub ≥ v0.2.0 (H4). A stale hub reads
  as a loud transient error on every pass — an operational emergency, not
  a supported mode. Deploy order: hub first.
- oss is byte-identical: everything hangs off the `hubConfig()` null
  switch; an oss boot constructs no reconciler, no client, no retry.
- Pinned by `test/integration/hub-reconcile.test.ts` (reload-time
  projection, removal/rename/role, suspended visible-but-blocked,
  fail-open error matrix, sweep blast radius, cli-connect binding,
  deep-link retry, cache/single-flight/machine-skip, counters).
