import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** Admin+ only — mirrors the API's requireRole('admin') gate. */
export const load: PageLoad = async ({ parent }) => {
  const { me } = await parent();
  if (me.role === 'member') redirect(307, '/');
  return {};
};
