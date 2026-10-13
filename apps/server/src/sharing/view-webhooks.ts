import { eq, sql } from 'drizzle-orm';
import type { Db, DbConn } from '@antasphere/chassis-db';
import type { WebhookEmitter } from '@antasphere/chassis-server';
import type { Timers } from '@antasphere/chassis-server/jobs';
import type { Logger } from '@antasphere/chassis-server/logger';
import { shareTokens, shareTokenViewWindows } from '@slideless/db';
import { projectIdsOf } from '../presentations/projects.js';

/**
 * The `share_link.viewed` webhook, grouped per link (PRDCT-3483, Romain's
 * ruling of 13 October 2026): the first counted view of a link is emitted at
 * once (`views: 1`), then at most one event per link per window (five
 * minutes) carries the count of the views since the last event and their
 * facts. A view nobody listens to costs one cached lookup: no row, no job.
 *
 * The state is one `share_token_view_windows` row per link with a window
 * open. A view, inside the transaction that counts it (`recordEntryView`):
 * - no row, or a window that ended with no timer armed: OPEN a window and
 *   emit at once;
 * - a window open and no timer armed: ARM the keyed one-off timer at the
 *   window's end (`pending`), and move `since` to this view, from which the
 *   flush reads the facts (the opening view's facts already went out);
 * - a timer armed: nothing, the counter is the record.
 * The timer's FLUSH counts the link's views since the opening
 * (`access_count - count_at_start`), reads their facts from
 * `share_token_views`, emits, and deletes the row: the next view opens a new
 * window and is emitted at once again.
 *
 * What a view carries is what `share_token_views` holds: the referring
 * hosts, the placements, the browser families; never an address, never an
 * identity (PRDCT-1313). A preview link never reaches here: the counted
 * gate excludes it.
 *
 * A webhook never breaks the write it reports: the window step runs in a
 * savepoint and a failure is logged, the view stays counted.
 */

export const SHARE_LINK_VIEWED = 'share_link.viewed';
/** The queue the flush timer rides (declared by `deckJobs`, no schedule). */
export const SHARE_LINK_VIEW_WINDOW_QUEUE = 'share-link-view-window';
/** The production window: five minutes. */
export const SHARE_LINK_VIEW_WINDOW_MS = 5 * 60_000;
/** The most values of each fact list an event carries. */
const MAX_FACT_VALUES = 50;

/** The facts the viewer's entry serve already computes for a counted view. */
export interface ShareLinkViewFacts {
  workspaceId: string;
  deckId: string;
  tokenId: string;
  /** The deck version served. */
  version: number;
  /** The link's `access_count` AFTER this view's increment. */
  accessCountNow: number;
  referrerHost: string | null;
  placement: string | null;
  uaFamily: string | null;
}

/** The flush timer's payload. */
export interface ShareLinkViewWindowJob {
  tokenId: string;
}

/**
 * The chassis's emitter answers "does anyone listen?" through `wants` (one
 * map lookup when cached), which its public `WebhookEmitter` type does not
 * name: read it when it is there; an emitter without it is taken as
 * listening (the emit itself still answers null for nobody).
 */
type ListeningEmitter = WebhookEmitter & { wants?: (workspaceId: string, type: string) => Promise<boolean> };

export interface ShareLinkViewWebhooksDeps {
  db: Db;
  webhooks: WebhookEmitter;
  timers: Timers;
  logger: Logger;
  /** The grouping window; a test seam (`DeckOverrides.viewWebhookWindowMs`), five minutes in production. */
  windowMs?: number | undefined;
}

const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

export class ShareLinkViewWebhooks {
  private readonly db: Db;
  private readonly webhooks: ListeningEmitter;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly windowSeconds: number;

  constructor(deps: ShareLinkViewWebhooksDeps) {
    this.db = deps.db;
    this.webhooks = deps.webhooks;
    this.timers = deps.timers;
    this.logger = deps.logger;
    this.windowSeconds = (deps.windowMs ?? SHARE_LINK_VIEW_WINDOW_MS) / 1000;
  }

