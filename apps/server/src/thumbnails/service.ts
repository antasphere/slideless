import { Readable } from 'node:stream';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@antasphere/chassis-db';
import type { StorageDriver } from '@antasphere/chassis-server/storage';
import { blobKey } from '@antasphere/chassis-server/storage';
import type { Logger } from '@antasphere/chassis-server/logger';
import { isAttachmentPath, isTraversalSafeAssetPath, type ManifestEntry } from '@slideless/contract';
import {
  presentations,
  presentationVersions,
  presentationVersionThumbnails,
  type PresentationVersionThumbnailRow
} from '@slideless/db';
import { SandboxUnavailableError, type ResolvedFile, type ThumbnailRenderer } from './renderer.js';

/**
 * The still images of deck versions (PRDCT-2725): which versions wait for
 * one, who captures them, where the bytes go.
 *
 * The queue is the `presentation_version_thumbnails` table. A version enters
 * it two ways: a live deck's CURRENT version with no row is seeded at the
 * start of every drain (so a push, a duplicate and every deck that existed
 * before this feature are covered by the same statement — the backfill is
 * this sweep), and an older version enters when someone who can read it
 * asks for its image (`request`). A drain claims one pending row at a time
 * with a lease (`FOR UPDATE SKIP LOCKED`), so replicas never capture the
 * same version twice at once, and a capture that crashes its process is
 * retried when the lease runs out, up to MAX_ATTEMPTS claims.
 *
 * A drain runs right after a push in the process that took it (`kick`), and
 * every minute from the worker's sweep job; an api-only replica never
 * captures (the renderer is null there).
 */
export const MAX_ATTEMPTS = 3;
/** How long a claim holds a row: longer than the renderer's hard timeout. */
const LEASE_SECONDS = 120;
/** A failed attempt waits this long before the next claim. */
const RETRY_DELAY_SECONDS = 60;
/** Current versions seeded per drain: bounds one sweep on an instance full of old decks. */
const SEED_BATCH = 50;

export type ThumbnailStatus =
  | { state: 'ready'; storageKey: string; sizeBytes: number; versionId: string }
  | { state: 'pending' | 'failed' | 'off' };

export interface ThumbnailServiceOptions {
  db: Db;
  storage: StorageDriver;
  logger: Logger;
  /** null = capture is off on this process (switched off, no Chromium, or an api-only replica). */
  renderer: ThumbnailRenderer | null;
}

export function thumbnailStorageKey(workspaceId: string, presentationId: string, versionId: string): string {
  for (const id of [workspaceId, presentationId, versionId]) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid id');
  }
  return `thumbs/${workspaceId}/${presentationId}/${versionId}.webp`;
}

export class ThumbnailService {
  private readonly db: Db;
  private readonly storage: StorageDriver;
  private readonly logger: Logger;
  private readonly renderer: ThumbnailRenderer | null;
  /** Set once Chromium refused to start sandboxed: capture stays off until the process restarts. */
  private sandboxDown = false;
  private draining: Promise<number> | null = null;
  private again = false;

  constructor(opts: ThumbnailServiceOptions) {
    this.db = opts.db;
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.renderer = opts.renderer;
  }

  /** Whether this process captures at all. */
  get capturing(): boolean {
    return this.renderer !== null && !this.sandboxDown;
  }

