# Template feedback

Discoveries, friction, and improvement ideas that concern the upstream
**codika-platform-template**, found while building Slideless on top of it.
We do NOT change the template from here — this file is the backlog for future
template improvements. Every work session on this repo appends its findings.

Format: dated entries, newest section last. Keep each entry short and
actionable; link the template file/line it concerns.

## 2026-07-10 — Phase 0 instantiation (template @ b0dcd13)

- **The instantiation checklist misses several product-name strings.** After
  following `docs/instantiation.md` top to bottom, a case-insensitive sweep
  still found `platform` as: the commander program name and description
  (`packages/cli/src/index.ts` `.name('platform')` — this is what `--help`
  prints, arguably as user-visible as the bin key), the MCP server identity
  (`apps/server/src/mcp/server.ts` `{ name: 'platform' }` — shows up in MCP
  client handshakes), the OTel `service.name` + tracer name
  (`apps/server/src/observability/otel.ts`), the API fallback page
  (`apps/server/src/app.ts` `<h1>Platform API is running</h1>`), the installer
  default dir `/opt/platform` + docs mentions (`install.sh`,
  `docs/install.md`, `docs/backup-restore.md`, `scripts/backup.sh` cron
  example), the backup/restore/scale scripts' hardcoded `psql -U platform -d
  platform` (NOT covered by the "compose + README + drizzle.config" list in
  the Postgres-rename section), and cosmetic test labels. Suggest: extend the
  checklist, or better, hoist a single `PRODUCT_NAME`/identity module the
  whole codebase reads.
- **The checklist doesn't say what to do with `docs/instantiation.md` itself.**
  Its verify step greps for `@platform\|<template-name>` and expects zero
  hits, but the checklist file itself contains both. We deleted it from the
  product repo (and dropped its row from `docs/README.md`, its mention in
  `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`). The checklist should state
  that.
- **`.changeset/config.json` pins `baseBranch: "main"`.** Instantiated
  products use `prod` as default per the workspace rule; the checklist's
  repo-setup section should mention it.
- **Class names stay template-branded.** `PlatformClient`, `PlatformApiError`,
  `PlatformRegistry`, the `src/platform/` module dir, and the i18n
  `nav.platform` label survive instantiation. Deliberate (internal API), but
  the checklist could say so explicitly so instantiators don't chase them.
- **No dev mail-catcher out of the box.** `EMAIL_DRIVER=none` is a sane prod
  default, but every product will want the real SMTP path exercised in
  dev/E2E. We added a `docker-compose.dev.yml` Mailpit overlay +
  `docs/dev-mailpit.md`; consider upstreaming it to the template.
- **`docs/env-reference.md` is generated but the checklist has you sed it.**
  The EMAIL_FROM example lives in a zod doc-comment in
  `apps/server/src/env.ts` AND in the generated `docs/env-reference.md`;
  cleaner instruction: edit `env.ts`, then regenerate via
  `pnpm --filter @slideless/server docs:env`.
- **Checklist positives worth keeping:** the file-by-file lists for the scope
  strings and image refs were accurate and complete; `EDITION` already
  defaulted to `oss`; the verify-grep catches most misses. The scope rename
  (`data:read`→`presentations:read` etc.) via plain string replace worked
  across contract/middleware/tests with zero manual fixes.
- **The API-key-prefix rename is NOT "a one-line change".** Four test sites
  hardcode `key_`: the mint-format regex and the tampered-key builder in
  `apps/server/test/integration/platform-core.test.ts` (2 integration
  failures + cascading audit assertions, 7 red tests total on first run),
  the secret slicer in `apikey-pepper-rotation.test.ts` (passes only while
  the new prefix has the same length as `key`), and the e2e regex in
  `apps/dashboard/e2e/smoke.spec.ts`. Either derive them from
  `API_KEY_PREFIX` or list them in the checklist.
- **The pre-setup default instance name and email branding are hardcoded
  `'Platform'`.** `boot.ts` (`cachedName` fallback), `api/index.ts` (the
  `/instance` discovery fallback), and `email/templates.ts`
  (`PRODUCT_NAME`, user-visible in every delivered email). None are in the
  checklist; the branding section's "instance name needs no code change"
  claim is only true post-wizard.
- **`setup.sh` cannot boot a fresh instantiation.** It runs
  `docker compose up -d --pull always`, which tries to pull
  `ghcr.io/<owner>/<repo>:latest` — an image that does not exist until the
  product's first release. First boot needs a local `docker build` + an
  `APP_IMAGE` override in `.env` (what we did). setup.sh could fall back to
  `--build` when the pull fails, or the checklist could call this out.
- **Compose `APP_PORT` knob worked exactly as documented** when host port
  3000 was occupied (by the template's own dev stack, amusingly): setting
  `APP_PORT` + `PUBLIC_BASE_URL` in `.env` was sufficient, in-container port
  untouched. Good design; keep it.

## 2026-07-10 — Phase 2 (presentation domain model + contracts)

- **The SDK route-coverage test hardcodes `{id}` substitution.** Its
  `expectedPath` helper only replaces `{id}`, so the first product route with
  a second path param (`{tokenId}`, `{version}`, `{sha256}`) forces editing
  the test. Suggest the template ship a param-name → sample-value map (or
  substitute any `{param}` with a type-appropriate sample) so products only
  add INVOKERS entries.
- **No recipe for contract-first phased builds.** We froze 24 routes ahead of
  their handlers by declaring a `501` response on each contract route and
  registering stubs that answer it (implementers delete the 501 entry with
  the handler). Worked cleanly with @hono/zod-openapi's typed handlers —
  worth documenting as the blessed pattern, since `errorResponses` ships no
  501 and an undeclared status fails typecheck.
- **No multipart example in the contract layer.** Modeling
  `multipart/form-data` (file + field) via `content: { 'multipart/form-data':
  { schema: z.object({ sha256, file: z.any() }) } }` renders valid OpenAPI
  3.1; a template example would have saved the trial run.
- **Drizzle wraps pg errors: constraint assertions must inspect `.cause`.**
  `expect(...).rejects.toThrow(/constraint_name/)` never matches because
  DrizzleQueryError's message is `Failed query: <sql>`; the pg error (with
  `.code === '23505'` and `.constraint`) hangs off `error.cause`. Worth a
  line in the template's testing docs.
- **Positives:** `drizzle-kit generate --name <slug>` slotted a cleanly named
  0013 into the journal; the scopes.ts "Products: open your domain endpoints
  here" comment made the fail-closed extension obvious; reusing the
  content-addressed `files` machinery for a product blob store required zero
  template changes (ADR 011).

## 2026-07-10 — Viewer-origin security spike (ADR 012)

- **The global `securityHeaders` middleware CLOBBERS per-route CSP and
  `Referrer-Policy`.** `middleware/security-headers.ts` runs after `next()` and
  unconditionally calls `c.header('referrer-policy', …)` and, on any `text/html`
  response, `c.header('content-security-policy', <dashboard csp>)`. Both are
  hard overwrites, so a route cannot serve its own policy: a viewer route
  setting `Content-Security-Policy: sandbox …` and `Referrer-Policy: no-referrer`
  gets silently reverted to the dashboard CSP + `strict-origin-when-cross-origin`
  at the wire. Any product that must serve a second HTML policy on the app origin
  (a sandboxed content viewer, an embeddable widget, a differently-CSP'd public
  page) hits this. Fix is a one-line guard — only set the default when the route
  has not already set one: `if (!c.res.headers.has('content-security-policy'))`
  and likewise for `referrer-policy`. Consider making the template's middleware
  respect a route-set value by default. (Guard demonstrated on branch
  `spike/viewer-origin`.)
- **The route-precedence "open slot" in `app.ts` works as intended.** Mounting a
  public product sub-app with `app.route('/', …)` in the documented slot before
  `serveStatic`/the SPA fallback took the request cleanly, ahead of the catch-all
  — no precedence surprises. Keep the slot and its comment.
- **`files/http.ts`'s attachment-by-default is the right default, but a product
  that renders user content needs a documented, first-class escape hatch.**
  Slideless must serve user HTML **inline** under a sandboxing CSP (ADR 012).
  Today that means bypassing `contentDispositionFor` entirely and hand-rolling
  the headers. The template could offer a blessed "isolated inline" serving
  helper (inline + `nosniff` + `Referrer-Policy: no-referrer` + a required
  `Content-Security-Policy: sandbox …` that refuses to emit without the sandbox
  directive and hard-bans `allow-same-origin`), so the one dangerous exception to
  the "never render user content on the app origin" rule is centralized and
  test-guarded rather than re-derived per product.
- **`/api/v1` cross-site credentialed hardening would help isolated viewers.**
  security.md already flags that the custom `/api/v1` routes rely on
  `SameSite=Lax` alone (no per-request Origin/Sec-Fetch-Site symmetry check). The
  spike showed Firefox will still transmit the session cookie on an
  opaque-origin credentialed fetch to `/api/v1/me` (the response was CORS-blocked
  so nothing leaked, and the server answered 401). Adding the noted
  Origin/`Sec-Fetch-Site: cross-site` rejection to the `/api/v1` surface would
  refuse the request outright — a template-level defense-in-depth that every
  content-rendering product inherits.

## 2026-07-10 — Phase 3 (upload + versioning pipeline)

- **Hono/zod-openapi multipart validation buffers whole parts in memory.** The
  contract fixed `multipart/form-data` for the asset upload, and
  `zValidator('form')` rides `c.req.parseBody()`, which materializes every part
  as a `File` in RAM; we then buffer once more (`file.arrayBuffer()`) to
  hash-verify the declared sha256 BEFORE any row/blob exists. Fine at
  slide-asset sizes (and a `bodyLimit` bounds the parse), but the template's
  streamed-with-mid-stream-cap upload pattern (`POST /files`, spool + hash in
  one pipeline) is strictly better for large payloads. If a future template
  revision grows a multipart helper, make it a streaming multipart parser
  (busboy-style) that can hash-and-spool per part — products then get
  hash-verified multipart for free instead of choosing between "multipart" and
  "streaming".
- **The global 1 MiB JSON `bodyLimit` needs per-surface routing as soon as a
  product has legitimately-large JSON.** Contract-valid commit manifests (5000
  entries × 1 KiB paths) exceed 1 MiB, so `api/index.ts` now routes body
  limits by path (1 MiB default / 16 MiB manifests / MAX_FILE_SIZE_MB+1 MiB
  multipart). A template-level `bodyLimitByPrefix([...])` helper would make
  this a declaration instead of an if-chain every product re-grows.
- **`FileService.delete` needed a transactional in-use seam.** ADR 011's
  blob-guard (a deck manifest must pin its blobs against the generic
  `DELETE /files/{id}`) only closes race-free if the reference check runs
  inside the delete transaction with the files row locked FOR UPDATE, while
  commits lock referenced rows FOR SHARE. The template's delete was
  fire-and-forget (soft-delete then blob removal). The optional
  `inUse(tx, row)` callback added here is a clean general seam — consider
  upstreaming it: any product that builds references onto `files` (the whole
  point of reusing the table) needs exactly this hook.
- **`pageOf`/`keysetBefore` generalized cleanly to a child collection** by
  passing the parent-id column as the "workspace" scope column (version
  listings scope the cursor subquery to the deck, not the workspace) — nice
  property of the helper's shape; worth a doc line in pagination.ts.
- **The explicit idempotency target list is the right shape** — adding
  `POST /presentations/uploads` was one Set entry + a doc line. No friction,
  recording the confirmation.

## 2026-07-10 — Phase 4 (sharing + the public viewer)

- **The global `securityHeaders` middleware unconditionally clobbered
  per-route CSP and Referrer-Policy** — the exact fail-dangerous class ADR
  012 warns about: a route that sets `Content-Security-Policy: sandbox …`
  for user content had it silently replaced by the dashboard CSP on every
  `text/html` response. Fixed here with `!c.res.headers.has(...)` guards
  (set-if-absent). The template should ship the guarded form: a baseline
  header middleware must be a DEFAULT, never an override — any product that
  adds a public content route hits this, and nothing fails loudly when it
  bites.
- **`serveBlob` needed disposition/header override seams for a sandboxed
  inline surface.** The safe-serving helper hardcodes
  `contentDispositionFor` (attachment for active types) and an `immutable`
  Cache-Control — both correct for the app-origin files surface, both wrong
  for a sandboxed viewer whose URLs are not content-addressed. Two optional
  fields (`contentDisposition`, `extraHeaders`) made it reusable; consider
  upstreaming that shape (documented as "only under an isolation regime").
- **`PepperRegistry` only exposed `get(version)` + `current` — resolution
  for versionless credentials was impossible.** API keys carry their pepper
  version in the row (keyId lookup first); a share-token secret IS the
  lookup key, so resolving across rotations needs the registered version
  list to compute candidate hashes. Added `versions: readonly number[]` to
  the registry. Any product token whose hash is the index key (share links,
  claim tokens...) needs this — worth having in the template from the start.
- **Hash-only token storage forces a choice on "email this link later":
  the server cannot re-derive the URL.** We made send ROTATE the token onto
  a fresh secret (mint → mail → persist, so a failed delivery never bricks
  the old link) and documented it in the route contract. A template-level
  note on this pattern (one-shot secrets vs. later-delivery flows) would
  save every product the same design detour.
- **The auth-surface rate-limiter registry extended cleanly** — one
  `viewerPassword: make('viewer-pw', 10, 15*60)` entry for the password
  gate's per-IP+token failure wall. Confirming the registry-of-named-buckets
  shape scales to product surfaces.

## 2026-07-10 — Phase 5 (collaborators + annotations)

- **The two-token invitation pattern is not extractable.**
  `invitations/service.ts` (mint pair → sha256 both → find-live-and-report-
  which → guarded one-shot redeem) had to be re-implemented verbatim for the
  per-deck collaborator grants (`collaborators/service.ts`) because the
  service is welded to the `invitations`/`workspace_members` tables. A tiny
  template helper — `mintClaimTokenPair()` + `matchClaimToken(hashA, hashB,
  presented)` — would let every product token-redemption surface (deck
  grants here; any future resource-scoped invite) reuse the crypto + the
  ADR 009 which-token-proves-mailbox semantics instead of copying them.
- **"Public API path" means two different things and only one is written
  down.** `isPublicApiPath` (auth-context.ts) skips credential resolution
  entirely; the OTHER public tier — routes like `/invitations/accept` that
  stay outside `requireAuth` but still resolve an optional session and rely
  on the fail-closed scope gate to keep machines out — exists only as an
  unwritten convention. Phase 5 added two more of the second kind
  (`/collaborators/lookup|claim`) plus a genuinely anonymous surface
  (`/api/v1/viewer/*`). A short doc block over `isPublicApiPath` naming the
  two tiers (and that "not requireAuth + unlisted in scopes.ts" is the
  sanctioned pattern for human token-redemption endpoints) would prevent a
  future implementer from "fixing" one into the other.
- **`user.created` is emitted from exactly one call site (invitation
  accept), not from a central identity seam.** Products subscribing to it
  for claim-at-signup semantics (collaborator grants here) must know that
  setup's owner creation and any future account entrance do NOT fire it —
  Phase 5's claim endpoint has to emit it manually. Emitting from a single
  identity-layer hook (Better Auth databaseHooks user.create.after) would
  make the event trustworthy by construction.
- **`keysetBefore`'s `workspaceId` parameter is really a scope column.**
  Phase 4 already scoped it by `presentationId` for tokens/versions; Phase 5
  repeated that for collaborators and annotations. The name keeps demanding
  a comment at every call site — renaming the field to `scopeColumn` /
  `scope` in the template would erase four copies of the same explanation.
- **Contract routes that declare no 403 force forbidden-as-404.** The frozen
  annotation list/create entries declare only 401/404, so the handlers must
  answer 404 for an authorized-user-but-wrong-role (they do, documented).
  Template guidance for contract authors — "every authed resource route
  declares 401 AND 403 AND 404 unless hiding existence is deliberate" —
  would make that a choice instead of an accident.
