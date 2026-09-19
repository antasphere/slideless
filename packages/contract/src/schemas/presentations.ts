import { z } from 'zod';
import { cursorPageQuerySchema, opaqueJsonChecks, plainText } from '@antasphere/chassis-contract';

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
 * Root paths the SERVER answers itself, so a deck may not carry them: the
 * viewer serves `/v/{secret}/downloads.zip` as the version's attachments
 * archive (PRDCT-2278), and a root file of that name would be shadowed
 * silently, unreachable through any route (verifier round 1, F3). Exact
 * root position, compared case-insensitively like the reserved filenames;
 * a nested `assets/downloads.zip` is an ordinary asset.
 */
export const RESERVED_ROOT_ASSET_PATHS = ['downloads.zip'] as const;

const RESERVED_ROOT_ASSET_PATH_SET: ReadonlySet<string> = new Set<string>(RESERVED_ROOT_ASSET_PATHS);

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
  if (RESERVED_ROOT_ASSET_PATH_SET.has(p.toLowerCase())) return false;
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
      `no reserved filename (${RESERVED_ASSET_FILENAMES.join(', ')}) ` +
      `and no reserved root path (${RESERVED_ROOT_ASSET_PATHS.join(', ')})`
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
export const presentationMetadataSchema = opaqueJsonChecks(z.record(z.string(), z.unknown())).refine(
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

/**
 * The reserved ATTACHMENTS folder (PRDCT-2278): every manifest entry under
 * `downloads/` at the bundle root is an attachment — a file that travels
 * WITH the version and is handed to a share-link recipient as a download
 * (never rendered), switched per link by `canDownload`. A folder
 * convention rather than per-file flags: the deck author drops files in
 * one place and the record, the routes and the CLI all agree on what is an
 * attachment without any of them re-deriving a rule. Exact, case-sensitive
 * prefix — manifest paths never normalize.
 */
export const DOWNLOADS_DIR = 'downloads';
export const DOWNLOADS_PREFIX = `${DOWNLOADS_DIR}/`;

/** True when a manifest path sits under the reserved `downloads/` folder. */
export function isAttachmentPath(p: string): boolean {
  return p.startsWith(DOWNLOADS_PREFIX) && p.length > DOWNLOADS_PREFIX.length;
}

/** The attachment's name: its manifest path relative to `downloads/`. */
export function attachmentNameOf(p: string): string {
  return p.slice(DOWNLOADS_PREFIX.length);
}

/** The manifest path an attachment name resolves to (the inverse of attachmentNameOf). */
export function attachmentPathOf(name: string): string {
  return `${DOWNLOADS_PREFIX}${name}`;
}

// ── References (ADR 025) ─────────────────────────────────────────────────────

/**
 * A REFERENCE is a deck the workspace keeps to make other decks from. The
 * underlying noun is `reference`; the types are surface names only, read
 * from the `type:` line of the AGENT.md frontmatter at push (matched
 * case-insensitively, stored lowercase). A future type is one more value
 * here — no migration, the column is free text.
 */
export const REFERENCE_TYPES = ['brand', 'template'] as const;
export const referenceTypeSchema = z.enum(REFERENCE_TYPES);
export type ReferenceType = z.infer<typeof referenceTypeSchema>;

/**
 * Serialized cap on the mirrored frontmatter, in JSON.stringify characters
 * (the metadata cap is the precedent). A frontmatter over it leaves the
 * deck an ordinary deck with a warning — it never refuses the push.
 */
export const REFERENCE_MAX_LENGTH = 16 * 1024;

/**
 * The frontmatter as the server mirrored it at push: `type` is the known
 * type in lowercase, every other field is the author's, verbatim and
 * opaque to the server.
 */
export const referenceSchema = z.object({ type: referenceTypeSchema }).catchall(z.unknown());
export type Reference = z.infer<typeof referenceSchema>;

/**
 * Who reads a reference (a column, never a frontmatter field): `private`
 * follows the deck read rule of ADR 013 unchanged; `workspace` opens the
 * reference and its files to every NON-GUEST member of the workspace.
 * Meaningful on a reference only — an ordinary deck is always `private`.
 */
export const audienceSchema = z.enum(['private', 'workspace']);
export type Audience = z.infer<typeof audienceSchema>;

/** Provenance a deck made from references records in `metadata.references`. */
export const referenceProvenanceSchema = z.object({
  type: referenceTypeSchema,
  id: z.string(),
  version: z.number().int().min(1)
});
export type ReferenceProvenance = z.infer<typeof referenceProvenanceSchema>;

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
  /**
   * Whether the current version's bundle carries attachments (files under
   * the reserved `downloads/` folder). Stamped at commit like hasAgentDoc,
   * so listings never open a manifest to know.
   */
  hasDownloads: z.boolean(),
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
  /**
   * Whether the deck owner is mailed when a form response arrives or is
   * edited (PRDCT-2330). Default true; the per-deck off switch for an owner
   * collecting hundreds of answers who does not want a mail per batch.
   */
  notifyOnResponse: z.boolean(),
  /**
   * The AGENT.md frontmatter of the current version when it names a known
   * reference type, mirrored at push; null on an ordinary deck. Existing
   * decks are classified at their next push (no backfill).
   */
  reference: referenceSchema.nullable(),
  /** Who reads this reference (see audienceSchema); `private` on every ordinary deck. */
  audience: audienceSchema,
  /** Whether this is the workspace's default reference of its type (one per type). */
  defaultReference: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Presentation = z.infer<typeof presentationSchema>;

/**
 * The list's query: the shared cursor page plus `type`. Absent lists
 * ORDINARY decks only (references leave the default listing); `brand` or
 * `template` lists the references of that type; `reference` lists every
 * reference. Kept here, not on the shared `cursorPageQuerySchema`.
 */
export const presentationsListTypeSchema = z.enum([...REFERENCE_TYPES, 'reference']);
export type PresentationsListType = z.infer<typeof presentationsListTypeSchema>;
export const presentationsListQuerySchema = cursorPageQuerySchema.extend({
  type: presentationsListTypeSchema.optional(),
  /**
   * `default=true` keeps only the default references (at most one per
   * type): with `type=brand` it answers "which deck is the house brand"
   * in one call. Without `type` it implies `type=reference`.
   */
  default: z.enum(['true']).optional()
});
export type PresentationsListQuery = z.infer<typeof presentationsListQuerySchema>;

export const presentationsListSchema = z.object({
  presentations: z.array(presentationSchema),
  nextCursor: z.string().nullable()
});

// ── Upload / versions ────────────────────────────────────────────────────────

/**
 * RFC 7231 media type: `token "/" token`, optionally followed by
 * `;`-separated `token=token|quoted-string` parameters. The manifest's
 * `contentType` is copied VERBATIM into the response `Content-Type` header
 * when the blob is served (`files/serve.ts`), including on the anonymous
 * viewer — and versions are immutable, so a committed value that the
 * `Headers` constructor refuses (a non-Latin-1 character, say) was a
 * permanent anonymous 500 on that asset (PLT-5, PRDCT-1358). The grammar
 * check at commit is the fix; the serve-time sanitizer is the backstop for
 * rows committed before it.
 */
const MEDIA_TYPE_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
export const MEDIA_TYPE_RE = new RegExp(
  `^${MEDIA_TYPE_TOKEN}\\/${MEDIA_TYPE_TOKEN}` +
    `(?:[ \\t]*;[ \\t]*${MEDIA_TYPE_TOKEN}=(?:${MEDIA_TYPE_TOKEN}|"[^"\\\\\\u0000-\\u001f\\u007f]*"))*$`
);

/**
 * A response header VALUE is a ByteString: setting it converts each UTF-16
 * code unit and throws a TypeError on any unit above 0xFF. The token grammar
 * already excludes those in unquoted positions, but a quoted parameter value
 * (`charset="€"`) can carry any character the regex's negated class does not
 * name — U+20AC passes the pattern and then throws at the `Headers` set. So
 * the Latin-1 ceiling is a SEPARATE, explicit check: every code unit ≤ 0xFF,
 * which also rejects astral characters and lone surrogates (their code units
 * are all ≥ 0xD800). Without it the grammar check is not the closure PLT-5
 * needs.
 */
function isLatin1(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

export function isValidMediaType(value: string): boolean {
  return value.length >= 1 && value.length <= 255 && isLatin1(value) && MEDIA_TYPE_RE.test(value);
}

/** One manifest line: where a blob mounts inside the deck. */
export const manifestEntrySchema = z.object({
  path: assetPathSchema,
  sha256: sha256Schema,
  sizeBytes: z.number().int().min(0),
  contentType: z
    .string()
    .min(1)
    .max(255)
    .refine(isValidMediaType, 'contentType must be an RFC 7231 media type (e.g. text/html)')
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
  /** Whether this version's manifest carries attachments (entries under `downloads/`). */
  hasDownloads: z.boolean(),
  /** This version's AGENT.md frontmatter when it names a known reference type; null otherwise. */
  reference: referenceSchema.nullable(),
  /**
   * One sentence naming what made this version's frontmatter unusable
   * (malformed, oversized, an unknown type), or null. The push succeeded
   * either way: the classification never refuses a commit.
   */
  referenceWarning: z.string().nullable(),
  /** Null once the author's account was deleted. */
  createdBy: z.string().nullable(),
  createdByRole: versionAuthorRoleSchema,
  createdAt: z.string()
});
export type PresentationVersion = z.infer<typeof presentationVersionSchema>;

/**
 * A version as the LIST returns it (PRDCT-2308): the summary plus the two
 * per-version counts the deck page's version popover shows, read from the
 * link-analytics events (`share_token_views`, `share_token_downloads`)
 * grouped by the version each event was served from. Both are bounded by
 * the events' retention (VIEW_EVENTS_RETENTION_DAYS): an old version's
 * counts fall back to 0 once its events are purged, while the deck's
 * `totalViews` keeps its lifetime figure. Owner previews write no event and
 * never count; a whole-set zip is one download.
 */
export const presentationVersionSummarySchema = presentationVersionSchema.extend({
  viewCount: z.number().int().min(0),
  downloadCount: z.number().int().min(0)
});
export type PresentationVersionSummary = z.infer<typeof presentationVersionSummarySchema>;

/**
 * One attachment of a version: a manifest entry under `downloads/`, named by
 * its path relative to that folder. Derived from the manifest by the server
 * (attachmentsOf) so no client re-derives the convention.
 */
export const attachmentSchema = z.object({
  /** The path relative to `downloads/` — what the recipient sees and the zip entry name. */
  name: z.string(),
  /** The full manifest path (`downloads/<name>`). */
  path: assetPathSchema,
  sizeBytes: z.number().int().min(0),
  contentType: z.string(),
  sha256: sha256Schema
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** The attachments of a manifest, in manifest order. */
export function attachmentsOf(manifest: ReadonlyArray<ManifestEntry>): Attachment[] {
  return manifest
    .filter((e) => isAttachmentPath(e.path))
    .map((e) => ({
      name: attachmentNameOf(e.path),
      path: e.path,
      sizeBytes: e.sizeBytes,
      contentType: e.contentType,
      sha256: e.sha256
    }));
}

export const presentationVersionDetailSchema = presentationVersionSchema.extend({
  manifest: z.array(manifestEntrySchema),
  /** The version's attachments (the `downloads/` entries of the manifest), derived server-side. */
  attachments: z.array(attachmentSchema)
});
export type PresentationVersionDetail = z.infer<typeof presentationVersionDetailSchema>;

/**
 * The recipient-side attachments list (`GET /api/v1/viewer/{secret}/attachments`,
 * token-authed, cookie-less): the version the link resolves to and its
 * attachments. `attachments` is EMPTY when the link's `canDownload` is off —
 * the link itself is public, only the capability is absent, so this is
 * never a 403.
 */
export const viewerAttachmentsSchema = z.object({
  version: z.number().int().min(1),
  attachments: z.array(attachmentSchema)
});
export type ViewerAttachments = z.infer<typeof viewerAttachmentsSchema>;

export const presentationVersionsListSchema = z.object({
  versions: z.array(presentationVersionSummarySchema),
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
  title: plainText(1, 300),
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
    title: plainText(1, 300).optional(),
    metadata: presentationMetadataSchema.optional(),
    /** The owner-notification switch for form responses (PRDCT-2330). */
    notifyOnResponse: z.boolean().optional(),
    /**
     * Who reads this reference. Deck administrators only (its owner, a
     * workspace admin/owner); 422 `not_a_reference` on an ordinary deck;
     * 409 `default_reference` when switching the default back to private.
     */
    audience: audienceSchema.optional(),
    /**
     * Make this the workspace's default reference of its type, or clear it.
     * Workspace admins/owners only; requires `audience: workspace`
     * (409 `audience_private`). Setting one clears the previous default of
     * that type in the same transaction.
     */
    defaultReference: z.boolean().optional()
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.metadata !== undefined ||
      v.notifyOnResponse !== undefined ||
      v.audience !== undefined ||
      v.defaultReference !== undefined,
    'at least one field required'
  );
export type PresentationUpdate = z.infer<typeof presentationUpdateSchema>;

/**
 * Commit a new version onto an existing deck. `expectedBaseVersion` is
 * optimistic concurrency: it must equal the deck's currentVersion or the
 * commit answers 409 version_conflict (someone else pushed in between).
 */
export const versionCommitSchema = z.object({
  expectedBaseVersion: z.number().int().min(0).max(2_147_483_647),
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

// ── Duplicate (PRDCT-2279, the master page) ──────────────────────────────────

/**
 * Body of `POST /presentations/{id}/duplicate`: a new deck in the same
 * workspace whose version 1 is the source version's manifest, entry for
 * entry, sha for sha. Nothing is re-uploaded — blobs are content-addressed
 * per workspace, so the copy references the bytes the source already holds.
 * `version` picks the source version (the current one when omitted);
 * `title` names the copy (the source title with a suffix when omitted).
 */
export const presentationDuplicateSchema = z.object({
  version: z.number().int().min(1).max(2_147_483_647).optional(),
  title: plainText(1, 300).optional()
});
export type PresentationDuplicate = z.infer<typeof presentationDuplicateSchema>;
