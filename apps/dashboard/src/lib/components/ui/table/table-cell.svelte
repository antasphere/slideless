<script lang="ts">
  import type { HTMLTdAttributes } from 'svelte/elements';
  import type { WithElementRef } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLTdAttributes> = $props();
</script>

<td
  bind:this={ref}
  class={cn(
    'text-ink-soft px-4 py-3.5 align-middle first:font-medium first:text-ink [&:has([role=checkbox])]:pl-4 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</td>
