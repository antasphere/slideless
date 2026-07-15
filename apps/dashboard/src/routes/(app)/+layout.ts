import { redirect } from '@sveltejs/kit';
import type { MeResponse } from '@slideless/contract';
import type { LayoutLoad } from './$types';

/**
 * Inside the app shell, /me is always the MEMBER shape: an active workspace,
 * a role, an origin. The zero-membership session state (user-scoped
 * federation — `workspaces: [], workspace: null`) never enters here; it is
 * routed to the /no-organization zero state below.
 */
export type MemberMe = MeResponse & {
  workspace: NonNullable<MeResponse['workspace']>;
  role: NonNullable<MeResponse['role']>;
  origin: NonNullable<MeResponse['origin']>;
  activeWorkspaceId: string;
};

/** The app shell requires a set-up instance and a signed-in member. */
export const load: LayoutLoad = async ({ parent, url }) => {
  const { instance, me, meError } = await parent();
  if (instance.setupRequired) redirect(307, '/setup');
  if (!me) {
    // The session is live but the hub gate refuses (hub unreachable beyond
    // the fail-closed window, cloud edition): explain instead of bouncing
    // to login. A dead hub grant (hub_grant_expired) is NOT in this set —
    // it falls through to the login redirect, where "Sign in with
    // Antasphere" is exactly the re-auth that heals it.
    if (meError) redirect(307, '/suspended');
    const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname + url.search)}`;
    redirect(307, `/login${next}`);
  }
  if (!me.workspace || !me.role || !me.origin || !me.activeWorkspaceId) {
    // A live session with ZERO active memberships (the cloud operator
    // before break-glass, a hub user whose last org was removed): the app
    // shell cannot render — hand over to the zero state.
    redirect(307, '/no-organization');
  }
  return { me: me as MemberMe };
};
