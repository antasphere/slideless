<script lang="ts">
  import { page, navigating } from '$app/state';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import NavUser from './NavUser.svelte';
  import DocsCard from './DocsCard.svelte';
  import NavBadge from '$lib/components/shell/NavBadge.svelte';
  import { buildNav, type NavItem, isActive as navActive } from '$lib/nav';
  import { reveal } from '$lib/components/ui/reveal/index.js';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { t } from '$lib/i18n';
  import BrandTile from './BrandTile.svelte';
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';
  import type { WorkspaceRole } from '@antasphere/chassis-contract';
  import type { MeResponse } from '@slideless/contract';

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
  // The everyday sections under their categories (NavItem.group), each drawn where it is first
  // met, the unlabelled ones (the overview) first; then the administration groups, when a tool
  // keeps them on the rail. A group with nothing in it draws no heading.
  const navGroups = $derived.by(() => {
    const groups: { label: string; items: NavItem[] }[] = [];
    for (const item of nav.primary) {
      const label = item.group ?? '';
      let group = groups.find((g) => g.label === label);
      if (!group) {
        group = { label, items: [] };
        if (label === '') groups.unshift(group);
        else groups.push(group);
      }
      group.items.push(item);
    }
    return [
      ...groups,
      { label: t('nav.workspace'), items: nav.workspace },
      { label: t('nav.system'), items: nav.system }
    ].filter((g) => g.items.length > 0);
  });

  // Use the navigation target as soon as a click starts a navigation, so the
  // selected highlight flips immediately instead of waiting for the page load
  // (the dashboard-template's instant-nav-highlight refinement).
  const currentPath = $derived(navigating.to?.url.pathname ?? page.url.pathname);

  // An entry with a fold (NavItem.fold) opens under its chevron; it opens by itself while its
  // own page is on screen, and stays as the hand left it after that.
  let folds = $state<Record<string, boolean>>({});
  const foldOpen = (item: NavItem) => folds[item.id] ?? navActive(item, currentPath);
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
                    <span class="nav-label min-w-0 truncate">{item.title}</span>
                    <NavBadge badge={item.badge} class="nav-item-badge ml-auto" />
                  </a>
                {/snippet}
              </Sidebar.MenuButton>
              {#if item.fold}
                <Sidebar.MenuAction
                  aria-expanded={foldOpen(item)}
                  aria-label={item.title}
                  onclick={() => (folds[item.id] = !foldOpen(item))}
                  class="fold-toggle"
                  data-open={foldOpen(item) ? '' : undefined}
                >
                  <ChevronDown />
                </Sidebar.MenuAction>
                {#if foldOpen(item)}
                  <!-- once unfolded, the rows come into view: the rail scrolls to them when they
                       land below its visible height -->
                  <div
                    class="fold"
                    transition:reveal={{ scale: 1.6 }}
                    onintroend={(e) =>
                      (e.currentTarget as HTMLElement).scrollIntoView({
                        block: 'end',
                        behavior: 'smooth'
                      })}
                  >
                    <item.fold {item} />
                  </div>
                {/if}
              {/if}
            </Sidebar.MenuItem>
          {/each}
        </Sidebar.Menu>
      </Sidebar.Group>
    {/each}
    <!-- the docs card rides inside the rail's scrolling area, after the last category, so an
         open fold can never push an entry under it: on a tall rail it sits at the foot (the
         margin takes the room), on a short one it scrolls with the entries -->
    <div class="mt-auto pl-1 pb-1">
      <DocsCard />
    </div>
  </Sidebar.Content>
  <Sidebar.Footer>
    <NavUser {user} {role} {workspaceName} />
  </Sidebar.Footer>
</Sidebar.Root>

<style>
  /* the chevron turns as the fold opens; the fold itself is gone on the icon rail */
  :global(.fold-toggle svg) {
    transition: transform var(--motion-duration) var(--motion-ease);
  }
  :global(.fold-toggle[data-open] svg) {
    transform: rotate(180deg);
  }
  :global([data-collapsible='icon']) .fold {
    display: none;
  }
  /* the nav word travels with the rail: out fast, in on the rail's curve */
  .nav-label {
    opacity: 1;
    transition: opacity 160ms ease-out 60ms;
  }
  :global([data-collapsible='icon']) .nav-label {
    opacity: 0;
    transition: opacity 90ms ease-in;
  }
  /* on the icon rail the badge sits on the icon's corner, as a dot */
  :global([data-collapsible='icon'] [data-sidebar='menu-button']) {
    position: relative;
  }
  :global([data-collapsible='icon'] [data-sidebar='menu-button'] .nav-item-badge) {
    position: absolute;
    top: 3px;
    right: 3px;
    min-width: 8px;
    width: 8px;
    height: 8px;
    padding: 0;
    font-size: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .nav-label {
      transition: none;
    }
  }
</style>
