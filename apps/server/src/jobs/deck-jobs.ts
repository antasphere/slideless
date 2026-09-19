import { sql } from 'drizzle-orm';
import type { Db } from '@antasphere/chassis-db';
import type { JobDeclaration } from '@antasphere/chassis-server/jobs';
import type { Logger } from '@antasphere/chassis-server/logger';
import type { Env } from '../env.js';
import { purgeShareTokenViews } from '../sharing/view-events.js';
import { purgeShareTokenDownloads } from '../sharing/download-events.js';

/**
 * The deck domain's three nightly jobs, declared to the chassis job runtime
 * (`createJobs(…, deckJobs(…))`), which installs their queues inside its
 * advisory-lock section and registers their pollers where they always ran.
 */
export const UPLOAD_SESSION_PURGE_QUEUE = 'upload-session-purge';
export const VIEW_EVENTS_PURGE_QUEUE = 'view-events-purge';
export const FORM_UPLOAD_PURGE_QUEUE = 'form-upload-purge';

/**
 * Upload sessions carry a ~1 h TTL (ADR 011), so the table is bounded by an
 * hour of reserve traffic plus consumed rows kept until their expiry for
 * debuggability: one unbatched, index-backed DELETE is fine (the audit-purge
 * batching lesson applies to unbounded tables only). Exported standalone so
 * the integration suite exercises the exact statement the nightly job runs.
 */
export async function purgeExpiredUploadSessions(db: Db): Promise<number> {
  const res = await db.execute(sql`DELETE FROM upload_sessions WHERE expires_at < now()`);
  return res.rowCount ?? 0;
}

export interface DeckJobsDeps {
  env: Pick<Env, 'VIEW_EVENTS_RETENTION_DAYS'>;
  db: Db;
  logger: Logger;
  /** Purge owned by a service built after the jobs (it needs the storage driver): resolved at RUN time. */
  purgeFormUploads: () => Promise<number>;
}

export function deckJobs({ env, db, logger, purgeFormUploads }: DeckJobsDeps): JobDeclaration[] {
  const viewRetentionDays = env.VIEW_EVENTS_RETENTION_DAYS;
  return [
    // Upload-session purge: expired reservations (consumed or abandoned) are
    // transient by design — ADR 011's nightly cleanup.
    {
      queue: UPLOAD_SESSION_PURGE_QUEUE,
      schedule: { cron: '0 3 * * *' },
      handler: async () => {
        const deleted = await purgeExpiredUploadSessions(db);
        logger.info({ deleted }, 'upload session purge ran');
      }
    },
    // Form upload purge (PRDCT-2403): files a respondent dropped and never
    // submitted, files an edit or a delete detached — bytes first, row second.
    {
      queue: FORM_UPLOAD_PURGE_QUEUE,
      schedule: { cron: '0 3 * * *' },
      handler: async () => {
        const removed = await purgeFormUploads();
        logger.info({ removed }, 'form upload purge ran');
      }
    },
    // Per-view analytics retention (PRDCT-1313): share_token_views grows one
    // row per counted link open, unbounded — the batched, index-backed purge
    // lives in sharing/view-events.ts so the integration suite exercises the
    // exact statement this job runs. 0 = keep forever; the queue always
    // exists so the schedule can be flipped later (audit-purge pattern).
    {
      queue: VIEW_EVENTS_PURGE_QUEUE,
      schedule: { cron: '0 3 * * *', enabled: viewRetentionDays > 0 },
      handler: async () => {
        const deleted = await purgeShareTokenViews(db, viewRetentionDays);
        logger.info({ retentionDays: viewRetentionDays, deleted }, 'view events retention purge ran');
        // The download events (PRDCT-2278) ride the same knob and the same
        // nightly run: one retention story for both kinds of link analytics.
        const deletedDownloads = await purgeShareTokenDownloads(db, viewRetentionDays);
        logger.info(
          { retentionDays: viewRetentionDays, deleted: deletedDownloads },
          'download events retention purge ran'
        );
      }
    }
  ];
}
