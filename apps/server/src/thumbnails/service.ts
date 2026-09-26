import { createHash, randomBytes } from 'node:crypto';
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
import type { RendererClient } from './renderer-client.js';

/**
 * The still images of deck versions (PRDCT-2725): which versions wait for
 * one, how they are handed to the renderer container, and how its answer
 * lands.
 *
 * The queue is the `presentation_version_thumbnails` table. A version enters
 * it two ways: a live deck's CURRENT version with no row is seeded at the
 * start of every drain (so a push, a duplicate and every deck that existed
 * before this feature are covered by the same statement; the backfill is
 * this sweep), and an older version enters when someone who can read it
 * asks for its image (`request`). A drain claims one pending row at a time
 * with a lease (`FOR UPDATE SKIP LOCKED`) and a fresh ONE-TIME KEY, hands
 * the job to the renderer, and moves on: nothing here waits for an image.
 * The renderer pulls the version's files with the key (`fileFor`) and puts
 * the image back with it (`complete`), or reports why it failed (`fail`);
 * a claim whose lease runs out (the renderer died, the network dropped) is
 * claimed again, up to MAX_ATTEMPTS. Every replica hands off and every
 * replica takes callbacks: the table is the only state.
 *
 * A drain runs right after a push in the process that took it (`kick`),
 * when a reader asks for a pending image, when a callback lands (the next
 * row behind the in-flight cap), and every minute from the worker's sweep.
 * With no renderer configured (`renderer` null) nothing is handed off; the
 * rows still accumulate, so a renderer added later catches up.
 */
export const MAX_ATTEMPTS = 3;
/** Versions handed to the renderer and not yet answered, instance-wide: the renderer's own queue is this deep. */
export const MAX_IN_FLIGHT = 4;

export interface ThumbnailDials {
  /** How long a claim holds a row: the renderer's queue wait plus its hard timeout, with room. */
  leaseSeconds: number;
  /** A failed attempt waits this long before the next claim. */
  retryDelaySeconds: number;
  /** A handoff the renderer could not take (busy, down) is retried after this long, the attempt not counted. */
  backoffSeconds: number;
}

export const DEFAULT_DIALS: ThumbnailDials = { leaseSeconds: 120, retryDelaySeconds: 60, backoffSeconds: 15 };
/** Current versions seeded per drain: bounds one sweep on an instance full of old decks. */
const SEED_BATCH = 50;
/** One line of the renderer's failure, kept for the operator. */
const ERROR_MAX = 300;

export type ThumbnailStatus =
  | { state: 'ready'; storageKey: string; sizeBytes: number; versionId: string }
  | { state: 'pending' | 'failed' | 'off' };

/** A file the renderer asked for, as the manifest holds it. */
export interface ServedFile {
  contentType: string;
  body: Buffer;
}

export interface ThumbnailServiceOptions {
  db: Db;
  storage: StorageDriver;
  logger: Logger;
  /** null = no renderer configured: this instance makes no images. */
  renderer: RendererClient | null;
  dials?: Partial<ThumbnailDials>;
}

/**
 * Where a claim's image lives. The claim's own mark is in the name (the first
 * twelve hex digits of its key's hash), so two captures of one version never
 * share an object: a slow write of a claim that was re-issued lands under its
 * own name, and the row names the winner's (verifier round 1, F7).
 */
export function thumbnailStorageKey(
  workspaceId: string,
  presentationId: string,
  versionId: string,
  claim: string
): string {
  for (const id of [workspaceId, presentationId, versionId]) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid id');
  }
  if (!/^[0-9a-f]{12}$/.test(claim)) throw new Error('invalid claim mark');
  return `thumbs/${workspaceId}/${presentationId}/${versionId}-${claim}.webp`;
}

