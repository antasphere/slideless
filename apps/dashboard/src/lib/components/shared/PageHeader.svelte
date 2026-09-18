<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
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

<!-- The page-title tier of the brand's type register: Sentient at the title
     size, the hairline underneath doing the separating (no Separator). -->
<div class="page-head mb-6 flex-wrap items-end justify-between gap-x-4 gap-y-3 md:mb-10">
  <div class="min-w-0 space-y-1">
    <h1>{title}</h1>
    {#if description}
      <p class="text-sm text-muted-foreground">{description}</p>
    {/if}
  </div>
  {#if onAdd}
    <Button onclick={onAdd} size="sm" class="h-10 shrink-0 px-4 text-sm md:h-8 md:px-3 md:text-xs">
      <Plus class="mr-1 h-4 w-4" />
      {addLabel}
    </Button>
  {/if}
</div>
