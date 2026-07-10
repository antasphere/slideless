<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { WithElementRef } from 'bits-ui';
  import type { HTMLAttributes } from 'svelte/elements';
  import { Skeleton } from '$lib/components/ui/skeleton';

  let {
    ref = $bindable(null),
    class: className,
    showIcon = true,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    showIcon?: boolean;
  } = $props();
</script>

<div
  bind:this={ref}
  data-sidebar="menu-button-loading"
  class={cn(
    // Base MenuButton styles
    'flex w-full items-center gap-2 overflow-hidden rounded-lg p-2 text-left text-sm h-9',
    // Use hover colors as background for loading state
    'bg-sidebar-accent/75 text-sidebar-accent-foreground',
    // Additional styling
    'transition-[width,height,padding] group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2',
    className
  )}
  {...restProps}
>
  {#if showIcon}
    <Skeleton class="size-4 shrink-0 rounded-md" data-sidebar="menu-button-loading-icon" />
  {/if}
  <Skeleton class="h-4 flex-1 rounded-md" data-sidebar="menu-button-loading-text" />
</div>
