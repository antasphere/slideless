import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { files, type Db, type FileRow } from '@slideless/db';
import { blobKey, type StorageDriver } from '../storage/driver.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';
import type { Logger } from '../logger.js';

export class FileTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`file exceeds the ${limitBytes}-byte limit`);
  }
}

/**
 * Through-app streamed uploads: the body is spooled to DATA_DIR/tmp while
 * sha256 + size accumulate (never buffered in memory), the size cap enforced
 * mid-stream, then the spool streams into the driver under the
 * content-addressed key. Upload of bytes that already exist for the
 * workspace is idempotent — same row comes back.
 */
export class FileService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageDriver,
    private readonly spoolDir: string,
    private readonly logger: Logger
  ) {}

  async upload(opts: {
    workspaceId: string;
    createdBy: string;
    originalName: string;
    contentType: string;
    body: Readable;
    maxBytes: number;
  }): Promise<{ file: FileRow; deduplicated: boolean }> {
    await mkdir(this.spoolDir, { recursive: true });
    const spoolPath = join(this.spoolDir, randomUUID());
    const hash = createHash('sha256');
    let size = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > opts.maxBytes) {
          cb(new FileTooLargeError(opts.maxBytes));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      }
    });

    try {
      await pipeline(opts.body, meter, createWriteStream(spoolPath, { flags: 'wx' }));
      const sha256 = hash.digest('hex');

      // Idempotent per (workspace, sha): reuse (and revive) an existing row.
      const [existing] = await this.db
        .select()
        .from(files)
        .where(and(eq(files.workspaceId, opts.workspaceId), eq(files.sha256, sha256)))
        .limit(1);
      const key = blobKey(opts.workspaceId, sha256);

      if (existing) {
        if (!(await this.storage.exists(key))) {
          await this.storage.put(key, createReadStream(spoolPath), {
            contentType: existing.contentType,
            sizeBytes: size
          });
        }
        if (existing.deletedAt) {
          await this.db.update(files).set({ deletedAt: null }).where(eq(files.id, existing.id));
          existing.deletedAt = null;
        }
        return { file: existing, deduplicated: true };
      }

      await this.storage.put(key, createReadStream(spoolPath), {
        contentType: opts.contentType,
        sizeBytes: size
      });
      const [row] = await this.db
        .insert(files)
        .values({
          workspaceId: opts.workspaceId,
          sha256,
          sizeBytes: size,
          contentType: opts.contentType,
          originalName: opts.originalName,
          createdBy: opts.createdBy
        })
        .returning();
      return { file: row!, deduplicated: false };
    } finally {
      await rm(spoolPath, { force: true });
    }
  }

  async get(workspaceId: string, id: string): Promise<FileRow | null> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.workspaceId, workspaceId)))
      .limit(1);
    if (!row || row.deletedAt) return null;
    return row;
  }

  async list(
    workspaceId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<{ files: FileRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    // The soft-delete filter MUST be SQL-side: a JS filter after the fetch
    // would shrink pages below the limit and break cursor correctness.
    const rows = await this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          isNull(files.deletedAt),
          ...(cursorId
            ? [
                keysetBefore({
                  table: files,
                  id: files.id,
                  createdAt: files.createdAt,
                  workspaceId: files.workspaceId,
                  cursorId,
                  workspace: workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(files.createdAt), desc(files.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { files: page, nextCursor };
  }

  /** Soft-deletes the row and removes the blob (one row per (ws, sha) by constraint). */
  async delete(row: FileRow): Promise<void> {
    // The soft-delete is authoritative; blob removal is best-effort cleanup —
    // a storage failure must not fail the request (a re-upload self-heals via
    // content addressing). Now that the driver surfaces real transport errors,
    // swallow them here rather than in the driver.
    await this.db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, row.id));
    try {
      await this.storage.delete(blobKey(row.workspaceId, row.sha256));
    } catch (err) {
      this.logger.error({ err, fileId: row.id }, 'blob delete failed — row soft-deleted, blob orphaned');
    }
  }

  async spoolDirUsable(): Promise<boolean> {
    try {
      await mkdir(this.spoolDir, { recursive: true });
      const s = await stat(this.spoolDir);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
}
