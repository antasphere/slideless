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

- **`fs.promises.writeFile` is not a safe way to write a path someone else
  chose.** It follows a pre-existing symlink at the target, and its
  `O_TRUNC` write PRESERVES the existing file's mode — a `-rwxr-xr-x` file
  stayed executable across both `writeFileSync` and `fs.promises.writeFile`
  (re-proved during PRDCT-1353). `open(target, O_WRONLY|O_CREAT|O_TRUNC|
O_NOFOLLOW, 0o644)` + an explicit `fchmod` is the shape; the parent
  directory needs its own `realpath` check, because `mkdir -p` walks
  straight through an existing symlinked directory.
- **`fetch` has no default timeout** — not in Node, not in the browser. A
  peer that accepts the connection and then says nothing parks the caller
  forever. Every SDK call carries `AbortSignal.timeout` (30 s for JSON,
  10 min for the byte-streaming ones, both overridable, `0` disables).
- **`fetch` silently DROPS a `Host` header** (forbidden header name), so a
  Host-validation test has to go through `node:http` directly. Same trap
  for any other forbidden header.
- **A lexical `resolve()` + `startsWith()` is not a traversal guard.** It
  cannot see a symlink. `slideless dev` shipped one and served `/etc/passwd`
  through a link inside the deck folder; the fix is `realpath` plus a second
  containment check on the resolved path.

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
  `sandbox allow-scripts allow-forms allow-popups
allow-popups-to-escape-sandbox allow-modals allow-downloads`, never
  `allow-same-origin` — on every viewer response shape (entry, HTML sub-page,
  asset, 206, pinned/latest, password-unlocked). Treat any diff touching those
  headers as security-critical.
- **A window a deck opens inherits the deck's sandbox, whatever URL it shows
  (PRDCT-2268).** Without `allow-popups-to-escape-sandbox`, a `window.open` or
  a `target="_blank"` link from a sandboxed deck yields a top-level page running
  in an OPAQUE origin: `document.cookie` throws, its fetches carry
  `Origin: null`, and the application it points at cannot boot — while the
  address bar shows the right https URL (found on an Exos client-demo page: the
  « Ouvrir » buttons opened an app that never started). The token lifts the
  sandbox on the OPENED window only; the deck keeps no `allow-same-origin`, and
  an `about:blank` or `javascript:` popup still inherits the opener's opaque
  origin, so it hands the deck no app-origin script. It lives in all THREE
  lists — `VIEWER_CSP`, `VIEWER_IFRAME_SANDBOX`, `DEV_SANDBOX_CSP` — and the
  share link is opened TOP-LEVEL, so the CSP header on the viewer's own
  responses (not the iframe attribute) is what the reported case inherited.
  The dashboard's `decks.test.ts` and `e2e/decks.spec.ts` spell the list out
  literally; `e2e/viewer-popups.spec.ts` proves the escape in a real browser.
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

## Annotation overlay rework (anchors + multi-page, 2026-07-25 — ADR 020)

- **"Browser entry" was not enough: multi-page decks lost the overlay on
  their second page.** Sub-pages go through the ASSET route, which never
  called the injection seam — so navigation to `page2.html` silently dropped
  the annotation layer. The seam now fires for any same-deck `text/html`
  DOCUMENT navigation; `Sec-Fetch-Dest` is the discriminator (`document` =
  navigate/inject, `iframe` et al. = sub-resource/byte-exact, absent = the
  old three-condition Accept heuristic). Same rule tightened the entry: an
  iframe-embedded entry is a sub-resource and no longer gets the overlay.
- **Never re-read `getSelection()` after the composer opens.** The original
  overlay kept a module-level `selection` that every later mouseup silently
  overwrote — reviewers saved anchors pointing at text they never selected
  (PRDCT-1242). Anchors are now FROZEN into a snapshot at capture time
  (pill shown / pin placed) and submitted verbatim.
- **An in-document overlay must stop propagation at its root, or every
  overlay click is also a deck click.** Decks navigate slides off
  document-level bubble listeners; the ✎ button was advancing slides
  (PRDCT-1241). Capture-phase deck listeners still win by design — accepted
  as the cost of sharing the document (ADR 012 trust model).

## Forms audit remediation (2026-07-26 — ADR 022, PRDCT-1331..1334)

- **A trust-boundary comment written as a DESCRIPTION gets a feature waved
  through; write it as a CONSTRAINT with a test behind it.** The forms
  runtime said "the runtime adds NO capability the deck did not have". That
  was true of the share secret and the unlock proof, so a reviewer who
  checked those two stopped reading — and ADR 022 leg 3 shipped a signed
  assertion of the SIGNED-IN VIEWER's identity into the same config, which
  deck JS lifted to file responses under a stranger's account across
  workspaces (PRDCT-1331). The comment now states the invariant as a rule
  for future edits, and the injected config's KEY SET is pinned by an
  integration assertion, so adding a field turns a test red instead of
  depending on prose being read carefully.
