# Connecting agents (MCP)

Every instance is MCP-capable at boot: the monolith serves a streamable-HTTP
MCP endpoint at `/mcp`, protected by the instance's own built-in OAuth 2.1
authorization server. No companion service, no shared secrets, no
`aud`/resource URL to keep in sync — the resource identifier is derived at
boot as `PUBLIC_BASE_URL + '/mcp'`.

## claude.ai / Claude Desktop (OAuth)

Add a custom connector with the URL:

```
https://platform.example.com/mcp
```

The client discovers everything itself: the 401 challenge points at the RFC
9728 resource metadata, which points at this instance as the authorization
server; the client self-registers (RFC 7591), the member signs in and
approves the consent screen, and the connector holds a 15-minute access
token with a rotating refresh token. Deactivating the member kills the
connector instantly (tokens are re-checked against the live membership on
every call).

## Claude Code / CLIs (API key)

`/mcp` also accepts the instance's API keys directly — no OAuth dance:

```bash
claude mcp add --transport http platform https://platform.example.com/mcp \
  --header "Authorization: Bearer key_..."
```

Mint keys in the dashboard (API keys → New). Scopes gate what tools can do:
`data:read` for reads, `data:write` for mutations.

## Verify an instance

```bash
curl -s https://platform.example.com/.well-known/oauth-protected-resource/mcp | jq
npx @modelcontextprotocol/inspector   # connect → OAuth dance → call get_me
```

`get_me` returning your identity proves discovery, registration, login,
consent, token exchange, JWKS verification, and the live membership check in
one call.

## For products extending the template

Tools live in `apps/server/src/mcp/`. Conventions (ported from a proven
predecessor MCP template): reads declare `readOnlyHint` and check `data:read`;
writes describe themselves as confirm-first and check `data:write`
(tool-level checks are UX — the API's fail-closed allowlist in
`middleware/scopes.ts` is the enforcement point); tools call the instance's
own API in-process forwarding the caller's bearer (MCP is just another API
client — never a privileged path); the acting user is NEVER a tool
parameter (identity comes from the verified credential); map domain error
codes to model-readable hints in `mcp/errors.ts`. New behavior lands in the
API first — the MCP tool is a thin projection of it.
