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

⚠️ **`AUTH_SECRET` also wraps the OAuth signing key.** The jwt plugin stores
the RS256 private key that signs every access token and id_token in the
`jwks` table, encrypted under `AUTH_SECRET`, with no expiry — so the plugin
never replaces it on its own. Rotating the secret without re-keying token
signing therefore breaks the instance's own OAuth surface: a boot on the
new secret cannot decrypt the stored key, so every `POST /oauth2/token`
would answer **500** while authorize still redirects (ADR 023). Since the
fix, such a boot REFUSES at the signing-key preflight instead of serving a
broken authorize endpoint — the fatal log names this procedure.

To rotate `AUTH_SECRET` (ordered; steps 3 and 5 are what keep OAuth up):

1. Pin version 1 to the current secret: `API_KEY_PEPPERS=1:<current AUTH_SECRET>`.
   Deploy. Key verification now reads the pinned value, not the live secret.
2. Change `AUTH_SECRET` to the new value in `.env`. Do NOT start the app yet
   — it would refuse the preflight.
3. Re-key token signing under the NEW secret:
   `docker compose run --rm app node dist/index.js rotate-signing-key`.
   This mints a fresh signing key (the newest key always signs). Every
   retired key stays PUBLISHED on `/jwks`, so tokens issued before the
   rotation keep verifying — the overlap window.
4. `docker compose up -d`. The boot preflight confirms the new key decrypts.
5. After the overlap window (outstanding access tokens live 15 min; allow
   for any external JWKS caches), retire each old key:
   `docker compose exec app node dist/index.js rotate-signing-key --retire <kid>`
   (step 3 printed the retired kids; `SELECT id FROM jwks;` recovers them —
   the command refuses to delete the active signer).

Effects, stated honestly: sessions are invalidated (users sign in again —
expected); API keys keep authenticating via the pinned pepper; token
signing keeps working via the re-key. Two-factor enrollments do NOT
survive — TOTP secrets and backup codes are encrypted under the live
secret, so enrolled users must re-enroll (or use the 2FA-lockout runbook
above). Plan the rotation with that in mind.

## Rotating the OAuth signing key (compromise drill)

The same command, against a RUNNING instance with an unchanged
`AUTH_SECRET` — the rehearsed answer to a suspected signing-key compromise:

1. `docker compose exec app node dist/index.js rotate-signing-key` — mints
   the replacement; the plugin signs with it from the next token mint, no
   restart needed. The instance's own verifier picks the new key up
   immediately (it refetches `/jwks` once on an unknown `kid`); external
   caches follow within their window.
2. For a COMPROMISE (not a routine rotation), retire the suspect key
   immediately rather than waiting out the overlap:
   `... rotate-signing-key --retire <kid>`. Tokens it signed stop verifying
   as caches roll over — that is the point; users re-authorize.
3. For a routine rotation, wait out the overlap window first (step 5 above).

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
