# ADR 002 — MCP SDK, transport, and the stateless /mcp endpoint

Status: accepted (2026-07-03)

## Decision

The bundled `/mcp` endpoint is built on:

- **`@modelcontextprotocol/sdk` 1.29.0** (official v1 line). Its zod peer is
  `^3.25 || ^4.0` — **zod v4 confirmed**: the workspace-wide zod 4.x pin
  (ADR 001) works unchanged for tool `inputSchema` shapes. The old v3-only
  constraint belonged to `mcp-handler` (a Next.js wrapper used by a
  predecessor MCP service), which this template does not carry.
- **`@hono/mcp` 0.3.0** — first-party Hono middleware providing
  `StreamableHTTPTransport` for the official `McpServer` (peers sdk
  `^1.25.1`, zod v3/v4). No Express shim, no second HTTP stack inside the
  monolith.
- **`jose` 6.2.3** for local RS256 verification of the access tokens the
  instance mints for itself (`src/identity/oauth-jwt.ts`).

### Transport mode: stateless, JSON responses

`new StreamableHTTPTransport({ enableJsonResponse: true })` with **no
`sessionIdGenerator`** (omit the key — under `exactOptionalPropertyTypes`
passing an explicit `undefined` is a type error):

- A fresh `McpServer` + transport pair is built **per request**, with the
  caller's verified principal and raw bearer closed over; nothing outlives
  the response. This is the platform's statelessness invariant applied to
  MCP: any replica can serve any request, no in-process session table.
- `enableJsonResponse` makes POST responses complete JSON bodies instead of
  SSE streams, so the `Response` handed to Hono needs no teardown hook.
- **Non-POST is rejected explicitly in `src/mcp/http.ts` (M9)** with
  `405 + Allow: POST` and a JSON-RPC error envelope; the official SDK client
  tolerates that and stays on POST. The transport itself does NOT do this: a
  GET reaching `handleRequest` opens a long-lived server-initiated SSE
  stream (and DELETE answers a session teardown) even in stateless mode —
  proven live by the M9 campaign. The same endpoint also converts the
  transport's thrown `HTTPException`s (a malformed or non-JSON-RPC POST
  body) into their JSON-RPC 400 responses instead of letting them surface as
  generic 500s.
- Cost of the trade: no server-initiated notifications/sampling and no
  resumable streams. None of the template's tools need them; a product that
  does can switch to session mode (`sessionIdGenerator` + event store) behind
  the same auth gate.

### Verified end-to-end

`test/integration/oauth-mcp.test.ts` runs the SDK's own
`Client` + `StreamableHTTPClientTransport` against a **real listening server**
on an ephemeral port (`@hono/node-server`): initialize handshake, `listTools`,
`get_me` and `list_files` calls — after completing the full OAuth dance (DCR →
authorize → consent → PKCE token exchange). A real server is required because
the SDK client dials a URL; `app.request()` cannot host the client side of the
handshake. The stateless server itself has no session coupling to test around.

## Version pins (recorded)

| Package                     | Version | Note                      |
| --------------------------- | ------- | ------------------------- |
| `@modelcontextprotocol/sdk` | 1.29.0  | v1 line; zod v4 supported |
| `@hono/mcp`                 | 0.3.0   | peers sdk ^1.25.1         |
| `jose`                      | ^6.2.3  | RS256 local JWKS verify   |

## Migration path (noted, not taken)

MCP SDK **v2** (betas tracking the 2026-07-28 spec revision: Standard Schema
support, a native Hono adapter that would replace `@hono/mcp`) is the noted
upgrade path once stable. The surface area here is deliberately small — one
transport construction site (`src/mcp/http.ts`) and tool registrations in
`src/mcp/server.ts` — so the migration is contained.

## Revisit when

SDK v2 leaves beta, or a product needs server-initiated messages (switch that
instance to session mode rather than reshaping the template default).
