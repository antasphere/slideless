# ADR 022 — Deck-embedded forms

- **Status**: accepted, 2026-07-25
- **Context**: the forms feature: share-link viewers submit forms the deck
  author wrote into the deck HTML, in direct links and inside the ADR 021
  official embeds; owners collect the responses per form, per link, per
  source, and per placement (CLI, MCP, API, dashboard). The design leans on
  three earlier decisions and extends each one level: the annotations
  token-session surface (Phase 5), the share-token secret model (hash plus
  pepper, shown once), and the ADR 020/021 injection and framing seams.

## Decisions

### 1. The deck HTML is the form; the server never parses deck HTML

The authoring contract is one attribute: `<form data-slideless-form="name">`
with standard inputs. The name is gated to the owner-slug charset
(`[A-Za-z0-9._-]{1,64}`, the placement charset) because it renders in owner
tooling; everything else about the form is the author's markup, untouched.
There is no server-side HTML scanning and no manifest declaration: the forms
runtime (viewer/forms-runtime.ts) is injected whenever the token allows
submitting and simply no-ops when the document carries no marked form. The
runtime must intercept `submit` because a native submit inside the sandboxed
opaque origin would garbage-navigate the document. Sub-pages of multi-page
decks come for free: the ADR 020 seam already transforms every same-deck
HTML navigation. Version integrity mirrors annotations: the runtime echoes
the version it was served with, and the server accepts a pinned token's pin
only, or at most the resolved version on a latest-mode token
(`invalid_version` otherwise).

### 2. The payload is opaque jsonb (the annotations.selection precedent)

A response payload is the serialized FormData: a flat
`Record<string, string | string[]>` (repeated names become arrays). The
server enforces shape and size only, never meaning: at most 128 fields,
128-char keys (contract caps), 32 KiB serialized
(`MAX_FORM_PAYLOAD_JSON_BYTES`, checked in-handler like
`MAX_SELECTION_JSON_BYTES`). Validating field semantics server-side would
freeze deck authoring for zero authz value, exactly the ADR 020 §1
argument. Respondent identity as data is an authorial choice (add inputs);
the server never infers it from the payload. Rows are stored raw and
escaped wherever they render (never `{@html}`), and the dashboard's CSV
export routes every cell through the formula-injection guard: a response is
hostile input aimed at deck owners until proven otherwise.

### 3. The edit secret is the share-token capability pattern, one level down

Each response mints a 48-byte base64url edit secret, returned exactly once
at create and stored only as `sha256(secret + pepper)` through the injected
`PepperRegistry` (unique hash index; resolution probes every registered
pepper version and fails closed on a dropped one). Holding the secret is
holding the capability: read and update exactly that one row, nothing else.
It travels in the URL fragment (`#slr=`), never in a path or query, so it
stays out of server logs and referrers, and reaches the API in the
`x-slideless-response` header. The viewer API binds it to the presenting
token session: a secret whose row belongs to another deck or another link
answers the same 404 as a missing one and burns the submit bucket, so the
endpoint is no better an oracle than an invalid share secret. A row is one
respondent's evolving answer: update replaces the payload in place.

### 4. Three respondent legs; leg 3 stops at the document boundary

The deck runs in an opaque origin with no cookies and no storage (ADR 012),
so "my response" must come from outside the sandbox. All three legs ship:

1. **The edit link** on the confirmation card (the current page URL plus
   the fragment secret).
2. **Email-me-my-link**, an explicit opt-in field on the card. The address
   is typed in the moment; it is deliberately never auto-detected from the
   payload (the payload stays meaning-free, decision 2). Hidden when the
   mail driver does not deliver; the endpoint answers `email_unavailable`.
3. **Signed-in auto-identity.** When the serving request carries a live
   first-party session, the server injects a signed respondent assertion
   (viewer/respondent.ts on the signed-value envelope, its own
   `viewer-respondent` MAC label, token-scoped, 1-hour TTL). The runtime
   echoes it on submit; verification is the ONLY writer of
   `respondent_user_id`, and the edit link is auto-mailed to the account
   address. A stale or forged assertion degrades the submit to anonymous
   rather than failing it: identity is courtesy, never a gate.

Leg 3 fires on top-level DOCUMENT navigations only. An embed's iframe
navigation is cross-site, so the `SameSite=Lax` session cookie is never
sent and the server could not see the session anyway (the same weakness
ADR 021 accepts for view dedupe); skipping the lookup on frames also means
no session read is ever attempted where it could only mis-assert. The
session read itself follows the break-glass discipline: a cheap cookie-name
pre-filter, then `auth.api.getSession` against the session store, never a
trusted claim. Anonymous viewers cost zero extra lookups.

### 5. Per-runtime injection gates: overlay document-only, forms document plus frame