- **Anything handed to the deck document is a capability grant, full stop.**
  It cannot be scoped by intent ("this only stamps attribution"), because
  the deck's own JS reads it and replays it. If a value identifies a
  person, it belongs on the APP origin behind an explicit click. There is
  no server-side rescue either: the submit is `credentials: 'omit'` from an
  opaque origin, so identity can never be re-derived at write time.
- **The URL FRAGMENT is attacker-controlled input, and the sandbox does not
  help.** ADR 022 §5 argued a frame was safe "by the ADR 021 §1 rationale",
  but §1 is about the sandbox regime and says nothing about the framer
  choosing the fragment. A framer planted `#slr=<their own response's edit
secret>` and harvested what visitors typed, straight through the official
  `/embed.js` loader, with the sandbox intact throughout (PRDCT-1332).
  A capability arriving in a fragment is a CANDIDATE, never an identity:
  the loader strips the fragment, and the runtime asks before adopting one.
- **A default-ON capability turns an opt-in code path into the default code
  path.** `canAnnotate` was opt-in, so buffering the whole document to
  inject was affordable. `canSubmitForms` defaults ON, and the identical
  code became a ~10x-document memory spike on EVERY share link — including
  decks with no form at all, on a route with no rate limiter (PRDCT-1333).
  When flipping a flag's default, re-audit every path it gates as if it
  were new. The fix reuses the `has_agent_doc` pattern: detect at commit,
  denormalize onto the version, and arm the seam only when it is true.
- **Assert the SHAPE of a memory curve, not a byte count.** A bounded-window
  injector and a buffering one produce identical output, so length and
  content prove nothing. Measuring bytes-in-minus-bytes-out at two document
  sizes does: the windowed one holds the same amount for both, the
  buffering one holds the document. And sample the high-water mark BEFORE
  counting each emitted chunk — sampling after reads zero for an
  implementation that flushes once at the end, which is precisely the
  implementation the test exists to catch.
- **Per-page state in a runtime that serves per-ELEMENT capabilities is a
  data-corruption bug waiting to happen.** One module-level `editSecret`
  shared by every form on the page, while ownership is per form, meant
  editing `rsvp` silently overwrote the respondent's `feedback` answer and
  the card said "updated" (PRDCT-1334). The client fix (`form.__slSecret`)
  is not the load-bearing one: the own-row routes carried NO form segment,
  so the server structurally could not detect the mismatch. Put the
  discriminator in the route, then the server refuses it whatever the
  client does.
- **A blanket `try/catch` around an injected runtime makes failure silent by
  construction.** The forms suite was 7/7 green while five of five real
  presentations broke. Removed.
- **A new Playwright project spends a SHARED, rate-limited login budget.**
  `limiters.login` is 10 per 15 minutes keyed per IP _and_ per address, and
  every project in the suite signs in as the same owner from the same IP. A
  `beforeEach(signIn)` in a five-test file took the whole suite from 7
  logins to 12, and tests 10, 11 and 12 — including `embed-forms.spec.ts`,
  which this work did not touch — failed at the LOGIN PAGE. It read exactly
  like a forms flake and was not one. Sign in once per file
  (`beforeAll` on its own context) and treat the login budget as a suite-wide
  resource when adding a project.
- **Test the runtime in its HABITAT.** The e2e specs drove a bare `<form>`
  on an empty page; every real deck binds document-level keydown and click
  navigation written years before forms existed, so clicking a field
  navigated the deck, typing a space was swallowed, submitting hid the
  confirmation card, and a deck's own `history.replaceState` wiped the edit
  secret from the URL. `viewer-forms-realdeck.spec.ts` uses fixtures whose
  navigation engines are lifted VERBATIM from
  `workspace/content/presentations/` — the value is being unmodified, so do
  not tidy them.

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

## Cloud-binding Phase 3 (hub SSO entrance, 2026-07-12)

- **Never enable `transaction: true` on the drizzle adapter.** The
  better-auth transaction runner executes queued `create.after` database
  hooks EVEN when the transaction rolled back (pinned 1.6.15,
  `@better-auth/core` `transaction.mjs`) — `user.created` would fire for a
  user row that no longer exists and the collaborator grant sweep would flip
  grants for a ghost. Today's passthrough default (no `transaction` key,
  adapter default false) is load-bearing: hooks always see committed rows on
  the outer pool (spike S1(d)).
- **Org claims exist ONLY in the callback exchange's access token.** The hub
  mints the workspace-claim JWT iff the TOKEN request carries RFC 8707
  `resource` (genericOAuth `tokenUrlParams`); the plugin's refresh shim
  drops it, so stored/refreshed hub tokens are opaque and claimless. Never
  read org context from `account.accessToken` after login.
- **jose `createRemoteJWKSet` throttles kid-miss refetches** (30 s
  cooldown): a rotation-fresh token can fail `JWKSNoMatchingKey` with no
  network attempt. `hub-jwt.ts` retries once against a rebuilt key set on
  both `JWKSNoMatchingKey` and `JWSSignatureVerificationFailed`; keep both
  arms on any Better Auth / jose bump.
- **better-auth's OAuth state is a double-submit pair**: the DB-stored state
  PLUS a signed `state` cookie set at `/sign-in/oauth2`; a callback without
  the cookie fails `state_mismatch`. Integration tests must carry the
  sign-in response's cookie into the callback request (browsers do it for
  free).
