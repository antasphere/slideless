import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileDeleteRoute, fileGetRoute, filesListRoute, fileUploadRoute } from '@slideless/contract/routes';
import type { DbConn, FileRow } from '@slideless/db';
import { ulid } from 'ulid';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { FileService } from '../files/service.js';
import { FileTooLargeError } from '../files/service.js';
import { serveBlob } from '../files/serve.js';
import type { StorageDriver } from '../storage/driver.js';
import { isUuid } from '../pagination.js';
import { requireAuth } from '../middleware/auth-context.js';

const err = (code: string, message: string) => ({ error: { code, message } });

const toWire = (f: FileRow) => ({
  id: f.id,
  sha256: f.sha256,
  sizeBytes: f.sizeBytes,
  contentType: f.contentType,
  originalName: f.originalName,
  createdBy: f.createdBy,
  createdAt: f.createdAt.toISOString()
});

export interface FileRouteDeps {
  service: FileService;
  storage: StorageDriver;
  registry: PlatformRegistry;
  env: Pick<Env, 'MAX_FILE_SIZE_MB' | 'EDITION' | 'APP_VERSION'>;
  logger: Logger;
  instanceId: () => Promise<string>;
  /**
   * ADR 011 blob-delete guard: true when the blob is referenced by a live
   * presentation version manifest — DELETE answers 409 file_in_use instead
   * of removing it. Runs inside the delete transaction (files module stays
   * presentation-agnostic; the wiring point injects the presentation check).
   */
  blobInUse: (tx: DbConn, workspaceId: string, sha256: string) => Promise<boolean>;
}

export function registerFileRoutes(api: OpenAPIHono, deps: FileRouteDeps): void {
  const { service, storage, registry, env, logger } = deps;
  const maxBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;

  api.use('/files', requireAuth());
  api.use('/files/*', requireAuth());

  api.openapi(filesListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const { files: rows, nextCursor } = await service.list(principal.workspaceId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json({ files: rows.map(toWire), nextCursor }, 200);
  });

  api.openapi(fileUploadRoute, async (c) => {
    const principal = c.get('principal')!;
    const { name } = c.req.valid('query');
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';

    // Entitlement gate first (declared size), hard cap enforced mid-stream too.
    const declared = Number(c.req.header('content-length') ?? '0');
    const decision = await registry.entitlements.check(principal, {
      key: 'files.upload',
      quantity: declared,
      unit: 'bytes'
    });
    if (!decision.allowed) {
      return c.json(err('entitlement_denied', decision.reason), 413);
    }
    if (!c.req.raw.body) {
      return c.json(err('empty_body', 'Request body required'), 400);
    }

    try {
      const { file, deduplicated } = await service.upload({
        workspaceId: principal.workspaceId,
        createdBy: principal.userId,
        originalName: name,
        contentType,
        body: Readable.fromWeb(c.req.raw.body as WebReadableStream),
        maxBytes
      });

      c.set('audit', {
        action: 'file.upload',
        resourceType: 'file',
        resourceId: file.id,
        metadata: { name, sizeBytes: file.sizeBytes, deduplicated }
      });
      registry.events.emit('file.uploaded', {
        workspaceId: principal.workspaceId,
        fileId: file.id,
        sizeBytes: file.sizeBytes
      });
      void registry.usage.emit({
        id: ulid(),
        meter: 'files.upload',
        quantity: file.sizeBytes,
        unit: 'bytes',
        occurredAt: new Date().toISOString(),
        workspaceId: principal.workspaceId,
        ...(principal.accountRef ? { accountRef: principal.accountRef } : {}),
        source: { instanceId: await deps.instanceId(), edition: env.EDITION, version: env.APP_VERSION }
      });

      return c.json({ file: toWire(file), deduplicated }, 201);
    } catch (e) {
      if (e instanceof FileTooLargeError) {
        return c.json(err('file_too_large', e.message), 413);
      }
      logger.error({ err: e }, 'file upload failed');
      return c.json(err('upload_failed', 'Upload failed'), 400);
    }
  });

  api.openapi(fileGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const file = await service.get(principal.workspaceId, id);
    if (!file) return c.json(err('not_found', 'File not found'), 404);
    return c.json(toWire(file), 200);
  });

  api.openapi(fileDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const file = await service.get(principal.workspaceId, id);
    if (!file) return c.json(err('not_found', 'File not found'), 404);
    const outcome = await service.delete(file, (tx, row) => deps.blobInUse(tx, row.workspaceId, row.sha256));
    if (outcome === 'in_use') {
      return c.json(
        err(
          'file_in_use',
          'This file is referenced by a presentation version — delete the presentation first'
        ),
        409
      );
    }
    c.set('audit', { action: 'file.delete', resourceType: 'file', resourceId: file.id });
    return c.json(toWire(file), 200);
  });

  // ── Content: streamed, Range-capable. Registered as plain Hono routes (a
  // byte endpoint, not part of the JSON OpenAPI surface); guarded by the
  // same requireAuth + scope machinery as everything else under /files.
  // The streaming machinery itself (ETag/304/Range/safe-serving) is shared
  // with the presentation asset download — files/serve.ts.
  const contentHandler = async (c: Context, headOnly: boolean) => {
    const principal = c.get('principal')!;
    const id = c.req.param('id') ?? '';
    // Plain Hono route (no contract param schema): reject a non-UUID id here
    // or it reaches Postgres' uuid cast and surfaces as a sanitized 500.
    if (!isUuid(id)) return c.json(err('not_found', 'File not found'), 404);
    const file = await service.get(principal.workspaceId, id);
    if (!file) return c.json(err('not_found', 'File not found'), 404);

    return serveBlob(c, {
      storage,
      logger,
      workspaceId: file.workspaceId,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      filename: file.originalName,
      headOnly
    });
  };

  api.get('/files/:id/content', (c) => contentHandler(c, false));
  api.on('HEAD', '/files/:id/content', (c) => contentHandler(c, true));
}
