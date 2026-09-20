import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { projects, user, workspaces } from '@antasphere/chassis-db';

// ═══ Presentation domain (ADR 011) ══════════════════════════════════════════
// The Slideless product model: decks with append-only immutable versions,
// per-recipient share tokens, per-deck dev collaborators, reviewer
// annotations, and transient upload sessions. Blob storage REUSES the
// content-addressed `files` table above (one blob per (workspace, sha256));
// each version's manifest — the path → sha256 listing — lives as jsonb on
// the version row so a commit is one transactional insert (ADR 011).

export const presentationKinds = ['presentation', 'app', 'plan'] as const;
export type PresentationKind = (typeof presentationKinds)[number];

/**
 * A deck. `current_version` is 0 until the first version commit; it is only
 * ever advanced by the optimistic-concurrency commit (expectedBaseVersion →
 * 409 on mismatch). `interactive` is the legacy badge orthogonal to `kind`.
 * `owner_user_id` anonymizes on account delete (decks are WORKSPACE data,
 * like files — ADR 006); `remixed_from` is lineage-only for the future
 * marketplace (column reserved, no behavior yet).
 */
/**
 * Where the annotation overlay's floating badge sits: the 4 corners plus the
 * 4 edge centers (bare edge name = that edge's center). The badge floats
 * over unknown deck content, so no automatic placement can know what it
 * covers — this is the one deliberately user-controllable slot.
 */
export const badgePositions = [
  'top-left',
  'top',
  'top-right',
  'right',
  'bottom-right',
  'bottom',
  'bottom-left',
  'left'
] as const;
export type BadgePosition = (typeof badgePositions)[number];

/** Who reads a reference (ADR 025); an ordinary deck is always `private`. */
export const audiences = ['private', 'workspace'] as const;
export type Audience = (typeof audiences)[number];

export const presentations = pgTable(
  'presentations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    kind: text('kind', { enum: presentationKinds }).notNull().default('presentation'),
    interactive: boolean('interactive').notNull().default(false),
    /**
     * Owner-defined structured metadata (a plain JSON object), the seam for
     * building external dashboards on top of the API. Opaque to the server
     * beyond shape + size (object-only, serialized cap enforced at the
     * contract layer); PATCH replaces the whole object — merge is a client
     * concern.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    currentVersion: integer('current_version').notNull().default(0),
    // Mirrors the current version's entry path so viewers/listings never
    // join presentation_versions for the common case.
    entryPath: text('entry_path').notNull().default('index.html'),
    // Mirrors the current version's has_agent_doc (the reserved root file
    // AGENT.md — the deck's agent-facing briefing) so listings stay
    // manifest-free, like entry_path.
    hasAgentDoc: boolean('has_agent_doc').notNull().default(false),
    // Mirrors the current version's has_forms (ADR 022) the same way.
    hasForms: boolean('has_forms').notNull().default(false),
    // Mirrors the current version's has_downloads (PRDCT-2278: the reserved
    // `downloads/` attachment folder) the same way.
    hasDownloads: boolean('has_downloads').notNull().default(false),
    /**
     * Whether the deck OWNER is mailed when a form response arrives or is
     * edited (PRDCT-2330). Defaults TRUE; the owner switches it off per deck
     * (a deck collecting 500 RSVPs) without turning forms off. Read by the
     * forms notifier after every viewer write; honoured whatever the mail
     * driver is (the `none` driver never sends anyway).
     */
    notifyOnResponse: boolean('notify_on_response').notNull().default(true),
    /**
     * References (ADR 025). Mirrors the current version's reference_type and
     * reference (the AGENT.md frontmatter, parsed once at push) so listing,
     * filtering and the read rule read columns, never a bundle. Free text,
     * not an enum: a future type is a contract value, no migration. NULL =
     * an ordinary deck. No backfill — a deck is classified at its next push.
     */
    referenceType: text('reference_type'),
    reference: jsonb('reference').$type<Record<string, unknown>>(),
    /**
     * Who reads a reference: `private` (ADR 013 unchanged) or `workspace`
     * (every non-guest member — the ADR 013 amendment). A COLUMN set by an
     * action, never a frontmatter field: a pusher must not be able to
     * publish to the workspace by editing a file. Only meaningful while
     * reference_type is set; the commit path resets it when a deck stops
     * being a reference.
     */
    audience: text('audience', { enum: audiences }).notNull().default('private'),
    /** The workspace's default reference of its type — one per (workspace, type), see the partial unique index. */
    isDefaultReference: boolean('is_default_reference').notNull().default(false),
    remixedFrom: uuid('remixed_from').references((): AnyPgColumn => presentations.id, {
      onDelete: 'set null'
    }),
    // Viewer analytics (Phase 4): bumped atomically when a share token serves
    // the ENTRY HTML (never per asset). Deliberately not on the wire schema
    // yet — the P8 dashboard decides how to surface them.
    totalViews: integer('total_views').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    /**
     * The deck's remembered badge slot for annotator links: whenever a share
     * token is created or patched with an EXPLICIT badgePosition, it lands
     * here too, so the next annotator link inherits it. Null = never chosen
     * = the overlay default (bottom-right).
     */
    annotationBadgePosition: text('annotation_badge_position', { enum: badgePositions }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // Serves the API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('presentations_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    // Serves the owner's "my decks" listing.
    index('presentations_workspace_owner_idx').on(t.workspaceId, t.ownerUserId, t.createdAt, t.id),
    // One default reference per type per workspace (ADR 025). The index is
    // the backstop under two concurrent sets: the loser's UPDATE fails on it
    // rather than leaving two defaults. A soft-deleted default frees the slot.
    uniqueIndex('presentations_default_reference_uniq')
      .on(t.workspaceId, t.referenceType)
      .where(sql`${t.isDefaultReference} AND ${t.deletedAt} IS NULL`),
    check('presentations_audience_check', sql`${t.audience} IN ('private', 'workspace')`)
  ]
);

