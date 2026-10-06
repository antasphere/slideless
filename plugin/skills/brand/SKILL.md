---
name: brand
description: The three motions around a Slideless workspace brand. CREATE a brand from a company's own material (its website, its files) when the user says "make a brand for <company>", "set up the brand of this workspace", "extract their identity from the site", "I'm setting up <company>'s workspace"; the procedure captures the site (screens, computed styles, font files, logo SVGs, colours), distills the identity (palette with roles, type scale, the graphic decisions no hex carries), authors the AGENT.md contract, builds the pages that show the brand applied, verifies the fonts in a headless render, then pushes, publishes and sets the default through the slideless CLI. USE a brand when the user asks for a deck "on brand", "with our identity", "following the workspace brand": list, pull, read the contract and the pages, author, record the brand on the push. GENERALISE at the end of a session or when asked: list the human's brand-level changes and offer, item by item, to fold them back into the brand, pushing a new brand version only on an explicit yes. Not for templates (the same verbs under `slideless template`, a different content contract) and not for ordinary pushes.
---

# /brand

A **brand** in Slideless is a reference deck the workspace keeps to make other decks from. Three
things make it one: the `AGENT.md` at the bundle's root whose frontmatter starts with
`type: Brand` and carries the contract (fonts, colours, backgrounds, shapes, motion, voice), the
pages of the deck, which **show the brand applied** rather than describe it, one layout per page,
and `assets/`, which carries the logo files and the font files. The server classifies the deck at
push; the audience (private or workspace) and the workspace default are set afterwards and never
by a file. The model is the References page of the Slideless docs, and the flags are the CLI
reference (`docs/agents/cli.md` in the repository, "References: brand, template"); this skill
teaches the path and repeats no table.

Three motions. **Create** turns a company's own material into a brand. **Use** authors a deck
under one. **Generalise** folds a session's brand-level changes back into the brand. Read the
motion the user asked for; the others are context.

Every example below is invented: Tidewater Logistics at `https://tidewater.example`, a brand
titled "Tidewater brand". Never carry a real company into this file.

## Before any motion: where you are

```bash
slideless whoami                 # the identity, the instance, the workspace the commands run in
slideless workspaces             # every workspace you can act in, the current one marked
```

A brand belongs to one workspace. When the user named one, pass it on every command with
`--workspace <id>` (or `--org <hub organization id or name>` on a cloud instance); never rely on
the server's default when the user's intent names a workspace. `--json` on any command gives the
machine-readable answer, and the push answer's `reference:` and `warning:` lines are the ones to
read back to the user.

---

## Motion 1: Create a brand

The outcome is a brand folder on disk, pushed as the workspace's brand, with everything in it
verified against the company's own material. The procedure is long because every shortcut
produces a brand that is wrong in a way the company notices at once: the wrong weight of their
typeface, a colour one shade off, square bullets where they use dashes.

### 1. Ask what material exists, then look for more

Ask once, in one question: do they have brand guidelines (a PDF, a Figma, a Notion page), logo
files, font files? Whatever they hand over is the primary source and the website is the check.
With nothing handed over, the website is the primary source. Either way, look for:

- the website, every top-level page of its navigation, and any page named brand, press, media kit
  or guidelines;
