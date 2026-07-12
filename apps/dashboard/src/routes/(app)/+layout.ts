import { redirect } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

/** The app shell requires a set-up instance and a signed-in member. */
export const load: LayoutLoad = async ({ parent, url }) => {
  const { instance, me, meError } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  if (!me) {
    // The session is live but the hub gate refuses the workspace (suspended
    // org / hub down, cloud edition): explain instead of bouncing to login.
    if (meError) redirect(307, '/suspended');
    const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
    redirect(307, `/login${next}`);
  }
  return { me };
};
