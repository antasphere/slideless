import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** Self-serve reset only exists when a delivering email driver is configured. */
export const load: PageLoad = async ({ parent }) => {
  const { instance } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  if (!instance.auth.passwordReset) redirect(307, '/login');
  return {};
};
