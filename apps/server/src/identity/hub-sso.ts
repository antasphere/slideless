import { AsyncLocalStorage } from 'node:async_hooks';
import type { JWTPayload } from 'jose';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { GenericOAuthConfig } from 'better-auth/plugins';
import {
  account,
  user as userTable,
  workspaceMembers,
  workspaceRoles,
  workspaces,
  type Db,
  type WorkspaceRole
} from '@slideless/db';
import type { Logger } from '../logger.js';
import { HubJwtVerifier } from './hub-jwt.js';

/**
 * "Sign in with Antasphere" — the cloud edition's SSO entrance
 * (docs/federation.md, ADR 015). This module owns everything hub-SSO:
 *
 *  - the relying-party provider config for better-auth's `genericOAuth`
 *    plugin (registered by identity/better-auth.ts ONLY when the instance
 *    boots EDITION=cloud — an oss boot never constructs this class);
 *  - `HubJwtVerifier`: remote-JWKS verification of the hub-minted tokens,
 *    mirroring oauth-jwt.ts's discipline (hard iss/aud pinning, RS256
 *    allowlist, cached keys + one forced refresh on unknown signature);
 *  - the per-login ASSERTION handoff (an AsyncLocalStorage scope spanning
 *    the callback request — see `runWithLoginScope`);
 *  - the JIT side effects better-auth does not know about: lazy org
 *    projection onto `workspaces.centralAccountId` and the per-login
 *    membership/role/email re-sync (D10/D11).
 *
 * The hub asserts exactly ONE org per login (its consent org picker). The
 * org context rides the ACCESS token — minted by the hub iff the TOKEN
 * request carries RFC 8707 `resource` (hence `tokenUrlParams`); refresh
 * re-mints drop `resource` and go opaque, so org claims are read from the
 * callback exchange ONLY, never from stored/refreshed tokens.
 */

/**
 * providerId of the hub relying party — the discovery method name in
 * `/api/v1/instance`, the better-auth callback path segment
 * (`/api/v1/auth/oauth2/callback/antasphere` — the redirect URI in the
 * hub's TOOL_REGISTRY entry), and the D9 trusted-provider key.
 */
export const HUB_SSO_PROVIDER_ID = 'antasphere';

/** Strict UUID shape — a malformed claim must never reach Postgres' uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What one hub login asserts, extracted from the VERIFIED callback tokens:
 * the org claims (`workspace_id`, `role`, `workspace_name`, `email`) from
 * the access token (the hub's `membershipAccessClaims`), the user claims
 * (`email_verified`, `name`) from the id_token. `role` is the hub org role
 * verbatim — local roles are DERIVED from it, never invented (D11).
 */
export interface HubSsoAssertion {
  /** Hub user id (`sub`) — matched against `account.accountId`, never a local user id. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** The ONE hub org this login asserted (consent org picker). */
  hubWorkspaceId: string;
  /** Hub org role, mapped 1:1 onto the local membership at every login. */
  role: WorkspaceRole;
  /** Display name for the projection (hub delta H1); absent on older hubs. */
  hubWorkspaceName: string | null;
}

/**
 * What one VERIFIED hub exchange JWT asserts (`POST /sso/cli-connect`,
 * docs/federation.md P5) — the same org assertion an SSO login carries,
 * plus the token's one-time-use handle.
 */
export interface HubConnectAssertion extends HubSsoAssertion {
  /** Unique per-token id — consumed one-time-use by the replay ledger. */
  jti: string;
  /** The token's own `exp` — how long the consumed jti must stay claimed. */
  expiresAt: Date;
}

/**
 * The minimal slice of better-auth's server API `provisionConnect` needs
 * (structural — `Auth` from identity/better-auth.ts satisfies it; typing it
 * here keeps hub-sso.ts free of an import cycle with that module). Going
 * through the INTERNAL ADAPTER is the point: `createOAuthUser` is the exact
 * call the genericOAuth callback makes for a browser-SSO JIT, so the
 * databaseHooks.user.create.after seam (`user.created` → the collaborator
 * grant sweep) fires identically, and the rows are byte-identical.
 */
