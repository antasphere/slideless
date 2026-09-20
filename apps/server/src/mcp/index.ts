import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildMcpServer as buildChassisMcpServer,
  type McpServerInfo,
  type McpToolContext,
  type McpToolDefinition
} from '@antasphere/chassis-server/mcp';
import { IDENTITY } from '@slideless/contract';
import { DECK_ERROR_HINTS, DECK_MCP_SCOPES } from './deck-kit.js';
import { registerSlidelessTools } from './tools.js';

/**
 * The Slideless MCP definition handed to the chassis (`mcpRoutes({ …, tool })`):
 * the slideless_ tool set, the server instructions, the deck error hints and
 * the two scope names.
 */
export const slidelessMcp: McpToolDefinition = {
  registerTools: registerSlidelessTools,
  instructions: (info) =>
    `MCP endpoint of the "${info.instanceName}" instance. Every tool acts as the connected ` +
    'user, with the scopes granted on the consent screen (or on the API key). The credential ' +
    'is the USER; the organization (workspace) is a per-call parameter — every tool accepts ' +
    `an optional \`workspace\` id, defaulting to your default org. Start with ${IDENTITY.mcp.toolPrefix}whoami ` +
    'to see who is connected and which organizations you can name; decks live behind the ' +
    `${IDENTITY.mcp.toolPrefix} tools (list/get/upload/download/share/collaborators/annotations).`,
  errorHints: DECK_ERROR_HINTS,
  scopes: DECK_MCP_SCOPES
};

/** The bundled MCP server exactly as `/mcp` builds it: the chassis builder with the definition above. */
export function buildMcpServer(ctx: McpToolContext, info: McpServerInfo): McpServer {
  return buildChassisMcpServer(ctx, info, slidelessMcp, IDENTITY.mcp);
}