`inject.ts` now decides per runtime instead of per request. The annotation
overlay keeps its ADR 020 gate: document navigations only, with the
`self !== top` refusal as belt-and-braces ("annotations never render in a
frame" stays policy). The forms runtime injects on document navigations AND
same-deck HTML frame navigations (`Sec-Fetch-Dest: iframe`/`frame`),
because official embeds are iframes and an embedded form must submit;
without the runtime the sandboxed native submit garbage-navigates. This is
safe by the ADR 021 §1 rationale: the sandbox regime holds identically in a
frame, the runtime runs in the same opaque origin, and its wildcard-CORS,
`credentials: 'omit'` calls work identically. The forms runtime accordingly
has NO top-context refusal, on purpose. Unchanged everywhere: `?raw` stays
byte-exact, agent-style `x-viewer-password` fetches and non-HTML responses
never see a runtime, `embed`/`object` destinations stay untouched.

### 6. `can_submit_forms` defaults ON (annotations' opt-in, inverted)

A form is the deck's own intended interaction, placed there by the author;
the annotation layer is added OVER a deck by the sharer. So annotations opt
in per link while forms opt out per link (`--no-forms` at share time,
`canSubmitForms` on PATCH): `push` then `share` yields a working form with
zero flags, which is the feature's north star. With the flag off the
runtime is not injected (UX) and the API refuses with 403 `forms_disabled`
(enforcement; injection absence is never the security boundary). Preview
tokens are minted with `canSubmitForms=false` server-side: owner previews
must never create respondent rows, matching their view-stat exclusion.

### 7. Attribution is source plus placement: sanitize-then-store, never authz

Every response carries `source` (`link` | `embed`) and `placement`. Source
is stamped from the injection context (frame navigation → `embed`), echoed
by the runtime, and enum-validated at the API. Placement is the serving
navigation's `?p=` label, sanitized server-side with the view-events
sanitizer (`[A-Za-z0-9._-]{1,64}`, else null), injected into the runtime
config, echoed, and re-sanitized at write. Both are attribution-grade by
declaration: deck JS shares the document with the runtime and could POST
anything the runtime can (the runtime adds no capability the deck lacked),
so these columns inform dashboards and slicing, never authorization.
`share_token_id` is set-null so responses survive link deletion; the token
name is joined at read time for display. The owner surface reuses the
annotations authz shape: responses address the deck's writers via
`canWrite`, the list and summary contracts declare no 403 so non-writers
get the same 404 an outsider would, and only delete distinguishes
`forbidden`.

### 8. Abuse posture: buckets and caps; viewer writes unaudited

- `viewerFormSubmit`: 30 per 10 minutes per `${ip}:${tokenId}`, shared by
  create and update. Unknown share secrets burn the per-IP invalid-secret
  point (the token-session resolver), and failed edit-secret lookups burn
  this same bucket, so probing secrets is never cheaper than submitting.
- `viewerFormEmail`: 5 per 15 minutes per `${ip}:${tokenId}` AND per target
  address (the emailKeyOf posture): a public endpoint that sends mail is a
  spam vector twice over.
- Payload caps per decision 2; a hard ceiling of 10,000 responses per deck
  (403 `responses_full`, indexed COUNT at submit) backstops everything.
- Viewer-side writes are NOT audited, a documented non-goal shared with
  annotations: the audit log records principal actions, and an anonymous
  respondent is not a principal. Owner deletes ARE audited
  (`presentation.form_response_delete` via the `c.set('audit', …)`
  convention; the global middleware writes the row).

## Consequences

- Embedded decks are no longer view-only: ADR 021's "embeds are view-only
  by construction" consequence narrows to the annotation overlay. Forms
  are deliberately live in frames; everything else ADR 021 records
  (frame-blocked gate shells, sandbox set, placement-as-attribution) holds
  unchanged, and password-protected links stay moot in embeds, forms
  included.
- The emailed edit link lands on the deck's ENTRY page (`buildViewerUrl`),
  even when the form lives on a sub-page; only the confirmation card's own
  link carries the current page URL. Accepted for v1: the runtime keeps an
  unmatched fragment secret in memory, so navigating to the page that does
  hold the form still prefills and updates.
- Edits have no history: update replaces the payload and bumps
  `updated_at`, so a disputed response shows only its latest state. Owner
  delete is the only moderation tool.
- One response per person is unenforceable beyond the edit secret: a
  respondent who discards their fragment and submits again creates a new
  row. The per-deck cap and the buckets bound the damage; real dedupe, if
  an author needs it, lives in the payload they asked for.
- Hub-signed-in users without a local tool session are not silently
  detected (popup/redirect identity stays deferred); legs 1 and 2 cover
  them.
- Regression surface: `apps/server/test/integration/forms.test.ts`
  (token-session mapping, caps, capability off, version validation,
  edit-secret read/update/foreign-secret, email leg, assertion
  verify/forge, source/placement sanitization, per-deck cap) and
  `apps/dashboard/e2e/viewer-forms.spec.ts` plus a second-origin embed
  submit spec on the `embed.spec.ts` template.
