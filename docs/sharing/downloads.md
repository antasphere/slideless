# Downloads

A deck can carry files that travel **with** it: a spreadsheet next to the report, the PDF of the slides, the raw data behind a chart. Put them in a `downloads/` folder at the root of the deck and push as usual. Every file in that folder is an **attachment** of the version it was pushed with, and whoever opens a share link can download them — one by one, or the whole set as a zip — unless you switch downloads off for that link.

## The convention

- `downloads/` at the root of the deck bundle is reserved: every file under it (nested folders included) is an attachment. Files elsewhere in the deck stay ordinary assets.
- Attachments are **pinned to the version**. A recipient downloads the set of the version their link resolves to: a link that follows the latest push always hands out the latest set; a link pinned to version 3 keeps handing out version 3's files after you push version 4. The version history is yours; recipients never see other versions.
- Storage is content-addressed and deduplicated, as for every deck file: a file you push again unchanged is stored once, and a new version re-uploads only what changed.
- An attachment is **handed out, never shown**. Whatever its type, it downloads with an `attachment` disposition and `nosniff`. An HTML file dropped in `downloads/` is a file to download, not a page of the deck: the viewer never renders it.
- The size limit per file is the instance's `MAX_FILE_SIZE_MB` (100 MB by default).

## What the recipient gets

On a share link, the attachments are reachable relative to the deck's own URL:

| URL                                 | What it serves                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/v/SECRET/downloads/<name>`        | One attachment by its name (its path relative to `downloads/`), with the content type declared at push, `ETag` and `Range` like an asset |
| `/v/SECRET/downloads.zip`           | Every attachment of the version as one zip, named `<deck-title>-v<n>.zip`, streamed as it is built, stored without compression           |
| `/api/v1/viewer/SECRET/attachments` | The list a recipient page renders: `{ version, attachments: [{ name, path, sizeBytes, contentType, sha256 }] }`                          |

The three are behind the same rules as the deck itself: a revoked link answers 403, an expired one 410, an unknown one 404, and a password-protected link takes the password the same way the deck does (the unlock cookie in a browser, the `x-viewer-password` header for a script). Nothing here sets or reads a session; the link secret is the whole credential.

## The per-link switch

Every share link carries `canDownload`, **on by default**: files were put in `downloads/` to be handed out, so push + share hands them out with no extra step. Switch it off per link when a recipient should see the deck but not take its files:

- **API** — `canDownload: false` on `POST /api/v1/presentations/{id}/tokens`, or on a `PATCH` of an existing link.
- **MCP** — the `canDownload` argument of `slideless_add_share_token`.

With downloads off, the deck still opens. The file and zip URLs answer 404 and the attachments list answers an empty `attachments` array with a 200, never a 403: the link is public, only the capability is absent, and a link holder learns nothing about a folder you chose not to hand out.

## The owner side

The version history of a deck keeps every version's attachments. Signed in, or with an API key carrying `presentations:read`:

- `GET /api/v1/presentations/{id}/versions/{n}` now carries `attachments` beside the manifest, and both the presentation and each version carry `hasDownloads`.
- `GET /api/v1/presentations/{id}/versions/{n}/downloads.zip` is the version's set as a zip.
- `GET /api/v1/presentations/{id}/versions/{n}/downloads/{name}` is one attachment; a nested name is one path segment, percent-encoded (`sub%2Fnotes.md`).

Both routes follow the deck read rules: a deck you cannot read answers 404, never 403.

## Counting

Each link counts its downloads in `downloadCount`, next to its view count: one per file taken, one per zip, whatever the zip held. A download is never a view, and a view never a download. Repeat downloads count again; `HEAD` requests, revalidations the `ETag` answers with a 304, and your own dashboard previews never count.

Each download is also recorded as an event with the link, the version served, the file's name (empty for a zip) and when — and nothing else: **no IP address, no geolocation, no referrer, no user agent**, on any edition, self-hosted included. Events are pruned nightly with the view events, after `VIEW_EVENTS_RETENTION_DAYS` (default 90; `0` keeps them forever). The per-link counter is never pruned.
