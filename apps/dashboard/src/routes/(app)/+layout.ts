import { requireMember, type MemberMe } from '$lib/member-guard';
import type { LayoutLoad } from './$types';

export type { MemberMe };

/** The app shell requires a set-up instance and a signed-in member (the guard is $lib/member-guard). */
export const load: LayoutLoad = async ({ parent, url }) => {
  return { me: requireMember(await parent(), url) };
};
