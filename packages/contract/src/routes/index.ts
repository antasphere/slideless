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
import { oauthConsentWorkspaceRequestSchema, oauthConsentWorkspaceSchema } from '../schemas/oauth.js';
import {
  cliAuthCompletedSchema,
  cliAuthCompleteSchema,
  cliAuthRequestedSchema,
  cliAuthRequestSchema
} from '../schemas/cli-auth.js';
import { ssoCliConnectSchema } from '../schemas/sso-connect.js';
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
  previewTokenCreateSchema,
  shareTokenCreatedSchema,
  shareTokenCreateSchema,
  shareTokenSchema,
  shareTokenSendSchema,
  shareTokenSentSchema,
  shareTokensListSchema,
  shareTokenUpdateSchema
} from '../schemas/share-tokens.js';
import {
  collaboratorClaimedSchema,
  collaboratorClaimSchema,
  collaboratorInvitedSchema,
  collaboratorInviteSchema,
  collaboratorLookupSchema,
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

/**
 * JSON REQUEST bodies are marked `required` so @hono/zod-openapi always runs
 * the body validator. Without the flag, a request with a missing/non-JSON
 * content-type SKIPS validation entirely and hands the handler `{}` cast as
 * the body type — a guaranteed TypeError → 500 on every pre-auth body route
 * (the schema-mismatch 400 path never runs). Responses keep plain jsonBody
 * (`required` is not a response-object field).
 */
const jsonRequestBody = <T>(schema: T, description: string) => ({
  ...jsonBody(schema, description),
  required: true
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
    body: jsonRequestBody(setupRequestSchema, 'Setup payload')
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
    body: jsonRequestBody(memberUpdateSchema, 'Fields to change')
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
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Account belongs to other workspaces (member_of_other_workspaces)')
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
    body: jsonRequestBody(memberChangeEmailLinkRequestSchema, 'The new email address'),
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
  request: { body: jsonRequestBody(apiKeyCreateSchema, 'Key name and scopes'), headers: idempotencyHeaders },
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
  request: { body: jsonRequestBody(invitationCreateSchema, 'Invitee'), headers: idempotencyHeaders },
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
  request: { body: jsonRequestBody(invitationAcceptSchema, 'Token + credentials for new accounts') },
  responses: {
    200: jsonBody(invitationAcceptedSchema, 'Joined the workspace'),
    400: errorResponses[400],
    403: jsonBody(apiErrorSchema, 'Workspace membership is hub-managed (hub_managed, cloud edition)'),
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Account exists — sign in to accept'),
    410: errorResponses[410]
  }
});

// ── OAuth consent workspace (ADR 014) ───────────────────────────────────────
// Session-only by construction: deliberately UNLISTED in the machine scope
// allowlist (middleware/scopes.ts) so keys/tokens 403 fail-closed, and the
// handler additionally refuses non-session principals. Uniform 403 whether
// the workspace does not exist or the caller is not an active member — no
// oracle about other workspaces.

export const oauthConsentWorkspaceRoute = createRoute({
  method: 'post',
  path: '/oauth/consent-workspace',
  tags: ['auth'],
  summary: 'Choose which workspace the upcoming OAuth consent binds (sessions only, ~10 min)',
  request: {
    body: jsonRequestBody(oauthConsentWorkspaceRequestSchema, 'The chosen workspace')
  },
  responses: {
    200: jsonBody(oauthConsentWorkspaceSchema, 'Selection parked for this session'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403]
  }
});

// ── CLI auth (browserless email-OTP → API key) ──────────────────────────────
// PUBLIC pre-auth endpoints like /setup: listed in PUBLIC_API_PATHS
// (middleware/auth-context.ts) and deliberately UNLISTED in the machine
// scope allowlist — a key/token presented here is pointless anyway (the flow
// EXISTS to obtain a key) and 403s fail-closed. Sign-up stays closed: the
// flow rides the emailOTP plugin's disableSignUp, so codes only sign in
// EXISTING accounts. Both endpoints are rate-limited (request: the OTP wall
// per IP + email; complete: the login wall per IP + email) and OTP
// verification is better-auth's atomic, attempt-limited (3) check.

export const cliAuthRequestRoute = createRoute({
  method: 'post',
  path: '/cli/auth/request',
  tags: ['cli-auth'],
  summary: 'Send a sign-in code to an email (public; generic success — no account enumeration)',
  request: { body: jsonRequestBody(cliAuthRequestSchema, 'The account email') },
  responses: {
    200: jsonBody(cliAuthRequestedSchema, 'Code sent if the account exists'),
    400: jsonBody(apiErrorSchema, 'Validation error, or no email driver (otp_unavailable)'),
    429: errorResponses[429],
    500: errorResponses[500]
  }
});

export const cliAuthCompleteRoute = createRoute({
  method: 'post',
  path: '/cli/auth/complete',
  tags: ['cli-auth'],
  summary: 'Verify a sign-in code and mint an API key (shown once, presentations:read+write)',
  request: { body: jsonRequestBody(cliAuthCompleteSchema, 'Email + code (+ optional key name/TTL)') },
  responses: {
    201: jsonBody(cliAuthCompletedSchema, 'Key minted; the full key appears only here'),
    400: jsonBody(apiErrorSchema, 'Validation error, or no email driver (otp_unavailable)'),
    401: jsonBody(apiErrorSchema, 'invalid_otp: wrong/expired code or no such account'),
    403: jsonBody(apiErrorSchema, 'two_factor_required or no active workspace membership'),
    429: jsonBody(apiErrorSchema, 'Too many attempts'),
    500: errorResponses[500]
  }
});

// ── CLI cross-tool connect (cloud edition only) ─────────────────────────────
// PUBLIC pre-auth endpoint like /cli/auth/* (listed in PUBLIC_API_PATHS,
// unlisted in the machine scope allowlist): the hub-minted 120 s exchange
// JWT IS the credential — verified against the hub JWKS with hard iss/aud
// pinning, `purpose: 'sso-connect'` required, and the `jti` consumed
// one-time-use (a replay inside the TTL mints nothing). On success the user
// is JIT-provisioned through the SAME projection path as an SSO login and
// an ordinary `slk_` key is minted, bound to the projected workspace. The
// route exists ONLY on EDITION=cloud; oss answers 404. Rate-limited (the
// login wall, per IP).

export const ssoCliConnectRoute = createRoute({
  method: 'post',
  path: '/sso/cli-connect',
  tags: ['sso'],
  summary: 'Exchange a hub-minted connect JWT for an API key (cloud edition; shown once)',
  request: { body: jsonRequestBody(ssoCliConnectSchema, 'The hub exchange token') },
  responses: {
    201: jsonBody(cliAuthCompletedSchema, 'Key minted; the full key appears only here'),
    400: jsonBody(apiErrorSchema, 'Validation error'),
    401: jsonBody(apiErrorSchema, 'invalid_token: bad signature/iss/aud/purpose, expired, or replayed jti'),
    403: jsonBody(apiErrorSchema, 'Provisioning refused (identity/email conflict, link refused)'),
    429: errorResponses[429],
    500: errorResponses[500]
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
    'Break-glass: make the calling superadmin (or a named existing user) an ACTIVE OWNER of a workspace (superadmin sessions only; adds an owner, never removes one; workspaceId required once the instance has several)',
  request: {
    body: jsonRequestBody(
      breakGlassClaimOwnershipRequestSchema,
      'Optional target user (default: the caller) and target workspace (required with several workspaces)'
    )
  },
  responses: {
    200: jsonBody(breakGlassClaimOwnershipSchema, 'The recovered owner membership'),
    400: jsonBody(
      apiErrorSchema,
      'Validation error, or several workspaces and none named (workspace_required)'
    ),
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
    body: jsonRequestBody(breakGlassResetTwoFactorRequestSchema, 'The target user')
  },
  responses: {
    200: jsonBody(breakGlassResetTwoFactorSchema, '2FA cleared (idempotent)'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
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
    404: errorResponses[404],
    // ADR 011 blob-delete guard: a blob referenced by any live presentation
    // version manifest is not deletable through the generic files surface.
    409: jsonBody(apiErrorSchema, 'file_in_use: referenced by a presentation version')
  }
});

// ═══ Presentation domain (ADR 011) ═══════════════════════════════════════════
//
// The contract below is FROZEN shape-first and fully LIVE: Phase 3
// (upload/versioning), Phase 4 (sharing + the public viewer), and Phase 5
// (collaborators/annotations) are all implemented.
//
// PUBLIC VIEWER (Phase 4 — LIVE, apps/server/src/viewer/routes.ts),
// deliberately NOT part of /api/v1 (token recipients are not principals):
//   GET  /v/{secret}            → viewer entry (path-carried secret; no ?token= legacy)
//   GET  /v/{secret}/{path...}  → deck asset relative to the version manifest
//   POST /v/{secret}            → password-gate unlock (browser form)
//
// TOKEN-SESSION ANNOTATION SURFACE (Phase 5 — LIVE,
// apps/server/src/viewer/annotations-api.ts), authenticated by the
// share-token secret (never by this file's principal machinery), CORS-open
// because the caller is the injected overlay inside the sandboxed OPAQUE
// origin (ADR 012). Deliberately outside this OpenAPI contract — it is not
// an agent surface:
//   GET  /api/v1/viewer/{secret}/annotations → this token's notes on the resolved version
//   POST /api/v1/viewer/{secret}/annotations → create a note (can_annotate tokens only)

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
    401: errorResponses[401]
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
    404: errorResponses[404]
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
    404: errorResponses[404]
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
    409: jsonBody(apiErrorSchema, 'Idempotency conflict')
  }
});

