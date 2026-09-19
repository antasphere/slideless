<script lang="ts">
  /* The workspace at the head of the sidebar, and the panel that opens from
     it, the way the hub's sidebar has it. The trigger sits on the sidebar
     like the person at its foot: the workspace's tile (its form in its
     colour, on its wash), its name in the display voice, the role beneath
     as an eyebrow; nothing on it moves, only the wash changes. The panel
     lists every workspace the person belongs to, one quiet row each with
     hairlines between, the current one held in the selected wash; the last
     row is the new workspace, for a person who may create one. */
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Plus from '@lucide/svelte/icons/plus';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';
  import { switchWorkspace } from '$lib/api';
  import { roleTag } from '$lib/tags';
  import BrandTile from './BrandTile.svelte';
  import CreateWorkspaceDialog from './CreateWorkspaceDialog.svelte';
  import { t } from '$lib/i18n';
  import type { MeResponse } from '@slideless/contract';

  /**
   * Sidebar workspace switcher (ADR 014 / user-scoped federation). Rendered
   * for users with more than one active membership, and for a person with ONE
   * workspace who may create another (`canCreateWorkspace`, PRDCT-2443 /
   * PRDCT-2444): they are the ones who most need the "New workspace" entry.
   * A single-membership user who may NOT create keeps the plain
   * instance-name header. Switching persists the choice (localStorage) and
   * reloads, so every loader and paged store restarts against the new
   * workspace, and the look follows (it is per workspace). Per-entry signals
   * come straight off /me: `hubOrigin` (Antasphere badge), `suspended`
   * (disabled + badge, visible but blocked), `default` (the selector-less
   * default marker). The default org is a HUB-level per-user setting, so the
   * "set as default" action links out to the hub console (hubManageUrl); a
   * local write would be overwritten by the next reconcile pass.
   */
  interface Props {
    workspaces: MeResponse['workspaces'];
    activeWorkspaceId: string;
    /** The hub console origin (P7 link-out); null on oss / local actives. */
    hubManageUrl?: string | null;
    /** /me's flag: the "New workspace" entry exists only while it is true. */
    canCreateWorkspace?: boolean;
  }

  let { workspaces, activeWorkspaceId, hubManageUrl = null, canCreateWorkspace = false }: Props = $props();

  let showCreateDialog = $state(false);

  const sidebar = useSidebar();

  const active = $derived(
    workspaces.find((w) => w.id === activeWorkspaceId) ??
      workspaces[0] ??
      ({ id: '', name: '', role: 'member' } as MeResponse['workspaces'][number])
  );

  function pick(id: string) {
    if (id === activeWorkspaceId) return;
    switchWorkspace(id);
  }
</script>

