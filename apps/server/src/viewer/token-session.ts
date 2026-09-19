import type { Context } from 'hono';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import type { ShareTokenRow } from '@slideless/db';
import type { PresentationService } from '../presentations/service.js';
import type { ShareTokenService } from '../sharing/service.js';
import { verifyViewerPassword } from '../sharing/password.js';
import type { ClientIpFn } from '@antasphere/chassis-server/middleware';
import { verifyUnlockValue } from './unlock.js';

/**
 * The SHARED token-session resolver for the public `/api/v1/viewer/{secret}`
 * surfaces (annotations, forms): secret → live token → capability →
 * password proof → live deck → resolved version, or the finished error
 * response. Extracted from the Phase 5 annotation surface so every
 * token-session API applies the exact same containment story:
 *
 *  - status mapping mirrors the viewer: unknown secret 404 (burning a
 *    per-IP point so the endpoint is no better a secret oracle than /v),
 *    revoked 403, expired 410;
 *  - the per-surface CAPABILITY gate (can_annotate, can_submit_forms, …)
 *    answers 403 with the surface's own code;
 *  - password-protected tokens must prove knowledge — the signed unlock
 *    proof the server injected into the surface's own client
 *    (`x-slideless-unlock`, viewer/unlock.ts MAC) or the raw
 *    `x-viewer-password` header (agents/tests; failures burn the tight
 *    per-IP+token password bucket);
 *  - the deck must still exist and have a published version (else 404).
 */

export interface TokenSessionDeps {
  sharing: ShareTokenService;
  presentations: PresentationService;
  /** MAC key for the unlock proof (the server auth secret). */
  authSecret: string;
  /** Unknown-secret probes burn a per-IP point from this bucket. */
  invalidSecretLimiter: RateLimiterAbstract;
  /** Failed password header attempts consume from this bucket (per IP + token). */
  passwordLimiter: RateLimiterAbstract;
  clientIp: ClientIpFn;
}

/** The per-surface capability gate and the 403 it answers with. */
export interface TokenSessionCapability {
  allows: (token: ShareTokenRow) => boolean;
  errorCode: string;
  errorMessage: string;
}

export interface TokenSessionView {
  token: ShareTokenRow;
  version: number;
  presentationId: string;
}

const err = (code: string, message: string) => ({ error: { code, message } });

export async function resolveTokenSession(
  c: Context,
  deps: TokenSessionDeps,
  capability: TokenSessionCapability
): Promise<{ ok: true; view: TokenSessionView } | { ok: false; res: Response }> {
  const secret = c.req.param('secret') ?? '';
  const token = await deps.sharing.resolveBySecret(secret);
  if (!token) {
    // Unknown secrets burn a per-IP point: no cheaper an oracle than /v.
    await deps.invalidSecretLimiter.consume(`${deps.clientIp(c)}:invalid`).catch(() => {});
    return {
      ok: false,
      res: c.json(err('not_found', 'This share link does not exist or is no longer available.'), 404)
    };
  }
  if (token.revokedAt) {
    return { ok: false, res: c.json(err('revoked', 'This share link has been revoked.'), 403) };
  }
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, res: c.json(err('expired', 'This share link has expired.'), 410) };
  }
  if (!capability.allows(token)) {
    return { ok: false, res: c.json(err(capability.errorCode, capability.errorMessage), 403) };
  }

  // Password proof: the injected unlock MAC, or the raw password header.
  if (token.passwordHash) {
    const unlock = c.req.header('x-slideless-unlock');
    const unlocked =
      unlock !== undefined && verifyUnlockValue(deps.authSecret, token.id, token.passwordHash, unlock);
    if (!unlocked) {
      const password = c.req.header('x-viewer-password');
      if (password === undefined) {
        return {
          ok: false,
          res: c.json(
            err(
              'password_required',
              'This share link is password protected — present x-slideless-unlock or x-viewer-password.'
            ),
            401
          )
        };
      }
      const bucket = `${deps.clientIp(c)}:${token.id}`;
      const state = await deps.passwordLimiter.get(bucket).catch(() => null);
      if (state !== null && state.remainingPoints <= 0) {
        return {
          ok: false,
          res: c.json(err('rate_limited', 'Too many password attempts — try again later.'), 429)
        };
      }
      if (!(await verifyViewerPassword(password, token.passwordHash))) {
        await deps.passwordLimiter.consume(bucket).catch(() => {});
        return {
          ok: false,
          res: c.json(err('password_invalid', 'The x-viewer-password value is not correct.'), 401)
        };
      }
    }
  }

  const deck = await deps.presentations.get(token.workspaceId, token.presentationId);
  if (!deck) {
    return {
      ok: false,
      res: c.json(err('not_found', 'This share link does not exist or is no longer available.'), 404)
    };
  }
  const version = token.pinnedVersion ?? deck.currentVersion;
  if (version < 1) {
    return { ok: false, res: c.json(err('not_found', 'This deck has no published version.'), 404) };
  }
  return { ok: true, view: { token, version, presentationId: deck.id } };
}
