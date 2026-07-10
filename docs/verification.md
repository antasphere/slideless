# Verification evidence

How each exit criterion is proven. Automated proofs live in the test suites
and CI; the manual drills below are reproducible with the scripts named.

## Automated

- **Unit** (`pnpm --filter @slideless/server test`, `@slideless/dashboard test`):
  scope allowlist, key format + constant-time verify, content-address +
  traversal guard, Range parser, disposition policy, env schema, CSP hashes,
  pino redaction (the real `REDACT_PATHS`), `safeNext` open-redirect guard.
- **Integration** (`test:integration`, testcontainers `pgvector/pg17`, real
  routes via `app.request()` + a real listening server for the OAuth/MCP
  dance): migrator idempotency, setup + 410, live-membership revocation on
  all three credential paths, API keys, invitations, audit, files (local +
  MinIO), metrics, request-id correlation, usage pipeline, and the full
  OAuth dance driven by the official MCP SDK client.
- **Dashboard e2e** (`@slideless/dashboard test:e2e`): builds the real image,
  boots an isolated compose stack, walks setup → key → invite → accept →
  audit → deep-link → re-login → consent error state.
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, unit, build, format,
  drift check, and the integration suite.
- **Release gates** (`.github/workflows/release.yml`): an image e2e smoke
  (build → compose up → setup/login/key/audit → restart-persistence) and a
  Trivy HIGH/CRITICAL scan, both gating the multi-arch GHCR publish.

## Manual drills (reproducible)

### Load test — exit criterion 7 (`scripts/loadtest.sh`)

autocannon, 50 connections, 10s, against a single-VPS compose deployment
(`node:22-alpine`, one replica, local storage). Representative run:

| Route              | What it exercises                                              | Median latency | Throughput   |
| ------------------ | -------------------------------------------------------------- | -------------- | ------------ |
| `/healthz`         | liveness, no deps                                              | 4 ms           | ~10.7k req/s |
| `/api/v1/instance` | public discovery, one indexed read                             | 11 ms          | ~4.3k req/s  |
| `/api/v1/me`       | authenticated: session + one live membership check per request | 27 ms          | ~1.8k req/s  |

Zero non-2xx across all three. The authenticated path deliberately does the
live re-check the security model depends on (instant revocation), and still
sustains ~1.8k req/s on one small container — headroom is a bigger machine
or (Profile B) more replicas.

### Upgrade survives — exit criterion 5

Bring up an older image, seed an owner + API key, then pull a newer image
carrying an additive migration (migration `0003` was created for exactly
this) and `docker compose up -d`. Verified: the two pending migrations
applied exactly once under the advisory lock, `/readyz` flipped back to 200,
and the pre-upgrade API key still authenticated — data survived.

### Graceful drain — exit criterion 6

Start a rate-limited 50MB download, send `SIGTERM` 3s in. Verified: the app
logged `shutdown: draining`, let the in-flight transfer finish, and the
downloaded bytes were identical to the source (52,428,800 bytes, curl exit
0); shutdown completed cleanly after the transfer. `stop_grace_period` in
compose is set above the in-app grace window so the orchestrator waits.

### MCP connector dance — exit criterion 13 (`apps/server/scripts/verify-mcp-dance.mts`)

Against a running instance: 401 challenge → RFC 9728 resource metadata →
dynamic client registration → login → consent → PKCE token exchange →
official MCP SDK client `initialize` + `get_me`. Verified end-to-end; the
same flow is also asserted in `test/integration/oauth-mcp.test.ts`.
