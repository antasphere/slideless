import { z } from 'zod';

/**
 * POST /api/v1/oauth/consent-workspace — parks the workspace an upcoming
 * OAuth consent should bind (ADR 014). Session-only: the consent page calls
 * it right before POST /oauth2/consent when the user picked a workspace;
 * single-membership users never need it (the default already names their
 * workspace). The selection lives ~10 minutes, scoped to the calling
 * session, and is membership-verified both when written and when consumed.
 */
export const oauthConsentWorkspaceRequestSchema = z.object({
  workspaceId: z.uuid()
});
export type OauthConsentWorkspaceRequest = z.infer<typeof oauthConsentWorkspaceRequestSchema>;

export const oauthConsentWorkspaceSchema = z.object({
  workspaceId: z.string(),
  expiresAt: z.string()
});
export type OauthConsentWorkspace = z.infer<typeof oauthConsentWorkspaceSchema>;
