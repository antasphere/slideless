# Deck self-description: metadata + AGENT.md

A deck can describe itself through two complementary channels:

- **`metadata`** — a structured JSON object on the presentation, set through
  the API. Use it to attach whatever your workflow needs (client, stage,
  campaign, tags…) and build your own dashboard or card views on top of the
  API without waiting for Slideless to grow those fields.
- **`AGENT.md`** — a markdown briefing shipped _inside_ the deck bundle, at
  its root. It travels with the content and is versioned with it: an agent
  can read what a deck is, what data it contains, and how to present it —
  before downloading or rendering anything.

## Metadata

Any plain JSON object up to 16k serialized, opaque to the server. It comes
back on every presentation read (get and list), so external dashboards can
render cards from a single `GET /api/v1/presentations` call.

Set it at creation (the upload-session commit accepts `metadata`) or later:

```bash
# CLI: merge single keys, or replace the whole object
slideless meta <deckId> --set client=Acme --set priority=3
slideless meta <deckId> --replace '{"stage":"final"}'
slideless meta <deckId>           # print the current object
```

```
PATCH /api/v1/presentations/{id}
{ "metadata": { "client": "Acme", "stage": "final" } }
```

The PATCH **replaces the object wholesale** — read first and send the merged
result (the CLI's `--set` does exactly that for you). The same PATCH also
retitles a deck without pushing a new version: `{ "title": "New name" }`.

MCP agents use `slideless_update_presentation`; the object is visible in
`slideless_get_presentation` and `slideless_list_presentations`.

## AGENT.md

Put a file named exactly `AGENT.md` (case-sensitive) at the root of your
bundle and push. The server detects it at commit and flags the deck
(`hasAgentDoc` on the presentation and on each version), so an agent knows
upfront whether a briefing exists without opening the manifest.

Writing one is the deck **creator's** responsibility. A good briefing tells
an agent what a human would need to know before presenting: what the deck
is, who it is for, what each page covers, where the data lives, what may be
edited and what must not.

Reading it back:

```bash
slideless agent-doc <deckId>            # latest version
slideless agent-doc <deckId> --at 3     # a pinned version
```

```
GET /api/v1/presentations/{id}/agent-doc            # markdown bytes
GET /api/v1/presentations/{id}/agent-doc?version=3
```

MCP agents call `slideless_get_agent_doc`. The dashboard shows the briefing
on the deck page (Deck details), and `slideless push` prints a reminder when
a bundle ships none.

Because `AGENT.md` is an ordinary bundle file, every share link also serves
it publicly at `/v/{secret}/AGENT.md` — an agent handed only a viewer URL
can fetch the briefing directly. Do not put anything in it you would not
put in the deck itself.

## Which one to use

|          | `metadata`                        | `AGENT.md`                       |
| -------- | --------------------------------- | -------------------------------- |
| Lives    | On the presentation record        | Inside the bundle, per version   |
| Shape    | JSON object (≤16k serialized)     | Markdown prose                   |
| Changes  | Anytime via PATCH, no new version | With the content, on push        |
| Audience | Dashboards, filtering, automation | Agents about to present the deck |
| Public   | No (authenticated API only)       | Yes, through any share link      |
