import type { Principal } from '@slideless/contract';
import { ApiToolError, deny, type ToolTextResult } from './errors.js';

/**
 * Shared plumbing for MCP tools (used by the chassis examples in server.ts
 * and the slideless_ tool set in tools.ts). Every call goes through the
 * instance's own /api/v1 IN-PROCESS with the caller's Authorization header
 * forwarded verbatim — MCP is just another API client, no privileged path.
 */
export interface McpToolContext {
  /** In-process fetch against the root app (path → Response). */
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>;
  /** The verified caller (OAuth token or API key principal). */
  principal: Principal;
  /** Forwarded verbatim on every in-process API call. */
  authorizationHeader: string;
}

/**
 * Tool-level scope pre-check — UX only: the API's fail-closed allowlist
 * (middleware/scopes.ts) is the enforcement point; this just gives the model
 * a clean, actionable error instead of a raw 403.
 */
export function checkScope(
  principal: Principal,
  scope: 'presentations:read' | 'presentations:write'
): ToolTextResult | null {
  if (principal.scopes && !principal.scopes.has(scope)) {
    return deny(
      `Missing scope "${scope}": this connection was not granted ` +
        (scope === 'presentations:write'
          ? 'permission to create or edit data.'
          : 'permission to read data.') +
        ' Reconnect the MCP server and approve the permission on the consent screen.'
    );
  }
  return null;
}

/**
 * In-process API call returning the raw Response (asset downloads, multipart
 * uploads). A non-2xx answer is parsed into an ApiToolError so wrapToolErrors
 * renders the code + `Next:` hint.
 */
export async function fetchApiRaw(
  ctx: McpToolContext,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await ctx.fetchApi(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: ctx.authorizationHeader }
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiToolError(
      res.status,
      body?.error?.code ?? null,
      body?.error?.message ?? `unexpected response from ${path}`
    );
  }
  return res;
}

/** In-process JSON API call: parses the body, maps non-2xx to ApiToolError. */
export async function callApi(ctx: McpToolContext, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await ctx.fetchApi(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: ctx.authorizationHeader }
  });
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok) {
    throw new ApiToolError(
      res.status,
      body?.error?.code ?? null,
      body?.error?.message ?? `unexpected response from ${path}`
    );
  }
  return body;
}

/** Append cursor/limit list params to a path. */
export function pageQuery(
  base: string,
  params: { cursor?: string | undefined; limit?: number | undefined }
): string {
  const query = new URLSearchParams();
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}
