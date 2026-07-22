# ADR 003 — Generic OIDC client login (identity layer 2) is deferred

Status: accepted (2026-07-03)

## Decision

The template does **not** ship generic OIDC/OAuth **client** login — human
sign-in delegated to an external IdP (Okta, Azure AD/Entra, Keycloak, generic
OIDC). This is deliberate deferral, not omission.

Do not confuse it with what M6 **did** ship: the instance is an OAuth 2.1
**authorization server** (it issues tokens for its own bundled `/mcp`
resource). Layer 2 is the opposite direction — the instance acting as an
OAuth/OIDC **relying party** so that enterprise users log in with their
company IdP.

## Why deferred

- v1's validated consumers (a SaaS product, per-firm client instances,
  agency deployments) all start with password + optional email-OTP + optional
  Google; none has an enterprise-IdP requirement on day one.
- Shipping it untested would mean carrying config surface (issuer URLs,
  client credentials, claim mapping, JIT provisioning policy) that no
  consumer exercises — exactly the kind of dead rail that rots.

## The place is reserved

- **`IdentityProvider` seam** (`packages/contract/seams.ts`): sign-in method
  discovery flows through `describe()`; a delegated-login variant slots in at
  the registry without touching call sites.
- **Instance discovery** (`GET /api/v1/instance`): `auth.methods` is an open
  enum — an `oidc` entry is additive for the SPA and CLIs.
- **Schema**: Better Auth's `account` table already models external provider
  links (`providerId`, `accountId`, tokens). **Enabling layer 2 later is
  Better Auth config-level work** — its `genericOAuth` / SSO plugin with
  issuer + client credentials — **no schema change**, no new migration
  beyond what that plugin's CLI generate emits (drift guard will catch it).
- The closed-sign-up posture stays: delegated logins must map onto existing
  members (`disableSignUp` + invitation-first), or the product explicitly
  opts into JIT provisioning.

## Revisit when

The first consumer needs enterprise IdP login (typically a per-firm
enterprise deployment or an agency client with Entra). Scope then: Better Auth
genericOAuth/SSO plugin config, env schema entries, login-page button wiring,
and an integration test against a Keycloak testcontainer.
