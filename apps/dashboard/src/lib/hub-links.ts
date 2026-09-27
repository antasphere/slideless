/**
 * The ONE way the dashboard builds a link to the Antasphere account site
 * (the hub): every "Manage at Antasphere" link goes through `hubLink`, so
 * each carries `return_to`, the page the person left, and the hub can offer
 * the way back. `base` is what `/me` hands over (`hubManageUrl`, or a
 * ready-made hub URL such as `hubNoAccessUrl`). The return target is encoded
 * once.
 */
export function hubLink(base: string, returnTo?: string): string {
  if (!returnTo) return base;
  return `${base}${base.includes('?') ? '&' : '?'}return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * The page the person is on, as the hub's `return_to` wants it (no query, no
 * hash). The dashboard is a pure SPA (`ssr = false`), so `location` is always
 * there.
 */
export function hereForHub(): string {
  return location.origin + location.pathname;
}

/** `hubLink` with the current page as the return target: what every link-out in the dashboard uses. */
export function hubLinkHere(base: string): string {
  return hubLink(base, hereForHub());
}
