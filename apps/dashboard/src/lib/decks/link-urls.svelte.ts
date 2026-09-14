/**
 * The share URLs this page has SEEN (PRDCT-2308). A link's secret is hashed
 * at rest and its URL exists exactly once, in the create response, so the
 * only place a links row can copy or open it from is this memory. Memory
 * ONLY, never storage: a share secret in sessionStorage would outlive the
 * page and be readable by any script on the origin, and the product's
 * posture is that the URL is never retrievable later. It dies with the page
 * load; a row created before it has no URL to give and says so.
 */
const urls = $state<Record<string, string>>({});

/** Remember a link's URL right after its creation (the create dialog). */
export function rememberLinkUrl(tokenId: string, url: string): void {
  urls[tokenId] = url;
}

/** The URL of a link created in this page session, or null. Reactive. */
export function linkUrl(tokenId: string): string | null {
  return urls[tokenId] ?? null;
}
