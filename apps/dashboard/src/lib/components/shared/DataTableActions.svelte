<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { Ellipsis } from '@lucide/svelte';
  import { t } from '$lib/i18n';

  interface ActionItem {
    label: string;
    onclick: () => void;
    variant?: 'default' | 'destructive';
  }

  interface Props {
    actions: ActionItem[];
  }

  let { actions }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button variant="ghost" size="icon" class="h-8 w-8" {...props}>
        <Ellipsis class="h-4 w-4" />
        <span class="sr-only">{t('table.openMenu')}</span>
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end">
    {#each actions as action (action.label)}
      <DropdownMenu.Item
        onclick={action.onclick}
        class={action.variant === 'destructive' ? 'text-destructive focus:text-destructive' : ''}
      >
        {action.label}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
