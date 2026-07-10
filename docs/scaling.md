# Scaling drill — proving Profile B

[deployment-profiles.md](deployment-profiles.md) claims the image scales
horizontally because the app container holds no state. Claims rot; this drill
is the executable proof. It stands up real multi-replica stacks with Docker
Compose and asserts every scaling invariant with direct evidence (Postgres
lock tables, DDL logs, cross-replica HTTP round-trips, pg-boss internals).
CI runs it on every push and PR (the `scale-drill` job in
`.github/workflows/ci.yml`), so the proof cannot silently regress.

## Run it locally

```bash
./scripts/scale-drill.sh                      # ~4-6 min after the image is built
DRILL_KEEP_IMAGE=1 ./scripts/scale-drill.sh   # keep the image for faster re-runs
DRILL_SKIP_BUILD=1 ./scripts/scale-drill.sh   # reuse an existing image (CI does this)
```

Needs Docker, `jq`, `curl`, `openssl`, and free localhost ports 3801-3803 and
3811-3813. Everything is isolated and throwaway: compose project
`scale-drill`, a separate `docker-compose.scale.yml` (never the operator
stack), generated secrets in a mktemp dir, tmpfs data volumes, and a
teardown (`down -v`, image removal, scratch cleanup) that runs on exit —
pass or fail. It never reads a committed `.env`.

## What it proves, and how

| #   | Claim                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Migrations under real concurrency**: N replicas race a fresh DB, exactly one applies DDL | A psql "gate" session holds the migration advisory lock (key 7432001) before any replica boots; `pg_locks` then shows all 3 replicas simultaneously queued (`NOT granted`) — deterministic contention, not start-order luck. After release: each replica's `[lock acquired → migrations up to date]` log interval is strictly disjoint from the others'; every replica boots exactly ONCE (pg-boss's install DDL is serialized under its own advisory lock, key 7432004 — see findings) with zero `deadlock detected` lines in the Postgres log; the drizzle journal has exactly one row per `.sql` file, zero duplicate hashes; and Postgres itself (`log_statement=ddl`) records the schema DDL executed by exactly ONE session. |
| 2   | **Sessions + API keys are replica-agnostic**                                               | A session cookie minted by sign-in on app1 answers `GET /api/v1/me` with 200/`via=session` on app2 AND app3; an API key minted on app1 authenticates on app2 (`via=api_key`). Shared Postgres session store + one shared `AUTH_SECRET`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3   | **Rate limits shared through Redis**                                                       | With `REDIS_URL` set, the login bucket (10/15 min, keyed IP+email) exhausted through app1 immediately 429s on app2 and app3. Then the contrast run: the same stack recreated WITHOUT `REDIS_URL` — app1 exhausted again, but app2 happily answers 401, proving buckets are per-process memory and the earlier sharing was genuinely Redis. The boot log line `rate limiting backed by redis` is asserted present/absent per stack.                                                                                                                                                                                                                                                                                                 |
| 4   | **`SERVICE_ROLE` api/worker split**                                                        | In a split stack (api1 + api2 + worker), a file upload through api1 enqueues a usage job that completes, with the `usage events flushed` handler log appearing on the worker ONLY. Then the worker is stopped for 45 s (longer than pg-boss's 30 s cron monitor interval): a job enqueued through api2 stays queued, and the `pgboss.version.cron_on` scheduler heartbeat stays frozen — api replicas run no workers and no scheduler. Restarting the worker drains the queued job and resumes the heartbeat, attributing execution to the worker alone.                                                                                                                                                                           |
| 5   | **Local storage does NOT span replicas** (why Profile B requires s3)                       | File metadata uploaded via app1 is visible on app2 (shared Postgres), but `GET /files/{id}/content` on app2 answers a clean `404 not_found` — the blob lives on app1's private disk, and the content route verifies blob reachability before committing a status line (it used to answer 200 + headers and die mid-stream, see findings). The drill asserts the uploader serves the blob back byte-identical and the other replica answers the clean 404: `STORAGE_DRIVER=local` really is single-replica; Profile B requires shared storage (s3/MinIO).                                                                                                                                                                           |

Cross-replica assertions hit each replica's own published port directly (no
load balancer in the loop), so "minted on A, verified on B" is deterministic.

