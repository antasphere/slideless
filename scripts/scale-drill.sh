#!/usr/bin/env bash
# Multi-replica scale drill (the Profile B rehearsal) — docs/scaling.md.
#
# Proves, against a real multi-replica stack (docker-compose.scale.yml under
# the isolated `scale-drill` compose project), every horizontal-scaling claim
# the docs make:
#
#   1. Migration concurrency — N replicas racing a fresh DB: exactly ONE
#      applies DDL (session-scoped pg_advisory_lock), the rest provably queue
#      on the lock (pg_locks) and apply nothing (Postgres log_statement=ddl);
#      pg-boss's install DDL is serialized under its own advisory lock
#      (7432004, jobs/pgboss.ts), so every replica boots exactly once with a
#      deadlock-free Postgres log.
#   2. Sessions + API keys minted on one replica authenticate on another
#      (Postgres session store + shared AUTH_SECRET); a local-storage blob
#      held by another replica answers a clean 404, never a truncated 200.
#   3. Rate limits: with REDIS_URL a bucket exhausted through replica A also
#      429s on replica B (shared); without it replica B accepts (per-process
#      memory) — the contrast that proves Redis is doing the work.
#   4. SERVICE_ROLE split — a job enqueued via api replicas is executed by
#      the worker only; with the worker stopped, api replicas run neither the
#      job nor the pg-boss scheduler (frozen pgboss.version.cron_on heartbeat).
#
# Cross-replica assertions hit each replica's own published port directly, so
# "minted on A, verified on B" is deterministic (no LB guessing).
#
# Usage: ./scripts/scale-drill.sh
#   DRILL_IMAGE=name:tag   image tag to build/use (default slideless:scale)
#   DRILL_SKIP_BUILD=1     reuse the image if it already exists (CI pre-builds it)
#   DRILL_KEEP_IMAGE=1     keep the image after the run (faster local iteration)
#
# Everything is throwaway: generated secrets in a mktemp scratch dir, tmpfs
# volumes, `down -v` + image removal on exit — pass or fail.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$REPO/docker-compose.scale.yml"
PROJECT=scale-drill
IMAGE="${DRILL_IMAGE:-slideless:scale}"
MIGRATION_LOCK_KEY=7432001 # packages/db/src/migrate.ts
PASS_COUNT=0

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '    · %s\n' "$*"; }
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$*"
}
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  exit 1
}

for bin in docker jq curl openssl; do
  command -v "$bin" >/dev/null || fail "required tool missing: $bin"
done

for port in 3801 3802 3803 3811 3812 3813; do
  if curl -s -o /dev/null --max-time 1 "http://localhost:$port/" 2>/dev/null; then
    fail "port $port already answers — refusing to run (the drill needs 3801-3803 and 3811-3813)"
  fi
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/scale-drill.XXXXXX")"
JAR="$SCRATCH/cookies.txt"

# Throwaway secrets — never a committed .env.
PG_PASSWORD="$(openssl rand -hex 16)"
AUTH_SECRET="$(openssl rand -hex 32)"

write_envfile() { # path REDIS_URL PUBLIC_BASE_URL
  {
    echo "DRILL_IMAGE=$IMAGE"
    echo "DRILL_PG_PASSWORD=$PG_PASSWORD"
    echo "DRILL_AUTH_SECRET=$AUTH_SECRET"
    echo "DRILL_REDIS_URL=$2"
    echo "DRILL_PUBLIC_BASE_URL=$3"
  } > "$1"
}
write_envfile "$SCRATCH/env.flat" 'redis://redis:6379' 'http://localhost:3801'
write_envfile "$SCRATCH/env.mem" '' 'http://localhost:3801'
write_envfile "$SCRATCH/env.split" 'redis://redis:6379' 'http://localhost:3811'
ENVFILE="$SCRATCH/env.flat"

# Both profiles are always enabled so every dc verb (up/stop/logs/down) sees
# every service; which topology runs is decided by naming services on `up`.
dc() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENVFILE" \
    --profile flat --profile split "$@"
}

psqlq() { dc exec -T db psql -U slideless -d slideless -v ON_ERROR_STOP=1 -tAc "$1"; }

applogs() { dc logs --no-log-prefix "$1" 2>/dev/null || true; }

