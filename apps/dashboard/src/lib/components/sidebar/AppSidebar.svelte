<script lang="ts">
  import { page, navigating } from '$app/state';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import NavUser from './NavUser.svelte';
  import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
  import Presentation from '@lucide/svelte/icons/presentation';
  import Users from '@lucide/svelte/icons/users';
  import Mail from '@lucide/svelte/icons/mail';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Folder from '@lucide/svelte/icons/folder';
  import ScrollText from '@lucide/svelte/icons/scroll-text';
  import Settings from '@lucide/svelte/icons/settings';
  import { t } from '$lib/i18n';
  import LogoTile from '$lib/components/brand/LogoTile.svelte';
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';
  import type { MeResponse, WorkspaceRole } from '@slideless/contract';

  interface Props {
    instanceName: string;
    role: WorkspaceRole;
    user: { name: string; email: string };
    /** All the user's workspaces + the one this session targets (ADR 014). */
    workspaces?: MeResponse['workspaces'];
    activeWorkspaceId?: string;
    /** The caller's membership origin — guests lose the guest-forbidden surfaces (D2). */
    origin?: MeResponse['origin'];
    /** True = the active workspace is a hub projection: membership is managed at the hub (P7). */
    hubOrigin?: boolean;
    /** Hub console origin — the switcher's set-default link-out (null on oss). */
    hubManageUrl?: string | null;
    /** /me's flag: a person who may create a workspace gets the menu with ONE workspace too. */
    canCreateWorkspace?: boolean;
  }

  let {
    instanceName,
    role,
    user,
    workspaces = [],
    activeWorkspaceId = '',
    origin = 'local',
    hubOrigin = false,
    hubManageUrl = null,
    canCreateWorkspace = false
  }: Props = $props();

  // The switcher exists with several memberships, or when the person may create
  // a workspace — otherwise the plain instance-name header stays unchanged.
  const showSwitcher = $derived((workspaces.length > 1 || canCreateWorkspace) && activeWorkspaceId !== '');

  const isAdmin = $derived(role === 'owner' || role === 'admin');
  // A guest is an external per-deck collaborator (D2): the member roster and
  // the generic files surface answer 403 guest_forbidden — don't offer them.
  const isGuest = $derived(origin === 'guest');

  const navGroups = $derived([
    {
      label: t('nav.platform'),
      items: [
        { title: t('nav.overview'), href: '/', icon: LayoutDashboard },
        // The product surface first: decks are what this instance is FOR.
        { title: t('nav.decks'), href: '/decks', icon: Presentation },
        ...(isGuest ? [] : [{ title: t('nav.members'), href: '/members', icon: Users }]),
        // Invitations are pure LOCAL membership management — a hub-origin
        // workspace takes its membership from the hub (P7), so the page
        // has nothing to offer there (the members page carries the link out).
        ...(isAdmin && !hubOrigin ? [{ title: t('nav.invitations'), href: '/invitations', icon: Mail }] : []),
        { title: t('nav.apiKeys'), href: '/api-keys', icon: KeyRound },
        ...(isGuest ? [] : [{ title: t('nav.files'), href: '/files', icon: Folder }])
      ]
    },
    {
      label: t('nav.system'),
      items: [
        ...(isAdmin ? [{ title: t('nav.auditLog'), href: '/audit', icon: ScrollText }] : []),
        { title: t('nav.settings'), href: '/settings', icon: Settings }
      ]
    }
  ]);

  // Use the navigation target as soon as a click starts a navigation, so the
  // selected highlight flips immediately instead of waiting for the page load
  // (the dashboard-template's instant-nav-highlight refinement).
  const currentPath = $derived(navigating.to?.url.pathname ?? page.url.pathname);

  function isActive(href: string): boolean {
    return href === '/' ? currentPath === '/' : currentPath.startsWith(href);
  }
</script>

<Sidebar.Root variant="inset" collapsible="icon">
  <Sidebar.Header>
    {#if showSwitcher}
      <WorkspaceSwitcher {workspaces} {activeWorkspaceId} {hubManageUrl} {canCreateWorkspace} />
    {:else}
      <!-- The identity block: a contained header (the template convention the
           bare version drifted from), the initial on a small brand field. -->
      <div
        class="flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-background/70 px-2 py-2 shadow-sm"
      >
        <LogoTile label={instanceName} />
        <span class="truncate font-display text-[15px] font-normal tracking-[-0.005em]">
          {instanceName}
        </span>
      </div>
    {/if}
  </Sidebar.Header>
  <Sidebar.Content>
    {#each navGroups as group (group.label)}
      <Sidebar.Group>
        <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
        <Sidebar.Menu>
          {#each group.items as item (item.href)}
            <Sidebar.MenuItem>
              <!-- Nav active state, the brand way: an accent-soft wash with
                   the icon in the accent — never a fill. -->
              <Sidebar.MenuButton
                isActive={isActive(item.href)}
                class="transition-[transform,background-color] duration-200 hover:translate-x-0.5 hover:!bg-sidebar-accent/75 hover:!text-sidebar-accent-foreground data-[active=true]:!bg-[var(--accent-soft)] data-[active=true]:!text-foreground"
              >
                {#snippet child({ props }: { props: Record<string, unknown> })}
                  <a href={item.href} {...props}>
                    <item.icon
                      class="{isActive(item.href)
                        ? 'text-brand-accent'
                        : 'text-muted-foreground'} transition-transform"
                    />
                    <span>{item.title}</span>
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.Group>
    {/each}
  </Sidebar.Content>
  <Sidebar.Footer>
    <NavUser {user} />
  </Sidebar.Footer>
</Sidebar.Root>