## Findings the drill surfaced (the honest part)

The first two findings below were real multi-replica bugs; both are FIXED
and the drill now hard-asserts the fixed behavior (a regression fails CI).

- **pg-boss queue creation deadlocked concurrent fresh-DB boots — the app
  migration lock does not cover it.** (FIXED) The drizzle migrations are
  perfectly serialized (proven above), but pg-boss's own setup runs AFTER
  them: pg-boss serializes its schema install internally, while
  `createQueue()` calls `pgboss.create_queue(text,json)` (queue-row insert +
  per-queue partition CREATE TABLE/attach) with NO lock. Multiple
  `all`/`worker` replicas booting together against a fresh database reliably
  deadlocked there (Postgres `DeadLockReport`; one or two losers crash-looped
  per 3-replica run until a docker restart found the queue rows in place).
  The fix (`apps/server/src/jobs/pgboss.ts`): the whole install section —
  `start()` + `createQueue` + nightly schedules — runs under a session-scoped
  `pg_advisory_lock` on a dedicated client, mirroring the migration-lock
  pattern. Lock key **7432004**, distinct from the migration lock (7432001)
  and the last-owner locks (7432002/7432003). The lock is held during boot
  setup only; steady-state `send()`/`work()` never touches it, and
  `SERVICE_ROLE=api` replicas (no DDL, no queue creation) never acquire it.
  The drill asserts every replica boots exactly once and the Postgres log
  contains zero `deadlock detected` lines.
- **Cross-replica reads of local-storage blobs failed UGLY, not clean.**
  (FIXED) The replica that doesn't hold the blob trusted the shared
  metadata, answered `200` with full headers, and then the body stream died
  (client saw a truncated transfer, curl exit 18) — silent corruption, not
  an error. The content route (`GET`/`HEAD /files/{id}/content`) now
  verifies `storage.exists(key)` before committing any status line and
  answers a clean `404 not_found` when the row exists but the bytes are
  unreachable on this replica; the local driver also opens the blob eagerly
  so a race after the check still fails before headers. The 404 is a safety
  net, NOT a fix for the topology: **Profile B (any multi-replica
  deployment) requires shared storage (`STORAGE_DRIVER=s3` — S3/MinIO/R2).**
  `STORAGE_DRIVER=local` is single-replica only and must never sit behind a
  multi-replica load balancer.
- **First boot of a fresh DB must be `SERVICE_ROLE=all|worker` — proven, not
  just documented.** An api-only replica against an empty database applies
  the app migrations, then crashes on pg-boss's `pg-boss is not installed`
  check (`migrate:false`) and restart-loops until a worker/all role installs
  the pg-boss schema once. The stack self-heals — the drill asserts the
  crash, then that starting the worker unblocks the api replica — but a
  Profile B rollout should start the worker pool first (or run one `all`-role
  boot) on a brand-new database.
- **`SERVICE_ROLE=api` still runs app DDL.** deployment-profiles.md says the
  api role "needs no DDL rights" — that is true of pg-boss, but `AUTO_MIGRATE`
  defaults to true and runs the drizzle migrations on every role. If the api
  pool's DB user must genuinely have no DDL rights, set `AUTO_MIGRATE=false`
  on the api pool and let the worker pool (or a release step) migrate.
- **Redis loss fails open, per replica.** The Redis limiter carries an
  in-memory `insuranceLimiter`: if Redis blips, limits degrade to per-replica
  buckets (weaker, N× the global budget) instead of rejecting traffic. A
  misconfigured `REDIS_URL` therefore does not fail the boot — which is
  exactly why the drill asserts the `rate limiting backed by redis` boot line
  and the cross-replica 429, not just "the app came up".

## What it deliberately does not cover

- **s3 storage in prod** (MinIO/S3/R2): the drill proves local storage does
  not span replicas, not that the s3 driver does. The s3 path is covered by
  unit tests; a MinIO leg can be added to this drill later.
- Managed-Postgres/PgBouncer behavior (see the pooling caveats in
  [deployment-profiles.md](deployment-profiles.md)).
- Rolling-deploy drain and expand-then-contract coexistence — separate
  proofs, see [production-readiness.md](production-readiness.md).