# First pino log line for a service with this exact msg -> its epoch-ms time.
logtime() { applogs "$1" | jq -Rr --arg m "$2" 'fromjson? | select(.msg == $m) | .time' | head -1; }
logcount() { applogs "$1" | jq -Rr --arg m "$2" 'fromjson? | select(.msg == $m) | .time' | wc -l | tr -d ' '; }

wait_ready() { # service port timeout_s
  local i=0
  until curl -fsS -o /dev/null "http://localhost:$2/readyz" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge "$3" ] && {
      applogs "$1" | tail -20 >&2
      fail "$1 (:$2) not ready after $3 s"
    }
    sleep 1
  done
  return 0
}

# Evidence survives teardown: on failure, dump the tail of every service log.
dump_logs() {
  for svc in db redis app1 app2 app3 api1 api2 worker; do
    echo "── logs: $svc ──────────────────────────────────────────────" >&2
    applogs "$svc" | tail -40 >&2
  done
}

CLEANED=0
cleanup() {
  local status=$?
  [ "$CLEANED" = 1 ] && exit "$status"
  CLEANED=1
  [ "$status" != 0 ] && dump_logs
  say "Teardown"
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "${DRILL_KEEP_IMAGE:-}" != "1" ]; then
    docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
  local leftovers
  leftovers=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')
  local volumes
  volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')
  if [ "$leftovers" = 0 ] && [ "$volumes" = 0 ]; then
    echo "  teardown clean: no scale-drill containers or volumes remain"
  else
    echo "  WARNING: $leftovers container(s) / $volumes volume(s) with project=$PROJECT remain" >&2
    status=1
  fi
  if [ "$status" = 0 ]; then
    printf '\n\033[32m✔ scale drill passed — %s assertions\033[0m\n' "$PASS_COUNT"
  else
    printf '\n\033[31m✘ scale drill FAILED (after %s passing assertions)\033[0m\n' "$PASS_COUNT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