export interface ConnectAuthSeam {
  $context: Promise<{
    internalAdapter: {
      createOAuthUser: (
        user: { email: string; name: string; emailVerified: boolean },
        account: { providerId: string; accountId: string }
      ) => Promise<{ user: { id: string } }>;
      linkAccount: (account: { providerId: string; accountId: string; userId: string }) => Promise<unknown>;
    };
  }>;
}

/**
 * A login failure the after-hook converts into a clean, session-less
 * redirect back to /login?error=<code>. Codes are stable (the dashboard
 * maps them to copy); anything unexpected becomes `sso_login_failed`.
 * `/sso/cli-connect` reuses the same errors as 403 bodies —
 * `sso_link_refused` is its trusted-link refusal (never thrown on the
 * browser login path, where better-auth's own linking gate answers first).
 */
export class HubSsoLoginError extends Error {
  constructor(
    readonly code:
      | 'sso_assertion_missing'
      | 'sso_identity_conflict'
      | 'sso_email_conflict'
      | 'sso_link_refused'
      | 'sso_projection_failed'
      | 'sso_login_failed',
    message: string
  ) {
    super(message);
    this.name = 'HubSsoLoginError';
  }
}

/**
 * The assertion handoff (ADR 015). The verified org context exists in
 * `getUserInfo` (raw tokens, PRE user-create); the projection must run in
 * the callback's after-hook (POST create, fires for JIT and returning users
 * alike). An AsyncLocalStorage scope established around the whole auth
 * request (api/index.ts wraps `auth.handler`) carries it across: getUserInfo
 * writes, the after-hook takes. Being request-scoped, two concurrent logins
 * can NEVER read each other's assertion — unlike any shared map keyed by
 * user/sub/token, where a same-user concurrent login could cross-wire orgs.
 */
interface LoginScope {
  assertion?: HubSsoAssertion;
}

const loginScope = new AsyncLocalStorage<LoginScope>();

export interface HubSsoOptions {
  db: Db;
  logger: Logger;
  /** The hub OIDC issuer (HUB_ISSUER_URL) — iss pin + discovery root. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * This instance's own OAuth resource identifier (`<PUBLIC_BASE_URL>/mcp`,
   * always derived, never configured) — sent as RFC 8707 `resource` on the
   * token request and pinned as the access token's audience.
   */
  resourceUrl: string;
  /** Dashboard origin for the failure redirects (PUBLIC_BASE_URL). */
  publicBaseUrl: string;
}

export class HubSsoService {
  private readonly verifier: HubJwtVerifier;

  constructor(private readonly opts: HubSsoOptions) {
    this.verifier = new HubJwtVerifier(opts.issuerUrl);
  }

  /**
   * Establish the per-request login scope. api/index.ts wraps EVERY
   * /api/v1/auth/* request on cloud — an empty object store is free, and
   * wrapping unconditionally keeps the seam independent of better-auth's
   * internal routing.
   */
  runWithLoginScope<T>(fn: () => T): T {
    return loginScope.run({}, fn);
  }

  /** One-shot read of the assertion the current request's getUserInfo verified. */
  takeAssertion(): HubSsoAssertion | undefined {
    const scope = loginScope.getStore();
    const assertion = scope?.assertion;
    if (scope) delete scope.assertion;
    return assertion;
  }

  /** Where a failed SSO login lands — the login page with a stable error code. */
  loginErrorUrl(code: string): string {
    return `${this.opts.publicBaseUrl.replace(/\/+$/, '')}/login?error=${encodeURIComponent(code)}`;
  }

  logLoginFailure(err: unknown, localUserId: string): void {
    this.opts.logger.warn(
      { err, localUserId },
      'hub SSO login failed after callback — session revoked, redirecting with error'
    );
  }

