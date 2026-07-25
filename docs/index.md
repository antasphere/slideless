# Slideless

Slideless is the home for what your agents build. Agents produce HTML —
presentations, small apps, plans, reports — and Slideless turns those
folders into versioned, shareable live links: push from the CLI (or let an
agent push over MCP), get a secret URL, send it to anyone. No PowerPoint
export, no static-host glue, no third party holding your content.

## Two ways to run it

- **Antasphere cloud** — [slideless.antasphere.com](https://slideless.antasphere.com),
  operated by Antasphere. Sign in with your Antasphere account — one
  account, managed at `account.antasphere.com`, shared across every
  Antasphere tool. Organizations and membership live there too. See
  [Your Antasphere account](getting-started/antasphere-account.md).
- **Self-hosted** — one Docker image plus a Postgres container, running
  entirely on your own machine. All state lives in your database and one
  data volume; nothing phones home. Every instance is its own OAuth 2.1
  authorization server and API-key issuer, so nothing works or breaks
  because of anyone else's infrastructure. Start at
  [Install](self-hosting/install.md).

## What an instance does

- **Versioned decks.** A deck is a folder of HTML/JS/CSS/assets. Every push
  is an immutable version; uploads are content-addressed (unchanged files
  never re-upload) and pulls are byte-exact.
- **Share links.** Per-recipient secret URLs (`/v/{secret}`), stored
  hash-only server-side, with optional expiry, viewer password,
  pin-to-version or follow-latest, view stats, and instant revocation.
- **A sandboxed public viewer.** User HTML renders under
  `Content-Security-Policy: sandbox` — an opaque origin with no cookies, no
  storage, no credentialed API
  ([viewer security model](security/viewer-security-model.md)).
- **Collaborators and annotations.** Per-deck grants for external people who
  can push new versions of one deck, and reviewer annotations captured
  straight from annotator share links into the owner's inbox.
- **Agents as first-class users.** The `slideless` CLI, the `/mcp` endpoint
  with 22 `slideless_` tools, and scoped `slk_` API keys — every instance is
  agent-ready at boot.

## Where to go next

- **[Connect an agent](getting-started/connect-an-agent.md)** — the
  five-minute on-ramp: point a CLI or MCP host at your instance.
- **[Your Antasphere account](getting-started/antasphere-account.md)** — how
  sign-in, organizations, and the CLI work on the cloud edition.
- **[The Slideless CLI](agents/cli.md)** and
  **[the MCP connector](agents/mcp-connector.md)** — the two agent surfaces
  in full.
- **[Install](self-hosting/install.md)**,
  **[reverse proxy](self-hosting/reverse-proxy.md)**,
  **[deployment profiles](self-hosting/deployment-profiles.md)**, and
  **[upgrades](self-hosting/upgrade.md)** — run your own instance.
- **[Backup and restore](operations/backup-restore.md)** and the
  **[scaling drill](operations/scaling.md)** — operate it with confidence.
- **[Security posture](security/security.md)** and the
  **[viewer security model](security/viewer-security-model.md)** — what is
  enforced, and how untrusted HTML is contained.
- **[Environment reference](reference/env-reference.md)** — every variable.
