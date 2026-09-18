<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import type { WithElementRef } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLTableRowElement>> = $props();
</script>

<tr
  bind:this={ref}
  class={cn(
    'border-b border-[color-mix(in_oklab,var(--hairline)_70%,transparent)] transition-colors last:border-0 hover:bg-[color-mix(in_oklab,var(--accent)_5%,transparent)] hover:[&>td:first-child]:shadow-[inset_2px_0_0_var(--accent)] data-[state=selected]:bg-[var(--accent-soft)]',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</tr>
