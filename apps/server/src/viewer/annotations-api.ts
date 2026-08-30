import type { Context, MiddlewareHandler } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import { z } from 'zod';
import {
  badgePositionSchema,
  hasNulDeep,
  MAX_SELECTION_JSON_BYTES,
  noControlChars
} from '@slideless/contract';
import type { Logger } from '../logger.js';
import type { PresentationService } from '../presentations/service.js';
import type { ShareTokenService } from '../sharing/service.js';
import { annotationToReviewerWire, type AnnotationService } from '../annotations/service.js';
import type { ClientIpFn } from '../middleware/rate-limit.js';
import { resolveTokenSession, type TokenSessionView } from './token-session.js';

/**
 * THE TOKEN-SESSION ANNOTATION SURFACE (Phase 5) — the reserved
 * `/api/v1/viewer/*` routes: a deliberate PUBLIC, token-authenticated hole
 * in the otherwise principal-gated /api/v1 tree (it matches the legacy
 * annotate-client model). The caller is the overlay client injected into
 * the sandboxed OPAQUE-origin viewer document (viewer/overlay.ts), which
 * has no cookies and no principal — the share-token secret it reads from
 * `location.pathname` is the entire credential, exactly like the viewer.
 *
 * Why this is safe (the containment story):
 *  - AUTH: every request re-resolves the secret → token (revoked → 403,
 *    expired → 410, unknown → 404) and requires `can_annotate`; a plain
 *    view-only token 403s. Password-protected tokens additionally require
 *    proof (below). Nothing here reads sessions, API keys, or scopes — and
 *    conversely a machine credential presented here dies at the fail-closed
 *    scope gate before reaching these handlers (the path is unlisted).
 *  - SCOPE: the surface can ONLY create annotations on, and list this
 *    token's own annotations of, the one deck+version the token resolves
 *    to. No other table, deck, or field is reachable; the reviewer wire
 *    shape leaks no ids beyond the annotation's own.
 *  - INPUT: zod-validated body, 10 KB note cap, 8 KB serialized-selection
 *    cap, 120-char author name; the selection stays opaque jsonb.
 *  - ABUSE: creates burn a per-IP+token bucket (limiter registry); failed
 *    secret resolutions burn a per-IP bucket so the endpoint is no better a
 *    secret oracle than the viewer itself. Annotation writes are not
 *    audited (the viewer's documented non-goal — token recipients are not
 *    principals); the owner surface's mutations are.
 *  - PASSWORD: a password-gated token must prove knowledge — either the
 *    signed unlock proof the server itself injected into the overlay after
 *    the entry passed the password gate (`x-slideless-unlock`, the
 *    viewer/unlock.ts MAC: token-scoped, 1 h, dies on password change), or
 *    the raw password via `x-viewer-password` (agents/tests; failures burn
 *    the same tight per-IP+token bucket as the viewer's gate).
 *  - CORS: the overlay runs in an opaque origin, so requests arrive
 *    cross-origin with `Origin: null`. The middleware answers preflights and
 *    stamps `Access-Control-Allow-Origin: *` — safe because NOTHING here is
 *    cookie/credential-authenticated; the token in the path is the auth, and
 *    CORS is not the security boundary (the oauth-public precedent).
 */

export const VIEWER_API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Viewer-Password, X-Slideless-Unlock, X-Slideless-Response',
  'Access-Control-Max-Age': '86400'
} as const;

// SL-B4: this schema is INLINE here, not the contract's annotationCreateSchema,
// so the contract-level `plainText` sweep does not reach it — and this is the
// most anonymously-reachable free-text write on the whole instance (a share-link
// reviewer needs no account). Both sinks land in Postgres `text` columns, where
// a NUL raises SQLSTATE 22021 and the resulting 500 logs the statement with its
// bound parameters. `selection` lands in a jsonb column, which refuses NUL its
// own way (22P05) — its keys and values are NUL-checked too. (The byte cap and
// the request-depth cap are enforced in the handler and at the /api/v1 edge.)
const annotationCreateBody = z.object({
  body: noControlChars(z.string().min(1).max(10000)),
  authorName: noControlChars(z.string().trim().min(1).max(120)).optional(),
  selection: z
    .record(z.string(), z.unknown())
    .refine((v) => !hasNulDeep(v), 'selection must not contain NUL characters')
    .default({}),
  version: z.number().int().min(1).optional()
});

/**
 * Wide-open CORS + preflight handling for the public viewer-token routes.
 * Mounted on `/viewer/*` inside the /api/v1 app, BEFORE the rate limits so
 * OPTIONS preflights never consume a bucket (the oauth-public pattern).
 */
export function viewerApiCors(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, { ...VIEWER_API_CORS_HEADERS });
    }
    await next();
    for (const [key, value] of Object.entries(VIEWER_API_CORS_HEADERS)) {
      c.res.headers.set(key, value);
    }
    c.res.headers.set('Cache-Control', 'no-store');
  };
}

