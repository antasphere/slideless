import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import { attachmentsOf, type ManifestEntry } from '@slideless/contract';
import type { Logger } from '@antasphere/chassis-server/logger';
import type { PresentationService } from '../presentations/service.js';
import type { ShareTokenService } from '../sharing/service.js';
import type { ClientIpFn } from '@antasphere/chassis-server/middleware';
import { resolveTokenSession } from './token-session.js';

/**
 * THE TOKEN-SESSION ATTACHMENTS LIST (PRDCT-2278), the third `/api/v1/viewer/*`
 * surface beside annotations and forms: what a recipient bar renders before
 * offering a download. Same containment story as its siblings (the shared
 * resolver: unknown 404 burning a per-IP point, revoked 403, expired 410,
 * password proof by the injected unlock MAC or the raw header; no principal,
 * no cookie, CORS-open for the sandboxed opaque origin), READ-ONLY, and it
 * exposes exactly what the recipient may then fetch from `/v/{secret}/
 * downloads/…`: the resolved version's `downloads/` entries.
 *
 * `canDownload` off answers the SAME 200 with an EMPTY list, never a 403:
 * the link itself is public and the deck still shows, only the capability
 * is absent — a bar reads "nothing to download" either way, and a link
 * holder learns nothing about a folder the owner chose not to hand out.
 */

export interface ViewerAttachmentDeps {
  sharing: ShareTokenService;
  presentations: PresentationService;
  logger: Logger;
  /** MAC key for the unlock proof (the server auth secret). */
  authSecret: string;
  /** Unknown-secret probes burn a per-IP point from this bucket. */
  invalidSecretLimiter: RateLimiterAbstract;
  /** Failed password header attempts consume from this bucket (per IP + token). */
  passwordLimiter: RateLimiterAbstract;
  clientIp: ClientIpFn;
}

const err = (code: string, message: string) => ({ error: { code, message } });

export function registerViewerAttachmentRoutes(api: OpenAPIHono, deps: ViewerAttachmentDeps): void {
  const { sharing, presentations, authSecret, clientIp } = deps;

  api.get('/viewer/:secret/attachments', async (c) => {
    const resolved = await resolveTokenSession(
      c,
      {
        sharing,
        presentations,
        authSecret,
        invalidSecretLimiter: deps.invalidSecretLimiter,
        passwordLimiter: deps.passwordLimiter,
        clientIp
      },
      // No capability gate: every live link may ASK. The download
      // capability decides the answer's content below, never its status.
      { allows: () => true, errorCode: 'not_found', errorMessage: 'unreachable' }
    );
    if (!resolved.ok) return resolved.res;
    const { token, version, presentationId } = resolved.view;
    if (!token.canDownload) return c.json({ version, attachments: [] }, 200);
    const row = await presentations.getVersion(token.workspaceId, presentationId, version);
    if (!row) {
      return c.json(err('not_found', 'This share link does not exist or is no longer available.'), 404);
    }
    return c.json({ version, attachments: attachmentsOf(row.manifest as ManifestEntry[]) }, 200);
  });
}
