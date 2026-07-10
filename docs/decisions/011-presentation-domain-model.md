# ADR 011 — Presentation domain model: files-reuse + jsonb manifests

Status: accepted (2026-07-10)

## Context

Phase 2 of the Slideless build defines the presentation product's data model
and freezes the /api/v1 contract surface (handlers land in Phases 3–5). Two
storage questions had real alternatives:

1. Where do deck blobs live — a new `presentation_assets` table or the
   template's existing content-addressed `files` machinery?
2. Where does a version's manifest (the path → sha256 listing) live — a blob
   in object storage via the StorageDriver, or a jsonb column on the version
   row?

The legacy product stored blobs content-addressed by sha256, deduped per
(workspace, sha256), with a `vN.json` manifest object per version — exactly
the shape the template's `files` table + `blobKey(workspaceId, sha256)`
already implement.

## Decision

**Blobs: reuse the `files` table and the StorageDriver.** Deck assets are
ordinary content-addressed workspace files; `presentation_versions.manifest`
references them by sha256, and the bytes live at
`blobKey(workspaceId, sha256)` like every other file. No parallel blob
pipeline, no second dedupe index, and the workspace export/GDPR semantics
(ADR 006) cover deck assets for free. There is deliberately NO join table:
the manifest jsonb IS the reference; a future asset-GC pass derives liveness
by scanning manifests (or materializes a join table then — an additive
change).

**Manifests: jsonb on `presentation_versions`, not an object-store blob.**

- A version commit is ONE transactional insert: bump
  `presentations.current_version` under the optimistic-concurrency check and
  write the manifest atomically. A manifest object in storage would need a
  write-then-insert dance with an orphaned-blob failure mode the template
  would then need GC for.
- Manifests are small structured metadata (a 1000-asset deck is ~100 KB;
  real decks are tens of entries), far below any jsonb comfort threshold.
- SQL can see into manifests (which versions reference sha X) — that is what
  makes the no-join-table decision above safe.
- Cost: manifest bytes ride Postgres backups rather than object storage, and
  version listings must NOT `SELECT *` (the API's version-list schema
  deliberately omits the manifest; only the single-version GET returns it).

**Consequences for the blob lifecycle (Phase 3 must respect this):** a
manifest references content the generic `DELETE /files/{id}` can remove
(soft-deletes the row AND deletes the blob). Phase 3 must protect deck
assets — either check manifest references before blob deletion, or keep
deck-asset file rows out of the user-facing files surface.
*Status update (Phase 3, 2026-07-10): closed.* `DELETE /files/{id}` now runs
a manifest-containment check (any live deck's version, GIN-indexed —
migration 0014) inside the delete transaction with the files row locked FOR
UPDATE, answering **409 file_in_use**; commits lock referenced rows FOR
SHARE, so delete-vs-commit races serialize instead of dangling a manifest.
Soft-deleted decks do not pin blobs (their manifests may dangle; a future GC
reclaims properly).

Other shapes fixed here:

- **Versions are append-only and immutable** — `UNIQUE (presentation_id,
  version)`, never UPDATE. `presentations.current_version` (0 = no versions
  yet) only advances via commit with `expectedBaseVersion` (409 on
  mismatch).
- **Share tokens are per-recipient**: 48-byte secret, sha256 stored, unique
  hash index for O(1) lookup (the api_keys pattern). `pinned_version` NULL
  means "follow latest". New over legacy: `expires_at`, `password_hash`.
  Revocation is soft (`revoked_at`) so access stats survive. No `?token=`
  URLs — the viewer (Phase 4) carries the secret in the path.
- **Collaborators are per-deck email grants** claimed at sign-in/sign-up via
  a hashed claim token (the invitations pattern); `user_id` set-nulls if the
  claimed account dies, reverting the grant to unclaimed.
  *Status update (Phase 5, 2026-07-10): shipped.* The claim token became the
  full two-token invitation pattern (ADR 009): `claim_email_token_hash`
  (migration 0016, additive) carries a second token that exists only in the
  invite email, so claiming with it may honestly set `emailVerified`.
  Grants cap at 10 live (active + unexpired-pending) per deck, pendings
  expire after 14 days, and an ACTIVE dev commits versions as
  `created_by_role = 'dev'`, manages share tokens and annotations, but can
  neither delete the deck nor touch its collaborator roster. Claiming makes
  a new account an ordinary workspace MEMBER (the platform authenticates
  through memberships); the per-deck grant rides on top.
- **Annotations anchor to (presentation, version)** with an opaque jsonb
  `selection`; author is either a principal (`author_user_id`) or an
  anonymous reviewer through a token (`share_token_id` + `author_name`),
  both surviving deletion via set null.
- **Upload sessions reserve the future presentation id** for new-deck pushes
  (~1 h expiry, one-shot via `consumed_at`); `presentation_id` deliberately
  has no FK — the row it names exists only after commit.
- **Deck ownership follows ADR 006**: decks are workspace data;
  `owner_user_id` (and version/token `created_by`) anonymize to NULL on
  account deletion rather than cascading content away.

## Alternatives rejected

- **New `presentation_assets` blob table**: duplicates dedupe, upload
  spooling, driver plumbing, and export coverage that `files` already has;
  two content stores to keep consistent.
- **Manifest in object storage**: keeps Postgres lean but breaks commit
  atomicity, hides manifests from SQL, and adds a GC obligation — wrong
  trade at deck-manifest sizes.
- **Mutable "current files" set updated in place**: loses pinned-version
  sharing, remix lineage, and cheap rollback; append-only versions are the
  product.
