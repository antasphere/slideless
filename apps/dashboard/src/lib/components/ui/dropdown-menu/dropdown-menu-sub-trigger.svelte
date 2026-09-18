<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive, type WithoutChild } from 'bits-ui';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    inset,
    children,
    ...restProps
  }: WithoutChild<DropdownMenuPrimitive.SubTriggerProps> & {
    inset?: boolean;
  } = $props();
</script>

<DropdownMenuPrimitive.SubTrigger
  bind:ref
  class={cn('float-item px-2 py-2 [&_svg]:pointer-events-none', inset && 'pl-8', className)}
  {...restProps}
>
  {@render children?.()}
  <ChevronRight class="ml-auto" />
</DropdownMenuPrimitive.SubTrigger>
