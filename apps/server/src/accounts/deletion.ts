import pg from 'pg';
import { and, eq, ne } from 'drizzle-orm';
import { user as userTable, workspaceMembers, type Db } from '@slideless/db';
import type { AuditService } from '../audit/service.js';
import type { Logger } from '../logger.js';

/**
 * Account deletion (GDPR erasure), shared by both delete surfaces: the
 * self-service Better Auth `/delete-user` route (via the boot-wired
 * before/after hooks) and the admin `DELETE /members/{id}` endpoint.
 *
 * Deliberately NO storage dependency: files are WORKSPACE data, not the
 * uploader's personal data — they survive the delete with `created_by`
 * nulled by the FK (migration 0008, ADR 006). Blobs are never touched here.
 *
 * Last-owner race hardening (ADR 006, M9): a zero-active-owner workspace is
 * unrecoverable (setup is one-shot), so the guard is enforced in two layers:
 *
 *  1. A `BEFORE DELETE OR UPDATE` trigger on workspace_members (migration
 *     0009) raises SQLSTATE {@link LAST_OWNER_SQLSTATE} whenever an operation
 *     would drop the workspace's ACTIVE owners to zero — serialized inside
 *     the trigger by a per-workspace `pg_advisory_xact_lock`, so it holds
 *     under ANY concurrency and on any code path. This is the guarantee.
 *  2. A per-workspace session-scoped advisory lock (dedicated `pg.Client`,
 *     mirroring the migration-lock pattern) serializes the HTTP surfaces
 *     around their guard re-check, so the LOSER of a race is rejected at the
 *     guard with a clean `LastOwnerError` (→ 400) instead of tripping the
 *     trigger mid-cascade (→ 500).
 */

/** Deleting this account would leave the workspace without an active owner. */
export class LastOwnerError extends Error {
  constructor() {
    super('The workspace must keep at least one active owner');
    this.name = 'LastOwnerError';
  }
}

/** SQLSTATE raised by the workspace_members last-owner trigger (migration 0009). */
export const LAST_OWNER_SQLSTATE = 'P0409';

/**
 * True when `cause` (or anything on its `cause` chain — drizzle wraps pg's
 * DatabaseError) is the last-owner trigger rejection.
 */
export function isLastOwnerDbError(cause: unknown): boolean {
  for (let err: unknown = cause; err instanceof Error; err = (err as { cause?: unknown }).cause) {
    if ((err as { code?: unknown }).code === LAST_OWNER_SQLSTATE) return true;
  }
  return false;
}

/**
 * Advisory-lock namespace for serializing owner-removing operations
 * (two-int form: classid 7432003, objid = hashtext(workspace id)). Distinct
 * from the migration lock (7432001) and the trigger's own xact lock
 * (7432002) — the session lock is held ACROSS the cascade while the trigger
 * lock is taken INSIDE it, so sharing a key would self-deadlock.
 */
const OWNER_GUARD_LOCK_KEY = 7_432_003;

/**
 * The self-service path parks the lock between Better Auth's before/after
 * hooks; if the cascade dies in between, afterDelete never runs. The
 * watchdog then cuts the dedicated connection (a session lock dies with its
 * session), so a leaked lock can stall owner removals for at most this long.
 */
const LOCK_WATCHDOG_MS = 60_000;

interface OwnerLock {
  client: pg.Client;
  workspaceId: string;
  released: boolean;
  watchdog?: NodeJS.Timeout;
}

/** True when the workspace keeps ≥1 ACTIVE owner besides excludeUserId. */
export async function hasOtherActiveOwner(
  db: Db,
  workspaceId: string,
  excludeUserId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, 'owner'),
        eq(workspaceMembers.isActive, true),
        ne(workspaceMembers.userId, excludeUserId)
      )
    )
    .limit(1);
  return Boolean(row);
}

export class AccountDeletionService {
  /**
   * before/after stash: beforeUserDelete runs with the user row still
   * present (workspace + email are readable); afterUserDelete runs after the
   * FK cascade, when neither is — so the system-actor audit row pops its
   * context from here. In-process by design: both hooks run in the same
   * request on the same replica.
   */
  private readonly stash = new Map<string, { workspaceId: string; email: string }>();

