# Slideless

The Slideless product monorepo, in the n8n mold: one Docker image plus a Postgres container. Ships a
versioned Hono API (`/api/v1`), a SvelteKit dashboard, Better Auth (sessions, API keys, a built-in
OAuth 2.1 authorization server), file storage, pg-boss jobs, an audit log, and a bundled MCP endpoint
(`/mcp`) — so agents are first-class consumers of every instance. Instantiated from the
platform-template (commit `b0dcd13`); branches follow the workspace rule: `prod` (default,
deploys) + `dev` (day-to-day work).

## Identity (fixed at instantiation)

- npm scope `@slideless/*` for the internal workspace packages; the CLI is the one exception —
  it publishes to npm as **`@antasphere/slideless`** (binary still `slideless`, released via
  `.github/workflows/publish-cli.yml` on `cli-v*` tags — internal/cli-release.md). Env var prefix
  `SLIDELESS_` — the CLI reads `SLIDELESS_URL` / `SLIDELESS_API_KEY`.
- **One definition**: `packages/contract/src/identity.ts` (`IDENTITY`, typed by `ToolIdentity` of
  `@antasphere/chassis-contract`) spells the slug, the display name, the key prefix, the three
  scopes, the CLI's binary and env prefix, the MCP server name and tool prefix, the OTel service
  name and the image name ONCE. It feeds the three existing inputs: `defineChassisContract`
  (`packages/contract/src/chassis.ts`), the `identity` slot of `slidelessTool`
  (`apps/server/src/tool.ts`; the deck-named sentences of the chassis sit in its `copy` slot) and
  `cliIdentity(IDENTITY)` in `packages/cli/src/cli.ts`. No `packages/chassis-*` file names the tool
  (`git grep -i slideless -- 'packages/chassis-*'` returns nothing), and
  `apps/server/test/integration/identity-pins.test.ts` pins every visible value by its literal.
  What cannot read it at run time (package names, the `bin` key, the image reference, the Postgres
  role, env var names, the MCP tool-name literals) is listed in the project OS,
  `knowledge/internal/identity-audit-server-and-packages.md`.
- API key prefix `slk` (`IDENTITY.apiKeyPrefix`; `ApiKeyService` in
  `packages/chassis-server/src/apikeys/service.ts` takes it as a required constructor value, with
  no chassis default).
- Scopes: `presentations:read`, `presentations:write`, `data:export` (export stays opt-in).
- License: fair-code under the Sustainable Use License 1.0, licensor Antasphere (`LICENSE`; every
  `package.json` says `SEE LICENSE IN LICENSE`, the CLI included). Say fair-code or source-available,
  never open source (PRDCT-1350).
- Docker image `ghcr.io/antasphere/slideless`; Postgres role/db `slideless`; port 3000; `EDITION=oss`.

## Layout

