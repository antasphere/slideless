# Lessons

Corrections and confirmed approaches, with why they mattered. Update in place;
delete entries that later prove wrong.

## Confirmed approaches

- **Session-scoped `pg_advisory_lock` on a dedicated `pg.Client` around
  `migrate()`** survives a two-replica race (verified: exactly one applies,
  both healthy). A transaction-scoped lock would release at drizzle's first
  internal commit.
- **`ctx.request` distinguishes HTTP from server-side Better Auth calls.**
  The before-hook that closes public sign-up checks `ctx.path.startsWith('/sign-up') && ctx.request`;
  server-side `auth.api.signUpEmail` (setup, invitation accept) carries no
  request and passes.
- **Better Auth CLI generate output is snake_case columns / camelCase
  properties / singular tables / TEXT ids** on the 1.6.x line — friendlier
  than older reports suggested. FKs from domain tables to `user.id` must be
  `text`.
- **`pnpm deploy` + a `"files": ["dist", "public"]` allowlist** produces the
  runtime layout; never bundle pino/pg/pg-boss (dynamic requires + transport
  workers break).
- **The oauth-provider consent dance is signed-query round-tripping** (1.6.15):
  `GET /oauth2/authorize` with a session but no stored consent answers a
  redirect to `consentPage?<signed query>` (all original authorize params +
  `exp` + issued-at + `sig`, HMAC'd with the auth secret). The consent page
  posts that query string back VERBATIM as `oauth_query` to
  `POST /oauth2/consent` `{ accept, oauth_query, scope? }` (session cookie
  required); the plugin verifies `sig` server-side, records the consent, and
  returns the client redirect (with the authorization code). No custom
  validation endpoint needed — the signature IS the API-side validation.
- **`customAccessTokenClaims` gates JWT issuance on BOTH grants**
  (authorization_code and refresh_token) — throwing `APIError('FORBIDDEN')`
  there when the live `workspace_members` row is missing/inactive aborts JWT
  minting. It is NOT the revocation mechanism, though: a refresh without the
  RFC 8707 `resource` param still mints an OPAQUE token that never passes
  through the claims callback (verified live, M9). The real enforcement is
  resource-side — the live membership re-check on every request, plus the
  bearer gate's `looksLikeJwt` rejecting opaque tokens outright.
- **Stateless `@hono/mcp`: one McpServer + `StreamableHTTPTransport({
enableJsonResponse: true })` per request** — no session ids, POST responses
  are complete JSON, GET is 405, and the official SDK client is happy. Omit
  `sessionIdGenerator` entirely; passing an explicit `undefined` trips
  `exactOptionalPropertyTypes`.
- **The MCP SDK Client needs a real listening server** — it dials a URL, so
  the dance test serves the booted Hono app on an ephemeral port with
  `@hono/node-server` (pick a free port first: PUBLIC_BASE_URL must equal the
  real origin because it is issuer, discovery root, and `/mcp` aud at once).
  `app.request()` stays fine for everything that isn't the SDK client.
- **The oauth-provider plugin's per-grant value seam is `postLogin.consentReferenceId`**
  (1.6.15, ADR 014): the callback (`{ user, session, scopes }` — no request
  body, no headers) runs on every authorize AND on the consent POST; its
  return value is stored on the consent row (consents are keyed
  client+user+referenceId), embedded in the authorization-code verification
  value, persisted on the refresh-token row, and handed to
  `customAccessTokenClaims({ referenceId })` on BOTH grants — refresh
  re-mints receive the STORED value with no extra plumbing. The generated
  auth schema already has the `reference_id` columns (plugin-static), so no
  drift. `postLogin` requires `page` + `shouldRedirect` too; a constant
  `() => false` keeps the picker on the consent page itself. Because the
  callback sees only the session, a user CHOICE must be parked
  session-visibly first (we use a verification-table row keyed to the
  session id, written by `POST /oauth/consent-workspace`). Throwing an
  APIError inside the callback fails the authorize with a 403 RFC-error
  body (not a redirect) — the fail-closed path for stale selections.
  Re-verify all of this on ANY Better Auth bump.
- **The drift guard absorbed the plugin tables cleanly**: adding jwt +
  oauthProvider to `scripts/auth-schema-config.ts` makes the pinned CLI emit
  `jwks` + 4 `oauth_*` tables (snake_case tables, camelCase index names);
  regenerate snapshot + `packages/db/src/auth-schema.ts` together and let
  drizzle-kit produce the additive migration. Same shape for `twoFactor`
  (I5): one `two_factor` table + `user.two_factor_enabled`, migration 0011,
  zero drift surprises.

## Corrections

- **Setup must claim + create workspace + membership in ONE transaction.**
  The first implementation could persist the singleton claim and then fail,
  leaving `setupRequired=false` with no owner — a bricked instance (proven by
  the M1 verifier). The Better Auth user is created outside the transaction
  (it cannot join); a losing racer leaves an orphaned user who can sign in
  but gets 401 everywhere. Setup retries reuse an existing owner account only
  after the presented credentials sign in successfully.
- **`VAR=` (empty string) in compose must mean "unset"** for optional env
  vars; zod `.optional()` alone rejects it. Every optional var goes through
  the empty-string preprocessor — which must **trim**: `VAR=' '` (whitespace)
  is `Number(' ') === 0`, so an untrimmed blank silently flips a `min(0)`
  numeric knob (e.g. the API rate limit) to its 0/disabled meaning instead of
  the default. `blankToUndefined` in `env.ts` trims; enum vars fail loudly on
  whitespace anyway, only meaningful-zero numerics were silently affected.
- **The Better Auth CLI silently writes nothing when the output file already
  exists** — hand it a fresh path in a temp dir, never a `mktemp`-created file.
- **The standalone `@better-auth/cli` version line (1.4.x) differs from
  better-auth (1.6.x)**, its bin is `better-auth`, and it vendors its own
  better-auth — so pnpm overrides for `@better-auth/core` must be scoped to
  the 1.6.15 parents or they poison the CLI's tree.
- **Drift-diff normalization needs the repo prettier config passed
  explicitly** — a temp file outside the repo gets prettier defaults and the
  diff false-positives.
- **`api.use('/thing/:id', gate)` also gates `/thing/lookup` and
  `/thing/accept`** — sibling literal segments under a param pattern need an
  explicit skip in the middleware, and the skip must be METHOD-exact or a
  DELETE /thing/lookup walks past the gate into a null-principal 500.
- **Never trust x-forwarded-for by default.** Rate-limit buckets and audit
  IPs derive from the socket address unless TRUST_PROXY opts into XFF
  (behind Caddy). Trusting XFF unconditionally let anyone rotate buckets
  (nullifying every per-IP limit) or fill a victim's bucket; the constant
  fallback also collapsed all direct clients into one shared bucket.
- **"Sign-up closed" needs three switches, not one**: the /sign-up hook,
  `disableSignUp` on the emailOTP plugin (OTP to an unknown email otherwise
  MINTS a user), and `disableSignUp` on each social provider (the OAuth
  callback otherwise creates users).
- **Machine-principal READS must be audited** — API keys mostly read, so
  auditing only mutations made "the key's identity lands in the audit log"
  (exit criterion 4) unsatisfiable.
- **Better Auth 1.6.15 wire quirks the clients must tolerate**: dynamic client
  registration answers **200**, not RFC 7591's 201; and `authorize`/`consent`
  return `{ redirect: true, url }` as JSON (HTTP 200) whenever
  `sec-fetch-mode: cors` is on the request (Node fetch sends it too) or
  `accept: application/json` — a 302 Location only for real browser
  navigations. The SPA consent page and any scripted client must handle the
  JSON shape.
- **Tokens minted without the RFC 8707 `resource` param are opaque, not
  JWTs** — they fail `looksLikeJwt` and die at the bearer gate. Correct MCP
  clients always send `resource`; the failure mode is a clean 401, not a
  confusing verification error.

## M8 (security review + final sweep)

- **The base image's bundled npm was the only vuln source.** After pruning
  esbuild/drizzle-kit, the last two HIGH CVEs (picomatch, sigstore) were in
  `/usr/local/lib/node_modules/npm` — npm's own vendored deps, not ours. The
  runtime runs `node dist/index.js` and never invokes npm, so
  `rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm*` in the runtime
  stage clears them AND trims the image. Trivy's Node scanner reads nested
  bundled package.json manifests, so a clean `/app/node_modules` isn't enough.
- **`pnpm deploy --prod --legacy` re-resolves independently of the frozen
  lockfile** and drags better-auth's peer-resolved `drizzle-kit` (→ esbuild
  Go binaries, the bulk of the CVEs) into the prod tree. Prune it in the
  Dockerfile — but NOT `kysely`, which better-auth statically imports at
  module load (`db/get-migration.mjs`); removing it dangles a symlink Node
  DOES follow → boot crash. "Verify each prune target isn't in a static
  import graph" is now enforced mechanically at build time by
  `scripts/prune-runtime-deps.mjs` (see the I1 entry below).
