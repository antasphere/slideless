# Deployment profiles

One image, one statelessness invariant, two documented shapes. Scaling is
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

| Concern     | Profile A                                                                                      | Profile B                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Postgres    | compose `db` container                                                                         | managed Postgres behind a connection pooler (PgBouncer/RDS Proxy/Neon)                                 |
| Files       | `STORAGE_DRIVER=local` (single replica only)                                                   | `STORAGE_DRIVER=s3` (S3/MinIO/R2) **required** + CDN in front of the immutable content-addressed paths |
| Rate limits | per-replica memory                                                                             | `REDIS_URL` (shared buckets)                                                                           |
| Secret      | `AUTH_SECRET` in `.env` (written by `setup.sh`); generated into `/data/secret` only when unset | set `AUTH_SECRET` explicitly — all replicas must share it                                              |
| Roles       | one container, `SERVICE_ROLE=all`                                                              | API pool `SERVICE_ROLE=api`, worker pool `SERVICE_ROLE=worker`                                         |
| pgvector    | included in the compose image                                                                  | enable the extension on the managed instance if you need it                                            |

**Profile B requires shared storage.** `STORAGE_DRIVER=local` is
single-replica only: each replica has a private disk, so a blob uploaded
through one replica does not exist on another. A replica that cannot reach a
blob answers a clean `404 not_found` on the content route — that is a safety
net against silent corruption, not a supported mode of operation. Any
multi-replica deployment must set `STORAGE_DRIVER=s3` (S3, MinIO, R2).

Requirements that make B safe are already Slideless invariants:
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
on every push to `prod` or `dev` and on every pull request): the migration-lock race, cross-replica sessions and API
keys, Redis-shared rate limits (with the in-memory contrast), and the
api/worker split. See [scaling.md](../operations/scaling.md), including its findings on
first-boot ordering (a fresh database needs one `all`/`worker` boot before
api-only replicas can start).

## Limiting workspace creation

Setup creates the instance's first workspace. After that, any signed-in member who is not a guest
can create another one from the dashboard and owns it ([Workspaces](../concepts/workspaces.md)). One
variable bounds that:

| Variable                  | Default | What it bounds                                                                               |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `MAX_WORKSPACES_PER_USER` | `10`    | The workspaces one person can OWN, the setup one included. `0` closes creation for everyone. |

Workspaces are isolated from each other: the owner of one reads nothing of another, and that
includes you as the owner of the first. What you keep as the operator is the instance itself: the
database, the backups, and [break-glass recovery](../security/security.md), which can make a
superadmin an owner of any workspace and says so in that workspace's audit log. Once the instance
holds more than one workspace, a break-glass ownership claim has to name its workspace.

One consequence to know before you leave creation open: an account is one person across the whole
instance, so once a member also belongs to another workspace, an owner can no longer generate a
password-reset or change-email link for them (`403 cross_workspace_target`), nor delete their
account (`409 member_of_other_workspaces`); the owner deactivates the membership instead. On an
instance with no email delivery, where the owner's reset link is the recovery path, that member
recovers through their own workspace or through break-glass.

Set `MAX_WORKSPACES_PER_USER=0` on an instance that should stay a single team's. Workspaces that
already exist are unaffected by a lower value; only new creations are refused. The API quota is per
credential, not per workspace, so more workspaces do not raise it. Storage has no per-workspace
ceiling: size the volume for the instance as a whole.

## Sizing storage for form uploads

Deck content is written by people with an account. Form uploads are the one
thing anonymous share-link visitors write to storage: a deck form can carry a
file field, and every respondent on a link with uploads on can add files to
it ([Forms](../sharing/forms.md#file-fields)). They land in the same storage
as everything else (the `app_data` volume with `STORAGE_DRIVER=local`, the
bucket with `s3`), under their own `forms/` prefix, and three variables bound
them:

| Variable                        | Default | What it bounds                                                                                               |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `FORMS_MAX_UPLOAD_MB`           | `100`   | One uploaded file. The lower of this and `MAX_FILE_SIZE_MB` applies. `0` switches form uploads off entirely. |
| `FORMS_MAX_FILES_PER_RESPONSE`  | `100`   | The files one response can hold, all file fields together.                                                   |
| `FORMS_MAX_UPLOADS_MB_PER_DECK` | `5120`  | The total weight of one deck's form uploads, files not yet submitted included.                               |

The worst case on disk is the number of decks that have a form with a file
field and a live link with uploads on, times
`FORMS_MAX_UPLOADS_MB_PER_DECK`: at the defaults, 5 GB per such deck. Nothing
caps the sum across decks, so either size the volume for that, lower the
per-deck total, or set `FORMS_MAX_UPLOAD_MB=0` on an instance that should
never take files from the public. A deck that reaches its total refuses new
uploads (`403 uploads_full`) and keeps serving; nothing else on the instance
is affected. Deleting responses frees their space at once; deleting a deck
frees the space of its uploaded files at the nightly purge, a day after the
delete.

An upload in flight is first written to `$DATA_DIR/tmp`, then copied to
storage, so with `s3` the local volume still needs room for the uploads
being received at one moment. Files that were uploaded and never submitted
are removed by a nightly job once they are 24 hours old. It runs on
the replicas that run jobs (`SERVICE_ROLE=all` or `worker`).

Connection pooling: the app's `pg.Pool` ships conservative defaults (max 10
connections per replica, `statement_timeout` 30 s,
`idle_in_transaction_session_timeout` 30 s), so N replicas hold at most
10·N connections; size Postgres `max_connections` or the pooler
accordingly. Behind PgBouncer in **transaction mode** the two timeouts do
not stick: they are session-level settings, and transaction pooling hands
each transaction a different server session. Set them server-side instead
(`ALTER DATABASE slideless SET statement_timeout = '30s'`, same for
`idle_in_transaction_session_timeout`) or run the pooler in session mode.

Kubernetes is an ops preference some enterprises impose, never a scale
requirement — the image runs unchanged; a Helm chart is a later add-on.
