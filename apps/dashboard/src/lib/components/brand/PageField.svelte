<script lang="ts">
  /* The page's ground: a seeded field with the film grain, fixed to the
	   viewport and painted behind everything, so the field IS the paper and
	   every plate floats on it. Rendered once per viewport size, no
	   linework — the gate pages (login, consent, error) and the signed-in
	   shell sit on it. Ported from the website's PageField.astro. */
  import { buildBlobs, DPR, noiseTile, renderLow } from '$lib/engine/engine.js';
  import { CONSTANTS, PALETTES, RECIPE } from '$lib/brand/recipe.js';
  import { paletteFor, theme } from '$lib/theme.svelte';
  import { followPointer } from '$lib/brand/follow';

  interface Props {
    palette?: string;
    seed?: number;
    /** How much of the field reaches the reader. */
    strength?: 'full' | 'soft' | 'quiet';
    /** Overrides for the signed-in shell, where a person sets them (look.svelte.ts):
        the field's opacity 0..1, and the grain as a factor of the brand's constant. */
    opacity?: number;
    grain?: number;
    /** The gate's page: the field floats a little and leans WITH the pointer,
        the other way from the gate's own ground, and far less. The painted
        sheet is moved, never repainted; it is cut a little larger than the
        page so its edge never shows. */
    alive?: boolean;
  }

  let {
    palette = 'labs-field',
    seed = RECIPE.seed,
    strength = 'full',
    opacity,
    grain = 1,
    alive = false
  }: Props = $props();

  let wrap = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);

  function rebuild() {
    if (!wrap || !canvas) return;
    const rect = { width: canvas.offsetWidth, height: canvas.offsetHeight };
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
    ctx.globalAlpha = Math.min(1, (onDark ? CONSTANTS.grain.alpha * 0.5 : CONSTANTS.grain.alpha) * grain);
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
    void grain;
    void theme.dark;
    if (!wrap) return;
    const ro = new ResizeObserver(rebuild);
    ro.observe(wrap);
    rebuild();
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!alive || !wrap || !canvas) return;
    const sheet = canvas;
    const stop = followPointer(wrap, ({ x, y, t }) => {
      const dx = x * 12 + Math.sin(t * 0.17) * 5;
      const dy = y * 9 + Math.cos(t * 0.13) * 4;
      sheet.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
    });
    return () => {
      stop();
      sheet.style.transform = '';
    };
  });
</script>

<div
  class="page-field"
  class:soft={strength === 'soft'}
  class:quiet={strength === 'quiet'}
  class:alive
  bind:this={wrap}
  aria-hidden="true"
>
  <canvas bind:this={canvas} style:opacity></canvas>
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
  .alive {
    overflow: hidden;
  }
  .alive canvas {
    position: absolute;
    inset: -24px;
    width: calc(100% + 48px);
    height: calc(100% + 48px);
    will-change: transform;
  }
  /* under an app a person reads all day: the weather, one notch down */
  .soft canvas {
    opacity: 0.72;
  }
  .quiet canvas {
    opacity: 0.5;
  }
</style>