# ── Phase 0 — one image for every replica ───────────────────────────────────
say "Phase 0 — build the drill image ($IMAGE)"
if [ "${DRILL_SKIP_BUILD:-}" = "1" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  note "DRILL_SKIP_BUILD=1 and image exists — reusing"
else
  docker build -t "$IMAGE" "$REPO"
fi

# ── Phase 1 — migration concurrency (flat topology, fresh DB) ───────────────
say "Phase 1 — advisory-lock migrations: 3 replicas race a fresh DB"
dc up -d --wait db redis

# Determinism gate: hold the migration lock from a psql session BEFORE any
# replica boots, so all three replicas provably contend at the same instant
# (no reliance on container start jitter).
dc exec -T -d db psql -U slideless -d slideless \
  -c "SELECT pg_advisory_lock($MIGRATION_LOCK_KEY), pg_sleep(600)"
held=""
for _ in $(seq 1 30); do
  held=$(psqlq "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$MIGRATION_LOCK_KEY AND granted")
  [ "$held" = "1" ] && break
  sleep 1
done
[ "$held" = "1" ] || fail "gate session never acquired the migration advisory lock"

dc up -d app1 app2 app3

waiting=0
for _ in $(seq 1 120); do
  waiting=$(psqlq "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$MIGRATION_LOCK_KEY AND NOT granted")
  [ "$waiting" = "3" ] && break
  sleep 1
done
[ "$waiting" = "3" ] || fail "expected 3 replicas queued on the migration lock, saw $waiting"
pass "pg_locks shows all 3 replicas simultaneously blocked on advisory key $MIGRATION_LOCK_KEY"

# Release the gate (terminating the backend releases its session lock).
psqlq "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$MIGRATION_LOCK_KEY AND granted" >/dev/null

wait_ready app1 3801 120
wait_ready app2 3802 120
wait_ready app3 3803 120
pass "all 3 replicas reached /readyz 200"

# A crash DURING migration application would leave an 'advisory lock
# acquired' without its matching 'migrations up to date' in that boot. A
# restart AFTER migrations was the pg-boss create_queue deadlock this drill
# originally surfaced; pg-boss's install DDL now runs under its own advisory
# lock (7432004, jobs/pgboss.ts), so a fresh-DB concurrent boot must come up
# clean on the FIRST attempt — any restart is a hard failure.
for svc in app1 app2 app3; do
  acq=$(logcount "$svc" 'advisory lock acquired, applying pending migrations')
  fin=$(logcount "$svc" 'migrations up to date')
  [ "$acq" = "$fin" ] || fail "$svc acquired the migration lock $acq times but completed $fin — a run crashed mid-application"
  boots=$(logcount "$svc" 'booting')
  if [ "$boots" != "1" ]; then
    applogs "$svc" | grep -m1 -i 'error' | cut -c1-200 | sed 's/^/      /' >&2 || true
    fail "$svc booted $boots times — a fresh-DB concurrent boot must not crash-loop (pg-boss install race regressed?)"
  fi
  pbinstall=$(logcount "$svc" 'advisory lock acquired, installing pg-boss schema and queues')
  [ "$pbinstall" = "1" ] || fail "$svc ran the pg-boss install-lock section $pbinstall times, expected exactly 1"
done
pass "every replica booted exactly ONCE and every lock acquisition ran to completion (migration + pg-boss install both serialized)"

deadlocks=$(dc logs --no-log-prefix db 2>/dev/null | grep -ci 'deadlock detected' || true)
[ "$deadlocks" = "0" ] || fail "Postgres log records $deadlocks deadlock(s) during the concurrent fresh-DB boot"
pass "Postgres log clean: zero deadlocks across the 3-replica fresh boot (pg-boss create_queue serialized)"

# Serialization: [acquired, done] intervals must not overlap across replicas.
serial=""
for svc in app1 app2 app3; do
  a=$(logtime "$svc" 'advisory lock acquired, applying pending migrations')
  d=$(logtime "$svc" 'migrations up to date')
  [ -n "$a" ] && [ -n "$d" ] || fail "$svc missing migration log lines"
  serial="$serial$a $d $svc"$'\n'
done
prev_done=0
order=""
while read -r a d svc; do
  [ -z "$svc" ] && continue
  [ "$a" -ge "$prev_done" ] || fail "lock intervals overlap: $svc acquired at $a before previous holder released at $prev_done"
  prev_done=$d
  order="$order $svc"
done <<EOF
$(printf '%s' "$serial" | sort -n)
EOF
pass "lock hold intervals are strictly serialized (order:$order)"

on_disk=$(ls "$REPO"/packages/db/drizzle/*.sql | wc -l | tr -d ' ')
applied=$(psqlq "SELECT count(*) FROM drizzle.__drizzle_migrations")
dupes=$(psqlq "SELECT count(*) - count(DISTINCT hash) FROM drizzle.__drizzle_migrations")
[ "$applied" = "$on_disk" ] || fail "migration journal has $applied rows, expected $on_disk (one per .sql file)"
[ "$dupes" = "0" ] || fail "duplicate migration hashes in the journal: a second replica re-applied"
pass "drizzle journal: $applied/$on_disk applied, 0 duplicates"

ddl_count=$(dc logs --no-log-prefix db 2>/dev/null | grep -c 'CREATE TABLE "workspaces"' || true)
[ "$ddl_count" = "1" ] || fail "Postgres DDL log shows the schema created $ddl_count times, expected exactly 1"
pass "Postgres log_statement=ddl: exactly ONE session executed the schema DDL"

for svc in app1 app2 app3; do
  r=$(logcount "$svc" 'rate limiting backed by redis')
  [ "$r" = "1" ] || fail "$svc did not report the redis rate-limit backend (REDIS_URL not wired?)"
done
pass "all replicas report 'rate limiting backed by redis' (REDIS_URL wired)"

# ── Phase 2 — sessions + API keys across replicas ────────────────────────────
say "Phase 2 — a session/API key minted on app1 authenticates on app2/app3"

code=$(curl -s -o "$SCRATCH/setup.json" -w '%{http_code}' -X POST http://localhost:3801/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"instanceName":"Scale Drill","owner":{"email":"owner@drill.test","name":"Drill Owner","password":"drill-password-123456"}}')
[ "$code" = "201" ] || fail "setup on app1 answered $code"

code=$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -X POST http://localhost:3801/api/v1/auth/sign-in/email \
  -H 'content-type: application/json' \
  -d '{"email":"owner@drill.test","password":"drill-password-123456"}')
[ "$code" = "200" ] || fail "sign-in on app1 answered $code"

for port in 3802 3803; do
  code=$(curl -s -b "$JAR" -o "$SCRATCH/me.json" -w '%{http_code}' "http://localhost:$port/api/v1/me")
  [ "$code" = "200" ] || fail "session cookie minted on app1 rejected by :$port ($code)"
  jq -e '.via == "session"' "$SCRATCH/me.json" >/dev/null || fail ":$port did not resolve the principal via session"
done
pass "session cookie minted on app1 authenticates on app2 AND app3 (via=session)"

KEY=$(curl -s -b "$JAR" -X POST http://localhost:3801/api/v1/api-keys \
  -H 'content-type: application/json' -d '{"name":"drill","scopes":["presentations:read"]}' | jq -r '.key')
[ -n "$KEY" ] && [ "$KEY" != "null" ] || fail "API key mint on app1 failed"
code=$(curl -s -H "authorization: Bearer $KEY" -o "$SCRATCH/me.json" -w '%{http_code}' http://localhost:3802/api/v1/me)
[ "$code" = "200" ] || fail "API key minted on app1 rejected by app2 ($code)"
jq -e '.via == "api_key"' "$SCRATCH/me.json" >/dev/null || fail "app2 did not resolve the principal via api_key"
pass "API key minted on app1 authenticates on app2 (via=api_key)"

# File METADATA crosses replicas (shared Postgres); local blob CONTENT must
# not (per-replica /data) — the documented reason Profile B requires s3.
printf 'scale-drill payload %s' "$(date +%s)" > "$SCRATCH/payload.bin"
FID=$(curl -s -b "$JAR" -X POST 'http://localhost:3801/api/v1/files?name=drill.txt' \
  -H 'content-type: text/plain' --data-binary "@$SCRATCH/payload.bin" | jq -r '.file.id')
[ -n "$FID" ] && [ "$FID" != "null" ] || fail "file upload on app1 failed"
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "http://localhost:3802/api/v1/files/$FID")
[ "$code" = "200" ] || fail "file metadata uploaded via app1 not visible on app2 ($code)"
curl -s -b "$JAR" -o "$SCRATCH/same.bin" "http://localhost:3801/api/v1/files/$FID/content" \
  && cmp -s "$SCRATCH/same.bin" "$SCRATCH/payload.bin" \
  || fail "uploader replica cannot serve its own blob back intact"
# The cross-replica fetch must fail CLEAN: app2's shared metadata row exists
# but the blob lives on app1's private disk, so the content route checks
# storage BEFORE committing a status line and answers 404 not_found. The
# mid-stream truncation this drill originally surfaced (200 + headers, then
# a dead body, curl exit 18) is a hard failure now.
cross_code=$(curl -s -b "$JAR" -o "$SCRATCH/cross.json" -w '%{http_code}' "http://localhost:3802/api/v1/files/$FID/content") \
  || fail "cross-replica content read did not complete as a clean HTTP response (curl exit $? — mid-stream truncation regressed?)"
[ "$cross_code" = "404" ] || fail "app2 answered $cross_code for a blob stored on app1's disk — expected a clean 404"
jq -e '.error.code == "not_found"' "$SCRATCH/cross.json" >/dev/null \
  || fail "app2's 404 body is not the not_found error envelope"
pass "file metadata crosses replicas; unreachable blob content answers a clean 404 (no truncated 200) — STORAGE_DRIVER=local is single-replica, as documented"

# ── Phase 3 — rate limits shared through Redis ───────────────────────────────
say "Phase 3 — a login bucket exhausted through app1 also 429s on app2/app3 (Redis)"

attempt() { # port -> http code for a failing login with a fixed probe email
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$1/api/v1/auth/sign-in/email" \
    -H 'content-type: application/json' \
    -d '{"email":"ratelimit-probe@drill.test","password":"wrong-password-123"}'
}

hit=0
for i in $(seq 1 12); do
  code=$(attempt 3801)
  if [ "$code" = "429" ]; then
    hit=$i
    break
  fi
done
[ "$hit" -gt 0 ] || fail "app1 never returned 429 within 12 attempts (limit is 10/15min)"
note "app1 started rejecting at attempt $hit"

codeB=$(attempt 3802)
codeC=$(attempt 3803)
[ "$codeB" = "429" ] || fail "app2 answered $codeB to a bucket exhausted via app1 — NOT shared through Redis"
[ "$codeC" = "429" ] || fail "app3 answered $codeC to a bucket exhausted via app1 — NOT shared through Redis"
pass "bucket exhausted via app1 → immediate 429 on app2 AND app3 (shared Redis store)"

# ── Phase 4 — the contrast: no Redis = per-replica buckets ───────────────────
say "Phase 4 — same probe without REDIS_URL: each replica has its own bucket"

ENVFILE="$SCRATCH/env.mem"
dc up -d app1 app2 app3 # recreated with REDIS_URL empty (fresh processes, fresh memory buckets)
wait_ready app1 3801 120
wait_ready app2 3802 120

for svc in app1 app2; do
  r=$(logcount "$svc" 'rate limiting backed by redis')
  [ "$r" = "0" ] || fail "$svc still reports the redis backend despite REDIS_URL being unset"
done

hit=0
for i in $(seq 1 12); do
  code=$(attempt 3801)
  if [ "$code" = "429" ]; then
    hit=$i
    break
  fi
done
[ "$hit" -gt 0 ] || fail "app1 (memory backend) never returned 429 within 12 attempts"
note "app1 started rejecting at attempt $hit"

codeB=$(attempt 3802)
[ "$codeB" != "429" ] || fail "app2 429'd without Redis — buckets should be per-process memory"
pass "without Redis, app2 still accepts (answered $codeB) after app1 was exhausted — per-replica buckets confirmed, so Phase 3's sharing was genuinely Redis"

# ── Phase 5 — SERVICE_ROLE split: api pool + dedicated worker ────────────────
say "Phase 5 — api/worker split (fresh DB)"

ENVFILE="$SCRATCH/env.split"
dc down -v --remove-orphans >/dev/null 2>&1
dc up -d --wait db redis

# Documented first-boot caveat (jobs/pgboss.ts): an api-only replica cannot
# fully boot a FRESH database — pg-boss starts with migrate:false and fails
# its schema check until a worker/all role has installed it once. Prove it,
# and prove the api replica still applied the APP migrations first (AUTO_MIGRATE
# runs regardless of role — set AUTO_MIGRATE=false on the api pool if the api
# DB user must have no DDL rights).
dc up -d api1
found=0
for _ in $(seq 1 90); do
  if applogs api1 | grep -q 'pg-boss is not installed'; then
    found=1
    break
  fi
  sleep 1
done
[ "$found" = "1" ] || fail "api1 booted alone against a fresh DB without tripping the documented pg-boss first-boot guard"
applied=$(psqlq "SELECT count(*) FROM drizzle.__drizzle_migrations")
[ "$applied" = "$on_disk" ] || fail "api1 should have applied app migrations before the pg-boss check ($applied/$on_disk)"
pass "api-only replica on a fresh DB: applied app migrations, then crash-looped on 'pg-boss is not installed' (documented: first boot needs role all|worker)"

dc up -d worker api2
wait_ready worker 3813 120
wait_ready api2 3812 120
wait_ready api1 3811 240 # recovers via docker restart once the worker installed pg-boss
pass "worker install unblocked api1: all three split-role replicas are ready"

for svc in api1 api2; do
  role=$(applogs "$svc" | jq -Rr 'fromjson? | select(.msg=="booting") | .serviceRole' | tail -1)
  [ "$role" = "api" ] || fail "$svc booted with serviceRole=$role"
done
role=$(applogs worker | jq -Rr 'fromjson? | select(.msg=="booting") | .serviceRole' | tail -1)
[ "$role" = "worker" ] || fail "worker booted with serviceRole=$role"

schedules=$(psqlq "SELECT count(*) FROM pgboss.schedule")
[ "$schedules" = "3" ] || fail "expected the worker's 3 nightly schedules in pgboss.schedule, found $schedules"
cron_on=$(psqlq "SELECT COALESCE(cron_on::text,'') FROM pgboss.version")
[ -n "$cron_on" ] || fail "worker never stamped the pgboss.version.cron_on scheduler heartbeat"
pass "worker registered 3 nightly schedules and stamps the scheduler heartbeat (cron_on)"

# Session sanity in the split topology, then enqueue a job via the api pool:
# a file upload emits a usage event into pg-boss (api/files.ts).
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3811/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"instanceName":"Scale Drill Split","owner":{"email":"owner@drill.test","name":"Drill Owner","password":"drill-password-123456"}}')
[ "$code" = "201" ] || fail "setup on api1 answered $code"
code=$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -X POST http://localhost:3811/api/v1/auth/sign-in/email \
  -H 'content-type: application/json' \
  -d '{"email":"owner@drill.test","password":"drill-password-123456"}')
[ "$code" = "200" ] || fail "sign-in on api1 answered $code"
code=$(curl -s -b "$JAR" -o "$SCRATCH/me.json" -w '%{http_code}' http://localhost:3812/api/v1/me)
[ "$code" = "200" ] || fail "session minted on api1 rejected by api2 ($code)"
pass "session minted on api1 authenticates on api2 (split topology)"

code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST 'http://localhost:3811/api/v1/files?name=job-a.txt' \
  -H 'content-type: text/plain' --data-binary "usage probe A $(date +%s)")
[ "$code" = "201" ] || fail "upload via api1 answered $code"
completed=0
for _ in $(seq 1 30); do
  completed=$(psqlq "SELECT count(*) FROM pgboss.job WHERE name='usage-events' AND state='completed'")
  [ "$completed" -ge 1 ] && break
  sleep 1
done
[ "$completed" -ge 1 ] || fail "usage job enqueued via api1 was never completed while the worker ran"
[ "$(logcount worker 'usage events flushed')" -ge 1 ] || fail "worker log lacks 'usage events flushed'"
[ "$(logcount api1 'usage events flushed')" = "0" ] || fail "api1 executed a job — SERVICE_ROLE=api must not register workers"
[ "$(logcount api2 'usage events flushed')" = "0" ] || fail "api2 executed a job — SERVICE_ROLE=api must not register workers"
pass "job enqueued via api1 executed by the WORKER only (flush log on worker, absent on api1/api2)"

# Negative window: stop the worker, enqueue through the api pool, and hold
# 45s (> the 30s pg-boss cron monitor interval). Nothing may execute and the
# scheduler heartbeat may not advance — api replicas run no job machinery.
say "Phase 5b — 45s with the worker stopped: api replicas run no jobs, no scheduler"
dc stop worker >/dev/null
cron_before=$(psqlq "SELECT COALESCE(cron_on::text,'') FROM pgboss.version")
completed_before=$(psqlq "SELECT count(*) FROM pgboss.job WHERE name='usage-events' AND state='completed'")
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST 'http://localhost:3812/api/v1/files?name=job-b.txt' \
  -H 'content-type: text/plain' --data-binary "usage probe B $(date +%s)")
[ "$code" = "201" ] || fail "upload via api2 answered $code (worker stopped — api replicas must still serve)"
queued=$(psqlq "SELECT count(*) FROM pgboss.job WHERE name='usage-events' AND state IN ('created','retry','active')")
[ "$queued" -ge 1 ] || fail "the api-enqueued probe job is missing from pgboss.job"
note "waiting 45s (cron monitor interval is 30s)…"
sleep 45
cron_after=$(psqlq "SELECT COALESCE(cron_on::text,'') FROM pgboss.version")
completed_after=$(psqlq "SELECT count(*) FROM pgboss.job WHERE name='usage-events' AND state='completed'")
[ "$cron_after" = "$cron_before" ] || fail "scheduler heartbeat advanced with only api replicas running (cron_on $cron_before → $cron_after)"
[ "$completed_after" = "$completed_before" ] || fail "a job completed with the worker stopped — an api replica executed it"
pass "45s with only api replicas: job stayed queued AND cron_on heartbeat frozen (no worker, no scheduler on SERVICE_ROLE=api)"

dc start worker >/dev/null
wait_ready worker 3813 120
done_after=0
for _ in $(seq 1 60); do
  done_after=$(psqlq "SELECT count(*) FROM pgboss.job WHERE name='usage-events' AND state='completed'")
  [ "$done_after" -gt "$completed_before" ] && break
  sleep 1
done
[ "$done_after" -gt "$completed_before" ] || fail "restarted worker never executed the queued job"
cron_resumed=""
for _ in $(seq 1 60); do
  cron_resumed=$(psqlq "SELECT COALESCE(cron_on::text,'') FROM pgboss.version")
  [ "$cron_resumed" != "$cron_before" ] && break
  sleep 1
done
[ "$cron_resumed" != "$cron_before" ] || fail "restarted worker never resumed the scheduler heartbeat"
pass "restarting the worker drained the queued job and resumed the scheduler heartbeat — execution is attributable to the worker alone"

# Teardown + summary run in the EXIT trap.
