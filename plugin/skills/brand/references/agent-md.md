# Authoring the AGENT.md of a brand

The `AGENT.md` at the root of the brand folder is two things: the frontmatter, which says what can
be said in values and is what the server returns as the deck's `reference`; and the prose under
it, which says the rest, the judgement calls, the things never to do, where each file is, what is
verified and what is inferred. An agent authoring a deck reads both, end to end, before writing a
page. The server reads only `type`; every other field is kept as written, so the shape inside each
field is the brand's to choose.

## The frontmatter

```markdown
---
type: Brand
title: 'Tidewater brand'
description: The look and the voice of Tidewater Logistics, read from tidewater.example in March 2027; the company publishes no guidelines of its own.
tags: [brand, tidewater]
timestamp: 2027-03-04T10:00:00Z
fonts:
  heading:
    family: Archivo Narrow
    weights: [700]
    source: assets/fonts/ArchivoNarrow-Bold.woff2
    note: always uppercase, letter-spacing 0.02em; the open-licence file the site serves
  body:
    family: Inter
    weights: [400, 500]
    source: assets/fonts/Inter-400.woff2
    sources: [assets/fonts/Inter-400.woff2, assets/fonts/Inter-500.woff2]
  label:
    family: JetBrains Mono
    weights: [500]
    source: assets/fonts/JetBrainsMono-Medium.woff2
    note: 12px uppercase tracked 0.08em; captions, eyebrows, table keys
colors:
  - name: Harbour
    hex: '#0B3954'
    role: primary; headings, the cover background, the chart series
  - name: Signal
    hex: '#FF6B35'
    role: the one accent; the bullet dot and the highlighted figure, never type, at most one element per page
  - name: Chalk
    hex: '#F7F5F0'
    role: page background
  - name: Ink
    hex: '#1B1B1E'
    role: body text
  - name: Tide
    hex: '#8FB8C9'
    role: secondary surfaces and the second chart series
gradient:
  signature: 'linear-gradient(135deg, #0B3954, #8FB8C9)'
  use: covers and section openers only, never behind body text
background:
  default: Chalk, flat
  cover: Harbour, flat, with the white logo bottom left
  sections: Chalk and Harbour alternate; a Tide panel for figures
  never: gradients behind text, photographs behind text
shape:
  radius: 2px on containers, 999px on buttons and tags
  border: 1px solid Ink at 12% opacity
  bullet: a 6px Signal square, vertically centred on the first line
  divider: a 1px Ink hairline at 12%, full content width
  shadow: none
  icon: 1.5px stroke, 20px, the arrow after every call to action pointing up-right
  logo: assets/logo.svg
  logoInverse: assets/logo-white.svg
  logoClearSpace: the height of the T on every side
  logoMinimum: below 20px of height, the mark alone (assets/mark.svg)
motion:
  transitions: fade, 200ms, ease-out
  never: slide-in text, bouncing, parallax
voice:
  tone: plain, direct, the number before the adjective
  person: we for the company, you for the customer
  signature: Freight that keeps its word.
  lines: [On time is the only time., Every container, every day.]
  vocabulary: [lane, on-time rate, container, claim, promise]
  avoid: [seamless, world-class, synergy, solution]
  example: We moved 41,000 containers in Q2, 6% more than in Q1.
---
```

Field by field:

- `type`, `title`, `description`, `tags`, `timestamp`: the fields every reference carries. The
  title is the name `<ref>` resolves by, so write the one people will type. The timestamp is the
  date of the last revision of the content; bump it on every push that changes the brand.
- `fonts`: one entry per role the brand has (heading, body, label, mono, display …), each with the
  family, the weights the site actually uses, and the file path under `assets/fonts/`. Several
  files for one family: list them in `sources`. Say in a `note` what the site does with the face
  (case, tracking, where) and the licence situation when the face is commercial.
- `colors`: a list, each with the company's own name when the CSS gave one, the hex, and a role
  sentence: where it appears, what it never does. Logo-only colours are listed with that role.
- `gradient` and any other field the identity needs: the server keeps it. Add what an agent would
  otherwise have to guess.
- `background`: the default page, the cover, how sections alternate, what never happens.
- `shape`: radius (per element kind when they differ), border, the bullet, the divider, shadows,
  the icon style, the logo files, the clear space, the minimum size. This is where the graphic
  decisions from the capture land; one line each.
- `motion`: what moves, what never does.
- `voice`: tone, person, the signature line, the verbatim lines from the site, the vocabulary to
  keep, the words to avoid, one example sentence that sounds right.

## The quoting rule

The server reads the frontmatter with a YAML parser. In YAML a plain value that contains a space
followed by `#` ends at the `#`, which is a comment marker. Hex colours inside a gradient, or a
hash in a sentence, are cut silently and the brand goes out with half a value:

```yaml
signature: linear-gradient(90deg, #FF6B35, #0B3954) # read as "linear-gradient(90deg,"
signature: 'linear-gradient(90deg, #FF6B35, #0B3954)' # read whole
```

Double-quote any value that contains ` #`. Quote the `hex` values too, for the same reason and
for the editors that colour `#` as a comment. After the push, read the brand back
(`slideless brand list --json`, or the push's `--json` answer) and check the fields that carry a
hash arrived whole.

## The prose

Under the frontmatter, in this order, each as a short section:

1. **The opening line:** "This deck is the brand of …. Read it before you build a deck for this
   workspace, and copy the values in the frontmatter as they are." Then one sentence on the
   source and the date.
2. **Purpose:** which decks follow the brand, and the page map: what page 1 shows, page 2, and so
   on, so an agent knows which page to copy for which layout.
3. **Typography:** the faces in use, the scale as sizes, the case and tracking rules, the one or
   two things the site never does (no bold body, no mixed case in headlines).
4. **Colour:** the system in two sentences, then the accent rule, then the logo-only colours.
5. **Layout rules:** margins, the grid, where headlines sit, how sections alternate, the
   components (buttons, tags, tables, cards) in a line each.
6. **Imagery:** the photography register, the illustration style, how the mark relates to the
   graphic system.
7. **Tone:** how to write; the example sentence from the frontmatter, explained in a line.
8. **What to avoid:** one list, the things that would make a deck look off-brand at a glance.
9. **Assets:** every file in `assets/` named with what it is for; the fonts under `assets/fonts/`;
   the note that the pages embed the fonts as data URIs because the viewer sandbox does not load
   a relative font file.
10. **Provenance:** the material the brand was read from (the site at a date, the files the
    company handed over), the **verified** list (read from a file or a computed style) and the
    **inferred** list (deduced from how the site behaves), and the licence note on the fonts.

Keep the whole file under 16 KB of frontmatter (the server's limit) and the prose readable in one
sitting. Every example in the file is the company's own copy or an invented figure marked as one.
