# Security posture

What the template enforces, and the one rule its consumers must keep.

## Enforced by the chassis

- **Closed sign-up.** Accounts enter through first-boot setup or invitations
  only: the HTTP sign-up endpoint is disabled, OTP signs in existing
  accounts only, social providers have `disableSignUp`. `SETUP_TOKEN` gates
  the wizard against squatters on freshly exposed instances.
- **Optional per-user 2FA (TOTP + backup codes,
  [ADR 009](decisions/009-two-factor-and-invite-verification.md)).** Any
  member can enroll from the account page: password-gated enrollment issues
  an authenticator secret plus 10 one-time backup codes (shown exactly once),
  and 2FA activates only after one TOTP verifies — an abandoned enrollment
  never locks anyone out. An enrolled user's password sign-in AND email-OTP
  sign-in require the code (the email-OTP path is closed by a custom hook —
  the plugin alone would let an emailed code bypass the second factor);
  Google sign-in trusts the IdP's own MFA. Machine credentials (API keys,
  OAuth tokens) never see a 2FA step. Disable is password-gated;
  enable/disable are audited; `/auth/two-factor/*` sits behind the login
  rate-limit wall.
- **Invite-acceptance email verification is honest
  ([ADR 009](decisions/009-two-factor-and-invite-verification.md)).** Every
  invitation has two tokens: the copyable link the inviter sees, and a second
  token that exists only inside the invitation email. Accepting with the
  emailed token proves mailbox control → `emailVerified = true`; accepting
  with the copyable link never flips the flag — instead (when an email
  driver delivers) acceptance fires the verification mail so the address can
  still be proven. An address is never marked verified without proof.
- **Live authorization.** Every request re-checks the workspace membership
  row — deactivating a member instantly kills their sessions, API keys, and
  (M6) OAuth tokens, regardless of cookie/token age.
- **Fail-closed machine access.** API keys and OAuth tokens reach only the
  endpoints consciously listed in `middleware/scopes.ts`, each behind its
  scope. New endpoints are unreachable to machine credentials until opened.
  API keys can carry an optional TTL set at mint; expiry is enforced
  fail-closed at resolution (an expired key answers the same 401 as a
  revoked one) and a nightly sweep normalizes expired keys to revoked.
- **Safe serving of uploads.** Browser-renderable ACTIVE content (HTML, SVG,
  XML) is always `Content-Disposition: attachment` — user content never
  renders on the app origin. Everything carries `nosniff`; HTML we serve is
  locked behind a hash-based CSP with `frame-ancestors 'none'`.
- **Retry-safe creates.** An `Idempotency-Key` header on the create POSTs
  (api-keys, invitations, reset links) replays the original response instead
  of double-creating; cached responses are AES-256-GCM encrypted because
  they carry one-shot secrets.
- **Auth-surface rate limits** (login per-IP+email, OTP per-IP+email, setup,
  invitation acceptance, API-key failure wall, password reset, OAuth client
  registration and token endpoints, and a per-IP wall on `/mcp`),
  socket-derived client identity unless `TRUST_PROXY` opts into the
  rightmost `x-forwarded-for` hop behind a controlled proxy.
- **General per-principal API quota.** Every authenticated `/api/v1` request
  consumes from a bucket keyed by the AUTHENTICATED principal identity — the
  API-key id, the OAuth token subject, or the session user id — never by
  anything client-supplied, so a caller can neither rotate its own bucket
  nor fill another principal's; it is consumed before the scope gate, so
  even fail-closed 403 hammering with a valid credential is bounded.
  Defaults: `API_RATE_LIMIT_PER_MINUTE` (600 sustained) +
  `API_RATE_LIMIT_BURST` (100/s spike cap, which burns no sustained points
  when it rejects); per-plan variation hangs on
  `EntitlementService.getRequestQuota`. Buckets share the auth-limiter
  backend: Redis across replicas when `REDIS_URL` is set, per-replica memory
  otherwise, failing OPEN to the in-memory insurance limiter on a Redis
  outage (availability over throttling — authz stays fail-closed). Limited
  requests answer `429` + `Retry-After`; the handled `2xx` and `429`
  responses carry `RateLimit-*`/`X-RateLimit-*` so agents can self-throttle
  (a downstream `403` from the scope gate consumed a point but is not
  stamped). Public
  discovery, setup, and the auth surfaces keep their own walls and are never
  double-limited.
- **Secrets hygiene.** One zod env schema is the only secrets entry point;
  the auto-generated secret lands in `/data` mode 0600; pino redacts
  passwords, tokens, cookies, and connection strings. Rotating `AUTH_SECRET`
  invalidates sessions and OAuth JWTs (sign in again); API keys survive it
  through versioned peppers — see the rotation runbook below and
  [ADR 008](decisions/008-api-key-pepper-versioning.md).
- **Versioned API-key peppers.** Key secrets are stored as
  `sha256(secret + pepper)` and each row records the pepper version that
  hashed it. Version 1 is always the `AUTH_SECRET`-derived pepper (with no
  extra config the behaviour is byte-identical to a single pepper);
  `API_KEY_PEPPERS` pins or adds versions, new keys mint under the highest
  version, and resolution verifies strictly under the stored row's version —
  a version missing from the registry fails closed with the same 401 as a
  revoked key, never a fallback to another pepper.
