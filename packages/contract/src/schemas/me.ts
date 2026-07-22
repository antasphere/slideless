import { z } from 'zod';
import { scopeSchema, workspaceRoleSchema } from './common.js';

/**
 * GET /api/v1/me — the resolved AuthContext of the calling principal,
 * whichever credential path it arrived on. The whoami for humans, keys, and
 * (later) OAuth tokens alike; also the MCP get_me tool's backing endpoint.
 *
 * ZERO-MEMBERSHIP sessions answer 200 too (user-scoped federation): a LIVE
 * session whose user holds no active membership — the cloud operator before
 * break-glass, a hub user whose last org was removed — gets
 * `{ workspaces: [], workspace: null, activeWorkspaceId: null, role: null,
 * origin: null, via: 'session' }` instead of a 401, so the dashboard can
 * render the no-organization zero state instead of a login bounce. Machine
 * credentials never see this shape: a key/token whose user has no active
 * membership fails resolution (401) before the route runs.
 */
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string()
  }),
  /**
   * The ACTIVE workspace this request resolved to (= activeWorkspaceId).
   * Null ONLY for the zero-membership session state described above.
   */
  workspace: z
    .object({
      id: z.string(),
      name: z.string(),
      /**
       * True when this workspace is the lazy projection of a hub org (cloud
       * edition, internal/federation.md) — its MEMBERSHIP is managed at the hub,
       * so clients hide local member/invitation management and link out
       * (P7). Derived from `centralAccountId IS NOT NULL`; the raw hub org
       * id is deliberately never exposed. Always false on oss.
       */
      hubOrigin: z.boolean()
    })
    .nullable(),
  /** Null only in the zero-membership session state. */
  role: workspaceRoleSchema.nullable(),
  /**
   * How the caller's membership of the ACTIVE workspace came to exist
   * (mirrors Principal.origin): 'local' = setup/invitation, 'hub' = SSO
   * projection (cloud), 'guest' = a per-deck collaborator (D2) — clients
   * hide the guest-forbidden workspace surfaces (deck creation, files,
   * member roster, export) for 'guest'. Null only in the zero-membership
   * session state.
   */
  origin: z.enum(['local', 'hub', 'guest']).nullable(),
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
  /**
   * The workspace THIS request resolved to — what X-Workspace-Id selects.
   * Null only in the zero-membership session state.
   */
  activeWorkspaceId: z.string().nullable(),
  /**
   * Where membership of the ACTIVE workspace is managed when it is
   * hub-origin (the hub account console, e.g. https://account.antasphere.com)
   * — the dashboard's link-out target (P7). Also set for the CLOUD
   * zero-membership session state (the "create an organization at
   * Antasphere" CTA target). null on oss and on local (non-projected)
   * workspaces.
   */
  hubManageUrl: z.string().nullable(),
  /**
   * First-run welcome still owed (SL-6). CLOUD + SESSION callers ONLY —
   * absent on oss and for every machine credential. TOOL-LOCAL and
   * retry-safe semantics: true iff NO user_onboarding row with a dismissal
   * exists (`NOT EXISTS (row WHERE dismissed_at IS NOT NULL)`), so a lost
   * first-login write still shows the welcome and only an explicit
   * POST /me/onboarding/dismiss (or the deploy backfill) ever hides it.
   * The hub's advisory `tool_first_login` claim plays no part.
   */
  firstRunPending: z.boolean().optional(),
  /**
   * The hint-watch discriminator (SL-4/SL-6). CLOUD + SESSION callers ONLY
   * — absent on oss and for machine credentials. True iff the user's ONLY
   * way in is hub SSO: they hold an `antasphere` account row AND no local
   * credential (password) account row. A break-glass-capable operator has
   * a credential account and is therefore NEVER ssoOnly — the dashboard's
   * hint-watch may auto-sign-out ssoOnly users when the hub hint cookie
   * disappears, and must never sign out an operator.
   */
  ssoOnly: z.boolean().optional()
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * POST /api/v1/me/onboarding/dismiss (cloud edition ONLY; sessions only —
 * machines 403 fail-closed via the scope allowlist, oss answers the JSON
 * 404 terminator): records the explicit dismissal that flips
 * `firstRunPending` to false, permanently (upsert; an earlier dismissal
 * timestamp is preserved). Idempotent — dismissing twice is a no-op.
 */
export const onboardingDismissedSchema = z.object({
  dismissed: z.literal(true)
});
export type OnboardingDismissed = z.infer<typeof onboardingDismissedSchema>;
