# Contributing

Slideless is developed in the open by Antasphere, and outside contributions
are welcome. It is fair-code under the [Sustainable Use License](LICENSE),
source-available and not open source: read the license before you contribute.

- **Branches.** `dev` is the day-to-day branch and `prod` is what ships. Branch
  from `dev` and open your pull request against `dev`.
- **Security problems never go in an issue or a pull request.** Follow
  [SECURITY.md](SECURITY.md).
- **Bigger changes start with an issue**, so the design is agreed before the
  code is written.

Slideless is built on Antasphere's platform template; improvement ideas that
concern the template itself go in [TEMPLATE-FEEDBACK.md](TEMPLATE-FEEDBACK.md).

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
pnpm turbo lint typecheck test build   # the CI gate, part 1 of 3 — run before every push
pnpm turbo test:integration            # real Postgres via testcontainers; needs Docker
pnpm format                            # prettier --write (CI runs format:check, part 2; the drift check below is part 3)
```

## Better Auth schema drift guard

CI runs `pnpm --filter @slideless/server drift:check`, which regenerates the
auth schema with the pinned `@better-auth/cli` and diffs it against the
committed snapshot. Any Better Auth config change that alters the schema
(new plugin, changed table shape) therefore requires, in the same PR:

1. Update `apps/server/scripts/auth-schema-config.ts`.
2. Regenerate with the pinned CLI and update **both**
   `packages/chassis-db/src/auth-schema.ts` and
   `apps/server/scripts/auth-schema.snapshot.ts` (the CLI silently writes
   nothing when the output file exists — give it a fresh path).
3. Add the corresponding **additive** drizzle migration in
   `packages/db/drizzle`.

See LESSONS.md for the sharp edges (CLI version line, prettier
normalization of the diff).

## Version pins

The `better-auth` / `@better-auth/oauth-provider` / `@better-auth/cli` trio
is exact-pinned.
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
