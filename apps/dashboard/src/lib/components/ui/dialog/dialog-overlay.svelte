<script lang="ts">
  import { cn } from '$lib/utils.js';
  import { Dialog as DialogPrimitive } from 'bits-ui';

  let { ref = $bindable(null), class: className, ...restProps }: DialogPrimitive.OverlayProps = $props();
</script>

<!-- the scrim's look lives with the surface's (dialog-content.svelte) -->
<DialogPrimitive.Overlay bind:ref class={cn('dlg-overlay', className)} {...restProps} />
