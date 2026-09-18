# The Slideless CLI

`slideless` is the typed command-line client for a Slideless instance — the
primary human/agent face of it. It signs in over email OTP (minting
its own API key), pushes deck folders as immutable versions, pulls them back
byte-exactly, manages share links and collaborators, and previews decks
locally under the exact viewer sandbox. The model behind the commands (one
deck as one artifact with a page of its own, immutable versions, links made
on top, files travelling with the version) is in the Concepts pages:
[The deck is the artifact](../concepts/artifact.md),
[Versions](../concepts/versions.md), [Share links](../concepts/links.md),
[Attachments](../concepts/attachments.md). What each release added is the
Changelog page of the docs site, generated from the repository's release
tags; this page describes the current CLI.

## Install

`npm i -g @antasphere/slideless` exposes the `slideless` binary (the package
publishes under the Antasphere org's npm scope; the binary name is unchanged).
The published package is a single self-contained bundle (`dist/bin.js`, built
with esbuild): the workspace-internal `@slideless/contract`, `@slideless/sdk`,
`@antasphere/cli-core`, and commander are inlined at build time, so the
published manifest carries **zero runtime dependencies** — nothing internal or
git-pinned leaks into a public install.

From a checkout:

```bash
pnpm --filter @antasphere/slideless... build
node packages/cli/dist/bin.js --help
```

## Configuration: profiles, flags, environment

Config lives in the **shared Antasphere CLI config home** (provided by
`@antasphere/cli-core` — one home for the whole tool family), under the
`slideless` namespace: `$XDG_CONFIG_HOME/antasphere/tools/slideless.json`
(default `~/.config/antasphere/tools/slideless.json`), directories `0700`,
file `0600`:

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": { "apiKey": "slk_…", "baseUrl": "https://slides.example.com" }
  }
}
```

**Migrating from older builds**: the config used to live at
`~/.config/slideless/config.json`. On first run, if that file still exists,
holds at least one profile, and the new home has no slideless profiles yet,
it is imported automatically and non-destructively — the old file stays in
place (older CLI builds keep working) but stops being read. Note the
corollary: after `slideless config clear`, a still-present legacy file is
imported again on the next run; delete `~/.config/slideless/config.json` too
if you want a truly clean slate.

Every command accepts `--api-url` (alias `--url`), `--api-key`, `--profile`,
and `--json`. Resolution order:

| Setting  | 1st         | 2nd                 | 3rd               | Otherwise                                                                     |
| -------- | ----------- | ------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Base URL | `--api-url` | `SLIDELESS_URL`     | profile `baseUrl` | **error**                                                                     |
| API key  | `--api-key` | `SLIDELESS_API_KEY` | profile `apiKey`  | hub connect (cloud, below) — else the public commands work and the rest error |

**Keeping secrets out of `argv`**: a value passed as `--api-key slk_…` or
`--password …` is visible to every process on the machine (`ps`) and lands in
the shell history. Both have alternatives that do not touch the command line:
`--api-key-stdin` reads the key from the first line of stdin
(`pass show slideless | slideless --api-key-stdin files list`), `SLIDELESS_API_KEY`
carries it in the environment, and `share` / `share-email` take
`--password-stdin` or `SLIDELESS_SHARE_PASSWORD`. stdin can only be spent
once per invocation — asking twice is a usage error rather than two commands
silently sharing one secret.

There is deliberately **no default URL**: a self-hosted CLI must name its
instance explicitly (flag, env, or saved profile) rather than silently talking
to the wrong host.

### Cloud instances: connect through `antasphere login`

On an **Antasphere-cloud** instance you never run a Slideless-specific login.
When no direct key resolves, the CLI asks discovery (`GET /api/v1/instance`)
whether the instance signs in through the hub (`auth.methods` contains
`antasphere`); if so, it exchanges the stored `antasphere login` credential
for a **user-scoped** tool-local `slk_` key (hub → tool; see
[Your Antasphere account](../getting-started/antasphere-account.md)) and
caches it in the profile **per hub profile** (`connectKeys` — ONE
key per hub account, valid for every org; the org is a per-request
selection, never part of the credential):

```bash
antasphere login                       # once, for the whole tool family
slideless list --api-url https://slideless.antasphere.com   # exchanges + caches on first use
slideless list                                      # served from the cache — no hub call, no new key
```

- The exchange names **no organization** (the hub credential identifies the
  USER, never one org); a single cached key serves whatever org context is
  active. Second and later runs make zero hub calls and mint nothing.
- The hub key is sent to the **hub only**; the instance sees a short-lived
  user-scoped JWT (plus its own one-time offline grant, relayed once and
  never stored by the CLI) and answers with an ordinary local key.
- A cached key is only ever replayed against the instance it was minted on
  (the profile's `baseUrl` scopes the cache).
- `slideless logout` on a hub-connected profile self-revokes the cached
  key(s) server-side (`DELETE /cli/auth/key` — the presenting key revokes
  exactly itself), then evicts them. An OLDER instance whose machine
  allowlist predates the self-revoke refuses (403) and keeps the key
  **valid server-side** — the CLI says so; revoke it from the dashboard. A
  classic single-key profile logs out exactly as before.

Self-hosted (`oss`) instances never take this branch: the flows above
(`auth login-request`, `login`, `SLIDELESS_API_KEY`, `--api-key`) resolve
exactly as documented, and the hub is never contacted.

## Sign in

The OTP flow is the **self-host** entrance. On an Antasphere-cloud instance
it refuses — the CLI detects cloud via discovery and steers you to
`antasphere login` (see "Cloud instances" above); server-side the endpoints
answer `403 cli_otp_disabled` (cloud instances are hub-login-only). The
flow needs the instance to have a delivering email driver
(`EMAIL_DRIVER=smtp|resend|brevo`); it signs in **existing accounts only** — sign-up
stays closed (accounts enter via setup, workspace invitations, or
collaborator claims):

```bash
slideless auth login-request  --api-url https://slides.example.com --email you@example.com
slideless auth login-complete --api-url https://slides.example.com --email you@example.com --code 123456
```

`login-complete` mints an `slk_` API key server-side (scopes
`presentations:read` + `presentations:write`, never `data:export`) and stores
it as the active profile; `--key-name <name>` names the key as the dashboard
lists it, and `--expires-in-days <n>` gives it a TTL (it never expires
otherwise). Accounts with 2FA enabled are refused
(`two_factor_required`), and an instance with no email driver has no OTP at
all — mint a key in the dashboard instead (**API keys**, **Create key**; tick
`presentations:write`, which the dialog leaves unchecked, for push and share)
and paste it:

```bash
slideless login --api-url https://slides.example.com --api-key slk_…   # or pipe the key on stdin
```

Profile management:

```bash
slideless whoami            # identity behind the resolved key
slideless verify            # exit 0 iff instance + key work
slideless profiles          # list profiles (keys redacted)
slideless use <profile>     # switch the active profile
slideless logout            # forget the stored key (revoke server-side in the dashboard);
                            # hub-connected profiles: revoke + evict the cached user-scoped key
