<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    inset,
    ...restProps
  }: DropdownMenuPrimitive.GroupHeadingProps & {
    inset?: boolean;
  } = $props();
</script>

<DropdownMenuPrimitive.GroupHeading
  bind:ref
  class={cn('float-label', inset && 'pl-8', className)}
  {...restProps}
/>
