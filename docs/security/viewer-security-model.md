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
  links. The URL is shown once at creation and is never retrievable again.
- Links are **per-recipient**: each can carry its own expiry, viewer
  password (scrypt-hashed), pinned version or follow-latest mode, and view
  stats. Revocation is instant — viewer entries are served `no-store` and
  assets are revalidated on every request.
- Anyone with the URL (and the password, if set) can view the deck.
  **Treat share URLs as the credential they are.**

## How untrusted HTML is contained

Every byte of deck content is served under this exact header set:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads
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
two worlds. The sandbox headers stay on as defense-in-depth. This is the
recommended setup for any instance where outsiders routinely open share
links. (Per-deck subdomains — full storage isolation for interactive
`app`-kind decks — are the target architecture and remain open.)

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

## The account boundary

- **Sign-up is closed.** Accounts enter only through the one-shot first-boot
  setup, workspace invitations, or per-deck collaborator claims. Anonymous
  visitors of share links never have accounts.
- **Machines authenticate with `slk_` API keys or the instance's own OAuth
  2.1 tokens**, and reach only the endpoints consciously allowlisted for
  their scopes — everything else fails closed with 403. Each instance is
  its own OAuth authorization server; no central identity exists.
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
