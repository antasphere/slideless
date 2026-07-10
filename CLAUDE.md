# codika-platform-template

Self-hosted platform template in the n8n mold: one Docker image plus a Postgres container. Ships a
versioned Hono API (`/api/v1`), a SvelteKit dashboard, Better Auth (sessions, API keys, a built-in
OAuth 2.1 authorization server), file storage, pg-boss jobs, an audit log, and a bundled MCP endpoint
(`/mcp`) — so agents are first-class consumers of every instance. Codika-internal; products instantiate
and rename it. This repo stays on `main` only (template exception to the prod/dev rule).

## Layout

| Path                                | What                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `apps/server`                       | The single deployable: Hono API, identity, MCP, jobs, storage  |
| `apps/dashboard`                    | SvelteKit SPA, built into and served by the server image       |
| `packages/db`                       | drizzle schema + migrations, incl. generated `auth-schema.ts`  |
| `packages/contract`                 | zod schemas + route contracts shared by server, SDK, dashboard |
| `packages/sdk`                      | Typed client over the contract (hand-written today)            |
| `packages/cli`                      | Typed CLI over the SDK; the `platform` binary (docs/cli.md)    |
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

## Before you change things

- **LESSONS.md** — read it before touching auth, MCP, or Docker packaging; it records the traps
  already hit and why the current shapes exist.
- **docs/decisions/** — ADRs: version pins (001, the exact-pinned Better Auth trio), MCP transport
  (002), OIDC client deferral (003), pgvector (004), auth-surface + metrics defaults (005).
- **docs/production-readiness.md** — the honest gap list and roadmap.
- **docs/instantiation.md** — the rename checklist when turning the template into a product.
- **docs/backup-and-data-sovereignty.md** — deferred design note: why durable backups must stay
  EU-sovereign (self-hosted DB in the instance + encrypted offsite to European object storage, not
  Neon/US), the AUTH_SECRET-in-/data recovery trap, and the open decisions. Read before building a
  backup system. Today's operator runbook for the existing scripts is docs/backup-restore.md.
