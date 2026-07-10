import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { ulid } from 'ulid';
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
import type { ManifestEntry } from '@slideless/contract';
import type { PresentationRow, PresentationVersionRow, UploadSessionRow } from '@slideless/db';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { FileService } from '../files/service.js';
import { FileTooLargeError } from '../files/service.js';
import { serveBlob } from '../files/serve.js';
import type { StorageDriver } from '../storage/driver.js';
import { canWriteDeck, type PresentationService } from '../presentations/service.js';
import { requireAuth } from '../middleware/auth-context.js';

/**
 * Presentation domain routes (ADR 011). Phase 3 implemented the upload +
 * versioning pipeline (push protocol, pull, delete); Phase 4 (sharing + the
 * public viewer, whose token-session routes live OUTSIDE this
 * principal-gated surface) and Phase 5 (collaborators/annotations) still
 * answer the 501 declared on their contract entries — implementers replace a
 * stub AND delete the 501 entry from the route contract in the same change.
 */

const err = (code: string, message: string) => ({ error: { code, message } });

const presentationToWire = (p: PresentationRow) => ({
  id: p.id,
  title: p.title,
  kind: p.kind,
  interactive: p.interactive,
  currentVersion: p.currentVersion,
  entryPath: p.entryPath,
  ownerUserId: p.ownerUserId,
  remixedFrom: p.remixedFrom,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString()
});

const versionToWire = (v: Omit<PresentationVersionRow, 'manifest'>) => ({
  presentationId: v.presentationId,
  version: v.version,
  entryPath: v.entryPath,
  sizeBytes: v.sizeBytes,
  fileCount: v.fileCount,
  createdBy: v.createdBy,
  createdByRole: v.createdByRole,
  createdAt: v.createdAt.toISOString()
});

const sessionToWire = (s: UploadSessionRow) => ({
  id: s.id,
  presentationId: s.presentationId,
  expiresAt: s.expiresAt.toISOString(),
  createdAt: s.createdAt.toISOString()
});

export interface PresentationRouteDeps {
  service: PresentationService;
  fileService: FileService;
  storage: StorageDriver;
  registry: PlatformRegistry;
  env: Pick<Env, 'MAX_FILE_SIZE_MB' | 'EDITION' | 'APP_VERSION'>;
  logger: Logger;
  instanceId: () => Promise<string>;
}

