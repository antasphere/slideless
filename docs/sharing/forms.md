# Forms

A deck can collect answers, not just show slides. Write a plain HTML form in the deck, mark it with one attribute, and every share link serves it live: viewers fill it in right inside the deck (including on your own site, when the deck is [embedded](embedding.md)), and the responses land with the deck for you to pull from the dashboard, the CLI, the API, or an MCP agent. No form builder, no third-party service, no viewer account.

## Putting a form in a deck

The deck HTML **is** the form. Mark any `<form>` with `data-slideless-form` and give it a name:

```html
<form data-slideless-form="rsvp">
  <label>Name <input name="name" required /></label>
  <label>
    Coming?
    <select name="attending">
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
  </label>
  <label><input type="checkbox" name="topics" value="pricing" /> Pricing</label>
  <label><input type="checkbox" name="topics" value="roadmap" /> Roadmap</label>
  <button type="submit">Send</button>
</form>
```

That is the whole authoring contract:

- **Standard inputs.** Text fields, textareas, selects, radios, checkboxes: anything that serializes as form data. Repeated names (the checkboxes above) become arrays in the stored response. A file input becomes a drop panel, and the files it takes are attached to the response next to the answers, never inside them: see [File fields](#file-fields).
- **The name is the form's identity.** A slug of 1 to 64 characters from `A–Z a–z 0–9 . _ -`. Responses are grouped and filtered by it everywhere, and it shows up in your dashboard, CLI tables, and CSV exports.
- **Multiple forms per deck** are just multiple named forms; each collects its own stream.
- **Sub-pages work.** In a multi-page deck a form can sit on any HTML page, not only the entry.
- **The markup stays yours.** The viewer wires submission behavior onto your form; it never restyles or rewrites it.
- **The confirmation speaks your deck's language, and every line of it is yours to change.** `<html lang="fr">` is enough for a French dialog; `data-slideless-success="Merci, à bientôt !"` replaces its first line. See [The confirmation dialog](#the-confirmation-dialog).

`slideless push` needs no flags and no manifest entry: pushing a deck that contains a marked form — in its HTML or in a script file that renders the form at load time — is all it takes, and the push output lists the detected form names as a reminder. Any share link then serves it working (see per-link control below).

**How the server decides.** At commit it stamps each version with whether it holds a form, and only stamped versions are served with the runtime. The rule: a deck that ships any script (a script file, or an inline `<script>` in a page) is always served with the runtime, because a form built at load time — `form.dataset.slidelessForm = 'rsvp'`, attributes read from a JSON data file, a minified bundle — cannot be seen in the bytes; a deck with no script at all is served with the runtime when the marker appears literally in an HTML page or a JSON file. Stylesheets, fonts and images never count. So a script-bearing deck always gets the runtime (one inert script tag if it has no form); a script-less deck must carry the literal `data-slideless-form` marker.

## What a viewer experiences

Submitting opens a confirmation dialog **over** the form: the form stays on the page with the answers in its fields, behind a scrim, and closing the dialog (its close button, Escape, a click outside it, or **Edit response**) returns the viewer to the form, ready to change an answer and submit again. A one-line status stays under the form with a **Show confirmation** button that reopens the dialog as it was, so nothing it said is ever out of reach. Double-submit protection holds while the request is in flight, and errors show inline under the form. The dialog carries:

- **The personal edit link**: the page URL plus a private `#slr=` fragment. Reopening it later offers to bring back the viewer's own answer; once they confirm, the form is prefilled and submitting again updates it in place. One respondent keeps one evolving response instead of piling up duplicates. The fragment never travels to the server as part of a request URL, so the edit secret stays out of logs; it is shown once, and without it a new submission is simply a new response.
- **Email me my link** (optional): the dialog offers to mail the edit link to an address the viewer types at that moment. The field appears only on instances that send email, and the mail only ever carries that viewer's own link.
- **Returning with an edit link asks first.** Opening a `#slr=` link does not silently put the form into edit mode. A prompt above the form explains that the link points at a response submitted on a given date and offers _Edit that response_ or _Submit a new response_, defaulting to a new one; it is not a dialog, so the viewer can ignore it and type. The link may have been forwarded, pasted on a page, or handed out deliberately, and overwriting a stranger's answers must never happen by merely opening a URL.

## The confirmation dialog

Every line of the dialog, of the status under the form and of the returning-link prompt comes from **one language contract**: the deck's language picks a built-in set of strings, and any single string can be replaced. Nothing else in the deck is touched.

**The language.** The viewer reads `data-slideless-lang` on the form, then on the nearest ancestor that carries it, then the document's own `<html lang>`; only the primary tag counts (`fr-BE` is `fr`). Built in: English (`en`), French (`fr`), Dutch (`nl`), German (`de`), Spanish (`es`). Any other language falls back to English as a whole, never string by string, so a dialog is either translated or plainly English.

**A string of your own.** `data-slideless-text-<key>` on the form replaces one built-in string, in whatever language you write it. `data-slideless-success` is the same as `data-slideless-text-success` and keeps working. The keys, with their English text:

| Key                                                    | Attribute                                                                         | English text                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `success`                                              | `data-slideless-success` (or `…-text-success`)                                    | Your response has been recorded.                                                                                                                             |
| `updated`                                              | `data-slideless-text-updated`                                                     | Your response has been updated.                                                                                                                              |
| `remembers`                                            | `data-slideless-text-remembers`                                                   | This link remembers your answers: reopen it any time to view or change them.                                                                                 |
| `keepLink`                                             | `data-slideless-text-keep-link`                                                   | Keep this personal link to view or update your answer later:                                                                                                 |
| `copy` · `copied` · `copyFailed`                       | `…-text-copy` · `…-text-copied` · `…-text-copy-failed`                            | Copy link · Copied · Press Ctrl+C                                                                                                                            |
| `edit`                                                 | `data-slideless-text-edit`                                                        | Edit response                                                                                                                                                |
| `emailSend` · `emailSent` · `emailFailed`              | `…-text-email-send` · `…-text-email-sent` · `…-text-email-failed`                 | Email me my link · Sent · Try again later                                                                                                                    |
| `emailPlaceholder` · `emailNote`                       | `…-text-email-placeholder` · `…-text-email-note`                                  | you@example.com · Optional: get the link by email so you can come back to it.                                                                                |
| `resumeTitle`                                          | `data-slideless-text-resume-title`                                                | This link points at a response submitted on `{date}`.                                                                                                        |
| `resumeWhy` · `resumeEdit` · `resumeNew`               | `…-text-resume-why` · `…-text-resume-edit` · `…-text-resume-new`                  | Choose "Edit that response" only if it is yours: editing replaces its answers. Otherwise submit a new response. · Edit that response · Submit a new response |
| `errorGeneric` · `errorNetwork`                        | `…-text-error-generic` · `…-text-error-network`                                   | Something went wrong. Please try again. · Network error. Please try again.                                                                                   |
| `close` · `show`                                       | `…-text-close` · `…-text-show`                                                    | Close · Show confirmation                                                                                                                                    |
| `uploadPrompt` · `uploadPromptOne`                     | `…-text-upload-prompt` · `…-text-upload-prompt-one`                               | Drop files here, or click to choose · Drop a file here, or click to choose                                                                                   |
| `uploadHintTypes` · `uploadHintSize` · `uploadHintMax` | `…-text-upload-hint-types` · `…-text-upload-hint-size` · `…-text-upload-hint-max` | Accepted: `{types}` · Up to `{size}` per file · `{max}` files at most                                                                                        |
| `uploadTooLarge` · `uploadWrongType`                   | `…-text-upload-too-large` · `…-text-upload-wrong-type`                            | `{name}` is larger than `{size}`. · `{name}` is not an accepted type (`{types}`).                                                                            |
| `uploadTooMany` · `uploadRequired` · `uploadTooFew`    | `…-text-upload-too-many` · `…-text-upload-required` · `…-text-upload-too-few`     | You can add at most `{max}` files here. · Please add a file. · Please add at least `{min}` files.                                                            |
| `uploadFailed` · `uploadUnavailable`                   | `…-text-upload-failed` · `…-text-upload-unavailable`                              | `{name}` could not be uploaded. Please try again. · File upload is not available on this link.                                                               |
| `uploadBusy` · `uploadRemove`                          | `…-text-upload-busy` · `…-text-upload-remove`                                     | Please wait for the uploads to finish. · Remove                                                                                                              |

`{date}` in the resume title is replaced by the response's date in the dialog's language. The `upload…` strings are the ones of a [file field](#file-fields), and they take placeholders of their own: `{name}` is the file's name, `{size}` a size such as `10 MB`, `{types}` the field's `accept` list, `{max}` and `{min}` the field's counts. A placeholder you leave out of your own string is simply not shown; any other `{word}` stays as you typed it.

A French deck, with one line of its own:

```html
<html lang="fr">
  …
  <form
    data-slideless-form="questions"
    data-slideless-success="Merci, vos réponses sont bien arrivées chez nous."
  >
    …
  </form>
</html>
```

Every other line of that dialog is French: the remembering line, **Copier le lien**, **Modifier ma réponse**, **Fermer**, **Afficher la confirmation**. A Flemish reader gets the same deck in Dutch with `<html lang="nl">`, or one form in Dutch on a French page with `data-slideless-lang="nl"` on that form.

**What the viewer does with your strings.** They are text, never markup: a `<b>` in an override is shown as the characters `<b>`, not as bold, and no attribute can add a link, a script or a style to the dialog. Control characters are dropped, an empty string is treated as absent, and a string is cut at 1,000 characters. Only the keys above are read; any other `data-slideless-text-*` attribute is ignored. The strings live in the viewer's sandbox with the rest of your deck: they are never sent to the server, never stored with a response, and never shown in the dashboard.

**Responses are anonymous by default, attributable when you mint an attributable link.** Slideless never attaches a viewer's account to a response, even when they happen to be signed in to the same instance in the same browser. A deck runs in a sandbox, and anything the page is told, the deck's own scripts can read and replay, so an identity handed to the page would be an identity anyone could claim. What a response always carries is the **share link it came through**, and that is the attribution you control: a link minted for one person, with that person's name on it, tells you who answered as surely as a name field would, without the deck ever learning anything. If you want names or emails in the data itself, add fields for them: the deck author decides what to ask, and Slideless never infers meaning from the answers.

## File fields

A form can ask for files: an identity document, a signed PDF, photos. Put a plain `<input type="file">` with a `name` inside a marked form. On a share link the viewer replaces it with a drop panel, and the files a respondent adds are attached to their response.

```html
<html lang="fr">
  …
  <form data-slideless-form="dossier">
    <label>Nom <input name="nom" required /></label>
    <label>
      Pièces justificatives (carte d'identité, justificatif de domicile)
      <input
        type="file"
        name="pieces"
        accept=".pdf,.jpg,.png"
        multiple
        required
        data-slideless-min="2"
        data-slideless-max="5"
        data-slideless-max-mb="10"
      />
    </label>
    <button type="submit">Envoyer</button>
  </form>
</html>
```

This field takes two to five files, PDF, JPG or PNG, 10 MB each at most, and the panel says so in French. Everything is read off the input itself:

| Attribute                                   | What it does                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                      | Required. The field's name: files are grouped by it on the response, in the zip and in the CLI's folders. A file input without a `name` is left alone.                                   |
| `accept`                                    | The accepted types, comma-separated: extensions (`.pdf,.png`), media types (`application/pdf`) or media type families (`image/*`). Without it, any type is accepted.                     |
| `required`                                  | At least one file.                                                                                                                                                                       |
| `multiple`                                  | More than one file. Without it the field holds one file, and adding another replaces it.                                                                                                 |
| `data-slideless-min` · `data-slideless-max` | The fewest and the most files the field takes. A `multiple` field with no maximum takes as many as the instance allows per response. A maximum above 1 works with or without `multiple`. |
| `data-slideless-max-mb`                     | A size ceiling per file, in MB, for this field. It can only lower the instance's ceiling: a value above it is ignored.                                                                   |

### What the respondent sees

- **A drop panel where the input was.** Dropping files on it adds them, and a click (or Enter, or Space) opens the system file picker. The panel states the accepted types, the size ceiling per file and, when you set one, the maximum count. While a file is dragged over the page every panel lights up, and when a single panel is on screen the whole page is its drop target, so a drop that misses the panel never makes the browser open the file and lose the answers.
- **Each file uploads as soon as it is added**, in its own request, with a progress bar. The list under the panel shows each file's name and size with a **Remove** control. A file of the wrong type, over the size ceiling or over the count is refused with a line under the field, and nothing is sent.
- **Submitting sends the answers and names the files already uploaded.** The submit waits for running uploads: it stops with a message under the field while one is in flight, or while fewer files than your minimum are there.
- **A returning respondent sees names and sizes, never the files.** On a [remembering link](#a-link-that-remembers-its-answers) or a personal edit link the files the response already holds are listed in place. They can be removed or added to, and the next submit keeps whatever is still listed. No route on the respondent's side serves an uploaded file back, so a link that remembers answers never becomes a way to download what was sent through it.
- **On a link that does not take uploads** the panel is greyed out and says `File upload is not available on this link.` The rest of the form still submits, and a `required` on the file field does not block it. The same holds in your own dashboard previews and on an instance where uploads are off.

A file field is served with the rest of the form in [embeds](#forms-in-embeds) and on password-protected links, under the same switch and the same limits. The strings of the panel follow the deck's language and can be replaced one by one: they are the `upload…` keys of [the language table](#the-confirmation-dialog).

### Who enforces what

Two sets of rules apply, and they are not enforced in the same place.

- **Your rules are enforced in the respondent's browser**, by the viewer, the way `required` is on a text field: `accept`, `required`, the counts and `data-slideless-max-mb`. The server never reads your form's markup.
- **The instance's ceilings are enforced by the server**, on every request, whatever the page says:

  | Ceiling                                 | Default | Set by                          |
  | --------------------------------------- | ------- | ------------------------------- |
  | Size of one file                        | 100 MB  | `FORMS_MAX_UPLOAD_MB`           |
  | Files on one response, all fields       | 100     | `FORMS_MAX_FILES_PER_RESPONSE`  |
  | Total weight of one deck's form uploads | 5 GB    | `FORMS_MAX_UPLOADS_MB_PER_DECK` |

  The size of one file is never above the instance's general file ceiling (`MAX_FILE_SIZE_MB`), and it is checked while the bytes arrive, not on the size the request declared. An empty file is refused. The deck total counts files that were uploaded and not yet submitted. Once it is reached, uploads are refused (`403 uploads_full`) until you delete responses. Uploads and removals are also rate-limited per visitor and link (60 per 10 minutes). The values are the operator's, in the [environment reference](../reference/env-reference.md).

**Treat every uploaded file as untrusted.** A respondent who bypasses the page and calls the instance directly, with nothing but the link, can send a file of a type you did not list, or of a size between your ceiling and the instance's. `accept` guides honest respondents; it is not a filter. The server does not inspect or scan what it stores. The file name, the field name and the content type are the respondent's own text: the name is reduced to a base name with no path and no control characters, a declared type that is not a media type is stored as `application/octet-stream`, and that is all. Open a received file the way you would open an attachment from a stranger.

### The per-link switch

File upload is a per-link capability, **on** for every new link, like the form around it. It needs form submissions on: a link with forms off takes no files either.

- **Dashboard**: untick _Allow file uploads_ when creating the link. The links list has an **Uploads** column, and a link's row menu turns uploads on or off later.
- **CLI**: `slideless share DECK_ID --no-uploads` (also on `share-email`); `slideless uploads DECK_ID TOKEN_ID --on` or `--off` for an existing link, and without a flag it prints the current state.
- **API and MCP**: `canUploadFiles: false` when creating the token (`slideless_add_share_token` takes the same field), or `PATCH /api/v1/presentations/{id}/tokens/{tokenId}` on an existing link.

**Links created before file fields existed have uploads off** until their owner turns them on. With uploads on, whoever holds the link can write files to the instance, inside the ceilings above, and a link already in circulation does not gain that by itself. On a link with uploads off, the upload route answers `403 uploads_disabled`, and so does a submit that names files: it is refused whole, so a respondent never believes documents arrived that did not. A submit with no file still goes through.

### Getting the files

The files are part of the response. Every owner-side read of a response carries `files`: each file's `id`, `field`, `name`, `contentType`, `sizeBytes`, `sha256` and `createdAt`, in upload order. The bytes come from three routes, and the dashboard, the CLI, the API and an MCP agent all use these same three:

| What                        | Route                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| One file                    | `GET /api/v1/presentations/{id}/responses/{responseId}/files/{fileId}` |
| One response's files, zip   | `GET /api/v1/presentations/{id}/responses/{responseId}/files.zip`      |
| The whole deck's files, zip | `GET /api/v1/presentations/{id}/responses/files.zip`                   |

- **Dashboard**: a response's row lists its files, each with a download, plus **Download files (.zip)** for the response and **Download all files (.zip)** for the deck.
- **CLI**: `slideless response-files DECK_ID` writes every file under one folder, `slideless response-files DECK_ID RESPONSE_ID` takes one response, and `--zip` takes the server's archive instead. The [CLI reference](../agents/cli.md) has the layout and the flags.
- **API**: the three routes above, authenticated like any other API call. The whole-deck zip takes the listing's filters (`form`, `token`, `source`, `placement`, `since`) and is laid out as `<form>/<response>/<field>/<file>`, where `<response>` is the moment the response was first sent plus the start of its id; one response's zip is `<field>/<file>`. Two files with the same name in one field become `name.ext` and `name (2).ext`. A zip with nothing to put in it answers `404 no_files`.
- **MCP**: `slideless_list_form_responses` returns `files` on every response. It never returns the bytes: the agent fetches them from the routes above with the same credential, or runs the CLI.

The files are addressed to the same people as the responses, under the same `presentations:read` scope for API keys. A file is always served as a download (`Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`), whatever its type: an instance never renders a stranger's PDF, image or HTML page in your signed-in browser. Both zip downloads are written to the audit log.

### How long files are kept

- **A file that was added and never submitted** is deleted by a nightly job once it is more than 24 hours old. A respondent who removes a file before submitting deletes it at once.
- **An edit that leaves a file out deletes it.** The response's [history](#every-edit-is-kept) keeps the name and the size of the files each revision held, never the bytes.
- **Deleting a response deletes its files**, bytes included.
- **Deleting the deck deletes its uploaded files**, the day after: the nightly job removes the files of a deck deleted more than 24 hours ago. The text answers stay with the deleted deck's record, like its versions ([The deck is the artifact](../concepts/artifact.md#delete)).
- Otherwise a file is kept as long as its response.

Uploaded files are stored apart from the deck's own files and from the workspace's **Files** page: they never appear there, a deck version can never reference one, and two respondents who send the same bytes each get their own copy.

## A link that remembers its answers

A share link minted for one named recipient **is that person's response**. Reopen the link plainly, days later, from another device, and the form comes back filled in with the answers already given; submit again and those answers are updated, never duplicated. No personal edit link to keep, no fragment to lose: the share link itself is the handle, because the server keys the response on the link it came through, a fact it already stores and never hands to the deck.

This is the default for every link you name: the dashboard's share form (**Remember answers on this link**, ticked), the API and the MCP tool (`remembersResponses`, default `true`), `slideless share <id> --name "Alice"` and every link `share-email` mints. Two shapes never remember, on purpose:

- **The unnamed quick link.** `slideless share <id>` without `--name` mints the generic `cli` label, and a link nobody named is a link for nobody in particular: every submit through it is a fresh response, as before. Pass `--remember` to make it remember, `--no-remember` on a named link to make it not.
- **Embeds.** A deck embedded on a website is opened by everyone who visits the page, all through the same link, so an embedded form never brings back the previous visitor's answers and never updates them: every embedded submission is its own response. The same link opened directly still remembers. **Never embed a remembering link:** an embed publishes the link's secret in your page source, so anyone can open that link directly and read or change the remembered answer. Mint the embed's link with `--no-remember` (or untick _Remember answers on this link_).

**Read this before you forward such a link.** On a remembering link the link secret is a bearer credential for the answers, not just for the deck: whoever holds the link can read what was answered through it and change it. Hand it to the one person it was minted for. For a link you will post publicly, or pass around a team, untick the switch (or `--no-remember`): every submit is then a separate response, and the personal edit link on the confirmation card is the only way back to one of them.

On a remembering link the confirmation dialog says so (`This link remembers your answers: reopen it any time to view or change them.`) and offers **Edit response**, which simply closes it over the still-filled form; the personal edit link and **Email me my link** do not appear, since the link is what to keep. Your own dashboard previews never remember anything, as they never create responses. The switch can be changed on an existing link (`PATCH …/tokens/{tokenId}` with `remembersResponses`); turning it off stops the link from bringing answers back and leaves the rows as they are.

## Every edit is kept

An edited response is not overwritten: every submit is a **revision**, and every revision is kept. Revision 1 is what was first said; each edit appends the next, with the link, the source, the placement and the deck version of the moment it was written. The response you list, export or delete is always the latest revision; the history is behind it.

- **The respondent sees only the latest.** Reopening a link or a personal edit link loads the current answers, and nothing on the respondent's side shows a revision number or an earlier text. One respondent can never read another's history.
- **The owner sees the history.** `GET …/responses/{responseId}` answers `{ response, versions }`, every kept revision newest first; `slideless response <deckId> <responseId>` prints the same; the dashboard's response row shows an **Edited · n versions** badge with a **History** button; the MCP `slideless_list_form_responses` tool takes `responseId`. Who wrote a revision is what the row knows: the link it came through and the moment, never an invented identity.
- **Retention.** At most 100 revisions are kept per response. Past that, the oldest revisions after the first are pruned: revision 1 and the latest 99 always survive.
- **Responses from before this feature** have a single revision carrying the answer as it was when the feature arrived; for one that had already been edited by then, revision 1 is that latest text, not what was first said. The history starts the day the feature lands.

Responses stay listed **newest first by creation**, so a page of results is stable while people keep answering and editing (a cursor over a changing sort order would skip or repeat rows in a CSV export). An edited response is found through its activity instead: the `since` filter, the summary's **Last activity**, and the **Edited · n versions** badge on the row. A `since` result keeps that creation order too, so on a long-lived deck an old response edited this morning sits at the depth its creation gives it, not on the first page; `--since` with `--all`, or the CSV, reads the whole set.

Because an edit is activity, the summary's **Last activity** and the `since` filter follow the latest activity of a response, not the moment it was first created: `--since` this morning finds an answer edited this morning, and the summary says when the last one changed.

## Being told

The deck owner is mailed when a response arrives and, in a **different mail**, when an existing response is edited. Both carry the deck's title, the form, the link the response came through, the moment, the revision number on an edit, and a button to the deck's page. **Neither mail carries the answers**: a respondent's text is third-party data that does not belong in an inbox; read it in the product.

- **One mail per deck per ten minutes.** A deck under a burst of submissions does not mail per row: the first response mails at once, the ones inside the window are counted, and the next mail after the window says how many others arrived and how many edits since the last mail.
- **Off switch.** Per deck, default on: the **Email me when responses arrive** switch on the responses panel, `notifyOnResponse` on `PATCH /api/v1/presentations/{id}` and on the MCP `slideless_update_presentation` tool, `slideless notify <id> --off` on the CLI. Forms stay on; only the mails stop.
- **Never in the way.** The mail is sent after the response is stored and never delays the respondent; an instance without a mail driver sends nothing; a mail failure is a log line, never a lost response.

## Collecting responses

- **Dashboard**: the deck page's _Responses_ panel shows a summary of what came in from where (per form, per link, per source and placement), plus the rows themselves, filterable and downloadable as CSV.
- **CLI**:

  ```bash
  slideless responses DECK_ID                       # summary buckets, then the latest rows
  slideless responses DECK_ID --form rsvp           # one form's stream
  slideless responses DECK_ID --link TOKEN_ID       # one share link's stream (the token id)
  slideless responses DECK_ID --source embed --placement pricing-page
  slideless responses DECK_ID --since 2026-07-01T00:00:00Z --csv > responses.csv
  slideless responses DECK_ID --json                # the wire shape, for agents
  slideless response DECK_ID RESPONSE_ID            # one response with its edit history
  slideless notify DECK_ID --off                    # stop the owner mails on this deck
  ```

- **API**: `GET /api/v1/presentations/{id}/responses` (cursor-paginated, newest first, filters `form`, `token`, `source`, `placement`, `since`, the last one reading activity), `GET …/responses/summary` (grouped counts per form × link × source × placement, with last activity), `GET …/responses/{responseId}` (one response with its revision history), and `DELETE …/responses/{responseId}` to remove a response and its history.
- **MCP**: the `slideless_list_form_responses` tool takes the same filters, `summary: true` returns the grouped overview instead of rows, and `responseId` returns one response with its history.

A response with [file fields](#file-fields) also carries its `files` on every one of these surfaces; [Getting the files](#getting-the-files) covers the downloads.

Responses are addressed to the people who can change the deck: the owner, a workspace admin, or an active collaborator. For API keys, reading sits under the `presentations:read` scope and deleting under `presentations:write`.

Each response records the form name, the deck version the respondent saw, the share link it came through, the source (`link` or `embed`), the placement label, timestamps, the current revision number, the answer itself, and the files it holds. An edited response stays one row, its revision number bumped and its earlier revisions kept behind it (see [Every edit is kept](#every-edit-is-kept)). Treat answer content as untrusted text: the dashboard escapes it everywhere it renders, and the CSV export guards against spreadsheet formula injection.

## Per-link control

Form submission is a per-link capability that defaults to **on** (the per-link switches are listed on [Share links](../concepts/links.md)): a form is part of the deck by the author's own choice, so `push` then `share` yields a working form with zero extra flags. To hand out a read-only link instead:

- **CLI**: `slideless share DECK_ID --no-forms` (also on `share-email`).
- **Dashboard**: untick _Allow form submissions_ when creating the link. Links that refuse forms leave the **Forms** column unchecked in the links list.
- **API**: `canSubmitForms: false` when creating the token, or `PATCH /api/v1/presentations/{id}/tokens/{tokenId}` to flip it on an existing link.

On a link with forms off, no submission wiring is served and direct submission attempts are refused (`403 forms_disabled`). Your own dashboard previews never create responses, the same way they never count as views.

## Forms in embeds

[Embedded decks](embedding.md) keep their forms fully working: viewers submit from inside the frame on your site. Attribution follows automatically: an embedded submission records source `embed` (a direct link records `link`) plus the embed's `data-slideless-placement` label, so the same link embedded in three places gives you three distinguishable response streams.

Two embed rules carry over:

- **Password-protected links stay unusable in embeds.** The password gate never renders inside a frame, so such a link's forms are unreachable there too. Embed links without a password.
- **Responses stay anonymous**, exactly as they do on a direct link, unless the form itself asks. The confirmation dialog opens inside the frame, the personal edit link and the email option work the same from there, and the loader drops any `#…` fragment on a `data-slideless-embed` URL. A hand-written iframe carrying a fragment only triggers the ask-first prompt, which defaults to a new response: a fragment is never silently adopted.

## Limits

- An answer is capped at 128 fields, 128 characters per field name, and 32 KiB serialized.
- A deck holds at most **10,000 responses** across all its forms; past that, new submissions are refused until you delete some.
- Submissions are rate-limited per visitor and link (30 per 10 minutes); edit-link emails are limited harder (5 per 15 minutes, also per target address).
- Uploaded files have their own limits, set by the instance: the size of one file, the number of files on a response, and the total weight per deck. See [Who enforces what](#who-enforces-what).

## What is stored, and what is never stored

A response stores the answer exactly as submitted, the files added to its file fields (their bytes, plus the name, the field, the declared type, the size and a SHA-256 of each), plus attribution context: the form name, the deck version, the share link, `link` or `embed`, and the placement label; every revision keeps its own copy of that context. **No respondent identity is ever stored** — see above; a remembering link attributes a response to the link, which is the owner's own label, not a viewer's account. Editing a response re-stamps the current context from the visit that made the edit, so the latest revision describes where the answer came from now, and the earlier revisions where it came from then. As with [link analytics](link-analytics.md), on every edition, self-hosted included:

- **No IP addresses** are stored on responses.
- **No User-Agent strings.**
- **No referrer.**

The `source` and `placement` context comes from the visiting browser, so read it as attribution, not proof: it tells you where responses came from, and it is never used as an access-control signal.
