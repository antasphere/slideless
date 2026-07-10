import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileDeleteRoute, fileGetRoute, filesListRoute, fileUploadRoute } from '@platform/contract/routes';
import type { FileRow } from '@platform/db';
import { ulid } from 'ulid';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { FileService } from '../files/service.js';
import { FileTooLargeError } from '../files/service.js';
import { contentDispositionFor, parseRangeHeader } from '../files/http.js';
import { blobKey, type StorageDriver } from '../storage/driver.js';
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
    await service.delete(file);
    c.set('audit', { action: 'file.delete', resourceType: 'file', resourceId: file.id });
    return c.json(toWire(file), 200);
  });

  // ── Content: streamed, Range-capable. Registered as plain Hono routes (a
  // byte endpoint, not part of the JSON OpenAPI surface); guarded by the
  // same requireAuth + scope machinery as everything else under /files.
  const contentHandler = async (c: Context, headOnly: boolean) => {
    const principal = c.get('principal')!;
    const id = c.req.param('id') ?? '';
    // Plain Hono route (no contract param schema): reject a non-UUID id here
    // or it reaches Postgres' uuid cast and surfaces as a sanitized 500.
    if (!isUuid(id)) return c.json(err('not_found', 'File not found'), 404);
    const file = await service.get(principal.workspaceId, id);
    if (!file) return c.json(err('not_found', 'File not found'), 404);

    // Content-addressed: the ETag IS the content hash, immutable forever.
    const etag = `"${file.sha256}"`;
    const baseHeaders: Record<string, string> = {
      'content-type': file.contentType,
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDispositionFor(file.contentType, file.originalName),
      'accept-ranges': 'bytes',
      etag,
      'cache-control': 'private, max-age=31536000, immutable'
    };

    if (c.req.header('if-none-match') === etag) {
      return c.body(null, 304, baseHeaders);
    }

    // The metadata row is shared (Postgres) but the blob must be reachable
    // from THIS replica before any status line is committed: with local
    // storage behind a multi-replica load balancer the bytes live on another
    // replica's private disk, and streaming ahead sent 200 + headers, then
    // died mid-body — silent truncation the client cannot distinguish from
    // the real file (scale drill, I2). The clean 404 is a safety net, not a
    // supported topology: multi-replica requires shared storage
    // (STORAGE_DRIVER=s3), docs/deployment-profiles.md.
    const key = blobKey(file.workspaceId, file.sha256);
    if (!(await storage.exists(key))) {
      logger.error(
        { fileId: file.id, key, driver: storage.name },
        'file blob unreachable: metadata row exists but storage has no bytes (local storage behind multiple replicas?)'
      );
      return c.json(err('not_found', 'File content not available'), 404);
    }

    const parsed = parseRangeHeader(c.req.header('range'), file.sizeBytes);
    if (parsed.kind === 'unsatisfiable') {
      return c.body(null, 416, { ...baseHeaders, 'content-range': `bytes */${file.sizeBytes}` });
    }

    const isPartial = parsed.kind === 'range';
    const start = isPartial ? parsed.range.start : 0;
    const end = isPartial ? parsed.range.end : file.sizeBytes - 1;
    const length = file.sizeBytes === 0 ? 0 : end - start + 1;

    const headers: Record<string, string> = {
      ...baseHeaders,
      'content-length': String(length),
      ...(isPartial ? { 'content-range': `bytes ${start}-${end}/${file.sizeBytes}` } : {})
    };
    const status = isPartial ? 206 : 200;

    if (headOnly || file.sizeBytes === 0) {
      return c.body(null, status, headers);
    }

    const nodeStream = await storage.getStream(key, isPartial ? parsed.range : undefined);
    // Backpressure rides Readable.toWeb; a client abort must destroy the
    // source or every seek-away leaks a descriptor/S3 socket.
    c.req.raw.signal.addEventListener('abort', () => nodeStream.destroy());
    const web = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    return c.body(web, status, headers);
  };

  api.get('/files/:id/content', (c) => contentHandler(c, false));
  api.on('HEAD', '/files/:id/content', (c) => contentHandler(c, true));
}
