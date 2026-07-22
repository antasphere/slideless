# Upgrade

Upgrading a self-hosted instance is one command; data survives in the
Docker volumes and migrations apply themselves at boot.

```bash
./update.sh            # = docker compose pull && docker compose up -d
```

Data survives in the `pg_data` and `app_data` volumes. Migrations are
forward-only and additive-first; the booting replica applies them exactly
once under a Postgres advisory lock (concurrent replicas wait, then find
nothing left to do). `/readyz` stays 503 until the schema is current.

## Pinning versions

`latest` follows tagged releases. To pin, set in `.env`:

```bash
APP_IMAGE=ghcr.io/antasphere/slideless:1.2.3
```

Tags published per release: `latest`, `X`, `X.Y`, `X.Y.Z`; the main branch
publishes `next` and `sha-<commit>` for early testing.

## Rollback

Take a backup before upgrading (`./scripts/backup.sh`). Rolling the image
back works while the schema is compatible (additive migrations tolerate the
previous app version). After a bad upgrade:

```bash
# pin the previous version in .env, then
docker compose up -d
# if the schema moved beyond compatibility, restore:
./scripts/restore.sh <STAMP>
```

## Manual migrations (AUTO_MIGRATE=false)

Operators who gate DDL run the same image once as a one-off:

```bash
docker compose run --rm -e AUTO_MIGRATE=true app node dist/index.js & sleep 8 && docker compose stop app
docker compose up -d
```