| Path                                | What                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/server`                       | The single deployable: Hono API, identity, MCP, jobs, storage                                              |
| `apps/server/src/tool.ts`           | The Slideless tool definition: the deck domain plugged into the chassis' named slots                       |
| `apps/dashboard`                    | SvelteKit SPA, built into and served by the server image                                                   |
| `packages/chassis-db`               | The generic tables, the generated `auth-schema.ts`, the migration runner                                   |
| `packages/chassis-contract`         | The generic zod schemas + route contracts                                                                  |
| `packages/chassis-server`           | The generic server: identity, federation, middleware, routers, jobs, MCP kit; entry `createPlatform(tool)` |
| `packages/chassis-sdk`              | The generic typed client (`ChassisClient`); `PlatformClient` extends it                                    |
| `packages/chassis-cli`              | The generic CLI: profiles, context, `safe-write.ts`, generic commands; entry `defineCli(definition)`       |
| `packages/db`                       | drizzle schema (the deck tables) + migrations (the one history, chassis tables included)                   |
| `packages/contract`                 | zod schemas + route contracts shared by server, SDK, dashboard                                             |
| `packages/sdk`                      | Typed client over the contract (hand-written today)                                                        |
| `packages/cli`                      | The `slideless` binary: the deck commands over `packages/chassis-cli`, one bundle (docs/agents/cli.md)     |
| `Dockerfile` + `docker-compose.yml` | The shipped image and the operator stack                                                                   |
| `docs/`                             | PUBLIC docs only — synced to the docs site; subfolders = sidebar groups, `docs/nav.yml` is the contract    |
| `internal/`                         | Engineering docs + ADRs (`internal/decisions/`), never published                                           |

## Invariants — never regress these

- **Fail-closed scope allowlist** (`packages/chassis-server/src/middleware/scopes.ts`, the deck rules in `apps/server/src/middleware/scopes.ts`): machine principals (API
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
  `packages/chassis-db/src/auth-schema.ts` + the snapshot via the pinned CLI, plus an additive drizzle
  migration. CI's `drift:check` gates it.
- **A deck bundle is untrusted input on the CLIENT side too (PRDCT-1353)**: manifest paths are
  the names `slideless pull` writes onto a developer's disk, so `assetPathSchema`
  (`packages/contract`) refuses dot-prefixed segments and `package.json`/lockfiles at COMMIT —
  never loosen it back to "traversal-safe" alone (`isTraversalSafeAssetPath` is the separate,
  weaker rule the viewer's manifest LOOKUP uses, where no filesystem is involved). The CLI then
  re-checks every path at PULL, caps each blob at the manifest's `sizeBytes`, verifies its sha256
  before writing, and writes through `packages/chassis-cli/src/safe-write.ts` only: lexical containment + a `realpath`
  parent check + `O_NOFOLLOW` + a forced 0644 (an `O_TRUNC` write PRESERVES an existing file's
  mode). `files download` uses the BASENAME of the server-chosen name inside a chosen directory.
  `slideless dev` is a real containment boundary: `realpath` re-check, dotfile paths 404, and a
  `Host` allowlist (the DNS-rebinding guard). Every non-`--json` sink goes through
  `sanitizeForTty` (`packages/chassis-cli/src/context.ts`) — `--json` stays byte-exact and must never be routed through it.
- **A tombstone the boot cannot replay closes the service (PRDCT-1809)**: the erasure replay in
  `packages/chassis-server/src/boot.ts` runs under `withAllLastOwnerGuards` (nothing touched on a refusal — Better Auth's
  cascade drops account rows before the user row, so an unguarded refusal half-erases), and a
  refused tombstone sets `state.closed`, which answers 503 `service_closed` on every route but
  `/healthz`, `/readyz`, `/metrics`, plus a `user.erasure_replay_refused` audit row. Never
  downgrade the closure to a readiness flag alone: only `/readyz` reads `state.ready` and the
  compose healthcheck watches `/healthz`, so the API would keep serving the resurrected
  subject. The erasure fingerprint is an HMAC under the auth secret (PRDCT-1811) — never a plain
  hash, since `erasures.jsonl` rides in the UNENCRYPTED data tarball. Forms detection
  (`forms/detect.ts`, PRDCT-1810): any script entry or inline `<script>` ARMS the runtime; a
  byte scan cannot see a runtime-authored marker, so "inconclusive arms" — never narrow it back
  to the literal marker alone.
- **The still image is made by a separate, optional renderer container, and the app never
  waits on it (PRDCT-2725)**: Chromium does NOT ship in the app image (Romain's ruling of 24
  September 2026: 422 MB against 1.52 GB for a nice-to-have). `apps/renderer` holds a sandboxed
  headless Chromium and nothing else (no database, no storage, no secret but
  `SLIDELESS_RENDERER_SECRET`); Slideless (`apps/server/src/thumbnails/`) hands a claimed version to
  it as a job the size of a line with a ONE-TIME KEY, the renderer pulls the version's files
  through `/internal/renderer/jobs/{job}/files/{path}` with that key and puts the WebP back
  through `…/image` (or `…/failure`). The key is the sha256 on the claimed row
  (`claim_token_hash`): it opens one version, only while the lease lives, and dies with the
  outcome, so a renderer that were ever taken over could write the images of the versions it was
  handed and read nothing else. A push only queues; `kick` hands off; a reader's ask hands off
  inside the request (what makes it work on a CPU-throttled cloud instance); a busy or
  unreachable renderer costs no attempt; at most `MAX_IN_FLIGHT` versions are out at once. Chromium
  ALWAYS runs under its own sandbox: the renderer refuses to boot without it (exit 3) and stops if
  it dies later; never add `--no-sandbox`, never `seccomp=unconfined`; the compose stack applies
  `deploy/seccomp-chromium.json` to the `renderer` service (the `images` profile), never to `app`.
  Alpine's Chromium is out for good: its graphics helper dies under Chromium's own seccomp on musl
  (arm64 and amd64 alike), so the renderer image is Debian with Playwright's pinned headless shell.
  Unset `SLIDELESS_RENDERER_URL` = no images, `thumbnail_unavailable`, the still pattern on the
  cards. The renderer's cloud deployment is its own task; until it ships, cloud shows the pattern.
- **Never render user content on the app origin** — files are served `attachment` + `nosniff`
  (docs/security/security.md).
- **The viewer origin is a real boundary, never a trust grant (PRDCT-1352)**: with
  `VIEWER_BASE_URL` set, `middleware/host-gate.ts` makes the viewer hostname answer ONLY
  `/v/*`, `/api/v1/viewer/*` (token-authed, cookie-less — the overlay and forms runtime call
  it relative to the deck page) and the probes, everything else 404 before any handler; the
  app hostname answers `/v/*` with a 308 to the viewer origin. The viewer origin is on the
  cross-site guard's `deniedOrigins` and filtered out of Better Auth's `trustedOrigins` and
  the sign-in Origin hook — refused EVEN AS THE SERVING ORIGIN, so a proxy routing the viewer
  hostname at the app can never turn "the origin we are served on" into trust for deck
  script. The dashboard CSP gains `frame-src 'self' <viewer origin>` (the preview iframe).
  Unset, none of this is installed — single-origin behaviour is byte-for-byte unchanged, and
  `viewer-origin.test.ts` pins both modes. Never widen the viewer-host allowlist to a
  cookie-reading surface, and never drop the explicit denial in favour of the gate alone.
- **Deck reads are private, never workspace-wide (ADR 013)**: every presentation read (get,
  versions, version detail, asset download, and the list's WHERE scope) goes through
  `canReadDeck` — deck owner, workspace admin/owner, or an ACTIVE collaborator grant on THAT
  deck. A failed read check answers **404, never 403** (deck existence is not probeable).
  Workspace membership alone is NOT a deck read grant — collaborators are external parties
  invited to one deck, and revoking a grant must cut content access immediately.
- **A deck linked to a project is read by the project's members, in the read rule's THREE
  homes at once (ADR 026)**: `canReadDeck`, the list's WHERE and `blobReadScope` each call
  `deckProjectReadPredicate` (`apps/server/src/presentations/projects.ts`), itself the chassis'
  `projectGrantPredicate` (`packages/chassis-server/src/projects/access.ts`, the ONE statement
  of who holds a grant: guest refused on the principal and on the row, live membership, one
  workspace, the role ladder, the operator view, the archived-write rule) over
  `presentation_projects`. Change one home, change all three; `deck-projects.test.ts` pins each
  alone. The write rule has a FOURTH home: `commitVersion` checks inside its own transaction and
  carries the editor branch beside `canWriteDeck`. Linking is the deck administrator's act with
  editor or more on the project (it widens reads); a non-reader of a project gets 404, never 403,
  a proven reader below the role 403 `insufficient_project_role`, an archived project 409
  `project_archived` on every change but unarchive. Project membership is LOCAL on both editions
  (never under `hub_managed`), a guest is never a project member (403 `guest_forbidden` on the
  whole `/projects` subtree), and a grant dies with the workspace membership it rides on (the
  foreign key's cascade; the hub sweep deletes the grants itself since it only deactivates).
  Nothing under `packages/chassis-*` names a deck, a brand or Slideless.
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
  emailOTP reset trio — answers 403 (before-hook in `packages/chassis-server/src/identity/better-auth.ts`;
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
  registered only when NOT cloud (`!hubSso` in `packages/chassis-server/src/identity/better-auth.ts`), so a cloud instance
  with `GOOGLE_CLIENT_ID`/`SECRET` set still leaves `/sign-in/social` unregistered (404
  `PROVIDER_NOT_FOUND`) — by construction, not by leaving the env unset. Rule: no non-SSO
  session entrance on cloud except the break-glass `/sign-in/email`; oss keeps Google social
  when configured.
- **No route ever hands a caller a PROVIDER GRANT, on either edition (PRDCT-1354, AUTH-3/AUTH-7)**:
  Better Auth's own `/get-access-token` and `/refresh-token` answer 403 `provider_grant_forbidden`
  from the same before-hook (`isProviderGrantPath` in `packages/chassis-server/src/identity/better-auth.ts` — re-verify the
  enumeration on ANY Better Auth bump). Both returned the caller's stored grant in PLAINTEXT, which
  makes `encryptOAuthTokens: true` pointless, and the `/auth/*` mount is registered BEFORE
  `authContext` (`packages/chassis-server/src/api/create-api.ts`), so neither saw the scope allowlist, the per-principal quota, the
  idempotency claim, or the audit log. On cloud that grant IS the hub grant (ADR 019), and
  `/refresh-token` rotated it OUTSIDE the `pg_advisory_lock(7432004, hashtext(userId))`
  single-flight, which the hub's RFC 9700 reuse detection turns into a grant-family-killing event
  any logged-in user could trigger from a browser tab. Pure subtraction: nothing in the server, SDK,
  CLI, dashboard, or MCP calls either route (the hub grant refreshes via `HubGrantService.postRefresh`,
  which posts to the hub token endpoint directly). Never reopen them; a new provider-token read
  surface needs an explicit charter call.
- **Minting another user's credential is an OWNER act with a cross-tenant refusal (PRDCT-1354,
  AUTH-1/2/8)**: `POST /members/{id}/reset-link` and `/members/{id}/change-email-link` both mint
  a SIGN-IN-EQUIVALENT bearer for a target (LESSONS.md M6), and a `user` row is instance-GLOBAL —
  so the mint's blast radius is every workspace the target belongs to. Both are `requireRole('owner')`,
  both run `mintRefusal` (`packages/chassis-server/src/api/members.ts`), and both refuse an `origin='guest'` target
  (`guest_target` — a per-deck outsider's account is not the host tenant's to recover, D2) and any
  target holding a membership in ANOTHER workspace (`cross_workspace_target`). Both also carry the
  cloud closure (`password_reset_disabled` / `email_change_disabled`) and both are idempotency
  targets. Any new mint route under `/members` must call `mintRefusal` too. Crossing the tenant
  boundary with a per-deck collaborator invite is likewise admin/owner-only
  (`external_invite_forbidden`, `api/collaborators.ts`): the claim path mints a real global `user`
  row, so inviting an outsider is an onboarding act, not a deck act.
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
  a grant-family-killing event. **An unanswered refresh is never re-presented blindly
  (PRDCT-1370)**: the hub rotates before it answers, so a timed-out presentation may already be
  rotated out; `HubGrantService` records every presentation (`hub_grant_presentations`) before
  the fetch and, while the record survives, PROBES the token through the hub's RFC 7662
  introspection (read-only) — `active:false` marks the grant dead without presenting, so the
  family (the CLI grant included) survives. Never remove the record write or the probe. Gate verdicts: dead grant → 401 `hub_grant_expired` (immediate;
  a browser SSO re-login heals), stale-beyond-15-min + failing hub → 403 `hub_unavailable`,
  swept membership → 401 `membership_revoked`, `hub_status='suspended'` → 403
  `account_suspended` (GET /me exempt — visible-but-blocked). **Orphan-purge HARD CONSTRAINT**
  (`packages/chassis-server/src/jobs/pgboss.ts`): never delete an `antasphere` account row while leaving an `origin='hub'`
  membership row — whole-user delete or nothing, else the reconciler's fail-open `no_link`
  branch becomes reachable for hub-origin principals.
- **Cloud sign-in requests `orgs:create`, and THE HUB DEPLOYS FIRST (PRDCT-2443)**: the scope list
  is stated once (`HUB_SSO_SCOPES`, `packages/chassis-server/src/identity/hub-sso.ts`): `openid profile email offline_access
account:read orgs:create`. The hub's authorize endpoint refuses an unknown requested scope with
  `invalid_scope`, which fails the WHOLE sign-in for every user, so a scope is added here only
  AFTER the hub lists it for the tool client. `orgs:create` is the hub's dedicated scope for
  `POST /orgs`; `account:write` does not open it and is never requested. A grant without the scope
  (minted before this shipped, or replaced by a CLI connect, whose hub-minted grant carries no
  `orgs:create`) gets 403 `insufficient_scope` from the hub, mapped to 401 `hub_reauth_required`:
  a browser sign-in heals it. `/me.canCreateWorkspace` stays true for such a person, on purpose.
- **A price is a declaration on the route, and the chassis names no key (PRDCT-2626, the billing
  rail spec §7)**: a route that meters an action, checks a limit or needs a feature says so ONCE in
  `DECK_ROUTE_ENTITLEMENTS` (`packages/contract/src/routes/index.ts`, built from the route objects;
  a duplicate throws) and the tool's `entitlements` slot (`apps/server/src/tool.ts`) carries the
  credits, the per-tier limits and the features, shown on `GET /instance`. ONE gate
  (`packages/chassis-server/src/entitlements/gate.ts`, registered in `create-api.ts` after the scope
  gate, the idempotency claim and the audit middleware, before every handler) enforces it for the
  dashboard, the CLI and the MCP tools alike and emits the usage event after a 2xx; no handler checks
  or emits by hand, and `git grep -i 'files.maxBytes\|presentations.commit\|slideless' --
'packages/chassis-*/src'` stays empty. Cloud order: feature → limit (403 `plan_required` + `details:
{ key, plan, requiredPlan, upgradeUrl }`, the hub's organization page) → the credit check; oss:
  the credit check first (413 `entitlement_denied`, today's message byte for byte), then the
  `oss` value, and NO event (unmetered by construction). The event's `userId` is the hub's `sub`,
  never the local id. **The event never names the tool (PRDCT-2629)**: the hub takes the tool
  from the machine token's registry entry (`slideless-cloud`, not `IDENTITY.slug`) and refuses a
  body slug that differs as `tool_mismatch`, so `UsageEvent` has no slug field and the fake hub
  (`testing/fake-hub.ts`) judges every element with the hub's schema (the contract's copy, checked by the wire check)
  (`usageEventSchema`) and refuses a stamped body exactly as the real hub does. The poster
  (`entitlements/poster.ts`, cloud only) posts whole batches to `POST <hub>/api/v1/usage/events`
  with a `client_credentials` token (`scope=usage:write`, `resource=<hub>/mcp`) minted
  single-flight on `HUB_CLIENT_ID`/`SECRET`; a 404 from an older hub, a 5xx, a 403 or a 2xx that
  is not the hub's answer is an outage the queue retries for about eight hours
  (`DEFAULT_USAGE_RETRY`), and the budget's END is a hold, never a loss (PRDCT-2635): the batch
  moves to `usage-events-held` (the usage QUEUE's dead letter, set by the worker boot, never
  named on a send: an api-role replica must be able to send before the worker of a release has
  booted; pg-boss stamps it on each job row at insert, so a job sent before that worker's install
  carries none; the dead-letter copy carries the original retry limit and no delay, pg-boss 10's rule),
  is logged at error level and counted (`usage_events_held_total`),
  and comes back through the queue every hour until the hub accepts it; the poster's per-event
  and per-batch outcomes are on `/metrics` (`usage_poster_events_total`, `usage_poster_batches_total`).
  A mint the hub refuses as a configuration error (`invalid_client` and its kin) is held five
  minutes, a transient failure five seconds (PRDCT-2637: the hub's token wall is the one
  people's sign-ins share). The plan read (`GET /usage/entitlements`, the hub's answer as the
  contract copies it, a boolean limit = unlimited or nothing, PRDCT-2636) is OFF the request path
  (PRDCT-2633): a cached plan is served at once and refreshed behind the request, a cold account
  waits at most 1.5 s, and the last known plan is kept fifteen minutes on failure, then free.
  **The plan gate sees a declared size before any body limit refuses it (PRDCT-2632)**: the
  tool's `bodyLimit` slot declares data (`BodyCap`), the chassis builds the middleware, and when
  the matched route carries a gate that judges a limit (`isDeferringGate`) a Content-Length over
  the cap is parked (`bodyRefusal`) with the request's body DROPPED, so nothing downstream can
  read it by construction, and fired by the gate after the plan check, so a metered account meets 403
  `plan_required` with the upgrade link at any size and the instance-cap 413 only when the plan
  allows it; oss and a request with no plan meet the cap first, byte for byte once the
  credential has resolved (a scope-less key now meets the scope gate's 403 before the cap's 413). The upload action
  is metered in exact bytes and priced per mebibyte through `per` on the action (`5 credits per
