import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * Every member of the workspace, never a guest — the server's own rule for
 * the `/connections` reads (PRDCT-3773). The writes are an owner's or an
 * admin's: the page hides their buttons from a member, the server refuses
 * them. A guest is sent home, the refusal /webhooks gives a member.
 */
export const load: PageLoad = async ({ parent }) => {
  const { me } = await parent();
  if (me.origin === 'guest') redirect(307, '/');
  return {};
};
