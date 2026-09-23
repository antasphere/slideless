import { eq } from 'drizzle-orm';
import type { ActorRef, EntitlementRequest } from '@antasphere/chassis-contract';
import { workspaces, type Db } from '@antasphere/chassis-db';
import type { DeckDomain } from '../tool.js';

/**
 * The paying actor of an anonymous form surface (PRDCT-2634, the billing
 * rail spec §8): a viewer submits a response or uploads a file through a
 * share link, with no principal; the share secret in the path resolves to
 * the deck, the deck to its owner, the owner's workspace to its account. The
 * owner pays and is reported; the viewer is never identified.
 *
 * Read at REQUEST time through the late-bound domain (the entitlements slot
 * runs before the services exist). Anything that does not resolve, a secret
 * the instance does not know, a revoked or expired link, a deck that is
 * gone, a domain not yet built, or a lookup that throws, answers null: the
 * gate then leaves the route to its own handling (its 404, 403 or 410) and
 * meters nothing, rather than refusing a viewer on a lookup error. A
 * workspace with no central account (oss, a cloud-local workspace) resolves
 * an actor with no `accountRef`: unmetered by construction.
 */
export function formOwnerActor(
  db: Db,
  getTool: () => DeckDomain | null
): (ctx: EntitlementRequest) => Promise<ActorRef | null> {
  return async (ctx) => {
    const secret = ctx.params.secret;
    const domain = getTool();
    if (!secret || !domain) return null;
    try {
      const token = await domain.sharing.resolveBySecret(secret);
      if (!token || token.revokedAt) return null;
      if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null;
      const deck = await domain.presentations.get(token.workspaceId, token.presentationId);
      if (!deck) return null;
      const [ws] = await db
        .select({ centralAccountId: workspaces.centralAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, token.workspaceId))
        .limit(1);
      return {
        userId: deck.ownerUserId,
        workspaceId: token.workspaceId,
        ...(ws?.centralAccountId ? { accountRef: ws.centralAccountId } : {})
      };
    } catch {
      return null;
    }
  };
}
