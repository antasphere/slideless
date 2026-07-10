# Spike: viewer-origin security probe (THROWAWAY)

Branch `spike/viewer-origin`. Evidence for the viewer-serving-model decision
(ADR 012 on `dev`). **Not for merge.** Delete with the branch.

## What it is

- `apps/server/src/spike/viewer.ts` — a throwaway Hono sub-app mounted in the
  deliberate public-route slot of `app.ts`. Serves a deliberately HOSTILE
  user-authored deck on the app origin under `Content-Security-Policy: sandbox …`
  and reports, from inside the browser, what it can reach (cookies, storage,
  the credentialed `/api/v1/me` API, service workers, the top frame). Four
  surfaces: `control` (no sandbox = danger baseline), `sandbox` (the real
  candidate), `same-origin-footgun` (`allow-same-origin` added — proves it must
  never be), and `framed` (iframe `sandbox` defense-in-depth).
- `apps/server/src/middleware/security-headers.ts` — a one-line guard so the
  global handler no longer CLOBBERS a per-route CSP / `Referrer-Policy`. Without
  it the dashboard CSP overwrites the viewer's `sandbox` CSP. Upstream this to
  the real viewer.
- `spike/run.mjs` — Playwright harness driving Chromium + WebKit + Firefox: logs
  in as the owner (real session cookie), then loads every surface and records
  the per-engine outcome. Secrets are read from `process.env.OWNER_PASSWORD`
  (sourced indirectly) and never printed; cookie values are never printed.

## Run

```bash
# stack up on :3100 (docker compose ... up -d), image = slideless:spike
export OWNER_PASSWORD="$(grep -E '^OWNER_PASSWORD=' .env | cut -d= -f2-)"
export OWNER_EMAIL=dev@slideless.local
node spike/run.mjs
```

## Result

Single-origin `CSP: sandbox` (WITHOUT `allow-same-origin`) blocks cookie read,
storage, credentialed API read, and service workers on all three engines; the
`allow-same-origin` variant re-opens everything. See ADR 012 for the decision,
the exact header set, and the storage tradeoff for `app`-kind decks.
