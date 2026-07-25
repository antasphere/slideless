# Annotations

Annotator share links let reviewers leave notes directly on a shared deck — anchored to the exact text, spot, or region they mark — and give the owner one place to read, resolve, and pull those notes. No reviewer account is needed: the link is the whole credential.

## Create an annotator link

Any share link can carry the annotate capability:

- **Dashboard** — on the deck's page, create a share link and tick *"the recipient can leave notes"*.
- **CLI** — pass `--annotator` when sharing:

  ```bash
  slideless share DECK_ID --name "Alice" --annotator
  slideless share-email DECK_ID --to alice@example.com --annotator
  ```

- **MCP** — the `slideless_add_share_token` tool accepts `canAnnotate: true`.

Everything else about share links applies unchanged: pin the link to a version with `--to-version`, protect it with `--password`, expire it with `--expires`. See [cli.md](../agents/cli.md) for the full sharing reference.

### Placing the notes button

The reviewer's floating notes button sits at the bottom-right by default, which can cover something important in a particular deck. Its position is the one placement you control explicitly, with eight slots: the four corners and the four edge centers (`top-left`, `top`, `top-right`, `right`, `bottom-right`, `bottom`, `bottom-left`, `left`).

- **Dashboard** — a *Notes button position* select appears in the share-link dialog when annotations are enabled.
- **CLI** — `slideless share DECK_ID --annotator --badge-position top-left` (also on `share-email`).
- **MCP** — `slideless_add_share_token` accepts `badgePosition`.

An explicit choice is remembered as the deck's default, so the next annotator link on the same deck inherits it automatically; any link can still override it, and updating a link's position updates the deck default too.

Reviewers can also move the button themselves, from the gear in the annotation panel: their choice is saved to their own link only — it never changes the deck default or anyone else's link.

## What reviewers can do

Opening an annotator link shows the deck with a small annotation layer on top:

- **Select text** anywhere in the deck — an *Add note* button appears at the selection. The selected quote is captured the moment the composer opens and is saved exactly as previewed.
- **Pin a spot or mark a region** — the *Add pin* mode turns the deck static for a moment: a click drops a pin on that element (a button, an image, whitespace), a drag marks a rectangular region. Press *Esc* or *Done* to go back to browsing. This is also how non-textual content gets annotated.
- **Review their notes** — a badge opens a side panel listing the reviewer's notes in *Open* and *Resolved* tabs, with *Add a pin* as the panel's main action. Open notes render as numbered pins on the page; clicking a note jumps to the place it was made and highlights it — including across pages of a multi-page deck.
- **Adjust their view** — a gear in the panel opens a small settings dialog: a position grid moves the notes button (saved to their link, so it sticks across pages and visits), a switch hides the pins when the deck should read clean (per visit), and a footer shows the link's context — the version being viewed, when the link went live, and its expiry if one is set.

Notes are private per link: a reviewer sees only the notes made with their own link, never another reviewer's. Interacting with the annotation layer never navigates the deck — slide decks that react to clicks or keys stay where they are.

## How capture works

Every capture follows the same three-part pattern, whichever way it starts:

1. **The anchor freezes immediately.** The moment the *Add note* button appears on a selection, or a pin or region lands in *Add pin* mode, the anchor — the quote, the element, the exact position — is snapshotted. Nothing you do afterwards (typing, clicking, selecting other text) changes what gets saved: what the composer previews is exactly what is stored.
2. **The pending note previews itself in place.** While the composer is open you see a pulsing provisional pin carrying the number the note will take, a dashed contour around the DOM element the anchor attaches to, and — for regions — the rectangle you drew. The preview is rendered by re-resolving the frozen anchor through the same lookup a saved note uses later, so it shows precisely where the note will land when the deck is reopened. For a text selection the contour outlines the containing element (typically the paragraph), which is what the anchor stores alongside the quoted text.
3. **The composer places itself beside the indicator, never on top.** It tries the right side first, then the left, then below, then above, always staying inside the viewport and never covering the pin, the region, or the selection. There is deliberately no placement setting — the auto-placement is the behavior.

## How anchors work

Each note stores a layered anchor: the page it was made on, a stable element path, the quoted text with its surrounding context, and — for pins and regions — the position as a fraction of the target element's box, so anchors survive window resizes and reflows. When the deck changes, resolution degrades gracefully: if the exact element is gone, the quote is searched for; if that fails too, the note is shown with its captured quote instead of a pin, never an error.

Two current limits are worth knowing:

- Anchors resolve against the version the note was made on; on a *latest* link the deck may have moved on, in which case resolution falls back as described.
- Content rendered inside a nested iframe within a deck page cannot be annotated yet — the page around it can.

## The owner workflow

Reviewer notes land with the deck, tagged with the version they were made on and an `open` or `resolved` status:

- **Dashboard** — the deck page's *Annotations* panel lists notes with their anchors, filterable by version and status, with *Resolve*, *Reopen*, and *Delete* per note.
- **CLI** —

  ```bash
  slideless pull-annotations DECK_ID --status open   # list / export notes
  slideless annotation resolve DECK_ID ANNOTATION_ID # mark one handled
  slideless annotation reopen DECK_ID ANNOTATION_ID  # flip it back
  ```

  `pull-annotations --json` includes each note's full anchor, so agents can act on exactly the element or text the reviewer marked.

- **MCP** — `slideless_list_annotations` lists a deck's notes, or the whole workspace's inbox when no deck is given.

Resolving is owner-side only: reviewers cannot change a note's status, but they see their note move to the *Resolved* tab once the owner handles it.

## Limits

Notes are capped at 10,000 characters and anchors at 8 KB; writes are rate-limited per link. Annotation content is treated as untrusted input everywhere it is displayed.
