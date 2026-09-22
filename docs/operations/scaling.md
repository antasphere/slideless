# Scaling drill — proving Profile B

[deployment-profiles.md](../self-hosting/deployment-profiles.md) claims the image scales
horizontally because the app container holds no state. Claims rot; this drill
is the executable proof. It stands up real multi-replica stacks with Docker
Compose and asserts every scaling invariant with direct evidence (Postgres
lock tables, DDL logs, cross-replica HTTP round-trips, pg-boss internals).
CI runs it on every push to `prod` or `dev` and on every PR (the `scale-drill` job in
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
stack), generated secrets in a mktemp dir, anonymous per-container data volumes, and a
teardown (`down -v`, image removal, scratch cleanup) that runs on exit —
pass or fail. It never reads a committed `.env`.

## What it proves, and how

| #   | Claim                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Migrations under real concurrency**: N replicas race a fresh DB, exactly one applies DDL | A psql "gate" session holds the migration advisory lock (key 7432001) before any replica boots; `pg_locks` then shows all 3 replicas simultaneously queued (`NOT granted`) — deterministic contention, not start-order luck. After release: each replica's `[lock acquired → migrations up to date]` log interval is strictly disjoint from the others'; every replica boots exactly ONCE (pg-boss's install DDL is serialized under its own advisory lock, key 7432004) with zero `deadlock detected` lines in the Postgres log; the drizzle journal has exactly one row per `.sql` file, zero duplicate hashes; and Postgres itself (`log_statement=ddl`) records the schema DDL executed by exactly ONE session. |
| 2   | **Sessions + API keys are replica-agnostic**                                               | A session cookie minted by sign-in on app1 answers `GET /api/v1/me` with 200/`via=session` on app2 AND app3; an API key minted on app1 authenticates on app2 (`via=api_key`). Shared Postgres session store + one shared `AUTH_SECRET`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | **Rate limits shared through Redis**                                                       | With `REDIS_URL` set, the login bucket (10/15 min, keyed IP+email) exhausted through app1 immediately 429s on app2 and app3. Then the contrast run: the same stack recreated WITHOUT `REDIS_URL` — app1 exhausted again, but app2 happily answers 401, proving buckets are per-process memory and the earlier sharing was genuinely Redis. The boot log line `rate limiting backed by redis` is asserted present/absent per stack.                                                                                                                                                                                                                                                                                  |
| 4   | **`SERVICE_ROLE` api/worker split**                                                        | In a split stack (api1 + api2 + worker), a probe job in the usage queue (inserted by the drill: a self-hosted instance emits no usage event, and the api pool's own sends are cloud-only) completes with the `usage events flushed` handler log appearing on the worker ONLY. Then the worker is stopped for 45 s (longer than pg-boss's 30 s cron monitor interval): a second probe queued meanwhile stays queued, and the `pgboss.version.cron_on` scheduler heartbeat stays frozen — api replicas run no workers and no scheduler. Restarting the worker drains the queued job and resumes the heartbeat, attributing execution to the worker alone.                                                             |
| 5   | **Local storage does NOT span replicas** (why Profile B requires s3)                       | File metadata uploaded via app1 is visible on app2 (shared Postgres), but `GET /files/{id}/content` on app2 answers a clean `404 not_found` — the blob lives on app1's private disk, and the content route verifies blob reachability before committing a status line (it used to answer 200 + headers and die mid-stream). The drill asserts the uploader serves the blob back byte-identical and the other replica answers the clean 404: `STORAGE_DRIVER=local` really is single-replica; Profile B requires shared storage (s3/MinIO).                                                                                                                                                                          |

Cross-replica assertions hit each replica's own published port directly (no
load balancer in the loop), so "minted on A, verified on B" is deterministic.

The drill also hard-asserts the fixed behavior of real multi-replica bugs
it surfaced during development (a regression fails CI) — among them the
first-boot ordering rule it proved: **a fresh database needs one
`all`/`worker`-role boot before api-only replicas can start** (an api-only
replica crash-loops on pg-boss's `pg-boss is not installed` check until a
worker installs the pg-boss schema once; the stack then self-heals).

## What it deliberately does not cover

- **s3 storage in prod** (MinIO/S3/R2): the drill proves local storage does
  not span replicas, not that the s3 driver does. The s3 path is covered by
  unit tests; a MinIO leg can be added to this drill later.
- Managed-Postgres/PgBouncer behavior (see the pooling caveats in
  [deployment-profiles.md](../self-hosting/deployment-profiles.md)).
- Rolling-deploy drain and expand-then-contract coexistence — separate
  proofs.