  /**
   * The image of one version for a reader the CALLER has already checked
   * (canReadDeck). A version with no row yet is queued here (the lazy path
   * for older versions) and answers pending.
   */
  async status(opts: {
    workspaceId: string;
    presentationId: string;
    versionId: string;
  }): Promise<ThumbnailStatus> {
    const [row] = await this.db
      .select()
      .from(presentationVersionThumbnails)
      .where(eq(presentationVersionThumbnails.versionId, opts.versionId))
      .limit(1);
    if (row?.state === 'ready' && row.storageKey && row.sizeBytes !== null) {
      return {
        state: 'ready',
        storageKey: row.storageKey,
        sizeBytes: row.sizeBytes,
        versionId: row.versionId
      };
    }
    if (row?.state === 'failed') return { state: 'failed' };
    // Nobody here will ever capture it: say so rather than "pending" forever.
    // The row is still queued, so a worker replica (or a restart with
    // capture on) picks it up.
    if (!row) {
      await this.db
        .insert(presentationVersionThumbnails)
        .values({
          versionId: opts.versionId,
          workspaceId: opts.workspaceId,
          presentationId: opts.presentationId
        })
        .onConflictDoNothing();
      this.kick();
    }
    return { state: this.capturing ? 'pending' : 'off' };
  }

