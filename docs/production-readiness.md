# Production-readiness: gaps, debt, and roadmap

An honest, self-critical audit of the template written right after it first
went green. The chassis is solid and well-architected; this document is the
list of things a skeptic would demand before betting a real client
engagement on it. Nothing here is a reason not to use the template — it is
the map of what "complete production starter" still requires.

Severity: **P0** blocks a real client build · **P1** first real deployment
needs it · **P2** completeness/polish. Effort: **S** hours · **M** a day or
two · **L** a milestone.

## Session update (2026-07-04)

The P0 list is cleared: login rate-limit keying, password reset + account
recovery, self-service account management, the SDK drift guard, and the CLI
all shipped. Also landed: default-closed `/metrics`, audit retention, bounded
list endpoints, request body caps, pool + pg-boss tuning, Dependabot, and the
contributor hygiene files. Each checked item below carries a note on how;
everything still unchecked remains genuinely open.

---

## Critical — fix before building a client product on this

- [x] **P0 · S — Password login rate limiting was defeated on the default
      install.** `/auth/sign-in/*` keyed by IP only; on a plain
      `docker compose up` with no reverse proxy Docker NAT collapses every
      external client onto the bridge gateway IP, turning all per-IP buckets
      into one global bucket. (Fixed: login and OTP key by IP AND email via
      `emailKeyOf` in `api/index.ts`, so per-account protection holds
      regardless of IP collapse; under `TRUST_PROXY` the client IP is the
      rightmost `x-forwarded-for` hop only, and the NAT reality is documented
      in `middleware/rate-limit.ts` + reverse-proxy.md.)
- [x] **P0 · M — No password reset / account recovery.** (Shipped: self-serve
      `/request-password-reset` when an email driver delivers; an
      admin-generated copyable reset link always works (`api/members.ts`
      `/members/:id/reset-link`, the invitations' no-SMTP pattern), consumed
      by the dashboard `/reset-password` page, with `/forgot-password` for
      the self-serve path. Resets revoke other sessions and are audited.)
- [x] **P0 · M — No self-service account management.** (Shipped: the
      `/account` page covers own name, password, and email change. Email
      change (M6) uses Better Auth's verification-mail flow — a link to the
      new address when an email driver delivers, or an admin-generated
      copyable change-email link when it does not; see security.md.)
- [x] **P0 · M — The SDK is hand-written and will silently drift from the
      contract.** Done differently than proposed (OpenAPI codegen was
      over-scoped — it can't express the Better Auth wrapper methods and would
      lose the hand-written ergonomics). Request/response _shapes_ already
      fail typecheck (the SDK annotates every method with contract types); the
      remaining gap — the method/path string literals — is now closed by
      `packages/sdk/test/route-coverage.test.ts`, which walks every contract
      route and fails CI when one lacks a matching SDK method or a path/method
      drifts.
- [x] **P0 · L — No CLI, despite "agents as first-class API consumers" being
      the template's thesis.** (Shipped: `packages/cli`, a thin typed CLI
      over the SDK exposing the `platform` binary: API-key auth, discovery
      via `/api/v1/instance`, whoami, files commands, `--json` output. See
      docs/cli.md.)

## Auth & account completeness (P1)

- [x] **2FA (TOTP).** (Shipped, ADR 009: opt-in per-user TOTP + 10 one-time
      backup codes via Better Auth's `twoFactor` plugin at the pinned 1.6.15.
      Enrollment is password-gated and pending until one TOTP verifies;
      password AND email-OTP sign-ins then require the second factor (the
      email-OTP bypass is closed by a custom hook — the plugin only covers
      password sign-in); Google sign-in trusts the IdP's MFA; machine
      principals never see a 2FA step. Migration 0011 (`two_factor` +
      `user.two_factor_enabled`) came through the drift guard; discovery
      reports `auth.twoFactor`. Deliberate v1 gaps: no admin 2FA reset
      (operator DB action, security.md), no trusted-device UI, no
      org-forced policy.)
- [x] **Email verification on invite acceptance.** (Shipped, ADR 009:
      invitations now carry a second token that exists ONLY in the invitation
      email (migration 0012). Accepting with it proves mailbox control →
      `emailVerified = true`; accepting with the admin-visible copyable link
      never flips the flag — instead, with a delivering email driver, the
      accept fires Better Auth's verification mail (the M6 plumbing). With no
      driver the account stays honestly unverified, as before.)
- [ ] **Session management UI** — users can't see or revoke their active
      sessions/devices; no login history / security-event view.
