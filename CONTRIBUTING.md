# Contributing

For team members, contractors, and engagement contributors working on
Slideless. The repo was instantiated from the codika-platform-template;
improvement ideas that concern the upstream template go in
[TEMPLATE-FEEDBACK.md](TEMPLATE-FEEDBACK.md), not here.

## Prerequisites

- **Node 22** (`engines` in package.json; the image is `node:22-alpine`)
- **pnpm 10** (`packageManager` pin — corepack picks it up)
- **Docker** — the integration suite runs Postgres via testcontainers

## Setup

```bash
pnpm install
pnpm turbo build
```

## Task rail

```bash
pnpm turbo lint typecheck test build   # the CI gate — run before every push
pnpm turbo test:integration            # real Postgres via testcontainers; needs Docker
pnpm format                            # prettier --write (CI runs format:check)
```

## Better Auth schema drift guard

CI runs `pnpm --filter @slideless/server drift:check`, which regenerates the
auth schema with the pinned `@better-auth/cli` and diffs it against the
committed snapshot. Any Better Auth config change that alters the schema
(new plugin, changed table shape) therefore requires, in the same PR:

1. Update `apps/server/scripts/auth-schema-config.ts`.
2. Regenerate with the pinned CLI and update **both**
   `packages/db/src/auth-schema.ts` and
   `apps/server/scripts/auth-schema.snapshot.ts` (the CLI silently writes
   nothing when the output file exists — give it a fresh path).
3. Add the corresponding **additive** drizzle migration in
   `packages/db/drizzle`.

See LESSONS.md for the sharp edges (CLI version line, prettier
normalization of the diff).

## Version pins

ADR 001 (`internal/decisions/001-version-pins.md`) exact-pins the
`better-auth` / `@better-auth/oauth-provider` / `@better-auth/cli` trio.
**Never bump one of them in isolation** — the oauth-provider peer conflict
breaks installs and the drift guard fails CI. Bump all three together with
the drift and integration suites green, or not at all. Dependabot is
configured to ignore the trio for this reason.

## Pull requests

- Tests for every behavior change — no untested behavior lands.
- Docs updated in the same PR (`docs/`, and regenerate
  `docs/reference/env-reference.md` via `pnpm --filter @slideless/server docs:env`
  when env vars change).
- prettier and eslint clean (`pnpm format`, `pnpm turbo lint`).
- Call out breaking changes and migration impact explicitly in the PR
  description.
