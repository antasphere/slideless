<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { WithElementRef } from 'bits-ui';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<!-- the actions: always in view in a framed dialog, side by side, sharing the
     width on a phone -->
<div bind:this={ref} class={cn('dlg-footer', className)} {...restProps}>
  {@render children?.()}
</div>