- [x] **API key expiry.** `api_keys` had no `expires_at` column; keys lived
      forever. (Shipped: optional `expiresInDays` at mint computes an
      absolute `expires_at` (migration 0006), resolution rejects an expired
      key with the same fail-closed 401 as a revoked one, and a nightly
      03:00 sweep in `jobs/pgboss.ts` normalizes expired keys to
      `revoked_at`.)
- [x] **Orphaned-user cleanup.** A setup that loses the concurrent claim
      race leaves a Better Auth user with no membership (can sign in, 401s
      everywhere). Documented but never garbage-collected — they accumulate.
      (Shipped, ADR 010: a nightly 03:00 pg-boss sweep deletes users with
      ZERO `workspace_members` rows once older than
      `ORPHAN_USER_RETENTION_HOURS` (default 72; 0 disables). A user with
      ANY membership — even deactivated — is never a candidate; an orphan
      with a live pending invitation is skipped (mid-onboarding), and a
      final membership re-check runs right before each delete. Deletion
      goes through Better Auth's own `internalAdapter.deleteUser` (sessions
      and accounts cascade), bounded batches, audited as
      `user.orphan_purge` with the count. Proven by
      `test/integration/orphan-purge.test.ts`.)
- [x] **`AUTH_SECRET` rotation is a hard cutover.** It was the API-key pepper
      _and_ the session/JWKS secret, so rotating it logged everyone out and
      broke every integration at once. (Fixed for API keys, ADR 008: peppers
      are versioned — `api_keys.pepper_version` (migration 0010, backfilled
      to 1) records which pepper hashed each key, `API_KEY_PEPPERS` pins or
      adds versions (version 1 stays the historical AUTH_SECRET-derived
      pepper), mint uses the highest version, and resolution fails closed on
      an unknown version with the same 401 as a revoked key. The rotation
      runbook in security.md is proven end to end by
      `test/integration/apikey-pepper-rotation.test.ts`: keys minted under
      v1 and v2 both authenticate after a real AUTH_SECRET change. Honest
      residue: sessions and OAuth JWTs still ride AUTH_SECRET, so rotating
      it still signs users out — expected and deliberately separate.)

## Security hardening (P1)

- [x] **General-API rate limiting / per-key quotas.** Only auth surfaces were
      limited; a valid API key or OAuth token could hammer any endpoint
      unbounded. (Shipped: every authenticated `/api/v1` request consumes a
      per-principal bucket — keyed by API-key id / OAuth subject / session
      user id, never a client header — enforced inside `authContext` after
      credential resolution and before the scope gate, so even fail-closed
      403 hammering is bounded. Quota values hang on
      `EntitlementService.getRequestQuota` (sustained per-minute + 1 s spike
      cap; env defaults `API_RATE_LIMIT_PER_MINUTE=600`,
      `API_RATE_LIMIT_BURST=100`, 0 disables), so a plan-aware edition varies
      them per principal with no middleware change. Buckets ride the same
      rate-limiter-flexible backend as the auth walls: Redis-shared across
      replicas when `REDIS_URL` is set (the I2 drill path), per-replica
      memory otherwise, fail-open to the insurance limiter on Redis outage.
      429 + `Retry-After` + `RateLimit-*`/`X-RateLimit-*` headers on every
      counted response. Sessions are included — the default is far above
      dashboard rates. Per-key PERSISTED quota overrides (a DB column) remain
      deliberately out: quotas stay config/entitlement-driven in the
      template.)
- [ ] **Upload validation / malware scanning.** We serve user files as
      `attachment`+`nosniff` (good) but never scan them. A file-accepting
      platform should have a ClamAV-style scan hook or a documented
      quarantine step.
- [x] **No request body-size limit** except the file cap. (Fixed: a 1 MiB
      `bodyLimit` on `/api/v1` with the file-streaming routes exempt, plus a
      separate 1 MiB cap on `/mcp`.)
- [x] **No idempotency keys on mutations.** A retried POST (network blip) can
      double-create. (Shipped: an opt-in `Idempotency-Key` header on the
      create POSTs (api-keys, invitations, reset links) claims a row in
      `idempotency_keys` (migration 0007) before the handler runs and replays
      the original response — AES-256-GCM encrypted at rest, the bodies carry
      one-shot secrets — for 24h, purged nightly;
      `apps/server/src/middleware/idempotency.ts`.)
- [ ] **CSP is permissive** (`style-src 'unsafe-inline'` for Svelte) and has
      no `report-uri`, so tightening later is blind. Add reporting; explore
      nonce-based styles.
