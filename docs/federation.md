# Federation — the cloud edition and the Antasphere hub

How one Slideless codebase (and one Docker image) ships two editions:

- **`EDITION=oss`** (default) — the self-host edition. Single-tenant, local
  accounts, everything in this repo's other docs. It carries **zero hub
  surface at runtime**: no hub env is read, no SSO plugin is registered, no
  hub network calls exist.
- **`EDITION=cloud`** — the Antasphere-operated deployment at
  `slideless.antasphere.com`. Human login is delegated to the Antasphere hub
  (`account.antasphere.com`, the OIDC IdP for all Antasphere cloud tools);
  hub organizations project lazily into Slideless workspaces; entitlements
  come from hub account status. The instance stays its **own** OAuth 2.1
  authorization server for its `/mcp` resource — the hub never appears in
  the MCP dance.

The edition is pure **instance parametrization** — config, not build. The
binding point is `apps/server/src/platform/edition.ts` (`bindEditionSeams`),
called once from `boot.ts` where the platform registry is assembled: `oss`
binds the local defaults untouched; `cloud` rebinds the identity and
entitlement seams.

> **Phase status.** Phase 2 (this doc's scaffolding) is built: env contract,
> edition binding seam, discovery, dev harness, R7 guard. The actual SSO
> entrance is **Phase 3**; hub entitlements are **Phase 4**; the CLI
> cross-tool exchange is **Phase 5**. Until Phase 3 lands, a cloud instance
> boots with the local identity binding (a logged warning says so) and local
> login keeps working.

## Environment contract

Full variable reference: [env-reference.md](env-reference.md). The cloud
block:

| Variable | Meaning |
| --- | --- |
| `EDITION=cloud` | Selects the cloud binding. Anything else behaves as `oss`. |
| `HUB_ISSUER_URL` | The hub OIDC issuer, `https://account.antasphere.com` in production. Discovery, JWKS, and the authorize/token endpoints all derive from it. |
| `HUB_CLIENT_ID` | This tool's OAuth client id from the hub `TOOL_REGISTRY` entry — `tool-slideless-cloud`. |
| `HUB_CLIENT_SECRET` | The matching client secret (confidential client; PKCE stays on regardless). |
| `HUB_SERVICE_KEY` | A hub API key (`ant_…`) holding the `accounts:status` scope — the EntitlementService credential (Phase 4; unread before then). |

Rules the boot enforces:

- **Fail-loud completeness**: `EDITION=cloud` with ANY of the four hub vars
  missing refuses to boot and prints one readable table naming every missing
  variable — never a partial boot that dies at the first hub call.
- **Derived resource URL**: this instance's own OAuth resource identifier is
  always `<PUBLIC_BASE_URL>/mcp` (`mcpResourceUrl` in
  `identity/better-auth.ts`). It is **never configured** — there is no env
  var for it, so it cannot drift from the origin that serves it.
- **On `EDITION=oss` none of the hub vars are required or read**
  (`hubConfig()` in `env.ts` returns `null` — the single switch every cloud
  seam hangs off). Formats are still validated when a var happens to be set:
  a typo fails the boot rather than lying dormant.

### The R7 edition-flip guard

Setup stamps the instance's edition into `instance_settings.edition`. A boot
whose env `EDITION` differs from the stamp **refuses to start**: flipping
editions under existing users and workspaces silently changes who can log in
and where workspace ownership is asserted. Cloud instances start from a
fresh database.

If a flip is truly intended, set `EDITION_CHANGE_ALLOWED=true` for **one
boot** — it re-stamps the new edition and proceeds; unset it again after. A
fresh database (pre-setup) boots under any edition with nothing to guard.

### D9 — the operator bootstrap

Setup mints the operator account with `emailVerified: true` (pinned by an
integration test). This is load-bearing on cloud: under hub-only login (D1,
Phase 3) the operator's only entrance is the hub trusted-link
(`accountLinking.trustedProviders: ['antasphere']` with
`requireLocalEmailVerified` kept on), and Better Auth refuses to link a
trusted provider onto an unverified local email — an unverified operator
would brick the instance at bootstrap. The hub's own setup does the same.

## Discovery

`GET /api/v1/instance` advertises the configured entrances so SPAs and CLIs
can render the right login (`auth.methods` is an **open enum** — ADR 003 —
clients must ignore entries they do not recognize):

- `oss`: today's methods, unchanged (`password`, `api-key`, `oauth`, plus
  `email-otp`/`google` when configured).
- `cloud`: additionally `antasphere` — the hub SSO entrance. In Phase 2 the
  local methods stay advertised because they are still the working entrance;
  Phase 3 applies the D1 hub-only posture (password/OTP hidden; the
  break-glass CLI remains the operator door).

## The hub registry entry (what the HUB operator configures)

