import { requireMember } from '$lib/member-guard';
import type { LayoutLoad } from './$types';

/**
 * The deck's master page group (PRDCT-2279): the same member guard as the
 * app shell, none of its chrome — the page is the presentation full-page
 * with the artifact bar, on the app origin behind the session cookie.
 */
export const load: LayoutLoad = async ({ parent, url }) => {
  return { me: requireMember(await parent(), url) };
};
