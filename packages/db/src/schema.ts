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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { account, user } from './auth-schema.js';

// Better Auth owns the shape of user/session/account/verification (generated
// via @better-auth/cli, snapshot-checked in CI); everything below is domain.
export * from './auth-schema.js';

/**
 * Singleton instance row. Exactly one row (id = 'instance') exists after
 * first-boot setup; its presence is what makes POST /api/v1/setup return 410.
 * Inserted by the setup endpoint with ON CONFLICT DO NOTHING so concurrent
 * setup calls cannot both win.
 */
export const instanceSettings = pgTable('instance_settings', {
  id: text('id').primaryKey(), // always 'instance'
  instanceId: text('instance_id').notNull(), // ULID minted at setup; used in usage events + discovery
  name: text('name').notNull(),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }).notNull().defaultNow(),
  schemaVersion: integer('schema_version').notNull().default(1),
  telemetryEnabled: boolean('telemetry_enabled').notNull().default(false),
  /**
   * The EDITION this instance was set up as (R7 boot guard,
   * internal/federation.md). Boot refuses an env EDITION that differs unless
   * EDITION_CHANGE_ALLOWED=true re-stamps it — an edition flip under
   * existing users/workspaces silently changes identity semantics. The
   * default covers pre-column rows honestly: everything so far is oss.
   */
  edition: text('edition').notNull().default('oss'),
  /**
   * The user setup minted as the instance operator (CLOUD-3, PRDCT-1356).
   * On cloud the operator holds NO membership (every cloud workspace is a
   * hub projection), which made them structurally an orphan: the purge
   * deleted the only local credential and the only break-glass identity.
   * A durable record here excludes them from the sweep by construction —
   * not by an env allowlist the operator may never have set. NULL on
   * instances set up before this column existed.
   */
  operatorUserId: text('operator_user_id')
});

/**
 * Multi-workspace schema AND runtime (ADR 014): setup creates the FIRST
 * workspace, the cloud edition creates later ones through the registry's
 * WorkspaceService, and every request is scoped to exactly ONE workspace —
 * the one named by the presented credential. Every domain table carries a
 * workspace_id and every read/write filters on the principal's.
 */
export const workspaceHubStatuses = ['active', 'suspended'] as const;
export type WorkspaceHubStatus = (typeof workspaceHubStatuses)[number];

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // Central-rail seam: a projected workspace names the ONE hub org it
    // mirrors (cloud edition SSO, internal/federation.md); NULL = locally owned.
    centralAccountId: text('central_account_id'),
    /**
     * The hub-asserted org status, materialized locally so suspension is
     * readable inside the resolvers (visible-but-blocked). Written ONLY by
     * the cloud edition's hub reconcile; local workspaces and every oss row
     * stay 'active' forever.
     */
    hubStatus: text('hub_status', { enum: workspaceHubStatuses }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    // A hub org projects into AT MOST ONE workspace (migration 0021): two
    // concurrent first-logins into a fresh org race their inserts, and the
    // loser must land on the winner's row (ON CONFLICT + re-select in the
    // SSO projection) — never on a second projection of the same org.
    uniqueIndex('workspaces_central_account_uniq')
      .on(t.centralAccountId)
      .where(sql`${t.centralAccountId} IS NOT NULL`),
    check('workspaces_hub_status_check', sql`${t.hubStatus} IN ('active', 'suspended')`)
  ]
);

export const workspaceRoles = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

/**
 * Where a membership row came from — who its source of truth is (G2,
 * slideless-cloud-binding-plan §5). Pure data in Phase 1 (no enforcement):
 *
 *  - 'local': created by setup, workspace invitations, or admin surfaces —
 *    this instance owns it.
 *  - 'hub':   created/updated ONLY by the cloud edition's SSO JIT projection
 *    and re-asserted against the hub (Phase 3+); local surfaces never mint it.
 *  - 'guest': created by the collaborator claim path — an external party
 *    invited to ONE deck whose membership exists only because principal
 *    resolution requires one. Excluded from hub re-assertion; guest
 *    capability limits arrive in Phase 6.
 *
 * No backfill needed: pre-launch, no production data — the default covers
 * every existing row's honest origin.
 */
