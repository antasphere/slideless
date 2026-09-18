<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive, type WithoutChildrenOrChild } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import Minus from '@lucide/svelte/icons/minus';
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';

  let {
    ref = $bindable(null),
    class: className,
    children: childrenProp,
    checked = $bindable(false),
    indeterminate = $bindable(false),
    ...restProps
  }: WithoutChildrenOrChild<DropdownMenuPrimitive.CheckboxItemProps> & {
    children?: Snippet;
  } = $props();
</script>

<DropdownMenuPrimitive.CheckboxItem
  bind:ref
  bind:checked
  bind:indeterminate
  class={cn('float-item py-1.5 pl-8 pr-2', className)}
  {...restProps}
>
  {#snippet children({ checked, indeterminate })}
    <span class="float-mark absolute left-2 flex size-3.5 items-center justify-center">
      {#if indeterminate}
        <Minus class="size-4" strokeWidth={2.2} />
      {:else}
        <Check class={cn('size-4', !checked && 'text-transparent')} strokeWidth={2.2} />
      {/if}
    </span>
    {@render childrenProp?.()}
  {/snippet}
</DropdownMenuPrimitive.CheckboxItem>
