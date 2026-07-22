# Deployment profiles

One template, one statelessness invariant, two documented shapes. Scaling is
a deployment choice, not an architecture change: the app container holds no
state (sessions in Postgres, jobs in pg-boss, files behind the
StorageDriver, counters append-and-aggregate, graceful drain on SIGTERM,
expand-then-contract migrations).

## Profile A — single VPS (the default)

`docker compose up -d`: app + Postgres, local file storage on the `app_data`
volume, in-memory rate limits, Caddy in front for TLS
([reverse-proxy.md](reverse-proxy.md)). Serves teams to small companies; a
bigger machine buys roughly 10×. This is the shape the install scripts and
backup scripts assume.

## Profile B — horizontal / cloud (reference)

The same image, N autoscaling replicas (e.g. Cloud Run), with the state
moved to managed services:

| Concern     | Profile A                                    | Profile B                                                                                              |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Postgres    | compose `db` container                       | managed Postgres behind a connection pooler (PgBouncer/RDS Proxy/Neon)                                 |
| Files       | `STORAGE_DRIVER=local` (single replica only) | `STORAGE_DRIVER=s3` (S3/MinIO/R2) **required** + CDN in front of the immutable content-addressed paths |
| Rate limits | per-replica memory                           | `REDIS_URL` (shared buckets)                                                                           |
| Secret      | auto-generated in `/data`                    | set `AUTH_SECRET` explicitly — all replicas must share it                                              |
| Roles       | one container, `SERVICE_ROLE=all`            | API pool `SERVICE_ROLE=api`, worker pool `SERVICE_ROLE=worker`                                         |
| pgvector    | included in the compose image                | enable the extension on the managed instance; products run `CREATE EXTENSION`                          |

**Profile B requires shared storage.** `STORAGE_DRIVER=local` is
single-replica only: each replica has a private disk, so a blob uploaded
through one replica does not exist on another. A replica that cannot reach a
blob answers a clean `404 not_found` on the content route — that is a safety
net against silent corruption, not a supported mode of operation. Any
multi-replica deployment must set `STORAGE_DRIVER=s3` (S3, MinIO, R2).

Requirements that make B safe are already the template's invariants:
`AUTO_MIGRATE` under an advisory lock means one replica migrates while
others wait; pg-boss's own install DDL (schema + queue partitions) is
serialized the same way under a second advisory lock (key 7432004,
`jobs/pgboss.ts`), so concurrent fresh-DB boots of `all`/`worker` replicas
do not deadlock; graceful drain means rolling deploys drop nothing (proven:
a SIGTERM mid-download lets the transfer finish); `SERVICE_ROLE=api` runs no
job supervision (note: it still applies the app migrations unless you set
`AUTO_MIGRATE=false` on the api pool — only the pg-boss DDL is skipped).

These claims are not just documented — they are exercised as a real
multi-replica stack by the scale drill (`scripts/scale-drill.sh`, run in CI
on every push): the migration-lock race, cross-replica sessions and API
keys, Redis-shared rate limits (with the in-memory contrast), and the
api/worker split. See [scaling.md](../operations/scaling.md), including its findings on
first-boot ordering (a fresh database needs one `all`/`worker` boot before
api-only replicas can start).

Connection pooling: the app's `pg.Pool` ships conservative defaults (max 10
connections per replica, `statement_timeout` 30 s,
`idle_in_transaction_session_timeout` 30 s), so N replicas hold at most
10·N connections; size Postgres `max_connections` or the pooler
accordingly. Behind PgBouncer in **transaction mode** the two timeouts do
not stick: they are session-level settings, and transaction pooling hands
each transaction a different server session. Set them server-side instead
(`ALTER DATABASE platform SET statement_timeout = '30s'`, same for
`idle_in_transaction_session_timeout`) or run the pooler in session mode.

Kubernetes is an ops preference some enterprises impose, never a scale
requirement — the image runs unchanged; a Helm chart is a later add-on.
