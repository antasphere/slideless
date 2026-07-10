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

    // LIVE authorization lookup — the instant-revocation point. The token's
    // role/workspace claims are a 15-min-stale snapshot and never trusted.
    const [row] = await this.db
      .select({
        role: workspaceMembers.role,
        workspaceId: workspaceMembers.workspaceId,
        accountRef: workspaces.centralAccountId,
        email: userTable.email,
        name: userTable.name
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(and(eq(workspaceMembers.userId, sub), eq(workspaceMembers.isActive, true)))
      .limit(1);
    if (!row) return null;

    return {
      userId: sub,
      email: row.email,
      name: row.name,
      workspaceId: row.workspaceId,
      role: row.role,
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
