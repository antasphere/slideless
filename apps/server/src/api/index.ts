import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { createEmailVerificationToken } from 'better-auth/api';
import { jwtVerify } from 'jose';
import { registerOpenApiDoc } from './openapi-doc.js';
import { ulid } from 'ulid';
import { and, asc, desc, eq } from 'drizzle-orm';
import { ACTIVE_WORKSPACE_HEADER } from '@slideless/contract';
import { instanceRoute, meRoute, setupRoute } from '@slideless/contract/routes';
import {
  account,
  instanceSettings,
  user as userTable,
  userOnboarding,
  workspaceMembers,
  workspaces,
  type Db
} from '@slideless/db';
import { hubConfig, type Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { Auth } from '../identity/better-auth.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { ApiKeyService } from '../apikeys/service.js';
import type { EmailDriver } from '../email/driver.js';
import { isApiKeyToken } from '../apikeys/service.js';
import { auditMiddleware, type AuditService } from '../audit/service.js';
import { constantTimeEquals } from '../constant-time.js';
import { isSecureSetupOrigin } from '../setup-transport.js';
import { authBodyGuard } from '../middleware/auth-body.js';
import { authContext, type PrincipalGate } from '../middleware/auth-context.js';
import { idempotency } from '../middleware/idempotency.js';
import { crossSiteGuard } from '../middleware/cross-site.js';
import { jsonDepthLimit } from '../middleware/json-depth.js';
import { noStoreAuthenticated } from '../middleware/no-store.js';
import { oauthPublicEndpoints } from '../middleware/oauth-public.js';
import {
  createRequestQuota,
  emailKeyOf,
  makeClientIp,
  rateLimit,
  type RateLimiters
} from '../middleware/rate-limit.js';
import type { OauthJwtVerifier } from '../identity/oauth-jwt.js';
import { HUB_SSO_PROVIDER_ID, type HubSsoService } from '../identity/hub-sso.js';
import type { HubGrantService } from '../identity/hub-grant.js';
import type { HubLogoutService } from '../identity/hub-logout.js';
import { registerBreakGlassRoutes } from './break-glass.js';
import { registerCliAuthRoutes } from './cli-auth.js';
import { registerOnboardingRoutes } from './onboarding.js';
import { registerSsoConnectRoutes } from './sso-connect.js';
import { registerSsoLogoutRoutes } from './sso-logout.js';
import { registerMemberRoutes } from './members.js';
import { registerApiKeyRoutes } from './apikeys.js';
import { registerInvitationRoutes } from './invitations.js';
import { registerAuditRoutes } from './audit.js';
import { registerFileRoutes } from './files.js';
import { registerExportRoutes } from './export.js';
import { registerPresentationRoutes } from './presentations.js';
import { registerCollaboratorRoutes } from './collaborators.js';
import { blobReadScope, PresentationService } from '../presentations/service.js';
import { AnnotationService } from '../annotations/service.js';
import { ShareTokenViewService } from '../sharing/view-events.js';
import type { CollaboratorService } from '../collaborators/service.js';
import type { FormResponseService } from '../forms/service.js';
import { registerViewerFormRoutes } from '../viewer/forms-api.js';
import { registerViewerAttachmentRoutes } from '../viewer/attachments-api.js';
import { registerViewerAnnotationRoutes, viewerApiCors } from '../viewer/annotations-api.js';
import type { ShareTokenService } from '../sharing/service.js';
import type { AccountDeletionService } from '../accounts/deletion.js';
import type { FileService } from '../files/service.js';
import type { StorageDriver } from '../storage/driver.js';

/** Inline error body matching the wire shape; keeps openapi handlers typed. */
const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * PRDCT-1437 door 1: neutralize the change-email consume's account-existence
 * oracle by rewriting the REQUEST before Better Auth reads the token.
 *
 * The consume of a `change-email-verification` link updates the target's email
 * to the new address; when that address already belongs to ANOTHER user the
 * update dies at the `user.email` UNIQUE constraint as a raw 500, while a free
 * address answers a 302 — a mint-then-consume "does this email exist anywhere
 * on the instance" for any workspace owner, and a robustness bug. Rather than
 * reimplement the consume (LESSONS.md M6: never hand-roll the Better Auth
 * flow), on a collision we re-sign the token so its target is the member's
 * CURRENT address — a no-op change that runs Better Auth's ENTIRE success path
 * (its own `callbackURL` origin check, the session mint, the set-cookie, the
 * 302-or-JSON, the audit hook) with no unique violation. Redirect, cookie, and
 * origin-check verdict are then byte-identical to the free case BY
 * CONSTRUCTION, and no `callbackURL` handling is added here, so no open-redirect
 * surface is introduced (the route's own originCheck stays the only judge).
 *
 * The one residual tell — the success JSON echoes the resulting email in its
 * `user` record — is reachable only WITHOUT a `callbackURL` (a real consume
 * always carries one and redirects) and is stripped to `user:null` by the
 * wrapper below. The honest, inherent residual (email uniqueness is
 * instance-global, so the change's outcome is readable one step later on the
 * roster) is documented in ADR 013's amendment. It runs in a before-hook only
 * as a query mutation, which the endpoint's own parsed query never sees, so it
 * MUST rewrite the request here. Re-verify the token shape and the
 * `change-email-verification` requestType on ANY Better Auth bump.
 */
/**
 * Constrain a verify-email redirect Location to the instance's own origin
 * (Major 3, PRDCT-1437 hardening). DEFENCE-IN-DEPTH, not a hole being closed:
 * on the pinned Better Auth, `/verify-email` DOES run its own callbackURL
 * origin check in production (the `originCheck` factory has no GET skip; only
 * `originCheckMiddleware` does) — but the test harness disables that guard
 * (`NODE_ENV=test` sets `skipOriginCheck`), and a future bump could regress
 * it, so we constrain the redirect ourselves and the no-op collision rewrite
 * routes the taken branch through the same constraint. A same-origin (or
 * public-origin) target is returned
 * as a relative path; anything off-origin is neutralized to `/`. Legitimate
 * consumes send a relative `callbackURL` and are untouched; applied to every
 * response the wrapper sees, so the taken and free branches stay identical.
 */
function safeRedirectLocation(location: string, requestUrl: string, publicBaseUrl: string): string {
  let resolved: URL;
  let servingOrigin: string;
  try {
    servingOrigin = new URL(requestUrl).origin;
    resolved = new URL(location, requestUrl);
  } catch {
    return '/';
  }
  let publicOrigin: string | null = null;
  try {
    publicOrigin = new URL(publicBaseUrl).origin;
  } catch {
    publicOrigin = null;
  }
  if (resolved.origin === servingOrigin || resolved.origin === publicOrigin) {
    return resolved.pathname + resolved.search + resolved.hash;
  }
  return '/';
}

async function rewriteChangeEmailCollision(
  auth: Auth,
  authSecret: string,
  request: Request
): Promise<Request> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return request;
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(authSecret), {
      algorithms: ['HS256']
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return request; // a bad token is Better Auth's to reject (uniform error redirect)
  }
  const email = payload.email;
  const updateTo = payload.updateTo;
  if (
    payload.requestType !== 'change-email-verification' ||
    typeof email !== 'string' ||
    typeof updateTo !== 'string' ||
    email === updateTo
  ) {
    return request;
  }
  try {
    const authCtx = await auth.$context;
    const target = await authCtx.internalAdapter.findUserByEmail(email);
    if (!target) return request; // user_not_found — uniform on both branches
    // A signed-in NON-target redirectOnErrors identically on both branches, so
    // only the state that actually reaches the update needs neutralizing.
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (session && session.user.email !== email) return request;
    const holder = await authCtx.internalAdapter.findUserByEmail(updateTo);
    if (!holder || holder.user.id === target.user.id) return request; // no collision
    // Collision: re-sign as a no-op (change email → same email). Better Auth
    // then updates the row to its own value (no 23505) and runs the full
    // success path off the rewritten request.
    const noopToken = await createEmailVerificationToken(authCtx.secret, email, email, 3600, {
      requestType: 'change-email-verification'
    });
    url.searchParams.set('token', noopToken);
    return new Request(url.toString(), request);
  } catch {
    // A lookup failure must not turn into a distinguishing error — let Better
    // Auth answer, and the wrapper's 5xx→uniform mapping backstops it.
    return request;
  }
}

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
  /**
   * The credential POST /setup REQUIRES (PRDCT-1347): SETUP_TOKEN, or the
   * token boot generated into the data volume for an unclaimed instance.
   * null only once the instance is set up (nothing left to claim).
   */
  setupToken: string | null;
  /** Removes the boot-generated token file after a successful claim (no-op when SETUP_TOKEN is set). */
  clearGeneratedSetupToken: () => Promise<void>;
  accountDeletion: AccountDeletionService;
  /** Share tokens (Phase 4) — shared with the public viewer, built in boot. */
  sharing: ShareTokenService;
  forms: FormResponseService;
  /** Per-deck dev grants (Phase 5) — shared with the user.created hook in boot. */
  collaborators: CollaboratorService;
  /**
   * Cloud edition only (internal/federation.md): the hub SSO binding. Its sole
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
   * Cloud edition only: RP-initiated hub logout — POST /sso/logout builds
   * the end-session URL through it (SL-2). Absent on oss: the route is
   * never registered and the path answers the JSON 404 terminator.
   */
  hubLogout?: HubLogoutService | undefined;
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

  // P7 (internal/federation.md): on EDITION=cloud, membership of a hub-origin
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

  // ── Cross-site (CSRF) gate, before ANY other work: an unsafe method driven
  // from another origin is refused before a body is buffered, before a
  // limiter bucket is touched, and before a credential resolves. Sessions are
  // ambient credentials — every business route below (presentations, share
  // tokens, collaborators, annotations, api-keys) would otherwise be drivable
  // from any page the user happens to have open.
  //
  // SCOPED TO /api/v1 ON PURPOSE. The public viewer (`/v/:secret`) is mounted
  // on the root app and is DELIBERATELY embeddable cross-origin (ADR 021 +
  // /embed.js), including its password-form POST — mounting this guard there
  // would break every legitimate embed. The viewer authenticates on the share
  // secret and its own scoped cookie, not on the dashboard session, so it is
  // not the ambient-credential surface this closes.
  api.use(
    '*',
    crossSiteGuard({
      publicBaseUrl: env.PUBLIC_BASE_URL,
      // The viewer origin (PRDCT-1352) is author-controlled deck script's
      // origin: never a trust grant here, even if it is the serving origin.
      deniedOrigins: env.VIEWER_BASE_URL ? [env.VIEWER_BASE_URL] : [],
      // `/api/v1/viewer/*` is the share-token annotation API, and it is a
      // DELIBERATE wildcard-CORS surface (viewer/annotations-api.ts): it is
      // called by the overlay client running inside the sandboxed viewer
      // iframe, whose origin is the opaque `null`. Nothing there is
      // cookie-authenticated — the share token in the path is the credential —
      // so it is not the ambient-credential class this guard closes, and
      // refusing `Origin: null` would break annotations outright.
      isExempt: (path) => path.startsWith('/api/v1/viewer/')
    })
  );

  // ── Authenticated responses are never cached. Registered ABOVE the
  // credential middleware so it wraps every route under /api/v1, and it reads
  // the principal AFTER the inner chain has resolved it. Routes that set their
  // own Cache-Control (public discovery, the OpenAPI document) keep it.
  api.use('*', noStoreAuthenticated());
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

  // ── JSON nesting cap, right after the size cap (so the scan is bounded by
  // it): `JSON.parse` accepts any depth but `JSON.stringify` is recursive, so
  // a small body of nothing but `[` turns any echo/audit/log of it into a
  // RangeError 500 inside the shipped node:22-alpine image.
  api.use('*', jsonDepthLimit());

  // ── Auth-surface rate limits: registered FIRST so they run before auth
  // resolution — abusive traffic is rejected before it costs a DB query.
  const clientIp = makeClientIp(env.TRUST_PROXY);
  // Login keys by IP AND email: Docker NAT (or a rotating attacker) can
  // collapse/expand the IP dimension, so per-account protection must not
  // depend on it. emailKeyOf returns [] for bodyless social sign-in.
  //
  // consumeOn: 'failure' — see rate-limit.ts. The email key is derived from
  // the REQUEST BODY, i.e. from an address anyone can type, so consuming it on
  // arrival made the wall an account-lockout tool: ten POSTs naming a victim
  // emptied that account's bucket for the window. Consuming only when the
  // credential was actually refused keeps the brute-force budget identical and
  // makes the owner's own successful sign-ins free.
  api.use('/auth/sign-in/*', rateLimit(limiters.login, clientIp, emailKeyOf, { consumeOn: 'failure' }));
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
  api.use('/cli/auth/complete', rateLimit(limiters.login, clientIp, emailKeyOf, { consumeOn: 'failure' }));
  // The OpenAPI document is unauthenticated (PUBLIC_API_PATHS) so it never
  // reaches the per-principal quota; the buffer is generated once at boot
  // (openapi-doc.ts) and this wall is the defence in depth on top.
  api.use('/openapi.json', rateLimit(limiters.openapiDoc, clientIp));
  // CLI cross-tool connect (cloud only, api/sso-connect.ts): presenting an
  // exchange token is a credential presentation — the same login wall as
  // /cli/auth/complete (per IP; no email dimension exists pre-verification).
  // Conditional like the route itself: oss mounts zero hub surface.
  if (deps.hubSso) {
    api.use('/sso/cli-connect', rateLimit(limiters.login, clientIp));
  }

  // ── JSON pre-validation in front of the Better Auth mount (AF-1 + the
  // update-user half of SL-B4, PRDCT-1358): Better Auth answers its own 500
  // on a malformed/empty JSON body and on a NUL that reaches Postgres —
  // responses app.onError never sees, so the app-level mappings cannot help.
  // Registered here, after the size and depth caps, so the guard's body read
  // is bounded.
  api.use('/auth/*', authBodyGuard());

  // Better Auth owns /api/v1/auth/* (mounted before the credential middleware
  // — it IS the credential machinery). On cloud the whole mount runs inside
  // the hub-SSO login scope: an AsyncLocalStorage span carrying the verified
  // hub assertion from the SSO callback's getUserInfo to its after-hook —
  // request-scoped, so concurrent logins can never cross-wire (ADR 015).
  const { hubSso } = deps;
  // The change-email consume, wrapped (PRDCT-1437). The request is rewritten
  // on a collision (rewriteChangeEmailCollision above), then two response
  // normalizations keep the taken and free cases indistinguishable:
  //
  //  - JSON success body: the change-email success echoes the resulting email
  //    in its `user` record — the one observable the no-op rewrite leaves
  //    differing between the taken and free cases. It is reachable ONLY without
  //    a `callbackURL` (a real consume always carries one and redirects, never
  //    hitting this JSON), so stripping `user` to null for every change-email
  //    consume touches no legitimate flow. Only the change/legacy branches
  //    return a non-null user; the plain verify-email success is already null.
  //  - a residual 5xx: the rewrite closes the DECIDABLE collision, but two
  //    concurrent mints claiming one FRESH address (no pre-existing account —
  //    so NOT an existence probe) can still lose at the DB. Map it to the same
  //    benign JSON so it never surfaces a raw 500. No redirect is issued here —
  //    every redirect stays Better Auth's, judged by its own originCheck, so
  //    this wrapper adds no open-redirect surface.
  //
  // Registered BEFORE the wildcard mount so the exact route wins.
  api.on(['GET'], '/auth/verify-email', async (c) => {
    const req = await rewriteChangeEmailCollision(auth, deps.authSecret, c.req.raw);
    const res = await (hubSso ? hubSso.runWithLoginScope(() => auth.handler(req)) : auth.handler(req));
    if (res.status === 200 && (res.headers.get('content-type') ?? '').includes('application/json')) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { status?: unknown; user?: unknown } | null;
      if (body && body.status === true && body.user != null) {
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(JSON.stringify({ status: true, user: null }), { status: 200, headers });
      }
      return res;
    }
    // A 3xx: constrain the Location to this origin (Major 3). Better Auth's
    // GET verify-email skips originCheck (no Origin header on a navigation) and
    // redirects to any callbackURL — an open redirect for anyone holding a
    // verify token, applied to BOTH branches so it stays uniform.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        const safe = safeRedirectLocation(location, c.req.url, env.PUBLIC_BASE_URL);
        if (safe !== location) {
          const headers = new Headers(res.headers);
          headers.set('location', safe);
          return new Response(null, { status: res.status, headers });
        }
      }
      return res;
    }
    if (res.status < 500) return res;
    logger.warn(
      { status: res.status },
      'verify-email answered 5xx — mapped to the uniform non-revealing response'
    );
    return c.json({ status: true, user: null }, 200);
  });
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
      // Cloud edition's post-resolution veto (internal/federation.md P4);
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
        auth: {
          ...registry.identity.describe(),
          // Cloud only (SL-1): the hint-cookie contract the dashboard's
          // silent auto-connect reads — spread-gated on the same single
          // `hub` switch as every cloud seam, so the oss discovery bytes
          // never carry the key.
          ...(hub
            ? { sso: { hintCookieName: hub.hintCookieName, hintCookieDomain: hub.hintCookieDomain } }
            : {})
        },
        features: { mcp: true, oauth: true, files: true }
      },
      200
    );
  });

  // ── POST /setup — one-shot first-boot wizard ─────────────────────────────
  api.openapi(setupRoute, async (c) => {
    const body = c.req.valid('json');

    // BEFORE the token check: an instance reachable only over plaintext on a
    // non-loopback origin must not accept the owner password at all, whether
    // or not the caller holds the token (setup-transport.ts).
    if (!env.ALLOW_INSECURE_SETUP && !isSecureSetupOrigin(env.PUBLIC_BASE_URL)) {
      logger.warn(
        { publicBaseUrl: env.PUBLIC_BASE_URL },
        'refused setup over plaintext on a non-loopback origin'
      );
      return c.json(
        err(
          'insecure_transport',
          'Setup over plaintext HTTP on a non-loopback origin is refused. Put TLS in front, reach the instance through an SSH tunnel, or set ALLOW_INSECURE_SETUP=true.'
        ),
        403
      );
    }

    const [existing] = await db.select({ id: instanceSettings.id }).from(instanceSettings).limit(1);
    if (existing) {
      return c.json(err('already_setup', 'This instance has already been set up'), 410);
    }

    // ALWAYS required (PRDCT-1347): the claim decides who owns the instance.
    // `deps.setupToken` is SETUP_TOKEN or the boot-generated token; it is
    // null only for a set-up instance, which the 410 above already answered
    // — so a null here is a claim with no credential to compare against and
    // fails closed rather than falling through to a free claim.
    if (!deps.setupToken || !constantTimeEquals(body.setupToken ?? '', deps.setupToken)) {
      return c.json(err('invalid_setup_token', 'A valid setup token is required'), 403);
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
    // it MUST be verified (D9, internal/federation.md): under hub-only login the
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
          // (boot.ts, internal/federation.md): setup records the edition this
          // instance was born under.
          .values({
            id: 'instance',
            instanceId,
            name: body.instanceName,
            edition: env.EDITION,
            // The durable operator record (CLOUD-3): survives the orphan purge.
            operatorUserId: ownerUserId
          })
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
    // The generated token has done its one job; a leftover copy in the data
    // volume is a secret with no purpose (it would ride in every backup).
    await deps.clearGeneratedSetupToken().catch((cause: unknown) => {
      logger.warn({ err: cause }, 'setup: could not remove the generated setup-token file');
    });

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

  /**
   * SL-6 /me extras — CLOUD + SESSION callers only (both spread-gated
   * below; machine credentials and every oss response never carry the
   * keys):
   *
   *  - `firstRunPending`: tool-local, retry-safe banner truth —
   *    `NOT EXISTS (user_onboarding row WHERE dismissed_at IS NOT NULL)`.
   *    A missing row (lost first-login insert) still shows the welcome;
   *    only an explicit dismissal (or the deploy backfill) hides it.
   *  - `ssoOnly`: the hint-watch discriminator — the user holds an
   *    `antasphere` account row AND no local credential (password) row.
   *    'credential' is better-auth's password-account providerId (pinned
   *    1.6.15; re-verify on bump). A break-glass-capable operator always
   *    has a credential row (setup mints it), so they are NEVER ssoOnly
   *    and the dashboard's hint-watch can never sign them out.
   */
  const CREDENTIAL_PROVIDER_ID = 'credential';
  const cloudSessionExtras = async (
    userId: string
  ): Promise<{ firstRunPending: boolean; ssoOnly: boolean }> => {
    const [onboardingRows, accountRows] = await Promise.all([
      db
        .select({ dismissedAt: userOnboarding.dismissedAt })
        .from(userOnboarding)
        .where(eq(userOnboarding.userId, userId))
        .limit(1),
      db.select({ providerId: account.providerId }).from(account).where(eq(account.userId, userId))
    ]);
    const providers = new Set(accountRows.map((r) => r.providerId));
    return {
      firstRunPending: onboardingRows[0]?.dismissedAt == null,
      ssoOnly: providers.has(HUB_SSO_PROVIDER_ID) && !providers.has(CREDENTIAL_PROVIDER_ID)
    };
  };

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
          // at the hub, never locally (internal/federation.md).
          hubManageUrl: hubManaged?.manageUrl ?? null,
          // Cloud + session extras (SL-6): the zero state is session-only
          // by construction, so only the edition gate applies here.
          ...(hub ? await cloudSessionExtras(session.user.id) : {})
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
        hubManageUrl: hubManaged && principal.accountRef ? hubManaged.manageUrl : null,
        // Cloud + SESSION only (SL-6): machine credentials never carry the
        // onboarding/hint-watch keys — the banner and the auto-sign-out are
        // browser concerns.
        ...(hub && principal.via === 'session' ? await cloudSessionExtras(principal.userId) : {})
      },
      200
    );
  });

  // First-run onboarding dismiss (SL-6): cloud-only — an oss boot leaves
  // POST /me/onboarding/dismiss to the JSON 404 terminator. Session-only
  // (unlisted in the machine scope allowlist; route-local session check).
  if (hub) {
    registerOnboardingRoutes(api, { db, auth });
  }

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
  // CLI cross-tool connect (internal/federation.md P5): PUBLIC exchange of a
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
  // Single logout (SL-2): cloud-only like /sso/cli-connect — an oss boot
  // leaves POST /sso/logout to the JSON 404 terminator. Deliberately
  // UNLISTED in the machine scope allowlist: sessions only (incl.
  // zero-membership — the handler resolves the session route-locally).
  if (hubSso && deps.hubLogout && hub) {
    registerSsoLogoutRoutes(api, {
      auth,
      logout: deps.hubLogout,
      hint: {
        name: hub.hintCookieName,
        domain: hub.hintCookieDomain,
        secure: env.PUBLIC_BASE_URL.startsWith('https://')
      },
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
  registerInvitationRoutes(api, {
    db,
    env,
    auth,
    email,
    audit,
    registry,
    logger,
    hubManaged,
    // CLOUD-5: no local-password accounts minted through invitations on cloud.
    ssoOnly: Boolean(deps.hubSso)
  });
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
    blobInUse: (tx, workspaceId, sha256) => presentationService.blobInUse(tx, workspaceId, sha256),
    // SL-B1: the generic files surface authorizes per DECK, not per
    // workspace — the ADR 013 policy expressed as a WHERE predicate.
    blobReadScope
  });
  registerPresentationRoutes(api, {
    service: presentationService,
    sharing: deps.sharing,
    views: new ShareTokenViewService(db, logger),
    annotations: annotationService,
    forms: deps.forms,
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
    // Cloud presence switch (internal/federation.md P6): closes the claim
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
  // The PUBLIC viewer-token form surface (ADR 022): the annotation surface's
  // sibling — same containment story, same shared token-session resolver.
  registerViewerFormRoutes(api, {
    sharing: deps.sharing,
    presentations: presentationService,
    forms: deps.forms,
    logger,
    authSecret: deps.authSecret,
    email,
    env,
    formSubmitLimiter: limiters.viewerFormSubmit,
    formEmailLimiter: limiters.viewerFormEmail,
    passwordLimiter: limiters.viewerPassword,
    clientIp
  });
  // The PUBLIC viewer-token attachments list (PRDCT-2278): the read-only
  // third sibling — same resolver, same containment. Unknown-secret probes
  // burn the annotation surface's per-IP bucket (nothing is written here,
  // the bucket only keeps the endpoint from being a cheaper secret oracle
  // than /v).
  registerViewerAttachmentRoutes(api, {
    sharing: deps.sharing,
    presentations: presentationService,
    logger,
    authSecret: deps.authSecret,
    invalidSecretLimiter: limiters.viewerAnnotate,
    passwordLimiter: limiters.viewerPassword,
    clientIp
  });

  // Generated ONCE here, at the end of route registration — never per
  // request (api/openapi-doc.ts explains why that mattered).
  registerOpenApiDoc(api, {
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
