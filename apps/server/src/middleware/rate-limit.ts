import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type RateLimiterAbstract
} from 'rate-limiter-flexible';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { EntitlementService, Principal } from '@antasphere/chassis-contract';
import type { Env } from '../env.js';
import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * Auth-surface rate limits (ours, not Better Auth's built-in): login, OTP
 * sends, invitation acceptance, setup attempts, API-key verification
 * failures. Memory backend per replica by default; Redis when REDIS_URL is
 * set so limits hold across replicas (Profile B).
 */
/** Workspace-creation attempts one person gets per hour; an address gets ten times that. */
export const WORKSPACE_CREATE_PER_PERSON = 60;

export interface RateLimiters {
  login: RateLimiterAbstract;
  otp: RateLimiterAbstract;
  invitationAccept: RateLimiterAbstract;
  setup: RateLimiterAbstract;
  apiKeyFailures: RateLimiterAbstract;
  /** RFC 7591 dynamic client registration — unauthenticated by design, so tight. */
  oauthRegister: RateLimiterAbstract;
  /** OAuth token endpoint — a full connector dance is ~8 requests, so generous. */
  oauthToken: RateLimiterAbstract;
  /** The bundled /mcp endpoint — MCP clients are chatty, so generous per IP. */
  mcp: RateLimiterAbstract;
  /** Password reset requests — per IP AND per email, tight (abuse + enumeration). */
  passwordReset: RateLimiterAbstract;
  /** Full-workspace export — expensive streams, keyed per IP AND per user. */
  workspaceExport: RateLimiterAbstract;
  /** Break-glass superadmin recovery — a rare operator action, tight per IP. */
  breakGlass: RateLimiterAbstract;
  /**
   * Workspace creation, the PER-PERSON bucket (key `u:<userId>`) — a rare
   * human act; on cloud every attempt is a call to the hub, and the cloud
   * zero-membership session resolves no principal, so the general quota
   * never sees it. Spent by the handler (api/workspaces.ts) once the caller
   * is IDENTIFIED — never by an unauthenticated request, never by a method
   * that is not the POST.
   */
  workspaceCreate: RateLimiterAbstract;
  /**
   * Workspace creation, the PER-ADDRESS bucket — ten people's worth of the
   * per-person one, spent only by identified callers the per-person bucket
   * let through. One colleague can therefore take at most a tenth of it:
   * an office behind one NAT address is never locked out by one person,
   * while a farm of accounts behind one address is still bounded.
   */
  workspaceCreateAddress: RateLimiterAbstract;
  /** The unauthenticated OpenAPI document — cheap now that it is a boot-time buffer, but still anonymous. */
  openapiDoc: RateLimiterAbstract;
  /**
   * Viewer password attempts (Phase 4) — share-link passwords are
   * low-entropy human secrets, so failed guesses burn from a tight bucket
   * keyed per IP AND per token. Successful unlocks never consume.
   */
  viewerPassword: RateLimiterAbstract;
  /**
   * Public token-authed annotation creates (Phase 5) — keyed per IP AND per
   * token (invalid secrets burn a per-IP point) so a leaked annotator link
   * can spam one deck only as fast as this bucket refills.
   */
  viewerAnnotate: RateLimiterAbstract;
  /**
   * Public token-authed form submissions (ADR 022) — same keying as
   * viewerAnnotate (per IP + token; invalid share secrets and failed
   * edit-secret lookups burn points too), so a broadcast link can be spammed
   * only as fast as this bucket refills; the per-deck response cap backstops.
   */
  viewerFormSubmit: RateLimiterAbstract;
  /**
   * The form edit-link email leg — a PUBLIC endpoint that sends mail is a
   * spam vector, so tight, keyed per IP + token AND per target address.
   */
  viewerFormEmail: RateLimiterAbstract;
  /**
   * Form file uploads (PRDCT-2403) on the token-session viewer surface: an
   * anonymous write-BYTES path, keyed per IP + token. 60 per 10 minutes
   * covers a respondent filling several file fields; the byte bounds are the
   * per-file, per-response and per-deck ceilings, not this bucket.
   */
  viewerFormUpload: RateLimiterAbstract;
  /**
   * Shared factory riding the same backend (Redis when REDIS_URL is set,
   * memory otherwise) for buckets sized at runtime — the per-principal
   * request quota creates one limiter per distinct quota tier through this.
   */
  make: (prefix: string, points: number, durationSec: number) => RateLimiterAbstract;
}

export async function createRateLimiters(env: Pick<Env, 'REDIS_URL'>, logger: Logger): Promise<RateLimiters> {
  let make: (prefix: string, points: number, durationSec: number) => RateLimiterAbstract;

  if (env.REDIS_URL) {
    const { Redis } = await import('ioredis');
    const client = new Redis(env.REDIS_URL, { enableOfflineQueue: false });
    client.on('error', (err: Error) => logger.error({ err }, 'redis rate-limit store error'));
    make = (prefix, points, duration) =>
      new RateLimiterRedis({
        storeClient: client,
        keyPrefix: `rl:${prefix}`,
        points,
        duration,
        // If Redis blips, fail open to memory rather than dropping requests.
        insuranceLimiter: new RateLimiterMemory({ points, duration })
      });
    logger.info('rate limiting backed by redis');
  } else {
    make = (prefix, points, duration) =>
      new RateLimiterMemory({ keyPrefix: `rl:${prefix}`, points, duration });
  }

  return {
    login: make('login', 10, 15 * 60),
    otp: make('otp', 5, 10 * 60),
    invitationAccept: make('inv-accept', 10, 60 * 60),
    setup: make('setup', 5, 60 * 60),
    apiKeyFailures: make('key-fail', 20, 15 * 60),
    oauthRegister: make('oauth-dcr', 10, 60 * 60),
    oauthToken: make('oauth-token', 60, 60),
    mcp: make('mcp', 120, 60),
    passwordReset: make('pw-reset', 5, 10 * 60),
    workspaceExport: make('ws-export', 5, 600),
    breakGlass: make('break-glass', 10, 60 * 60),
    workspaceCreate: make('ws-create', WORKSPACE_CREATE_PER_PERSON, 60 * 60),
    workspaceCreateAddress: make('ws-create-ip', WORKSPACE_CREATE_PER_PERSON * 10, 60 * 60),
    openapiDoc: make('openapi', 60, 60),
    viewerPassword: make('viewer-pw', 10, 15 * 60),
    viewerAnnotate: make('viewer-annot', 60, 10 * 60),
    viewerFormSubmit: make('viewer-form', 30, 10 * 60),
    viewerFormEmail: make('viewer-form-mail', 5, 15 * 60),
    viewerFormUpload: make('viewer-form-upload', 60, 10 * 60),
    make
  };
}

/**
 * Client identity for buckets and audit. x-forwarded-for is only believed
 * when TRUST_PROXY says a proxy we control sets it; otherwise the socket
 * address wins and spoofed headers are ignored. We read the RIGHTMOST hop —
 * the one appended (or set) by the trusted proxy itself; the leftmost is
 * client-claimed and spoofable whenever the proxy appends rather than
 * overwrites. Note the compose caveat: without a proxy, Docker NAT can
 * collapse external clients onto one address — per-IP limits are only as
 * granular as what the socket sees.
 */
export function makeClientIp(trustProxy: boolean): ClientIpFn {
  return (c) => {
    if (trustProxy) {
      const hops = c.req.header('x-forwarded-for')?.split(',');
      const xff = hops?.[hops.length - 1]?.trim();
      if (xff) return xff;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      // No socket (tests via app.request()) — one shared bucket.
      return 'unknown';
    }
  };
}

export type ClientIpFn = (c: Context) => string;

/** 429 with the standard wire shape when the bucket is empty. */
/**
 * WHEN a request costs a point.
 *
 *  - `arrival` (default): consume before the handler runs. Correct for
 *    everything whose cost IS the arrival — sending mail, accepting an
 *    invitation, registering an OAuth client, running setup.
 *  - `failure`: check the bucket before the handler (an exhausted bucket
 *    still 429s immediately) but consume only when the handler answered a
 *    client error. Correct for CREDENTIAL-VERIFICATION walls: on arrival, the
 *    limiter cannot yet know whether the caller is the account owner, so an
 *    email-keyed bucket consumed up front lets anyone who knows an address
 *    spend that account's whole budget and lock its owner out — including on
 *    the requests the owner themselves gets right. Consuming on failure keeps
 *    the brute-force wall exactly as tight (a guess is a failure) while a
 *    legitimate sign-in costs nothing.
 */
export interface RateLimitOptions {
  consumeOn?: 'arrival' | 'failure';
}

const RATE_LIMITED_BODY = {
  error: { code: 'rate_limited', message: 'Too many requests, slow down' }
} as const;

export function rateLimit(
  limiter: RateLimiterAbstract,
  clientIp: ClientIpFn,
  extraKeys?: (c: Context) => Promise<string[]>,
  options: RateLimitOptions = {}
): MiddlewareHandler {
  const consumeOn = options.consumeOn ?? 'arrival';
  return async (c, next) => {
    const keys = [clientIp(c), ...(extraKeys ? await extraKeys(c) : [])];

    if (consumeOn === 'arrival') {
      try {
        for (const key of keys) {
          await limiter.consume(key);
        }
      } catch {
        return c.json(RATE_LIMITED_BODY, 429);
      }
      return next();
    }

    // Failure-only: read the buckets (no consume) and refuse an exhausted one
    // BEFORE the handler, so a drained wall still costs an attacker nothing to
    // hit and no credential check runs. Backend errors fail open, matching
    // every other limiter here.
    for (const key of keys) {
      const state = await limiter.get(key).catch(() => null);
      if (state && state.remainingPoints <= 0 && state.msBeforeNext > 0) {
        return c.json(RATE_LIMITED_BODY, 429);
      }
    }
    await next();
    // 4xx/5xx = the credential was not accepted. Better Auth answers 401 for a
    // bad password, 400 for a malformed attempt, 403 for a refused origin —
    // all of them are attempts that must cost.
    if (c.res.status >= 400) {
      for (const key of keys) {
        await limiter.consume(key).catch(() => {});
      }
    }
  };
}

/**
 * Per-email key for OTP sends and password login (per IP AND per email): the
 * email key keeps per-account protection intact when NAT or a rotating
 * attacker collapses/expands the IP dimension.
 */
export async function emailKeyOf(c: Context): Promise<string[]> {
  try {
    const body = (await c.req.raw.clone().json()) as { email?: string };
    if (body?.email && typeof body.email === 'string') {
      return [`email:${body.email.toLowerCase().trim()}`];
    }
  } catch {
    // non-JSON body — the IP key alone applies
  }
  return [];
}

// ── General per-principal request quota (I3) ────────────────────────────────

/**
 * Bucket key for the general API quota, derived ONLY from the authenticated
 * principal — never from a client-supplied header, so a caller can neither
 * rotate its own bucket nor fill another principal's. Two API keys of the
 * same user are separate buckets (a leaked key can be throttled/revoked
 * without starving the owner's other integrations); the same user's session
 * is a third.
 */
export function principalBucketKey(p: Principal): string {
  if (p.via === 'api_key') return `key:${p.apiKeyId ?? p.userId}`;
  if (p.via === 'oauth') return `oauth:${p.userId}`;
  return `session:${p.userId}`;
}

/** Outcome of one quota consume — everything the HTTP layer needs for headers. */
export interface QuotaDecision {
  ok: boolean;
  /** The sustained per-minute limit (what RateLimit-Limit reports). */
  limit: number;
  remaining: number;
  /** Seconds until the sustained window resets. */
  resetSeconds: number;
  /** Present when ok=false: seconds the client should wait before retrying. */
  retryAfterSeconds?: number;
}

export interface RequestQuotaService {
  /** Consume one request for this principal; null = quota disabled (no headers). */
  consume(principal: Principal): Promise<QuotaDecision | null>;
}

/** RateLimit draft headers + the X- legacy mirror; reset values are delta seconds. */
export function quotaHeaderEntries(d: QuotaDecision): Array<[string, string]> {
  const remaining = String(Math.max(0, d.remaining));
  const reset = String(Math.max(0, d.resetSeconds));
  const limit = String(d.limit);
  return [
    ['RateLimit-Limit', limit],
    ['RateLimit-Remaining', remaining],
    ['RateLimit-Reset', reset],
    ['X-RateLimit-Limit', limit],
    ['X-RateLimit-Remaining', remaining],
    ['X-RateLimit-Reset', reset]
  ];
}

export interface RequestQuotaDeps {
  entitlements: EntitlementService;
  /** The shared limiter factory from createRateLimiters — Redis-backed when configured. */
  make: RateLimiters['make'];
  logger: Logger;
}

/**
 * Per-principal request quota over the shared rate-limit backend. Two buckets
 * per principal: a sustained per-minute window (the quota agents budget
 * against — headers describe this one) and a 1-second spike cap that smooths
 * thundering herds without burning sustained points on rejected spikes.
 *
 * Limits come from EntitlementService.getRequestQuota so a plan-aware edition
 * varies them per principal; limiter instances are created lazily per
 * distinct quota size (a product has a handful of plans, not thousands) and
 * the size is part of the store prefix, so a plan change moves the principal
 * to a fresh bucket instead of misreading the old counter.
 *
 * Failure posture matches the auth-surface limiters: Redis outages fall back
 * to the per-replica insurance limiter inside `make`; any other backend or
 * entitlement failure logs and FAILS OPEN (availability over throttling — the
 * quota is a cost control, not an authz boundary; authz stays fail-closed).
 */
export function createRequestQuota({ entitlements, make, logger }: RequestQuotaDeps): RequestQuotaService {
  const sustained = new Map<number, RateLimiterAbstract>();
  const burst = new Map<number, RateLimiterAbstract>();
  const limiterFor = (
    cache: Map<number, RateLimiterAbstract>,
    prefix: string,
    points: number,
    durationSec: number
  ): RateLimiterAbstract => {
    let limiter = cache.get(points);
    if (!limiter) {
      limiter = make(`${prefix}:${points}`, points, durationSec);
      cache.set(points, limiter);
    }
    return limiter;
  };

  return {
    async consume(principal) {
      let perMinute: number;
      let burstPerSecond: number;
      try {
        ({ perMinute, burstPerSecond } = await entitlements.getRequestQuota(principal));
      } catch (err) {
        logger.error({ err }, 'request quota lookup failed — allowing request');
        return null;
      }
      // Guard a product's custom (non-TS-checked) EntitlementService returning
      // a non-numeric quota: a bare `undefined` would slip past `<= 0` and hand
      // rate-limiter-flexible `points: undefined` (a surprise 4/min). Fail open.
      if (!Number.isFinite(perMinute) || !Number.isFinite(burstPerSecond)) {
        logger.error(
          { perMinute, burstPerSecond },
          'request quota returned a non-numeric value — allowing request'
        );
        return null;
      }
      if (perMinute <= 0) return null; // 0 = unlimited, a conscious operator opt-out

      const key = principalBucketKey(principal);
      const sustainedLimiter = limiterFor(sustained, 'apiq', perMinute, 60);

      // Spike cap first: a rejected burst must not burn sustained points —
      // the 1 s bucket self-heals and the minute budget stays intact.
      if (burstPerSecond > 0) {
        try {
          await limiterFor(burst, 'apiq-burst', burstPerSecond, 1).consume(key);
        } catch (rejection) {
          if (!(rejection instanceof RateLimiterRes)) {
            logger.error({ err: rejection }, 'rate-limit backend failure — allowing request');
            return null;
          }
          // Report the sustained bucket's state (read-only) so headers stay
          // meaningful; the retry hint comes from the 1 s burst window.
          const state = await sustainedLimiter.get(key).catch(() => null);
          return {
            ok: false,
            limit: perMinute,
            remaining: state ? Math.max(0, state.remainingPoints) : perMinute,
            resetSeconds: Math.ceil((state?.msBeforeNext ?? 0) / 1000),
            retryAfterSeconds: Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))
          };
        }
      }

      try {
        const res = await sustainedLimiter.consume(key);
        return {
          ok: true,
          limit: perMinute,
          remaining: res.remainingPoints,
          resetSeconds: Math.ceil(res.msBeforeNext / 1000)
        };
      } catch (rejection) {
        if (!(rejection instanceof RateLimiterRes)) {
          logger.error({ err: rejection }, 'rate-limit backend failure — allowing request');
          return null;
        }
        const retry = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
        return {
          ok: false,
          limit: perMinute,
          remaining: 0,
          resetSeconds: retry,
          retryAfterSeconds: retry
        };
      }
    }
  };
}
