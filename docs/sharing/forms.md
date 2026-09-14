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

- **Standard inputs.** Text fields, textareas, selects, radios, checkboxes: anything that serializes as form data. Repeated names (the checkboxes above) become arrays in the stored response. File inputs are skipped: responses carry text, never uploads.
- **The name is the form's identity.** A slug of 1 to 64 characters from `A–Z a–z 0–9 . _ -`. Responses are grouped and filtered by it everywhere, and it shows up in your dashboard, CLI tables, and CSV exports.
- **Multiple forms per deck** are just multiple named forms; each collects its own stream.
- **Sub-pages work.** In a multi-page deck a form can sit on any HTML page, not only the entry.
- **The markup stays yours.** The viewer wires submission behavior onto your form; it never restyles or rewrites it.
- **Custom confirmation.** `data-slideless-success="Thanks, see you there!"` replaces the default "Your response has been recorded."

`slideless push` needs no flags and no manifest entry: pushing a deck that contains a marked form — in its HTML or in a script file that renders the form at load time — is all it takes, and the push output lists the detected form names as a reminder. Any share link then serves it working (see per-link control below).

**How the server decides.** At commit it stamps each version with whether it holds a form, and only stamped versions are served with the runtime. The rule: a deck that ships any script (a script file, or an inline `<script>` in a page) is always served with the runtime, because a form built at load time — `form.dataset.slidelessForm = 'rsvp'`, attributes read from a JSON data file, a minified bundle — cannot be seen in the bytes; a deck with no script at all is served with the runtime when the marker appears literally in an HTML page or a JSON file. Stylesheets, fonts and images never count. So a script-bearing deck always gets the runtime (one inert script tag if it has no form); a script-less deck must carry the literal `data-slideless-form` marker.

## What a viewer experiences

Submitting swaps the form for a confirmation card, with double-submit protection while the request is in flight and inline errors if something goes wrong. The card carries:

- **The personal edit link**: the page URL plus a private `#slr=` fragment. Reopening it later offers to bring back the viewer's own answer; once they confirm, the form is prefilled and submitting again updates it in place. One respondent keeps one evolving response instead of piling up duplicates. The fragment never travels to the server as part of a request URL, so the edit secret stays out of logs; it is shown once, and without it a new submission is simply a new response.
- **Email me my link** (optional): the card offers to mail the edit link to an address the viewer types at that moment. The field appears only on instances that send email, and the mail only ever carries that viewer's own link.
- **Returning with an edit link asks first.** Opening a `#slr=` link does not silently put the form into edit mode. The card explains that the link points at a response submitted on a given date and offers _Edit that response_ or _Submit a new response_, defaulting to a new one. The link may have been forwarded, pasted on a page, or handed out deliberately, and overwriting a stranger's answers must never happen by merely opening a URL.

**Responses are anonymous by default, attributable when you mint an attributable link.** Slideless never attaches a viewer's account to a response, even when they happen to be signed in to the same instance in the same browser. A deck runs in a sandbox, and anything the page is told, the deck's own scripts can read and replay, so an identity handed to the page would be an identity anyone could claim. What a response always carries is the **share link it came through**, and that is the attribution you control: a link minted for one person, with that person's name on it, tells you who answered as surely as a name field would, without the deck ever learning anything. If you want names or emails in the data itself, add fields for them: the deck author decides what to ask, and Slideless never infers meaning from the answers.

## A link that remembers its answers

A share link minted for one named recipient **is that person's response**. Reopen the link plainly, days later, from another device, and the form comes back filled in with the answers already given; submit again and those answers are updated, never duplicated. No personal edit link to keep, no fragment to lose: the share link itself is the handle, because the server keys the response on the link it came through, a fact it already stores and never hands to the deck.

This is the default for every link you name: the dashboard's share form (**Remember answers on this link**, ticked), the API and the MCP tool (`remembersResponses`, default `true`), `slideless share <id> --name "Alice"` and every link `share-email` mints. Two shapes never remember, on purpose:

- **The unnamed quick link.** `slideless share <id>` without `--name` mints the generic `cli` label, and a link nobody named is a link for nobody in particular: every submit through it is a fresh response, as before. Pass `--remember` to make it remember, `--no-remember` on a named link to make it not.
- **Embeds.** A deck embedded on a website is opened by everyone who visits the page, all through the same link, so an embedded form never brings back the previous visitor's answers and never updates them: every embedded submission is its own response. The same link opened directly still remembers.

