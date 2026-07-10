import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** Landing page for emailed reset links — reachable even when the feature is off. */
export const load: PageLoad = async ({ parent }) => {
  const { instance } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  return {};
};
