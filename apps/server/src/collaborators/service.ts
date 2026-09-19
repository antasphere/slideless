import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db, DbConn } from '@antasphere/chassis-db';
import { collaborators, type CollaboratorRow } from '@slideless/db';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';

/**
 * Per-deck dev grants (Phase 5). The invitations pattern applied to decks:
 * an email is invited to develop ONE deck; the grant starts `pending` behind
 * a claim token and flips `active` when the invitee claims it — at sign-up
 * through the claim endpoint, at account creation through a workspace
 * invitation (the `user.created` hook), or by opening the claim link while
 * signed in. The database stores only sha256 hashes of the claim tokens.
 *
 * Two tokens per grant, one row (ADR 009 honesty, exactly like invitations):
 * `claimToken` is the copyable link the inviter sees (always in the invite
 * response), `emailClaimToken` appears ONLY inside the invite email — a
 * claim presenting it proves control of the invited mailbox, so that claim
 * path may honestly set `emailVerified`.
 */

/** Pending grants die after 14 days; enforcement is at read/claim time. */
export const COLLABORATOR_CLAIM_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Per-deck cap counting ACTIVE grants + LIVE (unexpired) pending invites. */
export const MAX_LIVE_COLLABORATORS_PER_DECK = 10;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A live pending grant plus which of its two tokens the caller presented. */
export interface CollaboratorClaimMatch {
  grant: CollaboratorRow;
  /** True when the presented token is the one that ONLY the email carried. */
  viaEmailToken: boolean;
}

export class CollaboratorError extends Error {
  constructor(
    public readonly code: 'already_collaborator' | 'already_invited' | 'collaborator_limit',
    message: string
  ) {
    super(message);
  }
}

export class CollaboratorService {
  constructor(private readonly db: Db) {}