export const assetPrecheckRoute = createRoute({
  method: 'post',
  path: '/presentations/precheck',
  tags: ['upload'],
  summary: 'Which blobs are missing from the workspace (content-addressed dedupe)',
  request: { body: jsonRequestBody(assetPrecheckRequestSchema, 'Candidate sha256 list') },
  responses: {
    200: jsonBody(assetPrecheckResponseSchema, 'Hashes to upload'),
    400: errorResponses[400],
    401: errorResponses[401]
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
    413: jsonBody(apiErrorSchema, 'Payload exceeds the instance size cap')
  }
});

export const uploadSessionCommitRoute = createRoute({
  method: 'post',
  path: '/presentations/uploads/{id}/commit',
  tags: ['upload'],
  summary: 'Commit an upload session: creates the deck and its version 1 (one-shot)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(uploadSessionCommitSchema, 'Deck metadata + version-1 manifest')
  },
  responses: {
    201: jsonBody(versionCommittedSchema, 'Deck created at version 1'),
    400: jsonBody(apiErrorSchema, 'Validation error or manifest references missing blobs'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Session already consumed'),
    410: jsonBody(apiErrorSchema, 'Session expired')
  }
});

export const versionCommitRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/versions',
  tags: ['upload'],
  summary: 'Commit a new immutable version (optimistic concurrency via expectedBaseVersion)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(versionCommitSchema, 'Manifest + expectedBaseVersion')
  },
  responses: {
    201: jsonBody(versionCommittedSchema, 'Version committed; currentVersion advanced'),
    400: jsonBody(apiErrorSchema, 'Validation error or manifest references missing blobs'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'version_conflict: expectedBaseVersion is stale — pull and retry')
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
    404: errorResponses[404]
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
    404: errorResponses[404]
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
    404: errorResponses[404]
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
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const shareTokenCreateRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/tokens',
  tags: ['sharing'],
  summary: 'Create a per-recipient share token (the secret + viewer URL appear only here)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(shareTokenCreateSchema, 'Recipient label + access options'),
    headers: idempotencyHeaders
  },
  responses: {
    201: jsonBody(shareTokenCreatedSchema, 'Created; secret shown once, never retrievable'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Idempotency conflict')
  }
});

