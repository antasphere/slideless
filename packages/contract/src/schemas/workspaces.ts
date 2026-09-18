import { z } from 'zod';
import { plainText } from './common.js';

/**
 * POST /api/v1/workspaces — a signed-in person creates ANOTHER workspace from
 * inside the product (PRDCT-2444 self-hosted, PRDCT-2443 cloud). One route,
 * one body, one answer on both editions; the dashboard keys off
 * `/me.canCreateWorkspace` and never sniffs the edition.
 *
 *  - Self-hosted: the workspace is created locally with the caller as its
 *    active owner, under the operator's per-person cap
 *    (`MAX_WORKSPACES_PER_USER`).
 *  - Cloud: the organization is created at Antasphere AS THE CALLER, then
 *    projected locally before the answer — `workspace.id` is always the
 *    LOCAL workspace id, the one `X-Workspace-Id` selects.
 *
 * Sessions only: API keys and OAuth bearers are refused (the route is
 * deliberately absent from the machine scope allowlist). The name is trimmed
 * server-side; a name that is blank once trimmed answers 400.
 */
export const workspaceCreateSchema = z.object({
  name: plainText(1, 120)
});
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

export const workspaceCreatedSchema = z.object({
  workspace: z.object({
    /** The LOCAL workspace id — pass it as `X-Workspace-Id` to work in it. */
    id: z.string(),
    name: z.string()
  })
});
export type WorkspaceCreated = z.infer<typeof workspaceCreatedSchema>;
