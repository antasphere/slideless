import { redirect } from '@sveltejs/kit';
import { safeNext } from '$lib/utils';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, url }) => {
  const { instance, me } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  if (me) {
    redirect(307, safeNext(url.searchParams.get('next')));
  }
  return {};
};
