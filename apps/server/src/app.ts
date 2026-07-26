import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './logger.js';
import type { RuntimeState } from './state.js';
import { requestId } from './middleware/request-id.js';
import { buildCsp, inlineScriptHashes, securityHeaders } from './middleware/security-headers.js';
import { healthRoutes } from './routes/health.js';

export interface AppDeps {
  logger: Logger;
  state: RuntimeState;
  /** Directory holding the built dashboard SPA. */
  publicDir: string;
  /** The versioned API, mounted at /api/v1. */
  api: OpenAPIHono;
  /** The bundled MCP endpoint, mounted at /mcp (M6). */
  mcp?: Hono;
  /** Root-level OAuth discovery documents (/.well-known/*, M6). */
  wellKnown?: Hono;
  /**
   * The public share-link viewer (/v/{secret}, Phase 4 / ADR 012). Mounted
   * in the public-route slot: OUTSIDE /api/v1, outside the auth/scope
   * middleware — token recipients are anonymous, the path secret is the
   * whole credential, and every user-content response it emits is locked
   * under `CSP: sandbox` (see viewer/routes.ts).
   */
  viewer?: Hono;
  /** Observability middlewares + the /metrics route (M5). */
  metricsMiddleware?: MiddlewareHandler;
  metricsRoutes?: Hono;
  otelMiddleware?: MiddlewareHandler;
  /**
   * Live readiness probe for the backing store (routes/health.ts). Omitted =
   * /readyz keeps reporting the boot-time storage result forever.
   */
  probeStorage?: () => Promise<void>;
}

/**
 * Assemble the single Hono app. Route precedence is load-bearing and fixed:
 * health → (api, mcp, well-known — mounted here as the platform grows) →
 * static assets → SPA index fallback LAST. A slot deliberately remains open
 * before the fallback for products that add public content routes.
 */
export async function createApp({
  logger,
  state,
  publicDir,
  api,
  mcp,
  wellKnown,
  viewer,
  metricsMiddleware,
  metricsRoutes,
  otelMiddleware,
  probeStorage
}: AppDeps): Promise<Hono> {
  const app = new Hono();

  // The SPA fallback is read first: its inline bootstrap script hashes feed
  // the CSP that guards every HTML response.
  let indexHtml: string | null = null;
  try {
    indexHtml = await readFile(join(publicDir, 'index.html'), 'utf8');
  } catch {
    logger.warn({ publicDir }, 'no dashboard build found — serving a placeholder at /');
  }
  const csp = buildCsp(indexHtml ? inlineScriptHashes(indexHtml) : []);

  app.use('*', requestId(logger));
  app.use('*', securityHeaders({ csp, state }));
  if (otelMiddleware) app.use('*', otelMiddleware);
  if (metricsMiddleware) app.use('*', metricsMiddleware);

  // Uncaught handler errors: log with the request id, answer the wire shape.
  app.onError((error, c) => {
    // Malformed request bodies first: Hono's body validators throw
    // HTTPException(400) on unparseable JSON ("Malformed JSON in request
    // body") or broken multipart BEFORE zod runs, so the zod-openapi
    // defaultHook never sees them — and Hono routes a thrown error straight
    // here from the throwing handler's own dispatch frame, so an upstream
    // try/catch middleware never observes it either. This is therefore THE
    // seam: map the framework's 400s to the wire shape with a stable
    // machine code instead of amplifying a pre-auth-reachable client
    // mistake into a 500 + an error-level log. Only hono's validators throw
    // HTTPException(400) on this app (the MCP sub-app handles its own).
    if (error instanceof HTTPException && error.status === 400) {
      const isJson = error.message.includes('JSON');
      return c.json(
        {
          error: {
            code: isJson ? 'invalid_json' : 'invalid_body',
            message: isJson ? 'Request body is not valid JSON' : 'Malformed request body'
          }
        },
        400
      );
    }
    (c.get('logger') ?? logger).error({ err: error }, 'unhandled error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  app.route(
    '/',
    healthRoutes(state, {
      ...(probeStorage ? { probeStorage } : {}),
      onStorageFailure: (err) => logger.error({ err }, 'storage probe failed — reporting not ready')
    })
  );
  if (metricsRoutes) app.route('/', metricsRoutes);

  app.route('/api/v1', api);
  if (mcp) app.route('/mcp', mcp);
  if (wellKnown) app.route('/', wellKnown);

  // The public-route slot: the share-link viewer lives here — before the
  // static assets and the SPA fallback, after every credentialed surface.
  if (viewer) app.route('/', viewer);

  app.use('*', serveStatic({ root: publicDir }));

  app.get('*', (c) => {
    if (indexHtml) return c.html(indexHtml);
    return c.html(
      '<!doctype html><title>Slideless</title><h1>Slideless API is running</h1>' +
        '<p>No dashboard build found. API health: <a href="/healthz">/healthz</a></p>'
    );
  });

  return app;
}
