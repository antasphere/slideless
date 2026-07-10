# Instantiating the template into a product

The single checklist for turning this template into a real product repo.
Work through it top to bottom; the verification step at the end proves you
missed nothing.

## 1. Repo setup

- Clone or copy the template into a new repository and rename it
  (`gh repo create`, or copy + `git remote set-url`).
- Create `prod` + `dev` branches per your org's convention. The template
  repo itself stays `main`-only (it is an iterated codebase, not a deployed
  app); instantiated products get the two long-lived branches immediately.
- Re-point CI/registry settings: the release workflow publishes to
  `ghcr.io/${{ github.repository }}`, so the image name follows the repo
  rename automatically — but set the `RELEASE_ENABLED` repository variable
  before expecting a publish.

## 2. Global renames

### `@platform/*` package scope

Pick your scope (e.g. `@acme/*`) and rename everywhere. A global
search-replace of `@platform/` is the reliable way — it appears in ~50
import statements plus these config sites:

- Package names + `workspace:*` deps in **6 package.json files**:
  `apps/server/package.json`, `apps/dashboard/package.json`,
  `packages/db/package.json`, `packages/contract/package.json`,
  `packages/sdk/package.json`, `packages/cli/package.json`
- `Dockerfile:22-26` — the `pnpm --filter @platform/...` build chain
- `.github/workflows/ci.yml` — the `drift:check` filter (line 21) and the
  integration build filters (line 33)
- `eslint.config.js` — the `no-restricted-imports` boundary groups
  (lines 63, 84-87)
- `apps/dashboard/vite.config.ts` — the `noExternal` list (line 10)
- Docs and scripts that spell out filter commands: `README.md`,
  `docs/env-reference.md`, `docs/verification.md`,
  `apps/server/scripts/generate-env-docs.ts`

Then rename the root `package.json` `name` (currently
`codika-platform-template`) and its `description`.

### Docker image reference

`ghcr.io/codika-io/codika-platform-template` appears at:

- `docker-compose.yml` (the `APP_IMAGE` default)
- `.env.example` (the pinning example)
- `install.sh` (the curl one-liner comment and `REPO_URL`)
- `update.sh` (the pinning comment)
- `docs/install.md` (one-liner, clone URL, container table)
- `docs/upgrade.md` (the pinning example)
- `apps/dashboard/e2e/stack-env.mjs` (the local smoke tag)

### Dockerfile OCI labels

`Dockerfile:61-62` — `org.opencontainers.image.title` (currently
`"platform"`) and `org.opencontainers.image.description`.

## 3. Product identity

### API key prefix

`apps/server/src/apikeys/service.ts` — `API_KEY_PREFIX` (currently `key`).
Pick a short product prefix (e.g. a product called Acme might use `acm`).
The parse regex derives from the constant, so this is a one-line change;
keys minted before the rename stop validating, which only matters
post-launch.

### CLI binary name

`packages/cli/package.json`: rename the package (`@platform/cli`, covered
by the scope rename above) and the `bin` key (`platform`, currently mapping
to `./dist/bin.js`) to your product's command. The CLI reads
`PLATFORM_URL` / `PLATFORM_API_KEY` (`packages/cli/src/context.ts`,
`docs/cli.md`); rename that env prefix together with the binary. The
package is `private: true`, so it is not published by default; publishing
under your scope is a per-product decision.

### Scope strings

Rename the generic `data:read` / `data:write` / `data:export` to your
domain's scopes (e.g. `docs:read` / `docs:write` / `docs:export`). Keep
`data:export`'s opt-in character when renaming: the full-workspace export
must never ride the plain read scope. Every file that carries the strings:

- `packages/contract/src/schemas/common.ts` — `scopeSchema` enum
- `apps/server/src/middleware/scopes.ts` — the `Scope` type + the
  fail-closed allowlist (the enforcement point)
- `apps/server/src/identity/better-auth.ts` — `OAUTH_SCOPES`
- `apps/server/src/mcp/server.ts` — tool `checkScope` calls
- `apps/server/src/api/apikeys.ts` — the scopes cast
- `apps/server/src/api/index.ts` — the `/me` scopes cast
- `apps/dashboard/src/routes/(app)/api-keys/+page.svelte` — key-mint
  scope picker copy
- `apps/dashboard/src/routes/oauth/consent/+page.svelte` — consent screen
  copy
- `docs/mcp-connector.md` — the conventions section
- `scripts/loadtest.sh` — the minted test key
- `.github/workflows/release.yml` — the e2e smoke's minted key
- Tests: `apps/server/test/integration/oauth-mcp.test.ts`,
  `platform-core.test.ts`, `files.test.ts`, `observability.test.ts`,
  `apps/server/test/unit/mcp-errors.test.ts`

### Environment defaults

- `EDITION` — `apps/server/src/env.ts` defaults to `oss`; set your
  product's edition string.
- **Port** — the default is 3000. If your product needs another, change
  `apps/server/src/env.ts` (the `PORT` default), the `Dockerfile`
  (`EXPOSE` + healthcheck), `docker-compose.yml` (the port mapping — note
  `APP_PORT` changes the host side only; healthchecks assume 3000
  in-container), `scripts/loadtest.sh`, `.env.example`, and the docs that
  spell out `localhost:3000` (`install.md`, `reverse-proxy.md`,
  `security.md`, `env-reference.md`).
- `EMAIL_FROM` example — `.env.example` and `docs/env-reference.md` show
  `Platform <noreply@example.com>`; update to your product's sender.

### Postgres role/database name

The compose stack creates role + database `platform`:

- `docker-compose.yml` — `DATABASE_URL`, `POSTGRES_USER` / `POSTGRES_DB`,
  and the `pg_isready` healthcheck
- `README.md` — the local-dev `DATABASE_URL`
- `packages/db/drizzle.config.ts` — the fallback URL

Renaming is optional (it is invisible to users) but do it consistently or
not at all — a half-rename bricks the compose healthcheck.

## 4. Branding

- **Instance name** needs no code change: the first-boot setup wizard asks
  for it and stores it in the database; the dashboard and MCP server read
  it at runtime.
- `apps/dashboard/src/app.html` — the `<title>` (currently `Platform`);
  add your favicon under `apps/dashboard/static/`.
- `apps/dashboard/src/app.css` + `src/lib/styles/terra-colors.css` — the
  design tokens (brand colors, shade scales). Fonts live in
  `apps/dashboard/static/fonts/`.
- **Dashboard copy / languages** — every user-facing dashboard string
  lives in `apps/dashboard/src/lib/i18n/` (`en.ts` + `fr.ts`, en/fr out of
  the box). Reword copy there, not in the components. To add or drop a
  locale, follow the recipe in [i18n.md](i18n.md) — and read ADR 007
  before adding a third language.

## 5. Verify

```bash
pnpm install                                   # regenerates the lockfile under the new names
pnpm turbo lint typecheck test build
pnpm turbo test:integration                    # needs Docker
grep -rn "@platform\|codika-platform-template" \
  --exclude-dir=node_modules --exclude=pnpm-lock.yaml .   # expect zero hits
```

Also grep for your old scope strings (`data:read`, `data:write`,
`data:export`) and the old key prefix (`key_`) if you renamed them — the
scope allowlist is fail-closed, so a missed rename shows up as machine
principals getting 403s, not as an open hole.
