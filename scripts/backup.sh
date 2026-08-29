#!/usr/bin/env bash
# Backup: Postgres dump + the app data volume (uploaded files, generated
# secret) + the local config, encrypted (BACKUP_PASSPHRASE is REQUIRED —
# a backup without the encrypted .env cannot restore to a working instance;
# pass --allow-unencrypted to consciously take a db+data-only backup).
# Run from cron for dailies:
#   BACKUP_PASSPHRASE=…
#   0 3 * * * /opt/slideless/scripts/backup.sh >> /var/log/slideless-backup.log 2>&1
set -euo pipefail
# Every artifact below holds production data, and the config archive holds
# AUTH_SECRET. 0600/0700 from the moment of creation, never a window at 0644.
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck source=lib/dr-lib.sh
. "$SCRIPT_DIR/lib/dr-lib.sh"

# Product slug: drives the default backup dir. Instantiation edits this one
# line (keep it in sync with PRODUCT.slug in packages/contract/src/product.ts).
PRODUCT_SLUG="slideless"
# Default OUTSIDE the checkout: `./backups` inside a git repo is one `git add
# -A` away from committing AUTH_SECRET, and one `git clean -xdf` away from
# deleting every backup.
BACKUP_DIR="${BACKUP_DIR:-/var/backups/$PRODUCT_SLUG}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
# Postgres role/database — must match docker-compose.yml (instantiation.md).
DB_USER="${DB_USER:-slideless}"
DB_NAME="${DB_NAME:-slideless}"
STAMP=$(date -u +%Y%m%d-%H%M%S)

ALLOW_UNENCRYPTED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-unencrypted) ALLOW_UNENCRYPTED=1; shift ;;
    *) dr_fail "unknown flag: $1  (usage: backup.sh [--allow-unencrypted])" ;;
  esac
done

# Fail LOUD, and before anything is written: a passphrase-less backup holds
# no .env, so unless the pepper root happens to live in /data/secret it
# cannot restore to a working instance — every API key and share link would
# stop resolving. That must be a conscious choice, not a cron default.
if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ "$ALLOW_UNENCRYPTED" != 1 ]; then
  dr_warn "BACKUP_PASSPHRASE is unset. Without it the config archive (.env — AUTH_SECRET,"
  dr_warn "the pepper root) cannot be written, and a restore from this backup would resolve"
  dr_warn "none of the existing API keys, share links or edit secrets."
  dr_fail "set BACKUP_PASSPHRASE, or pass --allow-unencrypted to take a db+data-only backup"
fi

mkdir -p "$BACKUP_DIR" ||
  dr_fail "cannot create $BACKUP_DIR — run as root or set BACKUP_DIR to a writable path"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

dr_info "dumping database"
docker compose exec -T db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"
chmod 600 "$BACKUP_DIR/db-$STAMP.sql.gz"

# Scratch dir for the pepper root on its way into the ENCRYPTED archive
# (mode 700 under umask 077; removed on exit, success or failure).
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  # PRDCT-1440: on generated-secret installs the pepper root lives in
  # /data/secret. It must not ride in the data tarball (the one artifact that
  # is NOT encrypted — the off-site copy the runbook asks for would carry it
  # in cleartext), so the tarball EXCLUDES it and the encrypted config
  # archive below carries it instead. restore.sh knows this third home.
  # PRDCT-1811: the first-boot claim token (/data/setup-token, PRDCT-1347) is
  # excluded from EVERY data tarball — an unclaimed instance's backup must not
  # hand the claim to whoever holds the artifact; the server mints a fresh
  # one on the next unclaimed boot.
  dr_info "archiving app data volume (/data: files; the pepper root goes into the encrypted config archive)"
  docker compose run --rm --no-deps -v "$(cd "$BACKUP_DIR" && pwd)":/backup --entrypoint tar app \
    -czf "/backup/data-$STAMP.tar.gz" --exclude=./secret --exclude=./setup-token -C /data .
  # The file is read out through stdout into a 0600 scratch file — never
  # through argv or the environment. -T: no pseudo-TTY even when an operator
  # runs this interactively — a TTY would turn the bytes into CRLF/progress
  # noise and corrupt the root.
  docker compose run --rm --no-deps -T --entrypoint sh app -c 'cat /data/secret 2>/dev/null || true' \
    > "$WORKDIR/data-secret"
  chmod 600 "$WORKDIR/data-secret"
  [ -s "$WORKDIR/data-secret" ] || rm -f "$WORKDIR/data-secret"
