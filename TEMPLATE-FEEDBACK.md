# Template feedback — the consolidated backlog

Discoveries, friction, and improvement ideas that concern the upstream
**codika-platform-template**, found while building Slideless on top of it
(template @ `b0dcd13`). We do NOT change the template from here — this file
is the backlog for future template improvements.

Consolidated 2026-07-10 from the dated append-log of all nine build phases,
the adversarial reviews, and the release-gate campaign. Every distinct
discovery is preserved; duplicates are merged (each entry names the phase(s)
that hit it). Format per item: **problem — where it bit us — suggested
upstream fix.** New findings: append to the matching theme.

Two sections at the end are deliberately separate: [confirmed-good template
properties](#confirmed-good-template-properties-keep-these) (do not
"improve" these away) and [open policy decisions for the product
owner](#open-policy-decisions-for-the-product-owner) (Romain's calls, not
template bugs).

---

## 1. Instantiation & identity

1. **The instantiation checklist misses several product-name strings.** A
   post-checklist sweep still found `platform` as: the commander program
   name/description (`packages/cli/src/index.ts` — what `--help` prints),
   the MCP server identity (`apps/server/src/mcp/server.ts`, shows up in MCP
   handshakes), the OTel `service.name` + tracer name
   (`observability/otel.ts`), the API fallback page (`app.ts`), the
   installer default dir `/opt/platform` (+ docs mentions), the
   backup/restore/scale scripts' hardcoded `psql -U platform -d platform`,
   and cosmetic test labels. (Phase 0.) Fix: extend the checklist, or better
   hoist a single `PRODUCT_NAME` identity module the whole codebase reads.
2. **Pre-setup branding is hardcoded `'Platform'`** in `boot.ts`
   (`cachedName` fallback), `api/index.ts` (`/instance` discovery fallback),
   and `email/templates.ts` (`PRODUCT_NAME`, user-visible in every delivered
   email); none are in the checklist and the "instance name needs no code
   change" claim is only true post-wizard. (Phase 0.) Fix: fold into the
   identity module above.
3. **The API-key-prefix rename is NOT a one-line change.** Four test sites
   hardcode `key_`: the mint-format regex + tampered-key builder in
   `platform-core.test.ts` (7 red tests on first run), the secret slicer in
   `apikey-pepper-rotation.test.ts` (passes only while prefix length
   matches), and the e2e regex in `dashboard/e2e/smoke.spec.ts`. (Phase 0.)
   Fix: derive them from `API_KEY_PREFIX`, or list all four in the checklist.
4. **The checklist doesn't say what to do with `docs/instantiation.md`
   itself** — its verify-grep expects zero `@platform` hits but the
   checklist file contains them. We deleted it (and its index/README
   mentions). (Phase 0.) Fix: the checklist should state that step.
5. **`.changeset/config.json` pins `baseBranch: "main"`** while instantiated
   products default to `prod`. (Phase 0.) Fix: mention in the repo-setup
   section.
6. **Template-branded class names survive instantiation by design**
   (`PlatformClient`, `PlatformApiError`, `PlatformRegistry`,
   `src/platform/`, `nav.platform`) but nothing says so — instantiators
   chase them. (Phase 0.) Fix: one checklist line declaring them internal
   API, deliberately kept.
7. **`docs/env-reference.md` is generated, but the checklist has you sed
   it.** The EMAIL_FROM example lives in a zod doc-comment in `env.ts` AND
   in the generated doc. (Phase 0.) Fix: instruct "edit `env.ts`, then
   `pnpm --filter <server> docs:env`".
8. **`setup.sh` cannot boot a fresh instantiation**: `docker compose up -d
--pull always` tries to pull an image that does not exist until the first
   release; first boot needs a local build + `APP_IMAGE` override. (Phase 0.)
   Fix: fall back to `--build` when the pull fails, or call it out in the
   checklist.
9. **No dev mail-catcher out of the box.** `EMAIL_DRIVER=none` is the right
   prod default, but every product wants the real SMTP path in dev/E2E.
   Slideless added a `docker-compose.dev.yml` Mailpit overlay +
   `docs/dev-mailpit.md`. (Phase 0.) Fix: upstream the overlay.

## 2. Auth chassis: OTP, key minting, account entrances

10. **The template has no browserless "OTP → API key" flow** — keys only
    mint from a dashboard session, so every CLI/agent bootstrap needs a
    browser. Slideless added `POST /cli/auth/{request,complete}` (public
    pre-auth routes riding the emailOTP plugin's `disableSignUp`, minting a
    scoped key from the verified sign-in, deleting the throwaway session).
    (Phase 6.) Fix: upstream as an optional surface next to `/setup` — the
    pattern is fully generic.
11. **Duplicate-email `signUpEmail` races are a template-wide pattern.**
    Every public account-minting endpoint needs the loser's unique-violation
    mapped to a clean `409 account_exists` (password hashing is tens of ms,
    the lookup ~1 ms, so the window is real); Slideless fixed its
    collaborator claim, but the template's `api/invitations.ts` accept has
    the identical uncaught-500 window. (Phase 5 review.) Fix: catch+map in
    the invitation accept, and note the pattern wherever `signUpEmail` is
    called pre-auth.
12. **Orphan account on revoke-during-claim.** Claim/accept endpoints create
    the account via `auth.api.signUpEmail` BEFORE the guarded token redeem;
    a revoke landing in between leaves a real account + membership with no
    active grant (claim answers 410, account stays) — same shape as setup's
    documented orphaned-user trade-off. The template's invitation-accept
    shares the window. (Phase 5 review, finding 6.) Fix: needs an
    account-creation/claim transaction seam the identity layer does not
    expose today; at minimum document the window.