slideless config show       # config path + redacted contents
slideless config clear      # delete the config file
```

## Author: push / pull / dev

```bash
slideless push ./deck --title "Q3 Board Deck"    # new deck → prints the id + the deck's page URL,
                                                 # and opens that page in your browser
slideless push ./deck                            # next push = version 2 of the SAME deck (prints the URL)
slideless push ./deck --open                     # …and open the page again
slideless push ./deck --no-open                  # never open, even on the first push
slideless open ./deck                            # open the linked deck's page (--json prints the URL)
slideless pull <id> ./out                        # byte-exact download of the latest version
slideless pull <id> ./out --at 1                 # …or any pinned version
cd deck && slideless pull                        # no id: the current folder's .slideless.json names the deck
slideless pull-annotations [id] [--version N] [--status open|resolved] [--out notes.json]
slideless annotation resolve <id> <annotationId> # mark a note resolved
slideless annotation reopen <id> <annotationId>  # …and flip it back open
slideless dev ./deck --port 4173 --no-open       # local preview, no backend; --entry picks the page
                                                 # to serve (index.html, else the only .html)
```

**push** implements the content-addressed 3-step protocol: scan → hash every
file (sha256) → `precheck` (the server answers which blobs it is missing) →
upload exactly those → commit the manifest. Unchanged files are never
re-uploaded.

- **New deck vs new version**: the first push writes `.slideless.json` into
  the deck folder (`{ presentationId, baseUrl }`). Later pushes find it and
  commit a new version of that deck with optimistic concurrency
  (`expectedBaseVersion`; a concurrent push answers a clean retry error).
  `--id <deckId>` targets a deck explicitly; `--new` forces a fresh deck. A
  link pointing at a _different_ instance errors loudly instead of silently
  targeting a foreign id.
- **Ignores**: `node_modules`, `Thumbs.db`, `.slideless.json`,
  `.slidelessignore`, **every dot-prefixed file or directory** (`.git`,
  `.DS_Store`, `.env`, `.github`, …) and `package.json` / the common
  lockfiles are always skipped. That is not a taste call: a manifest path is
  what `slideless pull` writes onto someone's disk, so those names are
  refused by the wire contract at commit and by the CLI again at pull —
  `.git/hooks/pre-commit`, `.env` and `package.json` are all "write this and
  something else runs it later" paths. Pushing a single dotfile
  (`slideless push .env`) errors instead of uploading it. A
  `.slidelessignore` in the deck root adds gitignore-style rules (a
  pragmatic subset: `#` comments, `*`, `?`, `**`; trailing `/` = directories
  only; patterns with `/` anchor to the deck root, without `/` they match
  any path segment; no `!` negation). Patterns are capped at 256 characters
  and 8 `**` wildcards, and a longer or heavier one errors — an unbounded
  pattern used to hang the scan. Symlinks are never followed.
