<script lang="ts">
  import { Dialog as SheetPrimitive } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let { ref = $bindable(null), class: className, ...restProps }: SheetPrimitive.TitleProps = $props();
</script>

<SheetPrimitive.Title
  bind:ref
  class={cn('text-foreground font-display text-lg font-normal', className)}
  {...restProps}
/>
