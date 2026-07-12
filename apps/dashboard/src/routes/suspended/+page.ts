import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * The hub-gate notice page (cloud edition, docs/federation.md P4): a live
 * session whose workspace the hub gate refuses lands here from the app
 * shell. A direct visit while everything is healthy bounces home.
 */
export const load: PageLoad = async ({ parent }) => {
  const { meError } = await parent();
  if (!meError) redirect(307, '/');
  return { meError };
};