- **`hooks.after` CAN fail a completed OAuth login cleanly**: delete the
  session row, `deleteSessionCookie(ctx, true)`, `setNewSession(null)`, then
  `throw ctx.redirect(...)` — the dispatch pipeline catches the APIError and
  replaces the success redirect (same undo dance as the email-OTP 2FA
  interstitial). Used by the SSO after-hook's fail-closed path (ADR 015).

## Cloud-binding Phase 5 (CLI cross-tool connect, 2026-07-12)

- **jose's `jwtVerify` validates `exp` only when the claim EXISTS** — a
  token minted without one sails through signature+iss+aud verification.
  Any flow whose security story says "bounded by the TTL" must REQUIRE the
  claim itself (`verifyConnectToken` refuses a missing `exp`); the same
  goes for `jti` before using it as a replay handle.
- **One-time-use must be claim-FIRST**: `/sso/cli-connect` INSERTs the jti
  into `sso_connect_jtis` (PK conflict = replay, multi-replica safe) BEFORE
  provisioning/minting. Insert-after-work would let two concurrent
  presentations of one token both reach the mint. Corollary: a transient
  provisioning failure burns the token — deliberate; the caller re-exchanges
  with the hub for a fresh one (120 s tokens are free), and the safe side of
  the race is the only acceptable side on a public endpoint.
- **`internalAdapter.createOAuthUser` is the reusable SSO-JIT primitive**
  for server-side entrances (no HTTP dance): it is the exact call the
  genericOAuth callback makes, wraps user+account in the transaction
  passthrough, lowercases the email, and fires `databaseHooks.user.create`
  — so the `user.created` seam (collaborator sweep) covers a
  non-better-auth entrance for free. Mirror better-auth's own linking rules
  around it (account-by-(provider,sub) first, then trusted-link by email
  ONLY onto a VERIFIED local address) or the entrance diverges from the
  browser SSO path's takeover posture.

## The Playwright suite and the release gate (PRDCT-2268 / PRDCT-2274, 2026-09-12)

- **The Playwright suite (`apps/dashboard/e2e`) runs nowhere in CI, so it rots silently.** It
  had been dead since PRDCT-1347 made the first-boot claim require a setup token: the harness
  passed `SETUP_TOKEN=''`, every dependent project failed at the wizard, and nobody saw it for
  two weeks. Now `playwright.config.ts` mints one token in the runner process, `stack-env.mjs`
  boots the stack with it and `smoke.spec.ts` fills the field, which the wizard only reveals
  AFTER the first refused submit (`tokenRequired` flips on the `invalid_setup_token` answer).
  Run the suite locally before shipping anything the smoke exercises; CI part 1 does not.
- **Better Auth's own sign-in throttle, not ours, is what "Too many attempts" means in e2e.**
  Our `limiters.login` is 10 points per 15 minutes and consumes on FAILURE for sign-in; the
  e2e projects never fail a login. What trips is Better Auth's default special rule on
  `/sign-in*` and `/sign-up*` (3 requests per 10-second sliding window per IP), active because
  the image runs `NODE_ENV=production`, and the dashboard renders any 429 with the same
  `login.errorRateLimited` string. Projects that sign in right after the smoke hit it;
  `signInAsOwner()` in `e2e/accounts.ts` waits 12 s once and retries. A future Better Auth
  bump that widens that window makes the wait too short: re-check on any bump.
- **The prod release publishes nothing when Trivy finds a HIGH anywhere in the image**, even in
  a dependency the change never touched (nodemailer 9.0.3, GHSA-2x7j-588g-ccc2, blocked the
  PRDCT-2268 roll). Bump that dependency alone: `pnpm add` re-resolves the Better Auth
  transitive pins ADR 001 keeps exact (better-call, @better-fetch/fetch), so restore the
  lockfile and edit the package's three entries by hand (importer, packages, snapshots), then
  `pnpm install --frozen-lockfile` to validate. The roll itself, once the image is published,
  is the fleet repo's runbook: `labs/products/antasphere/infra/README.md`, "The roll as it
  actually runs".

## Blob authorization (SL-B1, 2026-07-26)

- **An ACL on the resource is not an ACL on its bytes.** ADR 013 made deck
  reads private, then left `/files` authorizing on `workspace_id` alone —
  so the same content ADR 013 protected was streamable by any member and
  any `presentations:read` key one route down. When a policy is added to a
  domain surface, sweep every OTHER surface that can reach the same rows:
  here the generic file cabinet, its DELETE, and the version-commit path
  that binds shas into manifests.
- **`files.created_by` cannot answer "does this principal hold these
  bytes".** Blobs are content-addressed and unique per (workspace, sha256),
  so the SECOND uploader of identical bytes deduplicates onto the FIRST
  uploader's row and the column keeps naming the first one. Authorizing on
  it would lock a member out of a shared logo they just pushed, and refuse
  the commit that references it. Possession is its own fact —
  `file_uploaders` (migration 0034), written on BOTH the fresh-insert and
  the dedupe branch, by every upload route.
