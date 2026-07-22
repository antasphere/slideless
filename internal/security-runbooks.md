# Security runbooks

Step-by-step operator recovery and rotation procedures — the runbook
counterparts to the public [security posture](../docs/security/security.md):
2FA lockout recovery, break-glass ownership recovery, and
`AUTH_SECRET`/pepper rotation.

## 2FA lockout recovery

A member who loses BOTH the authenticator and every backup code cannot
complete sign-in, and there is deliberately no admin "disable someone's 2FA"
endpoint (it would make every admin a second-factor bypass). After verifying
the person's identity out of band, the operator either uses the break-glass
`reset-2fa` endpoint (below — superadmin only, audited) or clears the factor
at the database:

```sql
DELETE FROM two_factor WHERE user_id = '<id>';
UPDATE "user" SET two_factor_enabled = false WHERE id = '<id>';
```

(or deletes the account and re-invites). A password reset alone does NOT
disable 2FA — by design.

## Break-glass recovery (`SUPERADMIN_EMAILS`, ADR 010)

**Off by default.** When a workspace ends up with no usable owner (sole
owner locked out, membership state damaged), the operator recovers it
through the break-glass endpoints instead of SQL surgery. The posture
([ADR 010](decisions/010-break-glass-and-orphan-gc.md)):

- **Env allowlist, no DB super-role.** `SUPERADMIN_EMAILS` (comma-separated)
  is the whole switch; unset/empty = the endpoints answer `403` for
  everyone. A malformed entry fails boot loudly.
- **Session + verified email only, never machines.** A caller is superadmin
  only on a Better Auth SESSION whose email is on the list AND verified
  (`user.email_verified`) — accounts accepted via the copyable invite link
  are unverified and do NOT qualify until proven. The paths are deliberately
  unlisted in the machine scope allowlist, so API keys and OAuth tokens 403
  fail-closed even when their owner is listed. Identity is re-read from the
  database by session user id, never from a header.
- **Audited + rate-limited.** Every use lands a `break_glass.*` audit row
  with the superadmin identity and before/after state, plus a warn-level
  log line; the endpoints sit behind a tight per-IP wall.
- **Treat listed accounts as instance-takeover-capable.** Keep the list
  empty except while needed; unset it (and redeploy) when done.

The recovery runbook (no dashboard UI on purpose; superadmin status is never
exposed to users):

1. Add the operator email to `SUPERADMIN_EMAILS` in `.env`, then
   `docker compose up -d` to restart with it.
2. Ensure that account exists and its email is VERIFIED — invite it and
   accept via the token in the invitation EMAIL (not the copyable link), or
   complete an email-change/verification flow. As last resort on a box you
   already administer: `UPDATE "user" SET email_verified = true WHERE email = '<you>';`
3. Sign in with that account, then claim ownership (the session cookie is
   the credential — a membership is NOT required):

   ```bash
   curl -sS -X POST https://<instance>/api/v1/admin/break-glass/claim-ownership \
     -H 'content-type: application/json' -b '<session cookie>' -d '{}'
   # or recover a specific existing user instead:
   #   -d '{"userId":"<better-auth user id>"}'
   # on an instance running SEVERAL workspaces (ADR 014), the target is
   # explicit — the no-argument call answers 400 workspace_required:
   #   -d '{"workspaceId":"<workspace uuid>"}'
   ```

   The call creates/reactivates/promotes the membership to an ACTIVE OWNER
   (it only ever ADDS an owner, so the last-owner trigger is never at risk).
   Do this PROMPTLY: until it runs, the operator account has no membership and
   is therefore an orphaned-user-cleanup candidate — the nightly sweep would
   delete it once it ages past `ORPHAN_USER_RETENTION_HOURS` (72h default).
   Claiming ownership gives it a membership and takes it out of scope.

4. For a 2FA lockout, clear the member's factor:

   ```bash
   curl -sS -X POST https://<instance>/api/v1/admin/break-glass/reset-2fa \
     -H 'content-type: application/json' -b '<session cookie>' \
     -d '{"userId":"<better-auth user id>"}'
   ```

5. Finish the recovery in the dashboard (reset links, role fixes), then
   REMOVE the email from `SUPERADMIN_EMAILS` and restart. Review the
   `break_glass.*` audit entries.

## Rotating `AUTH_SECRET` without breaking API keys

`API_KEY_PEPPERS` holds `<version>:<secret>` entries joined by `;` (secrets
at least 32 chars, entry split at the first colon so secrets may contain
colons). **The loud rule: whenever version 1 appears in `API_KEY_PEPPERS`,
its value MUST be the historical `AUTH_SECRET`-derived pepper** — the secret
that was live when the version-1 keys were minted (if `AUTH_SECRET` was
never set, that is the generated `/data/secret` file's content). Pin
anything else and every existing key stops resolving. The app logs a boot
warning when `API_KEY_PEPPERS` is set without pinning version 1, because
those version-1 keys still silently depend on the live `AUTH_SECRET`.
Design: [ADR 008](decisions/008-api-key-pepper-versioning.md).

To rotate `AUTH_SECRET` (keys keep working, sessions restart):

1. Pin version 1 to the current secret: `API_KEY_PEPPERS=1:<current AUTH_SECRET>`.
   Deploy. Key verification now reads the pinned value, not the live secret.
2. Change `AUTH_SECRET` to the new value. Deploy. Sessions and OAuth JWTs
   are invalidated (users sign in again — expected); every API key keeps
   authenticating via its pinned pepper.

To rotate the pepper itself (e.g. after a suspected leak of the old secret):

1. Add a higher version: `API_KEY_PEPPERS=1:<historical secret>;2:<new random secret>`.
   Deploy. New keys mint under version 2; existing version-1 keys keep
   resolving.
2. Re-mint integrations onto new keys at your own pace. This query says when
   version 1 is retirable:
   `SELECT count(*) FROM api_keys WHERE pepper_version = 1 AND revoked_at IS NULL;`
3. When it reports zero, drop the `1:<...>` entry. Any straggler version-1
   key then fails closed (the standard 401) — it never falls back to
   another pepper.
