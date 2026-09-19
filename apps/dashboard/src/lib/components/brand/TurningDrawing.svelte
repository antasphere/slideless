<script lang="ts">
  /* One of the brand's drawings as a BODY in space, filling its box: it never
     leaves its centre, it turns about it, and it keeps a slow float of its
     own. The field is the engine's; the linework is the construction built
     in three dimensions ($lib/brand/solids) and re-projected on every frame,
     so a ring passes in front of a body and comes back behind it. A shape
     the brand has only as a flat plate keeps the engine's own linework and
     stays still. `turn` takes the two angles on every frame; the field
     inside the body slides with the turn, as its surface would. */
  import FieldCanvas from './FieldCanvas.svelte';
  import { buildSolid, type Solid } from '$lib/brand/solids';
  import { PALETTES, DPR } from '$lib/engine/engine.js';

  interface Props {
    palette: string;
    shape: string;
    seed: number;
    /** Where the radial mask starts to fade the body into the ground, %. */
    fade?: number;
    /** The float's size: 1 is the gate's, a small band takes less. */
    float?: number;
  }
  let { palette, shape, seed, fade = 76, float = 1 }: Props = $props();

  const solid = $derived<Solid | null>(buildSolid(shape, seed));
  const rgb = $derived(
    (PALETTES as Record<string, { light: boolean }>)[palette]?.light ? '28,25,21' : '247,244,236'
  );
  const skin = { x: 0, y: 0 };
  const readSkin = () => skin;
  let body = $state<HTMLElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let held = { a: 0, b: 0, t: 0 };

  function paint() {
    if (!canvas || !solid) return;
    const W = Math.round(canvas.offsetWidth * DPR);
    const H = Math.round(canvas.offsetHeight * DPR);
    if (W < 2 || H < 2) return;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const ink = (a: number) => `rgba(${rgb},${Math.min(0.96, a).toFixed(3)})`;
    solid({ ctx, W, H, dpr: DPR, ink, pitch: held.b, yaw: held.a, t: held.t });
  }

  /** The body's radius on screen, px: what a turn covers on the ground. */
  export function radius() {
    return (body?.offsetWidth ?? 0) * 0.42;
  }

  /** `a` about the upright, `b` about the level, radians; `t` the clock. */
  export function turn(a: number, b: number, t: number) {
    if (!body || !solid) return;
    held = { a, b, t };
    skin.x = a * 0.42;
    skin.y = b * 0.42;
    const dx = (Math.sin(t * 0.43) * 6 + Math.sin(t * 0.19 + 1.3) * 4) * float;
    const dy = (Math.cos(t * 0.37) * 8 + Math.sin(t * 0.23) * 4) * float;
    const lift = 1 + Math.sin(t * 0.31 + 0.6) * 0.016;
    body.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${lift.toFixed(4)})`;
    paint();
  }

  // the settled frame: all a reader who asked for no motion ever sees
  $effect(() => {
    void solid;
    void rgb;
    if (!canvas) return;
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    paint();
    return () => ro.disconnect();
  });
</script>

<div class="body" bind:this={body} style="--fade: {fade}%">
  <FieldCanvas {palette} {shape} {seed} linework={!solid} animate drift={readSkin} />
  {#if solid}<canvas bind:this={canvas} aria-hidden="true"></canvas>{/if}
</div>

<style>
  .body {
    position: relative;
    width: 100%;
    height: 100%;
    will-change: transform;
    -webkit-mask-image: radial-gradient(closest-side, #000 var(--fade), transparent 100%);
    mask-image: radial-gradient(closest-side, #000 var(--fade), transparent 100%);
  }
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
