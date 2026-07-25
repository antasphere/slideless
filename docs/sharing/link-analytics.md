# Link analytics

Every share link already counts its opens (the _Views_ column next to each link). Link analytics goes one level deeper: each counted view is also recorded as its own event, so you can see **when** a link was opened, **which site** drove the visit, **which placement** it came from, and the **browser family** — per link, per view.

## What counts as a view

An event is recorded under exactly the same rule that increments a link's view counter, so the event list and the counter always agree:

- Only the deck's **entry load** counts — asset fetches (images, styles, sub-pages of a multi-file deck) never do, and neither do `HEAD` requests or password-gate challenges.
- Repeat opens from the same browser inside the de-dupe window (`VIEW_DEDUPE_WINDOW_MINUTES`, default 10 minutes) collapse into one view: reloads, second tabs, and browser prefetching don't inflate the list. Cookie-less clients (curl, SDKs) count every fetch.
- Your own dashboard previews are excluded — previewing your deck never shows up in its stats.

## What each event stores — and what it never stores

Each view event carries exactly four facts:

| Field          | What it is                                                                              |
| -------------- | --------------------------------------------------------------------------------------- |
| `occurredAt`   | When the view happened                                                                  |
| `referrerHost` | The **host** of the referring page (e.g. `docs.example.com`), or empty for direct opens |
| `placement`    | The link's `?p=` label, if the opened URL carried one (see below)                       |
| `uaFamily`     | A coarse browser family: `chrome`, `firefox`, `safari`, `edge`, `bot`, or `other`       |

Just as important is what is **never** stored, on any edition, self-hosted included:

- **No IP addresses.**
- **No geolocation.**
- **No full referrer URLs** — the referring page's path and query string are discarded before anything is written; only the host survives.
- **No raw User-Agent strings** — only the coarse family, without versions.

This is a fixed design decision, not a configuration default.

## Placement labels (`?p=`)

Append `?p=<label>` to any share link to tag where you placed it:

```
https://slides.example.com/v/SECRET/?p=newsletter
https://slides.example.com/v/SECRET/?p=hero
```

The same link can carry different labels in different places — the label is part of the URL you hand out, not of the link itself, so one link embedded in three spots gives you three distinguishable streams. Labels are limited to 64 characters from `A–Z a–z 0–9 . _ -`; anything else is stored as no label.

## Reading the stats

- **Dashboard** — on the deck's page, open a link's menu and pick _View activity_. Revoked links keep their history.
- **CLI** — `slideless views DECK_ID TOKEN_ID` (omit the token id to list the deck's links first; `--all` follows pagination, `--json` for scripts).
- **API** — `GET /api/v1/presentations/{id}/tokens/{tokenId}/views`, cursor-paginated, newest first. Reading a link's views takes the same permission as listing the deck's links.
- **MCP** — the `slideless_list_token_views` tool.

Deleting a share link keeps its recorded history in the database (the events survive for deck-level statistics), but revoking a link — the normal way to end access — keeps it fully browsable in the dashboard.

## Retention

View events are pruned nightly after `VIEW_EVENTS_RETENTION_DAYS` (default **90**). Set it to `0` to keep events forever. The per-link counters (`accessCount`, last opened) are separate and are never pruned.
