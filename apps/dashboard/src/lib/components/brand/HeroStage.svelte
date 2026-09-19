<script lang="ts">
  /* The band a page opens on, as ONE element of the shell: the look's theme
     in full colour as a field, one of the brand's drawings turning slowly at
     its right, and the page's words on it. It stays while the pages change
     under it ($lib/hero.svelte, HeroBand says what each page puts on it), and
     a page change is three quiet things: the box eases to the new page's
     size, the drawing of the old page fades where it stands as the new one
     fades in where IT stands, and the words change. The ground never moves
     for a page change: it is one field for the whole app, laid at the tall
     band's size and only ever clipped by the box, never scaled to it.
     Decoration only: it never moves for a reader who asked for no motion. */
  import { cubicOut } from 'svelte/easing';
  import { fade, fly } from 'svelte/transition';
  import FieldGround from './FieldGround.svelte';
  import TurningDrawing from './TurningDrawing.svelte';
  import { followPointer } from '$lib/brand/follow';
  import { RECIPE } from '$lib/brand/recipe.js';
  import { hero } from '$lib/hero.svelte';
  import { gradientLevel, heroPalette, look } from '$lib/look.svelte';
  import { theme } from '$lib/theme.svelte';

  $effect(() => theme.start());
  const palette = $derived(heroPalette(look.value.theme, theme.dark));
  // The band follows the workspace's gradient like the page under it: its
  // colour leaves with the level, its linework only fades (a band with no
  // drawing would read as an empty box).
  const level = $derived(Math.min(1, gradientLevel(look.value)));

  const band = $derived(hero.current);
  // a drawing is the same one as long as nothing it is made of changes: two
  // pages of one section keep theirs, without a blink
  const drawn = $derived(band ? `${band.drawing}:${band.seed}:${band.compact}` : '');

  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = (n: number) => (still ? 0 : n);

  /* The band is alive the way the gate is, a tone lower: the drawing turns
     about its own centre toward the pointer and keeps a slow float, and the
     field under it is its ground, sliding the other way by the ground that
     turn covers. ONE follow for the life of the band, turning every drawing
     that is on it: through a page change the one that leaves keeps the pose
     and the clock it had while it fades, the one that arrives is born in
     that same pose, and the ground never starts over. */
  type Body = { turn: (a: number, b: number, t: number) => void; radius: () => number };
  // read on every frame, never rendered from: a plain record on purpose
  const bodies: Record<string, Body> = {};
  const ground = { x: 0, y: 0 };
  const readGround = () => ground;
  let box = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!box) return;
    const el = box;
    return followPointer(el, ({ x, y, t }) => {
      const a = x * 0.4 + Math.sin(t * 0.21) * 0.07;
      const away = 0.2;
      const b = y < 0 ? -away * Math.tanh((-y * 0.3) / away) : y * 0.3;
      let radius = 0;
      for (const body of Object.values(bodies)) {
        body.turn(a, b, t);
        radius = body.radius();
      }
      if (!radius) return;
      ground.x = (-a * radius) / el.offsetWidth;
      // the tall band's height, the one the ground is laid at: the box
      // changing size must not move the ground either
      ground.y = (-b * radius) / (el.querySelector<HTMLElement>('.ground')?.offsetHeight || el.offsetHeight);
    });
  });

  // Words on their way out leave the flow, so only the page that is open
  // gives the box its height, and they fade where they stand: held by the
  // band's top, not by the bottom edge that is moving under them.
  const leave = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    el.style.top = `${el.offsetTop}px`;
    el.style.width = `${el.offsetWidth}px`;
    el.classList.add('leaving');
  };
</script>

<!-- `data-page-head`: the shell watches it leave the scroll to show the path in the top bar -->
<section
  class="hero plate-window"
  class:compact={band?.compact}
  class:none={!band}
  data-page-head={band ? '' : undefined}
  aria-hidden={band ? undefined : 'true'}
  bind:this={box}
