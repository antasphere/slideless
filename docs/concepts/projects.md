# Projects

A project is a subgroup of a workspace: a name, a description, a list of members, and the decks
linked to it. It is how a team that shares one workspace works on one client, one product or one
campaign without opening every deck to everybody.

A workspace membership is not a grant on its decks ([Workspaces](workspaces.md)). A project is the
grant. Someone you add to a project reads the decks linked to that project, and nothing else.

## What a project holds

- **A name and a description.** The description says what the project is for. Agents read it, so
  write it for a reader who has never seen the project.
- **Members**, each with one of three roles.
- **Decks**, linked from the deck side. A deck can sit in several projects at once.
- **A brand**, at most one, chosen among the [references](references.md) linked to the project.

A project belongs to one workspace and never crosses to another.

## The three roles

| Role        | What it can do                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Viewer**  | Read the project and every deck linked to it: the deck page, its versions, its files                                                                    |
| **Editor**  | Everything a viewer can, plus push new versions of the project's decks and add decks of their own                                                       |
| **Manager** | Everything an editor can, plus rename and describe the project, archive and unarchive it, add and remove members, change roles, set the project's brand |

A workspace's owners and admins act as managers on every project of their workspace, whether or not
they are members of it.

Any member of a workspace creates a project and becomes its first manager. Creating one asks for
nothing else.

## Members come from the workspace

Members are added from the workspace's own member list, by email or by user id. A project is never a
way into the workspace: nobody is invited from outside through it, and adding a stranger's address
answers `404 member_not_found` until that person is a member of the workspace.

A per-deck guest can never be a project member (`403 guest_target`). A guest is someone whose only
access is a collaborator invitation on one deck ([Workspaces](workspaces.md)); a project is a
workspace-level grouping, and it stays closed to them.

A project grant lasts as long as the membership under it. Remove someone from the project, or from
the workspace, and their access to the project's decks is gone on the next request.

Project membership is managed inside Slideless on both editions. On cloud, the workspace roster is
managed at Antasphere ([Antasphere account](../getting-started/antasphere-account.md)), but the
projects inside that workspace, and who is in them, stay in Slideless.

## Linking a deck to a project

Linking a deck widens who reads it, so it is the deck's own act: the deck's owner does it, or a
workspace admin or owner. Being a manager of the project is not enough to pull somebody else's deck
into it.

```http
PUT /api/v1/presentations/{id}/projects/{projectId}
```

Unlinking is looser, because it only narrows: the deck's owner does it, and so does a manager of the
project.

```http
DELETE /api/v1/presentations/{id}/projects/{projectId}
```

Unlinking a deck answers `409 not_linked` when the deck was not in the project. A deck that leaves a
project keeps every other project it belongs to.

A push lands a deck in a project directly. Name the projects on the push and the new deck, or the new
version, is in them when the push answers. The pusher must be an editor or a manager of each project
named.

Every deck payload carries the projects it belongs to:

```json
{
  "projects": [
    { "id": "8c1d…", "name": "Northwind", "isBrand": false },
    { "id": "3f7a…", "name": "Q3 campaign", "isBrand": true }
  ]
}
```

The list holds only the projects the caller can read, so two people looking at the same deck can see
different lists. That is the point: a project you are not in is not something a deck tells you about.

To list one project's decks:

```http
GET /api/v1/presentations?project=<project id>
```

## The project's brand

A project can name one of its decks as its brand. The deck must be a reference of type `brand`
([References](references.md)) and it must be linked to the project. Agents read it before they author
a deck for that project, the same way they read the workspace's default brand.

```http
PUT /api/v1/projects/{id}/brand
GET /api/v1/projects/{id}/brand
DELETE /api/v1/projects/{id}/brand
```

Setting it is a manager's act. A deck that is not a brand reference answers `400 not_a_brand`, and a
deck that is not linked to the project answers `409 not_linked`.

The link is live. A reference stops being a brand when a push removes the `type: Brand` line from its
`AGENT.md`, and at that moment it stops being the project's brand too. The project is then without a
brand until a manager names another one. Nothing is restyled, here as everywhere: a brand is content
an agent reads ([References](references.md)).

## Archiving

A project is archived, never deleted. Archiving is a manager's act, and it is reversible.

An archived project:

- leaves the default list, and comes back with `?archived=true` or `?archived=all`;
- is read-only. Its name, its description, its members and its brand are frozen;
- keeps its decks readable. Its members still open them, and every share link minted from them keeps
  working;
- accepts no push through it. A deck's own owner still pushes to their deck; what stops is pushing
  through the project's grant.

Anything an archived project refuses answers `409 project_archived`. Unarchive it and the same call
goes through.

```http
POST /api/v1/projects/{id}/archive
POST /api/v1/projects/{id}/unarchive
```

## A project you are not in does not exist

Someone who is not a member of a project, and is not an admin or an owner of its workspace, cannot
tell it exists. Every read of it answers `404`, never `403`: a name, a member list or a deck count is
not something a colleague can probe. The same rule the decks follow ([Decks](artifact.md)).

## The API

| Call                                            | What it does                                            |
| ----------------------------------------------- | ------------------------------------------------------- |
| `GET /api/v1/projects`                          | The projects you can read; `?archived=false\|true\|all` |
| `POST /api/v1/projects`                         | Create one; you become its manager                      |
| `GET /api/v1/projects/{id}`                     | One project                                             |
| `PATCH /api/v1/projects/{id}`                   | Rename it, change its description                       |
| `POST /api/v1/projects/{id}/archive`            | Archive it                                              |
| `POST /api/v1/projects/{id}/unarchive`          | Bring it back                                           |
| `GET /api/v1/projects/{id}/members`             | The roster                                              |
| `POST /api/v1/projects/{id}/members`            | Add a workspace member, with a role                     |
| `PATCH /api/v1/projects/{id}/members/{userId}`  | Change a member's role                                  |
| `DELETE /api/v1/projects/{id}/members/{userId}` | Remove a member                                         |
| `GET\|PUT\|DELETE /api/v1/projects/{id}/brand`  | Read, set or clear the project's brand                  |

`?archived=false` is the default, so a plain `GET /api/v1/projects` lists the live ones.

Every project payload carries `myRole` and `memberCount`, so a client knows what to show without a
second call. `myRole` is the role you hold, or the manager role you hold by being an admin or an
owner of the workspace.

For API keys and agents: reads need `presentations:read`, writes need `presentations:write`. There is
no scope of their own for projects, because a project is a way of reading and writing decks.

## The refusals

| Answer                          | When                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `404 not_found`                 | The deck or the member is not one you can see          |
| `404 project_not_found`         | No such project, or one you are not a member of        |
| `404 member_not_found`          | The email or the user id names nobody in the workspace |
| `403 insufficient_project_role` | Your role in the project does not carry the act        |
| `403 guest_target`              | The person named is a per-deck guest                   |
| `409 project_archived`          | The project is archived; unarchive it first            |
| `409 already_member`            | That person is already in the project                  |
| `409 not_linked`                | The deck is not linked to the project                  |
| `400 not_a_brand`               | The deck named as the brand is not a brand reference   |
