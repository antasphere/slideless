import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Principal } from '@platform/contract';
import { ApiToolError, deny, jsonText, wrapToolErrors, type ToolTextResult } from './errors.js';

/**
 * The bundled MCP server: tools are thin shims over the instance's own
 * /api/v1 — called IN-PROCESS with the caller's Authorization header
 * forwarded verbatim. MCP is just another API client: no privileged path, no
 * MCP-only endpoints; new behavior lands in the API first. Identity comes
 * from the verified credential, never from a tool parameter.
 *
 * Conventions (ported from the predecessor MCP template):
 *  - read tools: `readOnlyHint: true` + a data:read checkScope
 *  - write tools: confirm-first description + data:write (+ destructiveHint
 *    for deletes); see the write-pattern comment at the bottom
 *  - checkScope is UX only — the API's fail-closed allowlist is the
 *    enforcement point; this just gives the model a clean, actionable error.
 */
export interface McpToolContext {
  /** In-process fetch against the root app (path → Response). */
  fetchApi: (path: string, init?: RequestInit) => Promise<Response>;
  /** The verified caller (OAuth token or API key principal). */
  principal: Principal;
  /** Forwarded verbatim on every in-process API call. */
  authorizationHeader: string;
}

export interface McpServerInfo {
  version: string;
  instanceName: string;
}

function checkScope(principal: Principal, scope: 'data:read' | 'data:write'): ToolTextResult | null {
  if (principal.scopes && !principal.scopes.has(scope)) {
    return deny(
      `Missing scope "${scope}": this connection was not granted ` +
        (scope === 'data:write' ? 'permission to create or edit data.' : 'permission to read data.') +
        ' Reconnect the MCP server and approve the permission on the consent screen.'
    );
  }
  return null;
}

async function callApi(ctx: McpToolContext, path: string, init: RequestInit = {}): Promise<unknown> {
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

export function buildMcpServer(ctx: McpToolContext, info: McpServerInfo): McpServer {
  const server = new McpServer(
    { name: 'platform', version: info.version },
    {
      instructions:
        `MCP endpoint of the "${info.instanceName}" instance. Every tool acts as the connected ` +
        'user, with the scopes granted on the consent screen (or on the API key). Start with ' +
        'get_me to see who is connected.'
    }
  );

  // ── Pattern 1: READ tool — the end-to-end whoami proof ────────────────────
  server.registerTool(
    'get_me',
    {
      description:
        'Who is connected: the user this MCP connection acts as. Returns ' +
        '{ user: { id, email, name }, workspace, role, via, scopes }. Everything done through ' +
        'this server happens as this user.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const denied = checkScope(ctx.principal, 'data:read');
      if (denied) return denied;
      return wrapToolErrors(async () => jsonText(await callApi(ctx, '/api/v1/me')));
    }
  );

  // ── Pattern 2: LIST tool with cursor pagination passed through ────────────
  server.registerTool(
    'list_files',
    {
      description:
        "List the workspace's files, newest first. Returns { files: [{ id, sha256, sizeBytes, " +
        'contentType, originalName, createdBy, createdAt }], nextCursor }. When nextCursor is ' +
        'non-null, call again with cursor set to it for the next page. Download or upload happen ' +
        'through the API, not through tools.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size (server max 100). Default 50.'),
        cursor: z.string().optional().describe('nextCursor from a previous page.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ limit, cursor }) => {
      const denied = checkScope(ctx.principal, 'data:read');
      if (denied) return denied;
      return wrapToolErrors(async () => {
        const query = new URLSearchParams();
        if (cursor) query.set('cursor', cursor);
        if (limit !== undefined) query.set('limit', String(limit));
        const qs = query.toString();
        return jsonText(await callApi(ctx, `/api/v1/files${qs ? `?${qs}` : ''}`));
      });
    }
  );

  // ── Pattern 3: WRITE tool (template example — copy when a product opens a
  // mutation to machine credentials). Rules: no readOnlyHint; add
  // `destructiveHint: true` for deletes; the description MUST tell the model
  // to confirm with the user first (hosts rely on that sentence); gate on
  // data:write; NEVER accept the acting user as a parameter (identity comes
  // from the verified credential, bound server-side by the API).
  //
  // server.registerTool(
  //   'create_item',
  //   {
  //     description:
  //       'Create an item. Returns { item: { id } }. Always confirm with the user before calling.',
  //     inputSchema: { name: z.string().max(200).describe('Item name (1-200 chars).') }
  //   },
  //   async ({ name }) => {
  //     const denied = checkScope(ctx.principal, 'data:write');
  //     if (denied) return denied;
  //     return wrapToolErrors(async () =>
  //       jsonText(
  //         await callApi(ctx, '/api/v1/items', {
  //           method: 'POST',
  //           headers: { 'content-type': 'application/json' },
  //           body: JSON.stringify({ name })
  //         })
  //       )
  //     );
  //   }
  // );

  return server;
}
