<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';

  interface Props {
    title: string;
    description?: string;
    onAdd?: () => void;
    addLabel?: string;
  }

  let { title, description, onAdd, addLabel = t('common.add') }: Props = $props();
</script>

<div>
  <div class="flex items-center justify-between">
    <div class="space-y-1">
      <h2 class="text-2xl font-semibold tracking-tight">{title}</h2>
      {#if description}
        <p class="text-sm text-muted-foreground">{description}</p>
      {/if}
    </div>
    {#if onAdd}
      <Button onclick={onAdd} size="sm">
        <Plus class="mr-2 h-4 w-4" />
        {addLabel}
      </Button>
    {/if}
  </div>
  <Separator class="mb-10 mt-4" />
</div>
