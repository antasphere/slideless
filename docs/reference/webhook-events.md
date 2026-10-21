# Webhook events

Every event type a Slideless instance delivers to a [webhook](../concepts/webhooks.md), with the subjects
it carries, the fields of its `data`, and an example delivery. The same catalog is served live, with the
JSON Schema of every `data`, on `GET /api/v1/webhooks/events`, by `slideless webhooks events` and by the
`slideless_webhook_events` MCP tool: an agent can discover the types without this page.

This page is generated from the catalog the instance boots on; do not edit it by hand. After changing an
event, run `pnpm --filter @slideless/server docs:webhook-events`.

## The envelope

Every delivery is one JSON object, the same for every type:

| Field         | What it is                                                                                |
| ------------- | ----------------------------------------------------------------------------------------- |
| `id`          | The event id: the same on every attempt and on a redelivery. Deduplicate on it            |
| `type`        | The event type, below                                                                     |
| `occurredAt`  | When it happened (ISO 8601)                                                               |
| `workspaceId` | The workspace it happened in                                                              |
| `subjects`    | What the event is about, under each subject's field (below); the keys a filter matches on |
| `data`        | The event's facts, per type below                                                         |
| `attempt`     | Which attempt this is, from 1                                                             |

The ids in the examples are made up; the dates are fixed.

## Subjects

A subject is what an event is about. An endpoint's filters name a subject by its key and list the ids it
accepts; the envelope carries the subject's value under its field. A subject's shape never varies:
`deckId` and `shareLinkId` hold one id, `projectIds` always holds a list, on every event that carries it.

| Key       | Envelope field         | What it is                                            |
| --------- | ---------------------- | ----------------------------------------------------- |
| `project` | `subjects.projectIds`  | The projects a deck belongs to, by id (always a list) |
| `deck`    | `subjects.deckId`      | A deck, by id                                         |
| `link`    | `subjects.shareLinkId` | A share link, by id                                   |

An event that does not carry a subject never matches a filter on it: an endpoint filtered on a deck
receives no `member.joined`.

## Every type