/** The key as the renderer presents it: base64url of 32 bytes, nothing else is looked up. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

interface Claim {
  row: PresentationVersionThumbnailRow;
  token: string;
  leaseUntil: Date;
}

export class ThumbnailService {
  private readonly db: Db;
  private readonly storage: StorageDriver;
  private readonly logger: Logger;
  private readonly renderer: RendererClient | null;
  private readonly dials: ThumbnailDials;
  private draining: Promise<number> | null = null;
  private again = false;
  /** One warning per renderer outage, not one per minute per version. */
  private lastOutageLog = 0;

  constructor(opts: ThumbnailServiceOptions) {
    this.db = opts.db;
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.renderer = opts.renderer;
    this.dials = { ...DEFAULT_DIALS, ...opts.dials };
  }

  /** Whether this instance makes images at all. */
  get enabled(): boolean {
    return this.renderer !== null;
  }

  /**
   * The image of one version for a reader the CALLER has already checked
   * (canReadDeck). A version with no row yet is queued here (the lazy path
   * for older versions) and answers pending; the ask itself starts a drain,
   * which is what makes an image arrive within seconds on an instance that
   * only works inside requests.
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
    if (!row) {
      // Queued whatever the renderer situation: a renderer configured later
      // picks the row up.
      await this.db
        .insert(presentationVersionThumbnails)
        .values({
          versionId: opts.versionId,
          workspaceId: opts.workspaceId,
          presentationId: opts.presentationId
        })
        .onConflictDoNothing();
    }
    if (!this.enabled) return { state: 'off' };
    this.kick();
    return { state: 'pending' };
  }

  /** Start a drain now in this process, unless one is running (then it runs again once it ends). */
  kick(): void {
    if (!this.enabled) return;
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

  /** The worker's minute sweep: the same drain `kick` starts, awaited. */
  async sweep(): Promise<void> {
    this.kick();
    await this.idle();
  }

  /** Wait for the running drain (tests, shutdown). A drain hands off; it never waits for an image. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /**
   * Hand every claimable version to the renderer, one at a time, up to the
   * in-flight cap. Returns how many were handed off. Safe to run on several
   * replicas at once.
   */
  private async drain(): Promise<number> {
    if (!this.renderer) return 0;
    await this.seedCurrentVersions();
    await this.giveUpExhausted();
    let handed = 0;
    for (;;) {
      if ((await this.inFlight()) >= MAX_IN_FLIGHT) break;
      const claim = await this.claim();
      if (!claim) break;
      const version = await this.liveVersion(claim.row.versionId);
      if (!version) {
        // The deck was deleted since the version was queued: nothing to show anyone.
        await this.db
          .delete(presentationVersionThumbnails)
          .where(eq(presentationVersionThumbnails.versionId, claim.row.versionId));
        continue;
      }
      const outcome = await this.renderer.submit({
        job: claim.row.versionId,
        token: claim.token,
        entryPath: version.entryPath,
        deadline: claim.leaseUntil.toISOString()
      });
      if (outcome === 'queued') {
        handed += 1;
        continue;
      }
      // The renderer could not take it: give the claim back, the attempt
      // uncounted, and stop this drain (the next kick or the sweep tries
      // again after the backoff).
      await this.release(claim.row.versionId, hashToken(claim.token));
      if (outcome === 'unauthorized') {
        this.logger.error(
          'thumbnails: the renderer refused this instance (SLIDELESS_RENDERER_SECRET differs between the two containers); no image will be made until they match'
        );
      } else if (Date.now() - this.lastOutageLog > 60_000) {
        this.lastOutageLog = Date.now();
        this.logger.warn(
          { outcome },
          outcome === 'busy'
            ? 'thumbnails: the renderer queue is full, the version waits'
            : 'thumbnails: the renderer is unreachable (is it running? docker compose --profile images up -d), the version waits'
        );
      }
      break;
    }
    return handed;
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

  /** A pending row whose claims ran out (its captures never came back) is failed, never claimed again. */
  private async giveUpExhausted(): Promise<void> {
    await this.db.execute(sql`
      UPDATE presentation_version_thumbnails
         SET state = 'failed', lease_until = NULL, claim_token_hash = NULL, updated_at = now(),
             error = coalesce(error, 'the renderer never answered')
       WHERE state = 'pending'
         AND attempts >= ${MAX_ATTEMPTS}
         AND (lease_until IS NULL OR lease_until < now())`);
  }

  /** Versions handed to a renderer whose answer is still to come, instance-wide. */
  private async inFlight(): Promise<number> {
    const res = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM presentation_version_thumbnails
       WHERE state = 'pending' AND claim_token_hash IS NOT NULL AND lease_until > now()`);
    return Number((res.rows[0] as { n: number }).n);
  }

  private async claim(): Promise<Claim | null> {
    const { token, hash } = mintToken();
    const res = await this.db.execute(sql`
      UPDATE presentation_version_thumbnails
         SET lease_until = now() + make_interval(secs => ${this.dials.leaseSeconds}),
             attempts = attempts + 1,
             claim_token_hash = ${hash},
             updated_at = now()
       WHERE version_id = (
         SELECT version_id FROM presentation_version_thumbnails
          WHERE state = 'pending'
            AND attempts < ${MAX_ATTEMPTS}
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING version_id, workspace_id, presentation_id, attempts, lease_until`);
    const r = res.rows[0] as
      | {
          version_id: string;
          workspace_id: string;
          presentation_id: string;
          attempts: number;
          lease_until: Date;
        }
      | undefined;
    if (!r) return null;
    return {
      row: {
        versionId: r.version_id,
        workspaceId: r.workspace_id,
        presentationId: r.presentation_id,
        attempts: Number(r.attempts)
      } as PresentationVersionThumbnailRow,
      token,
      leaseUntil: new Date(r.lease_until)
    };
  }

  /** Give a claim back: the renderer never took it. The attempt is not counted; the key dies. */
  private async release(versionId: string, hash: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE presentation_version_thumbnails
         SET lease_until = now() + make_interval(secs => ${this.dials.backoffSeconds}),
             attempts = greatest(attempts - 1, 0),
             claim_token_hash = NULL,
             updated_at = now()
       WHERE version_id = ${versionId} AND claim_token_hash = ${hash}`);
  }

  private async liveVersion(versionId: string) {
    const [version] = await this.db
      .select({
        id: presentationVersions.id,
        workspaceId: presentationVersions.workspaceId,
        presentationId: presentationVersions.presentationId,
        entryPath: presentationVersions.entryPath,
        manifest: presentationVersions.manifest
      })
      .from(presentationVersions)
      .innerJoin(presentations, eq(presentations.id, presentationVersions.presentationId))
      .where(and(eq(presentationVersions.id, versionId), isNull(presentations.deletedAt)))
      .limit(1);
    return version ?? null;
  }

  /**
   * The claim a key opens, or null: the row must be pending, handed off
   * under THIS key (its sha256), with a live lease. Every renderer-facing
   * verb below starts here, so a key from another job, a replayed key, or a
   * key whose lease ran out opens nothing.
   */
  private async claimFor(job: string, token: string): Promise<PresentationVersionThumbnailRow | null> {
    if (!TOKEN_RE.test(token) || !/^[0-9a-f-]{36}$/.test(job)) return null;
    const hash = hashToken(token);
    const [row] = await this.db
      .select()
      .from(presentationVersionThumbnails)
      .where(
        and(
          eq(presentationVersionThumbnails.versionId, job),
          eq(presentationVersionThumbnails.state, 'pending'),
          eq(presentationVersionThumbnails.claimTokenHash, hash),
          sql`${presentationVersionThumbnails.leaseUntil} > now()`
        )
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Whether a key opens a claim right now: what the renderer routes ask
   * BEFORE reading a byte of body, so a wrong key costs one indexed read and
   * never a buffer (verifier round 1, F1). The verbs below check again on
   * the write itself, bound to the same key.
   */
  async holdsClaim(opts: { job: string; token: string }): Promise<boolean> {
    return (await this.claimFor(opts.job, opts.token)) !== null;
  }

  /**
   * One of the version's own files for the renderer: an exact manifest path
   * (traversal-safe, never an attachment under `downloads/`), read from
   * storage and capped at the size the manifest declares. The entry document
   * is served as HTML whatever the manifest claims, as on the viewer.
   * `'unauthorized'` when the key opens nothing, `null` when the path is not
   * the version's.
   */
  async fileFor(opts: {
    job: string;
    token: string;
    path: string;
  }): Promise<ServedFile | 'unauthorized' | null> {
    const row = await this.claimFor(opts.job, opts.token);
    if (!row) return 'unauthorized';
    const version = await this.liveVersion(row.versionId);
    if (!version) return null;
    const path = opts.path;
    if (!isTraversalSafeAssetPath(path) || isAttachmentPath(path)) return null;
    const entry = (version.manifest as ManifestEntry[]).find((e) => e.path === path);
    if (!entry) return null;
    const body = await readCapped(this.storage, blobKey(row.workspaceId, entry.sha256), entry.sizeBytes);
    return {
      contentType: path === version.entryPath ? 'text/html; charset=utf-8' : entry.contentType,
      body
    };
  }

  /**
   * The renderer's image for a claim: stored, then the row made ready in
   * one statement bound to the key, so two answers for one claim store once
   * and the second is refused. The caller verified the bytes are a WebP
   * within the cap. `'rejected'` when the key opens nothing (or no longer).
   */
  async complete(opts: { job: string; token: string; webp: Buffer }): Promise<'stored' | 'rejected'> {
    const row = await this.claimFor(opts.job, opts.token);
    if (!row) return 'rejected';
    const hash = hashToken(opts.token);
    const key = thumbnailStorageKey(row.workspaceId, row.presentationId, row.versionId, hash.slice(0, 12));
    await this.storage.put(key, Readable.from([opts.webp]), {
      contentType: 'image/webp',
      sizeBytes: opts.webp.length
    });
    const res = await this.db.execute(sql`
      UPDATE presentation_version_thumbnails
         SET state = 'ready', storage_key = ${key}, size_bytes = ${opts.webp.length},
             lease_until = NULL, claim_token_hash = NULL, error = NULL, updated_at = now()
       WHERE version_id = ${row.versionId} AND state = 'pending' AND claim_token_hash = ${hash}
       RETURNING version_id`);
    if (res.rows.length === 0) return 'rejected';
    this.logger.info({ versionId: row.versionId, sizeBytes: opts.webp.length }, 'thumbnails: image landed');
    this.kick();
    return 'stored';
  }

  /**
   * The renderer's failure for a claim. Every reported failure counts an
   * attempt, and the last one gives up: a transient one (the renderer could
   * not start the job before its deadline, could not read every file) only
   * waits the short backoff instead of the retry delay. Counting it is what
   * bounds a version the renderer can never finish; the deadline is rarely
   * passed in practice (the renderer's queue is as deep as the in-flight
   * cap). Only a handoff the renderer never took (`release`) costs nothing.
   * `'rejected'` when the key opens nothing.
   */
  async fail(opts: {
    job: string;
    token: string;
    error: string;
    transient?: boolean;
  }): Promise<'recorded' | 'rejected'> {
    const row = await this.claimFor(opts.job, opts.token);
    if (!row) return 'rejected';
    const message = opts.error.split('\n')[0]!.slice(0, ERROR_MAX);
    const hash = hashToken(opts.token);
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    const waitSeconds = opts.transient ? this.dials.backoffSeconds : this.dials.retryDelaySeconds;
    await this.db.execute(
      exhausted
        ? sql`
        UPDATE presentation_version_thumbnails
           SET state = 'failed', lease_until = NULL, claim_token_hash = NULL, error = ${message}, updated_at = now()
         WHERE version_id = ${row.versionId} AND state = 'pending' AND claim_token_hash = ${hash}`
        : sql`
        UPDATE presentation_version_thumbnails
           SET lease_until = now() + make_interval(secs => ${waitSeconds}),
               claim_token_hash = NULL, error = ${message}, updated_at = now()
         WHERE version_id = ${row.versionId} AND state = 'pending' AND claim_token_hash = ${hash}`
    );
    this.logger.warn(
      { versionId: row.versionId, attempt: row.attempts, err: message, transient: opts.transient === true },
      exhausted ? 'thumbnails: capture failed, giving up' : 'thumbnails: capture failed, will retry'
    );
    this.kick();
    return 'recorded';
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
