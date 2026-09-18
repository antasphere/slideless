<script lang="ts">
  /* One faint sheet of film grain over the whole app (the Exos shell's
     .pagegrain): a runtime canvas-generated tile composited `overlay` at
     opacity 0.05. Pure decoration — aria-hidden, pointer-events none. */
  import { onMount } from 'svelte';
  import { noiseTile } from '$lib/engine/engine.js';
  import { look } from '$lib/look.svelte';

  // onMount, not $derived: the tile needs a real canvas, so the grain only
  // exists client-side (the prerendered shell ships without it).
  let grainURL = $state('');
  onMount(() => {
    grainURL = noiseTile(512, 0.9).toDataURL();
  });
</script>

{#if grainURL}
  <!-- 0.05 is the brand's sheet; a person's grain setting scales it (0.5 = the constant) -->
  <div
    class="pagegrain"
    style="background-image: url({grainURL}); opacity: {(0.1 * look.value.grain).toFixed(3)}"
    aria-hidden="true"
  ></div>
{/if}
