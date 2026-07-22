# ADR 015 — Hub SSO: the assertion handoff and JIT projection semantics

Status: **superseded by [ADR 019](019-user-scoped-live-federation.md)**
(2026-07-15). The login path no longer reads ORG claims from any token:
identity comes from the id_token alone, and the org projection is the
fail-closed login reconcile (as-the-user `GET /orgs`). What survives from
here: the AsyncLocalStorage login-scope handoff pattern (it now carries
the user assertion + the hub-audienced callback access token), the D9/D10
identity semantics, and the fail-closed no-session-without-projection
posture. Kept for the race analysis and historical rationale.

## Context

The cloud edition delegates human login to the Antasphere hub
(internal/federation.md). Each hub login asserts exactly ONE org — chosen on the
hub's consent org picker — as verified claims on the callback's access token
(`workspace_id`, `role`, `workspace_name`, `email`; the id_token adds
`email_verified` and `name`). Slideless must turn that assertion into local
state: JIT-create or link the user, lazily project the org into a workspace
(`workspaces.centralAccountId`), and (re-)assert the membership with the
hub's role — at EVERY login, for returning users too.

better-auth's `genericOAuth` plugin gives us two seams that see different
halves of the problem:

- **`getUserInfo(tokens)`** receives the raw callback tokens — the ONLY
  reliable place to verify the hub JWTs and read the org claims (stored
  tokens go stale, and refresh re-mints drop RFC 8707 `resource`, so they
  come back opaque and claimless). It runs BEFORE the user exists.
- **The callback after-hook** runs AFTER the user/session exist — the only
  place that can project and upsert the membership, and the only per-LOGIN
  seam (the `user.create` database hook fires for JIT only, never for
  returning users). It sees the session, not the tokens.

Something must carry the verified assertion from the first seam to the
second, and it must be impossible for two concurrent logins to read each
other's assertion: the same human can hold several hub orgs, and a shared
map keyed by user id / hub sub / email would let two interleaved logins of
one user cross-wire orgs (login A projecting login B's org, or B's role
landing on A's projection).

## Decision

**The handoff is an `AsyncLocalStorage` scope spanning the whole callback
request.** `api/index.ts` wraps the better-auth mount (`auth.handler`) in
`HubSsoService.runWithLoginScope` on cloud; `getUserInfo` writes the
verified `HubSsoAssertion` into the scope; the after-hook `take`s it
(one-shot). Node's async-context propagation guarantees the store is visible
to exactly the continuations of that one request — better-auth's dispatch
catches the callback's redirect-throw and runs after-hooks in the same
promise chain (source-verified on the pinned 1.6.15), so the scope is still
live there. Concurrent logins each get their own store by construction; no
key, no TTL, no cleanup, no cross-wiring surface.

Rejected alternatives:

- **Map keyed by hub `sub`** (or email): a second concurrent login of the
  same user overwrites the first's entry — precisely the cross-wiring this
  ADR exists to prevent.
- **Re-reading the stored `account.accessToken` in the after-hook**: the
  row is overwritten by whichever login wrote last (same race), costs a
  second verification, and breaks entirely after any refresh (opaque).

**The after-hook fails CLOSED.** It is gated on `ctx.context.newSession`
(set only on success exits) and path-matched to the `antasphere` callback.
If the assertion is missing, malformed, or any per-login step fails, the
hook deletes the just-minted session row, expires the cookie, and replaces
the success redirect with `/login?error=<code>` — a cloud session without
its hub-asserted projection never exists.

## The per-login steps (in order)

1. **Single-hub-identity guard.** A local user may hold at most one
   `antasphere` account row. The dangerous path: hub user B's (hub-verified)
   email matches a STALE address on local user A's row — better-auth's
   trusted-provider link (D9) would merge B onto A's user and decks. The
   hook detects a second distinct `accountId`, deletes the **newest** link
   row, and fails with `sso_identity_conflict`. Keying the undo on recency
   (not on the current login's `sub`) matters only in residue states where
   two rows pre-exist — a crash between better-auth's link and this hook,
   or a second identity linked via the explicit `/oauth2/link` flow (which
   mints no session, so the guard never saw it). There, deleting the
   current-sub row would let the established identity's own login destroy
   itself (and two concurrent conflicting logins destroy BOTH rows,
   stranding the user with no hub link); the newest row is always the
   intruding link, so the legitimate identity self-heals on retry.
2. **Email re-sync (D10).** The local email follows the hub's verified
   assertion. If another local user holds the asserted address, the login
   fails with `sso_email_conflict` — never corrupting either account; the
   unique constraint on `user.email` backstops the check-then-write race.
   For an UNCHANGED address `emailVerified` is a latch (never re-flipped to
   false by a weaker hub assertion — break-glass refuses unverified
   operators, so a downward sync could close the operator door); a CHANGED
   address takes the hub's asserted state honestly.
3. **Lazy projection + membership assertion (D11).** Look up
   `workspaces.centralAccountId = workspace_id`; create on miss (name from
   `workspace_name`, or a recognizable placeholder that self-heals at the
   next named login). The **unique partial index** on `centralAccountId`
   (migration 0021) + `ON CONFLICT DO NOTHING` + re-select make concurrent
   first-logins land on one row. The membership is UPSERTED every login:
   `role` = the hub org role verbatim (never invented locally, unknown
   roles refuse the login), `origin='hub'`, `isActive=true` (reactivating a
   deactivated row — the hub asserted this membership NOW).

## Consequences

- The hub is out of the request path after the callback: sessions resolve
  locally (LocalIdentityProvider semantics unchanged); hub outage gates
  logins only. Role/name/email changes on the hub propagate at the next
  login (Phase 4's H2 re-assertion tightens this to ~5 minutes).
- Two parallel first logins of one BRAND-NEW user race the JIT insert; the
  loser fails cleanly on user-email uniqueness and a retry succeeds. This
  is better-auth's create path, accepted as-is (rare, self-healing, never
  corrupting).
- The explicit `/oauth2/link` flow (linking a provider to a logged-in
  session) mints no session, so the hook skips it; the next SSO login
  projects. Without a projection the linked user simply has no new
  workspace yet. The flow CAN link a second hub identity onto the session's
  user (better-auth offers no per-provider link gate; same-email
  constrained) — the single-hub-identity guard undoes exactly that newest
  link at the next SSO login.
- The scope wrap costs one empty object per auth request on cloud and does
  not exist on oss (`hubSso` is never constructed there).