The hub seeds first-party tool clients from its `TOOL_REGISTRY` env var
(inline JSON) or `TOOL_REGISTRY_FILE` (path, wins over inline) at every boot
— idempotent upsert, and the seeded client ids are pinned so the hub's
client-management API refuses to mutate them. Each entry's `resourceUrl`
joins the hub's token-audience allowlist (`validAudiences`), and consent is
**never skipped** (`skipConsent: false` — the consent page hosts the hub's
org picker).

Production entry for Slideless cloud (origin per D7 —
`slideless.antasphere.com`, fixed before the entry is minted because grants
and redirect URIs die with it):

```json
[
  {
    "slug": "slideless-cloud",
    "name": "Slideless",
    "resourceUrl": "https://slideless.antasphere.com/mcp",
    "redirectUris": ["https://slideless.antasphere.com/api/v1/auth/oauth2/callback/antasphere"],
    "clientId": "tool-slideless-cloud",
    "clientSecret": "<from the secret store — presence makes it a confidential client>"
  }
]
```

The redirect URI is better-auth's `genericOAuth` callback for
`providerId: 'antasphere'` (registered in Phase 3). The Slideless deployment
then sets `HUB_CLIENT_ID`/`HUB_CLIENT_SECRET` to the same pair, and
`HUB_ISSUER_URL=https://account.antasphere.com`. The hub grants tool clients
its fixed `TOOL_CLIENT_SCOPES` (openid/profile/email/offline_access/
account:read/account:write) — `data:export` and `accounts:status` are never
client scopes; `accounts:status` rides the separate `HUB_SERVICE_KEY`.

## The federation dev harness

[`docker-compose.federation.yml`](../docker-compose.federation.yml) brings
up a **local hub + a local Slideless cloud instance**, pre-wired with the
dev twin of the registry entry, so the Phase 3+ SSO work has a live
two-instance loop:

```bash
docker compose -f docker-compose.federation.yml up -d --build
curl -fsS http://localhost:3300/healthz   # hub
curl -fsS http://localhost:3310/healthz   # slideless (EDITION=cloud)
docker compose -f docker-compose.federation.yml down -v
```

- **Ports**: hub `:3300`, Slideless `:3310`, shared Mailpit UI `:8030` —
  disjoint from the standing dev stacks (template `:3000`, Slideless
  self-host `:3100`/`:8026`, hub `:3200`/`:8028`).
- **URLs**: each app's `PUBLIC_BASE_URL` is a `*.localhost` name
  (`http://hub.localhost:3300`, `http://slideless.localhost:3310`) that
  resolves to 127.0.0.1 in browsers (RFC 6761) **and** to the right
  container on the compose network (service alias), with the app listening
  on the same port inside and out — so the OIDC issuer string, the
  server-side JWKS fetch, and the browser redirects all agree. Plain `curl`
  from the host: use `localhost:3300`/`localhost:3310`.
- **Bootstrap**: run each instance's setup wizard once (hub at
  `http://hub.localhost:3300`, Slideless at
  `http://slideless.localhost:3310`). The hub logs
  `tool registry: client seeded` for `tool-slideless-cloud` at boot.
- **Secrets are dev-only literals** in the compose file; the Slideless
  `HUB_SERVICE_KEY` is a placeholder until Phase 4 (its only reader) — mint
  a real `accounts:status` key on the local hub then.
- The hub builds from a sibling checkout
  (`FEDERATION_HUB_DIR`, default `../../../../platform/hub`).

## What Phase 3+ plugs into this

| Phase | Builds on this scaffolding |
| --- | --- |
| P3 — SSO entrance | `genericOAuth` registration in `identity/better-auth.ts`, conditional on `hubConfig()` (the same pattern as the emailOTP/Google blocks); `HubSsoIdentityProvider` replacing the stub in `edition.ts`; JIT + lazy projection onto `workspaces.centralAccountId`; D1 hub-only login posture; D10 email sync. |
| P4 — entitlements | `HubEntitlementService` using `HUB_SERVICE_KEY` against `GET {hub}/accounts/{id}/status`; H2 membership re-assertion. |
| P5 — CLI cross-tool | `POST /api/v1/sso/cli-connect` verifying hub-minted 120s JWTs; hub H3 `/sso/tool-token`. |

## Related decisions

- [ADR 003 — OIDC client login deferral](decisions/003-oidc-client-deferral.md):
  reserved exactly this seam (delegated login = config-level relying party;
  `auth.methods` open enum; JIT as an explicit opt-in).
- [ADR 014 — workspace-scoped principal](decisions/014-workspace-scoped-principal.md):
  the multi-workspace runtime the org projection lands on
  (`workspaces.centralAccountId`, membership `origin` discriminator).
- The program-level design lives in the Codika workspace:
  `workspace/knowledge/initiatives/agent-tools-platform/slideless-cloud-binding-plan.md`
  (Slideless-specific) and `cloud-edition-binding-patterns.md` (the
  tool-agnostic module the template inherits).
