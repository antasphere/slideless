# ADR 008 — API-key pepper versioning (decoupled from AUTH_SECRET)

Status: accepted (2026-07-07)

## Context

API-key secrets are stored as `sha256(secret + pepper)` and compared in
constant time; the pepper existed so a leaked database alone cannot validate
keys. Until this ADR the pepper WAS the resolved auth secret, verbatim — the
same value that signs sessions and encrypts the JWKS. That made
`AUTH_SECRET` rotation a hard cutover: one env change logged every user out
AND broke every API key, i.e. every integration, CLI credential, and MCP
connector at once. Sessions dying on a secret rotation is an acceptable
"sign in again" event; silently bricking machine credentials is not.

## Decision

- **Version the pepper, per key.** `api_keys.pepper_version`
  (smallint, NOT NULL, DEFAULT 1 — migration 0010) records which pepper
  hashed each row. The default backfills every pre-existing key to
  version 1.
- **Version 1 is, immutably, the historical `AUTH_SECRET`-derived pepper** —
  the resolved auth secret used verbatim, exactly the pre-versioning
  computation. With no new configuration the registry is exactly
  `{ 1: authSecret }` and new keys mint at version 1: byte-identical
  behaviour, nothing to migrate, proven by the integration test that
  recomputes `sha256(secret + AUTH_SECRET)` against the stored hash.
- **`API_KEY_PEPPERS` supplies additional versions** as operator-legible
  `<version>:<secret>` entries joined by `;` (entries split at the first
  colon; secrets ≥ 32 chars; malformed values refuse boot via the env
  schema). Entries override the default, so `1:<historical secret>` pins
  version 1 independently of the live `AUTH_SECRET` — the prerequisite step
  of the rotation runbook (internal/security-runbooks.md). When version 1 is pinned it
  MUST carry the historical value, or existing keys stop resolving; the app
  warns at boot when `API_KEY_PEPPERS` is set without pinning version 1.
- **Mint uses the current version** — the highest defined — and stores it on
  the row. **Resolution verifies strictly under the stored row's version.**
  A `pepper_version` the registry cannot map FAILS CLOSED: the same
  `401 invalid_api_key` as a revoked or expired key (test-pinned
  byte-identical body), never a crash, never a fallback to a different
  pepper, never cross-version acceptance.
- **Sessions and JWKS still ride `AUTH_SECRET` — deliberately out of scope.**
  Better Auth owns session-cookie signing and JWKS encryption; rotating
  those is a "users sign in again" event with no durable credentials to
  strand, and decoupling them would mean forking Better Auth's secret
  handling for little gain. This ADR decouples only the API-key pepper,
  which is the one place a rotation destroyed long-lived credentials.

## Alternatives rejected

- **Deriving per-version peppers from `AUTH_SECRET` via a KDF** (e.g.
  `HKDF(authSecret, version)`): any derivation different from "the secret,
  verbatim" would have invalidated every existing key — version 1 must
  reproduce the historical computation byte-identically.
- **Storing peppers in the database:** the pepper's entire purpose is to
  live OUTSIDE the database, so a DB leak alone cannot validate keys.
- **Re-hashing keys at resolution time to the current version:** impossible
  by design — the server never stores the key secret, only its hash, so
  there is nothing to re-hash; keys migrate versions by being re-minted.

## Consequences

- Operators get the two runbooks in internal/security-runbooks.md: rotate `AUTH_SECRET`
  (pin v1, deploy, rotate) and rotate the pepper itself (add v2, drain v1,
  drop it). `SELECT count(*) FROM api_keys WHERE pepper_version = 1 AND
revoked_at IS NULL` tells them when a retired version is droppable.
- Dropping a version from `API_KEY_PEPPERS` while keys still reference it
  bricks exactly those keys (fail-closed 401) — visible, not silent, and
  recoverable by restoring the entry.
- `pepper_version` is internal: it never appears in API responses or the
  GDPR export (both select columns explicitly).
