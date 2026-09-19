# References

A reference is a deck the workspace keeps to make other decks from. It is a deck like any other: it
has versions, files, an owner and share links. What makes it a reference is one line in its
`AGENT.md`. An agent that authors a new deck fetches the reference, reads it, and builds the new deck
from what it read.

There are two types today:

- **A brand** holds how the company looks and sounds: fonts, colours, backgrounds, shapes, motion
  and voice. Its pages show the brand applied, and its files carry the logo and the fonts.
- **A template** holds the structure of a recurring deck: what the deck is for, which pages it has
  and how to fill them. Its pages are the model to copy.

`brand` and `template` are names for the same thing underneath. The API calls it `reference`.

## The type comes from the file

The reserved `AGENT.md` at the root of the bundle (see
[Deck self-description](../agents/deck-self-description.md)) may start with a frontmatter: a YAML
block between two `---` lines, at the very top of the file. A frontmatter whose `type` is `Brand` or
`Template` makes the deck a reference of that type. The match ignores case, and the API returns the
type in lowercase.

Every reference carries the same first fields:

| Field         | What it holds                                  |
| ------------- | ---------------------------------------------- |
| `type`        | `Brand` or `Template`                          |
| `title`       | The name of the reference                      |
| `description` | One or two sentences on what it is             |
| `tags`        | A list of free words                           |
| `timestamp`   | When the content was last revised, as ISO 8601 |

Then come the fields of the type. A brand has `fonts`, `colors`, `background`, `shape`, `motion` and
`voice`. A template has `purpose`, `pages` and `fill`. Slideless stores every field as you wrote it.
It reads `type` and nothing else, so the shape inside each field is yours to choose.

The text under the frontmatter is the prose an agent reads. The frontmatter says what can be said in
values. The prose says the rest: the judgement calls, the things never to do, where each file is.

The frontmatter must close within the first 16 KB of the file, and it must stay under 16 KB once
parsed.

### A brand

```markdown
---
type: Brand
title: Northwind Freight brand
description: The look and the voice of every Northwind Freight deck.
tags: [brand, northwind]
timestamp: 2026-09-12T09:00:00Z
fonts:
  heading:
    family: Fraunces
    weights: [600, 700]
    source: assets/fonts/fraunces.woff2
  body:
    family: Inter
    weights: [400, 500]
    source: assets/fonts/inter.woff2
  mono:
    family: JetBrains Mono
    weights: [400]
    source: assets/fonts/jetbrains-mono.woff2
colors:
  - name: Harbour
    hex: '#0B3954'
    role: primary, headings and the cover background
  - name: Signal
    hex: '#FF6B35'
    role: accent, one element per page at most
  - name: Chalk
    hex: '#F7F5F0'
    role: page background
  - name: Ink
    hex: '#1B1B1E'
    role: body text
  - name: Tide
    hex: '#8FB8C9'
    role: chart fills and secondary surfaces
background:
  default: Chalk, flat
  cover: Harbour, flat, with the white logo bottom left
  never: gradients, photographs behind text
shape:
  radius: 4px
  border: 1px solid Ink at 12% opacity
  logo: assets/logo.svg
  logoInverse: assets/logo-white.svg
  logoClearSpace: the height of the N on every side
motion:
  transitions: fade, 200ms, ease-out
  never: slide-in text, bouncing, parallax
voice:
  tone: plain, direct, numbers before adjectives
  person: we
  avoid: [seamless, world-class, synergy]
  example: We moved 41,000 containers in Q2, 6% more than in Q1.
---

# Northwind Freight brand

This deck is the brand of Northwind Freight. Read it before you build a deck for us, and copy the
values above as they are.

Page 1 is the cover as we use it. Page 2 shows the palette with each colour in its role. Page 3
shows the type scale. Page 4 shows a chart drawn the way we draw them: Tide for the series, Signal
for the one figure we want read first.

The logo files are `assets/logo.svg` and `assets/logo-white.svg`. Use them as they are. Do not
redraw the logo, do not recolour it, and keep the clear space around it.

Signal is loud on purpose. One Signal element per page is the rule, and a page with none is fine.

Write the way the example sentence reads. A reader should find the number in the first five words.
```