- [ ] **Cookie `__Host-` prefix** not used; consider it for extra hardening.
- [ ] **Container supply chain:** Trivy scans but we generate no SBOM and do
      not sign the image (cosign/attestations). Add for a distributed
      template.
- [x] **No dependency-update automation** (Dependabot/Renovate). (Added:
      `.github/dependabot.yml`, weekly npm + GitHub Actions + Docker, with
      the ADR 001 Better Auth trio held back for coordinated manual bumps.)

## Correctness & code debt (P1/P2)

- [x] **P1 — Audit log grows unbounded, and we made it worse.** To satisfy
      exit criterion #4 literally, every machine-principal _read_ writes
      a row (`apps/server/src/audit/service.ts`). (Bounded:
      `AUDIT_RETENTION_DAYS` (default 365, 0 = keep forever) drives a
      nightly 03:00 purge that deletes in batches over the `created_at`
      index added in migration 0004; `jobs/pgboss.ts`. Partitioning and
      read-sampling stay unpursued, retention bounds the table.)
- [x] **P1 — List endpoints returned ALL rows.** members / api-keys /
      invitations lists had no pagination (only audit does). (Done: files /
      members / api-keys / invitations are cursor-paginated audit-style —
      plain-id cursor, SQL-side (created_at, id) keyset, composite indexes in
      migration 0005 — and the audit route shares the same contract schema;
      `apps/server/src/pagination.ts`.)
- [x] **P1 — The Docker prune is a `rm -rf` hack on the pnpm store.**
      Deleting `drizzle-kit`/esbuild dirs leaves dangling symlinks that work
      today; a pnpm/better-auth bump could make a pruned package actually
      load and CI would not catch it until boot. (Fixed: prune and
      verification now live in ONE build-stage script,
      `scripts/prune-runtime-deps.mjs` — it removes the deny-listed packages,
      fails the image build on any dangling symlink it cannot attribute to
      the deny-list, on any surviving deny-listed copy, on any declared
      server dependency that no longer resolves (covers the lazily imported
      ioredis/nodemailer/resend/OTLP drivers), and runs
      `node dist/index.js --boot-check`, a 3-line early exit that makes Node
      load the FULL static runtime import graph with no DB. A bump that makes
      a pruned package reachable now breaks the build, not container boot;
      release.yml builds the image on every push, so it is a CI gate.
      Bundling the server remains off the table — pino/pg/pg-boss dynamic
      requires, see LESSONS.md.)
- [x] **P1 — The built CLI could not run standalone.** `@platform/sdk`'s
      `exports` pointed at `./src/index.ts`, so `node packages/cli/dist/bin.js`
      loaded raw TypeScript and threw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
      (Fixed M9: the sdk `exports` point at built `dist` JS with a `types`
      condition — matching `@platform/contract`/`@platform/db` — and the sdk
      is now in the build graph. `node packages/cli/dist/bin.js --help` runs
      from a clean `pnpm build` without tsx.)
- [ ] **P2 — Cross-workspace blob duplication.** Content-addressed keys
      include `workspace_id`, so two workspaces uploading identical bytes
      store two copies (intentional isolation, wasteful storage). Consider a
      refcounted shared-blob model.
- [x] **P2 — No connection-pool tuning.** (Set in `packages/db/src/client.ts`:
      `max: 10`, `connectionTimeoutMillis: 10_000`, `statement_timeout: 30_000`,
      `idle_in_transaction_session_timeout: 30_000`; the PgBouncer
      transaction-mode caveat is documented in deployment-profiles.md.)
- [ ] **P2 — File delete is immediate + irreversible** (row soft-deleted but
      blob removed). No trash/undo.
- [ ] **P2 — Validation 400s echo the full zod issue array** in `details`,
      revealing internal field structure. Decide consciously.
- [x] **P2 — MCP `list_files` trims client-side** (the files API has no
      `limit` param), so it pulls all rows then slices. (Done: the tool
      passes `limit` + `cursor` through to the now-paginated /files and
      returns the API page verbatim, `nextCursor` included.)

## API & data (P1/P2)

- [x] **Unmatched `/api/v1/*` paths returned the SPA HTML.** A browser
      session hitting an unknown API path fell through to the dashboard
      catch-all (200 HTML). (Fixed M9: a JSON `404 not_found` terminator is
      mounted last on the `/api/v1` sub-app; machine principals still 403
      `endpoint_not_allowed` at the scope gate first.)
- [ ] **OpenAPI doc is incomplete.** `/mcp` and `/.well-known/*` are plain
      Hono routes, absent from the generated spec, so the OpenAPI document
      undersells the real surface.
