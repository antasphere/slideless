import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { apiKeys, workspaceMembers, user as userTable, type Db } from '@platform/db';
import type { Principal } from '@platform/contract';
import type { PepperRegistry } from './peppers.js';

/**
 * API keys: `<prefix>_<keyId8>_<secret>`.
 *
 * The prefix is a template constant — rename it per product (e.g. a product
 * called Acme might use `acm`). The shape is fixed: keyId gives an O(1)
 * indexed lookup, the secret is stored as sha256(secret + pepper) and
 * compared constant-time. The pepper defaults to the server auth secret, so
 * a leaked database alone cannot validate keys — and it is VERSIONED
 * (peppers.ts, ADR 008): each row records the pepper version that hashed it,
 * mint uses the registry's current version, and resolution uses the stored
 * version's pepper or fails closed. Keys are minted by sessions only.
 */
export const API_KEY_PREFIX = 'key';

const KEY_ID_BYTES = 6; // 8 chars base64url
const SECRET_BYTES = 32; // 43 chars base64url

const KEY_RE = new RegExp(`^${API_KEY_PREFIX}_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{20,})$`);

export function isApiKeyToken(token: string): boolean {
  return KEY_RE.test(token);
}

function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256')
    .update(secret + pepper)
    .digest('hex');
}

export interface MintedKey {
  id: string;
  keyId: string;
  /** The full key — returned once, never stored. */
  key: string;
}

export class ApiKeyService {
  constructor(
    private readonly db: Db,
    private readonly peppers: PepperRegistry
  ) {}

  async mint(opts: {
    workspaceId: string;
    createdBy: string;
    name: string;
    scopes: string[];
    expiresAt?: Date | null;
  }): Promise<MintedKey> {
    const keyId = randomBytes(KEY_ID_BYTES).toString('base64url');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    // Mint always hashes under the CURRENT pepper version and records which
    // one, so resolution can keep verifying old keys across pepper rotations.
    const pepperVersion = this.peppers.current;
    const pepper = this.peppers.get(pepperVersion);
    if (pepper === undefined) throw new Error(`pepper registry has no current version ${pepperVersion}`);
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        workspaceId: opts.workspaceId,
        keyId,
        secretHash: hashSecret(secret, pepper),
        pepperVersion,
        name: opts.name,
        scopes: opts.scopes,
        createdBy: opts.createdBy,
        expiresAt: opts.expiresAt ?? null
      })
      .returning({ id: apiKeys.id });
    if (!row) throw new Error('api key insert failed');
    return { id: row.id, keyId, key: `${API_KEY_PREFIX}_${keyId}_${secret}` };
  }

  /**
   * Resolve a presented key to a live principal, or null. The key dies with
   * its creator: the creator's membership must still be active (same live
   * re-check discipline as sessions).
   */
  async resolve(token: string): Promise<Principal | null> {
    const match = KEY_RE.exec(token);
    if (!match) return null;
    const [, keyId, secret] = match;
    if (!keyId || !secret) return null;

    const [row] = await this.db
      .select({
        id: apiKeys.id,
        secretHash: apiKeys.secretHash,
        pepperVersion: apiKeys.pepperVersion,
        workspaceId: apiKeys.workspaceId,
        scopes: apiKeys.scopes,
        createdBy: apiKeys.createdBy,
        expiresAt: apiKeys.expiresAt
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          isNull(apiKeys.revokedAt),
          // Expired = same lookup miss as revoked — one fail-closed 401, no
          // behavioural fork. DB clock, not app clock.
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`))
        )
      )
      .limit(1);
    if (!row) return null;

    // Verify under the pepper version THIS row was hashed with — never the
    // current one, never a fallback. An unknown version (e.g. the operator
    // dropped a retired pepper from API_KEY_PEPPERS while such keys remain)
    // FAILS CLOSED: same null → same 401 as a revoked or expired key.
    const pepper = this.peppers.get(row.pepperVersion);
    if (pepper === undefined) return null;

    const presented = Buffer.from(hashSecret(secret, pepper), 'hex');
    const stored = Buffer.from(row.secretHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

    const [member] = await this.db
      .select({
        role: workspaceMembers.role,
        email: userTable.email,
        name: userTable.name
      })
      .from(workspaceMembers)
      .innerJoin(userTable, eq(workspaceMembers.userId, userTable.id))
      .where(
        and(
          eq(workspaceMembers.userId, row.createdBy),
          eq(workspaceMembers.workspaceId, row.workspaceId),
          eq(workspaceMembers.isActive, true)
        )
      )
      .limit(1);
    if (!member) return null;

    // Advisory only — never correctness-load-bearing (statelessness invariant).
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiKeys.id, row.id))
      .catch(() => {});

    return {
      userId: row.createdBy,
      email: member.email,
      name: member.name,
      workspaceId: row.workspaceId,
      role: member.role,
      via: 'api_key',
      scopes: new Set(row.scopes),
      apiKeyId: row.id,
      ...(row.expiresAt ? { apiKeyExpiresAt: row.expiresAt.toISOString() } : {})
    };
  }
}
