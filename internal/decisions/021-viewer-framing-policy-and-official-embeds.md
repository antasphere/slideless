# ADR 021 — Viewer framing policy and official embeds

- **Status**: accepted, 2026-07-25
- **Context**: PRDCT-1312 (official embeds: script loader + iframe snippet).
  Until now the framing posture was implicit: `VIEWER_CSP` (ADR 012) simply
  never carried `frame-ancestors`, and nothing set `X-Frame-Options`. This
  ADR makes that a recorded decision instead of an accident, because the
  embed feature depends on it staying true.

## Decisions

### 1. Deck bytes are deliberately frameable — that IS the embed feature

Every viewer response that carries user bytes (`/v/{secret}/` entry, HTML
sub-pages, assets) is embeddable in third-party pages: `VIEWER_CSP` carries
no `frame-ancestors` directive and no code path sets `X-Frame-Options`.
This is safe because the protection never was "who may frame us" — it is
the ADR 012 sandbox regime (opaque origin via `CSP: sandbox` on the bytes,
plus the Surface D iframe `sandbox` attribute on the embedding side), which
holds identically whether the framer is the dashboard preview or a
stranger's website. Deck secrecy is the URL itself; anyone who can embed a
deck could already link to it.

Regression pin: `test/integration/embed.test.ts` fails if a viewer
user-content response ever grows `frame-ancestors` or `X-Frame-Options`.

### 2. The gate and error shells stay frame-blocked

`SHELL_CSP` (password gate, human-readable errors) keeps
`frame-ancestors 'none'`. These are FIRST-party pages: a password form
rendered inside a third-party page is a phishing primitive (the embedding
site can overlay/observe around it), so a password-protected link simply
does not work inside an embed — documented as a limitation, not softened.

### 3. `GET /embed.js` is the official embedding path

A tiny framework-free loader (`viewer/embed.ts`), served anonymous on the
APP origin with `text/javascript` + nosniff + `public, max-age=3600` +
ETag. It replaces `div[data-slideless-embed]` with the Surface D iframe:
validates the URL is http(s) with a `/v/{secret}/`-shaped path (normalizing
a missing trailing slash), appends `data-slideless-placement` as the `?p=`
analytics label (PRDCT-1313), sizes via `data-aspect-ratio` (default 16/9),
never double-mounts, and leaves invalid divs untouched. A plain-iframe
snippet with the same attribute set is the documented no-script fallback
(docs/sharing/embedding.md); the dashboard's created-token dialog offers
both, copyable — creation time is the only moment snippets can exist, since
secrets are hash-only at rest.

### 4. One source of truth for the sandbox attribute set

The Surface D string now lives in the contract as
`VIEWER_IFRAME_SANDBOX` (packages/contract, schemas/share-tokens.ts). The
dashboard's `PREVIEW_SANDBOX` re-exports it, embed.js templates it in at
module load, and the docs snippets quote it. It must never gain
`allow-same-origin` (ADR 012 Surface C: full session theft) or
`allow-top-navigation*` (framebusting); decks.test.ts and embed.test.ts pin
both properties on their respective copies.

## Consequences

- Embeds are view-only by construction: the annotation overlay already
  refuses non-top-level documents (Sec-Fetch-Dest gate + `self !== top`,
  ADR 020) — embedding does not fight or change that.
- Embedded views count, with weaker de-dupe: the `slvd_` cookie is
  `SameSite=Lax`, which browsers do not send on cross-site iframe
  navigations, so embedded opens may count more often than direct opens.
  Accepted; the placement label is the attribution mechanism for embeds
  (the Surface D `referrerpolicy="no-referrer"` means embedded views carry
  no referrer host).
- If `VIEWER_BASE_URL` splits the origins, /embed.js stays on the APP
  origin (the dashboard snippet uses `window.location.origin` for the
  script, `createdUrl` for the deck) — the loader itself is origin-agnostic
  about the viewer URL it mounts.
- Regression surface: `apps/server/test/integration/embed.test.ts` (loader
  headers/bytes, sandbox-drift pin, framing-policy pin) and
  `apps/dashboard/e2e/embed.spec.ts` (real cross-origin embed against the
  Docker stack: loader mounts the exact Surface D iframe, deck renders, no
  overlay, placement label lands in the analytics).
