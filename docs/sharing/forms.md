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

`slideless push` needs no flags and no manifest entry: pushing a deck that contains a marked form is all it takes, and the push output lists the detected form names as a reminder. Any share link then serves it working (see per-link control below).

## What a viewer experiences

Submitting swaps the form for a confirmation card, with double-submit protection while the request is in flight and inline errors if something goes wrong. The card carries:

- **The personal edit link**: the page URL plus a private `#slr=` fragment. Opening it later prefills the form with the viewer's own answer, and submitting again updates it in place. One respondent keeps one evolving response instead of piling up duplicates. The fragment never travels to the server as part of a request URL, so the edit secret stays out of logs; it is shown once, and without it a new submission is simply a new response.
- **Email me my link** (optional): the card offers to mail the edit link to an address the viewer types at that moment. The field appears only on instances that send email, and the mail only ever carries that viewer's own link.
- **Automatic recognition for signed-in viewers on direct links.** When someone opens a share link in a browser where they are signed in to the same Slideless instance, their submission is attributed to their account, and on instances that send email the edit link is mailed to their account address with no prompting. Everyone else stays anonymous. Inside embeds nobody is auto-recognized (see below).

A form is otherwise anonymous by design: if you want names or emails in the data, add fields for them. The deck author decides what to ask, and Slideless never infers meaning from the answers.

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
  ```

- **API**: `GET /api/v1/presentations/{id}/responses` (cursor-paginated, newest first, filters `form`, `token`, `source`, `placement`, `since`), `GET …/responses/summary` (grouped counts per form × link × source × placement, with last activity), and `DELETE …/responses/{responseId}` to remove a response.
- **MCP**: the `slideless_list_form_responses` tool takes the same filters, and `summary: true` returns the grouped overview instead of rows.

Responses are addressed to the people who can change the deck: the owner, a workspace admin, or an active collaborator. For API keys, reading sits under the `presentations:read` scope and deleting under `presentations:write`.

Each response records the form name, the deck version the respondent saw, the share link it came through, the source (`link` or `embed`), the placement label, timestamps, and the answer itself. An edited response stays one row with an updated timestamp. Treat answer content as untrusted text: the dashboard escapes it everywhere it renders, and the CSV export guards against spreadsheet formula injection.

## Per-link control

Form submission is a per-link capability that defaults to **on**: a form is part of the deck by the author's own choice, so `push` then `share` yields a working form with zero extra flags. To hand out a read-only link instead:

- **CLI**: `slideless share DECK_ID --no-forms` (also on `share-email`).
- **Dashboard**: untick _Allow form submissions_ when creating the link. Links that refuse forms show a _Forms off_ badge in the sharing panel.
- **API**: `canSubmitForms: false` when creating the token, or `PATCH /api/v1/presentations/{id}/tokens/{tokenId}` to flip it on an existing link.

On a link with forms off, no submission wiring is served and direct submission attempts are refused (`403 forms_disabled`). Your own dashboard previews never create responses, the same way they never count as views.

## Forms in embeds

[Embedded decks](embedding.md) keep their forms fully working: viewers submit from inside the frame on your site. Attribution follows automatically: an embedded submission records source `embed` (a direct link records `link`) plus the embed's `data-slideless-placement` label, so the same link embedded in three places gives you three distinguishable response streams.

Two embed rules carry over:

- **Password-protected links stay unusable in embeds.** The password gate never renders inside a frame, so such a link's forms are unreachable there too. Embed links without a password.
- **No automatic recognition in embeds.** An embedded view can never see a Slideless sign-in, so responses from embeds stay anonymous unless the form itself asks. The personal edit link and the email option work exactly the same from inside an embed.

## Limits

- An answer is capped at 128 fields, 128 characters per field name, and 32 KiB serialized.
- A deck holds at most **10,000 responses** across all its forms; past that, new submissions are refused until you delete some.
- Submissions are rate-limited per visitor and link (30 per 10 minutes); edit-link emails are limited harder (5 per 15 minutes, also per target address).
- No file uploads: file inputs are ignored, on purpose.

## What is stored, and what is never stored

A response stores the answer exactly as submitted, plus attribution context: the form name, the deck version, the share link, `link` or `embed`, the placement label, and (only for a recognized signed-in respondent on a direct link) their account identity. As with [link analytics](link-analytics.md), on every edition, self-hosted included:

- **No IP addresses** are stored on responses.
- **No User-Agent strings.**
- **No referrer.**

The `source` and `placement` context comes from the visiting browser, so read it as attribution, not proof: it tells you where responses came from, and it is never used as an access-control signal.
