import { createRoute, z } from '@hono/zod-openapi';
import { apiErrorSchema, cursorPageQuerySchema, versionParamSchema } from '@antasphere/chassis-contract';
import {
  defineChassisRoutes,
  errorResponses,
  idempotencyHeaders,
  jsonBody,
  jsonRequestBody,
  uuidParams
} from '@antasphere/chassis-contract/routes';
import { chassisContract } from '../chassis.js';
import { IDENTITY } from '../identity.js';
import {
  ASSET_PATH_MAX_LENGTH,
  assetPrecheckRequestSchema,
  assetPrecheckResponseSchema,
  assetUploadFormSchema,
  assetUploadedSchema,
  presentationSchema,
  presentationsListQuerySchema,
  presentationsListSchema,
  presentationUpdateSchema,
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
  shareTokenViewsListSchema,
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
  formResponseDetailSchema,
  formResponseFilesZipQuerySchema,
  formResponseSchema,
  formResponsesListQuerySchema,
  formResponsesListSchema,
  formResponsesSummarySchema
} from '../schemas/forms.js';
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

/**
 * The generic routes that carry something of the tool, instantiated ONCE with
 * the Slideless scopes (../chassis.ts), its identity (../identity.ts) and the
 * deck domain's wording of the one OpenAPI sentence that names it. Every
 * other generic route contract is a static export of
 * `@antasphere/chassis-contract/routes`.
 */