- **Entry detection**: `--entry` wins, else `index.html`, else the only
  `.html` file, else an error listing candidates. A single-file push
  (`slideless push deck.html`) uses that file as the entry.
- **The deck's page**: every push answers with the deck's own page on the
  instance, `<instance>/decks/<id>/present` (the master page: the owner's
  full view, where share links are minted from — no link is created by a
  push; [The deck is the artifact](../concepts/artifact.md) describes the
  page and its bar). The human summary prints it as `url:`; `--json` carries it as
  `url` next to `presentation` and `version`. The **first push of a
  folder** (the one that creates the deck) also opens that page in your
  default browser; later pushes only print it. `--open` opens it on any
  push, `--no-open` never does. A run whose stdout is not a terminal, or
  any `--json` run, never opens a browser — whatever the flags say — so a
  push in CI or under an agent stays silent. The opener is the platform's
  own (`open`, `xdg-open`, the Windows URL handler) with the URL as an
  argument, never a shell string.
- **Attachments**: a `downloads/` folder at the root of the deck is the
  version's attachment set ([Attachments](../concepts/attachments.md), and
  the [Downloads](../sharing/downloads.md) page for the URLs and the API):
  files handed to a link's recipient as downloads, never rendered. The bar over
  the share link offers them (a **Download** button listing each file, and
  **Download all** for the zip); on a link made with `--no-bar`, or inside an
  embed, the bar is absent and **your deck must link its own files** for a
  recipient to find them: `<a href="downloads/figures.csv">` for one,
  `<a href="downloads.zip">` for the set, relative to the deck's own URL. The
  push classifies them by the same rule the server uses and prints an
  `Attachments: N files, X MB (downloads/)` line under the summary when the
  folder carries some; `--json` carries `attachments: { count, sizeBytes }`.
  They ride the same content-addressed protocol as every file: an unchanged
  attachment is never re-uploaded when you iterate on the HTML (the precheck
  reports it present), and only what changed travels.
