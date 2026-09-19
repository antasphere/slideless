import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import type { BucketDeclaration, RateLimiters } from '@antasphere/chassis-server/middleware';

/**
 * The deck domain's own rate-limit buckets, declared to the chassis factory
 * (`createRateLimiters(env, logger, deckBuckets)`): same store, same
 * `rl:<prefix>` keys as every chassis bucket.
 */
export const deckBuckets = {
  /**
   * Viewer password attempts (Phase 4) — share-link passwords are
   * low-entropy human secrets, so failed guesses burn from a tight bucket
   * keyed per IP AND per token. Successful unlocks never consume.
   */
  viewerPassword: { prefix: 'viewer-pw', points: 10, durationSec: 15 * 60 },
  /**
   * Public token-authed annotation creates (Phase 5) — keyed per IP AND per
   * token (invalid secrets burn a per-IP point) so a leaked annotator link
   * can spam one deck only as fast as this bucket refills.
   */
  viewerAnnotate: { prefix: 'viewer-annot', points: 60, durationSec: 10 * 60 },
  /**
   * Public token-authed form submissions (ADR 022) — same keying as
   * viewerAnnotate (per IP + token; invalid share secrets and failed
   * edit-secret lookups burn points too), so a broadcast link can be spammed
   * only as fast as this bucket refills; the per-deck response cap backstops.
   */
  viewerFormSubmit: { prefix: 'viewer-form', points: 30, durationSec: 10 * 60 },
  /**
   * The form edit-link email leg — a PUBLIC endpoint that sends mail is a
   * spam vector, so tight, keyed per IP + token AND per target address.
   */
  viewerFormEmail: { prefix: 'viewer-form-mail', points: 5, durationSec: 15 * 60 },
  /**
   * Form file uploads (PRDCT-2403) on the token-session viewer surface: an
   * anonymous write-BYTES path, keyed per IP + token. 60 per 10 minutes
   * covers a respondent filling several file fields; the byte bounds are the
   * per-file, per-response and per-deck ceilings, not this bucket.
   */
  viewerFormUpload: { prefix: 'viewer-form-upload', points: 60, durationSec: 10 * 60 }
} satisfies Record<string, BucketDeclaration>;

/** What boot hands around: the chassis buckets plus the five above. */
export type DeckRateLimiters = RateLimiters & Record<keyof typeof deckBuckets, RateLimiterAbstract>;
