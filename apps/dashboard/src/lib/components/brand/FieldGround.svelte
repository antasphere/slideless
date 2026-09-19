<script lang="ts">
  /* A field that is the GROUND under a turning drawing: it drifts by itself
     and slides as one sheet by whatever `slide` says. The moving field is
     painted small (it is all blur, and the blur is the cost of a frame) and
     its grain is a still sheet over it, at the engine's own size and
     strength. */
  import { onMount } from 'svelte';
  import FieldCanvas from './FieldCanvas.svelte';
  import { CONSTANTS } from '$lib/brand/recipe.js';
  import { GRAINS, DPR } from '$lib/engine/engine.js';

  interface Props {
    palette: string;
    shape: string;
    seed: number;
    /** How far the ground has slid, in its own widths and heights. */
    slide: () => { x: number; y: number };
  }
  let { palette, shape, seed, slide }: Props = $props();

  let grainURL = $state('');
  onMount(() => {
    grainURL =
      (GRAINS as Record<string, { tile?: HTMLCanvasElement }>)[CONSTANTS.grain.type]?.tile?.toDataURL() ?? '';
  });
</script>

<FieldCanvas
  {palette}
  {shape}
  {seed}
  linework={false}
  grained={false}
  dpr={0.5}
  animate
  drift={slide}
  cadence={16}
  tempo={3.4}
/>
{#if grainURL}
  <div
    class="grain"
    style="background-image: url({grainURL}); background-size: {512 / DPR}px; opacity: {CONSTANTS.grain
      .alpha}"
  ></div>
{/if}

<style>
  .grain {
    position: absolute;
    inset: 0;
    mix-blend-mode: overlay;
    pointer-events: none;
  }
</style>
