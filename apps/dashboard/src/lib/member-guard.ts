import { redirect } from '@sveltejs/kit';
import type { MeResponse } from '@slideless/contract';
import type { HubGateError } from '../routes/+layout';

/**
 * Inside a signed-in surface, /me is always the MEMBER shape: an active
 * workspace, a role, an origin. The zero-membership session state
 * (user-scoped federation — `workspaces: [], workspace: null`) never enters;
 * it is routed to the /no-organization zero state below.
 */
export type MemberMe = MeResponse & {
  workspace: NonNullable<MeResponse['workspace']>;
  role: NonNullable<MeResponse['role']>;
  origin: NonNullable<MeResponse['origin']>;
  activeWorkspaceId: string;
};

/**
 * The one member guard, shared by the app shell (`(app)`) and the deck's
 * master page (`(present)`, PRDCT-2279): a set-up instance and a signed-in
 * member, or the matching redirect. Two route groups, one rule — the master
 * page renders without the shell's sidebar, never without its guard.
 */
export function requireMember(
  parentData: { instance: { setupRequired: boolean }; me: MeResponse | null; meError: HubGateError | null },
  url: URL
): MemberMe {
  const { instance, me, meError } = parentData;
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
  return me as MemberMe;
}
