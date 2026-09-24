# Connect an agent to your instance

Agents are the primary authors on a Slideless instance — this is the
on-ramp for pointing one at yours. There are two surfaces, both
self-contained on your box:

- **The CLI** — for terminal agents (Claude Code, shell loops, CI): push
  folders, pull them back, mint share links. Full reference:
  [cli.md](../agents/cli.md).
- **The MCP endpoint** — for MCP hosts (claude.ai connectors, Claude
  Desktop, Claude Code, any MCP client): 37 `slideless_` tools over
  streamable HTTP at `/mcp`. Full reference:
  [mcp-connector.md](../agents/mcp-connector.md).

Both authenticate against **your instance only**. There is no central
Slideless service in either path — the key self-host property is that every
instance is its **own OAuth 2.1 authorization server** and its own API-key
issuer, so nothing works or breaks because of anyone else's infrastructure.

## The CLI

Get the binary (`npm i -g @antasphere/slideless`, or a workspace build):

```bash
pnpm --filter @antasphere/slideless... build
alias slideless='node /path/to/slideless/packages/cli/dist/bin.js'
```

The CLI has **no default URL** — every command resolves its target as
`--api-url` flag → `SLIDELESS_URL` env → the saved profile's `baseUrl`, and
errors if none is set. That is deliberate: a self-hosted CLI must name its
instance instead of silently talking to the wrong host.

**Sign in, option A — browserless OTP** (requires the instance to have an
email driver). Signs in existing accounts only — sign-up stays closed:

```bash
slideless auth login-request  --api-url https://slides.example.com --email you@example.com
slideless auth login-complete --api-url https://slides.example.com --email you@example.com --code 123456
```

`login-complete` mints an `slk_` API key server-side (scopes
`presentations:read` + `presentations:write`) and stores it as the active
profile in `~/.config/antasphere/tools/slideless.json` (mode 600; the
shared Antasphere CLI config home, see [cli.md](../agents/cli.md)).

**Sign in, option B — paste a dashboard key** (works with `EMAIL_DRIVER=none`,
and required for accounts with 2FA). Mint the key in the dashboard: **API
keys**, then **Create key**. Tick `presentations:write` there (the dialog
pre-selects `presentations:read` only) so the key can push and share; the
secret is shown once, right after creation. Then:

```bash
slideless login --api-url https://slides.example.com --api-key slk_...
slideless verify    # exit 0 iff instance + key work (it does not check the scopes)
```

**The agent loop** — push, share, pull:

```bash
export SLIDELESS_URL=https://slides.example.com
export SLIDELESS_API_KEY=slk_...

id=$(slideless push ./deck --title "Q3 Board Deck" --json | jq -r .presentation.id)   # .url is the deck's own page
url=$(slideless share "$id" --name recipient --json | jq -r .url)                     # a recipient link, when one is needed
slideless pull "$id" ./out          # byte-exact round-trip
```

A push answers with the deck's own page on the instance (the owner's view,
where links are made); a share link is minted only when a recipient needs
one. An agent handed a share link reads it with a plain fetch: the link
answers with an index of the deck (its files and sizes, its downloads, its
`AGENT.md`), from which the agent fetches only what it needs; see
[Share links, read by agents](../agents/share-links-for-agents.md). The model is in the Concepts pages, starting with
[The deck is the artifact](../concepts/artifact.md).

`push` is content-addressed (only missing blobs upload; a re-push of the
same folder is a new immutable version), the first push writes
`.slideless.json` into the folder so later pushes target the same deck, and
`--json` on any command emits the wire shape for machine parsing. See
[cli.md](../agents/cli.md) for sharing flags (expiry, password, pin-to-version),
collaborator grants, annotations export, and `slideless dev` (a local
preview server with the exact viewer sandbox headers).

## The MCP endpoint

Every instance serves MCP at:

```
https://your-instance.example.com/mcp
```

Two ways in:

**OAuth (claude.ai / Claude Desktop connectors).** Add the URL as a custom
connector — that is the whole configuration. The client discovers
everything from your instance itself: the 401 challenge points at the RFC
9728 resource metadata, which names _this instance_ as the authorization
server; the client self-registers (RFC 7591), the member signs in on your
dashboard and approves consent, and tokens are minted, verified, and
refreshed entirely by your box. Deactivating the member kills the connector
instantly.

**API key (Claude Code, headless hosts).** `/mcp` accepts the instance's
`slk_` keys directly, no OAuth dance:

```bash
claude mcp add --transport http slideless https://your-instance.example.com/mcp \
  --header "Authorization: Bearer slk_..."
```

Tools act as the connected user — identity always comes from the verified
credential, never from a tool parameter, and the API's fail-closed scope
allowlist plus per-deck read privacy apply unchanged. The tool set (whoami,
list/get/upload/download presentations, share tokens, collaborators,
annotations) is tabled in [mcp-connector.md](../agents/mcp-connector.md); note the
1 MiB `/mcp` body cap — tools answer a clean "use the CLI" error for bigger
decks.

Verify an instance end to end:

```bash
curl -s https://your-instance.example.com/.well-known/oauth-protected-resource/mcp | jq
npx @modelcontextprotocol/inspector   # connect → OAuth dance → call slideless_whoami
```

## Scopes and revocation

| Credential     | Granted                                                                                                             | Revoke                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `slk_` API key | The scopes chosen at mint: `presentations:read`, `presentations:write`, optional opt-in `data:export`; optional TTL | Dashboard → API keys (immediate)                      |
| OAuth token    | The scopes approved on the consent screen; 15-minute access tokens, rotating refresh                                | Deactivate the member, or revoke the client's consent |

Machine credentials reach **only** the endpoints consciously allowlisted for
their scopes (fail-closed — see [security.md](../security/security.md)); member
deactivation is re-checked on every request, so cutting a person off cuts
their agents off in the same moment.
