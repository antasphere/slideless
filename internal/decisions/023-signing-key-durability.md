# ADR 023 — Signing-key durability across AUTH_SECRET rotation

Status: accepted (2026-08-12) · Ported from the hub's ADR 016 (audit H1,
PRDCT-1379) via the platform template's ADR 014: the finding is
chassis-level, so every sibling on this chassis carries the same fix.

## Context

The jwt plugin stores its RS256 signing key in the `jwks` table encrypted
under `AUTH_SECRET` (bare xchacha20 ciphertext — createAuth passes a plain
string `secret`), and slideless configures no `jwks.rotationInterval`, so
the row carries no `expiresAt` and the plugin never replaces it. `signJWT`
decrypts the newest row on every mint. Rotating `AUTH_SECRET` per the old
runbook therefore left an instance that BOOTED but threw on every signing
path — `POST /oauth2/token` answered 500, forever — while the runbook
claimed the rotation was safe ("keys keep working, sessions restart").
That is every MCP connector pairing and OAuth integration on the instance,
cloud and oss editions alike. Recovery was undocumented psql surgery
(`DELETE FROM jwks`), which silently re-keys the instance.

The decrypt/verify asymmetry is what makes a clean fix possible: only
SIGNING needs the private key; verification uses the public half, stored in
plaintext JSON and served by `/jwks`. A key whose private half became
undecryptable is still a perfectly good VERIFICATION key.

## Decision

1. **Boot preflight, fail-closed** (`identity/signing-key.ts`, wired in
   `boot.ts` after migrations and the edition-flip guard): one decrypt
   attempt of exactly the key the plugin would sign with (newest by
   `createdAt`; a missing or EXPIRED newest row passes — the next mint
   creates a fresh key). Failure refuses the boot with a diagnostic naming
   the cause and both remedies. The instance never again serves an
   authorize endpoint it cannot follow with a token mint.

2. **Operator-driven rotation with a publish-overlap window**
   (`node dist/index.js rotate-signing-key [--retire <kid>]`): minting
   inserts a fresh RS256 row — the exact shape the plugin's own `createJwk`
   writes — under the CURRENT secret; the newest row signs from the next
   mint. Retired rows stay published on `/jwks` (every row without an
   `expiresAt` is served), so already-issued tokens keep verifying until
   the operator explicitly retires the old kid after the overlap window.
   `--retire` refuses the active signer — deleting it would silently re-key
   the instance, the exact failure the preflight exists to prevent. The
   instance's own verifier (`identity/oauth-jwt.ts`) refetches its cached
   key set once on an unknown `kid` as well as on a bad signature, so a
   LIVE rotation is picked up immediately instead of after the 10-minute
   cache TTL.

3. **The corrected runbook** (internal/security-runbooks.md, with the
   public posture claims in docs/security/security.md matched to it):
   AUTH_SECRET rotation now re-keys signing between the secret flip and the
   restart, and a separate compromise-drill section covers rotating the
   signing key alone. The runbook states the 2FA-enrollment consequence
   honestly.

This is about the LOCAL signing key only — the key slideless's own OAuth
authorization server signs with. The hub-federation verifiers
(`identity/hub-jwt.ts` and friends) verify HUB-issued tokens against the
hub's JWKS and are untouched.

Pinned by `test/integration/signing-key-rotation.test.ts`: the
boot-twice-different-secrets refusal, the remedy path, old-token
verification through the overlap, retirement, the active-key refusal, and
the live mid-cache rotation pickup.

## Considered and declined

- **`jwks.disablePrivateKeyEncryption`** — declined. Encrypted-at-rest
  signing keys mean a DB dump or an offsite backup alone cannot forge
  tokens for the instance; `AUTH_SECRET` lives in the instance env, the
  backups travel elsewhere (internal/backup-and-data-sovereignty.md). The
  operational cost the encryption used to carry — bricked token issuance
  on secret rotation — is eliminated by the preflight + re-key procedure,
  so the remaining trade-off favors keeping encryption ON.
- **`jwks.rotationInterval` (automatic rotation)** — deferred: it owns a
  rotation cadence question (the maximum external JWKS cache window) that
  deserves its own decision. An interval alone would NOT have fixed the
  failure (the pre-existing key has no `expiresAt`, and a mid-interval
  secret rotation still bricks signing until the key expires); the
  preflight stays load-bearing regardless.
- **Versioned secrets** (`options.secrets`, supported by the pinned
  better-auth with `$ba$<version>$` envelopes and a legacy bare-ciphertext
  fallback) — a promising future shape that would also carry 2FA material
  across rotations, but it changes the encryption format of everything the
  secret wraps and deserves its own evaluated flip; out of scope here.

## Consequences

- `AUTH_SECRET` rotation is a five-step ordered procedure; skipping the
  re-key step now fails loudly at boot instead of 500ing in production.
- The `jwks` table may legitimately hold several rows; row count is not a
  health signal. (The pinned plugin can even mint two keys on a fresh
  instance's FIRST issuance — the id_token and access-token signs race
  `createJwk`; harmless, newest wins, both verify.)
- Re-verify on ANY better-auth bump: the `signJWT` newest-key selection,
  the `createJwk` row shape, the `/jwks` publish filter
  (`plugins/jwt/{sign,utils,adapter}.mjs`), and the bare-string
  `secretConfig` encryption format the preflight and rotation mirror.