- **Scope the existence oracle with the read.** `precheckMissing` answering
  "already present" for a blob the caller may not read is both a
  whole-workspace existence probe and a protocol dead end: the client skips
  the upload on that answer, then the commit guard refuses the sha and
  there is no way forward. Precheck and the commit guard must share one
  predicate.
- **Refuse an unauthorized sha as MISSING, not as its own error code.** A
  distinct "you may not use this blob" status would confirm that the
  workspace holds those exact bytes — the same reason a deck read answers
  404 and never 403.
  \=======

## Signing-key durability (PRDCT-1379 port, 2026-08-12)

- **A fresh instance's FIRST token issuance can mint TWO jwks rows.** On the
  pinned 1.6.15 the id_token and access-token signs run concurrently and both
  can hit `createJwk` when no key exists yet (sign.mjs has no lock around the
  get-or-create). Harmless in production (newest key signs, every key is
  published and verifies) but tests must never assert `jwks` row counts, and
  row count is not a health signal (ADR 023).
- **jose's local JWK set throws `JWKSNoMatchingKey` for an unknown kid, not
  `JWSSignatureVerificationFailed`.** A refetch-on-failure JWKS cache keyed
  to the latter alone never picks up a NEWLY minted signing key until its
  TTL — a live rotation would answer 401 for 10 minutes. The verifier
  (`identity/oauth-jwt.ts`) retries on both names; pinned by the mid-cache
  rotation test.

## Deployment posture (PRDCT-1347 / 1357 / 1356 / 1440, 2026-08-29)

- **"Optional when set" is a hole for the one request that decides ownership.**
  `SETUP_TOKEN` was checked only when configured, so a bare `docker run` produced
  a free-to-claim instance. The claim now always needs a token: env, or one
  generated into `$DATA_DIR/setup-token` at boot and printed to the log
  (`resolveSetupToken`, the same zero-config shape as the auth secret). The
  token check sits AFTER the 410 already-set-up answer so a replay never
  turns into a free claim when the token is null; the generated file is
  removed on success (it would otherwise ride in every backup). 76 test
  bodies had to grow a `setupToken` — the test helper now boots every app with
  `SETUP_TOKEN` so new suites pass it from `helpers.ts`.
- **The one unencrypted artifact defines the backup's secrecy.** With a
  passphrase the config archive was encrypted while `/data/secret` rode in
  the cleartext data tarball. `backup.sh` now `--exclude=./secret`s the
  tarball and carries the root as `data-secret` in the encrypted archive;
  `restore.sh` learned the third home (`config_secret`, written into the
  volume after the swap through a read-only mount of the decrypted WORKDIR,
  never through the backup dir). Bash 3.2 (macOS, where the unit suite runs
  the scripts) treats an empty array under `set -u` as unbound — use
  `${arr[@]+"${arr[@]}"}`.
- **An erasure replay that fails is fail-open unless the boot says otherwise
  (PRDCT-1809).** The replay deletes through Better Auth's cascade, which drops
  the account rows BEFORE the user row; when the subject is the sole active
  owner in the restored dump the 0009 trigger refuses the membership delete
  mid-cascade, and a swallowed error left a half-erased owner (no credential,
  PII back, membership intact), readiness green, no audit row. The replay now
  runs under every last-owner guard (`withAllLastOwnerGuards`, nothing touched
  on a refusal) and a refused tombstone CLOSES the service (`state.closed` →
  503 everywhere but the probes) with a `user.erasure_replay_refused` audit row
  until an operator promotes another owner and restarts. Readiness alone is not
  a closure: only `/readyz` reads `state.ready`, and the compose healthcheck
  watches `/healthz`.
- **An erasure that lives only in the database is undone by a restore.**
  The tombstone (`$DATA_DIR/erasures.jsonl`, append-only, hashed email)
  lives outside the dump; `restore.sh` carries the LIVE file forward into the
  restored tree; boot replays it through Better Auth's cascade with a
  `user.erasure_replayed` system audit row. The append lives in
  `AccountDeletionService.afterUserDelete` because every GDPR surface (self
  delete, admin delete) funnels through the adapter hooks; the orphan purge
  deliberately does not (it is GC, not erasure).
- **Count-based migration status calls a downgrade "current".** drizzle
  records the sha256 of each applied file; comparing hash SETS (not counts)
  makes a database migrated by a newer image show `unknownApplied > 0`. The
  check runs before `runMigrations` on every boot (drizzle's own migrator only
  compares timestamps and would happily proceed) and refuses readiness.
- **The flip acknowledgement is not a migration.** `EDITION_CHANGE_ALLOWED`
  re-stamped and proceeded; the oss→cloud flip now pre-flights (no
  unprojected workspace, no unverified user) and cloud→oss is refused. Tests
  that flip must project the setup workspace first.
- **On cloud, "no link" is definitive only for a user the hub never
  projected.** A principal holding `origin='hub'` rows whose account row is
  gone has a SEVERED link; treating it as the fail-open `no_link` (cached
  like a success) was the way to switch enforcement off. It now fails closed
  as a dead grant, and `/unlink-account` for `antasphere` is refused in the
  same before-hook as reset/OTP. `/sign-in/email` on cloud is the operator's
  (`instance_settings.operator_user_id`, the durable record that also keeps
  them out of the orphan purge) and the allowlist's door only.
