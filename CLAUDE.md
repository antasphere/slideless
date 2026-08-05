# Slideless

The Slideless product monorepo, in the n8n mold: one Docker image plus a Postgres container. Ships a
versioned Hono API (`/api/v1`), a SvelteKit dashboard, Better Auth (sessions, API keys, a built-in
OAuth 2.1 authorization server), file storage, pg-boss jobs, an audit log, and a bundled MCP endpoint
(`/mcp`) — so agents are first-class consumers of every instance. Instantiated from the
codika-platform-template (commit `b0dcd13`); branches follow the workspace rule: `prod` (default,
deploys) + `dev` (day-to-day work).

## Identity (fixed at instantiation)

- npm scope `@slideless/*` for the internal workspace packages; the CLI is the one exception —
  it publishes to npm as **`@antasphere/slideless`** (binary still `slideless`, released via
  `.github/workflows/publish-cli.yml` on `cli-v*` tags — internal/cli-release.md). Env var prefix
  `SLIDELESS_` — the CLI reads `SLIDELESS_URL` / `SLIDELESS_API_KEY`.
- API key prefix `slk` (`apps/server/src/apikeys/service.ts`).
- Scopes: `presentations:read`, `presentations:write`, `data:export` (export stays opt-in).
- Docker image `ghcr.io/antasphere/slideless`; Postgres role/db `slideless`; port 3000; `EDITION=oss`.

## Layout

