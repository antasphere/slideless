import House from '@lucide/svelte/icons/house';
import Users from '@lucide/svelte/icons/users';
import KeyRound from '@lucide/svelte/icons/key-round';
import Webhook from '@lucide/svelte/icons/webhook';
import Plug from '@lucide/svelte/icons/plug';
import Folder from '@lucide/svelte/icons/folder';
import ScrollText from '@lucide/svelte/icons/scroll-text';
import Settings from '@lucide/svelte/icons/settings';
import FolderKanban from '@lucide/svelte/icons/folder-kanban';
import type { Component } from 'svelte';
import type { WorkspaceRole } from '@antasphere/chassis-contract';
import type { MeResponse } from '@slideless/contract';
import type { NavBadge } from '$lib/nav-badge';
import { t } from '$lib/i18n';
import { tool } from '$lib/tool';

export { badgeView, type NavBadge } from '$lib/nav-badge';

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
  /**
   * The category the rail lists the section under (a label over its run of entries): the
   * tool's everyday sections name theirs, the shell's Projects and Settings sit under the
   * workspace's. An entry without one (the overview) stays at the top, unlabelled. Groups
   * are drawn in the order they are first met.
   */
  group?: string;
  /**
   * What the rail unfolds under the entry when it is opened (a chevron beside the entry):
   * a component the tool gives, rendered as the entry's sub-menu. The entry stays a link.
   */
  fold?: Component<{ item: NavItem }>;
  /**
   * Something new in the section (a count, a dot), set by the tool and drawn by the
   * sidebar, the phone tab bar and the workspace tiles (components/shell/NavBadge.svelte).
   */
  badge?: NavBadge;
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
  // A guest is an external person granted one object of the tool (D2): the member roster and
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
    ...tool.nav({ role, origin }),
    // Projects are the shell's (PRDCT-2582): every tool gets them. A guest is
    // an outsider invited on one resource and can never be a project's member.
    ...(isGuest
      ? []
      : [
          {
            id: 'projects',
            title: t('nav.projects'),
            blurb: t('nav.blurb.projects'),
            href: '/projects',
            icon: FolderKanban,
            pattern: 'truss',
            group: t('nav.workspace')
          }
        ]),
    ...tool.navAfter({ role, origin })
  ];

  // The workspace's administration (People, API keys, Files) is always a set of Settings tabs; the
  // rail shows it too as the tool says (`workspaceNav`): `admins` keeps it for owners and admins,
  // `none` drops it, the System group with it, and Settings closes the everyday sections.
  const railWorkspace = tool.workspaceNav ?? 'everyone';
  const showWorkspace = railWorkspace === 'everyone' || (railWorkspace === 'admins' && isAdmin);
  const showSystem = railWorkspace !== 'none';

  const workspace: NavItem[] = [];
  if (showWorkspace && !isGuest) {
    workspace.push({
      id: 'members',
      title: t('nav.people'),
      blurb: t('nav.blurb.people'),
      href: '/members',
      icon: Users,
      // Invitations and teams are tabs of the people section, never sections of their own.
      also: ['/invitations', '/teams'],
      pattern: 'blooms'
    });
  }
  if (showWorkspace)
    workspace.push({
      id: 'api-keys',
      title: t('nav.apiKeys'),
      blurb: t('nav.blurb.apiKeys'),
      href: '/api-keys',
      icon: KeyRound,
      pattern: 'gears'
    });
  // The webhooks (PRDCT-3484): a standing read of the workspace to a URL, an owner's or an admin's.
  if (showWorkspace && isAdmin && !isGuest) {
    workspace.push({
      id: 'webhooks',
      title: t('nav.webhooks'),
      blurb: t('nav.blurb.webhooks'),
      href: '/webhooks',
      icon: Webhook,
      pattern: 'sonar'
    });
  }
  // The connections (PRDCT-3773): what the workspace hears from and the keys it holds; every member reads them.
  if (showWorkspace && !isGuest) {
    workspace.push({
      id: 'connections',
      title: t('nav.connections'),
      blurb: t('nav.blurb.connections'),
      href: '/connections',
      icon: Plug,
      pattern: 'stagger'
    });
  }
  if (showWorkspace && !isGuest) {
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
  if (showSystem && isAdmin) {
    system.push({
      id: 'audit',
      title: t('nav.auditLog'),
      blurb: t('nav.blurb.auditLog'),
      href: '/audit',
      icon: ScrollText,
      pattern: 'written'
    });
  }
  const settings: NavItem = {
    id: 'settings',
    title: t('nav.settings'),
    blurb: t('nav.blurb.settings'),
    href: '/settings',
    icon: Settings,
    // the workspace's pages (and the audit log) light Settings only when the rail does not list them
    also: [
      '/account',
      ...(tool.settingsTabs?.().map((tab) => tab.href) ?? []),
      ...(showWorkspace
        ? []
        : ['/members', '/invitations', '/teams', '/api-keys', '/webhooks', '/connections', '/files']),
      ...(showSystem ? [] : ['/audit'])
    ],
    pattern: 'weave'
  };
  if (showSystem) system.push(settings);
  else primary.push({ ...settings, group: t('nav.workspace') });

  return { primary, workspace, system };
}

export function isActive(item: Pick<NavItem, 'href' | 'also'>, path: string): boolean {
  if (item.href === '/') return path === '/';
  return [item.href, ...(item.also ?? [])].some((p) => path === p || path.startsWith(p + '/'));
}

/** How many of the tool's sections a phone keeps as thumbs beside the overview: four thumbs and the Menu fill the bar. */
export const PHONE_TOOL_TABS_MAX = 3;

/** The everyday sections a phone keeps as thumbs: the overview, then the tool's own, at most three. */
const PHONE_TABS = new Set(['overview', ...tool.phoneTabs.slice(0, PHONE_TOOL_TABS_MAX)]);

/** The sections the phone's tab bar has no room for, as the workspace page lists them: the rest of the rail, then the administration. */
export function behindWorkspace(nav: NavModel): NavItem[] {
  return [...nav.primary.filter((i) => !PHONE_TABS.has(i.id)), ...nav.workspace, ...nav.system];
}

/**
 * The phone tab bar: the overview and the tool's thumbs, in the rail's order, four at most;
 * the bar itself adds the Menu thumb (PhoneTabBar), which opens the whole rail as a drawer.
 */
export function phoneTabs(nav: NavModel): NavItem[] {
  return nav.primary.filter((i) => PHONE_TABS.has(i.id));
}