/** Who committed a version: the deck owner or a per-deck dev collaborator. */
export const versionAuthorRoles = ['owner', 'dev'] as const;
export type VersionAuthorRole = (typeof versionAuthorRoles)[number];

/**
 * Append-only immutable versions. `manifest` is the canonical path → blob
 * listing: `[{ path, sha256, sizeBytes, contentType }]`, where every sha256
 * resolves to a `files` row of the same workspace (blobs at
 * blobKey(workspaceId, sha256)). Never UPDATE a row here — a new upload is a
 * new version.
 */
export const presentationVersions = pgTable(
  'presentation_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    entryPath: text('entry_path').notNull(),
    manifest: jsonb('manifest').notNull(),
    // Denormalized totals so listings never aggregate the manifest.
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    fileCount: integer('file_count').notNull(),
    // Whether the manifest carries the reserved root file AGENT.md (exact,
    // case-sensitive path — the deck's agent-facing briefing). Stamped at
    // commit like sizeBytes/fileCount; never derived at read time.
    hasAgentDoc: boolean('has_agent_doc').notNull().default(false),
    // Whether ANY text/html file in this version carries a marked
    // `data-slideless-form` (ADR 022). Detected once at commit, exactly like
    // has_agent_doc, and read by the viewer's injection seam: without it the
    // seam had to assume every deck might hold a form, so every share link
    // left the streaming serve path (PRDCT-1333, audit §3 — a ~10x-document
    // memory spike on an unauthenticated, unlimited GET).
    hasForms: boolean('has_forms').notNull().default(false),
    // Whether the manifest carries any entry under the reserved `downloads/`
    // folder — the version's ATTACHMENTS (PRDCT-2278). Stamped at commit like
    // has_agent_doc; listings and the dashboard never open a manifest to know.
    hasDownloads: boolean('has_downloads').notNull().default(false),
    // References (ADR 025): THIS version's AGENT.md frontmatter, read once
    // before the commit transaction (never at read time). reference_warning
    // is the one sentence naming what made a frontmatter unusable — stored
    // so the version detail says later what the push answer said on the day.
    referenceType: text('reference_type'),
    reference: jsonb('reference').$type<Record<string, unknown>>(),
    referenceWarning: text('reference_warning'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdByRole: text('created_by_role', { enum: versionAuthorRoles }).notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('presentation_versions_presentation_version_uniq').on(t.presentationId, t.version),
    // Serves the API's keyset pagination (created_at DESC, id DESC per deck).
    index('presentation_versions_presentation_created_id_idx').on(t.presentationId, t.createdAt, t.id),
    // Serves the manifest containment probes (`manifest @> '[{"sha256": …}]'`):
    // the DELETE /files/{id} in-use guard scans ALL of a workspace's versions
    // per delete, and a future asset-GC pass derives blob liveness the same
    // way (ADR 011's no-join-table decision leans on this staying fast).
    index('presentation_versions_manifest_gin').using('gin', t.manifest.op('jsonb_path_ops'))
  ]
);

