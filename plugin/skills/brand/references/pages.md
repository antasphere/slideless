# The pages of a brand

A brand's pages show the brand **applied**, one layout per page. They are not a guidelines deck
(that explanation lives in the `AGENT.md` prose) and not a sample presentation (no story, no
argument). An agent authoring a deck under the brand copies these pages, so each one must be a
clean, complete instance of one layout, built with the brand's own tokens, and labelled.

## The set

| Page | Layout            | What it shows                                                                                                     |
| ---- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1    | cover             | The cover as the company uses it: the background treatment, the logo's position, one headline, one line           |
| 2    | palette           | Every colour in its role, the hex under its name, one sentence under the row on how the system works              |
| 3    | type scale        | Each level with its label (face, size, weight, case), from the largest headline to the smallest label; the button |
| 4    | figures and chart | A row of figures as the house sets them, and one chart drawn the house way: series colour, highlight, axis, grid  |
| 5    | logo              | The logo in each setting (light, dark), the mark alone at its minimum, the clear space stated                     |
| 6    | content           | One content layout the brand uses: a headline with a list, a numbered list, a two-column                          |
| 7    | inverted section  | The inverted (or accent) section with the inverted button and the tags                                            |
| 8    | image             | The photography register full-bleed, the caption treatment, the divider the brand uses                            |
| 9    | closing           | The closing page: the sign-off line, the addresses                                                                |

Add a page when the brand has a layout agents will need (a table, a quote, a timeline). Remove
one when the brand has no such thing (a company with no photography has no image page; say so in
the prose). Keep the order: an agent cites "page 4" and the prose's page map must agree.

## Rules on every page

- **Size and paging.** 1280 × 720 CSS pixels per page (`@page { size: 1280px 720px; margin: 0 }`),
  unless the company's own decks use another ratio. The deck shows **one page at a time**, never a
  vertical scroll of pages: a fixed stage of that size, scaled to the viewport
  (`transform: scale(min(innerWidth / 1280, innerHeight / 720))`, set on resize), the pages stacked
  on it with only the active one visible, a short fade with a slight slide between pages (about
  400 ms, none under `prefers-reduced-motion`), the arrow keys, space, a click on either half and a
  swipe to move, the page number in the URL hash so a page can be linked, and a small counter.
  Plain HTML, CSS and a few lines of script, no library. In `@media print` the stage is unscaled
  and every page is visible in flow with a page break after it, so the PDF export keeps them all.
- **Fonts as data URIs.** The viewer serves a bundle under a CSP sandbox with no CORS headers, and
  a page in a sandbox has an opaque origin, so an `@font-face` pointing at a relative file fails
  silently and the page falls back to a system face. Inline every face:

  ```css
  @font-face {
    font-family: 'Archivo Narrow';
    src: url('data:font/woff2;base64,…') format('woff2');
    font-weight: 700;
  }
  ```

  Keep the files in `assets/fonts/` as well: the frontmatter names them there and a deck that
  reuses them copies them from there. Author a `src.html` with the relative URLs and build
  `index.html` from it with a small script that replaces each `url("assets/fonts/…")` by the
  data URI; keep both in the folder.

- **Logos by reference.** `<img src="assets/logo.svg">` loads in the viewer (images are not
  subject to the font rule). Never inline a recoloured copy.
- **Tokens as CSS variables.** `:root { --ink: …; --paper: …; }` with the names of the
  frontmatter, used everywhere on the pages, so an agent lifts the block as is.
- **The layout label.** A small line on every page, bottom right, in the label face:
  `Layout: palette`. Agents cite it; the prose's page map names it.
- **The company's own copy.** Headlines and lines on the pages are the company's own, taken
  from the site, or the brand's example sentence. A figure that is not the company's is marked
  `illustrative` in its caption.
- **Nothing decorative that the brand does not do.** No shadow where the site has none, no
  rounded card where the site squares them, no gradient under text where the site keeps text on
  flat ground.

## Verify

Render `index.html` headlessly (Chrome through `playwright-core`), wait for `document.fonts.ready`,
then check each face by name:

```js
await page.evaluate(() =>
  ['700 40px "Archivo Narrow"', '400 18px Inter', '500 12px "JetBrains Mono"'].map((f) => [
    f,
    document.fonts.check(f)
  ])
);
```

Every entry must be `true`. Screenshot each `.page` element and read every screenshot: an
overflow, a wrapped headline, a swatch with the wrong hex, a cropped logo, a fallback face. Fix
the source, rebuild, render again. `slideless dev ./brand-folder` serves the folder with the
viewer's own headers for a last look in a browser.

Only then `slideless brand push`.
