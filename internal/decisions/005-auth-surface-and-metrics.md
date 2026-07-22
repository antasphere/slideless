# ADR 005 — Auth-surface and metrics defaults

Status: accepted (2026-07-04)

## Decision

Three defaults on the instance's auth/observability surface, set together in
the post-M8 hardening pass:

- **`/metrics` is default-deny.** The endpoint answers `401` unless
  `METRICS_TOKEN` is set; scrapers authenticate with
  `Authorization: Bearer <token>`, compared in constant time. `setup.sh` and
  the one-liner installer generate the token, so a fresh install scrapes out
  of the box while a hand-written `.env` without the token exposes nothing.
- **Password reset is two-path: self-serve when email delivers, an admin
  copyable link always.** `POST /request-password-reset` auto-enables only
  when an email driver is configured (closed otherwise: a flat 400, no
  user-enumeration oracle). Independently, an owner/admin mints a one-time
  reset link from the Members page; the token lands in Better Auth's own
  `verification` table in the exact shape `POST /reset-password` consumes,
  so both paths converge on one endpoint. Resets revoke the user's other
  sessions and are audited. **Email change** shipped later (M6) on the same
  two-path shape: a self-service verification-mail when a driver delivers,
  plus an admin copyable change-email link for SMTP-less installs (minted via
  `createEmailVerificationToken`, the copyable-link equivalent this bullet had
  originally presumed absent). See security.md.
- **DCR client metadata is scheme-gated.** The oauth-provider plugin
  validates only `redirect_uris`, so a core `hooks.before` rejects any
  non-http(s) `client_uri`/`logo_uri`/`tos_uri`/`policy_uri` on all three
  client write paths (`/oauth2/register`, `/oauth2/create-client`,
  `/oauth2/update-client`), keeping a stored `javascript:` URI from ever
  reaching a render site. The consent page validates again at render.

## Why

All three close default-install holes rather than add features: an open
`/metrics` leaks route names and workload shape to anyone who can reach
port 3000; a copyable reset link keeps account recovery working on the
SMTP-less default install (the invitations pattern, proven); unvalidated DCR
metadata is attacker-controlled content on an unauthenticated endpoint. Each
follows the template's existing posture (fail closed, no email dependency,
validate at the write).

## Revisit when

Email change: when Better Auth ships a change-email flow that supports a
copyable-link fallback, or the first consumer requires self-serve email
change badly enough to make it email-driver-only. Metrics: if a consumer
needs unauthenticated scraping on an isolated network, an explicit
opt-out beats reopening the default.
