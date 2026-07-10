import { z } from 'zod';

/**
 * Per-recipient share tokens: each recipient gets their own 48-byte secret
 * (returned once at creation, only its sha256 stored), so access is
 * observable and revocable per person. `versionMode` 'latest' follows the
 * deck; 'pinned' freezes the recipient on `pinnedVersion`. `expiresAt` and
 * `password` are the v2 improvements over the legacy model.
 */

export const shareTokenVersionModeSchema = z.enum(['latest', 'pinned']);
export type ShareTokenVersionMode = z.infer<typeof shareTokenVersionModeSchema>;

export const shareTokenSchema = z.object({
  id: z.string(),
  presentationId: z.string(),
  /** Owner-facing recipient label — never shown to the recipient. */
  name: z.string(),
  versionMode: shareTokenVersionModeSchema,
  /** The frozen version — null while versionMode is 'latest'. */
  pinnedVersion: z.number().int().nullable(),
  canAnnotate: z.boolean(),
  expiresAt: z.string().nullable(),
  /** Whether a viewer password is set (the hash never leaves the server). */
  hasPassword: z.boolean(),
  revokedAt: z.string().nullable(),
  accessCount: z.number().int(),
  lastAccessedAt: z.string().nullable(),
  createdAt: z.string()
});
export type ShareToken = z.infer<typeof shareTokenSchema>;

export const shareTokensListSchema = z.object({
  shareTokens: z.array(shareTokenSchema),
  nextCursor: z.string().nullable()
});

const pinnedVersionConsistent = (v: {
  versionMode?: 'latest' | 'pinned' | undefined;
  pinnedVersion?: number | null | undefined;
}) => v.versionMode !== 'pinned' || typeof v.pinnedVersion === 'number';

export const shareTokenCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    versionMode: shareTokenVersionModeSchema.default('latest'),
    /** Required when versionMode is 'pinned'. */
    pinnedVersion: z.number().int().min(1).optional(),
    canAnnotate: z.boolean().default(false),
    expiresAt: z.iso.datetime().optional(),
    /** Optional viewer password (stored hashed, shown as hasPassword). */
    password: z.string().min(4).max(256).optional()
  })
  .refine(pinnedVersionConsistent, {
    message: 'pinnedVersion is required when versionMode is "pinned"'
  });
export type ShareTokenCreate = z.infer<typeof shareTokenCreateSchema>;

/**
 * The secret appears ONLY here (like API keys): store `url`, hand it to the
 * recipient — it is never retrievable again.
 */
export const shareTokenCreatedSchema = z.object({
  shareToken: shareTokenSchema,
  /** The recipient secret, base64url. Shown once. */
  secret: z.string(),
  /** The full viewer URL carrying the secret (path-based — no ?token=). */
  url: z.string()
});
export type ShareTokenCreated = z.infer<typeof shareTokenCreatedSchema>;

/** Patch semantics: omitted = unchanged; explicit null clears (expiry/password). */
export const shareTokenUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    versionMode: shareTokenVersionModeSchema.optional(),
    /** Required alongside versionMode 'pinned'; ignored for 'latest'. */
    pinnedVersion: z.number().int().min(1).optional(),
    canAnnotate: z.boolean().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    password: z.string().min(4).max(256).nullable().optional()
  })
  .refine(pinnedVersionConsistent, {
    message: 'pinnedVersion is required when versionMode is "pinned"'
  });
export type ShareTokenUpdate = z.infer<typeof shareTokenUpdateSchema>;

export const shareTokenSendSchema = z.object({
  email: z.email(),
  /** Optional personal note included in the share email. */
  message: z.string().max(2000).optional()
});
export type ShareTokenSend = z.infer<typeof shareTokenSendSchema>;

export const shareTokenSentSchema = z.object({
  shareToken: shareTokenSchema,
  /** False when the instance has no delivering email driver. */
  emailSent: z.boolean()
});
export type ShareTokenSent = z.infer<typeof shareTokenSentSchema>;
