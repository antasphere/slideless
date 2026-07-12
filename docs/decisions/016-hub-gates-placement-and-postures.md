# ADR 016 — Hub gates: post-resolution placement and failure postures

Status: accepted (2026-07-12)

## Context

Phase 3 made hub truth authoritative **at login**: SSO verifies the org
assertion, projects the org, and (re-)asserts the membership. But tool
sessions live 365 days, and API keys and OAuth grants live independently of
logins. Two propagation problems remain (docs/federation.md, "The hub
gates"):

1. a hub org that gets **suspended** (or deleted) must stop working in the
   tool within a bounded window;
2. a user **removed** from a hub org — or whose hub role changed — must
   lose/gain the corresponding access without waiting for a next login
   that may never come.

Both checks consume the hub's `accounts:status` machine surface (the org
status endpoint, plus hub delta **H2**: `GET
/accounts/{ws}/members/{userId}/status` → `{active, role?}`), and both must
respect the availability rule the plan pinned: **a hub outage gates logins
only — the hub is never a hard round-trip in the tool's request path**.

## Decision 1 — where the gates run: a post-resolution hook in `authContext`

The re-assertion could have lived inside `LocalIdentityProvider.resolve`
(the "identity path"). It deliberately does not: that provider resolves
**sessions only**, while API keys and OAuth bearers resolve in their own
paths inside the same `authContext` middleware. A contractor removed from a
hub org who never opens the dashboard again but holds a long-lived `slk_`
key would keep machine access indefinitely — exactly the gap Phase 4
closes.

So `authContext` — already the single credential resolver every `/api/v1`
request passes through — gains one optional seam:

```ts
principalGate?: (principal: Principal) => Promise<PrincipalGateResult>;
```

- Runs AFTER the credential resolves and the quota is consumed (hammering a
  suspended org stays rate-bounded) and BEFORE the machine scope gate (a
  definitive hub refusal wins over any per-endpoint outcome).
- Covers **all three credential kinds with one implementation**, and MCP
  tool calls too (they re-enter `/api/v1` in-process).
- oss wires nothing: the hook is absent, zero overhead, zero hub surface.
  Cloud wires `HubPrincipalGate` from `bindEditionSeams` — the same single
  binding point as every other edition seam.
- `{ ok: true, role }` lets the gate hand back a freshly synced hub role so
  the very request that observed a demotion/promotion already runs under it
  (D11).

The alternative — wrapping each resolver (identity provider, API-key
resolver, OAuth verifier) with a decorating class — was rejected as three
wrap points for one concern; the middleware hook is one seam with the same
coverage, and a natural template upstream (TEMPLATE-FEEDBACK #57).

## Decision 2 — failure postures (D5/D3), asymmetric on purpose

**Org suspension (60 s TTL per org; shared by the principal gate and
`HubEntitlementService`):** definitive answers (`active`, `suspended`,
`404`) are cached and enforced; errors serve the last known value **stale up
to 15 min from the last success, then fail closed** (`hub_unavailable`).
Stale-while-revalidate + single-flight + a ~15 s outage re-probe throttle
keep the hub out of the hot path; a cold cache with a dead hub fails closed
immediately (an unverifiable NEW org gets no benefit of the doubt).

**Membership re-assertion (~5 min per (user, workspace); `origin='hub'`
rows only):** the ONLY deactivation signal is a definitive
`200 {active:false}` from H2. Everything else — 401/403 (a broken/rotated
service key must never mass-lock-out users; logged loudly), 404 (a hub
without H2), 5xx, timeouts, malformed bodies — **fails open** and retries at
the next expiry. Deactivation is keyed to `origin='hub'` in the UPDATE
itself, audited (`member.deactivate`, reason `hub_reassertion`), and
answered `401 membership_revoked`; the existing live-membership re-check
then locks out sessions, keys, and bearers everywhere. Local/guest rows are
never re-asserted: they are tool truth, not hub truth.

The asymmetry is deliberate: suspension is an org-wide kill switch whose
false-open is expensive (a suspended tenant keeps consuming), so it fails
closed after a bounded grace; membership removal's false-CLOSED is the
expensive direction (one flaky poll deactivating a member silently), so only
a definitive hub answer may deactivate, and the lag is bounded by the cache
TTL.

## Consequences

- Propagation bounds, per replica: suspension ≤ ~60 s; removal/role change
  ≤ ~5 min. Both caches are in-process (no Redis dependency); replicas
  converge independently within their windows.
- One extra DB read per (user, workspace) per 5 min on hub-origin
  workspaces (the origin/sub lookup); zero for unprojected workspaces.
- Anonymous share-link viewing stays ungated (not an authenticated
  workspace surface); token revocation remains its kill switch.
- A hub that is down for more than 15 min turns every projected workspace
  read-nothing (403 `hub_unavailable`) while local workspaces keep working —
  the documented, alarmed (`hub_status_degraded_total`) trade the D5 dials
  encode.
