import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * Consent requires a signed-in user; the signed authorize query must survive
 * the login round-trip VERBATIM, so it rides the `next` param untouched.
 */
export const load: PageLoad = async ({ parent, url }) => {
  const { instance, me } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  if (!me) redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  return {};
};
