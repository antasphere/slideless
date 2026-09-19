<script lang="ts">
  /* The share links table's View button: which columns show. It edits a
     LinkColumns the table reads, so the section that owns the choice (the
     deck page) or the table itself (the master page's share sheet) can set
     it in the toolbar over the table. */
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import { t } from '$lib/i18n';
  import type { LinkColumns } from './linkColumns.svelte';

  interface Props {
    view: LinkColumns;
    class?: string;
  }

  let { view, class: className }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button variant="outline" size="sm" class={className} data-testid="links-columns" {...props}>
        <Settings2 class="mr-2 h-4 w-4" />
        {t('table.view')}
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-[176px]">
    <DropdownMenu.Label>{t('table.toggleColumns')}</DropdownMenu.Label>
    {#each view.choices as choice (choice.id)}
      <DropdownMenu.CheckboxItem
        checked={view.shows(choice.id)}
        closeOnSelect={false}
        onCheckedChange={(value) => view.set(choice.id, !!value)}
      >
        {choice.title}
      </DropdownMenu.CheckboxItem>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