  /**
   * Invite an email as a dev collaborator on a deck. Refuses an ACTIVE grant
   * and a live (unexpired) pending one; a revoked or expired-pending row is
   * RE-MINTED in place (fresh tokens, fresh TTL, back to pending/unclaimed —
   * the unique (presentation, email) row is the grant's whole history).
   * Enforces the per-deck cap on live grants.
   */
  async invite(opts: {
    workspaceId: string;
    presentationId: string;
    email: string;
    invitedBy: string;
  }): Promise<{ grant: CollaboratorRow; claimToken: string; emailClaimToken: string }> {
    const email = opts.email.toLowerCase().trim();
    const now = new Date();
    const claimToken = randomBytes(32).toString('base64url');
    const emailClaimToken = randomBytes(32).toString('base64url');
    const freshGrant = {
      status: 'pending' as const,
      userId: null,
      claimTokenHash: hashToken(claimToken),
      claimEmailTokenHash: hashToken(emailClaimToken),
      claimExpiresAt: new Date(now.getTime() + COLLABORATOR_CLAIM_TTL_MS),
      claimedAt: null,
      revokedAt: null,
      invitedBy: opts.invitedBy
    };

    const grant = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(collaborators)
        .where(and(eq(collaborators.presentationId, opts.presentationId), eq(collaborators.email, email)))
        .for('update')
        .limit(1);

      if (existing) {
        if (existing.status === 'active') {
          throw new CollaboratorError('already_collaborator', 'This email is already an active collaborator');
        }
        if (existing.status === 'pending' && this.pendingIsLive(existing, now)) {
          throw new CollaboratorError('already_invited', 'An open invite for this email already exists');
        }
        // Revoked or expired-pending: re-mint in place (cap check still applies
        // — the dead row does not count as live).
        await this.assertUnderCap(tx, opts.presentationId, now);
        const [updated] = await tx
          .update(collaborators)
          .set(freshGrant)
          .where(eq(collaborators.id, existing.id))
          .returning();
        return updated!;
      }

      await this.assertUnderCap(tx, opts.presentationId, now);
      const [inserted] = await tx
        .insert(collaborators)
        .values({
          workspaceId: opts.workspaceId,
          presentationId: opts.presentationId,
          email,
          role: 'dev',
          ...freshGrant
        })
        .returning();
      return inserted!;
    });

    return { grant, claimToken, emailClaimToken };
  }

  private pendingIsLive(row: CollaboratorRow, now: Date): boolean {
    return row.claimExpiresAt !== null && row.claimExpiresAt.getTime() > now.getTime();
  }

  private async assertUnderCap(tx: DbConn, presentationId: string, now: Date): Promise<void> {
    const rows = await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(collaborators)
      .where(
        and(
          eq(collaborators.presentationId, presentationId),
          or(
            eq(collaborators.status, 'active'),
            and(eq(collaborators.status, 'pending'), gt(collaborators.claimExpiresAt, now))
          )
        )
      );
    const live = rows[0]?.live ?? 0;
    if (live >= MAX_LIVE_COLLABORATORS_PER_DECK) {
      throw new CollaboratorError(
        'collaborator_limit',
        `A deck can have at most ${MAX_LIVE_COLLABORATORS_PER_DECK} collaborators (active + pending)`
      );
    }
  }

  /**
   * Find a live (pending, unrevoked, unexpired) grant by raw claim token —
   * either the copyable-link token or the emailed one — and report which.
   *
   * PENDING-ONLY by design: this feeds the PUBLIC lookup (the claim page's
   * pre-auth resolve), and widening it to active grants would leak deck
   * metadata (title, invitee email) to anyone replaying an already-used
   * token. The cross-request G1 residual — a grant swept to active in an
   * EARLIER request (sibling grant at signup; the cloud SSO-first claim
   * page, where JIT login sweeps before the claim POST — binding plan §5)
   * — is resolved on the CLAIM path only, via
   * {@link findActiveByClaimTokenFor}, which is keyed to the owning user's
   * session and therefore leaks nothing.
   */
  async findLiveByClaimToken(token: string): Promise<CollaboratorClaimMatch | null> {
    const hash = hashToken(token);
    const [row] = await this.db
      .select()
      .from(collaborators)
      .where(
        and(
          or(eq(collaborators.claimTokenHash, hash), eq(collaborators.claimEmailTokenHash, hash)),
          eq(collaborators.status, 'pending'),
          isNull(collaborators.revokedAt)
        )
      )
      .limit(1);
    if (!row) return null;
    if (!row.claimExpiresAt || row.claimExpiresAt.getTime() <= Date.now()) return null;
    return { grant: row, viaEmailToken: row.claimEmailTokenHash === hash };
  }

  /**
   * CLAIM-PATH companion to {@link findLiveByClaimToken} (the G1
   * cross-request fix, Phase 6): resolve an ACTIVE, unrevoked grant by raw
   * claim token, but ONLY when the grant is already owned by `userId`. A
   * grant the user.created sweep flipped in an EARLIER request (signup via
   * a workspace invitation with a sibling grant elsewhere; the cloud
   * SSO-first claim flow, where JIT login sweeps before the claim POST)
   * is invisible to the pending-only lookup — without this, that claim
   * answered 404 and the membership that makes the deck reachable was
   * never minted. Keying on the presented session's user id is what makes
   * this safe to expose on the claim endpoint: to anyone but the sweep's
   * own beneficiary the token stays indistinguishable from an invalid one.
   * No expiry check — claimExpiresAt bounds PENDING grants only; an active
   * grant lives until revoked (invariant of the claim/revoke lifecycle).
   */
  async findActiveByClaimTokenFor(token: string, userId: string): Promise<CollaboratorClaimMatch | null> {
    const hash = hashToken(token);
    const [row] = await this.db
      .select()
      .from(collaborators)
      .where(
        and(
          or(eq(collaborators.claimTokenHash, hash), eq(collaborators.claimEmailTokenHash, hash)),
          eq(collaborators.status, 'active'),
          isNull(collaborators.revokedAt),
          eq(collaborators.userId, userId)
        )
      )
      .limit(1);
    if (!row) return null;
    return { grant: row, viaEmailToken: row.claimEmailTokenHash === hash };
  }

  /**
   * Claim a pending grant for a user. Guarded (status must still be pending,
   * unexpired) so a token cannot be redeemed twice by DIFFERENT users;
   * returns the updated row or null when the grant was claimed by someone
   * else, revoked, or expired meanwhile.
   *
   * Idempotent for the SAME user: an ACTIVE grant already owned by `userId`
   * is claim-success, not a replay. Required by construction since the
   * `user.created` database hook (identity/better-auth.ts): the boot sweep
   * (`claimAllPendingForEmail`) fires INSIDE the claim endpoint's own
   * `signUpEmail` and routinely flips the very grant being claimed to
   * active before this method runs — without the idempotent re-read, a
   * brand-new invitee would 410 and never get the membership that makes
   * their deck reachable.
   */
  async claim(grantId: string, userId: string): Promise<CollaboratorRow | null> {
    const [row] = await this.db
      .update(collaborators)
      .set({ status: 'active', userId, claimedAt: sql`now()` })
      .where(
        and(
          eq(collaborators.id, grantId),
          eq(collaborators.status, 'pending'),
          isNull(collaborators.revokedAt),
          sql`${collaborators.claimExpiresAt} > now()`
        )
      )
      .returning();
    if (row) return row;
    // Pending-only update matched nothing: re-read for the idempotent case.
    // If the sweep's UPDATE held the row lock, ours re-evaluated after its
    // commit — the re-read observes the committed truth either way.
    const [current] = await this.db
      .select()
      .from(collaborators)
      .where(eq(collaborators.id, grantId))
      .limit(1);
    if (current && current.status === 'active' && current.userId === userId) return current;
    return null;
  }

  /**
   * Claim-at-signup sweep: activate every live pending grant for an email.
   * Fired when a user account is created (the `user.created` event — the
   * same moment the template redeems workspace invitations) and after an
   * explicit claim, so one claim never leaves sibling grants dangling.
   */
  async claimAllPendingForEmail(email: string, userId: string): Promise<number> {
    const rows = await this.db
      .update(collaborators)
      .set({ status: 'active', userId, claimedAt: sql`now()` })
      .where(
        and(
          eq(collaborators.email, email.toLowerCase().trim()),
          eq(collaborators.status, 'pending'),
          isNull(collaborators.revokedAt),
          sql`${collaborators.claimExpiresAt} > now()`
        )
      )
      .returning({ id: collaborators.id });
    return rows.length;
  }

  /** Soft revoke (idempotent): the grant stops authorizing, the row survives. */
  async revoke(grantId: string): Promise<CollaboratorRow | null> {
    await this.db
      .update(collaborators)
      .set({ status: 'revoked', revokedAt: sql`now()` })
      .where(and(eq(collaborators.id, grantId), sql`${collaborators.revokedAt} IS NULL`));
    const [row] = await this.db.select().from(collaborators).where(eq(collaborators.id, grantId)).limit(1);
    return row ?? null;
  }

  async get(
    workspaceId: string,
    presentationId: string,
    collaboratorId: string
  ): Promise<CollaboratorRow | null> {
    const [row] = await this.db
      .select()
      .from(collaborators)
      .where(
        and(
          eq(collaborators.id, collaboratorId),
          eq(collaborators.presentationId, presentationId),
          eq(collaborators.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  async list(
    workspaceId: string,
    presentationId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<{ collaborators: CollaboratorRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select()
      .from(collaborators)
      .where(
        and(
          eq(collaborators.presentationId, presentationId),
          eq(collaborators.workspaceId, workspaceId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: collaborators,
                  id: collaborators.id,
                  createdAt: collaborators.createdAt,
                  // Scope the cursor subquery to THIS deck (the share-token
                  // precedent): a foreign deck's cursor cannot position here.
                  workspaceId: collaborators.presentationId,
                  cursorId,
                  workspace: presentationId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(collaborators.createdAt), desc(collaborators.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { collaborators: page, nextCursor };
  }
}

/** Wire mapping shared by the API handlers (never a claim token hash). */
export function collaboratorToWire(c: CollaboratorRow): {
  id: string;
  presentationId: string;
  email: string;
  userId: string | null;
  role: 'owner' | 'dev';
  status: 'pending' | 'active' | 'revoked';
  invitedBy: string | null;
  claimedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
} {
  return {
    id: c.id,
    presentationId: c.presentationId,
    email: c.email,
    userId: c.userId,
    role: c.role,
    status: c.status,
    invitedBy: c.invitedBy,
    claimedAt: c.claimedAt?.toISOString() ?? null,
    revokedAt: c.revokedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString()
  };
}
