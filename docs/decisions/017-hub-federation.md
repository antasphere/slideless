# ADR 017 — Hub federation: the cloud edition's complete binding to the Antasphere hub

Status: accepted (2026-07-13)

## Context

Slideless ships one Docker image that runs in two postures: `EDITION=oss`
(self-host, local password/email auth, no external dependency) and
`EDITION=cloud` (a managed instance whose ACCOUNT layer — identity, orgs,
membership, billing status — is owned by the Antasphere hub). The binding
was built across phases P2–P8 and is documented operationally in
[docs/federation.md](../federation.md); the per-slice decisions live in
ADRs [014](./014-workspace-scoped-principal.md) (the workspace-scoped
principal the whole binding keys on),
[015](./015-hub-sso-assertion-handoff.md) (the SSO assertion handoff), and
[016](./016-hub-gates-placement-and-postures.md) (the continuous gates).
This ADR is the capstone: the one place a future reader (or the next tool
binding to the hub on this chassis) gets the whole shape and the security
model, with pointers into the shipped code.

Non-negotiables the binding was built under:

- **oss carries zero hub surface at runtime.** Not "disabled" — never
  constructed, never mounted. Self-host behavior is byte-identical to the
  pre-federation tool.
- **The hub is never a hard round-trip in the tool's request path.** A hub
  outage may gate logins; steady-state requests run on tool-local state
  within bounded staleness windows.
- **The template is never modified from here** (TEMPLATE-FEEDBACK.md is the
  upstream channel); the hub deltas the binding required are flagged for
  upstreaming, not silently forked.

## Decision — the binding, piece by piece

### 1. Edition split: config-selected, one image (P2)

`EDITION` + the hub env block (`HUB_ISSUER_URL`, `HUB_CLIENT_ID`,
`HUB_CLIENT_SECRET`, `HUB_SERVICE_KEY`) select the binding at boot —
`hubConfig()` (`src/env.ts`) is the single null-switch, and
`bindEditionSeams` (`src/platform/edition.ts`) is the ONE place edition
decides what the boot registry gets: oss returns the local seams untouched;
cloud rebinds identity + entitlements and adds the principal gate + hub
metrics. Setup stamps the edition into `instance_settings`; the R7 boot
guard refuses an env `EDITION` that contradicts the stamp
(`EDITION_CHANGE_ALLOWED=true` is the one-boot acknowledgement). Discovery
(`GET /api/v1/instance`) advertises the resulting entrance set.

### 2. The entrance: SSO delegation + JIT lazy projection (P3, ADR 015)

On cloud the ONLY advertised human entrance is `antasphere` — a Better Auth
`genericOAuth` relying party against the hub (confidential client, PKCE,
`openid profile email`). Org context rides the hub ACCESS token: the token
request carries RFC 8707 `resource=<own /mcp URL>`, which makes the hub mint
an RS256 JWT asserting `{sub, email, workspace_id, role, workspace_name}`
(hub delta H1). The callback verifies it with `HubJwtVerifier`
(`src/identity/hub-jwt.ts`) and hands the verified assertion to the
after-hook through a request-scoped AsyncLocalStorage span (ADR 015 — the
handoff that cannot cross-wire concurrent logins). Every login then runs the
same per-login work: JIT user create-or-link (D9 trusted link onto verified
local emails only), D10 email re-sync, lazy workspace projection
(`workspaces.centralAccountId` = the hub org id, unique partial index), and
membership upsert with `origin='hub'` + the hub-asserted role. Any failure
revokes the just-minted session — a cloud login without its projection does
not exist. After login the session is an ordinary local cookie; the hub is
out of the request path.

### 3. The continuous gates: suspension + re-assertion (P4, ADR 016)

Login-time truth decays, so two gates re-assert it continuously, both fed by
one cached `HubStatusClient` against the hub's `accounts:status` machine
surface, both running in the `principalGate` hook inside `authContext` —
after credential resolution, before the scope gate, covering sessions, API
keys, OAuth bearers, and MCP calls (which re-enter `/api/v1` in-process)
with one implementation:

- **Org suspension** (60 s TTL, stale-while-error 15 min, then fail
  CLOSED `hub_unavailable`): a suspended hub org stops working here within
  ~a minute; `HubEntitlementService` denies metered actions with the same
  truth.
