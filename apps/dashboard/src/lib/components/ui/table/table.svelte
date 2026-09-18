<script lang="ts">
  import type { HTMLTableAttributes } from 'svelte/elements';
  import type { WithElementRef } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    scroll = true,
    children,
    ...restProps
  }: WithElementRef<HTMLTableAttributes> & {
    /** The wrapper scrolls sideways (a table wider than its column). A scrolling
        wrapper is also a scroll container, which is what stops a header from
        sticking to the page: a table whose header stays in place while the page
        scrolls passes `scroll={false}`. */
    scroll?: boolean;
  } = $props();
</script>

<div class={cn('relative w-full', scroll && 'overflow-auto')}>
  <table bind:this={ref} class={cn('w-full caption-bottom text-[14px]', className)} {...restProps}>
    {@render children?.()}
  </table>
</div>
