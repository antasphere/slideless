import type { EntitlementRequest } from '@antasphere/chassis-contract';
import type { DeckDomain } from '../tool.js';

/**
 * The `links.perDeck` count of a share link mint (PRDCT-2702): the deck's
 * share links that are not revoked (previews excluded), plus the one being
 * minted, so the gate's `observed > max` refuses the eleventh on a free
 * workspace and lets the tenth through. Read at request time through the
 * late-bound domain, in the caller's workspace: a deck the caller cannot
 * see counts as that workspace's zero, and the handler's own 404 answers
 * (the count reveals nothing of a foreign deck). No principal, no domain,
 * or a lookup that throws: null, the route answers on its own.
 */
export function linksOfDeck(
  getTool: () => DeckDomain | null
): (ctx: EntitlementRequest) => Promise<number | null> {
  return async (ctx) => {
    const domain = getTool();
    const deckId = ctx.params.id;
    if (!domain || !deckId || !ctx.principal) return null;
    try {
      return (await domain.sharing.countLive(ctx.principal.workspaceId, deckId)) + 1;
    } catch {
      return null;
    }
  };
}