/**
 * Per-recipient share tokens. The 48-byte secret is never stored — only its
 * sha256 — and lookups ride the unique hash index. `pinned_version` NULL
 * means "always the latest version"; a value pins the recipient to that
 * version. `password_hash` (nullable) and `expires_at` (nullable) are the
 * v2 improvements over the legacy model; revocation is soft (`revoked_at`)
 * so access stats survive.
 */
export const shareTokenPurposes = ['share', 'preview'] as const;
export type ShareTokenPurpose = (typeof shareTokenPurposes)[number];

export const shareTokens = pgTable(
  'share_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    /** Recipient label ("Investor deck — Alice"), owner-facing only. */
    name: text('name').notNull(),
    /**
     * SERVER-SET marker, never client input. 'preview' rows are the
     * dashboard's own transient iframe tokens (ADR 012 Surface D): hidden
     * from the sharing panel, excluded from view stats, mintable only by the
     * deck owner / a workspace admin through the dedicated preview-token
     * endpoint, and immutable once minted. SECURITY: concealment and stat
     * exclusion key on THIS COLUMN — never on the token NAME, which is
     * client-controlled (keying on the name let any deck writer, including a
     * dev collaborator, mint stat-silent hidden share links).
     */
    purpose: text('purpose', { enum: shareTokenPurposes }).notNull().default('share'),
    tokenHash: text('token_hash').notNull(),
    pinnedVersion: integer('pinned_version'),
    canAnnotate: boolean('can_annotate').notNull().default(false),
    /**
     * Whether viewers of this link may submit the deck's embedded forms
     * (data-slideless-form). Defaults TRUE — a form is the deck's own
     * intended interaction, unlike the opt-in annotation layer — so
     * push + share yields a working form with zero flags; owners opt out
     * per link. Preview tokens are minted with false (owner previews must
     * never create respondent rows, matching their view-stat exclusion).
     */
    canSubmitForms: boolean('can_submit_forms').notNull().default(true),
    /**
     * Whether viewers of this link may download the version's attachments
     * (the reserved `downloads/` folder, PRDCT-2278). Defaults TRUE — files
     * were put in that folder to be handed out, so push + share hands them
     * out with zero flags; owners opt out per link. Off: the attachment
     * routes answer 404 and the recipient list is empty (never a 403 — the
     * link is public, only the capability is absent). The migration gave
     * every pre-existing link the default.
     */
    canDownload: boolean('can_download').notNull().default(true),
    /**
     * Whether the recipient TOP BAR rides this link (PRDCT-2281): the strip
     * over the deck naming it, its version and its attachments. Defaults
     * TRUE — a recipient should know what they are looking at — and an
     * owner switches it off per link to hand out a bare deck. Injected on
     * top-level document navigations only (viewer/inject.ts): embeds,
     * frames, the password gate and the error shells never carry it,
     * whatever this column says. The migration gave every pre-existing
     * link the default.
     */
    showBar: boolean('show_bar').notNull().default(true),
    /**
     * Whether this link REMEMBERS its respondent's form answers
     * (PRDCT-2328): reopening the link plainly brings the answers back, and
     * every submit through it updates the ONE remembered row per form
     * (`form_responses.remembered`) instead of creating a new one. The link
     * secret is then a bearer credential for the ANSWERS, not just the deck,
     * so the sharing surfaces say so. The contract default is TRUE on every
     * mint that names a recipient (Romain, 2026-09-14: "by default a link is
     * a form"); the COLUMN default is FALSE so every link minted before the
     * switch existed keeps its behaviour — a broadcast link already in
     * circulation must never start showing one visitor's answers to the
     * next. Preview tokens are minted false and refused by purpose anyway.
     * SECURITY: this is NOT ADR 022 leg 3. Nothing is handed to the deck
     * document beyond a boolean; the attribution is the token row the server
     * already stores and re-stamps. Never re-wire `respondent_user_id`.
     */
    remembersResponses: boolean('remembers_responses').notNull().default(false),
    /**
     * Whether respondents on this link may UPLOAD FILES into the deck's form
     * file fields (PRDCT-2403). Rides under `canSubmitForms`: both must hold.
     * The contract default is TRUE on every new mint (a file field is the
     * deck's own intended interaction, like the form around it); the COLUMN
     * default is FALSE so every link minted before the switch existed stays
     * closed — a link already in circulation must never gain an anonymous
     * write-bytes capability without its owner's word (the PRDCT-1335 item 6
     * lesson). Preview tokens are minted false.
     */
    canUploadFiles: boolean('can_upload_files').notNull().default(false),
    /**
     * Per-link badge slot override for the annotation overlay. Null = use
     * the deck's remembered `annotation_badge_position`, else bottom-right.
     */
    badgePosition: text('badge_position', { enum: badgePositions }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    /**
     * Attachment downloads through this link (PRDCT-2278): one per file
     * taken, one per whole-set zip, incremented in the same transaction as
     * the share_token_downloads row so the counter and the events agree.
     * Never a view: the entry-view counters above are untouched by a
     * download, and the `slvd_` de-dupe cookie plays no part.
     */
    downloadCount: integer('download_count').notNull().default(0),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('share_tokens_token_hash_uniq').on(t.tokenHash),
    // Serves the API's keyset pagination (created_at DESC, id DESC per deck).
    index('share_tokens_presentation_created_id_idx').on(t.presentationId, t.createdAt, t.id)
  ]
);

