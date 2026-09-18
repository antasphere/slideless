<script lang="ts">
  import { Select as SelectPrimitive, type WithoutChild } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    value,
    label,
    children: childrenProp,
    ...restProps
  }: WithoutChild<SelectPrimitive.ItemProps> = $props();
</script>

<SelectPrimitive.Item
  bind:ref
  {value}
  class={cn('float-item w-full py-1.5 pl-2 pr-8', className)}
  {...restProps}
>
  {#snippet children({ selected, highlighted })}
    <span class="float-mark absolute right-2 flex size-3.5 items-center justify-center">
      {#if selected}
        <Check class="size-4" strokeWidth={2.2} />
      {/if}
    </span>
    {#if childrenProp}
      {@render childrenProp({ selected, highlighted })}
    {:else}
      {label || value}
    {/if}
  {/snippet}
</SelectPrimitive.Item>
