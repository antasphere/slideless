import { z } from 'zod';

export const auditEntrySchema = z.object({
  id: z.number(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorVia: z.enum(['session', 'api_key', 'oauth', 'system']),
  apiKeyId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.string()
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextCursor: z.string().nullable()
});
