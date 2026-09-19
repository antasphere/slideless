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

> **License.** Slideless is [fair-code](https://faircode.io), distributed under the
> [Sustainable Use License](LICENSE): the source is open to read, and you may
> self-host it, modify it and use it for your own internal business or personal
> purposes, free of charge. You may not sell it or offer it to others as a paid
> or hosted service. It is source-available, not open source.
> Copyright (c) 2026 Antasphere.

## Five-minute quick start

Using a dedicated Hostinger VPS? Follow the
[Hostinger installation guide](docs/self-hosting/hostinger.md) for the deployment
button, automatic HTTPS, and browser setup.

```bash
git clone <this-repo> slideless && cd slideless
./setup.sh                # generates secrets + a setup token, writes .env (mode 600), starts the stack
                          # (with only POSTGRES_PASSWORD set in .env, `docker compose up` works too:
                          #  the server generates its secret and the setup token itself and prints
                          #  the token in the container log)
open http://localhost:3000
```

1. **Create the owner.** The dashboard shows the first-boot wizard: instance
   name + owner account. It asks for the setup token `setup.sh` printed.
2. **Connect the CLI.** Get the `slideless` binary (from this repo:
   `pnpm install && pnpm --filter @antasphere/slideless... build`, then alias
   `node packages/cli/dist/bin.js`; or `npm i -g @antasphere/slideless`). Mint an API key in the dashboard (API keys → New) and save it
   as a profile:

   ```bash
   slideless login --api-url http://localhost:3000 --api-key slk_...
   ```

   When the instance has an email driver configured, agents and headless
   machines can skip the dashboard entirely with the OTP flow
   (`slideless auth login-request` / `login-complete` — see
   [docs/agents/cli.md](docs/agents/cli.md)).

3. **Push a deck and share it.**

   ```bash
   slideless push ./my-deck --title "Q3 Board Deck"   # prints the deck id
   slideless share <id> --name "Alice"                # prints the /v/{secret} viewer URL
   ```

   The URL renders the deck for anyone who has it — sandboxed, no account
   needed. `slideless pull <id> ./out` gets the files back byte-identical.

Upgrades: `./update.sh`. Data survives in the `pg_data` and `app_data`
volumes; migrations apply automatically at boot under an advisory lock.
Fresh VPS? There is a one-liner installer — see [docs/self-hosting/install.md](docs/self-hosting/install.md).

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
  [docs/security/viewer-security-model.md](docs/security/viewer-security-model.md).
- **Collaborators + annotations.** Per-deck dev grants (external people who
  can push new versions of one deck) and reviewer annotations captured
  straight from annotator share links into the owner's inbox.
- **Agents as first-class users.** The `slideless` CLI
  ([docs/agents/cli.md](docs/agents/cli.md)), the `/mcp` endpoint with 24 `slideless_`
  tools ([docs/agents/mcp-connector.md](docs/agents/mcp-connector.md)), scoped `slk_` API
  keys, and a browserless email-OTP → API-key login. Start at
  [docs/getting-started/connect-an-agent.md](docs/getting-started/connect-an-agent.md).
- **A real multi-user platform underneath.** SvelteKit dashboard (English
  and French), members + invitations, closed sign-up, optional per-user 2FA,
  audit log, GDPR workspace export (opt-in `data:export` scope) and account
  deletion, file storage (local volume or S3), background jobs, Prometheus
  `/metrics`, break-glass recovery. Posture:
  [docs/security/security.md](docs/security/security.md).

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
  central accounts) runs this same code with `EDITION=cloud`; the default
  `oss` edition has no hub surface and never contacts it.

## Repository layout

| Path                        | What it is                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`               | The Node 22 Hono monolith: API, viewer, health, metrics, MCP, static dashboard                                                                                       |
| `apps/dashboard`            | SvelteKit SPA (adapter-static), built into the server image                                                                                                          |
| `packages/chassis-db`       | Generic tables (auth, workspaces, keys, audit, files) + pool factory + advisory-lock migrator                                                                        |
| `packages/db`               | The deck tables + ALL committed versioned migrations (chassis and deck)                                                                                              |
| `packages/chassis-contract` | Generic zod schemas + route contracts (instance, identity, workspaces, keys, audit, files); the scope-carrying ones are built by `defineChassisContract({ scopes })` |
| `packages/contract`         | The deck zod schemas + route contracts, and the chassis contract instantiated with the Slideless scopes (OpenAPI source of truth)                                    |
| `packages/sdk`              | Typed fetch client over the contract                                                                                                                                 |
| `packages/cli`              | Typed CLI over the SDK; the `slideless` binary ([docs/agents/cli.md](docs/agents/cli.md))                                                                            |
| `docs/`                     | Public product docs ([docs/index.md](docs/index.md) is the landing page)                                                                                             |

## Operating an instance

| Topic                       | Doc                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Install (one-liner, manual) | [docs/self-hosting/install.md](docs/self-hosting/install.md)                         |
| Every env var               | [docs/reference/env-reference.md](docs/reference/env-reference.md)                   |
| Reverse proxy + TLS (Caddy) | [docs/self-hosting/reverse-proxy.md](docs/self-hosting/reverse-proxy.md)             |
| Upgrades + rollback         | [docs/self-hosting/upgrade.md](docs/self-hosting/upgrade.md)                         |
| Backup + restore            | [docs/operations/backup-restore.md](docs/operations/backup-restore.md)               |
| Connect an agent (CLI/MCP)  | [docs/getting-started/connect-an-agent.md](docs/getting-started/connect-an-agent.md) |
| Viewer security model       | [docs/security/viewer-security-model.md](docs/security/viewer-security-model.md)     |
| Scaling beyond one box      | [docs/self-hosting/deployment-profiles.md](docs/self-hosting/deployment-profiles.md) |

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
(the Mailpit inbox is on `http://localhost:8025` unless `MAILPIT_UI_PORT` says otherwise).

Built on Antasphere's platform template. Template-level friction discovered
while building Slideless is logged in [TEMPLATE-FEEDBACK.md](TEMPLATE-FEEDBACK.md).