13. **`/setup`'s `signUpEmail` auto-creates an owner session (autoSignIn
    default) that nothing ever holds.** Harmless but invisible — it
    surprises any test asserting "no sessions for this user". (Phase 6.)
    Fix: pass the option to skip auto sign-in at setup, or document it.
14. **`user.created` is emitted from exactly one call site** (invitation
    accept), so products subscribing for claim-at-signup semantics must know
    setup and other entrances do NOT fire it — Slideless's claim endpoint
    emits manually. (Phase 5.) Fix: emit from a single identity-layer hook
    (Better Auth `databaseHooks.user.create.after`) so the event is
    trustworthy by construction.
15. **The config-level 2FA after-hook also fires for server-side
    `auth.api.signInEmailOTP` calls** — verified live (an enrolled user's
    server-side OTP sign-in returns `{ twoFactorRedirect: true }` with no
    session). Good for safety; nobody should assume it is HTTP-only.
    (Phase 6.) Fix: a note on the hook.
16. **"Public API path" means two different things and only one is written
    down.** `isPublicApiPath` skips credential resolution entirely; the
    OTHER tier — routes outside `requireAuth` that still resolve an optional
    session and rely on the fail-closed scope gate (invitation accept,
    collaborator lookup/claim) — exists only as an unwritten convention.
    (Phase 5.) Fix: a doc block over `isPublicApiPath` naming both tiers and
    blessing "not requireAuth + unlisted in scopes.ts" for human
    token-redemption endpoints.

## 3. MCP chassis

17. **The chassis' tool helpers are module-private.** `checkScope` and
    `callApi` live unexported inside `mcp/server.ts`, so the first product
    with a second tool file must refactor before writing a tool. Slideless
    moved them to `mcp/tool-kit.ts` (context type + checkScope + callApi +
    raw-Response variant + pageQuery). (Phase 7.) Fix: ship that split;
    `server.ts` keeps only the example tools.
18. **`callApi` force-parses JSON — binary surfaces need a raw variant.**
    Asset downloads and multipart uploads can't ride a JSON-only helper;
    Slideless added `fetchApiRaw` (auth header attached, non-2xx →
    ApiToolError, Response returned). (Phase 7.) Fix: upstream next to
    callApi.
19. **The `/mcp` bodyLimit answers plain HTTP 413, not a JSON-RPC error**, so
    a tool-level size cap must sit BELOW the transport cap to ever produce a
    model-readable error (Slideless caps inline uploads at 768 KiB decoded —
    the base64-inflation bound of a 1 MiB envelope — and the error names the
    CLI). (Phase 7.) Fix: document the relationship in the chassis.
20. **Stateless `/mcp` accepts `tools/call` without `initialize`** — each
    request builds a fresh McpServer and the SDK doesn't enforce the
    handshake, so raw JSON-RPC POSTs via `app.request` are a legitimate,
    fast integration-test harness (no listening server needed). (Phase 7.)
    Fix: a note in the chassis docs next to the SDK-client dance test.

## 4. Security headers, CSP & serving user content

21. **The global `securityHeaders` middleware CLOBBERED per-route CSP and
    `Referrer-Policy`** — it ran after `next()` and unconditionally
    overwrote both on every `text/html` response, silently replacing a
    viewer route's `CSP: sandbox` with the dashboard CSP. The exact
    fail-dangerous class ADR 012 warns about, and nothing fails loudly when
    it bites. (Found by the viewer spike; fixed in Phase 4 with
    `!c.res.headers.has(...)` set-if-absent guards.) Fix: ship the guarded
    form — a baseline header middleware must be a DEFAULT, never an
    override.
22. **`files/http.ts`'s attachment-by-default needs a first-class,
    documented escape hatch** for products that must render user content
    inline. Slideless had to bypass `contentDispositionFor` and hand-roll
    the ADR 012 header set. (Spike + Phase 4.) Fix: a blessed "isolated
    inline" serving helper — inline + `nosniff` + `no-referrer` + a REQUIRED
    `CSP: sandbox …` that refuses to emit without the sandbox directive and
    hard-bans `allow-same-origin` — so the one dangerous exception is
    centralized and test-guarded.
23. **`serveBlob` hardcodes disposition and an `immutable` Cache-Control** —
    both correct for the app-origin files surface, both wrong for a
    sandboxed viewer whose URLs are not content-addressed. Two optional
    fields (`contentDisposition`, `extraHeaders`) made it reusable.
    (Phase 4.) Fix: upstream that shape, documented as "only under an
    isolation regime".
24. **Design rule: never key server behavior on a client-controlled NAME.**
    Slideless' dashboard preview minted share tokens under a reserved name
    and keyed concealment + stat-exclusion on it — any deck writer could
    mint a concealed, stat-silent link (covert access channel; fixed with a
    server-set `purpose` column + a dedicated owner-gated mint endpoint,
    migration 0017). (Release gate.) Fix: if the template ever grows
    "system-minted rows sharing a user table", ship the discriminator as a
    server-set column from day one.

## 5. Contract & API chassis (zod-openapi)

