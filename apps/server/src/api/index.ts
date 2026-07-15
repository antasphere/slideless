import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { ulid } from 'ulid';
import { and, asc, desc, eq } from 'drizzle-orm';
import { ACTIVE_WORKSPACE_HEADER } from '@slideless/contract';
import { instanceRoute, meRoute, setupRoute } from '@slideless/contract/routes';
import { instanceSettings, user as userTable, workspaceMembers, workspaces, type Db } from '@slideless/db';
import { hubConfig, type Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Auth } from '../identity/better-auth.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { ApiKeyService } from '../apikeys/service.js';
import type { EmailDriver } from '../email/driver.js';
import { isApiKeyToken } from '../apikeys/service.js';
import { auditMiddleware, type AuditService } from '../audit/service.js';
import { constantTimeEquals } from '../constant-time.js';
import { authContext, type PrincipalGate } from '../middleware/auth-context.js';
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
import type { HubSsoService } from '../identity/hub-sso.js';
import type { HubGrantService } from '../identity/hub-grant.js';
import { registerBreakGlassRoutes } from './break-glass.js';
import { registerCliAuthRoutes } from './cli-auth.js';
import { registerSsoConnectRoutes } from './sso-connect.js';
import { registerMemberRoutes } from './members.js';
import { registerApiKeyRoutes } from './apikeys.js';
import { registerInvitationRoutes } from './invitations.js';
import { registerAuditRoutes } from './audit.js';
import { registerFileRoutes } from './files.js';
import { registerExportRoutes } from './export.js';
import { registerPresentationRoutes } from './presentations.js';
import { registerCollaboratorRoutes } from './collaborators.js';
import { PresentationService } from '../presentations/service.js';
import { AnnotationService } from '../annotations/service.js';
import type { CollaboratorService } from '../collaborators/service.js';
import { registerViewerAnnotationRoutes, viewerApiCors } from '../viewer/annotations-api.js';
import type { ShareTokenService } from '../sharing/service.js';
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
  /** Share tokens (Phase 4) — shared with the public viewer, built in boot. */
  sharing: ShareTokenService;
  /** Per-deck dev grants (Phase 5) — shared with the user.created hook in boot. */
  collaborators: CollaboratorService;
  /**
   * Cloud edition only (docs/federation.md): the hub SSO binding. Its sole
   * job here is wrapping the auth mount in the request-scoped login scope
   * that carries the verified hub assertion from the callback's token
   * verification to its after-hook (ADR 015).
   */
  hubSso?: HubSsoService | undefined;
  /**
   * Cloud edition only: the per-user hub grant store — /sso/cli-connect
   * lands the H3 offline grant through its `acquireFromConnect` seam.
   */
  hubGrant?: HubGrantService | undefined;
  /**
   * Cloud edition only: the post-resolution LIVE hub gate authContext runs
   * (reconcile-as-the-user + suspension/revocation/grant-death verdicts).
   * Absent on oss: the middleware carries zero hub surface.
   */
  principalGate?: PrincipalGate | undefined;
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

  // P7 (docs/federation.md): on EDITION=cloud, membership of a hub-origin
  // (projected) workspace is managed at the hub — this is the pointer the
  // membership-mutation gates and /me carry. Same single `hubConfig` switch
  // as every cloud seam: null on oss, so oss wires no gate and /me answers
  // hubManageUrl null.
  const hub = hubConfig(env);
  const hubManaged = hub ? { manageUrl: hub.issuerUrl } : undefined;

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

  // NOTE (release-gate fix): malformed/empty JSON bodies used to 500 here —
  // hono's json validator throws HTTPException(400) BEFORE zod runs, so the
  // defaultHook above never fires. Hono routes thrown errors straight to the
  // top-level errorHandler from the throwing frame (an upstream middleware
  // try/catch never sees them), so the mapping to the 400 wire shape lives
  // in app.ts app.onError — the one seam that covers every body route.

  // ── Public OAuth endpoints first: wildcard CORS + OPTIONS 204 + no-store
  // on token responses. Before the rate limits so preflights cost nothing.
  api.use('/auth/*', oauthPublicEndpoints());
  // The public viewer-token annotation surface (Phase 5): same posture — the
  // overlay calls cross-origin from the sandboxed opaque origin (Origin:
  // null), token-authed, never cookie-authed, so wildcard CORS is safe.
  api.use('/viewer/*', viewerApiCors());

  // ── Body size caps, path-routed. 1 MiB is generous for every JSON/auth
  // body. Exceptions:
  //  - /files: streamed uploads with their own mid-stream cap
  //    (MAX_FILE_SIZE_MB) plus a Content-Length entitlement check;
  //  - /presentations/assets: multipart deck-asset uploads — capped at
  //    MAX_FILE_SIZE_MB (+1 MiB multipart framing headroom) so an unbounded
  //    body can never balloon the buffering parse;
  //  - the rest of /presentations: JSON, but commit manifests are legal up to
  //    5000 entries × 1 KiB paths — a 16 MiB cap fits any contract-valid
  //    manifest while still bounding abuse.
  const jsonBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json(err('payload_too_large', 'Request body exceeds the 1 MiB limit'), 413)
  });
  const manifestBodyLimit = bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) => c.json(err('payload_too_large', 'Request body exceeds the 16 MiB limit'), 413)
  });
  const assetBodyLimit = bodyLimit({
    maxSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 + 1024 * 1024,
    onError: (c) =>
      c.json(err('file_too_large', `Asset exceeds the ${env.MAX_FILE_SIZE_MB} MB instance cap`), 413)
  });
  api.use('*', (c, next) => {
    const path = c.req.path;
    if (path.startsWith('/api/v1/files')) return next();
    if (path === '/api/v1/presentations/assets') return assetBodyLimit(c, next);
    if (path.startsWith('/api/v1/presentations')) return manifestBodyLimit(c, next);
    return jsonBodyLimit(c, next);
  });

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
  // Collaborator claims are invitation acceptances in per-deck clothing —
  // the same public token-redemption surface, the same wall.
  api.use('/collaborators/claim', rateLimit(limiters.invitationAccept, clientIp));
  api.use('/collaborators/lookup', rateLimit(limiters.invitationAccept, clientIp));
  // Break-glass: a rare superadmin recovery action — a tight per-IP wall
  // bounds allowlist probing before the handlers' own session checks run.
  api.use('/admin/break-glass/*', rateLimit(limiters.breakGlass, clientIp));
  // CLI email-OTP sign-in (api/cli-auth.ts): request = an OTP send (the OTP
  // wall, per IP + email); complete = a credential guess (the login wall,
  // per IP + email) on top of better-auth's own 3-attempts-per-code limit.
  api.use('/cli/auth/request', rateLimit(limiters.otp, clientIp, emailKeyOf));
  api.use('/cli/auth/complete', rateLimit(limiters.login, clientIp, emailKeyOf));
  // CLI cross-tool connect (cloud only, api/sso-connect.ts): presenting an
  // exchange token is a credential presentation — the same login wall as
  // /cli/auth/complete (per IP; no email dimension exists pre-verification).
  // Conditional like the route itself: oss mounts zero hub surface.
  if (deps.hubSso) {
    api.use('/sso/cli-connect', rateLimit(limiters.login, clientIp));
  }

  // Better Auth owns /api/v1/auth/* (mounted before the credential middleware
  // — it IS the credential machinery). On cloud the whole mount runs inside
  // the hub-SSO login scope: an AsyncLocalStorage span carrying the verified
  // hub assertion from the SSO callback's getUserInfo to its after-hook —
  // request-scoped, so concurrent logins can never cross-wire (ADR 015).
  const { hubSso } = deps;
  api.on(['GET', 'POST'], '/auth/*', (c) =>
    hubSso ? hubSso.runWithLoginScope(() => auth.handler(c.req.raw)) : auth.handler(c.req.raw)
  );

  api.use(
    '*',
    authContext({
      registry,
      isApiKeyToken,
      resolveApiKey: (token, requested) => apiKeyService.resolve(token, requested),
      resolveOauthJwt: (token, requested) => deps.oauthJwt.resolve(token, requested),
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
      }),
      // Cloud edition's post-resolution veto (docs/federation.md P4);
      // undefined on oss.
      principalGate: deps.principalGate
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
        name: row?.name ?? 'Slideless',
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

    // The operator drove the wizard (holding the setup token when one is
    // set) — their address needs no mailbox dance, and on the cloud edition
    // it MUST be verified (D9, docs/federation.md): under hub-only login the
    // operator's only entrance is the hub trusted-link, and Better Auth
    // refuses to link a trusted provider onto an UNVERIFIED local email
    // (requireLocalEmailVerified stays on). An unverified operator bricks a
    // cloud instance at bootstrap. The hub's own setup does the same.
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, ownerUserId));

    // Claim the singleton and — on the OSS edition — create the FIRST
    // workspace + owner membership in ONE transaction: either the instance
    // is fully set up or nothing persisted. The workspace goes through the
    // registry's WorkspaceService (ADR 014) — the same path product flows
    // use for every LATER workspace. On CLOUD (`hub` set — the same single
    // switch as every cloud seam) setup creates NO workspace: every cloud
    // workspace is a hub-org projection (user-scoped federation), so the
    // operator bootstrap mints a verified, break-glass capable USER only —
    // the singleton claim, the edition stamp, and the D9 emailVerified
    // force above all stay.
    const instanceId = ulid();
    let workspaceId: string | null;
    try {
      workspaceId = await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(instanceSettings)
          // The edition stamp is what the R7 boot guard compares against
          // (boot.ts, docs/federation.md): setup records the edition this
          // instance was born under.
          .values({ id: 'instance', instanceId, name: body.instanceName, edition: env.EDITION })
          .onConflictDoNothing()
          .returning({ id: instanceSettings.id });
        if (claimed.length === 0) throw new SetupAlreadyDone();

        if (hub) return null;
        const created = await registry.workspaces.create(body.instanceName, ownerUserId, tx);
        return created.workspaceId;
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
  // No blanket requireAuth: the ZERO-MEMBERSHIP session state is route-local
  // (user-scoped federation). A LIVE session whose user holds no active
  // membership — the cloud operator before break-glass, a hub user whose
  // last org was removed — resolves to a null principal (principal
  // resolution requires a membership) but must NOT read as "signed out":
  // /me answers 200 with `workspaces: [], workspace: null` so the dashboard
  // renders the no-organization zero state instead of a login bounce.
  // Machine credentials keep their 401: an invalid/zero-membership key or
  // bearer dies inside authContext before this handler ever runs, so the
  // session lookup below can only ever fire for cookie-authenticated
  // requests.
  api.openapi(meRoute, async (c) => {
    const principal = c.get('principal');
    if (!principal) {
      // The zero state exists ONLY for the selector-less default request: a
      // session that NAMED a workspace and failed its membership check must
      // keep the fail-closed 401 (no oracle about the workspace, and the
      // dashboard's stale-selection self-heal keys on that failure). With
      // no selector, a live session resolving to null principal means
      // exactly "zero active memberships" (the shared resolveMembership
      // default rule).
      if (c.req.header(ACTIVE_WORKSPACE_HEADER)?.trim()) {
        return c.json(err('unauthenticated', 'Authentication required'), 401);
      }
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session?.user) {
        return c.json(err('unauthenticated', 'Authentication required'), 401);
      }
      return c.json(
        {
          user: { id: session.user.id, email: session.user.email, name: session.user.name },
          workspace: null,
          role: null,
          origin: null,
          via: 'session' as const,
          scopes: null,
          apiKeyExpiresAt: null,
          workspaces: [],
          activeWorkspaceId: null,
          // The zero state's CTA target on cloud: organizations are created
          // at the hub, never locally (docs/federation.md).
          hubManageUrl: hubManaged?.manageUrl ?? null
        },
        200
      );
    }
    // Workspaces this credential can name (user-scoped credential model):
    // EVERY credential kind lists ALL of the user's active memberships — a
    // credential is the user, and the org is a per-request parameter. The
    // order mirrors the selection rule (default first, then oldest), but
    // clients must read the `default` flag explicitly, never infer it from
    // the index. (A PINNED key still lists everything: the pin restricts
    // which workspace the key can REACH, not what its holder may see —
    // /me answers about the user behind the credential.)
    const memberships = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        centralAccountId: workspaces.centralAccountId,
        hubStatus: workspaces.hubStatus,
        isDefault: workspaceMembers.isDefault
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, principal.userId), eq(workspaceMembers.isActive, true)))
      .orderBy(desc(workspaceMembers.isDefault), asc(workspaceMembers.createdAt), asc(workspaceMembers.id));
    // hubOrigin is the BOOLEAN projection flag (P7): the raw hub org id
    // never leaves the instance — map explicitly, never spread the row.
    const wireWorkspaces = memberships.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      hubOrigin: m.centralAccountId !== null,
      suspended: m.hubStatus === 'suspended',
      default: m.isDefault
    }));
    const active = wireWorkspaces.find((m) => m.id === principal.workspaceId);
    return c.json(
      {
        user: { id: principal.userId, email: principal.email, name: principal.name },
        workspace: {
          id: principal.workspaceId,
          name: active?.name ?? '',
          // The ACTIVE workspace's flag comes from the principal itself —
          // accountRef IS the request workspace's centralAccountId, read
          // live by every credential resolver.
          hubOrigin: Boolean(principal.accountRef)
        },
        role: principal.role,
        origin: principal.origin,
        via: principal.via,
        scopes: principal.scopes
          ? ([...principal.scopes] as Array<'presentations:read' | 'presentations:write' | 'data:export'>)
          : null,
        apiKeyExpiresAt: principal.apiKeyExpiresAt ?? null,
        workspaces: wireWorkspaces,
        activeWorkspaceId: principal.workspaceId,
        hubManageUrl: hubManaged && principal.accountRef ? hubManaged.manageUrl : null
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
  // CLI email-OTP → API-key mint: PUBLIC pre-auth routes (listed in
  // PUBLIC_API_PATHS) riding the emailOTP plugin; rate-limited above. Also
  // registers DELETE /cli/auth/key — the authenticated self-revoke (CLI
  // logout), NOT public, open to machines under presentations:write. On
  // cloud (hubSso present) the mint pair refuses 403 cli_otp_disabled — the
  // D1 hub-only entrance closure; the self-revoke stays open.
  registerCliAuthRoutes(api, { db, auth, email, apiKeys: apiKeyService, audit, logger, hubSso });
  // CLI cross-tool connect (docs/federation.md P5): PUBLIC exchange of a
  // hub-minted 120 s JWT (+ its H3 offline grant) for a USER-scoped `slk_`
  // key. Registered ONLY on cloud — an oss boot leaves the path to the JSON
  // 404 terminator below, so the self-host edition provably carries zero
  // hub surface here.
  if (hubSso && deps.hubGrant) {
    registerSsoConnectRoutes(api, {
      db,
      auth,
      hubSso,
      grant: deps.hubGrant,
      apiKeys: apiKeyService,
      audit,
      logger
    });
  }
  registerMemberRoutes(api, {
    db,
    auth,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    accountDeletion: deps.accountDeletion,
    hubManaged
  });
  registerApiKeyRoutes(api, db, apiKeyService);
  registerInvitationRoutes(api, { db, env, auth, email, audit, registry, logger, hubManaged });
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
  // Presentation domain (ADR 011): Phases 3 (upload/versioning/pull),
  // 4 (sharing + viewer), and 5 (collaborators/annotations) are all live.
  const presentationService = new PresentationService(db);
  const annotationService = new AnnotationService(db);
  registerFileRoutes(api, {
    service: deps.fileService,
    storage: deps.storage,
    registry,
    env,
    logger,
    instanceId,
    // ADR 011 sharp edge closed: a blob referenced by a live deck version
    // manifest is not deletable through the generic files surface.
    blobInUse: (tx, workspaceId, sha256) => presentationService.blobInUse(tx, workspaceId, sha256)
  });
  registerPresentationRoutes(api, {
    service: presentationService,
    sharing: deps.sharing,
    annotations: annotationService,
    fileService: deps.fileService,
    storage: deps.storage,
    registry,
    env,
    email,
    logger,
    instanceId
  });
  // Collaborator routes AFTER registerPresentationRoutes: the /presentations
  // requireAuth gates registered there must precede these handlers.
  registerCollaboratorRoutes(api, {
    db,
    env,
    auth,
    email,
    audit,
    registry,
    logger,
    presentations: presentationService,
    collaborators: deps.collaborators,
    // Cloud presence switch (docs/federation.md P6): closes the claim
    // endpoint's local-password account creation — invitees arrive through
    // the P3 SSO entrance instead. undefined on oss.
    hubSso
  });
  // The PUBLIC viewer-token annotation surface (Phase 5): token-authed,
  // deliberately outside requireAuth and the scope allowlist — see the
  // module's containment story. Registered before the 404 terminator.
  registerViewerAnnotationRoutes(api, {
    sharing: deps.sharing,
    presentations: presentationService,
    annotations: annotationService,
    logger,
    authSecret: deps.authSecret,
    annotateLimiter: limiters.viewerAnnotate,
    passwordLimiter: limiters.viewerPassword,
    clientIp
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
