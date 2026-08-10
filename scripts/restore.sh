#!/usr/bin/env bash
# Restore a backup made by backup.sh.
#
#   ./scripts/restore.sh <STAMP> [--yes] [--no-config]
#
# Shape of the restore, and why:
#
#   1. VERIFY everything first. Nothing destructive runs until the database
#      dump, the /data tarball and the config archive have all been proven
#      readable. A truncated dump therefore fails with the previous instance
#      still serving traffic.
#   2. Load the dump into a SCRATCH database with `-v ON_ERROR_STOP=1`, assert
#      row counts and constraint validity against it, and only then swap it in
#      by rename. psql without ON_ERROR_STOP replays a partial dump and still
#      exits 0; that is how you get a half-restored instance reported as a
#      success.
#   3. Put the PEPPER ROOT back, from whichever of its two homes the backup
#      carries it in: AUTH_SECRET in the archived .env, or $DATA_DIR/secret
#      inside the data volume (the server generates one there when
#      AUTH_SECRET is unset). It is the root for API keys, share-link hashes
#      and edit secrets, setup.sh generates a fresh one on a clean host, and
#      an env value SHADOWS the file — so a restore that gets this wrong
#      silently invalidates every credential while reporting success. Only
#      pepper material is copied: the live POSTGRES_PASSWORD stays.
#   4. On ANY failure, roll the swaps back and bring the previous instance
#      back up. If the rollback itself cannot complete, fail LOUDLY and leave
#      the app stopped: starting it on half-rolled-back data is the split
#      brain this script exists to prevent.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck source=lib/dr-lib.sh
. "$SCRIPT_DIR/lib/dr-lib.sh"

PRODUCT_SLUG="slideless"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/$PRODUCT_SLUG}"
# Postgres role/database — must match docker-compose.yml (instantiation.md).
DB_USER="${DB_USER:-slideless}"
DB_NAME="${DB_NAME:-slideless}"

STAMP=""
ASSUME_YES=0
REQUIRE_CONFIG=1
while [ $# -gt 0 ]; do
  case "$1" in
    -y | --yes) ASSUME_YES=1; shift ;;
    --no-config) REQUIRE_CONFIG=0; shift ;;
    -h | --help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    -*) dr_fail "unknown flag: $1" ;;
    *) STAMP="$1"; shift ;;
  esac
done
[ -n "$STAMP" ] || dr_fail "usage: restore.sh <STAMP> [--yes] [--no-config]  (see: ls $BACKUP_DIR)"

DB_DUMP="$BACKUP_DIR/db-$STAMP.sql.gz"
DATA_TAR="$BACKUP_DIR/data-$STAMP.tar.gz"
CONFIG_TAR="$BACKUP_DIR/config-$STAMP.tar.gz"
CONFIG_ENC="$CONFIG_TAR.enc"

# Postgres identifiers: the stamp carries a `-`, which is not legal unquoted.
SAFE_STAMP=$(printf '%s' "$STAMP" | tr -c 'a-zA-Z0-9' '_')
SCRATCH_DB="${DB_NAME}_restore_${SAFE_STAMP}"
PREV_DB="${DB_NAME}_prev_${SAFE_STAMP}"

STAGE="verify"
APP_STOPPED=0
DATA_SWAPPED=0
DB_SWAPPED=0
ENV_MERGED=0
WORKDIR=""
ENV_BACKUP=""

psql_admin() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U "$DB_USER" -d postgres "$@"; }
psql_scratch() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U "$DB_USER" -d "$SCRATCH_DB" "$@"; }

# Run a script inside a throwaway app container with the data volume and the
# backup directory mounted. --no-deps so it never resurrects the stopped app.
in_data_container() {
  docker compose run --rm --no-deps \
    -v "$(cd "$BACKUP_DIR" && pwd)":/backup --entrypoint sh app -c "$1"
}

