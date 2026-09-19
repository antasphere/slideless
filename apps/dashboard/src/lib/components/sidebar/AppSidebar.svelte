<script lang="ts">
  import { page, navigating } from '$app/state';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import NavUser from './NavUser.svelte';
  import { buildNav, isActive as navActive } from '$lib/nav';
  import { t } from '$lib/i18n';
  import BrandTile from './BrandTile.svelte';
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
           bare version drifted from), the workspace's form on its tile. -->
      <div class="flex items-center gap-2.5 px-1.5 py-1.5">
        <BrandTile seedKey={instanceName} label={instanceName} />
        <span class="truncate font-display text-[15px] font-normal tracking-[-0.005em] text-[var(--ink)]">
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
                class="transition-[transform,background-color,width,padding] duration-200 ease-out hover:translate-x-0.5 data-[active=true]:!bg-[var(--accent-soft)] data-[active=true]:!text-foreground group-data-[collapsible=icon]:hover:translate-x-0"
              >
                {#snippet child({ props }: { props: Record<string, unknown> })}
                  <a href={item.href} {...props}>
                    <item.icon
                      class="{navActive(item, currentPath)
                        ? 'text-brand-accent'
                        : 'text-muted-foreground'} transition-transform"
                    />
                    <!-- The word fades out early while the rail is still
                         narrowing, so it is gone before the 32px clip would
                         cut it mid-glyph. The icon never moves: it is the
                         button's first child at a fixed 16px, and the box's
                         padding animates on the rail's own curve. -->
                    <span class="nav-label">{item.title}</span>
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
    <NavUser {user} {role} {workspaceName} />
  </Sidebar.Footer>
</Sidebar.Root>

<style>
  /* the nav word travels with the rail: out fast, in on the rail's curve */
  .nav-label {
    opacity: 1;
    transition: opacity 160ms ease-out 60ms;
  }
  :global([data-collapsible='icon']) .nav-label {
    opacity: 0;
    transition: opacity 90ms ease-in;
  }
  @media (prefers-reduced-motion: reduce) {
    .nav-label {
      transition: none;
    }
  }
</style>
