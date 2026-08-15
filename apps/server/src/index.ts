import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { boot } from './boot.js';

// Packaging guard, not a runtime feature: `node dist/index.js --boot-check`
// exits here — AFTER Node has resolved and initialized every static import
// in the server graph (boot.js and its entire tree: better-auth → kysely,
// pg, pino, pg-boss, drizzle-orm, …) but BEFORE any env parsing, DB access,
// or listener. The Docker build stage runs it against the pruned production
// node_modules (scripts/prune-runtime-deps.mjs), so a prune that removes
// anything runtime-reachable fails the image BUILD instead of container boot.
if (process.argv.includes('--boot-check')) {
  console.log('boot-check ok: runtime module graph loaded');
  process.exit(0);
}

// Operator command (internal/security-runbooks.md, ADR 023): mint or retire
// an OAuth signing key without booting the server — `docker compose run --rm
// app node dist/index.js rotate-signing-key [--retire <kid>]`. Runs against
// the container's own env, so it works exactly in the state a failed
// signing-key preflight leaves the instance in.
if (process.argv[2] === 'rotate-signing-key') {
  const [{ parseEnv }, { createDb }, { resolveAuthSecret }, { createLogger }, { runSigningKeyCli }] =
    await Promise.all([
      import('./env.js'),
      import('@slideless/db'),
      import('./secret.js'),
      import('./logger.js'),
      import('./identity/signing-key.js')
    ]);
  const env = parseEnv(process.env);
  const db = createDb(env.DATABASE_URL);
  let code = 1;
  try {
    const authSecret = await resolveAuthSecret(env.AUTH_SECRET, env.DATA_DIR, createLogger(env));
    code = await runSigningKeyCli(db.db, authSecret, process.argv.slice(3), (line) => console.log(line));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
  }
  await db.pool.end().catch(() => {});
  process.exit(code);
}

const { app, env, logger, state, db, jobs, otel } = await boot();

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  logger.info({ port: info.port, host: env.HOST }, 'listening');
});

/**
 * Graceful shutdown: readiness flips first so load balancers stop routing,
 * then the listener drains in-flight requests, then the pool closes. A
 * bounded grace timeout force-exits so a hung connection cannot wedge deploys.
 */
const GRACE_TIMEOUT_MS = 30_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  state.draining = true;
  logger.info({ signal }, 'shutdown: draining');

  const nodeServer = server as unknown as Server;
  const force = setTimeout(() => {
    logger.error('shutdown: grace timeout exceeded, destroying remaining connections');
    nodeServer.closeAllConnections?.();
    process.exit(1);
  }, GRACE_TIMEOUT_MS);
  force.unref();

  // Order matters: stop taking jobs (in-flight ones finish), kick idle
  // keep-alive sockets (server.close alone never closes them), let active
  // requests — including a large download — run to completion, then close
  // the pool both depended on.
  await jobs.stop();
  nodeServer.closeIdleConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await otel.shutdown().catch(() => {});
  await db.pool.end();
  logger.info('shutdown: complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
