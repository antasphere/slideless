import type { MiddlewareHandler } from 'hono';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import type { Principal } from '@platform/contract';
import type { PlatformRegistry } from '../platform/registry.js';
import { apiError } from '../api/errors.js';
import {
  quotaHeaderEntries,
  type ClientIpFn,
  type QuotaDecision,
  type RequestQuotaService
} from './rate-limit.js';
import { looksLikeJwt, requiredScopeFor } from './scopes.js';

declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal | null;
  }
}

/** Paths under /api/v1 that are reachable without any credential. */
const PUBLIC_API_PATHS = new Set(['/api/v1/instance', '/api/v1/setup', '/api/v1/openapi.json']);

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATHS.has(path) || path.startsWith('/api/v1/auth/');
}

export interface AuthContextDeps {
  registry: PlatformRegistry;
  /** Resolves `Bearer <prefix>_...` API keys. Wired in M2; absent = keys rejected. */
  resolveApiKey?: (token: string) => Promise<Principal | null>;
  /** Resolves OAuth Bearer JWTs (local JWKS verify + live membership). Wired in M6. */
  resolveOauthJwt?: (token: string) => Promise<Principal | null>;
  /** Distinguishes an API-key credential from other bearers. */
  isApiKeyToken: (token: string) => boolean;
  /** Failed key verifications consume from this bucket (per IP) — brute-force wall. */
  keyFailureLimiter?: RateLimiterAbstract;
  /** Client identity (socket address unless TRUST_PROXY opts into XFF). */
  clientIp: ClientIpFn;
  /** General per-principal request quota (I3). Absent = no general limit. */
  requestQuota?: RequestQuotaService;
}

/**
 * The single credential resolver: every /api/v1 request passes through here
 * and comes out with c.get('principal') set (or a 401/403 for bad machine
 * credentials). Three paths, one output shape:
 *
 *  - session cookie → IdentityProvider.resolve (live membership re-check)
 *  - Bearer API key → O(1) key lookup (M2)
 *  - Bearer JWT → OAuth access token this instance minted: local JWKS
 *    verification + live membership re-check (M6)
 *
 * Machine principals additionally pass the fail-closed scope allowlist:
 * endpoints not consciously listed in scopes.ts are unreachable with a key
 * or token, whatever the underlying user's role is.
 */
export function authContext({
  registry,
  resolveApiKey,
  resolveOauthJwt,
  isApiKeyToken,
  keyFailureLimiter,
  clientIp,
  requestQuota
}: AuthContextDeps): MiddlewareHandler {
  return async (c, next) => {
    c.set('principal', null);

    if (isPublicApiPath(c.req.path)) {
      return next();
    }

    const authHeader = c.req.header('authorization')?.trim() ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() ?? null;

    let principal: Principal | null = null;

    if (bearer && looksLikeJwt(bearer)) {
      if (!resolveOauthJwt) {
        return apiError(c, 401, 'oauth_not_enabled', 'OAuth bearer tokens are not enabled on this instance');
      }
      principal = await resolveOauthJwt(bearer);
      if (!principal) {
        return apiError(c, 401, 'invalid_token', 'OAuth bearer token is invalid, expired, or revoked');
      }
    } else if (bearer && isApiKeyToken(bearer)) {
      if (!resolveApiKey) {
        return apiError(c, 401, 'invalid_api_key', 'API key not recognized');
      }
      const ip = clientIp(c);
      if (keyFailureLimiter) {
        const bucket = await keyFailureLimiter.get(ip).catch(() => null);
        if (bucket && bucket.remainingPoints <= 0 && bucket.msBeforeNext > 0) {
          return apiError(c, 429, 'rate_limited', 'Too many failed API key attempts');
        }
      }
      principal = await resolveApiKey(bearer);
      if (!principal) {
        if (keyFailureLimiter) await keyFailureLimiter.consume(ip).catch(() => {});
        return apiError(c, 401, 'invalid_api_key', 'API key not recognized');
      }
    } else if (bearer) {
      return apiError(c, 401, 'unsupported_credential', 'Unrecognized bearer credential format');
    } else {
      principal = await registry.identity.resolve({
        headers: c.req.raw.headers,
        path: c.req.path,
        method: c.req.method,
        requestId: c.get('requestId')
      });
    }

    // General per-principal request quota (I3), consumed BEFORE the scope
    // gate so even fail-closed 403 hammering is bounded — once a credential
    // resolves, the quota is the outermost cost control. The bucket key is
    // derived from the principal (see principalBucketKey), never a header.
    // Sessions are included: the default quota is far above any dashboard's
    // request rate, and a hijacked/scripted session is the same cost vector.
    let quota: QuotaDecision | null = null;
    if (principal && requestQuota) {
      quota = await requestQuota.consume(principal);
      if (quota && !quota.ok) {
        for (const [name, value] of quotaHeaderEntries(quota)) c.header(name, value);
        c.header('Retry-After', String(quota.retryAfterSeconds ?? Math.max(1, quota.resetSeconds)));
        return apiError(c, 429, 'rate_limited', 'API request quota exceeded, slow down');
      }
    }

    // Fail-closed scope gate for machine principals only.
    if (principal?.scopes) {
      const needed = requiredScopeFor(c.req.path, c.req.method);
      if (!needed) {
        return apiError(c, 403, 'endpoint_not_allowed', 'This endpoint is not available to this credential');
      }
      if (!principal.scopes.has(needed)) {
        return apiError(c, 403, 'insufficient_scope', `This credential was not granted "${needed}"`);
      }
    }

    c.set('principal', principal);
    if (!quota) return next();

    // Success path: stamp the quota headers on whatever response the route
    // produced (set on c.res so streamed/raw Response bodies get them too),
    // letting well-behaved agents self-throttle before hitting 429s.
    await next();
    for (const [name, value] of quotaHeaderEntries(quota)) c.res.headers.set(name, value);
    return;
  };
}

/** Route guard: 401 when unauthenticated. */
export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('principal')) {
      return apiError(c, 401, 'unauthenticated', 'Authentication required');
    }
    return next();
  };
}

const ROLE_RANK = { member: 0, admin: 1, owner: 2 } as const;

/** Route guard: 403 below the required role. */
export function requireRole(min: keyof typeof ROLE_RANK): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get('principal');
    if (!principal) {
      return apiError(c, 401, 'unauthenticated', 'Authentication required');
    }
    if (ROLE_RANK[principal.role] < ROLE_RANK[min]) {
      return apiError(c, 403, 'forbidden', `Requires ${min} role`);
    }
    return next();
  };
}
