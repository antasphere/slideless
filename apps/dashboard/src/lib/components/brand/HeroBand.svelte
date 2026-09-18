<script lang="ts">
  /* The band a page opens on: the look's theme in full colour as a field, one
     of the brand's drawings turning slowly at its right, and the page's words
     on it. The drawing is its own square canvas on the same field, its edge
     faded into the ground by a mask, so it sits beside the words on a desk
     and above them on a phone without a seam. Decoration only: it never
     moves for a reader who asked for no motion. */
  import type { Snippet } from 'svelte';
  import FieldCanvas from './FieldCanvas.svelte';
  import { RECIPE } from '$lib/brand/recipe.js';
  import { heroPalette, look } from '$lib/look.svelte';
  import { theme } from '$lib/theme.svelte';

  interface Props {
    /** One of the engine's constructions: `latitudes`, `orbits`, `apollonian`… */
    drawing?: string;
    seed?: number;
    children: Snippet;
  }
  let { drawing = 'latitudes', seed = RECIPE.seed, children }: Props = $props();

  $effect(() => theme.start());
  const palette = $derived(heroPalette(look.value.theme, theme.dark));
</script>

<section class="hero plate-window">
  <div class="ground"><FieldCanvas {palette} shape={drawing} {seed} linework={false} /></div>
  <div class="drawing"><FieldCanvas {palette} shape={drawing} {seed} animate /></div>
  <div class="words on-field">{@render children()}</div>
</section>

<style>
  .hero {
    position: relative;
    min-height: 210px;
    display: flex;
    align-items: flex-end;
    border: 1px solid var(--hairline);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  .ground {
    position: absolute;
    inset: 0;
  }
  .drawing {
    position: absolute;
    top: -40px;
    right: -34px;
    width: 176px;
    aspect-ratio: 1;
    -webkit-mask-image: radial-gradient(closest-side, #000 78%, transparent 100%);
    mask-image: radial-gradient(closest-side, #000 78%, transparent 100%);
  }
  .words {
    position: relative;
    padding: 24px 22px;
    max-width: 640px;
  }
  .words :global(.hero-eyebrow) {
    font-family: var(--second);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .words :global(.hero-title) {
    font-family: var(--display);
    font-weight: 300;
    font-size: clamp(28px, 5.4vw, 42px);
    line-height: 1.08;
    letter-spacing: -0.015em;
    margin-top: 8px;
  }
  .words :global(.hero-lede) {
    margin-top: 10px;
    font-size: 15px;
    line-height: 1.45;
    opacity: 0.82;
  }
  @media (min-width: 768px) {
    .hero {
      min-height: 250px;
    }
    .words {
      padding: 32px 34px;
    }
    .drawing {
      top: 50%;
      right: 5%;
      width: 330px;
      transform: translateY(-50%);
    }
  }
</style>
