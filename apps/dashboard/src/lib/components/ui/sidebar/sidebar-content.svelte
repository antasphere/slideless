<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { WithElementRef } from 'bits-ui';
  import { onMount } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLElement>> = $props();

  let showTopIndicator = $state(false);
  let showBottomIndicator = $state(false);

  function updateScrollIndicators() {
    if (!ref) return;

    const { scrollTop, scrollHeight, clientHeight } = ref;

    // Show top indicator when scrolled down
    showTopIndicator = scrollTop > 0;

    // Show bottom indicator when not at bottom and content is scrollable
    showBottomIndicator = scrollTop + clientHeight < scrollHeight && scrollHeight > clientHeight;
  }

  onMount(() => {
    if (ref) {
      // Initial check
      updateScrollIndicators();

      // Add scroll listener
      ref.addEventListener('scroll', updateScrollIndicators);

      // Add resize observer to detect content changes
      const resizeObserver = new ResizeObserver(() => {
        updateScrollIndicators();
      });
      resizeObserver.observe(ref);

      // Cleanup
      return () => {
        ref?.removeEventListener('scroll', updateScrollIndicators);
        resizeObserver.disconnect();
      };
    }
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col">
  <!-- Top scroll indicator -->
  <div
    class="mr-2 h-px flex-shrink-0 px-0 transition-opacity duration-150 {showTopIndicator
      ? 'opacity-75'
      : 'opacity-0'}"
  >
    <div class="h-full bg-border"></div>
  </div>

  <div
    bind:this={ref}
    data-sidebar="content"
    class={cn(
      'flex min-h-0 flex-1 flex-col gap-2 overflow-auto pr-1 group-data-[collapsible=icon]:overflow-hidden',
      // collapsed the rail is 48px wide and the only thing in it is a
      // 32px button: the scrollbar gutter would push it off centre.
      'group-data-[collapsible=icon]:pr-0',
      className
    )}
    {...restProps}
  >
    {@render children?.()}
  </div>

  <!-- Bottom scroll indicator -->
  <div
    class="mr-2 h-px flex-shrink-0 px-0 transition-opacity duration-150 {showBottomIndicator
      ? 'opacity-75'
      : 'opacity-0'}"
  >
    <div class="h-full bg-border"></div>
  </div>
</div>