  private async listening(workspaceId: string): Promise<boolean> {
    const wants = this.webhooks.wants;
    if (typeof wants !== 'function') return true;
    return wants.call(this.webhooks, workspaceId, SHARE_LINK_VIEWED);
  }

  /**
   * One counted view, inside the transaction that counted it. Never throws:
   * a failure is logged and the view stays counted.
   */
  async onView(tx: DbConn, facts: ShareLinkViewFacts): Promise<void> {
    try {
      if (!(await this.listening(facts.workspaceId))) return;
      await tx.transaction(async (sp) => this.windowStep(sp, facts));
    } catch (err) {
      this.logger.error(
        { err, shareTokenId: facts.tokenId },
        'share_link.viewed: the window step failed — the view was still counted'
      );
    }
  }

  private async windowStep(conn: DbConn, facts: ShareLinkViewFacts): Promise<void> {
    const { tokenId } = facts;
    // OPEN: insert, or take over a window that ended with no timer armed.
    // A conflicting live row is locked by the ON CONFLICT even when its WHERE
    // refuses the update, so two first views at once open ONE window: the
    // second waits, then reads it open and arms.
    const opened = await conn.execute(sql`
      INSERT INTO share_token_view_windows
        (share_token_id, workspace_id, presentation_id, window_until, since, count_at_start, pending)
      VALUES (
        ${tokenId}, ${facts.workspaceId}, ${facts.deckId},
        now() + make_interval(secs => ${this.windowSeconds}), now(), ${facts.accessCountNow}, false
      )
      ON CONFLICT (share_token_id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        presentation_id = EXCLUDED.presentation_id,
        window_until = EXCLUDED.window_until,
        since = EXCLUDED.since,
        count_at_start = EXCLUDED.count_at_start,
        pending = false
      WHERE share_token_view_windows.window_until <= now() AND NOT share_token_view_windows.pending
      RETURNING now() AS at
    `);
    const openedAt = (opened.rows[0] as { at: Date } | undefined)?.at;
    if (openedAt !== undefined) {
      const at = iso(openedAt);
      await this.webhooks.emit(conn, {
        workspaceId: facts.workspaceId,
        type: SHARE_LINK_VIEWED,
        subjects: {
          deck: facts.deckId,
          project: await projectIdsOf(conn, facts.deckId),
          link: tokenId
        },
        data: {
          deckId: facts.deckId,
          linkId: tokenId,
          version: facts.version,
          views: 1,
          firstViewAt: at,
          lastViewAt: at,
          referrerHosts: facts.referrerHost ? [facts.referrerHost] : [],
          placements: facts.placement ? [facts.placement] : [],
          browserFamilies: facts.uaFamily ? [facts.uaFamily] : []
        }
      });
      return;
    }

    const { rows } = await conn.execute(sql`
      SELECT window_until, pending,
             window_until + make_interval(secs => ${this.windowSeconds}) <= now() AS overdue
      FROM share_token_view_windows
      WHERE share_token_id = ${tokenId}
      FOR UPDATE
    `);
    const row = rows[0] as { window_until: Date; pending: boolean; overdue: boolean } | undefined;
    if (!row) return;
    if (!row.pending) {
      // ARM: the first view after the opening. The timer is keyed per link,
      // so a re-arm replaces, never doubles.
      await this.schedule(tokenId, { at: new Date(row.window_until) });
      await conn.execute(sql`
        UPDATE share_token_view_windows SET pending = true, since = now()
        WHERE share_token_id = ${tokenId}
      `);
    } else if (row.overdue) {
      // A timer armed and still not flushed a whole window after its due
      // time (its run failed out of retries, or never ran): arm it again
      // now, or the link would stay silent for good. `window_until` moves to
      // now so this happens at most once per window.
      await this.schedule(tokenId, { inSeconds: 0 });
      await conn.execute(sql`
        UPDATE share_token_view_windows SET window_until = now()
        WHERE share_token_id = ${tokenId}
      `);
    }
  }

