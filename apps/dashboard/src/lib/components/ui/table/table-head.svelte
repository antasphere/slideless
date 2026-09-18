<script lang="ts">
  import type { HTMLThAttributes } from 'svelte/elements';
  import type { WithElementRef } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLThAttributes> = $props();
</script>

<th
  bind:this={ref}
  class={cn(
    'table-head text-muted-foreground h-10 overflow-hidden px-4 text-left align-middle text-[11px] font-medium uppercase tracking-[0.08em] [&_button]:text-[11px] [&_button]:font-medium [&_button]:uppercase [&_button]:tracking-[0.08em] [&_button]:text-muted-foreground [&:has([role=checkbox])]:pl-4 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</th>
