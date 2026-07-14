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
    name: z.string(),
    /**
     * True when this workspace is the lazy projection of a hub org (cloud
     * edition, docs/federation.md) — its MEMBERSHIP is managed at the hub,
     * so clients hide local member/invitation management and link out
     * (P7). Derived from `centralAccountId IS NOT NULL`; the raw hub org
     * id is deliberately never exposed. Always false on oss.
     */
    hubOrigin: z.boolean()
  }),
  role: workspaceRoleSchema,
  /**
   * How the caller's membership of the ACTIVE workspace came to exist
   * (mirrors Principal.origin): 'local' = setup/invitation, 'hub' = SSO
   * projection (cloud), 'guest' = a per-deck collaborator (D2) — clients
   * hide the guest-forbidden workspace surfaces (deck creation, files,
   * member roster, export) for 'guest'.
   */
  origin: z.enum(['local', 'hub', 'guest']),
  via: z.enum(['session', 'api_key', 'oauth']),
  scopes: z.array(scopeSchema).nullable(),
  /** Expiry of the presented API key; null for sessions/OAuth or non-expiring keys. */
  apiKeyExpiresAt: z.string().nullable(),
  /**
   * The workspaces this credential can name (user-scoped credential model):
   * EVERY credential kind — session, API key, OAuth bearer — lists ALL of
   * the user's active memberships; the target workspace is a per-request
   * parameter (X-Workspace-Id), never baked into the credential. Clients
   * MUST read the `default` flag to find the selector-less default — never
   * assume index 0.
   */
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: workspaceRoleSchema,
      /** Same semantics as `workspace.hubOrigin`, per listed workspace. */
      hubOrigin: z.boolean(),
      /**
       * The hub asserted this org suspended (cloud edition): it stays
       * VISIBLE here but requests into it are refused. Always false on oss
       * and on local workspaces.
       */
      suspended: z.boolean(),
      /**
       * The user's default workspace — what a request naming no workspace
       * resolves to. At most one entry carries it; when none does, the
       * deterministic fallback (oldest active membership) applies.
       */
      default: z.boolean()
    })
  ),
  /** The workspace THIS request resolved to — what X-Workspace-Id selects. */
  activeWorkspaceId: z.string(),
  /**
   * Where membership of the ACTIVE workspace is managed when it is
   * hub-origin (the hub account console, e.g. https://account.antasphere.com)
   * — the dashboard's link-out target (P7). null on oss and on local
   * (non-projected) workspaces.
   */
  hubManageUrl: z.string().nullable()
});
export type MeResponse = z.infer<typeof meResponseSchema>;