  /**
   * The genericOAuth provider entry for the hub. Notes that are POSTURE,
   * not accident:
   *
   *  - `tokenUrlParams.resource` (RFC 8707) rides the TOKEN request — the
   *    hub mints the org-claim JWT only then (authorize-only does not).
   *  - `disableSignUp` stays UNSET: SSO IS the sanctioned signup entrance
   *    on cloud — the deliberate FOURTH signup switch next to the three
   *    closed-signup switches (CLAUDE.md invariant, docs/federation.md).
   *  - `getUserInfo` replaces the plugin's default entirely, so IT owns the
   *    emailVerified mapping — set from the hub's verified `email_verified`
   *    claim, never defaulted.
   */
  providerConfig(): GenericOAuthConfig {
    return {
      providerId: HUB_SSO_PROVIDER_ID,
      discoveryUrl: this.opts.issuerUrl.replace(/\/+$/, '') + '/.well-known/openid-configuration',
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
      tokenUrlParams: { resource: this.opts.resourceUrl },
      getUserInfo: (tokens) => this.getUserInfo(tokens)
    };
  }

  /**
   * Verify the callback tokens and extract the assertion. Returning null
   * makes the plugin fail the login with a clean error redirect — the
   * fail-closed path for every bad token (wrong iss/aud, expired, bad
   * signature, malformed claims).
   */
  private async getUserInfo(tokens: {
    accessToken?: string | undefined;
    idToken?: string | undefined;
  }): Promise<{ id: string; email: string; name: string; emailVerified: boolean } | null> {
    try {
      if (!tokens.accessToken) throw new Error('token response carried no access token');
      if (!tokens.idToken) throw new Error('token response carried no id_token (openid is always scoped)');
      // The org claims live in the ACCESS token (aud = our own resource URL);
      // the user claims (email_verified, name) live in the ID token (aud =
      // our client id). Verify BOTH against the hub JWKS and cross-pin the
      // subject so the pair provably describes one hub user.
      const accessClaims = await this.verifier.verify(tokens.accessToken, this.opts.resourceUrl);
      const idClaims = await this.verifier.verify(tokens.idToken, this.opts.clientId);
      if (accessClaims.sub !== idClaims.sub) {
        throw new Error('access/id token subject mismatch');
      }
      const assertion = buildAssertion(accessClaims, idClaims);
      const scope = loginScope.getStore();
      if (scope) {
        scope.assertion = assertion;
      } else {
        // No scope means the auth mount was not wrapped — the after-hook
        // will fail this login closed (sso_assertion_missing). Say why.
        this.opts.logger.error(
          'hub SSO: getUserInfo ran outside a login scope — the callback after-hook will refuse this login'
        );
      }
      return {
        id: assertion.sub,
        email: assertion.email,
        name: assertion.name,
        emailVerified: assertion.emailVerified
      };
    } catch (err) {
      this.opts.logger.warn({ err }, 'hub SSO: callback token rejected');
      return null;
    }
  }

  /**
   * The per-login work (after-hook, newSession-gated, JIT and returning
   * users alike), in fail-closed order:
   *
   *  1. single-hub-identity guard — undo an email-match link that would
   *     merge two hub subjects into one local user;
   *  2. email re-sync (D10) with the explicit duplicate-email collision
   *     path (fail the login, corrupt nothing);
   *  3. lazy projection + membership upsert with the hub-asserted role
   *     (D11) — the unique partial index resolves concurrent first-logins.
   *
   * Throws HubSsoLoginError; the caller revokes the just-minted session and
   * redirects. Any other throw is mapped to the generic failure code there.
   * Returns the LOCAL id of the projected workspace — the SSO after-hook
   * ignores it; `/sso/cli-connect` binds its minted key to it.
   */
  async assertLogin(localUserId: string, assertion: HubSsoAssertion): Promise<{ workspaceId: string }> {
    await this.guardSingleHubIdentity(localUserId, assertion.sub);
    await this.syncEmail(localUserId, assertion);
    return await this.project(localUserId, assertion);
  }