- **`case "${VAR:-default}"` with a `*)` fallthrough that re-reads `$VAR`
  loses the default.** `restore.sh`/`update.sh` probed `http://:3000` on
  every `.env` without `APP_BIND` (the `127.0.0.1` default matched `*`,
  which assigned the EMPTY variable). Default into the variable first, then
  `case "$VAR"`. Also: `docker compose run` allocates a pseudo-TTY when
  stdin is one — pass `-T` whenever stdout carries bytes you will store.
- **The break-glass upsert must stamp `origin='local'` on the conflict
  path too** — an `onConflictDoUpdate` `set` that omits a column keeps the
  row's old value, so a hub-projected row promoted by break-glass stayed
  `origin='hub'` and the reconciler swept the recovery ~12 s later.

## Config / HTTP hardening pass (PRDCT-1374 + PRDCT-1375, 2026-07-26)

Ported from the template. The generic rules live in the template's own LESSONS
entry; these are what THIS repo added or had to do differently.

- **PRIV-1 was live here, not latent.** The public viewer route is literally
  `/v/:secret`, so `path: c.req.path` on the completion log line wrote every
  working share capability into the log stream, and the OTel `url.path`
  attribute exported it off-instance to whatever trace backend an operator
  points at. Redaction cannot help — pino keys off object PROPERTIES and `path`
  is one opaque string. Both now carry `routeLabel(c)`, the matched pattern
  (`/v/:secret`, `/v/:secret/*`), read AFTER `next()`.
- **The cross-site gate must NOT cover the viewer, and that is load-bearing.**
  Two surfaces are deliberately cross-origin here and neither is
  cookie-authenticated (the share secret in the path IS the credential):
  `/v/:secret` on the root app (embeddable by design — ADR 021 + `/embed.js`,
  password-form POST included) and `/api/v1/viewer/*`, whose overlay client
  runs inside the sandboxed iframe and therefore sends `Origin: null`. The
  guard is mounted on `/api/v1` only, with an explicit `isExempt` for
  `/api/v1/viewer/`; the integration suite asserts BOTH stay open, so a future
  tightening fails there first instead of silently killing annotations.
- **A contract-wide sweep does not reach an inline schema.** The
  share-token annotation write validates against a schema defined INLINE in
  `viewer/annotations-api.ts`, not `@slideless/contract` — and it is the most
  anonymously-reachable free-text write on the instance, since a reviewer needs
  no account at all. Both its `body` and `authorName` needed their own
  `noControlChars`. When sweeping a class of sink, grep for the pattern in
  `apps/server/src` too, not just `packages/contract`.
- **"4xx" is not an assertion.** Two of this pass's own tests passed while the
  fix they named was broken. The share-secret fixture silently produced
  `undefined`, so every viewer assertion was hitting a 404 — which satisfies
  both `not.toBe(403)` and `status < 500`. And the deck-title case parsed a
  half-built commit payload, so `success === false` held for reasons that had
  nothing to do with the title. Fixes: assert the SPECIFIC status and error
  code, assert the negative control (the same request without the NUL
  succeeds), attribute the zod failure to a path, and assert every fixture step
  in `beforeAll` so a broken fixture fails loudly instead of making the suite
  vacuous.
- **`VIEWER_BASE_URL` joins the http(s)-only set.** It is the isolated
  user-content origin; a `javascript:`/`data:` value there is a redirect/XSS
  primitive, and the pinned zod's `z.url()` accepts both.
- **`HUB_CLIENT_SECRET` belongs on the redaction list.** It is this tool's own
  identity at the Antasphere hub — leaking it lets anyone impersonate Slideless
  at the authorization server. `*.secret` never matched it, and neither it nor
  `GOOGLE_CLIENT_SECRET` was listed.
- **This repo's compose does NOT feed the retention knobs blank** (the hub's
  does), so PLT-13 was latent here rather than live. It is still fixed the same
  way — every numeric knob rides `numeric()`, including the two view-analytics
  ones (`VIEW_EVENTS_RETENTION_DAYS`, `VIEW_DEDUPE_WINDOW_MINUTES`) — because
  the day someone adds `VAR=${VAR:-}` to compose it would go live silently.

## Release gate (PRDCT-1345 / 1344 / 1346, 2026-08-29)

