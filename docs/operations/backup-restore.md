# Backup and restore

What to back up on a self-hosted instance, how to automate dailies, how to
restore — and the drill that proves your backups actually work.

## What must be backed up

1. **The database** — users, workspaces, keys, audit, file metadata, jobs.
2. **The `/data` volume** — uploaded file blobs (local storage driver), the
   erasure tombstone (see below) and, on installs that never set
   `AUTH_SECRET`, the auto-generated auth secret.
3. **`.env`** — your secrets and configuration.

With `STORAGE_DRIVER=s3`, blobs live in the bucket; use the bucket's own
replication/versioning and back up only 1 + 3.

**3 is not optional — and it happens only with `BACKUP_PASSPHRASE` set.**
`AUTH_SECRET` is the pepper root: API-key hashes, share-link and edit-secret
hashes, and the idempotency cipher all derive from it, and `setup.sh`
generates a fresh one on a clean host. A restore that brings back the
database without it produces an instance where every pre-existing API key
and share link resolves to nothing — a "successful" restore that silently
threw the credentials away. Because `backup.sh` never writes `.env` in
cleartext, it **refuses to run** without `BACKUP_PASSPHRASE`;
`--allow-unencrypted` overrides that consciously, backing up 1 + 2 only.

## Backup

```bash
BACKUP_PASSPHRASE=… ./scripts/backup.sh  # → /var/backups/slideless/{db,data}-<stamp>.* + config-<stamp>.tar.gz.enc
./scripts/backup.sh --allow-unencrypted  # db+data only — a conscious, credential-less backup
BACKUP_DIR=/mnt/backups BACKUP_PASSPHRASE=… ./scripts/backup.sh  # elsewhere
```

Dailies via cron:

```cron
BACKUP_PASSPHRASE=your-backup-passphrase
0 3 * * * /opt/slideless/scripts/backup.sh >> /var/log/slideless-backup.log 2>&1
```

Retention defaults to 30 days (`RETENTION_DAYS`). Ship the backup directory
off the machine (rsync, restic, object storage) — a backup on the same disk
is not a backup.

Every artifact is written under `umask 077` and chmod'd to 0600, and
`BACKUP_DIR` defaults **outside** the checkout: a config archive sitting in
the repo is one `git add -A` away from committing `AUTH_SECRET`.

### The config archive is only ever written encrypted

The config archive holds `.env` — `AUTH_SECRET`, `SETUP_TOKEN`,
`METRICS_TOKEN` — so `backup.sh` never writes it in cleartext. Set
`BACKUP_PASSPHRASE` and it writes `config-<stamp>.tar.gz.enc` (AES-256-CBC,
PBKDF2, 600k iterations; the passphrase is handed over on a file
descriptor, never in argv). Keep the passphrase somewhere that survives the
machine — a password manager or secret manager — because it **is** the
recovery path for `AUTH_SECRET`.

Without `BACKUP_PASSPHRASE` the run **refuses to start** — a backup that
cannot restore to a working instance should be a conscious choice, not a
cron default. `--allow-unencrypted` is that choice: the run then skips the
config archive (`.env` is never written in cleartext) and produces db+data
only. Restoring such a backup needs `--no-config`, and `AUTH_SECRET`
survives only if the server auto-generated it into `/data/secret` (the data
tarball carries that file). An `AUTH_SECRET` written into `.env` — what
`setup.sh` does — is **not** in it: such a backup protects your data, not
your credentials.

`restore.sh` accepts the encrypted form and, for backups made by older
versions of `backup.sh`, the legacy cleartext `config-<stamp>.tar.gz`.

### The generated pepper root never rides in the data tarball

On installs where the server generated its own auth secret into
`/data/secret`, that file **is** the pepper root — and the data tarball is
the one artifact that is not encrypted. With `BACKUP_PASSPHRASE` set,
`backup.sh` therefore leaves `/data/secret` **out** of `data-<stamp>.tar.gz`
and carries it inside the encrypted config archive instead (as
`data-secret`, beside `.env`). No backup artifact holds the root in
cleartext. `restore.sh` reads it back out of the archive and writes it into
the restored volume after the swap. With `--allow-unencrypted`, the tarball
keeps the old shape — the secret rides in it in cleartext — and the run says
so loudly; that is the conscious choice the flag exists for.

## Restore

```bash
ls /var/backups/slideless          # find the <STAMP>
./scripts/restore.sh <STAMP>      # prompts before replacing anything
```

The restore is staged, so a bad backup cannot take the instance down:

1. **Verify first.** The dump, the `/data` tarball and the config archive are
   all proven readable before anything is touched — including a content-level
   check of the dump (banner present, every `COPY` block terminated, the
   completion trailer present). `pg_dump | gzip` can wrap a perfectly valid
   gzip stream around a dump pg_dump never finished writing, so a gzip check
   alone is a trap. A truncated dump fails here, with the previous instance
   still serving traffic.
2. **Load into a scratch database** with `-v ON_ERROR_STOP=1` (without it
   psql replays a partial dump and still exits 0), then assert against it:
   every constraint validated, and every table's row count equal to the
   number of rows the dump actually carries.