export interface ViewerAnnotationDeps {
  sharing: ShareTokenService;
  presentations: PresentationService;
  annotations: AnnotationService;
  logger: Logger;
  /** MAC key for the unlock proof (the server auth secret). */
  authSecret: string;
  /** Annotation creates consume from this bucket (per IP + token). */
  annotateLimiter: RateLimiterAbstract;
  /** Failed password header attempts consume from this bucket (per IP + token). */
  passwordLimiter: RateLimiterAbstract;
  clientIp: ClientIpFn;
}

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * Registers the token-session routes on the /api/v1 app. They are reachable
 * WITHOUT any principal (no requireAuth) — anonymous is the design — while
 * credentialed machine callers still die at the scope gate upstream.
 */
export function registerViewerAnnotationRoutes(api: OpenAPIHono, deps: ViewerAnnotationDeps): void {
  const { sharing, presentations, annotations, authSecret, clientIp } = deps;

  /**
   * Secret → live annotator token → live deck → resolved version, or the
   * error response — the shared token-session resolver (viewer/
   * token-session.ts) with the annotator capability. Unknown-secret probes
   * burn a point from the annotate bucket (this surface's write bucket).
   */
  async function resolveAnnotator(
    c: Context
  ): Promise<{ ok: true; view: TokenSessionView } | { ok: false; res: Response }> {
    return resolveTokenSession(
      c,
      {
        sharing,
        presentations,
        authSecret,
        invalidSecretLimiter: deps.annotateLimiter,
        passwordLimiter: deps.passwordLimiter,
        clientIp
      },
      {
        allows: (token) => token.canAnnotate,
        errorCode: 'not_annotator',
        errorMessage: 'This share link does not allow annotations.'
      }
    );
  }

  // ── GET: this token's notes on the resolved version (overlay bootstrap) ──
  api.get('/viewer/:secret/annotations', async (c) => {
    const resolved = await resolveAnnotator(c);
    if (!resolved.ok) return resolved.res;
    const { token, version } = resolved.view;
    const rows = await annotations.listForToken(token.id, version);
    return c.json({ version, annotations: rows.map(annotationToReviewerWire) }, 200);
  });

  // ── POST: create one note as this token's reviewer ────────────────────────
  api.post('/viewer/:secret/annotations', async (c) => {
    const resolved = await resolveAnnotator(c);
    if (!resolved.ok) return resolved.res;
    const { token, version: resolvedVersion, presentationId } = resolved.view;

    // Spam wall BEFORE any write: per IP + token, from the limiter registry.
    try {
      await deps.annotateLimiter.consume(`${clientIp(c)}:${token.id}`);
    } catch {
      return c.json(err('rate_limited', 'Too many annotations — slow down.'), 429);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(err('validation_error', 'Body must be JSON'), 400);
    }
    const parsed = annotationCreateBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_error',
            message: 'Request validation failed',
            details: parsed.error.issues
          }
        },
        400
      );
    }
    const body = parsed.data;
    if (JSON.stringify(body.selection).length > MAX_SELECTION_JSON_BYTES) {
      return c.json(
        err('selection_too_large', `selection must serialize under ${MAX_SELECTION_JSON_BYTES} bytes`),
        400
      );
    }
    // The note anchors to the version the reviewer SAW. A pinned token can
    // only ever mean its pin; a latest-mode token may claim the version its
    // document was served with (≥1, ≤ current) so a mid-review push does not
    // silently re-anchor the note to content the reviewer never read.
    let version = resolvedVersion;
    if (body.version !== undefined) {
      if (token.pinnedVersion !== null && body.version !== token.pinnedVersion) {
        return c.json(err('invalid_version', 'This share link is pinned to a different version'), 400);
      }
      if (body.version > resolvedVersion) {
        return c.json(err('invalid_version', 'version does not exist on this presentation'), 400);
      }
      version = body.version;
    }

    const row = await annotations.create({
      workspaceId: token.workspaceId,
      presentationId,
      version,
      shareTokenId: token.id,
      authorUserId: null,
      authorName: body.authorName ?? null,
      selection: body.selection,
      body: body.body
    });
    deps.logger.info(
      { presentationId, shareTokenId: token.id, annotationId: row.id, version },
      'viewer annotation created'
    );
    return c.json(annotationToReviewerWire(row), 201);
  });

  // ── PUT: move this link's notes button (the overlay's settings dialog) ────
  // Reviewer-scoped by design: writes ONLY this token's own badgePosition so
  // the choice sticks across pages and visits of this one link. It NEVER
  // touches the deck's remembered default — that is owner intent, set on the
  // owner surface. Same containment as annotation creates: token re-resolve,
  // password proof, zod enum, and the shared per-IP+token write bucket.
  api.put('/viewer/:secret/badge', async (c) => {
    const resolved = await resolveAnnotator(c);
    if (!resolved.ok) return resolved.res;
    const { token } = resolved.view;

    try {
      await deps.annotateLimiter.consume(`${clientIp(c)}:${token.id}`);
    } catch {
      return c.json(err('rate_limited', 'Too many requests — slow down.'), 429);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(err('validation_error', 'Body must be JSON'), 400);
    }
    const parsed = z.object({ position: badgePositionSchema }).safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_error',
            message: 'Request validation failed',
            details: parsed.error.issues
          }
        },
        400
      );
    }
    await sharing.update(token.id, { badgePosition: parsed.data.position });
    deps.logger.info(
      { shareTokenId: token.id, badgePosition: parsed.data.position },
      'viewer badge position updated'
    );
    return c.json({ badgePosition: parsed.data.position }, 200);
  });
}