| Type                      | Subjects                  | What happened                                                                                                                                                                                                          |
| ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook.ping`            | none                      | A test delivery, sent on request from the endpoint page or the API.                                                                                                                                                    |
| `member.joined`           | none                      | A person joined the workspace by accepting an invitation.                                                                                                                                                              |
| `member.removed`          | none                      | A person was removed from the workspace by an owner or an admin.                                                                                                                                                       |
| `workspace.created`       | none                      | A workspace was created from inside the product.                                                                                                                                                                       |
| `apikey.created`          | none                      | An API key was created on the API keys page or through the API (not the command line’s own sign-in key).                                                                                                               |
| `apikey.revoked`          | none                      | An API key of the workspace was revoked from the API keys page or through the API (not a key revoking itself at logout).                                                                                               |
| `project.created`         | `project`                 | A project was created in the workspace.                                                                                                                                                                                |
| `project.archived`        | `project`                 | A project of the workspace was archived.                                                                                                                                                                               |
| `deck.created`            | `deck`, `project`         | A deck was created: its first version was pushed, or a deck was duplicated.                                                                                                                                            |
| `deck.version_committed`  | `deck`, `project`         | A new version of a deck was pushed.                                                                                                                                                                                    |
| `deck.updated`            | `deck`, `project`         | A deck’s settings changed (its title, its description, its form notifications…); `fields` names what.                                                                                                                  |
| `deck.deleted`            | `deck`, `project`         | A deck was deleted.                                                                                                                                                                                                    |
| `deck.project_linked`     | `deck`, `project`         | A deck was put in a project (at creation, or later).                                                                                                                                                                   |
| `deck.project_unlinked`   | `deck`, `project`         | A deck was taken out of a project.                                                                                                                                                                                     |
| `share_link.created`      | `deck`, `project`, `link` | A share link was made for a deck (preview links never emit).                                                                                                                                                           |
| `share_link.updated`      | `deck`, `project`, `link` | A share link changed; `changed` names the fields.                                                                                                                                                                      |
| `share_link.revoked`      | `deck`, `project`, `link` | A share link was revoked.                                                                                                                                                                                              |
| `share_link.sent`         | `deck`, `project`, `link` | A share link was sent by mail from the dashboard.                                                                                                                                                                      |
| `share_link.viewed`       | `deck`, `project`, `link` | A share link was opened. Grouped per link: the first view is sent at once, then at most one event per link per five minutes carrying the count and the facts of the views since the last one. No address, no identity. |
| `attachment.downloaded`   | `deck`, `project`, `link` | An attachment of a deck was downloaded through a share link (`name` null for the whole bundle).                                                                                                                        |
| `form.response_submitted` | `deck`, `project`, `link` | A form inside a deck received a response; `answers` carries it.                                                                                                                                                        |
| `form.response_edited`    | `deck`, `project`, `link` | A respondent edited their response through their edit link; `answers` is the new revision.                                                                                                                             |
| `form.file_uploaded`      | `deck`, `project`, `link` | A respondent dropped a file into a form field (before the response is submitted).                                                                                                                                      |
| `form.response_deleted`   | `deck`, `project`         | A form response was deleted from the dashboard.                                                                                                                                                                        |
| `collaborator.invited`    | `deck`, `project`         | Someone was invited to work on a deck.                                                                                                                                                                                 |
| `collaborator.revoked`    | `deck`, `project`         | A collaborator’s grant on a deck was revoked (by hand, or with a member’s removal).                                                                                                                                    |
| `collaborator.claimed`    | `deck`, `project`         | An invited collaborator claimed their grant on a deck.                                                                                                                                                                 |
| `annotation.created`      | `deck`, `project`, `link` | An annotation was left on a deck version, by a viewer through a share link or by a member.                                                                                                                             |
| `annotation.resolved`     | `deck`, `project`         | An annotation was marked resolved.                                                                                                                                                                                     |
| `annotation.deleted`      | `deck`, `project`         | An annotation was deleted.                                                                                                                                                                                             |
| `thumbnail.rendered`      | `deck`, `project`         | The still image of a deck version is ready.                                                                                                                                                                            |
| `thumbnail.failed`        | `deck`, `project`         | The still image of a deck version could not be made.                                                                                                                                                                   |
| `document.pushed`         | `deck`, `project`         | A document’s data was written (created, pushed, an answer cleared, moved to another template version) and a new version rendered; `changed` names the keys that moved.                                                 |
| `document.answered`       | `deck`, `project`, `link` | A form inside a document was answered and the answer landed in the document’s data (`answers.<form>`); the response itself is in `form.response_submitted`.                                                            |

## `webhook.*`

### `webhook.ping`

A test delivery, sent on request from the endpoint page or the API.

Subjects: none. A filter on any subject excludes it.

| Field        | Type           |
| ------------ | -------------- |
| `endpointId` | string         |
| `sentBy`     | string or null |

```json
{
  "id": "c7baf094-9bd3-4116-9a17-c69f0e43b713",
  "type": "webhook.ping",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {},
  "data": {
    "endpointId": "0b6ed495-ed49-472b-8c3e-7368c74b879b",
    "sentBy": "e26290b7-b1c7-4735-b0ab-1081694c47d6"
  },
  "attempt": 1
}
```

## `member.*`

### `member.joined`

A person joined the workspace by accepting an invitation.

Subjects: none. A filter on any subject excludes it.

| Field    | Type   |
| -------- | ------ |
| `userId` | string |
| `role`   | string |

```json
{
  "id": "6d0d8ee2-c1c1-4653-a24f-7e273d33a705",
  "type": "member.joined",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {},
  "data": {
    "userId": "e26290b7-b1c7-4735-b0ab-1081694c47d6",
    "role": "member"
  },
  "attempt": 1
}
```

### `member.removed`

A person was removed from the workspace by an owner or an admin.

Subjects: none. A filter on any subject excludes it.

| Field    | Type   |
| -------- | ------ |
| `userId` | string |

```json
{
  "id": "044991b8-98d0-4ed7-ba3b-27f8f817024e",
  "type": "member.removed",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {},
  "data": {
    "userId": "e26290b7-b1c7-4735-b0ab-1081694c47d6"
  },
  "attempt": 1
}
```

## `workspace.*`

### `workspace.created`

A workspace was created from inside the product.

Subjects: none. A filter on any subject excludes it.

| Field         | Type   |
| ------------- | ------ |
| `ownerUserId` | string |

```json
{
  "id": "71a2cdbc-5f12-4369-b82d-5ba75fdb0f17",
  "type": "workspace.created",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {},
  "data": {
    "ownerUserId": "e26290b7-b1c7-4735-b0ab-1081694c47d6"
  },
  "attempt": 1
}
```

## `apikey.*`

### `apikey.created`

An API key was created on the API keys page or through the API (not the command line’s own sign-in key).

Subjects: none. A filter on any subject excludes it.

| Field      | Type   |
| ---------- | ------ |
| `apiKeyId` | string |

```json
{
  "id": "be07e143-8025-469c-bde6-af41b344aecf",
  "type": "apikey.created",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {},
  "data": {
    "apiKeyId": "54cbcb2c-78ff-44db-a0f2-60c5af2557ec"
  },
  "attempt": 1
}
```

### `apikey.revoked`

An API key of the workspace was revoked from the API keys page or through the API (not a key revoking itself at logout).

Subjects: none. A filter on any subject excludes it.

| Field      | Type   |
| ---------- | ------ |
| `apiKeyId` | string |

```json
{
  "id": "1e9ddbad-a382-4dee-8016-b1b7c1cc73b3",
  "type": "apikey.revoked",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {},
  "data": {
    "apiKeyId": "54cbcb2c-78ff-44db-a0f2-60c5af2557ec"
  },
  "attempt": 1
}
```

## `project.*`

### `project.created`

A project was created in the workspace.

Subjects: `project` (`subjects.projectIds`).

| Field       | Type   |
| ----------- | ------ |
| `projectId` | string |
| `name`      | string |
| `createdBy` | string |

```json
{
  "id": "a6a4d3a3-550f-4cbc-84ec-0005e20a1f60",
  "type": "project.created",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "projectId": "5328eb51-71a5-43e1-afd7-fb665c97be6d",
    "name": "Atlas",
    "createdBy": "e26290b7-b1c7-4735-b0ab-1081694c47d6"
  },
  "attempt": 1
}
```

### `project.archived`

A project of the workspace was archived.

Subjects: `project` (`subjects.projectIds`).

| Field       | Type   |
| ----------- | ------ |
| `projectId` | string |
| `name`      | string |

```json
{
  "id": "ed00911b-c708-4132-8fc9-64ee96d0ae24",
  "type": "project.archived",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "projectId": "5328eb51-71a5-43e1-afd7-fb665c97be6d",
    "name": "Atlas"
  },
  "attempt": 1
}
```

## `deck.*`

### `deck.created`

A deck was created: its first version was pushed, or a deck was duplicated.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field         | Type           |
| ------------- | -------------- |
| `deckId`      | string         |
| `title`       | string         |
| `version`     | integer        |
| `projectIds`  | list of string |
| `ownerUserId` | string         |
| `remixedFrom` | string or null |

```json
{
  "id": "64733107-f69a-4de4-b9b2-e97e744900a5",
  "type": "deck.created",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "title": "Q4 launch",
    "version": 2,
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "ownerUserId": "e26290b7-b1c7-4735-b0ab-1081694c47d6",
    "remixedFrom": null
  },
  "attempt": 1
}
```

### `deck.version_committed`

A new version of a deck was pushed.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field          | Type    |
| -------------- | ------- |
| `deckId`       | string  |
| `version`      | integer |
| `title`        | string  |
| `authorUserId` | string  |
| `authorRole`   | string  |

```json
{
  "id": "8656c5aa-3134-4a16-82e2-0362a7b030bf",
  "type": "deck.version_committed",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "version": 2,
    "title": "Q4 launch",
    "authorUserId": "e26290b7-b1c7-4735-b0ab-1081694c47d6",
    "authorRole": "owner"
  },
  "attempt": 1
}
```

### `deck.updated`

A deck’s settings changed (its title, its description, its form notifications…); `fields` names what.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field    | Type           |
| -------- | -------------- |
| `deckId` | string         |
| `fields` | list of string |

```json
{
  "id": "cd72b316-4cd3-47ef-a2e4-9109d919f210",
  "type": "deck.updated",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "fields": ["title"]
  },
  "attempt": 1
}
```

### `deck.deleted`

A deck was deleted.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field    | Type   |
| -------- | ------ |
| `deckId` | string |
| `title`  | string |

```json
{
  "id": "7770827b-6e3d-428f-b8fb-ad6bb776284c",
  "type": "deck.deleted",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "title": "Q4 launch"
  },
  "attempt": 1
}
```

### `deck.project_linked`

A deck was put in a project (at creation, or later).

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field       | Type   |
| ----------- | ------ |
| `deckId`    | string |
| `projectId` | string |

```json
{
  "id": "5c173bcd-a54f-4ee9-8f60-eb5275185901",
  "type": "deck.project_linked",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectId": "5328eb51-71a5-43e1-afd7-fb665c97be6d"
  },
  "attempt": 1
}
```

### `deck.project_unlinked`

A deck was taken out of a project.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field       | Type   |
| ----------- | ------ |
| `deckId`    | string |
| `projectId` | string |

```json
{
  "id": "13f5ec64-1667-48e1-8996-3950c145f388",
  "type": "deck.project_unlinked",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectId": "5328eb51-71a5-43e1-afd7-fb665c97be6d"
  },
  "attempt": 1
}
```

## `share_link.*`

### `share_link.created`

A share link was made for a deck (preview links never emit).

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field           | Type            |
| --------------- | --------------- |
| `deckId`        | string          |
| `linkId`        | string          |
| `name`          | string          |
| `purpose`       | string          |
| `pinnedVersion` | integer or null |
| `expiresAt`     | string or null  |
| `hasPassword`   | boolean         |

```json
{
  "id": "624d5210-4ad4-4dd5-b3d0-380f2edc2c01",
  "type": "share_link.created",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "name": "Alice at Acme",
    "purpose": "share",
    "pinnedVersion": 2,
    "expiresAt": "2026-11-12T00:00:00.000Z",
    "hasPassword": false
  },
  "attempt": 1
}
```

### `share_link.updated`

A share link changed; `changed` names the fields.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field           | Type            |
| --------------- | --------------- |
| `deckId`        | string          |
| `linkId`        | string          |
| `name`          | string          |
| `purpose`       | string          |
| `pinnedVersion` | integer or null |
| `expiresAt`     | string or null  |
| `hasPassword`   | boolean         |
| `changed`       | list of string  |

```json
{
  "id": "a5c9d4a8-316c-4fb9-9347-ff501c402f17",
  "type": "share_link.updated",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "name": "Alice at Acme",
    "purpose": "share",
    "pinnedVersion": 2,
    "expiresAt": "2026-11-12T00:00:00.000Z",
    "hasPassword": false,
    "changed": ["expiresAt"]
  },
  "attempt": 1
}
```

### `share_link.revoked`

A share link was revoked.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field           | Type            |
| --------------- | --------------- |
| `deckId`        | string          |
| `linkId`        | string          |
| `name`          | string          |
| `purpose`       | string          |
| `pinnedVersion` | integer or null |
| `expiresAt`     | string or null  |
| `hasPassword`   | boolean         |

```json
{
  "id": "aa8f37ec-cd87-42a5-820d-00df8e8af00f",
  "type": "share_link.revoked",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "name": "Alice at Acme",
    "purpose": "share",
    "pinnedVersion": 2,
    "expiresAt": "2026-11-12T00:00:00.000Z",
    "hasPassword": false
  },
  "attempt": 1
}
```

### `share_link.sent`

A share link was sent by mail from the dashboard.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field           | Type            |
| --------------- | --------------- |
| `deckId`        | string          |
| `linkId`        | string          |
| `name`          | string          |
| `purpose`       | string          |
| `pinnedVersion` | integer or null |
| `expiresAt`     | string or null  |
| `hasPassword`   | boolean         |
| `recipient`     | string          |

```json
{
  "id": "0e72e2af-9ec9-4297-bfd6-70749f00cfeb",
  "type": "share_link.sent",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "name": "Alice at Acme",
    "purpose": "share",
    "pinnedVersion": 2,
    "expiresAt": "2026-11-12T00:00:00.000Z",
    "hasPassword": false,
    "recipient": "alice@acme.co"
  },
  "attempt": 1
}
```

### `share_link.viewed`

A share link was opened. Grouped per link: the first view is sent at once, then at most one event per link per five minutes carrying the count and the facts of the views since the last one. No address, no identity.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field             | Type            |
| ----------------- | --------------- |
| `deckId`          | string          |
| `linkId`          | string          |
| `version`         | integer or null |
| `views`           | integer         |
| `firstViewAt`     | string          |
| `lastViewAt`      | string          |
| `referrerHosts`   | list of string  |
| `placements`      | list of string  |
| `browserFamilies` | list of string  |

```json
{
  "id": "6670b82d-eb8b-459d-8b65-223a49888dbf",
  "type": "share_link.viewed",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "version": 2,
    "views": 3,
    "firstViewAt": "2026-10-13T09:25:12.000Z",
    "lastViewAt": "2026-10-13T09:29:47.000Z",
    "referrerHosts": ["mail.google.com"],
    "placements": ["newsletter"],
    "browserFamilies": ["chrome"]
  },
  "attempt": 1
}
```

## `attachment.*`

### `attachment.downloaded`

An attachment of a deck was downloaded through a share link (`name` null for the whole bundle).

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field     | Type           |
| --------- | -------------- |
| `deckId`  | string         |
| `linkId`  | string         |
| `version` | integer        |
| `name`    | string or null |

```json
{
  "id": "bb456a72-bf21-4892-ae9e-04ae2dcaee16",
  "type": "attachment.downloaded",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "version": 2,
    "name": "pricing.pdf"
  },
  "attempt": 1
}
```

## `form.*`

### `form.response_submitted`

A form inside a deck received a response; `answers` carries it.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field        | Type                                   |
| ------------ | -------------------------------------- |
| `deckId`     | string                                 |
| `formName`   | string                                 |
| `responseId` | string                                 |
| `revision`   | integer                                |
| `linkId`     | string or null                         |
| `version`    | integer                                |
| `source`     | string                                 |
| `placement`  | string or null                         |
| `answers`    | object of string or list of string     |
| `files`      | list of object { id, name, sizeBytes } |

```json
{
  "id": "a5e73cf3-a1f3-47c4-939f-868e15a0f2b5",
  "type": "form.response_submitted",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "formName": "feedback",
    "responseId": "bbf56563-7fe1-435d-9295-300ba1fed135",
    "revision": 1,
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "version": 2,
    "source": "link",
    "placement": "newsletter",
    "answers": {
      "comments": "Looks good, ship it."
    },
    "files": [
      {
        "id": "cc551649-3076-4957-8310-0b660a84f19d",
        "name": "brief.pdf",
        "sizeBytes": 482133
      }
    ]
  },
  "attempt": 1
}
```

### `form.response_edited`

A respondent edited their response through their edit link; `answers` is the new revision.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field        | Type                                   |
| ------------ | -------------------------------------- |
| `deckId`     | string                                 |
| `formName`   | string                                 |
| `responseId` | string                                 |
| `revision`   | integer                                |
| `linkId`     | string or null                         |
| `version`    | integer                                |
| `source`     | string                                 |
| `placement`  | string or null                         |
| `answers`    | object of string or list of string     |
| `files`      | list of object { id, name, sizeBytes } |

```json
{
  "id": "439c005a-05db-4f6e-bc01-17cf58603c8b",
  "type": "form.response_edited",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "formName": "feedback",
    "responseId": "bbf56563-7fe1-435d-9295-300ba1fed135",
    "revision": 1,
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "version": 2,
    "source": "link",
    "placement": "newsletter",
    "answers": {
      "comments": "Looks good, ship it."
    },
    "files": [
      {
        "id": "cc551649-3076-4957-8310-0b660a84f19d",
        "name": "brief.pdf",
        "sizeBytes": 482133
      }
    ]
  },
  "attempt": 1
}
```

### `form.file_uploaded`

A respondent dropped a file into a form field (before the response is submitted).

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field       | Type    |
| ----------- | ------- |
| `deckId`    | string  |
| `formName`  | string  |
| `linkId`    | string  |
| `uploadId`  | string  |
| `name`      | string  |
| `sizeBytes` | integer |

```json
{
  "id": "361305b5-7659-4986-97f8-7071f86af682",
  "type": "form.file_uploaded",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "formName": "feedback",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "uploadId": "5cfb4a47-443f-46a5-bc42-c3770f54b0c7",
    "name": "brief.pdf",
    "sizeBytes": 482133
  },
  "attempt": 1
}
```

### `form.response_deleted`

A form response was deleted from the dashboard.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field        | Type   |
| ------------ | ------ |
| `deckId`     | string |
| `responseId` | string |

```json
{
  "id": "b84bfc37-7730-4706-854c-9aec85dc91d2",
  "type": "form.response_deleted",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "responseId": "bbf56563-7fe1-435d-9295-300ba1fed135"
  },
  "attempt": 1
}
```

## `collaborator.*`

### `collaborator.invited`

Someone was invited to work on a deck.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field            | Type           |
| ---------------- | -------------- |
| `deckId`         | string         |
| `collaboratorId` | string         |
| `email`          | string         |
| `userId`         | string or null |

```json
{
  "id": "41162da3-a5e6-4409-9a3b-aa218d4cff26",
  "type": "collaborator.invited",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "collaboratorId": "ad329f78-98f8-4216-b21b-19b068607b57",
    "email": "alice@acme.co",
    "userId": null
  },
  "attempt": 1
}
```

### `collaborator.revoked`

A collaborator’s grant on a deck was revoked (by hand, or with a member’s removal).

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field            | Type           |
| ---------------- | -------------- |
| `deckId`         | string         |
| `collaboratorId` | string         |
| `email`          | string         |
| `userId`         | string or null |

```json
{
  "id": "49167a07-bdff-4dd1-854e-3c4a495f6e21",
  "type": "collaborator.revoked",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "collaboratorId": "ad329f78-98f8-4216-b21b-19b068607b57",
    "email": "alice@acme.co",
    "userId": null
  },
  "attempt": 1
}
```

### `collaborator.claimed`

An invited collaborator claimed their grant on a deck.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field            | Type           |
| ---------------- | -------------- |
| `deckId`         | string         |
| `collaboratorId` | string         |
| `email`          | string         |
| `userId`         | string or null |

```json
{
  "id": "d231548f-7687-4dc7-83da-f6928bdba1a8",
  "type": "collaborator.claimed",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "collaboratorId": "ad329f78-98f8-4216-b21b-19b068607b57",
    "email": "alice@acme.co",
    "userId": null
  },
  "attempt": 1
}
```

## `annotation.*`

### `annotation.created`

An annotation was left on a deck version, by a viewer through a share link or by a member.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field          | Type           |
| -------------- | -------------- |
| `deckId`       | string         |
| `version`      | integer        |
| `annotationId` | string         |
| `linkId`       | string or null |
| `authorName`   | string or null |

```json
{
  "id": "7139b185-33df-4f43-a31e-b23c2562dfec",
  "type": "annotation.created",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "version": 2,
    "annotationId": "3b8e38bb-1da1-4eb4-8d7d-aa018c325595",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "authorName": "Alice"
  },
  "attempt": 1
}
```

### `annotation.resolved`

An annotation was marked resolved.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field          | Type           |
| -------------- | -------------- |
| `deckId`       | string         |
| `version`      | integer        |
| `annotationId` | string         |
| `linkId`       | string or null |
| `authorName`   | string or null |

```json
{
  "id": "124b3150-9af0-49fc-bafc-217e3a232b19",
  "type": "annotation.resolved",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "version": 2,
    "annotationId": "3b8e38bb-1da1-4eb4-8d7d-aa018c325595",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "authorName": "Alice"
  },
  "attempt": 1
}
```

### `annotation.deleted`

An annotation was deleted.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field          | Type           |
| -------------- | -------------- |
| `deckId`       | string         |
| `version`      | integer        |
| `annotationId` | string         |
| `linkId`       | string or null |
| `authorName`   | string or null |

```json
{
  "id": "0ee5bf49-7ebc-4490-8e80-e16c4e010989",
  "type": "annotation.deleted",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "version": 2,
    "annotationId": "3b8e38bb-1da1-4eb4-8d7d-aa018c325595",
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "authorName": "Alice"
  },
  "attempt": 1
}
```

## `thumbnail.*`

### `thumbnail.rendered`

The still image of a deck version is ready.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field       | Type    |
| ----------- | ------- |
| `deckId`    | string  |
| `versionId` | string  |
| `version`   | integer |

```json
{
  "id": "b8b064d4-cc84-4705-a7eb-fe4d81a22307",
  "type": "thumbnail.rendered",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "versionId": "e3d79f36-2839-4319-b188-d5affbe0b149",
    "version": 2
  },
  "attempt": 1
}
```

### `thumbnail.failed`

The still image of a deck version could not be made.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field       | Type    |
| ----------- | ------- |
| `deckId`    | string  |
| `versionId` | string  |
| `version`   | integer |

```json
{
  "id": "9e6f5e4e-4bf3-4349-a4c1-1b4bbeccefc2",
  "type": "thumbnail.failed",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "versionId": "e3d79f36-2839-4319-b188-d5affbe0b149",
    "version": 2
  },
  "attempt": 1
}
```

## `document.*`

### `document.pushed`

A document’s data was written (created, pushed, an answer cleared, moved to another template version) and a new version rendered; `changed` names the keys that moved.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`).