- **Container hardening.** Non-root user, tini PID 1, read-only rootfs
  (only `/data` and `/tmp` writable), no secrets in image layers, CI image
  vulnerability scan gating every release.
- **Zero phone-home.** Nothing leaves the instance unless an operator
  configures an exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`) or a rail sink —
  verifiable in code: no other outbound calls exist.
- **GDPR export + delete.** `GET /workspace/export` streams the whole
  workspace as a zip (tables as JSON, audit log as NDJSON, every live blob;
  invitation token hashes and API-key secret hashes never leave) — for an
  admin+ session, or an API key deliberately granted the opt-in
  `data:export` scope (never implied by `presentations:read`, or any admin read key
  would double as a whole-tenant exfiltration tool). Account deletion is
  **sessions only, never machines**: the self-service danger zone
  (password-gated) and the admin Members action; `DELETE /members/{id}` is
  unlisted in the scope allowlist and absent from the CLI — a conscious
  choice, deleting people is a human act. The cascade removes the person
  (sessions, membership, API keys, invitations they issued) while **files
  they uploaded stay with the workspace**, uploader anonymized to NULL, and
  audit history is kept anonymized. The last-owner rule is **race-free**: a
  `workspace_members` trigger (migration 0009) makes a zero-active-owner
  end state impossible under any concurrency, and the HTTP surfaces
  serialize on a per-workspace advisory lock so a concurrent-race loser
  gets a clean `400 last_owner`. Semantics in
  [ADR 006](decisions/006-gdpr-delete-semantics.md).
- **Orphaned-user cleanup.** Users with ZERO workspace memberships (e.g.
  losers of the one-shot setup race: they can sign in but 401 everywhere)
  are garbage-collected by a nightly sweep once older than
  `ORPHAN_USER_RETENTION_HOURS` (default 72; 0 disables). A user with ANY
  membership row — even deactivated — is never touched; deletion runs
  through Better Auth's own cascade path and is audited as
  `user.orphan_purge` (system actor). See ADR 010.
- **CSRF posture.** Better Auth's routes are Origin-checked: any
  cookie-bearing or fetch-metadata-bearing request is validated against the
  trusted origins, and sign-in additionally rejects a foreign `Origin`
  outright even on cookieless requests (M9 — closes the legacy-browser
  login-CSRF/session-fixation window; CLI/SDK/MCP calls carry no Origin and
  are unaffected). The fresh-session (<24 h) no-password `/delete-user`
  window is a Better Auth default: blocked cross-site by that Origin guard
  and by SameSite=Lax, it is only self-triggerable. The custom `/api/v1`
  routes rely on **SameSite=Lax cookies alone** (no per-request Origin
  symmetry check) — every current browser blocks cross-site POSTs with Lax
  cookies; adding Origin symmetry there is a known defense-in-depth item.

## Operator responsibilities

- **`/metrics` is closed by default.** It exposes route names, queue depth,
  storage bytes, and process stats, so it answers `401` until `METRICS_TOKEN`
  is set; scrapers then authenticate with `Authorization: Bearer <token>`
  (compared in constant time). `setup.sh` and the installer generate the
  token automatically — an existing install created before this change must
  add one to start scraping again.
- **Terminate TLS at a reverse proxy** and set `TRUST_PROXY=true` only there
  ([reverse-proxy.md](reverse-proxy.md)).
- **Account recovery when `EMAIL_DRIVER=none`.** Self-service password reset
  and email change both need an email driver (the change mails a verification
  link to the new address). Without one, an owner/admin generates a one-time
  copyable link from the Members page instead — a reset link for recovery, a
  change-email link to move a member's address — the same no-SMTP pattern as
  invitations. The change-email link is sign-in-equivalent; hand it only to
  the member it is for.
- **2FA lockout recovery is an operator action.** A member who loses BOTH
  the authenticator and every backup code cannot complete sign-in, and there
  is deliberately no admin "disable someone's 2FA" endpoint (it would make
  every admin a second-factor bypass). After verifying the person's identity
  out of band, the operator either uses the break-glass `reset-2fa` endpoint
  (below — superadmin only, audited) or clears the factor at the database:
  `DELETE FROM two_factor WHERE user_id = '<id>';
