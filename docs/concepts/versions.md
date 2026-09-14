# Versions

Every push is a new version of the deck, numbered from 1, and a version never changes once it is
committed. The owner keeps the whole history and can show, pull or duplicate any version; a
recipient sees one version, the one their link resolves to.

## What a version is

A version is the manifest of one push: every file's path, its `sha256`, its size and its content
type, plus the entry document, who pushed it (the owner or a collaborator) and three flags stamped
at commit: whether the bundle carries an `AGENT.md`, whether it embeds a form, and whether it
carries [attachments](attachments.md) (a `downloads/` folder).

Storage is content-addressed. Before uploading, the CLI asks the instance which of the pushed files'
hashes it is missing and uploads exactly those, so a version that changes one page uploads one page;
the other files of the manifest point at bytes already stored. A file with the same bytes in two
versions, or in two decks of the workspace, is stored once.

A push is also an optimistic write: it names the version it builds on, and a push that lands while
another one is running answers a clean retry error instead of silently reordering the history.

## Latest, or pinned

A share link opens either the latest version, always, or one version it is pinned to:

- **Always the latest version**: the recipient sees every push as it lands. This is the default.
- **Pin to a version**: the recipient stays on that version whatever you push afterwards.

You choose when you create the link and can change it later: **Change version…** on the link's row
in the share sheet of the [deck's page](artifact.md), `slideless pin <id> <tokenId> --to-version 2`
or `--latest`, a `PATCH` of the link on the API, or the MCP tool `slideless_set_token_version_mode`.

A pinned link is how a reviewer keeps looking at what they reviewed while you keep pushing, and how
a published link survives a version you regret: pin it back.

## What the owner sees

Hovering **Version history** in the deck's menu opens the versions beside it, newest first in a
list that scrolls: each one as a small live rendering, its version number, `Current` on the latest,
`Showing` on the one on screen, its file count, and how many times recipients were served that
version and took its files (the counts follow the link analytics' retention; the deck's total views
is the lifetime figure). Hovering the version badge on the right of the bar opens the same list.
Picking a version shows it on the page. **Open the full history…** opens the side panel: every
push with its rendering, when it was pushed, who pushed it (`Owner` or `Collaborator`), its size,
its file count and its counts. **Show** renders that version on the page and closes the panel;
the version badge follows. A version that carries attachments
shows its **Files** with each file's name and size and **All files (zip)**: each version keeps its
own files, so the history is where you see that version 3 replaced one file and added another
while version 1 kept its own three.

The same history is on the dashboard (the versions panel, with a preview per version), in the
terminal (`slideless versions <id>`, newest first, the numbers lining up with `pull --at`), on the
API (`GET /api/v1/presentations/{id}/versions`, and `/versions/{n}` for one version with its full
manifest and its attachments) and over MCP (`slideless_list_versions`, `slideless_get_version`).

## What a recipient sees

A recipient sees the version their link resolves to, named in the bar over the deck (`v3`), and
nothing about the others: not the history, not the version count, not another version's files. The version is served whole, its attachments
included when the link allows downloads. A recipient with an annotator link leaves notes on the
version they saw, and the note is stamped with that version.

## Getting a version back

`slideless pull <id> ./out` writes the latest version to disk byte for byte, attachments included,
and `--at 1` any earlier one. The CLI treats the answer as untrusted input on the way down: every
path is re-checked, every blob is capped at the size the manifest declared and verified against its
hash before it is written, and nothing is ever left executable.

## Versions and the rest of the deck

- **Duplicate** copies one version (the current one from the page, any one through the API) into
  a new deck at version 1; see [The deck is the artifact](artifact.md).
- **Rename** touches no version.
- **Delete** deletes the deck: versions are never deleted one by one.
- A version pushed by a collaborator is a version like any other, marked `Collaborator` in the
  history.
