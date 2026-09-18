# Security posture

What a Slideless instance enforces out of the box, what its operator is
responsible for, and the rules that govern rendering user content.

## Enforced by every instance

- **Closed sign-up.** Accounts enter through first-boot setup or invitations
  only: the HTTP sign-up endpoint is disabled, OTP signs in existing
  accounts only, social providers have `disableSignUp`. The setup wizard
  always requires a token (`SETUP_TOKEN`, or one the server generates into
  the data volume and logs at first boot) — squatters never get a free claim
  on a freshly exposed instance.
- **Optional per-user 2FA (TOTP + backup codes).** Any
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
- **Invite-acceptance email verification is honest.** Every
  invitation has two tokens: the copyable link the inviter sees, and a second
  token that exists only inside the invitation email. Accepting with the
  emailed token proves mailbox control → `emailVerified = true`; accepting
  with the copyable link never flips the flag — instead (when an email
  driver delivers) acceptance fires the verification mail so the address can
  still be proven. An address is never marked verified without proof.
- **Live authorization.** Every request re-checks the workspace membership
  row — deactivating a member instantly kills their sessions, API keys, and
  OAuth tokens, regardless of cookie/token age.
- **Fail-closed machine access.** API keys and OAuth tokens reach only the
  endpoints consciously listed in `middleware/scopes.ts`, each behind its
  scope. New endpoints are unreachable to machine credentials until opened.
  API keys can carry an optional TTL set at mint; expiry is enforced
  fail-closed at resolution (an expired key answers the same 401 as a
  revoked one) and a nightly sweep normalizes expired keys to revoked.