  /**
   * Verify a hub-minted exchange JWT (`POST /sso/cli-connect`, the H3
   * counterpart — docs/federation.md P5) and extract its assertion. The
   * chain, every link fail-closed:
   *
   *  1. `HubJwtVerifier.verify` — hub JWKS signature, `iss` pinned to the
   *     hub, `aud` pinned to OUR resource URL (a token minted for another
   *     tool dies here; a Slideless-minted MCP token dies on `iss`),
   *     RS256 allowlist, expiry (5 s tolerance).
   *  2. `exp` REQUIRED — jose only validates expiry when the claim exists,
   *     and the replay ledger needs a bound; a token without one is a
   *     contract break, refused.
   *  3. `purpose === 'sso-connect'` REQUIRED — a flow-(a) hub access token
   *     carries no purpose claim and dies here even though iss/aud match.
   *  4. `jti` REQUIRED (bounded) — the caller consumes it one-time-use.
   *  5. The org claims pass the same shape validation as an SSO login's.
   *
   * Throws on any failure; the route maps every throw to one uniform 401
   * (no oracle distinguishing replay from expiry from a foreign audience).
   */
  async verifyConnectToken(token: string): Promise<HubConnectAssertion> {
    const claims = await this.verifier.verify(token, this.opts.resourceUrl);
    if (typeof claims.exp !== 'number') throw new Error('exchange token carries no exp');
    if (claims.purpose !== 'sso-connect') {
      throw new Error('token is not an sso-connect exchange token (purpose claim)');
    }
    const jti = claims.jti;
    if (typeof jti !== 'string' || !jti || jti.length > 256) {
      throw new Error('exchange token carries no usable jti');
    }
    const org = assertOrgClaims(claims);
    return {
      ...org,
      // The hub mints exchange tokens only for a live, authenticated hub
      // user — an identity whose email the hub itself verified (its CLI
      // login IS an email OTP). The H3 contract carries no email_verified
      // or name claim, so the honest mirror of the SSO id_token's
      // `email_verified: true` is asserted here, and the display name
      // falls back exactly like an SSO login with a blank profile name.
      emailVerified: true,
      name: org.email.split('@')[0]!,
      jti,
      expiresAt: new Date(claims.exp * 1000)
    };
  }

