# The deck is the artifact

A deck is one artifact in your account: one record with a page of its own, a history of immutable
versions, and share links created on top of it. Everything you do to a deck happens on that one
thing. A link is never the deck, only a door into it.

## One deck, one page

Every deck has a page of its own on the instance, at `/decks/<id>/present` (the master page): the
deck rendered full-page under a slim bar, behind your sign-in, on the app origin. It is the page a
push answers with, and the place links are made from.

- `slideless push` prints the page's URL as `url:` under its summary, and the first push of a
  folder (the one that creates the deck) opens it in your browser. Later pushes only print it;
  `--open` opens it on any push, `--no-open` never does, and a `--json` run or a run outside a
  terminal never opens anything.
- `slideless open ./deck` reopens the page from the folder at any time, with no key and no network
  call: the folder's `.slideless.json` carries the deck id and the instance.
- An agent pushing over MCP gets the same URL in the tool's answer (`url`, next to `presentation`
  and `version`).

The page is the owner's. It sits behind the session cookie on the app origin, never on the viewer
origin, and it is not what a recipient sees: a recipient sees a [share link](links.md).

## The bar

On the left, the deck's title. Click it for the deck's menu: **Artifact by** the owner (`You` on
your own deck) and **Updated** when, then **Rename**, **Duplicate**, **Share**, **Version history** (the current version
number beside it; hovering it opens every version with a live thumbnail, see
[Versions](versions.md)), **All decks**, and **Delete**.

On the right, for the version the page shows: **Download files** with the file count when that
version carries [attachments](attachments.md) (**All files (zip)** first, then each file by name),
the deck's total views, the version badge (`v3`, hovering it opens the versions too), and
**Open in dashboard**.

Under the bar, the deck itself, rendered through the same sandboxed frame the dashboard's preview
uses: user HTML never renders on the app origin outside that frame.

## Who sees what

- The deck's owner and the workspace's admins and owners get the whole bar: rename, share and
  delete are theirs.
- A collaborator invited on the deck gets the read-only bar: the version history and Duplicate,
  no rename, no share, no delete. The deck itself does not render for a collaborator on this page;
  the page says so and points at the dashboard, where the versions and the notes are.
- A guest (someone who claimed a collaborator invitation from outside the workspace) cannot
  duplicate: creating a deck is a workspace act.

The page only hides. Every act is enforced by the server, and a deck you cannot read answers 404,
never 403: whether a deck exists is not something a stranger can probe.

## Rename

**Rename** in the bar edits the title in place. The next `slideless push ./deck --title "New name"`
does the same while pushing a version, and `PATCH /api/v1/presentations/{id}` with a `title` renames
without pushing one (the MCP tool is `slideless_update_presentation`). The id, the versions and the
links do not change: a link a recipient holds keeps opening the renamed deck.

## Duplicate

**Duplicate** makes a new deck of your own from the deck's current version, without uploading
anything: the files are already stored, the copy points at the same bytes. The copy starts at
version 1, is titled after the source with ` (copy)` appended, keeps the source's kind, its
interactive flag and its metadata, and remembers which deck it came from (`remixedFrom`). It has
no share links, no collaborators and no annotations of its own. The menu entry is disabled while
the deck has no version yet.

A collaborator may duplicate a deck they were invited to, into a deck they own. The API form is
`POST /api/v1/presentations/{id}/duplicate` with an optional `version` (any version of the source,
the current one by default) and an optional `title`; it is open to API keys carrying
`presentations:write`.

## Delete

**Delete** asks first: `Delete this deck?`, and says what follows: the deck and its versions stop
resolving, and every share link dies with it. The deletion is soft (the record is kept, nothing
resolves), and it is the same act as `slideless delete <id>`, `DELETE /api/v1/presentations/{id}` and
the MCP tool `slideless_delete_presentation`.

## The dashboard

**Open in dashboard** leads to the same deck in the dashboard's layout, at `/decks/<id>`: a preview
card, the deck's details (its metadata and its `AGENT.md` briefing, see
[Deck self-description](../agents/deck-self-description.md)), and the panels for share links,
collaborators, annotations, form responses and versions. **Open the deck page** there leads back
to the deck's page.

The list of your decks is at `/decks`. It shows the decks you own and the decks you were invited
to; a workspace admin or owner sees every deck of the workspace.
