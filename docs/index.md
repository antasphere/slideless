# Slideless

Slideless is the home for what your agents build. Agents produce HTML: presentations, small apps,
plans, reports. Slideless keeps each one as a deck in your account, versioned on every push, and
shares it by link. Push from the CLI (or let an agent push over MCP), open the deck's page, hand
out a link. No PowerPoint export, no static-host glue, no third party holding your content.

## The model in one screen

- **One deck is one artifact.** A deck is a folder of HTML pushed from the command line, and it
  lives in your account as one thing with a page of its own: the deck full-page under a bar where
  you rename it, duplicate it, share it, read its history and delete it. A push answers with that
  page. [The deck is the artifact](concepts/artifact.md)
- **Every push is a version.** Versions are immutable and numbered; unchanged files never upload
  twice; any version pulls back byte-exact. The owner sees the whole history, a recipient sees one
  version. [Versions](concepts/versions.md)
- **Links are made on top.** A share link is a secret URL that opens the deck for whoever holds it, under a slim bar naming
  the deck, its version and its files, following the latest version or pinned to one, with its own
  switches (annotations, forms, file uploads, downloads, the bar), an expiry, a password, view counts and instant
  revocation. A link is public to anyone
  with its URL; a deck with no link is private. [Share links](concepts/links.md)
- **Files travel with the version.** Whatever you put in a `downloads/` folder is the version's
  attachment set, downloadable from the link one by one or as a zip, and switched off per link when
  a recipient should look but not take. [Attachments](concepts/attachments.md)
- **A sandboxed viewer.** User HTML renders under `Content-Security-Policy: sandbox`: an opaque
  origin with no cookies, no storage, no credentialed API
  ([viewer security model](security/viewer-security-model.md)).
- **Collaborators and reviewers.** Per-deck grants for external people who push new versions of one
  deck, and annotator links whose notes land in the owner's inbox.
- **Agents as first-class users.** The `slideless` CLI, the `/mcp` endpoint with 33 `slideless_`
  tools, and scoped `slk_` API keys: every instance is agent-ready at boot.

## Two ways to run it

- **Antasphere cloud**: [slideless.antasphere.com](https://slideless.antasphere.com), operated by
  Antasphere. Sign in with your Antasphere account, one account managed at
  `account.antasphere.com` and shared across every Antasphere tool. Organizations and membership
  live there too. See [Your Antasphere account](getting-started/antasphere-account.md).
- **Self-hosted**: one Docker image plus a Postgres container, running entirely on your own machine.
  All state lives in your database and one data volume; nothing phones home. Every instance is its
  own OAuth 2.1 authorization server and API-key issuer, so nothing works or breaks because of
  anyone else's infrastructure. Start at [Install](self-hosting/install.md).

## Where to go next

- **[Connect an agent](getting-started/connect-an-agent.md)**: the five-minute on-ramp, pointing a
  CLI or an MCP host at your instance.
- **The concepts**: [the deck as an artifact](concepts/artifact.md), [versions](concepts/versions.md),
  [share links](concepts/links.md) and [attachments](concepts/attachments.md), one page each.
- **[Your Antasphere account](getting-started/antasphere-account.md)**: how sign-in, organizations
  and the CLI work on the cloud edition.
- **[The Slideless CLI](agents/cli.md)** and **[the MCP connector](agents/mcp-connector.md)**: the two
  agent surfaces in full.
- **[Install](self-hosting/install.md)**, **[reverse proxy](self-hosting/reverse-proxy.md)**,
  **[deployment profiles](self-hosting/deployment-profiles.md)** and
  **[upgrades](self-hosting/upgrade.md)**: run your own instance.
- **[Backup and restore](operations/backup-restore.md)** and the
  **[scaling drill](operations/scaling.md)**: operate it with confidence.
- **[Security posture](security/security.md)** and the
  **[viewer security model](security/viewer-security-model.md)**: what is enforced, and how untrusted
  HTML is contained.
- **[Environment reference](reference/env-reference.md)**: every variable.

## License

Slideless is [fair-code](https://faircode.io), distributed under the
[Sustainable Use License](https://github.com/antasphere/slideless/blob/prod/LICENSE): the source is
open to read, and you may self-host it, modify it and use it for your own internal business or
personal purposes, free of charge. You may not sell it or offer it to others as a paid or hosted
service. It is source-available, not open source.