UPDATE "user" SET two_factor_enabled = false WHERE id = '<id>';`
  (or deletes the account and re-invites). A password reset alone does NOT
  disable 2FA — by design.

### Break-glass recovery (`SUPERADMIN_EMAILS`, ADR 010)

**Off by default.** When a workspace ends up with no usable owner (sole
owner locked out, membership state damaged), the operator recovers it
through the break-glass endpoints instead of SQL surgery. The posture:

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

### Rotating `AUTH_SECRET` without breaking API keys

`API_KEY_PEPPERS` holds `<version>:<secret>` entries joined by `;` (secrets
at least 32 chars, entry split at the first colon so secrets may contain
colons). **The loud rule: whenever version 1 appears in `API_KEY_PEPPERS`,
its value MUST be the historical `AUTH_SECRET`-derived pepper** — the secret
that was live when the version-1 keys were minted (if `AUTH_SECRET` was
never set, that is the generated `/data/secret` file's content). Pin
anything else and every existing key stops resolving. The app logs a boot
warning when `API_KEY_PEPPERS` is set without pinning version 1, because
those version-1 keys still silently depend on the live `AUTH_SECRET`.

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

## The rule for products built on this template

**Never render user-uploaded or user-authored markup on the app origin.**
On a single-origin self-hosted box, rendered user content plus dashboard
session cookies equals session theft. A product that must render user
content (e.g. a presentation viewer) does it under a sandboxing CSP without
`allow-same-origin`, or on a separate origin entirely. The files module's
attachment-by-default policy implements this; keep it when extending.

### The one sanctioned exception: the public viewer (Phase 4, ADR 012)

Slideless's whole point is rendering user-authored HTML, so `/v/{secret}`
(apps/server/src/viewer/routes.ts) serves deck content **inline** — under
the exact regime the ADR 012 browser spike proved safe on Chromium, WebKit,
and Firefox:

- Every user-content response carries
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
  allow-modals allow-downloads` (an **opaque origin**: no cookies, no
  storage, no service workers, no credentialed same-origin API),
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
  **Never `allow-same-origin`, never `allow-top-navigation*`** — either one
  re-opens session theft.
- The global `securityHeaders` middleware is guarded to never clobber those
  per-route headers, and regression tests assert the header set on every
  viewer response shape (the protection is one header on one route — treat
  any change there as security-critical).
- Share links are per-recipient 384-bit path secrets, stored hash-only
  (sha256 + the versioned API-key pepper, ADR 008); optional expiry and an
  scrypt-hashed viewer password gate the bytes; revocation is instant
  (`no-store` entries, revalidated assets).
- `VIEWER_BASE_URL` moves share links onto a dedicated user-content origin —
  the ADR 012 hardening path; the sandbox stays on as defense-in-depth.

### The second sanctioned exception: the token-authed annotation surface (Phase 5)

Annotator share links (`can_annotate`) get an overlay client injected into
the viewer's ENTRY HTML (browser navigations only — never `?raw`, never
non-HTML Accepts, never agent-style `x-viewer-password` unlocks; the sandbox
header set is re-asserted on injected responses and the content-sha ETag is
dropped because the bytes are mutated). That overlay runs inside the
sandboxed OPAQUE origin, so it authenticates the way the viewer does — with
the token secret from `location.pathname` — against a deliberately PUBLIC
surface, `GET|POST /api/v1/viewer/{secret}/annotations`
(apps/server/src/viewer/annotations-api.ts):

- **Token-authed, never principal-authed.** Every call re-resolves the
  secret (revoked → 403, expired → 410, unknown → 404) and requires
  `can_annotate`; password-protected tokens must additionally present the
  signed unlock MAC the server injected after the entry passed the password
  gate (or the raw `x-viewer-password`). No cookie, session, or scope is
  ever consulted — and a machine credential presented there dies at the
  fail-closed scope gate (the path is deliberately unlisted).
- **Narrow by construction.** It can only create annotations on, and list
  the token's OWN annotations of, the one deck+version the token resolves
  to; the reviewer wire shape exposes no workspace/deck/user ids.
- **Abuse-bounded.** Creates burn a per-IP+token bucket (60/10 min), failed
  secret resolutions a per-IP one; bodies are zod-validated (10 KB note,
  8 KB selection, 120-char name).
- **CORS is wide open (`*`) on exactly this route pair** because the caller
  sits in an opaque origin (`Origin: null`) and nothing here is
  credentialed — the token in the path is the whole credential, so CORS is
  not the boundary (the public-OAuth-endpoints precedent). The overlay
  itself always fetches `credentials: 'omit'`, closing ADR 012's Firefox
  cookie-forwarding residual on this path.
- **Trust boundary:** the overlay shares the document with hostile deck JS.
  It holds nothing the deck could not already reach (the secret is in the
  URL; the unlock MAC only unlocks annotation calls for this same token),
  so a malicious deck gains no capability beyond spamming its own reviewers'
  notes into its own owner's inbox — bounded by the rate limit.

### Per-deck collaborators (Phase 5)

Dev collaborators are per-deck email grants (ADR 011) claimed through the
invitations pattern: hash-only two-token storage (the emailed token proves
mailbox control and may set `emailVerified`; the copyable link never does),
14-day pending TTL, 10 live grants per deck. Claiming makes a new account an
ordinary workspace MEMBER (the platform authenticates through memberships) —
so a collaborator can read workspace-scoped listings like any member, while
deck WRITE stays gated: an active dev can push versions (recorded as
`created_by_role = 'dev'`), manage the deck's share tokens and annotations,
but never delete the deck or alter its collaborator roster (owner/admin
only). `/collaborators/lookup` + `/collaborators/claim` are public
token-redemption endpoints for humans, rate-limited like invitation
acceptance and deliberately unlisted in the machine scope allowlist.
