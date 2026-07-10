import { z } from 'zod';
import { scopeSchema } from './common.js';

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyId: z.string(),
  scopes: z.array(scopeSchema),
  createdBy: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable()
});
export type ApiKeyInfo = z.infer<typeof apiKeySchema>;

export const apiKeysListSchema = z.object({
  apiKeys: z.array(apiKeySchema),
  nextCursor: z.string().nullable()
});

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(scopeSchema).min(1),
  /** TTL at mint; the server computes the absolute expiry. Omit = never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional()
});
export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

/** The secret appears exactly once, in this response. */
export const apiKeyCreatedSchema = z.object({
  apiKey: apiKeySchema,
  /** Full key `<prefix>_<keyid>_<secret>` — shown once, never retrievable. */
  key: z.string()
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