25. **CHASSIS BUG — malformed/empty JSON bodies 500 on every zod-openapi
    body route.** Hono's json validator throws `HTTPException(400)` BEFORE
    zod runs; the chassis `defaultHook` only handles
    `result.success === false`, so the exception falls to `app.onError` →
    500 `internal` + an error-level log — pre-auth reachable (`/setup`,
    `/cli/auth/request`, `/invitations/accept`), a log-noise amplifier any
    anonymous client can drive. (Release gate; fixed here.) Fix — port
    Slideless' exact shape upstream: (1) handle
    `HTTPException && status === 400` FIRST in the top-level `app.onError`
    (`invalid_json` for JSON parse, `invalid_body` for malformed multipart,
    NO error log) — the only workable seam: Hono routes the throw straight
    to the app errorHandler, a try/catch middleware never observes it, and a
    sub-app `onError` is ignored under `app.route()`; (2) mark every
    contract request body `required: true` (a `jsonRequestBody` helper) —
    without it zod-openapi SKIPS body validation when the content-type is
    missing/non-JSON and hands the handler `{}` cast as the body type — a
    guaranteed TypeError → 500. Regression suite:
    `apps/server/test/integration/body-validation.test.ts`.
26. **The SDK route-coverage test hardcodes `{id}` substitution** — the
    first product route with a second path param (`{tokenId}`, `{version}`,
    `{sha256}`) forces editing the test. (Phase 2.) Fix: ship a param-name →
    sample-value map (or substitute any `{param}` with a type-appropriate
    sample) so products only add INVOKERS entries.
27. **No recipe for contract-first phased builds.** Slideless froze 24
    routes ahead of their handlers by declaring a `501` response on each
    contract route and registering stubs that answer it (implementers delete
    the 501 entry with the handler); worked cleanly with typed handlers.
    (Phase 2.) Fix: document as the blessed pattern (`errorResponses` ships
    no 501 and an undeclared status fails typecheck).
28. **No multipart example in the contract layer.** Modeling
    `multipart/form-data` via `content: { 'multipart/form-data': { schema:
z.object({ sha256, file: z.any() }) } }` renders valid OpenAPI 3.1 but
    took a trial run. (Phase 2.) Fix: one template example.
29. **The global 1 MiB JSON `bodyLimit` needs per-surface routing** as soon
    as a product has legitimately-large JSON (contract-valid 5000-entry
    commit manifests exceed it); Slideless routes limits by path (1 MiB
    default / 16 MiB manifests / MAX_FILE_SIZE_MB+1 multipart). (Phase 3.)
    Fix: a `bodyLimitByPrefix([...])` helper so it is a declaration, not an
    if-chain every product re-grows.
30. **Contract routes that declare no 403 force forbidden-as-404.** The
    frozen annotation entries declared only 401/404, so
    authorized-but-wrong-role had to answer 404. (Phase 5.) Fix: authoring
    guidance — "every authed resource route declares 401 AND 403 AND 404
    unless hiding existence is deliberate".

## 6. Storage & files

31. **Hono/zod-openapi multipart validation buffers whole parts in RAM**
    (`zValidator('form')` rides `parseBody()`), then Slideless buffers again
    to hash-verify the declared sha256. Fine at slide-asset sizes under a
    bodyLimit; strictly worse than the template's streamed `POST /files`
    pipeline for large payloads. (Phase 3.) Fix: if the template grows a
    multipart helper, make it a streaming parser (busboy-style) that can
    hash-and-spool per part — hash-verified multipart for free.
32. **`FileService.delete` needed a transactional in-use seam.** A product
    that builds references onto `files` (the whole point of reusing the
    table) must run its reference check INSIDE the delete transaction with
    the row locked FOR UPDATE (commits lock FOR SHARE) — the template's
    delete was fire-and-forget. Slideless added an optional `inUse(tx, row)`
    callback. (Phase 3.) Fix: upstream the seam.

## 7. Tokens, invitations & rate limiting

33. **The two-token invitation pattern is not extractable.**
    `invitations/service.ts` (mint pair → sha256 both →
    find-live-and-report-which → guarded one-shot redeem) had to be
    re-implemented verbatim for per-deck collaborator grants because the
    service is welded to its tables. (Phase 5.) Fix: a tiny helper —
    `mintClaimTokenPair()` + `matchClaimToken(hashA, hashB, presented)` — so
    every token-redemption surface reuses the crypto + the ADR 009
    which-token-proves-mailbox semantics.
34. **`PepperRegistry` only exposed `get(version)` + `current` — resolution
    for versionless credentials was impossible.** A share-token secret IS
    the lookup key, so resolving across rotations needs the registered
    version list to compute candidate hashes; Slideless added
    `versions: readonly number[]`. (Phase 4.) Fix: ship it from the start —
    any token whose hash is the index key needs it.
35. **Hash-only token storage forces a design choice on "email this link
    later"**: the server cannot re-derive the URL. Slideless made send
    ROTATE the token onto a fresh secret (mint → mail → persist, so a failed
    delivery never bricks the old link). (Phase 4.) Fix: a template-level
    note on one-shot secrets vs later-delivery flows saves every product the
    same detour.
36. **Lock-free cap COUNT races.** `assertUnderCap` COUNTs live rows inside
    the invite transaction, but two concurrent invites for DIFFERENT emails
    take no common lock, so both pass at cap-1 and land cap+1. Low stakes,
    but the template's invitations service has the same pattern. (Phase 5
    review, finding 7.) Fix: per-scope advisory lock or recheck-after-insert.
37. **Rate-limiter buckets are shared across surfaces keyed by the same
    string** — `limiters.login` keyed `email:<addr>` is one bucket for
    password sign-in AND any new surface reusing it (the CLI complete
    endpoint). Right posture (per-account brute-force budget), but tests
    driving both surfaces must budget shared points. (Phase 6.) Fix: one
    line in the rate-limit module docs.

## 8. SDK, CLI & pagination

38. **The template CLI's default URL (`http://localhost:3000`) is a footgun
    for multi-instance products** — with a config file in play it silently
    points real commands at whatever occupies :3000. Slideless dropped it:
    no flag/env/profile → explicit error. (Phase 6.) Fix: same, once the
    template CLI grows a config file.