### A template

```markdown
---
type: Template
title: Quarterly business review
description: The deck account managers present to a customer at the end of each quarter.
tags: [template, qbr, customer]
timestamp: 2026-09-15T14:30:00Z
purpose: >
  Show a customer what we delivered in the quarter, what went wrong, and what we propose for the
  next one. Presented live in 30 minutes, then left with the customer as a link.
pages:
  - Cover. Customer name, the quarter, the account manager.
  - The quarter in three figures. Volume shipped, on-time rate, claims.
  - Volume by lane. One bar chart, this quarter against the last.
  - On-time performance. One line chart by week, with the contract target drawn as a line.
  - Incidents. One row per incident, with its cause, its cost and what changed after it.
  - Next quarter. Up to three proposals, each with its expected effect.
  - Questions. The contact details of the account team.
fill:
  data: Put the figures in downloads/figures.csv and draw the charts from that file.
  keep: The page order, the chart types, the footer.
  change: Every figure, every customer name, the incidents, the proposals.
  length: Seven pages. Remove the incidents page only when the quarter had none.
  language: The customer's language. Keep the page titles short enough for one line.
---

# Quarterly business review

This deck is the model for a quarterly business review. Copy its pages, keep their order, and
replace the content with the customer's quarter.

The sample figures belong to an invented customer. Never leave one of them in a real deck: every
number on every page is replaced, or its page is removed.

The three figures on page 2 are the ones the customer's contract names. When a contract names
different ones, use those and keep three.

The incidents page is the one customers read most closely. State the cause in plain words. A page
that says nothing went wrong, when something did, costs more than the incident.

Apply the workspace's brand on top of this template. The template carries structure, the brand
carries the look.
```

## A frontmatter that cannot be used

The classification never refuses a push. When the frontmatter is malformed, too large, or names a
type Slideless does not know, the push succeeds and the deck stays an ordinary deck. The push answer
carries one sentence that says what was unusable, in `version.referenceWarning`, and the CLI prints
it. For example:

```json
{
  "version": {
    "version": 4,
    "reference": null,
    "referenceWarning": "AGENT.md frontmatter names the type \"Palette\", which is not a known reference type (brand, template); the deck was saved as an ordinary deck."
  }
}
```

Fix the file and push again. The next version is classified afresh.

An `AGENT.md` with no frontmatter, or with a frontmatter that has no `type`, is an ordinary briefing.
It raises no warning.

## Existing decks

A deck is classified when a version is pushed. A deck that already exists stays an ordinary deck
until its next push, even when its `AGENT.md` already carries a usable frontmatter. Push it once and
it becomes a reference.

## What the API returns

A deck carries three fields for this, on every read:

- `reference`: the frontmatter of the current version as an object, with `type` in lowercase. It is
  `null` on an ordinary deck.
- `audience`: `private` or `workspace`.
- `defaultReference`: `true` or `false`.

Each version carries its own `reference` and `referenceWarning`, so the history shows what each push
declared.

## The audience

The audience says who in the workspace reads a reference. It is a property of the deck. It is never
a field of the frontmatter, so nobody changes it by editing a file.

- `private` is the default. The reference follows the ordinary deck rule: its owner, the workspace's
  admins and owners, and the collaborators invited on it ([Workspaces](workspaces.md)).
- `workspace` opens the reference to every member of the workspace. They read the deck, its versions
  and its files. Nobody gains the right to push to it or to change it.

Guests do not read a workspace reference through the audience. A guest is someone whose only access
is a collaborator invitation on one deck, and that invitation stays the way to show an outsider a
reference.

Whoever administers the deck sets the audience: its owner, or a workspace admin or owner.

```http
PATCH /api/v1/presentations/{id}
Content-Type: application/json

{ "audience": "workspace" }
```

The answer is the updated deck. The refusals:

| Answer                  | When                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `422 not_a_reference`   | The deck is an ordinary deck. Only a reference has an audience.       |
| `403`                   | You read the deck but do not administer it.                           |
| `404`                   | You cannot read the deck.                                             |
| `409 default_reference` | The deck is the default of its type. Clear the default first (below). |

