# Share links, read by agents

A share link has two readers. A person opens it in a browser and gets the deck. An agent handed
the same URL (a model with a fetch tool, curl, a script) gets a short index of the link instead: a
markdown page that says what the deck is, what the link allows, where every file is, and what the
deck's author wrote for agents. Nothing changes for the person, and nothing has to be set on the
link: every share link answers both ways.

## How an agent asks

The link answers by what the request asks for:

| The request                                                                                         | The answer                                |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| an `Accept` that includes `text/html` (a browser)                                                   | the deck                                  |
| a document or frame navigation (`Sec-Fetch-Dest: document`, `iframe`, `frame`), whatever it accepts | the deck                                  |
| no `Accept`, `*/*`, `text/markdown`, `text/plain`                                                   | the index, as markdown                    |
| an `Accept` of `application/json` (without `text/markdown`)                                         | the index, as JSON                        |
| `?format=agent` (or `?format=md`, `?format=markdown`)                                               | the index, as markdown, whatever `Accept` |
| `?format=json`                                                                                      | the index, as JSON, whatever `Accept`     |
| `?raw` or `?format=html`                                                                            | the entry document, byte for byte         |

```bash
curl https://slides.example.com/v/SECRET/                 # the markdown index
curl https://slides.example.com/v/SECRET/?format=json     # the same, as JSON
curl https://slides.example.com/v/SECRET/?raw             # the deck's HTML, exactly as pushed
```

A password-protected link answers `401` with the code `password_required` until the password is
sent. An agent sends it in the `x-viewer-password` header on every request, the index and each
file alike:

```bash
curl -H 'x-viewer-password: the-password' https://slides.example.com/v/SECRET/
```

An expired link answers `410` and a revoked one `403`, the same as for a person.

The deck's HTML also points at the index. When the viewer adds its bar, notes or forms to a page,
it adds in the page's `<head>` a `<link rel="alternate" type="text/markdown" href="?format=agent">`
and a comment naming `?format=agent` and `?format=json`, so an agent that received the HTML anyway
finds its way.

## What the index holds

- The deck's title and kind, the version the link serves, and whether the link follows the latest
  version or is pinned to one.
- What the link allows: downloads, annotations, form submissions, PDF export, and the expiry date.
- The entry document, with its size and type, and the `?raw` URL that returns it byte for byte.
- The deck's `AGENT.md`, inlined (up to 64 KB; a longer file is cut and its full URL given). A deck
  without one says so. See [Deck self-description](deck-self-description.md).
- Every file of the deck with its size, its type and its absolute URL.
- When the link allows downloads and the version carries files, the list of those files and the URL
  of the zip that holds them all.
- The URLs of the markdown and JSON forms of the index.

The JSON form carries the same facts as fields: `deck`, `version`, `link`, `agentDoc`, `entry`,
`files`, `downloads` (null when the link does not allow them) and `zipUrl`, plus `index` with the
two URLs.

## What it never holds

The index says nothing the link does not already hand out. Every URL in it is one the same link
opens anyway. A link with downloads off has no downloads section at all and never names the
files. The index never shows the deck's owner, the workspace, the other links, or the other
versions.

## Counting and search engines

An index read counts on the link as an **agent read** (`agentReadCount` on the API), apart from
its views: it never adds a view, never records a view event, and sets no cookie. `HEAD` requests
and the dashboard's own previews never count. See [Link analytics](../sharing/link-analytics.md).

The deck, its files and the index all carry `X-Robots-Tag: noindex, nofollow`, so a link that leaks into a public page is not indexed by
search engines.
