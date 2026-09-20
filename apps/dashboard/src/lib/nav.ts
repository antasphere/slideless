import House from '@lucide/svelte/icons/house';
import Users from '@lucide/svelte/icons/users';
import KeyRound from '@lucide/svelte/icons/key-round';
import Folder from '@lucide/svelte/icons/folder';
import ScrollText from '@lucide/svelte/icons/scroll-text';
import Settings from '@lucide/svelte/icons/settings';
import LayoutGrid from '@lucide/svelte/icons/layout-grid';
import type { Component } from 'svelte';
import type { WorkspaceRole } from '@antasphere/chassis-contract';
import type { MeResponse } from '@slideless/contract';
import { t } from '$lib/i18n';
import { tool } from '$lib/tool';

/**
 * The dashboard's one navigation model (PRDCT-2436). The desk sidebar, the
 * phone tab bar and the workspace page all read it, so a section a person may
 * not open (a guest's roster, a member's audit log) is absent from all three
 * at once and never from one only.
 */
export interface NavItem {
  id: string;
  title: string;
  /** One plain sentence on what the section is for: the workspace page shows it under the title. */
  blurb: string;
  href: string;
  icon: Component;
  /** Extra path prefixes that light this item (a section reached by tabs from it). */
  also?: string[];
  /** The pages the section carries as tabs, when the tool names them: the path in the top bar reads the open one here. */
  tabs?: { href: string; label: string }[];
  /** The drawing the section's tile carries: a key of the brand's pattern library. */
  pattern: string;
}

export interface NavModel {
  /** What a person opens every day. */
  primary: NavItem[];
  /** The administration of the workspace. */
  workspace: NavItem[];
  system: NavItem[];
}

export interface NavFacts {
  role: WorkspaceRole;
  origin?: MeResponse['origin'];
}

export function buildNav({ role, origin = 'local' }: NavFacts): NavModel {
  const isAdmin = role === 'owner' || role === 'admin';
  // A guest is an external per-deck collaborator (D2): the member roster and
  // the generic files surface answer 403 guest_forbidden, so they are not offered.
  const isGuest = origin === 'guest';

  const primary: NavItem[] = [
    {
      id: 'overview',
      title: t('nav.overview'),
      blurb: '',
      href: '/',
      icon: House,
      pattern: 'rings'
    },
    // The product first: what the tool brings comes right after the overview.
    ...tool.nav({ role, origin })
  ];

  const workspace: NavItem[] = [];
  if (!isGuest) {
    workspace.push({
      id: 'members',
      title: t('nav.people'),
      blurb: t('nav.blurb.people'),
      href: '/members',
      icon: Users,
      // Invitations are a tab of the people section, never a section of their own.
      also: ['/invitations'],
      pattern: 'blooms'
    });
  }
  workspace.push({
    id: 'api-keys',
    title: t('nav.apiKeys'),
    blurb: t('nav.blurb.apiKeys'),
    href: '/api-keys',
    icon: KeyRound,
    pattern: 'gears'
  });
  if (!isGuest) {
    workspace.push({
      id: 'files',
      title: t('nav.files'),
      blurb: t('nav.blurb.files'),
      href: '/files',
      icon: Folder,
      pattern: 'panes'
    });
  }

  const system: NavItem[] = [];
  if (isAdmin) {
    system.push({
      id: 'audit',
      title: t('nav.auditLog'),
      blurb: t('nav.blurb.auditLog'),
      href: '/audit',
      icon: ScrollText,
      pattern: 'written'
    });
  }
  system.push({
    id: 'settings',
    title: t('nav.settings'),
    blurb: t('nav.blurb.settings'),
    href: '/settings',
    icon: Settings,
    also: ['/account'],
    pattern: 'weave'
  });

  return { primary, workspace, system };
}

export function isActive(item: Pick<NavItem, 'href' | 'also'>, path: string): boolean {
  if (item.href === '/') return path === '/';
  return [item.href, ...(item.also ?? [])].some((p) => path === p || path.startsWith(p + '/'));
}

/** The everyday sections a phone keeps as tabs; the tool's other sections fold behind the workspace entry. */
const PHONE_TABS = new Set(['overview', ...tool.phoneTabs]);

/** The sections the phone's workspace entry opens: the references, then the administration. */
export function behindWorkspace(nav: NavModel): NavItem[] {
  return [
    ...nav.primary.filter((i) => !PHONE_TABS.has(i.id)),
    ...nav.workspace,
    ...nav.system.filter((i) => i.id !== 'settings')
  ];
}

/**
 * The phone tab bar: the two everyday sections, the workspace behind one
 * entry (the references included: six thumb tabs do not fit the bar), the
 * settings.
 */
export function phoneTabs(nav: NavModel): NavItem[] {
  const settings = nav.system.find((i) => i.id === 'settings');
  const behind = behindWorkspace(nav);
  return [
    ...nav.primary.filter((i) => PHONE_TABS.has(i.id)),
    {
      id: 'workspace',
      title: t('nav.workspace'),
      blurb: '',
      href: '/workspace',
      icon: LayoutGrid,
      also: behind.flatMap((i) => [i.href, ...(i.also ?? [])]),
      pattern: 'crosses'
    },
    ...(settings ? [settings] : [])
  ];
}
