import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * Owner or admin only, never a guest — the server's own rule for the whole
 * `/webhooks` family (a webhook is a standing read of the workspace to a URL).
 * Anyone else is sent home, the refusal /audit gives a member.
 */
export const load: PageLoad = async ({ parent }) => {
  const { me } = await parent();
  if ((me.role !== 'owner' && me.role !== 'admin') || me.origin === 'guest') redirect(307, '/');
  return {};
};
