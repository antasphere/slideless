import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonText, wrapToolErrors } from './errors.js';
import { callApi, checkScope, pageQuery, type McpToolContext } from './tool-kit.js';
import { registerSlidelessTools } from './tools.js';

/**
 * The bundled MCP server: tools are thin shims over the instance's own
 * /api/v1 — called IN-PROCESS with the caller's Authorization header
 * forwarded verbatim. MCP is just another API client: no privileged path, no
 * MCP-only endpoints; new behavior lands in the API first. Identity comes
 * from the verified credential, never from a tool parameter.
 *
 * Conventions (ported from the predecessor MCP template):
 *  - read tools: `readOnlyHint: true` + a presentations:read checkScope
 *  - write tools: confirm-first description + presentations:write (+ destructiveHint
 *    for deletes) — see the slideless_ write tools in tools.ts
 *  - checkScope is UX only — the API's fail-closed allowlist is the
 *    enforcement point; this just gives the model a clean, actionable error.
 *
 * get_me and list_files below are the chassis' original example tools (the
 * end-to-end whoami proof + a cursor-paginated list); the product tool set
 * (slideless_*) lives in tools.ts.
 */
export type { McpToolContext } from './tool-kit.js';

export interface McpServerInfo {
  version: string;
  instanceName: string;
}

export function buildMcpServer(ctx: McpToolContext, info: McpServerInfo): McpServer {
  const server = new McpServer(
    { name: 'slideless', version: info.version },
    {
      instructions:
        `MCP endpoint of the "${info.instanceName}" instance. Every tool acts as the connected ` +
        'user, with the scopes granted on the consent screen (or on the API key). Start with ' +
        'slideless_whoami to see who is connected; decks live behind the slideless_ tools ' +
        '(list/get/upload/download/share/collaborators/annotations).'
    }
  );

  // ── Pattern 1: READ tool — the end-to-end whoami proof ────────────────────
  server.registerTool(
    'get_me',
    {
      description:
        'Who is connected: the user this MCP connection acts as. Returns ' +
        '{ user: { id, email, name }, workspace, role, via, scopes }. Everything done through ' +
        'this server happens as this user. (Alias of slideless_whoami.)',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      const denied = checkScope(ctx.principal, 'presentations:read');
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
      const denied = checkScope(ctx.principal, 'presentations:read');
      if (denied) return denied;
      return wrapToolErrors(async () =>
        jsonText(await callApi(ctx, pageQuery('/api/v1/files', { cursor, limit })))
      );
    }
  );

  // The product surface: the slideless_ tool set (decks, versions, inline
  // upload/download, sharing, collaborators, annotations).
  registerSlidelessTools(server, ctx);

  return server;
}