export const collaboratorRoles = ['owner', 'dev'] as const;
export type CollaboratorRole = (typeof collaboratorRoles)[number];
export const collaboratorStatuses = ['pending', 'active', 'revoked'] as const;
export type CollaboratorStatus = (typeof collaboratorStatuses)[number];

/**
 * Per-deck dev grants, invited by email. `user_id` stays NULL until the
 * invitee claims the grant (at sign-in/sign-up via the emailed claim token —
 * sha256 stored, never the token). Deleting the claimed account reverts the
 * grant to unclaimed (set null) rather than silently keeping a dangling
 * identity.
 *
 * Two claim tokens per grant, one row (the invitations pattern, ADR 009):
 * `claim_token_hash` is the admin-visible copyable link (always returned by
 * the invite response), `claim_email_token_hash` is a SECOND token that
 * appears ONLY in the invite email — claiming with it proves control of the
 * invited mailbox, so that claim path may honestly set `emailVerified`.
 */
export const collaborators = pgTable(
  'collaborators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    role: text('role', { enum: collaboratorRoles }).notNull().default('dev'),
    status: text('status', { enum: collaboratorStatuses }).notNull().default('pending'),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    claimTokenHash: text('claim_token_hash'),
    claimEmailTokenHash: text('claim_email_token_hash'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('collaborators_presentation_email_uniq').on(t.presentationId, t.email),
    uniqueIndex('collaborators_claim_token_hash_uniq').on(t.claimTokenHash),
    uniqueIndex('collaborators_claim_email_token_hash_uniq').on(t.claimEmailTokenHash),
    // Serves "decks shared with me" for a signed-in collaborator.
    index('collaborators_user_idx').on(t.userId),
    // Serves the API's keyset pagination (created_at DESC, id DESC per deck).
    index('collaborators_presentation_created_id_idx').on(t.presentationId, t.createdAt, t.id)
  ]
);

