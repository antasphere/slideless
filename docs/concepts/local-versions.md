# Local versions

A deck folder can keep versions on your own machine, before it is ever pushed and without an
account. Each local version is the folder as it was when you saved it, kept whatever you change in
the folder afterwards, and the preview shows any of them beside the live folder.

## Saving and seeing a version

`slideless dev ./deck` opens the preview with a version bar above the deck. **Save version** saves
the folder as it is now; the menu next to it shows:

- **Live: the working folder**, which reloads on every file change.
- **Latest version**, which moves to each new version as it is saved.
- **One version**, `v3 · 9 Nov, 22:14 · 4 files`, which stays as it was whatever happens in the folder.
  **Back to live** returns to the folder.

`slideless snapshot ./deck` saves a version from the command line, and `slideless snapshots ./deck`
lists them. Saving a folder that has not changed since its latest version makes no new version.

## What a local version is

The same thing as a [version](versions.md) on an instance: every file's path, its `sha256`, its size
and its content type, plus the entry document, numbered from 1 and never changed once saved. The
folder is read with the push's own rules, so a local version holds exactly what a push would send:
the `.slidelessignore` file is honoured, dot-prefixed files are left out, and 5000 files is the cap.
Files are kept by content, so a file that does not change between versions is stored once.

## Where they live

In a store of your own, never in the deck folder, so a version cannot end up in a git repository by
surprise: `~/.local/share/antasphere/slideless/local` (`$XDG_DATA_HOME` when set), or
`%LOCALAPPDATA%\antasphere\slideless\local` on Windows. `--store <dir>` on `dev`, `snapshot` and
`snapshots`, or the `SLIDELESS_LOCAL_STORE` variable, puts it elsewhere. A store inside the deck
folder is refused, unless it sits under a dot-prefixed directory, which no scan reads.

The versions of a folder are found by the folder's real path: a folder moved or renamed starts a
new history.

## Local, not shared

Nothing leaves the machine. A local version has no link and no recipient; to share the work, push
the folder (`slideless push`) and share the deck.
