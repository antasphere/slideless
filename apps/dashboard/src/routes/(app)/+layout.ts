import { redirect } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

/** The app shell requires a set-up instance and a signed-in member. */
export const load: LayoutLoad = async ({ parent, url }) => {
  const { instance, me } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  if (!me) {
    const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
    redirect(307, `/login${next}`);
  }
  return { me };
};
