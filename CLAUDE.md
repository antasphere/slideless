# Slideless

The Slideless product monorepo, in the n8n mold: one Docker image plus a Postgres container. Ships a
versioned Hono API (`/api/v1`), a SvelteKit dashboard, Better Auth (sessions, API keys, a built-in
OAuth 2.1 authorization server), file storage, pg-boss jobs, an audit log, and a bundled MCP endpoint
(`/mcp`) — so agents are first-class consumers of every instance. Instantiated from the
codika-platform-template (commit `b0dcd13`); branches follow the workspace rule: `prod` (default,
deploys) + `dev` (day-to-day work).

## Identity (fixed at instantiation)

- npm scope `@slideless/*`; CLI binary `slideless`; env var prefix `SLIDELESS_` — the CLI reads
  `SLIDELESS_URL` / `SLIDELESS_API_KEY`.
- API key prefix `slk` (`apps/server/src/apikeys/service.ts`).
- Scopes: `presentations:read`, `presentations:write`, `data:export` (export stays opt-in).
- Docker image `ghcr.io/antasphere/slideless`; Postgres role/db `slideless`; port 3000; `EDITION=oss`.

## Layout

| Path                                | What                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `apps/server`                       | The single deployable: Hono API, identity, MCP, jobs, storage  |
| `apps/dashboard`                    | SvelteKit SPA, built into and served by the server image       |
| `packages/db`                       | drizzle schema + migrations, incl. generated `auth-schema.ts`  |
| `packages/contract`                 | zod schemas + route contracts shared by server, SDK, dashboard |
| `packages/sdk`                      | Typed client over the contract (hand-written today)            |
| `packages/cli`                      | Typed CLI over the SDK; the `slideless` binary (docs/cli.md)   |
| `Dockerfile` + `docker-compose.yml` | The shipped image and the operator stack                       |
| `docs/`                             | Operator guides + ADRs (`docs/README.md` is the index)         |

## Invariants — never regress these

- **Fail-closed scope allowlist** (`apps/server/src/middleware/scopes.ts`): machine principals (API
  keys, OAuth tokens) reach ONLY allowlisted routes; anything unlisted 403s. New endpoints stay
  unreachable to machines until consciously opened.
- **Closed sign-up needs three switches**: the `/sign-up` hook, `disableSignUp` on the emailOTP
  plugin, and `disableSignUp` on each social provider. Removing any one reopens sign-up.
- **Migrations run under a session-scoped `pg_advisory_lock` on a dedicated client** — multi-replica
  safe. Never switch to a transaction-scoped lock.
- **Auth schema drift guard**: any Better Auth config change that alters the schema must regenerate
  `packages/db/src/auth-schema.ts` + the snapshot via the pinned CLI, plus an additive drizzle
  migration. CI's `drift:check` gates it.
- **Never render user content on the app origin** — files are served `attachment` + `nosniff`
  (docs/security.md).

## Commands

```bash
pnpm install
pnpm turbo lint typecheck test build   # the CI gate
pnpm turbo test:integration            # real Postgres via testcontainers; needs Docker
```

Local dev mail: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` runs Mailpit
and points the SMTP driver at it (docs/dev-mailpit.md).

## Before you change things

- **LESSONS.md** — read it before touching auth, MCP, or Docker packaging; it records the traps
  already hit (inherited from the template) and why the current shapes exist.
- **TEMPLATE-FEEDBACK.md** — friction/improvement ideas that concern the upstream
  codika-platform-template. Never fix the template from here; append to this backlog instead.
- **docs/decisions/** — ADRs: version pins (001, the exact-pinned Better Auth trio), MCP transport
  (002), OIDC client deferral (003), pgvector (004), auth-surface + metrics defaults (005).
- **docs/production-readiness.md** — the honest gap list and roadmap.
- **docs/backup-and-data-sovereignty.md** — deferred design note: why durable backups must stay
  EU-sovereign (self-hosted DB in the instance + encrypted offsite to European object storage, not
  Neon/US), the AUTH_SECRET-in-/data recovery trap, and the open decisions. Read before building a
  backup system. Today's operator runbook for the existing scripts is docs/backup-restore.md.
