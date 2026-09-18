import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { parseFilters } from '$lib/components/audit/audit-filters';

/**
 * Admin+ only — mirrors the API's requireRole('admin') gate. The filters
 * are the URL's: a filtered view is a link, and this load re-runs on every
 * change of the query string so the page sees them as data.
 */
export const load: PageLoad = async ({ parent, url }) => {
  const { me } = await parent();
  if (me.role === 'member') redirect(307, '/');
  return { filters: parseFilters(url.searchParams) };
};