  /**
   * JIT-provision for `/sso/cli-connect`: resolve-or-create the local user
   * for a VERIFIED connect assertion, then run the SAME per-login work as
   * a browser SSO login (`assertLogin`: identity guard, D10 email sync,
   * lazy projection + origin='hub' membership upsert) so both entrances
   * produce identical rows. User resolution mirrors better-auth's own
   * OAuth linking exactly (oauth2/link-account.mjs on the pinned 1.6.15):
   *
   *  1. account row (providerId='antasphere', accountId=sub) → that user;
   *  2. else a local user holding the asserted email → TRUSTED LINK (D9),
   *     but only onto a VERIFIED local email (requireLocalEmailVerified —
   *     an attacker-parked unverified account can never be taken over);
   *  3. else create user + account through the internal adapter's
   *     `createOAuthUser` — the genericOAuth JIT call, so the
   *     databaseHooks.user.create.after seam (`user.created` → collaborator
   *     grant sweep) fires exactly as it would for a browser SSO signup.
   *     Closed-signup stays intact: this is the sanctioned hub entrance
   *     (the deliberate fourth switch), reached only with a VERIFIED hub
   *     token — never an anonymous signup surface.
   *
   * Two concurrent first-connects race the create; the loser's unique-email
   * violation is caught and resolved by re-running the lookup (the Phase 5
   * duplicate-account lesson).
   */
  async provisionConnect(
    auth: ConnectAuthSeam,
    assertion: HubSsoAssertion
  ): Promise<{ user: { id: string; email: string; name: string }; workspaceId: string }> {
    let userId = await this.resolveConnectUser(auth, assertion, true);
    if (userId === null) {
      // Lost the create race: the winner's rows are committed now (the
      // adapter's transaction passthrough) — one retry must resolve.
      userId = await this.resolveConnectUser(auth, assertion, false);
      if (userId === null) {
        throw new HubSsoLoginError('sso_login_failed', 'user provisioning raced and re-lookup failed');
      }
    }
    const { workspaceId } = await this.assertLogin(userId, assertion);
    // Re-read AFTER assertLogin: the D10 sync may have just rewritten the
    // email; the response must carry what the database now holds.
    const [row] = await this.opts.db
      .select({ id: userTable.id, email: userTable.email, name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    if (!row) throw new HubSsoLoginError('sso_login_failed', 'user row missing after provisioning');
    return { user: row, workspaceId };
  }

  /**
   * One resolution pass (see provisionConnect). Returns the local user id,
   * or null when `mayCreate` and the create lost a uniqueness race —
   * signalling the caller to re-run with the winner's rows visible.
   */
  private async resolveConnectUser(
    auth: ConnectAuthSeam,
    assertion: HubSsoAssertion,
    mayCreate: boolean
  ): Promise<string | null> {
    const db = this.opts.db;
    const [linked] = await db
      .select({ userId: account.userId })
      .from(account)
      .where(and(eq(account.providerId, HUB_SSO_PROVIDER_ID), eq(account.accountId, assertion.sub)))
      .limit(1);
    if (linked) return linked.userId;

    const [existing] = await db
      .select({ id: userTable.id, emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.email, assertion.email))
      .limit(1);
    const authCtx = await auth.$context;
    if (existing) {
      if (!existing.emailVerified) {
        // requireLocalEmailVerified, mirrored: linking a trusted provider
        // onto an UNVERIFIED local account is the classic pre-registration
        // takeover — refuse, exactly like the browser SSO path does.
        throw new HubSsoLoginError(
          'sso_link_refused',
          'a local account holds this email but its address is unverified — refusing the trusted link'
        );
      }
      await authCtx.internalAdapter.linkAccount({
        providerId: HUB_SSO_PROVIDER_ID,
        accountId: assertion.sub,
        userId: existing.id
      });
      return existing.id;
    }
    if (!mayCreate) return null;
    try {
      const created = await authCtx.internalAdapter.createOAuthUser(
        { email: assertion.email, name: assertion.name, emailVerified: assertion.emailVerified },
        { providerId: HUB_SSO_PROVIDER_ID, accountId: assertion.sub }
      );
      return created.user.id;
    } catch (err) {
      // The only expected failure is the unique-email (or duplicate-link)
      // violation from a concurrent first-connect — resolvable by retry.
      this.opts.logger.warn({ err }, 'sso cli-connect: JIT create raced — retrying resolution');
      return null;
    }
  }

  /**
   * A local user may hold AT MOST ONE hub identity. The dangerous path:
   * hub user B's email was changed (hub-side, verified there) to an address
   * some local user A still carries because A's projection is stale — B's
   * first login then finds no account row, matches A by email, and the D9
   * trusted link merges B onto A's local user (and A's decks). Detect the
   * second `antasphere` accountId, DELETE the NEWEST link row, and fail the
   * login. The conflict clears when A next logs in (their email re-syncs
   * away) or an operator intervenes.
   *
   * The undo keys on RECENCY, not on the current login's `sub`. On the
   * normal conflict they are the same row (the trusted link just inserted
   * it). They differ only in residue states where TWO rows pre-exist — a
   * crash between better-auth's link and this hook, or a second identity
   * linked via the explicit /oauth2/link flow (which mints no session, so
   * this guard never saw it). Deleting the current-sub row there would let
   * the ESTABLISHED identity's own login destroy itself (and two
   * concurrent conflicting logins destroy BOTH rows, stranding the user);
   * the newest row is always the intruding link, never the long-standing
   * identity, so the user self-heals on retry.
   */
  private async guardSingleHubIdentity(localUserId: string, sub: string): Promise<void> {
    const rows = await this.opts.db
      .select({ accountId: account.accountId, createdAt: account.createdAt })
      .from(account)
      .where(and(eq(account.userId, localUserId), eq(account.providerId, HUB_SSO_PROVIDER_ID)));
    if (!rows.some((r) => r.accountId !== sub)) return;
    const newest = [...rows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.accountId.localeCompare(a.accountId)
    )[0]!;
    await this.opts.db
      .delete(account)
      .where(
        and(
          eq(account.userId, localUserId),
          eq(account.providerId, HUB_SSO_PROVIDER_ID),
          eq(account.accountId, newest.accountId)
        )
      );
    throw new HubSsoLoginError(
      'sso_identity_conflict',
      `hub subject ${sub} maps to a local user already linked to a different hub subject — newest link undone`
    );
  }

  /**
   * D10: the hub is the identity source on cloud, so the local email FOLLOWS
   * the (verified) hub email at every login — email-keyed features (the
   * collaborator grant sweep) must see the current address. A collision with
   * another local user's email fails the login cleanly; the unique
   * constraint on user.email backstops the read-then-write race.
   */
  private async syncEmail(localUserId: string, assertion: HubSsoAssertion): Promise<void> {
    const email = assertion.email.toLowerCase();
    const [row] = await this.opts.db
      .select({ email: userTable.email, emailVerified: userTable.emailVerified })
      .from(userTable)
      .where(eq(userTable.id, localUserId))
      .limit(1);
    if (!row) throw new HubSsoLoginError('sso_login_failed', 'user row missing after callback');
    const emailChanged = row.email !== email;
    // For an UNCHANGED address, emailVerified is a LATCH: once this instance
    // holds the address as verified, a weaker hub assertion never flips it
    // back — break-glass (api/break-glass.ts) refuses unverified users, so a
    // downward sync could close the operator door if the hub's posture ever
    // allowed an unverified login. A CHANGED address takes the hub's
    // asserted state honestly (the new mailbox is unproven). Mirrors
    // better-auth's own overrideUserInfo semantics.
    const emailVerified = emailChanged
      ? assertion.emailVerified
      : row.emailVerified || assertion.emailVerified;
    if (!emailChanged && row.emailVerified === emailVerified) return;
    if (emailChanged) {
      const [holder] = await this.opts.db
        .select({ id: userTable.id })
        .from(userTable)
        .where(and(eq(userTable.email, email), ne(userTable.id, localUserId)))
        .limit(1);
      if (holder) {
        throw new HubSsoLoginError(
          'sso_email_conflict',
          `hub-asserted email is already held by another local user — refusing to sync`
        );
      }
    }
    try {
      await this.opts.db
        .update(userTable)
        .set({ email, emailVerified, updatedAt: new Date() })
        .where(eq(userTable.id, localUserId));
    } catch {
      // Concurrent claim of the same address between check and write.
      throw new HubSsoLoginError('sso_email_conflict', 'email sync lost a uniqueness race');
    }
  }

  /**
   * Lazy projection: the asserted hub org becomes a local workspace on
   * first use (`centralAccountId` = the hub org id), then a membership
   * upsert re-asserts (role, origin='hub', active) at EVERY login —
   * reactivating a deactivated row and following hub role changes (D11).
   * Deliberately NOT WorkspaceService.create: the projection needs
   * ON CONFLICT semantics on the 0021 unique partial index, the hub's role
   * (not owner), and origin='hub'.
   */
  private async project(localUserId: string, assertion: HubSsoAssertion): Promise<{ workspaceId: string }> {
    const db = this.opts.db;
    try {
      let [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.centralAccountId, assertion.hubWorkspaceId))
        .limit(1);
      if (!ws) {
        // H1 fallback: without workspace_name (older hub), project under a
        // recognizable placeholder — self-healing, the re-sync below renames
        // it at the first login whose token carries the claim.
        const name =
          assertion.hubWorkspaceName ?? `Antasphere workspace ${assertion.hubWorkspaceId.slice(0, 8)}`;
        const inserted = await db
          .insert(workspaces)
          .values({ name, centralAccountId: assertion.hubWorkspaceId })
          .onConflictDoNothing({
            target: workspaces.centralAccountId,
            where: sql`${workspaces.centralAccountId} IS NOT NULL`
          })
          .returning({ id: workspaces.id, name: workspaces.name });
        // Conflict = a concurrent first-login won the insert; land on its row.
        ws =
          inserted[0] ??
          (
            await db
              .select({ id: workspaces.id, name: workspaces.name })
              .from(workspaces)
              .where(eq(workspaces.centralAccountId, assertion.hubWorkspaceId))
              .limit(1)
          )[0];
        if (!ws) throw new Error('projection insert and re-select both returned nothing');
      }
      if (assertion.hubWorkspaceName && ws.name !== assertion.hubWorkspaceName) {
        await db.update(workspaces).set({ name: assertion.hubWorkspaceName }).where(eq(workspaces.id, ws.id));
      }
      await db
        .insert(workspaceMembers)
        .values({
          workspaceId: ws.id,
          userId: localUserId,
          role: assertion.role,
          origin: 'hub',
          isActive: true
        })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role: assertion.role, origin: 'hub', isActive: true }
        });
      return { workspaceId: ws.id };
    } catch (err) {
      if (err instanceof HubSsoLoginError) throw err;
      this.opts.logger.error({ err }, 'hub SSO: org projection failed');
      throw new HubSsoLoginError('sso_projection_failed', 'org projection failed');
    }
  }
}

