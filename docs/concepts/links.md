# Share links

A share link is a secret URL created on top of a deck. Whoever holds it opens the deck: there is no
sign-in on the other side, no visibility setting, and no way to make a link private. Privacy is not
minting a link. A deck with no link is reachable only by its owner, the workspace's admins and the
collaborators invited on it.

## A link is a link

- The URL is `/v/<secret>/` on the instance (or on the dedicated viewer origin when the operator set
  one). The secret is 48 random bytes, stored hashed: the URL appears exactly once, when the link is
  created, and can never be retrieved again. To hand a deck out again, create another link.
- Every link has an owner-facing **Recipient** label (`alice@client.com`, `Review round 2`) that
  the recipient never sees. One recipient per link is the intent: each link is observable and
  revocable on its own.
- Anyone with the URL is a recipient. Forwarding the URL forwards the access; revoking the link
  cuts it for everyone holding it.

The deck itself renders under a browser sandbox on the link: no cookies, no storage, no credentialed
call reaches the instance from a deck's own script ([viewer security model](../security/viewer-security-model.md)).

## What a link carries

Each link decides, on its own, what the recipient gets:

| Setting                    | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**                | latest  | `Always the latest version`, or `Pin to a version`; see [Versions](versions.md)                                                                                                                                                                                                                                                                                                                                                                                 |
| **Allow annotations**      | off     | The recipient can leave notes on the deck, anchored to text, a spot or a region; see [Annotations](../sharing/annotations.md)                                                                                                                                                                                                                                                                                                                                   |
| **Allow form submissions** | on      | The recipient can submit the forms the deck embeds; see [Forms](../sharing/forms.md)                                                                                                                                                                                                                                                                                                                                                                            |
| **Remember answers**       | on      | The link is its recipient's response: reopening it brings the answers back, every submit updates them, and whoever holds the link can read and change them. Off for a link many people will open. `remembersResponses` on the API and the MCP tool, `--no-remember` / `--remember` on the CLI (an unnamed CLI link is off); embeds never remember; see [Forms](../sharing/forms.md)                                                                             |
| **Allow file uploads**     | on      | The recipient can add files to the file fields of the deck's forms. Needs form submissions on. Whoever holds the link can then write files to the instance, inside the instance's size limits. A link created before file fields existed is off until you turn it on. `canUploadFiles` on the API and the MCP tool, `--no-uploads` on the CLI, `slideless uploads <id> <tokenId> --on` for an existing link; see [File fields](../sharing/forms.md#file-fields) |
| **Allow downloads**        | on      | The recipient can download the version's files, its `downloads/` folder, one by one or as a zip; see [Attachments](attachments.md)                                                                                                                                                                                                                                                                                                                              |
| **Bar**                    | on      | A slim bar over the deck on the link: the deck's title, the version, and the files to download. Off hands out a bare deck. `showBar` on the API and the MCP tool, `--no-bar` on the CLI; never shown inside an embed, whatever the link says                                                                                                                                                                                                                    |
| **Allow PDF export**       | on      | An **Export PDF** action in the bar prints the deck from the recipient's browser. `canExportPdf` on the API and the MCP tool, `--no-pdf` on the CLI, `slideless pdf <id> <tokenId> --on` for an existing link; a link created before the switch existed is off until you turn it on                                                                                                                                                                             |
| **Expiry**                 | none    | `No expiry`, or a date after which the link answers `410`; `7`, `30` or `90 days` from the form, any ISO datetime from the CLI or the API                                                                                                                                                                                                                                                                                                                       |
| **Password**               | none    | At least 4 characters; the recipient types it before the deck opens. Password-protected links do not render inside an [embed](../sharing/embedding.md)                                                                                                                                                                                                                                                                                                          |

The switches can be changed after creation (the version, the capabilities, the expiry and the
password are all editable on the API with a `PATCH`; the version from the page and the CLI too).
Each link also counts: its views (entry loads, one per browser within a short window), when it was
last opened, its downloads, and its agent reads (fetches of the link's index by an agent, counted
apart from views). [Link analytics](../sharing/link-analytics.md) keeps one event per
view, with the referring site and a placement label and without any IP address.

## Where links are made

- **The deck's page**: **Share** in the title menu opens the share sheet, `Links are made here, on
top of the deck`, with **New share link**, which opens the form in a dialog over the sheet. The
  form asks for the recipient, the version, the switches, the notes button position when
  annotations are on, the expiry and the password, and answers with the URL once.
- **The dashboard**: the share links panel of the deck's dashboard page, the same form.
- **The CLI**: `slideless share <id> --name "Alice"` prints the URL; `--to-version`, `--annotator`,
  `--no-forms`, `--no-uploads`, `--no-remember`, `--no-download`, `--no-bar`, `--expires`, `--password` set the rest, and `--embed`
  adds the website snippets. `slideless share-email <id> --to a@x.com b@x.com` mints one link per address and
  mails it. The [CLI reference](../agents/cli.md) has every flag.
- **The API**: `POST /api/v1/presentations/{id}/tokens`.
- **MCP**: `slideless_add_share_token`.

## What the recipient gets

The deck, whole, at the version the link resolves to, under a slim bar: the `Slideless` mark, the
deck's title, the version (`v3`) and, when the version carries files and the link allows
downloads, a **Download** button whose menu lists each file with its size and **Download all** for
the zip, and, when the link allows it, an **Export PDF** button that prints the deck from the
browser. The bar collapses to a thin handle at the top (its **Hide this bar** button, or Esc while it has
focus) and stays collapsed on that link for the rest of the browser tab; the handle, **Show the
presentation bar**, brings it back. The
deck sits under the bar, pushed down by its height, never covered. With the bar off, the recipient
gets the deck alone, as it was pushed, and a deck that hands out its files then links them itself,
relative to its own URL (`downloads/figures.csv`, `downloads.zip`), as [Attachments](attachments.md)
explains. Beyond that, what the link allows: the notes layer on an annotator link, working forms
unless they were switched off, file fields that take files unless uploads were switched off, the
files unless downloads were switched off. What the recipient
never gets: the deck's page, the version history, the other links, the owner's name, the
workspace.

### What an agent gets

The same URL, fetched by an agent rather than opened in a browser, answers with a short index of
the link instead of the deck: the title, the version, what the link allows, every file with its
URL, and the deck's AGENT.md. [Share links, read by agents](../agents/share-links-for-agents.md)
explains how an agent asks for it and what it holds.

A link answers for itself:

| The link is…                           | The recipient gets                         |
| -------------------------------------- | ------------------------------------------ |
| live                                   | the deck                                   |
| password-protected                     | a password prompt first                    |
| expired                                | `410`, `This share link has expired.`      |
| revoked                                | `403`, `This share link has been revoked.` |
| unknown (a mistyped or made-up secret) | `404`                                      |

## Revoking

Revoke a link when the recipient should stop: **Revoke** on the link's row (the dialog says the link
stops opening immediately and that its access stats are kept), `slideless unshare <id> --token <tokenId>`
for one link or `slideless unshare <id>` for every active link of the deck, `DELETE` on the API, or
the MCP tool `slideless_unshare_presentation`. Revocation is immediate, and the link's history stays readable in
the dashboard.

Deleting the deck kills every one of its links at once.

## Previews are not links

When you look at your own deck on its page or in the dashboard, the frame uses a short-lived preview
link the instance mints for you. It expires within the hour and never counts as a view or a download.
The dashboard's share links panel does not list it; `slideless tokens` and the API do, named
`Dashboard preview` with `purpose: preview`, so a listing from the terminal can show links you did
not create: they are yours, and they die on their own.

## Embedding

Any share link can render inline on your own site, in a sandboxed frame, with the same switches as
the direct link except the bar, which never mounts inside a frame; [Embedding decks on your site](../sharing/embedding.md) has the snippets and the
limits.