- **The per-file cap, refused before anything is uploaded**: every file of
  the deck is checked against the instance's per-file cap before the upload
  session, the precheck or any upload. A file over it names itself and the
  cap, and no byte has left the machine:

  ```
  Error: downloads/video.mp4 is 250.0 MB, over this instance's 100.0 MB per-file cap (MAX_FILE_SIZE_MB) — nothing was uploaded. Shrink or drop the file and push again.
  ```

  The cap the CLI checks against is the 100 MB default: no instance publishes
  its own `MAX_FILE_SIZE_MB` yet. On an instance configured with a lower cap the
  server stays the enforcement point and still answers `413` to the oversized
  blob after its upload, with the smaller files already stored.

- Flags: `--title`, `--entry`, `--kind presentation|app|plan`,
  `--interactive`, `--id`, `--new`, `--open` / `--no-open`.

**open** opens the page of the deck a folder is linked to: it reads
`.slideless.json` (deck id + instance) and composes the same URL a push
prints, with no key and no network call. `--json` prints
`{ presentationId, baseUrl, url }` instead of opening. An unlinked folder is
an error pointing at `push`, and a link file whose instance is not an
`http(s)` URL is refused before anything reaches the opener (the file can
arrive with a cloned folder; the opener would dispatch any scheme).

**pull** downloads a version's manifest and streams every blob to disk —
byte-identical to what was pushed, attachments under `downloads/` included
(the summary counts them) — then writes/refreshes `.slideless.json`
so a later `push` in that folder targets the same deck. It treats the
instance's answer as untrusted input: every manifest path is re-validated
locally, each blob is capped at the size the manifest declared and must hash
to the sha256 the manifest claims before anything is written, deck file writes
refuse to follow a symlink (file or directory) and never leave a file executable
(the `.slideless.json` link file itself is written plainly),
and a destination whose `.slideless.json` names a _different_ instance errors
loudly — the same refusal `push` has always had.

**dev** serves the folder locally under the same sandbox headers as the public viewer —
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox
allow-modals allow-downloads`, `nosniff`, `no-referrer`, `no-store` — so isolation
and relative paths match what share-link recipients get. It is not the hosted
viewer: it injects live reload and nothing else (no recipient bar, no annotation
layer, no forms runtime, so a marked form submits nowhere), it serves
`downloads/` files inline and has no `downloads.zip`, it serves files a push
would ignore, and a root-absolute URL (`/style.css`) resolves locally but breaks
under `/v/<secret>/`. Test forms, notes and downloads on a real share link. Any
file change reloads the browser. No backend, no credentials.

It serves the deck folder and nothing else: a path is resolved with
`realpath` and re-checked against the root, so a symlink inside the folder
cannot serve a file from elsewhere on the disk; dot-prefixed paths 404
outright; and requests whose `Host` header is not the address the server
bound answer 403, which is what stops a DNS-rebinding page from reading your
deck (and anything else) through the browser.

## Share

A share link is a secret URL made on top of the deck, public to whoever holds
it, following the latest version or pinned to one, with its own switches,
expiry, password and counts: [Share links](../concepts/links.md) is the model,
[Versions](../concepts/versions.md) the latest-or-pinned story.

```bash
slideless share <id> --name "Alice"                       # prints the /v/{secret} URL — shown ONCE
                                                          # (omit --name and the link is labelled "cli":
                                                          # name every recipient, the label is the audit).
                                                          # A NAMED link remembers its recipient's form
                                                          # answers: reopening it brings them back, every
                                                          # submit updates them; whoever holds it can read
                                                          # and change them — never post such a link.
slideless share <id> --name "Alice" --no-remember         # a named link whose every submit is a fresh
                                                          # response (a link a team will pass around)
slideless share <id> --remember                           # make the unnamed "cli" link remember too
                                                          # (unnamed = fresh responses by default)
slideless share <id> --to-version 2 --annotator \
                     --expires 2026-12-31T23:59:59Z --password hunter22
slideless share <id> --annotator --badge-position top-left  # move the notes button (8 slots;
                                                            # remembered as the deck default)
slideless share <id> --no-forms                           # viewers of this link cannot submit the
                                                          # deck's embedded forms (default: they can;
                                                          # also on share-email)
slideless share <id> --no-download                        # viewers of this link cannot download the
                                                          # version's attachments (default: they can;
                                                          # also on share-email)