on_exit() {
  local code=$?
  trap - EXIT
  set +e
  if [ "$code" -eq 0 ]; then
    [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
    exit 0
  fi

  dr_warn "restore FAILED during stage: $STAGE"
  # The .env goes back FIRST, and the cleanup of WORKDIR moved to the end of
  # this handler so the snapshot survives long enough to do it.
  #
  # Rolling the database back while leaving the BACKUP's AUTH_SECRET in .env
  # would recreate the exact defect this script exists to fix (OPS-1), only
  # pointed the other way: the pre-restore database would come back peppered
  # with the wrong secret, and every API key, share link and edit secret that
  # worked five minutes ago would stop resolving. The pepper and the database
  # are one unit; they roll back together.
  ROLLBACK_BROKEN=0
  if [ "$ENV_MERGED" = 1 ] && [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
    dr_warn "restoring the pre-restore .env (its pepper belongs to the database being rolled back)"
    cat "$ENV_BACKUP" > .env && chmod 600 .env || {
      ROLLBACK_BROKEN=1
      dr_warn "ROLLBACK INCOMPLETE: could not restore the pre-restore .env from $ENV_BACKUP"
    }
  fi
  if [ "$DB_SWAPPED" = 1 ]; then
    dr_warn "rolling the database swap back"
    # Postgres refuses to rename a database that has live backends, and for a
    # failure at start-app or verify-live the app THIS script started is
    # holding them (pg-boss keeps sessions open). Quiesce exactly as the
    # forward swap does — stop the app, then terminate whatever is left — and
    # let the rename errors through to stderr: swallowed, they once made this
    # handler report a rollback it had not performed, bringing the instance
    # back up on the RESTORED database under the pre-restore pepper
    # (PRDCT-1392).
    docker compose stop app
    psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname IN ('$DB_NAME', '$PREV_DB') AND pid <> pg_backend_pid();" > /dev/null
    if psql_admin -c "ALTER DATABASE \"$DB_NAME\" RENAME TO \"$SCRATCH_DB\";" > /dev/null &&
      psql_admin -c "ALTER DATABASE \"$PREV_DB\" RENAME TO \"$DB_NAME\";" > /dev/null; then
      dr_warn "database rolled back: \"$DB_NAME\" is the pre-restore database again"
    else
      ROLLBACK_BROKEN=1
      dr_warn "ROLLBACK INCOMPLETE: could not rename the databases back (psql error above)."
      dr_warn "\"$DB_NAME\" may still hold the RESTORED data; the pre-restore database is \"$PREV_DB\"."
    fi
  fi
  if [ "$DATA_SWAPPED" = 1 ]; then
    dr_warn "rolling the /data swap back"
    in_data_container '
      set -e
      [ -d /data/.restore-old ] || exit 0
      find /data -mindepth 1 -maxdepth 1 ! -name .restore-old -exec rm -rf {} \;
      find /data/.restore-old -mindepth 1 -maxdepth 1 -exec mv {} /data/ \;
      rmdir /data/.restore-old
    ' > /dev/null || {
      ROLLBACK_BROKEN=1
      dr_warn "ROLLBACK INCOMPLETE: could not roll /data back; the pre-restore tree is kept in /data/.restore-old"
    }
  fi
  if [ "$ROLLBACK_BROKEN" = 1 ]; then
    # Do NOT drop the scratch database and do NOT start the app: with the
    # rollback half-done, either would turn a recoverable state into the
    # exact split brain this handler exists to prevent. Leave everything for
    # the operator, loudly.
    dr_warn "the rollback could NOT complete — the app was left STOPPED rather than started on the wrong data."
    dr_warn "Inspect with: docker compose exec -T db psql -v ON_ERROR_STOP=1 -U $DB_USER -d postgres -c '\\l'"
    dr_warn "Finish the rollback by hand (rename \"$PREV_DB\" back to \"$DB_NAME\"), then start the app: docker compose up -d app"
    [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
    exit "$code"
  fi
  psql_admin -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" > /dev/null
  if [ "$APP_STOPPED" = 1 ]; then
    dr_warn "bringing the previous instance back up"
    docker compose up -d app ||
      dr_warn "could not restart the app automatically — run: docker compose up -d app"
  else
    dr_warn "nothing was changed; the running instance is untouched"
  fi
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
  exit "$code"
}
trap on_exit EXIT

# ── 1. verify every archive BEFORE touching anything ────────────────────────

dr_info "verifying archives for $STAMP"
COUNTS=$(dr_verify_pg_dump "$DB_DUMP")
dr_verify_tar "$DATA_TAR"

WORKDIR=$(mktemp -d)
if [ -f "$CONFIG_ENC" ]; then
  [ -n "${BACKUP_PASSPHRASE:-}" ] || dr_fail "$CONFIG_ENC is encrypted — set BACKUP_PASSPHRASE"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass fd:3 -in "$CONFIG_ENC" 3<<< "$BACKUP_PASSPHRASE" |
    tar -xzf - -C "$WORKDIR" || dr_fail "cannot decrypt/extract $CONFIG_ENC (wrong BACKUP_PASSPHRASE?)"
elif [ -f "$CONFIG_TAR" ]; then
  dr_verify_tar "$CONFIG_TAR"
  tar -xzf "$CONFIG_TAR" -C "$WORKDIR"
elif [ "$REQUIRE_CONFIG" = 1 ]; then
  dr_fail "no config archive for $STAMP. Without it AUTH_SECRET is lost and every existing
  API key, share link and edit secret stops resolving. Pass --no-config to accept that."
fi
[ "$REQUIRE_CONFIG" = 0 ] || [ -f "$WORKDIR/.env" ] ||
  dr_fail "the config archive for $STAMP holds no .env — pass --no-config to accept losing AUTH_SECRET"

# ── pepper-root provenance — decided BEFORE anything is destroyed ────────────
#
# AUTH_SECRET is OPTIONAL (apps/server/src/env.ts). Unset, the server generates
# one into $DATA_DIR/secret and reuses it forever (apps/server/src/secret.ts),
# so the pepper root lives in one of TWO places and the restore has to put it
# back differently depending on which:
#
#   archived .env carries AUTH_SECRET → merge it into the live .env.
#   only the data volume carries it   → the live .env must not SHADOW the
#                                       restored file, so AUTH_SECRET is
#                                       removed from it.
#
# Getting this wrong is silent, and it is the DEFAULT path that gets it wrong:
# setup.sh writes a fresh AUTH_SECRET into .env on a clean host, and an env
# value always beats the file. Restoring a data volume that carries the real
# secret while .env holds a brand-new one yields an instance that boots,
# reports ready, and resolves none of its API keys, share links or edit
# secrets — with the restore reported as a success. The repo's own design note
# calls this out (internal/backup-and-data-sovereignty.md, "The AUTH_SECRET trap").
ARCHIVED_AUTH_SECRET=""
[ -f "$WORKDIR/.env" ] && ARCHIVED_AUTH_SECRET=$(dr_env_get "$WORKDIR/.env" AUTH_SECRET)
PEPPER_SOURCE=none
if [ -n "$ARCHIVED_AUTH_SECRET" ]; then
  PEPPER_SOURCE=config_env
elif dr_tar_has_entry "$DATA_TAR" secret; then
  PEPPER_SOURCE=data_volume
fi
if [ "$PEPPER_SOURCE" = none ] && [ "$REQUIRE_CONFIG" = 1 ]; then
  dr_fail "backup $STAMP carries no pepper root: no AUTH_SECRET in the archived .env and no
  'secret' entry in data-$STAMP.tar.gz. Restoring it would produce an instance whose every
  API key, share link and edit secret silently stops resolving. Pass --no-config to accept that."
fi
dr_info "pepper root comes from: $PEPPER_SOURCE"
dr_success "archives verified"

if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "This REPLACES the current database and files with backup $STAMP. Type 'restore' to continue: " ok
  [ "$ok" = "restore" ] || { echo "aborted"; exit 1; }
fi

# ── 2. load into a scratch database and assert it ───────────────────────────

STAGE="load-scratch"
dr_info "loading the dump into scratch database $SCRATCH_DB"
psql_admin -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE);" > /dev/null
psql_admin -c "CREATE DATABASE \"$SCRATCH_DB\" OWNER \"$DB_USER\";" > /dev/null
gunzip -c "$DB_DUMP" | psql_scratch > /dev/null

STAGE="assert-scratch"
dr_info "asserting the restored data"
tables=$(psql_scratch -At -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')")
[ "${tables:-0}" -gt 0 ] || dr_fail "the restored database has no tables"

invalid=$(psql_scratch -At -c "SELECT count(*) FROM pg_constraint WHERE NOT convalidated")
[ "${invalid:-1}" = "0" ] || dr_fail "$invalid constraint(s) came back NOT VALID — the dump did not replay cleanly"

# Expected row counts come from the dump's own COPY blocks, so this works on
# any backup (no manifest needed) and catches a partial replay exactly.
rowsql=""
ntables=0
while IFS=$'\t' read -r tbl want; do
  [ -n "$tbl" ] || continue
  # The identifier comes from pg_dump's own COPY header. Pin it to the shape
  # pg_dump emits so it can never carry a smuggled statement into the query
  # built below.
  case "$tbl" in
    *[!A-Za-z0-9_.\"]*) dr_fail "unexpected table identifier in dump: $tbl" ;;
  esac
  if [ -n "$rowsql" ]; then rowsql="$rowsql UNION ALL "; fi
  rowsql="${rowsql}SELECT '$tbl' AS tbl, ${want}::bigint AS want, (SELECT count(*) FROM $tbl) AS got"
  ntables=$((ntables + 1))
done <<< "$COUNTS"

if [ -n "$rowsql" ]; then
  mismatch=$(psql_scratch -At -c \
    "SELECT tbl || ': expected ' || want || ', got ' || got FROM ($rowsql) q WHERE want <> got")
  [ -z "$mismatch" ] || dr_fail "row counts do not match the dump: $mismatch"
  dr_success "row counts match the dump across $ntables table(s)"
else
  dr_warn "the dump contains no COPY data — restoring an empty database"
fi

# ── 3. destructive phase ────────────────────────────────────────────────────

STAGE="stop-app"
dr_info "stopping app (db stays up)"
docker compose stop app
APP_STOPPED=1

STAGE="swap-data"
dr_info "restoring the data volume"
# Extract beside the live tree and swap, so a tar that dies half-way never
# leaves /data empty. The previous tree stays in .restore-old for rollback.
in_data_container "
  set -e
  rm -rf /data/.restore-new /data/.restore-old
  mkdir -p /data/.restore-new /data/.restore-old
  tar -xzf /backup/data-$STAMP.tar.gz -C /data/.restore-new
  find /data -mindepth 1 -maxdepth 1 ! -name .restore-new ! -name .restore-old -exec mv {} /data/.restore-old/ \;
  find /data/.restore-new -mindepth 1 -maxdepth 1 -exec mv {} /data/ \;
  rmdir /data/.restore-new
"
DATA_SWAPPED=1

STAGE="swap-db"
dr_info "swapping $SCRATCH_DB into place"
psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname IN ('$DB_NAME', '$SCRATCH_DB') AND pid <> pg_backend_pid();" > /dev/null
psql_admin -c "ALTER DATABASE \"$DB_NAME\" RENAME TO \"$PREV_DB\";" > /dev/null
DB_SWAPPED=1
psql_admin -c "ALTER DATABASE \"$SCRATCH_DB\" RENAME TO \"$DB_NAME\";" > /dev/null

STAGE="merge-secrets"
if [ "$PEPPER_SOURCE" != none ] || [ -f "$WORKDIR/.env" ]; then
  [ -f .env ] || dr_fail "no live .env — run ./setup.sh before restoring"
  # Snapshot before touching it, so on_exit can put the pre-restore pepper back
  # alongside the pre-restore database. Inside WORKDIR (mode 700, umask 077):
  # this file is a copy of every secret the instance holds.
  ENV_BACKUP="$WORKDIR/.env.pre-restore"
  cat .env > "$ENV_BACKUP"
  chmod 600 "$ENV_BACKUP"
  ENV_MERGED=1
fi

if [ -f "$WORKDIR/.env" ]; then
  dr_info "merging pepper material back into .env (POSTGRES_PASSWORD stays live)"
  merged=$(dr_merge_pepper_env "$WORKDIR/.env" .env | tr '\n' ' ')
  if [ -n "$merged" ]; then
    dr_success "restored from the config archive: $merged"
  else
    dr_info ".env already carries the backup's pepper material — nothing to merge"
  fi
fi

case "$PEPPER_SOURCE" in
  data_volume)
    # The restored /data/secret IS the pepper root. A fresh AUTH_SECRET in the
    # live .env would shadow it (env beats file) and every existing credential
    # would stop resolving — the failure this whole script exists to prevent.
    if [ -n "$(dr_env_get .env AUTH_SECRET)" ]; then
      dr_env_unset .env AUTH_SECRET
      dr_success "removed AUTH_SECRET from .env — the restored data volume carries the pepper root"
    else
      dr_info "AUTH_SECRET is unset in .env, so the restored /data/secret is the pepper root"
    fi
    ;;
  none)
    dr_warn "no pepper root in this backup (--no-config). AUTH_SECRET was NOT restored:"
    dr_warn "pre-existing API keys, share links and edit secrets will not resolve."
    ;;
esac

STAGE="start-app"
dr_info "starting app"
docker compose up -d --wait --wait-timeout 180 app

STAGE="verify-live"
# /readyz, not /healthz: readiness re-probes storage, so a restore that left
# the data volume unwritable is caught here instead of after the drill.
APP_PORT=$(dr_env_get .env APP_PORT)
APP_PORT="${APP_PORT:-3000}"
APP_BIND=$(dr_env_get .env APP_BIND)
case "${APP_BIND:-127.0.0.1}" in
  '' | 0.0.0.0 | '::' | localhost) PROBE_HOST=127.0.0.1 ;;
  *) PROBE_HOST="$APP_BIND" ;;
esac
ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://${PROBE_HOST}:${APP_PORT}/readyz" > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = 1 ] || dr_fail "the restored instance never reported ready on /readyz"

STAGE="done"
in_data_container 'rm -rf /data/.restore-old' > /dev/null
dr_success "restore complete"
echo "  The pre-restore database is kept as \"$PREV_DB\"."
echo "  Drop it once you have verified the instance:"
echo "    docker compose exec -T db psql -v ON_ERROR_STOP=1 -U $DB_USER -d postgres -c 'DROP DATABASE \"$PREV_DB\";'"