- [ ] **No API deprecation/versioning policy** beyond the `/api/v1` prefix —
      no sunset headers, no negotiation.
- [x] **No data export / workspace + account deletion (GDPR).** (Shipped:
      `GET /workspace/export` streams a zip — tables as JSON, audit log as
      NDJSON, every live blob — behind admin+ or the opt-in `data:export`
      scope, with a dashboard card and `platform export` in the CLI; account
      deletion via the password-gated danger zone and the admin Members
      action, hard cascade with a last-owner guard, files staying with the
      workspace per ADR 006. No grace period — the type-DELETE confirm is
      the flow.)
- [x] **No audit-log export** (CSV/JSON) for compliance. (Partial: the full
      audit log ships as `audit-log.ndjson` inside the workspace export
      bundle; there is no standalone CSV endpoint.)
- [ ] **No DB seed / demo-data script.** No `demo/` dir (workspace
      convention). Add one for local dev, demos, and e2e determinism.

## Observability & ops (P1/P2)

- [x] **`/metrics` exposed route names/queue depth/storage bytes and was
      default-open.** (Fixed: `/metrics` answers 401 unless `METRICS_TOKEN`
      is set, the bearer is compared in constant time, and `setup.sh` + the
      installer generate the token.)
- [ ] **`/readyz` doesn't check Redis, S3, or the email provider** — only
      DB + migrations + local storage.
- [ ] **We ship no Grafana dashboards or Prometheus alert rules.** Exposing
      `/metrics` is not the same as being observable.
- [ ] **No error-reporting seam** (Sentry-style). Failures log a generic 500
      with a request id, but nothing aggregates them or maps a user-facing
      error ID to the trace.
- [ ] **Backups are scripted but not automated or verified.** `backup.sh`
      exists; nothing schedules it, tests a restore, or alerts on failure.
- [x] **pg-boss table growth**, completed-job archival/retention not
      configured. (Configured in `jobs/pgboss.ts`:
      `archiveCompletedAfterSeconds: 3600` + `deleteAfterDays: 7`.)
- [ ] **No metrics-cardinality guard** — a product adding path params without
      a route pattern would explode `http_request_duration_seconds` labels.
- [ ] **No secrets-manager integration** (Vault / cloud secret store); every
      secret is an env var. Matters for the enterprise OIDC consumers.

## Testing & verification honesty (P1)

What "CI green" does **not** currently cover — be honest about this:

- [x] **Profile B was never actually run.** Every horizontal-scaling claim
      (advisory-lock migration under real concurrency, `SERVICE_ROLE`
      api/worker split, Redis rate limits, s3 in prod) is documented and
      unit-plausible but never deployed as a real multi-replica stack.
      (Closed by the scale drill — `scripts/scale-drill.sh` +
      `docker-compose.scale.yml`, run in CI on every push (`scale-drill` job
      in ci.yml) and locally per docs/scaling.md. Proven with evidence: the
      migration advisory lock under forced 3-replica contention (pg_locks +
      serialized log intervals + Postgres DDL log showing ONE applying
      session), cross-replica sessions and API keys, Redis-shared rate
      limits WITH the no-Redis per-replica contrast, and the api/worker
      split (worker-only job execution, frozen pg-boss cron heartbeat while
      only api replicas run, documented fresh-DB first-boot crash of
      api-only roles). Findings that did NOT hold as documented: the
      pg-boss schema install races to a self-healed deadlock/restart on
      fresh-DB multi-replica boots, and a local-storage blob read from the
      wrong replica dies mid-stream after a 200 rather than 404ing — both
      recorded in docs/scaling.md. Still NOT covered: the s3 driver against
      real MinIO/S3, and managed-Postgres/PgBouncer behavior.)
