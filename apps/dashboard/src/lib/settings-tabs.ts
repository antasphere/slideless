import type { MeResponse } from '@slideless/contract';
import { demoSignInOn } from '$lib/demo-link';
import { t } from '$lib/i18n';
import { tool } from '$lib/tool';

/** What decides which tabs a person sees: the instance's discovery and their /me. */
export interface SettingsFacts {
  instance: { demoSignIn?: boolean };
  me: Pick<MeResponse, 'role' | 'via'> & { origin?: MeResponse['origin'] };
}

/**
 * The demo links tab (the demo pass spec, section 7): only while the
 * instance's demo sign-in is on, only to an owner, and only in a browser
 * session, the three conditions the server's own routes hold. The page's
 * guard (`routes/(app)/settings/demo/+page.ts`) asks the same question.
 */
export function showsDemoLinks({ instance, me }: SettingsFacts): boolean {
  return demoSignInOn(instance) && me.role === 'owner' && me.via === 'session';
}

/**
 * Settings is one section with tabs (the settings pass of 2026-09-19, then
 * the workspace's administration folded in on 2026-10-01): the people, the
 * API keys, the webhooks for an owner or an admin (PRDCT-3484), the
 * connections for every member but a guest (PRDCT-3773), the files,
 * the audit log for an owner or an admin, the instance
 * (what the operator deployed), the demo links while `showsDemoLinks` holds,
 * the person's own account, and the workspace's own settings at the bar's
 * right end. One place says their order, so every tab shows the same bar.
 */
export function settingsTabs(facts: SettingsFacts, path?: string) {
  // a guest (an outsider granted one object) is refused the roster and the files: not offered
  const guest = facts.me.origin === 'guest';
  const admin = facts.me.role === 'owner' || facts.me.role === 'admin';
  return [
    ...(guest
      ? []
      : [
          {
            href: '/members',
            label: t('nav.people'),
            // lit on its three pages (members, teams, invitations), not on /members alone
            ...(path && /^\/(members|teams|invitations)(\/|$)/.test(path) ? { on: true } : {})
          }
        ]),
    { href: '/api-keys', label: t('nav.apiKeys') },
    // a standing read of the workspace to a URL: an owner's or an admin's, never a guest's (the server's rule)
    ...(admin && !guest ? [{ href: '/webhooks', label: t('nav.webhooks') }] : []),
    // what the workspace hears from and the keys it holds: every member reads, an owner or an admin acts (PRDCT-3773)
    ...(guest ? [] : [{ href: '/connections', label: t('nav.connections') }]),
    ...(guest ? [] : [{ href: '/files', label: t('nav.files') }]),
    // the tool's own settings (a connection, an integration), between the workspace's and the instance's
    ...(guest ? [] : (tool.settingsTabs?.() ?? [])),
    ...(admin ? [{ href: '/audit', label: t('nav.auditLog') }] : []),
    { href: '/settings/instance', label: t('settings.tabInstance') },
    ...(showsDemoLinks(facts) ? [{ href: '/settings/demo', label: t('settings.tabDemo') }] : []),
    { href: '/account', label: t('settings.tabAccount') },
    { href: '/settings', label: t('nav.settings'), end: true }
  ];
}