- **Never split a base64url credential on `_`.** Two flaky tests derived a
  key's secret/keyId via `key.split('_')[n]`, but base64url contains `_`, so
  the fragments were wrong ~1/7 of the time (a short fragment collided with a
  UUID; a truncated keyId failed the format check and skipped the rate-limit
  wall). Capture `keyId` from the mint response; assert the full key never
  reappears.
- **Open-redirect: a single leading slash is not enough.** `//evil.com` and
  `/\evil.com` are browser-resolved to external origins. `safeNext()` rejects
  those and requires exactly one leading slash.
- **Image size is 440MB vs the ~300MB soft target** — the batteries-included
  single image ships the aws-sdk v3 s3 driver (~100MB), OpenTelemetry, the
  MCP SDK, and the OAuth server. Trimming would mean a lazy/optional s3
  driver or two image variants; deferred as not worth the complexity for a
  template. Recorded as a known deviation.

## Post-M8 (account recovery + hardening pass, 2026-07-04)

- **Better Auth 1.6.15's core `hooks.before` is the only seam to scheme-check
  DCR client metadata.** The oauth-provider plugin validates only
  `redirect_uris`; `client_uri`/`logo_uri` accept any string, so a stored
  `javascript:` URI could reach a render site. The hook must cover
  `/oauth2/register` AND `/oauth2/create-client` AND `/oauth2/update-client`,
  and update-client nests the fields under `update`.