export const previewTokenCreateRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/preview-token',
  tags: ['sharing'],
  summary:
    "Mint the dashboard's own transient preview token (deck owner / workspace admin ONLY — " +
    'never dev collaborators). The server fixes every property: purpose "preview" (hidden ' +
    'from the sharing panel, excluded from view stats), a 1 hour expiry, no annotations, no ' +
    'password. Preview tokens are immutable: no update, no send; revocation is owner/admin ' +
    'only. The public token-create endpoint can never produce one — this route is the sole mint.',
  request: {
    params: uuidParams,
    body: jsonRequestBody(previewTokenCreateSchema, 'Optional version pin (omitted = latest)')
  },
  responses: {
    201: jsonBody(shareTokenCreatedSchema, 'Created; secret shown once, never retrievable'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const shareTokenUpdateRoute = createRoute({
  method: 'patch',
  path: '/presentations/{id}/tokens/{tokenId}',
  tags: ['sharing'],
  summary: 'Update a share token: pin/unpin version, rename, annotate flag, expiry, password',
  request: {
    params: tokenParams,
    body: jsonRequestBody(shareTokenUpdateSchema, 'Fields to change (null clears expiry/password)')
  },
  responses: {
    200: jsonBody(shareTokenSchema, 'Updated share token'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
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
    404: errorResponses[404]
  }
});

export const shareTokenSendRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/tokens/{tokenId}/send',
  tags: ['sharing'],
  summary:
    'Email the viewer link to a recipient. Hash-only storage means the server cannot recover the original secret, so each successful send ROTATES the token onto a fresh secret and mails that — earlier links for THIS token stop resolving (per-recipient tokens make that the natural resend semantics). No delivering email driver = nothing sent, nothing rotated (emailSent false).',
  request: {
    params: tokenParams,
    body: jsonRequestBody(shareTokenSendSchema, 'Recipient email + optional note')
  },
  responses: {
    200: jsonBody(shareTokenSentSchema, 'Delivery attempted; emailSent says whether mail went out'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
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
    404: errorResponses[404]
  }
});

export const collaboratorInviteRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/collaborators',
  tags: ['collaborators'],
  summary: 'Invite a dev collaborator by email (always returns a copyable claim link)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(collaboratorInviteSchema, 'Invitee email'),
    headers: idempotencyHeaders
  },
  responses: {
    201: jsonBody(collaboratorInvitedSchema, 'Grant created + claim link'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Already a collaborator, or idempotency conflict')
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
    404: errorResponses[404]
  }
});

