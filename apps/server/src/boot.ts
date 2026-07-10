import { createDb, type DbHandle } from '@platform/db';
import { migrationStatus, runMigrations } from '@platform/db/migrate';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APIError } from 'better-auth/api';
import { AccountDeletionService, LastOwnerError } from './accounts/deletion.js';
import { createApiApp } from './api/index.js';
import { buildPepperRegistry } from './apikeys/peppers.js';
import { ApiKeyService } from './apikeys/service.js';
import { createApp } from './app.js';
import { AuditService } from './audit/service.js';
import { createEmailDriver, type EmailDriver } from './email/driver.js';
import {
  buildChangeEmailConfirmEmail,
  buildOtpEmail,
  buildPasswordResetEmail,
  buildVerifyEmailEmail
} from './email/templates.js';
import { parseEnv, type Env } from './env.js';
import { createAuth, type AccountEvent, type Auth } from './identity/better-auth.js';
import { OauthJwtVerifier } from './identity/oauth-jwt.js';
import { isApiKeyToken } from './apikeys/service.js';
import { mcpRoutes } from './mcp/http.js';
import { wellKnownRoutes } from './routes/wellknown.js';
import { instanceSettings, workspaceMembers } from '@platform/db';
import { FileService } from './files/service.js';
import { createJobs, PgBossUsageSink, type Jobs } from './jobs/pgboss.js';
import { createLogger, type Logger } from './logger.js';
import { createStorageDriver } from './storage/factory.js';
import { createRateLimiters, makeClientIp, rateLimit } from './middleware/rate-limit.js';
import { createMetrics } from './observability/metrics.js';
import { createOtel, type Otel } from './observability/otel.js';
import { AllowAllEntitlements } from './platform/entitlements.js';
import { EventBus } from './platform/events.js';
import { LocalIdentityProvider } from './platform/local-identity.js';
import { createRegistry, type PlatformRegistry } from './platform/registry.js';
import { NoopUsageSink } from './platform/usage.js';
import { resolveAuthSecret } from './secret.js';
import { createRuntimeState, type RuntimeState } from './state.js';
import type { UsageSink } from '@platform/contract';

/** Test seams only — production boot never passes overrides. */
export interface BootOverrides {
  /** Downstream sink the pg-boss worker hands batches to (default: no-op). */
  usageDownstream?: UsageSink;
  /**
   * Replaces the env-derived email driver. Exists because change-email tokens
   * are stateless JWTs (never stored) — tests can only observe them by
   * recording the outbound mail.
   */
  email?: EmailDriver;
}

export interface BootResult {
  app: Hono;
  env: Env;
  logger: Logger;
  state: RuntimeState;
  db: DbHandle;
  auth: Auth;
  registry: PlatformRegistry;
  jobs: Jobs;
  email: EmailDriver;
  otel: Otel;
  authSecret: string;
}

/** Locate the committed migrations folder in dev (workspace) and in the image. */
function findMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../drizzle'), // image layout: /app/drizzle next to /app/dist
    join(here, '../../../packages/db/drizzle') // workspace layout from apps/server/dist or src
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`migrations folder not found; looked in: ${candidates.join(', ')}`);
}

/**
 * The boot sequence, in its locked order: env → logger → db probe → secret →
 * migrations under advisory lock → app assembly → ready.
 */
