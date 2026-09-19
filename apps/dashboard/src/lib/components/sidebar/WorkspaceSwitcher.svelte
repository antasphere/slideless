<script lang="ts">
  /* The workspace at the head of the sidebar, and the panel that opens from
     it, the way the hub's sidebar has it. The trigger sits on the sidebar
     like the person at its foot: the workspace's tile (its form in its
     colour, on its wash), its name in the display voice, the role beneath
     as an eyebrow; nothing on it moves, only the wash changes. The panel
     lists every workspace the person belongs to, one quiet row each with
     hairlines between, the current one held in the selected wash; a click
     on a row switches, a rest on it opens its quick actions to the right
     (open, its settings, the default). Each row wears its OWN workspace's
     colour — the wash under the hand is the colour of the workspace being
     pointed at, not of the one currently open. The last row is the new
     workspace, for a person who may create one. */
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Settings from '@lucide/svelte/icons/settings';
  import Star from '@lucide/svelte/icons/star';
  import Plus from '@lucide/svelte/icons/plus';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';
  import { switchWorkspace } from '$lib/api';
  import { accentOf, look, resolveLook } from '$lib/look.svelte';
  import { theme } from '$lib/theme.svelte';
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
   * "make default" action links out to the hub console (hubManageUrl); a
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

  /**
   * A row's own accent, as inline slots. The panel's rows are washed by the
   * shell's `--accent-soft`/`--wash`, which belong to the ACTIVE workspace —
   * so every row rested on answered in the current workspace's colour. Each
   * row overrides the two slots with its OWN look, the same resolution
   * BrandTile uses (the active workspace reads the live look store, so a try
   * on the settings page moves the row and its tile together; another
   * workspace reads what /me carries for it), and the wash under the hand is
   * then the colour of the workspace being pointed at.
   */
  function rowAccent(workspace: MeResponse['workspaces'][number]): string {
    const own =
      workspace.id && workspace.id !== look.workspaceId
        ? resolveLook(workspace.id, workspace.look)
        : look.value;
    const { accent, soft } = accentOf(own.theme, theme.dark);
    // --wash is what a highlighted row paints with; --accent-soft is the held
    // current row. Both here, so a row is its own colour in either state.
    // --accent-deep (the highlighted row's marks) is left to the shell: it is
    // mixed toward the ink rather than derived here, and the badges read on
    // the shell's ink either way.
    return `--accent: ${accent}; --accent-soft: ${soft}; --wash: ${soft}`;
  }

  function pick(id: string) {
    if (id === activeWorkspaceId) return;
    switchWorkspace(id);
  }
  function openSettings(id: string) {
    if (id === activeWorkspaceId) window.location.assign('/settings');
    else switchWorkspace(id, '/settings');
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
              ? '!size-8 !justify-center !gap-0 !p-0'
              : '!w-full !gap-2.5 !px-1.5 !py-1.5'}"
          >
            <BrandTile
              workspaceId={active.id}
              seedKey={active.id || active.name}
              label={active.name}
              size={sidebar.state === 'collapsed' ? 28 : 32}
            />
            <!-- The label is never destroyed on collapse: it fades and slides
                 out while the rail's width animates under it, so the two read
                 as one movement. An {#if} here removed it at frame 0 and the
                 open popped it back, against a 300ms width transition. -->
            <div
              class="label"
              class:away={sidebar.state === 'collapsed'}
              aria-hidden={sidebar.state === 'collapsed'}
            >
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
            </div>
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="w-[var(--bits-dropdown-menu-anchor-width)] min-w-[248px] max-w-[calc(100vw-24px)] !overflow-visible"
        side={sidebar.isMobile ? 'bottom' : 'right'}
        align="start"
        sideOffset={sidebar.isMobile ? 6 : 8}
      >
        <!-- overflow-visible: a row's quick actions open BESIDE the panel, and
             the content's own overflow-hidden would clip them away. -->
        <DropdownMenu.Label>{t('workspace.menuLabel')}</DropdownMenu.Label>
        {#each workspaces as workspace, i (workspace.id)}
          {@const current = workspace.id === activeWorkspaceId}
          {#if i > 0}<div class="hair"></div>{/if}
          <!-- A row is a click to switch and a rest for its quick actions.
               The current workspace is held in the selected wash; a
               suspended one stays VISIBLE but is not a switch target
               (visible-but-blocked: the server refuses its requests). -->
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger
              class="row !gap-2.5 px-2 py-2 {current ? 'current' : ''}"
              style={rowAccent(workspace)}
              disabled={workspace.suspended}
              aria-current={current ? 'true' : undefined}
              data-testid="workspace-entry"
              onclick={() => pick(workspace.id)}
            >
              <BrandTile
                workspaceId={workspace.id}
                wire={workspace.look}
                seedKey={workspace.id}
                label={workspace.name}
                size={26}
              />
              <span class="grid min-w-0 flex-1 leading-tight">
                <span class="truncate text-[13.5px] font-medium">{workspace.name}</span>
                <span class="role truncate">{roleTag(workspace.role).label}</span>
              </span>
              {#if workspace.suspended}
                <span class="badge badge--danger">{t('workspace.suspendedBadge')}</span>
              {:else if workspace.default}
                <!-- The selector-less default (a hub-level per-user setting):
                     clients read THIS flag, never the list order. -->
                <span class="badge badge--accent" title={t('workspace.defaultBadgeTitle')}>
                  {t('workspace.defaultBadge')}
                </span>
              {/if}
            </DropdownMenu.SubTrigger>
            <!-- The quick actions belong to the workspace whose row opened
                 them, so they carry that row's accent too: the panel renders
                 in a portal outside the row, so the slots do not inherit. -->
            <DropdownMenu.SubContent class="min-w-[200px]" style={rowAccent(workspace)} sideOffset={6}>
              <DropdownMenu.Label>{t('workspace.actions')}</DropdownMenu.Label>
              {#if !current}
                <DropdownMenu.Item class="!gap-2.5" onclick={() => pick(workspace.id)}>
                  <ArrowRight class="!size-3.5 !text-[var(--muted)]" />
                  {t('workspace.actionOpen')}
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Item class="!gap-2.5" onclick={() => openSettings(workspace.id)}>
                <Settings class="!size-3.5 !text-[var(--muted)]" />
                {t('workspace.actionSettings')}
              </DropdownMenu.Item>
              {#if workspace.default}
                <DropdownMenu.Item class="!gap-2.5" disabled>
                  <Star class="!size-3.5 !text-[var(--accent)]" />
                  {t('workspace.actionIsDefault')}
                </DropdownMenu.Item>
              {:else if workspace.hubOrigin && hubManageUrl}
                <!-- The default org lives at the hub (per-user setting): change
                     it there; a local toggle would be stomped by the next reconcile. -->
                <DropdownMenu.Item
                  class="!gap-2.5"
                  onclick={() => window.open(hubManageUrl, '_blank', 'noopener,noreferrer')}
                >
                  <ExternalLink class="!size-3.5 !text-[var(--muted)]" />
                  {t('workspace.actionMakeDefault')}
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
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
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>

{#if canCreateWorkspace}
  <CreateWorkspaceDialog bind:open={showCreateDialog} />
{/if}

<style>
  /* The trigger's words: they travel with the rail rather than blinking out
     of it. Width and opacity together, on the sidebar's own 300ms curve, so
     the collapse reads as one motion; `visibility` is delayed to the end so
     nothing under the rail is clickable once it is closed. */
  .label {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
    opacity: 1;
    transition:
      opacity 180ms var(--motion-ease),
      transform 300ms ease-out,
      visibility 0s linear 0s;
  }
  .label.away {
    opacity: 0;
    transform: translateX(-6px);
    visibility: hidden;
    /* width, not just visibility: a hidden flex child still takes its
       basis, and the row's gap still counts it, which pushed the mark a
       few px off the rail's centre. */
    flex: 0 0 0;
    width: 0;
    min-width: 0;
    overflow: hidden;
    pointer-events: none;
    transition:
      opacity 140ms var(--motion-ease),
      transform 300ms ease-out,
      visibility 0s linear 300ms;
  }
  @media (prefers-reduced-motion: reduce) {
    .label,
    .label.away {
      transition: none;
      transform: none;
    }
  }

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
  /* the row's own chevron is the sub-trigger's: quiet, at the end */
  :global(.float-item.row > svg:last-child) {
    width: 14px;
    height: 14px;
    color: var(--muted);
    opacity: 0.6;
  }
  /* The current workspace: the selected wash, under the pointer as well.
     Both slots are the row's own (rowAccent), so this holds the CURRENT
     workspace's colour while a rest on any other row shows THAT one's. */
  :global(.float-item.current),
  :global(.float-item.current[data-highlighted]) {
    background: var(--accent-soft);
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
