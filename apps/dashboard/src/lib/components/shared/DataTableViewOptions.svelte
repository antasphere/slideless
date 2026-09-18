<script lang="ts" generics="TData">
  import type { Table } from '@tanstack/table-core';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import { t } from '$lib/i18n';

  interface Props {
    table: Table<TData>;
  }

  let { table }: Props = $props();

  const columns = $derived(
    table.getAllColumns().filter((col) => typeof col.accessorFn !== 'undefined' && col.getCanHide())
  );
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button variant="outline" size="sm" class="ml-auto h-8" {...props}>
        <Settings2 class="mr-2 h-4 w-4" />
        {t('table.view')}
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-[176px]">
    <DropdownMenu.Label>{t('table.toggleColumns')}</DropdownMenu.Label>
    {#each columns as column (column.id)}
      <DropdownMenu.CheckboxItem
        checked={column.getIsVisible()}
        onCheckedChange={(value) => column.toggleVisibility(!!value)}
      >
        {column.columnDef.meta?.title ?? column.id}
      </DropdownMenu.CheckboxItem>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