39. **`keysetBefore`'s `workspaceId` parameter is really a scope column.**
    Phases 4 and 5 both scoped it by parent id (deck) and each call site
    demands the same explanatory comment. Fix: rename the field to
    `scopeColumn`/`scope`.

## 9. Dashboard chassis

40. **The api-keys page's `createRawSnippet` badge pattern is an XSS
    invitation when copied.** Fine for the server-generated keyId it
    interpolates today; the first product page that copies it for a
    USER-supplied field ships stored XSS on the app origin. Slideless kept
    it strictly for static i18n strings, rendered every user field through
    FlexRender's escaped path, with SECURITY comments at each site — and the
    annotation wire shapes carry a prominent "no server-side sanitization;
    every rendering surface MUST escape body/authorName/selection" warning
    (escaping shipped in the Phase 8 dashboard). (Phases 5+8.) Fix: ship a
    tiny props-based auto-escaped `TextBadge` cell component + a warning
    comment on createRawSnippet usage.
41. **The dashboard vite dev proxy hardcodes `http://localhost:3000`** —
    with several template-derived stacks on one laptop, `pnpm dev` silently
    proxies /api to a DIFFERENT product's container. (Phase 8.) Fix:
    `DEV_API_ORIGIN ?? 'http://localhost:3000'`.
42. **`createPagedList` swallows the HTTP status** — panels that must fall
    back gracefully on 403 (role-gated sub-resources) can't distinguish
    "forbidden" from "network down"; the store only keeps `e.message`.
    (Phase 8.) Fix: keep the PlatformApiError (or at least `status`) on the
    store's error state.
43. **The French catalog's NBSP typography is easy to break mechanically** —
    a blanket "space before :/?/!" fixup also rewrites comments, which
    `no-irregular-whitespace` rejects. (Phase 8.) Fix: a tiny catalog lint
    (NBSP before double punctuation inside fr string VALUES only).

## 10. Testing & CI shapes

44. **Drizzle wraps pg errors: constraint assertions must inspect
    `.cause`.** `rejects.toThrow(/constraint_name/)` never matches —
    DrizzleQueryError's message is `Failed query: <sql>`; the pg error
    (`.code === '23505'`, `.constraint`) hangs off `error.cause`. (Phase 2.)
    Fix: a line in the template's testing docs.
45. **One flat Playwright project made suite ordering an accident of file
    names.** The smoke spec assumes a virgin database, so any second spec
    sorting before it breaks the run; Slideless moved to `projects` with
    `dependencies: ['smoke']`. (Phase 8.) Fix: ship that shape from the
    start.

## 11. Multi-workspace runtime adaptation (cloud-binding Phase 1)

Found while adapting the template's multi-workspace runtime package
(`b9e2307..01bd1c6`, ADR 012 upstream / ADR 014 here) onto the divergent
Slideless tree — the first product to port it rather than inherit it.

46. **`databaseHooks.user.create.after` silently breaks endpoint-local
    claim flows (the G1 class).** Upstream `561ef6f` moved `user.created`
    into the DB hook; any product endpoint that (a) creates the account via
    `signUpEmail` and (b) then redeems the very token a hook subscriber
    sweeps by email now loses the race by construction — the sweep's UPDATE
    dispatches inside `signUpEmail` while the endpoint still has round-trips
    left, so a pending-only redeem reliably comes back null and the
    endpoint's post-redeem block (Slideless: the membership insert that
    makes the deck reachable) never runs. Slideless had to make
    `CollaboratorService.claim()` idempotent for the SAME user. (Phase 1 of
    the cloud binding; predicted as G1 in the binding plan's adversarial
    review.) Fix: the hook's doc comment should warn that subscribers with
    claim-at-signup semantics RACE the creating endpoint's continuation, and
    that any token redeem running after `signUpEmail` must treat
    already-redeemed-by-the-same-user as success.