/**
 * A deck's place in the workspace's PROJECTS (the chassis concept; this table
 * is the tool's own link to it). Many-to-many: a deck may sit in several
 * projects. The link is what widens the deck's READ rule to the project's
 * members (ADR 026), so creating it is the deck administrator's act.
 *
 * `is_brand` marks the project's BRAND: the project's companion, at most one
 * per project (the partial unique index). The flagged deck must be a `brand`
 * reference when the flag is set, and the flag drops in the same commit when
 * the deck stops being one (fail closed, like the default reference).
 *
 * Both sides cascade: a link carries no value once the deck or the project
 * is gone. A project is never deleted in practice; its workspace can be.
 */
export const presentationProjects = pgTable(
  'presentation_projects',
  {
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    isBrand: boolean('is_brand').notNull().default(false),
    addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.presentationId, t.projectId] }),
    // "The decks of this project": the list's project filter.
    index('presentation_projects_project_idx').on(t.projectId),
    // ONE brand per project, enforced by the database.
    uniqueIndex('presentation_projects_brand_uniq')
      .on(t.projectId)
      .where(sql`${t.isBrand}`)
  ]
);

export const annotationStatuses = ['open', 'resolved'] as const;
export type AnnotationStatus = (typeof annotationStatuses)[number];

/**
 * Reviewer notes on a specific deck version. Authored either by a signed-in
 * principal (`author_user_id`) or by an anonymous reviewer through a share
 * token (`share_token_id` + free-text `author_name`); both identity columns
 * are nullable and survive token/account deletion via set null. `selection`
 * is the client anchor payload (element/slide/rect), opaque jsonb to the
 * server.
 */
export const annotations = pgTable(
  'annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    shareTokenId: uuid('share_token_id').references(() => shareTokens.id, { onDelete: 'set null' }),
    authorUserId: text('author_user_id').references(() => user.id, { onDelete: 'set null' }),
    authorName: text('author_name'),
    selection: jsonb('selection').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: annotationStatuses }).notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // Serves the per-deck (optionally per-version) listing + keyset pagination.
    index('annotations_presentation_version_created_id_idx').on(
      t.presentationId,
      t.version,
      t.createdAt,
      t.id
    ),
    // Serves the workspace-wide owner inbox (created_at DESC, id DESC).
    index('annotations_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    index('annotations_share_token_idx').on(t.shareTokenId)
  ]
);

/** Where a form submission's serving document came from (attribution-grade). */
export const formResponseSources = ['link', 'embed'] as const;
export type FormResponseSource = (typeof formResponseSources)[number];

/**
 * Form submissions (ADR 022): one row per respondent's answer to one named
 * `data-slideless-form` in a deck, submitted anonymously through a share
 * token. `payload` is an OPAQUE flat JSON object (string / string[] values)
 * — the server enforces shape and size at the viewer API, never meaning
 * (the annotations.selection precedent). A row is one respondent's EVOLVING
 * answer: the injected runtime updates it in place through the row's own
 * edit secret (`response_secret_hash`, the share-token hash+pepper pattern
 * one level down — minted once, never stored, unique index is the lookup).
 *
 * Attribution: `share_token_id` names the link (set-null so responses
 * survive token deletion) and `source`/`placement` mirror the view-events
 * posture (visitor-influenced, sanitize-then-store, attribution-grade —
 * never authz). All three are re-stamped on an update, from the navigation
 * that made the edit (PRDCT-1332).
 *
 * ⚠️ `respondent_user_id` is DEAD (PRDCT-1331, audit §1). ADR 022 leg 3
 * stamped it from a signed identity assertion injected into the deck
 * document; deck JS could lift the assertion and file responses under a
 * stranger's account, cross-workspace. Leg 3 is gone, nothing writes this
 * column any more, and nothing reads it — a response is anonymous unless
 * the AUTHOR asked for a name in the form. The column stays for now only to
 * keep the migration additive; dropping it is a follow-up. Do NOT re-wire
 * it: account-linked responses must be an explicit claim on the app origin,
 * never a value handed to a sandboxed deck.
 */