- **The admin reset link mints into Better Auth's own `verification` table**:
  `auth.$context.internalAdapter.createVerificationValue({ identifier:
'reset-password:<token>', value: userId })` is the exact shape
  `POST /reset-password` consumes. No schema change, no drift.
- **Better Auth-native routes bypass the /api/v1 audit middleware.** A
  `hooks.after` matching `/change-password` reads
  `ctx.context.session.user.id` (populated because the route is
  session-gated), and `emailAndPassword.onPasswordReset` covers reset; both
  fire an injected `onAccountEvent`.
- **The 3-segment `/members/:id/reset-link` is NOT covered by the 2-segment
  `api.use('/members/:id', requireRole('admin'))` gate.** Every extra path
  segment needs its own explicit gate.
- **Caddy ≥2.5 discards client-supplied `X-Forwarded-*` by default.** The app
  reads the RIGHTMOST hop, which is correct under both overwrite and append
  proxies; the leftmost hop is client-claimed whenever a proxy appends.
- **The nightly audit purge must delete in bounded batches.** One unbatched
  DELETE seq-scans and blows the pool's `statement_timeout` on a large table,
  so retention silently never runs; the `created_at` index (migration 0004)
  keeps each batch fast.
- **A Node consumer of the SDK (the CLI) typechecks without a DOM lib only
  because the browser-only `cache` and body fields are cast to
  `RequestInit`.** Keep those casts when touching the SDK's fetch calls.

## M6 (email change, 2026-07-06)

- **The admin change-email link couples to `createEmailVerificationToken`
  from `'better-auth/api'`** (1.6.15: `(secret, email, updateTo?, expiresIn
= 3600, extraPayload?)`). It signs the exact HS256 JWT `GET /verify-email`
  consumes — payload `{email, updateTo, requestType}`, signed with the auth
  secret, requestType `'change-email-verification'` for the direct-change
  branch. Never hand-roll the jose call; re-verify the payload shape and the
  export on ANY Better Auth bump.
- **Change-email tokens are STATELESS JWTs — never stored in the
  `verification` table** (unlike reset-password tokens, which tests fish out
  of the DB). The only observation seam is the outbound mail, hence
  `RecordingEmailDriver` behind the `BootOverrides.email` seam. They also
  cannot be revoked; the 1 h expiry is the whole mitigation.
- **Template users are `emailVerified = false`, so the SINGLE-LEG flow is the
  common case**: `POST /change-email` mails exactly one verification link to
  the NEW address via top-level `emailVerification.sendVerificationEmail`
  (mandatory wiring — without it the endpoint 400s before any email lookup).
  The confirmation-to-the-OLD-address leg
  (`changeEmail.sendChangeEmailConfirmation`) only runs for verified users.
- **Consuming a change-email JWT while logged out CREATES a session for the
  target user** — the link is sign-in-equivalent. A different signed-in user
  is rejected (INVALID_USER), but logged-out consumption signs the target in
  and sets the cookie. The admin copy-link dialog must say "hand this to the
  member only", and the mint route stays session-only (deliberately unlisted
  in the machine scope allowlist).

## M9 (adversarial-campaign fixes, 2026-07-07)