| Path                                | What                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/server`                       | The single deployable: Hono API, identity, MCP, jobs, storage                                           |
| `apps/dashboard`                    | SvelteKit SPA, built into and served by the server image                                                |
| `packages/db`                       | drizzle schema + migrations, incl. generated `auth-schema.ts`                                           |
| `packages/contract`                 | zod schemas + route contracts shared by server, SDK, dashboard                                          |
| `packages/sdk`                      | Typed client over the contract (hand-written today)                                                     |
| `packages/cli`                      | Typed CLI over the SDK; the `slideless` binary (docs/agents/cli.md)                                     |
| `Dockerfile` + `docker-compose.yml` | The shipped image and the operator stack                                                                |
| `docs/`                             | PUBLIC docs only — synced to the docs site; subfolders = sidebar groups, `docs/nav.yml` is the contract |
| `internal/`                         | Engineering docs + ADRs (`internal/decisions/`), never published                                        |

## Invariants — never regress these

- **Fail-closed scope allowlist** (`apps/server/src/middleware/scopes.ts`): machine principals (API
  keys, OAuth tokens) reach ONLY allowlisted routes; anything unlisted 403s. New endpoints stay
  unreachable to machines until consciously opened.
- **Closed sign-up needs three switches**: the `/sign-up` hook, `disableSignUp` on the emailOTP
  plugin, and `disableSignUp` on each social provider. Removing any one reopens sign-up.
  **Cloud edition, the deliberate fourth switch**: the `antasphere` genericOAuth provider's
  `disableSignUp` stays UNSET — hub SSO IS the sanctioned account entrance there (JIT,
  internal/federation.md). Setting it bricks every first cloud login; it exists only on
  `EDITION=cloud` boots, so oss stays a three-switch closure.
- **Migrations run under a session-scoped `pg_advisory_lock` on a dedicated client** — multi-replica
  safe. Never switch to a transaction-scoped lock.
- **Auth schema drift guard**: any Better Auth config change that alters the schema must regenerate
  `packages/db/src/auth-schema.ts` + the snapshot via the pinned CLI, plus an additive drizzle
  migration. CI's `drift:check` gates it.
- **Never render user content on the app origin** — files are served `attachment` + `nosniff`
  (docs/security/security.md).
- **Deck reads are private, never workspace-wide (ADR 013)**: every presentation read (get,
  versions, version detail, asset download, and the list's WHERE scope) goes through
  `canReadDeck` — deck owner, workspace admin/owner, or an ACTIVE collaborator grant on THAT
  deck. A failed read check answers **404, never 403** (deck existence is not probeable).
  Workspace membership alone is NOT a deck read grant — collaborators are external parties
  invited to one deck, and revoking a grant must cut content access immediately.
- **The BLOB surface carries the same policy (SL-B1, ADR 013 amendment)**: the generic
  `/files` routes — list, `GET /files/{id}`, `GET|HEAD /files/{id}/content`, DELETE — apply
  `blobReadScope` (`presentations/service.ts`), the SQL form of `canReadDeck`: blobs you
  uploaded, plus blobs referenced by a LIVE version of a deck you can read; workspace
  admins/owners keep the whole-workspace operator view. 404, never 403. **Never authorize a
  blob read on `workspace_id` alone** — that was a whole-tenant content channel open to every
  plain member and every `presentations:read` key. The SAME predicate is the commit guard:
  `lockAndResolveBlobs` resolves only readable shas (an unreadable one reports as
  `missing_blobs`, never its own code — the refusal must not confirm the bytes exist), and
  `precheckMissing` is scoped the same way so "already present" is not an existence oracle.
  Possession lives in `file_uploaders`, NOT `files.created_by`: content-addressed dedupe
  means the second uploader of identical bytes lands on the first uploader's row, so every
  upload path must record its uploader or it locks people out of their own bytes.
- **Guest origin is a capability boundary (D2, internal/federation.md "Guests")**: a
  `workspace_members.origin='guest'` row exists for principal resolution only. Guests keep
  every ADR 013 per-deck surface their grant opens but are refused deck creation, the generic
  `/files` surface (reads included — the host tenant's file cabinet is a workspace-level
  surface; the guest's per-deck read is served by `/presentations/{id}/assets/{sha256}`),
  the member roster, and the workspace export on BOTH editions (`requireNonGuest`, 403
  `guest_forbidden`), across sessions, API keys, and OAuth bearers alike. Guest roles are
  locked (`guest_role_locked`); only the claim path writes guest rows; the hub reconcile
  never touches them. On cloud, guests get hub identities (the claim page is SSO-first; the
  claim endpoint answers `sso_required` instead of minting local-password accounts).
- **Cloud closes the local password-reset surface (P8, ADR 017)**: on `EDITION=cloud`, every
  reset-shaped route — `/request-password-reset`, `/reset-password` (POST + tokened GET), the
  emailOTP reset trio — answers 403 (before-hook in `identity/better-auth.ts`;
  `sendResetPassword` never wired there), and the admin `/members/{id}/reset-link` mint refuses
  `password_reset_disabled`. A hub-JIT user must never be able to SET a local password and
  sidestep SSO. `/sign-in/email` stays WIRED on both editions (the break-glass operator door,
  which never needs a reset); oss keeps the full reset surface unchanged. Re-verify the route
  enumeration (`isPasswordResetPath`) on any Better Auth bump.
- **Cloud closes the OTP MINTING entrances too (D1 hub-only credentials, ADR 017 §7 charter
  call taken 2026-07-13)**: on `EDITION=cloud`, the emailOTP session surface —
  `/sign-in/email-otp`, `/email-otp/verify-email` (config insurance), the send leg — answers
  403 `otp_signin_disabled` (`isOtpSignInPath`, same before-hook; re-verify on any Better Auth
  bump), and the tool's own CLI OTP mint (`/cli/auth/request` + `/cli/auth/complete`) answers
  403 `cli_otp_disabled` steering to `antasphere login`. Every cloud credential — human session
  AND CLI key — must trace through the hub so its audit log is the complete access record.
  `DELETE /cli/auth/key` (the logout SELF-revoke: a presenting key kills exactly itself) stays
  OPEN on both editions and is the one deliberate `/cli/auth` opening in the machine scope
  allowlist (`presentations:write`, method-keyed) — never close it, and never widen it to a
  named-key revoke. `/sso/cli-connect` (the sanctioned cloud CLI mint) and `/sign-in/email`
  are untouched; oss keeps OTP login + CLI mint unchanged. **The Google social provider is the
  third non-SSO session entrance and is closed the same way**: `socialProviders.google` is
  registered only when NOT cloud (`!hubSso` in `identity/better-auth.ts`), so a cloud instance
  with `GOOGLE_CLIENT_ID`/`SECRET` set still leaves `/sign-in/social` unregistered (404
  `PROVIDER_NOT_FOUND`) — by construction, not by leaving the env unset. Rule: no non-SSO
  session entrance on cloud except the break-glass `/sign-in/email`; oss keeps Google social
  when configured.
- **Cloud federation is USER-scoped and live (ADR 019, internal/federation.md "Live reconcile +
  grant")**: every hub read between logins is `GET <hub>/orgs` AS THE USER with that user's own
  stored grant (encrypted on the `account` row) — there is NO service key, no cross-tenant
  surface, and no target-user parameter anywhere; never reintroduce one (the master-key drill's
  lesson). A credential identifies a USER: `slk_` keys and OAuth grants are unpinned by default
  (the org is a per-request `X-Workspace-Id`/tool-argument parameter; a key's `workspace_id` is
  an optional least-privilege PIN), org claims are never read from any token (login = id_token
  identity + fail-closed reconcile; connect = the same), and grant refreshes MUST stay
  single-flighted per user (in-process + `pg_advisory_lock(7432004, hashtext(userId))`,
  re-read-after-lock) — the hub's RFC 9700 reuse detection makes an unserialized double-refresh
  a grant-family-killing event. Gate verdicts: dead grant → 401 `hub_grant_expired` (immediate;
  a browser SSO re-login heals), stale-beyond-15-min + failing hub → 403 `hub_unavailable`,
  swept membership → 401 `membership_revoked`, `hub_status='suspended'` → 403
  `account_suspended` (GET /me exempt — visible-but-blocked). **Orphan-purge HARD CONSTRAINT**
  (`jobs/pgboss.ts`): never delete an `antasphere` account row while leaving an `origin='hub'`
  membership row — whole-user delete or nothing, else the reconciler's fail-open `no_link`
  branch becomes reachable for hub-origin principals.
- **Hub-origin workspaces are hub-managed (P7, internal/federation.md)**: on `EDITION=cloud`, every
  local membership MUTATION on a projected workspace (`centralAccountId IS NOT NULL`) — invitation
  create/accept/revoke, member role-change/deactivate/reactivate/delete, reset-link,
  change-email-link — answers 403 `hub_managed` + `details.manageUrl`
  (`middleware/hub-managed.ts`, keyed on `principal.accountRef`, method-keyed non-GET). READS stay
  (`GET /members`, invitation list/lookup); the per-deck collaborator surface stays the sanctioned
  local path; cloud-LOCAL workspaces (operator's, deck-guest hosts) and oss are untouched. The
  dashboard adapts off `/me`'s `workspace.hubOrigin`/`origin`/`hubManageUrl`, never
  edition-sniffing.

## Commands

```bash
pnpm install
pnpm turbo lint typecheck test build   # the CI gate
pnpm turbo test:integration            # real Postgres via testcontainers; needs Docker
```

Local dev mail: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` runs Mailpit
and points the SMTP driver at it (internal/dev-mailpit.md).

## Before you change things

- **LESSONS.md** — read it before touching auth, MCP, or Docker packaging; it records the traps
  already hit (inherited from the template) and why the current shapes exist.
- **TEMPLATE-FEEDBACK.md** — friction/improvement ideas that concern the upstream
  codika-platform-template. Never fix the template from here; append to this backlog instead.
- **internal/decisions/** — ADRs: version pins (001, the exact-pinned Better Auth trio), MCP transport
  (002), OIDC client deferral (003), pgvector (004), auth-surface + metrics defaults (005).
- **internal/production-readiness.md** — the honest gap list and roadmap.
- **internal/backup-and-data-sovereignty.md** — deferred design note: why durable backups must stay
  EU-sovereign (self-hosted DB in the instance + encrypted offsite to European object storage, not
  Neon/US), the AUTH_SECRET-in-/data recovery trap, and the open decisions. Read before building a
  backup system. Today's operator runbook for the existing scripts is docs/operations/backup-restore.md.
