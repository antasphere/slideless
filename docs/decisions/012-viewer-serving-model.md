# ADR 012 — Viewer serving model: how Slideless renders user-authored HTML

Status: accepted (2026-07-10) — Phase 4 shipped the same-origin
`CSP: sandbox` mode with the exact header set below
(`apps/server/src/viewer/routes.ts`), the securityHeaders clobber guard
upstreamed, regression tests on every viewer response shape, and
`VIEWER_BASE_URL` as the config knob for the separate-origin hardening path
(still the target architecture; wildcard/per-token subdomains remain open).

## Context

Slideless exists to render arbitrary **user-authored HTML** — single files or
folders of HTML/JS/CSS/images/video/3D/shaders — to anonymous viewers behind
secret share-token URLs. The dashboard, versioned API, Better Auth session, and
the OAuth 2.1 server all live on **one origin**. The chassis carries a hard
invariant (CLAUDE.md, docs/security.md, `files/http.ts`): *never render user
content on the app origin* — active types are served `attachment` + `nosniff`.
Slideless must break that surface open safely. The load-bearing question:

> Can we serve user HTML on the **same origin** under
> `Content-Security-Policy: sandbox` (which drops the response into an **opaque
> origin**, severing it from the app's cookies, storage, and credentialed API),
> or do we need a **physically separate origin**?

This ADR is backed by a real-browser spike (branch `spike/viewer-origin`): a
deliberately hostile deck served on the app origin with a **live owner session
cookie present**, driven by Playwright across **Chromium, WebKit, and Firefox**.

## Evidence (spike `spike/viewer-origin`, 2026-07-10)

Setup per engine: log in as the owner (`POST /api/v1/auth/sign-in/email`) so a
real `better-auth.session_token` (`HttpOnly`, `SameSite=Lax`) is in the jar;
confirm it works (`GET /api/v1/me` → 200, owner principal); then load each
surface and record what the deck's JS could reach. `/api/v1/me` returns the full
owner principal — the theft target.

**Surface A — `control`: user HTML on the app origin, NO sandbox (the danger baseline).**

| Probe | Chromium | WebKit | Firefox |
|---|---|---|---|
| `document.cookie` read | `""` (session is HttpOnly) | `""` | `""` |
| `localStorage` / `sessionStorage` | works | works | works |
| `navigator.serviceWorker.register` | **REGISTERED** (scope `/spike/viewer/`) | REGISTERED | REGISTERED |
| `fetch('/api/v1/me',{credentials:'include'})` | **200 — owner principal read** | 200 — leaked | 200 — leaked |
| session cookie sent on that fetch | yes | yes | yes |
| **Verdict** | **FULL SESSION THEFT** | FULL | FULL |

HttpOnly hides the cookie from `document.cookie`, but the **credentialed fetch
vector steals the whole session anyway** — HttpOnly alone is not a defense.

**Surface B — `sandbox`: `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups` (the candidate).**

| Probe | Chromium | WebKit | Firefox |
|---|---|---|---|
| `document.cookie` read/write | **SecurityError** | SecurityError | SecurityError |
| `localStorage` / `sessionStorage` | **SecurityError** | SecurityError | SecurityError |
| `navigator.serviceWorker.register` | **SecurityError** | SecurityError | SecurityError |
| `fetch('/api/v1/me',{credentials:'include'})` | **TypeError** (unreadable) | TypeError (Load failed) | TypeError (NetworkError) |
| session cookie sent on that fetch | no | no | **yes**¹ |
| server answer to that fetch | (blocked) | (blocked) | 401 |
| **Verdict** | **SESSION SAFE** | SESSION SAFE | SESSION SAFE |

¹ Firefox still *transmits* the `SameSite=Lax` cookie on the opaque-origin
credentialed request (Chromium/WebKit suppress it); the server answered **401**
and, decisively, the CORS/opaque-origin wall made the response **unreadable to
the deck on every engine**. No owner data reached the deck anywhere. The Firefox
cookie-forwarding is a defense-in-depth item, not a break (see Residual risks).

**Surface C — `same-origin-footgun`: `sandbox allow-scripts allow-same-origin`.**

All three engines: `document.cookie` readable, storage works, service worker
REGISTERED, `fetch('/api/v1/me')` → **200 owner principal leaked**, cookie sent.
Adding `allow-same-origin` **fully re-opens the vulnerability** — the entire
guarantee rests on omitting that one token.

**Surface D — `framed`: sandboxed deck inside `<iframe sandbox="allow-scripts">` (dashboard-preview defense-in-depth).**

All three engines: cookie/storage/service-worker → SecurityError;
`fetch('/api/v1/me')` → TypeError; `window.top.location = …` (framebust attempt)
→ **SecurityError, the top URL never changed**; parent-document access blocked.
The iframe `sandbox` attribute reproduces the opaque-origin isolation **and**
additionally blocks top-navigation and parent access.

## Decision

**Adopt a dedicated, separate viewer origin as the target architecture, with
`CSP: sandbox` and iframe sandboxing layered on top as defense-in-depth.**

- **User content is served from its own origin**, distinct from the
  dashboard/API/OAuth origin — ideally a **per-share-token subdomain** on a
  dedicated user-content domain (e.g. `https://<token>.usercontent.<domain>`),
  so each deck is its own origin, isolated both from the dashboard **and from
  every other deck**. That origin hosts **no app cookies and no API**.
- **`Content-Security-Policy: sandbox` (never `allow-same-origin`) stays applied
  as a second layer** for the read-only "present" surface, and the dashboard
  preview embeds decks in a `sandbox` iframe (Surface D).
- **Same-origin `CSP: sandbox` (no `allow-same-origin`) is the empirically-proven
  fallback** — safe against session theft on all three engines — acceptable as
  an **MVP only for static / self-contained decks**, if a second origin is
  genuinely not yet available. It is **not** acceptable for interactive
  `app`-kind decks (see tradeoff) and it is **fail-dangerous** (below).

Why not "same origin is fine, ship it": the spike proves same-origin
`CSP: sandbox` defeats session theft, so it is a *valid* narrow answer. We still
choose the separate origin because two structural facts outweigh the
convenience: (1) it is **fail-safe** — a dropped/again-clobbered header cannot
leak the dashboard session across a real origin boundary (we already found the
global middleware silently clobbering per-route CSP; see Residual risks +
TEMPLATE-FEEDBACK); (2) it is the **only** model that lets `app`-kind decks have
real, isolated client storage. This is how every serious host of untrusted HTML
ships (per-sandbox subdomains, `*.usercontent` domains).

### The exact header set the real viewer must send

Serving the deck **inline** (the deliberate, documented exception to the
template's attachment-by-default rule — safe only under this sandbox /
separate-origin regime; never serve user HTML inline without it):

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

- **Never** include `allow-same-origin` (Surface C) or `allow-top-navigation*`
  (Surface D framebust). Keep popups sandboxed — do **not** add
  `allow-popups-to-escape-sandbox`.
- For the dashboard **preview**, embed with the matching iframe attribute and no
  `allow-same-origin`:
  `<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" referrerpolicy="no-referrer" allow="fullscreen" src="…">`.
- If the deck is served **inside the app** (same-origin fallback), the global
  `securityHeaders` middleware must be changed to **not clobber a per-route CSP
  or `Referrer-Policy`** — the spike found it unconditionally overwrites both on
  every `text/html` response, which silently replaces `sandbox …` with the
  dashboard CSP. A one-line `!c.res.headers.has(...)` guard fixes it (kept on the
  spike branch; upstream in the viewer phase). On a separate origin the viewer
  server owns its headers and this does not apply.

### The `localStorage` / service-worker tradeoff (impact on `app`-kind decks)

The opaque origin that makes `CSP: sandbox` safe **also denies all persistent
client state**: `localStorage`, `sessionStorage`, `document.cookie`, IndexedDB,
the Cache API, and **service workers** every throw `SecurityError` (Surface B,
all engines). Consequences:

- **"present" / static decks:** unaffected — they need no storage.
- **`app`-kind interactive decks** (editors, games, stateful tools, offline):
  under same-origin `CSP: sandbox` they **cannot persist anything, cannot cache,
  cannot go offline**. This is a hard cap, not a bug. Giving them real storage
  requires a real (non-opaque) origin — which on the app origin is catastrophic
  (Surface C). **Therefore `app`-kind decks are the decisive reason for the
  separate origin:** on a per-token subdomain a deck gets its own real, isolated
  origin with full storage/service-worker support, leaking nothing to the
  dashboard or to sibling decks. There, storage-needing decks run *without* the
  sandbox directive (origin isolation is the boundary); the sandbox layer stays
  for the read-only present mode.

### Defense-in-depth for the dashboard preview

Always embed the deck in a `sandbox` iframe **without `allow-same-origin`**
(Surface D), even when the deck is already on a separate origin. It independently
blocks storage, credentialed reads, framebusting, and parent access — a second
lock that survives a viewer-origin misconfiguration.

## Residual risks / follow-ups for the hardening phase (P9)

1. **Fail-dangerous header (same-origin mode).** The whole protection is one
   `sandbox` header on one route; any regression re-exposes the session. If
   same-origin is ever used, centralize the header and add a regression test
   asserting every user-HTML response carries `sandbox` and **never**
   `allow-same-origin`. The global-middleware clobber we found is exactly this
   class of bug.
2. **Firefox forwards the dashboard cookie** to the opaque-origin credentialed
   request (response blocked, but the cookie leaves the browser). Harden
   `/api/v1` to reject cross-site credentialed requests (`Origin: null` /
   `Sec-Fetch-Site: cross-site`) — belt-and-suspenders beyond CORS, and already
   a noted defense-in-depth item in security.md's CSRF posture.
3. **Attachment-invariant exception.** The viewer serves user HTML **inline** by
   design; guarantee (with a test) that no other code path serves user HTML
   inline outside the sandbox / separate-origin regime.
4. **Separate-origin plumbing.** Wildcard DNS + wildcard TLS for per-token
   subdomains; the user-content origin must carry no app cookies and no API;
   decide the preview framing policy (`frame-ancestors`).
5. **`location.origin` is misleading.** In the sandboxed opaque-origin document
   it still reports the fetched URL (`http://localhost:3100`), not `null` — do
   not use it as an isolation signal; the behavioral denials (SecurityError) are
   the truth.
6. **`connect-src` for app-kind decks** that fetch their own assets — scope it
   to the deck's own origin.

## Revisit when

- The separate viewer origin is provisioned: fold in the real hostname scheme,
  set the dashboard `frame-ancestors`, and move this from "target" to "shipped".
- A browser changes opaque-origin or `SameSite` semantics (re-run the spike
  harness — it is preserved on `spike/viewer-origin`).
- `app`-kind decks need capabilities (storage, SW, cross-deck messaging) that
  force a decision on per-token subdomain isolation vs. a shared sandbox origin.