slideless share <id> --no-bar                             # a bare deck: no recipient bar (title, version,
                                                          # downloads) over it (default: shown; also on
                                                          # share-email; never inside embeds anyway)
slideless share <id> --no-uploads                         # viewers of this link cannot upload files into
                                                          # the deck's form file fields; the rest of the
                                                          # form still submits (default: they can; also
                                                          # on share-email)
slideless share <id> --embed                              # also print the website embed snippets
slideless share <id> --embed --placement pricing-footer   # bake a per-spot analytics label in
slideless unshare <id> --token <tokenId>                  # revoke one link
slideless unshare <id>                                    # revoke ALL active links
slideless share-email <id> --to a@x.com b@x.com [--message "…"]  # one personal token per address, emailed;
                                                          # takes every share flag (--to-version, --annotator,
                                                          # --no-forms, --no-download, --no-bar, --no-uploads,
                                                          # --no-remember,
                                                          # --badge-position, --expires, --password,
                                                          # --password-stdin) except --embed and --placement;
                                                          # each link remembers its recipient's answers
slideless pin <id> <tokenId> --to-version 1               # freeze a recipient on v1
slideless pin <id> <tokenId> --latest                     # follow the latest again
slideless tokens <id> [--all]                             # list links + access stats (opens, last opened,
                                                          # downloads or "no downloads", "no forms",
                                                          # "no uploads", "remembers answers")
slideless uploads <id> <tokenId> [--on|--off]             # show or switch file uploads on an EXISTING
                                                          # link (a link minted before file fields
                                                          # existed has them off)
slideless views <id> [tokenId] [--all]                    # per-view events of one link: when, referring
                                                          # site, ?p= label, browser family (no IPs, no
                                                          # full URLs — never stored)
slideless responses <id> [--form name] [--link tokenId] \
                    [--source link|embed] [--placement label] \
                    [--since ISO] [--all] [--json|--csv]  # what viewers submitted through the deck's
                                                          # embedded forms, newest first; --since reads
                                                          # activity (created OR edited)
slideless response <id> <responseId>                      # one response with its edit history: every
                                                          # kept revision, newest first; lists the files
                                                          # it holds (field, name, size, id)
slideless response-files <id> [--form name] [--link tokenId] \
                    [--source link|embed] [--placement label] \
                    [--since ISO] [--out ./dir]           # download every file respondents uploaded into
                                                          # the deck's form file fields, as
                                                          # <dir>/<form>/<response>/<field>/<name>
                                                          # (default dir ./form-files-<deck id head>)
slideless response-files <id> <responseId> [--out ./dir]  # one response's files, as <dir>/<field>/<name>
                                                          # (default dir ./response-files-<response id head>)
slideless response-files <id> [responseId] --zip [path]   # the same files as ONE zip streamed from the
                                                          # server (default: the server's file name, in
                                                          # the current directory)
slideless notify <id> [--on|--off]                        # show or switch the owner mails on this deck
                                                          # (a mail on a new response, another on an edit;
                                                          # on by default; forms stay on when off)
