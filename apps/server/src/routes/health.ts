import { Hono } from 'hono';
import type { RuntimeState } from '../state.js';

/**
 * /healthz — liveness. No dependencies: answers 200 whenever the event loop
 * runs, so orchestrators never restart a replica that is merely waiting on
 * the database.
 *
 * /readyz — readiness. 503 until env is parsed, migrations are applied (or
 * confirmed current), and the DB is reachable; 503 again while draining.
 */
export function healthRoutes(state: RuntimeState): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => {
    if (state.ready && !state.draining) return c.json({ status: 'ready' });
    return c.json({ status: 'unavailable', reason: state.draining ? 'draining' : state.reason }, 503);
  });
  return app;
}
