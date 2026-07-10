import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  annotationCreateRoute,
  annotationDeleteRoute,
  annotationsInboxRoute,
  annotationsListRoute,
  annotationUpdateRoute,
  assetDownloadRoute,
  assetPrecheckRoute,
  assetUploadRoute,
  collaboratorInviteRoute,
  collaboratorRemoveRoute,
  collaboratorsListRoute,
  presentationDeleteRoute,
  presentationGetRoute,
  presentationsListRoute,
  shareTokenCreateRoute,
  shareTokenRevokeRoute,
  shareTokenSendRoute,
  shareTokensListRoute,
  shareTokenUpdateRoute,
  uploadSessionCommitRoute,
  uploadSessionCreateRoute,
  versionCommitRoute,
  versionGetRoute,
  versionsListRoute
} from '@slideless/contract/routes';
import { requireAuth } from '../middleware/auth-context.js';

/**
 * Presentation domain routes (ADR 011). Phase 2 registers the FROZEN
 * contract surface behind auth + the machine scope allowlist; every handler
 * answers the 501 declared on its route until its build phase lands the
 * logic: Phase 3 upload/versioning, Phase 4 sharing (+ the public viewer,
 * whose token-session routes live OUTSIDE this principal-gated surface),
 * Phase 5 collaborators/annotations. Implementers replace a stub AND delete
 * the 501 entry from the route contract in the same change.
 */

const err = (code: string, message: string) => ({ error: { code, message } });

export function registerPresentationRoutes(api: OpenAPIHono): void {
  api.use('/presentations', requireAuth());
  api.use('/presentations/*', requireAuth());
  api.use('/annotations', requireAuth());

  const notImplemented = (phase: string) =>
    err('not_implemented', `Not implemented yet — this endpoint arrives with ${phase}`);

  // Literal-segment siblings of /presentations/{id} first (see LESSONS.md on
  // param patterns swallowing literals): uploads, precheck, assets.
  api.openapi(uploadSessionCreateRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(assetPrecheckRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(assetUploadRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(uploadSessionCommitRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));

  api.openapi(presentationsListRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(presentationGetRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(presentationDeleteRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));

  api.openapi(versionCommitRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(versionsListRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(versionGetRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));
  api.openapi(assetDownloadRoute, (c) => c.json(notImplemented('Phase 3 (upload)'), 501));

  api.openapi(shareTokensListRoute, (c) => c.json(notImplemented('Phase 4 (sharing)'), 501));
  api.openapi(shareTokenCreateRoute, (c) => c.json(notImplemented('Phase 4 (sharing)'), 501));
  api.openapi(shareTokenUpdateRoute, (c) => c.json(notImplemented('Phase 4 (sharing)'), 501));
  api.openapi(shareTokenRevokeRoute, (c) => c.json(notImplemented('Phase 4 (sharing)'), 501));
  api.openapi(shareTokenSendRoute, (c) => c.json(notImplemented('Phase 4 (sharing)'), 501));

  api.openapi(collaboratorsListRoute, (c) => c.json(notImplemented('Phase 5 (collaborators)'), 501));
  api.openapi(collaboratorInviteRoute, (c) => c.json(notImplemented('Phase 5 (collaborators)'), 501));
  api.openapi(collaboratorRemoveRoute, (c) => c.json(notImplemented('Phase 5 (collaborators)'), 501));

  api.openapi(annotationsListRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationCreateRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationUpdateRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationDeleteRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationsInboxRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
}
