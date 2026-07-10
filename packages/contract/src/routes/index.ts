import { createRoute, z } from '@hono/zod-openapi';
import { apiErrorSchema, cursorPageQuerySchema } from '../schemas/common.js';
import { instanceInfoSchema } from '../schemas/instance.js';
import { setupRequestSchema, setupResponseSchema } from '../schemas/setup.js';
import { meResponseSchema } from '../schemas/me.js';
import {
  memberChangeEmailLinkRequestSchema,
  memberChangeEmailLinkSchema,
  memberResetLinkSchema,
  membersListSchema,
  memberSchema,
  memberUpdateSchema
} from '../schemas/members.js';
import {
  apiKeyCreatedSchema,
  apiKeyCreateSchema,
  apiKeySchema,
  apiKeysListSchema
} from '../schemas/api-keys.js';
import {
  invitationAcceptedSchema,
  invitationAcceptSchema,
  invitationCreatedSchema,
  invitationCreateSchema,
  invitationLookupSchema,
  invitationsListSchema
} from '../schemas/invitations.js';
import { auditListSchema } from '../schemas/audit.js';
import {
  breakGlassClaimOwnershipRequestSchema,
  breakGlassClaimOwnershipSchema,
  breakGlassResetTwoFactorRequestSchema,
  breakGlassResetTwoFactorSchema
} from '../schemas/break-glass.js';
import { fileSchema, filesListSchema, fileUploadedSchema, fileUploadQuerySchema } from '../schemas/files.js';
import {
  assetPrecheckRequestSchema,
  assetPrecheckResponseSchema,
  assetUploadFormSchema,
  assetUploadedSchema,
  presentationSchema,
  presentationsListSchema,
  presentationVersionDetailSchema,
  presentationVersionsListSchema,
  sha256Schema,
  uploadSessionCommitSchema,
  uploadSessionCreatedSchema,
  versionCommitSchema,
  versionCommittedSchema
} from '../schemas/presentations.js';
import {
  shareTokenCreatedSchema,
  shareTokenCreateSchema,
  shareTokenSchema,
  shareTokenSendSchema,
  shareTokenSentSchema,
  shareTokensListSchema,
  shareTokenUpdateSchema
} from '../schemas/share-tokens.js';
import {
  collaboratorInvitedSchema,
  collaboratorInviteSchema,
  collaboratorSchema,
  collaboratorsListSchema
} from '../schemas/collaborators.js';
import {
  annotationCreateSchema,
  annotationSchema,
  annotationsListQuerySchema,
  annotationsListSchema,
  annotationUpdateSchema
} from '../schemas/annotations.js';

/**
 * Server-only entry: route contracts for @hono/zod-openapi. Importing this
 * path pulls Hono — the dashboard and SDK must import the package root
 * instead. The OpenAPI document at /api/v1/openapi.json is generated from
 * these definitions; they are the single source of truth for the API shape.
 */

const jsonBody = <T>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description
});

export const errorResponses = {
  400: jsonBody(apiErrorSchema, 'Validation error'),
  401: jsonBody(apiErrorSchema, 'Not authenticated'),
  403: jsonBody(apiErrorSchema, 'Not authorized'),
  404: jsonBody(apiErrorSchema, 'Not found'),
  410: jsonBody(apiErrorSchema, 'Gone'),
  429: jsonBody(apiErrorSchema, 'Rate limited'),
  500: jsonBody(apiErrorSchema, 'Internal error')
} as const;

/** Opt-in retry-safe creates: replay-or-409 semantics per docs/security.md. */
const idempotencyHeaders = z.object({
  'idempotency-key': z.string().min(1).max(200).optional()
});

/**
 * Every `{id}` path param is a UUID, validated in the contract: a non-UUID
 * id answers a clean 400 validation_error instead of reaching Postgres and
 * surfacing its uuid-cast error as a sanitized 500 (see LESSONS.md).
 */
const uuidParams = z.object({ id: z.uuid() });

export const instanceRoute = createRoute({
  method: 'get',
  path: '/instance',
  tags: ['instance'],
  summary: 'Instance discovery (unauthenticated, cacheable)',
  responses: {
    200: jsonBody(instanceInfoSchema, 'Instance descriptor')
  }
});

