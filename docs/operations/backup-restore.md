# Backup and restore

What to back up on a self-hosted instance, how to automate dailies, how to
restore — and the drill that proves your backups actually work.

## What must be backed up

1. **The database** — users, workspaces, keys, audit, file metadata, jobs.
2. **The `/data` volume** — uploaded file blobs (local storage driver) and
   the auto-generated auth secret.
3. **`.env`** — your secrets and configuration.

With `STORAGE_DRIVER=s3`, blobs live in the bucket; use the bucket's own
replication/versioning and back up only 1 + 3.

## Backup

```bash
./scripts/backup.sh                         # → ./backups/{db,data,config}-<stamp>.*
BACKUP_DIR=/mnt/backups ./scripts/backup.sh # elsewhere
```

Dailies via cron:

```cron
0 3 * * * /opt/slideless/scripts/backup.sh >> /var/log/slideless-backup.log 2>&1
```

Retention defaults to 30 days (`RETENTION_DAYS`). Ship the backup directory
off the machine (rsync, restic, object storage) — a backup on the same disk
is not a backup.

## Restore

```bash
ls backups/                       # find the <STAMP>
./scripts/restore.sh <STAMP>      # prompts before replacing anything
```

Restores the database and the `/data` volume, then restarts the app. The
`.env` archive is restored manually when needed (it contains the secrets the
data was encrypted/peppered with — losing `AUTH_SECRET` invalidates all
sessions, and API keys with it unless their pepper versions are pinned in
`API_KEY_PEPPERS`; see [security.md](../security/security.md)).

## Disaster recovery drill

Quarterly, on a scratch machine: fresh clone → `./setup.sh` → stop →
copy a production backup in → `./scripts/restore.sh` → verify login, files
download, audit history. A restore that has never been rehearsed is a hope,
not a plan.
