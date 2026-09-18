<script lang="ts">
  import { page, navigating } from '$app/state';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import NavUser from './NavUser.svelte';
  import { buildNav, isActive as navActive } from '$lib/nav';
  import { t } from '$lib/i18n';
  import LogoTile from '$lib/components/brand/LogoTile.svelte';
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';
  import LookPanel from '$lib/components/shell/LookPanel.svelte';
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
    hubManageUrl = null,
    canCreateWorkspace = false
  }: Props = $props();

  // The switcher exists with several memberships, or when the person may create
  // a workspace — otherwise the plain instance-name header stays unchanged.
  const showSwitcher = $derived((workspaces.length > 1 || canCreateWorkspace) && activeWorkspaceId !== '');
  // What the account card says the role is IN: the workspace this session
  // targets, the instance for a single-membership user.
  const workspaceName = $derived(workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? instanceName);

  // One model for the sidebar, the phone tab bar and the workspace page ($lib/nav).
  // Invitations are a tab of the people section, so nothing here depends on
  // whether the workspace is a hub projection any more.
  const nav = $derived(buildNav({ role, origin }));
  const navGroups = $derived([
    { label: '', items: nav.primary },
    { label: t('nav.workspace'), items: nav.workspace },
    { label: t('nav.system'), items: nav.system }
  ]);

  // Use the navigation target as soon as a click starts a navigation, so the
  // selected highlight flips immediately instead of waiting for the page load
  // (the dashboard-template's instant-nav-highlight refinement).
  const currentPath = $derived(navigating.to?.url.pathname ?? page.url.pathname);
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
    {#each navGroups as group, g (g)}
      <Sidebar.Group>
        {#if group.label}<Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>{/if}
        <Sidebar.Menu>
          {#each group.items as item (item.href)}
            <Sidebar.MenuItem>
              <!-- Nav active state, the brand way: an accent-soft wash with
                   the icon in the accent — never a fill. -->
              <Sidebar.MenuButton
                isActive={navActive(item, currentPath)}
                class="transition-[transform,background-color] duration-200 hover:translate-x-0.5 data-[active=true]:!bg-[var(--accent-soft)] data-[active=true]:!text-foreground"
              >
                {#snippet child({ props }: { props: Record<string, unknown> })}
                  <a href={item.href} {...props}>
                    <item.icon
                      class="{navActive(item, currentPath)
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
    <div class="group-data-[collapsible=icon]:hidden"><LookPanel /></div>
    <NavUser {user} {role} {workspaceName} />
  </Sidebar.Footer>
</Sidebar.Root>
