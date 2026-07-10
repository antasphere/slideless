# Slideless

**The self-hostable home for what your agent builds.** Agents produce
HTML — presentations, small apps, plans, reports. Slideless turns those
folders into versioned, shareable live links: push from the CLI (or let an
agent push over MCP), get a secret URL, send it to anyone. No PowerPoint
export, no static-host glue, no third party holding your content.

It ships in the n8n mold: **one Docker image plus a Postgres container**,
running entirely on your own machine. All state lives in your database and
one data volume; nothing phones home. Every instance is agent-ready at boot:
a typed CLI, a versioned HTTP API (`/api/v1`), and a bundled MCP endpoint
(`/mcp`) behind the instance's **own built-in OAuth 2.1 authorization
server** — no central service anywhere in the loop.

> Licensing: see [LICENSE](LICENSE). The code is currently proprietary to
> Codika; open-sourcing is planned but not yet in effect.

## Five-minute quick start

```bash
git clone <this-repo> slideless && cd slideless
./setup.sh                # generates secrets + a setup token, writes .env (mode 600), starts the stack
open http://localhost:3000
```

1. **Create the owner.** The dashboard shows the first-boot wizard: instance
   name + owner account. It asks for the setup token `setup.sh` printed.
2. **Connect the CLI.** Get the `slideless` binary (from this repo:
   `pnpm install && pnpm --filter @slideless/cli... build`, then alias
   `node packages/cli/dist/bin.js`; or `npm i -g @slideless/cli` once
   published). Mint an API key in the dashboard (API keys → New) and save it
   as a profile:

   ```bash
   slideless login --api-url http://localhost:3000 --api-key slk_...
   ```

   When the instance has an email driver configured, agents and headless
   machines can skip the dashboard entirely with the OTP flow
   (`slideless auth login-request` / `login-complete` — see
   [docs/cli.md](docs/cli.md)).

3. **Push a deck and share it.**

   ```bash
   slideless push ./my-deck --title "Q3 Board Deck"   # prints the deck id
   slideless share <id> --name "Alice"                # prints the /v/{secret} viewer URL
   ```

   The URL renders the deck for anyone who has it — sandboxed, no account
   needed. `slideless pull <id> ./out` gets the files back byte-identical.

Upgrades: `./update.sh`. Data survives in the `pg_data` and `app_data`
volumes; migrations apply automatically at boot under an advisory lock.
Fresh VPS? There is a one-liner installer — see [docs/install.md](docs/install.md).

## What an instance does

- **Versioned decks.** A deck is a folder of HTML/JS/CSS/assets. Every push
  is an immutable version; uploads are content-addressed (unchanged files
  never re-upload) and pulls are byte-exact. Kinds: `presentation`, `app`,
  `plan`.
- **Share links.** Per-recipient secret URLs (`/v/{secret}`), stored
  hash-only server-side, with optional expiry, viewer password,
  pin-to-version or follow-latest, per-send email delivery, view stats, and
  instant revocation.
- **A sandboxed public viewer.** User HTML renders under
  `Content-Security-Policy: sandbox` — an opaque origin with no cookies, no
  storage, no credentialed API. See
  [docs/viewer-security-model.md](docs/viewer-security-model.md).
- **Collaborators + annotations.** Per-deck dev grants (external people who
  can push new versions of one deck) and reviewer annotations captured
  straight from annotator share links into the owner's inbox.
- **Agents as first-class users.** The `slideless` CLI
  ([docs/cli.md](docs/cli.md)), the `/mcp` endpoint with 18 `slideless_`
  tools ([docs/mcp-connector.md](docs/mcp-connector.md)), scoped `slk_` API
  keys, and a browserless email-OTP → API-key login. Start at
  [docs/connect-an-agent.md](docs/connect-an-agent.md).
- **A real multi-user platform underneath.** SvelteKit dashboard (English
  and French), members + invitations, closed sign-up, optional per-user 2FA,
  audit log, GDPR workspace export (opt-in `data:export` scope) and account
  deletion, file storage (local volume or S3), background jobs, Prometheus
  `/metrics`, break-glass recovery. Posture: [docs/security.md](docs/security.md).

## Self-hosted vs. cloud — what this repo does not include

This repository is the complete self-hosted product; every feature above
runs on your instance with no external dependency. Deliberately **not**
here:

- **No template marketplace.** The public template/remix catalog is a cloud
  service. A later release may let self-hosted CLIs remix the central
  catalog through its public read API; nothing in this repo depends on it.
- **No billing or plans.** Entitlements default to allow-all with
  instance-level caps (`MAX_FILE_SIZE_MB`, API quotas).
- **No unified accounts.** The Antasphere cloud edition (hosted instances,
  central accounts) is a separate product; this code never contacts it.

## Repository layout

| Path                | What it is                                                                     |
| ------------------- | ------------------------------------------------------------------------------ |
| `apps/server`       | The Node 22 Hono monolith: API, viewer, health, metrics, MCP, static dashboard |
| `apps/dashboard`    | SvelteKit SPA (adapter-static), built into the server image                    |
| `packages/db`       | Drizzle schema + committed versioned migrations + advisory-lock migrator       |
| `packages/contract` | zod schemas + route contracts (OpenAPI source of truth)                        |
| `packages/sdk`      | Typed fetch client over the contract                                           |
| `packages/cli`      | Typed CLI over the SDK; the `slideless` binary ([docs/cli.md](docs/cli.md))    |
| `docs/`             | Operator guides + ADRs ([docs/README.md](docs/README.md) is the index)         |

## Operating an instance

| Topic                       | Doc                                                            |
| --------------------------- | -------------------------------------------------------------- |
| Install (one-liner, manual) | [docs/install.md](docs/install.md)                             |
| Every env var               | [docs/env-reference.md](docs/env-reference.md)                 |
| Reverse proxy + TLS (Caddy) | [docs/reverse-proxy.md](docs/reverse-proxy.md)                 |
| Upgrades + rollback         | [docs/upgrade.md](docs/upgrade.md)                             |
| Backup + restore            | [docs/backup-restore.md](docs/backup-restore.md)               |
| Connect an agent (CLI/MCP)  | [docs/connect-an-agent.md](docs/connect-an-agent.md)           |
| Viewer security model       | [docs/viewer-security-model.md](docs/viewer-security-model.md) |
| Scaling beyond one box      | [docs/deployment-profiles.md](docs/deployment-profiles.md)     |

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

For local development with a real, inspectable mail-catcher (Mailpit — the
OTP and invitation emails land in a local inbox), run the dev overlay:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`
([docs/dev-mailpit.md](docs/dev-mailpit.md)).

Built on the codika-platform-template chassis (instantiated at template
commit `b0dcd13`). Template-level friction discovered while building
Slideless is logged in [TEMPLATE-FEEDBACK.md](TEMPLATE-FEEDBACK.md).
