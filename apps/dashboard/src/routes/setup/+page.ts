import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
  const { instance, me } = await parent();
  // Second visit: setup is done — this page no longer exists.
  if (!instance.setupRequired) redirect(307, me ? '/' : '/login');
  return {};
};