export const {
  meRoute,
  apiKeysListRoute,
  apiKeyCreateRoute,
  apiKeyRevokeRoute,
  cliAuthCompleteRoute,
  ssoCliConnectRoute,
  workspaceExportRoute,
  fileDeleteRoute
} = defineChassisRoutes(chassisContract, IDENTITY, {
  fileInUseOpenApi: 'file_in_use: referenced by a presentation version'
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
// Strict digits + int4 bound (FUZZ-9, PRDCT-1358): `z.coerce.number()` let
// `99999999999999999999` through `.int()` into a Postgres int4 overflow → 500.
const versionParams = z.object({ id: z.uuid(), version: versionParamSchema });
const assetParams = z.object({ id: z.uuid(), sha256: sha256Schema });

// ── Presentations ────────────────────────────────────────────────────────────

export const presentationsListRoute = createRoute({
  method: 'get',
  path: '/presentations',
  tags: ['presentations'],
  summary:
    'List presentations in the workspace (cursor-paginated, newest first); `type` lists references instead of ordinary decks',
  request: { query: presentationsListQuerySchema },
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

export const presentationUpdateRoute = createRoute({
  method: 'patch',
  path: '/presentations/{id}',
  tags: ['presentations'],
  summary:
    'Update mutable deck properties (title, metadata — metadata is a full replace; audience and defaultReference on a reference)',
  request: {
    params: uuidParams,
    body: jsonRequestBody(presentationUpdateSchema, 'Fields to change (at least one)')
  },
  responses: {
    200: jsonBody(presentationSchema, 'Updated presentation'),
    400: errorResponses[400],
    401: errorResponses[401],
    403: jsonBody(apiErrorSchema, 'The caller reads this deck but may not change this property'),
    404: errorResponses[404],
    409: jsonBody(
      apiErrorSchema,
      'audience_private or default_reference: the audience and the default disagree'
    ),
    422: jsonBody(apiErrorSchema, 'not_a_reference: audience and defaultReference apply to references only')
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
    // Deliberately NO 403 (AUTH-5, PRDCT-1393): an unauthorized push gets
    // the same 404 a nonexistent deck does — existence is not probeable.
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

// ── Attachments (PRDCT-2278, the owner side) ─────────────────────────────────
// The `downloads/` entries of ONE version, for the master page's version
// history: the whole set as a streamed store-only zip, or one file by name.
// Both under canReadDeck (404, never 403 — ADR 013), both `attachment` +
// `nosniff` (user content never renders on the app origin), both open to
// machine principals under presentations:read through the /presentations
// prefix rule of the scope allowlist (middleware/scopes.ts, consciously).
// Guests keep their per-deck read here as on the asset route. The
// recipient side (the share link) lives on the viewer: `/v/{secret}/
// downloads.zip`, `/v/{secret}/downloads/{name...}` and the token-authed
// list `GET /api/v1/viewer/{secret}/attachments` (viewer/attachments-api.ts).

/**
 * `{name}` is ONE path segment: an attachment's name relative to
 * `downloads/`, percent-encoded by the client — a nested name
 * (`sub/file.csv`) travels as `sub%2Ffile.csv`, so the route keeps typed
 * parameters and a place in the OpenAPI document. Bounded like a manifest
 * path; the handler applies the traversal rule to the decoded value and
 * looks the path up EXACTLY in the version's manifest.
 */
const attachmentParams = z.object({
  id: z.uuid(),
  version: versionParamSchema,
  name: z.string().min(1).max(ASSET_PATH_MAX_LENGTH)
});

export const versionAttachmentsZipRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/versions/{version}/downloads.zip',
  tags: ['presentations'],
  summary:
    "One version's attachments (its `downloads/` folder) as a streamed store-only zip named " +
    '`<deck-title-slug>-v<n>.zip`; entries are named by their path relative to downloads/. ' +
    '404 no_attachments when the version carries none.',
  request: { params: versionParams },
  responses: {
    // Deliberately NO `content` key on the 200 (the asset-download precedent):
    // the handler returns a plain streamed Response.
    200: { description: 'Zip archive stream (application/zip, attachment)' },
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

export const versionAttachmentDownloadRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/versions/{version}/downloads/{name}',
  tags: ['presentations'],
  summary:
    'One attachment of one version by its name (the path relative to downloads/, percent-encoded — ' +
    'a nested name travels as sub%2Ffile.csv), served attachment + nosniff with the manifest content ' +
    'type, ETag and Range like the asset route.',
  request: { params: attachmentParams },
  responses: {
    200: { description: 'Attachment bytes (streamed, attachment disposition)' },
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

export const agentDocGetRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/agent-doc',
  tags: ['presentations'],
  summary: "The deck's AGENT.md briefing (current version, or ?version=N)",
  request: {
    params: uuidParams,
    query: z.object({ version: versionParamSchema.optional() })
  },
  responses: {
    // Streamed like assetDownloadRoute; markdown bytes, inline disposition.
    200: { description: 'AGENT.md bytes (streamed, text/markdown)' },
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
    // Deliberately NO 403 (deckForSharing's uniform 404, AUTH-5): an
    // ordinary member gets the same 404 an outsider would.
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
    // Deliberately NO 403 (deckForSharing's uniform 404, AUTH-5).
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
    // Deliberately NO 403 (deckForSharing's uniform 404, AUTH-5).
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
    // The one reachable 403 on the token surface: a dev collaborator (a
    // PROVEN reader, past deckForSharing) refused a preview-token revoke.
    403: errorResponses[403],
    404: errorResponses[404]
  }
});

export const shareTokenViewsListRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/tokens/{tokenId}/views',
  tags: ['sharing'],
  summary:
    'Per-view events of one share token (cursor-paginated, newest first). Each event carries ' +
    'occurredAt, the referring site host, the sanitized ?p= placement label, a coarse browser ' +
    'family, and the version served. No IP, no geolocation, no full referrer URLs — ever.',
  request: { params: tokenParams, query: cursorPageQuerySchema },
  responses: {
    200: jsonBody(shareTokenViewsListSchema, 'View events, newest first'),
    401: errorResponses[401],
    // Deliberately NO 403 (the annotations-list posture): an ordinary member
    // gets the same 404 an outsider would — existence is not advertised.
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
    // Deliberately NO 403 (deckForSharing's uniform 404, AUTH-5).
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
    // Deliberately NO 403 (the annotations-list posture, PRDCT-1393): an
    // ordinary member gets the same 404 an outsider would.
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
    // Deliberately NO 403 (the annotations-list posture, PRDCT-1393).
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

// ── Form responses (owner surface; the token-session submit surface ships
// with the viewer — apps/server viewer/forms-api.ts) ─────────────────────────
// Gated like annotations: the deck's writers (canWrite), 404 for everyone
// else — the response stream's existence is not advertised. NOTE the handler
// registration order: the literal `/responses/summary` route MUST register
// before the `{responseId}` param route (the literal-segment trap, LESSONS.md).

const formResponseParams = z.object({ id: z.uuid(), responseId: z.uuid() });

export const formResponsesListRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/responses',
  tags: ['forms'],
  summary: 'List form responses of a presentation (filter by form/link/source/placement/since)',
  request: { params: uuidParams, query: formResponsesListQuerySchema },
  responses: {
    200: jsonBody(formResponsesListSchema, 'Responses, newest first'),
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

export const formResponsesSummaryRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/responses/summary',
  tags: ['forms'],
  summary: 'Grouped response counts per form × link × source × placement',
  request: { params: uuidParams },
  responses: {
    200: jsonBody(formResponsesSummarySchema, 'Summary buckets plus the deck total'),
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

// ── The files of form responses (PRDCT-2403) ─────────────────────────────────
// What respondents uploaded into a form's file fields. ONE capability of the
// API: the dashboard, the CLI and the MCP tool are three clients of these
// routes. Gated exactly like the responses they belong to (canWrite, 404
// never 403). Bytes are served `attachment` + `nosniff`, never rendered.
// The literal `/responses/files.zip` MUST register before `{responseId}`.

/** Every file of the deck's responses, one folder per response, as one zip. */
export const formResponsesFilesZipRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/responses/files.zip',
  tags: ['forms'],
  summary:
    "Every uploaded file of a presentation's form responses as a streamed store-only zip " +
    '(`<form>/<response>/<field>/<file>`); filter by form, link or since. 404 no_files when none match.',
  request: { params: uuidParams, query: formResponseFilesZipQuerySchema },
  responses: {
    200: { description: 'Zip archive stream (application/zip, attachment)' },
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

/**
 * One response with its edit history (PRDCT-2329): the current row plus
 * every revision, newest first. Owner surface only — the respondent wire
 * (viewer/forms-api.ts) never carries a history. Registered AFTER the
 * literal `/responses/summary` handler (the literal-segment trap).
 */
export const formResponseGetRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/responses/{responseId}',
  tags: ['forms'],
  summary: 'One form response with its revision history (owner surface)',
  request: { params: formResponseParams },
  responses: {
    200: jsonBody(formResponseDetailSchema, 'The response and its revisions, newest first'),
    401: errorResponses[401],
    // Deliberately NO 403 (the responses-list posture): an ordinary member
    // gets the same 404 an outsider would.
    404: errorResponses[404]
  }
});
export const formResponseDeleteRoute = createRoute({
  method: 'delete',
  path: '/presentations/{id}/responses/{responseId}',
  tags: ['forms'],
  summary: 'Delete one form response (owner moderation)',
  request: { params: formResponseParams },
  responses: {
    200: jsonBody(formResponseSchema, 'Deleted response (final snapshot)'),
    401: errorResponses[401],
    // Deliberately NO 403 (the responses-list posture, PRDCT-1393): an
    // ordinary member gets the same 404 an outsider would.
    404: errorResponses[404]
  }
});

const formResponseFileParams = z.object({ id: z.uuid(), responseId: z.uuid(), fileId: z.uuid() });

/** One response's files as one zip (`<field>/<file>`). Registered before the single-file route. */
export const formResponseFilesZipRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/responses/{responseId}/files.zip',
  tags: ['forms'],
  summary:
    "One form response's uploaded files as a streamed store-only zip. 404 no_files when it holds none.",
  request: { params: formResponseParams },
  responses: {
    200: { description: 'Zip archive stream (application/zip, attachment)' },
    401: errorResponses[401],
    404: errorResponses[404]
  }
});

export const formResponseFileDownloadRoute = createRoute({
  method: 'get',
  path: '/presentations/{id}/responses/{responseId}/files/{fileId}',
  tags: ['forms'],
  summary: 'Download one file a respondent uploaded (attachment + nosniff; Range supported)',
  request: { params: formResponseFileParams },
  responses: {
    200: { description: 'File bytes' },
    206: { description: 'Partial content' },
    304: { description: 'Not modified' },
    401: errorResponses[401],
    404: errorResponses[404],
    416: { description: 'Range not satisfiable' }
  }
});

// ── Duplicate (PRDCT-2279, lane C of the artifact wave) ──────────────────────
// A per-deck CREATE: reads the source under canReadDeck (404, never 403 —
// ADR 013), creates in the caller's workspace like an upload commit (guests
// refused, 403 guest_forbidden, D2), and mints exactly one copy per
// Idempotency-Key like the other row-minting creates.

import { presentationDuplicateSchema } from '../schemas/presentations.js';

export const presentationDuplicateRoute = createRoute({
  method: 'post',
  path: '/presentations/{id}/duplicate',
  tags: ['presentations'],
  summary:
    'Duplicate a presentation: a new deck in the same workspace whose version 1 references the ' +
    "source version's blobs (no re-upload); lineage recorded in remixedFrom",
  request: {
    params: uuidParams,
    body: jsonRequestBody(
      presentationDuplicateSchema,
      'Source version (default: current) and the copy’s title'
    ),
    headers: idempotencyHeaders
  },
  responses: {
    201: jsonBody(versionCommittedSchema, 'The copy at version 1'),
    400: jsonBody(apiErrorSchema, 'Validation error, or the source version does not exist'),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: jsonBody(apiErrorSchema, 'Idempotency conflict')
  }
});
