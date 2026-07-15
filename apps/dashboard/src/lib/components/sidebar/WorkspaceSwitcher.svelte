<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';
  import { switchWorkspace } from '$lib/api';
  import { t } from '$lib/i18n';
  import type { MeResponse } from '@slideless/contract';

  /**
   * Sidebar workspace switcher (ADR 014 / user-scoped federation). Rendered
   * ONLY for users with more than one active membership — single-membership
   * users (every self-host) keep the plain instance-name header,
   * byte-identical to before. Switching persists the choice (localStorage)
   * and reloads, so every loader and paged store restarts against the new
   * workspace. Per-entry signals come straight off /me: `hubOrigin`
   * (Antasphere badge), `suspended` (disabled + badge — visible but
   * blocked), `default` (the selector-less default marker). The default org
   * is a HUB-level per-user setting, so the "set as default" action links
   * out to the hub console (hubManageUrl) — a local write would be
   * overwritten by the next reconcile pass.
   */
  interface Props {
    workspaces: MeResponse['workspaces'];
    activeWorkspaceId: string;
    /** The hub console origin (P7 link-out); null on oss / local actives. */
    hubManageUrl?: string | null;
  }

  let { workspaces, activeWorkspaceId, hubManageUrl = null }: Props = $props();

  const sidebar = useSidebar();

  const active = $derived(
    workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? { id: '', name: '' }
  );
  const initial = $derived((active.name || 'W').slice(0, 1).toUpperCase());

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
            class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <div
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-sm"
            >
              {initial}
            </div>
            {#if sidebar.state !== 'collapsed'}
              <span class="truncate text-sm font-semibold">{active.name}</span>
              <ChevronsUpDown class="ml-auto size-4 shrink-0" />
            {/if}
          </Sidebar.MenuButton>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        class="w-[var(--bits-dropdown-menu-anchor-width)] min-w-56 rounded-lg"
        side={sidebar.isMobile ? 'bottom' : 'right'}
        align="start"
        sideOffset={4}
      >
        <DropdownMenu.Label class="text-xs text-muted-foreground">
          {t('workspace.menuLabel')}
        </DropdownMenu.Label>
        {#each workspaces as workspace (workspace.id)}
          <!-- A suspended org stays VISIBLE but is not a switch target
               (visible-but-blocked — the server refuses its requests). -->
          <DropdownMenu.Item
            onclick={() => pick(workspace.id)}
            disabled={workspace.suspended}
            data-testid="workspace-entry"
          >
            <span class="truncate">{workspace.name}</span>
            {#if workspace.hubOrigin}
              <!-- P7: a hub-org projection, managed at Antasphere. Keyed off
                   /me's hubOrigin flag — never edition-sniffing. Local
                   workspaces are implicitly distinguished: no badge. -->
              <span
                class="shrink-0 rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                title={t('workspace.hubBadgeTitle')}
              >
                {t('workspace.hubBadge')}
              </span>
            {/if}
            {#if workspace.suspended}
              <span
                class="shrink-0 rounded border border-destructive/50 px-1 text-[10px] font-medium uppercase tracking-wide text-destructive"
              >
                {t('workspace.suspendedBadge')}
              </span>
            {/if}
            {#if workspace.default}
              <!-- The selector-less default (a hub-level per-user setting)
                   — clients read THIS flag, never the list order. -->
              <span
                class="shrink-0 rounded bg-muted px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                title={t('workspace.defaultBadgeTitle')}
              >
                {t('workspace.defaultBadge')}
              </span>
            {/if}
            {#if workspace.id === activeWorkspaceId}
              <Check class="ml-auto h-4 w-4 shrink-0" />
            {/if}
          </DropdownMenu.Item>
        {/each}
        {#if hubManageUrl}
          <DropdownMenu.Separator />
          <!-- The default org lives at the hub (per-user setting): change it
               there — a local toggle would be stomped by the next reconcile. -->
          <DropdownMenu.Item onclick={() => window.open(hubManageUrl, '_blank', 'noopener,noreferrer')}>
            <ExternalLink class="h-4 w-4 shrink-0" />
            <span class="truncate">{t('workspace.setDefaultHub')}</span>
          </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>
