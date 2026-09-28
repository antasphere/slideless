import { redirect } from '@sveltejs/kit';
import { showsDemoLinks } from '$lib/settings-tabs';
import type { PageLoad } from './$types';

/**
 * Owner only, from a browser session, while the instance's demo sign-in is
 * on: the three conditions of the server's own routes. Anyone else goes back
 * to the settings.
 */
export const load: PageLoad = async ({ parent }) => {
  const { instance, me } = await parent();
  if (!showsDemoLinks({ instance, me })) redirect(307, '/settings');
  return {};
};
