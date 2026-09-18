# Embedding decks on your site

Any [share link](../concepts/links.md) can render **inline on your own website** — a landing page, a documentation site, an internal wiki — instead of sending visitors away to the viewer. Paste a small snippet where the deck should appear and it renders there, fully isolated from the rest of your page.

Both snippets are offered with copy buttons in the dashboard the moment you create a share link (they contain the link's secret URL, which is shown exactly once — the same rule as the URL itself).

## The script embed (recommended)

```html
<script src="https://slides.example.com/embed.js" async></script>
<div data-slideless-embed="https://slides.example.com/v/SECRET/"></div>
```

The loader finds every `div[data-slideless-embed]` on the page and replaces its contents with a sandboxed, responsive iframe. One script tag serves any number of embeds on the same page. Optional attributes on the div:

| Attribute                  | What it does                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `data-slideless-placement` | Labels this spot in the link's [analytics](link-analytics.md) — the loader appends it as the `?p=` placement label |
| `data-aspect-ratio`        | The frame's shape, e.g. `16/9` (the default) or `4/3`                                                              |

The placement label is what tells your embeds apart: the same link embedded in three places, each with its own `data-slideless-placement`, gives you three distinguishable streams in the link's view activity. This matters doubly for embeds because the frame never sends a referrer (see the security notes below), so the label is the only attribution an embedded view carries.

```html
<div
  data-slideless-embed="https://slides.example.com/v/SECRET/"
  data-slideless-placement="pricing-page"
  data-aspect-ratio="4/3"
></div>
```

The loader is deliberately boring: plain JavaScript, about 2.5 KB, no framework, no tracking, cacheable for an hour. A div whose URL is not a viewer link is left untouched (with a console warning), and running the script twice never double-mounts an embed.

## The plain iframe

If you'd rather not load a script, embed the frame directly:

```html
<iframe
  src="https://slides.example.com/v/SECRET/"
  sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
  referrerpolicy="no-referrer"
  allow="fullscreen"
  style="width:100%;aspect-ratio:16/9;border:0"
></iframe>
```

This carries the same `sandbox`, `referrerpolicy` and `allow` values as the frame the loader builds (the loader adds lazy loading and a title). Keep the `sandbox` attribute exactly as shown — it is the security boundary (below). `allow-popups-to-escape-sandbox` lets a window the deck opens run as a normal page (without it the opened page inherits the deck's isolation and an application there cannot start); it grants the deck itself nothing. To tag the embed in the link analytics, append `?p=your-label` to the `src` URL yourself.

## From the CLI (for agents)

You never have to assemble these snippets by hand. Minting a link and
getting its embed code is one command:

```bash
slideless share <deckId> --embed                          # URL + both snippets
slideless share <deckId> --embed --placement blog-footer  # with the analytics label baked in
slideless share <deckId> --json                           # machine form
```

`--json` always includes an `embed` object — `{ script, iframe, embedJsUrl }`
— next to the token and URL, so an agent that manages a deck and builds a
website can mint the link and drop the snippet into the page in one step:

```bash
slideless share <deckId> --placement pricing --json | jq -r '.embed.script'
```

The CLI, the dashboard's copy dialog, and this page all emit the same
snippet from one shared builder, sandbox attributes included. Placement
labels are slugs (letters, digits, `.`, `_`, `-`, max 64); each embedded
view then shows its label in `slideless views <deckId> <tokenId>`.

## Forms inside embeds

If the deck carries [forms](forms.md), they are fully functional inside an embed: viewers fill them in and submit without leaving your page. Attribution flows through the same placement mechanism as views: an embedded submission is recorded with source `embed` (a direct link records `link`) plus the embed's `data-slideless-placement` label, so

```bash
slideless responses DECK_ID --source embed --placement pricing-page
```

lists exactly what the pricing page's embed collected. Every embedded respondent still gets their personal edit link from the confirmation card, including the option to receive it by email. Two boundaries to know: password-protected links remain unusable in embeds (their forms included), and signed-in viewers are never auto-recognized inside a frame. The [forms page](forms.md) has the full story.

## Why this is safe — for your site and for the deck

Slideless decks are user-authored HTML, so the embed is built to guarantee that a deck can never touch the page that embeds it:

- The `sandbox` attribute puts the deck in an **opaque origin**: it gets no cookies, no storage, and no access to your page's DOM or scripts.
- **Framebusting is impossible** — the sandbox omits every `allow-top-navigation` variant, so a hostile deck cannot navigate your page away. It can still open new windows on a visitor's click (`allow-popups`), and those run as ordinary pages, outside the sandbox.
- `referrerpolicy="no-referrer"` means the viewer never learns the URL of the page embedding it.
- The deck itself is additionally served under `Content-Security-Policy: sandbox` by the viewer, the same double layer the dashboard's own preview uses. The [viewer security model](../security/viewer-security-model.md) has the full story.

Never add `allow-same-origin` to the sandbox. It would collapse the isolation between the deck and the viewer origin, and it is never needed for a deck to work.

## Limitations, honestly

- **Password-protected links don't work in embeds.** The password gate refuses to render inside a frame, by design: a first-party credential form has no business appearing on a third-party page. Embed links without a password (the secret URL is itself the credential).
- **Annotations never appear in embeds.** The notes overlay and its badge only mount when the deck is the top-level page, even on a link that allows annotations. Recipients who should annotate need the direct link. [Forms](forms.md) are the deliberate exception to embedded interactivity (see above).
- **Embeds stay bare.** The recipient bar a share link shows over the deck (its title, its version, the [downloads](downloads.md)) never mounts inside an embed or any iframe, whatever the link's `showBar` says: the frame belongs to your page.
- **View counting is coarser across sites.** The de-dupe cookie that collapses reloads into one view is `SameSite=Lax`, so it is never sent to a frame on another site: every load of a cross-site embed counts as a view. Embeds on the same site as the viewer de-dupe normally.

## Self-hosting note

`/embed.js` is served by your instance on the app origin, anonymous and cache-friendly. If you moved share links to a dedicated viewer origin with [`VIEWER_BASE_URL`](../reference/env-reference.md), keep the script `src` on the **app** origin and the div's URL on the viewer origin — which is exactly what the dashboard's copied snippet does.
