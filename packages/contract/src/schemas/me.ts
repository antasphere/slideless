import { z } from 'zod';
import { scopeSchema, workspaceRoleSchema } from './common.js';

/**
 * GET /api/v1/me — the resolved AuthContext of the calling principal,
 * whichever credential path it arrived on. The whoami for humans, keys, and
 * (later) OAuth tokens alike; also the MCP get_me tool's backing endpoint.
 */
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string()
  }),
  /** The ACTIVE workspace this request resolved to (= activeWorkspaceId). */
  workspace: z.object({
    id: z.string(),
    name: z.string()
  }),
  role: workspaceRoleSchema,
  via: z.enum(['session', 'api_key', 'oauth']),
  scopes: z.array(scopeSchema).nullable(),
  /** Expiry of the presented API key; null for sessions/OAuth or non-expiring keys. */
  apiKeyExpiresAt: z.string().nullable(),
  /**
   * The workspaces this credential can name (ADR 014). Sessions list ALL of
   * the user's active memberships (oldest first — index 0 is the
   * no-header default); machine credentials list ONLY the workspace they
   * are bound to (a workspace-scoped key/token must not enumerate the
   * user's other workspaces).
   */
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: workspaceRoleSchema
    })
  ),
  /** The workspace THIS request resolved to — what X-Workspace-Id selects. */
  activeWorkspaceId: z.string()
});
export type MeResponse = z.infer<typeof meResponseSchema>;
