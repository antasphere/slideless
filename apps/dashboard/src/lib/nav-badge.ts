import { t } from '$lib/i18n';

/**
 * Something new in a section of the menu (NavItem.badge): the tool sets it,
 * the sidebar, the phone tab bar and the workspace tiles draw it
 * (components/shell/NavBadge.svelte). Apart from nav.ts so it is tested
 * without the tool behind the menu.
 */
export interface NavBadge {
  count?: number;
  dot?: boolean;
  tone?: 'default' | 'alert';
  label?: string;
}

/** What a badge draws: a count, a dot or nothing, and the sentence a screen reader hears. */
export function badgeView(badge: NavBadge | undefined): {
  kind: 'count' | 'dot';
  text: string;
  label: string;
  alert: boolean;
} | null {
  if (!badge) return null;
  const alert = badge.tone === 'alert';
  const count = badge.count && badge.count > 0 ? Math.floor(badge.count) : 0;
  if (count > 0)
    return {
      kind: 'count',
      text: count > 99 ? '99+' : String(count),
      label: badge.label ?? t('nav.badge.count', { n: count }),
      alert
    };
  if (badge.dot) return { kind: 'dot', text: '', label: badge.label ?? t('nav.badge.dot'), alert };
  return null;
}