1,048,576 bytes`, PRDCT-2627), the boot refusing a route whose meter unit differs from its
  action's. Phase 1: every account is `free`, the free upload cap IS `MAX_FILE_SIZE_MB` by
  construction, credits are a no-op; the seed values are data to review before phase 2. The
  federation drill's seventh leg (`scripts/federation-drill.sh`, Phase 8) is the regression test
  of the pair: one metered action per surface read back from the hub's `usage_events`.
- **The hub owns the wire, the chassis's copies are checked against it (PRDCT-2677)**: the shapes the
  tools exchange with the hub live in the hub's contract and are published as its wire snapshot
  (`packages/contract/wire/hub-tool-messages.json` of the hub); `packages/chassis-contract/src/entitlements.ts`
  mirrors them, and `pnpm --filter @antasphere/chassis-contract wire:check` (the `hub-wire` CI job,
  against the hub's `dev`) fails on any difference. The check's `unpriceable` reason is a 413
  `entitlement_denied` refusal with the price and the balance and no top-up link (a link would draw
  the dashboard's and the CLI's top-up card), never an outage.
- **The chassis asks the hub before a priced action, and refuses on its answer (PRDCT-2664, phase 2
  of the billing rail, spec §7 steps 3 and 4)**: on a metered account (cloud, an `accountRef`) the
  gate's third step is `HubCreditCheck` (`packages/chassis-server/src/entitlements/check.ts`), one
  `POST <hub>/api/v1/usage/check` `{ accountRef, actionKey, quantity, unit }` with the machine token,
  the answer read with the contract's copy (`usageCheckSchema`). The LOCAL credit service (`AllowAllEntitlements`,
  the env cap) is never consulted on a metered account: the plan limit is its cap there. A denial is
  **402 `entitlement_denied`** with `details: { credits, balance, topUpUrl }`, read straight off the
  hub's answer; `account_suspended` from the check is 403 `account_suspended` (the live gate's code).
  The cache is per account per action and SOUND although the price depends on the quantity, because
  the price never decreases with it: a fresh allowed answer (30 s) serves any smaller or equal
  quantity, a fresh denial (5 s, so a top-up is felt quickly) refuses any larger or equal one, every
  other case asks the hub. A hub that does not answer (network, timeout, 5xx, 403, a 404 that is not
  `unknown_account`, no machine token) FAILS OPEN for fifteen minutes from the first failure, then
  every priced action answers 403 `hub_unavailable` (the federation gate's posture and code); a
  success clears the clock. The posture, the first failure's second and the cache size are on
  `/metrics` (`usage_check_posture` 0/1/2, `usage_check_failing_since_seconds`,
  `usage_check_cache_entries`, `usage_check_total{outcome}`). A 404 `unknown_account` and a 400 are the
  hub's judgement, not an outage: allowed, logged (error level for the 400, a bug a retry never heals),
  nothing charged. Never re-present the local env cap to a metered account, never cache a fail-open
  answer, and never make the closure a readiness flag. The dashboard shows the TOP-UP card on a 402
  and the UPGRADE card on a 403 `plan_required` (`$lib/billing-refusal.ts`, distinct, the decision on
  the details never on the edition), the CLI prints the price, the balance and the link, the MCP
  tool result carries them as text: a self-hosted 413 `entitlement_denied` without details keeps its
  sentence everywhere.
- **What discovery advertises is what the instance serves (PRDCT-2653)**: the paid tier's upload
  size IS `MAX_FILE_SIZE_MB` (the ceiling the handlers cut the stream at) and the free value is 100 MB
  or the cap when smaller (`apps/server/src/tool.ts`); `assertToolEntitlements` parses the slot
  through `toolEntitlementsSchema` (a missing tier stops the boot) and refuses any tier value, or
  unlimited, above a numeric `oss` ceiling. The cloud instance's cap must be raised to 500 MB by infra
  before staff seeds the hub's plan entitlements from discovery, or the seed carries the smaller
  value. The CLI's upfront refusal on the cloud reads the highest tier (it cannot know the account's
  plan; the instance refuses the plan on the declared size before reading a byte).
- **A metered upload declares its size (PRDCT-2652)**: on a metered account, a POST/PUT/PATCH with no
  `Content-Length` on a route whose limit READS the declared length (`limit.value ===
