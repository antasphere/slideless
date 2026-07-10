import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { instanceRoute, meRoute, setupRoute } from '@slideless/contract/routes';
import { instanceSettings, workspaceMembers, workspaces, type Db } from '@slideless/db';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Auth } from '../identity/better-auth.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { ApiKeyService } from '../apikeys/service.js';
import type { EmailDriver } from '../email/driver.js';
import { isApiKeyToken } from '../apikeys/service.js';
import { auditMiddleware, type AuditService } from '../audit/service.js';
import { constantTimeEquals } from '../constant-time.js';
import { authContext, requireAuth } from '../middleware/auth-context.js';
import { idempotency } from '../middleware/idempotency.js';
import { oauthPublicEndpoints } from '../middleware/oauth-public.js';
import {
  createRequestQuota,
  emailKeyOf,
  makeClientIp,
  rateLimit,
  type RateLimiters
} from '../middleware/rate-limit.js';
import type { OauthJwtVerifier } from '../identity/oauth-jwt.js';
import { registerBreakGlassRoutes } from './break-glass.js';
import { registerMemberRoutes } from './members.js';
import { registerApiKeyRoutes } from './apikeys.js';
import { registerInvitationRoutes } from './invitations.js';
import { registerAuditRoutes } from './audit.js';
import { registerFileRoutes } from './files.js';
import { registerExportRoutes } from './export.js';
import type { AccountDeletionService } from '../accounts/deletion.js';
import type { FileService } from '../files/service.js';
import type { StorageDriver } from '../storage/driver.js';

/** Inline error body matching the wire shape; keeps openapi handlers typed. */
const err = (code: string, message: string) => ({ error: { code, message } });

export interface ApiDeps {
  db: Db;
  env: Env;
  auth: Auth;
  registry: PlatformRegistry;
  logger: Logger;
  apiKeys: ApiKeyService;
  audit: AuditService;
  email: EmailDriver;
  limiters: RateLimiters;
  storage: StorageDriver;
  fileService: FileService;
  oauthJwt: OauthJwtVerifier;
  /** Server auth secret — also derives the idempotency replay-cache cipher key. */
  authSecret: string;
  accountDeletion: AccountDeletionService;
}

/** Control-flow marker: the singleton claim lost (instance already set up). */
class SetupAlreadyDone extends Error {}

/**
 * The versioned API, mounted at /api/v1. Every route is defined by a contract
 * in @slideless/contract/routes; the OpenAPI document is generated from those
 * contracts and served at /api/v1/openapi.json.
 */