export const collaboratorLookupRoute = createRoute({
  method: 'get',
  path: '/collaborators/lookup',
  tags: ['collaborators'],
  summary: 'Resolve a collaborator claim token (public; drives the claim page)',
  request: { query: z.object({ token: z.string().min(16) }) },
  responses: {
    200: jsonBody(collaboratorLookupSchema, 'Claim context'),
    404: errorResponses[404]
  }
});

export const collaboratorClaimRoute = createRoute({
  method: 'post',
  path: '/collaborators/claim',
  tags: ['collaborators'],
  summary:
    'Claim a collaborator grant (public; oss creates the account inline, cloud signs in via hub SSO first)',
  request: {
    body: jsonRequestBody(collaboratorClaimSchema, 'Token + credentials for new accounts (oss only)')
  },
  responses: {
    200: jsonBody(collaboratorClaimedSchema, 'Grant claimed (the account is now an active dev collaborator)'),
    400: errorResponses[400],
    404: errorResponses[404],
    409: jsonBody(
      apiErrorSchema,
      'account_exists (sign in, then claim) or sso_required (cloud: sign in with Antasphere first)'
    ),
    410: errorResponses[410]
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
    404: errorResponses[404]
  }
});

export const annotationCreateRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/annotations',
  tags: ['annotations'],
  summary: 'Create an annotation as a signed-in principal (owner/dev note on a version)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(annotationCreateSchema, 'Version + anchor + note')
  },
  responses: {
    201: jsonBody(annotationSchema, 'Created annotation'),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

export const annotationUpdateRoute = createRoute({
  method: 'patch',
  path: '/presentations/{id}/annotations/{annotationId}',
  tags: ['annotations'],
  summary: 'Update an annotation (edit body, resolve/reopen)',
  request: {
    params: annotationParams,
    body: jsonRequestBody(annotationUpdateSchema, 'Fields to change')
  },
  responses: {
    200: jsonBody(annotationSchema, 'Updated annotation'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404]
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
    404: errorResponses[404]
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
    401: errorResponses[401]
  }
});
