# Data-bound templates

A template can ship the shape of the data it shows. Put a `schema.json` next to its `AGENT.md`, bind
its pages to the schema's fields, and the template becomes a document factory: a tool pushes a JSON
object, Slideless fills the pages, and every push is a new version of the document. A form inside
the document writes its answer back into the same data, so the thing that asked a question is also
where the answer is read.

Nothing changes for an ordinary deck, or for a template without a schema. The feature starts with
one file.

## The template

A template is a [reference](references.md) whose `AGENT.md` frontmatter says `type: Template`. Two
more files at the root of the bundle make it data-bound:

- **`schema.json`**, a [JSON Schema](https://json-schema.org/) (draft 2020-12) of the data a document
  carries. It must carry a `version` string of its own, and it may carry an `$id`.
- **`data.json`**, a sample the schema accepts. The dashboard previews the template with it, and
  `slideless template new` scaffolds both files.

```json
{
  "$id": "https://example.com/lane-report",
  "version": "1",
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "tickets": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": { "id": { "type": "string" }, "headline": { "type": "string" } },
        "required": ["id"]
      }
    }
  },
  "required": ["title"],
  "additionalProperties": false
}
```

The `AGENT.md` says the rest in words: what each field means, how the pages use it, what a tool
pushes at which moment.

## Binding a page

A page binds to the data with markers in its HTML, resolved when a document is made or pushed:

| Marker                                           | What it does                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `{{title}}`                                      | The value of the field, HTML-escaped. A dotted path walks into objects: `{{code.branch}}`.                                           |
| `{{{summary}}}`                                  | The value as it is, not escaped. For a field that holds HTML you trust.                                                              |
| `{{#tickets}} … {{/tickets}}`                    | Repeated once per item of a list, the item as the context; rendered once for an object or a true value; skipped when empty or false. |
| `{{^tickets}} … {{/tickets}}`                    | The opposite: rendered when the list is empty or the value is false or missing.                                                      |
| `{{.}}`, `{{@index}}`, `{{@first}}`, `{{@last}}` | Inside a list: the item itself, its position from 0, whether it is the first or the last.                                            |
| `{{! a note }}`                                  | Dropped.                                                                                                                             |
| `\{{`                                            | A literal `{{`.                                                                                                                      |

Inside a repeated block, a field that the item does not have is looked up one level out, so
`{{#tickets}}{{title}}{{/tickets}}` prints the document's title on every ticket. There are no helpers
and no partials: a value is pushed the way it should read.

```html
<h1>{{title}}</h1>
<ul>
  {{#tickets}}
  <li><strong>{{id}}</strong> {{headline}}</li>
  {{/tickets}}
</ul>
{{^tickets}}
<p>No ticket yet.</p>
{{/tickets}}
```

Every HTML page of the template is bound, sub-pages included. Styles, scripts, images and fonts are
served as they are.

## What the push checks

A template push is refused, with the file and the line named, when:

- a page binds a field the schema does not describe (`binding_unknown`);
- a block is never closed or a marker is not a field path (`binding_syntax`);
- `schema.json` is not a JSON Schema with a `version` (a keyword holding a value of the wrong shape,
  such as `"required": "title"` or `"type": "strin"`, or a `$ref` that points nowhere), or carries a
  `pattern` that could take exponential time on a crafted value (`schema_invalid`);
- `data.json` does not follow the schema (`sample_invalid`);
- `schema.json` changed but its `version` did not (`schema_version_unchanged`). Documents pin a
  template version, and an upgrade compares the two.

`slideless template push` prints the refusal. The dashboard's **Data** tab on a template shows the
schema, the sample, the list of fields the pages bind, and a preview of the template filled with the
sample.

## The document

A document is a deck made from a template with data:

```bash
slideless document create --from "Lane report" --data lane.json
```

The document is pinned to the template version it was made from. Its version 1 is the template's
pages filled with the data, served, shared, downloaded and thumbnailed like any deck. A share link
on the document opens the filled page; `slideless pull` writes the filled page to disk.

Every push of data is a new version of the document:

```bash
slideless document data push <id> --file lane.json     # replace the data
slideless document data push <id> --merge patch.json   # change some keys only
```

`--file` replaces the whole object. `--merge` applies a merge patch: the keys in the file are set,
a key set to `null` is removed, the others stay. Both are checked against the pinned schema, and a
refusal names the field:

```
Error: The data does not follow the schema at /tickets/0/id: Property "id" is required.
```

`slideless document check --from "Lane report" --data lane.json` runs the same check without
pushing anything, so a tool can validate a file before it sends it.

Two more refusals a tool may meet: `409 document_busy` when another write on the same document is
still running after a fifteen-second wait (retry), and `400 schema_too_slow` when the schema's
patterns took more than a quarter of a second to judge the data (the pattern is the template's
to simplify). A template page over 8 MB is refused at push (`bound_file_too_large`), data over 1 MB
at write (`data_too_large`), and `500 validator_failed` is the instance's own fault, never the
schema's: retry.

The version history of the document is the history of its data: `slideless document data versions
<id>` lists each version with when, who, and the keys that changed; the dashboard's **Data** panel
shows the same and the difference between two versions.

## Answers in the data

A document may carry [forms](../sharing/forms.md). When someone answers one through a share link,
the response is stored as it is for every deck, and it is also written into the document's data
under `answers`, keyed by the form's name and then by its field names:

```json
{
  "title": "Data-bound templates",
  "answers": {
    "merge_gate": {
      "decision": "yes",
      "comment": "merge it",
      "$answered": {
        "at": "2026-10-20T19:02:00.000Z",
        "by": "romain",
        "link": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47",
        "response": "2b3f5197-cc10-4055-add1-5da2a0f05528",
        "revision": 1
      }
    }
  }
}
```

`by` is the recipient label of the share link the answer came through, the one name Slideless
keeps for a respondent; `at` is when; `response` and `revision` point at the stored response. The
page is rendered again with the answer in place, so a template may show what was answered:
`{{answers.merge_gate.decision}}`. The `answers` branch is always a valid binding, whatever the
schema says, and a push may never write it: a data file carrying `answers` is refused, a replace
keeps the answers the document already holds, and only a response moves them.

One answer per form is kept in the data, the latest; every response and its revisions stay in the
Responses tab, the API and the CSV as before. `slideless document answers <id>` reads them back,
and the webhook event `document.answered` tells a receiver the moment one lands.

## Upgrading a document

A new version of the template does not touch the documents made from it. Moving one is explicit:

```bash
slideless document upgrade <id>            # to the template's current version
slideless document upgrade <id> --to 3
```

The document's data is checked against the new version's schema first. When it no longer fits, the
upgrade is refused with the field named and the document stays where it was; push the missing data
with the upgrade (`--merge` or `--file` on the command, `merge` or `data` on the API), or before it.

A document outlives its template: when the template is deleted, the document keeps serving and
taking pushes on the version it is pinned to, and an upgrade answers `template_gone`. A writer of a
document must be able to read its template while it exists, since every push renders the template's
pages for them: one who cannot meets the same `template_gone`, which never tells a template they may
not read from one that is gone.

## What the document carries

The pushed data travels with the document: the rendered entry page embeds it in a `<script
type="application/json" id="slideless-data">` block, and `data.json` sits at the root of every
version, so a pull, a PDF or an agent reading the share link keep what the page was drawn from.
Whoever holds a share link can read that data, bound or not: push what the document may show.

The `answers` branch is not in those two files. Another recipient's answer, and the label of the
link it came through, reach a page only where the template binds them: `{{answers.merge_gate.decision}}`
shows the decision to every reader of the page, by the author's choice, and nothing shows it
otherwise. The owner reads the whole branch through the API, the CLI and the dashboard.
`{{{answers.merge_gate.comment}}}` (three braces) renders what a respondent typed as HTML, unescaped:
keep the two-brace form on an answer unless you mean it.

Only a form the document's pages carry is mirrored, and the branch has a budget of its own, 32 forms
and 256 KB, so a link holder can never fill a document until its owner cannot write it; a response
beyond either stays in the Responses tab and is not mirrored.
`slideless document answers <id> --clear <form>` (or `DELETE /presentations/{id}/answers/{form}`)
clears one form's answer from the data and renders again; the responses stay.

## From the API and the agent tools

| Action                      | API                                               | MCP tool                         |
| --------------------------- | ------------------------------------------------- | -------------------------------- |
| Read a template's contract  | `GET /presentations/{id}/schema`                  | `slideless_get_template_schema`  |
| Replace a template's schema | `PUT /presentations/{id}/schema`                  |                                  |
| Create a document           | `POST /presentations/{id}/instances`              | `slideless_create_document`      |
| Read the data               | `GET /presentations/{id}/data`                    | `slideless_get_document_data`    |
| Replace or merge the data   | `PUT` or `PATCH /presentations/{id}/data`         | `slideless_push_document_data`   |
| The push history            | `GET /presentations/{id}/data/versions`           |                                  |
| The answers                 | `GET /presentations/{id}/answers`                 | `slideless_get_document_answers` |
| Upgrade                     | `POST /presentations/{id}/upgrade`                | `slideless_upgrade_document`     |
| Clear one form's answer     | `DELETE /presentations/{id}/answers/{form}`       |                                  |
| One version of the history  | `GET /presentations/{id}/data/versions/{version}` |                                  |

A document is read by whoever reads the deck, and written by whoever can push to it. Creating a
document, pushing data, upgrading, clearing an answer and replacing a template's schema count as
deck edits on the Antasphere cloud; an answer costs what a form response costs, and its re-render nothing.

## Limits

| What                          | Limit  |
| ----------------------------- | ------ |
| `schema.json`, serialized     | 256 KB |
| A document's data, serialized | 1 MB   |
| An HTML page of a template    | 8 MB   |