- **Trivy's image export is what wedged Docker Desktop, twice.** `trivy image
<tag>` pulls the image through the daemon API while downloading its vuln DB;
  on this Mac that hung the daemon (every `docker` call timing out, an
  error-dialog process up) and took the integration suite's testcontainers down
  with it. Scan a `docker save` tarball instead (`trivy image --input x.tar`):
  same findings, no daemon in the loop. release.yml runs Trivy from its own
  container on a fresh runner, so CI is not affected.
- **better-auth's optional peers ship in the image unless denied.** The plugin
  declares svelte, vite, vitest, better-sqlite3, @sveltejs/kit and
  @prisma/client as `optionalDependencies`, so `pnpm deploy --prod` resolves
  them all — 48 MB of node_modules and the scanner surface behind the Trivy
  HIGHs. They are on the deny-list now, and the prune script grew an ORPHAN
  pass: removing a package strands its own subtree in `.pnpm` as real
  directories (rollup, postcss, tinypool, …) that the dangling-symlink sweep
  never sees. The pass keeps only store entries reachable through
  `node_modules` symlink chains from the deployed package. `.pnpm/node_modules`
  hoist links are deliberately NOT an edge (they would mark everything
  reachable) — and that hoist dir IS a Node resolution path for undeclared
  requires, so the honest statement is: the declared graph (step 4) and the
  static graph (step 5) are proven; a phantom DYNAMIC require satisfiable only
  through the hoist would break at container runtime, the same class of gap
  the deny-list always had (checked on the 2026-08-29 lock: every specifier
  that stops resolving belongs to a pruned package or a test dir). A dangling
  hoist left by the pass is attributed and unlinked, anything else still fails
  the build. The sweep's "resolves" verdict is build-stage-relative: a link
  that lands outside the deploy dir works in the build stage and dangles in
  the runtime image — `pnpm deploy --legacy` leaves exactly one (the deployed
  package's own hoist entry), now unlinked; any other escape fails the build. Unit
  test: `test/unit/prune-runtime-deps.test.ts` on a synthetic pnpm tree.
- **Compare store paths against `realpathSync(store)`.** `realpathSync` on a
  symlink answers the canonical path; on macOS the temp dir is `/var →