## The default reference

A workspace has at most one default reference per type: one default brand, one default template. The
default is the one an agent takes when nobody names another.

A workspace admin or owner sets it:

```http
PATCH /api/v1/presentations/{id}
Content-Type: application/json

{ "defaultReference": true }
```

The rules:

- The reference must have the `workspace` audience. On a private reference the call answers
  `409 audience_private`. A default that most members cannot read would be of no use to them.
- Setting a default clears the previous default of that type. There is no moment with two.
- `{ "defaultReference": false }` clears it. The workspace then has no default of that type.
- A default reference cannot return to `private` while it is the default
  (`409 default_reference`). Clear the default, then change the audience.
- Deleting a default reference is allowed. The workspace then has no default of that type.
- On an ordinary deck the call answers `422 not_a_reference`.

## When a reference stops being one

Each push classifies the deck again, from the new version's `AGENT.md`.

- **The new version has no usable frontmatter.** The deck becomes an ordinary deck in that same
  push. Its audience returns to `private` and it stops being the default. A later push that brings
  the frontmatter back makes it a reference again, but a private one: someone has to choose the
  `workspace` audience again. A deck never reopens to the workspace through a file alone.
- **The new version changes the type**, from brand to template or the other way. The deck keeps its
  audience and stops being the default, since it was the default of a type it no longer has.

The push answer says so. When a push takes the audience back to `private` or drops the default, the
version's `referenceWarning` carries a sentence that names what the deck lost, after the sentence on
the frontmatter when there is one. The CLI prints it, so the person who pushed knows at once.

## Duplicating a reference

A duplicate copies one version of a deck. When that version is a reference, the duplicate is a
reference of the same type. It is private and it is never the default, whatever the original was.

## Listing references

References leave the ordinary list. `GET /api/v1/presentations` with no `type` returns ordinary
decks only. The `type` parameter lists references instead:

```http
GET /api/v1/presentations?type=brand
GET /api/v1/presentations?type=template
GET /api/v1/presentations?type=reference
```

`brand` and `template` list the references of that type, and `reference` lists every reference. The
list holds what you can read: your own references, the ones you collaborate on, and every reference
with the `workspace` audience. Admins and owners see them all.

Add `default=true` to keep only the default references:

```http
GET /api/v1/presentations?type=brand&default=true
GET /api/v1/presentations?default=true
```

The first call answers "which deck is the house brand" in one request. It returns one deck, or none
when the workspace has no default brand. The second returns the default of every type: `default=true`
with no `type` means `type=reference`.

Agents connected over MCP have two tools:

- `slideless_list_references` takes a `type` and lists the references of that type.
- `slideless_get_default_reference` takes a `type` and returns the workspace's default of that type.

The CLI carries the same operations ([CLI](../agents/cli.md)).

## Reusing a reference's files

A reference's files follow the reference's rule: whoever reads the reference reads its files. So a
member who reads a workspace brand can put its logo in their own deck without uploading it again.
The push asks the instance which files it is missing, and the instance answers that the logo is
already present. The bytes are stored once in the workspace ([Versions](versions.md)).

This holds for as long as you read the reference. A file of a reference you cannot read counts as
missing, and the push uploads it.

## Provenance

A deck made from references records them in its `metadata`, under `references`:

```json
{
  "references": [
    { "type": "brand", "id": "0b7e2c1a-5d8f-4a36-9c41-7f2e6d3b9a10", "version": 3 },
    { "type": "template", "id": "c4a1f9e2-3b6d-4e87-a2f5-1d9c8b7e6f04", "version": 7 }
  ]
}
```

Each entry names the type, the reference's deck id and the version that was read. The version
matters: a reference keeps changing, and the entry says which state of it the deck came from.
`metadata` is replaced whole on a `PATCH`, so keep `references` when you change another key
([Deck self-description](../agents/deck-self-description.md#metadata)).

## Nothing is applied automatically

Slideless never changes a deck because a reference exists. A default brand does not restyle the
workspace's decks, and a new version of a template does not touch the decks made from it. A
reference is content that an agent fetches and reads. The deck that comes out is whatever that agent
wrote, and it stays as pushed.
