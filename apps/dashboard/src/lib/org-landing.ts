/**
 * The organization a person arrives in (PRDCT-3321). A tool card on the
 * Antasphere hub opens the tool as `<launch url>?org=<hub organization
 * id>`: the organization selected on the hub, so the tool opens in the one
 * the person was looking at, not in the one this browser last used here.
 *
 * The value is a SELECTOR, never an authority: the root layout sends it as
 * the workspace header of its bootstrap read, where the server resolves a
 * hub organization id against the caller's OWN active memberships
 * (PRDCT-2947) and fails closed on anything else. A landing that resolves
 * is remembered like a switch in the sidebar; one that does not is
 * dropped, and the bootstrap goes on with the stored selection. Only a
 * value shaped like a uuid is read at all, so a garbage query never buys a
 * server round-trip.
 */
export const ORG_LANDING_PARAM = 'org';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The landing's organization id when the query carries a well-formed one, else null. */
export function readOrgLanding(params: Pick<URLSearchParams, 'get'>): string | null {
  const value = params.get(ORG_LANDING_PARAM);
  return value && UUID_RE.test(value) ? value : null;
}

/**
 * The same address without the landing parameter: path, the other query
 * parameters in their order, the fragment. What the address bar shows once
 * the landing has been applied, and what the return-to-origin memory keeps
 * (the landing rides the sign-in's own callback, never the memory).
 */
export function withoutOrgLanding(path: string): string {
  let url: URL;
  try {
    url = new URL(path, 'http://landing.invalid');
  } catch {
    return path;
  }
  if (!url.searchParams.has(ORG_LANDING_PARAM)) return path;
  url.searchParams.delete(ORG_LANDING_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
