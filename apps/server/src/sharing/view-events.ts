import { and, desc, eq, sql } from 'drizzle-orm';
import { EMBED_PLACEMENT_RE } from '@slideless/contract';
import { shareTokenViews, type Db, type ShareTokenViewRow } from '@slideless/db';
import type { Logger } from '../logger.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';

/**
 * Per-view share-link analytics (PRDCT-1313): one event row per COUNTED
 * view — written by the viewer's entry serve under exactly the gate that
 * increments accessCount, so the event stream and the counters can never
 * disagree. Privacy posture, fixed by decision: NO IP, NO geolocation, NO
 * full referrer URL — the referring HOST, a sanitized placement label, and
 * a coarse browser family are the whole record. Self-hosters must be able
 * to read this file and trust it.
 */

/**
 * Longest host this table will store. A DNS name maxes out at 253 chars and
 * `:65535` adds 6; anything past that is not a real host. The cap matters
 * because `Referer` is VISITOR-supplied and this column is unbounded `text`
 * on an unbounded table: `new URL()` happily parses a 4000-char host, so
 * without it any share-link holder can write header-sized rows at request
 * rate (entry views are not rate-limited — only password attempts are).
 */
const REFERRER_HOST_MAX = 260;

/**
 * Host of the Referer header, or null when absent, unparsable, or longer
 * than a real host can be. The full URL (path, query) is deliberately
 * discarded before it can be stored. Over-long hosts answer null rather
 * than a truncated string: the same posture as viewPlacement, and a
 * truncated host would read in the dashboard as a real referring site.
 */
export function viewReferrerHost(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    const host = new URL(referer).host;
    return host === '' || host.length > REFERRER_HOST_MAX ? null : host;
  } catch {
    return null;
  }
}

/**
 * Placement labels are owner-chosen slugs, never free text. The shape is
 * shared with the snippet builder (EMBED_PLACEMENT_RE) so what the CLI and
 * dashboard emit is exactly what this sanitizer admits.
 */
const PLACEMENT_RE = EMBED_PLACEMENT_RE;

/**
 * The entry URL's `?p=` placement label, sanitized: at most 64 chars from
 * [A-Za-z0-9._-]. Anything else (absent, too long, illegal chars) → null —
 * the label is stored verbatim afterwards, so the charset gate is what
 * keeps arbitrary visitor-supplied text out of the owner's dashboard.
 */
export function viewPlacement(raw: string | undefined): string | null {
  if (!raw || !PLACEMENT_RE.test(raw)) return null;
  return raw;
}

/**
 * Coarse browser family from the User-Agent header: chrome / firefox /
 * safari / edge / bot / other — family only, never a version, never the
 * raw UA string. A tiny in-repo mapper on purpose (no dependency): the
 * order matters because Chrome UAs contain "Safari", Edge UAs contain
 * "Chrome", and headless/bot UAs may contain either.
 */
export function viewUaFamily(ua: string | undefined): string | null {
  if (!ua || ua.trim() === '') return null;
  if (
    /bot|crawl|spider|slurp|headless|curl|wget|python|libwww|httpclient|okhttp|node-fetch|axios|go-http/i.test(
      ua
    )
  ) {
    return 'bot';
  }
  if (/edg(e|a|ios)?\//i.test(ua)) return 'edge';
  if (/opr\/|opera/i.test(ua)) return 'other';
  if (/chrome\/|crios\//i.test(ua)) return 'chrome';
  if (/firefox\/|fxios\//i.test(ua)) return 'firefox';
  if (/safari\//i.test(ua)) return 'safari';
  return 'other';
}

export interface ShareTokenViewWrite {
  workspaceId: string;
  presentationId: string;
  shareTokenId: string;
  version: number;
  referrerHost: string | null;
  placement: string | null;
  uaFamily: string | null;
}

export class ShareTokenViewService {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger
  ) {}

  /**
   * Best-effort by contract (the AuditService.write posture): the entry
   * serve — and the accessCount increment that already committed — must
   * never turn into a 500 because an analytics insert failed. Failure =
   * logged loss.
   */
  async record(view: ShareTokenViewWrite): Promise<void> {
    try {
      await this.db.insert(shareTokenViews).values({
        workspaceId: view.workspaceId,
        presentationId: view.presentationId,
        shareTokenId: view.shareTokenId,
        version: view.version,
        referrerHost: view.referrerHost,
        placement: view.placement,
        uaFamily: view.uaFamily
      });
    } catch (err) {
      this.logger.error(
        { err, shareTokenId: view.shareTokenId },
        'share-token view event write failed — the view was still counted'
      );
    }
  }

  /**
   * One token's view events, newest first, keyset-paginated on
   * (occurred_at, id). The cursor subquery is scoped to THIS token (the
   * share-tokens listing precedent): a foreign token's cursor cannot
   * position here. Rows whose token was deleted (share_token_id nulled)
   * are deliberately unreachable through this per-token surface.
   */
  async list(
    workspaceId: string,
    presentationId: string,
    tokenId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<{ views: ShareTokenViewRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select()
      .from(shareTokenViews)
      .where(
        and(
          eq(shareTokenViews.shareTokenId, tokenId),
          eq(shareTokenViews.presentationId, presentationId),
          eq(shareTokenViews.workspaceId, workspaceId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: shareTokenViews,
                  id: shareTokenViews.id,
                  createdAt: shareTokenViews.occurredAt,
                  workspaceId: shareTokenViews.shareTokenId,
                  cursorId,
                  workspace: tokenId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(shareTokenViews.occurredAt), desc(shareTokenViews.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { views: page, nextCursor };
  }
}

/** Wire mapping shared by the API handler (contract shareTokenViewSchema). */
export function shareTokenViewToWire(v: ShareTokenViewRow): {
  id: string;
  version: number;
  occurredAt: string;
  referrerHost: string | null;
  placement: string | null;
  uaFamily: string | null;
} {
  return {
    id: v.id,
    version: v.version,
    occurredAt: v.occurredAt.toISOString(),
    referrerHost: v.referrerHost,
    placement: v.placement,
    uaFamily: v.uaFamily
  };
}

/**
 * Retention purge, exported standalone so the integration suite exercises
 * the exact statement the nightly job runs (the upload-session-purge
 * pattern). share_token_views is UNBOUNDED, so deletes run in bounded
 * index-backed batches (the audit-purge lesson: one huge DELETE would
 * seq-scan and blow the pool's statement_timeout, and retention would then
 * silently never run). retentionDays <= 0 = keep forever, delete nothing.
 */
export async function purgeShareTokenViews(db: Db, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const BATCH = 5000;
  let total = 0;
  for (let i = 0; i < 10_000; i++) {
    const res = await db.execute(sql`
      DELETE FROM share_token_views
      WHERE id IN (
        SELECT id FROM share_token_views
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
