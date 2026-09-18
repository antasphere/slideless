<script lang="ts">
  import { Select as SelectPrimitive, type WithoutChild } from 'bits-ui';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithoutChild<SelectPrimitive.TriggerProps> = $props();
</script>

<SelectPrimitive.Trigger
  bind:ref
  class={cn(
    // the outline button's material: what opens from it is cut from the same paper
    'data-[placeholder]:text-muted-foreground focus:ring-ring flex h-9 w-full items-center justify-between gap-2 whitespace-nowrap rounded-[10px] border border-[var(--hairline)] bg-[var(--plate-strong)] px-3 py-2 text-[13.5px] text-[var(--ink)] transition-[background-color,border-color] hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--hairline))] hover:bg-[color-mix(in_oklab,var(--accent)_6%,var(--plate-strong))] focus:outline-none focus:ring-1 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-[color-mix(in_oklab,var(--accent)_45%,var(--hairline))] [&>span]:line-clamp-1',
    className
  )}
  {...restProps}
>
  {@render children?.()}
  <ChevronDown class="size-4 shrink-0 text-[var(--muted)]" />
</SelectPrimitive.Trigger>
