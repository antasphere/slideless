import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Context } from 'hono';
import { ZipFile } from 'yazl';
import type { Attachment } from '@slideless/contract';
import type { Logger } from '../logger.js';
import { encodeContentDisposition } from '../files/http.js';
import { blobKey, type StorageDriver } from '../storage/driver.js';

/**
 * The attachments zip (PRDCT-2278): every `downloads/` entry of one version,
 * streamed as ONE store-only archive — no compression (the files are the
 * author's, mostly already-compressed media or archives; deflate would cost
 * CPU for nothing), no whole-archive buffering (yazl writes the local
 * headers, the bytes and the central directory as they come, so peak memory
 * is one blob stream's window whatever the set weighs). The same library
 * and the same sequential pump as the workspace export (api/export.ts):
 * one blob stream open at a time, a client abort tears down both, an error
 * mid-pump truncates the archive rather than finishing it "valid" but
 * incomplete. Shared by the recipient route on the viewer origin and the
 * owner route on the app origin; each caller passes its own header set.
 */

/** The longest slug the zip filename carries before `-v<n>.zip`. */
export const ZIP_SLUG_MAX_LENGTH = 60;

/**
 * `<deck title slug>-v<n>.zip`: lowercase ASCII letters and digits with
 * single dashes, accents stripped, capped, `deck` when nothing survives.
 * The title is owner input; the slug is what lands as a filename on the
 * recipient's disk, so nothing but `[a-z0-9-]` gets through.
 */
export function attachmentsZipFilename(title: string, version: number): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ZIP_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return `${slug === '' ? 'deck' : slug}-v${version}.zip`;
}

export interface ZipEntry {
  /** The blob's storage key. */
  key: string;
  /** The entry's path inside the archive — already safe (the caller's duty). */
  name: string;
  mtime: Date;
}

export interface ServeZipOptions {
  storage: StorageDriver;
  logger: Logger;
  /** For the log lines only. */
  workspaceId: string;
  entries: ZipEntry[];
  /** The download filename. */
  filename: string;
  headOnly: boolean;
  /** Headers merged over the defaults (the viewer passes the ADR 012 sandbox set). */
  extraHeaders?: Record<string, string>;
  /** What the archive is, for the log lines ("attachments", "form files"). */
  what: string;
}

export interface ServeAttachmentsZipOptions {
  storage: StorageDriver;
  logger: Logger;
  workspaceId: string;
  /** The version's attachments, in manifest order; each becomes one entry named by its `name`. */
  attachments: Attachment[];
  /** The download filename (attachmentsZipFilename). */
  filename: string;
  /** The entries' modification time — the version's commit time, so a re-download is byte-identical. */
  mtime: Date;
  headOnly: boolean;
  /** Headers merged over the defaults (the viewer passes the ADR 012 sandbox set). */
  extraHeaders?: Record<string, string>;
}

/** The attachments of one version as one archive (the recipient route and the owner route). */
export async function serveAttachmentsZip(c: Context, opts: ServeAttachmentsZipOptions): Promise<Response> {
  return serveZip(c, {
    storage: opts.storage,
    logger: opts.logger,
    workspaceId: opts.workspaceId,
    entries: opts.attachments.map((a) => ({
      key: blobKey(opts.workspaceId, a.sha256),
      name: a.name,
      mtime: opts.mtime
    })),
    filename: opts.filename,
    headOnly: opts.headOnly,
    ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    what: 'attachments'
  });
}

/**
 * Stream the archive. Every blob is checked for presence BEFORE the status
 * line goes out: a missing one is a clean 404 (the serveBlob posture — with
 * local storage behind several replicas the bytes may live on another
 * disk), never a 200 that dies mid-body. `attachment` + `nosniff` always;
 * `no-store` because the archive is assembled per request and the viewer
 * URL is not content-addressed. No Content-Length: the size of a streamed
 * store archive is only known at the end. Shared by the attachments zip
 * above and the form-response files zips (PRDCT-2403, api/presentations.ts).
 */
export async function serveZip(c: Context, opts: ServeZipOptions): Promise<Response> {
  const { storage, logger, workspaceId, what } = opts;
  for (const entry of opts.entries) {
    if (!(await storage.exists(entry.key))) {
      logger.error(
        { key: entry.key, driver: storage.name },
        `${what} blob unreachable: a row names it but storage has no bytes`
      );
      return c.json({ error: { code: 'not_found', message: 'File content not available' } }, 404);
    }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    'content-disposition': encodeContentDisposition('attachment', opts.filename),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...(opts.extraHeaders ?? {})
  };
  if (opts.headOnly) return c.body(null, 200, headers);

  const zip = new ZipFile();
  // @types/yazl types outputStream as the legacy NodeJS.ReadableStream; at
  // runtime it is a real Readable (a PassThrough), which destroy/toWeb need.
  const output = zip.outputStream as Readable;

  let currentBlobStream: Readable | null = null;
  c.req.raw.signal.addEventListener('abort', () => {
    currentBlobStream?.destroy();
    output.destroy(new Error(`client aborted the ${what} download`));
  });

  void (async () => {
    for (const entry of opts.entries) {
      // Destroying yazl's output does not stop the pump (the export lesson):
      // check the signal explicitly or a cancelled download keeps reading.
      if (c.req.raw.signal.aborted) throw new Error(`client aborted the ${what} download`);
      const stream = await storage.getStream(entry.key);
      currentBlobStream = stream;
      zip.addReadStream(stream, entry.name, { compress: false, mtime: entry.mtime });
      await finished(stream);
      currentBlobStream = null;
    }
    zip.end();
  })().catch((err: unknown) => {
    if (c.req.raw.signal.aborted) {
      logger.info({ workspaceId }, `${what} download cancelled by the client`);
    } else {
      logger.error({ err, workspaceId }, `${what} zip pump failed — download truncated`);
    }
    currentBlobStream?.destroy();
    output.destroy(err instanceof Error ? err : new Error(String(err)));
  });

  return c.body(Readable.toWeb(output) as unknown as ReadableStream, 200, headers);
}
