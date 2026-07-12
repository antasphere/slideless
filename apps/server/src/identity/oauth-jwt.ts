import { createLocalJWKSet, jwtVerify, type JWK, type JWTVerifyOptions } from 'jose';
import { and, eq } from 'drizzle-orm';
import { user as userTable, workspaceMembers, workspaces, type Db } from '@slideless/db';
import type { Principal } from '@slideless/contract';
import { mcpResourceUrl, type Auth } from './better-auth.js';

/**
 * OAuth Bearer-JWT resolution — the third credential path in auth-context.
 *
 * Access tokens are RS256 JWTs this instance minted itself (Better Auth jwt +
 * oauthProvider plugins), so verification is fully local: JWKS straight from
 * the jwt plugin (DB-backed, no HTTP), hard issuer / audience / algorithm /
 * expiry pinning. On top of the signature, every request re-resolves the
 * workspace membership LIVE — deactivating a member cuts token access on
 * their next request, not at token expiry. Scope enforcement stays in the
 * fail-closed allowlist gate (middleware/scopes.ts), identical to API keys.
 */
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Strict UUID shape — a malformed claim must never reach Postgres' uuid cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OauthJwtVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  // Per-instance cache: the process verifies its OWN tokens, keys rotate
  // rarely; on an unknown-signature failure we refetch once and retry.
  private jwksCache: { keySet: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | null = null;

  constructor(
    private readonly auth: Auth,
    private readonly db: Db,
    publicBaseUrl: string
  ) {
    this.issuer = publicBaseUrl;
    this.audience = mcpResourceUrl(publicBaseUrl);
  }

  private async keySet(forceRefresh = false) {
    if (!forceRefresh && this.jwksCache && Date.now() - this.jwksCache.fetchedAt < JWKS_TTL_MS) {
      return this.jwksCache.keySet;
    }
    const jwks = (await this.auth.api.getJwks()) as { keys: JWK[] };
    this.jwksCache = { keySet: createLocalJWKSet(jwks), fetchedAt: Date.now() };
    return this.jwksCache.keySet;
  }

  private async verify(token: string) {
    const options: JWTVerifyOptions = {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['RS256'], // hard allowlist — implicitly rejects none/HS256
      clockTolerance: 5,
      requiredClaims: ['sub']
    };
    try {
      return await jwtVerify(token, await this.keySet(), options);
    } catch (err) {
      // One retry with fresh keys covers signing-key rotation mid-cache.
      if (err instanceof Error && err.name === 'JWSSignatureVerificationFailed') {
        return await jwtVerify(token, await this.keySet(true), options);
      }
      throw err;
    }
  }

  /**
   * Resolve a Bearer JWT to its principal, or null when the token fails
   * verification or the membership row is missing/inactive — the same
   * fail-closed semantics as the session and API-key paths.
   *
   * Workspace scoping (ADR 014): the `workspace_id` claim names the ONE
   * workspace this token was consent-bound to — the membership re-check is
   * filtered to it, so the token reaches exactly that workspace's data and
   * nothing else, whatever other memberships the user holds. A token
   * WITHOUT the claim (minted before workspace binding existed) falls back
   * to the sole active membership; a multi-workspace user's legacy token
   * resolves to null (fail closed — re-authorization mints a bound one).
   */
  async resolve(token: string): Promise<Principal | null> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await this.verify(token));
    } catch {
      return null;
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) return null;
    const claimedWorkspace = typeof payload.workspace_id === 'string' ? payload.workspace_id : null;
    if (claimedWorkspace !== null && !UUID_RE.test(claimedWorkspace)) return null;

    // LIVE authorization lookup — the instant-revocation point. The token's
    // role claim is a 15-min-stale snapshot and never trusted; workspace_id
    // only SELECTS which membership must be live, it grants nothing itself.
    const rows = await this.db
      .select({
        role: workspaceMembers.role,
        // Guest capability limits (D2) bind OAuth bearers too — the origin
        // of the live membership, never a token claim.
        origin: workspaceMembers.origin,
        workspaceId: workspaceMembers.workspaceId,
        accountRef: workspaces.centralAccountId,
        email: userTable.email,
        name: userTable.name
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(
        and(
          eq(workspaceMembers.userId, sub),
          eq(workspaceMembers.isActive, true),
          ...(claimedWorkspace ? [eq(workspaceMembers.workspaceId, claimedWorkspace)] : [])
        )
      )
      .limit(2);
    const [row] = rows;
    if (!row) return null;
    // Legacy claimless token + several workspaces: never guess — fail closed.
    if (!claimedWorkspace && rows.length > 1) return null;

    return {
      userId: sub,
      email: row.email,
      name: row.name,
      workspaceId: row.workspaceId,
      role: row.role,
      origin: row.origin,
      via: 'oauth',
      scopes: new Set(
        String(typeof payload.scope === 'string' ? payload.scope : '')
          .split(' ')
          .filter(Boolean)
      ),
      ...(row.accountRef ? { accountRef: row.accountRef } : {})
    };
  }
}