<Sidebar.Menu class="px-1">
  <Sidebar.MenuItem>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Sidebar.MenuButton
            {...props}
            size="default"
            aria-label={t('workspace.switch')}
            data-testid="workspace-switcher"
            class="trigger !h-auto data-[state=open]:!bg-[var(--accent-soft)] {sidebar.state === 'collapsed'
              ? '!mx-auto !w-9 !justify-center !p-0'
              : '!gap-2.5 !px-1.5 !py-1.5'}"
          >
            <BrandTile workspaceId={active.id} seedKey={active.id || active.name} label={active.name} />
            {#if sidebar.state !== 'collapsed'}
              <!-- SECURITY: a workspace's name is user-authored: text interpolation only. -->
              <span class="grid min-w-0 flex-1 text-left leading-tight">
                <span
                  class="truncate font-display text-[15px] font-normal tracking-[-0.005em] text-[var(--ink)]"
                >
                  {active.name}
                </span>
                <span class="role truncate">{roleTag(active.role).label}</span>
              </span>
              <ChevronsUpDown class="ml-auto !size-3.5 shrink-0 text-[var(--muted)] opacity-70" />
            {/if}
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="w-[var(--bits-dropdown-menu-anchor-width)] min-w-[248px] max-w-[calc(100vw-24px)]"
        side={sidebar.isMobile ? 'bottom' : 'right'}
        align="start"
        sideOffset={sidebar.isMobile ? 6 : 8}
      >
        <DropdownMenu.Label>{t('workspace.menuLabel')}</DropdownMenu.Label>
        {#each workspaces as workspace, i (workspace.id)}
          {@const current = workspace.id === activeWorkspaceId}
          {#if i > 0}<div class="hair"></div>{/if}
          <!-- The current workspace is held in the selected wash and does
               nothing under the hand; every other row is a switch. A
               suspended one stays VISIBLE but is not a switch target
               (visible-but-blocked: the server refuses its requests). -->
          <DropdownMenu.Item
            class="row !gap-2.5 px-2 py-2 {current ? 'current' : ''}"
            closeOnSelect={!current}
            disabled={workspace.suspended}
            aria-current={current ? 'true' : undefined}
            data-testid="workspace-entry"
            onclick={() => pick(workspace.id)}
          >
            <BrandTile workspaceId={workspace.id} seedKey={workspace.id} label={workspace.name} size={26} />
            <span class="grid min-w-0 flex-1 leading-tight">
              <span class="truncate text-[13.5px] font-medium">{workspace.name}</span>
              <span class="role truncate">{roleTag(workspace.role).label}</span>
            </span>
            {#if workspace.hubOrigin}
              <!-- P7: a hub-org projection, managed at Antasphere. Keyed off
                   /me's hubOrigin flag, never edition-sniffing. -->
              <span class="badge" title={t('workspace.hubBadgeTitle')}>{t('workspace.hubBadge')}</span>
            {/if}
            {#if workspace.suspended}
              <span class="badge badge--danger">{t('workspace.suspendedBadge')}</span>
            {/if}
            {#if workspace.default}
              <!-- The selector-less default (a hub-level per-user setting):
                   clients read THIS flag, never the list order. -->
              <span class="badge badge--accent" title={t('workspace.defaultBadgeTitle')}>
                {t('workspace.defaultBadge')}
              </span>
            {/if}
          </DropdownMenu.Item>
        {/each}
        {#if canCreateWorkspace}
          <div class="hair"></div>
          <!-- the one act: a row like the others, a plus on a neutral tile -->
          <DropdownMenu.Item
            class="row !gap-2.5 px-2 py-2"
            data-testid="workspace-create"
            onclick={() => (showCreateDialog = true)}
          >
            <span class="plus"><Plus class="!size-3.5 !text-[var(--muted)]" strokeWidth={1.8} /></span>
            <span class="truncate font-display text-[15px] font-normal tracking-[-0.005em]">
              {t('workspace.create')}
            </span>
          </DropdownMenu.Item>
        {/if}
        {#if hubManageUrl}
          <div class="hair"></div>
          <!-- The default org lives at the hub (per-user setting): change it
               there; a local toggle would be stomped by the next reconcile. -->
          <DropdownMenu.Item
            class="row !gap-2.5 px-2 py-2"
            onclick={() => window.open(hubManageUrl, '_blank', 'noopener,noreferrer')}
          >
            <span class="plus"><ExternalLink class="!size-3.5 !text-[var(--muted)]" strokeWidth={1.8} /></span
            >
            <span class="truncate text-[13.5px]">{t('workspace.setDefaultHub')}</span>
          </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>

{#if canCreateWorkspace}
  <CreateWorkspaceDialog bind:open={showCreateDialog} />
{/if}

<style>
  /* the eyebrow, one size down: it sits under a name in a narrow column */
  .role {
    font-family: var(--second);
    font-weight: 300;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  /* nothing moves: no press scale, no lift, whatever the base button carries */
  :global(.trigger),
  :global(.trigger:active),
  :global(.trigger:hover) {
    transform: none;
    transition-property: background-color, color;
    cursor: pointer;
  }
  /* a row that does something shows the hand (the ui item rests at `default`) */
  :global(.float-item.row) {
    cursor: pointer;
  }
  /* the current workspace: the selected wash, under the pointer as well, and no hand */
  :global(.float-item.current),
  :global(.float-item.current[data-highlighted]) {
    background: var(--accent-soft);
    cursor: default;
  }
  /* hairlines between rows, not boxes */
  .hair {
    height: 1px;
    margin: 1px 8px;
    background: var(--hairline);
  }
  /* the new workspace's tile: a neutral wash, the same size as the rows' tiles */
  .plus {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--plate-strong);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  /* the per-entry signals, small and quiet at the row's end */
  .badge {
    flex: none;
    padding: 0 4px;
    border-radius: 5px;
    border: 1px solid var(--hairline);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .badge--danger {
    border-color: color-mix(in oklab, var(--danger) 45%, transparent);
    color: var(--danger);
  }
  .badge--accent {
    border-color: transparent;
    background: var(--accent-soft);
    color: var(--accent-deep);
  }
</style>
