import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, jwt, twoFactor } from 'better-auth/plugins';
import { deleteSessionCookie } from 'better-auth/cookies';
import { generateRandomString } from 'better-auth/crypto';
import { oauthProvider } from '@better-auth/oauth-provider';
import { and, eq } from 'drizzle-orm';
import {
  account,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  session,
  twoFactor as twoFactorTable,
  user,
  verification,
  workspaceMembers,
  type Db
} from '@platform/db';
import type { Env } from '../env.js';

/**
 * The only file that touches better-auth's constructor. Everything else goes
 * through the identity module's exports or the IdentityProvider seam, so a
 * Better Auth upgrade (or replacement) stays contained.
 *
 * Password login is the self-host default (no SMTP dependency). Email OTP
 * auto-enables when an email driver is configured; Google when client
 * credentials are set. The twoFactor plugin offers OPT-IN per-user TOTP +
 * backup codes (ADR 009) — password and email-OTP sign-ins by an enrolled
 * user require the second factor; machine credentials never see one. The
 * jwt + oauthProvider plugins make every instance an OAuth 2.1 authorization
 * server for its own bundled /mcp endpoint (M6): RS256 access JWTs (15 min),
 * rotating refresh tokens, PKCE + dynamic client registration, issuance
 * gated on a LIVE active workspace membership.
 */
/** Credential events audited on Better-Auth-native routes. */
export type AccountEvent =
  | 'password_reset'
  | 'password_change'
  | 'email_change_request'
  | 'email_change'
  | 'two_factor_enroll'
  | 'two_factor_disable';

export interface CreateAuthOptions {
  db: Db;
  env: Pick<Env, 'PUBLIC_BASE_URL' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>;
  authSecret: string;
  /** When provided (an email driver delivers), the email-OTP login auto-enables. */
  sendOtp?: (params: { email: string; otp: string; type: string }) => Promise<void>;
  /**
   * When provided (an email driver delivers), self-serve password reset
   * auto-enables — POST /request-password-reset mails a link. Without it that
   * endpoint stays closed (400) and only the admin-generated reset link works.
   */
  sendResetPassword?: (params: { email: string; url: string; token: string }) => Promise<void>;
  /**
   * Confirmation mail to the OLD address when a VERIFIED user requests an
   * email change (the two-leg flow). Unverified users — the template's common
   * case — skip straight to the verification mail below.
   */
  sendChangeEmailConfirmation?: (params: {
    email: string;
    newEmail: string;
    url: string;
    token: string;
  }) => Promise<void>;
  /**
   * Verification mail to the NEW address — the final leg of every self-serve
   * email change. When provided (an email driver delivers), POST /change-email
   * opens; without it the endpoint answers 400 BEFORE any email lookup (no
   * enumeration oracle) and only the admin-generated change link works.
   */
  sendVerificationEmail?: (params: { email: string; url: string; token: string }) => Promise<void>;
  /**
   * Audit hook for credential events on Better-Auth-native routes (which
   * bypass the /api/v1 audit middleware). Fired best-effort by the caller.
   */
  onAccountEvent?: (event: AccountEvent, userId: string) => Promise<void>;
  /**
   * Self-service account deletion guard, run by POST /delete-user BEFORE the
   * row cascade. Boot wires the AccountDeletionService here and translates
   * LastOwnerError into an APIError('BAD_REQUEST') so the route answers 400.
   */
  beforeUserDelete?: (userId: string) => Promise<void>;
  /** Completion hook, run AFTER the cascade (the audit row's system actor). */
  afterUserDelete?: (user: { id: string; email: string }) => Promise<void>;
}

export const AUTH_BASE_PATH = '/api/v1/auth';

/**
 * Products rename data:read / data:write to their domain's scopes — also in
 * middleware/scopes.ts and the consent page copy.
 */
export const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'data:read',
  'data:write',
  // Full-workspace export download — a deliberate opt-in, never implied by
  // data:read (see middleware/scopes.ts).
  'data:export'
] as const;

/**
 * The canonical OAuth resource identifier (JWT `aud`, RFC 8707) — the bundled
 * MCP endpoint. Derived from PUBLIC_BASE_URL at boot, never from its own env
 * var: AS and resource live on one origin, so the byte-identical-URL footgun
 * of the split dashboard+MCP deployment cannot exist here.
 */
export function mcpResourceUrl(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/+$/, '') + '/mcp';
}

export type Auth = ReturnType<typeof createAuth>;

