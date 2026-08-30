<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { WithElementRef } from 'bits-ui';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<main
  bind:this={ref}
  class={cn(
    'bg-background relative flex h-[100dvh] flex-1 flex-col',
    'peer-data-[variant=inset]:border peer-data-[variant=inset]:border-border',
    'peer-data-[variant=inset]:h-[calc(100dvh-theme(spacing.4))] md:peer-data-[variant=inset]:m-2 md:peer-data-[state=collapsed]:peer-data-[variant=inset]:ml-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-[14px] md:peer-data-[variant=inset]:shadow-[0_2px_14px_rgba(28,25,21,0.05)]',
    // The key fix: Ensure this container cannot scroll and has proper height containment
    'min-h-0 overflow-hidden',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</main>
