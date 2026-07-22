# Scale-drill findings

The bug narratives behind the multi-replica scale drill
([docs/operations/scaling.md](../docs/operations/scaling.md)): what the
drill surfaced while it was being built, what was fixed, and the residual
behaviors it now hard-asserts (a regression fails CI).

## Findings the drill surfaced (the honest part)

The first two findings below were real multi-replica bugs; both are FIXED
and the drill now hard-asserts the fixed behavior (a regression fails CI).

- **pg-boss queue creation deadlocked concurrent fresh-DB boots — the app
  migration lock does not cover it.** (FIXED) The drizzle migrations are
  perfectly serialized (proven by the drill's claims table), but pg-boss's
  own setup runs AFTER
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
- **`SERVICE_ROLE=api` still runs app DDL.**
  [deployment-profiles.md](../docs/self-hosting/deployment-profiles.md) says the
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
