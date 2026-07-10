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
