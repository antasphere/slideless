<script lang="ts">
  /* One of the brand's hover patterns on a seeded field: the dashboard twin of
     the console's AnimationCanvas.svelte and of the website's
     `mountPatternCards` harness. The ground is paint() with linework off (the
     field plus its grain, drifting at t * 0.12), the pattern's linework goes
     on top in the field's ink. The clock only advances while the card is
     played (hover eases toward its target at dt * 6) and the loop stops the
     moment the card is back at rest. A reader who asked for no motion gets the
     resting frame and nothing else. */
  import { paint, buildBlobs, mulberry32, clamp, DPR, TAU } from '$lib/engine/engine.js';
  import { PALETTES } from '$lib/brand/recipe.js';
  import { animationByKey } from '$lib/brand/animations.js';
  import { paletteFor, theme } from '$lib/theme.svelte';

  interface Props {
    /** A key of the brand's animation library (`slides`, `rings`, `weave`…). */
    pattern: string;
    palette?: string;
    seed: number;
    /** Play while true: the parent owns hover and focus, so a whole card can drive its plate. */
    active?: boolean;
    /** The website's cards whisper their grain at 0.15 overlay; a quiet plate can go lower. */
    grainAlpha?: number;
  }

  let { pattern, palette = 'dawn', seed, active = false, grainAlpha = 0.15 }: Props = $props();

  type Blobs = ReturnType<typeof buildBlobs>;
  type Draw = (ctx: CanvasRenderingContext2D, W: number, H: number, u: unknown) => void;

  const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
  const ease = (x: number) => {
    const c = clamp(x, 0, 1);
    return c * c * (3 - 2 * c);
  };

  let canvas = $state<HTMLCanvasElement | null>(null);
  let hover = 0;
  let target = 0;
  let t = 0;
  let rafId: number | null = null;
  let last = 0;
  let blobs: Blobs | null = null;
  let key = 'dawn';

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function render() {
    if (!canvas || !blobs) return;
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const W = Math.round(r.width * DPR);
    const H = Math.round(r.height * DPR);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paint(
      ctx,
      W,
      H,
      { palette: key, linework: false, grain: 'film', grainAlpha, grainSize: 1, seed, blobs },
      t * 0.12
    );
    const draw = animationByKey(pattern)?.draw as Draw | undefined;
    if (!draw) return;
    const inkRGB = PALETTES[key].light ? '28,25,21' : '247,244,236';
    ctx.save();
    draw(ctx, W, H, {
      t,
      hover,
      seed,
      rnd: mulberry32(seed),
      DPR,
      TAU,
      lerp,
      ease,
      ink: (a: number) => 'rgba(' + inkRGB + ',' + clamp(a, 0, 1).toFixed(3) + ')'
    });
    ctx.restore();
  }

  function tick(now: number) {
    const dt = Math.min(64, last ? now - last : 16) / 1000;
    last = now;
    if (target <= 0 && hover <= 0.001) {
      hover = 0;
      rafId = null;
      render();
      return;
    }
    hover += (target - hover) * Math.min(1, dt * 6);
    if (target === 0 && hover < 0.004) hover = 0;
    t += dt;
    render();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (rafId === null) {
      last = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  $effect(() => {
    theme.start();
    /* re-ground on any recipe change; the seed is baked into the blobs */
    key = paletteFor(PALETTES[palette] ? palette : 'dawn', theme.dark, PALETTES);
    blobs = buildBlobs(seed, key);
    void pattern;
    render();
  });

  $effect(() => {
    const wanted = active && !reduced() ? 1 : 0;
    if (wanted === target) return;
    target = wanted;
    start();
  });

  $effect(() => {
    if (!canvas) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    };
  });
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
