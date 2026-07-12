<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Sidebar from '$lib/components/ui/sidebar/index.js';
  import { useSidebar } from '$lib/components/ui/sidebar/index.js';
  import { switchWorkspace } from '$lib/api';
  import { t } from '$lib/i18n';
  import type { MeResponse } from '@slideless/contract';

  /**
   * Sidebar workspace switcher (ADR 012). Rendered ONLY for users with more
   * than one active membership — single-membership users (every self-host)
   * keep the plain instance-name header, byte-identical to before.
   * Switching persists the choice (localStorage) and reloads, so every
   * loader and paged store restarts against the new workspace.
   */
  interface Props {
    workspaces: MeResponse['workspaces'];
    activeWorkspaceId: string;
  }

  let { workspaces, activeWorkspaceId }: Props = $props();

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
          <DropdownMenu.Item onclick={() => pick(workspace.id)}>
            <span class="truncate">{workspace.name}</span>
            {#if workspace.id === activeWorkspaceId}
              <Check class="ml-auto h-4 w-4 shrink-0" />
            {/if}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </Sidebar.MenuItem>
</Sidebar.Menu>