47. **The runtime package assumes the product never minted its own
    migrations.** Its schema change ships as template migration
    `0013_melodic_chamber`; Slideless's 0013–0017 are product migrations, so
    the file can never be copied (journal idx/tag collision now, silent
    skip once the product's own later timestamps exist). The working rule —
    merge the schema source, `drizzle-kit generate` a fresh migration in the
    product's own sequence — is documented nowhere upstream. (Phase 1.)
    Fix: state the schema-merge+regenerate rule in the template's upgrade
    notes for EVERY template schema delta, or namespace template migrations
    away from product ones at instantiation.
48. **The 0009 last-owner trigger hard-codes its invariant for every
    workspace.** A cloud edition needs projected (hub-origin) workspaces
    exempt (ownership asserted upstream; local rows re-sync at SSO login),
    which forced a CREATE OR REPLACE of a security-critical function in a
    custom migration (Slideless 0019). (Phase 1, D11.) Fix candidate: ship
    the trigger reading an exemption predicate (e.g.
    `workspaces.central_account_id IS NOT NULL`) from the start, so
    editions configure instead of redefining plpgsql.

## 12. Edition split & federation seams (cloud-binding Phase 2)

Found while building the EDITION=cloud scaffolding (env contract, boot-time
seam binding, hub dev harness) on the ported multi-workspace runtime.

49. **Setup mints the operator `emailVerified=false` — a bootstrap brick for
    any hub-federating edition.** The template's `/setup` creates the owner
    via `signUpEmail` and never stamps `emailVerified`; the hub had to add
    the stamp ad hoc (`db.update(user).set({ emailVerified: true })`, its
    ADR 013 rationale: the operator drove the wizard, there may not even be
    an email driver yet). Any product that later delegates login to a
    central IdP with `accountLinking.trustedProviders` +
    `requireLocalEmailVerified` (the safe posture) finds its operator locked
    out of their own fresh instance: the trusted-link is their only entrance
    and Better Auth refuses it onto an unverified local email. Slideless had
    to replicate the hub's fix (cloud-binding Phase 2, decision D9). Fix:
    stamp the operator verified in the TEMPLATE's setup — it is correct for
    every edition, not a cloud nicety.
50. **`auth.methods` ships as a CLOSED `z.enum` although ADR 003 promises an
    open one.** The ADR's reserved seam says "`auth.methods` is an open
    enum — an `oidc` entry is additive for the SPA and CLIs", but
    `schemas/instance.ts` pins `z.enum([...])` and `seams.ts` a closed
    union — the FIRST added method makes every older SDK/CLI that validates
    responses fail parsing `GET /instance`. Slideless had to widen it
    (known-vocabulary enum `.or(z.string())` in the contract schema,
    `KnownAuthMethod | (string & {})` in the seam type) before advertising
    the hub SSO entrance. (Phase 2.) Fix: ship the open shape in the
    template so ADR 003's promise is true in code.
51. **The better-auth mount is not wrappable — the SSO edition had to edit
    `api/index.ts`.** The Phase 3 SSO binding needs an AsyncLocalStorage
    scope spanning each auth request (the verified-assertion handoff from
    `getUserInfo` to the callback after-hook, Slideless ADR 015), and the
    only way in was patching the `api.on(['GET','POST'], '/auth/*', …)`
    mount to conditionally wrap `auth.handler`. (Phase 3.) Fix: give
    `createApiApp` a first-class optional `wrapAuthHandler?: (run: () =>
Promise<Response>) => Promise<Response>` seam so editions/products
    compose around the auth mount without touching the file.
52. **`WorkspaceService.create` cannot express projections, so ADR 012/014's
    "the cloud edition creates workspaces through the registry" did not
    hold.** The lazy org projection needs INSERT … ON CONFLICT on an
    alternate unique key (`central_account_id`), a NON-owner role from an
    external assertion, and `origin='hub'` on the membership;
    `WorkspaceService.create` hardcodes owner/local and has no conflict
    semantics, so the projection ships its own SQL in `identity/hub-sso.ts`
    (Phase 3). Fix: when the template inherits the cloud-edition module,
    either grow the service an `ensureProjected(centralAccountId, name)`
    upsert or soften the ADR's one-creation-path claim.
53. **jose's remote JWKS throttles kid-miss refetches — verifiers must own a
    forced-refresh retry.** `createRemoteJWKSet` refetches on an unknown
    `kid` only outside its `cooldownDuration` (30 s default): a token signed
    by a freshly rotated IdP key within 30 s of the last fetch fails
    `JWKSNoMatchingKey` without any network attempt (hit by the Phase 3
    rotation test on first run). The template's future federation module
    must retry once against a rebuilt key set on BOTH
    `JWKSNoMatchingKey` and `JWSSignatureVerificationFailed` (see Slideless
    `identity/hub-jwt.ts`), mirroring what its local `oauth-jwt.ts` already
    does for the signature case.
54. **The dashboard login page DROPS the oauth-provider's signed authorize
    query — a signed-out user's OAuth dance dead-ends at the dashboard.**
    When `/oauth2/authorize` finds no session it redirects to `loginPage`
    with the full SIGNED authorize query (`response_type…&sig=`), expecting
    the page to send the user back to the authorize endpoint after sign-in.
    The template's login page only honors `next` (`afterSignIn → goto(
safeNext(next))`), so the authorize context is silently discarded and
    the user lands on the dashboard root — the relying party never gets its
    code. Hit LIVE in the Slideless-cloud M1 dance against the hub (Phase
    3): a signed-out hub user who authenticates mid-flow is stranded; the
    dance only completes when the hub session already exists (or the user
    retries from the tool). Affects EVERY instance's own `/mcp` OAuth flow
    for signed-out users too (claude.ai → tool), on hub and Slideless alike
    — pre-existing template behavior, not a P3 regression. Fix: on the
    login page, when the URL carries the signed authorize query
    (`response_type` + `sig`), after sign-in redirect to
    `{basePath}/oauth2/authorize?<query verbatim>` instead of `next` (the
    consent page already round-trips it verbatim; the login page must do
    the same).
55. **genericOAuth's explicit `/oauth2/link` is ungated per provider — SSO
    identity invariants must be enforced (and undone) in after-hooks, and
    the undo must key on RECENCY, never on the current login's subject.**
    The link endpoint links ANY configured provider onto the live session
    (same-email constrained), and its callback mints no session, so a
    newSession-gated per-login guard never sees it: a second hub identity
    can land on one local user despite a single-identity invariant. The
    guard therefore has to undo conflicts at the NEXT login — and deleting
    the current login's account row there is wrong in residue states (a
    crash between better-auth's link and the hook, or the explicit link):
    the established identity's own login would delete itself, and two
    concurrent conflicting logins delete BOTH rows, stranding the user.
    Deleting the NEWEST provider row is identical on the mainline and
    correct in every residue state. (Phase 3 double-check.) Fix: when the
    template grows its federation module, either upstream a per-provider
    link-gate seam or ship the recency-undo guard pattern (Slideless
    `identity/hub-sso.ts` `guardSingleHubIdentity`, ADR 015).
56. **`user.emailVerified` is load-bearing for break-glass — a federated
    email re-sync must never write it DOWNWARD for an unchanged address.**
    The template's break-glass sign-in refuses unverified users
    (`api/break-glass.ts`), so an SSO per-login sync that mirrors the IdP's
    `email_verified` verbatim can flip a verified operator to unverified
    and close the operator door — on a hub-only-login cloud edition, the
    only door. Verification must be treated as a latch for an unchanged
    address (`local || asserted`), following the assertion honestly only
    when the address itself changes (that is exactly better-auth's own
    `overrideUserInfo` semantics). (Phase 3 double-check; see Slideless
    `identity/hub-sso.ts` `syncEmail`.) Fix: bake the latch into the
    template's future federation module and document the
    break-glass/emailVerified coupling next to the break-glass code.

## 13. Hub gates: entitlements + membership re-assertion (cloud-binding Phase 4)

Found while binding the org-suspension gate and the H2 membership
re-assertion (Slideless `identity/hub-status.ts` + `hub-gate.ts`, ADR 016).

57. **`authContext` has no post-resolution seam — an edition cannot veto an
    otherwise-valid principal.** The template's registry seams cover WHO the
    caller is (IdentityProvider) and WHAT they may consume
    (EntitlementService), but nothing covers "this principal resolved fine
    and must still be refused / re-scoped on THIS request" — exactly what a
    federated suspension gate or membership re-assertion needs, for all
    three credential kinds at once (sessions resolve via the identity seam,
    but API keys and OAuth bearers resolve in `authContext` directly, so an
    identity-seam-only gate silently misses machine credentials). Slideless
    added an optional `principalGate?: (principal) => {ok} | {ok:false,
status, code, message}` hook to `authContext` (run after quota, before
    the scope gate; `{ok:true, role}` re-scopes the live request's role).
    Fix: upstream the hook as a first-class chassis seam — it is tiny,
    oss-inert, and every cloud binding will need it.
58. **`Principal.accountRef` was populated inconsistently across credential
    paths.** The session provider and the OAuth-JWT resolver joined
    `workspaces.centralAccountId` onto the principal; the API-key resolver
    did not — so any edition feature keyed on `accountRef` (the entire
    Phase 4 gate family) silently skips API-key principals until someone
    notices. Slideless added the missing join. Fix: populate `accountRef`
    in ALL three resolvers in the template, or centralize principal
    enrichment so a new field cannot fork per path.
59. **`createMetrics` runs late in boot, so edition seams cannot register
    their counters at construction.** The Prometheus `Registry` is created
    after the registry seams are bound; Slideless works around it by
    constructing hub-gate counters with `registers: []` and calling
    `registry.registerMetric(...)` post-hoc in boot. Workable, but the
    pattern is easy to miss and unregistered counters fail silently (they
    count into nothing visible). Fix: either build the metrics registry
    before the seam binding or have `bindEditionSeams` return metrics for
    boot to attach (document the contract).

## 14. Guest semantics: membership origin as a capability axis (cloud-binding Phase 6)

Found while limiting `origin='guest'` memberships to per-deck capability
(decision D2) and closing the cloud claim flow's local-password entrance.

60. **The chassis has no capability axis besides role, so any product that
    mints memberships for EXTERNAL parties silently grants them full
    member capability.** The template's own invitation-accept is a public
    membership-minting entrance, and principal resolution requires a
    membership — the same pressure that made Slideless's collaborator claim
    mint members bit the deck-privacy review (ADR 013) and now the guest
    phase. Slideless added `workspace_members.origin`
    ('local'|'hub'|'guest') + a required `Principal.origin` populated by
    ALL THREE credential resolvers (the accountRef lesson, #58, applied
    from the start this time) + a `requireNonGuest()` route guard. Fix:
    upstream the origin column, the Principal field, and the guard as
    chassis primitives — every tool that federates (or just invites
    outsiders to one resource) needs exactly this shape, and retrofitting
    the column later costs a data backfill (Slideless migration 0019 had to
    infer every existing row's honest origin).
61. **ADR 006's "files are workspace data" posture composes badly with
    external-party memberships.** `GET /files`, `GET /files/{id}/content`
    span every workspace blob with no per-resource authorization — right
    for teams, but the moment an outsider holds a membership it is a
    whole-tenant read channel that bypasses any per-resource ACL a product
    builds (Slideless: deck assets live in the same `files` table their
    ADR 013 guards protect via /presentations). Slideless closed it with
    the origin guard (guests: 403 on all of /files, reads included). Fix:
    when #60 lands, gate /files on non-guest origin in the template too —
    it is the surface where "membership = workspace-wide read" does the
    most damage.

## 15. Hub-managed membership surfaces (cloud-binding Phase 7)

Found while cloud-gating the local `/members` + `/invitations` mutations on
hub-origin workspaces and enriching `/me` for dashboard adaptation.

62. **Module-local `err()` helpers can't carry `details`, and the naive fix
    breaks zod-openapi typechecking.** Every API module defines
    `const err = (code, message) => ({ error: { code, message } })` while
    the shared `apiError()` (and `apiErrorSchema`) support an optional
    `details`. Extending the local helper with an optional param
    (`details?: Record<string, unknown>` + conditional spread) makes the
    returned property type `{...} | undefined`, which fails
    `RouteConfigToTypedResponse` assignability (`undefined` is not
    `JSONValue`) on EVERY typed `c.json` in the module — the P7
    hub-refusal body had to be inlined at its one call site instead. Fix:
    ship one overloaded helper in the chassis (or re-export `apiError` for
    handler use) whose no-details call keeps the exact
    `{ error: { code, message } }` type and whose with-details call types
    `details` as required — modules stop re-declaring their own.
63. **`/me` had no per-workspace metadata story.** The moment one credential
    can name several workspaces (ADR 014) and workspaces differ in KIND
    (here: hub-projected vs local), clients need per-entry flags on
    `workspaces[]` and the active `workspace` to adapt — Slideless added
    `hubOrigin` booleans, the caller's membership `origin`, and a
    `hubManageUrl` pointer (P7). Fix: when the federation seams upstream,
    carry these three `/me` additions with them; they are the difference
    between the dashboard adapting off data vs edition-sniffing.
64. **The template's per-exact-path gate idiom silently under-covers
    subtree-wide policies.** The chassis registers its route guards one
    exact Hono pattern at a time (`use('/members/:id', …)` + separate
    3-segment registrations, with a comment reminding future authors to
    re-register) because Hono's `use('/x', mw)` matches ONLY that exact
    shape. Any policy meant to hold for a WHOLE surface (P7's hub-managed
    gate; plausibly future ones like org-freeze or read-only mode) is
    quietly wrong under that idiom: the collection root and every future
    sibling path start OUTSIDE the gate. Hono's `use('/x/*', mw)` matches
    the root AND all depths (verified against the pinned version), so one
    wildcard mount makes such gates fail-closed by construction. Fix:
    document the wildcard idiom next to the per-path role gates in the
    chassis (or ship a `gateSubtree(api, '/x', mw)` helper) so
    subtree-wide policies never get the per-path treatment.

## 16. Closing the local password-reset surface (cloud-binding Phase 8)

Found while closing the P3 residual: on a hub-only-login edition,
`/request-password-reset` + `/reset-password` stayed functional (merely
hidden) — an SSO-JIT user with no credential account could mail themselves a
reset, SET a local password, and sign in past the per-login SSO re-sync.

65. **There is no single "disable local credential recovery" switch — the
    reset surface must be enumerated by route pattern, and it is wider than
    it looks.** Better Auth's reset machinery is not one route pair: beyond
    `/request-password-reset` + `/reset-password` (+ the tokened GET
    callback), the emailOTP plugin — which auto-enables with ANY delivering
    mailer for OTP login — silently carries its own password-reset trio
    (`/email-otp/request-password-reset`, `/email-otp/reset-password`, the
    deprecated `/forget-password/email-otp`). Unsetting `sendResetPassword`
    closes only the core request route (400) and does NOT stop
    `/reset-password` from consuming an admin-minted token. Slideless closed
    the class with a before-hook path predicate (`isPasswordResetPath`,
    enumerated against pinned 1.6.15 — a version-bump re-verify burden) plus
    not wiring `sendResetPassword` on cloud, plus refusing the admin
    `/members/{id}/reset-link` mint (its links would dead-end). Fix for the
    cloud-edition module: ship this as one documented seam (e.g.
    `disableLocalCredentialRecovery` on the auth factory) that owns the
    route enumeration in ONE chassis-tested place, so every hub-only tool
    doesn't hand-enumerate plugin reset aliases and re-audit them on each
    Better Auth bump. (The admin reset-link route is chassis code — the seam
    should gate it too, and the dashboard affordance with it.)

    **Update (2026-07-13, the hub-only-entrances close):** the seam is
    wider still. The charter call closed the two remaining non-SSO MINTING
    entrances on cloud, and each needed its own hand-enumeration next to
    the reset predicate: the emailOTP SESSION surface (`/sign-in/email-otp`
    — the unconditional mint — plus `/email-otp/verify-email`, which mints
    under `autoSignInAfterVerification`, plus the send leg) and the tool's
    own CLI OTP key mint (`/cli/auth/request` + `/cli/auth/complete`). A
    `disableLocalCredentialRecovery`-style switch that covers only reset is
    therefore the wrong shape: the chassis seam a hub-only edition wants is
    "local credential MINTING off" — reset routes + OTP sign-in routes +
    the CLI OTP mint pair + the social providers (see below) in ONE
    chassis-tested enumeration, leaving `/sign-in/email` (break-glass), the
    SSO provider, and the self-revoke open. Until then every hub-only tool
    re-audits several separate surfaces on each Better Auth bump.

    **Update 2 (same day, the Google-social close):** the seam must also
    cover `socialProviders`. `socialProviders.google` was NOT edition-gated
    — a cloud instance with `GOOGLE_CLIENT_ID`/`SECRET` set left
    `/sign-in/social` (+ `/oauth2/callback/google`) live as a fourth non-SSO
    SESSION entrance, defeating the same audit-completeness posture. Fixed by
    registering the provider only when `!hubSso` (mirroring how the
    `antasphere` SSO provider is cloud-only), so cloud mints nothing there by
    construction (404 `PROVIDER_NOT_FOUND`) regardless of the env. The
    chassis "credential-MINTING off" switch should own social-provider
    registration too — a hub-only edition wants NO non-SSO session entrance
    except the deliberate `/sign-in/email` break-glass door, and today each
    provider (Google now, GitHub/others later) is a separate un-gated
    `socialProviders` key a product owner must remember to leave unset.

## 17. The local gate misses the CI formatting gate (P8 review)

66. **`pnpm turbo lint typecheck test build` — the gate CLAUDE.md calls "the
    CI gate" — does not include `format:check`, but the template's ci.yml
    runs it as a separate step.** Result observed in BOTH instantiated repos
    (hub and Slideless) during the P8 review: several feature commits shipped
    prettier-dirty files, every local gate stayed green, and the first push
    would have gone CI-red (hub: 4 files, Slideless: 20 files, cleaned up in
    dedicated chore commits). Fix in the template: either add a
    `format:check` turbo task to the documented gate line, or fold prettier
    into the lint task — one gate, no drift between "what CLAUDE.md says CI
    is" and what CI runs.

## 18. The CLI logout self-revoke is missing from the template (family-wide)

67. **The template ships the CLI OTP key MINT (`/cli/auth/request` +
    `/cli/auth/complete`) but no logout counterpart — a CLI that minted a
    key cannot revoke it server-side.** `slideless logout` (and any tool
    CLI's logout) can only forget the local copy; the key stays live until
    someone finds it in the dashboard. The fail-closed machine allowlist
    (correctly) blocks every unlisted route, so this needs a deliberate
    chassis opening, and every instantiated tool will hit the same gap. The
    hub grew `DELETE /cli/auth/key` (self-revocation: the PRESENTING key
    revokes exactly itself — no id parameter, so no foreign key is nameable;
    sessions refused) machine-allowed under its write scope, and Slideless
    mirrored it (contract route + handler + one method-keyed allowlist
    entry + SDK `cliAuthRevoke()`). Fix in the template: ship the
    self-revoke route, its allowlist entry, and the SDK method as chassis
    code next to the mint pair, so `logout` works server-side in every
    product without each repo re-deriving the self-revocation shape.

## 19. The release smoke never survived the ADR 005 metrics hardening

68. **release.yml's e2e-smoke scrapes `/metrics` unauthenticated, but metrics
    are token-gated by default (ADR 005)** — the curl gets the 401 "metrics
    disabled: set METRICS_TOKEN" and the smoke (hence every image publish)
    fails. Latent in both instantiated repos and only surfaced at the FIRST
    real `v*` tag, because the shipped `branches: [main]` trigger (the
    hub's feedback item on workflow triggers) had kept the job from ever
    running post-instantiation. Fixed in-repo 2026-07-13: the smoke seeds a
    `METRICS_TOKEN` into its .env and presents it as the Bearer on the
    scrape. Fix in the template: the same two lines in release.yml — and
    note the compounding: a dead branch trigger hides a broken gate until
    the first release is on the critical path.

## Confirmed-good template properties (keep these)

- **The instantiation checklist's file-by-file lists for scope strings and
  image refs were accurate and complete**; the verify-grep catches most
  misses; `EDITION` already defaulted to `oss`; the scope rename via plain
  string replace worked across contract/middleware/tests with zero manual
  fixes. (Phase 0.)
- **The compose `APP_PORT` knob worked exactly as documented** when host
  port 3000 was occupied — `.env` only, in-container port untouched.
  (Phase 0.)
- **`drizzle-kit generate --name <slug>` slots cleanly named migrations into
  the journal; the scopes.ts "Products: open your domain endpoints here"
  comment made the fail-closed extension obvious; reusing the
  content-addressed `files` machinery for a product blob store required zero
  template changes** (ADR 011). (Phase 2.)
- **The route-precedence "open slot" in `app.ts` works as intended** — a
  public product sub-app mounted in the documented slot takes requests ahead
  of `serveStatic`/the SPA fallback with no surprises. (Spike.)
- **`pageOf`/`keysetBefore` generalized cleanly to child collections** by
  passing the parent-id column as the scope column. (Phase 3.)
- **The explicit idempotency target list is the right shape** — one Set
  entry + a doc line per new POST. (Phase 3.)
- **The auth-surface rate-limiter registry-of-named-buckets extends cleanly
  to product surfaces** — one `viewerPassword` entry for the password gate's
  per-IP+token wall. (Phase 4.)
- **OAuth portability is fixed at the root**: nothing under apps/ or
  packages/ hardcodes an external origin — the 401 challenge, RFC 9728
  document, issuer, and `/mcp` audience all derive from `PUBLIC_BASE_URL`
  (verified against :3100 and an ephemeral test origin). (Phase 7.)

## Open policy decisions for the product owner

Surfaced by the adversarial reviews and RECORDED ON PURPOSE — product policy
calls for Romain, not template bugs. Nothing here is silently fixed.

1. **`/members` roster visibility to collaborators.** ~~A claimed
   collaborator is a workspace member and can GET `/members` — the full
   name/email roster.~~ **RESOLVED 2026-07-13 (decision D2, cloud-binding
   Phase 6)**: guests (origin='guest') are refused the roster
   (`requireNonGuest`, 403). Ordinary invited members still see it —
   unchanged, and intended (they are team).
2. **The member account-minting policy.** ~~Any claimed collaborator can
   create their own deck, become its owner, and invite further emails.~~
   **RESOLVED 2026-07-13 (decision D2, cloud-binding Phase 6)**: guests are
   refused deck creation (and /files, and the export) on both editions;
   their role is locked so promotion cannot reopen it. Account minting per
   claim remains (principal resolution requires a membership), but a guest
   account can no longer populate the host workspace with content.
3. **Cross-site Origin-symmetry defense-in-depth on `/api/v1`.** The custom
   routes rely on SameSite=Lax alone; the ADR 012 spike showed Firefox still
   transmits the session cookie on an opaque-origin credentialed fetch (the
   response stayed unreadable and the server answered 401 — no break).
   Adding an Origin/`Sec-Fetch-Site: cross-site` rejection would refuse such
   requests outright — belt-and-suspenders every content-rendering product
   would inherit if upstreamed. Decide whether to ship it product-side now
   or wait for the template.
4. **The dead-token existence oracle in the viewer.** `/v/{secret}` statuses
   deliberately differ by cause: revoked → 403, expired → 410, unknown → 404. Friendlier for legitimate recipients, but it lets anyone probing a
   secret distinguish "this link once existed" from "never existed". Decide:
   keep the differentiated UX or collapse dead tokens to a uniform 404
   (live-link secrecy is unaffected either way — 384-bit secrets).
