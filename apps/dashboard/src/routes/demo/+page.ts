import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * The demo link's landing page (the demo pass spec, section 7). Public: the
 * pass in the fragment is the credential, and a browser already signed in
 * as someone else is signed in again as the pass's person, so no session
 * guard here. Everything happens in the page, client side.
 */
export const load: PageLoad = async ({ parent }) => {
  const { instance } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  return {};
};
