<script lang="ts">
  /* The page's ground: a seeded field with the film grain, fixed to the
	   viewport and painted behind everything, so the field IS the paper and
	   every plate floats on it. Rendered once per viewport size, no
	   linework — the gate pages (login, consent, error) and the signed-in
	   shell sit on it. Ported from the website's PageField.astro. */
  import { buildBlobs, DPR, noiseTile, renderLow } from '$lib/engine/engine.js';
  import { CONSTANTS, PALETTES, RECIPE } from '$lib/brand/recipe.js';
  import { paletteFor, theme } from '$lib/theme.svelte';

  interface Props {
    palette?: string;
    seed?: number;
    /** How much of the field reaches the reader. */
    strength?: 'full' | 'soft' | 'quiet';
  }

  let { palette = 'labs-field', seed = RECIPE.seed, strength = 'full' }: Props = $props();

  let wrap = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);

  function rebuild() {
    if (!wrap || !canvas) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const named = PALETTES[palette] ? palette : RECIPE.theme;
    /* the dark set paints the palette's night twin when it has one */
    const key = paletteFor(named, theme.dark, PALETTES);
    const W = Math.round(rect.width * DPR);
    const H = Math.round(rect.height * DPR);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const low = renderLow(buildBlobs(seed, key), key, W, H, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = 'blur(' + Math.max(4, Math.round(W * 0.018)) + 'px)';
    ctx.drawImage(low, -W * 0.06, -H * 0.06, W * 1.12, H * 1.12);
    ctx.filter = 'none';
    /* the film pass: overlay on a light ground, screen on a dark one */
    const onDark = !PALETTES[key].light;
    ctx.globalCompositeOperation = onDark ? 'screen' : 'overlay';
    ctx.globalAlpha = onDark ? CONSTANTS.grain.alpha * 0.5 : CONSTANTS.grain.alpha;
    const pattern = ctx.createPattern(noiseTile(512, 0.9), 'repeat');
    if (pattern) {
      pattern.setTransform(new DOMMatrix().scale(CONSTANTS.grain.size * DPR));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, W, H);
    }
  }

  $effect(() => {
    theme.start();
    void palette;
    void seed;
    void theme.dark;
    if (!wrap) return;
    const ro = new ResizeObserver(rebuild);
    ro.observe(wrap);
    rebuild();
    return () => ro.disconnect();
  });
</script>

<div
  class="page-field"
  class:soft={strength === 'soft'}
  class:quiet={strength === 'quiet'}
  bind:this={wrap}
  aria-hidden="true"
>
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .page-field {
    position: fixed;
    inset: 0;
    z-index: 0;
    background: var(--field-base);
    pointer-events: none;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* under an app a person reads all day: the weather, one notch down */
  .soft canvas {
    opacity: 0.72;
  }
  .quiet canvas {
    opacity: 0.5;
  }
</style>
