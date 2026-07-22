# ADR 010 — Env-allowlist break-glass superadmin + orphaned-user GC

Status: accepted (2026-07-07)

## Context

The per-tenant hosting model needs an instance-level recovery role distinct
from the workspace owner: when a workspace ends up with no USABLE owner (the
sole owner lost their password with `EMAIL_DRIVER=none`, lost their 2FA, or
the membership state was damaged by surgery), the operator must be able to
recover it without raw SQL. Separately, the one-shot setup flow leaves losers
of the claim race as **orphaned users** — Better Auth `user` rows with no
`workspace_members` row that can sign in but 401 everywhere — and nothing
ever cleaned them up.

## Decision — break-glass

**Superadmin is env-derived, never a DB role.** `SUPERADMIN_EMAILS`
(comma-separated, trim-aware, validated loudly at boot) is the entire
capability switch: unset/empty means no superadmin exists and the endpoints
are dormant. A request is superadmin ONLY when all three hold:

1. it carries a Better Auth **session** — the handlers resolve the session
   directly (`auth.api.getSession`), never a header, body field, or bearer;
2. the session user's email (re-read from the DB by user id) is on the
   allowlist;
3. that email is **verified** — an unverified match never qualifies, so
   squatting an allowlisted address (invitations accepted via the copyable
   link stay unverified) is not enough.

**Machines are excluded twice.** `/api/v1/admin/break-glass/*` is
deliberately UNLISTED in the fail-closed scope allowlist
(`middleware/scopes.ts`), so API keys and OAuth tokens answer
`403 endpoint_not_allowed` before the handlers run — even a key minted by
the superadmin themselves. And the session resolution inside the handlers
would reject them anyway. Like account deletion, break-glass is a human act.

**Two capabilities only, both audited with before/after state:**

- `POST /api/v1/admin/break-glass/claim-ownership` — make the calling
  superadmin (or a named existing user) an ACTIVE OWNER: create the
  membership when absent, reactivate + promote when present. It **adds** an
  owner and never removes one, so the migration-0009 last-owner trigger is
  satisfied by construction. No membership is required to call it — a
  membership-less session (`principal` = null) is exactly the state it
  exists to fix, so the route self-authenticates instead of using
  `requireAuth`/`requireRole`, self-audits (`break_glass.claim_ownership`),
  and sits behind its own tight per-IP rate wall.
- `POST /api/v1/admin/break-glass/reset-2fa` — clear a locked-out user's
  second factor (`two_factor` row + `user.two_factor_enabled`), the recovery
  ADR 009 had deferred to manual DB surgery. Audited as
  `break_glass.reset_two_factor`. This does NOT contradict ADR 009's "no
  admin disable-2FA endpoint": workspace admins still have no such surface —
  only the operator-controlled allowlist does, and that operator could
  already do it at the database.

Uniform `403 forbidden` for every rejection reason (dormant / not listed /
unverified) so the endpoint is not an oracle for the allowlist. No schema
change, no migration; the dashboard deliberately has no break-glass UI and
superadmin status is never exposed to normal users. Invocation is
API/CLI-by-curl — runbook in [security-runbooks.md](../security-runbooks.md).

**Rejected alternative:** a `user.is_superadmin` column. A persistent DB
super-role survives compromise of any admin surface that can write users, is
invisible to the operator's config review, and outlives the incident it was
created for. The env allowlist is visible in one place, versioned with the
deployment, and disarmable by unsetting a variable.

## Decision — orphaned-user GC

A nightly pg-boss job (`orphan-user-purge`, 03:00, worker role — the
audit-purge pattern) deletes users that have **zero** `workspace_members`
rows and are older than `ORPHAN_USER_RETENTION_HOURS` (default 72; 0
disables the sweep and its schedule).

Safety invariants, in order of importance:

- **A user with ANY membership row — active or deactivated — is never a
  candidate.** Deactivated members are real users, not orphans.
- **The grace period** keeps a mid-setup user alive (setup is one-shot and
  fast; 72h is paranoid on purpose).
- **A live pending invitation for the orphan's email excludes them**: a
  re-invited orphan is mid-onboarding, and because the invitation row exists
  before its accept URL does, this closes the scan-then-accept race for the
  invited case. A final membership re-check runs immediately before each
  delete as well; the residual window (membership committed between that
  re-check and the delete) is microseconds against a nightly cadence, and
  the 0009 trigger backstops the only catastrophic variant (the user having
  become a sole active owner) by aborting that delete.
- **Deletion goes through Better Auth's `internalAdapter.deleteUser`** — the
  exact path both GDPR delete surfaces use — so sessions, accounts, and keys
  cascade FK-safe. Bounded batches (50/iteration, capped iterations,
  no-progress break), one system-actor `user.orphan_purge` audit row per run
  that deleted anything (count + bounded email sample in metadata).

## Consequences

- Recovery of a locked-out instance is a config change (add the email, have
  that account verified) + one curl, instead of SQL surgery.
- The operator must keep `SUPERADMIN_EMAILS` empty except while needed, or
  accept that the listed accounts are workspace-takeover-capable; the docs
  say so explicitly.
- Orphaned users stop accumulating; `ORPHAN_USER_RETENTION_HOURS=0` restores
  the old keep-forever behavior.
