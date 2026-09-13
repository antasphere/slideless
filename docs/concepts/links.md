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

| Setting                    | Default | What it does                                                                                                                                           |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Version**                | latest  | `Always the latest version`, or `Pin to a version`; see [Versions](versions.md)                                                                        |
| **Allow annotations**      | off     | The recipient can leave notes on the deck, anchored to text, a spot or a region; see [Annotations](../sharing/annotations.md)                          |
| **Allow form submissions** | on      | The recipient can submit the forms the deck embeds; see [Forms](../sharing/forms.md)                                                                   |
| **Allow downloads**        | on      | The recipient can download the version's files, its `downloads/` folder, one by one or as a zip; see [Attachments](attachments.md)                     |
| **Expiry**                 | none    | `No expiry`, or a date after which the link answers `410`; `7`, `30` or `90 days` from the form, any ISO datetime from the CLI or the API              |
| **Password**               | none    | At least 4 characters; the recipient types it before the deck opens. Password-protected links do not render inside an [embed](../sharing/embedding.md) |

The switches can be changed after creation (the version, the capabilities, the expiry and the
password are all editable on the API with a `PATCH`; the version from the page and the CLI too).
Each link also counts: its views (entry loads, one per browser within a short window), when it was
last opened, and its downloads. [Link analytics](../sharing/link-analytics.md) keeps one event per
view, with the referring site and a placement label and without any IP address.

## Where links are made

- **The deck's page**: **Share** in the title menu opens the share sheet, `Links are made here, on
top of the deck`, with **New share link**. The form asks for the recipient, the version, the three
  switches, the notes button position when annotations are on, the expiry and the password, and
  answers with the URL once.
- **The dashboard**: the share links panel of the deck's dashboard page, the same form.
- **The CLI**: `slideless share <id> --name "Alice"` prints the URL; `--to-version`, `--annotator`,
  `--no-forms`, `--no-download`, `--expires`, `--password` set the rest, and `--embed` adds the
  website snippets. `slideless share-email <id> --to a@x.com b@x.com` mints one link per address and
  mails it. The [CLI reference](../agents/cli.md) has every flag.
- **The API**: `POST /api/v1/presentations/{id}/tokens`.
- **MCP**: `slideless_add_share_token`.

## What the recipient gets

The deck, whole, at the version the link resolves to, with what the link allows: the notes layer on
an annotator link, working forms unless they were switched off, the version's files unless downloads
were switched off. What the recipient never gets: the deck's page, the version history, the other
links, the owner's name, the workspace.

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
link the instance mints for you: it is not listed with the share links, it expires within the hour,
and it never counts as a view or a download.

## Embedding

Any share link can render inline on your own site, in a sandboxed frame, with the same switches as
the direct link; [Embedding decks on your site](../sharing/embedding.md) has the snippets and the
limits.