3. **Swap.** `/data` is extracted beside the live tree and swapped, keeping
   the old tree until the end; the scratch database is renamed into place and
   the previous one is kept as `slideless_prev_<stamp>`.
4. **Put the pepper root back**, from whichever of its two homes the backup
   carries it in. Only pepper material moves: the live `POSTGRES_PASSWORD`
   belongs to the database container on this host, and overwriting it with the
   backup's would lock the app out of its own database.
5. **Verify live** on `/readyz`, which re-probes storage.

Any failure rolls the swaps back — the database, `/data` **and** the `.env`,
because the pepper and the database are one unit — and brings the previous
instance back up. Before renaming the databases back, the rollback quiesces
exactly as the forward swap did: it stops the app (the script itself started
it for the live verification) and terminates any remaining backends —
Postgres refuses to rename a database that is being accessed. If the rollback
itself cannot complete, the script does **not** pretend it did: it reports the
reason on stderr, exits non-zero and leaves the app **stopped**, because
starting it on half-rolled-back data would put the wrong database live under
the wrong pepper.

Flags: `--yes` skips the prompt (drills, automation); `--no-config` accepts
running without a pepper root, i.e. deliberately accepts losing
`AUTH_SECRET`.

### The pepper root has three homes

`AUTH_SECRET` is optional. Set it in `.env` (what `setup.sh` does) and that is
the pepper root. Leave it unset and the server generates one into
`$DATA_DIR/secret` on first boot and reuses it forever. **An env value always
beats the file**, and that asymmetry is what makes a naive restore silently
destructive: `setup.sh` writes a _fresh_ `AUTH_SECRET` on a clean host, so
restoring a data volume that carries the real secret leaves the new one
shadowing it. The instance boots, reports ready, and every share link and edit
secret 404s while every API key 401s.

`restore.sh` therefore works out where the pepper root is during the _verify_
phase, before anything is destroyed, and says so (`pepper root comes from:
config_env | data_volume | config_secret | none`):

| Where the backup carries it                                 | What restore.sh does                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET` in the archived `.env`                        | Merges it (plus `API_KEY_PEPPERS`) into the live `.env`.                                                |
| `$DATA_DIR/secret` inside the data tarball (older backups)  | **Removes** `AUTH_SECRET` from the live `.env`, so the restored file is what the server reads.          |
| `data-secret` inside the encrypted config archive (current) | Writes it to `/data/secret` after the volume swap, then removes `AUTH_SECRET` from the live `.env` too. |
| None of them                                                | Refuses the restore, unless you pass `--no-config`.                                                     |

If you would rather never depend on `/data` for this, set `AUTH_SECRET`
explicitly and keep it in a secret manager — see
[backup-and-data-sovereignty.md](../../internal/backup-and-data-sovereignty.md).

Drop the kept database once you have verified the instance:

```bash
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U slideless -d postgres \
  -c 'DROP DATABASE "slideless_prev_<stamp>";'
```

Rotating `AUTH_SECRET` afterwards is a separate, deliberate operation — see
the pepper-rotation runbook in [security.md](../security/security.md).

### Erasures hold across a restore

A GDPR erasure that lived only in the database would be undone by the next
restore from an older dump — the person's row back, their password working,
the audit entry saying they were erased rolled back with everything else.
Every completed account erasure therefore also appends a line to
`/data/erasures.jsonl` (the user id and a hash of the email, never the
address): an append-only tombstone that lives outside the dump. `restore.sh`
carries the live volume's tombstones forward into the restored tree, and the
server replays the file at every boot: a tombstoned user found present again
is deleted again, with a `user.erasure_replayed` audit row. Back the file up
like the rest of `/data`; never truncate it.

### A downgrade is refused, not reported as "current"

The migration status compares the **hashes** drizzle records for every
applied migration with the files the running image ships. A database that
was migrated by a newer image (a rollback to an older tag, `:next` behind
`:latest`) carries hashes this image does not know: the instance boots but
refuses readiness (`/readyz` 503, the reason in the log) instead of running
older code against a newer schema. Deploy the version that applied them.
The same verdict fires if a migration file was **edited after it ran** on
that database (a development-branch database that applied an earlier draft
of a file): there the remedy is to fix the recorded hash by hand in
`drizzle.__drizzle_migrations` (`UPDATE … SET hash = '<sha256 of the file>'`),
never to loosen the check.

## Disaster recovery drill

Quarterly, on a scratch machine:

```bash
git clone … slideless && cd slideless
./setup.sh                                   # fresh secrets, fresh volumes
cp /path/to/backups/{db,data,config}-<stamp>.* /var/backups/slideless/
./scripts/restore.sh <stamp> --yes
```

Then verify, and mean it:

- log in as a user that existed before the backup,
- **call the API with an API key minted before the backup** — this is the
  check that catches a lost `AUTH_SECRET`, and it is the one a naive restore
  fails while reporting success,
- open a share link created before the backup,
- download a file, and read the audit history.

Rehearse the failure too: truncate a copy of the dump
(`truncate -s 50% db-<stamp>.sql.gz`) and restore from it. It must refuse
before the app is stopped, and the instance must still be serving.

A restore that has never been rehearsed is a hope, not a plan.
