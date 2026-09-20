<script lang="ts">
  /* The gate: every page a person meets before the app (sign in, create an
     account, confirm it, accept an invitation, reset a password, grant an
     application, set the instance up) and every edge page after it (an
     error, a zero state). ONE canvas for all of them, in two leaves: the
     product on the left, on its own field (the mark, the name, one sentence,
     the brand's drawing turning slowly), and the page's own words and form
     on the right. A phone gets the right leaf alone. A page fills the right
     leaf with the card parts it always used (Card.Header, Card.Title,
     Card.Description, Card.Content): inside the gate they lose their box
     and take the gate's voice, so no page restyles itself. `plate={false}`
     keeps the bare centred canvas for a bespoke moment (the silent SSO
     interstitial). */
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import PageField from './PageField.svelte';
  import FieldGround from './FieldGround.svelte';
  import TurningDrawing from './TurningDrawing.svelte';
  import AntasphereMark from './AntasphereMark.svelte';
  import { RECIPE } from '$lib/brand/recipe.js';
  import { followPointer } from '$lib/brand/follow';
  import { t } from '$lib/i18n';
  import { staggerParts } from '$lib/stagger';

  interface Props {
    /** Field palette: umber-field for gates, paper for error/edge pages. */
    palette?: string;
    /** quiet halves the field's reach (error pages). */
    strength?: 'full' | 'quiet';
    /** Kept for callers: the gate has one width now. */
    width?: string;
    /** The two-leaf gate (default), or the bare centred canvas. */
    plate?: boolean;
    /** The small line over the right leaf's title: what this page is. */
    eyebrow?: string;
    /** The left leaf's drawing: one of the engine's constructions. */
    drawing?: string;
    children: Snippet;
  }

  let {
    palette = 'umber-field',
    strength = 'full',
    width: _width,
    plate = true,
    eyebrow,
    drawing = 'latitudes',
    children
  }: Props = $props();

  // The instance's name, from the root loader every gate page inherits.
  const instanceName = $derived((page.data?.instance?.name as string | undefined) ?? 'Slideless');

  /* The left leaf is alive. The drawing stays where it is and turns about
     its own centre, toward the pointer; the field under it is the GROUND it
     rolls on, so it slides the other way by exactly the ground that turn
     covers (angle x radius), as one sheet. Over that the drawing keeps a
     slow float of its own, which rolls nothing. */
  const ground = { x: 0, y: 0 };
  const readGround = () => ground;
  let aside = $state<HTMLElement | null>(null);
  let body = $state<{ turn: (a: number, b: number, t: number) => void; radius: () => number } | null>(null);

  $effect(() => {
    if (!aside || !body) return;
    const leaf = aside;
    const drawn = body;
    const stop = followPointer(leaf, ({ x, y, t }) => {
      // a slow sway of its own keeps it alive at rest
      const a = x * 0.55 + Math.sin(t * 0.21) * 0.08;
      // rolling away from the eye would level the sphere's axis and flatten
      // its parallels to strokes: that side saturates short of it
      const away = 0.2;
      const b = y < 0 ? -away * Math.tanh((-y * 0.4) / away) : y * 0.4;
      drawn.turn(a, b, t);
      ground.x = (-a * drawn.radius()) / leaf.offsetWidth;
      ground.y = (-b * drawn.radius()) / leaf.offsetHeight;
    });
    return () => {
      stop();
      ground.x = ground.y = 0;
    };
  });
</script>

<PageField {palette} {strength} alive />

