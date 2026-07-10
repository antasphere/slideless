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
  workspace: z.object({
    id: z.string(),
    name: z.string()
  }),
  role: workspaceRoleSchema,
  via: z.enum(['session', 'api_key', 'oauth']),
  scopes: z.array(scopeSchema).nullable(),
  /** Expiry of the presented API key; null for sessions/OAuth or non-expiring keys. */
  apiKeyExpiresAt: z.string().nullable()
});
export type MeResponse = z.infer<typeof meResponseSchema>;
