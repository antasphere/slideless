# The MCP connector

Every instance is MCP-capable at boot: the monolith serves a streamable-HTTP
MCP endpoint at `/mcp`, protected by the instance's own built-in OAuth 2.1
authorization server. No companion service, no shared secrets, no
`aud`/resource URL to keep in sync — the resource identifier is derived at
boot as `PUBLIC_BASE_URL + '/mcp'`.

## claude.ai / Claude Desktop (OAuth)

Add a custom connector with the URL:

```
https://slides.example.com/mcp
```

The client discovers everything itself: the 401 challenge points at the RFC
9728 resource metadata, which points at this instance as the authorization
server; the client self-registers (RFC 7591), the member signs in and
approves the consent screen, and the connector holds a 15-minute access
token with a rotating refresh token. Deactivating the member kills the
connector instantly (tokens are re-checked against the live membership on
every call).

The consent screen names the workspace being granted, and the grant is
bound to exactly that workspace for its whole life — refreshes included.
Members of several workspaces pick one at consent; connecting
the same client to another workspace is a second consent (send
`prompt=consent` to force the picker past an existing grant).

## Claude Code / CLIs (API key)

`/mcp` also accepts the instance's API keys directly — no OAuth dance:

```bash
claude mcp add --transport http slideless https://slides.example.com/mcp \
  --header "Authorization: Bearer slk_..."
```

Mint keys in the dashboard (API keys → Create key). Scopes gate what tools can do:
`presentations:read` for reads, `presentations:write` for mutations.

## Verify an instance

```bash
curl -s https://slides.example.com/.well-known/oauth-protected-resource/mcp | jq
npx @modelcontextprotocol/inspector   # connect → OAuth dance → call get_me
```

`get_me` returning your identity proves discovery, registration, login,
consent, token exchange, JWKS verification, and the live membership check in
one call.

## The tool set

All product tools are prefixed `slideless_` and act as the connected user —
identity always comes from the verified credential (OAuth token or API key),
never from a tool parameter. Reads require `presentations:read`, writes
`presentations:write`; the API's fail-closed allowlist and per-deck read
privacy apply unchanged (a tool can never read a deck the caller can't).

| Tool                                  | Scope | Does                                                                                                                                                                                                       |
| ------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slideless_whoami`                    | read  | The connected user, workspace, role, scopes (`get_me` is the chassis alias)                                                                                                                                |
| `slideless_list_presentations`        | read  | Cursor-paginated deck list, scoped by per-deck read privacy                                                                                                                                                |
| `slideless_get_presentation`          | read  | One deck's metadata                                                                                                                                                                                        |
| `slideless_update_presentation`       | write | Rename a deck / replace its `metadata` object (full replace, no version push)                                                                                                                              |
| `slideless_get_agent_doc`             | read  | The deck's `AGENT.md` briefing as markdown (omit `version` = latest)                                                                                                                                       |
| `slideless_list_versions`             | read  | Version history (metadata only)                                                                                                                                                                            |
| `slideless_get_version`               | read  | One version incl. its full manifest and its `attachments` (the `downloads/` entries; omit `version` = latest)                                                                                              |
| `slideless_download_version`          | read  | Manifest + text-file contents inlined (≤256 KiB/file, ≤1 MiB total); binary/oversized → CLI note                                                                                                           |
| `slideless_upload_html_presentation`  | write | One HTML string → a new 1-file deck (precheck → upload → commit); answers with `url`, the deck's own page                                                                                                  |
| `slideless_upload_presentation_files` | write | Inline multi-file upload (`contentText`/`contentBase64`); with `presentationId` commits a new version; answers with `url`, the deck's own page. ≤768 KiB decoded total — bigger decks use the CLI          |
| `slideless_delete_presentation`       | write | Soft delete (destructive, confirm-first)                                                                                                                                                                   |
| `slideless_add_share_token`           | write | Mint a share link (name/pin/annotate/forms/downloads/bar/expiry/password: `canAnnotate`, `canSubmitForms`, `canDownload`, `showBar`, see [Share links](../concepts/links.md)); returns the viewer URL once |
| `slideless_list_share_tokens`         | read  | A deck's tokens with access stats: views, `downloadCount`, `canDownload`, `showBar` (secrets never retrievable)                                                                                            |
| `slideless_list_token_views`          | read  | One token's per-view events: time, referrer host, `?p=` label, browser family (no IPs)                                                                                                                     |
| `slideless_set_token_version_mode`    | write | Pin a token to a version / follow latest                                                                                                                                                                   |
| `slideless_unshare_presentation`      | write | Revoke one token, or ALL active tokens when `tokenId` is omitted (destructive)                                                                                                                             |
| `slideless_share_via_email`           | write | Email a token's link (delivered sends ROTATE the secret)                                                                                                                                                   |
| `slideless_invite_collaborator`       | write | Per-deck dev grant; returns the claim URL                                                                                                                                                                  |
| `slideless_uninvite_collaborator`     | write | Revoke a grant (destructive, immediate)                                                                                                                                                                    |
| `slideless_list_collaborators`        | read  | A deck's grant roster                                                                                                                                                                                      |
| `slideless_list_annotations`          | read  | Per-deck notes, or the workspace inbox when `presentationId` is omitted; filters `version`/`status`                                                                                                        |
| `slideless_list_form_responses`       | read  | A deck's form responses (filters `form`/`token`/`source`/`placement`/`since`), or the grouped per-form × link × source × placement overview with `summary: true`                                           |

The `/mcp` transport caps request bodies at 1 MiB, so inline uploads are
bounded at 768 KiB of decoded content (base64 inflation means anything larger
cannot fit the JSON-RPC envelope anyway) — the tools answer a clean error
pointing at `slideless push` / `slideless pull` for bigger decks.

## For products extending the template

Tools live in `apps/server/src/mcp/`. Conventions (ported from a proven
predecessor MCP template): reads declare `readOnlyHint` and check `presentations:read`;
writes describe themselves as confirm-first and check `presentations:write`
(tool-level checks are UX — the API's fail-closed allowlist in
`middleware/scopes.ts` is the enforcement point); tools call the instance's
own API in-process forwarding the caller's bearer (MCP is just another API
client — never a privileged path); the acting user is NEVER a tool
parameter (identity comes from the verified credential); map domain error
codes to model-readable hints in `mcp/errors.ts`. New behavior lands in the
API first — the MCP tool is a thin projection of it.