export async function boot(
  source: NodeJS.ProcessEnv = process.env,
  overrides: BootOverrides = {}
): Promise<BootResult> {
  const env = parseEnv(source);
  const logger = createLogger(env);
  const state = createRuntimeState();

  logger.info({ serviceRole: env.SERVICE_ROLE, nodeEnv: env.NODE_ENV }, 'booting');

  state.reason = 'connecting to database';
  const db = createDb(env.DATABASE_URL);
  await db.pool.query('SELECT 1');
  logger.info('database reachable');

  const authSecret = await resolveAuthSecret(env.AUTH_SECRET, env.DATA_DIR, logger);

  const migrationsFolder = findMigrationsFolder();
  let migrationsPending = false;
  if (env.AUTO_MIGRATE) {
    state.reason = 'applying migrations';
    await runMigrations({
      connectionString: env.DATABASE_URL,
      migrationsFolder,
      log: (msg) => logger.info({ scope: 'migrate' }, msg)
    });
  } else {
    const status = await migrationStatus({ connectionString: env.DATABASE_URL, migrationsFolder });
    migrationsPending = status.pending;
    if (status.pending) {
      state.reason = `migrations pending (${status.applied}/${status.onDisk} applied) and AUTO_MIGRATE=false`;
      logger.error({ status }, 'refusing readiness: run migrations manually or set AUTO_MIGRATE=true');
      // The process stays up (healthz green) but /readyz keeps failing.
    } else {
      logger.info({ status }, 'migrations current (AUTO_MIGRATE=false)');
    }
  }

  // Email first: whether it delivers decides whether email-OTP login,
  // self-serve password reset, and self-serve email change exist.
  const email = overrides.email ?? createEmailDriver(env, logger);

  // Audit is built before auth so credential events on Better-Auth-native
  // routes (password reset/change) can be recorded through it.
  const audit = new AuditService(db.db, logger);

  /** Best-effort audit for a Better-Auth credential event (resolves the user's workspace). */
  const auditAccountEvent = async (event: AccountEvent, userId: string) => {
    const [row] = await db.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);
    if (!row) return;
    await audit.write({
      workspaceId: row.workspaceId,
      principal: {
        userId,
        email: '',
        name: '',
        workspaceId: row.workspaceId,
        role: 'member',
        via: 'session',
        scopes: null
      },
      action: `user.${event}`,
      resourceType: 'user',
      resourceId: userId
    });
  };

  // Account deletion: shared by the self-service /delete-user hooks below
  // and the admin DELETE /members/{id} route. No storage dep — files are
  // workspace data and survive the delete (ADR 006). The connection string
  // feeds the dedicated advisory-lock clients that serialize last-owner
  // removals (the migration-lock pattern).
  const accountDeletion = new AccountDeletionService(db.db, audit, logger, env.DATABASE_URL);

  // Identity + seams: local defaults, swappable at this one point.
  const auth = createAuth({
    db: db.db,
    env,
    authSecret,
    onAccountEvent: auditAccountEvent,
    beforeUserDelete: async (userId) => {
      try {
        await accountDeletion.beforeUserDelete(userId);
      } catch (cause) {
        // Better Auth turns APIError into the route's 400 response.
        if (cause instanceof LastOwnerError) {
          throw new APIError('BAD_REQUEST', { message: cause.message });
        }
        throw cause;
      }
    },
    afterUserDelete: (user) => accountDeletion.afterUserDelete(user),
    ...(email.delivers
      ? {
          sendOtp: async ({ email: to, otp, type }: { email: string; otp: string; type: string }) => {
            const msg = buildOtpEmail({ otp, type });
            await email.send({ to, ...msg });
          },
          sendResetPassword: async ({ email: to, url }: { email: string; url: string; token: string }) => {
            // Better Auth builds `url` as the API callback that 302s to the
            // dashboard reset page with ?token — mail it verbatim.
            const msg = buildPasswordResetEmail({
              resetUrl: url,
              expiresAt: new Date(Date.now() + 3600_000)
            });
            await email.send({ to, ...msg });
          },
          // Two-leg email change, leg 1 (verified users only): confirmation
          // to the OLD address. Mail Better Auth's `url` verbatim.
          sendChangeEmailConfirmation: async ({
            email: to,
            newEmail,
            url
          }: {
            email: string;
            newEmail: string;
            url: string;
            token: string;
          }) => {
            const msg = buildChangeEmailConfirmEmail({
              newEmail,
              confirmUrl: url,
              expiresAt: new Date(Date.now() + 3600_000)
            });
            await email.send({ to, ...msg });
          },
          // Final leg of every email change: verification to the NEW address.
          sendVerificationEmail: async ({
            email: to,
            url
          }: {
            email: string;
            url: string;
            token: string;
          }) => {
            const msg = buildVerifyEmailEmail({
              verifyUrl: url,
              expiresAt: new Date(Date.now() + 3600_000)
            });
            await email.send({ to, ...msg });
          }
        }
      : {})
  });

  // Jobs: pg-boss (durable queue). The registry's UsageSink emits into it;
  // the worker side hands batches to the downstream sink (no-op locally).
  const jobs = await createJobs(
    env,
    db.db,
    logger,
    overrides.usageDownstream ?? new NoopUsageSink(),
    auth,
    audit
  );

  const events = new EventBus(logger);
  const registry = createRegistry({
    identity: new LocalIdentityProvider(
      auth,
      db.db,
      Boolean(env.GOOGLE_CLIENT_ID),
      email.delivers,
      email.delivers, // self-serve password reset needs a delivering email driver
      email.delivers // self-serve email change needs one too
    ),
    entitlements: new AllowAllEntitlements({
      maxFileSizeMb: env.MAX_FILE_SIZE_MB,
      apiRequestsPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
      apiRequestsBurstPerSecond: env.API_RATE_LIMIT_BURST
    }),
    usage: new PgBossUsageSink(jobs.boss, logger),
    events
  });

  // API-key pepper registry (ADR 008): version 1 is the AUTH_SECRET-derived
  // pepper; API_KEY_PEPPERS adds/pins versions so keys survive rotations.
  const pepperRegistry = buildPepperRegistry(authSecret, env.API_KEY_PEPPERS);
  if (env.API_KEY_PEPPERS !== undefined && !pepperRegistry.v1Pinned) {
    logger.warn(
      'API_KEY_PEPPERS is set but does not pin version 1 — version-1 API keys still ' +
        'depend on the live AUTH_SECRET; pin `1:<historical secret>` before rotating it ' +
        '(docs/security.md).'
    );
  }
  const apiKeys = new ApiKeyService(db.db, pepperRegistry);
  const limiters = await createRateLimiters(env, logger);

  // Storage: probed at boot — /readyz stays red on an unwritable volume.
  state.reason = 'probing storage';
  const storage = createStorageDriver(env);
  await storage.healthcheck();
  logger.info({ driver: storage.name }, 'storage writable');
  const fileService = new FileService(db.db, storage, join(env.DATA_DIR, 'tmp'), logger);

  // OAuth-bearer verification: local JWKS (we minted the token) + live
  // membership re-check. One instance, shared by the API and /mcp gates.
  const oauthJwt = new OauthJwtVerifier(auth, db.db, env.PUBLIC_BASE_URL);

  const api = createApiApp({
    db: db.db,
    env,
    auth,
    registry,
    logger,
    apiKeys,
    audit,
    email,
    limiters,
    storage,
    fileService,
    oauthJwt,
    authSecret,
    accountDeletion
  });

  // Observability: tracing (exporterless = zero phone-home) + Prometheus.
  const otel = await createOtel(env, logger);
  const metrics = createMetrics(db.db, jobs.boss);

  // MCP tools call the instance's own API in-process, forwarding the caller's
  // bearer — MCP is just another API client. The root app does not exist yet
  // at this point, so the fetcher closes over a holder filled right after
  // createApp (before any request can arrive).
  const rootApp: { current: Hono | null } = { current: null };
  let cachedName: string | null = null;
  const mcp = mcpRoutes({
    publicBaseUrl: env.PUBLIC_BASE_URL,
    version: env.APP_VERSION,
    fetchApi: async (path, init) => {
      if (!rootApp.current) throw new Error('mcp fetchApi called before app assembly');
      return rootApp.current.request(path, init);
    },
    resolveOauthJwt: (token) => oauthJwt.resolve(token),
    resolveApiKey: (token) => apiKeys.resolve(token),
    isApiKeyToken,
    limiter: rateLimit(limiters.mcp, makeClientIp(env.TRUST_PROXY)),
    instanceName: async () => {
      if (cachedName) return cachedName;
      const [row] = await db.db.select({ name: instanceSettings.name }).from(instanceSettings).limit(1);
      cachedName = row?.name ?? 'Platform';
      return cachedName;
    }
  });

  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');
  const app = await createApp({
    logger,
    state,
    publicDir,
    api,
    mcp,
    wellKnown: wellKnownRoutes({ auth, publicBaseUrl: env.PUBLIC_BASE_URL }),
    metricsMiddleware: metrics.middleware,
    metricsRoutes: metrics.routes(env.METRICS_TOKEN),
    otelMiddleware: otel.middleware
  });
  rootApp.current = app;

  if (!migrationsPending) {
    state.ready = true;
    state.reason = '';
  }

  return { app, env, logger, state, db, auth, registry, jobs, email, otel, authSecret };
}
