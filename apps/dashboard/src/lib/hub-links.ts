/**
 * The ONE way the dashboard builds a link to the Antasphere account site
 * (the hub): every "Manage at Antasphere" link goes through `hubLink`, so
 * each carries `return_to`, the page the person left, and the hub can offer
 * the way back. `base` is what `/me` hands over (`hubManageUrl`, or a
 * ready-made hub URL such as `hubNoAccessUrl`); `path` is appended to it
 * with exactly one slash between them. The return target is encoded once.
 */
export function hubLink(base: string, path?: string, returnTo?: string): string {
  let url = base;
  if (path) url = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  if (returnTo) url += `${url.includes('?') ? '&' : '?'}return_to=${encodeURIComponent(returnTo)}`;
  return url;
}

/** The page the person is on, as the hub's `return_to` wants it (no query, no hash). */
export function hereForHub(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  return location.origin + location.pathname;
}

/** `hubLink` with the current page as the return target: what every link-out in the dashboard uses. */
export function hubLinkHere(base: string, path?: string): string {
  return hubLink(base, path, hereForHub());
}
