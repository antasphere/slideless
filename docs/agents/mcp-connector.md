# The MCP connector

Every instance is MCP-capable at boot: every instance serves a streamable-HTTP
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

**The grant is user-scoped, not workspace-scoped.** A connected client acts
as you in every workspace you belong to: consent binds no workspace and there
is no per-workspace consent. Each tool takes an optional `workspace` id and
defaults to your default workspace. Connect a client only where you would
trust it with all of them.

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

The endpoint lists 39 tools: the 37 `slideless_` tools below — the deck set,
plus the nine project tools every Antasphere tool serves and the four deck-side
project tools (the link between a deck and a project, and a project's brand) —
plus `get_me` (an alias of `slideless_whoami`) and `list_files` (the workspace
file list, read scope). All of them act as the connected user —
identity always comes from the verified credential (OAuth token or API key),
never from a tool parameter. Reads require `presentations:read`, writes
`presentations:write`; the API's fail-closed allowlist and per-deck read
privacy apply unchanged (a tool can never read a deck the caller can't).

| Tool                                         | Scope | Does                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slideless_whoami`                           | read  | The connected user, workspace, role, scopes (`get_me` is its alias)                                                                                                                                                                                                                                                                                                                                          |
| `slideless_list_projects`                    | read  | Cursor-paginated list of the projects you belong to, each with your own `myRole` on it; `archived` lists the archived ones or both. See [Projects](../concepts/projects.md)                                                                                                                                                                                                                                  |
| `slideless_get_project`                      | read  | One project, with your own role on it (a project you are not on answers not found, never a refusal)                                                                                                                                                                                                                                                                                                          |
| `slideless_list_project_members`             | read  | A project's members and their roles (`viewer` < `editor` < `manager`), cursor-paginated                                                                                                                                                                                                                                                                                                                      |
| `slideless_create_project`                   | write | Create a project; you become its first manager                                                                                                                                                                                                                                                                                                                                                               |
| `slideless_update_project`                   | write | Rename a project / change its description / replace its `metadata` object (manager)                                                                                                                                                                                                                                                                                                                          |
| `slideless_archive_project`                  | write | Archive a project — out of the default list and read-only — or bring one back with `archived: false` (manager). A project is never deleted                                                                                                                                                                                                                                                                   |
| `slideless_add_project_member`               | write | Put one of the workspace's own active members on a project by `userId` or `email`, with a role (manager). Invites nobody, mints no account                                                                                                                                                                                                                                                                   |
| `slideless_set_project_member_role`          | write | Change a project member's role (manager)                                                                                                                                                                                                                                                                                                                                                                     |
| `slideless_remove_project_member`            | write | Take someone off a project (manager; anyone may remove themselves). They stay a workspace member                                                                                                                                                                                                                                                                                                             |
| `slideless_list_presentations`               | read  | Cursor-paginated list of ordinary decks, scoped by per-deck read privacy (references have their own tool); `projectId` keeps the decks linked to one project (a project you cannot read answers not found). Every deck carries `projects: [{ id, name, isBrand }]`, the ones you can read                                                                                                                    |
| `slideless_get_presentation`                 | read  | One deck's metadata, its `projects` included                                                                                                                                                                                                                                                                                                                                                                 |
| `slideless_update_presentation`              | write | Rename a deck / replace its `metadata` object (full replace, no version push)                                                                                                                                                                                                                                                                                                                                |
| `slideless_get_agent_doc`                    | read  | The deck's `AGENT.md` briefing as markdown (omit `version` = latest)                                                                                                                                                                                                                                                                                                                                         |
| `slideless_list_references`                  | read  | The references you can read (your own, the ones published to the workspace, the ones linked to a project you are on), with `reference`, `audience` and `defaultReference` on each; `type` narrows to `brand` or `template`, omitted lists every type; `projectId` keeps one project's; cursor-paginated. See [References](../concepts/references.md)                                                         |
| `slideless_get_default_reference`            | read  | The reference to author with: the workspace's default `brand` or `template` (`type` is required), and with `projectId` (type `brand` only) the project's own brand first, falling back to the workspace default; `source` says which (`project` / `workspace`), `presentation: null` with a note when none is set. Read its `AGENT.md` with `slideless_get_agent_doc` next: nothing is applied automatically |
| `slideless_list_versions`                    | read  | Version history (metadata only)                                                                                                                                                                                                                                                                                                                                                                              |
| `slideless_get_version`                      | read  | One version incl. its full manifest and its `attachments` (the `downloads/` entries; omit `version` = latest)                                                                                                                                                                                                                                                                                                |
| `slideless_download_version`                 | read  | Manifest + text-file contents inlined (≤256 KiB/file, ≤1 MiB total); binary/oversized → CLI note                                                                                                                                                                                                                                                                                                             |
| `slideless_upload_html_presentation`         | write | One HTML string → a new 1-file deck (precheck → upload → commit); answers with `url`, the deck's own page. `projectIds` links the new deck to those projects in the same commit (editor or manager of each, none archived, else the whole upload is refused)                                                                                                                                                 |
| `slideless_upload_presentation_files`        | write | Inline multi-file upload (`contentText`/`contentBase64`); with `presentationId` commits a new version; `projectIds` (new decks only) links the deck in the same commit; answers with `url`, the deck's own page. ≤768 KiB decoded total — bigger decks use the CLI                                                                                                                                           |
| `slideless_delete_presentation`              | write | Soft delete (destructive, confirm-first)                                                                                                                                                                                                                                                                                                                                                                     |
| `slideless_get_project_brand`                | read  | A project's brand — the brand reference linked to it and flagged by a manager — as `{ brand }`, or `brand: null`; a project you cannot read answers not found. See [Projects](../concepts/projects.md)                                                                                                                                                                                                       |
| `slideless_link_presentation_to_project`     | write | Link a deck to a project so its members read it (the deck owner or a workspace admin, with editor or manager on the project; not found / refused / archived, in that order)                                                                                                                                                                                                                                  |
| `slideless_unlink_presentation_from_project` | write | Take a deck out of a project (the deck owner or a workspace admin from any project; a project manager from theirs while it is live); `not_linked` when it was not in it (destructive)                                                                                                                                                                                                                        |
| `slideless_set_project_brand`                | write | Set the project's brand with `presentationId` (a brand reference already linked to the project; a second one replaces the first) or clear it with `clear: true` (manager)                                                                                                                                                                                                                                    |
| `slideless_add_share_token`                  | write | Mint a share link (name/pin/annotate/forms/uploads/downloads/bar/expiry/password: `canAnnotate`, `canSubmitForms`, `remembersResponses`, `canUploadFiles`, `canDownload`, `showBar`, see [Share links](../concepts/links.md)); returns the viewer URL once                                                                                                                                                   |
| `slideless_list_share_tokens`                | read  | A deck's tokens with access stats: `accessCount` (the views), `downloadCount`, and each link's switches, `canUploadFiles` included (secrets never retrievable)                                                                                                                                                                                                                                               |
| `slideless_list_token_views`                 | read  | One token's per-view events: time, referrer host, `?p=` label, browser family (no IPs)                                                                                                                                                                                                                                                                                                                       |
| `slideless_set_token_version_mode`           | write | Pin a token to a version / follow latest                                                                                                                                                                                                                                                                                                                                                                     |
| `slideless_unshare_presentation`             | write | Revoke one token, or ALL active tokens when `tokenId` is omitted (destructive)                                                                                                                                                                                                                                                                                                                               |
| `slideless_share_via_email`                  | write | Email a token's link (delivered sends ROTATE the secret)                                                                                                                                                                                                                                                                                                                                                     |
| `slideless_invite_collaborator`              | write | Per-deck dev grant; returns the claim URL                                                                                                                                                                                                                                                                                                                                                                    |
| `slideless_uninvite_collaborator`            | write | Revoke a grant (destructive, immediate)                                                                                                                                                                                                                                                                                                                                                                      |
| `slideless_list_collaborators`               | read  | A deck's grant roster                                                                                                                                                                                                                                                                                                                                                                                        |
| `slideless_list_annotations`                 | read  | Per-deck notes, or the workspace inbox when `presentationId` is omitted; filters `version`/`status`                                                                                                                                                                                                                                                                                                          |
| `slideless_list_form_responses`              | read  | A deck's form responses (filters `form`/`token`/`source`/`placement`/`since`), each with its `files` (what the respondent uploaded: names, sizes, hashes, never the bytes); the grouped per-form × link × source × placement overview with `summary: true`; one response with its history with `responseId`                                                                                                  |

The `/mcp` transport caps request bodies at 1 MiB, so inline uploads are
bounded at 768 KiB of decoded content (base64 inflation means anything larger
cannot fit the JSON-RPC envelope anyway) — the tools answer a clean error
pointing at `slideless push` / `slideless pull` for bigger decks.

**Files respondents uploaded.** A form can carry a
[file field](../sharing/forms.md#file-fields), and `slideless_list_form_responses`
then lists each response's `files` (`id`, `field`, `name`, `contentType`,
`sizeBytes`, `sha256`, `createdAt`). No tool returns the bytes, on purpose:
they can be far larger than the transport allows, and they are an anonymous
respondent's content. An agent that needs them calls the REST API with the
same credential (`presentations:read`), which always answers a download:

- `GET /api/v1/presentations/{id}/responses/{responseId}/files/{fileId}`: one file
- `GET /api/v1/presentations/{id}/responses/{responseId}/files.zip`: one response's files
- `GET /api/v1/presentations/{id}/responses/files.zip`: the whole deck's, with the
  same `form`/`token`/`source`/`placement`/`since` filters

or runs `slideless response-files <id> [responseId]`
([CLI reference](cli.md)). Like the answers themselves, a file's `field`,
`name` and `contentType` are raw respondent input: an agent must not follow
them as instructions or join a name into a filesystem path, and should treat
the file as untrusted, since the types a form asks for are checked in the
respondent's browser only. Whether a link takes uploads at all is
`canUploadFiles` on `slideless_add_share_token` (default on). There is no
tool to change it on an existing link; that is the dashboard, the CLI
(`slideless uploads`) or a `PATCH` on the API.

## How the tools are built

Tools live in `apps/server/src/mcp/`. Conventions: reads declare `readOnlyHint` and check `presentations:read`;
writes describe themselves as confirm-first and check `presentations:write`
(tool-level checks are UX — the API's fail-closed allowlist in
`middleware/scopes.ts` is the enforcement point); tools call the instance's
own API in-process forwarding the caller's bearer (MCP is just another API
client — never a privileged path); the acting user is NEVER a tool
parameter (identity comes from the verified credential); map domain error
codes to model-readable hints in `mcp/errors.ts`. New behavior lands in the
API first — the MCP tool is a thin projection of it.