- the social accounts (avatar and banner carry the mark at small size and the brand's photography);
- the `og:image`, the favicon and the touch icon (the mark alone, as the company crops it);
- a public press kit, found by a web search on the company name with "brand guidelines" and
  "press kit".

State what you found and what you did not. A company with no public guidelines is the common
case; say so in the brand's prose later (the "Provenance" section), because every rule you then
write is inferred from the site, not stated by the company.

### 2. Capture the site

Read `references/capture.md` in this skill's folder; it carries the recipe and a script
skeleton. The capture is headless (Chrome through `playwright-core`, a fixed 1440 px viewport)
and lands in a scratch folder **outside** the brand folder, because screens and audits are
working material, not brand assets. For each page:

- scroll the whole page first so lazy images load, then take the full-page screenshot and the
  viewport screenshot;
- read the computed styles: the font family and weight of every text element, the colours by
  frequency (text, backgrounds, borders), the gradients, the CSS custom properties (a Webflow,
  Framer or design-system site names its palette there, which is the company's own naming);
- list every `@font-face` with its source URL and weight, and download the files;
- save every inline `<svg>` that contains a brand colour (the logo usually ships inline in the
  header, in a light and a dark variant) and every `<img>` whose name says logo, mark, icon;
- record the headings with their size, weight, case and letter-spacing.

Download the fonts, the logos, the `og:image`, the hero imagery and any texture file (a hatching,
a grain, a pattern). Keep the original file names beside your renamed copies, so a value can be
traced back.

### 3. Distill the identity

Work from the audit, not from impression. Write the findings down as you go, in two columns,
**verified** (read from a file or a computed style) and **inferred** (a rule you deduced from how
the site behaves). The brand's prose will carry that split.

**Colours.** Name each colour by the company's own name when the CSS gave one, else by its role.
Give each a role sentence: where it appears and what it never does. The usual shape is one ink,
one paper, a run of greys, and one or two accents. Count how often the accent appears: a site
that uses its accent on one element per screen has a rule you must write down. Colours that live
only inside the logo are logo colours, not UI colours; say so.

**Type.** Each face with its weights as the site actually uses them (a site loads six weights and
uses two), its sizes at the reference viewport, its case and letter-spacing. Note the faces the
site loads and never uses. Note the licence: a commercial face (a foundry's) may be embedded in
the company's own brand, and the prose must say the file is the one the company serves.

**The graphic decisions no hex carries.** This is where a brand is recognised or not. Go through
the list and write one line each, from what the site does:

- bullets: square, round, dash, none, a glyph, an accent-coloured dot;
- corner radius: on containers, on buttons, on images, on tags, each separately (a site with
  square cards and pill buttons has two rules);
- borders: weight, colour, where (hairline grids, card outlines, dividers, none);
- dividers: a line, a hatching, a gradient band, whitespace only;
- shadows: none, one soft shadow on hover, elevated cards;
- icons: the set, stroke weight, size, the arrow after a call to action;
- buttons: shape, fill, the inverted variant on dark sections, the icon;
- grid and margins: content width, gutter, the number of columns, where headlines start;
- backgrounds: how sections alternate (paper, panel, inverted), the hero treatment;
- photography: documentary or staged, colour or monochrome, the recurring subject, the crop of
  portraits;
- illustration: the style, the stroke, how it relates to the mark;
- motion: what moves on the site, and what never does;
- voice: the taglines verbatim, the person (we, you), the register, the words the site repeats,
  the words it avoids.

**The logo.** Its variants (dark on light, light on dark, mark alone), its geometry (the viewBox),
the exact fills read from the SVG, how the site handles it small (the favicon is the company's
own minimum-size rule), and the clear space you observe around it.

### 4. Author the contract

```bash
slideless brand new ./tidewater-brand --title "Tidewater brand"
```

The scaffold writes an `AGENT.md` with every field of the type filled with invented values, an
`index.html` with one page per layout, and `assets/` with `assets/fonts/`. Replace everything.
Read `references/agent-md.md` in this skill's folder for the field-by-field guidance; the rules
that matter most:

- the frontmatter says what can be said in values (`fonts`, `colors`, `background`, `shape`,
  `motion`, `voice`; add `gradient`, `graphic` or any field the company's identity needs, the
  server keeps every field as written); the prose says the rest: the judgement calls, what never
  to do, where each file is, what is verified and what is inferred;
- **double-quote any value that contains a space followed by `#`** (a gradient with hex colours,
  a sentence with a hash): YAML reads ` #` as a comment and cuts the value there, silently;
- write the page map in the prose (page 1 is the cover as we use it, page 2 the palette …), so
  an agent reading the brand knows what each page shows;
- name every file in `assets/` and say what it is for;
- add a "Provenance" section: the source (the site at the capture date, the files the company
  handed over), the verified/inferred split, the licence note on the fonts.

Copy the logo SVGs into `assets/` byte for byte, never redrawn. Copy the font files into
`assets/fonts/`.

### 5. Build the pages that show the brand applied

Read `references/pages.md` in this skill's folder. The pages are not a guidelines deck; they are
the brand **applied**, one layout each, the pages an agent copies from when it authors a deck
under the brand. The set that serves most brands:

1. the cover as the company uses it;
2. the palette, each colour in its role;
3. the type scale, from the largest headline to the smallest label, with the button;
4. figures and a chart drawn the house way (the series colour, the one highlighted figure, the
   axis treatment, the gridlines or their absence);
5. the logo in its settings, and the mark alone at its minimum;
6. one content layout (a headline with a list, a two-column, a numbered list);
7. one inverted or accent section;
8. one image layout (the photography register, the caption treatment);
9. the closing page.

Rules that hold on every page: the fonts are **embedded as data URIs** in the HTML (the viewer
serves bundles in a sandbox where a relative font file does not load), and the same files stay
in `assets/fonts/` for decks that reuse them; the logos are referenced from `assets/`; nothing on
a page is invented beyond the company's own copy and figures, and a figure that is an example says
so in a caption; every page carries a small label naming its layout, so an agent can cite it.

### 6. Verify before pushing

Render the folder headlessly and check, by name, that every face loads
(`document.fonts.check('400 18px "Face Name"')` returns `true` for each). Screenshot every page
and look at each one: overflow, a fallback font, a swatch with the wrong hex, a cropped logo. A
brand with a wrong value is worse than none, because every deck inherits the error.

```bash
slideless dev ./tidewater-brand          # serve the folder locally with the viewer's own headers
```

### 7. Push, publish, set the default

```bash
slideless brand push ./tidewater-brand                 # creates the brand, named after the frontmatter's title
slideless brand list                                   # it appears, private, not the default
slideless brand publish "Tidewater brand"              # every member of the workspace reads it
slideless brand default "Tidewater brand"              # the one `slideless brand pull` fetches with no name (admin or owner)
```

Read the push summary's `reference:` line (type, title, private or published, default or not)
and its `warning:` line: `the instance classified this push as an ordinary deck` means the
frontmatter was unusable, fix it and push again. A later revision is `slideless brand push
./tidewater-brand --id <id>` (or from the pulled copy, `slideless brand push .slideless/brand`, as
its owner). A reference leaves the ordinary deck list by design: `slideless list` does not show
it, `slideless brand list` does.

### 8. Hand back

Tell the user: the brand's id and title, the workspace, its audience and default status, where
the source folder lives on disk and how to revise it, and the two lists from step 3: what is
verified and what is inferred. Name the fonts' licence situation in one sentence.

---

## Motion 2: Use a brand

1. **Which brand.** `slideless brand list`. When the user named none and a default exists (the
   row marked `*`), use the default and say so in one line. With no default, ask which one.
2. **Pull it beside the deck.** From the deck's folder, `slideless brand pull` (no name: the
   default; else `slideless brand pull "<ref>"`, `--at <n>` for a pinned version, `--into <dir>`
   to write elsewhere). It lands in `.slideless/brand/`, dot-prefixed so a push of the deck never
   carries it.
3. **Read it end to end.** `.slideless/brand/AGENT.md` first, the frontmatter and every section of
   the prose; then `index.html`, page by page, for the layouts and the CSS tokens; then list
   `assets/`. Do not author before the three are read.
4. **Author from the layouts and the tokens.** Copy the pages that fit, keep the CSS variables,
   copy the brand's assets into the deck's own `assets/` (identical bytes are never re-uploaded:
   the instance already holds them). Where the brand embeds its fonts as data URIs, keep that
   form. Where the deck needs a layout the brand has no page for, compose it from the brand's
   tokens and say so in the deck's own `AGENT.md`.
5. **Push with the brand recorded.** A push from the folder that pulled the brand records it by
   itself; to name one explicitly, or pin a version:

   ```bash
   slideless push ./deck --brand "Tidewater brand"@2
   ```

   A deck started as a copy of the brand is `slideless brand start "<ref>" ./deck`: the files
   copied, the `type:` line removed, the next push creating an ordinary deck that records the
   brand.

6. **Keep the deviations ledger** (below) from the first instruction.

---

## Motion 3: Generalise a session's changes back into the brand

While authoring, keep a short list of every instruction from the human that **contradicts or
extends the brand**, as opposed to a choice that belongs to this deck only. A colour changed, a
layout added, a rule relaxed, a word added to the avoid list: on the list. A chart that is blue
because this deck's data has four series: not on the list.

At the end of the session, or when the human asks, show the list and ask item by item whether to
generalise it into the brand. On a yes:

1. edit `.slideless/brand/AGENT.md` and the pages in `.slideless/brand/` to carry the change, and
   bump the frontmatter's `timestamp`;
2. show the diff;
3. `slideless brand push .slideless/brand` (the link file keeps the deck recording the brand at
   its new version).

With no write right on the brand (`This brand is not yours to push`), write the proposed change to
a file beside the deck and say who owns the brand. **Never push a brand without the human's yes**,
and never bundle several items into one yes.

---

## What this skill never does

- Invent a brand value. A colour, a weight, a radius comes from a file, a computed style or the
  human; when none gives it, the prose says it is inferred.
- Redraw, recolour, outline or re-space a logo.
- Put a credential, a key or an internal URL into a brand or a deck.
- Scrape behind a login, or take material the company did not publish or hand over.
- Treat a template as a brand: the same eight verbs exist under `slideless template`, but a
  template carries structure (`purpose`, `pages`, `fill`), a brand carries the look.

## Arguments

`$ARGUMENTS` is free text. `create <company or url>` enters motion 1, `use [<ref>]` motion 2,
`generalise` motion 3; with nothing, read the conversation and ask one question when the motion
is not clear.