export function createApiApp(deps: ApiDeps): OpenAPIHono {
  const { db, env, auth, registry, logger, apiKeys: apiKeyService, audit, email, limiters } = deps;

  const api = new OpenAPIHono({
    // Validation failures use the same wire shape as every other error.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'validation_error',
              message: 'Request validation failed',
              details: result.error.issues
            }
          },
          400
        );
      }
    }
  });

  // ── Public OAuth endpoints first: wildcard CORS + OPTIONS 204 + no-store
  // on token responses. Before the rate limits so preflights cost nothing.
  api.use('/auth/*', oauthPublicEndpoints());

  // ── Body size cap: 1 MiB is generous for every JSON/auth body. File uploads
  // stream to disk with their own mid-stream cap (MAX_FILE_SIZE_MB) plus a
  // Content-Length entitlement check, so they MUST bypass this or large
  // uploads would 413 at 1 MiB.
  const jsonBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json(err('payload_too_large', 'Request body exceeds the 1 MiB limit'), 413)
  });
  api.use('*', (c, next) => (c.req.path.startsWith('/api/v1/files') ? next() : jsonBodyLimit(c, next)));

  // ── Auth-surface rate limits: registered FIRST so they run before auth
  // resolution — abusive traffic is rejected before it costs a DB query.
  const clientIp = makeClientIp(env.TRUST_PROXY);
  // Login keys by IP AND email: Docker NAT (or a rotating attacker) can
  // collapse/expand the IP dimension, so per-account protection must not
  // depend on it. emailKeyOf returns [] for bodyless social sign-in.
  api.use('/auth/sign-in/*', rateLimit(limiters.login, clientIp, emailKeyOf));
  api.use('/auth/email-otp/*', rateLimit(limiters.otp, clientIp, emailKeyOf));
  api.use('/auth/sign-up/*', rateLimit(limiters.login, clientIp));
  // Password reset: request keys by IP AND email (tight); reset + change key
  // by IP (brute-forcing a token / the current password). The deprecated
  // emailOTP forget-password alias shares the reset wall.
  api.use('/auth/request-password-reset', rateLimit(limiters.passwordReset, clientIp, emailKeyOf));
  api.use('/auth/reset-password', rateLimit(limiters.passwordReset, clientIp));
  api.use('/auth/reset-password/*', rateLimit(limiters.passwordReset, clientIp));
  api.use('/auth/forget-password/*', rateLimit(limiters.passwordReset, clientIp, emailKeyOf));
  // Email change mints sign-in-equivalent tokens and sends mail — same tight
  // wall as the reset surface (per IP; the route is session-gated anyway).
  api.use('/auth/change-email', rateLimit(limiters.passwordReset, clientIp));
  api.use('/auth/change-password', rateLimit(limiters.login, clientIp));
  // The 2FA surface: verify-totp / verify-backup-code guess a 6-digit code or
  // a backup code behind the 10-minute pending-sign-in cookie; enable/disable
  // present the current password. Same brute-force wall as login (per IP).
  api.use('/auth/two-factor/*', rateLimit(limiters.login, clientIp));
  // Account deletion presents the current password — same brute-force wall.
  api.use('/auth/delete-user', rateLimit(limiters.login, clientIp));
  api.use('/auth/oauth2/register', rateLimit(limiters.oauthRegister, clientIp));
  api.use('/auth/oauth2/token', rateLimit(limiters.oauthToken, clientIp));
  api.use('/setup', rateLimit(limiters.setup, clientIp));
  api.use('/invitations/accept', rateLimit(limiters.invitationAccept, clientIp));
  api.use('/invitations/lookup', rateLimit(limiters.invitationAccept, clientIp));
  // Break-glass: a rare superadmin recovery action — a tight per-IP wall
  // bounds allowlist probing before the handlers' own session checks run.
  api.use('/admin/break-glass/*', rateLimit(limiters.breakGlass, clientIp));

  // Better Auth owns /api/v1/auth/* (mounted before the credential middleware
  // — it IS the credential machinery).
  api.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

  api.use(
    '*',
    authContext({
      registry,
      isApiKeyToken,
      resolveApiKey: (token) => apiKeyService.resolve(token),
      resolveOauthJwt: (token) => deps.oauthJwt.resolve(token),
      keyFailureLimiter: limiters.apiKeyFailures,
      clientIp,
      // General per-principal quota (I3): runs inside authContext, after the
      // credential resolves (the bucket key IS the principal identity) and
      // before the scope gate. Public paths and /auth/* never reach it (no
      // principal), so the auth-surface limiters above are not doubled.
      // Limits ride the EntitlementService seam; buckets ride the same
      // Redis-or-memory backend as every other limiter.
      requestQuota: createRequestQuota({
        entitlements: registry.entitlements,
        make: limiters.make,
        logger
      })
    })
  );

  // Idempotency sits strictly BETWEEN authContext (it needs the resolved
  // principal to scope claims) and auditMiddleware (a replayed short-circuit
  // never reaches the audit layer, so a retry cannot land a second audit row).
  api.use('*', idempotency({ db, authSecret: deps.authSecret }));

  api.use('*', auditMiddleware(audit, clientIp));

  // ── GET /instance — unauthenticated discovery ────────────────────────────
  api.openapi(instanceRoute, async (c) => {
    const [row] = await db.select().from(instanceSettings).limit(1);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(
      {
        name: row?.name ?? 'Platform',
        instanceId: row?.instanceId ?? null,
        edition: env.EDITION,
        version: env.APP_VERSION,
        apiVersion: 'v1' as const,
        setupRequired: !row,
        auth: registry.identity.describe(),
        features: { mcp: true, oauth: true, files: true }
      },
      200
    );
  });

  // ── POST /setup — one-shot first-boot wizard ─────────────────────────────
  api.openapi(setupRoute, async (c) => {
    const body = c.req.valid('json');

    if (env.SETUP_TOKEN && !constantTimeEquals(body.setupToken ?? '', env.SETUP_TOKEN)) {
      return c.json(err('invalid_setup_token', 'A valid setup token is required'), 403);
    }

    const [existing] = await db.select({ id: instanceSettings.id }).from(instanceSettings).limit(1);
    if (existing) {
      return c.json(err('already_setup', 'This instance has already been set up'), 410);
    }

    // Create the owner user through Better Auth so credential hashing and
    // account rows follow its rules exactly. Better Auth cannot join our
    // transaction, so this happens first; a setup that later loses the claim
    // race leaves an orphaned user who can sign in but reaches nothing (401
    // on every route — no membership).
    let ownerUserId: string;
    try {
      const created = await auth.api.signUpEmail({
        body: { email: body.owner.email, password: body.owner.password, name: body.owner.name }
      });
      ownerUserId = created.user.id;
    } catch (cause) {
      // Retry after a crashed earlier attempt: the user may already exist.
      // Reuse it ONLY if the presented credentials actually sign in — never
      // attach a workspace to an account the caller cannot prove they own.
      try {
        const signedIn = await auth.api.signInEmail({
          body: { email: body.owner.email, password: body.owner.password }
        });
        ownerUserId = signedIn.user.id;
      } catch {
        logger.error({ err: cause }, 'setup: owner creation failed');
        return c.json(err('owner_creation_failed', 'Could not create the owner user'), 400);
      }
    }

    // Claim the singleton and create workspace + owner membership in ONE
    // transaction: either the instance is fully set up or nothing persisted.
    const instanceId = ulid();
    let workspaceId: string;
    try {
      workspaceId = await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(instanceSettings)
          .values({ id: 'instance', instanceId, name: body.instanceName })
          .onConflictDoNothing()
          .returning({ id: instanceSettings.id });
        if (claimed.length === 0) throw new SetupAlreadyDone();

        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: body.instanceName })
          .returning({ id: workspaces.id });
        if (!workspace) throw new Error('workspace insert returned no row');
        await tx.insert(workspaceMembers).values({
          workspaceId: workspace.id,
          userId: ownerUserId,
          role: 'owner'
        });
        return workspace.id;
      });
    } catch (cause) {
      if (cause instanceof SetupAlreadyDone) {
        return c.json(err('already_setup', 'This instance has already been set up'), 410);
      }
      logger.error({ err: cause }, 'setup: transaction failed (nothing persisted)');
      return c.json(err('internal', 'Setup failed; the instance remains uninitialized — retry'), 500);
    }

    registry.events.emit('setup.completed', { workspaceId, instanceId });
    logger.info({ workspaceId, instanceId }, 'first-boot setup completed');

    // The genesis privileged action: audited directly (no principal in
    // context yet — the middleware exempts /setup).
    await audit.write({
      workspaceId,
      principal: null,
      action: 'instance.setup',
      resourceType: 'instance',
      resourceId: instanceId,
      requestId: c.get('requestId'),
      metadata: { ownerUserId, ownerEmail: body.owner.email }
    });

    return c.json({ instanceId, workspaceId, ownerUserId }, 201);
  });

  // ── GET /me — whoami across all credential paths ─────────────────────────
  api.use('/me', requireAuth());
  api.openapi(meRoute, async (c) => {
    const principal = c.get('principal');
    if (!principal) {
      return c.json(err('unauthenticated', 'Authentication required'), 401);
    }
    const [ws] = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    return c.json(
      {
        user: { id: principal.userId, email: principal.email, name: principal.name },
        workspace: { id: principal.workspaceId, name: ws?.name ?? '' },
        role: principal.role,
        via: principal.via,
        scopes: principal.scopes
          ? ([...principal.scopes] as Array<'presentations:read' | 'presentations:write' | 'data:export'>)
          : null,
        apiKeyExpiresAt: principal.apiKeyExpiresAt ?? null
      },
      200
    );
  });

  // ── Platform modules ─────────────────────────────────────────────────────
  // Break-glass first: it self-authenticates (superadmin sessions may carry
  // NO membership, so principal can be null) and is deliberately UNLISTED in
  // the machine scope allowlist — keys/tokens 403 fail-closed above.
  registerBreakGlassRoutes(api, {
    db,
    auth,
    audit,
    logger,
    superadminEmails: env.SUPERADMIN_EMAILS
  });
  registerMemberRoutes(api, {
    db,
    auth,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    accountDeletion: deps.accountDeletion
  });
  registerApiKeyRoutes(api, db, apiKeyService);
  registerInvitationRoutes(api, { db, env, auth, email, audit, registry, logger });
  registerAuditRoutes(api, db);
  registerExportRoutes(api, {
    db,
    env,
    storage: deps.storage,
    audit,
    limiters,
    clientIp,
    logger
  });

  // Instance id for usage-event sources, cached after first read.
  let cachedInstanceId: string | null = null;
  const instanceId = async (): Promise<string> => {
    if (cachedInstanceId) return cachedInstanceId;
    const [row] = await db.select({ id: instanceSettings.instanceId }).from(instanceSettings).limit(1);
    cachedInstanceId = row?.id ?? 'unsetup';
    return cachedInstanceId;
  };
  registerFileRoutes(api, {
    service: deps.fileService,
    storage: deps.storage,
    registry,
    env,
    logger,
    instanceId
  });

  api.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Platform API',
      version: env.APP_VERSION
    },
    servers: [{ url: '/api/v1' }]
  });

  // ── JSON 404 terminator — registered LAST ────────────────────────────────
  // An unmatched /api/v1 path answers the API wire shape instead of falling
  // through to the SPA catch-all (which would hand a browser session the
  // dashboard HTML with a 200). Machine principals never reach this: the
  // fail-closed scope gate already 403s every unlisted endpoint above.
  api.all('*', (c) => c.json(err('not_found', 'Not found'), 404));

  return api;
}
