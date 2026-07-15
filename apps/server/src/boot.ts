import { createDb, type DbHandle } from '@slideless/db';
import { migrationStatus, runMigrations } from '@slideless/db/migrate';
import { and, eq } from 'drizzle-orm';
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
import { hubConfig, parseEnv, type Env } from './env.js';
import { createAuth, mcpResourceUrl, type AccountEvent, type Auth } from './identity/better-auth.js';
import { HubSsoService } from './identity/hub-sso.js';
import { HubGrantService } from './identity/hub-grant.js';
import { hubApiResource, HubUserClient } from './identity/hub-user-client.js';
import {
  DEFAULT_FEDERATION_DIALS,
  HubOrgReconciler,
  type HubFederationDials
} from './identity/hub-reconcile.js';
import { OauthJwtVerifier } from './identity/oauth-jwt.js';
import type { OnWorkspaceMiss } from './identity/resolve-membership.js';
import { isApiKeyToken } from './apikeys/service.js';
import { mcpRoutes } from './mcp/http.js';
import { wellKnownRoutes } from './routes/wellknown.js';
import { instanceSettings, workspaceMembers } from '@slideless/db';
import { FileService } from './files/service.js';
import { createJobs, PgBossUsageSink, type Jobs } from './jobs/pgboss.js';
import { createLogger, type Logger } from './logger.js';
import { createStorageDriver } from './storage/factory.js';
import { createRateLimiters, makeClientIp, rateLimit } from './middleware/rate-limit.js';
import { createMetrics } from './observability/metrics.js';
import { createOtel, type Otel } from './observability/otel.js';
import { bindEditionSeams } from './platform/edition.js';
import { AllowAllEntitlements } from './platform/entitlements.js';
import { EventBus } from './platform/events.js';
import { LocalIdentityProvider } from './platform/local-identity.js';
import { createRegistry, type PlatformRegistry } from './platform/registry.js';
import { NoopUsageSink } from './platform/usage.js';
import { WorkspaceService } from './platform/workspaces.js';
import { resolveAuthSecret } from './secret.js';
import { ShareTokenService } from './sharing/service.js';
import { PresentationService } from './presentations/service.js';
import { CollaboratorService } from './collaborators/service.js';
import { viewerRoutes } from './viewer/routes.js';
import { createRuntimeState, type RuntimeState } from './state.js';
import type { UsageSink } from '@slideless/contract';

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
  /**
   * Shrinks the live-federation dials (reconcile TTL / stale window /
   * timeouts, identity/hub-reconcile.ts) so integration tests can watch
   * suspension/removal/grant-death propagate in milliseconds. Production
   * always runs the fixed defaults.
   */
  hubDials?: Partial<HubFederationDials>;
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

  // R7 edition-flip guard (docs/federation.md): EDITION selects the identity
  // binding, so flipping it under an already-set-up instance silently changes
  // who can log in and where workspace ownership is asserted. Setup stamps
  // the instance's edition; a boot whose env EDITION differs refuses to start
  // unless the operator explicitly acknowledges with EDITION_CHANGE_ALLOWED=true
  // (which re-stamps and proceeds). A fresh database (no instance row yet)
  // boots under any edition — cloud instances start from a fresh DB. The
  // stamp is compared whenever it is READABLE — including while migrations
  // are pending (readiness is red then, but the API still serves, so a
  // skipped guard would be one whole mis-bound boot). Only a schema that
  // predates the stamp column (migration 0020, AUTO_MIGRATE=false) has no
  // stamp to compare; the first migrated boot enforces the guard.
  let stampedEdition: string | undefined;
  try {
    const [instanceRow] = await db.db
      .select({ edition: instanceSettings.edition })
      .from(instanceSettings)
      .limit(1);
    stampedEdition = instanceRow?.edition;
  } catch (cause) {
    if (!migrationsPending) throw cause;
    // Pending migrations + unreadable stamp: the edition column (or the
    // table) is not migrated in yet on this database — nothing to compare.
  }
  if (stampedEdition !== undefined && stampedEdition !== env.EDITION) {
    if (!env.EDITION_CHANGE_ALLOWED) {
      const message =
        `refusing to boot: EDITION=${env.EDITION} but this instance was set up as ` +
        `'${stampedEdition}'. An edition flip on a populated instance changes identity ` +
        `semantics for existing users and workspaces. If this is intentional, set ` +
        `EDITION_CHANGE_ALLOWED=true for ONE boot to re-stamp it (docs/federation.md).`;
      logger.error({ stamped: stampedEdition, env: env.EDITION }, message);
      await db.pool.end(); // clean refusal — no leaked pool for the caller
      throw new Error(message);
    }
    await db.db.update(instanceSettings).set({ edition: env.EDITION });
    logger.warn(
      { from: stampedEdition, to: env.EDITION },
      'edition re-stamped (EDITION_CHANGE_ALLOWED=true) — unset the flag again after this boot'
    );
  } else if (env.EDITION_CHANGE_ALLOWED) {
    // A leftover acknowledgement must never rot silently: while the flag
    // stays set, the guard above is disarmed — any future EDITION change
    // would re-stamp without refusing. Say so on every boot.
    logger.warn(
      'EDITION_CHANGE_ALLOWED=true but no edition change is pending — unset it: while it stays ' +
        'set, the R7 edition-flip guard is disarmed and a future EDITION change re-stamps ' +
        'without refusal (docs/federation.md)'
    );
  }

  // Email first: whether it delivers decides whether email-OTP login,
  // self-serve password reset, and self-serve email change exist.
  const email = overrides.email ?? createEmailDriver(env, logger);

  // Audit is built before auth so credential events on Better-Auth-native
  // routes (password reset/change) can be recorded through it.
  const audit = new AuditService(db.db, logger);

  /**
   * Best-effort audit for a Better-Auth credential event. Credential events
   * are USER-level, so the row lands in every workspace the user is an
   * ACTIVE member of (ADR 014) — each workspace's trail records its own
   * members' password/2FA changes, and a workspace the user was deactivated
   * from records nothing; a single-workspace instance gets exactly one row,
   * as before.
   */
  const auditAccountEvent = async (event: AccountEvent, userId: string) => {
    const rows = await db.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.isActive, true)));
    for (const row of rows) {
      await audit.write({
        workspaceId: row.workspaceId,
        principal: { userId, via: 'session' },
        action: `user.${event}`,
        resourceType: 'user',
        resourceId: userId
      });
    }
  };

  // Account deletion: shared by the self-service /delete-user hooks below
  // and the admin DELETE /members/{id} route. No storage dep — files are
  // workspace data and survive the delete (ADR 006). The connection string
  // feeds the dedicated advisory-lock clients that serialize last-owner
  // removals (the migration-lock pattern).
  const accountDeletion = new AccountDeletionService(db.db, audit, logger, env.DATABASE_URL);

  // The event bus exists before auth so identity-layer hooks can publish:
  // `user.created` fires from Better Auth's databaseHooks.user.create.after,
  // covering EVERY account entrance by construction (setup, invitation
  // accept, collaborator claim, future SSO JIT) — never from individual
  // call sites.
  const events = new EventBus(logger);

  // The cloud edition's hub SSO binding (docs/federation.md): constructed
  // iff EDITION=cloud — hubConfig() is the single switch, so an oss boot
  // provably instantiates no SSO surface. Everything hub-SSO hangs off this
  // one object: the genericOAuth provider inside createAuth, the per-login
  // projection after-hook, and the login-scope wrap around the auth mount.
  const hub = hubConfig(env);
  // THE seam constant: the RFC 8707 `resource` for BOTH the SSO code
  // exchange and every refresh — `<hub>/mcp`, so the tokens Slideless holds
  // are HUB-audienced and callable at hub /api/v1 as the user. Flipping it
  // to null (if the hub ever accepts opaque tokens) is this one line.
  const hubTokenResource = hub ? hubApiResource(hub.issuerUrl) : null;
  const hubSso = hub
    ? new HubSsoService({
        db: db.db,
        logger,
        issuerUrl: hub.issuerUrl,
        clientId: hub.clientId,
        clientSecret: hub.clientSecret,
        // Own resource URL — always derived from PUBLIC_BASE_URL, never
        // configured. Pins H3 connect tokens only; login tokens are
        // hub-audienced via tokenResource.
        resourceUrl: mcpResourceUrl(env.PUBLIC_BASE_URL),
        tokenResource: hubTokenResource,
        publicBaseUrl: env.PUBLIC_BASE_URL
      })
    : undefined;

  // Identity + seams: local defaults, swappable at this one point.
  const auth = createAuth({
    db: db.db,
    env,
    authSecret,
    hubSso,
    onAccountEvent: auditAccountEvent,
    onUserCreated: (user) => events.emit('user.created', { userId: user.id, email: user.email }),
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

  // The live user-scoped federation stack (cloud only, docs/federation.md):
  // each user's OWN hub grant (offline_access refresh token on the account
  // row) → as-the-user `GET /orgs` reads → the org reconciler that the
  // login pass, the live gate, and the unknown-workspace miss hook all
  // share. Constructed AFTER createAuth because the grant encrypts tokens
  // with Better Auth's own key material ((await auth.$context).secretConfig
  // — equal to authSecret under our string-secret config; the fallback
  // keeps the read total if a future Better Auth reshapes the context).
  const hubDials: HubFederationDials = { ...DEFAULT_FEDERATION_DIALS, ...overrides.hubDials };
  const hubGrant = hub
    ? new HubGrantService({
        db: db.db,
        issuerUrl: hub.issuerUrl,
        clientId: hub.clientId,
        clientSecret: hub.clientSecret,
        tokenResource: hubTokenResource,
        key: async () =>
          ((await auth.$context) as unknown as { secretConfig?: string }).secretConfig ?? authSecret,
        connectionString: env.DATABASE_URL,
        logger,
        dials: {
          accessSkewMs: hubDials.accessSkewMs,
          tokenTimeoutMs: hubDials.tokenTimeoutMs,
          lockWatchdogMs: hubDials.lockWatchdogMs
        }
      })
    : undefined;
  const hubReconciler =
    hub && hubGrant
      ? new HubOrgReconciler({
          db: db.db,
          client: new HubUserClient({
            grant: hubGrant,
            issuerUrl: hub.issuerUrl,
            logger,
            timeoutMs: hubDials.orgsTimeoutMs
          }),
          audit,
          logger,
          dials: hubDials
        })
      : undefined;
  // The SSO login's fail-closed step 3 (assertLogin) runs THIS reconciler.
  if (hubSso && hubReconciler) hubSso.bindReconciler(hubReconciler);
  // Unknown-workspace retry, ALL THREE credential kinds: one cached
  // reconcile + one re-lookup. Rides the reconciler's TTL + throttle, so a
  // garbage selector can never hammer the hub. undefined on oss.
  const onWorkspaceMiss: OnWorkspaceMiss | undefined = hubReconciler
    ? async (userId) => {
        await hubReconciler.reconcile(userId);
      }
    : undefined;

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

  // The edition split (docs/federation.md): the local defaults below are the
  // oss binding, passed through bindEditionSeams — the ONE place EDITION
  // decides what the registry gets. oss returns them untouched; cloud
  // rebinds the identity descriptor and wires the live principal gate off
  // the reconciler built above. Entitlements stay LOCAL on both editions.
  const seams = bindEditionSeams(
    hub,
    {
      identity: new LocalIdentityProvider(
        auth,
        db.db,
        Boolean(env.GOOGLE_CLIENT_ID),
        email.delivers,
        email.delivers, // self-serve password reset needs a delivering email driver
        email.delivers, // self-serve email change needs one too
        onWorkspaceMiss
      ),
      entitlements: new AllowAllEntitlements({
        maxFileSizeMb: env.MAX_FILE_SIZE_MB,
        apiRequestsPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
        apiRequestsBurstPerSecond: env.API_RATE_LIMIT_BURST
      }),
      usage: new PgBossUsageSink(jobs.boss, logger)
    },
    logger,
    { db: db.db, reconciler: hubReconciler }
  );
  const registry = createRegistry({
    identity: seams.identity,
    entitlements: seams.entitlements,
    usage: seams.usage,
    events,
    workspaces: new WorkspaceService(db.db)
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
  const apiKeys = new ApiKeyService(db.db, pepperRegistry, onWorkspaceMiss);
  // Share-token secrets ride the SAME versioned pepper registry as API keys
  // (ADR 008): sha256(secret + pepper), fail-closed across rotations.
  const sharing = new ShareTokenService(db.db, pepperRegistry);
  const limiters = await createRateLimiters(env, logger);

  // Per-deck collaborators (Phase 5). Claim-at-signup: user creation is the
  // moment the template redeems invitations, so a fresh account (created via
  // a workspace invitation or the collaborator claim endpoint) sweeps every
  // live pending grant addressed to its email. The event bus isolates
  // failures; the sweep is idempotent against the claim endpoint's own.
  const collaboratorService = new CollaboratorService(db.db);
  events.on('user.created', async ({ userId, email: userEmail }) => {
    const claimed = await collaboratorService.claimAllPendingForEmail(userEmail, userId);
    if (claimed > 0) {
      logger.info({ userId, claimed }, 'claimed pending collaborator grants at account creation');
    }
  });

  // Storage: probed at boot — /readyz stays red on an unwritable volume.
  state.reason = 'probing storage';
  const storage = createStorageDriver(env);
  await storage.healthcheck();
  logger.info({ driver: storage.name }, 'storage writable');
  const fileService = new FileService(db.db, storage, join(env.DATA_DIR, 'tmp'), logger);

  // OAuth-bearer verification: local JWKS (we minted the token) + live
  // membership re-check. One instance, shared by the API and /mcp gates.
  const oauthJwt = new OauthJwtVerifier(auth, db.db, env.PUBLIC_BASE_URL, onWorkspaceMiss);

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
    accountDeletion,
    sharing,
    collaborators: collaboratorService,
    hubSso,
    // Cloud only (docs/federation.md): the post-resolution LIVE hub gate —
    // reconcile-as-the-user + suspension/revocation/grant-death verdicts —
    // run by authContext on every authenticated request. undefined on oss.
    principalGate: seams.principalGate
  });

  // The public share-link viewer (Phase 4, ADR 012): anonymous, mounted in
  // app.ts's public-route slot, serves user HTML ONLY under CSP: sandbox.
  const viewer = viewerRoutes({
    sharing,
    presentations: new PresentationService(db.db),
    fileService,
    storage,
    logger,
    authSecret,
    passwordLimiter: limiters.viewerPassword,
    clientIp: makeClientIp(env.TRUST_PROXY),
    secureCookies: env.PUBLIC_BASE_URL.startsWith('https://')
  });

  // Observability: tracing (exporterless = zero phone-home) + Prometheus.
  const otel = await createOtel(env, logger);
  const metrics = createMetrics(db.db, jobs.boss);
  // Cloud only: the reconcile-pass and grant-refresh counters join the app
  // registry so a degraded hub (or dying grants) is visible on /metrics.
  for (const metric of [...(hubReconciler?.promMetrics ?? []), ...(hubGrant?.promMetrics ?? [])]) {
    metrics.registry.registerMetric(metric);
  }

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
    // The /mcp transport gate resolves the credential with NO workspace
    // selector (default-org perspective): the per-tool-call `workspace`
    // argument is mapped to the header at the in-process /api/v1 re-entry,
    // where the real per-request selection happens.
    resolveOauthJwt: (token) => oauthJwt.resolve(token, null),
    resolveApiKey: (token) => apiKeys.resolve(token, null),
    isApiKeyToken,
    limiter: rateLimit(limiters.mcp, makeClientIp(env.TRUST_PROXY)),
    instanceName: async () => {
      if (cachedName) return cachedName;
      const [row] = await db.db.select({ name: instanceSettings.name }).from(instanceSettings).limit(1);
      cachedName = row?.name ?? 'Slideless';
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
    viewer,
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
