<script lang="ts">
  /* A seeded engine field on a canvas that fills its box: the gradient
	   blobs, an optional linework construction over them, and the film
	   grain. Redraws on resize and on any recipe change; the drift (`animate`)
	   repaints at the round-7 cadence with a jittered grain so it reads as
	   film, skipped under prefers-reduced-motion and while off screen.
	   Ported from finance-app src/lib/components/FieldCanvas.svelte. */
  import { paint, buildBlobs, DPR } from '$lib/engine/engine.js';
  import { CONSTANTS } from '$lib/brand/recipe.js';

  interface Props {
    palette: string;
    shape: string;
    seed: number;
    linework?: boolean;
    inkBoost?: number;
    dpr?: number;
    grained?: boolean;
    animate?: boolean;
  }

  let {
    palette,
    shape,
    seed,
    linework = true,
    inkBoost = 1,
    dpr = DPR,
    grained = true,
    animate = false
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);

  function draw(t = 0, grainOffset: { x: number; y: number } | null = null) {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const W = Math.round(r.width * dpr);
    const H = Math.round(r.height * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const g = CONSTANTS.grain;
    paint(
      canvas.getContext('2d'),
      W,
      H,
      {
        palette,
        study: shape,
        linework,
        inkBoost,
        grain: g.type,
        grainAlpha: grained ? g.alpha : 0,
        grainSize: g.size,
        seed,
        blobs: buildBlobs(seed, palette)
      },
      t,
      grainOffset
    );
  }

  $effect(() => {
    void palette;
    void shape;
    void seed;
    void linework;
    void grained;
    draw();
  });

  $effect(() => {
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!animate || !canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let visible = false;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
    });
    io.observe(canvas);

    const t0 = performance.now();
    let last = 0;
    let rafId = requestAnimationFrame(function frame(now) {
      if (visible && now - last > 44) {
        last = now;
        draw((now - t0) / 5200, { x: Math.random() * 512, y: Math.random() * 512 });
      }
      rafId = requestAnimationFrame(frame);
    });

    return () => {
      cancelAnimationFrame(rafId);
      io.disconnect();
      draw();
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
