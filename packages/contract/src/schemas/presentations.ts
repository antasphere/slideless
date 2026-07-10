import { z } from 'zod';

/**
 * Presentation domain wire schemas (ADR 011). A deck is a set of static
 * files pushed by an agent: append-only immutable versions whose manifest
 * lists path → sha256 into the workspace's content-addressed blob store.
 */

export const presentationKindSchema = z.enum(['presentation', 'app', 'plan']);
export type PresentationKind = z.infer<typeof presentationKindSchema>;

/** Who committed a version: the deck owner or a per-deck dev collaborator. */
export const versionAuthorRoleSchema = z.enum(['owner', 'dev']);
export type VersionAuthorRole = z.infer<typeof versionAuthorRoleSchema>;

/** Lowercase hex sha256 — the content address of a blob. */
export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'lowercase hex sha256 required');

/**
 * A relative asset path inside a deck: no leading slash, no backslashes, no
 * empty or `..` segments — enforced at the contract so traversal never
 * reaches a handler.
 */
export const assetPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
    'relative path without empty, "." or ".." segments required'
  );

export const presentationSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: presentationKindSchema,
  /** Legacy badge orthogonal to `kind`: the deck embeds interactive content. */
  interactive: z.boolean(),
  /** 0 until the first version commit. */
  currentVersion: z.number().int(),
  entryPath: z.string(),
  /** Null once the owner's account was deleted (decks are workspace data). */
  ownerUserId: z.string().nullable(),
  /** Marketplace lineage (reserved) — the deck this one was remixed from. */
  remixedFrom: z.string().nullable(),
  /**
   * Anonymous viewer opens of the ENTRY document, across all share tokens
   * and versions (assets never count; the dashboard's own preview tokens
   * never count). Survives token revocation.
   */
  totalViews: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Presentation = z.infer<typeof presentationSchema>;

export const presentationsListSchema = z.object({
  presentations: z.array(presentationSchema),
  nextCursor: z.string().nullable()
});

// ── Upload / versions ────────────────────────────────────────────────────────

/** One manifest line: where a blob mounts inside the deck. */
export const manifestEntrySchema = z.object({
  path: assetPathSchema,
  sha256: sha256Schema,
  sizeBytes: z.number().int().min(0),
  contentType: z.string().min(1).max(255)
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.array(manifestEntrySchema).min(1).max(5000);

/** Version metadata without the manifest (listings stay light). */
export const presentationVersionSchema = z.object({
  presentationId: z.string(),
  version: z.number().int(),
  entryPath: z.string(),
  sizeBytes: z.number(),
  fileCount: z.number().int(),
  /** Null once the author's account was deleted. */
  createdBy: z.string().nullable(),
  createdByRole: versionAuthorRoleSchema,
  createdAt: z.string()
});
export type PresentationVersion = z.infer<typeof presentationVersionSchema>;

export const presentationVersionDetailSchema = presentationVersionSchema.extend({
  manifest: z.array(manifestEntrySchema)
});
export type PresentationVersionDetail = z.infer<typeof presentationVersionDetailSchema>;

export const presentationVersionsListSchema = z.object({
  versions: z.array(presentationVersionSchema),
  nextCursor: z.string().nullable()
});

/** Transient reservation for a new-deck upload (~1 h). */
export const uploadSessionSchema = z.object({
  id: z.string(),
  /** The future deck id — the presentation row exists only after commit. */
  presentationId: z.string(),
  expiresAt: z.string(),
  createdAt: z.string()
});
export type UploadSession = z.infer<typeof uploadSessionSchema>;

export const uploadSessionCreatedSchema = z.object({
  uploadSession: uploadSessionSchema
});

/** Which blobs the workspace is missing (dedupe is per (workspace, sha256)). */
export const assetPrecheckRequestSchema = z.object({
  sha256: z.array(sha256Schema).min(1).max(5000)
});
export type AssetPrecheckRequest = z.infer<typeof assetPrecheckRequestSchema>;

export const assetPrecheckResponseSchema = z.object({
  /** Hashes with no blob in this workspace yet — upload exactly these. */
  missing: z.array(sha256Schema)
});
export type AssetPrecheckResponse = z.infer<typeof assetPrecheckResponseSchema>;

/**
 * Multipart asset upload: `file` carries the bytes, `sha256` the client's
 * claimed content address — the server re-hashes and rejects a mismatch.
 */
export const assetUploadFormSchema = z.object({
  sha256: sha256Schema,
  file: z.any()
});

export const assetUploadedSchema = z.object({
  sha256: sha256Schema,
  sizeBytes: z.number(),
  /** True when identical bytes already existed for this workspace. */
  deduplicated: z.boolean()
});
export type AssetUploaded = z.infer<typeof assetUploadedSchema>;

/** Commit an upload session: creates the deck and its version 1. */
export const uploadSessionCommitSchema = z.object({
  title: z.string().min(1).max(300),
  kind: presentationKindSchema.default('presentation'),
  interactive: z.boolean().default(false),
  entryPath: assetPathSchema,
  manifest: manifestSchema
});
export type UploadSessionCommit = z.infer<typeof uploadSessionCommitSchema>;

/**
 * Commit a new version onto an existing deck. `expectedBaseVersion` is
 * optimistic concurrency: it must equal the deck's currentVersion or the
 * commit answers 409 version_conflict (someone else pushed in between).
 */
export const versionCommitSchema = z.object({
  expectedBaseVersion: z.number().int().min(0),
  entryPath: assetPathSchema,
  manifest: manifestSchema,
  /** Optionally retitle the deck in the same commit. */
  title: z.string().min(1).max(300).optional()
});
export type VersionCommit = z.infer<typeof versionCommitSchema>;

export const versionCommittedSchema = z.object({
  presentation: presentationSchema,
  version: presentationVersionSchema
});
export type VersionCommitted = z.infer<typeof versionCommittedSchema>;
