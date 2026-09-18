# The viewer security model (for operators)

Slideless's whole point is rendering **untrusted, user-authored HTML** to
anonymous visitors. This page is what an operator needs to know about how
that is made safe, what the guarantees are, and the one hardening knob.
(The full platform posture lives in [security.md](security.md).)

## What a share link is

`slideless share <id>` (or the dashboard/MCP equivalents) mints a URL like
`https://your-instance/v/{secret}`:

- The secret is a **384-bit random path token, stored hash-only** — the
  database never holds the URL, and a leaked database does not leak working
  links. The URL is shown once at creation and is never retrievable again, with
  one exception: a create sent with an `Idempotency-Key` can be replayed with
  that same key for 24 hours (the cached response is encrypted under the auth
  secret).
- Links are **per-recipient**: each can carry its own expiry, viewer
  password (scrypt-hashed), pinned version or follow-latest mode, and view
  stats. Revocation is instant — viewer entries are served `no-store` and
  assets are revalidated on every request.
- Anyone with the URL (and the password, if set) can view the deck.
  **Treat share URLs as the credential they are.**

### What counts as an open

A link's view stats (`accessCount`, "last opened") count **entry-document
loads only** — asset fetches, `HEAD` requests, password challenges, and the
dashboard's own preview never count. To keep the number meaning "opens"
rather than "HTTP requests", repeat loads from the same browser inside a
short window count once: a counted open sets a signed, link-scoped,
HttpOnly cookie, and while the browser presents it the deck is served
without re-counting. That collapses browser prefetch/prerender, reloads,
and second tabs into one open. The window is
[`VIEW_DEDUPE_WINDOW_MINUTES`](../reference/env-reference.md) (default 10
minutes; `0` disables de-duplication and counts every entry load). Two
consequences worth knowing: cookie-less clients (CLIs, SDKs, mail-provider
link scanners) count on every fetch, and a very large window shifts the
metric toward "unique browsers" rather than "opens".

## How untrusted HTML is contained

Every byte of deck content is served under this exact header set:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`CSP: sandbox` without `allow-same-origin` drops the document into an
**opaque origin**: the deck's JavaScript cannot read cookies, cannot touch
localStorage/IndexedDB, cannot register service workers, and cannot make a
credentialed call to the instance's API — verified empirically on Chromium,
WebKit, and Firefox with a hostile deck and a live owner session in the
browser. The dashboard's own preview additionally wraps decks in
a `sandbox` iframe as a second, independent lock.

`allow-popups-to-escape-sandbox` is the one token that reaches outside the
deck: a window the deck opens (a `window.open`, a link with
`target="_blank"`) runs as a normal top-level page instead of inheriting the
deck's opaque origin, so a deck that links out to an application can open it.
It changes nothing about the deck itself, which still runs without
`allow-same-origin`.

This is the **safe default**: with zero configuration, a share link on the
app origin cannot be used to steal a dashboard session.

## The one hardening knob: `VIEWER_BASE_URL`

The default's protection is one header on one route — regression-tested,
but structurally a single layer. Setting `VIEWER_BASE_URL` to a **dedicated
user-content origin** (a second hostname that fronts the same instance but
carries no app cookies and hosts no API, e.g. a separate domain proxied to
the same container) makes share links get built on that origin instead:

```bash
VIEWER_BASE_URL=https://usercontent.example.net
```

Now even a hypothetical header regression cannot expose the dashboard
session across the real origin boundary — the browser itself separates the
two worlds. The server makes the boundary real rather than cosmetic: the
viewer hostname serves only decks and the token-authenticated viewer API
(the dashboard, sign-in and the rest of the API answer 404 there), the app
hostname redirects deck links across instead of serving them, the app API
refuses requests carrying the viewer origin — even where it would otherwise
trust "the origin it is served on" — and the auth layer never counts the
viewer origin as trusted. The sandbox headers stay on as defense-in-depth.
This is the recommended setup for any instance where outsiders routinely
open share links; the proxy recipe is in
[reverse-proxy.md](../self-hosting/reverse-proxy.md). (Per-deck subdomains
— full storage isolation for interactive `app`-kind decks — are the target
architecture and remain open.)

## Who can read a deck at all

Deck reads are **private by construction**, never workspace-wide:

- A deck's content is readable by its **owner**, workspace
  **admins/owners**, an **active per-deck collaborator grant**, or — for
  content only — a valid **share token**.
- Plain workspace membership is _not_ a read grant: collaborators are
  external parties invited to one deck, and revoking a grant cuts content
  access immediately.
- A failed read check answers **404, never 403** — the existence of a deck
  (or a share token) is not probeable.
- The rule reaches the **raw bytes**, not just the deck endpoints. The
  generic file surface (`/api/v1/files`, and the blob download under it)
  applies the same check: a member sees the blobs they uploaded plus those
  belonging to decks they can read, and nothing else. There is no route on
  which workspace membership alone yields another deck's content — and a
  version commit can only reference blobs its author is allowed to read, so
  one deck's content cannot be re-published from another.

## The account boundary

- **Sign-up is closed.** Accounts enter only through the one-shot first-boot
  setup, workspace invitations, or per-deck collaborator claims. Anonymous
  visitors of share links never have accounts.
- **Machines authenticate with `slk_` API keys or the instance's own OAuth
  2.1 tokens**, and reach only the endpoints consciously allowlisted for
  their scopes — everything else fails closed with 403. Each instance is
  its own OAuth authorization server; on a self-hosted instance no central
  identity exists (the cloud edition signs people in through the Antasphere hub).
- Annotator share links use a deliberately public, token-authed annotation
  API bounded by rate limits — the token in the URL is the whole
  credential, and it can only write notes on its own deck+version.

## Operator checklist

- Serve the instance over **HTTPS behind a reverse proxy**
  ([reverse-proxy.md](../self-hosting/reverse-proxy.md)) — share secrets travel in URLs.
- Consider `VIEWER_BASE_URL` (above) once share links leave your team.
- Never hand out `data:export`-scoped keys casually; never share the
  `/v/{secret}` URL of anything sensitive without an expiry or password.
- Treat any code change touching `apps/server/src/viewer/routes.ts` or the
  security-header middleware as security-critical — the regression tests
  assert the exact sandbox header set on every viewer response shape.
