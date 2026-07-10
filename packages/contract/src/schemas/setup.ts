import { z } from 'zod';

/**
 * POST /api/v1/setup — one-shot first-boot wizard: creates the owner user and
 * the single pinned workspace. Guarded by the singleton instance_settings row
 * (second attempt → 410) and, optionally, a SETUP_TOKEN.
 */
export const setupRequestSchema = z.object({
  instanceName: z.string().min(1).max(120),
  owner: z.object({
    email: z.email(),
    name: z.string().min(1).max(120),
    password: z.string().min(12).max(256)
  }),
  setupToken: z.string().optional()
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const setupResponseSchema = z.object({
  instanceId: z.string(),
  workspaceId: z.string(),
  ownerUserId: z.string()
});
export type SetupResponse = z.infer<typeof setupResponseSchema>;
