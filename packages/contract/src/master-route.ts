/**
 * The deck's master page (PRDCT-2279): the owner's full-page view of a deck
 * on the APP origin, where links are minted from. The dashboard mounts the
 * route at this path and the CLI / MCP compose the URL a push hands back
 * (PRDCT-2280), so the path is built in exactly one place — a pure function
 * of the deck id, nothing else. The viewer origin is never involved: the
 * master page is an owner surface behind the session cookie.
 */

/** `/decks/{id}/present` — the master page's path, relative to the app origin. */
export function deckMasterPath(deckId: string): string {
  return `/decks/${encodeURIComponent(deckId)}/present`;
}

/**
 * The master page's absolute URL for an instance base URL (`PUBLIC_BASE_URL`,
 * the CLI's resolved `baseUrl`). Trailing slashes on the base are dropped so
 * `https://x/` and `https://x` compose the same URL.
 */
export function deckMasterUrl(baseUrl: string, deckId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${deckMasterPath(deckId)}`;
}
