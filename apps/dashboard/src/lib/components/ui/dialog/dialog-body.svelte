<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';

  /* The part of a dialog that scrolls. It measures itself: a soft shadow
     falls from the header only once something has scrolled under it, and
     one rises from the actions only while there is more below. A dialog
     whose content fits shows neither. */
  let {
    class: className,
    children
  }: {
    class?: string;
    children: Snippet;
  } = $props();

  let scroller = $state<HTMLDivElement | null>(null);
  let inner = $state<HTMLDivElement | null>(null);
  let above = $state(false);
  let below = $state(false);

  function measure() {
    const el = scroller;
    if (!el) return;
    above = el.scrollTop > 1;
    below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  $effect(() => {
    if (!scroller || !inner) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(inner);
    return () => observer.disconnect();
  });
</script>

<div class="wrap" data-above={above ? '' : undefined} data-below={below ? '' : undefined}>
  <div class="scroller" bind:this={scroller} onscroll={measure}>
    <div class={cn('inner', className)} bind:this={inner}>
      {@render children()}
    </div>
  </div>
</div>

<style>
  .wrap {
    position: relative;
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }
  .scroller {
    min-height: 0;
    flex: 1 1 auto;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .inner {
    min-width: 0;
    padding: 6px var(--dlg-pad, 24px) 22px;
  }
  /* an older caller's whole content: its own header, then whatever follows */
  .inner:global(.dlg-plain) {
    display: grid;
    gap: 16px;
    padding: 22px var(--dlg-pad, 24px);
  }
  .inner:global(.dlg-plain) > :global(*) {
    min-width: 0;
  }
  .wrap::before,
  .wrap::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    z-index: 2;
    height: 18px;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--motion-duration) var(--motion-ease);
  }
  .wrap::before {
    top: 0;
    border-top: 1px solid var(--hairline);
    background: linear-gradient(to bottom, color-mix(in oklab, var(--ink) 9%, transparent), transparent);
  }
  .wrap::after {
    bottom: 0;
    background: linear-gradient(to top, color-mix(in oklab, var(--ink) 10%, transparent), transparent);
  }
  .wrap[data-above]::before,
  .wrap[data-below]::after {
    opacity: 1;
  }
</style>
