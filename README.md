# Slideless

Self-hosted Slideless: one Docker image plus a Postgres container, in the n8n mold. Ships a versioned HTTP API (`/api/v1`), a SvelteKit dashboard (English and French), member management, API keys, self-service account management (name, password, and email change), an audit log, file storage, background jobs, GDPR workspace export (behind an opt-in `data:export` scope) and account deletion, and a bundled MCP endpoint (`/mcp`) behind a built-in OAuth 2.1 authorization server — so agents (Claude Code, claude.ai connectors, CLIs) are first-class consumers of every instance.

## Quick start

```bash
git clone <this-repo> slideless && cd slideless
./setup.sh                # generates secrets + a setup token, writes .env (mode 600), starts the stack
open http://localhost:3000
```

`setup.sh` prints the setup token the first-boot wizard needs. For a manual install, `cp .env.example .env`, set a real `POSTGRES_PASSWORD` (compose refuses to start while it is empty), and `docker compose up -d`.

Upgrade: `./update.sh` (or `docker compose pull && docker compose up -d`). Data lives in the `pg_data` and `app_data` volumes; migrations apply automatically at boot under an advisory lock.

## Repository layout

| Path                | What it is                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| `apps/server`       | The Node 22 Hono monolith: API, health, metrics, MCP, static dashboard     |
| `apps/dashboard`    | SvelteKit SPA (adapter-static), built into the server image                |
| `packages/db`       | Drizzle schema + committed versioned migrations + advisory-lock migrator   |
| `packages/contract` | zod schemas + route contracts (OpenAPI source of truth)                    |
| `packages/sdk`      | Typed fetch client over the contract                                       |
| `packages/cli`      | Typed CLI over the SDK; the `slideless` binary ([docs/cli.md](docs/cli.md)) |
| `docs/`             | Install, upgrade, backup, reverse proxy, env reference, ADRs               |

## Development

```bash
pnpm install
pnpm turbo build          # db → dashboard (into server public/) → server
pnpm turbo lint typecheck test
# Local Postgres: uncomment the db `ports:` mapping in docker-compose.yml first
# (loopback-only), then:
docker compose up -d db
DATABASE_URL=postgres://slideless:<pw>@localhost:5432/slideless pnpm --filter @slideless/server dev
```

The `docs/` operator guide covers install, upgrade, backup, reverse proxy, and every env var; `docs/cli.md` covers the `slideless` command-line client. For local development with a real, inspectable mail-catcher (Mailpit), see [docs/dev-mailpit.md](docs/dev-mailpit.md).

Built on the codika-platform-template chassis (instantiated at template commit `b0dcd13`). Template-level friction discovered while building Slideless is logged in [TEMPLATE-FEEDBACK.md](TEMPLATE-FEEDBACK.md).
