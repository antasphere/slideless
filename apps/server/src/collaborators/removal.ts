import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { user as userTable } from '@antasphere/chassis-db';
import { collaborators } from '@slideless/db';
import type { MembershipRemovalHook } from '@antasphere/chassis-server';

/**
 * Slideless's half of a member's removal (the chassis's `membershipRemoval`
 * slot, PRDCT-2816): every deck invite waiting for the person in that
 * workspace and every deck grant they hold there is revoked, in the removal's
 * own transaction, on both editions.
 *
 * The pending invites are the reason this exists: claiming one switches an
 * inactive membership back on (api/collaborators.ts), so an invite made
 * BEFORE the removal was a door the removed person could open by themselves
 * (the verifier's round 1, F1). The active grants go for the other half of
 * the promise: a person brought back starts with nothing, the decks they
 * could read included, until someone invites them on a deck again.
 *
 * A row is matched by the account (a claimed grant carries it) or by the
 * address (a pending invite carries only that), never across workspaces.
 * Revoked the way `CollaboratorService.revoke` does it: the row survives, it
 * stops authorizing, and a later invite re-mints it in place.
 */
export const endDeckAccessOnRemoval: MembershipRemovalHook = async (tx, removed) => {
  let deckGrants = 0;
  let deckInvites = 0;
  for (const { workspaceId, userId } of removed) {
    const [person] = await tx
      .select({ email: userTable.email })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    const rows = await tx
      .update(collaborators)
      .set({ status: 'revoked', revokedAt: sql`now()` })
      .where(
        and(
          eq(collaborators.workspaceId, workspaceId),
          isNull(collaborators.revokedAt),
          person
            ? or(
                eq(collaborators.userId, userId),
                sql`lower(${collaborators.email}) = lower(${person.email})`
              )
            : eq(collaborators.userId, userId)
        )
      )
      .returning({ claimedAt: collaborators.claimedAt });
    for (const row of rows) {
      if (row.claimedAt) deckGrants += 1;
      else deckInvites += 1;
    }
  }
  return { deckGrants, deckInvites };
};