/private/var`, so a prefix test against the store path as spelled marks
  nothing reachable and the orphan pass deletes the whole store. A DANGLING
  link's lexical target, on the other hand, carries the spelled prefix — test
  both.
- **The 1.6.22 bump had two teeth beyond the schema drift** (both already met
  by the hub on its own bump, both re-hit here because the mirror was ported
  before the fix): `two_factor` gains `failed_verification_count` +
  `locked_until` (migration 0038), and the email-OTP → 2FA mirror must park a
  `2fa-attempts-<identifier>` verification row beside the `2fa-` one, because
  `verifyTwoFactor.beginAttempt` consumes it and 401s without it. The
  two-factor + cli-auth integration suites are the guard (6 red without it).
  Route surface re-enumerated 1.6.15 → 1.6.22: 156 → 157, one added
  (`GET /oauth-popup/start`, plugin not registered), nothing removed; ADR 001
  carries the method.
- **`@slideless/db` resolves to `dist`, so a schema edit is invisible to the
  server's tests until `pnpm --filter @slideless/db build`.** The symptom is
  Better Auth's "field X does not exist in the Drizzle schema" 500 on routes
  that touch the table — not a drift failure.

## Attachments (PRDCT-2278, 2026-09-13, lane A of the artifact wave)

- **A contract type exported as `z.infer` of a schema with `.default()` fields is the
  SERVER's shape, not the client's, and every client that spells the body breaks at typecheck
  the day the schema gains a defaulted field.** `ShareTokenCreate` was `z.infer<...>`: adding
  `canDownload: z.boolean().default(true)` made the field required for the CLI's `share` and
  the dashboard's share panel, both of which build a typed body and neither of which had a
  reason to know the new switch. The client-facing type is now `z.input<...>` (every defaulted
  field optional to a caller); the server keeps reading the schema's output through
  `c.req.valid('json')`. Apply the same rule to any create/update type a client constructs.
- **The generic viewer asset route must refuse the `downloads/` prefix itself, whatever the
  route order says.** The attachment pattern `/v/:secret/downloads/*` runs first for a real
  slash, but `downloads%2Fpage.html` is ONE segment to the router: it skips the attachment
  route and reaches the generic handler, which percent-decodes it back into `downloads/page.html`
  and, without the explicit exclusion, would find the manifest entry and serve an HTML
  attachment inline. Order is the mechanism, the exclusion is the guard, and the integration
  suite drives the encoded shape on purpose.

## The master page (PRDCT-2279, 2026-09-13, lane C of the artifact wave)

- **The API caches the dashboard's SPA shell at boot.** After `pnpm --filter @slideless/dashboard
build`, a running API keeps serving the OLD `index.html`, which imports chunks the rebuild
  deleted (`Failed to load module script … MIME type of "text/html"`), or, when turbo restored a
  cached shell beside fresh chunks, a shell whose `__sveltekit_<id>` global does not match the
  chunk's (`Cannot read properties of undefined (reading 'data')` at start). Restart the API
  after every dashboard rebuild; the browser suite never sees this because it builds the image.
- **A hands-on session signs in on the API's own port, not through the Vite proxy.** The sign-in
  Origin hook trusts `PUBLIC_BASE_URL` only, so a login posted from `localhost:5230` to an API
  whose base URL is `localhost:3230` answers 403 and the page says {{This account cannot sign
  in here.}} — an origin mismatch, not an account problem. For a look at a built page, open it on
  the API port (it serves the built dashboard); keep Vite for hot reload of unauthenticated
  pages, or point `PUBLIC_BASE_URL` at the Vite port and lose the viewer URLs.
- **`pnpm --filter <pkg> dev -- --port N` does not reach Vite.** The `--` is swallowed and Vite
  boots on 5173, outside every lane band. Use `pnpm --filter <pkg> exec vite dev --port N
--strictPort`, and `lsof` the band before trusting the log line.
- **A menu item's accessible name carries its trailing count.** `Version history` with a `3`
  badge is `menuitem "Version history 3"`; a Playwright `getByRole('menuitem', { name })` matches
  by substring unless `exact: true`, so keep the count in a separate span and never pass `exact`.
- **A snippet loses the template's null narrowing.** Inside `{#snippet child({ props })}` a
  `deck.title` read fails svelte-check with `'deck' is possibly 'null'` even under an `{:else}`
  that proved it; read such values through a `$derived` (`deck?.title ?? ''`) declared in the
  script.

## The recipient bar (PRDCT-2281, 2026-09-13, lane D of the artifact wave)

- **A deck document under `CSP: sandbox` has NO storage: `sessionStorage`, `localStorage` and
  `indexedDB` all THROW on access, not just return empty.** The brief asked for the bar's
  collapse state "in sessionStorage per token"; in the opaque origin the first read raises a
  `SecurityError` and, uncaught, would have killed the runtime. The runtime tries storage in a
  try, then falls back to `window.name`, the one per-tab slot a sandboxed document may write
  (keyed by a 32-bit fingerprint of the path, never the secret: the next page in the tab can
  read the name). Any future injected runtime that wants memory has the same two options.
- **`100vh` cannot be shrunk from inside one document.** The bar pushes the deck down with an
  `!important` inline margin, height and overflow on the root element; a deck sized with `100%`
  chains fits exactly, a deck sized in viewport units scrolls by the bar's height (vh resolves
  against the window, never a box). The only way to give a deck a smaller viewport is a frame,
  and a frame breaks the password gate (Lax cookies are not sent on frame navigations from the
  opaque origin), the overlay (top-level only) and forms attribution (a frame records `embed`).
  Collapsing the bar returns the viewport; that is the design, not a gap.
- **Every runtime that defaults ON moves every default link off the byte-exact stream path on a
  browser navigation, and the pins that asserted the ETag on a default link go red.** Three
  integration pins (forms ×2, annotations ×1) now take the stream-path proof on a `showBar:false`
  link and keep their own marker assertion on a default link. When adding a fourth runtime, read
  those pins first: the stream path is the BARE link's, and the streaming injector is what keeps
  a default link O(window) rather than O(document).
- **A `:host {}` rule protects nothing on the host itself.** The shadow root shields the
  bar's inside, but the host element lives in the deck's tree, and in the cascade a
  declaration from the shadow context (`:host`) loses to ANY outer author declaration, whatever
  its specificity: a deck's `body > div { position: relative }` turned the fixed bar into a
  700 px block at the end of the document (verifier round 2). The layout-critical declarations
  of an injected host are set inline with `!important`, the one level an outer stylesheet
  cannot beat. Same for any future injected host.
- **`overflow-y: auto` on the root does not reach content a `100%`-and-`overflow: hidden` body
  clips first.** A body sized to the root and hiding overflow becomes a clipping box the
  bar's height short of a `100vh` child, and no user scroll reaches the strip. The runtime
  measures the body after mount and, when an overflow-hidden body overflows, gives the root
  its full height back: the body is then the size it always was, shifted down, and the page
  scrolls by the bar's height. Forcing the body to scroll instead (the first attempt) failed
  on any deck with a margin: its own overflow hid the bar's, and a threshold on the excess is
  a guess about the deck.

## The artifact surface, second pass (PRDCT-2308 / PRDCT-2299, 2026-09-14, lane F)

- **In the shared `DataTable` (`table-fixed`), a column WITHOUT a `meta.width` gets whatever the
  others leave, which can be nothing.** The links table's recipient column had `minWidth` only and
  rendered 4px wide inside the share sheet, its lock icon spilling into the next cell — the exact
  "cut column" Romain reported on the wave. Give EVERY column a width and make them add up to the
  table's `min-w-*` (`tableClass`), so a narrow host scrolls the table sideways instead of eating
  a column; `master.spec.ts` pins the first column's width.
- **The dashboard CSP allowed styles and fonts from `'self'` only, so the Fontshare and Google
  Fonts links in `app.html` had never loaded on a built page** — Sentient and Onest fell back to
  the system stack silently (the console said so, nothing else did). `buildCsp` now lists the two
  API hosts under `style-src` and the two file hosts under `font-src`, nothing more. When adding a
  CDN link to the shell, add its hosts to the CSP in the same commit and look at the console of a
  built page, not the Vite dev server (which sets no CSP).
- **A hands-on seed that signs in from Node needs an `Origin` header**: the sign-in Origin hook
  refuses a request with none (403), the same answer a wrong origin gets. Send
  `origin: <PUBLIC_BASE_URL>` on `/sign-in/email` and on every JSON POST from a script.

## A restored `.svelte-kit` cache breaks the typecheck when a route group is added (2026-09-14, lane F)

- **`svelte-kit sync` does not clean the generated types it is regenerating, and CI restores them
  between runs.** Adding `(present)/+layout.ts` made SvelteKit generate a NEW
  `.svelte-kit/types/src/routes/(present)/proxy+layout.ts`; on a runner whose cache predated the
  change, the config loader walked the restored tree and `stat`ed an entry sync had since rewritten,
  dying with `ENOENT … proxy+layout.ts` before a single file was checked. Green on every developer
  machine and in a fresh clone (the tree is byte-identical), red only where a stale cache is
  restored — the `checks` job was the ONLY new failure on dev, beside three that had failed for two
  days. `typecheck` now does `rm -rf .svelte-kit/types` first: idempotent, costs a second, and makes
  the gate independent of whatever a runner restored. Reproduce the class by planting a dangling
  entry under `.svelte-kit/types/src/routes/` and running the typecheck.
- **CI failing "already" is not the same as CI failing the same way.** Compare the FAILING JOB NAMES
  against the previous commits on the base, not the red/green of the run: three drills had been red
  since 12 September, which is exactly what hides a fourth job going red for the first time.

## Workspace creation from inside the product (PRDCT-2444 / PRDCT-2443, 2026-09-18)

- **The route's audit row belongs to the NEW workspace, and the generic audit middleware has to be
  told to stay out.** `auditMiddleware` attributes every mutation to `principal.workspaceId`, the
  workspace the caller happens to be in. For `POST /workspaces` that is the wrong trail: a workspace
  never learns what its members do elsewhere. The path is in `isAuditExempt` and the handler writes
  its one `workspace.create` row itself, the setup pattern. Any future route whose effect lands
  OUTSIDE the caller's current workspace needs the same two moves, or the event leaks into a log
  its readers have no standing over.
- **`/me.canCreateWorkspace` and the route share ONE function** (`workspaceCreationRefusal`,
  `api/workspaces.ts`), and the route calls it INSIDE the locked transaction. A flag computed by a
  second copy of the rule promises what the route refuses the first time one of them moves.
- **A POST to the hub is never re-posted on an ambiguous answer.** The read path
  (`HubUserClient.orgs`) retries once after a 401 OR a 403, which is harmless for a GET. For
  `createOrg` only a 401 earns the retry (the hub refused the token before doing anything); a 403
  is a policy answer, and a timeout or a 5xx may hide a committed creation, so a second POST is a
  second organization. The `commit_then_500` mode of the fake hub pins it: one POST, a 403
  `hub_unavailable`, and the organization arrives by the next reconcile pass.
- **The Write tool turns a unicode NUL escape (backslash, `u0000`) inside a string literal into a
  real NUL byte in the file.** The test still "worked" (a NUL is a control character) but the
  source carried a raw NUL. Write such escapes through a script and byte-scan the file before
  committing.
- **Opening creation changes what an owner can do for a member.** A `user` row is instance-global:
  the moment a member owns a second workspace, `mintRefusal` answers `cross_workspace_target` and
  the delete answers `member_of_other_workspaces` for them in the FIRST workspace too. That is the
  guard working, not a regression: it is documented for operators in
  `docs/self-hosting/deployment-profiles.md`, and `MAX_WORKSPACES_PER_USER=0` is the switch for an
  instance that wants to stay one team's.
- **A rate wall mounted on a PATH counts everything that touches the path.** The first wall on
  `POST /workspaces` was `api.use('/workspaces', rateLimit(...))` on arrival: OPTIONS, HEAD and
  anonymous POSTs (all of them 404/401, none of them a creation) each spent the address's budget, so
  61 preflights locked a person out of a route they had never used, and `/me` still said they could
  create. The wall now lives IN the handler, after the caller is identified: the per-person bucket
  is judged first and a person it refuses never reaches the per-address one, which is ten people's
  worth, so one colleague takes at most a tenth of an office's NAT address. `/me.canCreateWorkspace`
  reads both buckets (no spend). Rule: a wall protecting an authenticated act is spent by the
  handler, keyed on who it identified; path mounts are for surfaces whose cost IS the arrival.
- **The deploy-order refusal lands on the TOOL's callback, not on a hub page.** Verified live by
  the federation drill's Phase 3b (hub `lane/org-create-for-tools` beside this branch, 2026-09-18):
  an authorize that requests a scope the hub does not list for the client answers a 302 to
  Slideless's own callback carrying `error=invalid_scope` and an `error_description` naming the
  scope — no code, no consent screen, the whole sign-in over. So a Slideless that ships
  `orgs:create` before the hub lists it does not "lose workspace creation", it locks every user out
  at the door, and the symptom shows in Slideless's callback logs, not the hub's. The hub first.
- **The drill's "next /24" is not a free subnet on a busy machine.** `172.30.250.0/24` overlapped
  a standing `172.30.0.0/16` compose network here, and so would `172.30.251.0/24`: Docker's default
  pool hands out /16s, so any neighbour inside the same /16 swallows every /24 of it. To run the
  drill beside other stacks, set `FEDERATION_SUBNET_PREFIX` OUTSIDE the pool (`10.99.250` worked),
  and read `docker network inspect` for the real masks before picking, not just the prefixes.
