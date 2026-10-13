# Webhooks

A webhook is a URL your workspace registers to be told when something happens: a deck is pushed, a
share link is opened, a form receives a response. Each time, Slideless sends a signed `POST` to the
URL with what happened. Nobody has to poll the API, and an automation (an n8n workflow, a CRM, a
Slack bot of your own) reacts within seconds.

## An endpoint

An endpoint is one URL with what it subscribes to:

- **Events**: the event types it receives, at least one. Each entry is an exact type
  (`form.response_submitted`), a family (`deck.*`, every `deck.` event), or everything (`*`).
- **Filters** (optional): which decks, projects or share links it is about. See
  [Filters](#filters) below.
- **A description**: a note for the people who manage it, up to 200 characters.
- **A switch**: an endpoint can be off. Nothing is sent to it then, and it keeps its settings and
  its history.
- **A signing secret** (`whsec_…`): every delivery is signed with it, so the receiver can prove the
  request came from your instance. The secret is shown once, when the endpoint is created and when
  it is rotated, and never again. [Webhook signatures](../security/webhook-signatures.md) explains
  how to check it.

An endpoint receives the events that happen after it exists; nothing that happened before is sent.
A new endpoint starts receiving within about thirty seconds.

## Who manages them

An owner or an admin of the workspace creates, changes and deletes the endpoints, and reads them
and their deliveries: an endpoint is a standing copy of the workspace's activity to an address of
someone's choice, so plain members do not see them. Every member, guests excepted, can read the
event catalog. A guest is refused everything, and a session opened by a
[demo link](../self-hosting/demo-links.md) may not change anything.

From a machine, an API key needs the `webhooks:manage` scope. The key `slideless login` makes
carries it, beside `presentations:read` and `presentations:write`; a key made on the API keys page
needs it among its scopes. Reading the catalog takes `presentations:read`.

Where they are managed:

- **The dashboard**: the **Webhooks** tab. **New webhook** registers one and shows its secret once;
  each endpoint has **Send a test**, **Rotate secret** and its **Deliveries**.
- **The CLI**: `slideless webhooks …` ([CLI reference](../agents/cli.md#webhooks)).
- **MCP**: the eleven `slideless_*webhook*` tools ([MCP connector](../agents/mcp-connector.md)).
- **The API**: `/api/v1/webhooks` (the OpenAPI document of the instance has every route).

## Event types

The event types are listed, with the fields of each and an example, in
[Webhook events](../reference/webhook-events.md). In short:

- `deck.*`: a deck created, a version pushed, its settings changed, deleted, put in a project or
  taken out of one.
- `share_link.*`: a link created, changed, revoked, sent by mail, opened.
- `form.*`: a response submitted, edited or deleted, a file dropped into a form.
- `attachment.downloaded`, `collaborator.*`, `annotation.*`, `thumbnail.*`.
- The workspace's own: `member.joined`, `member.removed`, `workspace.created`, `apikey.created`,
  `apikey.revoked`, `project.created`, `project.archived`.
- `webhook.ping`: the test delivery.

The instance also serves the catalog itself, with the JSON Schema of every event's `data`:
`GET /api/v1/webhooks/events`, `slideless webhooks events`, or the `slideless_webhook_events` tool.
An agent setting up a webhook reads it there rather than from this page.

Two events are worth knowing before you build on them:

- **`share_link.viewed` is grouped per link.** The first view of a link is sent at once. After
  that, at most one event per link every five minutes, carrying the number of views since the
  previous event (`views`), the first and last of them, and their referring hosts, placements and
  browser families. A viewer's address or identity is never sent; see
  [Link analytics](../sharing/link-analytics.md).
- **A form response carries its answers.** `form.response_submitted` and `form.response_edited`
  hold `answers`, by field name (a text, or a list for a multiple choice), and the files the
  respondent uploaded (their names and sizes, not the bytes). The answers are what a respondent
  typed: treat them as untrusted input.

Every other event carries ids and a few facts, not the whole object: the receiver fetches the rest
with an API key when it needs it.

## Filters

A filter narrows an endpoint to some decks, projects or share links. It names a subject and the ids
it accepts:

| Subject   | Matches                                      |
| --------- | -------------------------------------------- |
| `deck`    | Events about one of these decks              |
| `project` | Events about a deck in one of these projects |
| `link`    | Events about one of these share links        |

Several ids on one subject match any of them (OR). Several subjects must all match (AND): a filter
on a project and on a link takes the events about that link of a deck in that project. An event
that does not carry the filtered subject does not match: an endpoint filtered on a deck receives no
`member.joined`, and an endpoint filtered on a link receives no `deck.version_committed`. Which
subjects each event carries is in [Webhook events](../reference/webhook-events.md).

```bash
slideless webhooks create https://hooks.example.com/slideless \
  --event form.response_submitted --filter deck=<deckId>
```

## What a delivery looks like

Each delivery is a `POST` with a JSON body, the **envelope**:

```json
{
  "id": "a5e73cf3-a1f3-47c4-939f-868e15a0f2b5",
  "type": "form.response_submitted",
  "occurredAt": "2026-10-13T09:30:00.000Z",
  "workspaceId": "c6409e21-663b-41bf-966f-fd3f6fde5c36",
  "subjects": {
    "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528",
    "projectIds": ["5328eb51-71a5-43e1-afd7-fb665c97be6d"],
    "shareLinkId": "d5de1f6a-55d9-42f1-b8d2-b3c1729ccf47"
  },
  "data": { "deckId": "2b3f5197-cc10-4055-add1-5da2a0f05528", "formName": "feedback", "…": "…" },
  "attempt": 1
}
```

`subjects` holds what the event is about, the values filters match on. `data` holds the facts of
the type. `attempt` counts from 1. The request carries the three
[Standard Webhooks](https://www.standardwebhooks.com/) headers, `webhook-id`, `webhook-timestamp`
and `webhook-signature`, and a `user-agent` of `slideless-webhooks/<version>`.

**Answer with a 2xx, quickly.** A delivery succeeds when the receiver answers 200 to 299 within ten
seconds. Anything else is a failure: another status, a timeout, a refused connection, and a
redirect too, since a redirect is never followed. Do the work after answering, not before.

## At least once

A delivery can arrive more than once: a receiver that took an event but answered too late gets it
again. **Deduplicate on the envelope's `id`** (the `webhook-id` header, the same value). It is the
same on every attempt and on a manual redelivery, and different for every event. Deliveries are not
ordered either: when order matters, compare `occurredAt`.

## Retries, the hold, and switching off

A failed delivery is tried again ten times, the first after thirty seconds and each wait double the
previous one: about eight and a half hours in all. Then the delivery is **held**: it is marked
`held` and tried again an hour later with the same budget, and so on, until the receiver takes it
or the endpoint is switched off.

An endpoint whose deliveries keep failing is **switched off**: after 20 failures in a row, once the
first of them is at least two days old. Slideless then mails the person who created the endpoint,
once, with a link to it. The deliveries it missed stay in its log. When the receiver works again,
switch the endpoint back on (that resets the count) and redeliver what you need.

## Testing, the delivery log, redelivery

- **Send a test** (`slideless webhooks test`, `slideless_test_webhook`) sends a signed
  `webhook.ping` right away, once, and shows how it went: `delivered`, or `failed` with the status
  code or the error. A test is never retried.
- **Deliveries** lists every delivery of an endpoint, newest first, with its status (`pending`,
  `delivered`, `failed`, `held`), its attempt count, the last status code and error, the next try,
  and the payload exactly as sent. The log is kept 30 days by default; a self-hosted operator sets
  the length with `WEBHOOK_DELIVERY_RETENTION_DAYS`.
- **Redeliver** sends one delivery's event again, as a new delivery with the same `id` and the same
  payload, so a receiver that deduplicates takes it once.
- **Rotate secret** makes a new secret and shows it once. For 24 hours, every delivery carries two
  signatures, one per secret, so you can update the receiver without missing a delivery.

## Where a webhook can point

The URL is `https://` (or `http://` on a self-hosted instance; the cloud accepts `https://` only),
on the scheme's default port, without a user name or password in it. Its host must resolve to
public internet addresses only: every address the name resolves to is checked at each delivery,
and a webhook never reaches the instance's own network (localhost, private ranges, link-local
addresses, the cloud metadata address). A refused URL answers `url_refused` with the reason.

**Self-hosting next to your tools.** An operator who wants a webhook to reach a service on the same
network, an n8n on the LAN for example, sets `WEBHOOKS_ALLOW_PRIVATE_NETWORKS=true`. Private,
loopback and link-local addresses are then accepted, on any port (`http://n8n.lan:5678/webhook/…`).
The variable is refused on the cloud edition. See the
[environment reference](../reference/env-reference.md).

## Limits

| Edition     | Endpoints per workspace |
| ----------- | ----------------------- |
| Cloud, free | 5                       |
| Cloud, pro  | 25                      |
| Self-hosted | Unlimited               |

On the cloud, creating an endpoint beyond the plan's number answers `plan_required` with the link to
upgrade. Deliveries are not counted.

## Receiving them in n8n

1. A **Webhook** node (method `POST`, **Raw Body** on): register its production URL as the endpoint.
2. A **Code** node that checks the signature against the raw body with the endpoint's secret (the
   snippet of [Webhook signatures](../security/webhook-signatures.md)) and stops the run when it fails.
3. A **Switch** node on the envelope's `type`, one branch per event type you subscribed to.

For a self-hosted Slideless reaching an n8n on the same network, see
`WEBHOOKS_ALLOW_PRIVATE_NETWORKS` above.
