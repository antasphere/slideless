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

/**
 * SERVER-SET token purpose. 'preview' rows are the dashboard's own transient
 * iframe tokens (ADR 012 Surface D): hidden from the share-links panel,
 * excluded from view stats, minted ONLY through the dedicated preview-token
 * endpoint (deck owner / workspace admin, 1 h expiry), and immutable once
 * minted. SECURITY: every preview behavior keys on this column — never on
 * the token NAME, which is client input (keying concealment on the name let
 * any deck writer, dev collaborators included, mint stat-silent hidden
 * links). The public token-create endpoint always mints 'share'.
 */
export const shareTokenPurposeSchema = z.enum(['share', 'preview']);
export type ShareTokenPurpose = z.infer<typeof shareTokenPurposeSchema>;

/**
 * Default display label the SERVER gives preview tokens it mints. Purely
 * cosmetic (audit metadata, admin tooling): a user may freely name a normal
 * share token "Dashboard preview" and it behaves like any other token —
 * visible in the panel, counted in stats. Nothing keys on this string; the
 * marker is the `purpose` column above.
 */
export const PREVIEW_SHARE_TOKEN_NAME = 'Dashboard preview';

export const shareTokenSchema = z.object({
  id: z.string(),
  presentationId: z.string(),
  /** Owner-facing recipient label — never shown to the recipient. */
  name: z.string(),
  /** 'share' (normal, visible, counted) or 'preview' (dashboard plumbing). */
  purpose: shareTokenPurposeSchema,
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
 * Body of the dedicated preview-token endpoint (owner/admin only). The
 * server fixes everything else: purpose 'preview', the display name, a 1 h
 * expiry, no annotations, no password. `version` pins the preview; omitted
 * = follow latest.
 */
export const previewTokenCreateSchema = z.object({
  /** Pin the preview to this version; omitted = latest. */
  version: z.number().int().min(1).optional()
});
export type PreviewTokenCreate = z.infer<typeof previewTokenCreateSchema>;

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
