# ADR 006 — GDPR delete semantics and the export scope

Status: accepted (2026-07-06)

## Decision

The template ships account deletion (self-service + admin) and a
full-workspace export, with these load-bearing semantics:

- **Files are workspace data, not the uploader's personal data.** Account
  deletion removes the person — the user row, sessions, workspace
  membership, API keys, invitations they issued — but files they uploaded
  **remain with the workspace**, with `files.created_by` set to NULL by the
  FK (migration 0008). That is exactly the `set null` anonymization
  `audit_log.actor_user_id` and `workspace_members.invited_by` already get.
  GDPR erases personal data; workspace files are the controller's business
  records. `api_keys.created_by` KEEPS its cascade: keys are personal
  credentials that die with their creator. No blob is touched anywhere in
  the delete flows. A product needing per-user file erasure adds it on top.
- **Hard cascade, no grace period.** The delete happens immediately through
  Better Auth's own path (`internalAdapter.deleteUser` + Postgres FK
  cascades); there is no soft-delete or undo window. The dashboard's
  type-DELETE confirmation is the guard.
- **The last active owner cannot be deleted — race-free** (M9 hardening; a
  zero-active-owner instance is unrecoverable because setup is one-shot).
  Two layers, both in `accounts/deletion.ts` + migration 0009:
  1. A `BEFORE DELETE OR UPDATE` trigger on `workspace_members` raises
     SQLSTATE `P0409` whenever an operation would drop the workspace's
     ACTIVE owners to zero. The trigger serializes concurrent removals with
     a per-workspace `pg_advisory_xact_lock` before its survivor check
     (plain READ COMMITTED visibility is not enough — two concurrent deletes
     each see the other's row still present), so the invariant holds on
     every path: both HTTP surfaces, the PATCH demotion, future code, even
     operator SQL through the app role. Transaction-scoped lock — it cannot
     leak.
  2. The HTTP surfaces serialize around their guard re-check with a
     per-workspace session-scoped advisory lock on a dedicated client (the
     migration-lock pattern), so the LOSER of a concurrent last-owner race
     gets a clean `400 last_owner` instead of tripping the trigger
     mid-cascade. The self-service path parks the lock between Better Auth's
     before/after delete hooks (released in `afterUserDelete` on success, by
     a 60 s watchdog if the cascade dies between the hooks — the session
     lock dies with its connection, so a leak self-heals); the admin delete
     and PATCH demotion hold it across their own try/finally. Both surfaces
     additionally map the trigger's `P0409` to `400 last_owner`.
     The earlier "advisory, accepted race" stance is retired: it was proven
     live that two parallel self-deletes of the two last owners both returned
     200 and bricked the instance.
- **The fresh-session no-password window is a Better Auth default we
  document rather than fight**: a session younger than `freshAge` (24 h) may
  call `/delete-user` without a password server-side. The dashboard always
  collects the current password (every template user has a credential
  account), so the UI path is always password-gated. Exposure is low: the
  call is blocked cross-site by Better Auth's Origin/CSRF guard and by
  SameSite=Lax cookies, so it is only self-triggerable — someone scripting
  their own fresh session against themselves.
- **Delete is never exposed to machines.** `DELETE /members/{id}` is
  deliberately unlisted in the fail-closed scope allowlist (keys/tokens
  403), and the CLI ships no delete command. Deleting people is a
  session-only act.
- **Audit trail:** pre-existing rows anonymize via SET NULL; each deletion
  additionally lands a completion row — `member.delete` with the acting
  admin on the admin surface, `user.account_delete` with the `system` actor
  on the self-service surface (written after the cascade, FK-safe).
- **Export rides a dedicated opt-in `data:export` scope**, never
  `data:read` — otherwise any admin read key would be a whole-tenant
  exfiltration tool. Session access requires admin+. The export-vs-delete
  race is not locked: an export running while an account is deleted may see
  partially anonymized rows — accepted for a single-workspace instance.
- **`invitations.invited_by` cascade side effect:** invitations issued by
  the deleted user disappear with them (their tokens stop resolving). An
  admin re-invites; acceptable for the template's scale.

## Why

The named consumers of this template are per-tenant deployments that
explicitly require GDPR export + erasure. The files-stay stance keeps the
workspace's business records intact (the alternative — deleting every blob a
person ever uploaded — destroys shared workspace state and is NOT what
art. 17 requires for controller records). Side benefit: file rows now never
hard-delete, so a pagination cursor can never be orphaned mid-walk.

## Revisit when

A product needs per-user file erasure (add an explicit "also delete my
files" flow on top), a workspace-delete flow arrives (its member cascade
must account for the migration-0009 trigger — see the note in that
migration), or a consumer requires a deletion grace period / soft-delete
window.