```

Secrets are stored hash-only server-side: the URL printed at creation is
never retrievable again (`share-email` mints and mails a fresh secret per
send).

**Embedding from the CLI**: `share --json` always carries an `embed` object
(`{ script, iframe, embedJsUrl }`) alongside the token and URL, so an agent
that both manages decks and builds websites mints the link and pastes the
snippet in one step — no second command, nothing to assemble by hand. In
human output, `--embed` prints the same two snippets. Both come from the
same builder as the dashboard's copy dialog (identical sandbox attributes);
`--placement <label>` bakes a per-spot analytics label into them (it shows
up per view in `slideless views`). Details: the Embedding page under
Sharing & review.

`tokens` lists every link of the deck, the dashboard's own preview links
included: rows named `Dashboard preview` that expire within the hour and
count nothing; the dashboard hides them, the CLI and the API do not. The human table has no column for the
bar: `--json` carries `showBar` on every token, which is how a bare link is told apart from the
others. Access stats count entry loads only, de-duplicated per browser within a short window (`VIEW_DEDUPE_WINDOW_MINUTES`, default 10 min) — so one human
open is one count, while cookie-less fetches (CLI, curl) count each time.
"Last opened" is the last counted open. The downloads column is the link's
`downloadCount` (one per attachment taken through the link, one per zip,
never a view) when the link allows downloads, and `no downloads` when it was
minted with `--no-download` (`canDownload: false`; the deck still opens, the
file URLs answer 404). `--json` carries both fields on every token.

**Collecting form responses**: `slideless responses` with no filters prints
the summary first (responses per form × link × source × placement, with the
latest activity), then the most recent rows. Filters narrow the row listing:
`--form` to one named form, `--link` to one share link (token id or link
name, never a share URL: secrets are hash-only server-side and cannot be
resolved back to a token), `--source link|embed` and `--placement <label>`
to one distribution spot, `--since <ISO datetime>` to a time window (a
response created OR edited at or after it — an edit is activity, so an
edited answer resurfaces). `--all`
follows pagination, `--json` prints the wire shape for agents, and `--csv`
writes a spreadsheet-safe CSV (cells are guarded against formula injection)
built client-side from the same rows. Links minted with `--no-forms` refuse
submissions (`403 forms_disabled`); everything else about them works
unchanged. Every edit is kept as a revision:
`slideless response <id> <responseId>` prints the current answer and every
kept revision (at most
100 per response; the first and the latest 99 always survive), each with the
link and the moment it was written through. `slideless notify <id> --off`
silences the owner mails (one on a new response, a different one on an edit,
never carrying the answers, at most one per deck per ten minutes) without
touching forms. Details: the Forms page under Sharing & review.

**Files uploaded through a form**: a form can carry a file field, and what
respondents upload is attached to their response. `responses` shows a files
count per row, `--csv` adds one column per file field met in the exported
rows, named `<field> (files)` and holding that field's file names joined
with `; ` (guarded like every other cell), and `--json` carries `files` on
every response (`id`, `field`, `name`, `contentType`, `sizeBytes`, `sha256`).
`response` lists the current files and, in the history, the names each
revision held (`-` on a revision from before file fields existed).

`slideless response-files <id>` brings the bytes to disk. Without a
`responseId` it takes every file of the deck's responses, narrowed by
`--form`, `--link`, `--source`, `--placement` and `--since` exactly as
`responses` reads them; with one
it takes that response's files (the filters are refused there). Two modes:

- **A folder** (the default, `--out <dir>`): one download per file, laid out
  as `<dir>/<form>/<response>/<field>/<name>` where `<response>` is when the
  response was first sent plus the head of its id (`20260914-2000-7f3a9c1e`),
  or `<dir>/<field>/<name>` for one response. File and field names are the
  respondent's raw input, so no name is ever used as a path: each segment is
  reduced to one plain name (separators resolved to the basename, control
  characters dropped, a leading dot replaced by `_`, so `../../x` is written
  as `x` and `.env` as `_env`), two files with the same name in one field
  become `name.ext` and `name (2).ext`, and every write is contained in
  `<dir>` (symlinks refused, mode forced to 0644). Each download is capped at
  the size the response declares and its sha256 is verified before the file
  is kept; a mismatch stops the command with an error and exit code 1. The
  human output prints the path written for each file, with the name as sent
  when the two differ.
- **One zip** (`--zip [path]`): the server builds the archive
  (`<form>/<response>/<field>/<file>`, or `<field>/<file>` for one response)
  and the CLI streams it to disk without buffering it. Without a path, the
  file takes the server's name (`<deck-title>-form-files.zip`), reduced to a
  plain file name and written in the current directory; a path you type is
  used verbatim. `--out` and `--zip` cannot be combined.

Nothing to download is not an error: the command says so and exits 0, in both
modes (the zip routes answer `404 no_files`, which the CLI reads as the same
empty result). `--json` prints a summary instead of the table: in folder mode
`{ mode: "folder", path, files: [{ responseId, formName, fileId, field, name,
sizeBytes, sha256, path }], totalBytes }` (`path` is `null` and `files` empty
when there was nothing), in zip mode `{ mode: "zip", path, sizeBytes }`.

Uploads are a per-link switch, like forms and downloads: a new link has them
on, `share --no-uploads` mints one without, and
`slideless uploads <id> <tokenId> --on` turns them on for a link minted
before file fields existed (those stay off until their owner says otherwise;
a link already in circulation never gains a public write capability by
itself). Without a flag `uploads` prints the current state. An upload rides a
form submit, so the switch does nothing on a link minted with `--no-forms`.

## Collaborators

```bash
slideless invite   <id> --email dev@example.com    # per-deck dev grant; prints the claim link
slideless uninvite <id> <collaboratorId>           # revoke the grant
```

## Decks, files, export

```bash
slideless list [--all]        # presentations, newest first
slideless get <id>            # one deck: title, kind, version, agent doc, metadata keys
slideless meta <id>           # print the deck's metadata object (JSON)
slideless meta <id> --set client=Acme --set priority=3   # merge keys (values parse as JSON when valid)
slideless meta <id> --unset priority                     # remove a key
slideless meta <id> --replace '{"stage":"final"}'        # replace the WHOLE object
slideless agent-doc [id] [--at <version>] [--out <file>] # print the bundle's AGENT.md briefing
slideless versions <id> [--all]  # version history, newest first (numbers line up with pull --at);
                                 # rows carry the flags and sizes, not the manifest: one version's
                                 # manifest and attachments are GET /api/v1/presentations/{id}/versions/{n}
                                 # or the MCP tool slideless_get_version
