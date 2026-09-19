import { t } from '$lib/i18n';

/**
 * Settings is one section with three tabs (the settings pass of
 * 2026-09-19): the workspace (its name, its look, its data), the instance
 * (what the operator deployed), and the person's own account. One place
 * says their order, so every tab shows the same bar.
 */
export function settingsTabs() {
  return [
    { href: '/settings', label: t('settings.tabWorkspace') },
    { href: '/settings/instance', label: t('settings.tabInstance') },
    { href: '/account', label: t('settings.tabAccount') }
  ];
}
