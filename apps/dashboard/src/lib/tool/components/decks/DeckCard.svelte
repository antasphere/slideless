<script lang="ts">
  /* One deck as a card (PRDCT-2437): the deck itself, the title, and the two or
     three facts a person who is not technical cares about. No id, no hash, no
     version number. The picture is a still image of the deck's first page,
     captured on the server at each push and shown to everyone who can read the
     deck (PRDCT-2725); no deck HTML loads here. Under it, until it arrives and
     in its place when there is none (no version yet, or no image made), sits
     the deck's own drawn plate: its pattern says what kind of deck it is, its
     field is seeded from the deck's id. The plate is still, never animated;
     while the image is fetched or made a shimmering skeleton covers it, the
     image fades in over that, and when there is none the plate shows. */
  import PatternCanvas from '$lib/components/brand/PatternCanvas.svelte';
  import DeckProjectTags from '$lib/tool/components/projects/DeckProjectTags.svelte';
  import DeckStill from './DeckStill.svelte';
  import Eye from '@lucide/svelte/icons/eye';
  import Clock from '@lucide/svelte/icons/clock-3';
  import { DECK_PALETTES, DECK_PATTERNS } from '$lib/brand/recipe.js';
  import { seedOf } from '$lib/brand/seed';
  import { kindLabel } from '$lib/tool/decks';
  import type { StillState } from '$lib/tool/decks/stills';
  import { formatTimeAgo } from '$lib/format';
  import { t } from '$lib/i18n';
  import type { DeckWithProjects } from '$lib/tool/projects-client';

  interface Props {
    deck: DeckWithProjects;
    /** A shorter plate, for a row of recent decks. */
    compact?: boolean;
    /** A project its tags leave out: the one whose page the card is on. */
    exceptProject?: string;
  }

  let { deck, compact = false, exceptProject }: Props = $props();

  const seed = $derived(seedOf(deck.id));
  const palette = $derived(DECK_PALETTES[seed % DECK_PALETTES.length]);
  const pattern = $derived(DECK_PATTERNS[deck.kind] ?? 'slides');

  let still = $state<StillState>('idle');
</script>

<!-- SECURITY: the title is USER-AUTHORED; it renders through text
     interpolation only, never {@html}. -->
<a href="/decks/{deck.id}" class="sheet tile deck">
  <div class="plate-window plate" class:compact data-still={deck.currentVersion > 0 ? still : undefined}>
    <PatternCanvas {pattern} {palette} {seed} />
    {#if deck.currentVersion > 0}
      <DeckStill deckId={deck.id} version={deck.currentVersion} bind:state={still} />
    {/if}
    <span class="kind">{kindLabel(deck.kind)}</span>
    {#if deck.interactive}
      <span class="kind kind--right">{t('decks.badgeInteractive')}</span>
    {/if}
  </div>
  <div class="body">
    <h3 class="title">{deck.title}</h3>
    <p class="facts">
      {#if deck.currentVersion > 0}
        <span class="fact"><Clock class="size-3.5" />{formatTimeAgo(deck.updatedAt)}</span>
        <span class="fact">
          <Eye class="size-3.5" />
          {deck.totalViews === 0
            ? t('decks.noOpens')
            : deck.totalViews === 1
              ? t('decks.oneOpen')
              : t('decks.opens', { count: String(deck.totalViews) })}
        </span>
      {:else}
        <span class="fact">{t('decks.noVersions')}</span>
      {/if}
    </p>
    <!-- the projects the deck sits in (PRDCT-2584): the reader's own only -->
    <div class="projects"><DeckProjectTags {deck} except={exceptProject} /></div>
  </div>
</a>

<style>
  .deck {
    display: flex;
    flex-direction: column;
    padding: 8px;
    min-width: 0;
  }
  .plate {
    aspect-ratio: 16 / 9;
  }
  .plate.compact {
    aspect-ratio: 16 / 9;
  }
  .kind {
    position: absolute;
    left: 10px;
    bottom: 10px;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--plate-strong);
    border: 1px solid var(--plate-edge);
    font-size: 11px;
    color: var(--ink-soft);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .kind--right {
    left: auto;
    right: 10px;
  }
  .body {
    padding: 14px 8px 8px;
    min-width: 0;
  }
  .title {
    font-family: var(--display);
    font-weight: 400;
    font-size: 18px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted);
  }
  .projects:not(:empty) {
    margin-top: 10px;
  }
  .fact {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
</style>
