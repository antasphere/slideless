import type { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { oauthConsentWorkspaceRoute } from '@slideless/contract/routes';
import { verification, workspaceMembers, type Db } from '@slideless/db';
import {
  oauthWorkspaceSelectionIdentifier,
  OAUTH_WORKSPACE_SELECTION_TTL_MS,
  type Auth
} from '../identity/better-auth.js';
import { requireAuth } from '../middleware/auth-context.js';

const err = (code: string, message: string) => ({ error: { code, message } });

export interface OauthRouteDeps {
  db: Db;
  auth: Auth;
}

/**
 * OAuth consent workspace selection (ADR 012). The consent page POSTs the
 * user's chosen workspace here right before POST /oauth2/consent; the
 * oauth-provider plugin's consentReferenceId seam (identity/better-auth.ts)
 * consumes it and binds the consent — and therefore every token the grant
 * ever mints — to that workspace.
 *
 * Session-only, twice over: the path is deliberately UNLISTED in the
 * fail-closed scope allowlist (machine principals 403 before the handler),
 * and the handler refuses non-session principals anyway. The selection is
 * keyed to the CALLING SESSION (id re-read from the session store, never a
 * client-supplied value) and parked in Better Auth's own verification table
 * — the admin-reset-link pattern — with a 10-minute TTL, so it cannot leak
 * across sessions or outlive the consent flow it serves.
 */
export function registerOauthRoutes(api: OpenAPIHono, deps: OauthRouteDeps): void {
  const { db, auth } = deps;

  api.use('/oauth/consent-workspace', requireAuth());
  api.openapi(oauthConsentWorkspaceRoute, async (c) => {
    const principal = c.get('principal')!;
    if (principal.via !== 'session') {
      return c.json(err('sessions_only', 'The consent workspace is chosen from a browser session'), 403);
    }
    const { workspaceId } = c.req.valid('json');

    // ACTIVE membership of the chosen workspace, or one uniform 403 — a
    // nonexistent workspace and someone else's answer identically.
    const [member] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, principal.userId),
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.isActive, true)
        )
      )
      .limit(1);
    if (!member) {
      return c.json(err('forbidden', 'This workspace is not available to this account'), 403);
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.session?.id) {
      return c.json(err('unauthenticated', 'Authentication required'), 401);
    }
    const identifier = oauthWorkspaceSelectionIdentifier(session.session.id);
    const expiresAt = new Date(Date.now() + OAUTH_WORKSPACE_SELECTION_TTL_MS);

    // Upsert: one live selection per session — drop stale rows, then mint
    // through Better Auth's own adapter (id generation, hooks).
    await db.delete(verification).where(eq(verification.identifier, identifier));
    const authCtx = await auth.$context;
    await authCtx.internalAdapter.createVerificationValue({
      identifier,
      value: workspaceId,
      expiresAt
    });

    c.set('audit', {
      action: 'oauth.consent_workspace',
      resourceType: 'workspace',
      resourceId: workspaceId
    });
    return c.json({ workspaceId, expiresAt: expiresAt.toISOString() }, 200);
  });
}
