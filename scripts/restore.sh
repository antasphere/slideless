#!/usr/bin/env bash
# Restore a backup made by backup.sh. DESTRUCTIVE: replaces the database and
# the data volume. Usage: ./scripts/restore.sh <STAMP>  (e.g. 20260703-030000)
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP="${1:?usage: restore.sh <STAMP> (see ls backups/)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB_DUMP="$BACKUP_DIR/db-$STAMP.sql.gz"
DATA_TAR="$BACKUP_DIR/data-$STAMP.tar.gz"

[ -f "$DB_DUMP" ] || { echo "✖ missing $DB_DUMP" >&2; exit 1; }
[ -f "$DATA_TAR" ] || { echo "✖ missing $DATA_TAR" >&2; exit 1; }

read -r -p "This REPLACES the current database and files with backup $STAMP. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "aborted"; exit 1; }

echo "▸ stopping app (db stays up)"
docker compose stop app

echo "▸ restoring database"
gunzip -c "$DB_DUMP" | docker compose exec -T db psql -q -U slideless -d postgres \
  -c "DROP DATABASE IF EXISTS slideless WITH (FORCE);" -c "CREATE DATABASE slideless OWNER slideless;" >/dev/null
gunzip -c "$DB_DUMP" | docker compose exec -T db psql -q -U slideless -d slideless >/dev/null

echo "▸ restoring data volume"
docker compose run --rm --no-deps -v "$(cd "$BACKUP_DIR" && pwd)":/backup --entrypoint sh app \
  -c "rm -rf /data/* && tar -xzf /backup/data-$STAMP.tar.gz -C /data"

echo "▸ starting app"
docker compose up -d --wait app

echo "✔ restore complete"
