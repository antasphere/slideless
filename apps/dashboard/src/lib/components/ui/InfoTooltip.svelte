<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { onMount, tick } from 'svelte';

  interface Props {
    content: string;
    delayDuration?: number;
  }

  let { content, delayDuration = 100 }: Props = $props();

  let mounted = $state(false);

  onMount(async () => {
    // Wait for the next tick to ensure DOM is fully rendered
    await tick();

    // Add a small delay before enabling tooltips
    setTimeout(() => {
      mounted = true;
    }, 50);
  });
</script>

{#if mounted}
  <Tooltip.Provider {delayDuration}>
    <Tooltip.Root>
      <Tooltip.Trigger
        data-tooltip-trigger
        class="flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/20 text-xs text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
      >
        ?
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content>
          <p class="text-xs font-normal leading-relaxed">{content}</p>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
{:else}
  <div
    class="flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/20 text-xs text-muted-foreground"
  >
    ?
  </div>
{/if}
