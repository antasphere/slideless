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
