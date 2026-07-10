<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { WithElementRef } from 'bits-ui';
  import { onMount } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    class: className,
    children,
    onscroll,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    onscroll?: (event: Event) => void;
  } = $props();

  let showTopIndicator = $state(false);

  function updateScrollIndicators() {
    if (!ref) return;

    const { scrollTop } = ref;

    // Show top indicator when scrolled down
    showTopIndicator = scrollTop > 0;
  }

  function handleScroll(event: Event) {
    updateScrollIndicators();
    onscroll?.(event);
  }

  onMount(() => {
    if (ref) {
      // Initial check
      updateScrollIndicators();

      // Add scroll listener
      ref.addEventListener('scroll', handleScroll);

      // Add resize observer to detect content changes
      const resizeObserver = new ResizeObserver(() => {
        updateScrollIndicators();
      });
      resizeObserver.observe(ref);

      // Cleanup
      return () => {
        ref?.removeEventListener('scroll', handleScroll);
        resizeObserver.disconnect();
      };
    }
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col">
  <!-- Top scroll indicator -->
  <div
    class="h-px flex-shrink-0 px-0 transition-opacity duration-150 {showTopIndicator
      ? 'opacity-75'
      : 'opacity-0'}"
  >
    <div class="h-full bg-border"></div>
  </div>

  <div
    bind:this={ref}
    data-scrollable-content
    class={cn('min-h-0 flex-1 overflow-y-auto pr-1', className)}
    {...restProps}
  >
    {@render children?.()}
  </div>
</div>
