# Workspaces

A workspace is where decks, files, members, invitations and the audit log live. Everything you do in
Slideless happens in exactly one workspace at a time, and nothing crosses from one workspace to
another: a deck, a file, a member list or an audit row belongs to one workspace and is invisible from
every other, even on the same instance and even to that instance's other owners.

## One person, several workspaces

An account is a person, not a seat in one workspace. The same sign-in can belong to several
workspaces, with a different role in each: owner of your own, plain member of a client's. The
workspace switcher in the sidebar lists them. For the API, the CLI and agents, the workspace is a
per-request choice: send `X-Workspace-Id: <workspace id>`, or leave it out to land in your default
workspace. `GET /api/v1/me` lists the workspaces you can name and the one the request resolved to.

Being a member of a workspace is not a grant on its decks. Inside a workspace, a deck is readable by
its owner, by the workspace's admins and owners, and by the collaborators invited on it
([Decks](artifact.md)).

## Creating another workspace

The first workspace of a self-hosted instance is created at setup. After that, a signed-in person
creates another one from the workspace switcher, and becomes its owner. It starts empty: no deck, no
member and no audit row is carried over, and the workspace you were in is not told.

```http
POST /api/v1/workspaces
Content-Type: application/json

{ "name": "Client work" }
```

```json
{ "workspace": { "id": "5f0c…", "name": "Client work" } }
```

The name is 1 to 120 characters; surrounding spaces are trimmed. Pass the returned `id` as
`X-Workspace-Id` to work in the new workspace. The call accepts an `Idempotency-Key` header, so a
retried request never creates two.

Who can create one:

- **A browser session only.** API keys, OAuth tokens and MCP agents are refused: creating a workspace
  is a person's decision, never a credential's.
- **Not a guest.** Someone whose only access is a per-deck collaborator invitation cannot
  (`403 guest_forbidden`). A member of any workspace can, whatever their role there.
- **Within the operator's limit.** On a self-hosted instance one person can own up to
  `MAX_WORKSPACES_PER_USER` workspaces (10 by default); past it the call answers
  `403 workspace_limit_reached`. With the variable at `0`, creation is closed for everyone
  (`403 workspace_creation_disabled`). See
  [Deployment profiles](../self-hosting/deployment-profiles.md#limiting-workspace-creation).

`GET /api/v1/me` carries `canCreateWorkspace`, true when the call would be accepted right now. A
client shows or hides its "new workspace" entry from that one flag.

| Answer                            | When                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `201`                             | Created; the caller is its owner                                          |
| `400 validation_error`            | The name is missing, blank, too long, or carries control characters       |
| `401 unauthenticated`             | No session                                                                |
| `401 hub_grant_expired`           | Cloud: sign in with Antasphere again, then retry                          |
| `403 session_required`            | The caller is an API key or an OAuth token                                |
| `403 guest_forbidden`             | The caller is a guest everywhere                                          |
| `403 workspace_creation_disabled` | The operator closed creation                                              |
| `403 workspace_limit_reached`     | The caller already owns the maximum                                       |
| `403 hub_link_required`           | Cloud: the account is not linked to Antasphere                            |
| `403 hub_unavailable`             | Cloud: Antasphere could not be reached; check your workspaces, then retry |
| `403 hub_refused`                 | Cloud: Antasphere did not accept the creation                             |
| `429 rate_limited`                | More than 60 attempts in an hour from one address or one person           |
| `409`                             | The `Idempotency-Key` was reused with another body, or is in flight       |

## On Slideless cloud

On cloud a workspace is an Antasphere organization
([Antasphere account](../getting-started/antasphere-account.md)). Creating a workspace from Slideless
creates the organization at Antasphere, in your name, with you as its owner, and it appears in
Slideless at once. The number of organizations one person can own is Antasphere's limit. Members of
that organization are then invited and managed at `account.antasphere.com`, like every other
organization.

## Leaving and deleting

A workspace must keep at least one active owner, so the last owner cannot leave, be demoted or delete
their account while they are the only one. An account that belongs to several workspaces cannot be
deleted by an admin of one of them: that admin deactivates the membership instead, and the account
stays with its other workspaces.