export const workspaceMemberOrigins = ['local', 'hub', 'guest'] as const;
export type WorkspaceMemberOrigin = (typeof workspaceMemberOrigins)[number];

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: workspaceRoles }).notNull().default('member'),
    origin: text('origin', { enum: workspaceMemberOrigins }).notNull().default('local'),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * The user's DEFAULT workspace marker (user-scoped credential model): a
     * request that names no workspace resolves here first, then falls back
     * to the deterministic oldest-active ordering. At most one row per user
     * (partial unique index). Nothing sets it locally yet — on cloud the hub
     * reconcile materializes the hub-level per-user default org into it; on
     * oss it stays false, so resolution is byte-identical to the pre-column
     * behavior.
     */
    isDefault: boolean('is_default').notNull().default(false),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('workspace_members_workspace_user_uniq').on(t.workspaceId, t.userId),
    index('workspace_members_user_idx').on(t.userId),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('workspace_members_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    // ONE default workspace per user, enforced by the database.
    uniqueIndex('workspace_members_user_default_uniq')
      .on(t.userId)
      .where(sql`${t.isDefault}`)
  ]
);

/**
 * Token-bearing invitations. Tokens are never stored — only their sha256 —
 * and the acceptance link always works without SMTP (copyable link).
 *
 * Two tokens per invitation, one row: `token_hash` is the admin-visible
 * copyable link (always returned by the create response), `email_token_hash`
 * is a SECOND token that appears ONLY in the invitation email. Accepting with
 * the emailed token proves control of the invited address (the admin never
 * saw it), so that accept path may honestly set `emailVerified`; accepting
 * with the copyable link proves nothing about the address. Nullable because
 * pre-existing invitations (and rows from products that disable the email
 * leg) have no emailed token.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: workspaceRoles }).notNull().default('member'),
    tokenHash: text('token_hash').notNull(),
    emailTokenHash: text('email_token_hash'),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('invitations_token_hash_uniq').on(t.tokenHash),
    uniqueIndex('invitations_email_token_hash_uniq').on(t.emailTokenHash),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('invitations_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    index('invitations_email_idx').on(t.email)
  ]
);

/**
 * API keys: `<prefix>_<keyId8>_<secret>`. keyId gives O(1) indexed lookup;
 * the secret is stored as sha256(secret + server pepper) and compared in
 * constant time. Minted by sessions only — a key never mints a key.
 *
 * A key is a USER credential (user-scoped credential model): it acts as its
 * creator, and the target workspace is chosen per request (X-Workspace-Id /
 * the user's default) against the creator's LIVE memberships. `workspace_id`
 * is an OPTIONAL PIN, not the identity: NULL (the mint default) = the key
 * reaches any workspace its creator is an active member of; a value pins the
 * key to that ONE workspace forever (least privilege — and the grandfathered
 * behavior of every key minted before the model change, which stays exactly
 * as issued).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull(),
    secretHash: text('secret_hash').notNull(),
    // Which pepper version hashed this key's secret (apps/server
    // apikeys/peppers.ts). Version 1 = the AUTH_SECRET-derived pepper that
    // hashed every key before versioning existed (hence the backfilling
    // default); higher versions come from API_KEY_PEPPERS. Resolution fails
    // closed on a version it cannot map.
    pepperVersion: smallint('pepper_version').notNull().default(1),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // null = never expires; enforced at resolution, normalized to revoked_at
    // by the nightly sweep. Deliberately unindexed: the sweep seq-scans a
    // tiny table once a night, and the hot path rides api_keys_key_id_uniq.
    expiresAt: timestamp('expires_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('api_keys_key_id_uniq').on(t.keyId),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('api_keys_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id),
    // Serves the own-keys listing (keys are user credentials: created_by,
    // created_at DESC, id DESC).
    index('api_keys_created_by_created_id_idx').on(t.createdBy, t.createdAt, t.id)
  ]
);

/**
 * Idempotency-Key replay store for the non-idempotent create POSTs. One row
 * per (workspace, user, client key): claimed (insert-first) before the
 * handler runs, then filled with the response so a retried create replays
 * instead of double-creating. The body is stored AES-256-GCM encrypted
 * (see apps/server middleware/idempotency.ts) because these responses carry
 * one-shot secrets — the full API key, the invitation accept token, the
 * reset link — whose plaintext is deliberately never persisted anywhere
 * else. Rows live 24h; a nightly purge deletes expired ones.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    // Both null while the first request is in flight; filled best-effort
    // once the handler's 2xx response is known.
    responseStatus: integer('response_status'),
    responseBodyEnc: text('response_body_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
  },
  (t) => [
    uniqueIndex('idempotency_keys_ws_user_key_uniq').on(t.workspaceId, t.userId, t.key),
    // Serves the nightly purge (expires_at range scan).
    index('idempotency_keys_expires_idx').on(t.expiresAt)
  ]
);

/**
 * One-time-use ledger for hub→tool exchange JWTs (`POST /sso/cli-connect`,
 * cloud edition only — internal/federation.md P5). The hub mints every 120 s
 * exchange token with a unique `jti`; consuming a token INSERTs its jti
 * here first, and the primary-key conflict IS the replay detection — a
 * replayed token inside its TTL loses the insert and is rejected before it
 * can mint a second key. Postgres-backed so the guard is MULTI-REPLICA
 * SAFE by construction (every replica races the same table), unlike any
 * in-memory set. Rows are inert once `expires_at` passes (the token itself
 * is expired then — the hub never re-mints a jti) and are swept
 * best-effort on later exchanges; the table stays tiny (rows live ~2 min,
 * arrivals are rate-limited), so the sweep needs no index.
 */
