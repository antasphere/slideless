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

<div
  bind:this={ref}
  data-sidebar="header"
  class={cn('flex flex-col gap-2 px-2 pb-[1.5px] pt-1', 'group-data-[collapsible=icon]:px-2', className)}
  {...restProps}
>
  {@render children?.()}
</div>
