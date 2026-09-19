<script lang="ts">
  /* What a page says about the band it opens on: the drawing, the size, and
     the words. It renders nothing here. The band itself is one element of the
     shell (HeroStage, in the app layout) that stays while the pages change,
     so it can ease from one page's size to the next, keep its ground still
     and let the drawings fade in their places ($lib/hero.svelte). */
  import type { Snippet } from 'svelte';
  import { RECIPE } from '$lib/brand/recipe.js';
  import { hero } from '$lib/hero.svelte';

  interface Props {
    /** One of the engine's constructions: `latitudes`, `orbits`, `apollonian`… */
    drawing?: string;
    seed?: number;
    /** A section's hero (people, settings): lower, the drawing smaller. */
    compact?: boolean;
    /** What the words say: pages that give the same one share their words on
        the band, which then stay put from one to the other (SectionHero). */
    wordsKey?: string;
    children: Snippet;
  }
  let { drawing = 'latitudes', seed = RECIPE.seed, compact = false, wordsKey, children }: Props = $props();

  const owner = Symbol('band');
  $effect(() => {
    hero.show({ owner, drawing, seed, compact, words: children, words_key: wordsKey });
  });
  $effect(() => () => hero.hide(owner));
</script>
