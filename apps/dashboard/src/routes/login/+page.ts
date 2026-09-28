import { redirect } from '@sveltejs/kit';
import { isReloginLanding } from '$lib/sso';
import { safeNext } from '$lib/utils';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, url }) => {
  const { instance, me } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  // A relogin landing (cloud): the account site's session was just replaced
  // by a demo link for another person, so a signed-in visitor here is not
  // that person any more. The page ends the tool's own session and signs in
  // again through the hub; every other signed-in visitor goes on to `next`.
  const relogin = isReloginLanding(url.searchParams, instance.auth.sso);
  if (me && !relogin) {
    redirect(307, safeNext(url.searchParams.get('next')));
  }
  return { relogin: Boolean(me) && relogin };
};
