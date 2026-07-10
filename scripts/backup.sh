#!/usr/bin/env bash
# Backup: Postgres dump + the app data volume (uploaded files, generated
# secret) + the local config. Run from cron for dailies:
#   0 3 * * * /opt/slideless/scripts/backup.sh >> /var/log/slideless-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

echo "▸ dumping database"
docker compose exec -T db pg_dump -U slideless slideless | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"
[ -s "$BACKUP_DIR/db-$STAMP.sql.gz" ] || { echo "✖ empty dump" >&2; exit 1; }

echo "▸ archiving app data volume (/data: files, secret)"
docker compose run --rm --no-deps -v "$(cd "$BACKUP_DIR" && pwd)":/backup --entrypoint tar app \
  -czf "/backup/data-$STAMP.tar.gz" -C /data .

echo "▸ archiving config"
tar -czf "$BACKUP_DIR/config-$STAMP.tar.gz" .env docker-compose.yml 2>/dev/null

echo "▸ pruning backups older than ${RETENTION_DAYS}d"
find "$BACKUP_DIR" -name '*.gz' -mtime "+$RETENTION_DAYS" -delete

echo "✔ backup complete: $BACKUP_DIR/{db,data,config}-$STAMP.*"