- [ ] **The drain (#6) and upgrade (#5) proofs are manual scripts, not CI
      gates** — they will rot. Add an automated in-flight-drop-zero test and
      an old-binary-against-new-schema coexistence test (the real
      expand-then-contract proof).
- [ ] **No coverage measurement.** We don't know what the ~95 tests touch.
      Add coverage + a threshold, and a test that enumerates the OpenAPI doc
      and fails when a route is unclassified by the scope allowlist (the
      "every route covered" guarantee is by-construction, not enforced).
- [ ] **The load test is 10s** — no soak test, no memory-growth check, no
      pool-exhaustion test.
- [ ] **The verifiers were Fable reviewing Fable** — same model family,
      likely shared blind spots. Get a human security audit before a client
      relies on it.
- [ ] **No real claude.ai connector round-trip.** We proved the dance with
      the MCP inspector + SDK client against localhost; nobody added the
      instance as an actual claude.ai connector end to end.
- [ ] **No contract tests** asserting the SDK's claimed shapes match what the
      server returns; no mutation testing; no a11y or cross-browser on the
      dashboard.

## Feature completeness for a real product (P2)

- [x] **Dashboard i18n (en/fr).** Shipped in M7: a library-free two-file
      catalog (`apps/dashboard/src/lib/i18n/` — `en.ts` is the type source,
      `fr.ts` is `Record<MessageKey, string>`) with compile-time key parity, a
      language switcher, and localStorage persistence (ADR 007). Transactional
      emails stay **English-only** — `email/templates.ts` carries no French
      (an earlier draft of this list wrongly claimed the templates were
      bilingual). Localizing them properly needs a per-user locale column
      (Better Auth schema territory) and is deferred; see the emails caveat in
      docs/i18n.md and ADR 007.
- [ ] Webhooks — internal event bus exists but no outbound subscription for
      product/customer integrations.
- [ ] Notifications — no in-app notification primitive; no email beyond OTP +
      invite + password reset + email-change verification (no welcome, no
      digests).
- [ ] Job-visibility UI — operators can't see pg-boss status, failures,
      retries, or a dead-letter queue.
- [x] Instance-superadmin / break-glass role distinct from the workspace
      owner (the per-tenant hosting model needs it). (Shipped, ADR 010:
      `SUPERADMIN_EMAILS` env allowlist — off by default, session +
      VERIFIED email only, machine credentials 403 fail-closed (the routes
      are unlisted in the scope allowlist). Two capabilities:
      `POST /api/v1/admin/break-glass/claim-ownership` (become/promote an
      active owner — adds, never removes, so the 0009 trigger holds) and
      `.../reset-2fa` (clears a locked-out member's factor). Everything
      audited with before/after state; runbook in security.md; no dashboard
      surface on purpose.)
- [ ] Support impersonation (view-as-user) — deliberately NOT part of
      break-glass; still open.
- [ ] Fine-grained RBAC — roles are coarse (owner/admin/member); no custom
      roles/permissions.
- [ ] Signed-URL direct-to-S3 uploads (methods reserved) — through-app
      streaming won't scale to multi-GB files on Profile B.
- [ ] File thumbnails/previews; resumable uploads.
- [ ] Onboarding — empty states, first-run guidance beyond the setup wizard.
- [ ] Billing/subscription example — the `EntitlementService`/`UsageSink`
      seams exist but there's no reference Stripe-style stub wiring them.
- [ ] Workspace settings self-service (name, branding).

## Repo hygiene / contributor-readiness (P2)

All added (2026-07-04): **LICENSE** (proprietary/internal, terms explicit in
the root file), **CONTRIBUTING.md**, **CODEOWNERS**, **.editorconfig**, the
**PR template**, and **Dependabot config** (`.github/dependabot.yml`).

## Known deviations (accepted, recorded)

- **Image is 440MB vs the ~300MB soft target.** Batteries-included: aws-sdk
  v3 (~100MB), OpenTelemetry, MCP SDK, OAuth server in one image. The clean
  fix is a lazy/optional s3 driver (dynamic import + optional dep) so the
  default local image drops the AWS SDK — deferred. See `LESSONS.md`.
- **Generic OIDC client login (identity layer 2) deferred by ADR 003** — the
  seam reserves the place; enabling it is Better Auth config-level work.
- **No OAuth-provider-issued refresh-token reuse detection surfaced to the
  operator** beyond Better Auth's defaults (365-day sliding refresh; 15-min
  access; live re-check mitigates).

---

## Suggested order of attack

Items 1–3 of the original list shipped 2026-07-04 (rate-limit keying, the
account pass minus 2FA/email verification, the SDK guard + CLI), plus audit
retention from item 5. The 2026-07-05→07 deferred-capabilities pass then
landed cursor pagination, API-key expiry, idempotency keys, GDPR
export/delete, self-service email change, and dashboard en/fr i18n (each
ticked above). 2FA (TOTP + backup codes) and honest email verification on
invite acceptance shipped 2026-07-07 (ADR 009), completing the account
story. What remains, in order:

1. Automate the Profile-B and coexistence proofs (P1·M): make the scaling
   story actually tested, not just claimed.
2. Session management UI (P1): see/revoke active sessions — and the natural
   home for 2FA trusted-device handling, deliberately unused so far.
3. Localize transactional emails (P2): the dashboard is bilingual but
   `email/templates.ts` is English-only; needs a per-user locale column.