else
  dr_info "archiving app data volume (/data: files, secret)"
  docker compose run --rm --no-deps -v "$(cd "$BACKUP_DIR" && pwd)":/backup --entrypoint tar app \
    -czf "/backup/data-$STAMP.tar.gz" --exclude=./setup-token -C /data .
fi
# tar ran inside the container under the image's umask, not ours.
chmod 600 "$BACKUP_DIR/data-$STAMP.tar.gz"

dr_info "archiving config"
CONFIG_ARTIFACT=""
if [ ! -f .env ] && [ ! -f "$WORKDIR/data-secret" ]; then
  dr_warn "no .env found — config archive skipped. A restore will NOT recover AUTH_SECRET,"
  dr_warn "so every existing API key and share link would stop resolving."
elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  # No .env but a generated pepper root: the archive carries just the root.
  CONFIG_FILES=()
  [ -f .env ] && CONFIG_FILES+=(.env)
  [ -f docker-compose.yml ] && CONFIG_FILES+=(docker-compose.yml)
  # The passphrase is handed over on file descriptor 3, never through argv
  # or the environment, so it cannot be read out of the process table.
  # `data-secret` (the pepper root pulled out of /data, PRDCT-1440) rides
  # here, encrypted, when the install generated its secret; absent when
  # AUTH_SECRET lives in .env instead.
  CONFIG_EXTRA=()
  if [ -f "$WORKDIR/data-secret" ]; then
    CONFIG_EXTRA=(-C "$WORKDIR" data-secret)
    dr_info "the pepper root (/data/secret) is carried in the encrypted config archive"
  fi
  # `${arr[@]+"${arr[@]}"}`: an empty array under `set -u` is an unbound
  # variable on bash 3.2 (macOS), where the unit suite drives this script.
  tar -czf - ${CONFIG_FILES[@]+"${CONFIG_FILES[@]}"} ${CONFIG_EXTRA[@]+"${CONFIG_EXTRA[@]}"} |
    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass fd:3 \
      -out "$BACKUP_DIR/config-$STAMP.tar.gz.enc" 3<<< "$BACKUP_PASSPHRASE"
  chmod 600 "$BACKUP_DIR/config-$STAMP.tar.gz.enc"
  CONFIG_ARTIFACT="config-$STAMP.tar.gz.enc"
else
  # Reachable only via --allow-unencrypted (the up-front gate refuses
  # otherwise). .env holds AUTH_SECRET, POSTGRES_PASSWORD, SETUP_TOKEN and
  # METRICS_TOKEN, and backup artifacts are what gets shipped OFF this
  # machine — so it is never written into a backup in cleartext, not even
  # at mode 0600.
  dr_warn "--allow-unencrypted: config archive SKIPPED — .env is never backed up in cleartext."
  dr_warn "--allow-unencrypted: a server-generated pepper root (/data/secret) rides INSIDE data-$STAMP.tar.gz"
  dr_warn "in CLEARTEXT — anyone holding this tarball can forge every API key and share link."
  dr_warn "This backup carries no .env: restoring it needs --no-config, and AUTH_SECRET survives only"
  dr_warn "if the server auto-generated it into /data/secret. An AUTH_SECRET set in .env (what"
  dr_warn "setup.sh writes) is NOT in this backup. Set BACKUP_PASSPHRASE to get the encrypted"
  dr_warn "config archive — see docs/operations/backup-restore.md."
fi

dr_info "verifying the archives just written"
dr_verify_pg_dump "$BACKUP_DIR/db-$STAMP.sql.gz" > /dev/null
dr_verify_tar "$BACKUP_DIR/data-$STAMP.tar.gz"

dr_info "pruning backups older than ${RETENTION_DAYS}d"
find "$BACKUP_DIR" \( -name '*.gz' -o -name '*.gz.enc' \) -mtime "+$RETENTION_DAYS" -delete

if [ -n "$CONFIG_ARTIFACT" ]; then
  dr_success "backup complete: $BACKUP_DIR/{db-$STAMP.sql.gz,data-$STAMP.tar.gz,$CONFIG_ARTIFACT}"
else
  dr_success "backup complete: $BACKUP_DIR/{db,data}-$STAMP.* (no config archive — see warnings above)"
fi
