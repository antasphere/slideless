import type { MeResponse } from '@slideless/contract';
import { demoSignInOn } from '$lib/demo-link';
import { t } from '$lib/i18n';

/** What decides which tabs a person sees: the instance's discovery and their /me. */
export interface SettingsFacts {
  instance: { demoSignIn?: boolean };
  me: Pick<MeResponse, 'role' | 'via'>;
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
 * Settings is one section with three tabs (the settings pass of
 * 2026-09-19): the workspace (its name, its look, its data), the instance
 * (what the operator deployed), and the person's own account; a fourth, the
 * demo links, while `showsDemoLinks` holds. One place says their order, so
 * every tab shows the same bar.
 */
export function settingsTabs(facts: SettingsFacts) {
  return [
    { href: '/settings', label: t('settings.tabWorkspace') },
    { href: '/settings/instance', label: t('settings.tabInstance') },
    ...(showsDemoLinks(facts) ? [{ href: '/settings/demo', label: t('settings.tabDemo') }] : []),
    { href: '/account', label: t('settings.tabAccount') }
  ];
}