export const formResponses = pgTable(
  'form_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    /** The deck version the respondent SAW (validated like annotations). */
    version: integer('version').notNull(),
    /** The form's `data-slideless-form` name (slug, validated at the API). */
    formName: text('form_name').notNull(),
    shareTokenId: uuid('share_token_id').references(() => shareTokens.id, { onDelete: 'set null' }),
    source: text('source', { enum: formResponseSources }).notNull().default('link'),
    /** Sanitized `?p=` label of the serving document (view-events sanitizer); else null. */
    placement: text('placement'),
    respondentUserId: text('respondent_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** sha256(editSecret + pepper) — resolution probes every registered pepper version. */
    responseSecretHash: text('response_secret_hash').notNull(),
    payload: jsonb('payload').$type<Record<string, string | string[]>>().notNull(),
    /**
     * TRUE on the ONE row a remembering link (`share_tokens.remembers_responses`,
     * PRDCT-2328) holds per form: the row the link's own navigations resolve
     * without any edit secret. Set only by the remembering create path; an
     * embed submission or a fragment-secret submission on the same link
     * stays false. The partial unique index below is what makes "the link's
     * answer" a key rather than a guess at "the latest row".
     */
    remembered: boolean('remembered').notNull().default(false),
    /**
     * The current revision number (PRDCT-2329): 1 at create, +1 per edit,
     * always equal to the highest `form_response_versions.revision` of this
     * row. The row IS the latest state; the versions table is the history.
     */
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('form_responses_secret_hash_uniq').on(t.responseSecretHash),
    // Serves the per-deck response-cap COUNT by prefix and the `since`
    // fallback scans.
    index('form_responses_presentation_form_created_id_idx').on(
      t.presentationId,
      t.formName,
      t.createdAt,
      t.id
    ),
    // Serves the owner listing + keyset pagination, ordered by LAST ACTIVITY
    // (updated_at) so an edited response resurfaces (PRDCT-2329, from
    // PRDCT-1339 §1: everything keyed on created_at hid every edit).
    index('form_responses_presentation_form_updated_id_idx').on(
      t.presentationId,
      t.formName,
      t.updatedAt,
      t.id
    ),
    index('form_responses_share_token_idx').on(t.shareTokenId),
    // ONE remembered row per (link, form): the remembering resolver's key.
    uniqueIndex('form_responses_token_form_remembered_uniq')
      .on(t.shareTokenId, t.formName)
      .where(sql`${t.remembered}`)
  ]
);

/**
 * Every revision of a form response (PRDCT-2329): revision 1 is the create,
 * each edit appends the next. Responses from before the feature got their
 * CURRENT answer backfilled as revision 1 (migration 0042): for a response
 * edited before that, revision 1 is its latest text, not its first.
 * `form_responses` stays the CURRENT state every existing read uses; this
 * table is the history the owner reads and the
 * respondent never sees (the respondent wire carries no revision, no
 * history). Each revision keeps the attribution of the navigation that
 * wrote it — the link, the source, the placement, the deck version — never
 * an identity (ADR 022 decision 4 holds per revision). Retention: at most
 * FORM_RESPONSE_MAX_REVISIONS (100) rows per response; past it the oldest
 * revisions AFTER the first are pruned, so revision 1 and the latest 99
 * always survive. Deleting the response cascades its history away.
 */
