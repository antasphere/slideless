import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { blobKey, type StorageDriver } from '../storage/driver.js';
import type { Logger } from '../logger.js';
import { contentDispositionFor, parseRangeHeader } from './http.js';

export interface ServeBlobOptions {
  storage: StorageDriver;
  logger: Logger;
  workspaceId: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  filename: string;
  headOnly: boolean;
}

/**
 * Stream one content-addressed blob: immutable ETag (= the sha), 304, single
 * Range (206/416), safe-serving disposition + nosniff (docs/security.md —
 * user content never renders on the app origin). Shared by the files content
 * route and the presentation asset download; both resolve METADATA first and
 * only then hand the bytes question here.
 */
export async function serveBlob(c: Context, opts: ServeBlobOptions): Promise<Response> {
  // Content-addressed: the ETag IS the content hash, immutable forever.
  const etag = `"${opts.sha256}"`;
  const baseHeaders: Record<string, string> = {
    'content-type': opts.contentType,
    'x-content-type-options': 'nosniff',
    'content-disposition': contentDispositionFor(opts.contentType, opts.filename),
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
  const key = blobKey(opts.workspaceId, opts.sha256);
  if (!(await opts.storage.exists(key))) {
    opts.logger.error(
      { key, driver: opts.storage.name },
      'blob unreachable: metadata row exists but storage has no bytes (local storage behind multiple replicas?)'
    );
    return c.json({ error: { code: 'not_found', message: 'File content not available' } }, 404);
  }

  const parsed = parseRangeHeader(c.req.header('range'), opts.sizeBytes);
  if (parsed.kind === 'unsatisfiable') {
    return c.body(null, 416, { ...baseHeaders, 'content-range': `bytes */${opts.sizeBytes}` });
  }

  const isPartial = parsed.kind === 'range';
  const start = isPartial ? parsed.range.start : 0;
  const end = isPartial ? parsed.range.end : opts.sizeBytes - 1;
  const length = opts.sizeBytes === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    ...baseHeaders,
    'content-length': String(length),
    ...(isPartial ? { 'content-range': `bytes ${start}-${end}/${opts.sizeBytes}` } : {})
  };
  const status = isPartial ? 206 : 200;

  if (opts.headOnly || opts.sizeBytes === 0) {
    return c.body(null, status, headers);
  }

  const nodeStream = await opts.storage.getStream(key, isPartial ? parsed.range : undefined);
  // Backpressure rides Readable.toWeb; a client abort must destroy the
  // source or every seek-away leaks a descriptor/S3 socket.
  c.req.raw.signal.addEventListener('abort', () => nodeStream.destroy());
  const web = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return c.body(web, status, headers);
}
