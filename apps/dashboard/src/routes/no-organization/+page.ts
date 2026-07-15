import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * The zero-membership zero state (user-scoped federation): a LIVE session
 * whose user belongs to no organization on this instance — the cloud
 * operator before break-glass, a hub user whose last org was removed, a
 * fresh hub account with no orgs yet. /me answers 200 with
 * `workspaces: []`; the (app) shell redirects here instead of bouncing to
 * login (this is NOT "signed out"). A direct visit while the user does
 * hold a workspace bounces home; no session bounces to login.
 */
export const load: PageLoad = async ({ parent }) => {
  const { instance, me } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  if (!me) redirect(307, '/login');
  if (me.workspace) redirect(307, '/');
  return { me };
};