export const ssoConnectJtis = pgTable('sso_connect_jtis', {
  jti: text('jti').primaryKey(),
  /** The token's own `exp` — after this the row only documents history. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * The hub-grant PRESENTATION marker (PRDCT-1370, internal/federation.md
 * "Ambiguous refresh outcomes"): written by HubGrantService immediately
 * BEFORE it presents a user's refresh token to the hub's token endpoint,
 * cleared once the hub's answer is known (a rotation, or a definitive
 * refusal). A row that survives therefore means "this exact token was
 * presented and its answer never arrived" — a client-side timeout, a lost
 * response, a socket reset after the hub committed. The hub rotates BEFORE
 * it answers and cannot roll back, so blindly re-presenting that token
 * would trip the hub's RFC 9700 reuse detection and tear down the user's
 * whole (client, user) grant family, the CLI grant included. With the
 * marker in place the next refresh PROBES the token through the hub's
 * RFC 7662 introspection endpoint first (read-only: it never rotates and
 * never tears down) and only presents a token the hub still calls active.
 *
 * Keyed by the `account` row (one hub link per user); `refresh_token` is
 * the ciphertext presented, so a browser re-login that re-seeds the row
 * mid-flight invalidates the marker by construction (the ciphertext no
 * longer matches). Postgres-backed so every replica sees it — the refresh
 * lock is cross-replica, and so must the memory of an unanswered
 * presentation be.
 */
export const hubGrantPresentations = pgTable('hub_grant_presentations', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => account.id, { onDelete: 'cascade' }),
  /** The refresh-token CIPHERTEXT that was presented (matches account.refresh_token). */
  refreshToken: text('refresh_token').notNull(),
  presentedAt: timestamp('presented_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * TOOL-LOCAL first-run onboarding state (SL-6; written on the cloud
 * edition's SSO login path, read by /me). An APP domain table, not a
 * Better Auth column — no drift-guard involvement. The welcome-banner
 * decision reads ONLY this table and is RETRY-SAFE BY CONSTRUCTION:
 * `firstRunPending := NOT EXISTS (row WHERE dismissed_at IS NOT NULL)` —
 * the absence of a DISMISSAL means the welcome is still owed, so a
 * transiently-failed first-login insert self-heals on the next login and
 * only an explicit dismissal ever hides the banner. The hub's advisory
 * `tool_first_login` id_token claim is deliberately ignored for behavior
 * (the hub's user_tool_usage table stays the ECOSYSTEM analytics truth;
 * this table owns the banner). The deploy-time backfill migration inserts
 * DISMISSED rows for every pre-existing user — nobody gets a retroactive
 * welcome.
 */
export const userOnboarding = pgTable('user_onboarding', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** First observed login (informational; the banner keys on dismissed_at). */
  firstLoginAt: timestamp('first_login_at', { withTimezone: true }).notNull().defaultNow(),
  /** NULL = welcome still owed; set once by POST /me/onboarding/dismiss (or the backfill). */
  dismissedAt: timestamp('dismissed_at', { withTimezone: true })
});

/**
 * Audit log: who did what to which resource, when, with which credential.
 * Append-only; bigint identity keeps inserts cheap on the hot path.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    // NULL = INSTANCE-attributed: the event belongs to no workspace (ADR 014)
    // — e.g. the orphan-user purge, whose subjects have no workspace home.
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    actorVia: text('actor_via', { enum: ['session', 'api_key', 'oauth', 'system'] }).notNull(),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    requestId: text('request_id'),
    ip: text('ip'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('audit_log_workspace_created_idx').on(t.workspaceId, t.createdAt),
    // Serves the admin API's keyset pagination (workspace_id, id DESC).
    index('audit_log_workspace_id_idx').on(t.workspaceId, t.id),
    // Serves the nightly retention purge (created_at range scan across all
    // workspaces); the workspace-leading index above cannot.
    index('audit_log_created_idx').on(t.createdAt)
  ]
);

/**
 * File metadata over the content-addressed StorageDriver. Rows are
 * workspace-scoped; blobs are stored once per (workspace, sha256).
 *
 * `created_by` is nullable with `set null` on user delete (migration 0008):
 * files are WORKSPACE data, not the uploader's personal data — deleting the
 * account anonymizes the uploader (like audit_log.actor_user_id) while the
 * file stays with the workspace (ADR 006).
 */
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    originalName: text('original_name').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('files_workspace_sha_uniq').on(t.workspaceId, t.sha256),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('files_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id)
  ]
);

/**
 * Proof of possession: every user who has PUSHED these exact bytes into the
 * workspace, not just the first one (SL-B1 / ADR 013 on the blob surface).
 *
 * `files` is content-addressed and unique per (workspace, sha256), so a
 * second uploader of identical bytes deduplicates onto the FIRST uploader's
 * row and `files.created_by` keeps naming that first uploader. Once blob
 * reads are per-deck authorized, that single column is no longer a truthful
 * answer to "may this principal see these bytes": a member who uploaded a
 * shared logo that another member had uploaded first would be locked out of
 * a blob they demonstrably hold — and their version commit, which must only
 * bind shas they may read, would be refused. This table records each
 * distinct uploader so possession survives deduplication.
 *
 * `on delete cascade` on both sides: attribution is personal data (it dies
 * with the account, like the anonymized `files.created_by`) and carries no
 * value once the file row is gone.
 */
export const fileUploaders = pgTable(
  'file_uploaders',
  {
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.userId] }),
    // Serves the per-principal blob visibility probe (file_id + user_id is
    // the PK, so the lookup is the PK index; this one serves the reverse
    // "everything this user uploaded" direction the cascade delete walks).
    index('file_uploaders_user_idx').on(t.userId)
  ]
);

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
    index('presentations_workspace_owner_idx').on(t.workspaceId, t.ownerUserId, t.createdAt, t.id)
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('form_responses_secret_hash_uniq').on(t.responseSecretHash),
    // Serves the owner listing + keyset pagination (per deck, optionally per
    // form) AND the per-deck response-cap COUNT by prefix.
    index('form_responses_presentation_form_created_id_idx').on(
      t.presentationId,
      t.formName,
      t.createdAt,
      t.id
    ),
    index('form_responses_share_token_idx').on(t.shareTokenId)
  ]
);

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
    index('share_token_views_occurred_idx').on(t.occurredAt)
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
    index('share_token_downloads_occurred_idx').on(t.occurredAt)
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

export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type FileUploaderRow = typeof fileUploaders.$inferSelect;
export type PresentationRow = typeof presentations.$inferSelect;
export type PresentationVersionRow = typeof presentationVersions.$inferSelect;
export type ShareTokenRow = typeof shareTokens.$inferSelect;
export type CollaboratorRow = typeof collaborators.$inferSelect;
export type AnnotationRow = typeof annotations.$inferSelect;
export type FormResponseRow = typeof formResponses.$inferSelect;
export type ShareTokenViewRow = typeof shareTokenViews.$inferSelect;
export type ShareTokenDownloadRow = typeof shareTokenDownloads.$inferSelect;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
