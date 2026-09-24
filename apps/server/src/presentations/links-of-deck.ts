import type { EntitlementRequest } from '@antasphere/chassis-contract';
import type { DeckDomain } from '../tool.js';

/**
 * The `links.perDeck` count of a share link mint (PRDCT-2702): the deck's
 * share links that are not revoked (previews excluded), plus the one being
 * minted, so the gate's `observed > max` refuses the eleventh on a free
 * workspace and lets the tenth through. Read at request time through the
 * late-bound domain, and only for a caller who can WRITE the deck, the
 * handler's own bar for the sharing routes: anyone else gets the handler's
 * 404 (ADR 013: a deck's existence and its link count are not probeable,
 * and a plan refusal must never say more than the handler would). No
 * principal, no domain, or a deck the caller may not write: null, the route
 * answers on its own; a lookup that throws is caught and logged by the gate.
 */
export function linksOfDeck(
  getTool: () => DeckDomain | null
): (ctx: EntitlementRequest) => Promise<number | null> {
  return async (ctx) => {
    const domain = getTool();
    const deckId = ctx.params.id;
    if (!domain || !deckId || !ctx.principal) return null;
    const deck = await domain.presentations.get(ctx.principal.workspaceId, deckId);
    if (!deck || !(await domain.presentations.canWrite(ctx.principal, deck))) return null;
    return (await domain.sharing.countLive(ctx.principal.workspaceId, deckId)) + 1;
  };
}