- **Membership re-assertion** (~5 min per (user, workspace), hub delta H2):
  `origin='hub'` rows only; ONLY a definitive `200 {active:false}`
  deactivates (fail OPEN on every error class — a broken service key must
  never mass-lock-out a tenant). Role changes sync on the same poll (D11).

The asymmetry is deliberate and argued in ADR 016.

### 4. Guests: origin is a capability boundary (P6)

Deck collaborators are external parties invited to ONE deck (ADR 013), not
workspace members. Their `workspace_members.origin='guest'` row exists for
principal resolution only: `requireNonGuest` refuses deck creation, the
generic `/files` surface, the member roster, and the workspace export on
BOTH editions (403 `guest_forbidden`), across all three credential kinds.
Guest roles are locked; the hub re-assertion never touches guest rows. On
cloud the claim is SSO-FIRST: the claim endpoint's account-creation branch
answers 409 `sso_required` (`src/api/collaborators.ts`) — guests get hub
identities, never local-password accounts.

### 5. Hub-managed membership: local CRUD is gated (P7)

On cloud, membership of a PROJECTED workspace is the hub's source of truth,
so every local membership mutation under `/members/*` + `/invitations/*`
answers 403 `hub_managed` + `details.manageUrl`
(`src/middleware/hub-managed.ts` — method-keyed, mounted once per subtree,
keyed on `principal.accountRef`, so future mutation routes are refused by
default). Reads stay open (the roster is real); the per-deck collaborator
surface stays the sanctioned local path; cloud-LOCAL workspaces (the
operator's, deck-guest hosts) keep local management. The dashboard adapts
off `/me`'s `workspace.hubOrigin`/`origin`/`hubManageUrl` signals, never
edition sniffing.

### 6. CLI cross-tool exchange (P5, hub delta H3)

The gcloud model: one hub login, N tool keys. `POST {hub}/api/v1/sso/tool-token`
(hub API key with the `sso:exchange` scope) mints a 120 s RS256 JWT
(`purpose:'sso-connect'`, `jti`, org-asserting claims); the tool's PUBLIC
`POST /api/v1/sso/cli-connect` (`src/api/sso-connect.ts`, cloud-only mount)
verifies it with the same `HubJwtVerifier` discipline, burns the `jti`
one-time-use CLAIM-FIRST via a Postgres insert-conflict ledger
(multi-replica safe), JIT-provisions through the SAME code path as a browser
SSO login (proven byte-identical rows), and mints an ordinary `slk_` key
bound to the projected workspace — never with `data:export`. Every
verification failure is one uniform 401. Day-to-day CLI calls are then the
plain local API-key path, hub out of the loop.

### 7. The security model, in one place

- **Issuer/aud pinning at every trust boundary.** `HubJwtVerifier` pins
  `iss` to the configured hub issuer (and refuses a discovery document that
  claims otherwise), pins `aud` per call site to OUR resource URL, and
  allowlists RS256 — at the SSO callback AND at `/sso/cli-connect`.
  Conversely the tool's own OAuth gate (`identity/oauth-jwt.ts`) pins `iss`
  to the instance itself, so hub-minted JWTs can never pass as tool tokens:
  MCP's OAuth dance is untouched by federation, and the two token worlds
  cannot be confused in either direction.
- **`origin` is the capability boundary on membership rows.** `hub` rows are
  hub truth (re-asserted, role-synced, deactivatable by H2); `local` rows
  are tool truth (never re-asserted); `guest` rows are capability-limited
  and immutable outside the claim path.
- **One-time-use is enforced in the database**, not in memory: the
  `sso_connect_jtis` primary-key conflict IS the replay signal, and the jti
  burns before provisioning, so concurrency can only under-mint.
- **Failure postures are bounded and asymmetric by argument** (ADR 016):
  suspension fails closed after a bounded grace; membership re-assertion
  deactivates only on a definitive hub answer.
- **Machine credentials are covered by construction**: the `principalGate`
  sits in the one middleware every credential kind resolves through, and the
  fail-closed scope allowlist keeps machines off everything unlisted —
  including the whole `/members`/`/invitations` surface and break-glass.
- **The entrance set is closed, not hidden.** Sign-up stays triple-switch
  closed (the `antasphere` provider's unset `disableSignUp` is the
  deliberate fourth switch that lets JIT in); and since the P8 closes below,
  the local password-reset surface REFUSES on cloud rather than being merely
  undiscoverable. Two same-class doors are KNOWN-OPEN on cloud pending a
  charter call (initiative doc `slideless-cloud-binding-DISCUSS-LATER.md`
  §B2): `/sign-in/email-otp` (human OTP sign-in) and `/cli/auth/*` (the
  tool's own OTP→`slk_` mint), both reachable only with a delivering mailer
  and a hub-synced mailbox, both hub-gated per request by the P4
  re-assertion — an unwanted entrance, never an escalation.

### 8. The P8 hardening closes (this program's exit gate)

Two residuals identified during the build were closed at P8:

1. **Hub side — `/sso/tool-token` refuses unverified subjects** (hub commit
   `fcb0930`): an unverified hub email mints nothing (403
   `email_unverified`, checked before and independently of membership so it
   adds no oracle). This closes the driverless-hub chain behind
   `cli-connect`'s `emailVerified:true` JIT assertion.
2. **Tool side — the local password-reset surface is closed on cloud** (the
   P3 residual). `/request-password-reset` and `/reset-password` stayed
   reachable under hub-only login (the UI merely hid them): a hub-JIT user —
   who has NO credential account — could mail themselves a reset, SET a
   local password, and mint `/sign-in/email` sessions that skip the
   per-login SSO re-sync. P4's re-assertion still gated every such session,
   so this was posture, not an open hole — but D1 does not want the
   entrance. Now the ENTIRE reset class refuses 403 on cloud: the core
   routes plus the emailOTP plugin's reset trio
   (`/email-otp/request-password-reset`, `/email-otp/reset-password`,
   `/forget-password/email-otp`), enumerated against the pinned Better Auth
   1.6.15 surface in `isPasswordResetPath`
   (`src/identity/better-auth.ts`), with `sendResetPassword` never wired on
   cloud as defense in depth, and the admin `/members/{id}/reset-link` mint
   refusing 403 `password_reset_disabled` (a mint would dead-end on the
   refused consumption route). `/sign-in/email` stays wired on both editions
   — it is the break-glass operator door (ADR 010), and break-glass needs a
   session plus the SETUP password, never a reset. oss keeps the full reset
   surface unchanged.

## Consequences

- **Operator recovery on cloud is: hub SSO, or the setup password, or DB
  surgery.** D9 mints the operator `emailVerified:true` so the hub trusted
  link always works; the setup password drives `/sign-in/email` +
  break-glass when the hub is unreachable. An operator who forgets the setup
  password AND has lost hub access has no self-serve reset — the accepted
  D1 trade, now explicit.
- **Local-credential accounts on cloud-LOCAL workspaces have no password
  recovery** (delete + re-invite is the workaround). These accounts are a
  legacy chassis affordance under hub-only login, not a sanctioned cloud
  flow.
- **Propagation bounds** (per replica): suspension ≤ ~60 s; membership
  removal/role change ≤ ~5 min; a hub outage > 15 min turns projected
  workspaces off (`hub_unavailable`) while local workspaces keep working.
- **The hub deltas H1 (org-name claim), H2 (member-status endpoint), H3
  (tool-token exchange) are FLAGGED FOR UPSTREAMING** into the platform
  template as first-class cloud seams, together with the chassis seams the
  binding added by hand (`principalGate`, `accountRef` in every resolver,
  metrics-early boot ordering, a supported product-JWT mint). The curated
  list lives in
  `workspace/knowledge/initiatives/agent-tools-platform/template-improvements-roundup.md`;
  the authoritative backlog stays TEMPLATE-FEEDBACK.md here and in the hub.
- **The next tool on this chassis binds the same way**: the whole binding is
  seam-shaped (identity, entitlements, principal gate, three conditional
  route mounts, one middleware), selected by one env switch, with
  `docs/federation.md` as the operational runbook and
  `cloud-edition-binding-patterns.md` (initiative docs) as the reusable
  pattern write-up.
- Every posture above is pinned by integration tests that boot the real app
  per edition (`test/integration/edition.test.ts`, `hub-sso.test.ts`,
  `hub-entitlements.test.ts`, `hub-managed-membership.test.ts`,
  `sso-cli-connect.test.ts`, `guest-capabilities.test.ts`,
  `collaborators-cloud.test.ts`) — regressions on any seam fail the gate,
  not a reviewer's memory.
