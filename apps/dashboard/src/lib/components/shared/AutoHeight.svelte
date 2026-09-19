<script lang="ts">
  /* A box whose height glides to its content's. What is inside may change
     at once (a dialog's next step, a longer sentence): the box measures it
     and travels there in the product's motion, so nothing around it jumps.
     The first measure is taken without a transition, and a reader who asked
     for no motion gets the new height at once. */
  import type { Snippet } from 'svelte';

  let { children, class: className = '' }: { children: Snippet; class?: string } = $props();

  let inner = $state<HTMLDivElement | null>(null);
  let height = $state<number | null>(null);
  let settled = $state(false);
  let shrinking = $state(false);
  let following = $state(false);
  /** Under this many pixels a change is a frame of someone else's animation, not a jump. */
  const FOLLOW_PX = 10;

  $effect(() => {
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (!inner) return;
      // The SAME journey up and down: a transition on `height` from `auto`
      // (the box's first state, and whenever the content is measured late)
      // is not interpolated by the browser and lands at once, which read as
      // "shrinking is faster". The measured pixel height is always set, so
      // every change is a real interpolation of the same duration.
      const next = inner.offsetHeight;
      // Down is not up played backwards: the shorter content is already in
      // place, so the edge crosses empty space, and an ease-out spends most of
      // that distance in its first frames — it read as a snap. Going down
      // takes longer and eases at both ends.
      // Content that is ALREADY gliding (an error line folding open, a
      // Reveal) reports a few pixels per frame. Travelling to each of those
      // with a transition of its own leaves the box behind its content, and
      // what is at the bottom (the button) is clipped until it catches up.
      // Small steps are followed at once; only a real jump is a journey.
      following = height !== null && Math.abs(next - height) <= FOLLOW_PX;
      shrinking = height !== null && next < height;
      height = next;
      // the first height is where the box IS, not somewhere it travels to
      if (!settled) requestAnimationFrame(() => (settled = true));
    });
    ro.observe(inner);
    return () => ro.disconnect();
  });
</script>

<div
  class="auto-h {className}"
  class:settled
  class:shrinking
  class:following
  style:height={height === null ? 'auto' : `${height}px`}
>
  <div bind:this={inner} class="auto-h-inner">{@render children()}</div>
</div>

<style>
  /* the room for a focus ring: what is inside keeps its 4px of air while the box clips */
  .auto-h {
    margin: -4px;
    overflow: hidden;
  }
  .auto-h-inner {
    padding: 4px;
  }
  @media (prefers-reduced-motion: no-preference) {
    .auto-h.settled {
      transition: height calc(var(--motion-duration) * 2.4) cubic-bezier(0.22, 1, 0.36, 1);
    }
    .auto-h.settled.shrinking {
      transition: height calc(var(--motion-duration) * 3.6) cubic-bezier(0.65, 0, 0.35, 1);
    }
    .auto-h.settled.following {
      transition: none;
    }
  }
</style>