export function registerPresentationRoutes(api: OpenAPIHono, deps: PresentationRouteDeps): void {
  const { service, fileService, storage, registry, env, logger } = deps;
  const maxBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;

  api.use('/presentations', requireAuth());
  api.use('/presentations/*', requireAuth());
  api.use('/annotations', requireAuth());

  const notImplemented = (phase: string) =>
    err('not_implemented', `Not implemented yet — this endpoint arrives with ${phase}`);

  // ── Upload (push protocol) ─────────────────────────────────────────────────
  // Literal-segment siblings of /presentations/{id} first (see LESSONS.md on
  // param patterns swallowing literals): uploads, precheck, assets.

  api.openapi(uploadSessionCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const session = await service.createUploadSession(principal.workspaceId, principal.userId);
    c.set('audit', {
      action: 'presentation.upload_session_create',
      resourceType: 'upload_session',
      resourceId: session.id,
      metadata: { presentationId: session.presentationId }
    });
    return c.json({ uploadSession: sessionToWire(session) }, 201);
  });

  api.openapi(assetPrecheckRoute, async (c) => {
    const principal = c.get('principal')!;
    const { sha256 } = c.req.valid('json');
    const missing = await service.precheckMissing(principal.workspaceId, sha256);
    return c.json({ missing }, 200);
  });

  api.openapi(assetUploadRoute, async (c) => {
    const principal = c.get('principal')!;

    // Entitlement gate on the declared size first; the true size is enforced
    // after parse (and the multipart body limit bounds the parse itself).
    const declared = Number(c.req.header('content-length') ?? '0');
    const decision = await registry.entitlements.check(principal, {
      key: 'files.upload',
      quantity: declared,
      unit: 'bytes'
    });
    if (!decision.allowed) {
      return c.json(err('entitlement_denied', decision.reason), 413);
    }

    const form = c.req.valid('form');
    const file = form.file as unknown;
    // Hono's parseBody yields string | File per part; the bytes MUST be a
    // file part (a string field named `file` is a malformed client).
    if (!(file instanceof File)) {
      return c.json(err('invalid_form', 'The `file` field must be a file part'), 400);
    }
    // MVP shape (slide-sized assets): the multipart part is buffered to hash
    // before storing — the declared sha must be verified BEFORE any files row
    // exists, or a mismatch would still mint a blob the client never meant.
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > maxBytes) {
      return c.json(err('file_too_large', `file exceeds the ${maxBytes}-byte limit`), 413);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== form.sha256) {
      return c.json(
        err('sha256_mismatch', `Declared sha256 ${form.sha256} but the content hashes to ${actual}`),
        400
      );
    }

    try {
      const { file: row, deduplicated } = await fileService.upload({
        workspaceId: principal.workspaceId,
        createdBy: principal.userId,
        originalName: file.name || form.sha256,
        contentType: file.type || 'application/octet-stream',
        body: Readable.from(bytes),
        maxBytes
      });

      c.set('audit', {
        action: 'presentation.asset_upload',
        resourceType: 'file',
        resourceId: row.id,
        metadata: { sha256: row.sha256, sizeBytes: row.sizeBytes, deduplicated }
      });
      void registry.usage.emit({
        id: ulid(),
        meter: 'files.upload',
        quantity: row.sizeBytes,
        unit: 'bytes',
        occurredAt: new Date().toISOString(),
        workspaceId: principal.workspaceId,
        ...(principal.accountRef ? { accountRef: principal.accountRef } : {}),
        source: { instanceId: await deps.instanceId(), edition: env.EDITION, version: env.APP_VERSION }
      });

      return c.json({ sha256: row.sha256, sizeBytes: row.sizeBytes, deduplicated }, 201);
    } catch (e) {
      if (e instanceof FileTooLargeError) {
        return c.json(err('file_too_large', e.message), 413);
      }
      logger.error({ err: e }, 'asset upload failed');
      return c.json(err('upload_failed', 'Upload failed'), 400);
    }
  });

  api.openapi(uploadSessionCommitRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await service.commitUploadSession({
      workspaceId: principal.workspaceId,
      principal,
      sessionId: id,
      title: body.title,
      kind: body.kind,
      interactive: body.interactive,
      entryPath: body.entryPath,
      manifest: body.manifest as ManifestEntry[]
    });
    if (!result.ok) {
      const f = result.failure;
      switch (f.code) {
        case 'not_found':
          return c.json(err('not_found', 'Upload session not found'), 404);
        case 'session_consumed':
          return c.json(err('session_consumed', 'This upload session was already committed'), 409);
        case 'session_expired':
          return c.json(err('session_expired', 'This upload session has expired — reserve a new one'), 410);
        case 'invalid_manifest':
          return c.json(err('invalid_manifest', f.message), 400);
        case 'missing_blobs':
          return c.json(
            {
              error: {
                code: 'missing_blobs',
                message: `The manifest references ${f.missing.length} blob(s) not uploaded to this workspace — upload them and retry`,
                details: { missing: f.missing }
              }
            },
            400
          );
      }
    }

    c.set('audit', {
      action: 'presentation.create',
      resourceType: 'presentation',
      resourceId: result.presentation.id,
      metadata: { title: result.presentation.title, fileCount: result.version.fileCount }
    });
    registry.events.emit('presentation.created', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id
    });
    return c.json(
      { presentation: presentationToWire(result.presentation), version: versionToWire(result.version) },
      201
    );
  });

  api.openapi(versionCommitRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await service.commitVersion({
      workspaceId: principal.workspaceId,
      principal,
      presentationId: id,
      expectedBaseVersion: body.expectedBaseVersion,
      entryPath: body.entryPath,
      manifest: body.manifest as ManifestEntry[],
      title: body.title
    });
    if (!result.ok) {
      const f = result.failure;
      switch (f.code) {
        case 'not_found':
          return c.json(err('not_found', 'Presentation not found'), 404);
        case 'forbidden':
          return c.json(err('forbidden', 'Only the deck owner or a workspace admin can commit'), 403);
        case 'invalid_manifest':
          return c.json(err('invalid_manifest', f.message), 400);
        case 'missing_blobs':
          return c.json(
            {
              error: {
                code: 'missing_blobs',
                message: `The manifest references ${f.missing.length} blob(s) not uploaded to this workspace — upload them and retry`,
                details: { missing: f.missing }
              }
            },
            400
          );
        case 'version_conflict':
          return c.json(
            {
              error: {
                code: 'version_conflict',
                message: `expectedBaseVersion ${body.expectedBaseVersion} is stale — the deck is at version ${f.currentVersion}; pull and retry`,
                details: { currentVersion: f.currentVersion }
              }
            },
            409
          );
      }
    }

    c.set('audit', {
      action: 'presentation.version_commit',
      resourceType: 'presentation',
      resourceId: result.presentation.id,
      metadata: { version: result.version.version, fileCount: result.version.fileCount }
    });
    registry.events.emit('presentation.version_committed', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id,
      version: result.version.version
    });
    return c.json(
      { presentation: presentationToWire(result.presentation), version: versionToWire(result.version) },
      201
    );
  });

  // ── Presentations ──────────────────────────────────────────────────────────

  api.openapi(presentationsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const { presentations, nextCursor } = await service.list(principal.workspaceId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json({ presentations: presentations.map(presentationToWire), nextCursor }, 200);
  });

  api.openapi(presentationGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    return c.json(presentationToWire(deck), 200);
  });

  api.openapi(presentationDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (!canWriteDeck(principal, deck)) {
      return c.json(err('forbidden', 'Only the deck owner or a workspace admin can delete it'), 403);
    }
    const deleted = await service.softDelete(deck);
    c.set('audit', {
      action: 'presentation.delete',
      resourceType: 'presentation',
      resourceId: deck.id,
      metadata: { title: deck.title }
    });
    return c.json(presentationToWire(deleted), 200);
  });

  // ── Pull ───────────────────────────────────────────────────────────────────

  api.openapi(versionsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    const { versions, nextCursor } = await service.listVersions(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json({ versions: versions.map(versionToWire), nextCursor }, 200);
  });

  api.openapi(versionGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, version } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    const row = await service.getVersion(principal.workspaceId, id, version);
    if (!row) return c.json(err('not_found', 'Version not found'), 404);
    return c.json({ ...versionToWire(row), manifest: row.manifest as ManifestEntry[] }, 200);
  });

  api.openapi(assetDownloadRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, sha256 } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    // Reference check: the blob must appear in one of THIS deck's manifests —
    // a deck id is never a handle to pull arbitrary workspace blobs.
    const entry = await service.findManifestEntry(principal.workspaceId, id, sha256);
    if (!entry) return c.json(err('not_found', 'Asset not referenced by this presentation'), 404);
    const fileRow = await fileService.getBySha(principal.workspaceId, sha256);
    if (!fileRow) return c.json(err('not_found', 'Asset content not available'), 404);

    return serveBlob(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      sha256,
      sizeBytes: fileRow.sizeBytes,
      // The deck's declared type wins over the files row (safe-serving keeps
      // active content as attachment + nosniff either way).
      contentType: entry.contentType,
      filename: entry.path.split('/').pop() ?? entry.path,
      headOnly: false
    });
  });

  // ── Phase 4/5 stubs (contract-frozen 501s) ─────────────────────────────────

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
