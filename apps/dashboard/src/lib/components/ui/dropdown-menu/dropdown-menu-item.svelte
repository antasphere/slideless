<script lang="ts">
  import { cn } from '$lib/utils.js';
  import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';

  let {
    ref = $bindable(null),
    class: className,
    inset,
    variant = 'default',
    ...restProps
  }: DropdownMenuPrimitive.ItemProps & {
    inset?: boolean;
    /** `destructive`: danger ink, and the danger wash under the hand. */
    variant?: 'default' | 'destructive';
  } = $props();
</script>

<DropdownMenuPrimitive.Item
  bind:ref
  class={cn('float-item px-2 py-2', inset && 'pl-8', className)}
  data-variant={variant}
  {...restProps}
/>