export const formResponseVersions = pgTable(
  'form_response_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    responseId: uuid('response_id')
      .notNull()
      .references(() => formResponses.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    /** The deck version the respondent saw when writing THIS revision. */
    version: integer('version').notNull(),
    shareTokenId: uuid('share_token_id').references(() => shareTokens.id, { onDelete: 'set null' }),
    source: text('source', { enum: formResponseSources }).notNull().default('link'),
    placement: text('placement'),
    payload: jsonb('payload').$type<Record<string, string | string[]>>().notNull(),
    /**
     * The files the response held AT this revision (PRDCT-2403): names and
     * sizes only, a record of what was attached, never a handle on bytes — a
     * file removed by a later edit is gone from storage while its name stays
     * here. Null on revisions written before the feature.
     */
    files: jsonb('files').$type<FormResponseFileSnapshot[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // One row per revision; serves the owner's history read (revision DESC)
    // and the retention prune (revision ASC after the first).
    uniqueIndex('form_response_versions_response_revision_uniq').on(t.responseId, t.revision)
  ]
);

/** One entry of a revision's files snapshot (PRDCT-2403). */
export interface FormResponseFileSnapshot {
  id: string;
  field: string;
  name: string;
  sizeBytes: number;
}

/**
 * The files a respondent uploaded into a form's file fields (PRDCT-2403).
 *
 * Deliberately NOT rows of `files`: that table is the workspace's
 * content-addressed pool, deduplicated per (workspace, sha256), which deck
 * version commits resolve shas against and which `blobReadScope` guards.
 * Bytes sent by an ANONYMOUS share-link respondent never enter that pool —
 * no dedupe (so no existence oracle), no possession question, no in-use
 * guard. Each upload owns its bytes under its own `storage_key`.
 *
 * Lifecycle: a row is born PENDING (`response_id` null) when the runtime
 * uploads a dropped file, and is ATTACHED when a submit on the same link and
 * form claims it. Every parent reference is `set null`: deleting a response
 * (or the deck cascade deleting it) DETACHES the row instead of dropping it,
 * because the blob must be removed from storage too and a cascade cannot do
 * that. The purge job (`form-upload-purge`) sweeps every row with no
 * response once it is older than the pending window, blob first.
 */
export const formResponseFiles = pgTable(
  'form_response_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id').references(() => presentations.id, { onDelete: 'set null' }),
    responseId: uuid('response_id').references(() => formResponses.id, { onDelete: 'set null' }),
    /** The link the bytes came through: a pending row is claimable through THIS link only. */
    shareTokenId: uuid('share_token_id').references(() => shareTokens.id, { onDelete: 'set null' }),
    formName: text('form_name').notNull(),
    /** The file input's `name` — RAW respondent-side input, like a payload key. */
    fieldName: text('field_name').notNull(),
    /** The file's display name, sanitized at the API (basename, no control characters) — still untrusted text. */
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    attachedAt: timestamp('attached_at', { withTimezone: true })
  },
  (t) => [
    // Serves the per-response read (owner wire, respondent wire, zip).
    index('form_response_files_response_idx').on(t.responseId),
    // Serves the per-deck byte-total cap and the whole-form zip.
    index('form_response_files_presentation_idx').on(t.presentationId),
    // Serves the purge sweep: unattached rows by age.
    index('form_response_files_unattached_idx')
      .on(t.createdAt)
      .where(sql`${t.responseId} is null`)
  ]
);

/**
 * The owner-notification cooldown per deck (PRDCT-2330): one mail per deck
 * per window, the events inside the window counted and carried by the next
 * mail. One row per deck that ever fired a notification; deck deletion
 * cascades it away. Nothing here identifies a respondent.
 */
export const formResponseMailState = pgTable('form_response_mail_state', {
  presentationId: uuid('presentation_id')
    .primaryKey()
    .references(() => presentations.id, { onDelete: 'cascade' }),
  /** When the last owner mail for this deck went out. */
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
  /** New responses since `last_sent_at` that no mail has reported yet. */
  pendingNew: integer('pending_new').notNull().default(0),
  /** Edits since `last_sent_at` that no mail has reported yet. */
  pendingEdited: integer('pending_edited').notNull().default(0)
});

/**
 * One row per COUNTED share-link view (PRDCT-1313): written by the viewer's
 * entry serve under exactly the gate that increments accessCount, so the
 * event stream and the counters can never disagree about what a "view" is.
 * Deliberately minimal by privacy design — referrer HOST only (never the
 * full URL), a sanitized `?p=` placement label, a coarse browser family;
 * NO IP, NO geolocation, ever (self-hosters must be able to trust the
 * posture). `share_token_id` is set-null so a token's history survives its
 * deletion; deck deletion cascades the rows away with the deck.
 */
