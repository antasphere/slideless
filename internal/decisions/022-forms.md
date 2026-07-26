# ADR 022 — Deck-embedded forms

- **Status**: accepted, 2026-07-25; **amended 2026-07-26** after the
  seven-agent audit (`slideless-os` spec `2026-07-25-forms-audit-remediation`).
  Decision 4's leg 3 is **withdrawn** (PRDCT-1331), decision 5's fragment
  claim is **corrected** (PRDCT-1332), and decision 1's "never scans deck
  HTML" is **narrowed** (PRDCT-1333). Amendments are marked inline; the
  original wording is quoted where it was the thing that failed, because
  reviewers wave through sentences, not diffs.
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
There is no manifest declaration. **Amended (PRDCT-1333):** the original
text also said there is "no server-side HTML scanning" and that the runtime
"is injected whenever the token allows submitting". Since `can_submit_forms`
defaults ON (decision 6), that made every share link of every deck leave the
streaming serve path for a buffering one — measured at roughly ten times the
document in peak RSS on an anonymous GET of a route with no rate limiter,
for decks containing no form at all. So the commit path now records whether
a version holds a marked form (`presentation_versions.has_forms`, a byte
scan for the marker attribute in `forms/detect.ts`, stamped exactly like
`has_agent_doc`) and the runtime is injected only when the token allows
submitting AND the version actually carries a form. This is a substring
question, not parsing: a false negative costs the author their form and a
false positive costs one inert script tag, and neither is an authorization
decision — the API still enforces the capability on every submit. Injection
absence remains a UX fact, never a security boundary (decision 6). The
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

### 4. Two respondent legs; a response is anonymous by construction

The deck runs in an opaque origin with no cookies and no storage (ADR 012),
so "my response" must come from outside the sandbox. Two legs ship:

1. **The edit link** on the confirmation card (the current page URL plus
   the fragment secret).
2. **Email-me-my-link**, an explicit opt-in field on the card. The address
   is typed in the moment; it is deliberately never auto-detected from the
   payload (the payload stays meaning-free, decision 2). Hidden when the
   mail driver does not deliver; the endpoint answers `email_unavailable`.

A response carries **no respondent identity at all**. If the author wants
to know who answered, they ask in the form.

#### Leg 3 is WITHDRAWN (PRDCT-1331) — do not rebuild it in this shape

The original decision 4 shipped a third leg: "when the serving request
carries a live first-party session, the server injects a signed respondent
assertion … verification is the ONLY writer of `respondent_user_id`, and
the edit link is auto-mailed to the account address … identity is courtesy,
never a gate."

That is architecturally unsound and was **not patchable in place**.
Anything handed to the deck document is readable by the deck's own
JavaScript (the ADR 012 trust model), and the assertion was written into
the injected config *before* the runtime's "no forms here" early return, so
it was present even in decks holding no form. Proven end to end,
cross-workspace: a victim in another workspace opens the share link while
signed in, deck JS lifts the assertion out of `script[data-slideless-forms]`
and files a cookie-less POST from an unrelated IP, and the deck owner's
list shows that person's address, internal user id and arbitrary payload
content attributed to them — with no interaction beyond loading the page,
and no audit trail to contradict it (viewer writes are unaudited by
decision 8). Deriving the identity server-side at submit time instead is
impossible: the submit is a `credentials: 'omit'` fetch from an opaque
origin and structurally cannot carry the session cookie, which is exactly
why the assertion existed.

