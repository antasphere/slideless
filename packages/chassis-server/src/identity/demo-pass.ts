import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getSessionCookie } from 'better-auth/cookies';
import {
  demoPasses,
  demoPassSessions,
  session as sessionTable,
  user as userTable,
  workspaceMembers,
  type Db
} from '@antasphere/chassis-db';
import type { DemoPass } from '@antasphere/chassis-contract';
import { isDemoAddress } from './demo-pass-rules.js';

/**
 * The demo pass service (the demo pass spec, section 3): mint, list, revoke,
 * look a secret up, and record a use. The secret is 32 random bytes in
 * base64url (43 characters); only its sha256 hex is stored, looked up through
 * the unique index. Nothing here logs, and nothing here returns the secret
 * but `mint`, once, to the route that shows it once.
 */

/** The sha256 hex of a pass secret: the only form the database ever holds. */
export function demoPassSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A pass as the owner's routes speak it: the row plus its person's address and name. */
interface PassWithPerson {
  id: string;
  userId: string;
  email: string;
  name: string;
  targetPath: string;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  useCount: number;
}

export function demoPassToWire(p: PassWithPerson): DemoPass {
  return {
    id: p.id,
    userId: p.userId,
    email: p.email,
    name: p.name,
    targetPath: p.targetPath,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    expiresAt: p.expiresAt.toISOString(),
    revokedAt: p.revokedAt?.toISOString() ?? null,
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    useCount: p.useCount
  };
}

/** What a redeem signs in: the pass and its person, every condition re-checked. */
export interface RedeemablePass {
  passId: string;
  workspaceId: string;
  targetPath: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string };
}

const passColumns = {
  id: demoPasses.id,
  userId: demoPasses.userId,
  email: userTable.email,
  name: userTable.name,
  targetPath: demoPasses.targetPath,
  createdBy: demoPasses.createdBy,
  createdAt: demoPasses.createdAt,
  expiresAt: demoPasses.expiresAt,
  revokedAt: demoPasses.revokedAt,
  lastUsedAt: demoPasses.lastUsedAt,
  useCount: demoPasses.useCount
};

export class DemoPassService {
  constructor(private readonly db: Db) {}

  /**
   * Mint a pass. The caller (the owner's route) has already judged every
   * refusal; this writes the row and hands the secret back, once.
   */
  async mint(input: {
    workspaceId: string;
    userId: string;
    createdBy: string;
    targetPath: string;
    expiresInMinutes: number;
  }): Promise<{ pass: PassWithPerson; secret: string }> {
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60 * 1000);
    const [row] = await this.db
      .insert(demoPasses)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        targetPath: input.targetPath,
        secretHash: demoPassSecretHash(secret),
        createdBy: input.createdBy,
        expiresAt
      })
      .returning({ id: demoPasses.id });
    const pass = await this.get(input.workspaceId, row!.id);
    return { pass: pass!, secret };
  }

  /** One pass of one workspace, or null (another workspace's pass is null too). */
  async get(workspaceId: string, id: string): Promise<PassWithPerson | null> {
    const [row] = await this.db
      .select(passColumns)
      .from(demoPasses)
      .innerJoin(userTable, eq(userTable.id, demoPasses.userId))
      .where(and(eq(demoPasses.id, id), eq(demoPasses.workspaceId, workspaceId)))
      .limit(1);
    return row ?? null;
  }

  /** The workspace's passes, newest first. */
  async list(workspaceId: string): Promise<PassWithPerson[]> {
    return this.db
      .select(passColumns)
      .from(demoPasses)
      .innerJoin(userTable, eq(userTable.id, demoPasses.userId))
      .where(eq(demoPasses.workspaceId, workspaceId))
      .orderBy(desc(demoPasses.createdAt), desc(demoPasses.id));
  }

  /**
   * Revoke a pass of this workspace. Idempotent: a revoked pass keeps its
   * first revocation time and is answered again. Null when the workspace
   * holds no such pass. The sessions the pass opened are not ended: they are
   * the person's sessions now, and the person signs out of them.
   */
  async revoke(workspaceId: string, id: string): Promise<PassWithPerson | null> {
    const updated = await this.db
      .update(demoPasses)
      .set({ revokedAt: sql`coalesce(${demoPasses.revokedAt}, now())` })
      .where(and(eq(demoPasses.id, id), eq(demoPasses.workspaceId, workspaceId)))
      .returning({ id: demoPasses.id });
    if (updated.length === 0) return null;
    return this.get(workspaceId, id);
  }

  /**
   * The redeem's lookup (spec section 4, step 2): the pass whose secret hashes
   * to this, and only while EVERY condition still holds: not expired, not
   * revoked, its person still there, still an ACTIVE member of the pass's
   * workspace, the address still a demonstration address, and no second
   * factor enrolled since the mint. One statement for the pass, its person
   * and the membership; null whatever the reason, so the caller has one
   * answer to give.
   */
  async redeemable(secret: string, extraDomains: ReadonlySet<string>): Promise<RedeemablePass | null> {
    const [row] = await this.db
      .select({
        passId: demoPasses.id,
        workspaceId: demoPasses.workspaceId,
        targetPath: demoPasses.targetPath,
        expiresAt: demoPasses.expiresAt,
        userId: userTable.id,
        email: userTable.email,
        name: userTable.name,
        twoFactorEnabled: userTable.twoFactorEnabled
      })
      .from(demoPasses)
      .innerJoin(userTable, eq(userTable.id, demoPasses.userId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, demoPasses.userId),
          eq(workspaceMembers.workspaceId, demoPasses.workspaceId),
          eq(workspaceMembers.isActive, true)
        )
      )
      .where(
        and(
          eq(demoPasses.secretHash, demoPassSecretHash(secret)),
          isNull(demoPasses.revokedAt),
          sql`${demoPasses.expiresAt} > now()`
        )
      )
      .limit(1);
    if (!row) return null;
    if (row.twoFactorEnabled) return null;
    if (!isDemoAddress(row.email, extraDomains)) return null;
    return {
      passId: row.passId,
      workspaceId: row.workspaceId,
      targetPath: row.targetPath,
      expiresAt: row.expiresAt,
      user: { id: row.userId, email: row.email, name: row.name }
    };
  }

  /** Record one use: the session it opened (the audit mark) and the counters, together. */
  async recordUse(passId: string, sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(demoPassSessions).values({ sessionId, passId });
      await tx
        .update(demoPasses)
        .set({ useCount: sql`${demoPasses.useCount} + 1`, lastUsedAt: sql`now()` })
        .where(eq(demoPasses.id, passId));
    });
  }

  /**
   * The pass that opened the session this request presents, or null: the
   * audit middleware's ONE lookup (spec section 6). The session cookie is
   * `<token>.<signature>` (the token is alphanumeric, the signature follows
   * the first dot); the principal was already resolved from this very
   * cookie, so its signature has been checked and the token part is enough to
   * find the session row.
   */
  async passOfRequest(headers: Headers): Promise<string | null> {
    const cookie = getSessionCookie(headers);
    if (!cookie) return null;
    const token = cookie.split('.')[0];
    if (!token) return null;
    const [row] = await this.db
      .select({ passId: demoPassSessions.passId })
      .from(demoPassSessions)
      .innerJoin(sessionTable, eq(sessionTable.id, demoPassSessions.sessionId))
      .where(eq(sessionTable.token, token))
      .limit(1);
    return row?.passId ?? null;
  }
}