export const shareTokenViews = pgTable(
  'share_token_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    shareTokenId: uuid('share_token_id').references(() => shareTokens.id, { onDelete: 'set null' }),
    /** The deck version the recipient was served. */
    version: integer('version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Host of the Referer header (`new URL(...).host`); null when absent/unparsable. */
    referrerHost: text('referrer_host'),
    /** Sanitized `?p=` label from the entry URL (≤64 chars, [A-Za-z0-9._-]); else null. */
    placement: text('placement'),
    /** Coarse browser family (chrome/firefox/safari/edge/bot/other) — never a full UA. */
    uaFamily: text('ua_family')
  },
  (t) => [
    // Serves the API's keyset pagination (occurred_at DESC, id DESC per token).
    index('share_token_views_token_occurred_id_idx').on(t.shareTokenId, t.occurredAt, t.id),
    // Serves the nightly retention purge's age scan.
    index('share_token_views_occurred_idx').on(t.occurredAt),
    // Serves the per-version counts on the version list (PRDCT-2308) and
    // the deck-deletion cascade (a FK gets no index on its own).
    index('share_token_views_presentation_version_idx').on(t.presentationId, t.version)
  ]
);

/**
 * One row per attachment DOWNLOAD through a share link (PRDCT-2278), the
 * sibling of share_token_views with the same privacy posture: NO IP, NO
 * geolocation, no referrer, no user agent — the link, the version served,
 * the file taken and when. `name` is the attachment's name (its path
 * relative to `downloads/`), or NULL when the recipient took the whole set
 * as one zip (one event, however many files it held). Written under the
 * same transaction that increments `share_tokens.download_count`, so the
 * count and the events never disagree; pruned by the same nightly retention
 * as the view events (VIEW_EVENTS_RETENTION_DAYS). `share_token_id` is
 * set-null so a link's history survives its deletion; deck deletion
 * cascades the rows away with the deck.
 */
export const shareTokenDownloads = pgTable(
  'share_token_downloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => presentations.id, { onDelete: 'cascade' }),
    shareTokenId: uuid('share_token_id').references(() => shareTokens.id, { onDelete: 'set null' }),
    /** The deck version the attachment(s) came from. */
    version: integer('version').notNull(),
    /** The attachment name (path relative to `downloads/`); NULL = the whole set as a zip. */
    name: text('name'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // Serves a per-token listing (occurred_at DESC, id DESC), the views precedent.
    index('share_token_downloads_token_occurred_id_idx').on(t.shareTokenId, t.occurredAt, t.id),
    // Serves the nightly retention purge's age scan.
    index('share_token_downloads_occurred_idx').on(t.occurredAt),
    // Serves the per-version counts on the version list (PRDCT-2308) and
    // the deck-deletion cascade (a FK gets no index on its own).
    index('share_token_downloads_presentation_version_idx').on(t.presentationId, t.version)
  ]
);

/**
 * Transient reservation for new-deck uploads (~1 h): mints the future
 * presentation id up front so asset uploads and the final commit share one
 * handle. `presentation_id` deliberately has NO foreign key — the
 * presentation row does not exist until the session's commit creates it.
 * `consumed_at` makes commits one-shot; a nightly purge deletes expired rows.
 */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // Serves the nightly purge (expires_at range scan).
    index('upload_sessions_expires_idx').on(t.expiresAt)
  ]
);

export type PresentationRow = typeof presentations.$inferSelect;
export type PresentationVersionRow = typeof presentationVersions.$inferSelect;
export type ShareTokenRow = typeof shareTokens.$inferSelect;
export type CollaboratorRow = typeof collaborators.$inferSelect;
export type PresentationProjectRow = typeof presentationProjects.$inferSelect;
export type AnnotationRow = typeof annotations.$inferSelect;
export type FormResponseRow = typeof formResponses.$inferSelect;
export type FormResponseVersionRow = typeof formResponseVersions.$inferSelect;
export type FormResponseFileRow = typeof formResponseFiles.$inferSelect;
export type FormResponseMailStateRow = typeof formResponseMailState.$inferSelect;
export type ShareTokenViewRow = typeof shareTokenViews.$inferSelect;
export type ShareTokenDownloadRow = typeof shareTokenDownloads.$inferSelect;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
