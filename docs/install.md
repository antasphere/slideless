# Install

Two supported paths. Both end with the first-boot wizard in the browser.

## One-liner (fresh VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/codika-io/codika-platform-template/main/install.sh | \
  sudo bash -s -- --domain platform.example.com
```

Installs git + Docker if missing, clones to `/opt/platform`, generates
secrets into `.env` (mode 600), starts the stack, and configures UFW
(22/80/443; 3000 only when no `--domain` is given). With a domain, finish by
wiring the reverse proxy ([reverse-proxy.md](reverse-proxy.md)) and setting
`TRUST_PROXY=true` in `.env`.

## Manual (any machine with Docker)

```bash
git clone https://github.com/codika-io/codika-platform-template.git platform
cd platform
./setup.sh            # generates .env secrets, pulls images, starts
open http://localhost:3000
```

`setup.sh` is idempotent: with an existing `.env` it just (re)starts.

## First boot

The dashboard shows the setup wizard: instance name + owner account. When a
`SETUP_TOKEN` is set, the wizard requires it — this stops a stranger racing
you to own a freshly exposed instance. `setup.sh` and the one-liner installer
always generate one; on a hand-written `.env` without it, setup is
first-come-first-served, so **set `SETUP_TOKEN` on any internet-reachable
host**. Setup runs exactly once; afterwards the endpoint answers `410 Gone`.

Teammates join via invitations (Members → Invite). Every invitation yields a
copyable accept link — SMTP is never required. To also send invitation
emails, configure an email driver in `.env` ([env-reference.md](env-reference.md)).

## What's running

| Service | Image                                        | Data                                                  |
| ------- | -------------------------------------------- | ----------------------------------------------------- |
| `app`   | `ghcr.io/codika-io/codika-platform-template` | `app_data` volume → `/data` (files, generated secret) |
| `db`    | `pgvector/pgvector:pg17`                     | `pg_data` volume                                      |

The app container is stateless by design — all state lives in Postgres and
the `/data` volume. Migrations apply automatically at boot under an advisory
lock; set `AUTO_MIGRATE=false` to run them manually (the instance then
refuses readiness while behind).
