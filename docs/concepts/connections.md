# Connections

A connection is a source your workspace is linked to: a service that posts signed deliveries to
Slideless when something happens on its side, or a service Slideless reads with a key you hold. Which
sources exist is decided by the tool (its code declares them); what you do with each one is the same
everywhere: Settings › Connections shows one card per source, and the `connections` commands of the CLI
and the connection tools of the MCP endpoint drive the same cards.

Slideless declares no source today: Settings › Connections and `slideless connections list` show an
empty list; the door and the connection MCP tools appear with the first source the tool declares, and the
deliveries log lists the deliveries of its inbound sources.

## Two kinds of source

- **An inbound source** posts to a receiving URL Slideless makes for your workspace. The URL carries a
  random token, shown once when it is made (or rotated) and never again: only its fingerprint is kept.
  The source signs every delivery with a secret it shows you once; you paste that secret into the
  card, and Slideless checks every delivery against it before anything is written. The card shows the
  last delivery (its type, when, and whether it was processed), and the log below the cards lists
  them all.
- **A key source** is a service Slideless reads on your behalf (a mailing tool, a notes tool): you
  paste the key the service gave you, Slideless probes the service with it before storing it, and the
  card says what the probe answered. The test button probes again with the stored key.

A source may be both: it posts to Slideless and Slideless reads it.

## What a card shows and never shows

A card shows who connected the source and when, whether the secret or the key is set and still
readable, the fields the source declares (a folder, the inboxes to read), the last delivery and the
last test. It never shows the secret, the key or the receiving URL: the secret is stored sealed under
the instance's own key, never answered, logged, audited or exported; the URL's token is kept as a
fingerprint. A secret the instance can no longer open (its auth secret changed) reads **unreadable**:
set it again.

## Who may do what

Every member of the workspace reads the cards. Making or rotating a receiving URL, setting a secret
or a key, editing the fields, testing and disconnecting are an owner's or an admin's acts, from a
browser session or through an API key carrying the `webhooks:manage` scope (the same scope as
webhooks: a connection is a credential of the workspace). A session opened by a demo link reads the
cards and changes nothing.

## The door

An inbound source posts to `https://<your instance>/hooks/<source>/<token>`, outside the API. The
door accepts a delivery only when its signature verifies on the body as received, within five minutes
of the sender's clock; a refused signature answers 401 and writes nothing, an unknown token 404. A
delivery already taken (the sender's own id, per workspace and source) answers 200 and runs nothing
again, so a sender's retry is harmless; a delivery whose handling failed is logged as failed and runs
again when the sender retries. The body is capped at 256 KiB. The door has its own rate limit per
address.

Which signature scheme a source uses is declared by the tool: the Standard Webhooks scheme (what
Slideless's own [webhooks](webhooks.md) send, so two tools of the same family connect to each other),
or Stripe's.

## A sibling tool

A sibling is another tool of the same Antasphere hub (Meet, for one), and its card carries **Connect
as me**: Slideless, acting as you, registers its receiving URL on the sibling, in the workspace of the
same organization, and stores the signing secret the sibling answers, so you copy nothing and the card
reads **Registered on** the sibling. Running it again replaces the endpoint, the URL and the secret
together. Disconnecting deletes the endpoint on the sibling first, then the connection here; when the
sibling cannot be reached, **Only here** drops the connection on this side alone. A refusal says what
to do: sign in again when your sign-in predates the permission to connect, or open the sibling once so
it knows you, then retry. The URL and the secret by hand stay under the button, for a stack where the
hub does not grant that permission.

## Disconnecting

Disconnecting a source deletes its secret, its receiving URL and its delivery log for the workspace.
The source stays on the page, disconnected, ready to be connected again.

## From the terminal

```
slideless connections list
slideless connections connect <sibling>       # a sibling tool: connected as you, nothing to copy
slideless connections connect stripe          # prints the receiving URL once
slideless connections secret stripe --stdin   # the secret from stdin, never an argument
slideless connections test <source>
slideless connections deliveries <source> --all
slideless connections disconnect <sibling> --yes   # the endpoint on the sibling too; --local for this side only
```

The secret is read from standard input or a file, never from an argument: an argument is visible to
every process on the machine and lands in the shell history.
