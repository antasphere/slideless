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

dr_info "archiving app data volume (/data: files, secret)"
docker compose run --rm --no-deps -v "$(cd "$BACKUP_DIR" && pwd)":/backup --entrypoint tar app \
  -czf "/backup/data-$STAMP.tar.gz" -C /data .
# tar ran inside the container under the image's umask, not ours.
chmod 600 "$BACKUP_DIR/data-$STAMP.tar.gz"

dr_info "archiving config"
CONFIG_ARTIFACT=""
if [ ! -f .env ]; then
  dr_warn "no .env found — config archive skipped. A restore will NOT recover AUTH_SECRET,"
  dr_warn "so every existing API key and share link would stop resolving."
elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  # The passphrase is handed over on file descriptor 3, never through argv
  # or the environment, so it cannot be read out of the process table.
  tar -czf - .env docker-compose.yml |
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