export const setupRoute = createRoute({
  method: 'post',
  path: '/setup',
  tags: ['instance'],
  summary: 'One-shot first-boot setup: create the owner and the workspace',
  request: {
    body: jsonBody(setupRequestSchema, 'Setup payload')
  },
  responses: {
    201: jsonBody(setupResponseSchema, 'Instance initialized'),
    400: errorResponses[400],
    403: errorResponses[403],
    410: errorResponses[410],
    500: errorResponses[500]
  }
});

export const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['auth'],
  summary: 'Resolved identity of the calling principal',
  responses: {
    200: jsonBody(meResponseSchema, 'The caller identity'),
    401: errorResponses[401]
  }
});

// ── Members ──────────────────────────────────────────────────────────────────

export const membersListRoute = createRoute({
  method: 'get',
  path: '/members',
  tags: ['members'],
  summary: 'List workspace members (cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: { 200: jsonBody(membersListSchema, 'Members, newest first'), 401: errorResponses[401] }
});

export const memberUpdateRoute = createRoute({
  method: 'patch',
  path: '/members/{id}',
  tags: ['members'],
  summary: 'Change a member role or active state (admin+)',
  request: {
    params: uuidParams,
    body: jsonBody(memberUpdateSchema, 'Fields to change')
  },
  responses: {
    200: jsonBody(memberSchema, 'Updated member'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const memberDeleteRoute = createRoute({
  method: 'delete',
  path: '/members/{id}',
  tags: ['members'],
  summary: 'Delete a member account (admin+; sessions only — files they uploaded stay)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(memberSchema, 'Deleted member (final snapshot)'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const memberResetLinkRoute = createRoute({
  method: 'post',
  path: '/members/{id}/reset-link',
  tags: ['members'],
  summary: 'Generate a one-time password reset link for a member (admin+)',
  request: { params: uuidParams, headers: idempotencyHeaders },
  responses: {
    200: jsonBody(memberResetLinkSchema, 'Copyable reset link + expiry'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Idempotency conflict')
  }
});

export const memberChangeEmailLinkRoute = createRoute({
  method: 'post',
  path: '/members/{id}/change-email-link',
  tags: ['members'],
  summary: 'Generate a one-time email change link for a member (admin+; the link also signs them in)',
  request: {
    params: uuidParams,
    body: jsonBody(memberChangeEmailLinkRequestSchema, 'The new email address'),
    headers: idempotencyHeaders
  },
  responses: {
    200: jsonBody(memberChangeEmailLinkSchema, 'Copyable email change link + expiry'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Email already in use (email_taken) or idempotency conflict')
  }
});

// ── API keys ─────────────────────────────────────────────────────────────────

export const apiKeysListRoute = createRoute({
  method: 'get',
  path: '/api-keys',
  tags: ['api-keys'],
  summary: 'List API keys (admins see all, members their own; cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: { 200: jsonBody(apiKeysListSchema, 'API keys, newest first'), 401: errorResponses[401] }
});

export const apiKeyCreateRoute = createRoute({
  method: 'post',
  path: '/api-keys',
  tags: ['api-keys'],
  summary: 'Mint an API key (sessions only — a key never mints a key)',
  request: { body: jsonBody(apiKeyCreateSchema, 'Key name and scopes'), headers: idempotencyHeaders },
  responses: {
    201: jsonBody(apiKeyCreatedSchema, 'Created; the full key appears only here'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: jsonBody(apiErrorSchema, 'Idempotency conflict')
  }
});

export const apiKeyRevokeRoute = createRoute({
  method: 'delete',
  path: '/api-keys/{id}',
  tags: ['api-keys'],
  summary: 'Revoke an API key (its creator or an admin)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(apiKeySchema, 'Revoked key'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

// ── Invitations ──────────────────────────────────────────────────────────────

export const invitationsListRoute = createRoute({
  method: 'get',
  path: '/invitations',
  tags: ['invitations'],
  summary: 'List invitations (admin+, cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(invitationsListSchema, 'Invitations, newest first'),
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

export const invitationCreateRoute = createRoute({
  method: 'post',
  path: '/invitations',
  tags: ['invitations'],
  summary: 'Invite by email (admin+). Always returns a copyable accept link.',
  request: { body: jsonBody(invitationCreateSchema, 'Invitee'), headers: idempotencyHeaders },
  responses: {
    201: jsonBody(invitationCreatedSchema, 'Invitation + copyable link'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: jsonBody(apiErrorSchema, 'Already a member, already invited, or idempotency conflict')
  }
});

export const invitationRevokeRoute = createRoute({
  method: 'delete',
  path: '/invitations/{id}',
  tags: ['invitations'],
  summary: 'Revoke an open invitation (admin+)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(invitationSchemaRef(), 'Revoked invitation'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const invitationLookupRoute = createRoute({
  method: 'get',
  path: '/invitations/lookup',
  tags: ['invitations'],
  summary: 'Resolve an invitation token (public; drives the accept page)',
  request: { query: z.object({ token: z.string().min(16) }) },
  responses: {
    200: jsonBody(invitationLookupSchema, 'Invitation context'),
    404: errorResponses[404]
  }
});

export const invitationAcceptRoute = createRoute({
  method: 'post',
  path: '/invitations/accept',
  tags: ['invitations'],
  summary: 'Accept an invitation (public: creates the account when needed)',
  request: { body: jsonBody(invitationAcceptSchema, 'Token + credentials for new accounts') },
  responses: {
    200: jsonBody(invitationAcceptedSchema, 'Joined the workspace'),
    400: errorResponses[400],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Account exists — sign in to accept'),
    410: errorResponses[410]
  }
});

// ── Workspace ────────────────────────────────────────────────────────────────

export const workspaceExportRoute = createRoute({
  method: 'get',
  path: '/workspace/export',
  tags: ['workspace'],
  summary: 'Full workspace export as a streamed zip (admin+; keys need data:export)',
  responses: {
    // Deliberately NO `content` key on the 200: that is what lets the
    // api.openapi handler legally return a plain streamed Response.
    200: { description: 'Zip archive stream (application/zip)' },
    401: errorResponses[401],
    403: errorResponses[403],
    429: errorResponses[429]
  }
});

// ── Break-glass (superadmin recovery, ADR 010) ──────────────────────────────
// Session-only by construction: both paths are deliberately UNLISTED in the
// machine scope allowlist (middleware/scopes.ts), so API keys and OAuth
// tokens 403 fail-closed. The handlers additionally resolve the Better Auth
// session directly and require a verified email on the SUPERADMIN_EMAILS
// allowlist — no membership required (the recovering operator may have none).

export const breakGlassClaimOwnershipRoute = createRoute({
  method: 'post',
  path: '/admin/break-glass/claim-ownership',
  tags: ['admin'],
  summary:
    'Break-glass: make the calling superadmin (or a named existing user) an ACTIVE OWNER of the workspace (superadmin sessions only; adds an owner, never removes one)',
  request: {
    body: jsonBody(breakGlassClaimOwnershipRequestSchema, 'Optional target user (default: the caller)')
  },
  responses: {
    200: jsonBody(breakGlassClaimOwnershipSchema, 'The recovered owner membership'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Instance not set up yet (not_setup)'),
    429: errorResponses[429]
  }
});

export const breakGlassResetTwoFactorRoute = createRoute({
  method: 'post',
  path: '/admin/break-glass/reset-2fa',
  tags: ['admin'],
  summary: "Break-glass: clear a locked-out user's 2FA (superadmin sessions only, audited)",
  request: {
    body: jsonBody(breakGlassResetTwoFactorRequestSchema, 'The target user')
  },
  responses: {
    200: jsonBody(breakGlassResetTwoFactorSchema, '2FA cleared (idempotent)'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Instance not set up yet (not_setup)'),
    429: errorResponses[429]
  }
});

// ── Audit ────────────────────────────────────────────────────────────────────

export const auditListRoute = createRoute({
  method: 'get',
  path: '/audit',
  tags: ['audit'],
  summary: 'Read the audit log (admin+, cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(auditListSchema, 'Audit entries, newest first'),
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

// Local alias to keep the revoke route readable without a forward reference.
function invitationSchemaRef() {
  return invitationsListSchema.shape.invitations.element;
}

// ── Files ────────────────────────────────────────────────────────────────────

export const filesListRoute = createRoute({
  method: 'get',
  path: '/files',
  tags: ['files'],
  summary: 'List files in the workspace (cursor-paginated)',
  request: { query: cursorPageQuerySchema },
  responses: { 200: jsonBody(filesListSchema, 'Files, newest first'), 401: errorResponses[401] }
});

export const fileGetRoute = createRoute({
  method: 'get',
  path: '/files/{id}',
  tags: ['files'],
  summary: 'File metadata',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(fileSchema, 'File'),
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

export const fileUploadRoute = createRoute({
  method: 'post',
  path: '/files',
  tags: ['files'],
  summary: 'Upload raw bytes (streamed; content-type header = file type)',
  request: {
    query: fileUploadQuerySchema,
    body: {
      content: { 'application/octet-stream': { schema: z.any() } },
      description: 'The file bytes'
    }
  },
  responses: {
    201: jsonBody(fileUploadedSchema, 'Stored (content-addressed, idempotent per workspace)'),
    401: errorResponses[401],
    403: errorResponses[403],
    413: jsonBody(apiErrorSchema, 'Payload exceeds the instance size cap'),
    400: errorResponses[400]
  }
});

export const fileDeleteRoute = createRoute({
  method: 'delete',
  path: '/files/{id}',
  tags: ['files'],
  summary: 'Delete a file (metadata soft-deleted, blob removed)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(fileSchema, 'Deleted file'),
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

// ═══ Presentation domain (ADR 011) ═══════════════════════════════════════════
//
// The contract below is FROZEN shape-first: Phase 3 (upload/versioning),
// Phase 4 (sharing/viewer) and Phase 5 (collaborators/annotations) implement
// the handlers. Until then the registered stubs answer the 501 declared on
// each route — implementers delete that entry as they land the handler.
//
// PUBLIC VIEWER (Phase 4) — path shape reserved, deliberately NOT part of
// /api/v1 (token recipients are not principals):
//   GET  /v/{secret}            → viewer entry (path-carried secret; no ?token= legacy)
//   GET  /v/{secret}/{path...}  → deck asset relative to the version manifest
//   POST /api/v1/viewer/*       → token-session surface (annotation create/list),
//                                 authenticated by the share-token secret, never
//                                 by this file's principal machinery.

const notImplemented = jsonBody(apiErrorSchema, 'Not implemented yet — arrives in a later build phase');

/** Two-level params: `{id}` is always the presentation. */
const tokenParams = z.object({ id: z.uuid(), tokenId: z.uuid() });
const collaboratorParams = z.object({ id: z.uuid(), collaboratorId: z.uuid() });
const annotationParams = z.object({ id: z.uuid(), annotationId: z.uuid() });
const versionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) });
const assetParams = z.object({ id: z.uuid(), sha256: sha256Schema });

// ── Presentations ────────────────────────────────────────────────────────────

export const presentationsListRoute = createRoute({
  method: 'get',
  path: '/presentations',
  tags: ['presentations'],
  summary: 'List presentations in the workspace (cursor-paginated, newest first)',
  request: { query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(presentationsListSchema, 'Presentations, newest first'),
    401: errorResponses[401],
    501: notImplemented
  }
});

export const presentationGetRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}',
  tags: ['presentations'],
  summary: 'Presentation metadata',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(presentationSchema, 'Presentation'),
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const presentationDeleteRoute = createRoute({
  method: 'delete',
  path: '/presentations/{id}',
  tags: ['presentations'],
  summary: 'Delete a presentation (soft delete; versions and tokens stop resolving)',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(presentationSchema, 'Deleted presentation (final snapshot)'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    501: notImplemented
  }
});

// ── Upload (push) ────────────────────────────────────────────────────────────

export const uploadSessionCreateRoute = createRoute({
  method: 'post',
  path: '/presentations/uploads',
  tags: ['upload'],
  summary: 'Reserve a new-deck upload session (~1 h): mints the future presentation id',
  request: { headers: idempotencyHeaders },
  responses: {
    201: jsonBody(uploadSessionCreatedSchema, 'Upload session reserved'),
    401: errorResponses[401],
    403: errorResponses[403],
    409: jsonBody(apiErrorSchema, 'Idempotency conflict'),
    501: notImplemented
  }
});

export const assetPrecheckRoute = createRoute({
  method: 'post',
  path: '/presentations/precheck',
  tags: ['upload'],
  summary: 'Which blobs are missing from the workspace (content-addressed dedupe)',
  request: { body: jsonBody(assetPrecheckRequestSchema, 'Candidate sha256 list') },
  responses: {
    200: jsonBody(assetPrecheckResponseSchema, 'Hashes to upload'),
    400: errorResponses[400],
    401: errorResponses[401],
    501: notImplemented
  }
});

export const assetUploadRoute = createRoute({
  method: 'post',
  path: '/presentations/assets',
  tags: ['upload'],
  summary: 'Upload one deck asset (multipart; server re-hashes and rejects a sha256 mismatch)',
  request: {
    body: {
      content: { 'multipart/form-data': { schema: assetUploadFormSchema } },
      description: 'Fields: `sha256` (claimed content address) + `file` (the bytes)'
    }
  },
  responses: {
    201: jsonBody(assetUploadedSchema, 'Stored (content-addressed, idempotent per workspace)'),
    400: jsonBody(apiErrorSchema, 'Hash mismatch or malformed form'),
    401: errorResponses[401],
    403: errorResponses[403],
    413: jsonBody(apiErrorSchema, 'Payload exceeds the instance size cap'),
    501: notImplemented
  }
});

export const uploadSessionCommitRoute = createRoute({
  method: 'post',
  path: '/presentations/uploads/{id}/commit',
  tags: ['upload'],
  summary: 'Commit an upload session: creates the deck and its version 1 (one-shot)',
  request: {
    params: uuidParams,
    body: jsonBody(uploadSessionCommitSchema, 'Deck metadata + version-1 manifest')
  },
  responses: {
    201: jsonBody(versionCommittedSchema, 'Deck created at version 1'),
    400: jsonBody(apiErrorSchema, 'Validation error or manifest references missing blobs'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Session already consumed'),
    410: jsonBody(apiErrorSchema, 'Session expired'),
    501: notImplemented
  }
});

export const versionCommitRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/versions',
  tags: ['upload'],
  summary: 'Commit a new immutable version (optimistic concurrency via expectedBaseVersion)',
  request: {
    params: uuidParams,
    body: jsonBody(versionCommitSchema, 'Manifest + expectedBaseVersion')
  },
  responses: {
    201: jsonBody(versionCommittedSchema, 'Version committed; currentVersion advanced'),
    400: jsonBody(apiErrorSchema, 'Validation error or manifest references missing blobs'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'version_conflict: expectedBaseVersion is stale — pull and retry'),
    501: notImplemented
  }
});

// ── Pull ─────────────────────────────────────────────────────────────────────

export const versionsListRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/versions',
  tags: ['presentations'],
  summary: 'List versions of a presentation (cursor-paginated, newest first; no manifests)',
  request: { params: uuidParams, query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(presentationVersionsListSchema, 'Versions, newest first'),
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const versionGetRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/versions/{version}',
  tags: ['presentations'],
  summary: 'One version including its full manifest (path → sha256)',
  request: { params: versionParams },
  responses: {
    200: jsonBody(presentationVersionDetailSchema, 'Version + manifest'),
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const assetDownloadRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/assets/{sha256}',
  tags: ['presentations'],
  summary: 'Download one deck blob by content address (attachment + nosniff)',
  request: { params: assetParams },
  responses: {
    // Deliberately NO `content` key on the 200 (workspace-export precedent):
    // the handler returns a plain streamed Response.
    200: { description: 'Asset bytes (streamed)' },
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

// ── Sharing ──────────────────────────────────────────────────────────────────

export const shareTokensListRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/tokens',
  tags: ['sharing'],
  summary: 'List share tokens of a presentation (cursor-paginated)',
  request: { params: uuidParams, query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(shareTokensListSchema, 'Share tokens, newest first'),
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const shareTokenCreateRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/tokens',
  tags: ['sharing'],
  summary: 'Create a per-recipient share token (the secret + viewer URL appear only here)',
  request: {
    params: uuidParams,
    body: jsonBody(shareTokenCreateSchema, 'Recipient label + access options'),
    headers: idempotencyHeaders
  },
  responses: {
    201: jsonBody(shareTokenCreatedSchema, 'Created; secret shown once, never retrievable'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Idempotency conflict'),
    501: notImplemented
  }
});

export const shareTokenUpdateRoute = createRoute({
  method: 'patch',
  path: '/presentations/{id}/tokens/{tokenId}',
  tags: ['sharing'],
  summary: 'Update a share token: pin/unpin version, rename, annotate flag, expiry, password',
  request: {
    params: tokenParams,
    body: jsonBody(shareTokenUpdateSchema, 'Fields to change (null clears expiry/password)')
  },
  responses: {
    200: jsonBody(shareTokenSchema, 'Updated share token'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const shareTokenRevokeRoute = createRoute({
  method: 'delete',
  path: '/presentations/{id}/tokens/{tokenId}',
  tags: ['sharing'],
  summary: 'Revoke a share token (soft — access stats survive)',
  request: { params: tokenParams },
  responses: {
    200: jsonBody(shareTokenSchema, 'Revoked share token'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const shareTokenSendRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/tokens/{tokenId}/send',
  tags: ['sharing'],
  summary: 'Email the viewer link to a recipient (best-effort on top of the copyable URL)',
  request: {
    params: tokenParams,
    body: jsonBody(shareTokenSendSchema, 'Recipient email + optional note')
  },
  responses: {
    200: jsonBody(shareTokenSentSchema, 'Delivery attempted; emailSent says whether mail went out'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    501: notImplemented
  }
});

// ── Collaborators ────────────────────────────────────────────────────────────

export const collaboratorsListRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/collaborators',
  tags: ['collaborators'],
  summary: 'List collaborators of a presentation (cursor-paginated)',
  request: { params: uuidParams, query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(collaboratorsListSchema, 'Collaborators, newest first'),
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const collaboratorInviteRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/collaborators',
  tags: ['collaborators'],
  summary: 'Invite a dev collaborator by email (always returns a copyable claim link)',
  request: {
    params: uuidParams,
    body: jsonBody(collaboratorInviteSchema, 'Invitee email'),
    headers: idempotencyHeaders
  },
  responses: {
    201: jsonBody(collaboratorInvitedSchema, 'Grant created + claim link'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Already a collaborator, or idempotency conflict'),
    501: notImplemented
  }
});

export const collaboratorRemoveRoute = createRoute({
  method: 'delete',
  path: '/presentations/{id}/collaborators/{collaboratorId}',
  tags: ['collaborators'],
  summary: 'Revoke a collaborator grant (pending or active)',
  request: { params: collaboratorParams },
  responses: {
    200: jsonBody(collaboratorSchema, 'Revoked grant'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    501: notImplemented
  }
});

// ── Annotations (owner surface; the token-session surface ships with Phase 4) ─

export const annotationsListRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/annotations',
  tags: ['annotations'],
  summary: 'List annotations of a presentation (filter by version/status; cursor-paginated)',
  request: { params: uuidParams, query: annotationsListQuerySchema },
  responses: {
    200: jsonBody(annotationsListSchema, 'Annotations, newest first'),
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const annotationCreateRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/annotations',
  tags: ['annotations'],
  summary: 'Create an annotation as a signed-in principal (owner/dev note on a version)',
  request: {
    params: uuidParams,
    body: jsonBody(annotationCreateSchema, 'Version + anchor + note')
  },
  responses: {
    201: jsonBody(annotationSchema, 'Created annotation'),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const annotationUpdateRoute = createRoute({
  method: 'patch',
  path: '/presentations/{id}/annotations/{annotationId}',
  tags: ['annotations'],
  summary: 'Update an annotation (edit body, resolve/reopen)',
  request: {
    params: annotationParams,
    body: jsonBody(annotationUpdateSchema, 'Fields to change')
  },
  responses: {
    200: jsonBody(annotationSchema, 'Updated annotation'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const annotationDeleteRoute = createRoute({
  method: 'delete',
  path: '/presentations/{id}/annotations/{annotationId}',
  tags: ['annotations'],
  summary: 'Delete an annotation',
  request: { params: annotationParams },
  responses: {
    200: jsonBody(annotationSchema, 'Deleted annotation (final snapshot)'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    501: notImplemented
  }
});

export const annotationsInboxRoute = createRoute({
  method: 'get',
  path: '/annotations',
  tags: ['annotations'],
  summary: 'Workspace-wide annotation inbox (all decks; filter by status; cursor-paginated)',
  request: { query: annotationsListQuerySchema },
  responses: {
    200: jsonBody(annotationsListSchema, 'Annotations across the workspace, newest first'),
    401: errorResponses[401],
    501: notImplemented
  }
});