declaredContentLength`) or whose meter is in bytes answers 411 `length_required` before the
  handler, since a body judged as 0 bytes passed the plan limit whatever its size and a stored blob
  is content-addressed (a rollback could delete what another deck references); a count limit on a
  JSON route demands no size. Every first-party
  caller (the SDKs, the MCP kit's in-process call) declares it; oss and cloud-local workspaces are
  untouched.
- **An anonymous surface pays through the resource's owner, and the viewer learns nothing
  (PRDCT-2634, spec §8, Romain's ruling of 2026-09-23)**: when a route declares `meter.actor`, the
  gate runs the hook WITHOUT a principal and meters on the actor it resolves (the owner's user id,
  workspace and account; `via` reads `session`, the hub's enum having no value for a share link);
  a hook that resolves nothing or throws leaves the route to its own handling and meters nothing.
  Slideless declares two: the form response (`forms.response`, per call) and the form file upload
  (`forms.upload`, bytes per MB received, its own key so the report tells it from the owner's
  uploads), both through `deckRouteEntitlements({ formOwner })` in `apps/server/src/tool.ts`, the
  hook `presentations/form-owner-actor.ts` resolving the share secret through the late-bound domain
  (`EntitlementsContext.getTool`, the jobs slot's shape; the slot runs before `services`). A credit
  refusal on an anonymous surface is `402 entitlement_denied` with ONE neutral sentence and NO
  `details`: the owner's balance, price and top-up page are never shown to a viewer. The plain
  `DECK_ROUTE_ENTITLEMENTS` carries no hooks (a client's read); the server always builds its own.
  The upload handler records `audit.metadata.sizeBytes` so the emit meters the bytes kept. A
  deduplicated upload is billed at the bytes RECEIVED (PRDCT-2655, the same ruling), and the
  price label says so. **A route that declares an `actor` hook is a viewer's surface whatever the
  credential**: a person signed in to any workspace who holds the link is a viewer there, the hook
  alone names the payer, and a null or throwing hook leaves the route with nothing metered, never a
  fallback to the signed-in person. In front of the two doors, on cloud only, a wall of 90 requests
  per ten minutes PER ADDRESS (`viewerFormGate`, the tool's `rateLimits` slot) bounds what one holder
  can make the instance ask the hub; never key it on the share secret, which caps a link's whole
  audience (verifier round 5), and never install it on oss, where the gate asks nothing.
- **The poster never posts what the hub would refuse on its date (PRDCT-2644)**: the hub's window
  (`USAGE_EVENT_MAX_PAST_MS` seven days, `USAGE_EVENT_MAX_FUTURE_MS` five minutes,
  `usageEventOccurrenceIssue`, copied with the hub's names and messages in `chassis-contract`,
  pinned by `usage-window.test.ts` and checked against the hub by the wire check) is judged before posting; an event outside it is named in the batch outcome, sent to
  `usage-events-held` by the usage worker with the `occurred_at_window:<id>` marker key (so the held
  worker never counts or logs it as a retry-budget hold), and re-driven after the hold forever: a
  future-dated event lands once its time comes, a stale one waits for an operator.
  `usage_events_held_total` now carries `{reason}`. Boot logs a warning when the hub's `Date` header
  disagrees with the instance clock by more than the forward bound (`entitlements/clock-skew.ts`).
- **What pro unlocks is locked on free, at the door where the act happens (PRDCT-2702, phase 3 of
  the billing rail)**: every limit and feature the `entitlements` slot declares is enforced by the one
  gate, and the chassis learned what a count needs (a limit's `value` may be async, read the parsed
  body through `ctx.body()` and answer `null` for "nothing to judge"; a `feature` may be
  `{ key, when }`, judged BEFORE the plan is read so a condition that does not hold costs no hub
  read; an entry-level `actor` makes a limit-only PUBLIC door a viewer surface; a hook that throws
  is logged at warn and judges nothing; only a SIZE limit defers the body cap, a count limit meets
  the cap's 413 at once). The member cap is ONE seat pool (`presentations/member-seats.ts`: active
  members of every origin, guests included, plus the addresses holding a seat without a
  membership: a live pending collaborator grant, an ACTIVE grant not yet claimed into a
  membership, an open workspace invitation) at Slideless's TWO doors, the collaborator invite and
  the collaborator claim, each reporting the seats AFTER its act: the invite refuses the seat over
  the cap, the claim refuses the join on a workspace above it (a downgrade seats nobody until it
  is under). The workspace invitation doors carry NO declaration: on every workspace that has a
  plan they answer `hub_managed` and the hub enforces the same cap at ITS doors
  (`billing/member-cap.ts` there, the smallest numeric `workspace.members` among the tools that
  declare it), and a declaration that could never refuse is a false guarantee. `links.perDeck`
  counts the deck's share links not revoked (expired ones count, previews never;
  `ShareTokenService.countLive`). Both count hooks judge ONLY a caller the handler would let act (one who can write the deck for the
  links, read and administer it for the invite, a plain member only for a colleague's address):
  anyone else gets the handler's own 404 or 403, never a plan refusal that says more (ADR 013).
  The pool is read in ONE statement (one snapshot), the claim judges the MEMBERS alone plus this
  one (a join converts a reservation and adds no seat; counting the other reservations deadlocked
  a downgraded workspace: first come, first seated), and the count is read outside any lock:
  concurrent invites at the cap may overshoot it by the concurrency (accepted; the next act
  re-reads). `deck.password` is gated on
  the ACT: setting a password the schema accepts, at the mint or on an existing link, is pro;
  removing one is never refused, a too-short one is the validator's 400, and a password set before
  a downgrade keeps protecting the link. A public door (the claim) reads the neutral sentence with
  no details; the signed-in doors carry the full refusal with the upgrade link on the three
  surfaces (`toastApiError` on the invitations page and the links table too). `custom_domain`
  stays declared and ungated because nothing exists to attach a domain to: the day it is built,
  the route carries `feature: 'custom_domain'` from its first commit. The form response is priced
  1 credit per call (Romain's seed ruling of 24 September 2026); a hub that already seeded 5 keeps
  it until staff edits the row. The drill's third leg (Phase 8) is the regression test on a real
  pair: the locked mint refused on the three surfaces with nothing queued or landed, the hub's
  fourth invitation refused, a staff override felt on both sides, the one landed mint's event
  priced 20.
- **Hub-origin workspaces are hub-managed (P7, internal/federation.md)**: on `EDITION=cloud`, every
  local membership MUTATION on a projected workspace (`centralAccountId IS NOT NULL`) — invitation
  create/accept/revoke, member role-change/deactivate/reactivate/delete, reset-link,
  change-email-link — answers 403 `hub_managed` + `details.manageUrl`
  (`packages/chassis-server/src/middleware/hub-managed.ts`, keyed on `principal.accountRef`, method-keyed non-GET). READS stay
  (`GET /members`, invitation list/lookup); the per-deck collaborator surface stays the sanctioned
  local path; cloud-LOCAL workspaces (operator's, deck-guest hosts) and oss are untouched. The
  dashboard adapts off `/me`'s `workspace.hubOrigin`/`origin`/`hubManageUrl`, never
  edition-sniffing.

## Deploying to prod

**First move the version** (PRDCT-2340): on a clean `dev`, `pnpm release patch|minor|major
[--title "…"]` bumps the root and `apps/server` package files together, commits
`chore(release): slideless X.Y.Z` and makes the annotated `vX.Y.Z` tag on it; push `dev` and the
tag (`--push` does both). The kind is the human's call, never derived from commit subjects and
never auto-incremented. The version is intrinsic to the image (PRDCT-1844), so this is the only
place it moves; `release.yml`'s first job (`node scripts/release.mjs guard`) refuses a push whose
package version already carries a v-tag on another commit, so a forgotten bump fails in twenty
seconds instead of shipping a lookalike of the previous release. The CLI keeps its own series
(`packages/cli`, `cli-v*` tags, `publish-cli.yml`).

Then `git push origin origin/dev:refs/heads/prod` is the whole action (PRDCT-2326): `release.yml`
publishes the image (smoke, scan, multi-arch build, ~20 min) and then dispatches the fleet
repository (`antasphere/infra`, `deploy.yml`), which mirrors, pins, plans behind a one-change
gate, applies, probes and commits the pin — live ~25 min after the push, no human step; the
probe's last fact is that the live instance serves the version the push carried. A
rollback is `gh workflow run deploy.yml -R antasphere/infra -f sha=<older sha> -f version=<its version>`.
The setup and the break-glass live in the infra repo (`docs/slideless-deploy.html`, README).

**A docs-only promotion is not a release.** When everything `dev` carries beyond `prod` sits
under `docs/`, `deploy/` or the docs/pages publisher workflows, push `prod` WITHOUT `pnpm
release`: `release.yml` ignores those paths, so no image is built and nothing rolls on GCP,
while `docs-notify.yml` (the docs site) and `hostinger-pages.yml` (the self-hosting template
on `deploy.slideless.antasphere.com`) still publish. One product file in the same push makes
it a release again, and then the version must have moved.

## Commands

```bash
pnpm install
pnpm turbo lint typecheck test build         # the CI gate, part 1
pnpm format:check                            # part 2 — CI runs this too; `pnpm format` fixes
pnpm --filter @slideless/server drift:check  # part 3 — the auth-schema drift guard
pnpm turbo test:integration                  # real Postgres via testcontainers; needs Docker
cd apps/server && pnpm preview:emails        # render every email to a local review wall
```

The mail wall (`apps/server/scripts/previewEmails.ts`) is the same wall as the hub's and the
sibling templates' — one family, so a change to one is a change to consider on the others.
It renders every builder with fixture data, several shapes for the mails that have them, and
nothing is ever sent. A new mail means a new `TemplateSpec` in its `catalogue()`, with
reader-facing `when` copy; the builders stay env-free (urls, names and dates arrive as
parameters), which is what lets `tsx` render them standalone.

The mails' layout is `packages/chassis-server/src/email/shell.ts`, carried BYTE-IDENTICAL by the
hub's `apps/server/src/email/shell.ts` (`cmp` the two before closing a mail task). The five
account mails are the chassis's `email/templates.ts`: they spell no product, the name comes from
`identity.displayName` and the three phrases that are a tool's own from the `copy.mail` slot
(`apps/server/src/email/brand.ts` here). The deck mails are `apps/server/src/email/deck-templates.ts`,
on the same shell and blocks. The grain band and the mark are hosted images,
`apps/dashboard/static/email/band.jpg` and `mark.png`, because Gmail strips SVG and data URIs; the
chassis boot hands their urls to the shell from `PUBLIC_BASE_URL`, and the shell falls back to a
CSS gradient without them. Integration tests read links and codes out of the TEXT part (the first
url in it must be the action link), and `forms.test.ts` pins the held-back-activity wording.

Local dev mail: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` runs Mailpit
and points the SMTP driver at it (internal/dev-mailpit.md).