>
  <div class="ground" style:opacity={level}>
    <FieldGround {palette} shape={RECIPE.shape} seed={RECIPE.seed} slide={readGround} />
  </div>
  {#if band}
    {#key drawn}
      {@const id = drawn}
      <div
        class="drawing"
        class:small={band.compact}
        style:--level={0.4 + 0.6 * level}
        in:fade={{ duration: ms(520), delay: ms(120), easing: cubicOut }}
        out:fade={{ duration: ms(260) }}
      >
        <TurningDrawing
          bind:this={() => bodies[id], (body) => (body ? (bodies[id] = body) : delete bodies[id])}
          {palette}
          shape={band.drawing}
          seed={band.seed}
          fade={78}
          float={band.compact ? 0.5 : 0.8}
        />
      </div>
    {/key}
  {/if}
  <!-- the band's depth: over the field, under the words (decoration only) -->
  <div class="shade" aria-hidden="true"></div>
  {#if band}
    {#key band.words_key ?? band.owner}
      <div
        class="words on-field"
        class:small={band.compact}
        in:fly={{ y: 8, duration: ms(380), delay: ms(140), easing: cubicOut }}
        out:fade={{ duration: ms(140) }}
        onoutrostart={leave}
      >
        {@render band.words()}
      </div>
    {/key}
  {/if}
</section>

<style>
  .hero {
    /* the two sizes of the band, and the one the ground is laid at */
    --tall: 260px;
    --low: 132px;
    position: relative;
    min-height: var(--tall);
    /* One cell, at the band's foot, for the words: through a page change the
       ones that leave and the ones that arrive share it and lie over each
       other. Side by side in a row they would squeeze each other, a long
       sentence would wrap again and grow, and its title would jump up. */
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: end;
    /* The same lit edge the content plate wears (`--plate-edge`, white at
       60%): on a field of colour a dark border and the recess's own contact
       line double into a hard rim, while a white edge reads as light caught
       on the frame — the band sits in the page instead of being outlined on
       it. The token already flips for dark (white at 7%). */
    border: 1px solid var(--plate-edge);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
    /* what shows as the gradient leaves: the page's own base */
    background: var(--field-base);
  }
  .hero.compact {
    min-height: var(--low);
  }
  /* a page with no band: the box closes, and opens again for the next one */
  .hero.none {
    min-height: 0;
    border-color: transparent;
    box-shadow: none;
    opacity: 0;
  }
  @media (prefers-reduced-motion: no-preference) {
    .hero {
      transition:
        min-height 460ms cubic-bezier(0.22, 1, 0.36, 1),
        opacity 240ms ease,
        border-color 240ms ease;
    }
  }
  /* the words carry their own size (not the box's): the ones on their way
     out keep theirs while the box is already taking the next page's */
  .words.small {
    padding: 20px 22px;
  }
  .words.small :global(.hero-title) {
    font-size: clamp(24px, 4.4vw, 32px);
  }
  /* The ground keeps the tall band's size whatever the box does: a lower box
     shows less of the same field, it never squeezes it. */
  .ground {
    position: absolute;
    inset: 0 0 auto;
    height: var(--tall);
  }
  /* The band is a surface set INTO the page: the shadow runs all the way
     round the inside of the frame, follows the rounded corners, and is
     heaviest at the top and bottom edges.

     Inset box-shadow, not gradients, and that is the whole point: a
     background gradient is a rectangle and cannot hug a corner radius, so it
     leaves the corners flat and the sides untouched. An inset shadow is cast
     by the border box itself, so it wraps the perimeter — corners included —
     the way a real recess does.

     Four casts, read top to bottom:
       1. top edge, deep and tight — the frame's lip occludes the light.
       2. bottom edge, softer and a little lighter — the far wall of a recess
          catches some bounce, so it never goes as dark as the lip.
       3. left and right, one cast with no vertical offset and a wide spread
          pulled back by a negative spread: the sides get the ambient
          occlusion that makes the corners turn, without a visible band.
       4. a hairline of true contact darkness on every edge, no blur — the
          line that says the surface stops here. This is the one that draws
          the corner radius crisply.
     Then one lit edge across the top inside: the frame's own bright lip over
     the recess, which is what sells the depth rather than just darkness. */
  .shade {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
    /* The casts are the look's own accent taken most of the way to black,
       never neutral black: a grey shadow over a warm field greys the colour
       out and is what reads as "off". A real shadow is the surface's own
       hue darkened, so the band stays one material. */
    --cast: color-mix(in oklab, var(--accent-deep, var(--accent)) 28%, #000);
    box-shadow:
      inset 0 9px 13px -11px color-mix(in oklab, var(--cast) 9%, transparent),
      inset 0 -9px 13px -11px color-mix(in oklab, var(--cast) 6%, transparent),
      inset 0 0 16px 5px color-mix(in oklab, var(--cast) 2.5%, transparent),
      inset 0 1px 0 0 rgb(255 255 255 / 0.16);
  }
  /* Dark: the recess keeps its shape, and the lit top edge carries more of
     the reading, because against a dark field the eye takes depth off the
     highlight rather than off more darkness. */
  :global(:root.dark) .shade {
    --cast: color-mix(in oklab, var(--accent-deep, var(--accent)) 20%, #000);
    box-shadow:
      inset 0 9px 14px -11px color-mix(in oklab, var(--cast) 17%, transparent),
      inset 0 -9px 14px -11px color-mix(in oklab, var(--cast) 11%, transparent),
      inset 0 0 18px 5px color-mix(in oklab, var(--cast) 4.5%, transparent),
      inset 0 1px 0 0 rgb(255 255 255 / 0.08);
  }
  /* A drawing has ONE place per size and is pinned to the band's top, never
     to its middle: the box can change height under it and it does not move.
     (The tops are where the middle of each size's own band puts it.) */
  .drawing {
    position: absolute;
    top: -40px;
    right: -34px;
    width: 176px;
    aspect-ratio: 1;
    opacity: var(--level);
  }
  .words {
    position: relative;
    grid-area: 1 / 1;
    padding: 30px 24px;
    max-width: 640px;
  }
  .words:global(.leaving) {
    position: absolute;
    left: 0;
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
      --tall: 312px;
      --low: 150px;
    }
    .words {
      padding: 44px 46px;
    }
    .words.small {
      padding: 24px 30px;
    }
    .drawing {
      top: -44px;
      right: 5%;
      width: 400px;
    }
    .drawing.small {
      top: -40px;
      right: 3%;
      width: 230px;
    }
  }
</style>
