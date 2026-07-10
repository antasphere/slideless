import { z } from 'zod';

/**
 * GET /api/v1/instance — unauthenticated, cacheable discovery. This is what
 * CLIs and MCP clients read to route: which auth methods exist, whether
 * first-boot setup is still pending, and what the instance is.
 */
export const instanceInfoSchema = z.object({
  name: z.string(),
  instanceId: z.string().nullable(),
  edition: z.string(),
  version: z.string(),
  apiVersion: z.literal('v1'),
  setupRequired: z.boolean(),
  auth: z.object({
    methods: z.array(z.enum(['password', 'email-otp', 'google', 'api-key', 'oauth'])),
    passwordReset: z.boolean(),
    emailChange: z.boolean(),
    twoFactor: z.boolean()
  }),
  features: z.object({
    mcp: z.boolean(),
    oauth: z.boolean(),
    files: z.boolean()
  })
});
export type InstanceInfo = z.infer<typeof instanceInfoSchema>;
