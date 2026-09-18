<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive, type WithoutChild } from 'bits-ui';
  import Circle from '@lucide/svelte/icons/circle';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    children: childrenProp,
    ...restProps
  }: WithoutChild<DropdownMenuPrimitive.RadioItemProps> = $props();
</script>

<DropdownMenuPrimitive.RadioItem bind:ref class={cn('float-item py-1.5 pl-8 pr-2', className)} {...restProps}>
  {#snippet children({ checked })}
    <span class="float-mark absolute left-2 flex size-3.5 items-center justify-center">
      {#if checked}
        <Circle class="size-2 fill-current" />
      {/if}
    </span>
    {@render childrenProp?.({ checked })}
  {/snippet}
</DropdownMenuPrimitive.RadioItem>
