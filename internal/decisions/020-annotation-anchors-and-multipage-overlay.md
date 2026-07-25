# ADR 020 — Resolvable annotation anchors and multi-page overlay injection

- **Status**: accepted, 2026-07-25
- **Context**: PRDCT-1241 (overlay clicks fell through and navigated the deck),
  PRDCT-1242 (the anchor could be silently replaced between capture and
  submit), PRDCT-1296 (anchors were display-only and sub-pages/sub-frames were
  unreachable). Shipped together as the overlay rework.

## Decisions

### 1. Anchor descriptor v2 is a CLIENT convention; the server stays opaque

`annotations.selection` remains untyped jsonb (`record(string, unknown)`,
8 KB cap). The overlay writes a layered descriptor — `v: 2`, `type`
(`text | point | region`), `page` (deck-relative document), `frame`
(reserved, always `null` today), `quote` + `context`, a bounded CSS
`selector`, a `[data-slide]`/`[data-panel]` `container` hint, normalized
`point`/`rect` fractions of the target element's box, and the capture-time
`viewport`. Resolution ladder on render/jump: selector → quote search
(container-scoped) → container → unanchored, degrading without error. Legacy
v1 anchors (`{type:'text', quote}`) stay readable via the quote rung.

Why not a server-validated schema: the anchor is only ever interpreted by
clients (overlay, dashboard); validating it server-side would freeze its
evolution for zero authz value — the server's protections (size cap, zod
record shape, rate limit, escaping-on-render) are independent of its meaning.
The tightening path, if ever needed, touches `annotationSelectionSchema`
(contract) plus the viewer surface's inline copy and
`MAX_SELECTION_JSON_BYTES` together.

### 2. Anchors are FROZEN at capture time

The composer snapshots the full descriptor the moment the capture happens
(selection pill shown / pin placed) and submits that snapshot verbatim. The
live selection is never re-read after the composer opens — the PRDCT-1242
class of bug (later mouseups silently replacing the anchor) is structurally
gone, not patched.

### 3. The overlay injects into every same-deck HTML DOCUMENT navigation

Previously only the entry navigation was transformed, so the overlay
vanished on `page2.html` of a multi-page deck and cross-page jump-to had
nothing to land on. The seam (`viewer/inject.ts`) now applies to the asset
route too, for manifest entries typed `text/html`, gated by
`docNavigation()`:

- `Sec-Fetch-Dest: document` → a top-level navigation, inject;
- `Sec-Fetch-Dest` present but not `document` (`iframe`, `frame`, `embed`,
  …) → a sub-resource, stream byte-exact;
- header absent (older engines, plain clients) → fall back to the Phase 5
  heuristic: HTML `Accept` and no agent-style `x-viewer-password`.

`?raw`/`?format=html` stays byte-exact everywhere; transformed responses are
`no-store` with no ETag (no validator would be honest for mutated bytes) and
re-assert the exact ADR 012 header set. The entry route now uses the same
gate, which also tightens it: an iframe-embedded ENTRY is a sub-resource and
no longer gets the overlay (the overlay additionally refuses to mount when
`window.self !== window.top`).

ADR 012 is unchanged: sub-pages were always served inline under the sandbox
CSP; the transform adds the same inline script the entry already carried,
inside the same opaque origin, with the same server-side hostile-input
treatment of every annotation write.

### 4. Deck isolation is stop-propagation at the overlay root plus a mode layer

Deck scripts navigate slides off document-level bubble listeners; the overlay
stops propagation of pointer/mouse/touch/key/wheel events at its root, so
interacting with it never reaches them (PRDCT-1241). Capture-phase listeners
on `document` still fire first — nothing an in-document overlay can do about
that, accepted. "Annotate mode" (point/region pins) adds a full-viewport
capture layer that swallows deck-bound events entirely while active, which is
what makes pinning safe on interactive decks.

### 5. Deferred: the sub-frame participation protocol

Content inside nested iframes (opaque origins of their own) stays
unannotatable. The chosen future path is the PRDCT-1296 postMessage
participation protocol — the overlay listening for anchor reports from
frames, treating them as hostile input like every annotation write. The v2
descriptor reserves `frame` for it; `Sec-Fetch-Dest: iframe` requests are
deliberately served untransformed until then. Screenshot/raster anchors were
rejected (cross-origin frames cannot be rasterized; images cannot be
searched, diffed, or re-anchored).

## Consequences

- Reviewer UX is the sliding-sheet pattern (pill → frozen composer → FAB →
  sheet with Open/Resolved tabs, numbered pins, cross-page jump via a
  `#__slanno=<id>` hash the destination overlay resolves and strips).
- Reviewer capability is unchanged: create + read own notes only; status
  flips stay owner-surface.
- The dashboard renders known anchor shapes humanly (quote, page, container)
  and falls back to the raw JSON line for unknown shapes — always escaped,
  never `{@html}` (stored-XSS posture unchanged).
- Regression surface: `apps/server/test/integration/annotations.test.ts`
  (injection matrix incl. multi-page + Sec-Fetch-Dest, v2 round-trip) and
  `apps/dashboard/e2e/viewer-annotations.spec.ts` (1241/1242 repros, pins,
  annotate mode, cross-page jump, against the real Docker stack).
