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
upfront whether a briefing exists without opening the manifest. A
`downloads/` folder is flagged the same way (`hasDownloads`, see
[Attachments](../concepts/attachments.md)): a deck that carries files should
say in its briefing what each file is and which page it belongs to, since the
files are handed out, never rendered.

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
on the deck's dashboard page (the Deck details panel, one click from the
[deck's own page](../concepts/artifact.md)), and `slideless push` prints a
reminder when a bundle ships none.

Because `AGENT.md` is an ordinary bundle file, every share link also serves
it publicly at `/v/{secret}/AGENT.md` — an agent handed only a viewer URL
can fetch the briefing directly. Do not put anything in it you would not
put in the deck itself. The link's agent index also inlines it, so an agent
fetching the share URL itself reads the briefing first
([Share links, read by agents](share-links-for-agents.md)).

### The frontmatter

`AGENT.md` may start with a frontmatter: a YAML block between two `---`
lines, at the very top of the file. The briefing follows it as before.

```markdown
---
type: Brand
title: Northwind Freight brand
description: The look and the voice of every Northwind Freight deck.
---

# Northwind Freight brand

This deck is the brand of Northwind Freight. Read it before you build a deck for us.
```

A `type: Brand` or `type: Template` makes the deck a **reference**: a deck
the workspace keeps to make other decks from. The server reads the
frontmatter once, at push, and returns it as `reference` on the presentation
and on the version. [References](../concepts/references.md) has the fields of
each type, the audience, the default and the list.

An unusable frontmatter never blocks a push. When it is malformed, too large
(over 16 KB) or names an unknown type, the push succeeds, the deck stays an
ordinary deck, and the push answer says what was unusable in
`version.referenceWarning`. An `AGENT.md` with no frontmatter, or with a
frontmatter that has no `type`, is an ordinary briefing and raises no warning.

`slideless brand new <dir>` and `slideless template new <dir>` scaffold a folder
whose `AGENT.md` already carries a correct frontmatter, with every field of the
type filled with an example to replace. `slideless reference push` is the push
that checks it: a folder whose `AGENT.md` is missing, carries no frontmatter, or
names no known type is refused before a single byte is uploaded
([CLI](cli.md#references-brand-template)).

## Which one to use

|          | `metadata`                        | `AGENT.md`                       |
| -------- | --------------------------------- | -------------------------------- |
| Lives    | On the presentation record        | Inside the bundle, per version   |
| Shape    | JSON object (≤16k serialized)     | Markdown prose                   |
| Changes  | Anytime via PATCH, no new version | With the content, on push        |
| Audience | Dashboards, filtering, automation | Agents about to present the deck |
| Public   | No (authenticated API only)       | Yes, through any share link      |
