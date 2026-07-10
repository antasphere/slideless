import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

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
  telemetryEnabled: boolean('telemetry_enabled').notNull().default(false)
});

/**
 * Multi-workspace schema, single-workspace runtime: the template pins exactly
 * one workspace (created at setup), but every domain table carries a
 * workspace_id so products/cloud editions can widen without a schema rewrite.
 */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // Central-rail seam: many workspaces to one central account, later.
  centralAccountId: text('central_account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const workspaceRoles = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

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
    isActive: boolean('is_active').notNull().default(true),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
  },
  (t) => [
    uniqueIndex('workspace_members_workspace_user_uniq').on(t.workspaceId, t.userId),
    index('workspace_members_user_idx').on(t.userId),
    // Serves the admin API's keyset pagination (workspace_id, created_at DESC, id DESC).
    index('workspace_members_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id)
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
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
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
    index('api_keys_workspace_created_id_idx').on(t.workspaceId, t.createdAt, t.id)
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
 * Audit log: who did what to which resource, when, with which credential.
 * Append-only; bigint identity keeps inserts cheap on the hot path.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
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

export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type FileRow = typeof files.$inferSelect;