<div class="relative z-10 flex min-h-dvh items-center justify-center p-4 sm:p-6">
  {#if plate}
    <div class="gate plate">
      <aside class="gate-aside" aria-hidden="true" bind:this={aside}>
        <div class="gate-field">
          <FieldGround {palette} shape={drawing} seed={RECIPE.seed} slide={readGround} />
        </div>
        <div class="gate-shade"></div>
        <div class="gate-drawing">
          <TurningDrawing bind:this={body} {palette} shape={drawing} seed={RECIPE.seed} fade={74} />
        </div>
        <div class="gate-words on-field">
          <!-- the company's own mark, the same one the hub's gate wears -->
          <AntasphereMark size={76} class="gate-mark" />
          <p class="gate-name">{instanceName}</p>
          <p class="gate-tagline">{t('login.tagline')}</p>
        </div>
      </aside>
      <section class="gate-form" use:staggerParts>
        {#if eyebrow}<p class="eyebrow gate-eyebrow">{eyebrow}</p>{/if}
        {@render children()}
      </section>
    </div>
  {:else}
    {@render children()}
  {/if}
</div>

<style>
  .gate {
    display: grid;
    width: 100%;
    max-width: 920px;
    overflow: hidden;
    border-radius: 18px;
  }
  @media (min-width: 768px) {
    .gate {
      grid-template-columns: 1.05fr 1fr;
      min-height: 560px;
    }
  }
  .gate-aside {
    view-transition-name: gate-aside;
    position: relative;
    display: none;
    overflow: hidden;
    border-right: 1px solid var(--hairline);
  }
  @media (min-width: 768px) {
    .gate-aside {
      display: block;
    }
  }
  .gate-field {
    position: absolute;
    inset: 0;
  }
  /* the whole body shows: it stands inside the leaf, over the words, clear of
     both edges with room for its float and its lean toward the pointer */
  .gate-drawing {
    position: absolute;
    top: 5%;
    right: 7%;
    width: 64%;
    aspect-ratio: 1;
  }
  /* the leaf is set INTO the plate, with the hero band's own recess
     (HeroBand .shade: the casts and why they are inset shadows) */
  .gate-shade {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    border-radius: 18px 0 0 18px;
    --cast: color-mix(in oklab, var(--accent-deep, var(--accent)) 28%, #000);
    box-shadow:
      inset 0 9px 13px -11px color-mix(in oklab, var(--cast) 9%, transparent),
      inset 0 -9px 13px -11px color-mix(in oklab, var(--cast) 6%, transparent),
      inset 0 0 16px 5px color-mix(in oklab, var(--cast) 2.5%, transparent),
      inset 0 1px 0 0 rgb(255 255 255 / 0.16);
  }
  :global(:root.dark) .gate-shade {
    --cast: color-mix(in oklab, var(--accent-deep, var(--accent)) 20%, #000);
    box-shadow:
      inset 0 9px 14px -11px color-mix(in oklab, var(--cast) 17%, transparent),
      inset 0 -9px 14px -11px color-mix(in oklab, var(--cast) 11%, transparent),
      inset 0 0 18px 5px color-mix(in oklab, var(--cast) 4.5%, transparent),
      inset 0 1px 0 0 rgb(255 255 255 / 0.08);
  }
  .gate-words {
    position: absolute;
    inset: auto 0 0 0;
    display: grid;
    gap: 10px;
    padding: 36px 38px;
  }
  /* the mark stands on the field like the words under it: the same paper
     halo, as a drop-shadow since an SVG takes no text-shadow. Its box is the
     512 reference, the sphere sits 23 units inside: pulled left by that much
     so the sphere's edge, not the box's, lines up with the name. */
  .gate-words :global(.gate-mark) {
    display: block;
    margin: 0 0 6px -3px;
    filter: drop-shadow(0 0 10px rgb(247 246 244 / 0.85));
  }
  :global(:root.dark) .gate-words :global(.gate-mark) {
    filter: drop-shadow(0 0 10px rgb(20 16 12 / 0.8));
  }
  .gate-name {
    font-family: var(--display);
    font-weight: 300;
    font-size: 34px;
    line-height: 1.05;
    letter-spacing: -0.015em;
  }
  .gate-tagline {
    max-width: 30ch;
    font-size: 14.5px;
    line-height: 1.45;
    opacity: 0.8;
  }
  /* the leaf that turns between two gate pages (app.css) */
  .gate-form {
    view-transition-name: gate-form;
    display: flex;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
    padding: 36px 26px 32px;
  }
  @media (min-width: 768px) {
    .gate-form {
      padding: 46px 44px 40px;
    }
  }
  .gate-eyebrow {
    margin-bottom: 8px;
  }
  /* The card parts a gate page is made of, in the gate's voice: no box of
     their own, the title in the display serif at the gate's size. */
  .gate-form :global([data-slot='card']) {
    gap: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
  }
  .gate-form :global([data-slot='card-header']),
  .gate-form :global([data-slot='card-content']),
  .gate-form :global([data-slot='card-footer']) {
    padding-left: 0;
    padding-right: 0;
  }
  .gate-form :global([data-slot='card-header']) {
    gap: 6px;
  }
  .gate-form :global([data-slot='card-title']) {
    font-family: var(--display);
    font-weight: 300;
    font-size: 30px;
    line-height: 1.1;
    letter-spacing: -0.015em;
    color: var(--ink);
    text-wrap: balance;
  }
  .gate-form :global([data-slot='card-description']) {
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
    text-wrap: pretty;
  }
  @media (max-width: 767.98px) {
    .gate-form :global([data-slot='card-title']) {
      font-size: 26px;
    }
  }
</style>
