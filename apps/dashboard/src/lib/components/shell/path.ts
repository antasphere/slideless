import { isActive, type NavModel } from '$lib/nav';
import type { Crumb } from '$lib/crumbs.svelte';
import { t } from '$lib/i18n';

/**
 * Where a path sits in the navigation model, as crumbs: the section, then the
 * open tab where the section holds sibling pages (`People / Invitations`,
 * `Settings / My account`). A section a person may not open is absent from
 * the model, so it yields no crumb either. What a page knows beyond that (a
 * deck's title) it adds itself through `crumbs.extra`.
 */
export function pathCrumbs(nav: NavModel, path: string): Crumb[] {
  if (path === '/workspace') return [{ label: t('nav.workspace'), href: '/workspace' }];
  const item = [...nav.primary, ...nav.workspace, ...nav.system].find((i) => isActive(i, path));
  if (!item) return [];
  const trail: Crumb[] = [{ label: item.title, href: item.href }];
  const tab = sectionTab(path);
  if (tab && item.also?.length) trail.push({ label: tab, href: path });
  return trail;
}

/** The tab's own name on the pages that are tabs of a section (SectionHero). */
function sectionTab(path: string): string | undefined {
  switch (path) {
    case '/members':
      return t('members.title');
    case '/invitations':
      return t('invitations.title');
    case '/settings':
      return t('settings.tabInstance');
    case '/account':
      return t('settings.tabAccount');
    default:
      return undefined;
  }
}
