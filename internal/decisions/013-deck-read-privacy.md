# ADR 013 — Deck reads are private, not workspace-wide

Status: accepted (2026-07-10)

## Context

The template's ADR 006 treats uploaded content as **workspace data**: files
belong to the workspace, not the uploader, and every workspace member can
read them. ADR 011 inherited that stance for decks ("deck ownership follows
ADR 006"), and the Phase 3 read handlers authorized `list` / `get` /
`listVersions` / `getVersion` / asset download on `workspace_id` alone.

Phase 5 changed who a "member" is. Slideless self-hosted has no multi-user
workspace product; the only way a non-owner account comes to exist is a
**per-deck collaborator grant** (or an explicit workspace invitation). A
collaborator is routinely an EXTERNAL party — a reviewer or client invited
to develop exactly ONE deck — yet claiming their grant makes them an
ordinary workspace member (the platform authenticates through memberships,
see LESSONS.md Phase 5). Under the ADR 006 posture that membership was a
read handle to EVERY deck in the workspace: the Phase 5 adversarial review
proved live that a deck-A collaborator could list and download the full
content of deck B, and that revoking their grant did not cut this off.

## Decision

**A deck is private to its owner.** A principal may READ a deck (metadata,
version list, version detail with manifest, asset bytes) iff they are:

1. the deck owner (`presentations.owner_user_id`), or
2. a workspace **admin/owner** — the instance operator keeps the ADR 006
   operator view (and orphaned decks, owner set NULL after account
   deletion, stay manageable), or
3. the holder of an **ACTIVE** collaborator grant on THAT deck (status
   `active`; revoked or expired-pending grants authorize nothing).

This is `canReadDeck` in `apps/server/src/presentations/service.ts`, applied
to `GET /presentations/{id}`, `GET /presentations/{id}/versions`,
`GET /presentations/{id}/versions/{version}`, and
`GET /presentations/{id}/assets/{sha256}`. `GET /presentations` applies the
same scope as a WHERE clause: admins/owners page the whole workspace; a
plain member pages only decks they own or actively collaborate on.

**Failed read checks answer 404, never 403.** Deck ids must not be probeable
by principals who cannot read the deck — the same hide-existence posture the
annotation and collaborator-roster routes already take.

**Amendment 2026-07-26 (PRDCT-1354, AUTH-5): the WRITE surface answers 404
too.** `deckForSharing` (`api/presentations.ts`), the resolver behind the
share-token management routes, used to distinguish 404 (no such deck) from
403 (exists, you cannot manage it). That 403 was the same existence oracle
this section forbids, reachable by any workspace member against every deck
in the tenant — hiding a deck from a principal's READS while confirming it
to their WRITES leaks the identical bit. The refusal became a uniform 404.

**Amendment 2026-08-10 (PRDCT-1393): the rest of the write surface caught
up.** The 2026-07-26 amendment shipped with only `deckForSharing` fixed and
overstated its own reach: eight sibling per-deck write routes kept leaking
the same bit to any workspace member (403 for a real deck, 404 for a
nonexistent one, and the probe is free) — deck DELETE, annotation
PATCH/DELETE, form-response DELETE, collaborator invite AND remove, the
version commit, and the preview-token mint. All now answer 404 on a failed
deck check, asserted per route in
`test/integration/minted-credentials.test.ts`.

The rule, stated precisely this time, which the code now satisfies on every
route: **a per-deck surface, read or write, answers 404 whenever the caller
fails the deck READ check** (`canReadDeck`) — deck existence is never
confirmed to a principal who cannot read the deck. A 403 is permitted only
AFTER a passed read check, where it confirms nothing the caller does not
already legitimately see: the owner-level refusals to an active dev
collaborator (deck delete, collaborator invite/remove, preview-token
mint/revoke) and the invite route's `external_invite_forbidden` gate.

`canReadDeck` today coincides with `canWriteDeck` (owner-level OR active dev
grant); it is deliberately a separate policy function so a future read-only
collaborator role can widen reads without widening writes.

The same policy governs the raw blobs behind those decks — see the SL-B1
amendment at the bottom of this ADR.

## Deliberate divergence from ADR 006

ADR 006's "files are workspace data" stance is **unchanged** for GDPR
semantics (deck ownership still anonymizes to NULL on account deletion;
blobs stay with the workspace). What diverges is deck-level READ
authorization: workspace membership alone is no longer a read grant on
decks, because membership here is an artifact of collaborator onboarding,
not a statement of trust across the whole tenant's content.

## Amendment (2026-07-26) — the blob surface, SL-B1

The original decision left the generic `/files` surface on ADR 006's
posture, reasoning that decks were what mattered. That was wrong, and the
security campaign proved it live: `GET /files` and
`GET /files/{id}/content` authorized on `workspace_id` alone, so any plain
member — and any `presentations:read` API key — could enumerate and stream
the BYTES of every deck in the workspace. Deck ids were private while deck
content was not, which is the same hole one layer down. A version commit
then re-bound a foreign sha into a deck of the attacker's own, letting them
re-publish stolen content anonymously through a share link.

**A blob carries the deck policy.** `blobReadScope`
(`presentations/service.ts`) is `canReadDeck` expressed as a WHERE
predicate over a `files` row, and every generic-surface read applies it —
list, metadata, content (GET + HEAD) and delete:

1. workspace **admin/owner** → the ADR 006 operator view, every blob;
2. everyone else → blobs they **uploaded**, plus blobs referenced by the
   manifest of a LIVE version of a deck they can read.

Refusals are **404, never 403**, exactly as for decks. The same predicate
is the commit guard: `lockAndResolveBlobs` resolves only readable shas, so
an unreadable one reports as `missing_blobs` (a refusal that does not
confirm the workspace holds the bytes), and `precheckMissing` is scoped the
same way so "already present" cannot serve as a whole-workspace existence
oracle.

Possession is tracked in `file_uploaders` (migration 0034), not in
`files.created_by`. Blobs are content-addressed and unique per (workspace,
sha256), so a second uploader of identical bytes deduplicates onto the
first uploader's row; crediting only `created_by` would lock a member out
of bytes they demonstrably hold and refuse their commit. Every upload —
fresh or deduplicated, `/files` or `/presentations/assets` — records its
uploader.

Guests remain refused the surface outright (`requireNonGuest`). The per-deck
read they hold is served by `/presentations/{id}/assets/{sha256}`; the
generic file cabinet of a host tenant is not theirs to browse.

Unchanged, out of this ADR's scope:

- WRITE paths (`canWriteDeck`) and owner-level control (`canAdministerDeck`)
  — already correctly scoped in Phase 5.
- The public viewer (token-authed, ADR 012) — a separate authorization
  system.
- Share-token management and annotation authz — already gated on
  `canWriteDeck` / `canAdministerDeck`.
- The `/members` roster visibility and whether members may create decks or
  invite collaborators — open policy decisions recorded in
  TEMPLATE-FEEDBACK.md ("Phase 5 adversarial review").

## Revisit when

A real multi-user team product wants workspace-shared decks (add an explicit
visibility field or team grants — do NOT silently revert reads to
workspace-wide), or a read-only collaborator role arrives (extend
`canReadDeck` only).
