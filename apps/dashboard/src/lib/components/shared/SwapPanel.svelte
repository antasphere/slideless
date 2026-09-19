<script lang="ts">
  /* Two panels in the same place, where one replaces the other on a choice
     (the sign-in's password and email-code forms): the one leaving fades out
     where it stands, the one arriving fades up under it, and they overlap,
     so nothing below jumps while they trade places. The box around them
     glides to the new height (AutoHeight), so the buttons under it travel
     instead of teleporting. A reader who asked for no motion gets the swap
     at once. */
  import type { Snippet } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { motionDuration } from '$lib/components/ui/reveal/index.js';

  /** Changes when the panel changes: the key that drives the swap. */
  let { of: key, children }: { of: unknown; children: Snippet } = $props();
</script>

<div class="swap">
  {#key key}
    <div
      class="panel"
      in:fly={{ y: 8, duration: motionDuration(2.2), delay: motionDuration(0.9) }}
      out:fade={{ duration: motionDuration(0.9) }}
    >
      {@render children()}
    </div>
  {/key}
</div>

<style>
  /* the two panels share one cell: the leaving one no longer takes room */
  .swap {
    display: grid;
  }
  .panel {
    grid-area: 1 / 1;
    min-width: 0;
  }
</style>
