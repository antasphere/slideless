# ADR 007 — Dashboard i18n: static catalogs with compile-time key parity

Status: accepted (2026-07-07)

## Decision

The dashboard's en/fr i18n is a library-free, two-file catalog system
(`apps/dashboard/src/lib/i18n/`):

- **English is the source of type truth.** `en.ts` exports the catalog
  `as const` and derives `MessageKey = keyof typeof en`. Every other locale
  is typed `Record<MessageKey, string>`, so a missing key (Record requires
  all keys) or an extra key (excess-property checking) is a **compile
  error**, not a runtime fallback surprise.
- **Both catalogs are statically imported** into one bundle. No async
  loading, no splitting, no i18n framework.
- **The locale is fixed per page load.** It is resolved once at boot
  (localStorage `platform.lang` → `navigator.language` → `'en'`) by the
  root `+layout.ts`; switching persists the choice and reloads the page.
  Consequence: `t()` is a plain synchronous function with zero
  runes/stores/reactivity — components use it like any pure helper,
  including inside TanStack column defs and default prop values.
- **No URL prefixing.** The sibling dashboard template's `[[lang=lang]]`
  optional segment exists for SSR/SEO on pre-auth pages; this dashboard is
  a pure SPA (`ssr = false`, adapter-static) with no SEO surface, so
  localStorage persistence replaces the URL as the carrier of the choice.

## Why

- The dashboard's string surface (~380 messages) is small enough that
  bundling every locale costs a few kilobytes — irrelevant next to the
  component code — while buying total type safety and zero async
  complexity.
- The reload-on-switch model is what keeps the system this small: a
  live-switching locale would force every `t()` call site into reactive
  context (a store or rune), touching every component for a feature nobody
  exercises more than once.
- Adapted from `codika-dashboard-template`'s system, minus its SSR-bound
  resolution (hooks.server.ts, URL param), plus the completeness guarantee
  it lacks (its catalogs are `Record<string, string>` — a missing key
  falls back silently).

## Accepted costs

- **All locales ship in the bundle.** Fine at 2, still fine at 3. Past ~3
  languages (or with very large catalogs), reconsider: dynamic per-locale
  `import()` keyed off the resolved locale, or Paraglide (same
  compile-time key safety, per-locale tree-shaking and lazy loading). This
  is a conscious tradeoff so language three isn't a surprise.
- **A language switch is a full page reload.** Acceptable for a
  set-once preference.
- **Server-originated messages stay English** (API errors, transactional
  emails). Documented in docs/i18n.md; proper email localization needs a
  per-user locale column and is tracked in production-readiness.md.

## Revisit when

A third locale lands (bundle-size call), a product needs live language
switching without reload, or per-user server-side locale (localized emails)
gets built — at which point the client should read that column instead of
localStorage as the primary source.
