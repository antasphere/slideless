<script lang="ts">
  import type { Column } from '@tanstack/table-core';
  import { cn } from '$lib/utils.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import { t } from '$lib/i18n';

  interface Props {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    column: Column<any, any>;
    title: string;
    class?: string;
  }

  let { column, title, class: className }: Props = $props();
</script>

{#if !column.getCanSort()}
  <div class={cn('flex items-center space-x-2', className)}>
    <Button variant="ghost" size="sm" class="-ml-3 h-8 cursor-default hover:bg-transparent">
      <span>{title}</span>
    </Button>
  </div>
{:else}
  <div class={cn('flex items-center space-x-2', className)}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button variant="ghost" size="sm" class="-ml-3 h-8 data-[state=open]:bg-accent" {...props}>
            <span>{title}</span>
            {#if column.getIsSorted() === 'desc'}
              <ArrowDown class="ml-2 h-4 w-4" />
            {:else if column.getIsSorted() === 'asc'}
              <ArrowUp class="ml-2 h-4 w-4" />
            {:else}
              <ArrowUpDown class="ml-2 h-4 w-4" />
            {/if}
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start">
        <DropdownMenu.Item onclick={() => column.toggleSorting(false)}>
          <ArrowUp class="mr-2 h-3.5 w-3.5 text-muted-foreground/70" />
          {t('table.sortAsc')}
        </DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => column.toggleSorting(true)}>
          <ArrowDown class="mr-2 h-3.5 w-3.5 text-muted-foreground/70" />
          {t('table.sortDesc')}
        </DropdownMenu.Item>
        {#if column.getCanHide()}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onclick={() => column.toggleVisibility(false)}>
            <EyeOff class="mr-2 h-3.5 w-3.5 text-muted-foreground/70" />
            {t('table.hideColumn')}
          </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
{/if}
