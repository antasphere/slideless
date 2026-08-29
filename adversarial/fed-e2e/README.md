# Federation seam — adversarial verification artifacts (`adv/fed-e2e`)

**These files are ADVERSARIAL ARTIFACTS, not product source.** They were produced by an
independent end-to-end verification of the hub ↔ Slideless federation seam
(PRDCT-1370 grant-teardown/leak fixes, PRDCT-1376 hub trust fixes) on **2026-08-29**,
run live against the two-instance drill stack with assertions on the **hub** Postgres.
The real fixes below go through normal fix lanes against product source — nothing here
patches product code.

## Verdict

**Product seam is CLEAN** — no exploitable defect was found against any attack in scope:
a slow-but-alive hub can no longer tear down a grant family (Slideless probes via
introspection before re-presenting), one tool's client cannot mint another tool's
audience, revocation stops new minting, and org suspension evicts in-flight reads
through the live reconcile. The post-rotation grace and its retired-successor teardown
behave exactly as designed, including the past-window boundary.

**The shipped drill could not get a clean run** — see F1. With the one-line fix it passes
all **14** assertions.

## Files

| File | What |
| --- | --- |
| `federation-drill.patched.sh` | Verbatim copy of `scripts/federation-drill.sh` with the F1 Phase-4 fix, so the seam test reaches a clean 14/14. Run: `FEDERATION_HUB_DIR=<hub> DRILL_SKIP_BUILD=1 ./adversarial/fed-e2e/federation-drill.patched.sh`. |
| `phase4-origin-fix.patch` | The F1 one-liner as a unified diff against product `scripts/federation-drill.sh`, for the fix lane (`git apply`). |
| `repro-findings.sh` | Self-contained repro for the two novel findings (F2, F4). Brings up the stack, asserts on the hub DB, tears down. |

## Findings (triage owned by Romain — no tickets opened)

### F1 — MEDIUM (tooling / deliverable): the drill can't pass as shipped
`scripts/federation-drill.sh` Phase 4 POSTs `/api/v1/auth/get-access-token` with the
session cookie but **no `Origin` header**. Better Auth's built-in origin guard answers
`MISSING_OR_NULL_ORIGIN` (403) *before* the Slideless `provider_grant_forbidden` hook, so
the `grep -q provider_grant_forbidden` assertion goes red. The product route is closed
either way (403, zero token material) — this is a **test** defect. Root cause: the
origin-trust merge (PRDCT-1377/1378) landed *after* the drill (PRDCT-1370). It also means
the AUTH-3 leg was being satisfied incidentally by the origin guard; with the `Origin`
header it actually exercises the provider-grant closure it is meant to test.

**Red-test proof:** unpatched drill FAILS at Phase 4 after 4 passes; patched drill = 14/14.
**Fix:** `phase4-origin-fix.patch` (add `-H "Origin: $SL"` to the Phase-4 curl).

### F2 — LOW (defense-in-depth): family teardown precedes client-secret validation
In the pinned `@better-auth/oauth-provider` refresh handler, `if (refreshToken.revoked)
invalidateRefreshFamily(...)` runs **before** `validateClientCredentials`. Verified live:
presenting a **revoked** refresh token for a confidential client with a **wrong** secret
collapses the whole family (2 rows/1 live → 0). So a holder of a single spent/revoked raw
refresh token + the public `client_id` can grief a confidential client's entire family
(including the shared CLI grant) with no/wrong secret — the client secret is no barrier.
The PRDCT-1376 token preflight authenticates the client only for the *grace re-arm*; it
lets an unauthenticated refresh presentation fall through to the plugin's teardown.
Pre-existing plugin behavior; precondition is possession of a raw revoked token (normally
only Slideless's encrypted `account` row / in-transit), same-user only → LOW.
**Hardening:** have the preflight refuse a refresh presentation whose client credentials
don't validate, making the destructive path authenticated-only. Repro: `repro-findings.sh`.

### F3 — LOW (grant hygiene): orphaned live refresh rows accumulate at the hub
After a CLOUD-2 timeout Slideless abandons the rotated-out token locally (marks its grant
dead) but never revokes it at the hub — it probes, never presents — so the hub keeps that
row live for the full refresh lifetime (~365 d). Observed: after one CLOUD-2 timeout + a
browser re-login, the hub held **2 live** refresh rows for one user. Cleared only by
`DELETE /me/connections`. Suggest a hub-side sweep of superseded-but-unrevoked rows, or an
explicit accept of the accumulation.

### F4 — LOW (latent): audience-guard media-type coupling
`apps/server/src/identity/token-preflight.ts` detects JSON with `/^application\/json/i`,
stricter than the plugin's `/^application\/([a-z0-9.+-]*\+)?json/i`. A `+json` body skips
the preflight's per-client-audience check. **Not exploitable today** — the token
endpoint's `allowedMediaTypes` 415s `+json`. But a Better Auth bump that accepts
structured-suffix JSON on the token endpoint would reopen the cross-tool audience bypass
PRDCT-1376 closed. **Hardening:** align the preflight regex with the plugin's. Repro:
`repro-findings.sh` (asserts the `+json` 415 that currently protects it).

### Confirmed, not a finding: revocation latency
An already-minted JWT access token keeps working for ≤15 min after grant revocation
(Slideless served `/me` from cache immediately post-revoke). Documented pull-only posture —
flagged so it's a conscious accept.

## How the drill runs
Two-instance stack (`docker-compose.federation.yml` + `docker-compose.federation.drill.yml`):
a hub, a cloud Slideless, a TCP delay-hop (admin `127.0.0.1:8474`, `POST /latency {"ms":N}`
for the slow-but-alive leg), and a second registry tool (`tool-drill-second`) so the
per-client-audience and grace legs have a foreign audience and their own family. Needs
ports 3300/3310/8474 free. `FEDERATION_HUB_DIR` selects the hub checkout to build
(default `../../../hub`); `DRILL_SKIP_BUILD=1` reuses prebuilt images.

Run on Claude Fable 5.
