# Backups and data sovereignty (deferred design note)

> **Status: captured discussion, not yet implemented (2026-07-07).** This
> records the reasoning so the next person to tackle durable backups does not
> re-derive it. The operator runbook for the tooling that exists today lives in
> [backup-restore.md](../docs/operations/backup-restore.md); this file is the roadmap and the
> constraints around it.

## Why this exists

A client asked the obvious catastrophe question: if the VPS running an instance
is shut down or lost, do we lose everything? For the default self-hosted
deployment the honest answer today is close to "yes", and the fix is entangled
with a positioning constraint (data sovereignty) that rules out the easy cloud
answers. Both halves are written down below.

## Current state (what exists today)

- `scripts/backup.sh` dumps Postgres (`pg_dump | gzip`), tars the `/data`
  volume (uploaded blobs plus the auto-generated auth secret), and tars
  `.env` + `docker-compose.yml`, pruning older than `RETENTION_DAYS` (30).
- `scripts/restore.sh` restores a stamped set and restarts the app.
- `backup-restore.md` documents a cron line, an off-machine warning, and a
  quarterly restore drill.

The mechanism is real; the posture is not. By default nothing schedules it,
nothing ships it off the machine (the script writes to `./backups` on the same
disk), nothing verifies a restore, and nothing alerts on failure. Postgres and
the blobs both live in Docker named volumes (`pg_data`, `app_data`) on the one
VPS. So a fresh client instance has no live, offsite, tested backups until an
operator wires all of that by hand, which for a per-client fleet nobody will do
reliably. `production-readiness.md` already flags this ("Backups are scripted
but not automated or verified").

## The load-bearing constraint: sovereignty, not just a region

The template's entire pitch is that data lives _in_ the instance, under the
client's control, for hard-GDPR clients. That constraint dictates the backup
design more than convenience does:

- Managed databases (Neon, RDS, Cloud SQL, Supabase) would make durability the
  provider's problem with almost no code (the app only needs a `DATABASE_URL`).
  But moving the primary database off the instance breaks the "data lives in
  it" argument, and the popular option (Neon) is a US company, now part of
  Databricks.
- **An EU region is not EU sovereignty.** A US-controlled provider storing bytes
  in Frankfurt is still subject to US extraterritorial law (the CLOUD Act,
  FISA 702), which is exactly the Schrems II problem sovereignty-minded clients
  pay to avoid. What matters for the hard bar is the nationality of the
  _operating entity_, not the data-center location. This disqualifies US clouds'
  EU regions (Neon, Wasabi, Backblaze B2, Cloudflare R2, AWS) for these clients
  even when the data sits in Europe.

Conclusion: the durability solution must itself be sovereign. The aligned shape
keeps the primary Postgres self-hosted inside the instance on sovereign EU
infrastructure the client controls, and ships _encrypted_ daily backups to
EU-sovereign object storage. This preserves the pitch and removes the
single-VPS single point of failure.

## Recommended architecture (for when we build it)

1. **Keep the primary database in the instance.** Self-hosted Postgres on EU
   infrastructure the client controls (a Hetzner/Scaleway/OVH box, or their own
   datacenter). Do not move the primary DB to a managed service, even an EU one,
   unless a specific client explicitly prefers that trade.
2. **Encrypted daily backups to EU-sovereign S3-compatible storage.** The
   template already speaks S3 with an endpoint override (`STORAGE_DRIVER=s3`,
   `S3_ENDPOINT`, `S3_*`), so the backup _target_ is configuration, not code.
   Encrypt client-side before upload so even the storage provider cannot read
   the dump, which keeps both the confidentiality and the sovereignty argument
   airtight. Retention around 10 days, configurable.
3. **Ship it as an opt-in backup service, not a cron the operator must set up.**
   A small sidecar container or a compose profile that runs the scheduled
   encrypted `pg_dump` (plus a blob sync when `STORAGE_DRIVER=local`) belongs
   outside the app process; `pg_dump` from inside the app container is awkward.
   This closes the four real gaps at once: scheduled, offsite, and (below)
   verified and alerted.
4. **Make restore a tested path, not a hope.** Wire a backup then wipe then
   restore then verify drill into CI, the way the multi-replica scale drill
   (`scripts/scale-drill.sh`) works, so restore is proven rather than assumed.
5. **Alert on failure.** At minimum a non-zero exit and a metric; ideally a
   healthcheck-style ping so a silently failing nightly backup surfaces.

### The AUTH_SECRET trap (fix this regardless of the rest)

The auth secret is auto-generated into `/data` when `AUTH_SECRET` is unset
(`resolveAuthSecret` in `boot.ts`). It is not in the database and not in the
blob bucket. So an operator on managed Postgres plus S3 blobs who assumes "the
database and the bucket are backed up, I'm safe" would silently lose that secret
on a VPS rebuild, and losing it breaks every session, the JWKS, _and_ every API
key (they are peppered with it, unless the pepper version is pinned per
[ADR 008](decisions/008-api-key-pepper-versioning.md)). The highest-leverage
single change is to recommend setting `AUTH_SECRET` explicitly as an env in a
secret manager rather than letting it auto-generate, which takes `/data` out of
the critical recovery path and shrinks the backup surface to the database and
blobs.

## Provider candidates to evaluate

Verify current regions, SecNumCloud/ISO 27001 status, `pgvector` support (the
DB image is `pgvector/pgvector`, so any external Postgres needs the extension),
and pricing before committing to any of these; the list is from memory in
2026-07 and this landscape shifts.

- **EU-sovereign object storage (backup target).** European-owned operators, not
  US clouds' EU regions: Scaleway (FR), OVHcloud (FR, the strongest public-sector
  story via SecNumCloud), Hetzner (DE), IONOS (DE), and for Switzerland
  (adequacy-covered) Exoscale or Infomaniak. For French public-sector or
  health-data clients, SecNumCloud-qualified providers are the gold standard.
- **Sovereign managed Postgres, if a client ever wants managed over
  self-hosted.** Aiven (FI), Clever Cloud (FR), or Scaleway/OVHcloud managed
  databases. There is no clean European equivalent of Neon's serverless-branching
  developer experience; the pragmatic sovereign answer is one of these or
  self-hosted. Given the pitch, self-hosted DB plus sovereign offsite backup is
  the better fit anyway.

## Trade-offs to state to clients

- **RPO.** Nightly dumps mean up to 24 hours of potential data loss. If a client
  cannot tolerate that, the real answer is Postgres point-in-time recovery
  (seconds of RPO), which in practice means either a self-hosted WAL-archiving
  setup or a managed sovereign Postgres, not more frequent dumps.
- **Managed vs self-hosted.** Managed shifts durability to the provider but,
  even sovereign, moves data off the instance and weakens the "data lives in it"
  story. Self-hosted keeps the story and puts durability on us; the backup
  service is how we make that responsible.

## Open decisions for the implementation session

1. Sidecar backup container versus a scheduled job; leaning sidecar for
   separation and because `pg_dump` wants to run outside the app process.
2. Which one or two European providers to document as the reference target
   (needs the verification pass above).
3. Whether to also document a self-hosted WAL-archiving PITR recipe for clients
   with a sub-24h RPO requirement.
4. Client-side encryption key management (where the backup encryption key lives,
   and how it is itself backed up, without recreating the AUTH_SECRET trap).
5. Recommend or default `AUTH_SECRET` to an explicit env; this one is worth
   doing even ahead of the rest.
