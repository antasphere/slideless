import { eq, sql } from 'drizzle-orm';
import type { Db } from '@antasphere/chassis-db';
import { shareTokenDownloads, shareTokens } from '@slideless/db';
import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * Per-download share-link events (PRDCT-2278), the sibling of the view
 * events (view-events.ts): one row per attachment a recipient takes through
 * a link — one per file, one per whole-set zip — written in the SAME
 * transaction that increments `share_tokens.download_count`, so the counter
 * and the events can never disagree. Privacy posture, the same fixed one:
 * NO IP, NO geolocation, no referrer, no user agent — the link, the version
 * served, the file's name and when. Self-hosters must be able to read this
 * file and trust it.
 *
 * A download is never a view: nothing here touches accessCount, totalViews
 * or the `slvd_` de-dupe cookie.
 */

export interface ShareTokenDownloadWrite {
  workspaceId: string;
  presentationId: string;
  shareTokenId: string;
  version: number;
  /** The attachment's name (its path relative to `downloads/`); null = the whole set as a zip. */
  name: string | null;
}

export class ShareTokenDownloadService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger
  ) {}

  /**
   * Best-effort by contract (the view-events posture): a download must
   * never turn into a 500 because an analytics write failed. Failure =
   * logged loss, of the event AND the counter together (one transaction).
   */
  async record(download: ShareTokenDownloadWrite): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(shareTokenDownloads).values({
          workspaceId: download.workspaceId,
          presentationId: download.presentationId,
          shareTokenId: download.shareTokenId,
          version: download.version,
          name: download.name
        });
        await tx
          .update(shareTokens)
          .set({ downloadCount: sql`${shareTokens.downloadCount} + 1` })
          .where(eq(shareTokens.id, download.shareTokenId));
      });
    } catch (err) {
      this.logger.error(
        { err, shareTokenId: download.shareTokenId },
        'share-token download event write failed — the download was still served'
      );
    }
  }
}

/**
 * Retention purge, the exact statement the nightly job runs (the view-events
 * pattern: bounded, index-backed batches so a large table never blows the
 * pool's statement_timeout). retentionDays <= 0 = keep forever, delete
 * nothing. Shares VIEW_EVENTS_RETENTION_DAYS with the view events — one
 * knob for both kinds of link analytics.
 */
export async function purgeShareTokenDownloads(db: Db, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const BATCH = 5000;
  let total = 0;
  for (let i = 0; i < 10_000; i++) {
    const res = await db.execute(sql`
      DELETE FROM share_token_downloads
      WHERE id IN (
        SELECT id FROM share_token_downloads
        WHERE occurred_at < now() - make_interval(days => ${retentionDays})
        ORDER BY occurred_at
        LIMIT ${BATCH}
      )
    `);
    const deleted = res.rowCount ?? 0;
    total += deleted;
    if (deleted < BATCH) break;
  }
  return total;
}