Removing it also removed four dependent defects: an auto-mail that never
consulted the email limiter (12 replayed submits, 12 mails to a stranger's
real address from the instance's trusted sender); an unhandled FK violation
turning a since-deleted user's assertion into a 500 with the response lost,
contradicting this decision's own "never a gate"; a bearer identity token
that kept working for its full hour after sign-out or an admin killing the
session; and `respondentEmail` on the owner wire, readable by any
`presentations:read` machine key — the exfiltration shape `/workspace/export`
has its own `data:export` scope to avoid. Leg 3 was also already dead on the
documented hardening path (`VIEWER_BASE_URL` set = no app cookies on the
viewer origin) while the docs promised it unconditionally, so it created
product pressure against ADR 012's own recommended deployment.

`respondent_user_id` remains on `form_responses`, unwritten and unread, so
the removal stays additive; dropping the column is a follow-up. **Nothing
may re-wire it.** If account-linked responses are wanted, the safe shape is
an explicit claim on the APP origin — the respondent clicks through and
confirms — which is a different feature, not a value injected into a
sandboxed document.

### 5. Per-runtime injection gates: overlay document-only, forms document plus frame

`inject.ts` now decides per runtime instead of per request. The annotation
overlay keeps its ADR 020 gate: document navigations only, with the
`self !== top` refusal as belt-and-braces ("annotations never render in a
frame" stays policy). The forms runtime injects on document navigations AND
same-deck HTML frame navigations (`Sec-Fetch-Dest: iframe`/`frame`),
because official embeds are iframes and an embedded form must submit;
without the runtime the sandboxed native submit garbage-navigates. The
*sandbox* regime holds identically in a frame by the ADR 021 §1 rationale:
same opaque origin, same wildcard-CORS `credentials: 'omit'` calls. The
forms runtime accordingly has NO top-context refusal, on purpose.

**Corrected (PRDCT-1332):** the original text read "this is safe by the ADR
021 §1 rationale" without qualification. That was wrong. ADR 021 §1 argues
about the sandbox, and says nothing about **the framer controlling the URL
fragment**. A framer (or any link author) could mount
`.../v/{secret}/#slr=<the secret of a response they submitted themselves>`;
the runtime adopted the fragment unconditionally, switched that form into
update mode, and the victim's answers overwrote the framer's row, which the
framer then read back through `GET …/responses/me`. An empty planted
payload made the prefill invisible, and the only tell was the card saying
"updated" instead of the author's success message. Proven twice, including
through the official `/embed.js` loader. Two defences, both required:
`viewer/embed.ts` strips the fragment (`url.hash = ''`) before assigning
`frame.src` — it validates `url.pathname` and used to forward `url.href`
whole — and the runtime never silently adopts a fragment: on arrival with a
valid `#slr=` it shows an explicit prompt naming the response's date and
**defaults to create**. Leg 1 still works; the hijack is now visible and
consented. Related: an edited row used to keep the *creator's*
`source`/`placement`/`version`, so attribution on every edit was silently
wrong; the update path re-stamps all three from the navigation that made
the edit.

Unchanged everywhere: `?raw` stays
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
anything the runtime can, so these columns inform dashboards and slicing,
never authorization.

**The parenthetical that used to sit here — "the runtime adds no capability
the deck lacked" — is now an enforced INVARIANT rather than a description,
and it is stated once, here, in its testable form (PRDCT-1331):**

> Every value the server places in the deck document must be one the deck
> could already obtain by itself.

Two values qualify and are injected: the share-token secret (already in
`location.pathname`) and the unlock proof (password links, scoped to viewer
calls on that same token). The rest of the config — version, source,
placement, `emailAvailable` — is server *context*, not capability, and the
server re-derives or re-validates each of them at write.

That sentence was true for those values and **false for leg 3's identity
assertion**, and it is what let leg 3 through review: a reviewer checking
the claim against the share secret and the unlock proof finds it holds and
stops reading. So the test is mechanical, not editorial: the injected
config's key set is pinned by an integration assertion, and adding a key
turns that test red. If a new value cannot be justified against the
invariant above, it does not go in the document — it goes on the app
origin, behind a click.
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
- No respondent is ever identified automatically, signed in or not. Legs 1
  and 2 are the whole story; an author who needs a name asks for one.
- The own-row routes carry the form name
  (`/viewer/{secret}/forms/{form}/responses/me`) and the server 404s a
  secret whose row belongs to another form (PRDCT-1334). The runtime keeps
  its edit secret per form (`form.__slSecret`); the route segment is the
  half that holds even when the client is wrong, and before it existed the
  server structurally could not detect the mismatch.
- The runtime shields each marked form's subtree, not just its confirmation
  card, stopping click/pointer/touch/wheel/key events at the form root
  (bubble phase, deliberately: a capture-phase shield at the form root
  would also skip the AUTHOR's own listeners inside it). Real decks bind
  document-level navigation and five of five broke without this. A deck
  binding `capture: true` on `document` still wins — the same residual the
  annotation overlay card has always had.
- Regression surface: `apps/server/test/integration/forms.test.ts`
  (token-session mapping, caps, capability off, version validation,
  edit-secret read/update/foreign-secret and the cross-FORM refusal, email
  leg, anonymity under assertion-shaped input, source/placement
  sanitization and re-stamping, `has_forms` stamping and the form-less
  streaming path, per-deck cap),
  `apps/server/test/unit/inject-stream.test.ts` (byte fidelity and bounded
  memory of the streaming injector), and the Playwright suites:
  `viewer-forms.spec.ts`, the second-origin `embed-forms.spec.ts` (which
  also pins the fragment strip), and **`viewer-forms-realdeck.spec.ts`,
  the habitat suite** — fixtures whose navigation engines are lifted
  verbatim from `workspace/content/presentations/`. The original suite
  drove a bare `<form>` on an empty page and was 7/7 green while the
  feature was broken in every real deck; a bare-form-only forms suite is
  the specific mistake not to repeat.
