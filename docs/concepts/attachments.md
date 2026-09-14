# Attachments

Files can travel with a deck: the spreadsheet behind a chart, the PDF of the slides, the raw data.
Put them in a `downloads/` folder at the root of the deck and push. Every file in that folder is an attachment of the version it was pushed with, offered to the
recipient by the bar over the share link, one by one or as a zip. Where the bar is absent (a link
made with the bar off, an embed), the deck links them itself; where downloads are switched off for
the link, nothing offers them.

## The convention

- `downloads/` at the root of the deck bundle is reserved: every file under it, nested folders
  included, is an attachment. Files anywhere else are ordinary assets of the deck.
- An attachment is handed out, never shown. Whatever its type, it downloads as a file. An HTML file
  in `downloads/` is a file to download, not a page of the deck.
- `downloads.zip` at the root of the deck is reserved too: that URL is the version's whole set as
  one archive, so a push carrying a root file of that name is refused.
- Attachments belong to the version. A link that follows the latest push hands out the latest set;
  a link pinned to version 3 keeps handing out version 3's files after you push version 4.

`slideless push` classifies the folder by the same rule the server uses and prints an
`Attachments:` line under its summary with the file count, the total size and the folder name when
the deck carries some. The Downloads page under Sharing & review has the URLs, the API and the
counting rules: [Downloads](../sharing/downloads.md).

## Stored once, carried by every version

Storage is content-addressed, for attachments as for every file of the deck: a file's bytes are
stored once in the workspace, under their hash, and each version's manifest points at them. Take a
deck pushed three times:

| Push | What changed                                                                | What uploads                       | What the version carries in `downloads/`                      |
| ---- | --------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| v1   | the deck, with `figures.csv`, `annex.pdf` and `sources.zip` in `downloads/` | the HTML and the three files       | `figures.csv`, `annex.pdf`, `sources.zip`                     |
| v2   | the HTML only                                                               | the changed HTML page              | the same three files, not uploaded again                      |
| v3   | `annex.pdf` replaced, `notes.md` added                                      | the new `annex.pdf` and `notes.md` | `figures.csv`, the new `annex.pdf`, `sources.zip`, `notes.md` |

After the third push the instance holds two annexes (two different files) and one copy of
everything else. A link pinned to v1 still hands out the first annex; a link on the latest hands out
the second. The version history on the [deck's page](artifact.md) shows exactly that, version by
version, with each version's files.

## Where the files show

- **On the deck's page**, the bar's **Download files** menu lists the shown version's files with
  **All files (zip)** first, and **Version history** lists each version's **Files** with the same
  zip link. That is the owner's side, behind the sign-in.
- **On a share link**, the bar over the deck carries a **Download** button when the version has
  files: its menu lists each file with its size, one link per file, and **Download all** for the
  zip. The files are served one by one at `/v/<secret>/downloads/<name>` and all together at
  `/v/<secret>/downloads.zip`, relative to the deck's own URL, so a deck may also link them itself
  (`downloads/figures.csv`, `downloads.zip`); it must, when the link was made with the bar off or
  the deck is embedded on a site, since the bar never mounts there. Every download counts on the
  link, next to its views.
- **On the API**, `GET /api/v1/presentations/{id}/versions/{n}` lists a version's attachments, and
  the same version's files download from `/versions/{n}/downloads/{name}` and
  `/versions/{n}/downloads.zip`, under the deck's read rules.

## The per-link switch

Every link carries **Allow downloads**, on by default: the files were put in `downloads/` to be
handed out. Untick it on the form, or pass `--no-download` to `slideless share`, when a recipient
should see the deck but not take its files. With downloads off, the deck still opens and the bar shows the title and the version without a
**Download** button; the file URLs answer 404 and the list of files is empty, so a link holder learns
nothing about a folder you chose not to hand out. The links list leaves the **Downloads** column unchecked on such a link, and `slideless tokens` prints
`no downloads` in its downloads column.

## The zip

`downloads.zip` on a link, and **All files (zip)** on the deck's page, stream the version's set as
one archive named after the deck and the version (`quarterly-review-v3.zip`), built as it is sent
and stored without compression: the files are the author's, mostly compressed already. A zip
download counts once, whatever it held.

## The size limit

Each file of a deck, attachments included, is capped per file by the instance: `MAX_FILE_SIZE_MB`,
100 MB by default. The CLI checks every file against the cap before uploading anything, so a file
over it is refused by name, with the cap, and no byte has left your machine:

```
Error: downloads/video.mp4 is 250.0 MB, over this instance's 100.0 MB per-file cap (MAX_FILE_SIZE_MB) — nothing was uploaded. Shrink or drop the file and push again.
```

On the Antasphere cloud, Antasphere sets the cap for the instance. On a self-hosted instance the
operator sets it, and past the cap the disk behind the data volume is the only limit.
