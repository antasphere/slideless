# ADR 009 — Optional 2FA (TOTP + backup codes) and honest invite verification

Status: accepted (2026-07-07)

## Decision

**Two-factor authentication** ships via Better Auth's `twoFactor` plugin at
the pinned 1.6.15 (same trio as ADR 001 — no version bump):

- **Opt-in per user, never org-forced.** Each member enables it from the
  account page; the instance carries no policy switch. Discovery reports the
  capability as `auth.twoFactor` in `GET /api/v1/instance`.
- **TOTP + one-time backup codes only.** The plugin's email-OTP second factor
  (`otpOptions.sendOTP`) is deliberately NOT wired: an emailed code as
  "second factor" collapses into the first factor for anyone who controls
  the mailbox.
- **Enrollment is pending until proven.** `/two-factor/enable`
  (password-gated) issues the secret + 10 one-time backup codes but does NOT
  flip `user.twoFactorEnabled`; the first verified TOTP does. A user who
  never finishes enrollment keeps single-step sign-in — no lockout from an
  authenticator that was never set up. Disable is password-gated and deletes
  the secret + remaining backup codes.
- **Second factor covers password AND email-OTP sign-in.** The plugin's own
  sign-in hook only intercepts `/sign-in/email` — `/sign-in/email-otp` would
  bypass the second factor entirely. A custom after-hook in
  `identity/better-auth.ts` mirrors the plugin's dance for the email-OTP
  path (drop the minted session, park the pending sign-in behind the signed
  `two_factor` cookie, answer `{ twoFactorRedirect: true }`), verified live
  by the integration suite. **Google sign-in is IdP-trust:** an enrolled
  user signing in with Google is authenticated by Google's own MFA posture;
  the template does not stack a second TOTP on top (Better Auth has no hook
  seam on the OAuth callback redirect, and IdP-side MFA is the industry
  posture). Documented, not hidden.
- **Machine principals never see a 2FA step.** API keys and OAuth bearer
  tokens do not pass through sign-in; nothing changed in their paths, and the
  suite pins it.
- **Schema via the drift guard, as always.** The plugin's `two_factor` table
  and `user.two_factor_enabled` column were regenerated with the pinned CLI
  (snapshot + `packages/db/src/auth-schema.ts`) and landed as the additive
  migration 0011. `/auth/two-factor/*` sits behind the same per-IP login
  rate-limit wall as the other credential surfaces, and enable/disable are
  audited (`user.two_factor_enroll` / `user.two_factor_disable`).
- **Recovery when both the authenticator and the backup codes are lost is an
  OPERATOR action.** There is deliberately no admin "disable someone's 2FA"
  endpoint in v1 (it would make every admin a 2FA-bypass oracle). The
  operator escape hatch is DB surgery documented in security.md; the
  softer alternative is delete + re-invite.

**Email verification on invite acceptance** follows one honesty rule: never
mark an address verified without proof of mailbox control.

- The invitation create response has ALWAYS handed the inviter a copyable
  accept link — so possession of that token can never prove the invitee's
  address, even when the same token was also emailed. The fix is **two
  tokens, one invitation** (migration 0012, `invitations.email_token_hash`):
  the copyable link keeps its token; the invitation email carries a second
  token that no admin surface ever returns.
- Accepting with the **emailed token** proves mailbox control →
  `emailVerified = true` on accept.
- Accepting with the **copyable link** proves nothing → the account stays
  unverified; when an email driver delivers, acceptance fires Better Auth's
  verification mail (the M6 plumbing — same `sendVerificationEmail` wiring
  as email change) so the address can still be proven with one click.
  Best-effort: a failed send never blocks the membership.
- With **no email driver** there is no emailed token in flight and no
  verification mail; the account is unverified and documented as such —
  exactly the pre-existing template posture, now deliberate instead of
  accidental.
- Both tokens die together on accept/revoke/expiry (same row, same
  `accepted_at` gate); pre-migration invitations simply have no emailed
  token and behave like copyable links.

## Why

A 2026 auth starter should offer 2FA, and this template's closed-sign-up,
self-hosted posture makes TOTP the right default: no SMS vendor, no SMTP
dependency, works air-gapped. Backup codes cover device loss without a
support channel. The email-OTP bypass closure and the refusal to wire the
emailed second factor both follow from the same threat model: the mailbox is
one factor, never two. For invitations, the copyable link is the product
(zero-SMTP onboarding) — so honesty required either a second, email-only
token or never verifying; the dual token keeps the frictionless emailed flow
AND a truthful `emailVerified` bit.

## Revisit when

- Better Auth ships a coherent >1.6.15 trio: re-verify the two-factor
  plugin's sign-in hook matcher (does it still skip `/sign-in/email-otp`?),
  the `two_factor` cookie dance mirrored in `identity/better-auth.ts`, and
  the drift snapshot.
- A product needs org-forced 2FA, WebAuthn/passkeys, or an admin-side 2FA
  reset — all deliberate non-goals of this slice.
- Session-management UI lands (production-readiness P1): trusted-device
  handling (`trustDevice`) was deliberately left unused by the dashboard.