/**
 * Claim-shape validation for the ORG half of a hub assertion — shared by the
 * SSO login (access token) and the cli-connect exchange token, which carry
 * the same `membershipAccessClaims` payload. A malformed token must fail the
 * flow, not corrupt state.
 */
function assertOrgClaims(
  accessClaims: JWTPayload
): Pick<HubSsoAssertion, 'sub' | 'email' | 'hubWorkspaceId' | 'role' | 'hubWorkspaceName'> {
  const sub = accessClaims.sub;
  if (typeof sub !== 'string' || !sub) throw new Error('missing sub');
  const email = accessClaims.email;
  if (typeof email !== 'string' || !email.includes('@')) throw new Error('missing/malformed email claim');
  const hubWorkspaceId = accessClaims.workspace_id;
  if (typeof hubWorkspaceId !== 'string' || !UUID_RE.test(hubWorkspaceId)) {
    throw new Error('missing/malformed workspace_id claim');
  }
  const role = accessClaims.role;
  // D11: local roles are DERIVED 1:1 from the hub's — an unknown role is a
  // contract break, refused rather than mapped to anything.
  if (typeof role !== 'string' || !(workspaceRoles as readonly string[]).includes(role)) {
    throw new Error(`unknown hub role claim: ${String(role)}`);
  }
  const rawWsName = accessClaims.workspace_name;
  return {
    sub,
    email: email.toLowerCase(),
    hubWorkspaceId,
    role: role as WorkspaceRole,
    hubWorkspaceName: typeof rawWsName === 'string' && rawWsName.trim() ? rawWsName : null
  };
}

/** The full SSO-login assertion: org claims (access token) + user claims (id token). */
function buildAssertion(accessClaims: JWTPayload, idClaims: JWTPayload): HubSsoAssertion {
  const org = assertOrgClaims(accessClaims);
  const rawName = idClaims.name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName : org.email.split('@')[0]!;
  return {
    ...org,
    emailVerified: idClaims.email_verified === true,
    name
  };
}