  private schedule(tokenId: string, when: { at: Date } | { inSeconds: number }): Promise<string> {
    return this.timers.schedule<ShareLinkViewWindowJob>(
      SHARE_LINK_VIEW_WINDOW_QUEUE,
      { tokenId },
      { ...when, key: `view:${tokenId}`, retry: { limit: 3, delaySeconds: 5, backoff: true } }
    );
  }

  /**
   * The timer's handler: say what the window grouped, then close it. A
   * window with nothing new (or no listener left) is closed silently.
   */
  async flush(tokenId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`
        SELECT workspace_id, presentation_id, count_at_start
        FROM share_token_view_windows
        WHERE share_token_id = ${tokenId}
        FOR UPDATE
      `);
      const window = rows[0] as
        { workspace_id: string; presentation_id: string; count_at_start: number } | undefined;
      if (!window) return;
      const [link] = await tx
        .select({ accessCount: shareTokens.accessCount })
        .from(shareTokens)
        .where(eq(shareTokens.id, tokenId));
      const views = (link?.accessCount ?? 0) - window.count_at_start;
      if (views > 0) {
        const facts = await this.groupedFacts(tx, tokenId);
        try {
          // A savepoint: an emit that fails must not keep the window (and
          // the link's next events) stuck.
          await tx.transaction(async (sp) => {
            await this.webhooks.emit(sp, {
              workspaceId: window.workspace_id,
              type: SHARE_LINK_VIEWED,
              subjects: {
                deck: window.presentation_id,
                project: await projectIdsOf(sp, window.presentation_id),
                link: tokenId
              },
              data: { deckId: window.presentation_id, linkId: tokenId, views, ...facts }
            });
          });
        } catch (err) {
          this.logger.error(
            { err, shareTokenId: tokenId, views },
            'share_link.viewed: the grouped emit failed — the window is closed without it'
          );
        }
      }
      await tx.delete(shareTokenViewWindows).where(eq(shareTokenViewWindows.shareTokenId, tokenId));
    });
  }

  /** The grouped views' facts, read from `share_token_views` from the window's `since` on. */
  private async groupedFacts(
    conn: DbConn,
    tokenId: string
  ): Promise<{
    version: number | null;
    firstViewAt: string;
    lastViewAt: string;
    referrerHosts: string[];
    placements: string[];
    browserFamilies: string[];
  }> {
    const { rows } = await conn.execute(sql`
      WITH w AS (SELECT since FROM share_token_view_windows WHERE share_token_id = ${tokenId}),
      v AS (
        SELECT stv.* FROM share_token_views stv, w
        WHERE stv.share_token_id = ${tokenId} AND stv.occurred_at >= w.since
      )
      SELECT
        coalesce((SELECT min(occurred_at) FROM v), (SELECT since FROM w)) AS first_view_at,
        coalesce((SELECT max(occurred_at) FROM v), now()) AS last_view_at,
        (SELECT version FROM v ORDER BY occurred_at DESC, id DESC LIMIT 1) AS version,
        ARRAY(SELECT DISTINCT referrer_host FROM v WHERE referrer_host IS NOT NULL
              ORDER BY 1 LIMIT ${MAX_FACT_VALUES}) AS referrer_hosts,
        ARRAY(SELECT DISTINCT placement FROM v WHERE placement IS NOT NULL
              ORDER BY 1 LIMIT ${MAX_FACT_VALUES}) AS placements,
        ARRAY(SELECT DISTINCT ua_family FROM v WHERE ua_family IS NOT NULL
              ORDER BY 1 LIMIT ${MAX_FACT_VALUES}) AS browser_families
    `);
    const r = rows[0] as {
      first_view_at: Date;
      last_view_at: Date;
      version: number | null;
      referrer_hosts: string[];
      placements: string[];
      browser_families: string[];
    };
    return {
      version: r.version,
      firstViewAt: iso(r.first_view_at),
      lastViewAt: iso(r.last_view_at),
      referrerHosts: r.referrer_hosts,
      placements: r.placements,
      browserFamilies: r.browser_families
    };
  }
}