## Before you change things

**`internal/` is no longer in this repository.** The engineering record moved to the project OS
when the repo was prepared for publication (PRDCT-1341): every `internal/…` path in this file
reads at `labs/products/antasphere/tools/slideless/slideless-os/knowledge/internal/` in the
workspace (`decisions/` for the ADRs, `security-runbooks.md`, `federation.md`, `production-
readiness.md`, `backup-and-data-sovereignty.md`, `cli-release.md`, `dev-mailpit.md`). Nothing
under that folder is published; keep it out of this repo.

- **LESSONS.md** — read it before touching auth, MCP, or Docker packaging; it records the traps
  already hit (inherited from the template) and why the current shapes exist.
- **TEMPLATE-FEEDBACK.md** — friction/improvement ideas that concern the upstream
  platform-template. Never fix the template from here; append to this backlog instead.
- **internal/decisions/** — ADRs: version pins (001, the exact-pinned Better Auth trio), MCP transport
  (002), OIDC client deferral (003), pgvector (004), auth-surface + metrics defaults (005).
- **internal/production-readiness.md** — the honest gap list and roadmap.
- **internal/backup-and-data-sovereignty.md** — deferred design note: why durable backups must stay
  EU-sovereign (self-hosted DB in the instance + encrypted offsite to European object storage, not
  Neon/US), the AUTH_SECRET-in-/data recovery trap, and the open decisions. Read before building a
  backup system. Today's operator runbook for the existing scripts is docs/operations/backup-restore.md.