| Field             | Type                          |
| ----------------- | ----------------------------- |
| `deckId`          | string                        |
| `version`         | integer                       |
| `templateId`      | string                        |
| `templateVersion` | integer                       |
| `source`          | "create", "push" or "upgrade" |
| `changed`         | list of string                |
| `authorUserId`    | string or null                |

```json
{
  "id": "27c8100f-b994-474b-b7a0-e75972878bd1",
  "type": "document.pushed",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"]
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "version": 2,
    "templateId": "83e7aff3-d0ab-42ac-be3e-935650af8338",
    "templateVersion": 1,
    "source": "push",
    "changed": ["tickets"],
    "authorUserId": "e26290b7-b1c7-4735-b0ab-1081694c47d6"
  },
  "attempt": 1
}
```

### `document.answered`

A form inside a document was answered and the answer landed in the document’s data (`answers.<form>`); the response itself is in `form.response_submitted`.

Subjects: `deck` (`subjects.deckId`), `project` (`subjects.projectIds`), `link` (`subjects.shareLinkId`).

| Field        | Type           |
| ------------ | -------------- |
| `deckId`     | string         |
| `version`    | integer        |
| `formName`   | string         |
| `responseId` | string         |
| `revision`   | integer        |
| `linkId`     | string or null |
| `answeredBy` | string or null |
| `changed`    | list of string |

```json
{
  "id": "d5ddd5fb-885e-4dba-965a-76c9734ef49a",
  "type": "document.answered",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "version": 2,
    "formName": "feedback",
    "responseId": "bbf56563-7fe1-435d-9295-300ba1fed135",
    "revision": 1,
    "linkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
    "answeredBy": "Alice at Acme",
    "changed": ["answers.feedback"]
  },
  "attempt": 1
}
```
