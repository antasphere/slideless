# Webhook signatures

Every [webhook](../concepts/webhooks.md) delivery is signed with the endpoint's secret, following
the [Standard Webhooks](https://www.standardwebhooks.com/) specification (its symmetric `v1`
scheme). A receiver that checks the signature knows the request came from your instance, that the
body was not changed on the way, and that it is recent. Anyone can send a `POST` to a public URL:
check every delivery before acting on it.

Any Standard Webhooks library verifies Slideless deliveries as they are. The two snippets below do
it without one.

## The headers

| Header              | What it holds                                                                           |
| ------------------- | --------------------------------------------------------------------------------------- |
| `webhook-id`        | The event id, the same as the envelope's `id` (the same on every attempt: dedupe on it) |
| `webhook-timestamp` | When this attempt was signed, in whole unix seconds                                     |
| `webhook-signature` | One or more `v1,<signature>` entries, separated by a space                              |

## What is signed

1. The secret is `whsec_` followed by standard base64. The HMAC key is the **decoded bytes** of the
   part after `whsec_`, not the text of the secret.
2. The signed content is the id, the timestamp and the body joined by dots:
   `${webhook-id}.${webhook-timestamp}.${body}`, with the timestamp exactly as the header spells it
   and the body exactly as received, byte for byte.
3. The signature is HMAC-SHA256 of that content, encoded in standard base64 (with `+`, `/` and `=`
   padding), and written as `v1,<signature>`.

## How to check it

- **Check before you parse.** Compute the signature over the raw body as it arrived. A body parsed
  and serialized again (by a framework's JSON middleware, say) is not the same bytes, and the check
  fails.
- **Accept any entry.** `webhook-signature` may hold several `v1,` entries. After a secret rotation,
  for 24 hours, each delivery carries two signatures, one with the new secret and one with the
  previous one, so the receiver verifies whichever secret it holds. The delivery is genuine when
  any `v1` entry matches; ignore entries with another version.
- **Check the time.** Refuse a timestamp more than five minutes away from your clock, in either
  direction. Together with deduplicating on `webhook-id`, that refuses a delivery someone recorded
  and sends again later.
- **Compare in constant time.** Compare the expected signature with each entry using a
  constant-time comparison, never `===` or `==`, so the time a comparison takes says nothing about
  how much of a guess was right.
- **Answer 2xx only after the check.** Answer a failed check with a 4xx and do nothing else. The
  instance treats it as a failed delivery and retries it, so a receiver configured with the wrong
  secret shows up in the endpoint's delivery log.

## Node (WebCrypto, no dependency)

Node 20 or later; the same code runs on Deno, Bun and Cloudflare Workers.

```js
const encoder = new TextEncoder();

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

/** Constant-time for strings of the same length (a signature's length is no secret). */
function equalsConstantTime(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * secret: the endpoint's `whsec_…` secret.
 * headers: an object with lowercase header names.
 * rawBody: the request body exactly as received, as a string (UTF-8).
 */
export async function verifyWebhook(secret, headers, rawBody, toleranceSeconds = 300) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (!id || !timestamp || !signatures) return false;
  if (!/^\d{1,15}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  if (!secret.startsWith('whsec_')) throw new Error('a webhook secret starts with whsec_');
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secret.slice('whsec_'.length)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${rawBody}`));
  const expected = bytesToBase64(mac);

  let verified = false;
  for (const entry of signatures.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1 || entry.slice(0, comma) !== 'v1') continue;
    // Every entry is compared, so the timing does not tell which one matched.
    if (equalsConstantTime(entry.slice(comma + 1), expected)) verified = true;
  }
  return verified;
}
```

With Express, take the body as text on that route so it reaches you unparsed:

```js
import express from 'express';

const app = express();
app.post('/slideless', express.text({ type: 'application/json' }), async (req, res) => {
  if (!(await verifyWebhook(process.env.SLIDELESS_WEBHOOK_SECRET, req.headers, req.body))) {
    return res.status(400).end();
  }
  const event = JSON.parse(req.body);
  res.status(204).end(); // answer first, then do the work
  // if (seen(event.id)) return; … switch (event.type) { … }
});
```

## Python (standard library)

```python
import base64
import hashlib
import hmac
import time


def verify_webhook(secret: str, headers, body: bytes, tolerance: int = 300) -> bool:
    """headers: a mapping with lowercase names; body: the raw request bytes."""
    msg_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    signatures = headers.get("webhook-signature")
    if not msg_id or not timestamp or not signatures:
        return False
    if not (timestamp.isascii() and timestamp.isdigit() and len(timestamp) <= 15):
        return False
    if abs(time.time() - int(timestamp)) > tolerance:
        return False

    if not secret.startswith("whsec_"):
        raise ValueError("a webhook secret starts with whsec_")
    key = base64.b64decode(secret[len("whsec_"):])
    signed = f"{msg_id}.{timestamp}.".encode() + body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest())

    verified = False
    for entry in signatures.split(" "):
        version, _, signature = entry.partition(",")
        # Every entry is compared, so the timing does not tell which one matched.
        if version == "v1" and hmac.compare_digest(signature.encode(), expected):
            verified = True
    return verified
```

In Flask, `request.get_data()` gives the raw bytes; in Django, `request.body`; in FastAPI,
`await request.body()`. Parse the JSON only once `verify_webhook` answered `True`.

## Keeping the secret

- The secret is shown once, when the endpoint is created and at each rotation. Store it where the
  receiver reads its other secrets, never in the workflow's code or in a repository.
- If it leaks, rotate it (**Rotate secret** in the dashboard, `slideless webhooks rotate-secret`,
  or `slideless_rotate_webhook_secret`). The previous secret keeps signing for 24 hours
  (`previousSecretExpiresAt` on the endpoint), so update the receiver within that window. To cut
  the previous secret at once, delete the endpoint and create a new one.
- The instance stores the secret encrypted and never writes it to the audit log.