- **The stateless MCP transport does NOT 405 a non-POST on its own.** A GET
  reaching `StreamableHTTPTransport.handleRequest` opens a long-lived
  server-initiated SSE stream and DELETE answers a session teardown, even
  with no `sessionIdGenerator` — the "GET is 405 by design" claim was
  aspirational. Reject non-POST explicitly in `src/mcp/http.ts` (405 +
  `Allow: POST`, JSON-RPC envelope) BEFORE invoking the transport, and
  convert the transport's thrown `HTTPException` (malformed / non-JSON-RPC
  POST body) into its own JSON-RPC 400 response so it never surfaces as a
  generic 500.
- **Every `{id}` path param needs `z.uuid()` (or an in-handler `isUuid`
  check for the plain-Hono routes).** A bare `z.string()` param lets a
  non-UUID id reach Postgres' uuid cast → `invalid input syntax for type
uuid` → sanitized 500. Validate at the contract (`uuidParams` in
  `routes/index.ts`) so it is a clean 400 validation_error. This generalizes
  the literal-segment trap: `DELETE /invitations/lookup` now fails the uuid
  param check (400) rather than walking into a 500.
- **A JSON 404 terminator (`api.all('*', …)`) must be mounted LAST on the
  `/api/v1` sub-app**, or unmatched API paths fall through to the SPA
  catch-all and a browser session gets the dashboard HTML at 200. Machine
  principals never reach it — the fail-closed scope gate 403s first.
- **Audit cursors need `Number.isSafeInteger`, not just `Number.isFinite`.**
  `Number('99999999999999999999')` is finite but past bigint precision;
  feeding it to `lt(id, …)` overflows Postgres → 500. Treat out-of-range
  like NaN (ignore, serve page 1).
- **The sdk/contract/cli `exports` must point at built `dist` JS, not
  `./src/index.ts`.** The CLI ships as built JS; when `@slideless/sdk` (and
  `@slideless/contract`) resolved to raw TS, `node dist/bin.js` loaded
  TypeScript with parameter-property constructors and threw
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Any package a built binary loads at
  runtime needs a `dist`-pointing `exports` (+ a real build step) so it runs
  without tsx.
- **Last-owner delete is race-free via a DB trigger + app-level advisory
  lock** — see ADR 006. The trigger takes a per-workspace
  `pg_advisory_xact_lock` before its survivor check (READ COMMITTED alone
  lets two concurrent deletes each see the other's row); the app surfaces
  hold a per-workspace SESSION advisory lock on a dedicated client (the
  migration-lock pattern) across their guard + cascade so the race loser
  gets 400, not the trigger's 500. Session lock namespace (7432003) is
  distinct from the migration lock (7432001) and the trigger's xact lock
  (7432002): the session lock wraps the cascade while the trigger lock is
  taken inside it, so a shared key would self-deadlock.

## I1 (Docker prune hardening, 2026-07-07)

- **A blind `rm -rf` on `.pnpm` store dirs is a time bomb, not a prune.** It
  leaves dangling symlinks that only "work" because nothing follows them at
  runtime; a pnpm layout change or a dependency bump that makes a pruned
  package statically reachable (the kysely class of trap, M8) would pass
  every local gate and crash at container boot. The fix keeps the explicit
  deny-list (drizzle-kit / esbuild / @esbuild/\* / @esbuild-kit/\* /
  typescript) but moves prune AND proof into ONE build-stage script,
  `scripts/prune-runtime-deps.mjs`, so removal and verification share the
  list and cannot drift. It fails the image build on: a dangling symlink not
  attributable to the deny-list, a deny-listed package surviving anywhere
  (store rename, vendored nested copy), a declared server dependency that no
  longer resolves (covers the four lazily imported drivers a graph load
  never touches: ioredis, nodemailer, resend, the OTLP exporter), and
  `node dist/index.js --boot-check` failing.
- **`--boot-check` is a 3-line early exit in `src/index.ts`, and it is a
  full-graph proof for free**: `dist/index.js` is one tsup bundle whose bare
  imports stay external, and `import { boot }` is static — so by the time
  the flag check runs, Node has already resolved and initialized the entire
  static runtime graph (better-auth → kysely, pg, pino, pg-boss, drizzle-orm,
  aws-sdk, MCP SDK, …) with no env, DB, or listener needed. Pruning anything
  statically reachable = ERR_MODULE_NOT_FOUND = the docker build fails
  (validated: adding kysely to the deny-list kills the build at this step,
  and it is the ONLY step that catches it — kysely is transitive, so the
  declared-deps check alone would miss it). release.yml builds the image on
  every push, so this guard is a CI gate, not a local ritual.

- **`@types/yazl` types `zip.outputStream` as the legacy
  `NodeJS.ReadableStream`** — but at runtime it is a real `Readable` (a
  PassThrough). `destroy()` and `Readable.toWeb()` need the concrete type, so
  cast once at the top (`zip.outputStream as Readable`) and thread that; don't
  scatter the cast (`api/export.ts`).
- **A zod-openapi `responses` entry with NO `content` key is what lets an
  `api.openapi` handler return a plain streamed `Response`.** The 200 for
  `GET /workspace/export` is `{ description: '...' }` only; add a `content`
  schema and @hono/zod-openapi's conditional types then demand a matching
  validated body and `c.body(stream)` stops typechecking.
- **yazl sequential-blob discipline is two separate facts.** (1) `await
finished(sourceStream)` after each `addReadStream` gives natural
  one-at-a-time backpressure, so descriptors / S3 sockets never pile up on a
  multi-blob export. (2) yazl's `errored` latch only trips on errors emitted
  by the ZipFile itself — destroying `outputStream` does NOT stop the pump, so
  entries queued after an abort are still opened and fully drained. A long
  pump needs an explicit `signal.aborted` check inside the loop or a cancelled
  multi-GB export keeps consuming bandwidth (`api/export.ts` blob loop).
- **Better Auth `/delete-user`'s `beforeDelete` / `afterDelete` are ROUTE-level
  hooks** — they fire only for the self-service HTTP endpoint. The admin
  surface deletes via `internalAdapter.deleteUser` (the same path, adapter
  hooks kept, cascade + SET NULL applied) which fires NEITHER, so
  `DELETE /members/{id}` must write its own `member.delete` audit row; the
  self-service path gets its `user.account_delete` system-actor row from
  `afterDelete`.
- **Re-verify FK on-delete semantics from `schema.ts`, never from a planning
  doc.** The GDPR plan claimed `invitations.invited_by` was `set null`; the
  schema has it `notNull()` + `onDelete: 'cascade'` (so a deleted user's
  invitations vanish with them, tokens stop resolving). The set-null
  anonymization applies to `audit_log.actor_user_id`,
  `workspace_members.invited_by`, and `files.created_by`; `api_keys.created_by`
  cascades. Grep every `created_by`/`invited_by` reader before assuming.
- **The dashboard vitest run needs SvelteKit's path aliases declared by hand.**
  Plain vitest doesn't know `$lib`; `apps/dashboard/vitest.config.ts` adds
  `resolve.alias.$lib` (alongside the svelte plugin + `browser` condition that
  compile the `.svelte.ts` runes modules) or the i18n catalog tests fail to
  resolve their imports.

## I5 (2FA + invite verification, 2026-07-07)

- **Better Auth 1.6.15's twoFactor sign-in hook covers ONLY
  `/sign-in/email|username|phone-number` — `/sign-in/email-otp` walks
  straight past the second factor.** An enrolled user could be signed in by
  anyone controlling the mailbox. The closure lives in the config-level
  `hooks.after` (`identity/better-auth.ts`): user hooks run BEFORE plugin
  hooks in `api/dispatch.mjs`, and a returned `ctx.json(...)` replaces the
  response (`context.context.returned`), so mirroring the plugin's dance
  (delete the minted session via `internalAdapter`, `deleteSessionCookie`,
  `setNewSession(null)`, park a `2fa-<rand>` verification value behind the
  signed `two_factor` cookie) hands the email-OTP path the exact same
  `{ twoFactorRedirect: true }` step that `/two-factor/verify-totp`
  completes. `deleteSessionCookie` imports from 'better-auth/cookies',
  `generateRandomString` from 'better-auth/crypto'. Re-verify the mirror
  against the plugin's index.mjs on ANY Better Auth bump. Google social
  sign-in has no equivalent seam (redirect flow) — documented as IdP-trust
  in ADR 009, not silently ignored.
- **Invite-token possession never proves the invitee's email** — the create
  response always returns the copyable `acceptUrl`, so even an "emailed"
  invitation's token is admin-visible. Making acceptance set `emailVerified`
  honestly required a SECOND token that only the email carries
  (`invitations.email_token_hash`, migration 0012); which hash matched tells
  the accept route whether mailbox control was demonstrated.
- **2FA verify/activate rotates the session** — after `/two-factor/verify-totp`
  (activation) and `/two-factor/disable`, the old cookie's session row is
  deleted; tests and UI must adopt the fresh set-cookie or every subsequent
  session call 401s.
- **The 2FA enable/disable password gate holds ONLY because `allowPasswordless`
  is unset.** Better Auth's `shouldRequirePassword` short-circuits to `true`
  when `allowPasswordless` is falsy — that is the entire reason a hijacked
  session can't toggle 2FA without re-auth. A product that sets
  `twoFactor({ allowPasswordless: true })` silently drops the re-auth
  requirement for any user without a credential account. Do NOT set it without
  re-auditing the disable gate.

## I2 (multi-replica scale drill, 2026-07-07)

- **pg-boss serializes its schema install internally but NOT `createQueue`
  — wrap the whole install section in the app's own advisory lock.**
  (Verified in pg-boss 10.4.2 source: the `locked()` xact-advisory wrapper
  covers only migrations; `createQueue` executes `pgboss.create_queue(text,
json)` — queue-row insert + per-queue partition CREATE TABLE/attach — bare.)
  Concurrent fresh-DB boots of 2+ all|worker replicas reliably deadlocked
  there (Postgres `DeadLockReport`) and crash-looped until a docker restart
  found the rows in place (`ON CONFLICT DO NOTHING`). Fix (`jobs/pgboss.ts`):
  `start()` + `createQueue` + nightly schedules run under a session-scoped
  `pg_advisory_lock` on a dedicated client (the migrate.ts pattern), key
  **7432004** (distinct from 7432001 migration / 7432002 trigger xact /
  7432003 last-owner session). Boot-setup only: `work()` registration and
  steady-state `send()` stay outside the lock, and `SERVICE_ROLE=api`
  (migrate:false, no queue creation, no DDL rights) never acquires it — its
  documented fresh-DB crash-loop on 'pg-boss is not installed' is unchanged.
  The drill now hard-fails any restart during the 3-replica fresh boot and
  greps the Postgres log for `deadlock detected` (must be 0).
- **A cross-replica read of a local-storage blob died mid-stream after a
  200, not with a 404** — the replica trusted the shared metadata row, sent
  full headers, then the body stream hit the missing file (curl exit 18,
  truncated transfer): silent corruption, not an error. Two-layer fix: the
  content route checks `storage.exists(key)` before committing any status
  line (GET, HEAD, and Range all 404 `not_found` when the row exists but the
  bytes are unreachable on this replica), and `LocalStorageDriver.getStream`
  opens eagerly (`fsPromises.open` + `handle.createReadStream`) so a missing
  blob rejects at the await — matching the s3 driver's eager GetObject —
  instead of erroring after headers. The 404 is a safety net: Profile B
  requires `STORAGE_DRIVER=s3`; local storage is single-replica only.
- **A compose `tmpfs` mount is root-owned; the image runs as `node`.** Mount
  `/data` as an anonymous volume instead (ownership copied from the image
  dir, removed by `down -v`) — tmpfs at `/data` makes every replica crash
  with `EACCES: mkdir /data/storage` under `read_only: true`.
- **`pgboss.version.cron_on` is a clean scheduler observable.** Any instance
  running the timekeeper (`schedule: true`) bumps it every ≤30 s
  (cronMonitorIntervalSeconds); with only `SERVICE_ROLE=api` replicas alive
  it freezes — the drill's proof that the api role runs no scheduler without
  waiting for a 03:00 cron.

## I6 (break-glass + orphan GC, 2026-07-07)

- **A membershipless account in `SUPERADMIN_EMAILS` is itself an orphan-GC
  candidate.** Break-glass recovery deliberately works from a `principal:null`
  (no-membership) session so it can rescue a workspace that lost its owners —
  but the orphaned-user purge deletes exactly those no-membership users past
  `ORPHAN_USER_RETENTION_HOURS` (72h). So the two features interact: arm the
  allowlist and run `claim-ownership` promptly; once the operator account has a
  membership it is out of GC scope. Documented in the security.md runbook.
- **Break-glass endpoints skip `requireAuth`/`requireRole` but must still
  validate a real session.** They resolve the caller via `auth.api.getSession`
  (validates the cookie against the session store) and RE-READ email +
  `emailVerified` from the DB by user id — never from a claim/header/body — so
  a membershipless session can reach them while a forged/absent session and any
  machine principal cannot. The routes stay UNLISTED in `scopes.ts`, so the
  fail-closed scope gate 403s every API key / OAuth token (even one minted by
  the superadmin) before the handler runs. All rejection reasons return one
  uniform 403 so the endpoint is not an allowlist oracle.
- **Orphan-GC safety is layered, not a single query.** `NOT EXISTS` on ANY
  `workspace_members` row (no `is_active` filter, so a deactivated member is
  never an orphan) + a grace window + a live-pending-invitation exclusion (the
  invite row exists before its accept URL, closing the scan-then-accept race) +
  a per-row membership re-check immediately before each delete + the 0009
  trigger backstopping the sole-owner cascade. Bounded batches with a
  no-progress break; `0` disables it.

## Phase 4 (sharing + public viewer, 2026-07-10)

- **The viewer's entire isolation is one header on one route — and the
  global `securityHeaders` middleware was silently clobbering exactly that
  header.** Every `text/html` response got the dashboard CSP stamped over a
  per-route `CSP: sandbox` (found by the ADR 012 spike). The middleware now
  sets CSP/Referrer-Policy only when the route did not (set-if-absent), and
  `test/integration/sharing-viewer.test.ts` asserts the exact sandbox set —
  `sandbox allow-scripts allow-forms allow-popups allow-modals