slideless delete <id>         # soft delete (links stop resolving)
slideless instance            # public discovery — no key needed
slideless files list [--all]
slideless files upload <path> [--name <stored name>] [--content-type <type>]
slideless files rm <id>
slideless files download <id> [--dir ./here]  # writes the stored name (basename only) into --dir
slideless files download <id> --out ./exact/path.bin   # …or a path you choose, verbatim
slideless export [-o file]    # workspace zip (key needs the opt-in data:export scope)
```

## Paging

Every listing command (`list`, `versions`, `tokens`, `views`, `responses`,
`files list`) answers one page at a time, newest first: `--limit <n>` sets the
page size (1 to 100), `--cursor <cursor>` resumes from the `nextCursor` a
previous page printed, and `--all` follows the cursors until every page is
fetched.

## Shell completion

```bash
eval "$(slideless completion bash)"     # or zsh
slideless completion fish | source      # fish
```

## Machine use

Add `--json` to any command except `files download` for the wire shape; every error prints to stderr
and exits non-zero. Typical agent loop:

```bash
export SLIDELESS_URL=https://slides.example.com
export SLIDELESS_API_KEY=slk_…
id=$(slideless push ./deck --json | jq -r .presentation.id)   # .url is the deck's own page
url=$(slideless share "$id" --name ci --json | jq -r .url)      # a recipient link, when one is needed
```

A `--json` push never opens a browser; hand `.url` (the deck's page on the
instance, behind the owner's session) to the person, and mint a share link
only when a recipient needs one.

## Server endpoints behind `auth login-*`

`POST /api/v1/cli/auth/request` and `POST /api/v1/cli/auth/complete` are
public pre-auth endpoints (like `/setup`), riding the better-auth email-OTP
plugin with `disableSignUp` — an unknown email gets a generic success and no
mail (no account enumeration, no account creation), codes are attempt-limited
(3) and both endpoints sit behind the instance's OTP/login rate walls. The
key is returned exactly once; the flow's throwaway session is deleted
server-side. Without an email driver both answer `400 otp_unavailable`; on
the cloud edition both answer `403 cli_otp_disabled` (hub-only login — mint
through `antasphere login` instead). `DELETE /cli/auth/key` is the logout
counterpart on both editions: an authenticated route where the presenting
API key revokes exactly ITSELF (machine-allowed under `presentations:write`
in the fail-closed scope allowlist; sessions are refused — the dashboard is
their key surface).