  /** Start a drain now in this process, unless one is running (then it runs again once it ends). */
  kick(): void {
    if (!this.capturing) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = this.drain()
      .catch((err: unknown) => {
        this.logger.error({ err }, 'thumbnails: drain failed');
        return 0;
      })
      .finally(() => {
        this.draining = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /**
   * The worker's minute sweep: the same drain `kick` starts, never a second
   * one beside it (the renderer takes one capture at a time per process).
   */
  async sweep(): Promise<void> {
    this.kick();
    await this.idle();
  }

  /** Wait for the running drain (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * Capture every claimable version, one at a time. Returns how many images
   * were stored. Safe to run on several replicas at once.
   */
  private async drain(): Promise<number> {
    if (!this.capturing) return 0;
    await this.seedCurrentVersions();
    await this.giveUpExhausted();
    let stored = 0;
    for (;;) {
      if (!this.capturing) break;
      const row = await this.claim();
      if (!row) break;
      if (await this.captureOne(row)) stored += 1;
    }
    return stored;
  }

  /** Queue the current version of every live deck that has no row: the push path and the backfill in one statement. */
  private async seedCurrentVersions(): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO presentation_version_thumbnails (version_id, workspace_id, presentation_id)
      SELECT v.id, v.workspace_id, v.presentation_id
        FROM presentations p
        JOIN presentation_versions v
          ON v.presentation_id = p.id AND v.version = p.current_version
       WHERE p.deleted_at IS NULL
         AND p.current_version > 0
         AND NOT EXISTS (SELECT 1 FROM presentation_version_thumbnails t WHERE t.version_id = v.id)
       ORDER BY p.updated_at DESC
       LIMIT ${SEED_BATCH}
      ON CONFLICT DO NOTHING`);
  }

  /** A pending row whose claims ran out (its captures kept dying mid-way) is failed, never claimed again. */
  private async giveUpExhausted(): Promise<void> {
    await this.db.execute(sql`
      UPDATE presentation_version_thumbnails
         SET state = 'failed', lease_until = NULL, updated_at = now(),
             error = coalesce(error, 'the capture never finished')
       WHERE state = 'pending'
         AND attempts >= ${MAX_ATTEMPTS}
         AND (lease_until IS NULL OR lease_until < now())`);
  }

  private async claim(): Promise<PresentationVersionThumbnailRow | null> {
    const res = await this.db.execute(sql`
      UPDATE presentation_version_thumbnails
         SET lease_until = now() + make_interval(secs => ${LEASE_SECONDS}),
             attempts = attempts + 1,
             updated_at = now()
       WHERE version_id = (
         SELECT version_id FROM presentation_version_thumbnails
          WHERE state = 'pending'
            AND attempts < ${MAX_ATTEMPTS}
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING version_id, workspace_id, presentation_id, attempts`);
    const r = res.rows[0] as
      { version_id: string; workspace_id: string; presentation_id: string; attempts: number } | undefined;
    if (!r) return null;
    return {
      versionId: r.version_id,
      workspaceId: r.workspace_id,
      presentationId: r.presentation_id,
      attempts: Number(r.attempts)
    } as PresentationVersionThumbnailRow;
  }

  /** One claimed version to an image. Never throws: the row records the outcome. */
  private async captureOne(row: PresentationVersionThumbnailRow): Promise<boolean> {
    const [version] = await this.db
      .select({
        id: presentationVersions.id,
        entryPath: presentationVersions.entryPath,
        manifest: presentationVersions.manifest
      })
      .from(presentationVersions)
      .innerJoin(presentations, eq(presentations.id, presentationVersions.presentationId))
      .where(and(eq(presentationVersions.id, row.versionId), isNull(presentations.deletedAt)))
      .limit(1);
    if (!version) {
      // The deck was deleted since the version was queued: nothing to show anyone.
      await this.db
        .delete(presentationVersionThumbnails)
        .where(eq(presentationVersionThumbnails.versionId, row.versionId));
      return false;
    }

    const manifest = version.manifest as ManifestEntry[];
    const byPath = new Map(manifest.map((e) => [e.path, e]));
    const resolve = async (path: string): Promise<ResolvedFile | null> => {
      if (!isTraversalSafeAssetPath(path) || isAttachmentPath(path)) return null;
      const entry = byPath.get(path);
      if (!entry) return null;
      const body = await readCapped(this.storage, blobKey(row.workspaceId, entry.sha256), entry.sizeBytes);
      // The entry renders as a document whatever the manifest claims, as on the viewer.
      return {
        contentType: path === version.entryPath ? 'text/html; charset=utf-8' : entry.contentType,
        body
      };
    };

    try {
      const webp = await this.renderer!.capture({ entryPath: version.entryPath, resolve });
      const key = thumbnailStorageKey(row.workspaceId, row.presentationId, row.versionId);
      await this.storage.put(key, Readable.from([webp]), {
        contentType: 'image/webp',
        sizeBytes: webp.length
      });
      await this.db
        .update(presentationVersionThumbnails)
        .set({
          state: 'ready',
          storageKey: key,
          sizeBytes: webp.length,
          leaseUntil: null,
          error: null,
          updatedAt: new Date()
        })
        .where(eq(presentationVersionThumbnails.versionId, row.versionId));
      this.logger.info({ versionId: row.versionId, sizeBytes: webp.length }, 'thumbnails: captured');
      return true;
    } catch (err) {
      if (err instanceof SandboxUnavailableError) {
        // Not this version's fault: give the claim back untouched and stop
        // capturing in this process. The rows wait for a process that can.
        this.sandboxDown = true;
        await this.db
          .update(presentationVersionThumbnails)
          .set({
            leaseUntil: null,
            attempts: sql`greatest(${presentationVersionThumbnails.attempts} - 1, 0)`
          })
          .where(eq(presentationVersionThumbnails.versionId, row.versionId));
        this.logger.error(
          { err: err.message },
          "thumbnails: capture is OFF on this process — Chromium's sandbox could not start. " +
            'Deck cards show their drawn plate. On Docker, run the container with the seccomp profile ' +
            'the compose stack ships (docs/self-hosting); never run Chromium without its sandbox.'
        );
        return false;
      }
      const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      await this.db
        .update(presentationVersionThumbnails)
        .set(
          exhausted
            ? { state: 'failed', leaseUntil: null, error: message, updatedAt: new Date() }
            : {
                leaseUntil: sql`now() + make_interval(secs => ${RETRY_DELAY_SECONDS})`,
                error: message,
                updatedAt: new Date()
              }
        )
        .where(eq(presentationVersionThumbnails.versionId, row.versionId));
      this.logger.warn(
        { versionId: row.versionId, attempt: row.attempts, err: message },
        exhausted ? 'thumbnails: capture failed, giving up' : 'thumbnails: capture failed, will retry'
      );
      return false;
    }
  }
}

/** A stored blob into memory, refusing more than the manifest said it holds. */
async function readCapped(storage: StorageDriver, key: string, maxBytes: number): Promise<Buffer> {
  const stream = await storage.getStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error('blob larger than its manifest entry');
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