  /** Locks parked across Better Auth's cascade (beforeUserDelete → afterUserDelete). */
  private readonly heldLocks = new Map<string, OwnerLock>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    /** Dedicated advisory-lock connections (mirrors packages/db migrate.ts). */
    private readonly connectionString: string
  ) {}

  /**
   * Throws LastOwnerError when the user is the workspace's last ACTIVE
   * owner. Unlocked fast-path check — the race-free enforcement is
   * withLastOwnerGuard + the migration-0009 trigger.
   */
  async assertDeletable(userId: string): Promise<void> {
    const membership = await this.membershipOf(userId);
    if (!membership) return; // orphaned user (lost setup race) — nothing to protect
    if (
      membership.role === 'owner' &&
      membership.isActive &&
      !(await hasOtherActiveOwner(this.db, membership.workspaceId, userId))
    ) {
      throw new LastOwnerError();
    }
  }

  /**
   * Serialize an owner-removing operation and enforce the last-owner rule
   * race-free: the per-workspace advisory lock makes the guard re-check see
   * every previously committed removal (the loser of a race rejects with
   * LastOwnerError → 400), and the migration-0009 trigger — surfaced here as
   * LastOwnerError too — backstops anything that slips past. The lock is
   * released on EVERY path (finally).
   */
  async withLastOwnerGuard<T>(workspaceId: string, excludeUserId: string, op: () => Promise<T>): Promise<T> {
    const lock = await this.acquireOwnerLock(workspaceId);
    try {
      if (!(await hasOtherActiveOwner(this.db, workspaceId, excludeUserId))) {
        throw new LastOwnerError();
      }
      return await op();
    } catch (cause) {
      if (isLastOwnerDbError(cause)) throw new LastOwnerError();
      throw cause;
    } finally {
      await this.releaseOwnerLock(lock);
    }
  }

  /**
   * Guard + stash. Runs while the user row still exists. For an ACTIVE OWNER
   * the guard re-check runs under the workspace lock, and the lock is parked
   * across Better Auth's cascade (released by afterUserDelete, or by the
   * watchdog if the cascade dies in between) — so of two concurrent
   * last-owner self-deletes, the loser blocks here until the winner's
   * cascade commits, re-checks, and rejects with a clean LastOwnerError.
   */
  async beforeUserDelete(userId: string): Promise<void> {
    const membership = await this.membershipOf(userId);
    if (!membership) return; // no workspace to guard or audit against
    if (membership.role === 'owner' && membership.isActive) {
      const lock = await this.acquireOwnerLock(membership.workspaceId);
      let parked = false;
      try {
        if (!(await hasOtherActiveOwner(this.db, membership.workspaceId, userId))) {
          throw new LastOwnerError();
        }
        this.parkLock(userId, lock);
        parked = true;
      } finally {
        if (!parked) await this.releaseOwnerLock(lock);
      }
    }
    const [u] = await this.db
      .select({ email: userTable.email })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    this.stash.set(userId, { workspaceId: membership.workspaceId, email: u?.email ?? '' });
  }

  /** Pop the stash and record the system-actor completion row (FK-safe: the user is gone). */
  async afterUserDelete(user: { id: string; email: string }): Promise<void> {
    const lock = this.heldLocks.get(user.id);
    if (lock) {
      this.heldLocks.delete(user.id);
      await this.releaseOwnerLock(lock);
    }
    const stashed = this.stash.get(user.id);
    this.stash.delete(user.id);
    if (!stashed) {
      this.logger.warn({ userId: user.id }, 'account delete completed without a stashed context');
      return;
    }
    await this.audit.write({
      workspaceId: stashed.workspaceId,
      principal: null, // → actorVia 'system'
      action: 'user.account_delete',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { deletedUserId: user.id, email: stashed.email || user.email }
    });
  }

  /**
   * Session-scoped pg_advisory_lock on a dedicated client — never the pool:
   * a session lock parked on a pooled connection would poison the pool.
   */
  private async acquireOwnerLock(workspaceId: string): Promise<OwnerLock> {
    const client = new pg.Client({ connectionString: this.connectionString });
    await client.connect();
    const lock: OwnerLock = { client, workspaceId, released: false };
    try {
      await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [OWNER_GUARD_LOCK_KEY, workspaceId]);
    } catch (cause) {
      await this.releaseOwnerLock(lock);
      throw cause;
    }
    return lock;
  }

  /** Idempotent; closing the client guarantees the session lock dies with it. */
  private async releaseOwnerLock(lock: OwnerLock): Promise<void> {
    if (lock.released) return;
    lock.released = true;
    if (lock.watchdog) clearTimeout(lock.watchdog);
    try {
      await lock.client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [
        OWNER_GUARD_LOCK_KEY,
        lock.workspaceId
      ]);
    } catch {
      // client.end() below still drops the session-scoped lock
    }
    await lock.client.end().catch(() => {});
  }

  /** Park the lock across the cascade, watchdogged against a hook-gap leak. */
  private parkLock(userId: string, lock: OwnerLock): void {
    lock.watchdog = setTimeout(() => {
      this.heldLocks.delete(userId);
      this.logger.warn(
        { userId, workspaceId: lock.workspaceId },
        'owner-delete lock watchdog fired — a delete died between the hooks; releasing the lock'
      );
      void this.releaseOwnerLock(lock);
    }, LOCK_WATCHDOG_MS);
    lock.watchdog.unref();
    this.heldLocks.set(userId, lock);
  }

  private async membershipOf(
    userId: string
  ): Promise<{ workspaceId: string; role: string; isActive: boolean } | null> {
    const [row] = await this.db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        isActive: workspaceMembers.isActive
      })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);
    return row ?? null;
  }
}
