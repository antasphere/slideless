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
