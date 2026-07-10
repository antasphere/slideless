import { z } from 'zod';

/**
 * API conventions (fixed): plain resource JSON on success — no
 * `{ success, data }` envelope; errors are `{ error: { code, message,
 * details? } }`; cursor pagination.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/**
 * Generic scopes; products define their own (e.g. products:read).
 * `data:export` is a deliberate opt-in for the full-workspace export — it
 * never rides `data:read`, or any admin read key would be a whole-tenant
 * exfiltration tool.
 */
export const scopeSchema = z.enum(['data:read', 'data:write', 'data:export']);
export type Scope = z.infer<typeof scopeSchema>;

export const cursorPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
