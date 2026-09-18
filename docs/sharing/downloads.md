# Downloads

A deck can carry files that travel **with** it: a spreadsheet next to the report, the PDF of the slides, the raw data behind a chart. Put them in a `downloads/` folder at the root of the deck and push as usual. Every file in that folder is an **attachment** of the version it was pushed with, and whoever opens a share link can download them — one by one, or the whole set as a zip — unless you switch downloads off for that link. This page is the reference: the URLs, the API, the counting rules. The model (why files belong to a version, how storage keeps one copy across versions, where the files show) is [Attachments](../concepts/attachments.md), and the link they are handed out through is [Share links](../concepts/links.md).

## The convention

- `downloads/` at the root of the deck bundle is reserved: every file under it (nested folders included) is an attachment. Files elsewhere in the deck stay ordinary assets.
- Attachments are **pinned to the version**. A recipient downloads the set of the version their link resolves to: a link that follows the latest push always hands out the latest set; a link pinned to version 3 keeps handing out version 3's files after you push version 4. The version history is yours; recipients never see other versions.
- Storage is content-addressed and deduplicated, as for every deck file: a file you push again unchanged is stored once, and a new version re-uploads only what changed.
- `downloads.zip` at the root of the deck is reserved too: the viewer answers that URL with the version's archive, so a push carrying a root file of that name is refused. Anywhere else the name is free.
- An attachment is **handed out, never shown**. Whatever its type, it downloads with an `attachment` disposition and `nosniff`. An HTML file dropped in `downloads/` is a file to download, not a page of the deck: the viewer never renders it.
- The size limit per file is the instance's `MAX_FILE_SIZE_MB` (100 MB by default).

## What the recipient gets

On a share link, the attachments are reachable relative to the deck's own URL:

| URL                                 | What it serves                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v/SECRET/downloads/<name>`        | One attachment by its name (its path relative to `downloads/`), with the content type declared at push, `ETag` and `Range` like an asset                 |
| `/v/SECRET/downloads.zip`           | Every attachment of the version as one zip, named `<deck-title>-v<n>.zip`, streamed as it is built, stored without compression                           |
| `/api/v1/viewer/SECRET/attachments` | The list the recipient bar renders, readable by any script on the page too: `{ version, attachments: [{ name, path, sizeBytes, contentType, sha256 }] }` |

The three are behind the same rules as the deck itself: a revoked link answers 403, an expired one 410, an unknown one 404, and a password-protected link takes the password: the two `/v/` URLs the same way the deck does (the unlock cookie in a browser, the `x-viewer-password` header for a script); the list endpoint is cookie-less and takes the `x-slideless-unlock` proof the bar is handed, or `x-viewer-password`. Nothing here sets or reads a session; the link secret is the whole credential.

## The per-link switch

Every share link carries `canDownload`, **on by default**: files were put in `downloads/` to be handed out, so push + share hands them out with no extra step. Switch it off per link when a recipient should see the deck but not take its files:

- **API** — `canDownload: false` on `POST /api/v1/presentations/{id}/tokens`, or on a `PATCH` of an existing link.
- **MCP** — the `canDownload` argument of `slideless_add_share_token`.
- **CLI** — `--no-download` on `slideless share` and `slideless share-email`.

With downloads off, the deck still opens. The file and zip URLs answer 404 and the attachments list answers an empty `attachments` array with a 200, never a 403: the link is public, only the capability is absent, and a link holder learns nothing about a folder you chose not to hand out.

## The owner side

Every deck has a page of its own in the dashboard, at `/decks/<id>/present` ([The deck is the artifact](../concepts/artifact.md)): the deck full-page, with a bar at the top where you rename it, duplicate it, open its version history and create its share links. A push prints that URL and opens it. The version history there lists each version with the files it carried, so you can see that version 3 replaced one file and added another while version 1 kept its own three; each version's files download from the same list, one by one or as a zip. Links are made from that bar too, with the downloads switch on the create form.

The same version history is on the API. Signed in, or with an API key carrying `presentations:read`:

- `GET /api/v1/presentations/{id}/versions/{n}` now carries `attachments` beside the manifest, and both the presentation and each version carry `hasDownloads`.
- `GET /api/v1/presentations/{id}/versions/{n}/downloads.zip` is the version's set as a zip.
- `GET /api/v1/presentations/{id}/versions/{n}/downloads/{name}` is one attachment; a nested name is one path segment, percent-encoded (`sub%2Fnotes.md`).

Both routes follow the deck read rules: a deck you cannot read answers 404, never 403.

## Counting

Each link counts its downloads in `downloadCount`, next to its view count: one per file taken, one per zip, whatever the zip held. A download is never a view, and a view never a download. Repeat downloads count again. What never counts: `HEAD` requests, partial byte-range responses on a file (a download manager fetching in chunks, a media player seeking), revalidations the `ETag` answers with a 304, a file the storage could not serve, and your own dashboard previews. The zip does not serve ranges: every zip response is the whole archive, and it counts.

Each download is also recorded as an event with the link, the version served, the file's name (`NULL` for a zip) and when — and nothing else: **no IP address, no geolocation, no referrer, no user agent**, on any edition, self-hosted included. Events are pruned nightly with the view events, after `VIEW_EVENTS_RETENTION_DAYS` (default 90; `0` keeps them forever). The per-link counter is never pruned.

## What the recipient sees

A share link opens with a slim **bar** over the deck: the deck's title, the version the link resolves to (`v3`), the Antasphere mark, and, when the version carries attachments and the link allows downloads, a **Download** button. The button opens a menu listing each file with its size, one link per file, and **Download all** for the whole set as a zip. The deck itself is pushed down by the bar's height, never covered; a deck sized to the viewport scrolls by that height. The bar collapses to a thin handle at the top of the page (the **Hide this bar** button, or Esc while the bar has focus) and stays collapsed on that link for the rest of the browser tab; the handle, **Show the presentation bar**, brings it back.

The bar is part of the viewer's isolation, not an exception to it: it runs inside the same sandbox as the deck, holds nothing the deck could not already read (the link secret is in the page's own address), calls only the attachments list above, relative to the deck page and without cookies, and mounts in a shadow root so the deck's styles cannot restyle it and its styles cannot reach the deck. Clicks and keys on the bar stop at the bar: a deck script listening on the document in the usual way (the bubble phase) never sees them; one listening in the capture phase still does, as it does for the annotation layer.

Where it never appears: inside an [embed](embedding.md) or any iframe (the deck stays bare there), on the password gate, and on the error pages. With downloads off, the bar shows the title and the version without a Download button.

Two shapes of deck defeat the bar, by the deck's own choice: a body fixed to the viewport (`position: fixed; inset: 0`) ignores the push-down and sits under the bar, and a script that sets the bar's own loaded flag (`window.__slidelessTopbarLoaded = true`) before the page ends suppresses it. Neither weakens anything: the bar was already the deck's to cover or hide from inside its sandbox.

Every share link carries `showBar`, **on by default**. Switch it off per link to hand out a bare deck, nothing but the presentation itself:

- **API** — `showBar: false` on `POST /api/v1/presentations/{id}/tokens`, or on a `PATCH` of an existing link.
- **CLI** — `slideless share <id> --no-bar` (also on `share-email`).
- **MCP** — the `showBar` argument of `slideless_add_share_token`.
