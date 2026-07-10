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

`canReadDeck` today coincides with `canWriteDeck` (owner-level OR active dev
grant); it is deliberately a separate policy function so a future read-only
collaborator role can widen reads without widening writes.

## Deliberate divergence from ADR 006

ADR 006's "files are workspace data" stance is **unchanged for the generic
`/files` surface** and for GDPR semantics (deck ownership still anonymizes
to NULL on account deletion; blobs stay with the workspace). What diverges
is deck-level READ authorization: workspace membership alone is no longer a
read grant on decks, because membership here is an artifact of collaborator
onboarding, not a statement of trust across the whole tenant's content.

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
