import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
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
  /** Observability middlewares + the /metrics route (M5). */
  metricsMiddleware?: MiddlewareHandler;
  metricsRoutes?: Hono;
  otelMiddleware?: MiddlewareHandler;
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
  metricsMiddleware,
  metricsRoutes,
  otelMiddleware
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
    (c.get('logger') ?? logger).error({ err: error }, 'unhandled error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  app.route('/', healthRoutes(state));
  if (metricsRoutes) app.route('/', metricsRoutes);

  app.route('/api/v1', api);
  if (mcp) app.route('/mcp', mcp);
  if (wellKnown) app.route('/', wellKnown);

  app.use('*', serveStatic({ root: publicDir }));

  app.get('*', (c) => {
    if (indexHtml) return c.html(indexHtml);
    return c.html(
      '<!doctype html><title>platform</title><h1>Platform API is running</h1>' +
        '<p>No dashboard build found. API health: <a href="/healthz">/healthz</a></p>'
    );
  });

  return app;
}