**Read this before you forward such a link.** On a remembering link the link secret is a bearer credential for the answers, not just for the deck: whoever holds the link can read what was answered through it and change it. Hand it to the one person it was minted for. For a link you will post publicly, or pass around a team, untick the switch (or `--no-remember`): every submit is then a separate response, and the personal edit link on the confirmation card is the only way back to one of them.

On a remembering link the confirmation card says so ({{This link remembers your answers: reopen it any time to view or change them.}}) and offers **Edit response**; the personal edit link and **Email me my link** do not appear, since the link is what to keep. Your own dashboard previews never remember anything, as they never create responses. The switch can be changed on an existing link (`PATCH …/tokens/{tokenId}` with `remembersResponses`); turning it off stops the link from bringing answers back and leaves the rows as they are.

## Every edit is kept

An edited response is not overwritten: every submit is a **revision**, and every revision is kept. Revision 1 is what was first said; each edit appends the next, with the link, the source, the placement and the deck version of the moment it was written. The response you list, export or delete is always the latest revision; the history is behind it.

- **The respondent sees only the latest.** Reopening a link or a personal edit link loads the current answers, and nothing on the respondent's side shows a revision number or an earlier text. One respondent can never read another's history.
- **The owner sees the history.** `GET …/responses/{responseId}` answers `{ response, versions }`, every kept revision newest first; `slideless response <deckId> <responseId>` prints the same; the dashboard's response row shows an **Edited · n versions** badge with a **History** button; the MCP `slideless_list_form_responses` tool takes `responseId`. Who wrote a revision is what the row knows: the link it came through and the moment, never an invented identity.
- **Retention.** At most 100 revisions are kept per response. Past that, the oldest revisions after the first are pruned: revision 1 and the latest 99 always survive.

Because an edit is activity, the listing, the summary's **Last activity** and the `since` filter all follow the latest activity of a response, not the moment it was first created: an answer edited this morning is at the top of the list again, and `--since` this morning finds it.

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

- **API**: `GET /api/v1/presentations/{id}/responses` (cursor-paginated, latest activity first, filters `form`, `token`, `source`, `placement`, `since`), `GET …/responses/summary` (grouped counts per form × link × source × placement, with last activity), `GET …/responses/{responseId}` (one response with its revision history), and `DELETE …/responses/{responseId}` to remove a response and its history.
- **MCP**: the `slideless_list_form_responses` tool takes the same filters, `summary: true` returns the grouped overview instead of rows, and `responseId` returns one response with its history.

Responses are addressed to the people who can change the deck: the owner, a workspace admin, or an active collaborator. For API keys, reading sits under the `presentations:read` scope and deleting under `presentations:write`.

Each response records the form name, the deck version the respondent saw, the share link it came through, the source (`link` or `embed`), the placement label, timestamps, the current revision number, and the answer itself. An edited response stays one row, its revision number bumped and its earlier revisions kept behind it (see [Every edit is kept](#every-edit-is-kept)). Treat answer content as untrusted text: the dashboard escapes it everywhere it renders, and the CSV export guards against spreadsheet formula injection.

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
- **Responses stay anonymous**, exactly as they do on a direct link, unless the form itself asks. The personal edit link and the email option work the same from inside an embed, and the loader ignores any `#…` fragment on a `data-slideless-embed` URL, so an embedding page cannot point visitors at somebody else's response.

## Limits

- An answer is capped at 128 fields, 128 characters per field name, and 32 KiB serialized.
- A deck holds at most **10,000 responses** across all its forms; past that, new submissions are refused until you delete some.
- Submissions are rate-limited per visitor and link (30 per 10 minutes); edit-link emails are limited harder (5 per 15 minutes, also per target address).
- No file uploads: file inputs are ignored, on purpose.

## What is stored, and what is never stored

A response stores the answer exactly as submitted, plus attribution context: the form name, the deck version, the share link, `link` or `embed`, and the placement label; every revision keeps its own copy of that context. **No respondent identity is ever stored** — see above; a remembering link attributes a response to the link, which is the owner's own label, not a viewer's account. Editing a response re-stamps the current context from the visit that made the edit, so the latest revision describes where the answer came from now, and the earlier revisions where it came from then. As with [link analytics](link-analytics.md), on every edition, self-hosted included:

- **No IP addresses** are stored on responses.
- **No User-Agent strings.**
- **No referrer.**

The `source` and `placement` context comes from the visiting browser, so read it as attribution, not proof: it tells you where responses came from, and it is never used as an access-control signal.