/** Metadata URI fields a registering client may present to users (RFC 7591). */
const CLIENT_METADATA_URI_FIELDS = ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri'] as const;

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createAuth({
  db,
  env,
  authSecret,
  sendOtp,
  sendResetPassword,
  sendChangeEmailConfirmation,
  sendVerificationEmail,
  onAccountEvent,
  beforeUserDelete,
  afterUserDelete
}: CreateAuthOptions) {
  const isHttps = env.PUBLIC_BASE_URL.startsWith('https://');
  const resource = mcpResourceUrl(env.PUBLIC_BASE_URL);

  /**
   * The JWT issuance gate: ONLY users holding a LIVE active workspace
   * membership get claims minted. Runs on the authorization_code AND
   * refresh_token grants; throwing aborts issuance with an RFC 6749 error
   * body. It is NOT what revokes a deactivated member's access, though: a
   * refresh without the RFC 8707 `resource` param still mints an OPAQUE
   * token that never passes through here. The real enforcement is
   * resource-side — every request re-checks the live membership (and an
   * opaque token fails the bearer gate's looksLikeJwt outright), so whatever
   * a refresh mints is rejected at every resource. Verified live (M9).
   */
  async function membershipAccessClaims(user: { id: string; email: string } | null | undefined) {
    if (!user?.id) {
      throw new APIError('FORBIDDEN', {
        error: 'access_denied',
        error_description: 'Token issuance requires a user-bound grant'
      });
    }
    const [row] = await db
      .select({ role: workspaceMembers.role, workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, user.id), eq(workspaceMembers.isActive, true)))
      .limit(1);
    if (!row) {
      throw new APIError('FORBIDDEN', {
        error: 'access_denied',
        error_description: 'This account has no active membership on this instance'
      });
    }
    return { role: row.role, workspace_id: row.workspaceId, email: user.email };
  }

  return betterAuth({
    plugins: [
      ...(sendOtp
        ? [
            emailOTP({
              // Closed instance: OTP signs in EXISTING accounts only — without
              // this, an OTP send to any unknown email would mint a user.
              disableSignUp: true,
              async sendVerificationOTP({ email, otp, type }) {
                await sendOtp({ email, otp, type });
              }
            })
          ]
        : []),
      // Optional per-user 2FA: TOTP + one-time backup codes (ADR 009). NO
      // otpOptions.sendOTP — an emailed code as "second factor" would collapse
      // into the first factor for anyone who controls the mailbox. Enrollment
      // is password-gated and pending until the user proves a working
      // authenticator by verifying one TOTP code; disable is password-gated.
      // Sign-up stays closed: the plugin adds no account-creating route.
      twoFactor({
        // Label shown in authenticator apps — the instance's own host.
        issuer: new URL(env.PUBLIC_BASE_URL).host
      }),
      jwt({
        // JWTs exist ONLY as OAuth access tokens — never attach a signed JWT
        // to plain session responses (recommended with an oauth provider).
        disableSettingJwtHeader: true,
        // RS256 over the default EdDSA: broadest verifier compatibility.
        jwks: { keyPairConfig: { alg: 'RS256' } },
        // Clean origin (no /api/v1/auth path) as the OAuth issuer — the exact
        // `iss` oauth-jwt.ts pins, and the root of the RFC 8414 discovery
        // documents re-served by routes/wellknown.ts.
        jwt: { issuer: env.PUBLIC_BASE_URL }
      }),
      oauthProvider({
        // SPA routes; the API-side validation is Better Auth's signed query.
        loginPage: '/login',
        consentPage: '/oauth/consent',
        scopes: [...OAUTH_SCOPES],
        // `resource` (RFC 8707) must be the bundled MCP endpoint — its exact `aud`.
        validAudiences: [resource],
        // No M2M clients: every token is bound to a consenting user.
        grantTypes: ['authorization_code', 'refresh_token'],
        // MCP clients (claude.ai, Claude Desktop) register themselves via
        // RFC 7591 without a session. Registration alone grants nothing —
        // tokens still require login + consent + an active membership — and
        // the register endpoint is rate-limited in api/index.ts.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
        clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
        // Short access tokens: stateless JWTs can't be revoked, so revocation
        // latency == remaining lifetime. Refresh tokens rotate (reuse detected).
        accessTokenExpiresIn: 900, // 15 min
        refreshTokenExpiresIn: 60 * 60 * 24 * 365, // 365 days (sliding; see the session note)
        customAccessTokenClaims: async ({ user }) => membershipAccessClaims(user),
        // Root discovery documents are re-served by routes/wellknown.ts.
        silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true }
      })
    ],
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              // Same closure: Google signs in accounts that already exist
              // (created via setup/invitations); the callback never creates.
              disableSignUp: true
            }
          }
        : {},
    baseURL: env.PUBLIC_BASE_URL,
    basePath: AUTH_BASE_PATH,
    secret: authSecret,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user,
        session,
        account,
        verification,
        jwks,
        oauthClient,
        oauthAccessToken,
        oauthRefreshToken,
        oauthConsent,
        twoFactor: twoFactorTable
      }
    }),
    user: {
      // Self-serve email change. Enabled unconditionally: without a
      // delivering email driver POST /change-email answers 400 BEFORE the
      // email lookup (no enumeration oracle), so the switch is safe. Tokens
      // are stateless HS256 JWTs signed with the auth secret (1h expiry,
      // not revocable). Template users are typically emailVerified=false, so
      // the COMMON flow is single-leg: one verification mail to the NEW
      // address; the confirmation-to-old-address leg only runs for verified
      // users.
      changeEmail: {
        enabled: true,
        ...(sendChangeEmailConfirmation
          ? {
              sendChangeEmailConfirmation: async ({
                user,
                newEmail,
                url,
                token
              }: {
                user: { email: string };
                newEmail: string;
                url: string;
                token: string;
              }) => {
                await sendChangeEmailConfirmation({ email: user.email, newEmail, url, token });
              }
            }
          : {})
      },
      // Self-service account deletion (GDPR erasure). NO
      // sendDeleteAccountVerification: the password path works with zero
      // SMTP. Known Better Auth default, documented not fought: a session
      // younger than freshAge (24h) may delete WITHOUT a password
      // server-side; the dashboard always collects the password (every
      // template user has a credential account). See ADR 006.
      deleteUser: {
        enabled: true,
        beforeDelete: async (user: { id: string }) => {
          await beforeUserDelete?.(user.id);
        },
        afterDelete: async (user: { id: string; email: string }) => {
          await afterUserDelete?.({ id: user.id, email: user.email });
        }
      }
    },
    emailVerification: {
      expiresIn: 3600,
      ...(sendVerificationEmail
        ? {
            sendVerificationEmail: async ({
              user,
              url,
              token
            }: {
              user: { email: string };
              url: string;
              token: string;
            }) => {
              // `user.email` is already the NEW address on the change-email leg.
              await sendVerificationEmail({ email: user.email, url, token });
            }
          }
        : {}),
      // Fires when GET /verify-email flips a user to verified — the email
      // change landing. Also fires on a hypothetical plain verify-email
      // (acceptable: the audit row records a verification event either way).
      afterEmailVerification: async (user: { id: string }) => {
        if (user?.id) await onAccountEvent?.('email_change', user.id);
      }
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      // Recovery/change implies a possibly-compromised account: drop the
      // other sessions on a reset. Applies to self-serve AND admin-minted
      // reset links (both land on POST /reset-password).
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        await onAccountEvent?.('password_reset', user.id);
      },
      // Self-serve reset exists only with a delivering email driver; without
      // it, /request-password-reset returns 400 (no user-enumeration oracle).
      ...(sendResetPassword
        ? {
            resetPasswordTokenExpiresIn: 3600,
            sendResetPassword: async ({
              user,
              url,
              token
            }: {
              user: { email: string };
              url: string;
              token: string;
            }) => {
              await sendResetPassword({ email: user.email, url, token });
            }
          }
        : {})
    },
    hooks: {
      // Accounts enter through setup or invitations only. HTTP sign-up is
      // closed: ctx.request exists exactly when the call arrived over HTTP;
      // server-side auth.api.signUpEmail calls (setup, invitation accept)
      // carry no request and pass.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/sign-up') && ctx.request) {
          throw new APIError('FORBIDDEN', {
            message: 'Sign-up is closed on this instance — ask an admin for an invitation'
          });
        }
        // Login-CSRF (session fixation) hardening: Better Auth's own origin
        // check deliberately SKIPS requests carrying neither cookies nor
        // Sec-Fetch metadata (progressive enhancement for non-browser
        // clients), which leaves legacy browsers open to a cross-site login
        // POST. Close the gap on the credential-issuing sign-in surface: a
        // sign-in that DOES present an Origin must present a trusted one —
        // trust evaluation is Better Auth's own isTrustedOrigin plus the
        // serving origin (mirroring the trustedOrigins function below).
        // CLI/SDK/MCP flows send no Origin header and are untouched; the
        // OAuth token/register endpoints keep their deliberate public
        // wildcard-CORS posture (middleware/oauth-public.ts).
        if (ctx.path.startsWith('/sign-in') && ctx.request) {
          const origin = ctx.request.headers.get('origin');
          if (origin) {
            let servingOrigin: string | null = null;
            try {
              servingOrigin = new URL(ctx.request.url).origin;
            } catch {
              // unparseable request URL — judge by the trusted list only
            }
            if (origin !== servingOrigin && !ctx.context.isTrustedOrigin(origin)) {
              throw new APIError('FORBIDDEN', { message: 'Invalid origin' });
            }
          }
        }
        // The plugin scheme-checks only redirect_uris — reject javascript:/data:
        // metadata URIs on every client write path (unauthenticated DCR AND the
        // session-gated create/update-client endpoints) so a stored javascript:
        // URI can never reach a render site. The consent page also validates at
        // render (defense in depth).
        if (
          ctx.path === '/oauth2/register' ||
          ctx.path === '/oauth2/create-client' ||
          ctx.path === '/oauth2/update-client'
        ) {
          const raw = ctx.body as Record<string, unknown> | undefined;
          // register/create-client carry the fields at the top level;
          // update-client nests them under `update`.
          const meta = (raw?.update ?? raw) as Record<string, unknown> | undefined;
          for (const field of CLIENT_METADATA_URI_FIELDS) {
            const value = meta?.[field];
            if (value != null && value !== '' && !isHttpUrl(value)) {
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_client_metadata',
                error_description: `${field} must be an http(s) URL`
              });
            }
          }
        }
      }),
      // A successful /change-password or /change-email reaches the after-hook
      // (an error throws before it) — audit them here since Better Auth
      // routes bypass the /api/v1 audit middleware. Reset is audited via
      // onPasswordReset above; the email-change LANDING (the verify-email
      // consumption) via afterEmailVerification.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/change-password') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('password_change', userId);
        }
        if (ctx.path === '/change-email') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('email_change_request', userId);
        }
        // 2FA credential-material events (both routes are session-gated).
        // Enroll = secret + backup codes issued (activation completes on the
        // first verified TOTP); disable = secret + backup codes destroyed.
        if (ctx.path === '/two-factor/enable') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('two_factor_enroll', userId);
        }
        if (ctx.path === '/two-factor/disable') {
          const userId = ctx.context.session?.user?.id;
          if (userId) await onAccountEvent?.('two_factor_disable', userId);
        }
        // Close the email-OTP second-factor bypass: the twoFactor plugin's
        // own sign-in hook covers /sign-in/email (password) but NOT
        // /sign-in/email-otp, so an emailed one-time code would sign a
        // 2FA-enabled user straight in — collapsing 2FA to mailbox control.
        // Mirror the plugin's dance (verified against 1.6.15
        // plugins/two-factor/index.mjs; re-verify on ANY Better Auth bump):
        // drop the just-minted session, park the pending sign-in in the
        // verification table behind the signed `two_factor` cookie, and
        // answer { twoFactorRedirect } so /two-factor/verify-totp (or a
        // backup code) completes it. A 2FA-enabled user always has a
        // verified TOTP secret — activation is the only path that sets
        // user.twoFactorEnabled.
        if (ctx.path === '/sign-in/email-otp') {
          const data = ctx.context.newSession;
          if (!data?.user || !(data.user as { twoFactorEnabled?: boolean }).twoFactorEnabled) return;
          deleteSessionCookie(ctx, true);
          await ctx.context.internalAdapter.deleteSession(data.session.token);
          ctx.context.setNewSession(null);
          const maxAge = 600; // the plugin's twoFactorCookieMaxAge default
          const twoFactorCookie = ctx.context.createAuthCookie('two_factor', { maxAge });
          const identifier = `2fa-${generateRandomString(20)}`;
          await ctx.context.internalAdapter.createVerificationValue({
            value: data.user.id,
            identifier,
            expiresAt: new Date(Date.now() + maxAge * 1000)
          });
          await ctx.setSignedCookie(
            twoFactorCookie.name,
            identifier,
            ctx.context.secret,
            twoFactorCookie.attributes
          );
          return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
        }
      })
    },
    // Long-lived sliding sessions; safe because the auth-context middleware
    // re-checks workspace membership on every request (instant revocation).
    session: {
      expiresIn: 60 * 60 * 24 * 365,
      updateAge: 60 * 60 * 24
    },
    advanced: {
      useSecureCookies: isHttps
    },
    // Trust the serving origin (works on localhost, previews, any domain)
    // plus the configured public origin behind a TLS-terminating proxy.
    trustedOrigins: (request) => {
      const origins = [env.PUBLIC_BASE_URL];
      try {
        if (request) origins.push(new URL(request.url).origin);
      } catch {
        // unparseable request URL — explicit origin only
      }
      return origins;
    }
  });
}