- **Safe serving of uploads.** Browser-renderable ACTIVE content (HTML, SVG,
  XML) is always `Content-Disposition: attachment` — user content never
  renders on the app origin. Everything carries `nosniff`; HTML we serve is
  locked behind a hash-based CSP with `frame-ancestors 'none'`. Files that
  share-link respondents upload into a form's file field are held to a
  stricter rule: always `attachment`, whatever their type (see "The form
  surface and the files it takes" below).
- **Retry-safe creates.** An `Idempotency-Key` header on the create POSTs
  (API keys, invitations, reset and change-email links, upload sessions,
  share-link creation, deck duplicate) replays the original response instead
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
  invalidates sessions (sign in again); API keys survive it through
  versioned peppers (next item), and OAuth token signing survives it
  through the `rotate-signing-key` re-key step in the rotation procedure —
  skipping that step fails loudly at the boot preflight instead of 500ing
  in production.
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
- **Zero phone-home.** No telemetry, no update check. The instance talks only
  to what you configure: the mail driver (SMTP or Resend), an S3 bucket,
  Redis, Google sign-in, an OTLP exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`),
  and on the cloud edition the Antasphere hub.
- **Workspace export + account deletion.** `GET /workspace/export` streams a
  zip of the workspace record, its member roster, invitations, workspace-pinned
  API keys, the audit log (NDJSON), file metadata and every live blob
  (invitation token hashes and API-key secret hashes never leave). **It is not
  yet a complete data-portability export:** decks, versions, share links,
  collaborators, annotations, form responses and view events are not in it;
  read those through the API or the CLI. It answers an admin or owner only, by
  session or by a key of theirs that also carries the opt-in `data:export`
  scope (never implied by `presentations:read`, or any admin read key
  would double as a whole-tenant exfiltration tool). A `presentations:read`
  key is bounded by its owner's own reach: for a plain member that is the
  decks they own or collaborate on, down to the raw blobs
  ([viewer-security-model.md](viewer-security-model.md)); for an admin or
  owner it is the workspace, because the operator view is theirs by role,
  key or no key. Account deletion is
  **sessions only, never machines**: the self-service danger zone
  (password-gated) and the admin Members action; `DELETE /members/{id}` is
  unlisted in the scope allowlist and absent from the CLI — a conscious
  choice, deleting people is a human act. The cascade removes the person
  (sessions, membership, API keys, invitations they issued) while **files
  they uploaded stay with the workspace**, uploader anonymized to NULL. **Audit
  history is kept, and it is not fully anonymized:** earlier rows keep their
  action, IP and metadata with the actor link nulled, the deletion itself is
  recorded with the erased email, and per-deck collaborator rows keep the
  invited email. The last-owner rule is **race-free**: a
  `workspace_members` trigger (migration 0009) makes a zero-active-owner
  end state impossible under any concurrency, and the HTTP surfaces
  serialize on a per-workspace advisory lock so a concurrent-race loser
  gets a clean `400 last_owner`.
- **Orphaned-user cleanup.** Users with ZERO workspace memberships (e.g.
  losers of the one-shot setup race: they can sign in but 401 everywhere)
  are garbage-collected by a nightly sweep once older than
  `ORPHAN_USER_RETENTION_HOURS` (default 72; 0 disables). A user with ANY
  membership row — even deactivated — is never touched; deletion runs
  through Better Auth's own cascade path and is audited as
  `user.orphan_purge` (system actor).
- **CSRF posture.** Better Auth's routes are Origin-checked: any
  cookie-bearing or fetch-metadata-bearing request is validated against the
  trusted origins, and sign-in additionally rejects a foreign `Origin`
  outright even on cookieless requests (closes the legacy-browser
  login-CSRF/session-fixation window; CLI/SDK/MCP calls carry no Origin and
  are unaffected). The fresh-session (under 24 h) no-password `/delete-user`
  window is a Better Auth default: blocked cross-site by that Origin guard
  and by SameSite=Lax, it is only self-triggerable. The custom `/api/v1`
  routes are covered by a **cross-site gate of their own**
  (`middleware/cross-site.ts`): every unsafe method under
  `/api/v1` is refused when `Sec-Fetch-Site` says `cross-site`, or when an
  `Origin` arrives that is neither the serving origin nor `PUBLIC_BASE_URL`
  — and, when `VIEWER_BASE_URL` splits the origins, the viewer
  origin is refused outright, even when it is the serving origin: deck script
  lives there, and `middleware/host-gate.ts` keeps the dashboard, sign-in and
  the cookie-authed API off that hostname altogether.
  Exempt, each deliberately and each with a test: safe methods;
  `Authorization`-bearing calls (API keys and OAuth bearers are not ambient
  credentials); the wildcard-CORS OAuth endpoints (`middleware/oauth-public.ts`);
  and **`/api/v1/viewer/*`**, the share-token annotation API, which the overlay
  client calls from inside the sandboxed iframe whose Origin is the opaque
  `null`. The **share-link viewer itself (`/v/:secret`) is mounted on the root
  app and is not behind this gate at all** — it is deliberately embeddable
  cross-origin (`/embed.js`), password-form POST included. Neither
  viewer surface is cookie-authenticated: the share secret in the path is the
  credential, so neither is the ambient-credential class this closes.
- **The raw request path never reaches the log stream or a trace.** This was
  the live critical here, not a hypothetical: the viewer route is literally
  `/v/:secret`, so logging `c.req.path` wrote every working share capability
  into the logs and (as `url.path`) into the trace backend. Both now carry the
  MATCHED ROUTE PATTERN (`route-label.ts`); pino redaction could never have
  helped, because it keys off object properties and `path` is one opaque
  string.
- **Free text is NUL-free at the contract.** `plainText()` in
  `@slideless/contract` refuses NUL and the invisible C0 controls on every
  user-supplied name/label (deck title, share-token name, annotation body,
  collaborator/invitation names, API key names, setup, filenames). The
  share-token annotation API keeps its own INLINE schema in
  `viewer/annotations-api.ts` — the most anonymously-reachable free-text write
  on the instance, since a reviewer needs no account — so it is guarded there
  explicitly with `noControlChars`. `app.onError` maps SQLSTATE 22021/22P05 to
  400 as the backstop; before this, a NUL surfaced as a 500 whose error log
  printed the statement and its bound parameters.
- **Request JSON is depth-capped at 100** (`middleware/json-depth.ts`).
  `JSON.parse` swallows any nesting but `JSON.stringify` is recursive and
  throws `RangeError` on the shipped `node:22-alpine` (measured on v22.23.1:
  depth 1000 fine, depth 5000 throws; host Node 25 reproduces neither).
- **The OpenAPI document is a boot-time buffer** (`api/openapi-doc.ts`), not a
  per-request generation on an unauthenticated path.
- **Authenticated JSON is `Cache-Control: no-store`**
  (`middleware/no-store.ts`); the viewer and public discovery keep their own.
- **HSTS** rides every response when `PUBLIC_BASE_URL` is https
  (`HSTS_MAX_AGE`, default 180 days, `0` disables), set-if-absent so it never
  disturbs the viewer's sandbox headers.
- **`AUTH_SECRET` must look random** (entropy floor, not just `min(32)`), and
  every URL knob is http(s)-only — including `VIEWER_BASE_URL`, where a
  non-http scheme would be a redirect primitive on the user-content origin.
- **The login wall consumes on FAILURE, not on arrival**, so nobody can lock an
  account out by typing its address ten times. Residual, stated plainly: an
  attacker's failed guesses still drain the victim's bucket, which is inherent
  to any per-account brute-force wall.
- **Dynamic client registration has an off switch**
  (`OAUTH_DYNAMIC_CLIENT_REGISTRATION`, default `true` = unchanged behaviour).

- **The client side is treated as a target too.** A deck bundle is content
  someone else authored, and the CLI materializes it on a developer's
  machine, so the manifest-path contract refuses dot-prefixed segments
  (`.git/**`, `.env`, `.npmrc`, `.github/**`) and `package.json` /
  the lockfiles at COMMIT, and `slideless pull` re-checks every path, caps
  each blob at its declared size, verifies its sha256 before writing,
  refuses to follow a symlink (file or directory), and never leaves a
  written file executable. `slideless files download` writes only the
  BASENAME of the server-chosen stored name, inside the directory the caller
  chose. `slideless dev` resolves through `realpath` and validates the
  `Host` header, so neither a symlink in the deck folder nor a
  DNS-rebinding page turns the preview server into a filesystem reader. Any
  content the CLI prints in human mode is stripped of terminal control
  sequences (`--json` stays byte-exact).

## Operator responsibilities

- **`/metrics` is closed by default.** It exposes route names, queue depth,
  storage bytes, and process stats, so it answers `401` until `METRICS_TOKEN`
  is set; scrapers then authenticate with `Authorization: Bearer <token>`
  (compared in constant time). `setup.sh` and the installer generate the
  token automatically — an existing install created before this change must
  add one to start scraping again.
- **Terminate TLS at a reverse proxy** and set `TRUST_PROXY=true` only there
  ([reverse-proxy.md](../self-hosting/reverse-proxy.md)).
- **Account recovery when `EMAIL_DRIVER=none`.** Self-service password reset
  and email change both need an email driver (the change mails a verification
  link to the new address). Without one, a workspace **owner** generates a
  one-time copyable link from the Members page instead — a reset link for
  recovery, a change-email link to move a member's address — the same no-SMTP
  pattern as invitations. The change-email link is sign-in-equivalent; hand it
  only to the member it is for. Both links are refused for a per-deck guest
  and for any member who also belongs to another workspace: a `user` account
  is instance-global, so such a link would reach a workspace the minter has
  no authority over. Those people recover self-service, or through the
  operator's break-glass surface.
- **2FA lockout recovery is an operator action.** A member who loses BOTH
  the authenticator and every backup code cannot complete sign-in, and there
  is deliberately no admin "disable someone's 2FA" endpoint (it would make
  every admin a second-factor bypass). After verifying the person's identity
  out of band, the operator clears the factor through the break-glass
  recovery path below (superadmin only, audited), or deletes the account and
  re-invites. A password reset alone does NOT disable 2FA — by design.
- **Break-glass recovery is off by default.** When a workspace ends up with
  no usable owner (sole owner locked out, membership state damaged), the
  operator recovers it through audited break-glass endpoints instead of SQL
  surgery. `SUPERADMIN_EMAILS` (comma-separated) is the whole switch —
  unset/empty means the endpoints answer `403` for everyone. A caller
  qualifies only on a SESSION whose email is on the list AND verified;
  machine credentials (API keys, OAuth tokens) always fail closed. Every use
  lands a `break_glass.*` audit row behind a tight per-IP wall. Treat listed
  accounts as instance-takeover-capable: keep the list empty except while
  needed, and unset it (with a redeploy) when done.
- **Secret rotation is supported without breaking API keys or OAuth.**
  Rotating `AUTH_SECRET` invalidates sessions (users sign in again);
  existing API keys keep resolving as long as their pepper version is pinned
  in `API_KEY_PEPPERS`, and token signing keeps working when the ordered
  procedure is followed: pin version 1 to the historical secret, change
  `AUTH_SECRET`, re-key signing with
  `docker compose run --rm app node dist/index.js rotate-signing-key`, then
  start. A boot whose stored signing key no longer decrypts under the
  current secret is refused at a preflight with the remedy in the message —
  never a booted instance that 500s on every token mint.

## The rule for rendering user content

**Never render user-uploaded or user-authored markup on the app origin.**
On a single-origin self-hosted box, rendered user content plus dashboard
session cookies equals session theft. A product that must render user
content (e.g. a presentation viewer) does it under a sandboxing CSP without
`allow-same-origin`, or on a separate origin entirely. The files module's
attachment-by-default policy implements this; keep it when extending.

### The one sanctioned exception: the public viewer

Slideless's whole point is rendering user-authored HTML, so `/v/{secret}`
(apps/server/src/viewer/routes.ts) serves deck content **inline** — under
the exact regime a dedicated browser spike proved safe on Chromium, WebKit,
and Firefox:

- Every user-content response carries
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox
allow-modals allow-downloads` (an **opaque origin**: no cookies, no
  storage, no service workers, no credentialed same-origin API),
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
  **Never `allow-same-origin`, never `allow-top-navigation*`** — either one
  re-opens session theft. `allow-popups-to-escape-sandbox` is deliberate: it
  lifts the sandbox on the windows a deck opens (so an application opened
  from a deck can boot), never on the deck itself.
- The global `securityHeaders` middleware is guarded to never clobber those
  per-route headers, and regression tests assert the header set on every
  viewer response shape (the protection is one header on one route — treat
  any change there as security-critical).
- Share links are per-recipient 384-bit path secrets, stored hash-only
  (sha256 + the versioned API-key pepper); optional expiry and an
  scrypt-hashed viewer password gate the bytes; revocation is instant
  (`no-store` entries, revalidated assets).
- `VIEWER_BASE_URL` moves share links onto a dedicated user-content origin —
  the recommended hardening once share links leave your team
  ([viewer-security-model.md](viewer-security-model.md)); the sandbox stays
  on as defense-in-depth.

### The second sanctioned exception: the token-authed annotation surface

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
  itself always fetches `credentials: 'omit'`, closing the Firefox
  cookie-forwarding residual the browser spike had left open on this path.
- **Trust boundary:** the overlay shares the document with hostile deck JS.
  It holds nothing the deck could not already reach (the secret is in the
  URL; the unlock MAC only unlocks annotation calls for this same token),
  so a malicious deck gains no capability beyond spamming its own reviewers'
  notes into its own owner's inbox — bounded by the rate limit.

### The form surface and the files it takes

A share link with forms on (`can_submit_forms`) gets a forms client injected
the same way, talking to the same kind of public, token-authed surface under
`/api/v1/viewer/{secret}/forms/…`: the share secret is the credential, every
call re-resolves it, no cookie or principal is ever consulted, CORS is `*`,
and a machine credential dies at the scope gate. Submissions are zod-validated
(128 fields, 32 KiB serialized), rate-limited per IP and token (30/10 min) and
capped at 10,000 responses per deck.

A form with a file field adds the one **anonymous write path that takes
bytes**: `POST /api/v1/viewer/{secret}/forms/{form}/uploads`, one file per
request as a raw streamed body. What bounds it:

- **Three conditions, re-checked on every request.** The link has forms on,
  the link has uploads on (`can_upload_files`), and the instance allows them
  (`FORMS_MAX_UPLOAD_MB` above 0). New links have uploads on; every link
  minted before file fields existed has them off until its owner turns them
  on, so an upgrade never gives a link in circulation a write capability.
  Preview tokens never take a file. Anything else answers
  `403 uploads_disabled`.
- **Three byte ceilings, all the instance's.** One file
  (`FORMS_MAX_UPLOAD_MB`, default 100, never above `MAX_FILE_SIZE_MB`),
  enforced while the body streams, whatever `Content-Length` said; the files
  one response can hold (`FORMS_MAX_FILES_PER_RESPONSE`, default 100); and
  the total weight of one deck's form uploads
  (`FORMS_MAX_UPLOADS_MB_PER_DECK`, default 5120), which counts files not yet
  submitted and is re-checked under a per-deck lock so concurrent uploads
  cannot pass it together. That last number is the bound on what a share
  link can write to the instance's disk.
- **Its own rate bucket**: uploads and removals, per IP and token
  (60/10 min).
- **An upload is bound to where it came from.** A submit attaches an upload
  only through the same link, on the same form and field, on the same deck,
  once. An id that does not match refuses the whole submit. A file nobody
  submitted is deleted by a nightly job once it is 24 hours old.
- **The author's rules are not a server control.** The accepted types and
  the counts a deck author writes on the input are enforced in the
  respondent's browser. Someone who calls the route directly can store any
  type of file within the ceilings above. The server does not inspect or
  scan what it stores: whoever downloads a respondent's file should treat it
  as untrusted.
- **The bytes never come back through the viewer surface.** No token-authed
  route serves an uploaded file: a returning respondent gets names and
  sizes. A share secret, even one that remembers answers, is never a
  download URL for what was sent through it.
- **Never rendered, anywhere.** The owner-side downloads
  (`/api/v1/presentations/{id}/responses/…/files/{fileId}` and the two zip
  routes) are gated like the responses themselves (404, never 403) and
  always answer `Content-Disposition: attachment` with `nosniff`, PDFs and
  images included. An anonymous stranger's bytes never render on the app
  origin. Both zip downloads are audited.
- **Stored apart from deck content.** These files never enter the
  workspace's content-addressed file pool: no dedupe (so "already present"
  can never tell an anonymous caller that some bytes exist), no listing on
  the generic `/files` surface, and nothing a deck version can reference. A
  respondent cannot plant an asset in a deck.
- **Names are untrusted text.** The file name is cut to a base name with no
  control or bidi characters and no leading dot; the zip routes rebuild every
  entry path from single sanitized segments; the CLI never joins a
  server-provided name into a path. Every sink still escapes them.

### Per-deck collaborators

Dev collaborators are per-deck email grants claimed through the
invitations pattern (a deck owner can invite colleagues; inviting an outside
email needs a workspace admin or owner): hash-only two-token storage (the emailed token proves
mailbox control and may set `emailVerified`; the copyable link never does),
14-day pending TTL, 10 live grants per deck. Claiming gives a new account a
`guest`-origin membership that exists only so it can authenticate: it opens
that one deck's surfaces and nothing workspace-level (no file cabinet, no
roster, no export, no deck creation). Deck WRITE stays gated: an active dev can push versions (recorded as
`created_by_role = 'dev'`), manage the deck's share tokens and annotations,
but never delete the deck or alter its collaborator roster (owner/admin
only). `/collaborators/lookup` + `/collaborators/claim` are public
token-redemption endpoints for humans, rate-limited like invitation
acceptance and deliberately unlisted in the machine scope allowlist.
