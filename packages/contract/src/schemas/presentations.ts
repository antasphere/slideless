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
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'lowercase hex sha256 required');

/** Maximum length of a manifest path, in characters. */
export const ASSET_PATH_MAX_LENGTH = 1024;

/**
 * The structural half of the manifest-path rule: a relative path with no
 * leading slash, no backslashes and no empty, `.` or `..` segments. This is
 * the traversal guard alone — it says nothing about WHICH names are allowed
 * (see `isSafeAssetPath`). The viewer uses it on a decoded request path,
 * where the only question is "could this escape?" (there is no filesystem
 * under the viewer, only an exact manifest lookup).
 */
export function isTraversalSafeAssetPath(p: string): boolean {
  return (
    p.length >= 1 &&
    p.length <= ASSET_PATH_MAX_LENGTH &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/**
 * Names a deck bundle may never carry. `slideless pull` materializes a
 * manifest onto a developer's disk (into `.` by default), so a path the
 * SERVER chose must never be able to land on a file some other tool
 * executes: `package.json` (npm/pnpm lifecycle scripts) and the lockfiles
 * that decide what a later install fetches. Compared case-insensitively —
 * macOS and Windows filesystems are case-insensitive, so `Package.json`
 * overwrites `package.json`.
 */
export const RESERVED_ASSET_FILENAMES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb'
] as const;

const RESERVED_ASSET_FILENAME_SET: ReadonlySet<string> = new Set<string>(RESERVED_ASSET_FILENAMES);

/**
 * A relative asset path inside a deck. Traversal-safe (above) AND free of
 * dot-prefixed segments and reserved filenames.
 *
 * The dotfile ban is the other half of the pull hardening: `.git/hooks/*`,
 * `.env`, `.npmrc`, `.envrc` and `.github/workflows/*` are all "write this
 * and something else runs it later" paths, and every one of them is legal
 * under the traversal rule alone. A deck is a bundle of viewer-served
 * assets — none of it needs a dotfile — so the contract refuses them at
 * COMMIT and the CLI refuses them again at PULL (defense in depth: an
 * instance may be older, hostile, or impersonated).
 */
export function isSafeAssetPath(p: string): boolean {
  if (!isTraversalSafeAssetPath(p)) return false;
  return p
    .split('/')
    .every((seg) => !seg.startsWith('.') && !RESERVED_ASSET_FILENAME_SET.has(seg.toLowerCase()));
}

export const assetPathSchema = z
  .string()
  .min(1)
  .max(ASSET_PATH_MAX_LENGTH)
  .refine(
    isSafeAssetPath,
    'relative path required: no empty, "." or ".." segments, no dot-prefixed segment, ' +
      `and no reserved filename (${RESERVED_ASSET_FILENAMES.join(', ')})`
  );

/**
 * Serialized size cap for a deck's owner-defined metadata object, in
 * JSON.stringify characters (an environment-free proxy for bytes — the
 * contract runs in browsers and Node alike, so no TextEncoder/Buffer here).
 */
export const PRESENTATION_METADATA_MAX_LENGTH = 16 * 1024;

/**
 * Owner-defined structured metadata: a plain JSON object, opaque to the
 * server beyond shape and size (≤16k serialized). The seam for building
 * external dashboards on top of the API — PATCH replaces the whole object,
 * merge is a client concern.
 */
export const presentationMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => JSON.stringify(v).length <= PRESENTATION_METADATA_MAX_LENGTH,
    `metadata must serialize to at most ${PRESENTATION_METADATA_MAX_LENGTH} characters`
  );
export type PresentationMetadata = z.infer<typeof presentationMetadataSchema>;

/**
 * The reserved root filename of a deck's agent-facing briefing: authored by
 * the creator, shipped inside the bundle, detected at version commit (exact,
 * case-sensitive — manifest paths never normalize).
 */
export const AGENT_DOC_PATH = 'AGENT.md';

export const presentationSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: presentationKindSchema,
  /** Legacy badge orthogonal to `kind`: the deck embeds interactive content. */
  interactive: z.boolean(),
  /** Owner-defined metadata object (see presentationMetadataSchema). */
  metadata: z.record(z.string(), z.unknown()),
  /** 0 until the first version commit. */
  currentVersion: z.number().int(),
  entryPath: z.string(),
  /**
   * Whether the current version's bundle carries the reserved AGENT.md
   * briefing (readable at GET /presentations/{id}/agent-doc).
   */
  hasAgentDoc: z.boolean(),
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
  /** Whether this version's manifest carries the reserved AGENT.md briefing. */
  hasAgentDoc: z.boolean(),
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
  metadata: presentationMetadataSchema.optional(),
  entryPath: assetPathSchema,
  manifest: manifestSchema
});
export type UploadSessionCommit = z.infer<typeof uploadSessionCommitSchema>;

/**
 * Mutable deck properties. `metadata` is a full replace of the stored
 * object; `title` here is the rename-without-a-version-push path (the
 * version commit's optional `title` stays for atomic push-and-retitle).
 */
export const presentationUpdateSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    metadata: presentationMetadataSchema.optional()
  })
  .refine((v) => v.title !== undefined || v.metadata !== undefined, 'at least one field required');
export type PresentationUpdate = z.infer<typeof presentationUpdateSchema>;

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
