import type { WorkspaceRole } from '@antasphere/chassis-contract';
import { t } from '$lib/i18n';

/** What the tab list reads off `/me`: the caller's role and origin, and whether the workspace is the hub's. */
export interface PeopleTabsFacts {
  role: WorkspaceRole;
  origin?: 'local' | 'hub' | 'guest' | null;
  workspace: { hubOrigin: boolean };
}

export interface PeopleTab {
  href: string;
  label: string;
  on?: boolean;
}

/**
 * People is one section with up to three tabs (PRDCT-2436, PRDCT-2813): the
 * members, the teams they form, and the invitations on their way. One place
 * says which and in which order, so the three pages show the same bar.
 *  - Members: always (a guest never reaches the section: the nav leaves it out).
 *  - Teams: every member who is not a guest, on both editions (in a hub-origin
 *    workspace the page is read-only, the account site owns the teams).
 *  - Invitations: owners and admins of a workspace whose membership is managed
 *    here, never a hub-origin one (P7).
 * `path` is the open page's path: a team's own page (/teams/<id>) lights the
 * Teams tab, which an exact path match would not.
 */
export function peopleTabs(me: PeopleTabsFacts, path?: string): PeopleTab[] {
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const isGuest = me.origin === 'guest';
  const onTeam = path !== undefined && path.startsWith('/teams/');
  return [
    { href: '/members', label: t('members.title') },
    ...(isGuest ? [] : [{ href: '/teams', label: t('teams.title'), ...(onTeam ? { on: true } : {}) }]),
    ...(isAdmin && !me.workspace.hubOrigin ? [{ href: '/invitations', label: t('invitations.title') }] : [])
  ];
}