allow-downloads`, never `allow-same-origin` — on every viewer response
  shape (entry, HTML sub-page, asset, 206, pinned/latest, password-unlocked).
  Treat any diff touching those headers as security-critical.
- **A pure secret-as-lookup-key credential cannot store a pepper version.**
  Share-token resolution computes sha256(secret + pepper) under EVERY
  registered pepper version and probes the unique hash index (O(rotations));
  API keys avoid this only because the keyId travels in the credential.
  Dropping a version from `API_KEY_PEPPERS` fails share links minted under
  it closed, same as keys.
- **Hash-only storage means "email this link" cannot resend the original
  URL** — the send route mints a fresh secret, mails it, and only persists
  the new hash after the SMTP call succeeds (a failed delivery leaves the
  old link intact). Consequence: sending retires the create-time URL for
  that token; per-recipient tokens make that the natural resend semantics
  (documented on the route contract).
- **The password-unlock cookie MACs a fingerprint of the current password
  hash** (HMAC over tokenId + expiry + hash-fingerprint, key = auth secret):
  changing/clearing the password instantly invalidates every outstanding
  unlock with zero server-side state. Cookie is token-named + Path-scoped to
  `/v/{secret}`, so it also covers asset subpaths and never leaks across
  tokens.
- **Viewer asset URLs are NOT content-addressed — never serve them
  `immutable`.** A latest-mode token re-maps paths on every push and
  revocation must bite, so assets go out `private, no-cache` with the
  content-sha ETag (cheap 304s), and the entry is `no-store` outright.

## Phase 5 (collaborators + annotations, 2026-07-10)

- **"Browser entry" for overlay injection is three conditions, not one.**
  `can_annotate` alone would hand the overlay to agents: the transform fires
  only when the Accept header includes `text/html` AND the request is not
  `?raw`/`?format=html` AND it did not authenticate agent-style via
  `x-viewer-password`. Injected responses must re-assert the full ADR 012
  sandbox header set and DROP the ETag — serveBlob's content-sha ETag would
  lie about mutated bytes (raw/plain entries keep it, tests pin both).
- **The opaque origin makes the overlay a `credentials: 'omit'`,
  `Origin: null` caller.** Its POSTs preflight (application/json is not a
  "simple" content type), so the public annotation routes need explicit
  OPTIONS handling + wildcard CORS — safe ONLY because the surface is
  token-authed, never cookie-authed (the oauth-public precedent). `omit`
  also closes ADR 012's Firefox cookie-forwarding residual for this path.
- **A password-gated token cannot re-prove the password from inside the
  sandbox** (the unlock cookie never travels cross-origin from the opaque
  origin). The server injects a signed unlock proof INTO the overlay it
  serves after the entry passed the password gate — reusing the
  viewer/unlock.ts MAC (token-scoped, password-fingerprint-bound, 1 h) as a
  header instead of a cookie. No new state, dies on password change.
- **Principals REQUIRE a workspace membership, so claim-at-signup must mint
  one.** A collaborator account created via the claim endpoint would 401 on
  every route without a `workspace_members` row (identity.resolve re-checks
  live membership) — the claim creates an ordinary `member` row, making the
  per-deck grant a layer ON TOP of workspace read access, not a substitute.
  Consequence worth remembering: any future "grant-only, no workspace reads"
  collaborator model is an auth-layer change, not a Phase 5 tweak.
- **Emit `user.created` only AFTER explicitly claiming the triggering
  grant.** The boot hook sweeps pending grants for a new account's email;
  emitting before the claim endpoint's own guarded claim would race it into
  a false "already used" 410 (the sweep and the endpoint both flip the same
  row). Order: claim → membership → sibling sweep → emit.
- **In-transaction collaborator checks keep revocation honest.**
  `commitVersion` resolves owner-vs-dev INSIDE the deck's FOR UPDATE
  transaction (`isActiveDevCollaborator(tx, …)`), so a concurrent revoke
  serializes against the commit instead of racing it — same discipline as
  the blob FOR SHARE locks.

## Phase 5 security review (deck read privacy, 2026-07-10)

- **Inheriting the template's "workspace data" read posture silently made
  every collaborator a whole-workspace reader.** The Phase 3 read handlers
  authorized list/get/versions/asset-download on `workspace_id` alone (ADR
  006's stance for files); Phase 5's claim flow then minted workspace
  memberships for EXTERNAL per-deck collaborators — proven live: a deck-A
  collaborator downloaded deck B's content, and revoking the grant changed
  nothing. Whenever onboarding mints memberships for outsiders, every
  resource read path must re-derive its own authorization (`canReadDeck`,
  ADR 013) instead of riding the workspace boundary. Failed read checks
  answer 404, never 403 — matching the existing hide-existence posture.
- **Every public account-minting endpoint needs a duplicate-account catch
  around `signUpEmail`.** Two concurrent claims of one invite both pass the
  account lookup (password hashing is tens of ms, the lookup is ~1 ms), so
  the loser's INSERT hits the unique-email violation — an uncaught 500
  until mapped to the same 409 `account_exists` the sequential path
  answers. The integration test hits this interleaving deterministically
  for the same timing reason. `api/invitations.ts` accept has the identical
  window (recorded in TEMPLATE-FEEDBACK.md, not fixed here).

## Phase 6 (CLI + CLI auth, 2026-07-10)

- **`emailOTP` with `disableSignUp` is exactly the browserless-login
  primitive** (verified against 1.6.15 routes.mjs): send-verification-otp
  for an unknown email deletes the pending code and answers a generic
  success (no mail, no enumeration, no user); sign-in-email-otp verifies
  atomically with a 3-attempt limit and maps unknown-account to the same
  INVALID_OTP as a wrong code. The CLI auth endpoints are thin wrappers over
  these two calls — never reimplement OTP storage/verification.
- **Server-side `auth.api.signInEmailOTP` runs the config hooks too**: the
  2FA after-hook intercepts an enrolled user's OTP sign-in exactly as over
  HTTP and returns `{ twoFactorRedirect: true }` with no session — so the
  CLI-auth complete endpoint refuses 2FA users (403 two_factor_required)
  without any extra check beyond "no token in the response". Never "fix"
  that into a bypass.
- **`/setup`'s `signUpEmail` auto-creates an owner session** (better-auth
  autoSignIn default) that nothing ever holds. Tests asserting session
  cleanup must diff against a baseline instead of expecting zero rows.
- **The CLI resolves its target as flag → env → profile → ERROR, no default
  URL.** With a config file in play, a hard-coded localhost default silently
  points real commands at the wrong instance; failing loudly is the feature.
  The push link file (`.slideless.json`) records `baseUrl` for the same
  reason — a folder linked to instance A errors on a push to instance B
  instead of targeting a foreign deck id.
- **`slideless dev` must mirror the ADR 012 header set** (CSP `sandbox …`,
  nosniff, no-referrer, no-store) so local previews behave byte-for-byte
  like the public viewer; the constants live in `packages/cli/src/devserver.ts`
  and `apps/server/src/viewer/routes.ts` — keep them in lockstep when the
  sandbox policy ever changes.

## Phase 7 (MCP tool set, 2026-07-10)

- **In-process multipart works: `app.request('/api/v1/presentations/assets',
{ body: FormData })` round-trips through Hono's parseBody** (File/FormData
  are Node ≥20 globals), so MCP upload tools reuse the exact API route the
  CLI hits — same hashing, same entitlement gate, same audit rows. The
  in-process Request carries no content-length, so the route's DECLARED-size
  entitlement precheck sees 0; the true-size check after parse still binds.
- **Tool-level size caps must undercut the transport cap to be reachable.**
  The /mcp bodyLimit (1 MiB) rejects oversized envelopes with a plain 413
  before any tool runs; a tool-side "too big" check equal to that cap is dead
  code. Inline uploads cap at 768 KiB decoded — the base64-inflation bound of
  a 1 MiB envelope — so the friendly use-the-CLI error is what models see.
- **The viewer's dead-token statuses differ by cause**: revoked → 403,
  expired → 410, unknown secret / deleted deck → 404 (viewer/routes.ts).
  Tests (and tools' descriptions) must not blanket-assume 404.
- **Raw JSON-RPC POSTs against the stateless /mcp are a valid test harness**:
  every request builds a fresh McpServer, nothing enforces an initialize
  handshake, and `enableJsonResponse` returns plain JSON — so tools can be
  integration-tested via `app.request` without a listening server (the
  oauth-mcp suite still proves the real SDK-client + listener path).
